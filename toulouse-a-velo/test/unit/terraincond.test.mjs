import test from 'node:test';
import assert from 'node:assert/strict';
import { DATUM, LATTICE, Terrain } from '../../src/world/terrain.js';
import { cleanProfile, conditionRoads, despike, extendHeights, fitDeckEnds, segmentsCross, sharpenQuays, WALK_DEF } from '../../src/world/terraincond.js';
import { DECK_TOP, deckEdgeBlocked, surfaceFns } from '../../src/world/terrain.js';
import { abutmentWalls, setupDecks } from '../../src/world/bridges.js';
import { latticeFor } from '../../src/data/terrainbake.js';
import { LocalProjection } from '../../src/geo.js';

const P = new LocalProjection(LATTICE.lat, LATTICE.lon);
function synth(elev) {
  const [n, w] = P.unproject(-400, -400), [s, e] = P.unproject(400, 400);
  const g = latticeFor({ s, w, n, e });
  const data = new Float32Array(g.cols * g.rows);
  for (let r = 0; r < g.rows; r++) {
    for (let c = 0; c < g.cols; c++) {
      const [x, z] = P.project(g.lat - r * g.dLat, g.lon + c * g.dLon);
      data[r * g.cols + c] = elev(x, z);
    }
  }
  return new Terrain({ near: { ...g, data } }, P);
}
const ss = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

test('橋の縦断面: 測りの外れ値（端の 12 m の跳ね）を捨て、でこぼこをならす', () => {
  const ys = [];
  for (let k = 0; k <= 40; k++) ys.push(1 + 1.5 * 4 * (k / 40) * (1 - k / 40) + (k % 2 ? 0.2 : -0.2));
  ys[39] = 13;
  ys[40] = 14;
  const y = cleanProfile(ys);
  assert.ok(y);
  assert.ok(Math.max(...y) < 3, `${Math.max(...y)}`);
  assert.ok(Math.abs(y[40] - 1) < 0.5);
  // 水面が透けたくぼみ（中ほどが 1.8 m 低い）は残さない
  const sag = cleanProfile(Array.from({ length: 21 }, (_, k) => 4 - 1.8 * Math.exp(-(((k - 10) / 3) ** 2))));
  assert.ok(Math.min(...sag) > 3.5, `たわみ ${Math.min(...sag)}`);
  // ほとんどが外れ（木・建物の上）なら信用しない
  assert.equal(cleanProfile(ys.map((v, k) => (k % 3 ? v + 10 * Math.sin(k) : v))), null);
});

test('橋の縦断面: 端は目標の高さに合わせ、差が大きいほど長い坂（単調、勾配 7 % 以下）', () => {
  const y = new Array(51).fill(8); // 250 m の橋の面が 8 m 上
  const out = fitDeckEnds(y, 5, 250, 0, 7.6);
  assert.equal(out[0], 0);
  assert.equal(out[50], 7.6);
  for (let k = 1; k <= 50; k++) {
    assert.ok(out[k] >= out[k - 1] - 1e-9 || k > 25, `単調 ${k}`);
    assert.ok(Math.abs(out[k] - out[k - 1]) / 5 < 0.07, `勾配 ${k}: ${out[k - 1]} → ${out[k]}`);
  }
  // 差がないときも、端の 20 m の測りのでこぼこは消える（ポン・ヌフの右岸の端のくぼみ）
  const dip = [0.1, -0.3, 0.2, 0.5, 0.9, 1.2, 1.4];
  const f = fitDeckEnds(dip, 5, 30, 0.1, null);
  for (let k = 1; k < 5; k++) assert.ok(f[k] >= f[k - 1] - 1e-9);
});

