// メトロ（地下鉄）の駅の出入口（data/metro.js で LiDAR の地形モデルの穴から見つけた位置・大きさ・向き）。
// 写真（Wikimedia Commons の Capitole・Jeanne d'Arc・Palais de Justice・Esquirol・Arènes など）では:
// - 地面にあいた長方形の吹き抜けを、階段とステンレスのエスカレーターで下りる（下の端にガラスの扉）
// - 吹き抜けの 3 辺（入口の側を除く）にベージュの花崗岩張りの低い腰壁（約 1 m）とステンレスの手すり
// - 入口の脇に灰色の柱の看板（上から、黄色地に紺の丸と「M」、駅名の黒い帯、黄色の駅の絵の板）
// 地下駐車場の車の坂（kind: 'parking'。キャピトル広場など）は、灰色のコンクリートの壁のあいだをアスファルトの坂で下り、
// 下の端に暗いトンネルの口と黄色と黒の高さ制限の梁、入口に高さ制限の門と青地に白い P の看板。腰壁はコンクリート
// 地面には穴をあける: 地形の格子の穴（地形モデルに写った吹き抜け）は周りの高さで埋め、吹き抜けの長方形は
// 水面と同じステンシルの穴（ground.js）にして、地面・地面の覆い・歩道を描かず、吹き抜けの中が見えるようにする
import * as THREE from 'three';
import { MeshWriter } from './meshwriter.js';
import { closestOnSegment, hash01 } from '../geo.js';
import { CAR_ROADS } from './parse.js';

const STEP_H = 0.16; // 段の高さ（m）
const LANDING = 2.4; // 下の踊り場の長さ（m）
const PARAPET = 1.0, PARAPET_T = 0.3; // 腰壁の高さ・厚さ
const RAMP_PARAPET = 0.6; // 駐車場の坂の腰壁の高さ（利用者の写真: キャピトル・Esquirol の坂の縁は低いばら色の花崗岩）
const ESCALATOR_W = 1.25;
const C = {
  stone: [0.86, 0.79, 0.69], // ベージュの花崗岩
  coping: [0.9, 0.86, 0.79],
  wall: [0.8, 0.76, 0.7], // 吹き抜けの中の壁
  step: [0.36, 0.35, 0.35], // 灰色の花崗岩の段
  nose: [0.5, 0.49, 0.47], // 段鼻（蹴上げ）
  floor: [0.42, 0.41, 0.41],
  steel: [0.78, 0.8, 0.82],
  esc: [0.24, 0.25, 0.27], // エスカレーターの段（黒っぽいアルミ）
  door: [0.12, 0.15, 0.17], // ガラスの扉（中は暗い）
  frame: [0.62, 0.64, 0.66],
  post: [0.42, 0.44, 0.46],
  yellow: [0.98, 0.72, 0.05],
  name: [0.16, 0.17, 0.2],
  concrete: [0.68, 0.58, 0.53], // 駐車場の坂の壁・腰壁（利用者の写真: Esquirol・キャピトルの坂はばら色がかった灰色の花崗岩 #a68975・#9a8a85）
  asphalt: [0.3, 0.3, 0.31],
  line: [0.85, 0.85, 0.82],
  black: [0.1, 0.1, 0.11],
  tunnel: [0.05, 0.05, 0.06],
};
const RAMP_PORTAL_H = 2.3; // 駐車場のトンネルの口の高さ（m。高さ制限 2 m 前後）

// 写真・航空写真で直す出入口の幅 [緯度, 経度, 幅 m]（地形モデルの穴が隣の植え込みとつながって広く見つかった所）。
// キャピトル（Square Charles-de-Gaulle の東の縁。利用者のストリートビュー 211839・航空写真）: 階段の吹き抜けは幅約 5.5 m
const ENTRANCE_WIDTHS = [[43.6046415, 1.4454812, 5.5]];
// 事前取得の出入口（緯度経度）をローカル座標に。len・wid は扱える範囲に収める
export function projectEntrances(list, proj) {
  return (list || []).map((e) => {
    const [x, z] = proj.project(e.lat, e.lon);
    const parking = e.kind === 'parking';
    const fix = ENTRANCE_WIDTHS.find(([lat, lon]) => Math.abs(lat - e.lat) < 2e-6 && Math.abs(lon - e.lon) < 2e-6);
    if (fix) e = { ...e, wid: fix[2] };
    return {
      kind: parking ? 'parking' : 'metro', station: e.station, name: e.name, x, z, ang: e.ang, down: e.down >= 0 ? 1 : -1,
      len: Math.min(parking ? 40 : 30, Math.max(6, e.len)), wid: Math.min(parking ? 12 : 9, Math.max(2.8, e.wid)), depth: e.depth,
    };
  });
}

