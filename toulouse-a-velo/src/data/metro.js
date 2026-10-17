// メトロ（地下鉄 A・B 線）の駅の出入口を、実測データから見つける。
// - 駅の位置と名前: IGN BD TOPO の equipement_de_transport（nature = 'Station de métro'、営業中のもの。地下の駅の形）
// - 出入口: LiDAR HD の地形モデル（0.5 m）で、駅のまわり ±R m の地面にあいた細長い穴（階段・エスカレーターの吹き抜け）。
//   地面を「幅 CLOSE m の窓で閉じた面」（穴を埋めた面）と比べ、PIT_DEPTH m 以上低い所のまとまりを、面積・形で選ぶ。
//   建物の中（地形モデルは建物の下を補間するので、偽の穴ができる）と、駅から NEAR m より遠い穴は捨てる
// 結果は [{ station, lon, lat, len, wid, ang, depth, down }]（scripts/fetch-data.mjs で public/data/<エリア>-metro.json に入れる）。
// ang: 長い向き（東から南へのラジアン、ローカル座標の x 東・z 南）、down: 長い向きのどちらへ下りるか（+1 / -1）。
// three.js を使わない（単体テストできる）
import { fetchWfsLayer, normalizeCoords, polygonsOf } from './bdtopo.js';
import { LIDAR_LAYERS, fetchElevation } from './lidar.js';

const RES = 0.5; // m
const R = 110; // 駅の中心から調べる範囲（m）
const CLOSE = 16; // 穴を埋める窓（m。出入口の幅より広く、広場・中庭より狭い）
const PIT_DEPTH = 1.2; // m
const MIN_AREA = 8, MAX_AREA = 300; // m²
const MIN_LEN = 4.5, MAX_WID = 13; // m
const NEAR = 95; // 駅の中心から出入口までの最大の距離（m。駅のホームの長さ＋通路）
const MIN_DEPTH = 1.8; // m（浅いくぼみは植え込み・溝）
const PER_STATION = 4; // 駅ごとの出入口の数の上限（深さ × 長さの大きい順）

// 1 次元の窓の最大・最小（行または列。src を len 個、step おき）
function slide(src, dst, off, len, step, k, max) {
  for (let i = 0; i < len; i++) {
    let v = max ? -Infinity : Infinity;
    for (let j = Math.max(0, i - k); j <= Math.min(len - 1, i + k); j++) {
      const a = src[off + j * step];
      if (max ? a > v : a < v) v = a;
    }
    dst[off + i * step] = v;
  }
}

// 2 次元の窓 (2k+1)² の最大（max）または最小
function morph(h, cols, rows, k, max) {
  const t = new Float32Array(h.length), o = new Float32Array(h.length);
  for (let r = 0; r < rows; r++) slide(h, t, r * cols, cols, 1, k, max);
  for (let c = 0; c < cols; c++) slide(t, o, c, rows, cols, k, max);
  return o;
}

// 地面の高さの格子（行 0 = 北、cols × rows、res m）から出入口の穴を見つける。
// 返り値の x, z は格子の中心から（x 東、z 南、m）
export function detectEntrances(h, cols, rows, res = RES, { close = CLOSE, depth = PIT_DEPTH, minArea = MIN_AREA, maxArea = MAX_AREA, minLen = MIN_LEN, maxWid = MAX_WID } = {}) {
  // 測れていない所（NaN・とても低い値）は全体の中央値で埋める
  const ok = [];
  for (const v of h) if (Number.isFinite(v) && v > -100) ok.push(v);
  ok.sort((a, b) => a - b);
  const med = ok.length ? ok[ok.length >> 1] : 0;
  const g = Float32Array.from(h, (v) => (Number.isFinite(v) && v > -100 ? v : med));
  const k = Math.max(1, Math.round(close / res / 2));
  const closed = morph(morph(g, cols, rows, k, true), cols, rows, k, false);
  const pit = new Uint8Array(g.length);
  for (let i = 0; i < g.length; i++) pit[i] = closed[i] - g[i] > depth ? 1 : 0;
  // 4 近傍でつながったまとまり
  const seen = new Uint8Array(g.length), out = [];
  const stack = [];
  for (let i0 = 0; i0 < g.length; i0++) {
    if (!pit[i0] || seen[i0]) continue;
    const cells = [];
    stack.push(i0);
    seen[i0] = 1;
    while (stack.length) {
      const i = stack.pop();
      cells.push(i);
      const r = (i / cols) | 0, c = i - r * cols;
      for (const j of [c > 0 ? i - 1 : -1, c + 1 < cols ? i + 1 : -1, r > 0 ? i - cols : -1, r + 1 < rows ? i + cols : -1]) {
        if (j >= 0 && pit[j] && !seen[j]) {
          seen[j] = 1;
          stack.push(j);
        }
      }
    }
    const area = cells.length * res * res;
    if (area < minArea || area > maxArea) continue;
    // 主軸（共分散の固有ベクトル）で長さ・幅・向きを測る
    let mx = 0, mz = 0;
    for (const i of cells) {
      mx += (i % cols) * res;
      mz += ((i / cols) | 0) * res;
    }
    mx /= cells.length;
    mz /= cells.length;
    let sxx = 0, szz = 0, sxz = 0;
    for (const i of cells) {
      const dx = (i % cols) * res - mx, dz = ((i / cols) | 0) * res - mz;
      sxx += dx * dx;
      szz += dz * dz;
      sxz += dx * dz;
    }
    sxx /= cells.length;
    szz /= cells.length;
    sxz /= cells.length;
    const ang = 0.5 * Math.atan2(2 * sxz, sxx - szz);
    const ux = Math.cos(ang), uz = Math.sin(ang);
    let t0 = Infinity, t1 = -Infinity, s0 = Infinity, s1 = -Infinity, st = 0, sd = 0, stt = 0, std = 0, dmax = 0;
    for (const i of cells) {
      const dx = (i % cols) * res - mx, dz = ((i / cols) | 0) * res - mz;
      const t = dx * ux + dz * uz, s = -dx * uz + dz * ux, d = closed[i] - g[i];
      t0 = Math.min(t0, t);
      t1 = Math.max(t1, t);
      s0 = Math.min(s0, s);
      s1 = Math.max(s1, s);
      st += t;
      sd += d;
      stt += t * t;
      std += t * d;
      dmax = Math.max(dmax, d);
    }
    const n = cells.length, len = t1 - t0 + res, wid = s1 - s0 + res;
    if (len < minLen || wid > maxWid || len < wid * 1.3) continue;
    // 深い方の端へ下りる（長い向きに沿った深さの回帰の傾き）
    const slope = (std - (st * sd) / n) / Math.max(1e-9, stt - (st * st) / n);
    // 上の端は浅い（穴の深さ depth m より浅い段は穴に入らない）ので、深さの傾きから上の端を延ばす（4 m まで）
    const ext = Math.abs(slope) > 0.05 ? Math.min(4, depth / Math.abs(slope)) : 0;
    const a0 = slope >= 0 ? t0 - ext : t0, a1 = slope >= 0 ? t1 : t1 + ext;
    // 長方形の中心（主軸の範囲の真ん中）
    const cx = mx + (ux * (a0 + a1)) / 2 - (uz * (s0 + s1)) / 2, cz = mz + (uz * (a0 + a1)) / 2 + (ux * (s0 + s1)) / 2;
    out.push({ x: cx - (cols * res) / 2, z: cz - (rows * res) / 2, len: len + ext, wid, ang, depth: dmax, down: slope >= 0 ? 1 : -1 });
  }
  return out;
}

