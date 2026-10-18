// 地形（地面の本当の高さ）。IGN LiDAR HD の地形モデル（MNT、地面だけの高さ）から作った 5 m の格子（data/terrainbake.js）。
// - 高さは y = 標高 − DATUM（145 m）。ポン・ヌフの右岸の端がほぼ y = 0、旧市街は −2.5〜+1、サン・シプリアンは −8〜−6、
//   ガロンヌ川の水面は −12.5、ジョリモンは +47、ペシュ・ダヴィッドは +93〜+114
// - 格子は緯度・経度に固定する（トゥールーズ全体のエリアの座標で 5 m ごと）。どのエリア・どのタイルでも、同じ緯度経度なら
//   同じ高さになる（タイルの継ぎ目ができない）
// - 格子の各マスは対角線 (c, r)–(c+1, r+1) で 2 枚の三角形に分け、高さはその平面。地面のメッシュも上に重ねる面（道路・歩道・
//   標示）も、この格子の線と対角線で切り分けて同じ平面に載せる（split）ので、地面が上の面を突き抜けることがない
// - 川・運河の上は「岸から延ばした」高さ（水面はステンシルの穴から見る）。水面の高さは別の格子（level）
// - 橋の上の高さは deck()（bridges.js の setupDecks が橋ごとの縦断面を登録する）
// FLAT_TERRAIN は今までの平らな世界（地面 y = 0）と同じ結果になる（地形のファイルがないときと単体テスト）。
import { Grid, closestOnSegment, pointInRing } from '../geo.js';

export const DATUM = 145; // y = 標高 − DATUM（m）
export const DRAPE_TOL = 0.04; // 地面に重ねる面: 頂点だけ載せた平面と地面の差がこれ以下なら三角形を切らない（MeshWriter の tol）
export const DRAPE_LIFT = 0.05; // 地面に重ねる平らな面を地面から浮かせる高さ（DRAPE_TOL より大きく。地面が突き抜けない）
export const DECK_TOP = 0.08; // 橋の車道の面（bridges.js の topY と同じ）
export const TERRAIN_VERSION = 1;
// 格子の基準: トゥールーズ全体のエリアの原点。どのエリアの地形ファイルもこの格子の一部を切り出したもの
export const LATTICE = { lat: 43.5994, lon: 1.4395, step: 5 };
const MAGIC = 0x54564154; // 'TAVT'

// 緯度経度の格子 g を、エリアの投影 proj のローカル座標から引けるようにする（列 = ax·x + bx、行 = az·z + bz）
function prepGrid(g, proj) {
  return {
    ...g,
    ax: 1 / (proj.kx * g.dLon), bx: (proj.lon0 - g.lon) / g.dLon,
    az: 1 / (proj.ky * g.dLat), bz: (g.lat - proj.lat0) / g.dLat,
  };
}

// 格子の平面補間（対角線 (c, r)–(c+1, r+1) で分けた三角形の平面）。u, v: 列・行（範囲内）
function planar(g, u, v) {
  const cols = g.cols, d = g.data;
  const c = Math.min(Math.floor(u), cols - 2), r = Math.min(Math.floor(v), g.rows - 2);
  const fu = u - c, fv = v - r, i = r * cols + c;
  const h00 = d[i], h10 = d[i + 1], h01 = d[i + cols], h11 = d[i + cols + 1];
  return fu >= fv ? h00 + fu * (h10 - h00) + fv * (h11 - h10) : h00 + fv * (h01 - h00) + fu * (h11 - h01);
}

