// 地下の駅の間取り（three.js を使わない。単体テストできる）。写真（Wikimedia Commons の Mermoz・Capitole・Esquirol・Carmes・
// Compans-Caffarelli・François Verdier・Saint-Cyprien・Palais de Justice・Arènes・Jean Jaurès）の、トゥールーズの VAL の駅のつくり:
// - 地上の出入口（LiDAR の地形モデルで見つけた吹き抜けの階段。world/metro.js）は、そのまま改札階（salle des billets）へ下りる。
//   階段の下の端を改札階の床の高さにそろえ、吹き抜けは改札階の中の階段の囲いになる（天井はそこだけ空へ抜ける）。
//   改札階から遠い出入口だけ、通路でつなぐ
// - 改札階: 改札の外のホール（券売機・案内）と、1 列の改札（三脚の回転式の改札）。改札の中は線路の上で、両側のホームへ
//   下りる吹き抜け（タイル張りの腰壁で囲う）に、階段と上りのエスカレーター。2 つの方面の階段は反対の向きに下りる
//   （Capitole の「← Direction Basso Cambo | Direction Balma-Gramont →」）
// - ホーム階: 2 本の線路を挟む相対式ホーム（幅 5 m）、全面ガラスのホームドア。階段とエスカレーターはホームの奥の壁に沿って下りてくる
// - 2 つの線の駅（Jean Jaurès）: 真ん中のコンコースから 4 方向の改札の中へ（十字の間取り）
// 座標: ゲームのローカル座標（x 東・z 南・y 上）。駅の局所座標 (s, t) は network.js の stationFrame
import { LAYOUT, TRAIN_CARS, boxHalf, doorOffsets, stationFrame, terminusOf, wallT } from './network.js';
import { entranceDoor, entranceFrame, entranceMaxDepth, rimAt } from '../world/metro.js';
import { NavLayer, rectPoly, stairHeight } from './nav.js';
import { hash01 } from '../geo.js';

export const HALL_H = 3.6; // 改札階の天井の高さ
export const CORR_H = 2.7; // 通路の天井の高さ
export const PLAT_H = 4.3; // ホーム階の天井の高さ
export const RISE = 0.165, TREAD = 0.3, FLIGHT = 18, MID_LANDING = 1.2; // 階段（18 段ごとに踊り場）
export const ESC_ANGLE = (30 * Math.PI) / 180, ESC_FLAT = 0.9, ESC_W = 1.0, STAIR_W = 1.7; // エスカレーター（30°、上下の平らな所）
export const ESC_SPEED = 0.5; // m/s
export const WELL_W = STAIR_W + ESC_W + 0.35; // 吹き抜け（階段＋エスカレーター＋手すりのあいだ）の幅
const GATE_PITCH = 1.05, GATE_HOUSING = 0.25, GATE_LANES = 6; // 改札（回転式の三脚の改札が 6 通路。通路の幅 0.8 m）
const PAID_END = 2.4; // 改札の線から吹き抜けの上の端まで
const PAID_TAIL = 0.8; // 吹き抜けの下りる先から改札の中の端の壁まで
const U_BASE = 11; // 改札の外のホールの最小の長さ（券売機・案内）
const U_REACH = 16; // 出入口をホールに取り込む距離（ホールの基本の長方形から）
const U_MAX_T = 26; // ホールの横の広がりの上限（駅の軸から）

export function stairRun(drop) {
  const n = Math.max(1, Math.ceil(Math.abs(drop) / RISE)), flights = Math.ceil(n / FLIGHT);
  return { n, flights, run: n * TREAD + (flights - 1) * MID_LANDING };
}

export function escalatorRun(drop) {
  return drop / Math.tan(ESC_ANGLE) + 2 * ESC_FLAT;
}

// 階段の高さ（踊り場つき）: u は上の端から（0..run）、上 y0 から下 y1 へ
export function flightHeight(u, run, y0, y1, n, flights) {
  if (u <= 0) return y0;
  if (u >= run) return y1;
  const per = Math.ceil(n / flights); // 1 区切りの段の数
  let k = 0, pos = 0;
  for (let f = 0; f < flights; f++) {
    const steps = Math.min(per, n - k), len = steps * TREAD;
    if (u < pos + len) return stairHeight(u - pos, 0, len, y0 + ((y1 - y0) * k) / n, y0 + ((y1 - y0) * (k + steps)) / n, steps);
    pos += len;
    k += steps;
    if (u < pos + MID_LANDING) return y0 + ((y1 - y0) * k) / n;
    pos += MID_LANDING;
  }
  return y1;
}

// エスカレーターの高さ（上の平らな所、30° の斜面、下の平らな所）
export function escalatorHeight(u, run, y0, y1) {
  const slope = run - 2 * ESC_FLAT;
  if (u <= ESC_FLAT) return y0;
  if (u >= ESC_FLAT + slope) return y1;
  return y0 + ((y1 - y0) * (u - ESC_FLAT)) / slope;
}

// ---------------------------------------------------------------- 高さ
// 単線の駅の改札階の床: 駅のまわりの地面（ホールが広がる所）から 4.2 m、駅の中心から 5 m、出入口の縁から 3.6 m より深く。
// groundAt(x, z): 地面の高さ
export function hallLevel(station, pits, groundAt) {
  const f = stationFrame(station, station.lines[0]);
  let g = groundAt(station.x, station.z), ym = g - 5.0;
  for (let s = -40; s <= 40; s += 10) {
    for (let t = -20; t <= 20; t += 10) ym = Math.min(ym, groundAt(...f.at(s, t)) - 4.2);
  }
  for (const e of pits) if (e.rim != null && e.kind === 'metro') ym = Math.min(ym, rimAt(e, e.len / 2, 0) - 3.6);
  return Math.round(ym * 100) / 100;
}

// 出入口の階段の深さを改札階の床にそろえる（world/ground.js の T.metroAdjust から、地形の手直しの前に 1 回）。
// 階段で届かない短い吹き抜けは届く所まで（下の扉の先に数段の階段）。駅に station.ym を入れる
export function adjustStationPits(station, pits, groundAt) {
  const own = pits.filter((e) => e.kind === 'metro' && e.rim != null);
  if (station.lines.length > 1) return; // 2 つの線の駅は今までの深さ
  const ym = hallLevel(station, own, groundAt);
  station.hallY = ym;
  for (const e of own) {
    const want = rimAt(e, e.len / 2, 0) - ym + 0.03; // 踊り場は改札階の床の 3 cm 下（床と重ならない）
    e.H = Math.max(2.8, Math.min(want, entranceMaxDepth(e)));
  }
}

// 駅の高さ: 改札階の床 ym とホームの床 yp（線ごと）。doors: 出入口の下の扉（entranceDoor）
export function stationLevels(station, doors, groundY, { deep = false } = {}) {
  const yb = doors.length ? Math.min(...doors.map((d) => d.yb)) : groundY - 5;
  const ym = station.hallY != null && station.lines.length < 2 ? station.hallY : deep ? yb - 3.6 : Math.min(yb, groundY - 5);
  const yp = {};
  station.lines.forEach((l, k) => {
    yp[l] = ym - LAYOUT.hallDrop - k * 7.5;
  });
  return { ym, yp };
}

