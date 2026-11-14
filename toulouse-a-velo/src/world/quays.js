// 岸壁（河岸の垂直の壁）: 事前取得で 0.5 m の地形モデルから見つけた線（data/quaybake.js、地形のファイルの quays）を
// ローカル座標の壁の線分にして、道・橋の所で切る。three.js を使わない（単体テストできる）。
// 地形（terrain.js の setCliffs）は線の所で上の段と下の段に切れ、ground.js がその線にレンガの壁と手すり壁を立てる。
import { Grid, closestOnSegment } from '../geo.js';
import { CAR_ROADS } from './parse.js';
import { DATUM } from './terrain.js';

const median3 = (a, b, c) => Math.max(Math.min(a, b), Math.min(Math.max(a, b), c));

// 岸壁の線（緯度経度と標高）をローカル座標の折れ線にする。高さは前後の点との中央値でならし、step m 以下ごとに点を足す。
// 返り値: [{ pts: [{ x, z, top, bot, wet }]（上の段を左に見る向き。top・bot は y = 標高 − DATUM）}]
export function quayChains(lines, proj, step = 2.5) {
  const out = [];
  for (const line of lines || []) {
    const raw = line.pts.map(([lat, lon, top, bot, wet]) => {
      const [x, z] = proj.project(lat, lon);
      return { x, z, top: top - DATUM, bot: bot - DATUM, wet: !!wet };
    });
    if (raw.length < 2) continue;
    const sm = raw.map((p, i) => {
      const a = raw[Math.max(0, i - 1)], b = raw[Math.min(raw.length - 1, i + 1)];
      return { ...p, top: median3(a.top, p.top, b.top), bot: median3(a.bot, p.bot, b.bot) };
    });
    const pts = [sm[0]];
    for (let i = 0; i + 1 < sm.length; i++) {
      const a = sm[i], b = sm[i + 1], L = Math.hypot(b.x - a.x, b.z - a.z), n = Math.max(1, Math.ceil(L / step));
      for (let j = 1; j <= n; j++) {
        const t = j / n;
        pts.push({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t, top: a.top + (b.top - a.top) * t, bot: a.bot + (b.bot - a.bot) * t, wet: t < 0.5 ? a.wet : b.wet });
      }
    }
    out.push({ pts });
  }
  return out;
}

// 2 つの線分の交点（なければ null）。返り値 { x, z, t（AB の上の位置 0〜1）, sin（交わる角度の sin の絶対値）}
function crossing(ax, az, bx, bz, cx, cz, dx, dz) {
  const rx = bx - ax, rz = bz - az, sx = dx - cx, sz = dz - cz, den = rx * sz - rz * sx;
  if (Math.abs(den) < 1e-9) return null;
  const t = ((cx - ax) * sz - (cz - az) * sx) / den, u = ((cx - ax) * rz - (cz - az) * rx) / den;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return { x: ax + rx * t, z: az + rz * t, t, sin: Math.abs(den) / (Math.hypot(rx, rz) * Math.hypot(sx, sz)) };
}

