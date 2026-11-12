// 街のにぎわい（歩く人・カフェの客・ハト）の計算（src/game/lifelogic.js）と、RoadNetwork.onRoad の filter
import test from 'node:test';
import assert from 'node:assert/strict';
import { dodge, inBellCone, newPigeon, pigeonStep, respawnPoint, seatHash, terraceSeats } from '../../src/game/lifelogic.js';
import { RoadNetwork } from '../../src/game/roadnet.js';
import { CAR_ROADS } from '../../src/world/parse.js';
import { mulberry32 } from '../../src/geo.js';

const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

test('よける: 自転車の進む線から離れる側へ 1.6 m', () => {
  // 自転車は (0, 0) から北（-z）へ 5 m/s。人は 4 m 前・0.5 m 右（+x）
  const r = dodge({ px: 0.5, pz: -4, bx: 0, bz: 0, heading: 0, speed: 5 });
  assert.ok(r);
  assert.ok(near(r.x, 2.1) && near(r.z, -4), JSON.stringify(r));
  // 左（-x）にいれば左へ
  const l = dodge({ px: -0.4, pz: -4, bx: 0, bz: 0, heading: 0, speed: 5 });
  assert.ok(near(l.x, -2.0), JSON.stringify(l));
  // 東（heading = 90°）へ走る自転車の 0.3 m 南にいる人は、さらに南へ
  const e = dodge({ px: 5, pz: 0.3, bx: 0, bz: 0, heading: Math.PI / 2, speed: 4 });
  assert.ok(near(e.x, 5) && near(e.z, 1.9), JSON.stringify(e));
});

test('よけない: 遠ざかる・遅い・遠い・線から離れている自転車', () => {
  assert.equal(dodge({ px: 0, pz: 4, bx: 0, bz: 0, heading: 0, speed: 5 }), null); // 人は後ろ（遠ざかる）
  assert.equal(dodge({ px: 0, pz: -4, bx: 0, bz: 0, heading: 0, speed: 0.5 }), null); // 近づく速さが 1 m/s 未満
  assert.equal(dodge({ px: 0, pz: -9, bx: 0, bz: 0, heading: 0, speed: 8 }), null); // 7 m より遠い
  assert.equal(dodge({ px: 2, pz: -4, bx: 0, bz: 0, heading: 0, speed: 8 }), null); // 1.3 m 以上横を通る
  // 後退している自転車には、後ろの人がよける
  assert.ok(dodge({ px: 0.2, pz: 3, bx: 0, bz: 0, heading: 0, speed: -2 }));
  // force（ベル）なら距離・速さの条件なしで向きだけ決める
  const f = dodge({ px: -3, pz: -15, bx: 0, bz: 0, heading: 0, speed: 0, force: true });
  assert.ok(near(f.x, -4.6), JSON.stringify(f));
});

test('ベルの扇形: 前 20 m・左右 60°', () => {
  const b = { bx: 0, bz: 0, heading: 0 };
  assert.ok(inBellCone({ ...b, px: 0, pz: -10 }));
  assert.ok(inBellCone({ ...b, px: 8, pz: -10 })); // 約 39°
  assert.ok(!inBellCone({ ...b, px: 10, pz: -2 })); // 約 79°
  assert.ok(!inBellCone({ ...b, px: 0, pz: 5 })); // 後ろ
  assert.ok(!inBellCone({ ...b, px: 0, pz: -21 })); // 遠い
});

test('テラスの席: 局所 (±0.75, ±0.62) が向き a で回り、椅子はテーブルを向く', () => {
  const s0 = terraceSeats({ x: 10, y: 2, z: 20, a: 0 });
  assert.equal(s0.length, 4);
  assert.ok(s0.every((s) => near(s.y, 2.46)));
  assert.deepEqual(s0.map((s) => [+(s.x - 10).toFixed(2), +(s.z - 20).toFixed(2)]), [[-0.75, -0.62], [-0.75, 0.62], [0.75, -0.62], [0.75, 0.62]]);
  // 椅子の向き: 前（-z を yaw で回した向き）がテーブルの中心線（局所 z = 0）へ
  for (const s of s0) assert.ok(-Math.cos(s.yaw) * (s.z - 20) < 0);
  // 90° 回すと、局所の +x は -z へ、局所の +z は +x へ（three.js の Y 軸まわりの回転）
  const s1 = terraceSeats({ x: 0, y: 0, z: 0, a: Math.PI / 2 });
  assert.ok(near(s1[3].x, 0.62, 1e-9) && near(s1[3].z, -0.75, 1e-9), JSON.stringify(s1[3]));
  for (const s of s1) {
    const fx = -Math.sin(s.yaw), fz = -Math.cos(s.yaw); // 座る人の前
    assert.ok(fx * s.x + fz * s.z < 0, '前はテーブル（テラスの中心）の側');
  }
});

