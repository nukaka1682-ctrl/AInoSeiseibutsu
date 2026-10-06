// 敷地を隔てる塀（中庭・庭・駐車場などを囲む壁）を、実測データから見つける。
// - 候補の線: 地籍（IGN Parcellaire Express）の敷地の境界。塀はふつう敷地の境に建っている
// - 本当に塀があるか: LiDAR HD の表面モデル（0.5 m）と地形モデルの差（地面からの高さ）で、
//   境界に沿って「高さ 1.6〜7 m で、両側より高い、細い盛り上がり」が続いている所だけを塀にする
//   （建物の上・木の下・車などは除く）。位置は境界から前後 1.25 m の範囲で、実際に高い所へずらす
// 結果は [経度 1, 緯度 1, 経度 2, 緯度 2, 高さ (m)] の線分の配列（scripts/fetch-data.mjs で同梱データに入れる）。
// 同じ表面モデルから、木の位置・高さ・枝の広がりも見つける（IGN のデータには個々の木がないため）。
import { fetchWfsLayer, normalizeCoords, polygonsOf } from './bdtopo.js';
import { HeightGrid, LIDAR_LAYERS, fetchElevation } from './lidar.js';
import { detectTrees } from '../world/lidartrees.js';

export const PARCEL_LAYER = 'CADASTRALPARCELS.PARCELLAIRE_EXPRESS:parcelle';
const DSM_RES = 0.5; // m
const DTM_RES = 1;
const STEP = 0.5; // 境界に沿って調べる間隔（m）
const MIN_H = 1.6; // これより低いものは塀にしない（車・生け垣の一部など）
const MAX_H = 7;
const MIN_LEN = 2; // m
const MARGIN = 25; // 周りの敷地・建物も見るための余白（m）

// bbox（緯度経度）の周りを、東西 mx・南北 mz（m/度）で平面に直す
function frame(bbox) {
  const lat0 = (bbox.s + bbox.n) / 2;
  const mx = 111320 * Math.cos((lat0 * Math.PI) / 180), mz = 110574;
  return {
    mx, mz,
    w: bbox.w, n: bbox.n,
    width: (bbox.e - bbox.w) * mx, height: (bbox.n - bbox.s) * mz,
    to: ([lon, lat]) => [(lon - bbox.w) * mx, (bbox.n - lat) * mz],
    from: (x, z) => [Math.round((bbox.w + x / mx) * 1e7) / 1e7, Math.round((bbox.n - z / mz) * 1e7) / 1e7],
  };
}

export function grow(bbox, m) {
  const lat0 = (bbox.s + bbox.n) / 2;
  const dLat = m / 110574, dLon = m / (111320 * Math.cos((lat0 * Math.PI) / 180));
  return { s: bbox.s - dLat, n: bbox.n + dLat, w: bbox.w - dLon, e: bbox.e + dLon };
}

// 多角形（外形と穴）を格子に塗る（偶奇規則のスキャンライン）
function fillPolygon(mask, cols, rows, res, rings) {
  for (let r = 0; r < rows; r++) {
    const z = (r + 0.5) * res;
    const xs = [];
    for (const ring of rings) {
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [ax, az] = ring[j], [bx, bz] = ring[i];
        if ((az > z) !== (bz > z)) xs.push(ax + ((z - az) / (bz - az)) * (bx - ax));
      }
    }
    if (xs.length < 2) continue;
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const c0 = Math.max(0, Math.ceil(xs[k] / res - 0.5)), c1 = Math.min(cols - 1, Math.floor(xs[k + 1] / res - 0.5));
      for (let c = c0; c <= c1; c++) mask[r * cols + c] = 1;
    }
  }
}

function dilate(mask, cols, rows) {
  const out = mask.slice();
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (mask[r * cols + c]) continue;
      if ((c > 0 && mask[r * cols + c - 1]) || (c + 1 < cols && mask[r * cols + c + 1]) ||
        (r > 0 && mask[(r - 1) * cols + c]) || (r + 1 < rows && mask[(r + 1) * cols + c])) out[r * cols + c] = 1;
    }
  }
  return out;
}

const percentile = (a, p) => {
  const s = a.slice().sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
};