test('橋の端: どの陸の端も、取り付ける地面の高さに合う（差 8 m の測りでも）', () => {
  // 川（|x| < 60）の谷。岸の地面は 135 m、橋の面の測りは 143 m で両端まで高い
  const T = synth((x) => DATUM - 10 + 5 * ss((Math.abs(x) - 60) / 30));
  const a = P.unproject(-150, 0), b = P.unproject(150, 0);
  T.profiles = [{ a, b, y: new Array(61).fill(DATUM - 2) }];
  const road = (id, pts, bridge) => ({ id, type: 'secondary', name: 'Pont', width: 10, pts, nodeIds: pts.map((_, i) => id * 10 + i), bridge, tunnel: false, layer: bridge ? 1 : 0, oneway: false });
  const roads = [road(1, [[-150, 0], [0, 0], [150, 0]], true), road(2, [[-250, 0], [-150, 0]], false), road(3, [[150, 0], [250, 0]], false)];
  const waterDepthAt = (x) => (Math.abs(x) < 60 ? 6 : 0);
  setupDecks(T, roads, P, waterDepthAt);
  for (const x of [-149.5, 149.5]) {
    const d = T.deck(x, 0, T.h(x, 0));
    assert.ok(d != null && Math.abs(d - T.h(x, 0)) < 0.3, `端 ${x}: 橋 ${d} 地面 ${T.h(x, 0)}`);
  }
  // 自転車の高さ（地面）から、端から橋の上へ順にたどれる
  let y = T.h(-160, 0);
  for (let x = -160; x <= 160; x += 1) {
    const d = T.deck(x, 0, y);
    const g = d == null ? T.h(x, 0) : Math.max(T.h(x, 0), d);
    assert.ok(Math.abs(g - y) < 0.5, `${x}: ${y} → ${g}`);
    y = g;
  }
  assert.ok(T.deck(0, 0, y) > -5, '川の上は橋の面');
});

test('車道の縦断面: 道の横は水平、地形モデルのでこぼこはならす', () => {
  // 川へ下る横の傾き（z が増えると下がる）と、道に沿った 18 m 周期のでこぼこ
  const T = synth((x, z) => DATUM - 0.15 * z + Math.sin(x / 3));
  const before = T.h(10, 0) - T.h(10, 4);
  conditionRoads(T, [{ type: 'primary', width: 8, pts: [[-200, 0], [200, 0]], bridge: false, tunnel: false, layer: 0 }]);
  assert.ok(before > 0.5);
  for (const x of [-50, 0, 37.5, 90]) {
    assert.ok(Math.abs(T.h(x, 4) - T.h(x, -4)) < 0.05, `横の傾き ${x}`);
    assert.ok(Math.abs(T.h(x, 0)) < 0.35, `でこぼこ ${x}: ${T.h(x, 0)}`);
  }
  // 道から離れた所はそのまま
  assert.ok(Math.abs(T.h(0, 60) - (-0.15 * 60 + Math.sin(0))) < 0.05);
});

test('岸壁: なまった斜面を 1 マスの段差に戻し、下の段に向いた壁の線を返す', () => {
  // 上の河岸 142 m（z < 0）から 20 m かけて遊歩道 134 m へ
  const T = synth((x, z) => 142 - 8 * ss(z / 20));
  const walls = sharpenQuays(T, [0, 0], 300, { inWater: (x, z) => z > 30 });
  assert.ok(walls.length > 20);
  for (const w of walls.slice(0, 20)) {
    assert.ok(w.nz > 0.9, '壁は遊歩道（南）を向く');
    assert.ok(w.at - w.ab > 6, `壁の高さ ${w.at - w.ab}`);
  }
  // 段差は 1 マスの中（上の段は 142 m、下の段は 134 m のまま）
  const zs = walls.map((w) => w.az);
  const zw = zs.reduce((s, v) => s + v, 0) / zs.length;
  assert.ok(Math.abs(T.h(0, zw - 6) - (142 - DATUM)) < 0.3, `上 ${T.h(0, zw - 6)}`);
  assert.ok(Math.abs(T.h(0, zw + 6) - (134 - DATUM)) < 0.3, `下 ${T.h(0, zw + 6)}`);
});

