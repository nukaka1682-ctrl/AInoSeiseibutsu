// 駅と電車の人（動かない。立って電車を待つ人・座っている人）。人ごとに服の色・背の高さを変え、
// 駅ごと・車両ごとに 1 つの形にまとめて描く（描く回数を増やさない）
import * as THREE from 'three';
import { entranceDoor } from '../world/metro.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { personGeometry } from './people.js';
import { LAYOUT, doorOffsets, wallT } from './network.js';
import { mulberry32 } from '../geo.js';

let mat = null;
export function crowdMaterial() {
  return (mat ||= new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.78 }));
}

export { personGeometry };

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
  if (plan.layout === 'aerial') {
    // 高架の駅: ホームドアの脇で待つ人（階段の吹き抜けの内側の通り道）と、切符売り場の人
    for (const L of plan.lines) {
      const f = L.frame;
      for (const side of [1, -1]) {
        const n = 3 + Math.floor(rnd() * 4);
        for (let i = 0; i < n; i++) {
          const sd = L.doorsS[Math.floor(rnd() * L.doorsS.length)] + (rnd() < 0.5 ? -1 : 1) * (1.0 + rnd() * 0.6);
          const [x, z] = f.at(sd, (LAYOUT.psd + 0.6 + rnd() * 0.9) * side);
          place(x, L.yp, z, Math.atan2(-f.nx * side, f.nz * side) + (rnd() - 0.5) * 0.9);
        }
      }
    }
    for (let i = 0; i < 4; i++) {
      const [x, z] = plan.U(-14 + rnd() * 7, (rnd() - 0.5) * 9);
      place(x, plan.ym, z, rnd() * Math.PI * 2);
    }
    return finish(parts);
  }
  if (plan.layout === 'osm') {
    osmCrowd(plan, nav, rnd, place);
    return finish(parts);
  }
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
  return finish(parts);
}

function finish(parts) {
  if (!parts.length) return null;
  const mesh = new THREE.Mesh(mergeGeometries(parts), crowdMaterial());
  mesh.name = 'crowd';
  for (const g of parts) g.dispose();
  return mesh;
}

// OSM の間取りの駅（osmplan.js）: ホームドアの脇で待つ人（島式のホームは軸の側）と、改札の階で立ち止まった人
function osmCrowd(plan, nav, rnd, place) {
  const floorKind = (x, z, y) => {
    let k = null;
    nav.floors(x, z, (fy, reg) => {
      if (Math.abs(fy - y) < 0.05) k = reg.kind;
    });
    return k;
  };
  const clear = (x, z, y, kind) => [[0, 0], [0.6, 0], [-0.6, 0], [0, 0.6], [0, -0.6]].every(([dx, dz]) => floorKind(x + dx, z + dz, y) === kind);
  for (const L of plan.lines) {
    const f = L.frame;
    for (const side of [1, -1]) {
      const inward = L.island ? -side : side;
      const n = 3 + Math.floor(rnd() * 5);
      for (let i = 0, tries = 0; i < n && tries < 40; tries++) {
        const sd = L.doorsS[Math.floor(rnd() * L.doorsS.length)] + (rnd() < 0.5 ? -1 : 1) * (1.0 + rnd() * 0.6);
        const t = (L.P + inward * (0.7 + rnd() * 1.6) * side) * side;
        const [x, z] = f.at(sd, t);
        if (!clear(x, z, L.yp, 'platform')) continue;
        place(x, L.yp, z, Math.atan2(-f.nx * inward, f.nz * inward) + (rnd() - 0.5) * 0.9);
        i++;
      }
    }
  }
  const lv = plan.ticket != null ? plan.levels.get(plan.ticket) : null;
  if (!lv || !lv.floor.length) return;
  const pts = lv.floor.flatMap((pg) => pg[0]);
  const x0 = Math.min(...pts.map((q) => q[0])), x1 = Math.max(...pts.map((q) => q[0])), z0 = Math.min(...pts.map((q) => q[1])), z1 = Math.max(...pts.map((q) => q[1]));
  let want = 3 + Math.floor(rnd() * 3);
  for (let tries = 0; want > 0 && tries < 120; tries++) {
    const x = x0 + rnd() * (x1 - x0), z = z0 + rnd() * (z1 - z0);
    if (!clear(x, z, lv.y, 'hall')) continue;
    if (plan.pitInfo.some((p) => Math.hypot(x - p.d.x - p.d.dx * 1.5, z - p.d.z - p.d.dz * 1.5) < 2.8)) continue;
    if (plan.gates.some((g) => Math.abs(g.frame.local(x, z)[0]) < 2.2)) continue;
    if (plan.blocks.some((b) => {
      const [s, t] = b.frame.local(x, z);
      return Math.abs(t) < b.W / 2 + 1.5 && s > -4.5 && s < b.len + 4.5;
    })) continue;
    place(x, lv.y, z, rnd() * Math.PI * 2);
    want--;
  }
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
