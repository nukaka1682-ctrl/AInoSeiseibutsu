import test from 'node:test';
import assert from 'node:assert/strict';
import { DATUM, LATTICE, Terrain } from '../../src/world/terrain.js';
import { conditionRoads } from '../../src/world/terraincond.js';
import { quayChains, quaySegments, snapPathsToQuays } from '../../src/world/quays.js';
import { quayLines, simplifyLine, traceCliffs } from '../../src/data/quaybake.js';
import { latticeFor } from '../../src/data/terrainbake.js';
import { MeshWriter } from '../../src/world/meshwriter.js';
import { LocalProjection } from '../../src/geo.js';

const P = new LocalProjection(LATTICE.lat, LATTICE.lon);
function synth(elev) {
  const [n, w] = P.unproject(-200, -200), [s, e] = P.unproject(200, 200);
  const g = latticeFor({ s, w, n, e });
  const data = new Float32Array(g.cols * g.rows);
  for (let r = 0; r < g.rows; r++) for (let c = 0; c < g.cols; c++) {
    const [x, z] = P.project(g.lat - r * g.dLat, g.lon + c * g.dLon);
    data[r * g.cols + c] = elev(x, z);
  }
  return new Terrain({ near: { ...g, data } }, P);
}

test('岸壁の線: 0.5 m の高さの格子の斜めの崖をなぞる（上の段が左、草の土手はなぞらない）', () => {
  const cols = 240, rows = 200, cell = 0.5, H = new Float32Array(cols * rows);
  // 斜めの壁（x − 0.4 y = 60 マス）: 西が上の段 142 m、東が下の段 134 m。壁の面は 1 マスのなまり
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const d = c - 0.4 * r - 60;
    H[r * cols + c] = d < -0.5 ? 142 : d > 0.5 ? 134 : 138 - d * 8;
  }
  const lines = traceCliffs(H, cols, rows, cell);
  assert.equal(lines.length, 1);
  const pts = lines[0].pts;
  assert.ok(pts.length <= 6, `間引いた点 ${pts.length}`);
  for (const [x, y] of pts) assert.ok(Math.abs(x - 0.4 * y - 60.5) < 3, `(${x}, ${y})`);
  // 上の段（西）が進む向きの左 → 北へ進む
  assert.ok(pts[pts.length - 1][1] < pts[0][1]);
  // ゆるい土手（45° 未満）はなぞらない
  const bank = new Float32Array(cols * rows);
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) bank[r * cols + c] = 142 - Math.max(0, Math.min(8, (c - 60) * cell * 0.8));
  assert.equal(traceCliffs(bank, cols, rows, cell).length, 0);
  // 緯度経度と高さ: 水辺（東の端）の近くだけ
  const out = quayLines(H, cols, rows, { nw: [43.6, 1.44], dLat: cell / 111320, dLon: cell / 80600, cell, wet: (lat, lon) => lon > 1.44 + (150 * cell) / 80600 });
  assert.equal(out.length, 1);
  const [, , top, bot] = out[0].pts[2];
  assert.ok(Math.abs(top - 142) < 0.01 && Math.abs(bot - 134) < 0.01, `${top} ${bot}`);
  assert.deepEqual(simplifyLine([[0, 0], [1, 0.1], [2, 0], [3, 5]], 0.5), [[0, 0], [2, 0], [3, 5]]);
});

