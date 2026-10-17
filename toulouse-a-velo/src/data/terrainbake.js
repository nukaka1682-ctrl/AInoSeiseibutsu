// 地形の格子を作る（事前取得 scripts/fetch-data.mjs と、同梱の地形ファイルがないときのブラウザ）。
// 1. IGN LiDAR HD の地形モデル（MNT）を 2.5 m で取り、2 × 2 の平均で 5 m の格子に（格子は world/terrain.js の LATTICE に固定）
// 2. 川・運河・池（地図の水域）の格子点は、地形モデルでは水面の高さで平ら。その値を水面の格子（20 m）に使い、地面の格子では
//    岸から延ばした高さに置き換える（川の上で地面がへこまない。岸壁の上端が本当の岸の高さになる）
// 3. 平らな所だけ [1 2 1] で 3 回ならす（段差・土手・岸壁の縁はそのまま。道路の面に重ねる三角形を減らすため、数 cm の凹凸も消す）
// 4. 遠くの格子（50 m、エリアの外 6 km まで。ペシュ・ダヴィッドやコート・パヴェの丘を遠景に見せる）
// 5. 長い橋は表面モデル（MNS）の帯から橋面の縦断面を測る（車・街灯・木を除くため、横 3 本の線の中央値の最小と、外れ値の除去）
import { LIDAR_LAYERS, fetchElevation } from './lidar.js';
import { LATTICE } from '../world/terrain.js';
import { LocalProjection } from '../geo.js';
import { bridgeGroups, deckHalf, polyFrame } from '../world/bridges.js';

const T = new LocalProjection(LATTICE.lat, LATTICE.lon);

// bbox（緯度経度）を覆う、格子 step m の格子点の範囲
export function latticeFor(bbox, step = LATTICE.step) {
  const dLat = step / T.ky, dLon = step / T.kx;
  const cW = Math.ceil((LATTICE.lon - bbox.w) / dLon), rN = Math.ceil((bbox.n - LATTICE.lat) / dLat);
  const lon = LATTICE.lon - cW * dLon, lat = LATTICE.lat + rN * dLat;
  return { lat, lon, dLat, dLon, cols: Math.floor((bbox.e - lon) / dLon) + 1, rows: Math.floor((lat - bbox.s) / dLat) + 1 };
}

const grow = (b, m) => {
  const dLat = m / T.ky, dLon = m / T.kx;
  return { s: b.s - dLat, n: b.n + dLat, w: b.w - dLon, e: b.e + dLon };
};

// 格子 g（格子点が画素の角）を sub 倍の細かさで取り、sub × sub の平均で格子点の値にする
async function fetchLattice(layer, g, sub, onProgress) {
  const fc = g.cols * sub, fr = g.rows * sub;
  const bb = { w: g.lon - g.dLon / 2, e: g.lon + (g.cols - 0.5) * g.dLon, n: g.lat + g.dLat / 2, s: g.lat - (g.rows - 0.5) * g.dLat };
  const { data } = await fetchElevation(layer, bb, fc, fr, { onProgress, concurrency: 4 });
  if (sub === 1) return data;
  const out = new Float32Array(g.cols * g.rows);
  for (let r = 0; r < g.rows; r++) {
    for (let c = 0; c < g.cols; c++) {
      let s = 0;
      for (let j = 0; j < sub; j++) for (let i = 0; i < sub; i++) s += data[(r * sub + j) * fc + c * sub + i];
      out[r * g.cols + c] = s / (sub * sub);
    }
  }
  return out;
}

// 水域（ローカル座標の外形と穴）を格子点に塗る（偶奇規則の走査線）
export function rasterizeWater(areas, g, proj) {
  const mask = new Uint8Array(g.cols * g.rows);
  const colOf = (x) => (x / proj.kx + proj.lon0 - g.lon) / g.dLon;
  const rowOf = (z) => (g.lat - (proj.lat0 - z / proj.ky)) / g.dLat;
  for (const a of areas) {
    const rings = [a.outer, ...(a.holes || [])].map((ring) => ring.map(([x, z]) => [colOf(x), rowOf(z)]));
    let r0 = Infinity, r1 = -Infinity;
    for (const ring of rings) for (const p of ring) { r0 = Math.min(r0, p[1]); r1 = Math.max(r1, p[1]); }
    for (let r = Math.max(0, Math.ceil(r0)); r <= Math.min(g.rows - 1, Math.floor(r1)); r++) {
      const xs = [];
      for (const ring of rings) {
        for (let i = 0; i < ring.length; i++) {
          const [ax, ay] = ring[i], [bx, by] = ring[(i + 1) % ring.length];
          if ((ay <= r && by > r) || (by <= r && ay > r)) xs.push(ax + ((r - ay) / (by - ay)) * (bx - ax));
        }
      }
      xs.sort((p, q) => p - q);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        for (let c = Math.max(0, Math.ceil(xs[k])); c <= Math.min(g.cols - 1, Math.floor(xs[k + 1])); c++) mask[r * g.cols + c] = 1;
      }
    }
  }
  return mask;
}

