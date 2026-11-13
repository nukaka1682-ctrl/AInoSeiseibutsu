// 走るもの（ほかの自転車乗り・トラム）の計算のうち、three.js にも DOM にも依らない部分。
// Node の単体テストから使う。描画と街のデータを見る部分は traffic.js。
// 座標は x = 東、z = 南。線（path）は { pts: [[x, z], ...], cum: 始点からの道のり, length }。
import { closestOnSegment } from '../geo.js';

// ---------------------------------------------------------------- 線
export function makePath(pts) {
  const cum = new Float64Array(pts.length);
  for (let i = 1; i < pts.length; i++) cum[i] = cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  return { pts, cum, length: cum[pts.length - 1] || 0 };
}

// 道のり s の点と、線の向き（単位ベクトル dx, dz。始点 → 終点の向き）。s は線の両端で止める。out は使い回してよい
export function pointAlong(path, s, out = {}) {
  const { pts, cum } = path, n = pts.length;
  s = s < 0 ? 0 : s > path.length ? path.length : s;
  // 二分探索で cum[i] <= s <= cum[i + 1] の i
  let lo = 0, hi = n - 2;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (cum[mid] <= s) lo = mid;
    else hi = mid - 1;
  }
  const i = Math.max(0, lo), a = pts[i], b = pts[Math.min(n - 1, i + 1)];
  const L = cum[i + 1] - cum[i] || 0, k = L > 1e-9 ? (s - cum[i]) / L : 0;
  const dx = b[0] - a[0], dz = b[1] - a[1], d = Math.hypot(dx, dz) || 1;
  out.x = a[0] + dx * k;
  out.z = a[1] + dz * k;
  out.dx = dx / d;
  out.dz = dz / d;
  out.i = i;
  return out;
}

// (x, z) から、線の道のり s0〜s1 の部分までのいちばん近い距離 d と、その点の道のり s
export function nearOnPath(path, s0, s1, x, z) {
  const { pts, cum } = path;
  if (s0 > s1) [s0, s1] = [s1, s0];
  let best = { d: Infinity, s: s0 };
  for (let i = 0; i + 1 < pts.length; i++) {
    if (cum[i + 1] < s0 || cum[i] > s1) continue;
    const L = cum[i + 1] - cum[i];
    if (L < 1e-9) continue;
    // 範囲の端で切った部分だけを見る
    const t0 = Math.max(0, (s0 - cum[i]) / L), t1 = Math.min(1, (s1 - cum[i]) / L);
    const a = pts[i], b = pts[i + 1], dx = b[0] - a[0], dz = b[1] - a[1];
    const c = closestOnSegment(x, z, a[0] + dx * t0, a[1] + dz * t0, a[0] + dx * t1, a[1] + dz * t1);
    const d = Math.sqrt(c.d2);
    if (d < best.d) best = { d, s: cum[i] + L * (t0 + (t1 - t0) * c.t) };
  }
  return best;
}

// ---------------------------------------------------------------- トラムの線路
const MAX_BEND = (120 * Math.PI) / 180; // これより折り返す向きにはつながない（同じ線路の上下線どうしなど）

// 線路の way（{ pts, bridge }。1 本の線路 = 1 つの way）を、端どうしが join m 以内のものでつないで長い線にする。
// 向きが逆の way も逆順にしてつなぐ。3 本以上が集まる所（分岐）では、曲がりのいちばん小さい way へ。
// 戻り値: [{ pts, bridge（橋の way を含む）, segBridge（区間 pts[i] → pts[i + 1] ごとに、橋の way か）}]（長い順）
export function chainRails(rails, join = 3) {
  const plen = (p) => {
    let L = 0;
    for (let i = 1; i < p.length; i++) L += Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1]);
    return L;
  };
  const ways = rails.filter((r) => r.pts?.length >= 2).map((r) => ({ pts: r.pts, bridge: !!r.bridge, used: false, L: plen(r.pts) }));
  const order = ways.slice().sort((a, b) => b.L - a.L);
  const out = [];
  // chain の終わりに、つながる way を足していく
  const extend = (chain) => {
    for (;;) {
      const e = chain.pts[chain.pts.length - 1], p = chain.pts[chain.pts.length - 2];
      const ex = e[0] - p[0], ez = e[1] - p[1], el = Math.hypot(ex, ez) || 1;
      let best = null;
      for (const w of ways) {
        if (w.used) continue;
        for (const rev of [false, true]) {
          const q = rev ? w.pts[w.pts.length - 1] : w.pts[0];
          if (Math.hypot(q[0] - e[0], q[1] - e[1]) > join) continue;
          const q2 = rev ? w.pts[w.pts.length - 2] : w.pts[1];
          const nx = q2[0] - q[0], nz = q2[1] - q[1], nl = Math.hypot(nx, nz) || 1;
          const bend = Math.acos(Math.max(-1, Math.min(1, (ex * nx + ez * nz) / (el * nl))));
          if (bend > MAX_BEND) continue;
          if (!best || bend < best.bend) best = { w, rev, bend };
        }
      }
      if (!best) return;
      best.w.used = true;
      const add = best.rev ? best.w.pts.slice().reverse() : best.w.pts;
      const first = add[0];
      const skip = Math.hypot(first[0] - e[0], first[1] - e[1]) < 0.5 ? 1 : 0; // 同じ点は 2 度入れない
      for (let i = skip; i < add.length; i++) {
        chain.pts.push(add[i]);
        chain.segBridge.push(best.w.bridge);
      }
      chain.bridge ||= best.w.bridge;
    }
  };
  for (const seed of order) {
    if (seed.used) continue;
    seed.used = true;
    const chain = { pts: seed.pts.slice(), bridge: seed.bridge, segBridge: new Array(seed.pts.length - 1).fill(seed.bridge) };
    extend(chain);
    chain.pts.reverse();
    chain.segBridge.reverse();
    extend(chain);
    out.push(chain);
  }
  return out.sort((a, b) => plen(b.pts) - plen(a.pts));
}