test('崖: 地面が線の所で上の段と下の段に切れる（setCliffs）', () => {
  // 斜めの線 z = 0.37 x + 3 の北が上（y = 0）、南が下（y = −8）。5 m の格子ではなまった斜面（線の前後 2.5 m）
  const T = synth((x, z) => DATUM - 8 * Math.min(1, Math.max(0, (z - 0.37 * x - 3 + 2.5) / 5)));
  assert.ok(Math.abs(T.h(0, 3) + 4) < 1.5); // なまった斜面の途中
  const segs = [];
  for (let x = -100; x < 100; x += 4) {
    const a = [x, 0.37 * x + 3], b = [x + 4, 0.37 * (x + 4) + 3], L = Math.hypot(4, 1.48);
    // 東へ進む: 左（北）が上の段、下の段へ向く向きは南
    segs.push({ ax: a[0], az: a[1], bx: b[0], bz: b[1], nx: -(b[1] - a[1]) / L, nz: (b[0] - a[0]) / L, at: 0, bt: 0, ab: -8, bb: -8, ea: 1, eb: 1 });
  }
  T.setCliffs(segs);
  for (const x of [-40, -3.3, 0, 17.2, 55]) {
    const z = 0.37 * x + 3;
    assert.ok(Math.abs(T.h(x, z - 0.3)) < 0.05, `上の段 (${x}) ${T.h(x, z - 0.3)}`);
    assert.ok(Math.abs(T.h(x, z + 0.3) + 8) < 0.05, `下の段 (${x}) ${T.h(x, z + 0.3)}`);
    assert.ok(Math.abs(T.h(x, z - 4)) < 0.05 && Math.abs(T.h(x, z + 4) + 8) < 0.05);
    // 段を指定すれば、線の反対側でもその段を延ばした高さ
    assert.ok(Math.abs(T.h(x, z + 0.3, -1)) < 0.05 && Math.abs(T.h(x, z - 0.3, 1) + 8) < 0.05);
  }
  assert.equal(T.cliffSide(0, 10), 1);
  assert.equal(T.cliffSide(0, -10), -1);
  // 載せた面は線で切れて、頂点は 0 か −8 のどちらか（斜めの幕にならない）
  const w = new MeshWriter({ drape: T, lift: 0 });
  w.quad([-30, 0, -20], [30, 0, -20], [30, 0, 30], [-30, 0, 30], [0, 1, 0], [0, 0], [1, 0], [1, 1], [0, 1], [1, 1, 1]);
  let up = 0, down = 0;
  for (let i = 1; i < w.pos.length; i += 3) {
    const y = w.pos[i];
    assert.ok(Math.abs(y) < 0.05 || Math.abs(y + 8) < 0.05, `y = ${y}`);
    if (y > -4) up++;
    else down++;
  }
  assert.ok(up > 10 && down > 10);
  // 端へ向けて重みを 0 にすると、段がすぼんで元の地面につながる
  const T2 = synth((x, z) => DATUM - 8 * Math.min(1, Math.max(0, (z + 6) / 12)));
  T2.setCliffs([{ ax: -10, az: 0, bx: 10, bz: 0, nx: 0, nz: 1, at: 0, bt: 0, ab: -8, bb: -8, ea: 1, eb: 0 }]);
  assert.ok(T2.h(-9, -0.5) - T2.h(-9, 0.5) > 7);
  assert.ok(T2.h(9.9, -0.5) - T2.h(9.9, 0.5) < 2.5);
});

