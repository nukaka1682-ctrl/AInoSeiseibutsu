// LiDAR の表面モデル（DSM）から、建物の外形の内側の「本物の屋根の形」を三角形メッシュにする。
// 外形（と中庭の穴）を境界に、内側の格子点を加えて制約付きドロネー三角形分割（poly2tri）し、
// 各頂点の高さを DSM から引く。平らな面の上の格子点は省いて三角形を減らす。
import poly2tri from 'poly2tri';
import { Earcut } from 'three/src/extras/Earcut.js';
import { closestOnSegment, pointInPolygon, signedArea } from '../geo.js';

// 外形を step m ごとに細かくする（屋根の端の高さを細かく拾うため）
function densify(ring, step) {
  const out = [];
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const n = Math.max(1, Math.round(len / step));
    for (let k = 0; k < n; k++) {
      const p = [a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n];
      p.orig = k === 0; // 元の外形の頂点
      out.push(p);
    }
  }
  return out;
}

// 各頂点で外形の内側に少し入った点（屋根の端の高さを、道路ではなく屋根の上で測るため）
function insetPoints(ring, d, inwardSign) {
  const n = ring.length;
  return ring.map((p, i) => {
    const a = ring[(i - 1 + n) % n], b = ring[(i + 1) % n];
    let nx = 0, nz = 0;
    for (const [s, t] of [[a, p], [p, b]]) {
      const dx = t[0] - s[0], dz = t[1] - s[1];
      const l = Math.hypot(dx, dz) || 1;
      nx += (-dz / l) * inwardSign;
      nz += (dx / l) * inwardSign;
    }
    const l = Math.hypot(nx, nz) || 1;
    return [p[0] + (nx / l) * d, p[1] + (nz / l) * d];
  });
}

function minDistToRings(x, z, rings) {
  let best = Infinity;
  for (const r of rings) {
    for (let i = 0; i < r.length; i++) {
      const a = r[i], b = r[(i + 1) % r.length];
      const c = closestOnSegment(x, z, a[0], a[1], b[0], b[1]);
      if (c.d2 < best) best = c.d2;
    }
  }
  return Math.sqrt(best);
}

/**
 * @param {number[][]} outer 外形（ローカル座標）
 * @param {number[][][]} holes 中庭
 * @param {(x:number,z:number)=>number} dsmAt 表面の高さ
 * @returns {{ points: number[][], heights: number[], triangles: number[], rings: {start:number, count:number}[] }}
 *   points/heights: 頂点（境界の頂点が先、rings にその範囲）、triangles: 頂点番号 3 つずつ
 */