// 停留所の位置（線の始点からの道のり）: every m ごと。線の終わりから margin m より手前だけ（終わりは終点で止まる）
export function stopsAlong(length, every = 450, margin = 60) {
  const out = [];
  for (let s = every; s <= length - margin; s += every) out.push(s);
  return out;
}

// トラムの速さ: 止まる所まで dist m のとき、加速度 acc で止まれる速さ（と vmax）を超えないように。
// 遅ければ acc で加速し、速すぎれば brake（m/s²）までで減速する
export function tramSpeed(v, dist, vmax, dt, acc = 0.9, brake = 3) {
  const cap = Math.min(vmax, Math.sqrt(2 * acc * Math.max(0, dist)));
  if (v < cap) return Math.min(cap, v + acc * dt);
  return Math.max(cap, v - brake * dt);
}

// ---------------------------------------------------------------- 自転車乗り
// 走る所: 進む向きの右側。車道の端から 0.9 m 内側（中心線から 幅/2 − 0.9 m）。幅 3.6 m 未満の道と自転車道は中心線から 0.5 m
export function laneOffset(road) {
  if (road.type === 'cycleway' || !(road.width >= 3.6)) return 0.5;
  return road.width / 2 - 0.9;
}

// 坂: 上り 5 % で 0.7 倍（直線で、0.5 倍まで）、下りは 1.25 倍まで
export function slopeFactor(grade) {
  if (grade > 0) return Math.max(0.5, 1 - 6 * grade);
  return Math.min(1.25, 1 - 5 * grade);
}

// 交差点で次の区間を選ぶ。seg: RoadNetwork の区間（ia → ib）、dir: +1 なら ia → ib へ、-1 なら逆へ進んでいる。
// net.segsAt(n): 節点 n につながる区間。ok(seg): 走ってよい区間か。
// つながる区間のうち、今の向きにいちばん近い道を 70 %、ほかを 30 % で選ぶ。行き止まりなら U ターン。
// 戻り値: { seg, dir, turn（曲がる角度 rad。U ターンは π）}
export function nextSegment(net, seg, dir, rnd, ok = () => true) {
  const n = dir > 0 ? seg.ib : seg.ia;
  let fx = seg.bx - seg.ax, fz = seg.bz - seg.az;
  const fl = Math.hypot(fx, fz) || 1;
  fx = (fx / fl) * dir;
  fz = (fz / fl) * dir;
  const cands = [];
  for (const s of net.segsAt(n)) {
    if (s === seg || !ok(s)) continue;
    const d = s.ia === n ? 1 : -1;
    let nx = s.bx - s.ax, nz = s.bz - s.az;
    const nl = Math.hypot(nx, nz) || 1;
    nx = (nx / nl) * d;
    nz = (nz / nl) * d;
    cands.push({ seg: s, dir: d, turn: Math.acos(Math.max(-1, Math.min(1, fx * nx + fz * nz))) });
  }
  if (!cands.length) return { seg, dir: -dir, turn: Math.PI };
  cands.sort((a, b) => a.turn - b.turn);
  if (cands.length === 1 || rnd() < 0.7) return cands[0];
  return cands[1 + Math.floor(rnd() * (cands.length - 1))];
}

// 脚の 2 関節の逆運動学（bike.js の updatePose と同じ式）。自転車の局所の座標（前は -z）で、
// crank: クランクの角度、side: +1 = 右脚（クランクの角度そのまま）、-1 = 左脚（半周ずれ）。
// 腿 0.46 m・すね 0.46 m。ひざは前（-z）に出す。out に hip・knee・foot の [x, y, z] を入れる
export const LEG = { thigh: 0.46, shin: 0.46, bbY: 0.3, bbZ: 0.04, crank: 0.17, hipY: 1.03, hipZ: 0.2 };
export function legIK(crank, side, out = { hip: [0, 0, 0], knee: [0, 0, 0], foot: [0, 0, 0] }) {
  const L1 = LEG.thigh, L2 = LEG.shin;
  const a = crank + (side > 0 ? 0 : Math.PI);
  const fx = 0.14 * side, fy = LEG.bbY - Math.cos(a) * LEG.crank, fz = LEG.bbZ + Math.sin(a) * LEG.crank;
  const hx = 0.1 * side, hy = LEG.hipY, hz = LEG.hipZ;
  const dy = fy - hy, dz = fz - hz;
  const D = Math.min(Math.hypot(dy, dz), L1 + L2 - 0.001);
  const base = Math.atan2(dz, dy);
  const alpha = Math.acos(Math.min(1, Math.max(-1, (L1 * L1 + D * D - L2 * L2) / (2 * L1 * D))));
  const z1 = hz + L1 * Math.sin(base + alpha), z2 = hz + L1 * Math.sin(base - alpha);
  const k = z1 < z2 ? base + alpha : base - alpha;
  out.hip[0] = hx; out.hip[1] = hy; out.hip[2] = hz;
  out.knee[0] = hx; out.knee[1] = hy + L1 * Math.cos(k); out.knee[2] = hz + L1 * Math.sin(k);
  out.foot[0] = fx; out.foot[1] = fy; out.foot[2] = fz;
  return out;
}