// 壁を切る所:
// - 橋の道の幅の中（橋の下を横切る壁は、当たり判定が橋の上の自転車を止めてしまう）
// - 地面の道・トンネルの道が壁の線を横切る所（車道は幅の半分 + 1 m、小道は幅の半分 + 0.6 m。坂や階段で段を下りる道が通れるように）。
//   小道が壁に沿って浅い角度（sin が crossSin 未満）で交わる所は切らない（河岸の縁の自転車道・壁の足元の遊歩道の線のずれ）
// 残った部分のうち minLen m より短いものは捨てる。端から taper m の間は端の重み（ea・eb）を 0 から 1 へ（段の高さがすぼむ）。
// skip(x, z): true の点を含む線分も捨てる（手で決めた岸壁の近くなど）
// 返り値: 壁の線分 [{ ax, az, bx, bz, nx, nz, at, bt, ab, bb, ea, eb, wet }]（n: 下の段へ向く向き）
export function quaySegments(chains, roads = [], { minLen = 6, taper = 6, crossSin = 0.8, skip = null } = {}) {
  const grid = new Grid(25), rsegs = [];
  for (const r of roads) {
    if (!r.pts || r.pts.length < 2) continue;
    const under = !!r.bridge; // 橋の下の壁は、橋の上の自転車の当たり判定になるので作らない
    for (let i = 0; i + 1 < r.pts.length; i++) {
      grid.insertSegment(r.pts[i][0], r.pts[i][1], r.pts[i + 1][0], r.pts[i + 1][1], rsegs.length);
      rsegs.push({ ax: r.pts[i][0], az: r.pts[i][1], bx: r.pts[i + 1][0], bz: r.pts[i + 1][1], half: (r.width || 2.5) / 2, under, car: CAR_ROADS.has(r.type) || r.type === 'service' || r.type === 'living_street', steps: r.type === 'steps', tunnel: !!r.tunnel });
    }
  }
  const out = [];
  for (const { pts } of chains) {
    const n = pts.length - 1;
    if (n < 1) continue;
    const S = [0];
    for (let i = 0; i < n; i++) S.push(S[i] + Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].z - pts[i].z));
    const cut = new Uint8Array(n);
    const cutAround = (s, half) => {
      for (let i = 0; i < n; i++) if (S[i + 1] > s - half && S[i] < s + half) cut[i] = 1;
    };
    for (let i = 0; i < n; i++) {
      const a = pts[i], b = pts[i + 1], mx = (a.x + b.x) / 2, mz = (a.z + b.z) / 2;
      if (skip && (skip(a.x, a.z) || skip(b.x, b.z))) cut[i] = 1;
      const seen = new Set();
      grid.query(Math.min(a.x, b.x) - 12, Math.min(a.z, b.z) - 12, Math.max(a.x, b.x) + 12, Math.max(a.z, b.z) + 12, (k) => {
        if (seen.has(k)) return;
        seen.add(k);
        const r = rsegs[k];
        if (r.under) {
          const lim = r.half + 1;
          if (closestOnSegment(mx, mz, r.ax, r.az, r.bx, r.bz).d2 < lim * lim || closestOnSegment(a.x, a.z, r.ax, r.az, r.bx, r.bz).d2 < lim * lim) cut[i] = 1;
          return;
        }
        const c = crossing(a.x, a.z, b.x, b.z, r.ax, r.az, r.bx, r.bz);
        if (!c) return;
        // 小道（階段を除く）は、壁をはっきり横切る（sin ≥ crossSin）ときだけ切る。浅く交わるのは線のずれ（snapPathsToQuays が寄せる）
        if (!r.car && !r.steps && !r.tunnel && c.sin < crossSin) return;
        cutAround(S[i] + c.t * (S[i + 1] - S[i]), Math.min(12, (r.half + (r.car ? 1 : 0.6)) / Math.max(0.3, c.sin)));
      });
    }
    for (let i = 0; i < n; i++) {
      if (cut[i]) continue;
      let j = i;
      while (j + 1 < n && !cut[j + 1]) j++;
      const s0 = S[i], s1 = S[j + 1];
      if (s1 - s0 >= minLen) {
        const e = (s) => Math.min(1, (s - s0) / taper, (s1 - s) / taper);
        for (let k = i; k <= j; k++) {
          const a = pts[k], b = pts[k + 1], L = S[k + 1] - S[k];
          if (L < 1e-6) continue;
          out.push({
            ax: a.x, az: a.z, bx: b.x, bz: b.z, nx: -(b.z - a.z) / L, nz: (b.x - a.x) / L,
            at: a.top, bt: b.top, ab: a.bot, bb: b.bot, ea: Math.max(0, e(S[k])), eb: Math.max(0, e(S[k + 1])), wet: a.wet && b.wet,
          });
        }
      }
      i = j;
    }
  }
  return out;
}

