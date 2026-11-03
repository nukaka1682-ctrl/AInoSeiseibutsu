// メッシュを組み立てる道具（材質ごとに MeshWriter を持ち、壁・床・箱・棒・円柱を書く）。駅・車両・トンネルで使う
import * as THREE from 'three';
import { MeshWriter } from '../world/meshwriter.js';

export class Builder {
  constructor() {
    this.writers = new Map();
  }

  w(key) {
    let w = this.writers.get(key);
    if (!w) this.writers.set(key, (w = new MeshWriter()));
    return w;
  }

  // 鉛直の壁 a→b（[x, z]）、高さ y0..y1（両端で違ってよい: [ya0, ya1], [yb0, yb1]）。n: 面の向き [nx, nz]（省略すると a→b の左）
  wall(key, a, b, y0, y1, { n = null, color = [1, 1, 1], uv = 1.2, u0 = 0, yb = null } = {}) {
    const dx = b[0] - a[0], dz = b[1] - a[1], L = Math.hypot(dx, dz);
    if (L < 1e-4) return;
    const nn = n || [-dz / L, dx / L];
    const [ya0, ya1] = [y0, y1], [yb0, yb1] = yb || [y0, y1];
    this.w(key).quad([a[0], ya0, a[1]], [b[0], yb0, b[1]], [b[0], yb1, b[1]], [a[0], ya1, a[1]], [nn[0], 0, nn[1]],
      [u0 / uv, ya0 / uv], [(u0 + L) / uv, yb0 / uv], [(u0 + L) / uv, yb1 / uv], [u0 / uv, ya1 / uv], color);
  }

  // 水平の凸多角形の床（up: 上向き）。y は数か関数 y(x, z)
  floor(key, poly, y, { up = true, color = [1, 1, 1], uv = 1.2 } = {}) {
    const yf = typeof y === 'function' ? y : () => y;
    const P = poly.map(([x, z]) => [x, yf(x, z), z]);
    const n = up ? [0, 1, 0] : [0, -1, 0];
    const w = this.w(key);
    for (let i = 1; i + 1 < P.length; i++) {
      const [a, b, c] = [P[0], P[i], P[i + 1]];
      w.tri(a, b, c, n, [a[0] / uv, -a[2] / uv], [b[0] / uv, -b[2] / uv], [c[0] / uv, -c[2] / uv], color);
    }
  }

  // 向きのある直方体: 中心 (x, z)、高さ y0..y1、長さ a の向き (ux, uz)、奥行き b
  box(key, x, z, y0, y1, ux, uz, a, b, { color = [1, 1, 1], uv = 1.2, top = true, bottom = false } = {}) {
    const vx = -uz, vz = ux, ha = a / 2, hb = b / 2;
    const p = (i, j, y) => [x + ux * ha * i + vx * hb * j, y, z + uz * ha * i + vz * hb * j];
    const w = this.w(key);
    const sides = [[[1, -1], [1, 1], [ux, uz], b], [[-1, 1], [-1, -1], [-ux, -uz], b], [[1, 1], [-1, 1], [vx, vz], a], [[-1, -1], [1, -1], [-vx, -vz], a]];
    for (const [[i0, j0], [i1, j1], [nx, nz], l] of sides) {
      w.quad(p(i0, j0, y0), p(i1, j1, y0), p(i1, j1, y1), p(i0, j0, y1), [nx, 0, nz], [0, y0 / uv], [l / uv, y0 / uv], [l / uv, y1 / uv], [0, y1 / uv], color);
    }
    if (top) w.quad(p(-1, -1, y1), p(1, -1, y1), p(1, 1, y1), p(-1, 1, y1), [0, 1, 0], [0, 0], [a / uv, 0], [a / uv, b / uv], [0, b / uv], color);
    if (bottom) w.quad(p(-1, -1, y0), p(1, -1, y0), p(1, 1, y0), p(-1, 1, y0), [0, -1, 0], [0, 0], [a / uv, 0], [a / uv, b / uv], [0, b / uv], color);
  }