test('岸壁の線分: 橋の下・横切る道で切り、端はすぼめる。沿って走る小道は壁の片側へ寄せる', () => {
  const lines = [{ pts: [] }];
  for (let x = -60; x <= 60; x += 4) lines[0].pts.push([...P.unproject(x, 0), DATUM, DATUM - 6, 0]);
  const chains = quayChains(lines, P);
  assert.equal(chains.length, 1);
  assert.ok(Math.abs(chains[0].pts[0].top) < 1e-6 && Math.abs(chains[0].pts[0].bot + 6) < 1e-6);
  const road = (id, type, width, pts, extra = {}) => ({ id, type, width, pts, nodeIds: pts.map((_, i) => `${id}_${i}`), ...extra });
  const roads = [
    road(1, 'residential', 6, [[-30, -40], [-30, 40]]), // 横切る車道
    road(2, 'primary', 8, [[30, -40], [30, 40]], { bridge: true }), // 上を越える橋
    road(3, 'cycleway', 2.5, [[-20, -1.2], [-5, 0.6], [10, -0.4], [22, 0.5]]), // 壁の上の縁を走り、線が壁と浅く交わる
    road(4, 'path', 2, [[-20, 5], [20, 5]]), // 下の遊歩道（離れている）
    road(5, 'steps', 2, [[0, -6], [0, 6]]), // 階段
  ];
  assert.ok(snapPathsToQuays(roads, chains) >= 1);
  const cyc = roads[2];
  // 東へ進む線の左（北 = z が負）が上の段。自転車道は上の段の側へ、壁から幅の半分 + 1.2 m 以上
  for (const [x, z] of cyc.pts) if (x > -18 && x < 20) assert.ok(z <= -2.44, `(${x.toFixed(1)}, ${z.toFixed(2)})`);
  assert.equal(cyc.pts.length, cyc.nodeIds.length);
  assert.deepEqual(roads[3].pts, [[-20, 5], [20, 5]]);
  const segs = quaySegments(chains, roads);
  const has = (x) => segs.some((q) => Math.min(q.ax, q.bx) <= x && Math.max(q.ax, q.bx) >= x);
  assert.ok(!has(-30) && !has(-27) && has(-23), '車道の所で切る');
  assert.ok(!has(30) && !has(34.5) && has(37), '橋の下は切る');
  assert.ok(!has(0) && has(4), '階段の所で切る');
  assert.ok(has(-12) && has(15), '沿って走る自転車道では切らない');
  for (const q of segs) {
    assert.ok(Math.abs(q.nx) < 1e-9 && q.nz > 0.99); // 下の段は南
    assert.ok(q.ea >= 0 && q.ea <= 1 && q.eb >= 0 && q.eb <= 1);
  }
  assert.ok(segs[0].ax < -59.9 && segs[0].ea === 0);
  assert.ok(segs.some((q) => q.ea === 1 && q.eb === 1));
  // 壁の向こうへ出てまた戻る小道は、元の側へ戻す
  const out = [road(9, 'footway', 2, [[-20, -4], [-10, -4], [-5, 3], [5, 3], [10, -4], [20, -4]])];
  snapPathsToQuays(out, chains);
  for (const [, z] of out[0].pts) assert.ok(z < -1.5, `z = ${z}`);
});

test('道のならし: 自転車道・歩道も縦断面でならし、横に傾かない', () => {
  // 東へ下る斜面（10 %）を北へ走る道 → 横に傾いている
  const mk = () => synth((x) => DATUM - 0.1 * x);
  const tilt = (T, x) => Math.abs(T.h(x - 1.2, 3.3) - T.h(x + 1.2, 3.3));
  const road = (id, type, width, x) => ({ id, type, width, pts: [[x, -150], [x, 150]], nodeIds: [`${id}a`, `${id}b`] });
  const T = mk();
  assert.ok(tilt(T, 40.7) > 0.2);
  conditionRoads(T, [road(1, 'cycleway', 2.5, 40.7), road(2, 'residential', 6, -52.3), road(3, 'steps', 2, 120.4)]);
  assert.ok(tilt(T, 40.7) < 0.01, `自転車道 ${tilt(T, 40.7)}`);
  assert.ok(Math.abs(T.h(40.7, 3.3) + 4.07) < 0.15);
  assert.ok(Math.abs(T.h(-52.3 - 2.7, 11) - T.h(-52.3 + 2.7, 11)) < 0.01, '車道の幅いっぱい');
  assert.ok(tilt(T, 120.4) > 0.2, '階段はそのまま');
  assert.ok(Math.abs(T.h(80, 0) + 8) < 0.05, '道から離れた地面はそのまま');
  // paths: false なら車道だけ
  const T2 = mk();
  conditionRoads(T2, [road(1, 'cycleway', 2.5, 40.7)], () => false, { paths: false });
  assert.ok(tilt(T2, 40.7) > 0.2);
});