// 双線形補間（遠くの格子・水面の格子。範囲外は端の値）。NaN の格子点は使わない（すべて NaN なら NaN）
function bilinear(g, u, v) {
  u = Math.min(Math.max(u, 0), g.cols - 1.0001);
  v = Math.min(Math.max(v, 0), g.rows - 1.0001);
  const c = Math.floor(u), r = Math.floor(v), fu = u - c, fv = v - r, i = r * g.cols + c, d = g.data;
  const w = [(1 - fu) * (1 - fv), fu * (1 - fv), (1 - fu) * fv, fu * fv], h = [d[i], d[i + 1], d[i + g.cols], d[i + g.cols + 1]];
  let s = 0, n = 0;
  for (let k = 0; k < 4; k++) {
    if (Number.isNaN(h[k])) continue;
    s += w[k] * h[k];
    n += w[k];
  }
  return n > 1e-6 ? s / n : NaN;
}

const lerpV = (a, b, t) => {
  const o = new Array(a.length);
  for (let k = 0; k < a.length; k++) o[k] = a[k] + (b[k] - a[k]) * t;
  return o;
};

// 凸多角形（頂点は [x, y, z, ...属性]）を、key(頂点) が整数になる直線ですべて切り分けて out に足す
function cutFamily(polys, key, out) {
  for (const poly of polys) {
    let lo = Infinity, hi = -Infinity;
    const ks = poly.map((v) => {
      const k = key(v);
      if (k < lo) lo = k;
      if (k > hi) hi = k;
      return k;
    });
    const k0 = Math.floor(lo) + 1, k1 = Math.ceil(hi) - 1;
    if (k0 > k1) {
      out.push(poly);
      continue;
    }
    let rest = poly, rk = ks;
    for (let k = k0; k <= k1; k++) {
      const below = [], above = [], ak = [];
      const n = rest.length;
      for (let i = 0; i < n; i++) {
        const a = rest[i], ka = rk[i], j = (i + 1) % n, kb = rk[j];
        if (ka <= k) below.push(a);
        if (ka >= k) {
          above.push(a);
          ak.push(ka);
        }
        if ((ka < k && kb > k) || (ka > k && kb < k)) {
          const p = lerpV(a, rest[j], (k - ka) / (kb - ka));
          below.push(p);
          above.push(p);
          ak.push(k);
        }
      }
      if (below.length >= 3) out.push(below);
      rest = above;
      rk = ak;
      if (rest.length < 3) break;
    }
    if (rest.length >= 3) out.push(rest);
  }
  return out;
}

export class Terrain {
  // data: { near, far, level, bridges }（decodeTerrain の結果）、proj: エリアの投影（LocalProjection）
  constructor(data, proj) {
    this.proj = proj;
    this.near = prepGrid(data.near, proj);
    this.near.data = this.near.data.slice(); // 手直し（terraincond.js）は Terrain ごと（同じ読み込み結果から 2 つ作っても 2 回ならさない）
    this.far = data.far ? prepGrid(data.far, proj) : null;
    this.level = data.level ? prepGrid(data.level, proj) : null;
    this.profiles = data.bridges || []; // 事前取得で測った橋の縦断面（緯度経度の両端と、5 m ごとの標高）
    this.report = data.report || null;
    this.flat = false;
    this.datum = DATUM;
    this.conditioned = false; // 道路・岸壁で格子を手直ししたか（terraincond.js、ground.js の buildGroundBase）
    this.quayWalls = [];
    this.metroRaw = data.metro || []; // メトロの出入口（緯度経度。<エリア>-metro.json）
    this.metro = []; // ローカル座標にして、穴を埋めたもの（ground.js の buildGroundBase。world/metro.js）
    this.decks = [];
    this.maxHalf = 0;
    this.deckGrid = new Grid(40);
    this.deckSegs = [];
    this.areaLevels = new WeakMap();
    // 地面の格子の線（ローカル座標での間隔）
    const g = this.near;
    this.cellX = 1 / g.ax;
    this.cellZ = 1 / g.az;
  }