// 駅の高さ（改札階 ym・ホーム yp）。2 つの線の駅は、出入口の吹き抜けが改札階の上にかかれば改札階を 1 層深く
export function stationLevelsFor(station, entrances, groundY) {
  const doors = entrances.filter((e) => e.rim != null && e.kind === 'metro').map((e) => ({ e, ...entranceDoor(e) }));
  if (station.lines.length < 2) return { ...stationLevels(station, doors, groundY), deep: false, doors };
  const pre = crossLayout(station, stationLevels(station, doors, groundY));
  const rects0 = crossRects(station, pre);
  const overlaps = doors.some(({ e }) => pitTouches(e, rects0, 1.5));
  return { ...stationLevels(station, doors, groundY, { deep: overlaps }), deep: overlaps, doors };
}

function pitTouches(e, rects, m) {
  const f = entranceFrame(e);
  for (let u = -e.len / 2; u <= e.len / 2 + 2.5; u += 1) {
    for (const v of [-e.wid / 2, 0, e.wid / 2]) {
      const [x, z] = f.at(u, v);
      if (rects.some((r) => inRect(r, x, z, m))) return true;
    }
  }
  return false;
}

// 出入口の吹き抜けの形（ローカル座標の四隅）と、駅の局所座標の外接長方形
function pitInfo(e, f) {
  const fe = entranceFrame(e), L = e.len / 2, W = e.wid / 2;
  const poly = [fe.at(-L, -W), fe.at(L, -W), fe.at(L, W), fe.at(-L, W)];
  const loc = poly.map(([x, z]) => f.local(x, z));
  return { poly, s0: Math.min(...loc.map((p) => p[0])), s1: Math.max(...loc.map((p) => p[0])), t0: Math.min(...loc.map((p) => p[1])), t1: Math.max(...loc.map((p) => p[1])) };
}

// ---------------------------------------------------------------- 駅の間取り
// entrances: この駅の出入口（world/metro.js の、rim のあるもの）。groundY: 駅の中心の地面の高さ
export function planStation(station, entrances, groundY, network = null) {
  return station.lines.length > 1 ? planCross(station, entrances, groundY, network) : planSingle(station, entrances, groundY, network);
}

function linePlan(station, line, yp, network) {
  const f = stationFrame(station, line), Lb = boxHalf(line, station);
  const n = TRAIN_CARS[line], doorsS = doorOffsets(n);
  const half = (n * LAYOUT.carPitch) / 2 + 0.6;
  const dirs = [1, -1].map((side) => ({ side, dir: side, terminus: network ? terminusOf(network, line, side) : null }));
  return { line, frame: f, yp, Lb, doorsS, psdHalf: half, dirs };
}

// 吹き抜け（片方のホームへ）: 上の端 s0 から dirS の向きに下りる。side: ホームの側（t の符号）
function addWell(plan, L, side, s0, dirS, ym, yp) {
  const WT = wallT(), drop = ym - yp, st = stairRun(drop), escRun = escalatorRun(drop), len = Math.max(st.run, escRun);
  const tWall = WT * side, tIn = (WT - WELL_W) * side;
  const tStair = [tIn, tIn + STAIR_W * side].sort((a, b) => a - b), tEsc = [tWall - ESC_W * side, tWall - 0.02 * side].sort((a, b) => a - b);
  const f = L.frame;
  plan.wells.push({ line: L.line, frame: f, side, s0, s1: s0 + len * dirS, dirS, t0: Math.min(tIn, tWall), t1: Math.max(tIn, tWall), yTop: ym, yBot: yp });
  plan.stairs.push({ kind: 'stairs', line: L.line, frame: f, side, s0, dirS, run: st.run, len, t0: tStair[0], t1: tStair[1], y0: ym, y1: yp, n: st.n, flights: st.flights });
  plan.stairs.push({ kind: 'escalator', line: L.line, frame: f, side, s0, dirS, run: escRun, len, t0: tEsc[0], t1: tEsc[1], y0: ym, y1: yp, up: true });
  return len;
}

