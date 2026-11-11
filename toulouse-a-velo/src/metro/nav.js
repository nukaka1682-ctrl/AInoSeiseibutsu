// 歩ける所（床）と壁。地上・吹き抜けの階段・地下の通路・改札階・ホーム・走る電車の中を同じしくみで歩く（three.js を使わない）。
// - 床: 凸多角形（x, z）と高さの関数 y(x, z)。立っている高さから上に up m・下に down m の中で、いちばん近い床に立つ。
//   どの床もなければその向きには進めない（ホームの縁から線路に落ちない・吹き抜けの縁から落ちない）
// - 壁: 線分と高さの範囲 [y0, y1]。体の高さ（足 + 0.3〜1.7 m）と重なる壁だけ当たる。active が false の壁（開いた扉）は通れる
// - 動く層（電車の 1 両）: 層の局所座標（x 前・z 右）の床と壁。層の位置・向きは毎フレーム変わり、乗っている人を運ぶ
// - 地上: surface（街の地面の高さ・建物などの当たり判定）を別に渡す
import { Grid, closestOnSegment } from '../geo.js';

export const STEP_UP = 0.62, STEP_DOWN = 0.9;

function convexContains(poly, x, z) {
  let sign = 0;
  for (let i = 0, n = poly.length; i < n; i++) {
    const [ax, az] = poly[i], [bx, bz] = poly[(i + 1) % n];
    const c = (bx - ax) * (z - az) - (bz - az) * (x - ax);
    if (Math.abs(c) < 1e-9) continue;
    const s = c > 0 ? 1 : -1;
    if (sign && s !== sign) return false;
    sign = s;
  }
  return true;
}

function bounds(poly) {
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
  for (const [x, z] of poly) {
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minZ = Math.min(minZ, z);
    maxZ = Math.max(maxZ, z);
  }
  return { minX, minZ, maxX, maxZ };
}

// 床と壁の集まり（静的な層: 座標はそのままローカル座標。動く層: 局所座標で、pose で置く）
export class NavLayer {
  constructor(name = '', { cell = 6 } = {}) {
    this.name = name;
    this.regions = [];
    this.walls = [];
    this.rgrid = new Grid(cell);
    this.wgrid = new Grid(cell);
    this.pose = null; // 動く層: { x, y, z, fx, fz }（局所の +x が (fx, fz)、+z が (-fz, fx)）
    this.prev = null;
  }

  // poly: 凸多角形 [[x, z], ...]、y(x, z): 床の高さ（動く層は局所の高さ）。opts: { kind, conveyor: [vx, vz]（動く歩道）, holes: [凸多角形]（床の穴） }
  addRegion(poly, y, opts = {}) {
    const r = { poly, y: typeof y === 'number' ? () => y : y, layer: this, ...opts };
    const b = bounds(poly);
    r.bounds = b;
    this.rgrid.insertBounds(b.minX, b.minZ, b.maxX, b.maxZ, this.regions.length);
    this.regions.push(r);
    return r;
  }

  addWall(ax, az, bx, bz, y0, y1, opts = {}) {
    const w = { ax, az, bx, bz, y0, y1, active: true, ...opts };
    this.wgrid.insertSegment(ax, az, bx, bz, this.walls.length);
    this.walls.push(w);
    return w;
  }

  // ローカル座標 ↔ 層の局所座標
  toLocal(x, z, pose = this.pose) {
    if (!pose) return [x, z];
    const dx = x - pose.x, dz = z - pose.z;
    return [dx * pose.fx + dz * pose.fz, -dx * pose.fz + dz * pose.fx];
  }

  toWorld(lx, lz, pose = this.pose) {
    if (!pose) return [lx, lz];
    return [pose.x + lx * pose.fx - lz * pose.fz, pose.z + lx * pose.fz + lz * pose.fx];
  }

  // slope: 局所の +x への床の勾配（電車が坂にいるとき）
  setPose(x, y, z, fx, fz, slope = 0) {
    this.prev = this.pose ? { ...this.pose } : null;
    this.pose = { x, y, z, fx, fz, slope };
  }

