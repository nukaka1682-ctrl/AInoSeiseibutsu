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
export function quaySegments(chains, roads = [], { minLen = 6, taper = 6, crossSin = 0.2, skip = null } = {}) {
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
  for (const { pts, solid, spec } of chains) {
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
        if (r.under && spec?.bridge) return; // 高架の下の擁壁
        if (r.under) {
          const lim = r.half + 1;
          if (closestOnSegment(mx, mz, r.ax, r.az, r.bx, r.bz).d2 < lim * lim || closestOnSegment(a.x, a.z, r.ax, r.az, r.bx, r.bz).d2 < lim * lim) cut[i] = 1;
          return;
        }
        // 小道の幅の中に入る壁（寄せきれなかった所）は立てない（道筋どおりに走る自転車をふさがない）
        if (solid && !r.car) return; // 写真で決めた岸壁は、小道では切らない（横切る小道は snapPathsToQuays が切り離す）
        if (!r.car && !r.steps && closestOnSegment(mx, mz, r.ax, r.az, r.bx, r.bz).d2 < (r.half + 0.9) ** 2) cut[i] = 1;
        const c = crossing(a.x, a.z, b.x, b.z, r.ax, r.az, r.bx, r.bz);
        if (!c) return;
        // 小道がごく浅く交わる所（sin < crossSin）は切らない（線のずれの残り。ふつうは snapPathsToQuays が先に寄せてある）
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
        const e = (s) => (solid && !spec?.taper ? 1 : Math.min(1, (s - s0) / taper, (s1 - s) / taper));
        for (let k = i; k <= j; k++) {
          const a = pts[k], b = pts[k + 1], L = S[k + 1] - S[k];
          if (L < 1e-6) continue;
          out.push({
            ax: a.x, az: a.z, bx: b.x, bz: b.z, nx: -(b.z - a.z) / L, nz: (b.x - a.x) / L,
            at: a.top, bt: b.top, ab: a.bot, bb: b.bot, ea: Math.max(0, e(S[k])), eb: Math.max(0, e(S[k + 1])), wet: a.wet && b.wet, stone: !!spec?.stone, plain: !!spec?.plain,
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
export function snapPathsToQuays(roads, chains, { band = 3.5, minRun = 6, step = 2.5, gap = 1.2 } = {}) {
  if (!chains.length) return 0;
  const grid = new Grid(20), segs = [];
  chains.forEach(({ pts }, chain) => {
    for (let i = 0; i + 1 < pts.length; i++) {
      const a = pts[i], b = pts[i + 1], L = Math.hypot(b.x - a.x, b.z - a.z);
      if (L < 1e-6) continue;
      grid.insertSegment(a.x, a.z, b.x, b.z, segs.length);
      segs.push({ ax: a.x, az: a.z, bx: b.x, bz: b.z, tx: (b.x - a.x) / L, tz: (b.z - a.z) / L, chain, solid: !!chains[chain].solid });
    }
  });
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
  // 0. 同じ壁の線を 2 回横切る小道（壁の向こうへ出てまた戻る）: 2.2 m 以上の垂直の壁は通れないので、線のずれ。あいだの部分を
  //    元の側へ戻す（壁から幅の半分 + gap m）。1 回だけ横切る所は本当の出入り（壁の切れ目・坂）として残す
  for (const r of roads) {
    if (DRIVE(r) || r.bridge || r.tunnel || (r.layer || 0) !== 0 || r.type === 'steps' || !r.pts || r.pts.length < 2) continue;
    const S = [0];
    for (let i = 0; i + 1 < r.pts.length; i++) S.push(S[i] + Math.hypot(r.pts[i + 1][0] - r.pts[i][0], r.pts[i + 1][1] - r.pts[i][1]));
    const xs = [];
    for (let i = 0; i + 1 < r.pts.length; i++) {
      const [ax, az] = r.pts[i], [bx, bz] = r.pts[i + 1], seen = new Set();
      grid.query(Math.min(ax, bx), Math.min(az, bz), Math.max(ax, bx), Math.max(az, bz), (k) => {
        if (seen.has(k)) return;
        seen.add(k);
        const q = segs[k], c = crossing(ax, az, bx, bz, q.ax, q.az, q.bx, q.bz);
        if (!c) return;
        // 横切る前にいた側（下の段の側が正）
        const side = Math.sign((ax - c.x) * -q.tz + (az - c.z) * q.tx) || 1;
        xs.push({ s: S[i] + c.t * (S[i + 1] - S[i]), chain: q.chain, side });
      });
    }
    if (xs.length < 2) continue;
    xs.sort((a, b) => a.s - b.s);
    const spans = [];
    for (let k = 0; k + 1 < xs.length; k++) {
      if (xs[k].chain !== xs[k + 1].chain || xs[k + 1].s - xs[k].s > 80) continue;
      spans.push([xs[k].s, xs[k + 1].s, xs[k].chain, xs[k].side]);
      k++;
    }
    if (!spans.length) continue;
    const keep = (r.width || 2.5) / 2 + gap;
    const onChain = (x, z, chain) => {
      let best = null;
      grid.queryPoint(x, z, 15, (k) => {
        const q = segs[k];
        if (q.chain !== chain) return;
        const c = closestOnSegment(x, z, q.ax, q.az, q.bx, q.bz);
        if (!best || c.d2 < best.d2) best = { d2: c.d2, x: c.x, z: c.z, nx: -q.tz, nz: q.tx };
      });
      return best;
    };
    const pts = [], ids = [];
    for (let i = 0; i < r.pts.length; i++) {
      const sp = spans.find(([a, b]) => S[i] > a && S[i] < b);
      let p = r.pts[i], id = r.nodeIds?.[i];
      if (sp && !(id != null && carNodes.has(id))) {
        const c = onChain(p[0], p[1], sp[2]);
        if (c) {
          p = [c.x + c.nx * sp[3] * keep, c.z + c.nz * sp[3] * keep];
          if (id != null && !moved.has(id)) moved.set(id, p);
        }
      }
      pts.push(p);
      ids.push(id);
      if (i + 1 === r.pts.length) break;
      // 区間にかかる辺には step m ごとに点を足す（壁の反対側へ戻した点）
      const [ax, az] = r.pts[i], [bx, bz] = r.pts[i + 1], L = S[i + 1] - S[i], n = Math.ceil(L / step);
      for (let j = 1; j < n; j++) {
        const sj = S[i] + (L * j) / n, sq = spans.find(([a, b]) => sj > a && sj < b);
        if (!sq) continue;
        const c = onChain(ax + ((bx - ax) * j) / n, az + ((bz - az) * j) / n, sq[2]);
        if (!c) continue;
        pts.push([c.x + c.nx * sq[3] * keep, c.z + c.nz * sq[3] * keep]);
        ids.push(`u${r.id}_${i}_${j}`);
      }
    }
    r.pts = pts;
    if (r.nodeIds) r.nodeIds = ids;
    count++;
  }
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
  // 写真で決めた岸壁（solid）をまだ横切っている小道・階段は、横切る辺で 2 本に切り離す（垂直の壁は通れない。地図の線の
  // ずれか、モデルにない階段。道筋はほかの坂へ回る）
  const extra = [];
  for (const r of roads) {
    if (DRIVE(r) || r.bridge || r.tunnel || !r.pts || r.pts.length < 2) continue;
    const cutAt = [];
    for (let i = 0; i + 1 < r.pts.length; i++) {
      const [ax, az] = r.pts[i], [bx, bz] = r.pts[i + 1];
      let hit = false;
      grid.query(Math.min(ax, bx), Math.min(az, bz), Math.max(ax, bx), Math.max(az, bz), (k) => {
        if (!hit && segs[k].solid && crossing(ax, az, bx, bz, segs[k].ax, segs[k].az, segs[k].bx, segs[k].bz)) hit = true;
      });
      if (hit) cutAt.push(i);
    }
    if (!cutAt.length) continue;
    const parts = [];
    let from = 0;
    for (const i of cutAt) {
      parts.push([from, i]);
      from = i + 1;
    }
    parts.push([from, r.pts.length - 1]);
    const keepParts = parts.filter(([a, b]) => b - a >= 1);
    const all = r.pts, ids = r.nodeIds;
    if (!keepParts.length) {
      r.pts = [all[0], all[0]];
      r.dead = true;
      continue;
    }
    keepParts.forEach(([a, b], j) => {
      const t = j ? { ...r, id: `${r.id}_s${j}` } : r;
      t.pts = all.slice(a, b + 1);
      if (ids) t.nodeIds = ids.slice(a, b + 1);
      if (j) extra.push(t);
    });
    count++;
  }
  for (let i = roads.length - 1; i >= 0; i--) if (roads[i].dead) roads.splice(i, 1);
  roads.push(...extra);
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

// ---------------------------------------------------------------- 写真で決める岸壁
// 見た目を本物にするため、地形モデルより写真を優先して手で決めた岸壁（利用者の方針）。
// ドラード河岸（利用者の写真 NCM_0109: ポン・ヌフから北を見る）: ポン・ヌフのたもとからドラード広場の入り江の角まで、
// 高いレンガの岸壁がまっすぐ一続きに立ち、上の河岸の縁にプラタナスの並木と手すり壁、足元に平らな遊歩道（壁際は舗装、
// 水際は芝の帯）。地形モデルではポン・ヌフ寄りが坂と段の重なりで、壁が切れ切れ・地面が波打っていた。
// line: 壁の線 [緯度, 経度]（上の段を左に見る向き）。top: 両端の上の段の標高、bottom: 下の段の標高（m）。
// front: 壁の前、この距離まで下の段の高さに平らにする。back: 壁の裏、この距離まで上の段の高さにそろえる
export const MANUAL_QUAYS = [
  // lawn: 水際の芝の帯 [線の上の始まり・終わり（0〜1）, 壁からの距離の内側・外側 m]
  { id: 'daurade', line: [[43.600929, 1.4391], [43.599725, 1.440309]], top: [142.25, 144.4], bottom: 133.7, front: 30, back: 7, lawn: [0.3, 0.93, 6, 10.5] },
  // トゥニ河岸（ポン・ヌフの南。0.5 m の地形モデルの壁の線をまっすぐな折れ線で）: 川沿いの堤のレンガの壁と、水際の細い下の段。
  // 地形モデルからなぞった線は切れ切れで、壁の切れ端と波打つ斜面になっていた。top・bottom なし: 上は壁の裏の地面、
  // 下は水面 + low m（fillManualHeights）
  // Purpan の A620 の高架の下（利用者の指摘とストリートビュー 225619・航空写真・0.5 m の地形モデル）: Avenue de Grande-Bretagne は
  // 高速道路の盛り土を、両側が垂直のコンクリートの擁壁の切り通しで平らにくぐる。地形モデルは高架の下を補間するので、
  // 道が盛り土に埋まって波打ち、高架と地面がひと続きの丘になっていた。2 本の擁壁の線（向かい合う）のあいだを道の高さに平らにする。
  // low: 'ground' = 下の段は壁の前の地面のいちばん低い所の高さ。bridge: 橋の下でも壁を立てる。stone: 淡い石・コンクリートの壁。
  // taper: 両端は段の高さをすぼめる（盛り土の斜面へつながる）。plain: 壁の前を河岸の石の板の舗装にしない
  { id: 'a620-nord', line: [[43.605438, 1.403276], [43.604897, 1.404291]], low: 'ground', front: 21, back: 12, bridge: true, stone: true, taper: true, plain: true },
  { id: 'a620-sud', line: [[43.604692, 1.404306], [43.605222, 1.402993]], low: 'ground', front: 21, back: 12, bridge: true, stone: true, taper: true, plain: true },
  // 北の端はガロネットの口（昔の川の支流）: 河岸の道は橋（Pont du Halage de Tounis）で口を渡るが、地図では地面の道で、
  // 8 m 下の谷へ落ち込んでいた。壁を口の前もまっすぐ通し、壁の裏 13 m（道の幅）を河岸の高さまで埋める（raiseRoads: 車道の下も）。
  // topWin: 上の段の高さを前後 ±35 m の高い方（上から 1/4 の値）で決める（谷の所でも両側の河岸の高さ）
  { id: 'tounis', line: [[43.599452, 1.4404], [43.598966, 1.440368], [43.598734, 1.440304], [43.598224, 1.44016], [43.597714, 1.440096], [43.597251, 1.440144], [43.596556, 1.440224], [43.59586, 1.440304], [43.595513, 1.440352]], low: 1.0, front: 12, back: 13, raiseRoads: true, topWin: 14 },
];

// 手で決めた岸壁をローカル座標の折れ線にする（quayChains と同じ形。solid: 小道では切らない・端をすぼめない）
export function manualChains(proj, step = 2.5) {
  return MANUAL_QUAYS.map((m) => {
    const P = m.line.map((ll) => proj.project(...ll));
    let total = 0;
    for (let i = 0; i + 1 < P.length; i++) total += Math.hypot(P[i + 1][0] - P[i][0], P[i + 1][1] - P[i][1]);
    const pts = [];
    let s = 0;
    for (let i = 0; i + 1 < P.length; i++) {
      const [ax, az] = P[i], [bx, bz] = P[i + 1], L = Math.hypot(bx - ax, bz - az), n = Math.max(1, Math.ceil(L / step));
      for (let j = i ? 1 : 0; j <= n; j++) {
        const t = (s + (L * j) / n) / total;
        pts.push({ x: ax + ((bx - ax) * j) / n, z: az + ((bz - az) * j) / n, top: m.top ? m.top[0] + (m.top[1] - m.top[0]) * t - DATUM : NaN, bot: m.bottom != null ? m.bottom - DATUM : NaN, wet: false });
      }
      s += L;
    }
    return { pts, solid: true, spec: m };
  });
}

// 点 (x, z) が、手で決めた岸壁の線のそば（線の両端より内側で、前 front + 2 m・裏 back m 以内）か。
// 地形モデルからなぞった線のうち、ここに入る部分は使わない
export function nearManualQuay(chains, x, z) {
  for (const { pts, spec } of chains) {
    const a = pts[0], b = pts[pts.length - 1], dx = b.x - a.x, dz = b.z - a.z, L2 = dx * dx + dz * dz;
    const t = ((x - a.x) * dx + (z - a.z) * dz) / L2;
    if (t < 0.01 || t > 0.99) continue;
    const L = Math.sqrt(L2), d = ((x - a.x) * -dz + (z - a.z) * dx) / L; // 下の段の側が正
    if (d < spec.front + 2 && d > -spec.back) return true;
  }
  return false;
}

// 高さを決めていない手書きの岸壁の点の高さを地形から決める: 上は壁の裏 6〜10 m の地面の中央値（線に沿って ±15 m でならす）、
// 下は水面 + low m。地形を書き直す前（flattenManualQuays の前）に呼ぶ
export function fillManualHeights(terrain, chains) {
  for (const { pts, spec } of chains) {
    if (spec.top && spec.bottom != null) continue;
    const raw = pts.map((p, i) => {
      const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)], L = Math.hypot(b.x - a.x, b.z - a.z) || 1;
      const nx = -(b.z - a.z) / L, nz = (b.x - a.x) / L; // 下の段へ
      const hs = [6, 8, 10].map((d) => terrain.h(p.x - nx * d, p.z - nz * d)).sort((u, v) => u - v);
      const bot = spec.low === 'ground' ? terrain.h(p.x + nx * spec.front * 0.5, p.z + nz * spec.front * 0.5) : terrain.waterLevel(p.x + nx * 8, p.z + nz * 8) + (spec.low ?? 1);
      return { top: hs[1], bot };
    });
    if (spec.low === 'ground') {
      // 壁の前の地面のいちばん低い所（下から 2 割の値）にそろえる（橋の下は地形モデルが盛り上がっている）
      const sorted = raw.map((r) => r.bot).sort((u, v) => u - v), flat = sorted[Math.floor(sorted.length * 0.2)];
      for (const r of raw) r.bot = flat;
    }
    const win = spec.topWin || 6; // ±6 点（約 15 m）
    const tops = pts.map((p, i) => {
      let st = 0, sb = 0, n = 0;
      const list = [];
      for (let j = Math.max(0, i - win); j <= Math.min(pts.length - 1, i + win); j++) {
        st += raw[j].top;
        sb += raw[j].bot;
        list.push(raw[j].top);
        n++;
      }
      list.sort((u, v) => u - v);
      if (spec.bottom == null) p.bot = sb / n;
      return spec.topWin ? list[Math.floor((list.length - 1) * 0.75)] : st / n;
    });
    // topWin のときは、選んだ高さをもう一度ならす（段にならないように）
    pts.forEach((p, i) => {
      if (spec.top) return;
      if (!spec.topWin) {
        p.top = tops[i];
        return;
      }
      let s2 = 0, n = 0;
      for (let j = Math.max(0, i - 6); j <= Math.min(pts.length - 1, i + 6); j++) {
        s2 += tops[j];
        n++;
      }
      p.top = s2 / n;
    });
  }
}

// 手で決めた岸壁のまわりの地形の格子を書き直す: 壁の前（水の上を除く）は下の段の高さに平らに、壁の裏は上の段の高さまで上げる
// （車道の芯 keep(k) = false の点は上げない）。terrain.setCliffs の前に呼ぶ
export function flattenManualQuays(terrain, chains, inWater = () => false, keep = null) {
  const g = terrain.near, D = g.data;
  for (const { pts, spec } of chains) {
    const R = Math.max(spec.front, spec.back) + 1;
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    for (const p of pts) {
      x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x);
      z0 = Math.min(z0, p.z); z1 = Math.max(z1, p.z);
    }
    const c0 = Math.max(0, Math.floor(g.ax * (x0 - R) + g.bx)), c1 = Math.min(g.cols - 1, Math.ceil(g.ax * (x1 + R) + g.bx));
    const r0 = Math.max(0, Math.floor(g.az * (z0 - R) + g.bz)), r1 = Math.min(g.rows - 1, Math.ceil(g.az * (z1 + R) + g.bz));
    for (let r = r0; r <= r1; r++) {
      const z = (r - g.bz) / g.az;
      for (let c = c0; c <= c1; c++) {
        const x = (c - g.bx) / g.ax, k = r * g.cols + c;
        if (Number.isNaN(D[k])) continue;
        let best = null;
        for (let i = 0; i + 1 < pts.length; i++) {
          const a = pts[i], b = pts[i + 1], cs = closestOnSegment(x, z, a.x, a.z, b.x, b.z);
          if (!best || cs.d2 < best.d2) best = { d2: cs.d2, i, t: cs.t, x: cs.x, z: cs.z };
        }
        const a = pts[best.i], b = pts[best.i + 1], L = Math.hypot(b.x - a.x, b.z - a.z) || 1;
        // 線の両端の先は触らない
        if ((best.i === 0 && best.t <= 0) || (best.i === pts.length - 2 && best.t >= 1)) continue;
        const d = ((x - best.x) * -(b.z - a.z) + (z - best.z) * (b.x - a.x)) / L;
        const top = a.top + (b.top - a.top) * best.t + DATUM, bot = a.bot + (b.bot - a.bot) * best.t + DATUM;
        if (d > 0 && d < spec.front) {
          if (!inWater(x, z)) D[k] = bot;
        } else if (d <= 0 && d > -spec.back && (spec.raiseRoads || !keep || keep(k))) D[k] = Math.max(D[k], top);
      }
    }
  }
}

// 手で決めた岸壁の足元の芝の帯の外形（[[x, z]…] の輪の一覧）
export function manualLawns(proj) {
  const out = [];
  for (const { pts, spec } of manualChains(proj, 6)) {
    if (!spec.lawn) continue;
    const [t0, t1, d0, d1] = spec.lawn, a = pts[0], b = pts[pts.length - 1], dx = b.x - a.x, dz = b.z - a.z, L = Math.hypot(dx, dz);
    const nx = -dz / L, nz = dx / L, at = (t, d) => [a.x + dx * t + nx * d, a.z + dz * t + nz * d];
    const n = Math.max(1, Math.ceil(((t1 - t0) * L) / 8)), inner = [], outer = [];
    for (let i = 0; i <= n; i++) {
      const t = t0 + ((t1 - t0) * i) / n;
      inner.push(at(t, d0));
      outer.push(at(t, d1));
    }
    out.push([...inner, ...outer.reverse()]);
  }
  return out;
}