// 単線の駅
function planSingle(station, entrances, groundY, network) {
  const line = station.lines[0], WT = wallT();
  const lv = stationLevelsFor(station, entrances, groundY);
  const ym = lv.ym, yp = lv.yp[line];
  const L = linePlan(station, line, yp, network), f = L.frame, Lb = L.Lb;
  const doors = lv.doors;
  const info = doors.map((d) => ({ d, ...pitInfo(d.e, f), door: f.local(d.x, d.z) }));
  // 吹き抜けと扉の前（数段の階段と 2.2 m）の外接長方形 [a0, a1] × [b0, b1]
  for (const p of info) {
    const apron = (p.d.yb > ym + 0.06 ? stairRun(p.d.yb - ym).run + 0.4 : 0) + 2.2, lat = p.d.dw + 0.6;
    const ext = [[p.d.x, p.d.z], [p.d.x + p.d.dx * apron, p.d.z + p.d.dz * apron]].flatMap(([x, z]) => [f.local(x + p.d.sx * lat, z + p.d.sz * lat), f.local(x - p.d.sx * lat, z - p.d.sz * lat)]);
    p.a0 = Math.min(p.s0, ...ext.map((q) => q[0]));
    p.a1 = Math.max(p.s1, ...ext.map((q) => q[0]));
    p.b0 = Math.min(p.t0, ...ext.map((q) => q[1]));
    p.b1 = Math.max(p.t1, ...ext.map((q) => q[1]));
  }
  const drop = ym - yp, wl = Math.max(stairRun(drop).run, escalatorRun(drop));
  // 改札の中の置き場所と、改札の外のホールの数（+ の端・− の端・両端）: 出入口の吹き抜けが改札の中にかからず、出入口から近いもの。
  // 吹き抜け（w0..w0 + wl）はホームの箱の中。改札の中・外のホールは箱の外（トンネルの上）へはみ出してよい
  const boxHits = (p, s0, s1, t0, t1) => p.s1 > s0 && p.s0 < s1 && p.t1 > t0 && p.t0 < t1;
  const conflicts = (p, mode, a, b, w0) => {
    let c = 0;
    if (p.a1 > a - 0.9 && p.a0 < b + 0.9 && p.b1 > -WT - 0.8 && p.b0 < WT + 0.8) c += 1000; // 改札の中に吹き抜け・扉の前がかかる
    if (boxHits(p, w0 - 1.2, w0 + wl + 1.2, -WT - 0.5, WT + 0.5)) c += 5000; // 吹き抜けの上
    for (const end of mode === '2' ? [1, -1] : mode === '+' ? [1] : [-1]) {
      const edge = end > 0 ? b : a;
      if (boxHits(p, Math.min(edge - 1.5 * end, edge + 3.5 * end), Math.max(edge - 1.5 * end, edge + 3.5 * end), -WT - 0.5, WT + 0.5)) c += 3000; // 改札の前後
    }
    return c;
  };
  let best = null;
  for (const mode of ['+', '-', '2']) {
    for (let w0 = -Lb + 1.5; w0 + wl <= Lb - 1.5 + 1e-9; w0 += 0.5) {
      const a = mode === '+' ? w0 - PAID_TAIL : w0 - PAID_END;
      const b = mode === '-' ? w0 + wl + PAID_TAIL : w0 + wl + PAID_END;
      let cost = mode === '2' ? 6 : 0;
      for (const p of info) {
        cost += conflicts(p, mode, a, b, w0);
        const side = (p.s0 + p.s1) / 2 >= (a + b) / 2 ? 1 : -1;
        const has = mode === '2' || (mode === '+' ? side > 0 : side < 0);
        const edge = has ? (side > 0 ? b : a) : side > 0 ? a : b;
        // 改札の外のホールの側にあれば、改札からの距離。反対の側なら遠回り
        const ds = has ? Math.max(0, side > 0 ? p.s0 - edge : edge - p.s1) : Math.abs((p.s0 + p.s1) / 2 - edge) + 40;
        const dt = Math.max(0, p.t0 - WT, -WT - p.t1);
        cost += ds + dt * 0.5;
      }
      // 駅の真ん中に近いほどよい（少しだけ）
      cost += Math.abs((a + b) / 2) * 0.05;
      if (!best || cost < best.cost) best = { mode, a, b, w0, cost };
    }
  }
  const { mode, a, b, w0 } = best;
  // 改札の中・吹き抜け・改札の前にかかる出入口は閉める（地上から下りた扉は閉まっている）
  for (const p of info) p.blocked = conflicts(p, mode, a, b, w0) > 0;
  const plan = {
    layout: 'single', station, groundY, ym, deep: false, frame: f, lines: [], stairs: [], wells: [], gates: [], rects: [], corridors: [], openings: [], pits: [], closed: [], direct: [], doorSteps: [],
  };
  plan.lines.push(L);
  // 改札の中（線路の上）
  plan.rects.push({ frame: f, s0: a, s1: b, t0: -WT, t1: WT, kind: 'paid' });
  // 吹き抜け: 片方の端だけにホールがあれば、両方の吹き抜けをその改札の近くから奥へ下りる。両端なら反対の向きに
  if (mode === '+') for (const side of [1, -1]) addWell(plan, L, side, b - PAID_END, -1, ym, yp);
  else if (mode === '-') for (const side of [1, -1]) addWell(plan, L, side, a + PAID_END, 1, ym, yp);
  else {
    addWell(plan, L, 1, b - PAID_END, -1, ym, yp);
    addWell(plan, L, -1, a + PAID_END, 1, ym, yp);
  }
  // 改札の外のホール（端ごと）: 基本の長方形を、近くの出入口の吹き抜けが入るまで広げる
  const ends = mode === '2' ? [1, -1] : mode === '+' ? [1] : [-1];
  for (const end of ends) {
    const edge = end > 0 ? b : a;
    let s0 = end > 0 ? edge : edge - U_BASE, s1 = end > 0 ? edge + U_BASE : edge, t0 = -WT, t1 = WT;
    const mine = info.filter((p) => ((p.s0 + p.s1) / 2 >= (a + b) / 2 ? 1 : -1) === end || !ends.includes(-end));
    const take = (p) => {
      s0 = Math.min(s0, p.a0 - 1.4);
      s1 = Math.max(s1, p.a1 + 1.4);
      t0 = Math.min(t0, p.b0 - 1.4);
      t1 = Math.max(t1, p.b1 + 1.4);
      if (end > 0) s0 = edge;
      else s1 = edge;
      p.direct = end;
    };
    for (const p of mine) {
      // 改札の中の側へはみ出す吹き抜けは取り込めない（通路で）
      if (p.blocked || (end > 0 ? p.a0 < edge + 0.3 : p.a1 > edge - 0.3)) continue;
      const ds = Math.max(0, p.s0 - s1, s0 - p.s1), dt = Math.max(0, p.t0 - t1, t0 - p.t1);
      if (ds > U_REACH || dt > U_REACH || p.b1 > U_MAX_T || p.b0 < -U_MAX_T) continue;
      take(p);
    }
    // 取り込んだ吹き抜けで広げたホールに、取り込んでいない吹き抜けがかかったら、それも取り込む（かかったまま通路にはしない）
    for (let again = true; again;) {
      again = false;
      for (const p of mine) {
        if (p.direct || p.blocked) continue;
        if (p.a1 > s0 - 0.6 && p.a0 < s1 + 0.6 && p.b1 > t0 - 0.6 && p.b0 < t1 + 0.6 && (end > 0 ? p.a0 >= edge + 0.3 : p.a1 <= edge - 0.3)) {
          take(p);
          again = true;
        }
      }
    }
    plan.rects.push({ frame: f, s0, s1, t0, t1, kind: 'unpaid', end });
    // 改札の side: 改札の外から中へ向かう向き（s の符号）
    plan.gates.push({ line, frame: f, side: -end, s: edge, t0: -WT, t1: WT, dir: null, both: true, end });
  }
  // 出入口: ホールの中の吹き抜けはそのまま下りる（下の扉がホールより高ければ数段の階段）。ほかは通路で
  const halls = plan.rects;
  for (const p of info) {
    if (!p.direct) continue;
    plan.direct.push(p.d.e);
    const step = p.d.yb - ym;
    if (step > 0.06) {
      const st = stairRun(step);
      plan.doorSteps.push({ e: p.d.e, door: p.d, y0: p.d.yb, y1: ym, st, len: st.run + 0.4, w: Math.min(2 * p.d.dw, 3.6) });
    }
  }
  const attach = [];
  for (const r of halls.filter((q) => q.kind === 'unpaid')) {
    // ホールの辺のうち、改札の中と接していない所
    const edges = [
      { axis: 't', at: r.t1, lo: r.s0, hi: r.s1, out: 1 }, { axis: 't', at: r.t0, lo: r.s0, hi: r.s1, out: -1 },
      { axis: 's', at: r.end > 0 ? r.s1 : r.s0, lo: r.t0, hi: r.t1, out: r.end },
    ];
    // ゲートの側の辺（改札の中と接する所を除いた両脇）
    const ge = r.end > 0 ? r.s0 : r.s1;
    if (r.t1 > WT + 1) edges.push({ axis: 's', at: ge, lo: WT, hi: r.t1, out: -r.end });
    if (r.t0 < -WT - 1) edges.push({ axis: 's', at: ge, lo: r.t0, hi: -WT, out: -r.end });
    for (const e of edges) attach.push({ ...e, frame: f });
  }
  // 遠い出入口は通路で（改札に近い順に）
  const far = info.filter((p) => !p.direct && !p.blocked).sort((p, q) => Math.min(Math.abs(p.door[0] - a), Math.abs(p.door[0] - b)) - Math.min(Math.abs(q.door[0] - a), Math.abs(q.door[0] - b)));
  plan.pits = doors.map((d) => d.e);
  routeAll(plan, far.map((p) => p.d), attach, halls);
  plan.closed.push(...info.filter((p) => p.blocked).map((p) => p.d.e));
  plan.boxed = plan.closed.filter((e) => pitInfo(e, f).poly.some(([x, z]) => halls.some((r) => inRect(r, x, z, 0.3))));
  return plan;
}

// ---------------------------------------------------------------- 2 つの線の駅（十字の間取り）
// 改札階の長方形（局所座標）: 28 m 四方のコンコースと 4 方向の改札の中
export function crossLayout(station, levels) {
  const WT = wallT();
  const Cs = 14, Ct = 14;
  const lines = station.lines.map((line, k) => {
    const drop = levels.ym - levels.yp[line];
    const st = stairRun(drop), esc = escalatorRun(drop);
    const wellLen = Math.max(st.run, esc);
    const c0 = k === 0 ? Cs : Ct;
    return { line, k, drop, stair: st, escRun: esc, wellLen, c0, Lw: wellLen + 2.2, sTop: c0 + 1.6 };
  });
  return { Cs, Ct, WT, lines, two: true };
}