// 出入口の局所の座標: 下りる向き d、横の向き s、中心 (x, z) からの (u, v) → (x, z)
export function entranceFrame(e) {
  const dx = Math.cos(e.ang) * e.down, dz = Math.sin(e.ang) * e.down;
  const sx = -dz, sz = dx;
  return { dx, dz, sx, sz, at: (u, v) => [e.x + dx * u + sx * v, e.z + dz * u + sz * v] };
}

// 吹き抜けの長方形の角（反時計回りでなくてもよい: 上の端 2 つ・下の端 2 つ）と、その外周 m m 広げた角
export function entranceCorners(e, m = 0) {
  const f = entranceFrame(e), L = e.len / 2 + m, W = e.wid / 2 + m;
  return [f.at(-L, -W), f.at(L, -W), f.at(L, W), f.at(-L, W)];
}

// 地形の格子にあいた吹き抜けの穴を、周りの地面で埋める（地形の手直し。ground.js の buildGroundBase で 1 回だけ）。
// 長方形を ring m 広げた外周の地面の高さに平面（下りる向き・横の向きの傾き）を当てはめ、穴の中の格子点をその面まで上げる
// （坂の途中の出入口でも段ができない）。各出入口に e.rim（中心の y）と e.slope（[下りる向き, 横] の傾き）を付ける
export function fillMetroPits(terrain, list, { ring = 6, pad = 2.5 } = {}) {
  if (!terrain || terrain.flat || !list.length) return;
  const g = terrain.near, D = g.data, DAT = terrain.datum;
  for (const e of list) {
    const f = entranceFrame(e), P = entranceCorners(e, ring), S = [];
    for (let i = 0; i < 4; i++) {
      const [ax, az] = P[i], [bx, bz] = P[(i + 1) % 4], n = Math.max(2, Math.ceil(Math.hypot(bx - ax, bz - az) / 2));
      for (let k = 0; k < n; k++) {
        const x = ax + ((bx - ax) * k) / n, z = az + ((bz - az) * k) / n;
        S.push([(x - e.x) * f.dx + (z - e.z) * f.dz, (x - e.x) * f.sx + (z - e.z) * f.sz, terrain.h(x, z)]);
      }
    }
    // 平面 y = a + b u + c v（外周の点は u・v について対称なので、それぞれの傾きは独立に求まる）。外れ値（隣の穴・段差）に
    // 引っ張られないよう、いちど当てはめて残差の大きい 2 割を捨ててから当てはめ直す
    const fit = (pts) => {
      let su = 0, sv = 0, sy = 0, suu = 0, svv = 0, suy = 0, svy = 0;
      for (const [u, v, y] of pts) {
        su += u;
        sv += v;
        sy += y;
        suu += u * u;
        svv += v * v;
        suy += u * y;
        svy += v * y;
      }
      const n = pts.length, mu = su / n, mv = sv / n, my = sy / n;
      const b = (suy - n * mu * my) / Math.max(1e-9, suu - n * mu * mu), c = (svy - n * mv * my) / Math.max(1e-9, svv - n * mv * mv);
      return { a: my - b * mu - c * mv, b, c };
    };
    let pl = fit(S);
    const res = S.map(([u, v, y]) => Math.abs(y - (pl.a + pl.b * u + pl.c * v))).sort((p, q) => p - q);
    const cut = res[Math.floor(res.length * 0.8)];
    pl = fit(S.filter(([u, v, y]) => Math.abs(y - (pl.a + pl.b * u + pl.c * v)) <= cut));
    e.rim = pl.a;
    e.slope = [pl.b, pl.c];
    const L = e.len / 2 + pad, W = e.wid / 2 + pad, R = Math.hypot(L, W);
    const c0 = Math.max(0, Math.floor(g.ax * (e.x - R) + g.bx)), c1 = Math.min(g.cols - 1, Math.ceil(g.ax * (e.x + R) + g.bx));
    const r0 = Math.max(0, Math.floor(g.az * (e.z - R) + g.bz)), r1 = Math.min(g.rows - 1, Math.ceil(g.az * (e.z + R) + g.bz));
    for (let r = r0; r <= r1; r++) {
      const z = (r - g.bz) / g.az;
      for (let c = c0; c <= c1; c++) {
        const x = (c - g.bx) / g.ax, u = (x - e.x) * f.dx + (z - e.z) * f.dz, v = (x - e.x) * f.sx + (z - e.z) * f.sz;
        if (Math.abs(u) > L || Math.abs(v) > W) continue;
        const k = r * g.cols + c, y = pl.a + pl.b * u + pl.c * v;
        if (!Number.isNaN(D[k]) && D[k] < y + DAT) D[k] = y + DAT;
      }
    }
  }
}

