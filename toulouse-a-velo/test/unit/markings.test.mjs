import test from 'node:test';
import assert from 'node:assert/strict';
import { DASH, catenaryStations, frameAt, inLaneBand, laneLayout, mergeIntervals, slicePolyline, subtract, tramCrossCuts, writePicture, RED_LANE, writeRoadMarkings } from '../../src/world/markings.js';
import { planStreets, writeSignal } from '../../src/world/streets.js';
import { writeCatenary } from '../../src/world/ground.js';
import { MeshWriter } from '../../src/world/meshwriter.js';

const road = (o) => ({ id: 1, type: 'tertiary', name: '', width: 7, oneway: false, bridge: false, tunnel: false, lanes: 0, cycleway: '', pts: [[0, 0], [200, 0]], ...o });
const cumOf = (pts) => pts.reduce((c, p, i) => (i ? [...c, c[i - 1] + Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1])] : [0]), []);

// 書いた頂点を集める（高さを地形で持ち上げる書き込み先の代わり: drape(x, z) を y に足す）
function collector(drape = () => 0) {
  const v = [];
  const push = (p) => v.push([p[0], p[1] + drape(p[0], p[2]), p[2]]);
  return { v, quad: (a, b, c, d) => [a, b, c, d].forEach(push), tri: (a, b, c) => [a, b, c].forEach(push) };
}

test('車線の並び: 中央線・住宅街・バスレーン・自転車レーン・自転車道・広い道', () => {
  const two = laneLayout(road());
  assert.deepEqual(two.lines.map((l) => [l.off, l.kind]), [[0, 't1']]);
  assert.equal(laneLayout(road({ type: 'residential', width: 6 })).lines.length, 0, '住宅街の狭い道は線なし');
  const metz = laneLayout(road({ name: 'Rue de Metz', width: 9, oneway: true }));
  assert.ok(metz.lines.some((l) => l.kind === 'solid' && Math.abs(l.off - 1.3) < 1e-9 && l.w === 0.25), 'バスレーンの太い実線');
  assert.ok(metz.pics.some((p) => p.kind === 'bus') && metz.bike);
  const rep = laneLayout(road({ name: 'Rue de la République', width: 5, oneway: true, type: 'secondary' }));
  assert.ok(rep.lines.some((l) => l.kind === 't3' && Math.abs(l.off - 1) < 1e-9), '右に 1.5 m の自転車レーン');
  assert.ok(rep.pics.some((p) => p.kind === 'bike') && rep.pics.some((p) => p.kind === 'arrow'));
  const both = laneLayout(road({ name: 'Avenue de Grande Bretagne', width: 14 }));
  assert.ok(both.pics.some((p) => p.dir === -1 && p.off < 0), '両方向の道は左側の自転車レーンが逆向き');
  assert.deepEqual(laneLayout(road({ type: 'cycleway', width: 2.5 })).pics.map((p) => p.kind), ['bike']);
  const wide = laneLayout(road({ type: 'primary', width: 13, lanes: 4 }));
  assert.ok(wide.lines.some((l) => l.off === 0 && l.kind === 'solid'), '4 車線は中央が実線');
  assert.equal(wide.lines.filter((l) => l.kind === 't1').length, 2);
  assert.equal(wide.lines.filter((l) => Math.abs(Math.abs(l.off) - 6.2) < 1e-9).length, 2, '路側線');
  assert.equal(laneLayout(road({ type: 'residential', width: 5 }), { x: -400, z: 130 }).speed, 'n20', 'サン・シプリアンは 20');
  assert.equal(laneLayout(road({ type: 'residential', width: 5 }), { x: 400, z: -300 }).speed, 'n30');
  assert.equal(laneLayout(road({ type: 'footway' })).lines.length, 0);
});

test('区間: まとめる・除く・折れ線の点', () => {
  assert.deepEqual(mergeIntervals([[5, 8], [0, 2], [1, 3], [7, 9]]), [[0, 3], [5, 9]]);
  assert.deepEqual(subtract(0, 10, [[2, 3], [5, 6]]), [[0, 2], [3, 5], [6, 10]]);
  assert.deepEqual(subtract(0, 10, [[-1, 11]]), []);
  const pts = [[0, 0], [10, 0], [10, 10]];
  const f = frameAt(pts, cumOf(pts), 15);
  assert.ok(Math.abs(f.x - 10) < 1e-9 && Math.abs(f.z - 5) < 1e-9 && f.uz === 1);
});