// 点が多角形（[経度, 緯度] の環）の中か
function inRing(x, y, r) {
  let inside = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [xi, yi] = r[i], [xj, yj] = r[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// 営業中のメトロの駅 [{ name, lon, lat }]（BD TOPO。地下の駅の形の重心）
export async function fetchMetroStations(bbox) {
  const features = await fetchWfsLayer('equipement_de_transport', bbox);
  const out = [];
  for (const f of features) {
    const p = f.properties || {};
    if (p.nature !== 'Station de métro' || p.etat_de_l_objet !== 'En service') continue;
    const raw = polygonsOf(f.geometry)[0]?.[0];
    if (!raw || !raw.length) continue;
    const ring = normalizeCoords(raw.map((p) => [p[0], p[1]]), bbox);
    let lon = 0, lat = 0;
    for (const [x, y] of ring) {
      lon += x;
      lat += y;
    }
    out.push({ name: p.toponyme || '', lon: lon / ring.length, lat: lat / ring.length });
  }
  return out;
}

// bbox の中の駅ごとに地形モデルを取り、出入口を見つける（同じ駅の名前が 2 つあれば両方の範囲を調べ、重なった穴は 1 つに）
export async function fetchMetroEntrances(bbox, { log = () => {} } = {}) {
  const stations = (await fetchMetroStations(bbox)).filter((s) => s.lat > bbox.s && s.lat < bbox.n && s.lon > bbox.w && s.lon < bbox.e);
  const out = [];
  for (const s of stations) {
    const mz = 110574, mx = 111320 * Math.cos((s.lat * Math.PI) / 180);
    const b = { s: s.lat - R / mz, n: s.lat + R / mz, w: s.lon - R / mx, e: s.lon + R / mx };
    const N = Math.round((2 * R) / RES);
    let grid;
    try {
      grid = await fetchElevation(LIDAR_LAYERS.dtm, b, N, N);
    } catch (err) {
      log(`  メトロ ${s.name}: 地形モデルを取れませんでした（${err.message}）`);
      continue;
    }
    // 建物の外形（BD TOPO。中心が建物の中の穴は捨てる）
    let rings = [];
    try {
      rings = (await fetchWfsLayer('batiment', b, { propertyNames: ['geometrie'] })).flatMap((f) => polygonsOf(f.geometry).map((p) => normalizeCoords(p[0].map((q) => [q[0], q[1]]), b)));
    } catch (err) {
      log(`  メトロ ${s.name}: 建物を取れませんでした（${err.message}）`);
    }
    const inBuilding = (lon, lat) => rings.some((r) => inRing(lon, lat, r));
    const found = detectEntrances(grid.data || grid, N, N, RES)
      .filter((e) => Math.hypot(e.x, e.z) <= NEAR && e.depth >= MIN_DEPTH && !inBuilding(s.lon + e.x / mx, s.lat - e.z / mz))
      .sort((p, q) => q.depth * Math.min(q.len, 20) - p.depth * Math.min(p.len, 20))
      .slice(0, PER_STATION);
    for (const e of found) {
      const lon = s.lon + e.x / mx, lat = s.lat - e.z / mz;
      if (out.some((o) => Math.hypot((o.lon - lon) * mx, (o.lat - lat) * mz) < 3)) continue;
      const r = (v, k) => Math.round(v * 10 ** k) / 10 ** k;
      out.push({ station: s.name, lon: r(lon, 7), lat: r(lat, 7), len: r(e.len, 1), wid: r(e.wid, 1), ang: r(e.ang, 3), depth: r(e.depth, 1), down: e.down });
    }
    log(`  メトロ ${s.name}: 出入口 ${found.length}`);
  }
  return { stations, entrances: out };
}
