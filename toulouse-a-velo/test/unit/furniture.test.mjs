import * as THREE from 'three';
import test from 'node:test';
import assert from 'node:assert/strict';
import { BIKE_LANE, CAR_L, CAR_W, FurnitureSet, parkMode, buildFurniture, carColor, carGeometry, curbAt, furnitureMaterial, parkingStalls, planFurniture, ringSamples, rightSide, slotsAlong, FURNITURE_FAR } from '../../src/world/furniture.js';
import { RaisedIndex, planStreets, writeStreets } from '../../src/world/streets.js';
import { LocalProjection, pointInPolygon, ringBounds } from '../../src/geo.js';
import { historicCoreTest } from '../../src/config.js';
import { MeshWriter } from '../../src/world/meshwriter.js';

const road = (id, type, width, pts, extra = {}) => ({ id, type, name: extra.name || `Rue ${id}`, width, pts, nodeIds: pts.map((_, i) => id * 100 + i), bridge: false, tunnel: false, oneway: false, surface: '', sidewalk: '', ...extra });
const box = (x0, z0, x1, z1) => ({ outer: [[x0, z0], [x1, z0], [x1, z1], [x0, z1]], holes: [] });
const area = (id, type, x0, z0, x1, z1, name = '') => {
  const a = { id, type, name, tags: {}, ...box(x0, z0, x1, z1) };
  a.bounds = ringBounds(a.outer);
  a.area = (x1 - x0) * (z1 - z0);
  return a;
};

// 十字路: 東西の通り（tertiary 8 m: 両側に駐車）と南北の通り（secondary 5 m: 片側だけ）、東西の通りの北西側に広場
function town(old = () => false, extraRoads = [], clip = { minX: -200, minZ: -200, maxX: 200, maxZ: 200 }, extraAreas = []) {
  const roads = [
    road(1, 'tertiary', 8, [[-200, 0], [0, 0], [200, 0]]),
    road(2, 'secondary', 5, [[0, -200], [0, 0]]),
    road(3, 'secondary', 5, [[0, 0], [0, 200]]),
    ...extraRoads,
  ];
  const areas = [area(9, 'plaza', -90, 4.3, -30, 50, 'Place Test'), area(10, 'parking', 40, -80, 90, -40), ...extraAreas];
  const parsed = { roads, areas, rails: [] };
  const plan = planStreets(parsed, old);
  const raised = new RaisedIndex();
  const stats = writeStreets(parsed, plan, clip, { buildings: [box(10, 9, 60, 30)] }, () => new MeshWriter(), raised);
  return { parsed, plan, clip, raised, curbs: stats.curbs, opts: { parsed, plan, clip, curbs: stats.curbs, inOldTown: old, heightAt: (x, z) => raised.heightAt(x, z) } };
}

test('位置の計算: 道全体で決まる間隔、外周の点、縁石の補間', () => {
  const all = slotsAlong(0, 100, 27, 5).map((p) => p.s);
  assert.deepEqual(all, [5, 32, 59, 86]);
  // タイルの境で分けても同じ位置（k も同じ）
  const a = slotsAlong(0, 40, 27, 5), b = slotsAlong(40.01, 100, 27, 5);
  assert.deepEqual(a.concat(b).map((p) => p.k), slotsAlong(0, 100, 27, 5).map((p) => p.k));
  const ring = [[0, 0], [20, 0], [20, 10], [0, 10]];
  const pts = ringSamples(ring, 10, 1, 5);
  assert.equal(pts.length, 6);
  for (const p of pts) assert.ok(p.x > 0.5 && p.x < 19.5 && p.z > 0.5 && p.z < 9.5, `内側 ${p.x},${p.z}`);
  const rows = [{ s: 0, ax: 0, az: 4, cx: 0, cz: 4.2, nx: 0, nz: 1, e: 2 }, { s: 10, ax: 10, az: 4, cx: 10, cz: 4.2, nx: 0, nz: 1, e: 3 }];
  const p = curbAt(rows, 5);
  assert.equal(p.ax, 5);
  assert.equal(p.ux, 1);
  assert.equal(rightSide(p), true, '東向きの道の南（+z）の縁石は右側');
  assert.ok(['#e6e6e3', '#151618'].includes(carColor(0)) && carColor(0.999));
});

test('駐車場の区画: 車が駐車場の中に収まり、重ならない', () => {
  const a = area(1, 'parking', 0, 0, 40, 30);
  const st = parkingStalls(a);
  assert.ok(st.length >= 20, `${st.length} 区画`);
  for (const s of st) assert.ok(pointInPolygon(s.x, s.z, a));
  for (let i = 0; i < st.length; i++) for (let j = i + 1; j < st.length; j++) assert.ok(Math.hypot(st[i].x - st[j].x, st[i].z - st[j].z) >= 2.49);
});