// NaN の格子点を、まわりの値の平均で外側から順に埋める（maxRings 周まで）
export function extendInto(data, cols, rows, maxRings = Infinity) {
  let front = [];
  const nb = [[-1, 0], [1, 0], [0, -1], [0, 1]];
  for (let i = 0; i < data.length; i++) {
    if (!Number.isNaN(data[i])) continue;
    const r = Math.floor(i / cols), c = i - r * cols;
    if (nb.some(([dc, dr]) => c + dc >= 0 && c + dc < cols && r + dr >= 0 && r + dr < rows && !Number.isNaN(data[(r + dr) * cols + c + dc]))) front.push(i);
  }
  const queued = new Uint8Array(data.length);
  for (const i of front) queued[i] = 1;
  for (let ring = 0; ring < maxRings && front.length; ring++) {
    const vals = front.map((i) => {
      const r = Math.floor(i / cols), c = i - r * cols;
      let s = 0, n = 0;
      for (const [dc, dr] of nb) {
        const cc = c + dc, rr = r + dr;
        if (cc < 0 || cc >= cols || rr < 0 || rr >= rows) continue;
        const v = data[rr * cols + cc];
        if (!Number.isNaN(v)) {
          s += v;
          n++;
        }
      }
      return n ? s / n : NaN;
    });
    front.forEach((i, k) => (data[i] = vals[k]));
    const next = [];
    for (const i of front) {
      const r = Math.floor(i / cols), c = i - r * cols;
      for (const [dc, dr] of nb) {
        const cc = c + dc, rr = r + dr;
        if (cc < 0 || cc >= cols || rr < 0 || rr >= rows) continue;
        const j = rr * cols + cc;
        if (!queued[j] && Number.isNaN(data[j])) {
          queued[j] = 1;
          next.push(j);
        }
      }
    }
    front = next;
  }
}

// 平らな所（3 × 3 の高低差が relief m 未満）だけ [1 2 1] でならす
export function smoothFlat(data, cols, rows, relief = 1.0) {
  const src = data.slice();
  for (let r = 1; r + 1 < rows; r++) {
    for (let c = 1; c + 1 < cols; c++) {
      const i = r * cols + c;
      let lo = Infinity, hi = -Infinity, s = 0;
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          const v = src[i + dr * cols + dc];
          lo = Math.min(lo, v);
          hi = Math.max(hi, v);
          s += v * (dr ? 1 : 2) * (dc ? 1 : 2);
        }
      }
      if (hi - lo < relief) data[i] = s / 16;
    }
  }
}

// 水面の格子（地面の格子の k 点ごと）: 水域の格子点の生の値（地形モデルの水面）の、まわり ±win 点の中央値。水のない所は 3 周まで延ばす
export function waterLevels(raw, mask, g, k = 4, win = 6) {
  const cols = Math.ceil(g.cols / k), rows = Math.ceil(g.rows / k);
  const data = new Float32Array(cols * rows).fill(NaN);
  const buf = [];
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      buf.length = 0;
      const c0 = i * k, r0 = j * k;
      for (let r = Math.max(0, r0 - win); r <= Math.min(g.rows - 1, r0 + win); r++) {
        for (let c = Math.max(0, c0 - win); c <= Math.min(g.cols - 1, c0 + win); c++) if (mask[r * g.cols + c]) buf.push(raw[r * g.cols + c]);
      }
      if (buf.length < 3) continue;
      buf.sort((a, b) => a - b);
      data[j * cols + i] = buf[buf.length >> 1];
    }
  }
  extendInto(data, cols, rows, 3);
  return { lat: g.lat, lon: g.lon, dLat: g.dLat * k, dLon: g.dLon * k, cols, rows, data };
}

const median = (a) => {
  const s = a.filter((v) => !Number.isNaN(v)).sort((p, q) => p - q);
  return s.length ? s[s.length >> 1] : NaN;
};

// 橋面の縦断面（標高 m、step m ごと）。dsm(x, z): 表面モデルの高さ（ローカル座標）。中心線 pts、半幅 half
export function deckProfile(pts, half, dsm, step = 5) {
  const fr = polyFrame(pts);
  const L = fr.length, ds = 2;
  const n = Math.max(2, Math.round(L / ds) + 1);
  const lines = [-0.6, 0, 0.6].map((f) => {
    const v = [];
    for (let k = 0; k < n; k++) {
      const s = (L * k) / (n - 1);
      const [x, z] = fr.at(pts, s);
      const [tx, tz] = fr.tangent(fr.locate(s)[0]);
      v.push(dsm(x - tz * f * half, z + tx * f * half));
    }
    // 7 点（14 m）の中央値（車・街灯・欄干）
    return v.map((_, k) => median(v.slice(Math.max(0, k - 3), k + 4)));
  });
  let D = lines[0].map((_, k) => Math.min(...lines.map((l) => (Number.isNaN(l[k]) ? Infinity : l[k]))));
  D = D.map((v) => (Number.isFinite(v) ? v : NaN));
  // 30 m の移動中央値から離れた点（橋にかかる木・上を通る高速道路）を除いて、間を直線で埋める
  const tol = Math.max(0.8, 0.005 * L);
  const med = D.map((_, k) => median(D.slice(Math.max(0, k - 7), k + 8)));
  const ok = D.map((v, k) => !Number.isNaN(v) && Math.abs(v - med[k]) <= tol);
  const good = ok.filter(Boolean).length;
  if (good < n * 0.5) return null;
  const idx = [];
  ok.forEach((o, k) => o && idx.push(k));
  const Y = D.map((v, k) => {
    if (ok[k]) return v;
    let a = idx.findLast((i) => i < k), b = idx.find((i) => i > k);
    if (a == null) a = b;
    if (b == null) b = a;
    return a === b ? D[a] : D[a] + ((D[b] - D[a]) * (k - a)) / (b - a);
  });
  const out = [];
  for (let s = 0; s < L + step * 0.5; s += step) {
    const f = Math.min(s, L) / (L / (n - 1));
    const i = Math.min(Math.floor(f), n - 2);
    out.push(Math.round((Y[i] + (Y[i + 1] - Y[i]) * (f - i)) * 100) / 100);
  }
  return out;
}