test('席のハッシュ: 決まった値で 0〜1、場所・番号で変わる', () => {
  const a = seatHash(123.4, -56.7, 2);
  assert.equal(a, seatHash(123.4, -56.7, 2));
  assert.notEqual(a, seatHash(123.4, -56.7, 3));
  assert.notEqual(a, seatHash(123.5, -56.7, 2));
  let lo = 0, n = 0;
  for (let i = 0; i < 2000; i++) {
    const v = seatHash(i * 3.7, -i * 1.3, i % 4);
    assert.ok(v >= 0 && v < 1);
    if (v < 0.55) lo++;
    n++;
  }
  assert.ok(Math.abs(lo / n - 0.55) < 0.05, `0.55 未満の割合 ${lo / n}`);
});

test('置き直す点: 自転車から 45〜radius m の輪の中で、7 割が前側', () => {
  const rnd = mulberry32(5), bike = { x: 100, z: -50, heading: 1.0 };
  let front = 0;
  const N = 3000;
  for (let i = 0; i < N; i++) {
    const p = respawnPoint(rnd, bike, 110);
    const dx = p.x - bike.x, dz = p.z - bike.z, d = Math.hypot(dx, dz);
    assert.ok(d >= 45 - 1e-9 && d <= 110 + 1e-9, `d=${d}`);
    const cos = (Math.sin(bike.heading) * dx - Math.cos(bike.heading) * dz) / d;
    if (cos >= Math.cos((100 * Math.PI) / 180) - 1e-9) front++;
  }
  assert.ok(Math.abs(front / N - 0.7) < 0.04, `前側 ${front / N}`);
});

test('ハト: 脅かされると飛び立ち、時間がたつと地面に戻る', () => {
  const flock = { x: 0, z: 0, R: 15, dir: 1, rnd: mulberry32(3) };
  const birds = Array.from({ length: 8 }, () => newPigeon(flock));
  const dt = 1 / 30;
  // 地面: 群れの中心から 3.5 m の中をちょこちょこ歩く
  for (let t = 0; t < 20; t += dt) for (const b of birds) pigeonStep(b, flock, dt);
  assert.ok(birds.every((b) => b.state === 'ground' && b.h === 0 && Math.hypot(b.x, b.z) < 3.5 + 0.5));
  // 脅かす: 0.4 秒以内に全部が飛ぶ
  flock.cx = 0;
  flock.cz = 0;
  flock.x = 6; // 下りる所
  for (const b of birds) pigeonStep(b, flock, dt, { scare: true });
  for (let t = 0; t < 0.5; t += dt) for (const b of birds) pigeonStep(b, flock, dt);
  assert.ok(birds.every((b) => b.state === 'fly'), birds.map((b) => b.state).join());
  for (let t = 0; t < 3; t += dt) for (const b of birds) pigeonStep(b, flock, dt);
  assert.ok(birds.every((b) => b.h >= 4 && Math.abs(Math.hypot(b.x, b.z) - b.R) < 0.5), '円を回っている');
  // 自転車が近くに居続けると、下りない
  for (let t = 0; t < 12; t += dt) for (const b of birds) pigeonStep(b, flock, dt, { near: true });
  assert.ok(birds.every((b) => b.state === 'fly'));
  // 離れると下りて、下りる所のそばの地面に戻る
  for (let t = 0; t < 30; t += dt) for (const b of birds) pigeonStep(b, flock, dt);
  assert.ok(birds.every((b) => b.state === 'ground' && b.h === 0), birds.map((b) => b.state).join());
  assert.ok(birds.every((b) => Math.hypot(b.x - 6, b.z) < 3.5 + 0.5));
});

test('RoadNetwork.onRoad: filter で車道だけを数える', () => {
  const road = (id, type, width, pts) => ({ id, type, width, pts, nodeIds: pts.map((_, i) => id * 100 + i), name: '' });
  const net = new RoadNetwork([road(1, 'residential', 8, [[0, 0], [100, 0]]), road(2, 'pedestrian', 10, [[0, 30], [100, 30]])]);
  const car = (s) => CAR_ROADS.has(s.road.type);
  assert.ok(net.onRoad(50, 1));
  assert.ok(net.onRoad(50, 31));
  assert.ok(net.onRoad(50, 1, 0.8, car));
  assert.ok(!net.onRoad(50, 31, 0.8, car)); // 歩行者の道は数えない
  assert.ok(!net.onRoad(50, 3.9, -0.3, car)); // 車道の縁から 0.3 m 内側より外
  assert.ok(net.onRoad(50, 3.6, -0.3, car));
});
