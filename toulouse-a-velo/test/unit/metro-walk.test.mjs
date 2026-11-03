import test from 'node:test';

// キャンバスのない Node で車両の材質（文字の板）を作れるように、何もしないキャンバスを置く
if (typeof globalThis.document === 'undefined') {
  const ctx = new Proxy({}, {
    get: (o, k) => (k in o ? o[k] : k === 'measureText' ? () => ({ width: 0 }) : k === 'createRadialGradient' || k === 'createLinearGradient' ? () => ({ addColorStop() {} }) : () => {}),
    set: (o, k, v) => ((o[k] = v), true),
  });
  globalThis.document = { createElement: () => ({ width: 0, height: 0, getContext: () => ctx }) };
}
import assert from 'node:assert/strict';
import { Nav, NavLayer, rectPoly, stairHeight } from '../../src/metro/nav.js';
import { Walker } from '../../src/metro/walker.js';
import { Train } from '../../src/metro/train.js';
import { LocalProjection } from '../../src/geo.js';
import { LAYOUT, buildNetwork, trackAt } from '../../src/metro/network.js';

const at = (s, t) => [s, t];
const fwd = { fwd: 1, side: 0, run: false };
// 北（-z）へ向かって歩く（viewYaw = 0）
const walk = (w, nav, sec, ctl = fwd, yaw = 0) => {
  for (let t = 0; t < sec; t += 1 / 30) w.update(1 / 30, ctl, nav, yaw);
};

test('歩く人: 段差を上り下りし、床のない所（ホームの縁・吹き抜け）へは進まない', () => {
  const L = new NavLayer('t');
  // 下の床（z 0..-10、高さ 0）→ 階段（z -10..-16、高さ 0 → 3.3。20 段）→ 上の床（z -16..-30、高さ 3.3）
  L.addRegion(rectPoly(at, -2, 2, 0, -10), 0);
  L.addRegion(rectPoly(at, -2, 2, -10, -16), (x, z) => stairHeight(-z, 10, 16, 0, 3.3, 20));
  L.addRegion(rectPoly(at, -2, 2, -16, -30), 3.3);
  L.addWall(-2, 0, -2, -30, -1, 5);
  L.addWall(2, 0, 2, -30, -1, 5);
  const nav = new Nav();
  nav.add(L);
  const w = new Walker();
  w.place(0, 0, -1, 0);
  walk(w, nav, 14);
  assert.ok(w.z < -17 && Math.abs(w.y - 3.3) < 1e-6, `上の床へ (z=${w.z.toFixed(1)}, y=${w.y.toFixed(2)})`);
  // 床の端（z = -30）の先には出ない
  walk(w, nav, 20);
  assert.ok(w.z >= -30.01, `端で止まる z=${w.z.toFixed(2)}`);
  // 壁を越えない（東へ）
  walk(w, nav, 5, fwd, Math.PI / 2);
  assert.ok(w.x <= 2 - 0.2, `壁の手前 x=${w.x.toFixed(2)}`);
  // 走ると速い
  const w2 = new Walker();
  w2.place(0, 0, -1, 0);
  walk(w2, nav, 2, { fwd: 1, side: 0, run: true });
  assert.ok(w2.z < -4.5, `走る z=${w2.z.toFixed(2)}`);
});

test('電車: 扉が閉まっていれば出られず、開けば出られる。走る電車の中の人は電車と一緒に動く', () => {
  const net = buildNetwork(new LocalProjection(43.5994, 1.4395));
  const path = net.lines.B, s0 = path.stations[3];
  const t = new Train('B', 2, 1);
  t.place(path, s0.S.B);
  const nav = new Nav();
  for (const c of t.cars) nav.add(c.nav);
  // ホーム（進む向きの右、ホームドアの線から 5 m）
  const plat = new NavLayer('plat');
  const p = trackAt(path, s0.S.B, 1);
  const rx = -p.fz, rz = p.fx;
  const P = (s, tt) => [p.x - rx * LAYOUT.trackOff + p.fx * s + rx * tt, p.z - rz * LAYOUT.trackOff + p.fz * s + rz * tt];
  plat.addRegion([P(-30, LAYOUT.psd), P(30, LAYOUT.psd), P(30, LAYOUT.psd + 5), P(-30, LAYOUT.psd + 5)], p.y);
  nav.add(plat);
  const car = t.cars[0], cp = car.pose;
  const w = new Walker();
  // 扉（局所 x = 0）の前、車内の真ん中
  w.place(cp.x, cp.y, cp.z, 0);
  const yawRight = Math.atan2(-cp.fz, -cp.fx) + Math.PI; // 進む向きの右
  const right = (sec) => walk(w, nav, sec, fwd, Math.atan2(rx, -rz));
  void yawRight;
  right(3);
  const lat = (w.x - cp.x) * rx + (w.z - cp.z) * rz;
  assert.ok(lat < 1.0, `扉が閉まっていると車内にとどまる (${lat.toFixed(2)})`);
  t.setDoors(1);
  right(4);
  const lat2 = (w.x - cp.x) * rx + (w.z - cp.z) * rz;
  assert.ok(lat2 > 2.5 && !w.region.layer.pose, `扉が開くとホームへ (${lat2.toFixed(2)})`);
  // 乗り直して、電車を 100 m 進める: 人も 100 m 運ばれる
  t.setDoors(1);
  w.place(cp.x, cp.y, cp.z, 0);
  walk(w, nav, 0.1, { fwd: 0, side: 0 });
  assert.ok(w.region?.layer?.pose, '車内');
  const x0 = w.x, z0 = w.z;
  t.setDoors(0);
  for (let k = 1; k <= 50; k++) {
    t.place(path, s0.S.B + k * 2);
    walk(w, nav, 1 / 30, { fwd: 0, side: 0 });
  }
  const moved = Math.hypot(w.x - x0, w.z - z0);
  assert.ok(Math.abs(moved - 100) < 3, `電車と一緒に ${moved.toFixed(1)} m`);
  assert.ok(w.region?.layer?.pose, 'まだ車内');
});
