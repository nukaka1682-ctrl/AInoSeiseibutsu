// 敷地を隔てる塀（data/walls.js で地籍と LiDAR から見つけたもの）と、LiDAR で見つけた木を、ローカル座標に直して作る。
// 塀はレンガ（ときどき漆喰）の壁に、瓦をのせた笠木。当たり判定も付ける。
// 見た目は Wikimedia Commons のトゥールーズのレンガ壁の写真を手本にしたテクスチャ（textures.js の makeEnclosureTexture）。
import * as THREE from 'three';
import { MeshWriter } from './meshwriter.js';
import { Grid, closestOnSegment, hash01 } from '../geo.js';

const THICK = 0.4;
const CAP = [0.78, 0.45, 0.32]; // 笠木の瓦（瓦のテクスチャに掛ける色）

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

// LiDAR の誤検出らしい高い塀をならす（木・電柱・街灯が塀に見えたもの。ぽつんと短くて高い塀は細いレンガの柱に見える）。
// 焼いた塀は高さ TALL m 超が 4 割ほどある（実際の敷地の塀はたいてい 2〜3 m）。
// - 高さ TALL m 超で、ほかの塀の端が LONE m 以内にない（ひとつだけの）短い塀: 長さ 2 m 未満は捨て、4 m 未満は SHORT_CAP m に
// - それ以外の高い塀: 建物（buildings の外形）に端が付いていなければ TALL m に下げる（建物に付いた長い塀は残す）
const TALL = 4, SHORT_CAP = 2.5, ATTACH = 1.5, LONE = 1;
export function tameWalls(segs, buildings = []) {
  let grid = null; // 建物の索引（高い長い塀があるときだけ作る）
  const attached = (x, z) => {
    if (!grid) {
      grid = new Grid(40);
      buildings.forEach((b, i) => b.bounds && grid.insertBounds(b.bounds.minX - ATTACH, b.bounds.minZ - ATTACH, b.bounds.maxX + ATTACH, b.bounds.maxZ + ATTACH, i));
    }
    let hit = false;
    grid.queryPoint(x, z, 0, (k) => {
      if (hit) return;
      const r = buildings[k].outer;
      for (let i = 0, j = r.length - 1; i < r.length && !hit; j = i++) {
        if (closestOnSegment(x, z, r[j][0], r[j][1], r[i][0], r[i][1]).d2 < ATTACH * ATTACH) hit = true;
      }
    });
    return hit;
  };
  // 塀の端の索引（1 m のマス）
  const ends = new Map();
  const cell = (x, z) => `${Math.floor(x / LONE)},${Math.floor(z / LONE)}`;
  segs.forEach((sg, i) => {
    for (const [x, z] of [[sg[0], sg[1]], [sg[2], sg[3]]]) {
      const k = cell(x, z);
      const l = ends.get(k);
      if (l) l.push(i, x, z);
      else ends.set(k, [i, x, z]);
    }
  });
  const lone = (i) => {
    const sg = segs[i];
    for (const [x, z] of [[sg[0], sg[1]], [sg[2], sg[3]]]) {
      const cx = Math.floor(x / LONE), cz = Math.floor(z / LONE);
      for (let dx = -1; dx <= 1; dx++) {
        for (let dz = -1; dz <= 1; dz++) {
          const l = ends.get(`${cx + dx},${cz + dz}`);
          if (!l) continue;
          for (let k = 0; k < l.length; k += 3) if (l[k] !== i && (l[k + 1] - x) ** 2 + (l[k + 2] - z) ** 2 < LONE * LONE) return false;
        }
      }
    }
    return true;
  };
  const out = [];
  segs.forEach((sg, i) => {
    const [ax, az, bx, bz, h] = sg;
    if (h <= TALL) {
      out.push(sg);
      return;
    }
    const L = Math.hypot(bx - ax, bz - az);
    if (L < 4 && lone(i)) {
      if (L >= 2) out.push([ax, az, bx, bz, SHORT_CAP]);
      return;
    }
    out.push(attached(ax, az) || attached(bx, bz) ? sg : [ax, az, bx, bz, TALL]);
  });
  return out;
}

// trees: [経度, 緯度, 高さ, 半径] の配列 → buildTrees の点
export function projectTrees(trees, proj) {
  return trees.map(([lon, lat, h, r]) => {
    const [x, z] = proj.project(lat, lon);
    return { x, z, y: 0, h, r };
  });
}

