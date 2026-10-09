// 三角形を溜めて BufferGeometry にするヘルパー。法線を明示して渡し、
// 巻き順は法線と合うように自動で入れ替える（表面が外側を向くように）。
import * as THREE from 'three';
import { Earcut } from 'three/src/extras/Earcut.js';

export class MeshWriter {
  constructor() {
    this.pos = [];
    this.nor = [];
    this.uv = [];
    this.col = [];
  }

  get empty() {
    return this.pos.length === 0;
  }

  // a,b,c: [x,y,z], n: [nx,ny,nz], ta/tb/tc: [u,v], color: [r,g,b]（頂点ごとなら [[r,g,b] × 3]）
  tri(a, b, c, n, ta, tb, tc, color) {
    let ca = color || [1, 1, 1], cb = ca, cc = ca;
    if (Array.isArray(ca[0])) [ca, cb, cc] = color;
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
    if (cx * n[0] + cy * n[1] + cz * n[2] < 0) {
      [b, c] = [c, b];
      [tb, tc] = [tc, tb];
      [cb, cc] = [cc, cb];
    }
    this.pos.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
    this.nor.push(n[0], n[1], n[2], n[0], n[1], n[2], n[0], n[1], n[2]);
    this.uv.push(ta[0], ta[1], tb[0], tb[1], tc[0], tc[1]);
    this.col.push(ca[0], ca[1], ca[2], cb[0], cb[1], cb[2], cc[0], cc[1], cc[2]);
  }

  // 四角形 a-b-c-d（周回順）。color は 1 色か、頂点ごとの [[r,g,b] × 4]
  quad(a, b, c, d, n, ta, tb, tc, td, color) {
    const pv = color && Array.isArray(color[0]);
    this.tri(a, b, c, n, ta, tb, tc, pv ? [color[0], color[1], color[2]] : color);
    this.tri(a, c, d, n, ta, tc, td, pv ? [color[0], color[2], color[3]] : color);
  }

  toGeometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

export function triangulate(outer, holes = []) {
  const verts = [];
  const holeIdx = [];
  const all = [];
  for (const p of outer) {
    verts.push(p[0], p[1]);
    all.push(p);
  }
  for (const h of holes) {
    holeIdx.push(all.length);
    for (const p of h) {
      verts.push(p[0], p[1]);
      all.push(p);
    }
  }
  const idx = Earcut.triangulate(verts, holeIdx);
  return { points: all, indices: idx };
}

// 平面ポリゴン（外周＋穴）を三角形分割して書き込む。y: 高さ、uvScale: テクスチャ1枚あたりのメートル数
export function writeFlatPolygon(w, outer, holes, y, uvScale, color, up = true) {
  const { points, indices } = triangulate(outer, holes);
  const n = up ? [0, 1, 0] : [0, -1, 0];
  for (let i = 0; i < indices.length; i += 3) {
    const a = points[indices[i]], b = points[indices[i + 1]], c = points[indices[i + 2]];
    w.tri(
      [a[0], y, a[1]], [b[0], y, b[1]], [c[0], y, c[1]], n,
      [a[0] / uvScale, -a[1] / uvScale], [b[0] / uvScale, -b[1] / uvScale], [c[0] / uvScale, -c[1] / uvScale],
      color,
    );
  }
}
