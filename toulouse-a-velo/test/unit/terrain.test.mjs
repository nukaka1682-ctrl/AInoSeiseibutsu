import test from 'node:test';
import assert from 'node:assert/strict';
import { DATUM, FLAT_TERRAIN, LATTICE, Terrain, decodeTerrain, encodeTerrain, surfaceFns } from '../../src/world/terrain.js';
import { deckProfile, extendInto, latticeFor } from '../../src/data/terrainbake.js';
import { MeshWriter } from '../../src/world/meshwriter.js';
import { LocalProjection } from '../../src/geo.js';
import { Bike } from '../../src/game/bike.js';

// 原点のまわり ±600 m の合成の地形。elev(x, z): トゥールーズの座標での標高（m）
const TOULOUSE = new LocalProjection(LATTICE.lat, LATTICE.lon);
function synth(elev) {
  const [n, w] = TOULOUSE.unproject(-600, -600), [s, e] = TOULOUSE.unproject(600, 600);
  const g = latticeFor({ s, w, n, e });
  const data = new Float32Array(g.cols * g.rows);
  for (let r = 0; r < g.rows; r++) {
    for (let c = 0; c < g.cols; c++) {
      const [x, z] = TOULOUSE.project(g.lat - r * g.dLat, g.lon + c * g.dLon);
      data[r * g.cols + c] = elev(x, z);
    }
  }
  return { near: { ...g, data } };
}
const slope = synth((x, z) => DATUM + 0.05 * x + 0.02 * z);
const ridge = synth((x) => DATUM + 4 * Math.sin(x / 9) + 0.06 * x);

test('地形: 平面の格子は平面のまま（y = 標高 − 145）', () => {
  const T = new Terrain(slope, TOULOUSE);
  for (const [x, z] of [[0, 0], [12.3, -7.7], [-250.1, 333.3], [401, 2]]) {
    assert.ok(Math.abs(T.h(x, z) - (0.05 * x + 0.02 * z)) < 1e-3, `(${x}, ${z})`);
  }
  const r = T.range([[0, 0], [20, 0], [20, 20], [0, 20]]);
  assert.ok(Math.abs(r.min) < 1e-3 && Math.abs(r.max - 1.4) < 1e-3);
  const n = T.normal(5, 5);
  assert.ok(n[0] < 0 && n[2] < 0 && n[1] > 0.99);
});

test('地形: 同じ緯度経度なら、どのエリアの座標でも同じ高さ（タイル・エリアの継ぎ目がない）', () => {
  const A = new Terrain(ridge, TOULOUSE);
  const P = new LocalProjection(43.6012, 1.4431); // 別のエリアの原点
  const B = new Terrain(ridge, P);
  for (const [x, z] of [[3.3, 4.4], [-120.7, 55.1], [250, -301.9]]) {
    const [bx, bz] = P.project(...TOULOUSE.unproject(x, z));
    assert.ok(Math.abs(A.h(x, z) - B.h(bx, bz)) < 1e-4);
  }
});

test('地形のファイル: 書いて読むと 1 cm 以内で同じ', async () => {
  const bytes = await encodeTerrain({ ...ridge, bridges: [{ name: 'x', a: [43.6, 1.44], b: [43.6, 1.441], y: [140, 141.5] }] });
  const back = await decodeTerrain(bytes);
  assert.equal(back.near.cols, ridge.near.cols);
  let worst = 0;
  for (let i = 0; i < back.near.data.length; i++) worst = Math.max(worst, Math.abs(back.near.data[i] - ridge.near.data[i]));
  assert.ok(worst <= 0.011, `誤差 ${worst}`);
  assert.deepEqual(back.bridges[0].y, [140, 141.5]);
});

test('MeshWriter: 地形に載せた長い面は、格子で切られて地面と同じ平面に載る', () => {
  const T = new Terrain(ridge, TOULOUSE);
  const w = new MeshWriter({ drape: T, lift: 0.05, tol: 0 });
  w.quad([-60, 0, -2], [60, 0, -2], [60, 0, 2], [-60, 0, 2], [0, 1, 0], [0, 0], [1, 0], [1, 1], [0, 1], [1, 1, 1]);
  assert.ok(w.pos.length / 9 > 40, '三角形が増える');
  for (let i = 0; i < w.pos.length; i += 9) {
    // 頂点も重心も地面の 5 cm 上（どの三角形も地面の 1 枚の三角形の中にある）
    for (let k = 0; k < 9; k += 3) assert.ok(Math.abs(w.pos[i + k + 1] - T.h(w.pos[i + k], w.pos[i + k + 2]) - 0.05) < 1e-4);
    const cx = (w.pos[i] + w.pos[i + 3] + w.pos[i + 6]) / 3, cz = (w.pos[i + 2] + w.pos[i + 5] + w.pos[i + 8]) / 3;
    const cy = (w.pos[i + 1] + w.pos[i + 4] + w.pos[i + 7]) / 3;
    assert.ok(Math.abs(cy - T.h(cx, cz) - 0.05) < 1e-3);
  }
  // 平らな地形（FLAT_TERRAIN）では今までと同じ
  const a = new MeshWriter({ drape: FLAT_TERRAIN, lift: 0.05 }), b = new MeshWriter();
  for (const m of [a, b]) m.quad([-60, 0.14, -2], [60, 0.14, -2], [60, 0.14, 2], [-60, 0.14, 2], [0, 1, 0], [0, 0], [1, 0], [1, 1], [0, 1], [1, 1, 1]);
  assert.deepEqual(a.pos, b.pos);
});