// 塀のメッシュ（materials は buildings.js の enclosureBrick・enclosureRender）。collision があれば当たり判定を足す
// terrain: 地形（塀を地面に沿わせる。y は地面からの高さ）
export function buildEnclosures(segs, materials, collision = null, terrain = null) {
  const o = { drape: terrain, lift: -0.05 }; // 少し地面に埋める（地面の細かい凹凸で浮かないように）
  const brick = new MeshWriter(o), render = new MeshWriter(o), cap = new MeshWriter(o);
  const sloped = terrain && !terrain.flat;
  const plain = sloped ? { brick: new MeshWriter(), render: new MeshWriter(), cap: new MeshWriter() } : null;
  for (const [ax, az, bx, bz, h] of segs) {
    const L = Math.hypot(bx - ax, bz - az);
    if (L < 0.5) continue;
    if (sloped) {
      // 地形の上: 地面にそのまま沿わせると、段差（河岸・土手）を斜めに横切る塀の上端が 5 m の格子ごとにのこぎりの歯になる。
      // 上端はなめらかな線（wallProfile）、下端は地面より下まで（地面に隠れる）の普通の面で作る
      const seed = Math.floor(ax * 3.1) * 7919 + Math.floor(az * 2.3);
      writeSlopedWall(hash01(seed, 1) < 0.75 ? plain.brick : plain.render, plain.cap, wallProfile(terrain, ax, az, bx, bz, h), seed);
      if (collision) collision.addSegment(ax, az, bx, bz);
      continue;
    }
    const ux = (bx - ax) / L, uz = (bz - az) / L;
    const nx = -uz * (THICK / 2), nz = ux * (THICK / 2);
    const seed = Math.floor(ax * 3.1) * 7919 + Math.floor(az * 2.3);
    const w = hash01(seed, 1) < 0.75 ? brick : render;
    const k = 0.9 + hash01(seed, 2) * 0.15;
    const color = [k, k * (0.97 + hash01(seed, 3) * 0.03), k * (0.94 + hash01(seed, 4) * 0.06)];
    const u0 = hash01(seed, 5) * 4; // 塀ごとにテクスチャの位置をずらす
    const top = h - 0.12;
    // 両側の面
    for (const s of [1, -1]) {
      const p = [ax + nx * s, az + nz * s], q = [bx + nx * s, bz + nz * s];
      w.quad([p[0], 0, p[1]], [q[0], 0, q[1]], [q[0], top, q[1]], [p[0], top, p[1]], [-uz * s, 0, ux * s],
        [u0, 0], [u0 + L / 4, 0], [u0 + L / 4, top / 4], [u0, top / 4], color);
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
    cap.quad(at(0, h), at(1, h), at(2, h), at(3, h), [0, 1, 0], [0, 0], [L / 1.6, 0], [L / 1.6, 0.35], [0, 0.35], CAP);
    for (let i = 0; i < 4; i++) {
      const j = (i + 1) % 4;
      const ex2 = c[j][0] - c[i][0], ez2 = c[j][1] - c[i][1];
      const l = Math.hypot(ex2, ez2) || 1;
      cap.quad(at(i, top), at(j, top), at(j, h), at(i, h), [ez2 / l, 0, -ex2 / l], [0, 0], [l / 1.6, 0], [l / 1.6, 0.06], [0, 0.06], CAP);
    }
    if (collision) collision.addSegment(ax, az, bx, bz);
  }
  const group = new THREE.Group();
  group.name = 'enclosure-walls';
  const list = [[brick, materials.enclosureBrick], [render, materials.enclosureRender], [cap, materials.roof]];
  if (plain) list.push([plain.brick, materials.enclosureBrick], [plain.render, materials.enclosureRender], [plain.cap, materials.roof]);
  for (const [w, material] of list) {
    if (w.empty) continue;
    const m = new THREE.Mesh(w.toGeometry(), material);
    m.castShadow = m.receiveShadow = true;
    m.matrixAutoUpdate = false;
    group.add(m);
  }
  return group;
}

// 地形の上の塀の縦断面。step m ごとの点 { x, z, base, top }（y。base: 塀の足＝両側の地面の低い方より bury m 下、
// top: 笠木の上端）。上端は「低い側の地面 + h」と「高い側の地面 + 胸壁 min(h, rail) m」の大きい方を、±win m の最大で包んでから
// ±win m で平均する（包んだ線の平均なので、どの点でも元の高さより下がらない）。段差を斜めに横切る塀ものこぎりの歯にならない
export function wallProfile(terrain, ax, az, bx, bz, h, { step = 2, win = 4, rail = 1, bury = 0.3, half = THICK / 2 } = {}) {
  const L = Math.hypot(bx - ax, bz - az), n = Math.max(1, Math.ceil(L / step));
  const ux = (bx - ax) / (L || 1), uz = (bz - az) / (L || 1), nx = -uz * half, nz = ux * half;
  const pts = [], lo = [], raw = [];
  for (let i = 0; i <= n; i++) {
    const x = ax + ((bx - ax) * i) / n, z = az + ((bz - az) * i) / n;
    const g1 = terrain.h(x + nx, z + nz), g2 = terrain.h(x - nx, z - nz), g0 = terrain.h(x, z);
    const l = Math.min(g0, g1, g2), u = Math.max(g0, g1, g2);
    pts.push({ x, z, base: 0, top: 0 });
    lo.push(l);
    raw.push(Math.max(l + h, u + Math.min(h, rail)));
  }
  const w = Math.max(1, Math.round(win / (L / n)));
  const env = raw.map((_, i) => Math.max(...raw.slice(Math.max(0, i - w), i + w + 1)));
  for (let i = 0; i <= n; i++) {
    const a = Math.max(0, i - w), b = Math.min(n, i + w);
    let s = 0;
    for (let k = a; k <= b; k++) s += env[k];
    pts[i].top = s / (b - a + 1);
    pts[i].base = Math.min(...lo.slice(Math.max(0, i - 1), i + 2)) - bury;
  }
  return pts;
}

// wallProfile の点で塀を書く（地形の上。w: 壁の面、cap: 笠木）
function writeSlopedWall(w, cap, P, seed) {
  const k = 0.9 + hash01(seed, 2) * 0.15;
  const color = [k, k * (0.97 + hash01(seed, 3) * 0.03), k * (0.94 + hash01(seed, 4) * 0.06)];
  const u0 = hash01(seed, 5) * 4;
  const A = P[0], Z = P[P.length - 1], L = Math.hypot(Z.x - A.x, Z.z - A.z);
  const ux = (Z.x - A.x) / L, uz = (Z.z - A.z) / L, nx = -uz * (THICK / 2), nz = ux * (THICK / 2);
  const ft = (p) => p.top - 0.12; // 壁の面の上端（その上に笠木）
  let s0 = 0;
  for (let i = 0; i + 1 < P.length; i++) {
    const p = P[i], q = P[i + 1], d = Math.hypot(q.x - p.x, q.z - p.z), s1 = s0 + d;
    for (const s of [1, -1]) {
      const a = [p.x + nx * s, p.z + nz * s], b = [q.x + nx * s, q.z + nz * s];
      w.quad([a[0], p.base, a[1]], [b[0], q.base, b[1]], [b[0], ft(q), b[1]], [a[0], ft(p), a[1]], [-uz * s, 0, ux * s],
        [u0 + s0 / 4, p.base / 4], [u0 + s1 / 4, q.base / 4], [u0 + s1 / 4, ft(q) / 4], [u0 + s0 / 4, ft(p) / 4], color);
    }
    // 笠木（少し張り出した瓦。端だけ 5 cm 延ばす）
    const cx = nx * 1.4, cz = nz * 1.4, ea = i === 0 ? 0.05 : 0, eb = i + 2 === P.length ? 0.05 : 0;
    const c = [[p.x - ux * ea + cx, p.z - uz * ea + cz, p.top], [q.x + ux * eb + cx, q.z + uz * eb + cz, q.top], [q.x + ux * eb - cx, q.z + uz * eb - cz, q.top], [p.x - ux * ea - cx, p.z - uz * ea - cz, p.top]];
    const at = (j, dy = 0) => [c[j][0], c[j][2] + dy, c[j][1]];
    cap.quad(at(0), at(1), at(2), at(3), [0, 1, 0], [s0 / 1.6, 0], [s1 / 1.6, 0], [s1 / 1.6, 0.35], [s0 / 1.6, 0.35], CAP);
    for (const [j0, j1] of [[0, 1], [2, 3]]) {
      const ex2 = c[j1][0] - c[j0][0], ez2 = c[j1][1] - c[j0][1], l = Math.hypot(ex2, ez2) || 1;
      cap.quad(at(j0, -0.12), at(j1, -0.12), at(j1), at(j0), [ez2 / l, 0, -ex2 / l], [0, 0], [l / 1.6, 0], [l / 1.6, 0.06], [0, 0.06], CAP);
    }
    s0 = s1;
  }
  // 端の面と笠木の端
  for (const [p, s, j0, j1] of [[A, -1, 3, 0], [Z, 1, 1, 2]]) {
    w.quad([p.x + nx, p.base, p.z + nz], [p.x - nx, p.base, p.z - nz], [p.x - nx, ft(p), p.z - nz], [p.x + nx, ft(p), p.z + nz], [ux * s, 0, uz * s],
      [0, 0], [THICK / 4, 0], [THICK / 4, (ft(p) - p.base) / 4], [0, (ft(p) - p.base) / 4], color);
    const e = 0.05 * s, cx = nx * 1.4, cz = nz * 1.4;
    const c = j0 === 3 ? [[p.x + e * ux - cx, p.z + e * uz - cz], [p.x + e * ux + cx, p.z + e * uz + cz]] : [[p.x + e * ux + cx, p.z + e * uz + cz], [p.x + e * ux - cx, p.z + e * uz - cz]];
    cap.quad([c[0][0], p.top - 0.12, c[0][1]], [c[1][0], p.top - 0.12, c[1][1]], [c[1][0], p.top, c[1][1]], [c[0][0], p.top, c[0][1]], [ux * s, 0, uz * s],
      [0, 0], [0.5, 0], [0.5, 0.06], [0, 0.06], CAP);
  }
}