export function crossRects(station, hall) {
  const out = [];
  const fP = stationFrame(station, station.lines[0]);
  out.push({ frame: fP, s0: -hall.Cs, s1: hall.Cs, t0: -hall.Ct, t1: hall.Ct, kind: 'unpaid', end: 0 });
  for (const L of hall.lines) {
    const f = stationFrame(station, L.line);
    out.push({ frame: f, s0: L.c0, s1: L.c0 + L.Lw, t0: -hall.WT, t1: hall.WT, kind: 'paid', line: L.line, side: 1 });
    out.push({ frame: f, s0: -L.c0 - L.Lw, s1: -L.c0, t0: -hall.WT, t1: hall.WT, kind: 'paid', line: L.line, side: -1 });
  }
  return out;
}

function planCross(station, entrances, groundY, network) {
  const fP = stationFrame(station, station.lines[0]);
  const lv = stationLevelsFor(station, entrances, groundY);
  const levels = { ym: lv.ym, yp: lv.yp };
  const hall = crossLayout(station, levels);
  const rects = crossRects(station, hall);
  const plan = { layout: 'cross', station, groundY, ym: levels.ym, deep: lv.deep, frame: fP, hall, rects, lines: [], stairs: [], wells: [], gates: [], corridors: [], openings: [], pits: [], closed: [], direct: [], doorSteps: [] };
  for (const H of hall.lines) {
    const L = linePlan(station, H.line, levels.yp[H.line], network);
    plan.lines.push(L);
    for (const side of [1, -1]) {
      addWell(plan, L, side, H.sTop * side, side, levels.ym, L.yp);
      plan.gates.push({ line: H.line, frame: L.frame, side, s: H.c0 * side, t0: -hall.WT, t1: hall.WT, dir: L.dirs.find((d) => d.side === side) });
    }
  }
  // 出入口はコンコースの辺（改札の中にかからない所）へ通路で
  const WT = hall.WT, attach = [];
  for (const sg of [1, -1]) {
    for (const [lo, hi] of [[-hall.Cs, -WT], [WT, hall.Cs]]) attach.push({ frame: fP, axis: 't', at: sg * hall.Ct, lo, hi, out: sg });
    for (const [lo, hi] of [[-hall.Ct, -WT], [WT, hall.Ct]]) attach.push({ frame: fP, axis: 's', at: sg * hall.Cs, lo, hi, out: sg });
  }
  plan.pits = lv.doors.map((d) => d.e);
  routeAll(plan, lv.doors, attach, rects);
  return plan;
}

export function inRect(r, x, z, m = 0) {
  const [s, t] = r.frame.local(x, z);
  return s > r.s0 - m && s < r.s1 + m && t > r.t0 - m && t < r.t1 + m;
}

// ---------------------------------------------------------------- 通路
// 出入口ごとに通路を通す。通す順番で道筋が変わるので、いくつかの順番を試し、全部がほかの通路と重ならずに通るうちで最も短いもの。
// 通せない出入口は閉まっている（扉を閉める。ほかの出入口から出入りする）
function routeAll(plan, doors, attach, blockers) {
  const allPits = plan.pits.length ? plan.pits : [...doors.map((q) => q.e), ...plan.direct];
  const perms = permutations(doors.map((_, i) => i)).slice(0, 8);
  let best = null;
  for (const perm of perms) {
    plan.corridors = [];
    plan.openings = [];
    const used = [];
    let ok = 0, len = 0;
    for (const i of perm) {
      const c = routeCorridor(doors[i], plan, used, i, allPits, attach, blockers);
      if (!c) continue;
      plan.corridors.push(c);
      ok++;
      len += c.len;
    }
    if (!best || ok > best.ok || (ok === best.ok && len < best.len)) best = { ok, len, corridors: plan.corridors, openings: plan.openings };
    if (ok === doors.length) break; // 全部通る順番が見つかれば終わり
  }
  plan.corridors = best ? best.corridors : [];
  plan.openings = best ? best.openings : [];
  plan.corridors.sort((a, b) => a.idx - b.idx);
  plan.closed = doors.filter((_, i) => !plan.corridors.some((c) => c.idx === i)).map((d) => d.e);
  plan.boxed = [];
}

