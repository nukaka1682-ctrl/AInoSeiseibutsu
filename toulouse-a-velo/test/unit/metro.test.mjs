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

test('地下駐車場の車の坂: 駐車場の近くの長くてなだらかな穴だけ。急な吹き抜け・遠い穴はメトロの出入口のまま', async () => {
  const { isParkingRamp } = await import('../../src/data/metro.js');
  const ramp = { len: 26, wid: 11, depth: 4.6 }; // なだらかな坂（18 %）
  assert.ok(isParkingRamp(ramp, 60));
  assert.ok(!isParkingRamp(ramp, 170), '駐車場から遠い');
  assert.ok(isParkingRamp({ len: 27, wid: 16, depth: 8.8 }, 3), 'キャピトル広場の坂（駐車場の印の上。幅が広く奥が深い）');
  assert.ok(!isParkingRamp({ len: 27, wid: 16, depth: 8.8 }, 60), '印から離れた幅の広い急な穴');
  assert.ok(!isParkingRamp({ len: 12, wid: 6, depth: 6.9 }, 10), '急な階段の吹き抜け（エスキロル）');
  assert.ok(!isParkingRamp({ len: 8, wid: 4, depth: 1.5 }, 10), '短い穴');
  const proj = { project: (lat, lon) => [(lon - 1.44) * 80000, -(lat - 43.6) * 111000] };
  const [p, m] = projectEntrances([
    { kind: 'parking', name: 'Parking Capitole', lat: 43.6, lon: 1.44, len: 36, wid: 11, ang: 0, down: 1, depth: 4.6 },
    { station: 'Capitole', lat: 43.6, lon: 1.441, len: 36, wid: 11, ang: 0, down: 1, depth: 4.6 },
  ], proj);
  assert.equal(p.kind, 'parking');
  assert.equal(p.wid, 11);
  assert.equal(m.kind, 'metro', '古いデータ（kind なし）はメトロ');
  assert.equal(m.wid, 9);
});

test('穴の向きは、近くの建物の壁の向き（15° 以内）にそろえる', async () => {
  const { snapToStreetGrid } = await import('../../src/data/metro.js');
  // 東西・南北の壁の街並み（少し回った 3° の向き）
  const r = (3 * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r);
  const segs = [];
  for (let k = -3; k <= 3; k++) {
    segs.push([20 * k * c, 20 * k * s, (20 * k + 15) * c, (20 * k + 15) * s]);
    segs.push([-30 * s + 10 * k * c, 30 * c + 10 * k * s, -30 * s + 10 * k * c - 12 * s, 30 * c + 10 * k * s + 12 * c]);
  }
  const deg = (a) => (a * 180) / Math.PI;
  assert.ok(Math.abs(deg(snapToStreetGrid((-10.6 * Math.PI) / 180, 0, 0, segs)) - 3) < 1.2, '−10.6° → 3°');
  assert.ok(Math.abs(deg(snapToStreetGrid((80 * Math.PI) / 180, 0, 0, segs)) - 93) < 1.2, '80° → 93°（南北の向き）');
  assert.ok(Math.abs(deg(snapToStreetGrid((40 * Math.PI) / 180, 0, 0, segs)) - 40) < 1e-6, '離れた向きはそのまま');
  assert.equal(snapToStreetGrid(0.3, 500, 500, segs), 0.3, '近くに建物がなければそのまま');
});