  // 岸壁（terraincond.js の sharpenQuays の線）を覚える。壁は下の段の格子点の上に立ち、壁の裏（上の段の側）の 1 マスは
  // 斜面のまま（ground.js の歩道の板で隠す）。自転車・並木・街灯は板の上に載せる（top）
  setQuayWalls(walls) {
    this.quayWalls = walls;
    this.quayGrid = new Grid(20);
    this.quayBox = null;
    walls.forEach((q, i) => {
      const k = Math.max(q.wa || 0, q.wb || 0);
      const b = [Math.min(q.ax, q.bx) - k, Math.min(q.az, q.bz) - k, Math.max(q.ax, q.bx) + k, Math.max(q.az, q.bz) + k];
      this.quayGrid.insertBounds(...b, i);
      const B = this.quayBox || (this.quayBox = [Infinity, Infinity, -Infinity, -Infinity]);
      B[0] = Math.min(B[0], b[0]);
      B[1] = Math.min(B[1], b[1]);
      B[2] = Math.max(B[2], b[2]);
      B[3] = Math.max(B[3], b[3]);
    });
  }

  // 上に載る面の高さ: 地面か、岸壁の上の歩道の板（板の幅 wa/wb の中）の高い方。地面のメッシュ・道路の面は h のまま
  top(x, z) {
    const y = this.h(x, z);
    return this.quayBox ? Math.max(y, this.quayWalkAt(x, z)) : y;
  }

  // 岸壁の上の歩道の板の高さ（板の上でなければ -Infinity）
  quayWalkAt(x, z) {
    const B = this.quayBox;
    if (!B || x < B[0] || z < B[1] || x > B[2] || z > B[3]) return -Infinity;
    let best = -Infinity;
    this.quayGrid.queryPoint(x, z, 0, (i) => {
      const q = this.quayWalls[i], dx = q.bx - q.ax, dz = q.bz - q.az, L2 = dx * dx + dz * dz;
      const t = ((x - q.ax) * dx + (z - q.az) * dz) / L2;
      if (t < -0.02 || t > 1.02) return;
      const tc = Math.min(1, Math.max(0, t)), d = -((x - q.ax - dx * tc) * q.nx + (z - q.az - dz * tc) * q.nz); // 壁から裏へ
      if (d <= 0.05 || d > (q.wa || 0) + ((q.wb || 0) - (q.wa || 0)) * tc) return;
      best = Math.max(best, q.at + (q.bt - q.at) * tc - 0.02);
    });
    return best;
  }

  // 地面の高さ（y）。5 m の格子の平面。格子の外は遠くの格子
  h(x, z) {
    const g = this.near, u = g.ax * x + g.bx, v = g.az * z + g.bz;
    if (u >= 0 && v >= 0 && u <= g.cols - 1 && v <= g.rows - 1) return planar(g, u, v) - DATUM;
    return this.hFar(x, z);
  }

  // 近くの格子の中か（遠くの地面のメッシュが近くの格子を使うか、遠くの格子を使うかを決める）
  inNear(x, z, margin = 0) {
    const g = this.near, u = g.ax * x + g.bx, v = g.az * z + g.bz, m = margin * g.ax;
    return u >= m && v >= m && u <= g.cols - 1 - m && v <= g.rows - 1 - m;
  }

  hFar(x, z) {
    const g = this.far;
    if (!g) {
      const n = this.near;
      return planar(n, Math.min(Math.max(n.ax * x + n.bx, 0), n.cols - 1), Math.min(Math.max(n.az * z + n.bz, 0), n.rows - 1)) - DATUM;
    }
    return bilinear(g, g.ax * x + g.bx, g.az * z + g.bz) - DATUM;
  }

  // 地面の法線（左右前後 2.5 m の差から。なめらかに変わる）
  normal(x, z, out = [0, 1, 0]) {
    const e = 2.5;
    const dx = (this.h(x + e, z) - this.h(x - e, z)) / (2 * e), dz = (this.h(x, z + e) - this.h(x, z - e)) / (2 * e);
    const l = Math.hypot(dx, 1, dz);
    out[0] = -dx / l;
    out[1] = 1 / l;
    out[2] = -dz / l;
    return out;
  }