test('写真で決めた岸壁: 壁の前を平らに書き直し、小道では切らず、横切る小道は切り離す', async () => {
  const { MANUAL_QUAYS, manualChains, fillManualHeights, flattenManualQuays, nearManualQuay, manualLawns } = await import('../../src/world/quays.js');
  const { MEMORIAL, memorialColliders } = await import('../../src/world/monuments.js');
  const Q = new LocalProjection(43.6, 1.44);
  const chains = manualChains(Q);
  assert.equal(chains.length, MANUAL_QUAYS.length);
  const dau = chains.find((c) => c.spec.id === 'daurade');
  assert.ok(dau.solid && dau.pts.length > 50);
  const a = dau.pts[0], b = dau.pts[dau.pts.length - 1], L = Math.hypot(b.x - a.x, b.z - a.z);
  assert.ok(L > 150 && L < 180, `長さ ${L}`);
  // 下の段（川）は線の南西
  const mid = dau.pts[dau.pts.length >> 1], n = [-(b.z - a.z) / L, (b.x - a.x) / L];
  assert.ok(n[0] < 0 && n[1] > 0);
  assert.ok(nearManualQuay(chains, mid.x + n[0] * 10, mid.z + n[1] * 10));
  assert.ok(!nearManualQuay(chains, mid.x - n[0] * 20, mid.z - n[1] * 20));
  assert.ok(!nearManualQuay(chains, a.x - (b.x - a.x) * 0.1, a.z - (b.z - a.z) * 0.1));
  // 地形: なまった斜面 → 壁の前は下の段に平ら、裏は上の段
  const g = latticeFor({ s: 43.598, w: 1.437, n: 43.603, e: 1.443 });
  const data = new Float32Array(g.cols * g.rows);
  for (let r = 0; r < g.rows; r++) for (let c = 0; c < g.cols; c++) {
    const [x, z] = Q.project(g.lat - r * g.dLat, g.lon + c * g.dLon);
    const d = (x - a.x) * n[0] + (z - a.z) * n[1];
    data[r * g.cols + c] = 143 - 9 * Math.min(1, Math.max(0, (d + 8) / 20)); // 幅 20 m のなだらかな斜面
  }
  const T = new Terrain({ near: { ...g, data } }, Q);
  fillManualHeights(T, chains);
  flattenManualQuays(T, chains);
  const segs = quaySegments([dau], [{ id: 1, type: 'footway', width: 2, pts: [[mid.x - n[0] * 8, mid.z - n[1] * 8], [mid.x + n[0] * 8, mid.z + n[1] * 8]] }]);
  assert.equal(segs.length, dau.pts.length - 1, '小道では切らない');
  assert.ok(segs.every((q) => q.ea === 1 && q.eb === 1));
  T.setCliffs(segs);
  for (const d of [1, 6, 15, 25]) assert.ok(Math.abs(T.h(mid.x + n[0] * d, mid.z + n[1] * d) - (133.7 - DATUM)) < 0.05, `前 ${d} m: ${T.h(mid.x + n[0] * d, mid.z + n[1] * d)}`);
  assert.ok(T.h(mid.x - n[0] * 1, mid.z - n[1] * 1) > 143 - DATUM - 0.6, `裏: ${T.h(mid.x - n[0], mid.z - n[1])}`);
  // 横切る小道は切り離す
  const roads = [{ id: 7, type: 'footway', width: 2, pts: [[mid.x - n[0] * 8, mid.z - n[1] * 8], [mid.x, mid.z - 0.01], [mid.x + n[0] * 8, mid.z + n[1] * 8]], nodeIds: ['a', 'b', 'c'] }];
  snapPathsToQuays(roads, [dau]);
  for (const r of roads) for (let i = 0; i + 1 < r.pts.length; i++) {
    const s0 = (r.pts[i][0] - a.x) * n[0] + (r.pts[i][1] - a.z) * n[1], s1 = (r.pts[i + 1][0] - a.x) * n[0] + (r.pts[i + 1][1] - a.z) * n[1];
    assert.ok(s0 * s1 > 0, '壁をまたぐ辺が残っている');
  }
  assert.ok(manualLawns(Q).length >= 1);
  // 記念碑: 通路は通れる（真ん中に当たり判定がない）、壁と 8 本の円柱
  const cs = memorialColliders(0, 0, [0, 1]);
  assert.equal(cs.filter((c) => c.length === 3).length, 8);
  assert.ok(cs.filter((c) => c.length === 4).every(([ax, , bx]) => Math.min(Math.abs(ax), Math.abs(bx)) >= MEMORIAL.pass - 1e-9));
});
