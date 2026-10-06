// 敷地を隔てる塀（data/walls.js で地籍と LiDAR から見つけたもの）と、LiDAR で見つけた木を、ローカル座標に直して作る。
// 塀はレンガ（ときどき漆喰）の壁に、瓦をのせた笠木。当たり判定も付ける。
import * as THREE from 'three';
import { MeshWriter } from './meshwriter.js';
import { hash01 } from '../geo.js';

const THICK = 0.4;
const BRICK = ['#c98a72', '#bf7a62', '#d29a80', '#c4846b'];
const STUCCO = ['#e2d3ba', '#d8c6a6', '#e9dcc6'];
const CAP = [0.62, 0.33, 0.23]; // 笠木の瓦

const col = (hex) => {
  const c = new THREE.Color(hex);
  return [c.r, c.g, c.b];
};

// walls: [経度 1, 緯度 1, 経度 2, 緯度 2, 高さ] の配列 → [[x1, z1, x2, z2, 高さ], ...]
export function projectWalls(walls, proj) {
  return walls.map(([lon1, lat1, lon2, lat2, h]) => [...proj.project(lat1, lon1), ...proj.project(lat2, lon2), h]);
}

// 道路の上にかかる部分は切り取る（LiDAR に写った大型車や門の上の構造物などの誤検出。道はふさがない）
export function clearRoads(segs, onRoad) {
  const out = [];
  for (const [ax, az, bx, bz, h] of segs) {
    const L = Math.hypot(bx - ax, bz - az);
    const n = Math.max(1, Math.ceil(L / 0.5));
    let start = -1;
    for (let k = 0; k <= n; k++) {
      const t = k / n;
      const free = k < n && !onRoad(ax + (bx - ax) * t, az + (bz - az) * t);
      if (free && start < 0) start = k;
      if (!free && start >= 0) {
        const t0 = start / n, t1 = Math.min(1, (k - (k === n ? 0 : 1)) / n);
        if ((t1 - t0) * L >= 1) out.push([ax + (bx - ax) * t0, az + (bz - az) * t0, ax + (bx - ax) * t1, az + (bz - az) * t1, h]);
        start = -1;
      }
    }
  }
  return out;
}

// trees: [経度, 緯度, 高さ, 半径] の配列 → buildTrees の点
export function projectTrees(trees, proj) {
  return trees.map(([lon, lat, h, r]) => {
    const [x, z] = proj.project(lat, lon);
    return { x, z, y: 0, h, r };
  });
}

// 塀のメッシュ（material は建物の「窓のない壁」と同じレンガのテクスチャ）。collision があれば当たり判定を足す
export function buildEnclosures(segs, material, collision = null) {
  const w = new MeshWriter();
  for (const [ax, az, bx, bz, h] of segs) {
    const L = Math.hypot(bx - ax, bz - az);
    if (L < 0.5) continue;
    const ux = (bx - ax) / L, uz = (bz - az) / L;
    const nx = -uz * (THICK / 2), nz = ux * (THICK / 2);
    const seed = Math.floor(ax * 3.1) * 7919 + Math.floor(az * 2.3);
    const color = hash01(seed, 1) < 0.75 ? col(BRICK[Math.floor(hash01(seed, 2) * BRICK.length)]) : col(STUCCO[Math.floor(hash01(seed, 3) * STUCCO.length)]);
    const top = h - 0.12;
    // 両側の面
    for (const s of [1, -1]) {
      const p = [ax + nx * s, az + nz * s], q = [bx + nx * s, bz + nz * s];
      w.quad([p[0], 0, p[1]], [q[0], 0, q[1]], [q[0], top, q[1]], [p[0], top, p[1]], [-uz * s, 0, ux * s],
        [0, 0], [L / 4, 0], [L / 4, top / 4], [0, top / 4], color);
    }
    // 端の面
    for (const [x, z, s] of [[ax, az, -1], [bx, bz, 1]]) {
      w.quad([x + nx, 0, z + nz], [x - nx, 0, z - nz], [x - nx, top, z - nz], [x + nx, top, z + nz], [ux * s, 0, uz * s],
        [0, 0], [THICK / 4, 0], [THICK / 4, top / 4], [0, top / 4], color);
    }
    // 笠木（少し張り出した瓦）
    const cx = nx * 1.4, cz = nz * 1.4, ex = ux * 0.05, ez = uz * 0.05;
    const c = [[ax - ex + cx, az - ez + cz], [bx + ex + cx, bz + ez + cz], [bx + ex - cx, bz + ez - cz], [ax - ex - cx, az - ez - cz]];
    const at = (i, y) => [c[i][0], y, c[i][1]];
    w.quad(at(0, h), at(1, h), at(2, h), at(3, h), [0, 1, 0], [0, 0], [1, 0], [1, 0.1], [0, 0.1], CAP);
    for (let i = 0; i < 4; i++) {
      const j = (i + 1) % 4;
      const ex2 = c[j][0] - c[i][0], ez2 = c[j][1] - c[i][1];
      const l = Math.hypot(ex2, ez2) || 1;
      w.quad(at(i, top), at(j, top), at(j, h), at(i, h), [ez2 / l, 0, -ex2 / l], [0, 0], [1, 0], [1, 0.03], [0, 0.03], CAP);
    }
    if (collision) collision.addSegment(ax, az, bx, bz);
  }
  const group = new THREE.Group();
  group.name = 'enclosure-walls';
  if (!w.empty) {
    const m = new THREE.Mesh(w.toGeometry(), material);
    m.castShadow = m.receiveShadow = true;
    m.matrixAutoUpdate = false;
    group.add(m);
  }
  return group;
}