test('破線: 交差点の区間を避け、タイルで切っても同じ線（継ぎ目なし）、坂でも路面に沿う', () => {
  const r = road();
  const cum = cumOf(r.pts), lay = laneLayout(r);
  const cuts = [[-1, 12], [95, 118]];
  const all = { minX: -50, minZ: -50, maxX: 250, maxZ: 50 };
  const one = collector();
  writeRoadMarkings(r, cum, lay, cuts, all, one, one);
  assert.ok(one.v.length > 0);
  for (const [x] of one.v) assert.ok(x >= 12 - 1e-6 && (x <= 95 + 1e-6 || x >= 118 - 1e-6), `区間の中に線 x=${x}`);
  // 3 m の線と 10 m のすき間（道の始点から）
  const xs = [...new Set(one.v.map(([x]) => Math.round(x * 100) / 100))].sort((a, b) => a - b);
  assert.ok(xs.includes(13) && xs.includes(16) && xs.includes(26) && xs.includes(29), xs.slice(0, 6).join(','));
  const a = collector(), b = collector();
  writeRoadMarkings(r, cum, lay, cuts, { ...all, maxX: 100 }, a, a);
  writeRoadMarkings(r, cum, lay, cuts, { ...all, minX: 100 }, b, b);
  const key = (v) => v.map((p) => p.map((c) => c.toFixed(3)).join()).sort().join(';');
  assert.equal(key([...a.v, ...b.v]), key(one.v));
  // 坂（h = 0.05·x）: 地面からの高さで書くので、地形を足す書き込み先では全部の頂点が路面から 3 cm 以内
  const h = (x) => 0.05 * x;
  const slope = collector(h);
  writeRoadMarkings(road({ name: 'Rue de Metz', width: 9, oneway: true, type: 'secondary', pts: [[0, 0], [80, 30], [200, 30]] }), cumOf([[0, 0], [80, 30], [200, 30]]), laneLayout(road({ name: 'Rue de Metz', width: 9, oneway: true })), [], all, slope, slope);
  assert.ok(slope.v.length > 0);
  for (const [x, y] of slope.v) assert.ok(Math.abs(y - h(x)) < 0.03);
  // 信号機も足元の高さ y0（地面＋歩道）からの形
  const sig = collector();
  writeSignal(sig, 5, 5, h(5) + 0.13, 1, 0, [0, 0, 0]);
  assert.ok(Math.abs(Math.min(...sig.v.map((p) => p[1])) - (h(5) + 0.13)) < 1e-9);
  assert.ok(Math.max(...sig.v.map((p) => p[1])) - (h(5) + 0.13) <= 3.0 + 1e-9);
});

test('絵: アトラスの升と向き（上 = 進む向き）', () => {
  const w = new MeshWriter();
  writePicture(w, 0, 0, 0, -1, 'bus');
  const g = w.toGeometry();
  const pos = g.getAttribute('position'), uv = g.getAttribute('uv');
  for (let i = 0; i < pos.count; i++) {
    assert.ok(uv.getX(i) >= 2 / 8 && uv.getX(i) <= 3 / 8, 'BUS の升');
    // 北（-z）へ進む人が読む: 前（z が小さい）ほど v が大きい
    if (pos.getZ(i) < 0) assert.equal(uv.getY(i), 1);
    else assert.equal(uv.getY(i), 0);
  }
  assert.equal(DASH.t1.join(), '3,10');
});

test('交差点の手前で標示を止める区間（planStreets）', () => {
  const ew = road({ id: 1, name: 'Rue A', pts: [[-150, 0], [0, 0], [150, 0]] });
  const ns = road({ id: 2, name: 'Rue B', type: 'primary', width: 9, pts: [[0, -150], [0, 0], [0, 150]] });
  const plan = planStreets({ roads: [ew, ns] });
  const cuts = plan.info.get(ew).cuts;
  assert.ok(cuts.length === 1 && cuts[0][0] < 150 - 4.5 - 2 && cuts[0][1] > 150 + 4.5 + 2, JSON.stringify(cuts));
  assert.equal(plan.layout(ew), plan.layout(ew), '並びは 1 回だけ作る');
});

test('一覧の通りのレーンは狭い区間でも途切れない（1 m）、帯の判定', () => {
  const rep = road({ name: 'Rue de la République', width: 5.5 });
  const lay = laneLayout(rep);
  assert.ok(lay.right && Math.abs(lay.rw - 1) < 1e-9, JSON.stringify(lay));
  assert.ok(!laneLayout(road({ width: 5.5, cycleway: 'lane' })).right, '一覧にない通りは 1.5 m 取れなければなし');
  assert.ok(laneLayout(road({ name: 'Rue de la République', width: 7 })).lines.some((l) => l.off === -0.75 && l.kind === 't1'), '両方向は中央線');
  // 東向きの道（中心 z = 0、半幅 2.75）: 右（+z）の縁石から 1 m がレーン
  const L = () => lay;
  assert.ok(inLaneBand(50, 2.2, [rep], L));
  assert.ok(!inLaneBand(50, 1.5, [rep], L) && inLaneBand(50, 1.5, [rep], L, 0.6), 'pad で車道の側へ広げる');
  assert.ok(!inLaneBand(50, -2.2, [rep], L) && !inLaneBand(50, 3.3, [rep], L) && !inLaneBand(250, 2.2, [rep], L));
});