// parcels / buildings: 多角形（[経度, 緯度] のリングの配列）の配列。dsm / dtm: bbox を覆う格子（北が上）
// keep(経度, 緯度): その線分を結果に入れるか（タイルの持ち分など）
export function detectWalls({ bbox, parcels, buildings, dsm, dtm, keep = () => true }) {
  const F = frame(bbox);
  const cols = dsm.cols, rows = dsm.rows;
  const res = F.width / cols; // 実際の画素の大きさ（m）
  // 地面からの高さ
  const nd = new Float32Array(cols * rows);
  const tx = dtm.cols / cols, tz = dtm.rows / rows;
  for (let r = 0; r < rows; r++) {
    const rr = Math.min(dtm.rows - 1, Math.floor((r + 0.5) * tz));
    for (let c = 0; c < cols; c++) {
      const cc = Math.min(dtm.cols - 1, Math.floor((c + 0.5) * tx));
      nd[r * cols + c] = dsm.data[r * cols + c] - dtm.data[rr * dtm.cols + cc];
    }
  }
  const H = (x, z) => {
    const c = Math.floor(x / res), r = Math.floor(z / res);
    return c < 0 || r < 0 || c >= cols || r >= rows ? NaN : nd[r * cols + c];
  };
  // 建物（少し太らせる）
  let mask = new Uint8Array(cols * rows);
  for (const poly of buildings) fillPolygon(mask, cols, rows, res, poly.map((ring) => ring.map(F.to)));
  mask = dilate(mask, cols, rows);
  const inBuilding = (x, z) => {
    const c = Math.floor(x / res), r = Math.floor(z / res);
    return c >= 0 && r >= 0 && c < cols && r < rows && mask[r * cols + c] === 1;
  };

  // 敷地の境界（隣どうしで同じ辺は 1 回だけ）
  const seen = new Set();
  const edges = [];
  const q = (v) => Math.round(v * 5);
  for (const poly of parcels) {
    for (const ring of poly) {
      const pts = ring.map(F.to);
      for (let i = 0; i + 1 < pts.length; i++) {
        const a = pts[i], b = pts[i + 1];
        const k1 = `${q(a[0])},${q(a[1])}`, k2 = `${q(b[0])},${q(b[1])}`;
        const key = k1 < k2 ? `${k1}|${k2}` : `${k2}|${k1}`;
        if (k1 === k2 || seen.has(key)) continue;
        seen.add(key);
        edges.push([a, b]);
      }
    }
  }

  const out = [];
  const OFF = [-1.25, -1, -0.75, -0.5, -0.25, 0, 0.25, 0.5, 0.75, 1, 1.25];
  for (const [a, b] of edges) {
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (L < MIN_LEN) continue;
    const ux = (b[0] - a[0]) / L, uz = (b[1] - a[1]) / L, nx = -uz, nz = ux;
    const n = Math.floor(L / STEP) + 1;
    const ok = new Uint8Array(n), hs = new Float32Array(n), best = new Int8Array(n);
    for (let k = 0; k < n; k++) {
      const t = Math.min(L, k * STEP);
      const px = a[0] + ux * t, pz = a[1] + uz * t;
      let hmax = -Infinity, bi = 0;
      for (let o = 0; o < OFF.length; o++) {
        const h = H(px + nx * OFF[o], pz + nz * OFF[o]);
        if (h > hmax) [hmax, bi] = [h, o];
      }
      const wx = px + nx * OFF[bi], wz = pz + nz * OFF[bi];
      if (!(hmax >= MIN_H && hmax <= MAX_H) || inBuilding(wx, wz)) continue;
      // 細さ: 両側 2〜3 m は塀より 0.8 m 以上低い（木・建物・小屋の屋根ではない）
      const side = (s) => percentile([2, 2.5, 3].map((d) => H(wx + nx * d * s, wz + nz * d * s)), 0.5);
      const s1 = side(1), s2 = side(-1);
      if (!(s1 < hmax - 0.8 && s2 < hmax - 0.8)) continue;
      ok[k] = 1;
      hs[k] = hmax;
      best[k] = bi;
    }
    // 1 m 以下のすき間はつなぐ（門などの開口はそれより広い）
    for (let k = 1; k < n - 1; k++) {
      if (ok[k]) continue;
      let j = k;
      while (j < n && !ok[j]) j++;
      if (j < n && j - k <= 2 && ok[k - 1]) for (let m = k; m < j; m++) ok[m] = 2;
      k = j;
    }
    for (let k = 0; k < n;) {
      if (!ok[k]) {
        k++;
        continue;
      }
      let j = k;
      while (j + 1 < n && ok[j + 1]) j++;
      const t0 = Math.max(0, k * STEP - (k === 0 ? 0 : STEP / 2)), t1 = Math.min(L, j * STEP + (j === n - 1 ? 0 : STEP / 2));
      if (t1 - t0 >= MIN_LEN) {
        const hh = [], bo = [];
        for (let m = k; m <= j; m++) if (ok[m] === 1) {
          hh.push(hs[m]);
          bo.push(OFF[best[m]]);
        }
        // 位置: 境界からのずれは、塀の上を通る位置の中央値
        const off = percentile(bo, 0.5);
        const h = Math.min(MAX_H, Math.max(MIN_H, percentile(hh, 0.6)));
        const p0 = [a[0] + ux * t0 + nx * off, a[1] + uz * t0 + nz * off];
        const p1 = [a[0] + ux * t1 + nx * off, a[1] + uz * t1 + nz * off];
        const g0 = F.from(...p0), g1 = F.from(...p1);
        const mid = F.from((p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2);
        if (keep(mid[0], mid[1])) out.push([g0[0], g0[1], g1[0], g1[1], Math.round(h * 10) / 10]);
      }
      k = j + 1;
    }
  }
  return out;
}

// GeoJSON の地物から多角形（[経度, 緯度] のリングの配列）を取り出す
export function featurePolygons(features, bbox) {
  const out = [];
  for (const f of features) {
    for (const poly of polygonsOf(f.geometry)) out.push(poly.map((ring) => normalizeCoords(ring.map((c) => c.slice(0, 2)), bbox)));
  }
  return out;
}

// bbox の塀と木を、実測データから見つける。buildings: その周り（MARGIN m）を含む建物の GeoJSON 地物
// 戻り値: walls（detectWalls の形）と trees（[経度, 緯度, 高さ (m), 枝の広がりの半径 (m)]）
export async function fetchSiteFeatures(bbox, buildings, { keep } = {}) {
  const big = grow(bbox, MARGIN);
  const F = frame(big);
  const [parcelFeatures, dsm, dtm] = await Promise.all([
    fetchWfsLayer(PARCEL_LAYER, big, { maxPages: 10 }),
    fetchElevation(LIDAR_LAYERS.dsm, big, Math.round(F.width / DSM_RES), Math.round(F.height / DSM_RES)),
    fetchElevation(LIDAR_LAYERS.dtm, big, Math.round(F.width / DTM_RES), Math.round(F.height / DTM_RES)),
  ]);
  const inside = (lon, lat) => lon >= bbox.w && lon < bbox.e && lat > bbox.s && lat <= bbox.n && (!keep || keep(lon, lat));
  const buildingPolys = featurePolygons(buildings, big);
  const walls = detectWalls({ bbox: big, parcels: featurePolygons(parcelFeatures, big), buildings: buildingPolys, dsm, dtm, keep: inside });

  // 木: 樹冠の高さの極大（world/lidartrees.js）
  const rect = { minX: 0, maxX: F.width, minZ: 0, maxZ: F.height };
  const local = buildingPolys.map((poly) => {
    const rings = poly.map((ring) => ring.map(F.to));
    let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
    for (const [x, z] of rings[0]) {
      minX = Math.min(minX, x); maxX = Math.max(maxX, x); minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
    }
    return { outer: rings[0], holes: rings.slice(1), bounds: { minX, minZ, maxX, maxZ } };
  });
  const found = detectTrees({ dsm: new HeightGrid(dsm, rect), dtm: new HeightGrid(dtm, rect), buildings: local });
  const trees = [];
  for (const t of found) {
    const [lon, lat] = F.from(t.x, t.z);
    if (inside(lon, lat)) trees.push([lon, lat, Math.round(t.h * 10) / 10, Math.round(t.r * 10) / 10]);
  }
  return { walls, trees };
}