  // (x, z) での、向き (fx, fz) への勾配（±len m の差）
  grade(x, z, fx, fz, len = 1.5) {
    return (this.h(x + fx * len, z + fz * len) - this.h(x - fx * len, z - fz * len)) / (2 * len);
  }

  // 外形 ring（[[x, z]…]）の中と頂点の地面の高さ: { min, max, p20, mean }
  range(ring, step = 5) {
    const hs = [];
    let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
    for (const [x, z] of ring) {
      hs.push(this.h(x, z));
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
    }
    if (ring.length >= 3) {
      for (let z = Math.ceil(minZ / step) * step; z < maxZ; z += step) {
        for (let x = Math.ceil(minX / step) * step; x < maxX; x += step) if (pointInRing(x, z, ring)) hs.push(this.h(x, z));
      }
    }
    if (!hs.length) return { min: 0, max: 0, p20: 0, mean: 0 };
    hs.sort((a, b) => a - b);
    return { min: hs[0], max: hs[hs.length - 1], p20: hs[Math.floor((hs.length - 1) * 0.2)], mean: hs.reduce((s, v) => s + v, 0) / hs.length };
  }

  // 水面の高さ（y）。水面の格子（20 m ごと、地形モデルの川の上の平らな値）から。area: 水域（あれば、格子の外の池の高さに使う）
  waterLevel(x, z, area = null) {
    const g = this.level;
    if (g) {
      const L = bilinear(g, g.ax * x + g.bx, g.az * z + g.bz);
      if (!Number.isNaN(L)) return L - DATUM;
    }
    if (!area) return this.h(x, z) - 1;
    // 水面の格子にない小さな池: 岸のいちばん低い所の 0.6 m 下（池ごとに一定）
    let L = this.areaLevels.get(area);
    if (L == null) {
      L = Infinity;
      for (const [px, pz] of area.outer) L = Math.min(L, this.h(px, pz));
      L = (Number.isFinite(L) ? L : 0) - 0.6;
      this.areaLevels.set(area, L);
    }
    return L;
  }

  // 橋の縦断面を登録する（bridges.js の setupDecks）。list: [{ pts: [[x, z]…], y: [5 m ごとの y], step, half }]
  setDecks(list) {
    this.decks = list;
    this.deckGrid = new Grid(40);
    this.deckSegs = [];
    this.maxHalf = 0;
    list.forEach((d, k) => {
      this.maxHalf = Math.max(this.maxHalf, d.half);
      let s = 0;
      for (let i = 0; i + 1 < d.pts.length; i++) {
        const [ax, az] = d.pts[i], [bx, bz] = d.pts[i + 1];
        const len = Math.hypot(bx - ax, bz - az);
        this.deckGrid.insertSegment(ax, az, bx, bz, this.deckSegs.length);
        this.deckSegs.push({ k, ax, az, bx, bz, s0: s, len });
        s += len;
      }
      d.length = s;
    });
  }

  // 橋の縦断面 d の、橋の始点からの距離 s での高さ
  deckY(d, s) {
    const f = Math.min(Math.max(s / d.step, 0), d.y.length - 1);
    const i = Math.min(Math.floor(f), d.y.length - 2);
    return i < 0 ? d.y[0] : d.y[i] + (d.y[i + 1] - d.y[i]) * (f - i);
  }