  // (x, z) の床の候補（高さはローカル座標の高さ）
  floors(x, z, fn) {
    const [lx, lz] = this.toLocal(x, z);
    const oy = this.pose ? this.pose.y : 0;
    this.rgrid.queryPoint(lx, lz, 0, (i) => {
      const r = this.regions[i];
      if (r.disabled) return;
      const b = r.bounds;
      if (lx < b.minX - 1e-6 || lx > b.maxX + 1e-6 || lz < b.minZ - 1e-6 || lz > b.maxZ + 1e-6) return;
      if (!convexContains(r.poly, lx, lz)) return;
      if (r.holes && r.holes.some((h) => convexContains(h, lx, lz))) return; // 床の穴（吹き抜け・出入口の階段）
      fn(r.y(lx, lz) + oy + (this.pose?.slope || 0) * lx, r);
    });
  }

  // 円 (x, z, rad) を、高さ [y0, y1] に重なる壁から押し出す
  resolve(x, z, rad, y0, y1) {
    const oy = this.pose ? this.pose.y : 0;
    let [lx, lz] = this.toLocal(x, z);
    let hit = false;
    for (let iter = 0; iter < 3; iter++) {
      let moved = false;
      const seen = new Set();
      this.wgrid.queryPoint(lx, lz, rad, (i) => {
        if (seen.has(i)) return;
        seen.add(i);
        const w = this.walls[i];
        if (!w.active || w.y1 + oy <= y0 || w.y0 + oy >= y1) return;
        const c = closestOnSegment(lx, lz, w.ax, w.az, w.bx, w.bz);
        if (c.d2 >= rad * rad) return;
        const d = Math.sqrt(c.d2);
        let nx, nz;
        if (d > 1e-6) {
          nx = (lx - c.x) / d;
          nz = (lz - c.z) / d;
        } else {
          const dx = w.bx - w.ax, dz = w.bz - w.az, l = Math.hypot(dx, dz) || 1;
          nx = -dz / l;
          nz = dx / l;
        }
        lx += nx * (rad - d);
        lz += nz * (rad - d);
        hit = moved = true;
      });
      if (!moved) break;
    }
    const [wx, wz] = this.toWorld(lx, lz);
    return { x: wx, z: wz, hit };
  }

  // 線分 a→b（高さ y の水平の線）が壁に当たる割合（カメラを壁の手前に）
  raycast(ax, az, bx, bz, y) {
    const oy = this.pose ? this.pose.y : 0;
    const [la, lb] = [this.toLocal(ax, az), this.toLocal(bx, bz)];
    let best = 1;
    const seen = new Set();
    this.wgrid.query(Math.min(la[0], lb[0]), Math.min(la[1], lb[1]), Math.max(la[0], lb[0]), Math.max(la[1], lb[1]), (i) => {
      if (seen.has(i)) return;
      seen.add(i);
      const w = this.walls[i];
      if (!w.active || y < w.y0 + oy || y > w.y1 + oy) return;
      const t = segT(la[0], la[1], lb[0], lb[1], w.ax, w.az, w.bx, w.bz);
      if (t != null && t < best) best = t;
    });
    return best;
  }

  // 線分 a→b が、高さ [y0, y1] に重なる壁を横切るか
  crosses(ax, az, bx, bz, y0, y1) {
    const oy = this.pose ? this.pose.y : 0;
    const [la, lb] = [this.toLocal(ax, az), this.toLocal(bx, bz)];
    let hit = false;
    this.wgrid.query(Math.min(la[0], lb[0]), Math.min(la[1], lb[1]), Math.max(la[0], lb[0]), Math.max(la[1], lb[1]), (i) => {
      if (hit) return;
      const w = this.walls[i];
      if (!w.active || w.y1 + oy <= y0 || w.y0 + oy >= y1) return;
      if (segT(la[0], la[1], lb[0], lb[1], w.ax, w.az, w.bx, w.bz) != null) hit = true;
    });
    return hit;
  }

