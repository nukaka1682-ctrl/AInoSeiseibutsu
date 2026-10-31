import test from 'node:test';
import assert from 'node:assert/strict';
import { MASONRY_NAME, PONT_NEUF, archLayout, archRise, bridgeGroups, bridgeStyle, columns, conditionUnderpasses, wetIntervals } from '../../src/world/bridges.js';
import { fillWaterUnderBridges, unifyWaterLevels } from '../../src/world/parse.js';
import { pointInRing } from '../../src/geo.js';
import { bankVertexWidths, naturalHeight, subdivideRing } from '../../src/world/ground.js';

test('橋: 深い水を渡る区間（短い陸のすき間はつなぎ、浅い所・短すぎる区間は除く）', () => {
  const step = 1;
  const depths = [];
  for (let i = 0; i < 120; i++) depths.push(i < 10 ? 0 : i < 50 ? 10 : i < 54 ? 0 : i < 90 ? 10 : i < 100 ? 2.2 : i < 103 ? 10 : 0);
  const wet = wetIntervals(depths, step);
  assert.equal(wet.length, 1, '4 m の陸のすき間はつなぐ／3 m の区間は捨てる');
  assert.equal(wet[0].s0, 10);
  assert.equal(wet[0].s1, 90);
  assert.equal(wet[0].depth, 10);
});

test('橋: ポン・ヌフの 7 つのアーチ（中ほどがいちばん大きく、全長に合わせて伸縮、橋脚は穴が入る厚さ）', () => {
  const lay = archLayout(2, 216, PONT_NEUF);
  assert.equal(lay.arches.length, 7);
  assert.equal(lay.piers.length, 6);
  const spans = lay.arches.map((a) => 2 * a.a);
  const big = spans.indexOf(Math.max(...spans));
  assert.equal(big, 3, '中ほどのアーチがいちばん大きい');
  assert.ok(spans[3] > 30 && spans[3] < 34, `最大の径間 ${spans[3]}`);
  assert.ok(spans[0] < spans[6], '左岸（西）側が小さい');
  assert.ok(Math.abs(lay.arches[0].c - lay.arches[0].a - 2) < 1e-9, '左の橋台から始まる');
  const last = lay.arches[6];
  assert.ok(Math.abs(last.c + last.a - 216) < 1e-9, '右の橋台で終わる');
  for (const p of lay.piers) assert.ok(p.s1 - p.s0 > 6, '橋脚は丸い穴が入る厚さ');
  // アーチと橋脚が重ならずに並ぶ
  lay.piers.forEach((p, k) => {
    assert.ok(Math.abs(lay.arches[k].c + lay.arches[k].a - p.s0) < 1e-9);
    assert.ok(Math.abs(lay.arches[k + 1].c - lay.arches[k + 1].a - p.s1) < 1e-9);
  });
  // 右岸から描かれた way では順番が逆
  const rev = archLayout(2, 216, { ...PONT_NEUF, reverse: true });
  assert.ok(Math.abs(2 * rev.arches[6].a - spans[0]) < 1e-9);
});

test('橋: ふつうの石の橋は等しい径間（25〜40 m）、短い橋は 1 つのアーチ', () => {
  const lay = archLayout(0, 200, { target: 32, minSpan: 25, maxSpan: 40 });
  const spans = lay.arches.map((a) => 2 * a.a);
  assert.ok(spans.every((s) => s >= 25 && s <= 40 && Math.abs(s - spans[0]) < 1e-9), `径間 ${spans}`);
  assert.equal(lay.piers.length, spans.length - 1);
  const total = spans.reduce((a, b) => a + b, 0) + lay.piers.reduce((a, p) => a + p.s1 - p.s0, 0);
  assert.ok(Math.abs(total - 200) < 1e-9);
  assert.equal(archLayout(0, 18, { target: 30, minSpan: 22, maxSpan: 38 }).arches.length, 1);
  // 46 m は 45 m の大きな 1 つより、2 つのアーチ
  assert.equal(archLayout(0, 46, { target: 30, minSpan: 22.5, maxSpan: 37.5 }).arches.length, 2);
  // アーチの高さ: 起拱線は水面のすぐ上、要石は橋面の下に収まる
  const { spring, rise } = archRise(16, 10, 1.1);
  assert.ok(spring > -10 && spring < -9);
  assert.ok(spring + rise + 1.1 < -0.9 && rise > 5);
});