  // (x, z) の上の橋の面の高さ（y、車道の面は + DECK_TOP）。yHint: これより 1.2 m 以上高い橋は無視する（橋の下を走るとき）。なければ null
  deck(x, z, yHint = Infinity) {
    let best = null;
    this.deckGrid.queryPoint(x, z, Math.max(25, this.maxHalf + 1), (i) => { // 幅の広い橋（並んだ way をまとめた橋）も
      const sg = this.deckSegs[i], d = this.decks[sg.k];
      const c = closestOnSegment(x, z, sg.ax, sg.az, sg.bx, sg.bz);
      if (c.d2 > d.half * d.half) return;
      // 橋の両端より外（線の端の先）は橋ではない
      if ((c.t <= 0 && sg.s0 === 0) || (c.t >= 1 && sg.s0 + sg.len >= d.length - 1e-6)) return;
      const y = this.deckY(d, sg.s0 + c.t * sg.len);
      if (y > yHint + 1.2) return;
      if (best == null || y > best) best = y;
    });
    return best;
  }

  // 三角形 A, B, C（頂点 [x, y, z, ...]）の 3 頂点の地面の高さを結んだ平面と、三角形の中の地面との差の最大が tol 以下か。
  // 差は、辺と格子の線・対角線の交点と、中の格子点で最大になる（地面は格子の三角形ごとの平面なので）
  flatOver(A, B, C, tol) {
    const g = this.near;
    const P = [A, B, C], H = P.map((p) => this.h(p[0], p[2]));
    const fam = [(x, z) => g.ax * x + g.bx, (x, z) => g.az * z + g.bz, (x, z) => g.ax * x + g.bx - g.az * z - g.bz];
    for (let e = 0; e < 3; e++) {
      const p = P[e], q = P[(e + 1) % 3], hp = H[e], hq = H[(e + 1) % 3];
      for (const f of fam) {
        const kp = f(p[0], p[2]), kq = f(q[0], q[2]);
        const k0 = Math.floor(Math.min(kp, kq)) + 1, k1 = Math.ceil(Math.max(kp, kq)) - 1;
        for (let k = k0; k <= k1; k++) {
          const t = (k - kp) / (kq - kp);
          if (Math.abs(this.h(p[0] + (q[0] - p[0]) * t, p[2] + (q[2] - p[2]) * t) - (hp + (hq - hp) * t)) > tol) return false;
        }
      }
    }
    // 中の格子点
    const [ax, az] = [A[0], A[2]], bx = B[0] - ax, bz = B[2] - az, cx = C[0] - ax, cz = C[2] - az;
    const det = bx * cz - bz * cx;
    if (Math.abs(det) < 1e-6) return true;
    const u = P.map((p) => g.ax * p[0] + g.bx), v = P.map((p) => g.az * p[2] + g.bz);
    const c0 = Math.max(0, Math.ceil(Math.min(...u))), c1 = Math.min(g.cols - 1, Math.floor(Math.max(...u)));
    const r0 = Math.max(0, Math.ceil(Math.min(...v))), r1 = Math.min(g.rows - 1, Math.floor(Math.max(...v)));
    for (let r = r0; r <= r1; r++) {
      const z = (r - g.bz) / g.az - az;
      for (let c = c0; c <= c1; c++) {
        const x = (c - g.bx) / g.ax - ax;
        const l1 = (x * cz - z * cx) / det, l2 = (bx * z - bz * x) / det;
        if (l1 < -1e-9 || l2 < -1e-9 || l1 + l2 > 1 + 1e-9) continue;
        if (Math.abs(g.data[r * g.cols + c] - DATUM - (H[0] + l1 * (H[1] - H[0]) + l2 * (H[2] - H[0]))) > tol) return false;
      }
    }
    return true;
  }

  // 凸多角形 poly（頂点 [x, y, z, ...属性]）を地面の格子の線と対角線で切り分ける。切った各片は地面の 1 枚の三角形の中にある
  split(poly) {
    const g = this.near;
    const ku = (v) => g.ax * v[0] + g.bx, kv = (v) => g.az * v[2] + g.bz, kd = (v) => g.ax * v[0] + g.bx - (g.az * v[2] + g.bz);
    return cutFamily(cutFamily(cutFamily([poly], ku, []), kv, []), kd, []);
  }
}