test('小物の配置: 路上駐車は自転車の通る幅を残し、交差点をあけ、街灯は歩道の上', () => {
  const { opts, raised } = town();
  const out = planFurniture(opts);
  // 東西の通り（8 m）は両側、南北の通り（5 m）は片側だけ
  const ew = out.cars.filter((c) => Math.abs(c.z) < 4 && Math.abs(c.x) > 4);
  assert.ok(ew.some((c) => c.z > 0) && ew.some((c) => c.z < 0), '東西の通りの両側');
  const ns = out.cars.filter((c) => Math.abs(c.x) < 2.5 && Math.abs(c.z) > 4);
  assert.ok(ns.length > 0);
  assert.ok(ns.every((c) => c.x > 0) || ns.every((c) => c.x < 0), '南北の通りは片側だけ');
  for (const c of ew) {
    // 縁石（|z| = 4）から 15 cm あけて幅 1.8 m。残りの車道は 3 m 以上
    assert.ok(Math.abs(Math.abs(c.z) - (4 - 0.15 - CAR_W / 2)) < 1e-6);
    assert.ok(Math.hypot(c.x, c.z) > 11, `交差点の近く ${c.x},${c.z}`);
  }
  assert.ok(8 - 2 * (0.15 + CAR_W) >= BIKE_LANE && 5 - (0.15 + CAR_W) >= BIKE_LANE);
  // 車の向きは通りに沿う（右側の車は進む向き）
  for (const c of ew) assert.ok(Math.abs(Math.sin(c.a)) < 1e-6);
  // 街灯は一段高い歩道の上、車道の外
  assert.ok(out.lights.length > 6);
  for (const l of out.lights) {
    assert.ok(raised.heightAt(l.x, l.z) > 0 && l.y > 0, `街灯 ${l.x},${l.z}`);
    assert.ok(Math.abs(l.z) > 4.2 || Math.abs(l.x) > 2.7);
  }
  // 広場に接する縁石（x = -90〜-30 の北側）に花崗岩の車止めが 1.4 m おき
  const bol = out.bollards.filter((b) => b.z > 4 && b.x > -88 && b.x < -32).sort((a, b) => a.x - b.x);
  assert.ok(bol.length > 30, `${bol.length} 本`);
  for (let i = 1; i < bol.length; i++) assert.ok(Math.abs(bol[i].x - bol[i - 1].x - 1.4) < 0.05);
  // 駐車場の車と、当たり判定（車は箱、ほかは円）
  assert.ok(out.cars.some((c) => c.x > 40 && c.z < -40));
  assert.equal(out.colliders.filter((c) => c.hl).length, out.cars.length + out.containers.length);
  // 旧市街では路上駐車も灰色の街灯もない
  const old = planFurniture(town(() => true).opts);
  assert.equal(old.lights.length, 0);
  assert.equal(old.cars.filter((c) => Math.abs(c.z) < 4 || Math.abs(c.x) < 2.5).length, 0);
});

test('狭い住宅街の通り（4 m）は片側に歩道へ半分乗り上げて駐車。狭い tertiary には止めない', () => {
  assert.equal(parkMode({ type: 'residential', width: 4 }, 2), 'kerb');
  assert.equal(parkMode({ type: 'residential', width: 4 }, 1.2), null, '歩道が狭い');
  assert.equal(parkMode({ type: 'tertiary', width: 4 }, 2), null);
  assert.equal(parkMode({ type: 'residential', width: 3.5 }, 2), null, '自転車の通る幅が残らない');
  assert.equal(parkMode({ type: 'residential', width: 5 }, 2), 'one');
  assert.equal(parkMode({ type: 'tertiary', width: 8.5 }, 2), 'both');
  assert.equal(parkMode({ type: 'service', width: 8 }, 2), null);
  const narrow = road(4, 'residential', 4, [[-200, 100], [200, 100]]);
  const { opts, raised } = town(() => false, [narrow]);
  const out = planFurniture(opts);
  const cars = out.cars.filter((c) => Math.abs(c.z - 100) < 3);
  assert.ok(cars.length > 20, `${cars.length} 台`);
  const side = Math.sign(cars[0].z - 100);
  for (const c of cars) {
    assert.equal(Math.sign(c.z - 100), side, '片側だけ');
    // 車道（幅 4 m）のうち車がふさぐのは 1 m 未満。残りは BIKE_LANE 以上
    const inner = Math.abs(c.z - 100) - CAR_W / 2;
    assert.ok(2 - inner <= 4 - BIKE_LANE + 1e-6, `${c.z}`);
    // 歩道側の車輪は歩道の上: 歩道側が上がるように傾け、少し持ち上げる
    assert.ok(c.y > 0.03 && Math.abs(c.roll) > 0.03);
  }
  // 傾きの向き: 行列で歩道側の角が高くなる
  const set = buildFurniture(opts);
  set.cull(0, 100, true);
  const mesh = set.group.children.find((m) => m.name === 'cars');
  const k = out.cars.indexOf(cars[0]);
  const M = new THREE.Matrix4().fromArray(mesh.instanceMatrix.array, out.cars.slice(0, k).filter((c) => Math.hypot(c.x, c.z - 100) <= FURNITURE_FAR).length * 16);
  const hi = new THREE.Vector3(0, 0, 0.8).applyMatrix4(M), lo = new THREE.Vector3(0, 0, -0.8).applyMatrix4(M);
  const [kerbSide, roadSide] = Math.sign(hi.z - 100) === side ? [hi, lo] : [lo, hi];
  assert.ok(kerbSide.y > roadSide.y + 0.05, `${kerbSide.y} ${roadSide.y}`);
  assert.ok(raised.heightAt(kerbSide.x, kerbSide.z) > 0.05 && raised.heightAt(roadSide.x, roadSide.z) < 0.02);
});