  // 3 次元の 2 点を結ぶ細い角棒（断面 t m）
  bar(key, a, b, t, { color = [1, 1, 1] } = {}) {
    const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2], L = Math.hypot(dx, dy, dz) || 1;
    const d = [dx / L, dy / L, dz / L];
    let s = Math.abs(d[1]) < 0.9 ? [-d[2], 0, d[0]] : [1, 0, 0];
    const sl = Math.hypot(...s);
    s = s.map((v) => v / sl);
    const u = [d[1] * s[2] - d[2] * s[1], d[2] * s[0] - d[0] * s[2], d[0] * s[1] - d[1] * s[0]];
    const h = t / 2, w = this.w(key);
    const P = (p, i, j) => [p[0] + (s[0] * i + u[0] * j) * h, p[1] + (s[1] * i + u[1] * j) * h, p[2] + (s[2] * i + u[2] * j) * h];
    const faces = [[[1, 1], [1, -1], s], [[-1, -1], [-1, 1], s.map((v) => -v)], [[-1, 1], [1, 1], u], [[1, -1], [-1, -1], u.map((v) => -v)]];
    for (const [[i0, j0], [i1, j1], n] of faces) w.quad(P(a, i0, j0), P(b, i0, j0), P(b, i1, j1), P(a, i1, j1), n, [0, 0], [L, 0], [L, 0.1], [0, 0.1], color);
  }

  // 鉛直の円柱（側面だけ。seg 角形）
  cyl(key, x, z, y0, y1, r, { seg = 12, color = [1, 1, 1], uv = 1.2 } = {}) {
    const w = this.w(key);
    for (let i = 0; i < seg; i++) {
      const a0 = (i / seg) * Math.PI * 2, a1 = ((i + 1) / seg) * Math.PI * 2, am = (a0 + a1) / 2;
      const p = (a, y) => [x + Math.cos(a) * r, y, z + Math.sin(a) * r];
      const u0 = (a0 * r) / uv, u1 = (a1 * r) / uv;
      w.quad(p(a0, y0), p(a1, y0), p(a1, y1), p(a0, y1), [Math.cos(am), 0, Math.sin(am)], [u0, y0 / uv], [u1, y0 / uv], [u1, y1 / uv], [u0, y1 / uv], color);
    }
  }

  // 任意の 4 点の面
  quad(key, a, b, c, d, n, { color = [1, 1, 1], uvs = [[0, 0], [1, 0], [1, 1], [0, 1]] } = {}) {
    this.w(key).quad(a, b, c, d, n, ...uvs, color);
  }

  // 材質ごとのメッシュにする。mats: { key: material }（キーの前半 "tile:#..." の ":" より前で引く）。
  // light(x, y, z, nx, ny, nz) → 明るさの倍率（頂点の色に掛ける。照明の当たり方を焼き込む）
  build(mats, { light = null, shadows = false, name = '' } = {}) {
    const group = new THREE.Group();
    group.name = name;
    for (const [key, w] of this.writers) {
      if (w.empty) continue;
      const mat = mats[key] || mats[key.split(':')[0]];
      if (!mat) continue;
      const g = w.toGeometry();
      if (light) {
        const P = g.attributes.position.array, N = g.attributes.normal.array, C = g.attributes.color.array;
        for (let i = 0; i < P.length; i += 3) {
          const k = light(P[i], P[i + 1], P[i + 2], N[i], N[i + 1], N[i + 2]);
          C[i] *= k;
          C[i + 1] *= k;
          C[i + 2] *= k;
        }
      }
      const m = new THREE.Mesh(g, mat);
      m.name = key;
      m.castShadow = m.receiveShadow = shadows;
      if (mat.transparent) m.renderOrder = 2;
      group.add(m);
    }
    return group;
  }
}

export function disposeGroup(group) {
  group.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    if (o.isInstancedMesh) o.dispose();
  });
}
