// ジャン・ジョレス通り（Allées Jean-Jaurès）の 2023 年の「ランブラ」（利用者の写真・Street View 212352・212441）:
// 2 本の一方通行の車道（2 車線・約 7 m）は両側の建物の前（歩道の外）を通り、そのあいだ（約 33 m）は車の通らない遊歩道。
// 遊歩道は真ん中に淡いベージュの固めた砂の道、両側（車道沿い）に幅約 6 m の植え込み（低木と若い木）。
// 地図データ（IGN）の車道は工事の前の位置（建物から約 14 m）なので、通りの軸から見て外へずらす（reshapeRoads）。
// ずらす量は通りの両端で 0 にして、交差点とのつながりを保つ。
import { closestOnSegment } from '../geo.js';

// a → b: 通りの軸（u の向き）。split: 2 本の車道のあいだの線の、軸からの横のずれ v（[u, v] の 2 点を直線で）。
// reach: この線から横に reach m 以内の道の点を動かす。shift: 線より北西（v < 線）・南東の側へずらす量（m）。
// ramp: ずらす量が 0 → 1 → 0 になる u（両端の交差点では 0）
export const RAMBLAS = {
  name: /^All[ée]es Jean[- ]Jaur[eè]s$/i,
  a: [43.605571, 1.448741],
  b: [43.609102, 1.453765],
  split: [[50, -15], [550, -3.4]],
  reach: 22,
  shift: [-5, 6],
  ramp: [30, 80, 500, 545],
  width: 7, // 車道の幅（2 車線）
  bed: 6, // 車道沿いの植え込みの幅
};

const smooth = (e0, e1, x) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

function frame(proj) {
  const A = proj.project(...RAMBLAS.a), B = proj.project(...RAMBLAS.b);
  const L = Math.hypot(B[0] - A[0], B[1] - A[1]);
  const U = [(B[0] - A[0]) / L, (B[1] - A[1]) / L], V = [-U[1], U[0]];
  const [[u0, v0], [u1, v1]] = RAMBLAS.split;
  const split = (u) => v0 + ((v1 - v0) * (u - u0)) / (u1 - u0);
  const [r0, r1, r2, r3] = RAMBLAS.ramp;
  const ramp = (u) => smooth(r0, r1, u) * (1 - smooth(r2, r3, u));
  const uv = (x, z) => [(x - A[0]) * U[0] + (z - A[1]) * U[1], (x - A[0]) * V[0] + (z - A[1]) * V[1]];
  const at = (u, v) => [A[0] + U[0] * u + V[0] * v, A[1] + U[1] * u + V[1] * v];
  return { U, V, split, ramp, uv, at };
}

// 道（parse.js の roads）の点を、遊歩道の両側の車道の新しい位置へ動かす（点の配列をその場で書き換える）。
// 通りの車道は 2 車線の幅にする
export function reshapeRoads(roads, proj) {
  const f = frame(proj);
  for (const r of roads) {
    for (const q of r.pts) {
      const [u, v] = f.uv(q[0], q[1]);
      const dv = v - f.split(u);
      if (Math.abs(dv) > RAMBLAS.reach) continue;
      const k = f.ramp(u);
      if (!k) continue;
      const s = (dv < 0 ? RAMBLAS.shift[0] : RAMBLAS.shift[1]) * k;
      q[0] += f.V[0] * s;
      q[1] += f.V[1] * s;
    }
    if (RAMBLAS.name.test(r.name || '') && !r.bridge && !r.tunnel) {
      r.width = Math.max(r.width, RAMBLAS.width);
      r.lanes = 2;
    }
  }
}

// 遊歩道の形（roads は動かしたあとの道）: ring: 遊歩道の外形（両側の車道の内側の縁石のあいだ）、
// beds: 車道沿いの植え込みの帯の中心線 2 本（北西・南東）。roads ごとに 1 回
const cache = new WeakMap();
export function ramblasLayout(roads, proj) {
  let out = cache.get(roads);
  if (out !== undefined) return out;
  const f = frame(proj);
  const segs = [];
  for (const r of roads) {
    if (!RAMBLAS.name.test(r.name || '') || r.bridge || r.tunnel) continue;
    for (let i = 0; i + 1 < r.pts.length; i++) segs.push([f.uv(...r.pts[i]), f.uv(...r.pts[i + 1])]);
  }
  const nw = [], se = [];
  const half = RAMBLAS.width / 2 + 0.4;
  for (let u = RAMBLAS.ramp[1]; u <= RAMBLAS.ramp[2] + 1e-6; u += 5) {
    const s = f.split(u);
    let lo = -Infinity, hi = Infinity;
    for (const [p, q] of segs) {
      if ((p[0] - u) * (q[0] - u) > 0 || p[0] === q[0]) continue;
      const v = p[1] + ((q[1] - p[1]) * (u - p[0])) / (q[0] - p[0]);
      if (v < s) lo = Math.max(lo, v);
      else hi = Math.min(hi, v);
    }
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi - lo < 2 * half + 2 * RAMBLAS.bed + 4) continue;
    nw.push([u, lo + half]);
    se.push([u, hi - half]);
  }
  if (nw.length < 2) {
    cache.set(roads, null);
    return null;
  }
  const ring = [...nw.map(([u, v]) => f.at(u, v)), ...[...se].reverse().map(([u, v]) => f.at(u, v))];
  const bedLine = (side, sg) => side.map(([u, v]) => f.at(u, v + (sg * RAMBLAS.bed) / 2));
  out = { ring, beds: [bedLine(nw, 1), bedLine(se, -1)], bedHalf: RAMBLAS.bed / 2 };
  cache.set(roads, out);
  return out;
}

// 点が遊歩道の植え込みの帯の中か（街の小物・木を置かない）
export function inRamblasBed(layout, x, z) {
  if (!layout) return false;
  for (const line of layout.beds) {
    for (let i = 0; i + 1 < line.length; i++) {
      if (closestOnSegment(x, z, ...line[i], ...line[i + 1]).d2 < layout.bedHalf ** 2) return true;
    }
  }
  return false;
}
