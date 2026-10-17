import test from 'node:test';
import assert from 'node:assert/strict';
import { detectEntrances } from '../../src/data/metro.js';
import { clearEntrances, entranceCorners, entranceWalls, projectEntrances } from '../../src/world/metro.js';

// 0.5 m の格子（100 m 四方）。平らな 140 m の地面に、東西 12 m × 南北 4 m の吹き抜け（西の端 0 m から東の端 4 m まで下る）
function synthPit({ cx = 10, cz = -5, len = 12, wid = 4, drop = 4 } = {}) {
  const res = 0.5, N = 200, h = new Float32Array(N * N);
  for (let r = 0; r < N; r++) {
    for (let c = 0; c < N; c++) {
      const x = c * res - 50, z = r * res - 50, u = x - cx, v = z - cz;
      h[r * N + c] = 140 + 0.01 * x;
      if (Math.abs(u) <= len / 2 && Math.abs(v) <= wid / 2) h[r * N + c] -= Math.max(0.3, (drop * (u + len / 2)) / len);
    }
  }
  return { h, N, res };
}

test('メトロの出入口: 地形モデルの細長い吹き抜けの穴を見つけ、位置・大きさ・下りる向きを測る', () => {
  const { h, N, res } = synthPit();
  const found = detectEntrances(h, N, N, res);
  assert.equal(found.length, 1);
  const e = found[0];
  assert.ok(Math.abs(e.x - 10) < 0.8 && Math.abs(e.z + 5) < 0.8, `位置 ${e.x},${e.z}`);
  assert.ok(Math.abs(e.len - 12) < 1.5 && Math.abs(e.wid - 4) < 1, `大きさ ${e.len}×${e.wid}`);
  // 長い向きは東西（ang ≈ 0 か π）、下りる向きは東
  assert.ok(Math.abs(Math.sin(e.ang)) < 0.1);
  assert.ok(Math.cos(e.ang) * e.down > 0, '東へ下りる');
  assert.ok(e.depth > 3);
});

test('メトロの出入口: 浅いくぼみ・広すぎる穴・丸い穴は出入口にしない', () => {
  assert.equal(detectEntrances(synthPit({ drop: 0.8 }).h, 200, 200, 0.5).filter((e) => e.depth > 1.5).length, 0);
  const sq = synthPit({ len: 6, wid: 6, drop: 40 });
  assert.equal(detectEntrances(sq.h, sq.N, sq.N, sq.res).length, 0, '正方形の穴（中庭・植え込み）');
});

test('メトロの出入口: ローカル座標の長方形・当たり判定の 4 辺・腰壁と重なる塀を除く', () => {
  const proj = { project: (lat, lon) => [(lon - 1.44) * 80000, -(lat - 43.6) * 111000] };
  const [e] = projectEntrances([{ station: 'Test', lat: 43.6, lon: 1.44, len: 12, wid: 4, ang: 0, down: 1, depth: 4 }], proj);
  const P = entranceCorners(e).map((p) => p.map((v) => Math.round(v) + 0));
  assert.deepEqual(P, [[-6, -2], [6, -2], [6, 2], [-6, 2]]);
  const W = entranceWalls(e);
  assert.equal(W.length, 4);
  // 吹き抜けの縁の塀（実際の腰壁）は消え、離れた塀は残る
  const kept = clearEntrances([[-6, 2.3, 6, 2.3, 1], [-6, 20, 6, 20, 2]], [e]);
  assert.deepEqual(kept, [[-6, 20, 6, 20, 2]]);
});

test('メトロの出入口: 坂の途中の吹き抜けの穴は、周りの地面の傾きの面で埋める（段を作らない）', async () => {
  const { DATUM, LATTICE, Terrain } = await import('../../src/world/terrain.js');
  const { latticeFor } = await import('../../src/data/terrainbake.js');
  const { LocalProjection } = await import('../../src/geo.js');
  const { fillMetroPits, rimAt } = await import('../../src/world/metro.js');
  const P = new LocalProjection(LATTICE.lat, LATTICE.lon);
  const [n, w] = P.unproject(-200, -200), [s, e] = P.unproject(200, 200);
  const g = latticeFor({ s, w, n, e });
  const data = new Float32Array(g.cols * g.rows);
  const ground = (x, z) => DATUM + 0.04 * x; // 東へ 4 % の上り
  for (let r = 0; r < g.rows; r++) {
    for (let c = 0; c < g.cols; c++) {
      const [x, z] = P.project(g.lat - r * g.dLat, g.lon + c * g.dLon);
      data[r * g.cols + c] = ground(x, z) - (Math.abs(x) < 8 && Math.abs(z) < 3 ? 4 : 0);
    }
  }
  const T = new Terrain({ near: { ...g, data } }, P);
  const ent = [{ x: 0, z: 0, len: 14, wid: 5, ang: 0, down: 1, depth: 4 }];
  fillMetroPits(T, ent);
  for (const x of [-6, -2, 3, 6]) assert.ok(Math.abs(T.h(x, 0) - 0.04 * x) < 0.25, `穴の中 ${x}: ${T.h(x, 0)}`);
  assert.ok(Math.abs(rimAt(ent[0], 5, 0) - 0.2) < 0.05, '縁の高さは傾きの面');
});