test('橋: 車道の橋に並ぶ歩道の橋は親にまとめ、アーチは親だけ（幅は歩道の外側まで）', () => {
  const road = { id: 1, type: 'secondary', width: 9, bridge: true, pts: [[0, 0], [200, 0]] };
  const left = { id: 2, type: 'footway', width: 3, bridge: true, pts: [[0, -8], [200, -8]] };
  const right = { id: 3, type: 'footway', width: 3, bridge: true, pts: [[200, 8], [0, 8]] };
  const other = { id: 4, type: 'secondary', width: 9, bridge: true, pts: [[0, 300], [200, 300]] };
  const info = bridgeGroups([road, left, right, other]);
  assert.equal(info.get(left).root, road);
  assert.equal(info.get(right).root, road);
  assert.equal(info.get(other).root, other);
  const v = info.get(road);
  // offsets の L 側は (−dz, dx) 向き（東へ向かう線なら南 = +z）
  assert.ok(Math.abs(v.extL - 9.8) < 1e-6 && Math.abs(v.extR - 9.8) < 1e-6, `幅 ${v.extL} ${v.extR}`);
  assert.ok(info.onDeck(100, 9));
  assert.ok(!info.onDeck(100, 12));
});

test('橋: 側面を縦の短冊で埋める（丸い穴の正方形はよけ、下は石・上はレンガ）', () => {
  const quads = [];
  const fq = (a, b, c, d, color) => quads.push({ a, b, c, d, color });
  columns(fq, [[0, -10], [10, -10]], -1, [[4, 6, -6, -2]], [[-8, 'stone'], [Infinity, 'brick']]);
  // 穴の範囲（s 4〜6、y -6〜-2）には何もない
  for (const q of quads) {
    const sm = (q.a[0] + q.b[0]) / 2, ym = (q.a[1] + q.d[1]) / 2;
    assert.ok(!(sm > 4 && sm < 6 && ym > -6 && ym < -2));
  }
  const area = quads.reduce((s, q) => s + (q.b[0] - q.a[0]) * (q.d[1] - q.a[1]), 0);
  assert.ok(Math.abs(area - (90 - 8)) < 1e-9, `面積 ${area}`);
  assert.ok(quads.some((q) => q.color === 'stone' && q.d[1] === -8));
});

test('橋: 高速道路の横のランプは本線の下につき、まとまりは近代の橋。2 本に分かれた車道は本体を重ねない', () => {
  // 東西の高速道路（上り・下り）と、北側に並ぶランプ。下りは 2 本の way に分かれていて、東の way は幅が広く自分が親になる
  const up = { id: 10, type: 'motorway', width: 10, bridge: true, pts: [[0, 0], [300, 0]] };
  const link = { id: 5, type: 'primary_link', width: 6, bridge: true, pts: [[20, -12], [280, -12]] };
  const downA = { id: 11, type: 'motorway', width: 10, bridge: true, pts: [[0, 15], [140, 15]] };
  const downB = { id: 12, type: 'motorway', width: 12, bridge: true, pts: [[140, 15], [300, 15]] };
  const info = bridgeGroups([up, link, downA, downB]);
  assert.equal(info.get(link).root, up, 'ランプ（順位が下）は本線を親にする');
  const deep = () => 10;
  const st = bridgeStyle(up, info.get(up), deep);
  assert.equal(st.kind, 'modern');
  // 2 本に分かれた下りは、どちらも同じ親か、それぞれ自分で本体を作る（ほかの親の広げた本体の中に入らない）
  const roots = new Set([downA, downB].map((r) => info.get(r).root));
  for (const r of roots) {
    if (r === up) continue;
    const v = info.get(r);
    const zs = r.pts.map((p) => p[1]);
    const lo = Math.min(...zs) - v.extR, hi = Math.max(...zs) + v.extL;
    const u = info.get(up);
    // up は東向き: L 側が +z
    assert.ok(hi <= -u.extR + 0.5 || lo >= u.extL - 0.5, `本体が重なる ${lo}..${hi} / ${-u.extR}..${u.extL}`);
  }
});