// 通路の道筋: 下の扉 → 2 m 進む → 駅の向き（s か t）にそろえて → ホールの辺の手前の点 A2 → ホールの辺 Pa。
// 曲がり角は 90° 以下。高さの差は最後の区間（A2 → Pa）の階段で。attach: ホールの辺 { frame, axis, at, lo, hi, out }
function routeCorridor(d, plan, used, idx, pits, attach, blockers, { overlap = false } = {}) {
  const f = plan.frame;
  const w = Math.min(2 * d.dw, 3.6);
  const drop = d.yb - plan.ym;
  const Dl = f.local(d.x, d.z), D1 = f.local(d.x + d.dx * 2, d.z + d.dz * 2);
  // 扉から出て最初に進む向き: そのまま、または駅の 4 つの向きのどれかへ少し進んでから
  const firsts = [D1];
  for (const [es, et] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) for (const a of [2, 5, 9, 14]) firsts.push([D1[0] + es * a, D1[1] + et * a]);
  const st = drop > 0.4 ? stairRun(drop) : null;
  const Lr = Math.max(2.5, (st ? st.run : 0) + 1.6);
  // 通路がほかの出入口の吹き抜け（と自分の吹き抜け）の下を通らない（階段で吹き抜けの床より 2.9 m 以上下りた所はよい）
  const pitRects = pits.map((e) => ({ e, f: entranceFrame(e), yb: entranceDoor(e).yb }));
  const hitsPit = (pts) => {
    for (const p of samplePath(pts, d.yb, plan.ym, st)) {
      if (p.seg < 1) continue;
      const [x, z] = f.at(p.s, p.t);
      for (const { e, f: g, yb } of pitRects) {
        if (p.y < yb - 2.9) continue;
        const uu = (x - e.x) * g.dx + (z - e.z) * g.dz, v = (x - e.x) * g.sx + (z - e.z) * g.sz;
        if (Math.abs(uu) < e.len / 2 + 0.6 && Math.abs(v) < e.wid / 2 + w / 2 + 0.3) return true;
      }
    }
    return false;
  };
  // 改札階の高さの所でホール（改札の中・ほかのホール）を通らない（入る辺の手前の w/2 + 0.6 m は除く）
  const hitsHall = (pts) => {
    const n = pts.length, Pa = pts[n - 1];
    for (const p of samplePath(pts, d.yb, plan.ym, st)) {
      if (p.seg < 1 || Math.abs(p.y - plan.ym) > 3.2) continue;
      if (Math.hypot(p.s - Pa[0], p.t - Pa[1]) < w / 2 + 0.6) continue;
      const [x, z] = f.at(p.s, p.t);
      if (blockers.some((r) => inRect(r, x, z, w / 2 + 0.3))) return true;
    }
    return false;
  };
  // 通路どうし・自分自身と重ならない（高さが 3.2 m 以上違えば上下に交差してよい）
  const hitsCorridor = (pts) => {
    const mine = samplePath(pts, d.yb, plan.ym, st);
    for (const c of plan.corridors) {
      c.samples ||= samplePath(c.local, c.yTop, c.yBot, c.stair);
      for (const a of mine) {
        if (a.seg < 1) continue;
        for (const b of c.samples) {
          if (b.seg < 1) continue;
          if (Math.abs(a.y - b.y) < 3.2 && Math.hypot(a.s - b.s, a.t - b.t) < (w + c.w) / 2 + 0.3) return true;
        }
      }
    }
    for (const a of mine) {
      for (const b of mine) {
        if (b.seg < a.seg + 2) continue;
        if (Math.abs(a.y - b.y) < 3.2 && Math.hypot(a.s - b.s, a.t - b.t) < w + 0.3) return true;
      }
    }
    return false;
  };
  let best = null;
  for (const sd of attach) {
    const lo = Math.min(sd.lo, sd.hi) + w / 2 + 0.4, hi = Math.max(sd.lo, sd.hi) - w / 2 - 0.4;
    if (hi < lo) continue;
    // 入る位置: 辺の区間に等しく並べた枠と、扉の位置にそろえた位置（ほかの通路が使っていない所）
    const k = Math.floor((hi - lo) / (w + 0.5)) + 1;
    const slots = Array.from({ length: k }, (_, j) => (k > 1 ? lo + ((hi - lo) * j) / (k - 1) : (lo + hi) / 2));
    const want = Math.max(lo, Math.min(hi, sd.axis === 't' ? D1[0] : D1[1]));
    const key = `${sd.axis}:${sd.at.toFixed(2)}`;
    const free = [want, ...slots].filter((p) => !used.some((u) => u.key === key && Math.abs(u.pos - p) < (u.w + w) / 2 + 0.3));
    for (const pos of free) {
      for (const lane of st ? [0, 4.5, 9, 14] : [0, 3, 7]) {
        const P = (along, off) => (sd.axis === 't' ? [along, sd.at + sd.out * off] : [sd.at + sd.out * off, along]);
        const Pa = P(pos, 0), A2 = P(pos, Lr + lane);
        for (const P1 of firsts) {
          for (const order of ['st', 'ts']) {
            const mid = order === 'st' ? [A2[0], P1[1]] : [P1[0], A2[1]];
            const pts = dedupe([Dl, D1, P1, mid, A2, Pa]);
            if (pts.length < 3 || !turnsOk(pts, w)) continue;
            const len = pathLen(pts) + (P1 === D1 ? 0 : 2) + lane * 0.5;
            if (best && len >= best.len) continue;
            // 最後の区間（ホールへ下りる階段）は長さが足りる
            const n = pts.length, last = Math.hypot(pts[n - 1][0] - pts[n - 2][0], pts[n - 1][1] - pts[n - 2][1]);
            if (st && last < st.run + 1.2) continue;
            if (hitsPit(pts) || hitsHall(pts) || (!overlap && hitsCorridor(pts))) continue;
            best = { len, pts, sd, pos, key };
          }
        }
      }
    }
  }
  if (!best) return null;
  used.push({ key: best.key, pos: best.pos, w });
  const world = best.pts.map(([s, t]) => f.at(s, t));
  // ホールの壁の開口（ローカル座標の線分）
  const { sd, pos } = best;
  const o0 = sd.axis === 't' ? f.at(pos - w / 2, sd.at) : f.at(sd.at, pos - w / 2), o1 = sd.axis === 't' ? f.at(pos + w / 2, sd.at) : f.at(sd.at, pos + w / 2);
  const g = sd.frame, n = sd.axis === 't' ? [-g.nx * sd.out, -g.nz * sd.out] : [-g.ax * sd.out, -g.az * sd.out]; // ホールの内向き
  plan.openings.push({ a: o0, b: o1, w, idx, n });
  return { idx, door: d, w, pts: world, local: best.pts, yTop: d.yb, yBot: plan.ym, stair: st, Lr, len: best.len };
}

// 通路の道筋の 0.5 m ごとの点と床の高さ（最後の区間は階段で下りる）→ [{ s, t, y, seg }]
function samplePath(pts, yTop, yBot, st) {
  const out = [], n = pts.length;
  for (let i = 0; i + 1 < n; i++) {
    const [a, b] = [pts[i], pts[i + 1]], len = Math.hypot(b[0] - a[0], b[1] - a[1]), m = Math.max(1, Math.ceil(len / 0.5));
    const last = i === n - 2, flat0 = last && st ? Math.max(0.6, (len - st.run) / 2) : Infinity;
    for (let k = 0; k <= m; k++) {
      const u = (len * k) / m;
      const y = u <= flat0 ? yTop : Math.max(yBot, yTop - ((u - flat0) * RISE) / TREAD);
      out.push({ s: a[0] + ((b[0] - a[0]) * k) / m, t: a[1] + ((b[1] - a[1]) * k) / m, y, seg: i });
    }
  }
  return out;
}

function permutations(a) {
  if (a.length <= 1) return [a];
  const out = [];
  a.forEach((x, i) => {
    for (const p of permutations(a.slice(0, i).concat(a.slice(i + 1)))) out.push([x, ...p]);
  });
  return out;
}

function dedupe(pts) {
  const out = [];
  for (const p of pts) {
    const q = out[out.length - 1];
    if (!q || Math.hypot(p[0] - q[0], p[1] - q[1]) > 0.3) out.push(p);
  }
  // 一直線に並んだ点を除く
  for (let i = out.length - 2; i >= 1; i--) {
    const [a, b, c] = [out[i - 1], out[i], out[i + 1]];
    const cr = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
    const dot = (b[0] - a[0]) * (c[0] - b[0]) + (b[1] - a[1]) * (c[1] - b[1]);
    if (Math.abs(cr) < 1e-6 && dot > 0) out.splice(i, 1);
  }
  return out;
}

// 曲がる角が 95° 以下（最初の角は扉の向きのまま）。とても短い区間（0.8 m 未満）は作らない。
// 同じ向きに続けて曲がる（コの字）なら、あいだの区間は通路の幅より長く
function turnsOk(pts, w = 3.6) {
  const turn = (i) => {
    const [a, b, c] = [pts[i - 1], pts[i], pts[i + 1]];
    return Math.sign((b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]));
  };
  for (let i = 1; i + 2 < pts.length; i++) {
    const L = Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]);
    if (turn(i) !== 0 && turn(i) === turn(i + 1) && L < w + 0.6) return false;
  }
  for (let i = 1; i + 1 < pts.length; i++) {
    const [a, b, c] = [pts[i - 1], pts[i], pts[i + 1]];
    const ux = b[0] - a[0], uz = b[1] - a[1], vx = c[0] - b[0], vz = c[1] - b[1];
    const cos = (ux * vx + uz * vz) / (Math.hypot(ux, uz) * Math.hypot(vx, vz) || 1);
    if (cos < Math.cos((95 * Math.PI) / 180)) return false;
  }
  for (let i = 1; i < pts.length; i++) if (Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]) < 0.8 && i !== 1) return false;
  return true;
}

function pathLen(pts) {
  let l = 0;
  for (let i = 1; i < pts.length; i++) l += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  return l;
}