// 出入口の縁の地面の高さ（吹き抜けの局所の (u, v)。fillMetroPits の平面）
export function rimAt(e, u, v) {
  return e.rim + (e.slope ? e.slope[0] * u + e.slope[1] * v : 0);
}

// 駐車場の坂の向き: 入口（上の端）は車道に近い方の端（LiDAR の深さの傾きは坂の下の屋根の下が写らず逆になることがある）
export function orientRamps(list, roads, { reach = 60 } = {}) {
  const ramps = list.filter((e) => e.kind === 'parking');
  if (!ramps.length) return;
  const segs = [];
  for (const r of roads) {
    if (!CAR_ROADS.has(r.type) || r.bridge || r.tunnel) continue;
    for (let i = 0; i + 1 < r.pts.length; i++) {
      const [ax, az] = r.pts[i], [bx, bz] = r.pts[i + 1];
      if (ramps.some((e) => Math.min(ax, bx) < e.x + reach && Math.max(ax, bx) > e.x - reach && Math.min(az, bz) < e.z + reach && Math.max(az, bz) > e.z - reach)) segs.push([ax, az, bx, bz]);
    }
  }
  const dist = (x, z) => segs.reduce((m, [ax, az, bx, bz]) => Math.min(m, closestOnSegment(x, z, ax, az, bx, bz).d2), Infinity);
  for (const e of ramps) {
    const f = entranceFrame(e), [ax, az] = f.at(-e.len / 2, 0), [bx, bz] = f.at(e.len / 2, 0);
    if (Math.sqrt(dist(bx, bz)) + 2 < Math.sqrt(dist(ax, az))) e.down = -e.down;
  }
}

// (x, z) が出入口の吹き抜け（pad m 広げた長方形）の中か（木を植えない）
export function inEntrance(list, x, z, pad = 0.5) {
  return list.some((e) => {
    const f = entranceFrame(e), u = (x - e.x) * f.dx + (z - e.z) * f.dz, v = (x - e.x) * f.sx + (z - e.z) * f.sz;
    return Math.abs(u) < e.len / 2 + pad && Math.abs(v) < e.wid / 2 + pad;
  });
}

// 出入口の吹き抜けのまわりの塀を除く（LiDAR で見つけた塀のうち、実際の出入口の腰壁だったもの。腰壁は buildMetroEntrances が作る）
export function clearEntrances(segs, list, pad = 2) {
  if (!list.length) return segs;
  return segs.filter(([ax, az, bx, bz]) => {
    const x = (ax + bx) / 2, z = (az + bz) / 2;
    return !list.some((e) => {
      const f = entranceFrame(e), u = (x - e.x) * f.dx + (z - e.z) * f.dz, v = (x - e.x) * f.sx + (z - e.z) * f.sz;
      return Math.abs(u) < e.len / 2 + pad && Math.abs(v) < e.wid / 2 + pad;
    });
  });
}

// 当たり判定の線分（吹き抜けの 4 辺。自転車は落ちない）
export function entranceWalls(e) {
  const P = entranceCorners(e, 0.1);
  return P.map((p, i) => [...p, ...P[(i + 1) % 4]]);
}

// 吹き抜けの深さ（段の数は STEP_H ごと）
export function entranceDepth(e) {
  if (e.kind === 'parking') return Math.min(5.5, Math.max(RAMP_PORTAL_H + 0.6, (e.depth || 3) + 0.8));
  return Math.min(6.5, Math.max(3.5, (e.depth || 3) + 1.2));
}