// 平らな世界（今までと同じ。地形のファイルがないとき・単体テスト）
export const FLAT_TERRAIN = {
  flat: true,
  h: () => 0,
  top: () => 0,
  hFar: () => 0,
  inNear: () => false,
  normal: (x, z, out = [0, 1, 0]) => {
    out[0] = 0;
    out[1] = 1;
    out[2] = 0;
    return out;
  },
  grade: () => 0,
  range: () => ({ min: 0, max: 0, p20: 0, mean: 0 }),
  waterLevel: (x, z, area) => -(area?.depth ?? 10),
  setDecks() {},
  deck: () => null,
  decks: [],
};

// 水の上を通れるか（地形があるとき）。y: 自転車の高さ。橋の面の近くにいれば通れる。橋の線の外（水域が橋の端より先まで
// 続く所・橋として描かれていない道路）は、頭の上に橋がなく、地面の近くを走っていれば道路の上は通れる（橋の下の河岸から川へは出られない）
export function waterPass(terrain, x, z, y, onRoad) {
  const d = terrain.deck(x, z, y);
  if (d != null && Math.abs(d + DECK_TOP - y) < 1.5) return true;
  return onRoad(x, z) && terrain.deck(x, z) == null && Math.abs(y - terrain.h(x, z)) < 1.5;
}

// 欄干で止めるか。dHere / dAhead: いまの所・1 m 先の橋の面の高さ（Terrain.deck。橋がなければ null）、S / Sa: その走る面の高さ。
// 橋の上から、橋のない所へ step m 以上落ちるとき、または高さが step m 以上違う隣の橋の面（同じ橋の並んだ車道）へ移るとき
export function deckEdgeBlocked(dHere, dAhead, S, Sa, step = 0.5) {
  if (dHere == null) return false;
  if (dAhead == null) return S - Sa > step;
  return Math.abs(dAhead - dHere) > step && Math.abs(Sa - S) > step;
}

// 走る面の高さ。liftAt(x, z): 一段高い歩道の高さ（地面からの相対、0 か CURB_H）。
// surfaceY(x, z, yHint): 地面＋歩道、または橋の面（yHint より 1.2 m 以上高い橋は無視 = 橋の下）
export function surfaceFns(terrain, liftAt) {
  const top = terrain.top ? (x, z) => terrain.top(x, z) : (x, z) => terrain.h(x, z);
  const surfaceY = (x, z, yHint = Infinity) => {
    const g = top(x, z) + liftAt(x, z);
    const d = terrain.deck(x, z, yHint);
    return d == null ? g : Math.max(g, d + DECK_TOP);
  };
  // 歩道の段を除いた面（勾配・崖の判定に使う）
  const rideY = (x, z, yHint = Infinity) => {
    const g = top(x, z);
    const d = terrain.deck(x, z, yHint);
    return d == null ? g : Math.max(g, d + DECK_TOP);
  };
  // スタート・ワープの高さ: 水の上なら一番上の橋、陸の上なら地面（橋の下の河岸に置いたとき、上の橋に載せない）。
  // onBridge: 置く道そのものが橋（陸の上の高架・運河や線路を越える橋）なら、陸の上でも一番上の橋の面
  const spawnY = (x, z, inWater = null, onBridge = false) => (onBridge || inWater?.(x, z) ? surfaceY(x, z) : surfaceY(x, z, terrain.h(x, z) + liftAt(x, z) + 0.3));
  return { surfaceY, rideY, spawnY, heightAt: (x, z) => surfaceY(x, z), groundAt: (x, z, y = Infinity) => surfaceY(x, z, y) };
}