test('岸壁: 水辺から遠い段差・水の上の台地・車道には壁を作らない', () => {
  const quay = (x, z) => 142 - 8 * ss(z / 20);
  // 水が 300 m 先: 同じ段差でも壁はなく、格子もそのまま
  const A = synth(quay);
  const before = A.h(0, 10);
  assert.equal(sharpenQuays(A, [0, 0], 300, { inWater: (x, z) => z > 330 }).length, 0);
  assert.equal(A.h(0, 10), before);
  // 水の上（z > 30）に橋の高さの台地（142 m）が残っていても、壁は水の上に立たず、水辺から 45 m 以内（川沿いの低い遊歩道の幅）、足は水面 + 4 m 以下
  const wetZ = (x, z) => z > 30;
  const B = synth((x, z) => (z > 40 && Math.abs(x) < 40 ? 142 : quay(x, z)));
  const walls = sharpenQuays(B, [0, 0], 300, { inWater: wetZ });
  assert.ok(walls.length > 10);
  for (const w of walls) {
    const mx = (w.ax + w.bx) / 2, mz = (w.az + w.bz) / 2;
    assert.ok(!wetZ(mx, mz), `水の上の壁 ${mx},${mz}`);
    assert.ok(30 - mz < 45, `水辺から遠い壁 ${mz}`);
    assert.ok(Math.min(w.ab, w.bb) <= B.waterLevel(mx, mz) + 4 + 1e-3 || Math.min(w.ab, w.bb) <= 134 - DATUM + 0.1, `足が高い ${w.ab}`);
  }
  // 岸壁を横切る車道（x = 0）の格子はならした高さのまま、壁も車道を横切らない
  const C = synth(quay);
  conditionRoads(C, [{ type: 'primary', width: 8, pts: [[0, -150], [0, 150]], bridge: false, tunnel: false, layer: 0 }], wetZ);
  const road = [-20, -5, 5, 15, 25].map((z) => C.h(0, z));
  const cw = sharpenQuays(C, [0, 0], 300, { inWater: wetZ });
  [-20, -5, 5, 15, 25].forEach((z, i) => assert.ok(Math.abs(C.h(0, z) - road[i]) < 1e-4, `車道 ${z}`));
  for (const w of cw) assert.ok(Math.min(Math.abs(w.ax), Math.abs(w.bx)) > 4, `車道の上の壁 ${w.ax}`);
});

test('岸壁: なまった斜面に沿って走る遊歩道は坂ではなく下の段の道（岸壁の下の船着き場）', () => {
  // 上の河岸 142 m（z < 0）から遊歩道 134 m へ。遊歩道は斜面の途中（z = 8、なまった格子では 139 m 前後）を、斜面に少し斜めに走る
  const quay = (x, z) => 142 - 8 * ss(z / 20);
  const T = synth(quay);
  const path = { type: 'footway', width: 3, pts: [[-150, 6], [150, 12]], bridge: false, tunnel: false, layer: 0 };
  const walls = sharpenQuays(T, [0, 0], 300, { inWater: (x, z) => z > 30, paths: [path] });
  // 遊歩道の上は下の段（134 m）まで下がり、壁はその山側（北）に立つ
  for (const x of [-100, -40, 30, 90]) {
    const z = 6 + ((x + 150) / 300) * 6;
    assert.ok(Math.abs(T.h(x, z) - (134 - DATUM)) < 1, `遊歩道 ${x}: ${T.h(x, z) + DATUM}`);
  }
  assert.ok(walls.filter((w) => Math.abs(w.ax) < 100).length > 10, '壁がある');
  for (const w of walls) if (Math.abs(w.ax) < 100) assert.ok(w.az < 9 + ((w.ax + 150) / 300) * 6, `壁が遊歩道の川側 ${w.ax},${w.az}`);
  // 斜面を下りる坂道（斜面を横切る）は坂のまま、壁でふさがない
  const T2 = synth(quay);
  const ramp = { type: 'footway', width: 3, pts: [[0, -30], [0, 28]], bridge: false, tunnel: false, layer: 0 };
  const w2 = sharpenQuays(T2, [0, 0], 300, { inWater: (x, z) => z > 30, paths: [ramp] });
  for (const w of w2) assert.ok(!segmentsCross(w.ax, w.az, w.bx, w.bz, 0, -30, 0, 28), '坂を横切る壁');
});

test('格子の 1 点だけの穴・とげを直す。同じ読み込み結果から作った地形は別々に手直しされる', () => {
  const T = synth(() => DATUM);
  const g = T.near, k = Math.floor(g.rows / 2) * g.cols + Math.floor(g.cols / 2);
  g.data[k] = DATUM - 3;
  g.data[k + 7] = DATUM + 2.5;
  assert.equal(despike(T), 2);
  assert.ok(Math.abs(g.data[k] - DATUM) < 1e-6 && Math.abs(g.data[k + 7] - DATUM) < 1e-6);
  const decoded = { near: { ...latticeFor({ s: 43.59, w: 1.43, n: 43.6, e: 1.45 }), data: null } };
  decoded.near.data = new Float32Array(decoded.near.cols * decoded.near.rows).fill(DATUM + 1);
  const A = new Terrain(decoded, P), B2 = new Terrain(decoded, P);
  A.near.data[0] = 0;
  assert.equal(B2.near.data[0], DATUM + 1);
  assert.equal(decoded.near.data[0], DATUM + 1);
});

