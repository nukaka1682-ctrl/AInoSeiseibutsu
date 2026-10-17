// 三角形を溜めて BufferGeometry にするヘルパー。法線を明示して渡し、
// 巻き順は法線と合うように自動で入れ替える（表面が外側を向くように）。
// 地形に載せる（world/terrain.js）:
// - drape: 地形。書いた y は「地面からの高さ」になり、三角形は地面の格子の線と対角線で切り分けて地面の平面に載せる
//   （長い道路の面も坂に沿う。地面と同じ平面なので地面が突き抜けない）。上向きの面の法線は地面の法線に。lift: さらに浮かせる高さ。
//   tol: 頂点だけを載せた平面と地面の差がこれ以下の三角形は切らずにそのまま書く（平らな所で三角形を増やさない。
//   0 なら必ず切る。地面のメッシュは 0、上に重ねる面は terrain.js の DRAPE_TOL で、浮かせる DRAPE_LIFT より小さい）
// - yOffset: すべての頂点に足す高さ（建物の土台の高さなど、形を変えずに上下に動かす物）
// - map(x, y, z) → y': 頂点の高さを置き換える（橋・岸）。maxEdge: その前に、辺がこれより長い三角形を辺の中点で分ける
//   （split(a, b, c) が false を返す三角形は分けない）
import * as THREE from 'three';
import { Earcut } from 'three/src/extras/Earcut.js';

export class MeshWriter {
  constructor({ drape = null, lift = 0, map = null, maxEdge = 0, split = null, tol = 0.04 } = {}) {
    this.pos = [];
    this.nor = [];
    this.uv = [];
    this.col = [];
    this.drape = drape && !drape.flat ? drape : null;
    this.lift = lift;
    this.map = map;
    this.maxEdge = maxEdge;
    this.split = split;
    this.yOffset = 0;
    this.tol = tol;
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
    if (this.drape || this.map) {
      const A = [a[0], a[1], a[2], ta[0], ta[1], ca[0], ca[1], ca[2]];
      const B = [b[0], b[1], b[2], tb[0], tb[1], cb[0], cb[1], cb[2]];
      const C = [c[0], c[1], c[2], tc[0], tc[1], cc[0], cc[1], cc[2]];
      if (this.map) this.bisect(A, B, C, n, 0);
      else this.drapeTri(A, B, C, n, 0);
      return;
    }
    if (this.yOffset) {
      const o = this.yOffset;
      a = [a[0], a[1] + o, a[2]];
      b = [b[0], b[1] + o, b[2]];
      c = [c[0], c[1] + o, c[2]];
    }
    this.pos.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
    this.nor.push(n[0], n[1], n[2], n[0], n[1], n[2], n[0], n[1], n[2]);
    this.uv.push(ta[0], ta[1], tb[0], tb[1], tc[0], tc[1]);
    this.col.push(ca[0], ca[1], ca[2], cb[0], cb[1], cb[2], cc[0], cc[1], cc[2]);
  }

  // map のとき: 辺が maxEdge より長ければ、いちばん長い辺の中点で 2 つに分ける（同じ辺は隣の三角形でも同じ点で分かれる）
  bisect(A, B, C, n, depth) {
    const m = this.maxEdge;
    if (m > 0 && depth < 14 && (!this.split || this.split(A, B, C))) {
      const e = (p, q) => (p[0] - q[0]) ** 2 + (p[2] - q[2]) ** 2;
      const ab = e(A, B), bc = e(B, C), ca = e(C, A), L = Math.max(ab, bc, ca);
      if (L > m * m) {
        const mid = (p, q) => p.map((v, k) => (v + q[k]) / 2);
        if (L === ab) {
          const M = mid(A, B);
          this.bisect(A, M, C, n, depth + 1);
          this.bisect(M, B, C, n, depth + 1);
        } else if (L === bc) {
          const M = mid(B, C);
          this.bisect(A, B, M, n, depth + 1);
          this.bisect(A, M, C, n, depth + 1);
        } else {
          const M = mid(C, A);
          this.bisect(A, B, M, n, depth + 1);
          this.bisect(M, B, C, n, depth + 1);
        }
        return;
      }
    }
    this.emit(A, B, C, n);
  }

  // 地形に載せる: 地面とほぼ同じ平面ならそのまま、大きければ辺の中点で分けて調べ直し、小さければ格子で切る
  drapeTri(A, B, C, n, depth) {
    const d = this.drape;
    if (this.tol > 0 && d.flatOver(A, B, C, this.tol)) return this.emit(A, B, C, n);
    const e = (p, q) => (p[0] - q[0]) ** 2 + (p[2] - q[2]) ** 2;
    const ab = e(A, B), bc = e(B, C), ca = e(C, A), L = Math.max(ab, bc, ca);
    if (this.tol > 0 && L > 900 && depth < 12) {
      const mid = (p, q) => p.map((v, k) => (v + q[k]) / 2);
      if (L === ab) {
        const M = mid(A, B);
        this.drapeTri(A, M, C, n, depth + 1);
        this.drapeTri(M, B, C, n, depth + 1);
      } else if (L === bc) {
        const M = mid(B, C);
        this.drapeTri(A, B, M, n, depth + 1);
        this.drapeTri(A, M, C, n, depth + 1);
      } else {
        const M = mid(C, A);
        this.drapeTri(A, B, M, n, depth + 1);
        this.drapeTri(M, B, C, n, depth + 1);
      }
      return;
    }
    for (const p of d.split([A, B, C])) for (let k = 1; k + 1 < p.length; k++) this.emit(p[0], p[k], p[k + 1], n);
  }

  // 地形に載せた（または map した）三角形を書く。頂点は [x, y, z, u, v, r, g, b]
  emit(A, B, C, n) {
    const ux = B[0] - A[0], uy = B[1] - A[1], uz = B[2] - A[2];
    const vx = C[0] - A[0], vy = C[1] - A[1], vz = C[2] - A[2];
    const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
    if (cx * cx + cy * cy + cz * cz < 1e-14) return; // 切り分けでできたつぶれた三角形
    const d = this.drape, o = this.yOffset;
    const up = d && n[1] > 0.95 ? 1 : d && n[1] < -0.95 ? -1 : 0;
    for (const P of [A, B, C]) {
      const y = this.map ? this.map(P[0], P[1], P[2]) + o : P[1] + d.h(P[0], P[2]) + this.lift + o;
      this.pos.push(P[0], y, P[2]);
      if (up) {
        const g = d.normal(P[0], P[2]);
        this.nor.push(g[0] * up, g[1] * up, g[2] * up);
      } else this.nor.push(n[0], n[1], n[2]);
      this.uv.push(P[3], P[4]);
      this.col.push(P[5], P[6], P[7]);
    }
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