test('橋: 石のアーチ橋は実物が石積みの橋だけ（住宅地の道・歩道橋・高速道路は近代の橋）', () => {
  assert.ok(MASONRY_NAME.test('Pont Neuf') && MASONRY_NAME.test('Pont des Catalans') && MASONRY_NAME.test('Pont de la Croix de Pierre'));
  assert.ok(!MASONRY_NAME.test('Pont du Halage de Tounis') && !MASONRY_NAME.test('Pont Saint-Pierre') && !MASONRY_NAME.test('Avenue du Grand Ramier'));
  const res = { id: 1, type: 'residential', name: 'Avenue du Grand Ramier', width: 6, bridge: true, pts: [[0, 0], [120, 0]] };
  const cat = { id: 2, type: 'secondary', name: 'Pont des Catalans', width: 12, bridge: true, pts: [[0, 500], [240, 500]] };
  const roads = [res, cat];
  const info = bridgeGroups(roads);
  const deep = (x) => (x > 10 && x < 230 ? 10 : 0);
  assert.equal(bridgeStyle(res, info.get(res), deep).kind, 'modern');
  assert.equal(bridgeStyle(cat, info.get(cat), deep).kind, 'arch');
});

test('水: 長い継ぎ目でつながった川の切れ端は同じ深さ、短い合流口・運河は別の水面', () => {
  const box = (id, x0, x1, z0, z1, depth, kind, tags = {}) => ({
    id, type: 'water', tags, outer: [[x0, z0], [x1, z0], [x1, z1], [x0, z1]], holes: [], depth, kind,
    bounds: { minX: x0, maxX: x1, minZ: z0, maxZ: z1 },
  });
  const a = box(1, 0, 200, 0, 150, 10, 'river'); // 広い切れ端
  const b = box(2, 200, 400, 0, 150, 6, 'river'); // 切り方で細く見えた切れ端（継ぎ目 150 m）
  const touch = box(3, 400, 600, 0, 30, 6, 'river'); // 合流口 30 m の支流
  const touch2 = box(4, 600, 800, 0, 30, 6, 'river');
  const canal = box(5, 50, 150, 150, 400, 2.2, 'canal', { water: 'canal' }); // 運河（閘門で上がる）
  const pond = box(6, 0, 200, -80, 0, 0.7, 'pond'); // 川に長く接する池
  const areas = [a, b, touch, touch2, canal, pond];
  unifyWaterLevels(areas);
  assert.equal(b.depth, 10);
  assert.equal(pond.depth, 10);
  assert.equal(pond.kind, 'river');
  assert.equal(touch.depth, 6, '短い合流口は別の水面');
  assert.equal(canal.depth, 2.2);
  // 運河の口に架かる橋の下のパッチは、浅い側（運河）の深さ
  const quay = { id: 9, type: 'residential', width: 6, bridge: true, pts: [[40, 151], [160, 151]] };
  const areas2 = [box(1, 0, 200, 0, 148, 10, 'river'), box(5, 50, 150, 154, 400, 2.2, 'canal', { water: 'canal' })];
  fillWaterUnderBridges(areas2, [quay]);
  const patches = areas2.filter((x) => x.patch);
  assert.ok(patches.length >= 1);
  for (const p of patches) assert.equal(p.depth, 2.2);
  // パッチは深い川の上にはみ出さない（川の始まる所 z = 148 から 0.5 m 以内）。運河の側は運河に重なるまで
  for (const p of patches) {
    for (const [, z] of p.outer) assert.ok(z >= 147.5, `パッチの頂点 z=${z} が川の上`);
    assert.ok(Math.max(...p.outer.map(([, z]) => z)) > 156, '運河に重なる');
    for (let x = p.bounds.minX; x <= p.bounds.maxX; x += 2) {
      for (let z = p.bounds.minZ; z <= p.bounds.maxZ; z += 0.25) {
        if (pointInRing(x, z, p.outer)) assert.ok(z >= 147.5, `パッチの中 (${x}, ${z}) が川の上`);
      }
    }
  }
});