// 折れ線の左右の縁（角は留め継ぎ）。pts: [[x, z]...]、w: 幅 → { L: [[x, z]...], R: [[x, z]...] }
export function offsetPolyline(pts, w) {
  const h = w / 2, L = [], R = [];
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
    let n1 = null, n2 = null;
    if (i > 0) {
      const dx = p[0] - a[0], dz = p[1] - a[1], l = Math.hypot(dx, dz);
      n1 = [-dz / l, dx / l];
    }
    if (i + 1 < pts.length) {
      const dx = b[0] - p[0], dz = b[1] - p[1], l = Math.hypot(dx, dz);
      n2 = [-dz / l, dx / l];
    }
    let nx, nz, k = 1;
    if (n1 && n2) {
      nx = n1[0] + n2[0];
      nz = n1[1] + n2[1];
      const l = Math.hypot(nx, nz) || 1;
      nx /= l;
      nz /= l;
      k = 1 / Math.max(0.5, nx * n1[0] + nz * n1[1]);
    } else [nx, nz] = n1 || n2;
    L.push([p[0] + nx * h * k, p[1] + nz * h * k]);
    R.push([p[0] - nx * h * k, p[1] - nz * h * k]);
  }
  return { L, R };
}

// 通路の床の高さ: 最後の区間（A2 → Pa）だけ階段。それまでは扉の高さ
export function corridorProfile(c) {
  const pts = c.pts, n = pts.length;
  const lastLen = Math.hypot(pts[n - 1][0] - pts[n - 2][0], pts[n - 1][1] - pts[n - 2][1]);
  const drop = c.yTop - c.yBot;
  if (drop <= 0.4) {
    // 小さな差はゆるい坂
    return { segment: n - 2, flat0: 0, run: lastLen, stairs: false, ramp: true };
  }
  const run = c.stair.run, flat0 = Math.max(0.6, (lastLen - run) / 2);
  return { segment: n - 2, flat0, run, stairs: true };
}

// ---------------------------------------------------------------- 歩ける所
// 床の穴（局所の長方形 → ローカル座標の多角形）
export function wellPoly(w) {
  return rectPoly(w.frame.at, Math.min(w.s0, w.s1), Math.max(w.s0, w.s1), w.t0, w.t1);
}

// 出入口の扉の前の数段の階段の形（扉から下りる向きに len m、幅 w）
export function doorStepPoly(ds) {
  const d = ds.door, h = ds.w / 2;
  const P = (u, v) => [d.x + d.dx * u + d.sx * v, d.z + d.dz * u + d.sz * v];
  return { poly: [P(0, -h), P(ds.len, -h), P(ds.len, h), P(0, h)], P };
}

// 駅の床と壁（静的な層）。ホームドアの扉（開け閉めする壁）は plan.psdWalls に { line, side, s, wall } で入れる
export function buildStationNav(plan) {
  const nav = new NavLayer(plan.station.id, { cell: 6 });
  const { ym } = plan, WT = wallT();
  plan.psdWalls = [];
  const yTop = ym + HALL_H;
  // 改札階の床（吹き抜け・ホールの中の出入口の吹き抜けと扉の前の階段を穴に）
  const pitPolys = plan.direct.map((e) => pitInfo(e, plan.frame).poly);
  const stepPolys = plan.doorSteps.map((ds) => doorStepPoly(ds).poly);
  for (const r of plan.rects) {
    const at = r.frame.at;
    const holes = [];
    for (const w of plan.wells) {
      const P = wellPoly(w);
      if (P.some(([x, z]) => inRect(r, x, z, 0.01))) holes.push(P);
    }
    for (const P of [...pitPolys, ...stepPolys]) if (P.some(([x, z]) => inRect(r, x, z, 0.01))) holes.push(P);
    nav.addRegion(rectPoly(at, r.s0, r.s1, r.t0, r.t1), ym, { kind: 'hall', holes, rect: r });
  }
  // 改札階の外周の壁（長方形の辺のうち、ほかの長方形の中でない所。通路の入口を除く）
  for (const seg of hallBoundary(plan)) nav.addWall(seg[0][0], seg[0][1], seg[1][0], seg[1][1], ym - 0.2, yTop);
  // 吹き抜けの手すり（内側の辺と奥の端）。階段の横の壁はホームまで
  for (const w of plan.wells) {
    const at = w.frame.at, tIn = w.side > 0 ? w.t0 : w.t1, sFar = w.s1;
    const [a, b] = [at(w.s0, tIn), at(sFar, tIn)];
    nav.addWall(a[0], a[1], b[0], b[1], w.yBot - 0.2, w.yTop + 1.1);
    const [c, e] = [at(sFar, w.t0), at(sFar, w.t1)];
    nav.addWall(c[0], c[1], e[0], e[1], w.yTop - 0.3, w.yTop + 1.1);
  }
  // 階段・エスカレーター（階段とエスカレーターのあいだに手すり）
  for (const s of plan.stairs) {
    const at = s.frame.at, d = s.dirS;
    const sa = s.s0, sb = s.s0 + s.len * d;
    const yf = s.kind === 'stairs'
      ? (x, z) => {
          const [ls] = s.frame.local(x, z);
          return flightHeight((ls - sa) * d, s.run, s.y0, s.y1, s.n, s.flights);
        }
      : (x, z) => {
          const [ls] = s.frame.local(x, z);
          return escalatorHeight((ls - sa) * d, s.run, s.y0, s.y1);
        };
    const sEnd = s.s0 + s.run * d;
    const r = nav.addRegion(rectPoly(at, Math.min(sa, sEnd), Math.max(sa, sEnd), s.t0, s.t1), yf, { kind: s.kind });
    if (s.kind === 'escalator') r.conveyor = [-s.frame.ax * d * ESC_SPEED, -s.frame.az * d * ESC_SPEED]; // 上り
    // 階段が短ければ、下の端から吹き抜けの奥までホームの高さの床
    if (Math.abs(sb - sEnd) > 0.05) nav.addRegion(rectPoly(at, Math.min(sEnd, sb), Math.max(sEnd, sb), s.t0, s.t1), s.y1, { kind: 'platform', line: s.line, side: s.side });
    if (s.kind === 'escalator') {
      const tB = Math.abs(s.t0) < Math.abs(s.t1) ? s.t0 : s.t1; // 階段の側の手すり
      const [a, b] = [at(sa, tB - 0.1 * Math.sign(tB)), at(sb, tB - 0.1 * Math.sign(tB))];
      nav.addWall(a[0], a[1], b[0], b[1], s.y1 - 0.2, s.y0 + 1.1);
    }
  }
  // 改札（回転式の三脚の改札の箱と、両脇のガラスの仕切り）
  for (const g of plan.gates) {
    const at = g.frame.at, lanes = gateLanes(g);
    const solid = [];
    let t = g.t0;
    for (const [a, b] of lanes) {
      solid.push([t, a]);
      t = b;
    }
    solid.push([t, g.t1]);
    for (const [a, b] of solid) {
      if (b - a < 0.02) continue;
      const [p, q] = [at(g.s, a), at(g.s, b)];
      nav.addWall(p[0], p[1], q[0], q[1], ym - 0.2, ym + 1.2);
    }
    // 改札の箱の長さ（s の向きに 1.4 m）: 通路の両側の壁
    for (const [a, b] of lanes) {
      for (const tt of [a, b]) {
        const [p, q] = [at(g.s - 0.7, tt), at(g.s + 0.7, tt)];
        nav.addWall(p[0], p[1], q[0], q[1], ym - 0.2, ym + 1.0);
      }
    }
  }
  // ホーム階
  for (const L of plan.lines) {
    const at = L.frame.at, yp = L.yp, P = LAYOUT.psd;
    for (const side of [1, -1]) {
      const w = plan.wells.find((q) => q.line === L.line && q.side === side);
      const ws0 = Math.min(w.s0, w.s1), ws1 = Math.max(w.s0, w.s1);
      const tPs = P * side, tW = WT * side, tIn = side > 0 ? w.t0 : w.t1;
      // ホームの床: ホームドアの側（全長）と、壁の側（階段の前後）
      nav.addRegion(rectPoly(at, -L.Lb, L.Lb, Math.min(tPs, tIn), Math.max(tPs, tIn)), yp, { kind: 'platform', line: L.line, side });
      nav.addRegion(rectPoly(at, -L.Lb, ws0, Math.min(tIn, tW), Math.max(tIn, tW)), yp, { kind: 'platform', line: L.line, side });
      nav.addRegion(rectPoly(at, ws1, L.Lb, Math.min(tIn, tW), Math.max(tIn, tW)), yp, { kind: 'platform', line: L.line, side });
      // 壁: 奥の壁・両端・ホームドア（扉の所は開け閉めする）。階段の上の端の下の囲い
      const wall = (s0, t0, s1, t1, y0 = yp - 0.2, y1 = yp + PLAT_H) => {
        const [a, b] = [at(s0, t0), at(s1, t1)];
        return nav.addWall(a[0], a[1], b[0], b[1], y0, y1);
      };
      wall(-L.Lb, tW, L.Lb, tW);
      wall(-L.Lb, tPs, -L.Lb, tW);
      wall(L.Lb, tPs, L.Lb, tW);
      wall(w.s0, tIn, w.s0, tW, yp - 0.2, w.yTop - 0.5);
      const gaps = L.doorsS.map((s) => [s - 0.8, s + 0.8]);
      let s = -L.Lb;
      for (const [a, b] of gaps) {
        wall(s, tPs, a, tPs);
        plan.psdWalls.push({ line: L.line, side, s: (a + b) / 2, wall: wall(a, tPs, b, tPs) });
        s = b;
      }
      wall(s, tPs, L.Lb, tPs);
    }
  }
  // 通路
  for (const c of plan.corridors) addCorridorNav(nav, c);
  // 地上の出入口の吹き抜けの階段（閉まった出入口は扉の所も壁）。ホールの中の吹き抜けは扉の前に数段の階段
  for (const e of plan.pits) addPitNav(nav, e, plan.closed.includes(e));
  for (const ds of plan.doorSteps) {
    const { poly, P } = doorStepPoly(ds), d = ds.door;
    const yf = (x, z) => flightHeight((x - d.x) * d.dx + (z - d.z) * d.dz - 0.2, ds.st.run, ds.y0, ds.y1, ds.st.n, ds.st.flights);
    nav.addRegion(poly, yf, { kind: 'stairs', corridor: true });
    for (const v of [-ds.w / 2, ds.w / 2]) {
      const [a, b] = [P(0, v), P(ds.len, v)];
      nav.addWall(a[0], a[1], b[0], b[1], ds.y1 - 0.2, ds.y0 + 1.0);
    }
  }
  plan.nav = nav;
  return nav;
}

