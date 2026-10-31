// メトロ（地下鉄 A・B 線）の駅の出入口を、実測データから見つける。
// - 駅の位置と名前: IGN BD TOPO の equipement_de_transport（nature = 'Station de métro'、営業中のもの。地下の駅の形）
// - 出入口: LiDAR HD の地形モデル（0.5 m）で、駅のまわり ±R m の地面にあいた細長い穴（階段・エスカレーターの吹き抜け）。
//   地面を「幅 CLOSE m の窓で閉じた面」（穴を埋めた面）と比べ、PIT_DEPTH m 以上低い所のまとまりを、面積・形で選ぶ。
//   建物の中（地形モデルは建物の下を補間するので、偽の穴ができる）と、駅から NEAR m より遠い穴は捨てる
// - 地下駐車場（BD TOPO の 'Parking souterrain'）のまわりの長くてなだらかな穴は、車の坂（kind: 'parking'）
// 結果は [{ kind, station | name, lon, lat, len, wid, ang, depth, down }]（scripts/fetch-data.mjs で public/data/<エリア>-metro.json に入れる）。
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
// 地下駐車場の車の坂: 駐車場の印から RAMP_NEAR m 以内、長さ RAMP_MIN_LEN m 以上・幅 RAMP_MIN_WID m 以上で、
// 深さ ÷ 長さが RAMP_SLOPE 以下（車の坂は 15〜20 %。階段・エスカレーターの吹き抜けは 30 % 以上）
const RAMP_NEAR = 100, RAMP_AT = 30, RAMP_MIN_LEN = 12, RAMP_MIN_WID = 3.2, RAMP_SLOPE = 0.22, RAMP_AT_SLOPE = 0.4, RAMP_MAX_WID = 18;
const PER_PARKING = 3;

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

const CORNERS = [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]];

// 点の凸包（反時計回り。単調連鎖法）
function convexHull(pts) {
  const p = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [], hi = [];
  for (const q of p) {
    while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop();
    lo.push(q);
  }
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i];
    while (hi.length >= 2 && cross(hi[hi.length - 2], hi[hi.length - 1], q) <= 0) hi.pop();
    hi.push(q);
  }
  return lo.slice(0, -1).concat(hi.slice(0, -1));
}

// 凸包を囲む面積が最小の長方形の長い辺の向き（ラジアン。凸包の辺の向きのどれか）
export function minAreaAngle(hull) {
  let best = Infinity, ang = 0;
  for (let i = 0; i < hull.length; i++) {
    const [ax, az] = hull[i], [bx, bz] = hull[(i + 1) % hull.length];
    const th = Math.atan2(bz - az, bx - ax), ux = Math.cos(th), uz = Math.sin(th);
    let t0 = Infinity, t1 = -Infinity, s0 = Infinity, s1 = -Infinity;
    for (const [x, z] of hull) {
      const t = x * ux + z * uz, s = -x * uz + z * ux;
      t0 = Math.min(t0, t);
      t1 = Math.max(t1, t);
      s0 = Math.min(s0, s);
      s1 = Math.max(s1, s);
    }
    const area = (t1 - t0) * (s1 - s0);
    if (area < best - 1e-9) {
      best = area;
      ang = t1 - t0 >= s1 - s0 ? th : th + Math.PI / 2;
    }
  }
  // −π/2〜π/2 に
  while (ang > Math.PI / 2) ang -= Math.PI;
  while (ang <= -Math.PI / 2) ang += Math.PI;
  return ang;
}