test('岸壁: 遊歩道へ下りる歩道・自転車道の坂は壁でふさがず、遊歩道に沿う道があっても壁は残る', () => {
  const quay = (x, z) => 142 - 8 * ss(z / 20);
  const wetZ = (x, z) => z > 30;
  const T = synth(quay);
  const ramp = { type: 'footway', width: 2.5, pts: [[0, -120], [0, 28]], bridge: false, tunnel: false, layer: 0 };
  const cyc = { type: 'cycleway', width: 2.5, pts: [[100, -120], [70, 28]], bridge: false, tunnel: false, layer: 0 };
  const along = { type: 'footway', width: 3, pts: [[-280, 26], [280, 26]], bridge: false, tunnel: false, layer: 0 };
  const before = [-15, -5, 5, 15].map((z) => T.h(0, z));
  const walls = sharpenQuays(T, [0, 0], 300, { inWater: wetZ, paths: [ramp, cyc, along] });
  assert.ok(walls.length > 20, `壁 ${walls.length}`);
  for (const r of [ramp, cyc]) {
    for (const w of walls) assert.ok(!segmentsCross(w.ax, w.az, w.bx, w.bz, ...r.pts[0], ...r.pts[1]), `${r.type} を横切る壁 ${w.ax},${w.az}`);
  }
  // 坂の上の格子は元の斜面のまま（段差にしない）
  [-15, -5, 5, 15].forEach((z, i) => assert.ok(Math.abs(T.h(0, z) - before[i]) < 1e-4, `坂 ${z}`));
  assert.ok(segmentsCross(0, 0, 2, 2, 0, 2, 2, 0));
  assert.ok(!segmentsCross(0, 0, 2, 0, 0, 1, 2, 1));
});

test('遠くの地面: 測った範囲の外を縁の高さから地方の平均へ移る丘で埋める（同じ入力なら同じ）', () => {
  const nx = 120, nz = 120, step = 80;
  const make = () => {
    const ys = new Float32Array(nx * nz).fill(NaN);
    for (let j = 40; j < 80; j++) for (let i = 40; i < 80; i++) ys[j * nx + i] = 5;
    return extendHeights(ys, nx, nz, step, -4800, -4800);
  };
  const ys = make();
  assert.ok(ys.every(Number.isFinite));
  assert.equal(ys[60 * nx + 60], 5);
  assert.ok(Math.abs(ys[60 * nx + 81] - 5) < 1, `縁の外すぐ ${ys[60 * nx + 81]}`); // 縁で段差にならない
  // 遠く（縁から 3 km 以上）は地方の平均（縁の 5 m を 15 m に上げた値）のまわりのうねり
  const far = [];
  for (let j = 0; j < 5; j++) for (let i = 0; i < nx; i++) far.push(ys[j * nx + i]);
  const m = far.reduce((s, v) => s + v, 0) / far.length;
  assert.ok(m > 8 && m < 22, `平均 ${m}`);
  assert.ok(Math.max(...far) - Math.min(...far) > 3, 'うねりがある');
  assert.deepEqual(Array.from(make()), Array.from(ys));
});

test('欄干: 橋の外や高さの違う隣の橋の面へ 0.5 m 以上落ちる所は止め、同じ橋の上・地面から橋へは止めない', () => {
  assert.equal(deckEdgeBlocked(5, null, 5.1, 4, 0.5), true); // 橋の外へ落ちる
  assert.equal(deckEdgeBlocked(5, null, 5.1, 4.9), false); // 橋の端から同じ高さの道へ
  assert.equal(deckEdgeBlocked(5, 3.9, 5.1, 4.0), true); // 隣の 1.1 m 低い橋の面
  assert.equal(deckEdgeBlocked(5, 6.2, 5.1, 6.3), true); // 隣の 1.2 m 高い橋の面
  assert.equal(deckEdgeBlocked(5, 5.05, 5.1, 5.15), false); // 同じ橋の上
  assert.equal(deckEdgeBlocked(null, 5, 0, 5.1), false); // 地面から橋へ（ほかの判定に任せる）
  // スタート・ワープ: 陸の上の高架でも、置く道が橋なら橋の面に
  const T = { h: () => 0, deck: (x, z, y = Infinity) => (6 > y + 1.2 ? null : 6) };
  const f = surfaceFns(T, () => 0);
  assert.equal(f.spawnY(0, 0, () => false), 0);
  assert.equal(f.spawnY(0, 0, () => false, true), 6 + DECK_TOP);
});

