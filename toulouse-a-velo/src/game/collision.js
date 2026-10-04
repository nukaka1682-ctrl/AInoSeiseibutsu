// 2D の当たり判定（建物の壁・木の幹・水面・エリア外）。
// 自転車は半径 r の円として扱い、壁の線分から押し出す。
import { Grid, closestOnSegment } from '../geo.js';

export class CollisionWorld {
  constructor(rect) {
    this.rect = rect;
    this.segs = []; // [ax, az, bx, bz]
    this.segGrid = new Grid(10);
    this.circles = [];
    this.circleGrid = new Grid(10);
    this.inWater = () => false;
    this.onRoad = () => false;
  }

  // skip(a, b) が true を返す辺は壁にしない（建物の下をくぐる通路など）
  addRing(ring, skip = null) {
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i], b = ring[(i + 1) % ring.length];
      if (skip && skip(a, b)) continue;
      this.addSegment(a[0], a[1], b[0], b[1]);
    }
  }

  addSegment(ax, az, bx, bz) {
    const i = this.segs.length;
    this.segs.push([ax, az, bx, bz]);
    this.segGrid.insertSegment(ax, az, bx, bz, i);
  }

  addCircle(x, z, r) {
    const i = this.circles.length;
    this.circles.push([x, z, r]);
    this.circleGrid.insertBounds(x - r, z - r, x + r, z + r, i);
  }

  // 水の上は橋（道路）の上だけ通れる
  blockedByWater(x, z) {
    return this.inWater(x, z) && !this.onRoad(x, z);
  }

  outOfBounds(x, z, margin = 15) {
    const r = this.rect;
    return x < r.minX + margin || x > r.maxX - margin || z < r.minZ + margin || z > r.maxZ - margin;
  }

  // 円 (x,z,r) を壁から押し出す。戻り値: { x, z, hit, nx, nz }
  resolve(x, z, r) {
    let hit = false, nxSum = 0, nzSum = 0;
    for (let iter = 0; iter < 3; iter++) {
      let moved = false;
      const seen = new Set();
      this.segGrid.queryPoint(x, z, r, (i) => {
        if (seen.has(i)) return;
        seen.add(i);
        const s = this.segs[i];
        const c = closestOnSegment(x, z, s[0], s[1], s[2], s[3]);
        if (c.d2 < r * r) {
          const d = Math.sqrt(c.d2);
          let nx, nz;
          if (d > 1e-6) {
            nx = (x - c.x) / d;
            nz = (z - c.z) / d;
          } else {
            const dx = s[2] - s[0], dz = s[3] - s[1];
            const l = Math.hypot(dx, dz) || 1;
            nx = -dz / l;
            nz = dx / l;
          }
          x += nx * (r - d);
          z += nz * (r - d);
          nxSum += nx;
          nzSum += nz;
          hit = moved = true;
        }
      });
      this.circleGrid.queryPoint(x, z, r, (i) => {
        const [cx, cz, cr] = this.circles[i];
        const dx = x - cx, dz = z - cz;
        const d = Math.hypot(dx, dz);
        const min = r + cr;
        if (d < min && d > 1e-6) {
          x += (dx / d) * (min - d);
          z += (dz / d) * (min - d);
          nxSum += dx / d;
          nzSum += dz / d;
          hit = moved = true;
        }
      });
      if (!moved) break;
    }
    const nl = Math.hypot(nxSum, nzSum) || 1;
    return { x, z, hit, nx: nxSum / nl, nz: nzSum / nl };
  }

  // 線分 a→b が最初に壁に当たる位置の割合 t（0..1）。カメラのめり込み防止用
  raycast(ax, az, bx, bz) {
    let best = 1;
    const seen = new Set();
    this.segGrid.query(Math.min(ax, bx), Math.min(az, bz), Math.max(ax, bx), Math.max(az, bz), (i) => {
      if (seen.has(i)) return;
      seen.add(i);
      const s = this.segs[i];
      const t = segIntersect(ax, az, bx, bz, s[0], s[1], s[2], s[3]);
      if (t !== null && t < best) best = t;
    });
    return best;
  }
}

export function segIntersect(ax, az, bx, bz, cx, cz, dx, dz) {
  const rx = bx - ax, rz = bz - az, sx = dx - cx, sz = dz - cz;
  const den = rx * sz - rz * sx;
  if (Math.abs(den) < 1e-9) return null;
  const t = ((cx - ax) * sz - (cz - az) * sx) / den;
  const u = ((cx - ax) * rz - (cz - az) * rx) / den;
  if (t >= 0 && t <= 1 && u >= 0 && u <= 1) return t;
  return null;
}