// 看板の絵（左半分: 黄色地に紺の丸と M。右半分: 駐車場の青地に白い P）
let signTex = null;
function signTexture() {
  if (signTex) return signTex;
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 128;
  const x = c.getContext('2d');
  x.fillStyle = '#f9b80d';
  x.fillRect(0, 0, 128, 128);
  x.strokeStyle = '#1d2a55';
  x.lineWidth = 9;
  x.beginPath();
  x.arc(64, 64, 44, 0, Math.PI * 2);
  x.stroke();
  x.fillStyle = '#1d2a55';
  x.font = 'bold 64px sans-serif';
  x.textAlign = 'center';
  x.textBaseline = 'middle';
  x.fillText('M', 64, 68);
  x.fillStyle = '#1f5fae';
  x.fillRect(128, 0, 128, 128);
  x.strokeStyle = '#ffffff';
  x.lineWidth = 5;
  x.strokeRect(136, 8, 112, 112);
  x.fillStyle = '#ffffff';
  x.font = 'bold 92px sans-serif';
  x.fillText('P', 192, 70);
  signTex = new THREE.CanvasTexture(c);
  signTex.colorSpace = THREE.SRGBColorSpace;
  signTex.anisotropy = 4;
  return signTex;
}

export function createMetroMaterials(tex) {
  // 面の向き（周回順）は気にせず両面で描く（法線は面ごとに渡す）
  const D = THREE.DoubleSide;
  return {
    // 石・コンクリート: 模様なし（壁のレンガの明るさの模様をかけると、腰壁が淡いレンガの箱に見えた）
    stone: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, side: D }),
    steel: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.35, metalness: 0.6, side: D }),
    plain: new THREE.MeshLambertMaterial({ vertexColors: true, side: D }),
    sign: typeof document === 'undefined' ? new THREE.MeshLambertMaterial({ color: '#f9b80d', side: D }) : new THREE.MeshLambertMaterial({ map: signTexture(), side: D }),
  };
}

// 直方体（中心 (x, y0〜y1, z)、横の向き (ux, uz) に長さ a、奥行き b）。6 面
function box(w, x, z, y0, y1, ux, uz, a, b, color, uvScale = 1) {
  const vx = -uz, vz = ux, ha = a / 2, hb = b / 2;
  const p = (i, j, y) => [x + ux * ha * i + vx * hb * j, y, z + uz * ha * i + vz * hb * j];
  const sides = [[[1, -1], [1, 1], [ux, uz]], [[-1, 1], [-1, -1], [-ux, -uz]], [[1, 1], [-1, 1], [vx, vz]], [[-1, -1], [1, -1], [-vx, -vz]]];
  for (const [[i0, j0], [i1, j1], [nx, nz]] of sides) {
    const l = Math.hypot((i1 - i0) * ha, (j1 - j0) * hb) * uvScale, h = (y1 - y0) * uvScale;
    w.quad(p(i0, j0, y0), p(i1, j1, y0), p(i1, j1, y1), p(i0, j0, y1), [nx, 0, nz], [0, 0], [l / 2, 0], [l / 2, h / 2], [0, h / 2], color);
  }
  w.quad(p(-1, -1, y1), p(1, -1, y1), p(1, 1, y1), p(-1, 1, y1), [0, 1, 0], [0, 0], [a * uvScale / 2, 0], [a * uvScale / 2, b * uvScale / 2], [0, b * uvScale / 2], color);
}

// 2 点を結ぶ細い棒（手すり）。断面 t m の四角
function bar(w, a, b, t, color) {
  const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2], L = Math.hypot(dx, dy, dz) || 1;
  // 横の向き（水平）と、それに直交する向き
  let sx = -dz, sz = dx;
  const sl = Math.hypot(sx, sz) || 1;
  sx = (sx / sl) * (t / 2);
  sz = (sz / sl) * (t / 2);
  const uy = t / 2; // 上の向き（鉛直）
  const P = (p, i, j) => [p[0] + sx * i, p[1] + uy * j, p[2] + sz * i];
  const faces = [[[1, 1], [1, -1], [sx, 0, sz]], [[-1, -1], [-1, 1], [-sx, 0, -sz]], [[-1, 1], [1, 1], [0, 1, 0]], [[1, -1], [-1, -1], [0, -1, 0]]];
  for (const [[i0, j0], [i1, j1], n] of faces) {
    const nl = Math.hypot(...n) || 1;
    w.quad(P(a, i0, j0), P(b, i0, j0), P(b, i1, j1), P(a, i1, j1), [n[0] / nl, n[1] / nl, n[2] / nl], [0, 0], [L, 0], [L, 0.1], [0, 0.1], color);
  }
}