// 改札の通路 [[t0, t1], ...]（真ん中に GATE_LANES 本）
export function gateLanes(g) {
  const n = GATE_LANES, total = n * GATE_PITCH + GATE_HOUSING, start = -total / 2 + GATE_HOUSING;
  const out = [];
  for (let k = 0; k < n; k++) {
    const a = start + k * GATE_PITCH;
    out.push([a, a + GATE_PITCH - GATE_HOUSING]);
  }
  return out;
}

// 改札階の外周の壁の線分（[[x, z], [x, z]]）。通路の入口・改札の列は開ける
export function hallBoundary(plan) {
  const out = [];
  const rects = plan.rects;
  const insideOther = (r, x, z) => rects.some((q) => q !== r && inRect(q, x, z, 0));
  const onOpening = (x, z) => plan.openings.some((o) => {
    const dx = o.b[0] - o.a[0], dz = o.b[1] - o.a[1], l2 = dx * dx + dz * dz || 1;
    const u = ((x - o.a[0]) * dx + (z - o.a[1]) * dz) / l2;
    if (u < 0 || u > 1) return false;
    return Math.hypot(o.a[0] + dx * u - x, o.a[1] + dz * u - z) < 0.08;
  });
  for (const r of rects) {
    const at = r.frame.at;
    const edges = [
      [[r.s0, r.t0], [r.s1, r.t0], [0, -1]], [[r.s1, r.t0], [r.s1, r.t1], [1, 0]],
      [[r.s1, r.t1], [r.s0, r.t1], [0, 1]], [[r.s0, r.t1], [r.s0, r.t0], [-1, 0]],
    ];
    for (const [[s0, t0], [s1, t1], [ns, nt]] of edges) {
      const L = Math.hypot(s1 - s0, t1 - t0), n = Math.max(1, Math.ceil(L / 0.25));
      let run = null;
      const flush = (k) => {
        if (run != null && k > run) out.push([at(s0 + ((s1 - s0) * run) / n, t0 + ((t1 - t0) * run) / n), at(s0 + ((s1 - s0) * k) / n, t0 + ((t1 - t0) * k) / n)]);
        run = null;
      };
      for (let k = 0; k < n; k++) {
        const u = (k + 0.5) / n, s = s0 + (s1 - s0) * u, t = t0 + (t1 - t0) * u;
        const [x, z] = at(s + ns * 0.05, t + nt * 0.05);
        const open = insideOther(r, x, z) || onOpening(...at(s, t));
        if (open) flush(k);
        else if (run == null) run = k;
      }
      flush(n);
    }
  }
  return out;
}

// 通路の床の形: 区間ごとの長方形と、曲がり角の外側のくさび（凸多角形。長方形とくさびは重なってよい）
// → [{ poly, seg, kind: 'rect' | 'joint', u0, u1, at, along, len }]
export function corridorPieces(c) {
  const out = [], h = c.w / 2, P = c.pts, n = P.length;
  for (let i = 0; i + 1 < n; i++) {
    const [ax, az] = P[i], [bx, bz] = P[i + 1], len = Math.hypot(bx - ax, bz - az), ux = (bx - ax) / len, uz = (bz - az) / len;
    const at = (u, v) => [ax + ux * u - uz * h * v, az + uz * u + ux * h * v];
    const along = (x, z) => (x - ax) * ux + (z - az) * uz;
    out.push({ seg: i, kind: 'rect', at, along, len, ux, uz, poly: [at(0, -1), at(len, -1), at(len, 1), at(0, 1)] });
  }
  for (let j = 1; j + 1 < n; j++) {
    const a = out[j - 1], b = out[j], [px, pz] = P[j];
    const cross = a.ux * b.uz - a.uz * b.ux;
    if (Math.abs(cross) < 1e-6) continue;
    const sg = cross > 0 ? -1 : 1; // 外側（左右）
    const n1 = [-a.uz * sg, a.ux * sg], n2 = [-b.uz * sg, b.ux * sg];
    const mx = n1[0] + n2[0], mz = n1[1] + n2[1], ml = Math.hypot(mx, mz) || 1, k = 1 / Math.max(0.5, (mx * n1[0] + mz * n1[1]) / ml);
    out.push({ seg: j, kind: 'joint', poly: [[px, pz], [px + n1[0] * h, pz + n1[1] * h], [px + (mx / ml) * h * k, pz + (mz / ml) * h * k], [px + n2[0] * h, pz + n2[1] * h]] });
  }
  return out;
}