  // 前のフレームの位置から今の位置へ、層に乗った点を運ぶ（[x, y, z, 向きの変わり（ラジアン）]）
  carry(x, y, z) {
    if (!this.pose || !this.prev) return [x, y, z, 0];
    const [lx, lz] = this.toLocal(x, z, this.prev);
    const [wx, wz] = this.toWorld(lx, lz, this.pose);
    const a0 = Math.atan2(this.prev.fz, this.prev.fx), a1 = Math.atan2(this.pose.fz, this.pose.fx);
    let da = a1 - a0;
    da = Math.atan2(Math.sin(da), Math.cos(da));
    return [wx, y + this.pose.y - this.prev.y, wz, da];
  }
}

function segT(ax, az, bx, bz, cx, cz, dx, dz) {
  const rx = bx - ax, rz = bz - az, sx = dx - cx, sz = dz - cz;
  const den = rx * sz - rz * sx;
  if (Math.abs(den) < 1e-9) return null;
  const t = ((cx - ax) * sz - (cz - az) * sx) / den;
  const u = ((cx - ax) * rz - (cz - az) * rx) / den;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? t : null;
}

// すべての層と地上をまとめて調べる
export class Nav {
  constructor() {
    this.layers = new Set();
    this.surface = null; // { floorAt(x, z, y) → y | null, resolve(x, z, r) → { x, z, hit }, raycast(ax, az, bx, bz) → t, level(x, z) → 地面の高さ }
  }

  add(layer) {
    this.layers.add(layer);
    return layer;
  }

  remove(layer) {
    this.layers.delete(layer);
  }

  // (x, z) で、足の高さ y から歩いて行ける床（{ y, region } か null。region が null なら地上）
  floorAt(x, z, y, up = STEP_UP, down = STEP_DOWN) {
    let best = null, bd = Infinity;
    const consider = (fy, region) => {
      if (fy > y + up || fy < y - down) return;
      // 近い床。同じくらいなら高い方（段の上）
      const d = Math.abs(fy - y) - (fy > y ? 0.001 : 0);
      if (d < bd) {
        bd = d;
        best = { y: fy, region };
      }
    };
    for (const L of this.layers) L.floors(x, z, consider);
    if (this.surface) {
      const sy = this.surface.floorAt(x, z, y);
      if (sy != null) consider(sy, null);
    }
    return best;
  }

  // 体（足の高さ y、半径 r）を壁から押し出す
  resolve(x, z, r, y) {
    const y0 = y + 0.3, y1 = y + 1.7;
    let hit = false;
    for (const L of this.layers) {
      const o = L.resolve(x, z, r, y0, y1);
      x = o.x;
      z = o.z;
      hit ||= o.hit;
    }
    if (this.surface && this.surface.near(x, z, y)) {
      const o = this.surface.resolve(x, z, r);
      x = o.x;
      z = o.z;
      hit ||= o.hit;
    }
    return { x, z, hit };
  }

  // 歩いて a → b へ行けるか（壁を横切らず、b に足の届く床がある）。行ければ b の床 { y, region }
  step(ax, az, y, bx, bz) {
    for (const L of this.layers) if (L.crosses(ax, az, bx, bz, y + 0.3, y + 1.7)) return null;
    return this.floorAt(bx, bz, y);
  }

  raycast(ax, az, bx, bz, y) {
    let t = 1;
    for (const L of this.layers) t = Math.min(t, L.raycast(ax, az, bx, bz, y));
    if (this.surface && this.surface.near(ax, az, y - 1.6)) t = Math.min(t, this.surface.raycast(ax, az, bx, bz));
    return t;
  }
}

// 局所座標の長方形（s0..s1, t0..t1）を、駅の局所座標 → ローカル座標の関数 at で多角形に
export function rectPoly(at, s0, s1, t0, t1) {
  return [at(s0, t0), at(s1, t0), at(s1, t1), at(s0, t1)];
}

// 階段の高さ: 上の端 y0（u = u0）から下りる。段の数 n、下の端の高さ y1（u = u1）。踏み面は水平
export function stairHeight(u, u0, u1, y0, y1, n) {
  const k = Math.max(0, Math.min(n - 1, Math.floor(((u - u0) / (u1 - u0)) * n)));
  return y0 + ((y1 - y0) * (k + 1)) / n;
}
