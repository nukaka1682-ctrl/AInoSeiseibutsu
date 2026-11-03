// 駅と電車の人（動かない。立って電車を待つ人・座っている人）。人ごとに服の色・背の高さを変え、
// 駅ごと・車両ごとに 1 つの形にまとめて描く（描く回数を増やさない）
import * as THREE from 'three';
import { entranceDoor } from '../world/metro.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { Builder } from './geom.js';
import { LAYOUT, doorOffsets, wallT } from './network.js';
import { mulberry32 } from '../geo.js';

const TOPS = ['#2a3a5e', '#7a2b23', '#2f5d3a', '#d8d4cc', '#1c1c1e', '#8c6a3f', '#4d6f9c', '#b84c66', '#e3b23c', '#5b5b63'];
const BOTTOMS = ['#2b2f3a', '#3c3f46', '#1e2433', '#6b5a48', '#20232a', '#5d6470'];
const SKINS = ['#e8c4a8', '#d9a888', '#b98563', '#8a5a3c', '#f0d2bc', '#6b4228'];
const HAIRS = ['#2a1d14', '#4a3222', '#1a1a1a', '#8a6a42', '#c9b38a', '#6e6e6e'];

let mat = null;
export function crowdMaterial() {
  return (mat ||= new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8 }));
}

const col = (hex) => new THREE.Color(hex).toArray();

// 1 人の形（局所: 足もとが原点、-z が前）。pose: 'stand' | 'sit'
export function personGeometry(rnd, pose = 'stand') {
  const B = new Builder();
  const h = 0.92 + rnd() * 0.16; // 背の高さの倍率
  const top = col(TOPS[Math.floor(rnd() * TOPS.length)]), bottom = col(BOTTOMS[Math.floor(rnd() * BOTTOMS.length)]);
  const skin = col(SKINS[Math.floor(rnd() * SKINS.length)]), hair = col(HAIRS[Math.floor(rnd() * HAIRS.length)]), shoe = col('#18181a');
  const k = 'p';
  const sit = pose === 'sit';
  const hip = sit ? 0.45 : 0.86 * h;
  // 脚
  for (const x of [-0.1, 0.1]) {
    if (sit) {
      B.box(k, x, -0.2, hip - 0.07, hip + 0.07, 0, 1, 0.42, 0.15, { color: bottom });
      B.box(k, x, -0.4, 0.06, hip - 0.04, 0, 1, 0.13, 0.14, { color: bottom });
      B.box(k, x, -0.46, 0, 0.07, 0, 1, 0.26, 0.12, { color: shoe });
    } else {
      B.box(k, x, 0, 0.06, hip, 0, 1, 0.14, 0.15, { color: bottom });
      B.box(k, x, -0.05, 0, 0.07, 0, 1, 0.26, 0.12, { color: shoe });
    }
  }
  // 胴・腕・首・頭
  const t0 = hip, t1 = hip + 0.6 * h;
  B.box(k, 0, 0, t0 - 0.04, t1, 1, 0, 0.4 * (0.95 + rnd() * 0.12), 0.24, { color: top });
  for (const x of [-0.25, 0.25]) {
    if (sit) B.box(k, x, -0.12, t0 + 0.1, t1 - 0.04, 1, 0, 0.1, 0.3, { color: top });
    else B.box(k, x, 0, t1 - 0.62, t1 - 0.02, 1, 0, 0.1, 0.11, { color: top });
  }
  B.cyl(k, 0, 0, t1, t1 + 0.08, 0.06, { seg: 8, color: skin });
  // 頭（8 角形の柱を 2 段にして丸く）
  B.cyl(k, 0, 0, t1 + 0.08, t1 + 0.26, 0.105, { seg: 10, color: skin });
  B.box(k, 0, 0, t1 + 0.26, t1 + 0.3, 1, 0, 0.19, 0.2, { color: hair });
  B.box(k, 0, 0.03, t1 + 0.14, t1 + 0.28, 1, 0, 0.2, 0.17, { color: hair });
  // 鞄（ときどき）
  if (rnd() < 0.4) B.box(k, 0.28, 0.02, t0 - 0.1, t0 + 0.25, 1, 0, 0.08, 0.3, { color: col(['#3a2a20', '#1d1d1f', '#7a2b23'][Math.floor(rnd() * 3)]) });
  const g = B.writers.get(k).toGeometry();
  return g;
}