// 地面の高さの格子（行 0 = 北、cols × rows、res m）から出入口の穴を見つける。
// 返り値の x, z は格子の中心から（x 東、z 南、m）
// orient(x, z, ang): 測った向きを直す（近くの建物の壁の向きにそろえる。scanPits）
export function detectEntrances(h, cols, rows, res = RES, { close = CLOSE, depth = PIT_DEPTH, minArea = MIN_AREA, maxArea = MAX_AREA, minLen = MIN_LEN, maxWid = MAX_WID, orient = null } = {}) {
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
    // 向き: 穴（マスの角の点）の凸包を囲む面積が最小の長方形の向き（吹き抜け・坂の縁のまっすぐな辺に合う。
    // 共分散の主軸は、形が少しいびつだと広場の石畳の向きから大きくずれる）
    let mx = 0, mz = 0;
    for (const i of cells) {
      mx += (i % cols) * res;
      mz += ((i / cols) | 0) * res;
    }
    mx /= cells.length;
    mz /= cells.length;
    const pts = [];
    for (const i of cells) {
      const x = (i % cols) * res - mx, z = ((i / cols) | 0) * res - mz;
      for (const [ox, oz] of CORNERS) pts.push([x + ox * res, z + oz * res]);
    }
    let ang = minAreaAngle(convexHull(pts));
    if (orient) ang = orient(mx - (cols * res) / 2, mz - (rows * res) / 2, ang);
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

// 営業中のメトロの駅 [{ name, lon, lat }] と地下駐車場 [{ name, lon, lat }]（BD TOPO。駅は地下の駅の形の重心、
// 駐車場は小さな印の形の重心）
export async function fetchMetroStations(bbox) {
  const features = await fetchWfsLayer('equipement_de_transport', bbox);
  const stations = [], parkings = [];
  for (const f of features) {
    const p = f.properties || {};
    const metro = p.nature === 'Station de métro' && p.etat_de_l_objet === 'En service';
    const parking = p.nature === 'Parking' && p.nature_detaillee === 'Parking souterrain';
    if (!metro && !parking) continue;
    const raw = polygonsOf(f.geometry)[0]?.[0];
    if (!raw || !raw.length) continue;
    const ring = normalizeCoords(raw.map((q) => [q[0], q[1]]), bbox);
    let lon = 0, lat = 0;
    for (const [x, y] of ring) {
      lon += x;
      lat += y;
    }
    (metro ? stations : parkings).push({ name: p.toponyme || '', lon: lon / ring.length, lat: lat / ring.length });
  }
  return { stations, parkings };
}

// 地下駐車場の車の坂か（駐車場の印から RAMP_NEAR m 以内で、長くてなだらか。メトロの階段・エスカレーターは急）
// 駐車場の印のすぐそば（RAMP_AT m 以内）の長い穴は、少し急でも幅が広くても坂（キャピトル広場の坂は幅 16 m、奥が 9 m 近く深い。
// 深さ ÷ 長さが RAMP_AT_SLOPE を超える階段の吹き抜けは除く）
export function isParkingRamp(e, distToParking) {
  if (distToParking <= RAMP_AT && e.len >= RAMP_MIN_LEN && e.depth / e.len <= RAMP_AT_SLOPE) return true;
  return distToParking <= RAMP_NEAR && e.len >= RAMP_MIN_LEN && e.wid >= RAMP_MIN_WID && e.wid <= MAX_WID && e.depth / e.len <= RAMP_SLOPE;
}

// 街並みの向きにそろえる: segs（[x0, z0, x1, z1] m。建物の外形の辺）のうち (x, z) から near m 以内の辺の向き（90° ごとに同じ）を
// 長さで重みを付けて 1° ごとに数え、ang から maxDiff 以内でいちばん多い向きへ（長い向き・短い向きのどちらに近いかは保つ）
export function snapToStreetGrid(ang, x, z, segs, { near = 60, maxDiff = (15 * Math.PI) / 180 } = {}) {
  const bins = new Float32Array(90);
  for (const [x0, z0, x1, z1] of segs) {
    const mxs = (x0 + x1) / 2, mzs = (z0 + z1) / 2;
    if (Math.hypot(mxs - x, mzs - z) > near) continue;
    const L = Math.hypot(x1 - x0, z1 - z0);
    if (L < 2) continue;
    let d = (Math.atan2(z1 - z0, x1 - x0) * 180) / Math.PI;
    d = ((d % 90) + 90) % 90;
    bins[Math.floor(d) % 90] += L;
  }
  const a = (((ang * 180) / Math.PI) % 90 + 90) % 90;
  let best = -1, bestW = 0;
  for (let k = 0; k < 90; k++) {
    // ±2° でならした重み
    let w = 0;
    for (let j = -2; j <= 2; j++) w += bins[(k + j + 90) % 90] * (1 - Math.abs(j) / 3);
    let diff = Math.abs(k + 0.5 - a);
    diff = Math.min(diff, 90 - diff);
    if ((diff * Math.PI) / 180 <= maxDiff && w > bestW) {
      bestW = w;
      best = k + 0.5;
    }
  }
  if (best < 0) return ang;
  let delta = best - a;
  if (delta > 45) delta -= 90;
  if (delta < -45) delta += 90;
  return ang + (delta * Math.PI) / 180;
}

// 中心 (lon, lat) のまわり ±r m の穴の候補（建物の中・浅いものを除く）。x, z: 中心からの m、lon, lat 付き
async function scanPits(lon0, lat0, r, label, log) {
  const mz = 110574, mx = 111320 * Math.cos((lat0 * Math.PI) / 180);
  const b = { s: lat0 - r / mz, n: lat0 + r / mz, w: lon0 - r / mx, e: lon0 + r / mx };
  const N = Math.round((2 * r) / RES);
  let grid;
  try {
    grid = await fetchElevation(LIDAR_LAYERS.dtm, b, N, N);
  } catch (err) {
    log(`  ${label}: 地形モデルを取れませんでした（${err.message}）`);
    return [];
  }
  // 建物の外形（BD TOPO。中心が建物の中の穴は捨てる）
  let rings = [];
  try {
    rings = (await fetchWfsLayer('batiment', b, { propertyNames: ['geometrie'] })).flatMap((f) => polygonsOf(f.geometry).map((p) => normalizeCoords(p[0].map((q) => [q[0], q[1]]), b)));
  } catch (err) {
    log(`  ${label}: 建物を取れませんでした（${err.message}）`);
  }
  // 建物の外形の辺（中心からの m。x 東・z 南）
  const segs = [];
  for (const ring of rings) {
    for (let i = 0; i + 1 < ring.length; i++) segs.push([(ring[i][0] - lon0) * mx, (lat0 - ring[i][1]) * mz, (ring[i + 1][0] - lon0) * mx, (lat0 - ring[i + 1][1]) * mz]);
  }
  return detectEntrances(grid.data || grid, N, N, RES, { maxWid: RAMP_MAX_WID, orient: (x, z, ang) => snapToStreetGrid(ang, x, z, segs) })
    .map((e) => ({ ...e, lon: lon0 + e.x / mx, lat: lat0 - e.z / mz }))
    .filter((e) => e.depth >= MIN_DEPTH && !rings.some((ring) => inRing(e.lon, e.lat, ring)));
}

// bbox の中の駅ごとに地形モデルを取り、出入口を見つける（同じ駅の名前が 2 つあれば両方の範囲を調べ、重なった穴は 1 つに）。
// 地下駐車場のまわりも調べ、車の坂（isParkingRamp）は kind: 'parking' にする（駅のまわりで見つけた穴も、駐車場の近くの坂は駐車場）
export async function fetchMetroEntrances(bbox, { log = () => {} } = {}) {
  const inBox = (s) => s.lat > bbox.s && s.lat < bbox.n && s.lon > bbox.w && s.lon < bbox.e;
  const all = await fetchMetroStations(bbox);
  const stations = all.stations.filter(inBox), parkings = all.parkings.filter(inBox);
  const out = [];
  const dist = (a, b) => Math.hypot((a.lon - b.lon) * 111320 * Math.cos((a.lat * Math.PI) / 180), (a.lat - b.lat) * 110574);
  const nearestParking = (e) => parkings.reduce((m, p) => Math.min(m, dist(e, p)), Infinity);
  const r = (v, k) => Math.round(v * 10 ** k) / 10 ** k;
  const add = (e, kind, name) => {
    if (out.some((o) => dist(o, e) < 3)) return false;
    out.push({ kind, ...(kind === 'metro' ? { station: name } : { name }), lon: r(e.lon, 7), lat: r(e.lat, 7), len: r(e.len, 1), wid: r(e.wid, 1), ang: r(e.ang, 3), depth: r(e.depth, 1), down: e.down });
    return true;
  };
  for (const s of stations) {
    const found = (await scanPits(s.lon, s.lat, R, `メトロ ${s.name}`, log)).filter((e) => Math.hypot(e.x, e.z) <= NEAR);
    const ramps = found.filter((e) => isParkingRamp(e, nearestParking(e)));
    const metro = found.filter((e) => !ramps.includes(e) && e.wid <= MAX_WID)
      .sort((p, q) => q.depth * Math.min(q.len, 20) - p.depth * Math.min(p.len, 20))
      .slice(0, PER_STATION);
    let n = 0;
    for (const e of metro) n += add(e, 'metro', s.name) ? 1 : 0;
    for (const e of ramps) add(e, 'parking', parkings.reduce((m, p) => (dist(e, p) < dist(e, m) ? p : m)).name);
    log(`  メトロ ${s.name}: 出入口 ${n}${ramps.length ? `（駐車場の坂 ${ramps.length}）` : ''}`);
  }
  for (const p of parkings) {
    const ramps = (await scanPits(p.lon, p.lat, R, `駐車場 ${p.name}`, log))
      .filter((e) => isParkingRamp(e, dist(e, p)))
      .sort((a, b) => b.depth * b.len - a.depth * a.len)
      .slice(0, PER_PARKING);
    let n = 0;
    for (const e of ramps) n += add(e, 'parking', p.name) ? 1 : 0;
    log(`  駐車場 ${p.name || '（名前なし）'}: 坂 ${n}`);
  }
  return { stations, parkings, entrances: out };
}