// 地下駐車場の車の坂。上の端（入口）は道路につながるので腰壁なし。w: { stone, steel, plain, sign } の MeshWriter
function writeRamp(e, w) {
  const f = entranceFrame(e), H = entranceDepth(e), L = e.len / 2, W = e.wid / 2;
  const y0 = rimAt(e, -L, 0), yb = rimAt(e, L, 0) - H;
  const fy = (u) => y0 + ((yb - y0) * (u + L)) / (2 * L); // 坂の床の高さ
  const P = (u, v, y) => {
    const [x, z] = f.at(u, v);
    return [x, y, z];
  };
  const up = [-f.dx * (yb - y0) / (2 * L), 1, -f.dz * (yb - y0) / (2 * L)];
  const ul = Math.hypot(...up);
  const n = up.map((c) => c / ul);
  // 坂の床（アスファルト）。2 車線の幅なら真ん中に白い線
  w.plain.quad(P(-L, -W, fy(-L)), P(L, -W, fy(L)), P(L, W, fy(L)), P(-L, W, fy(-L)), n, [0, 0], [1, 0], [1, 1], [0, 1], C.asphalt);
  if (e.wid >= 5.5) {
    for (let u = -L + 0.5; u + 2 < L; u += 4) w.plain.quad(P(u, -0.06, fy(u) + 0.02), P(u + 2, -0.06, fy(u + 2) + 0.02), P(u + 2, 0.06, fy(u + 2) + 0.02), P(u, 0.06, fy(u) + 0.02), n, [0, 0], [1, 0], [1, 1], [0, 1], C.line);
  }
  // 両側の壁（床の下から地面まで）と、下の端の壁にトンネルの口
  for (const v of [-W, W]) {
    const nv = v < 0 ? 1 : -1;
    w.stone.quad(P(-L, v, fy(-L) - 0.3), P(L, v, fy(L) - 0.3), P(L, v, rimAt(e, L, v)), P(-L, v, rimAt(e, -L, v)), [f.sx * nv, 0, f.sz * nv], [0, 0], [L / 2, 0], [L / 2, H / 2], [0, H / 2], C.concrete);
  }
  w.stone.quad(P(L, -W, yb - 0.3), P(L, W, yb - 0.3), P(L, W, rimAt(e, L, W)), P(L, -W, rimAt(e, L, -W)), [-f.dx, 0, -f.dz], [0, 0], [W, 0], [W, H / 2], [0, H / 2], C.concrete);
  const pw = W - 0.25, ph = Math.min(RAMP_PORTAL_H, H - 0.3);
  w.plain.quad(P(L - 0.03, -pw, yb), P(L - 0.03, pw, yb), P(L - 0.03, pw, yb + ph), P(L - 0.03, -pw, yb + ph), [-f.dx, 0, -f.dz], [0, 0], [1, 0], [1, 1], [0, 1], C.tunnel);
  // トンネルの口の上の黄色と黒の高さ制限の梁
  const stripes = (wr, u, yA, yB) => {
    const k = Math.max(2, Math.round((2 * pw) / 0.5));
    for (let i = 0; i < k; i++) {
      const v0 = -pw + (2 * pw * i) / k, v1 = v0 + (2 * pw) / k;
      const [cx, cz] = f.at(u, (v0 + v1) / 2);
      box(wr, cx, cz, yA, yB, f.sx, f.sz, v1 - v0, 0.12, i % 2 ? C.black : C.yellow);
    }
  };
  stripes(w.plain, L - 0.2, yb + ph - 0.05, yb + ph + 0.2);
  // 3 辺のコンクリートの腰壁（入口の側を除く）と手すり
  const ry = (u0, v0, u1, v1) => {
    const a = rimAt(e, u0, v0), b = rimAt(e, u1, v1);
    return [Math.min(a, b) - 0.3, (a + b) / 2 + RAMP_PARAPET];
  };
  for (const s of [-1, 1]) {
    const [cx, cz] = f.at(0.15, s * (W + PARAPET_T / 2));
    box(w.stone, cx, cz, ...ry(-L, s * W, L, s * W), f.dx, f.dz, 2 * L + 0.3, PARAPET_T, C.concrete);
  }
  {
    const [cx, cz] = f.at(L + PARAPET_T / 2, 0);
    box(w.stone, cx, cz, ...ry(L, -W, L, W), f.sx, f.sz, e.wid + 2 * PARAPET_T, PARAPET_T, C.concrete);
  }
  const railY = rimAt(e, 0, 0) + RAMP_PARAPET + 0.12, o = PARAPET_T / 2;
  bar(w.steel, P(-L, -W - o, railY), P(L + o, -W - o, railY), 0.05, C.steel);
  bar(w.steel, P(L + o, -W - o, railY), P(L + o, W + o, railY), 0.05, C.steel);
  bar(w.steel, P(L + o, W + o, railY), P(-L, W + o, railY), 0.05, C.steel);
  // 入口の高さ制限の門（両脇の柱と黄色と黒の梁）
  const ga = -L + 0.4, gy = (v) => rimAt(e, ga, v);
  for (const v of [-W - 0.15, W + 0.15]) {
    const [cx, cz] = f.at(ga, v);
    box(w.plain, cx, cz, gy(v) - 0.2, y0 + 2.45, f.dx, f.dz, 0.16, 0.16, C.post);
  }
  stripes(w.plain, ga, y0 + 2.2, y0 + 2.45);
  // 入口の脇の P の看板（青地に白い P。両面）
  const seed = Math.round(e.x * 3 + e.z * 7), side = hash01(seed, 2) < 0.5 ? -1 : 1;
  const [tx, tz] = f.at(-L - 1, side * (W + 0.6)), ty = rimAt(e, -L - 1, side * (W + 0.6));
  box(w.plain, tx, tz, ty - 0.2, ty + 2.9, f.dx, f.dz, 0.1, 0.1, C.post);
  box(w.plain, tx, tz, ty + 2.2, ty + 2.9, f.sx, f.sz, 0.72, 0.06, C.name);
  for (const s of [1, -1]) {
    const nx = -f.dx * s, nz = -f.dz * s, off = 0.032;
    const c = (vv, y) => [tx + nx * off + f.sx * vv * s, y, tz + nz * off + f.sz * vv * s];
    w.sign.quad(c(-0.35, ty + 2.22), c(0.35, ty + 2.22), c(0.35, ty + 2.88), c(-0.35, ty + 2.88), [nx, 0, nz], [0.5, 0], [1, 0], [1, 1], [0.5, 1], [1, 1, 1]);
  }
}