// ---------------------------------------------------------------- ファイル（public/data/<エリア>-terrain.bin）
// 'TAVT'・ヘッダーの長さ（uint32）・ヘッダー（JSON）・格子ごとの圧縮データ（deflate-raw）。格子は (標高 − offset) / scale の
// uint16（65535 = 値なし）を、左・上・左上から予測した差（平面の予測）にして圧縮する
async function pipe(bytes, stream) {
  const out = new Response(new Blob([bytes]).stream().pipeThrough(stream));
  return new Uint8Array(await out.arrayBuffer());
}

function encodeGrid(g, scale, offset) {
  const { cols, rows, data } = g;
  const q = new Uint16Array(cols * rows);
  for (let i = 0; i < q.length; i++) {
    const v = data[i];
    q[i] = Number.isNaN(v) ? 65535 : Math.min(65534, Math.max(0, Math.round((v - offset) / scale)));
  }
  const res = new Uint16Array(q.length);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      const L = c ? q[i - 1] : 0, U = r ? q[i - cols] : 0, UL = c && r ? q[i - cols - 1] : 0;
      res[i] = (q[i] - (L + U - UL)) & 0xffff;
    }
  }
  return new Uint8Array(res.buffer);
}

function decodeGrid(bytes, meta) {
  const { cols, rows, scale, offset } = meta;
  const res = new Uint16Array(bytes.buffer, bytes.byteOffset, cols * rows);
  const q = new Uint16Array(cols * rows);
  const data = new Float32Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      const L = c ? q[i - 1] : 0, U = r ? q[i - cols] : 0, UL = c && r ? q[i - cols - 1] : 0;
      q[i] = (res[i] + L + U - UL) & 0xffff;
      data[i] = q[i] === 65535 ? NaN : offset + q[i] * scale;
    }
  }
  return data;
}

const GRID_CODING = { near: [0.02, 100], far: [0.1, 0], level: [0.02, 100] };

// data: { near, far, level（{ lat, lon, dLat, dLon, cols, rows, data: Float32Array（標高 m）} ）, bridges, report }
export async function encodeTerrain(data) {
  const header = { version: TERRAIN_VERSION, datum: DATUM, lattice: LATTICE, grids: {}, bridges: data.bridges || [], report: data.report || null };
  const blobs = [];
  for (const name of ['near', 'far', 'level']) {
    const g = data[name];
    if (!g) continue;
    const [scale, offset] = GRID_CODING[name];
    const z = await pipe(encodeGrid(g, scale, offset), new CompressionStream('deflate-raw'));
    header.grids[name] = { lat: g.lat, lon: g.lon, dLat: g.dLat, dLon: g.dLon, cols: g.cols, rows: g.rows, scale, offset, bytes: z.length };
    blobs.push(z);
  }
  const hj = new TextEncoder().encode(JSON.stringify(header));
  const total = 8 + hj.length + blobs.reduce((s, b) => s + b.length, 0);
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, MAGIC, true);
  dv.setUint32(4, hj.length, true);
  out.set(hj, 8);
  let o = 8 + hj.length;
  for (const b of blobs) {
    out.set(b, o);
    o += b.length;
  }
  return out;
}

export async function decodeTerrain(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dv.getUint32(0, true) !== MAGIC) throw new Error('地形のファイルの形式が違います');
  const hl = dv.getUint32(4, true);
  const header = JSON.parse(new TextDecoder().decode(bytes.subarray(8, 8 + hl)));
  if (header.version !== TERRAIN_VERSION) throw new Error(`地形のファイルの版が違います（${header.version}）`);
  const out = { bridges: header.bridges || [], report: header.report };
  let o = 8 + hl;
  for (const name of ['near', 'far', 'level']) {
    const m = header.grids[name];
    if (!m) continue;
    const raw = await pipe(bytes.subarray(o, o + m.bytes), new DecompressionStream('deflate-raw'));
    o += m.bytes;
    out[name] = { lat: m.lat, lon: m.lon, dLat: m.dLat, dLon: m.dLon, cols: m.cols, rows: m.rows, data: decodeGrid(raw, m) };
  }
  return out;
}