test('水: 運河に長く接する池は運河の水面、橋の下のパッチは橋が渡る運河の深さ（片側の池は数えない）', () => {
  const box = (id, x0, x1, z0, z1, depth, kind, tags = {}) => ({
    id, type: 'water', tags, outer: [[x0, z0], [x1, z0], [x1, z1], [x0, z1]], holes: [], depth, kind,
    bounds: { minX: x0, maxX: x1, minZ: z0, maxZ: z1 },
  });
  const canal = box(1, 0, 30, 0, 400, 2.2, 'canal', { water: 'canal' });
  const lock = box(2, 0, 30, 400, 440, 2.2, 'canal', { water: 'lock' });
  const basin = box(3, 30, 120, 100, 180, 0.7, 'pond'); // 運河に 80 m 接する船だまり
  const basin2 = box(4, 120, 160, 100, 180, 0.7, 'pond'); // 船だまりの奥の池（池から池へ伝わる）
  const pond = box(5, 30, 50, 300, 310, 0.7, 'pond'); // 10 m しか接しない池
  unifyWaterLevels([canal, lock, basin, basin2, pond]);
  assert.equal(basin.depth, 2.2);
  assert.equal(basin.kind, 'canal');
  assert.equal(basin2.depth, 2.2);
  assert.equal(pond.depth, 0.7, '短く接する池は別');
  assert.equal(lock.depth, 2.2);
  // 運河を渡る橋の片側が池（運河の外の浅い池）: パッチは運河の深さ
  const a1 = box(1, 0, 30, 0, 97, 2.2, 'canal', { water: 'canal' });
  const a2 = box(2, 0, 30, 103, 400, 0.7, 'pond');
  const road = { id: 7, type: 'residential', width: 6, bridge: true, pts: [[-20, 100], [50, 100]] };
  const areas = [a1, a2];
  fillWaterUnderBridges(areas, [road]);
  const patches = areas.filter((x) => x.patch);
  assert.ok(patches.length >= 1);
  for (const p of patches) assert.equal(p.depth, 2.2);
});

test('岸: 街の外れの土手の幅は頂点ごとに両側の小さい方、岸壁との境目でも細くしない（石の袖壁でふさぐ）', () => {
  // 辺 0: 岸壁、辺 1・2: 土手、辺 3: 岸なし（水の継ぎ目）
  const prof = ['quay', 'natural', 'natural', null];
  const wid = [16, 12, 8, 16];
  const vw = bankVertexWidths(prof, wid);
  assert.equal(vw[1], 12, '岸壁と土手の境目は土手の幅のまま');
  assert.equal(vw[2], 8, '両側が土手なら小さい方');
  assert.equal(vw[3], 8, '水の継ぎ目では土手の幅のまま');
  assert.equal(vw[0], 16);
});