// 出入口のメッシュ（エリア全体で 1 つのグループ）。list: fillMetroPits で rim を付けた出入口
export function buildMetroEntrances(list, mats) {
  const stone = new MeshWriter(), steel = new MeshWriter(), plain = new MeshWriter(), sign = new MeshWriter();
  for (const e of list) {
    if (e.rim == null) continue;
    if (e.kind === 'parking') {
      writeRamp(e, { stone, steel, plain, sign });
      continue;
    }
    // y0: 上の端（入口）の地面の高さ。yb: 下の踊り場の床
    const f = entranceFrame(e), H = entranceDepth(e), y0 = rimAt(e, -e.len / 2, 0), yb = rimAt(e, e.len / 2, 0) - H;
    const L = e.len / 2, W = e.wid / 2;
    const P = (u, v, y) => {
      const [x, z] = f.at(u, v);
      return [x, y, z];
    };
    const seed = Math.round(e.x * 3 + e.z * 7);
    // 吹き抜けの中の壁（上から下の踊り場の床の少し下まで。内側を向く）
    const inner = [[[-L, -W], [L, -W], [f.sx, f.sz]], [[L, W], [-L, W], [-f.sx, -f.sz]], [[L, -W], [L, W], [-f.dx, -f.dz]], [[-L, W], [-L, -W], [f.dx, f.dz]]];
    for (const [[u0, v0], [u1, v1], [nx, nz]] of inner) {
      const l = Math.hypot(u1 - u0, v1 - v0);
      stone.quad(P(u0, v0, yb - 0.2), P(u1, v1, yb - 0.2), P(u1, v1, rimAt(e, u1, v1)), P(u0, v0, rimAt(e, u0, v0)), [nx, 0, nz], [0, 0], [l / 2, 0], [l / 2, H / 2], [0, H / 2], C.wall);
    }
    // 下の踊り場の床と、下の端の壁のガラスの扉（枠つき）
    plain.quad(P(L - LANDING, -W, yb), P(L, -W, yb), P(L, W, yb), P(L - LANDING, W, yb), [0, 1, 0], [0, 0], [1, 0], [1, 1], [0, 1], C.floor);
    const dw = Math.min(e.wid - 0.6, 3.6) / 2, dh = Math.min(2.4, H - 0.3);
    const o = -0.02;
    plain.quad(P(L + o, -dw - 0.08, yb), P(L + o, dw + 0.08, yb), P(L + o, dw + 0.08, yb + dh + 0.08), P(L + o, -dw - 0.08, yb + dh + 0.08), [-f.dx, 0, -f.dz], [0, 0], [1, 0], [1, 1], [0, 1], C.frame);
    plain.quad(P(L + o * 2, -dw, yb), P(L + o * 2, dw, yb), P(L + o * 2, dw, yb + dh), P(L + o * 2, -dw, yb + dh), [-f.dx, 0, -f.dz], [0, 0], [1, 0], [1, 1], [0, 1], C.door);
    // 階段（上の端から踊り場まで）。広い吹き抜けは片側をエスカレーター
    const run = Math.max(2, e.len - LANDING), drop = y0 - yb, n = Math.max(4, Math.round(drop / STEP_H)), tread = run / n, rise = drop / n;
    const esc = e.wid >= 4.2;
    const vs = esc ? (hash01(seed, 1) < 0.5 ? 1 : -1) : 0; // エスカレーターの側
    const sv0 = esc && vs < 0 ? -W + ESCALATOR_W + 0.15 : -W, sv1 = esc && vs > 0 ? W - ESCALATOR_W - 0.15 : W;
    for (let i = 0; i < n; i++) {
      const u0 = -L + i * tread, u1 = u0 + tread, y = y0 - (i + 1) * rise;
      plain.quad(P(u0, sv0, y), P(u1, sv0, y), P(u1, sv1, y), P(u0, sv1, y), [0, 1, 0], [0, 0], [1, 0], [1, 1], [0, 1], i % 2 ? C.step : C.nose);
      plain.quad(P(u0, sv1, y), P(u0, sv0, y), P(u0, sv0, y + rise), P(u0, sv1, y + rise), [-f.dx, 0, -f.dz], [0, 0], [1, 0], [1, 1], [0, 1], C.nose);
    }
    // 階段の真ん中の手すり（広い階段だけ）
    const hr = (v) => bar(steel, P(-L + 0.3, v, y0 + 0.9 - 0.3 * (rise / tread)), P(-L + run, v, yb + 0.9), 0.05, C.steel);
    if (sv1 - sv0 > 3) hr((sv0 + sv1) / 2);
    if (esc) {
      // エスカレーター: 黒い段の斜面と、両側のステンレスの欄干（斜めの板）と黒い手すり
      const e0 = vs > 0 ? W - ESCALATOR_W : -W, e1 = e0 + ESCALATOR_W;
      const tA = P(-L, e0, y0 - 0.05), tB = P(-L, e1, y0 - 0.05), bA = P(-L + run, e0, yb), bB = P(-L + run, e1, yb);
      plain.quad(tA, tB, bB, bA, [f.dx * 0.5, 0.86, f.dz * 0.5], [0, 0], [1, 0], [1, 1], [0, 1], C.esc);
      for (const v of [e0 + 0.06, e1 - 0.06]) {
        const a = P(-L, v, y0), b = P(-L + run, v, yb), a2 = P(-L, v, y0 + 0.95), b2 = P(-L + run, v, yb + 0.95);
        for (const s of [1, -1]) steel.quad(...(s > 0 ? [a, b, b2, a2] : [b, a, a2, b2]), [f.sx * s, 0, f.sz * s], [0, 0], [1, 0], [1, 1], [0, 1], C.steel);
        bar(plain, a2, b2, 0.08, C.name);
      }
    }
    // 腰壁（入口の側＝上の端を除く 3 辺。外側に）と笠石・ステンレスの手すり
    const wallSides = [[[-L, -W], [L, -W], -1], [[-L, W], [L, W], 1]];
    // 腰壁の上端は両端の地面の高さの平均 + PARAPET、足は低い方の 0.3 m 下（坂の途中でも浮かない）
    const ry = (u0, v0, u1, v1) => {
      const a = rimAt(e, u0, v0), b = rimAt(e, u1, v1);
      return [Math.min(a, b) - 0.3, (a + b) / 2 + PARAPET];
    };
    for (const [[u0, v0], [u1], s] of wallSides) {
      const vm = v0 + (s * PARAPET_T) / 2;
      const [cx, cz] = f.at((u0 + u1) / 2, vm);
      box(stone, cx, cz, ...ry(u0, v0, u1, v0), f.dx, f.dz, u1 - u0 + (u1 === L ? PARAPET_T * 2 : 0), PARAPET_T, C.stone);
    }
    {
      const [cx, cz] = f.at(L + PARAPET_T / 2, 0);
      box(stone, cx, cz, ...ry(L, -W, L, W), f.sx, f.sz, e.wid, PARAPET_T, C.stone);
    }
    const railY = rimAt(e, 0, 0) + PARAPET + 0.12;
    const r0 = P(-L, -W - PARAPET_T / 2, railY), r1 = P(L + PARAPET_T / 2, -W - PARAPET_T / 2, railY), r2 = P(L + PARAPET_T / 2, W + PARAPET_T / 2, railY), r3 = P(-L, W + PARAPET_T / 2, railY);
    bar(steel, r0, r1, 0.05, C.steel);
    bar(steel, r1, r2, 0.05, C.steel);
    bar(steel, r2, r3, 0.05, C.steel);
    // 入口の側の手すり（上の端の両脇から下る）
    for (const v of [-W + 0.1, W - 0.1]) bar(steel, P(-L - 0.3, v, y0 + 0.9), P(-L + run, v, yb + 0.9), 0.05, C.steel);
    // 看板の柱（入口の脇。上の端から 0.8 m 手前、横は腰壁の外）
    const side = hash01(seed, 2) < 0.5 ? -1 : 1;
    const [tx, tz] = f.at(-L - 0.8, side * (W + 0.5)), ty = rimAt(e, -L - 0.8, side * (W + 0.5));
    box(plain, tx, tz, ty - 0.2, ty + 3.0, f.dx, f.dz, 0.2, 0.2, C.post);
    box(plain, tx, tz, ty + 1.9, ty + 2.55, f.sx, f.sz, 0.62, 0.1, C.yellow); // 駅の絵の板（黄色）
    box(plain, tx, tz, ty + 2.6, ty + 2.82, f.sx, f.sz, 0.62, 0.1, C.name); // 駅名の帯
    box(plain, tx, tz, ty + 2.82, ty + 3.48, f.sx, f.sz, 0.66, 0.14, C.name); // M の箱（縁）
    // M の面（両面。上の端の向きと下りる向き）
    for (const s of [1, -1]) {
      const nx = -f.dx * s, nz = -f.dz * s, off = 0.071;
      const c = (vv, y) => [tx + nx * off + f.sx * vv * s, y, tz + nz * off + f.sz * vv * s];
      sign.quad(c(-0.31, ty + 2.84), c(0.31, ty + 2.84), c(0.31, ty + 3.46), c(-0.31, ty + 3.46), [nx, 0, nz], [0, 0], [0.5, 0], [0.5, 1], [0, 1], [1, 1, 1]);
    }
  }
  const group = new THREE.Group();
  group.name = 'metro-entrances';
  for (const [w, m] of [[stone, mats.stone], [steel, mats.steel], [plain, mats.plain], [sign, mats.sign]]) {
    if (w.empty) continue;
    const mesh = new THREE.Mesh(w.toGeometry(), m);
    mesh.castShadow = mesh.receiveShadow = true;
    group.add(mesh);
  }
  return group;
}

// 吹き抜けの穴の形（ステンシル。地面と同じ高さの長方形）
export function writeEntranceMasks(w, list) {
  for (const e of list) {
    if (e.rim == null) continue;
    const L = e.len / 2, W = e.wid / 2, Y = [rimAt(e, -L, -W), rimAt(e, L, -W), rimAt(e, L, W), rimAt(e, -L, W)];
    const P = entranceCorners(e, 0).map(([x, z], i) => [x, Y[i] + 0.03, z]);
    // 上向きの面（反時計回り）
    const [a, b, , d] = P;
    const up = (d[0] - a[0]) * (b[2] - a[2]) - (d[2] - a[2]) * (b[0] - a[0]) > 0;
    const Q = up ? P : [P[0], P[3], P[2], P[1]];
    w.quad(...Q, [0, 1, 0], [0, 0], [1, 0], [1, 1], [0, 1], [1, 1, 1]);
  }
}