export function roofFromDsm(outer, holes, dsmAt, { edgeStep = 2.5, grid = 1.8, inset = 0.7, flatTol = 0.3, stepTol = 1.5 } = {}) {
  const rings = [outer, ...holes].map((r) => densify(r, edgeStep));
  const points = [];
  const heights = [];
  const ringInfo = [];
  // 境界: 内側（穴なら穴の外側）に inset m 入った所の高さ
  const outerSign = signedArea(rings[0]) > 0 ? 1 : -1;
  rings.forEach((r, ri) => {
    const sign = ri === 0 ? outerSign : -(signedArea(r) > 0 ? 1 : -1);
    const ins = insetPoints(r, inset, sign); // 屋根の内側へ
    const raw = r.map((_, i) => dsmAt(ins[i][0], ins[i][1]));
    // 前後 2 点との中央値（控え壁・煙突・樋などで屋根の縁がぎざぎざにならないように）
    const hs = raw.map((_, i) => {
      if (r.length < 5) return raw[i];
      const w = [-2, -1, 0, 1, 2].map((d) => raw[(i + d + r.length) % r.length]).sort((a, b) => a - b);
      return w[2];
    });
    // 元の頂点の間の点は、高さが両端の直線から flatTol 以上ずれる所だけ残す（壁と屋根の三角形を減らす）
    const keep = r.map((p) => p.orig);
    let last = 0;
    for (let i = 1; i <= r.length; i++) {
      const k = i % r.length;
      if (!keep[k]) continue;
      for (let j = last + 1; j < i; j++) {
        const t = (j - last) / (i - last);
        if (Math.abs(hs[j] - (hs[last] + (hs[k] - hs[last]) * t)) > flatTol) keep[j] = true;
      }
      last = i;
    }
    const kept = r.map((p, i) => i).filter((i) => keep[i]);
    rings[ri] = kept.map((i) => r[i]);
    ringInfo.push({ start: points.length, count: kept.length });
    for (const i of kept) {
      points.push(r[i]);
      heights.push(hs[i]);
    }
  });

  // 内側の格子点（世界座標にそろえた格子）。周りと同じ平面上にある点は省く
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
  for (const [x, z] of rings[0]) {
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
  }
  const poly = { outer: rings[0], holes: rings.slice(1) };
  // 比べる隣の点は、屋根の縁から inset m 以上内側のものだけ（縁の近くの表面モデルは道路の高さと混ざってぼやけている）
  const inside = (x, z) => pointInPolygon(x, z, poly) && minDistToRings(x, z, rings) >= inset;
  const steiner = [];
  for (let gx = Math.ceil(minX / grid) * grid; gx < maxX; gx += grid) {
    for (let gz = Math.ceil(minZ / grid) * grid; gz < maxZ; gz += grid) {
      if (!pointInPolygon(gx, gz, poly)) continue;
      const edgeDist = minDistToRings(gx, gz, rings);
      if (edgeDist < grid * 0.6) continue;
      const h = dsmAt(gx, gz);
      const nb = (dx, dz) => (edgeDist - Math.hypot(dx, dz) >= inset || inside(gx + dx, gz + dz) ? dsmAt(gx + dx, gz + dz) : h);
      const devX = Math.abs(h - (nb(-grid, 0) + nb(grid, 0)) / 2);
      const devZ = Math.abs(h - (nb(0, -grid) + nb(0, grid)) / 2);
      const devD = Math.abs(h - (nb(-grid, -grid) + nb(grid, grid)) / 2);
      const dev = Math.max(devX, devZ, devD);
      if (dev > flatTol) steiner.push([gx, gz, h, dev]);
    }
  }
  // 段差（高さの違う棟の境）の近くは半分の間隔の点も足す（格子と段差の線がずれて屋根がぎざぎざになるのを抑える）
  const seen = new Set(steiner.map(([x, z]) => `${Math.round(x * 100)},${Math.round(z * 100)}`));
  const half = grid / 2;
  for (const [gx, gz, , dev] of steiner.slice()) {
    if (dev < stepTol) continue;
    for (const [dx, dz] of [[-half, 0], [half, 0], [0, -half], [0, half], [-half, -half], [half, -half], [-half, half], [half, half]]) {
      const x = gx + dx, z = gz + dz;
      const key = `${Math.round(x * 100)},${Math.round(z * 100)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (!pointInPolygon(x, z, poly)) continue;
      const edgeDist = minDistToRings(x, z, rings);
      if (edgeDist < half * 0.6) continue;
      // 段差の線の上の点だけ（平らな所の点は要らない）
      const h = dsmAt(x, z);
      const nb = (ax, az) => (edgeDist - Math.hypot(ax, az) >= inset || inside(x + ax, z + az) ? dsmAt(x + ax, z + az) : h);
      const d = Math.max(Math.abs(h - (nb(-half, 0) + nb(half, 0)) / 2), Math.abs(h - (nb(0, -half) + nb(0, half)) / 2));
      if (d > flatTol * 2) steiner.push([x, z, h, 0]);
    }
  }

  // 三角形分割（失敗したら境界だけで Earcut）
  let triangles = null;
  try {
    const mk = (r, start) => r.map((p, i) => {
      const q = new poly2tri.Point(p[0], p[1]);
      q.id = start + i;
      return q;
    });
    const ctx = new poly2tri.SweepContext(mk(rings[0], ringInfo[0].start));
    rings.slice(1).forEach((r, i) => ctx.addHole(mk(r, ringInfo[i + 1].start)));
    const base = points.length;
    steiner.forEach(([x, z, h], i) => {
      const q = new poly2tri.Point(x, z);
      q.id = base + i;
      ctx.addPoint(q);
      points.push([x, z]);
      heights.push(h);
    });
    ctx.triangulate();
    triangles = [];
    for (const t of ctx.getTriangles()) triangles.push(t.getPoint(0).id, t.getPoint(1).id, t.getPoint(2).id);
  } catch {
    points.length = ringInfo.reduce((a, r) => a + r.count, 0);
    heights.length = points.length;
    const flat = [];
    const holeIdx = [];
    rings.forEach((r, i) => {
      if (i > 0) holeIdx.push(flat.length / 2);
      for (const p of r) flat.push(p[0], p[1]);
    });
    triangles = Earcut.triangulate(flat, holeIdx);
  }
  return { points, heights, triangles, rings: ringInfo };
}