function addCorridorNav(nav, c) {
  const { L, R } = offsetPolyline(c.pts, c.w);
  const prof = corridorProfile(c);
  const n = c.pts.length;
  for (const pc of corridorPieces(c)) {
    if (pc.kind === 'joint' || pc.seg !== prof.segment) {
      nav.addRegion(pc.poly, pc.kind === 'joint' && pc.seg === n - 1 ? c.yBot : c.yTop, { kind: 'corridor' });
      continue;
    }
    // 最後の区間: 平ら → 階段（か坂） → 平ら
    const { at, along, len } = pc;
    if (prof.ramp) {
      nav.addRegion(pc.poly, (x, z) => c.yTop + ((c.yBot - c.yTop) * Math.max(0, Math.min(1, along(x, z) / len))), { kind: 'corridor' });
    } else {
      const u0 = prof.flat0, u1 = u0 + prof.run;
      nav.addRegion([at(0, -1), at(u0, -1), at(u0, 1), at(0, 1)], c.yTop, { kind: 'corridor' });
      nav.addRegion([at(u0, -1), at(u1, -1), at(u1, 1), at(u0, 1)], (x, z) => flightHeight(along(x, z) - u0, prof.run, c.yTop, c.yBot, c.stair.n, c.stair.flights), { kind: 'stairs', corridor: true });
      nav.addRegion([at(u1, -1), at(len, -1), at(len, 1), at(u1, 1)], c.yBot, { kind: 'corridor' });
    }
  }
  for (let i = 0; i + 1 < n; i++) {
    if (i !== prof.segment || prof.ramp) {
      const [y0, y1] = i === prof.segment ? [Math.min(c.yTop, c.yBot) - 0.2, Math.max(c.yTop, c.yBot) + CORR_H] : [c.yTop - 0.2, c.yTop + CORR_H];
      nav.addWall(L[i][0], L[i][1], L[i + 1][0], L[i + 1][1], y0, y1);
      nav.addWall(R[i][0], R[i][1], R[i + 1][0], R[i + 1][1], y0, y1);
      continue;
    }
    // 階段の区間の壁: 1 m ごとに、その所の床の高さから天井まで（ほかの通路が上や下を通れる）
    const yAt = (u) => (u <= prof.flat0 ? c.yTop : u >= prof.flat0 + prof.run ? c.yBot : flightHeight(u - prof.flat0, prof.run, c.yTop, c.yBot, c.stair.n, c.stair.flights));
    const pc = corridorPieces(c).find((q) => q.kind === 'rect' && q.seg === i);
    for (const [A, B] of [[L[i], L[i + 1]], [R[i], R[i + 1]]]) {
      const len = Math.hypot(B[0] - A[0], B[1] - A[1]), m = Math.max(1, Math.ceil(len));
      for (let k = 0; k < m; k++) {
        const p0 = [A[0] + ((B[0] - A[0]) * k) / m, A[1] + ((B[1] - A[1]) * k) / m], p1 = [A[0] + ((B[0] - A[0]) * (k + 1)) / m, A[1] + ((B[1] - A[1]) * (k + 1)) / m];
        const ua = pc.along(...p0), ub = pc.along(...p1);
        const ya = yAt(Math.max(0, ua)), yb = yAt(Math.min(pc.len, ub));
        nav.addWall(p0[0], p0[1], p1[0], p1[1], Math.min(ya, yb) - 0.2, Math.max(ya, yb) + CORR_H);
      }
    }
  }
}

// 地上の出入口の吹き抜け: 階段（とエスカレーター）と下の踊り場。world/metro.js の buildMetroEntrances と同じ寸法
const PIT_LANDING = 2.4, PIT_ESC_W = 1.25;
export function addPitNav(nav, e, closed = false) {
  if (e.rim == null) return;
  const d = entranceDoor(e);
  const f = entranceFrame(e), L = e.len / 2, W = e.wid / 2;
  const y0 = rimAt(e, -L, 0), yb = d.yb;
  const run = Math.max(2, e.len - PIT_LANDING), drop = y0 - yb, n = Math.max(4, Math.round(drop / 0.16));
  const esc = (e.esc ?? e.wid >= 4.2) && e.wid >= 3.4;
  const seed = Math.round(e.x * 3 + e.z * 7);
  const vs = esc ? (hash01(seed, 1) < 0.5 ? 1 : -1) : 0;
  const sv0 = esc && vs < 0 ? -W + PIT_ESC_W + 0.15 : -W, sv1 = esc && vs > 0 ? W - PIT_ESC_W - 0.15 : W;
  const P = (u, v) => f.at(u, v);
  const uOf = (x, z) => (x - e.x) * f.dx + (z - e.z) * f.dz;
  nav.addRegion([P(-L, sv0), P(-L + run, sv0), P(-L + run, sv1), P(-L, sv1)], (x, z) => stairHeight(uOf(x, z), -L, -L + run, y0, yb, n), { kind: 'stairs', pit: e });
  nav.addRegion([P(-L + run, -W), P(L, -W), P(L, W), P(-L + run, W)], yb, { kind: 'landing', pit: e });
  if (esc) {
    const e0 = vs > 0 ? W - PIT_ESC_W : -W, e1 = e0 + PIT_ESC_W;
    const r = nav.addRegion([P(-L, e0), P(-L + run, e0), P(-L + run, e1), P(-L, e1)], (x, z) => y0 - 0.05 + ((yb - y0 + 0.05) * Math.max(0, Math.min(1, (uOf(x, z) + L) / run))), { kind: 'escalator', pit: e });
    r.conveyor = [-f.dx * ESC_SPEED, -f.dz * ESC_SPEED];
    const vB = vs > 0 ? e0 : e1; // 階段の側の欄干
    const [a, b] = [P(-L, vB), P(-L + run, vB)];
    nav.addWall(a[0], a[1], b[0], b[1], yb - 0.2, y0 + 1.0);
  }
  // 吹き抜けの横の壁（地上の腰壁から踊り場まで）と上の端の下（ホールの中の吹き抜けで、階段の下に入らない）、下の端の壁（扉の両脇）
  for (const v of [-W, W]) {
    const [a, b] = [P(-L - 0.3, v), P(L, v)];
    nav.addWall(a[0], a[1], b[0], b[1], yb - 0.6, Math.max(y0, rimAt(e, L, v)) + 1.2);
  }
  {
    const [a, b] = [P(-L, -W), P(-L, W)];
    nav.addWall(a[0], a[1], b[0], b[1], yb - 0.6, y0 - 1.6);
  }
  for (const [v0, v1] of closed ? [[-W, W]] : [[-W, -d.dw], [d.dw, W]]) {
    const [a, b] = [P(L, v0), P(L, v1)];
    nav.addWall(a[0], a[1], b[0], b[1], yb - 0.6, rimAt(e, L, 0) + 1.2);
  }
}

export { pitInfo };