test('岸壁: 壁は下の段の格子点を結ぶ地面の三角形の辺に立ち、壁の前の地面は平ら。壁の裏は歩道の板の高さで走る', () => {
  const T = synth((x, z) => 142 - 8 * ss(z / 20));
  const walls = sharpenQuays(T, [0, 0], 300, { inWater: (x, z) => z > 30 });
  assert.ok(walls.length > 20);
  for (const w of walls.slice(0, 40)) {
    const mx = (w.ax + w.bx) / 2, mz = (w.az + w.bz) / 2;
    // 壁の前（下の段の側）1〜3 m は下端の高さのまま（地面の三角形が壁をまたがない）
    for (const d of [1, 3]) assert.ok(T.h(mx + w.nx * d, mz + w.nz * d) - Math.max(w.ab, w.bb) < 0.3, `壁の前の地面 ${mx},${mz}`);
    assert.equal(w.wa, WALK_DEF, '車道がなければ歩道の板は既定の幅');
  }
  // 板の上（壁の裏 2 m）は、地面の高さ h は斜面のまま、上に載る面 top は板の高さ
  T.setQuayWalls(walls);
  const w = walls[10], mx = (w.ax + w.bx) / 2, mz = (w.az + w.bz) / 2, x = mx - w.nx * 2, z = mz - w.nz * 2;
  assert.ok(Math.abs(T.top(x, z) - ((w.at + w.bt) / 2 - 0.02)) < 0.05, `板 ${T.top(x, z)}`);
  assert.ok(T.h(x, z) <= T.top(x, z) + 1e-6);
  assert.equal(T.top(mx + w.nx * 2, mz + w.nz * 2), T.h(mx + w.nx * 2, mz + w.nz * 2), '壁の前は地面');
});

test('高架の下の擁壁: 高速道路の橋の下をくぐる車道の両脇の盛り土の足元に、盛り土の上までの壁を立てる', () => {
  // 南北の車道（x = 0、幅 10 m）。両脇 x = ±12 m から盛り土（6 m 高い）。東西の高速道路の橋が z = 0 で越える
  const h = (x, z) => (Math.abs(x) > 12 && Math.abs(z) < 60 ? Math.min(6, (Math.abs(x) - 12) * 2) : 0);
  const terrain = { flat: false, h, deck: (x, z) => (Math.abs(z) < 6 ? 8 : null) };
  const road = { type: 'secondary', width: 10, pts: [[0, -150], [0, 150]], bridge: false, tunnel: false, layer: 0 };
  const motorway = { type: 'motorway', width: 12, pts: [[-80, 0], [80, 0]], bridge: true, tunnel: false, layer: 1 };
  const ramp = { type: 'footway', width: 2, pts: [[13, 40], [30, 40]], bridge: false, tunnel: false, layer: 0 };
  const walls = abutmentWalls(terrain, [road, motorway, ramp]);
  assert.ok(walls.length > 20, `壁 ${walls.length}`);
  for (const w of walls) {
    assert.ok(Math.abs(Math.abs(w.ax) - 12.5) < 0.6, `足元 ${w.ax}`);
    assert.ok(Math.abs(w.az) < 62, `盛り土の外 ${w.az}`);
    assert.ok(w.at > 5, `上端 ${w.at}`);
    assert.ok(Math.sign(w.nx) === -Math.sign(w.ax), '道の側を向く');
    assert.ok(!segmentsCross(w.ax, w.az, w.bx, w.bz, 13, 40, 30, 40), '盛り土を上る道を横切らない');
  }
  // 高架がなければ作らない
  assert.equal(abutmentWalls(terrain, [road]).length, 0);
});