test('岸: 長い辺を 10 m 以下に分け、土手の高さは断面に沿って上から下へ', () => {
  const ring = subdivideRing([[0, 0], [35, 0], [35, 4], [0, 4]], 10);
  assert.equal(ring.length, 4 + 1 + 4 + 1);
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i], q = ring[(i + 1) % ring.length];
    assert.ok(Math.hypot(q[0] - p[0], q[1] - p[1]) <= 10 + 1e-9);
  }
  assert.ok(Math.abs(naturalHeight(0, 10)) < 1e-9);
  let prev = 0;
  for (let f = 0.05; f < 1; f += 0.05) {
    const y = naturalHeight(f, 10);
    assert.ok(y <= prev + 1e-9 && y > -10.31);
    prev = y;
  }
});

test('橋: 陸の上の橋は、高速道路を含めば高架（厚い桁）、ほかは薄い桁の坂・歩道橋（どちらも石の欄干でなく鉄の手すり）', () => {
  const mw = { id: 1, type: 'motorway', width: 10, bridge: true, pts: [[0, 0], [100, 0]] };
  const ramp = { id: 2, type: 'residential', name: 'Allée Michel Viala', width: 7, bridge: true, pts: [[0, 300], [60, 300]] };
  const info = bridgeGroups([mw, ramp]);
  const dry = () => 0;
  assert.equal(bridgeStyle(mw, info.get(mw), dry).kind, 'overpass');
  assert.equal(bridgeStyle(ramp, info.get(ramp), dry).kind, 'land');
});

test('高架の下の擁壁: 歩道の先に両側の壁を立て、壁の前と裏の格子点を道の高さに下げる', () => {
  // 5 m の格子（x・z −100〜100）。東西の道（幅 8 m）の両脇は |z| 6〜13 m の斜面で 6 m 上の盛り土。南北の高速道路の橋が上を渡る
  const cols = 41, rows = 41, DAT = 145, data = new Float32Array(cols * rows);
  const bank = (z) => Math.min(6, Math.max(0, ((Math.abs(z) - 6) * 6) / 7));
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) data[r * cols + c] = bank(-100 + r * 5) + DAT;
  const near = { ax: 0.2, bx: 20, az: 0.2, bz: 20, cols, rows, data };
  const h = (x, z) => {
    const u = Math.min(cols - 1.001, Math.max(0, x * 0.2 + 20)), v = Math.min(rows - 1.001, Math.max(0, z * 0.2 + 20));
    const c = Math.floor(u), r = Math.floor(v), fu = u - c, fv = v - r, at = (rr, cc) => data[rr * cols + cc];
    return (at(r, c) * (1 - fu) + at(r, c + 1) * fu) * (1 - fv) + (at(r + 1, c) * (1 - fu) + at(r + 1, c + 1) * fu) * fv - DAT;
  };
  const terrain = { flat: false, near, datum: DAT, h };
  const road = { id: 1, type: 'secondary', width: 8, pts: [[-100, 0], [100, 0]] };
  const mw = { id: 2, type: 'motorway', width: 10, bridge: true, pts: [[0, -40], [0, 40]] };
  const walls = conditionUnderpasses(terrain, [road, mw]);
  assert.ok(walls.length > 10, `壁 ${walls.length}`);
  assert.ok(walls.some((w) => w.nz > 0.9) && walls.some((w) => w.nz < -0.9), '両側に立つ（頭の上を渡る橋は壁を切らない）');
  for (const w of walls) {
    assert.ok(Math.abs(Math.abs(w.az) - 5.5) < 0.01, `壁は道の縁から 1.5 m 外: z ${w.az}`);
    assert.ok(w.at > 5.5 && w.ab < 0, `壁は道の高さから盛り土の上まで: ${w.ab}..${w.at}`);
  }
  assert.ok(h(10, 5.2) < 0.05 && h(10, -5.2) < 0.05, '壁の足元は道の高さ（斜面が壁の前に出ない）');
  assert.ok(h(10, 17) > 5.9, '壁の裏の先は盛り土の上');
  assert.equal(terrain.underpass, walls);
});