test('トラムの架線柱: 35 m おき、複線は 2 本の線の真ん中に 1 本、範囲の中だけ', () => {
  const t1 = { type: 'tram', pts: [[0, 0], [200, 0]] }, t2 = { type: 'tram', pts: [[0, 3.5], [200, 3.5]] };
  const c = collector();
  const poles = writeCatenary([t1, t2, { type: 'rail', pts: [[0, 50], [200, 50]] }], { minX: 0, minZ: -20, maxX: 100, maxZ: 20 }, c);
  assert.deepEqual(poles.map(([x]) => Math.round(x)), [18, 53, 88]);
  assert.ok(poles.every(([, z]) => Math.abs(z - 1.75) < 1e-6), '柱は 2 本の線の真ん中');
  assert.ok(c.v.every(([, y]) => y >= 0 && y <= 7.5));
  assert.ok(c.v.some(([, y, z]) => y > 5.8 && z > 3.4) && c.v.some(([, y, z]) => y > 5.8 && z < 0.1), '腕は両方の線の上まで');
});

test('トラムの架線柱: 車道・横断歩道を横切る所には立てない', () => {
  assert.deepEqual(catenaryStations(100, [], 35), [17.5, 52.5, 87.5]);
  // 17.5 m の柱は区間 [12, 20] の 3 m 先へ、52.5 m の柱は区間 [40, 80] の先が次の柱に近すぎるので立てない
  assert.deepEqual(catenaryStations(120, [[12, 20], [40, 80]], 35), [23, 87.5]);
  // 南北の車道（幅 8 m）を直角に横切るトラム: 車道の帯（± 4 m）に柱がない
  const t = { type: 'tram', pts: [[0, 0], [200, 0]] };
  for (const x0 of [17.5, 52.5, 87.5, 122.5]) {
    const cross = { pts: [[x0, -100], [x0, 100]], width: 8 };
    const poles = writeCatenary([t], { minX: 0, minZ: -20, maxX: 200, maxZ: 20 }, collector(), (r) => tramCrossCuts(r.pts, [cross]));
    assert.ok(poles.length >= 4, `${poles.length}`);
    for (const [x] of poles) assert.ok(Math.abs(x - x0) > 4 + 0.5, `柱 x=${x} が車道 x=${x0} の中`);
  }
});

test('トラム: 架線柱は電車にかからない所、坂でも地面から、交差点と横断歩道で芝を切る', () => {
  const t = { type: 'tram', pts: [[0, 0], [200, 0]] };
  const h = (x) => 0.05 * x;
  const c = collector(h);
  const poles = writeCatenary([t], { minX: 0, minZ: -20, maxX: 200, maxZ: 20 }, c);
  for (const [, z] of poles) assert.ok(Math.abs(z) - 0.11 >= 2 - 0.2 && Math.abs(z) < 2.6, `柱 z=${z}（電車の幅 2.4 m の外、芝の帯の縁）`);
  for (const [x, y] of c.v) assert.ok(y - h(x) >= -1e-9 && y - h(x) <= 7.5 + 1e-9, '地面からの高さ');
  // 南北の車道（幅 8 m）を直角に横切る所と、斜め 45° の道、並んで走る道（切らない）、横断歩道
  const cross = { pts: [[50, -100], [50, 100]], width: 8 };
  const diag = { pts: [[100, -20], [140, 20]], width: 6 };
  const along = { pts: [[0, 0.5], [200, 0.5]], width: 12 };
  const xw = { x: 170, z: 0, ux: 1, uz: 0, len: 4, half: 5 }; // トラムの走る東西の道の横断歩道
  const cuts = tramCrossCuts(t.pts, [cross, diag, along], [xw]);
  assert.equal(cuts.length, 3, JSON.stringify(cuts));
  assert.ok(Math.abs(cuts[0][0] - 45) < 1e-6 && Math.abs(cuts[0][1] - 55) < 1e-6);
  assert.ok(Math.abs(cuts[1][0] - (120 - 4 * Math.SQRT2)) < 1e-6 && Math.abs(cuts[1][1] - (120 + 4 * Math.SQRT2)) < 1e-6, "斜めの道は帯を斜めに横切る長さ");
  assert.ok(Math.abs(cuts[2][0] - 167.7) < 1e-6 && Math.abs(cuts[2][1] - 172.3) < 1e-6);
  const pts = [[0, 0], [10, 0], [10, 10]];
  assert.deepEqual(slicePolyline(pts, [0, 10, 20], 5, 15), [[5, 0], [10, 0], [10, 5]]);
});

test('赤い舗装の自転車レーン: Route de Bayonne は自転車レーンの幅に赤い面（白い破線の下）', () => {
  const lay = laneLayout(road({ name: 'Route de Bayonne', type: 'primary', width: 12 }));
  const fills = lay.lines.filter((l) => l.kind === 'fill');
  assert.equal(fills.length, 2, '両側');
  for (const f of fills) {
    assert.deepEqual(f.color, RED_LANE);
    assert.ok(f.w > 0.9 && f.w < 1.5);
    // 面は破線の内側（車道の縁の側）
    const dash = lay.lines.find((l) => l.kind === 't3' && Math.sign(l.off) === Math.sign(f.off));
    assert.ok(Math.abs(f.off) > Math.abs(dash.off));
  }
  assert.equal(laneLayout(road({ name: 'Avenue Étienne Billières', type: 'primary', width: 12 })).lines.filter((l) => l.kind === 'fill').length, 0, 'ほかの通りは白線だけ');
});