test('MeshWriter: 平面の坂では、許容差の中なら三角形を増やさない。yOffset は形を変えずに上げる', () => {
  const T = new Terrain(slope, TOULOUSE);
  const w = new MeshWriter({ drape: T, lift: 0.05, tol: 0.04 });
  w.quad([-60, 0, -2], [60, 0, -2], [60, 0, 2], [-60, 0, 2], [0, 1, 0], [0, 0], [1, 0], [1, 1], [0, 1], [1, 1, 1]);
  assert.equal(w.pos.length / 9, 2);
  const r = new MeshWriter();
  r.yOffset = 3;
  r.quad([0, 0, 0], [1, 0, 0], [1, 2, 0], [0, 2, 0], [0, 0, 1], [0, 0], [1, 0], [1, 1], [0, 1], [1, 1, 1]);
  assert.deepEqual([Math.min(...r.pos.filter((_, i) => i % 3 === 1)), Math.max(...r.pos.filter((_, i) => i % 3 === 1))], [3, 5]);
});

test('橋の上と下: 橋の面は、自転車の高さから届くときだけ', () => {
  const T = new Terrain(slope, TOULOUSE);
  T.setDecks([{ pts: [[0, 0], [100, 0]], y: [8, 9, 10], step: 50, half: 6 }]);
  const { surfaceY, rideY } = surfaceFns(T, () => 0.14);
  assert.ok(Math.abs(surfaceY(50, 0) - 9.08) < 1e-6); // 橋の上（車道の面 +0.08）
  assert.ok(Math.abs(surfaceY(50, 0, T.h(50, 0)) - (T.h(50, 0) + 0.14)) < 1e-6); // 下の地面を走っている
  assert.ok(Math.abs(rideY(50, 3) - 9.08) < 1e-6);
  assert.equal(T.deck(50, 9), null); // 橋の幅の外
  assert.equal(T.deck(-5, 0), null); // 橋の端の先
});

test('地形の事前計算: 水の所は岸から延ばす。橋面の縦断面は木・車の出っ張りを除く', () => {
  const N = NaN;
  const d = Float32Array.from([10, 10, 10, 10, N, N, 12, 12, 12]);
  extendInto(d, 3, 3);
  assert.ok(d.every((v) => v >= 10 && v <= 12));
  // 220 m の橋: 片側 +2 %、反対側 −3.7 % の山形。途中に木（+8 m）と車（+1.5 m、横 1 本だけ）
  const prof = (s) => (s < 90 ? 145.1 + 0.02 * s : 146.9 - 0.037 * (s - 90));
  const dsm = (x, z) => {
    let v = prof(x);
    if (x > 40 && x < 52) v += 8;
    if (x > 150 && x < 156 && Math.abs(z) < 1) v += 1.5;
    return v;
  };
  const y = deckProfile([[0, 0], [220, 0]], 8, dsm, 5);
  assert.equal(y.length, 45);
  for (let k = 0; k < y.length; k++) assert.ok(Math.abs(y[k] - prof(k * 5)) < 0.35, `${k * 5} m: ${y[k]}`);
});

test('自転車: 平らな道は約 30 km/h、5 % の上りは約 20 km/h、6 % の下りは惰性で約 40 km/h', () => {
  const world = { collision: { resolve: (x, z) => ({ x, z, hit: false }), blockedByWater: () => false, outOfBounds: () => false } };
  const run = (grade, throttle) => {
    const b = new Bike();
    b.speed = 5;
    for (let i = 0; i < 120 * 90; i++) {
      b.grade = grade;
      b.step(1 / 120, { throttle, brake: 0, steer: 0, sprint: false }, world);
    }
    return b.speed * 3.6;
  };
  const flat = run(0, 1), up = run(0.05, 1), down = run(-0.06, 0);
  assert.ok(flat > 27 && flat < 32, `平ら ${flat.toFixed(1)}`);
  assert.ok(up > 16 && up < 23, `上り ${up.toFixed(1)}`);
  assert.ok(down > 35 && down < 45, `下り ${down.toFixed(1)}`);
});