test('旧市街の小物は右岸の歴史的な中心だけ（Place Olivier・Château d\'eau は外と同じ）', () => {
  const core = historicCoreTest(new LocalProjection(43.5994, 1.4395));
  assert.equal(core(-407, 130), false, 'Place Olivier');
  assert.equal(core(-215, 40), false, 'Château d\'eau');
  assert.equal(core(-600, 200), false, 'Saint-Cyprien');
  assert.equal(core(300, -530), true, 'Capitole');
  assert.equal(core(-200, -470), true, 'Place Saint-Pierre');
  assert.equal(core(1500, -530), false, '旧市街の外');
});

test('広場の車止め: 広場の下を通る道は使わず、広場の縁の車道に沿って立てる', () => {
  // 広場の真ん中を通る車道（広場の舗装に隠れる）
  const under = road(5, 'residential', 5, [[-150, 30], [-10, 30]]);
  const { opts } = town(() => false, [under]);
  const out = planFurniture(opts);
  const inPlaza = out.bollards.filter((b) => b.x > -88 && b.x < -32 && b.z > 6 && b.z < 48);
  assert.equal(inPlaza.length, 0, inPlaza.map((b) => `${b.x.toFixed(1)},${b.z.toFixed(1)}`).join(' '));
  assert.ok(out.bollards.filter((b) => b.z > 4 && b.z < 6 && b.x > -88 && b.x < -32).length > 30, '東西の通りの縁');
});

test('タイルの境: 2 つの範囲に分けて作っても、街灯は同じ所に同じ数', () => {
  const key = (l) => `${l.x.toFixed(2)},${l.z.toFixed(2)}`;
  const full = planFurniture(town().opts).lights.filter((l) => l.x < -20).map(key).sort();
  const a = planFurniture(town(() => false, [], { minX: -200, minZ: -200, maxX: -100, maxZ: 200 }).opts).lights;
  const b = planFurniture(town(() => false, [], { minX: -100, minZ: -200, maxX: 200, maxZ: 200 }).opts).lights;
  const both = a.concat(b).filter((l) => l.x < -20).map(key).sort();
  assert.deepEqual(both, full);
});

test('小物のメッシュ: 種類ごとに 1 つの InstancedMesh、近い物だけ描く', () => {
  const { opts } = town();
  const cw = { circles: 0, rings: 0, addCircle() { this.circles++; }, addRing() { this.rings++; } };
  const set = buildFurniture(opts, cw);
  assert.ok(set.group.children.length >= 4 && set.group.children.length <= 7);
  assert.equal(cw.rings, set.stats.cars + set.stats.containers);
  set.cull(0, 0, true);
  const cars = set.group.children.find((m) => m.name === 'cars');
  assert.ok(cars.isInstancedMesh && cars.count === set.stats.cars && cars.visible);
  // 視錐台カリングの球は描く物だけを囲む（自転車のまわり FURNITURE_FAR m の球ではない）
  set.cull(250, 0, true);
  const sp = cars.boundingSphere;
  assert.ok(cars.count > 0 && cars.count < set.stats.cars);
  assert.ok(sp.radius < 260, `${sp.radius}`);
  const tmp = new THREE.Matrix4(), v = new THREE.Vector3();
  for (let i = 0; i < cars.count; i++) assert.ok(v.setFromMatrixPosition(tmp.fromArray(cars.instanceMatrix.array, i * 16)).distanceTo(sp.center) <= sp.radius);
  set.cull(0, FURNITURE_FAR + 300, true);
  assert.ok(set.group.children.every((m) => m.count === 0 && !m.visible), '遠くでは描かない');
  set.cull(0, FURNITURE_FAR + 305);
  assert.equal(cars.count, 0);
  // 車の形: 約 120 三角形、長さ 4.2 m、塗装の印
  const g = carGeometry();
  const n = g.getAttribute('position').count / 3;
  assert.ok(n > 80 && n < 160, `${n} 三角形`);
  g.computeBoundingBox();
  assert.ok(Math.abs(g.boundingBox.max.x - g.boundingBox.min.x - CAR_L) < 0.1);
  assert.ok(g.getAttribute('paint') && !g.getAttribute('uv'));
  assert.ok(furnitureMaterial().vertexColors);
  const fs = new FurnitureSet();
  fs.add('x', carGeometry(), furnitureMaterial(), []);
  assert.equal(fs.group.children.length, 0);
});