// 長い橋（length m 以上）の縦断面を表面モデルから測る
async function bakeBridges(parsed, proj, onStatus, minLen = 30) {
  const info = bridgeGroups(parsed.roads);
  const roots = new Set();
  for (const v of info.values()) roots.add(v.root);
  const list = [...roots].filter((r) => polyFrame(r.pts).length >= minLen);
  const out = [];
  let done = 0;
  const queue = list.slice();
  const worker = async () => {
    while (queue.length) {
      const r = queue.shift();
      const half = deckHalf(r);
      let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
      for (const [x, z] of r.pts) {
        minX = Math.min(minX, x); maxX = Math.max(maxX, x);
        minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
      }
      const m = half + 6;
      minX -= m; maxX += m; minZ -= m; maxZ += m;
      const [n, w] = proj.unproject(minX, minZ), [s, e] = proj.unproject(maxX, maxZ);
      const cols = Math.max(4, Math.round(maxX - minX)), rows = Math.max(4, Math.round(maxZ - minZ));
      try {
        const { data } = await fetchElevation(LIDAR_LAYERS.dsm, { s, w, n, e }, cols, rows, { concurrency: 1 });
        const dsm = (x, z) => {
          const c = Math.floor(((x - minX) / (maxX - minX)) * cols), rr = Math.floor(((z - minZ) / (maxZ - minZ)) * rows);
          return c < 0 || rr < 0 || c >= cols || rr >= rows ? NaN : data[rr * cols + c];
        };
        const y = deckProfile(r.pts, half, dsm);
        if (y) {
          const a = proj.unproject(...r.pts[0]), b = proj.unproject(...r.pts[r.pts.length - 1]);
          out.push({ name: r.name || '', a: a.map((v) => Math.round(v * 1e7) / 1e7), b: b.map((v) => Math.round(v * 1e7) / 1e7), y });
        }
      } catch (err) {
        console.warn(`橋 ${r.name || r.id}: 表面モデルを取れませんでした（${err.message}）`);
      }
      onStatus?.(`橋の縦断面 ${++done}/${list.length}`);
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  out.sort((p, q) => p.a[0] - q.a[0] || p.a[1] - q.a[1]);
  return out;
}

// bbox（緯度経度）の地形を作る。parsed/proj: そのエリアの地図（水域と橋）。step: 格子（m）、sub: 取得の細かさ（step/sub m）
// withDsm: 橋の縦断面を測るか。戻り値は terrain.js の encodeTerrain / Terrain にそのまま渡せる
export async function bakeTerrain({ bbox, parsed, proj, step = LATTICE.step, sub = 2, margin = 600, farRadius = 6000, withDsm = true, onStatus = () => {} }) {
  const g = latticeFor(grow(bbox, margin), step);
  onStatus(`地形モデル ${g.cols} × ${g.rows}（${step} m）を取得中…`);
  const data = await fetchLattice(LIDAR_LAYERS.dtm, g, sub, (f) => onStatus(`地形モデル ${(f * 100).toFixed(0)} %`));
  const water = parsed.areas.filter((a) => a.type === 'water');
  const mask = rasterizeWater(water, g, proj);
  const raw = data.slice();
  for (let i = 0; i < mask.length; i++) if (mask[i]) data[i] = NaN;
  extendInto(data, g.cols, g.rows);
  for (let k = 0; k < 3; k++) smoothFlat(data, g.cols, g.rows);
  const level = waterLevels(raw, mask, g, Math.max(1, Math.round(20 / step)), Math.max(2, Math.round(30 / step)));
  onStatus('遠くの地形を取得中…');
  const fg = latticeFor(grow(bbox, farRadius), 50);
  const far = { ...fg, data: await fetchLattice(LIDAR_LAYERS.dtm, fg, 1) };
  const bridges = withDsm ? await bakeBridges(parsed, proj, onStatus) : [];
  return { near: { ...g, data }, far, level, bridges };
}