// 岸壁に沿って走る小道（歩道・自転車道・遊歩道）を、壁のどちらか側へ寄せる。地図の小道の線は 1〜2 m ずれていて、
// 河岸の縁の自転車道・壁の足元の遊歩道が壁の線と浅い角度で何度も交わる（そのままだと道の面が壁の反対側の段に落ち、
// ナビの道筋が壁を突き抜ける）。壁から band m 以内を壁とほぼ平行（cos > 0.6）に minRun m 以上走る区間を見つけ、
// 区間の点の多い側（ほぼ壁の真上なら、区間の前後で道がいる側。分からなければ上の段）へ、壁から幅の半分 + gap m 以上
// 離す。区間には step m ごとに点を足す（足した点の nodeIds は新しい名前）。車道と共有する点は動かさない。
// roads をその場で書き換える。返り値: 寄せた区間の数
export function snapPathsToQuays(roads, chains, { band = 3.5, minRun = 6, step = 2.5, gap = 0.7 } = {}) {
  if (!chains.length) return 0;
  const grid = new Grid(20), segs = [];
  for (const { pts } of chains) {
    for (let i = 0; i + 1 < pts.length; i++) {
      const a = pts[i], b = pts[i + 1], L = Math.hypot(b.x - a.x, b.z - a.z);
      if (L < 1e-6) continue;
      grid.insertSegment(a.x, a.z, b.x, b.z, segs.length);
      segs.push({ ax: a.x, az: a.z, bx: b.x, bz: b.z, tx: (b.x - a.x) / L, tz: (b.z - a.z) / L });
    }
  }
  const DRIVE = (r) => CAR_ROADS.has(r.type) || r.type === 'service' || r.type === 'living_street' || r.type === 'motorway' || r.type === 'motorway_link';
  const carNodes = new Set();
  for (const r of roads) if (DRIVE(r) && r.nodeIds) for (const id of r.nodeIds) carNodes.add(id);
  // いちばん近い壁の線: { d（下の段の側が正）, cx, cz, nx, nz, tx, tz }
  const nearest = (x, z) => {
    let best = null;
    grid.queryPoint(x, z, band, (i) => {
      const q = segs[i], c = closestOnSegment(x, z, q.ax, q.az, q.bx, q.bz);
      if (c.d2 > band * band || (best && c.d2 >= best.d2)) return;
      const nx = -q.tz, nz = q.tx;
      best = { d2: c.d2, d: (x - c.x) * nx + (z - c.z) * nz, cx: c.x, cz: c.z, nx, nz, tx: q.tx, tz: q.tz };
    });
    return best;
  };
  const moved = new Map(); // 動かした元の点（nodeId → [x, z]）
  let count = 0;
  for (const r of roads) {
    if (DRIVE(r) || r.bridge || r.tunnel || (r.layer || 0) !== 0 || r.type === 'steps' || !r.pts || r.pts.length < 2) continue;
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    for (const [x, z] of r.pts) {
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (z < z0) z0 = z;
      if (z > z1) z1 = z;
    }
    let any = false;
    grid.query(x0 - band, z0 - band, x1 + band, z1 + band, () => (any = true));
    if (!any) continue;
    // step m ごとの点（orig: 元の点の番号）
    const S = [];
    for (let i = 0; i < r.pts.length; i++) {
      const [ax, az] = r.pts[i];
      S.push({ x: ax, z: az, orig: i });
      if (i + 1 === r.pts.length) break;
      const [bx, bz] = r.pts[i + 1], L = Math.hypot(bx - ax, bz - az), n = Math.ceil(L / step);
      for (let j = 1; j < n; j++) S.push({ x: ax + ((bx - ax) * j) / n, z: az + ((bz - az) * j) / n, orig: -1 });
    }
    let s = 0;
    S.forEach((p, i) => {
      if (i) s += Math.hypot(p.x - S[i - 1].x, p.z - S[i - 1].z);
      p.s = s;
      const a = S[Math.max(0, i - 1)], b = S[Math.min(S.length - 1, i + 1)], dl = Math.hypot(b.x - a.x, b.z - a.z) || 1;
      const w = nearest(p.x, p.z);
      p.w = w && Math.abs(((b.x - a.x) / dl) * w.tx + ((b.z - a.z) / dl) * w.tz) > 0.6 ? w : null;
    });
    const half = (r.width || 2.5) / 2, keep = half + gap;
    let changed = false;
    for (let i = 0; i < S.length; i++) {
      if (!S[i].w) continue;
      let j = i, last = i;
      while (j + 1 < S.length && (S[j + 1].w || (j + 2 < S.length && S[j + 2].w))) {
        j++;
        if (S[j].w) last = j;
      }
      j = last;
      if (S[j].s - S[i].s >= minRun) {
        let sum = 0, cnt = 0;
        for (let k = i; k <= j; k++) if (S[k].w) {
          sum += S[k].w.d;
          cnt++;
        }
        let side = sum / cnt > 0.6 ? 1 : sum / cnt < -0.6 ? -1 : 0;
        if (!side) {
          // 区間の前後の点がいる側（壁から 12 m 以内で分かれば）
          let ctx = 0;
          for (const k of [i - 1, i - 2, j + 1, j + 2]) {
            if (k < 0 || k >= S.length) continue;
            let best = null;
            grid.queryPoint(S[k].x, S[k].z, 12, (q) => {
              const g = segs[q], c = closestOnSegment(S[k].x, S[k].z, g.ax, g.az, g.bx, g.bz);
              if (!best || c.d2 < best.d2) best = { d2: c.d2, d: (S[k].x - c.x) * -g.tz + (S[k].z - c.z) * g.tx };
            });
            if (best) ctx += Math.sign(best.d);
          }
          side = ctx > 0 ? 1 : -1;
        }
        for (let k = i; k <= j; k++) {
          const p = S[k], w = p.w || nearest(p.x, p.z);
          if (!w) continue;
          const want = side * Math.max(side * w.d, keep);
          if (Math.abs(want - w.d) < 0.02) {
            p.keep = true;
            continue;
          }
          if (p.orig >= 0 && r.nodeIds && carNodes.has(r.nodeIds[p.orig])) continue; // 車道と共有する点
          p.x += w.nx * (want - w.d);
          p.z += w.nz * (want - w.d);
          p.keep = true;
          p.moved = true;
        }
        for (let k = i; k <= j; k++) if (S[k].moved || S[k].keep) changed = changed || !!S[k].moved;
        count++;
      }
      i = j;
    }
    if (!changed) continue;
    // 区間の中の足した点だけを残して、道の点を作り直す
    const pts = [], ids = [];
    S.forEach((p, i) => {
      if (p.orig < 0 && !p.keep) return;
      pts.push([p.x, p.z]);
      const id = p.orig >= 0 ? r.nodeIds?.[p.orig] : `q${r.id}_${i}`;
      ids.push(id);
      if (p.orig >= 0 && p.moved && id != null && !moved.has(id)) moved.set(id, [p.x, p.z]);
    });
    r.pts = pts;
    if (r.nodeIds) r.nodeIds = ids;
  }
  // 動かした点を共有するほかの小道の点も同じ所へ（交差点がずれないように）
  if (moved.size) {
    for (const r of roads) {
      if (!r.nodeIds || DRIVE(r)) continue;
      r.nodeIds.forEach((id, i) => {
        const m = moved.get(id);
        if (m) r.pts[i] = [m[0], m[1]];
      });
    }
  }
  return count;
}