// 駅の人: ホームのドアの前で待つ人と、コンコースを歩く途中で立ち止まった人。nav: 駅の歩ける所（人の所は壁で囲む）
export function stationCrowd(plan, nav, seed = 1) {
  const rnd = mulberry32(seed);
  const parts = [];
  const place = (x, y, z, yaw, pose = 'stand') => {
    const g = personGeometry(rnd, pose);
    const m = new THREE.Matrix4().makeRotationY(-yaw).setPosition(x, y, z);
    g.applyMatrix4(m);
    parts.push(g);
    // 当たり判定（0.5 m 四方）
    const r = 0.25;
    nav.addWall(x - r, z - r, x + r, z - r, y - 0.2, y + 1.7);
    nav.addWall(x + r, z - r, x + r, z + r, y - 0.2, y + 1.7);
    nav.addWall(x + r, z + r, x - r, z + r, y - 0.2, y + 1.7);
    nav.addWall(x - r, z + r, x - r, z - r, y - 0.2, y + 1.7);
  };
  const WT = wallT(), P = LAYOUT.psd;
  for (const L of plan.lines) {
    const f = L.frame;
    for (const side of [1, -1]) {
      const n = 3 + Math.floor(rnd() * 5);
      const doors = L.doorsS;
      for (let i = 0; i < n; i++) {
        // ドアの脇（ドアの前はあける）
        const sd = doors[Math.floor(rnd() * doors.length)] + (rnd() < 0.5 ? -1 : 1) * (1.0 + rnd() * 0.6);
        const t = (P + 0.7 + rnd() * 1.6) * side;
        const [x, z] = f.at(sd, t);
        // ホームドアの方を向く（少しばらつき）
        const yaw = Math.atan2(-f.nx * side, f.nz * side) + (rnd() - 0.5) * 0.9;
        place(x, L.yp, z, yaw);
      }
      // ベンチに座る人
      if (rnd() < 0.7) {
        const s = -L.Lb + 4 + 11 * Math.floor(rnd() * 2) + (rnd() - 0.5) * 1.0;
        const w = plan.wells.find((q) => q.line === L.line && q.side === side);
        if (!(s > Math.min(w.s0, w.s1) - 2.5 && s < Math.max(w.s0, w.s1) + 2.5)) {
          const [x, z] = f.at(s, (WT - 0.42) * side);
          place(x, L.yp, z, Math.atan2(-f.nx * side, f.nz * side), 'sit');
        }
      }
    }
  }
  // 改札の外のホール（床があり、出入口の扉の前・改札の前でない所）
  const halls = plan.rects.filter((r) => r.kind === 'unpaid');
  const onHall = (x, z) => {
    let ok = false;
    nav.floors(x, z, (y, reg) => {
      if (reg.kind === 'hall' && Math.abs(y - plan.ym) < 0.01) ok = true;
    });
    return ok;
  };
  const doors = plan.direct.map((e) => entranceDoor(e));
  let want = 3 + Math.floor(rnd() * 3);
  for (let tries = 0; want > 0 && tries < 80 && halls.length; tries++) {
    const r = halls[Math.floor(rnd() * halls.length)];
    const s = r.s0 + 1.2 + rnd() * Math.max(0, r.s1 - r.s0 - 2.4), t = r.t0 + 1.2 + rnd() * Math.max(0, r.t1 - r.t0 - 2.4);
    const [x, z] = r.frame.at(s, t);
    if (plan.hall?.two && Math.hypot(s, t) < 1.6) continue;
    if (![[0, 0], [1.2, 0], [-1.2, 0], [0, 1.2], [0, -1.2]].every(([dx, dz]) => onHall(x + dx, z + dz))) continue;
    if (doors.some((d) => Math.hypot(x - d.x - d.dx * 1.5, z - d.z - d.dz * 1.5) < 2.6)) continue;
    if (plan.gates.some((g) => Math.abs(g.frame.local(x, z)[0] - g.s) < 2)) continue;
    place(x, plan.ym, z, rnd() * Math.PI * 2);
    want--;
  }
  if (!parts.length) return null;
  const mesh = new THREE.Mesh(mergeGeometries(parts), crowdMaterial());
  mesh.name = 'crowd';
  for (const g of parts) g.dispose();
  return mesh;
}

// 車両の座っている人（車体の局所座標。seats: [{ x, z, dir }]）
export function carPassengers(seats, seed) {
  const rnd = mulberry32(seed);
  const parts = [];
  for (const s of seats) {
    if (rnd() > 0.32) continue;
    const g = personGeometry(rnd, 'sit');
    // 座席の向き dir（+1 で +x を向く）。人の前は -z なので、+x を向くには yaw = π/2
    const m = new THREE.Matrix4().makeRotationY(s.dir > 0 ? -Math.PI / 2 : Math.PI / 2).setPosition(s.x + s.dir * 0.05, 0, s.z);
    g.applyMatrix4(m);
    parts.push(g);
  }
  if (!parts.length) return null;
  const mesh = new THREE.Mesh(mergeGeometries(parts), crowdMaterial());
  mesh.name = 'passengers';
  for (const g of parts) g.dispose();
  return mesh;
}

export { doorOffsets };
