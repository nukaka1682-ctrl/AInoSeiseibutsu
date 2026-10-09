import test from 'node:test';
import assert from 'node:assert/strict';
import { CURB_H, RaisedIndex, classifyStreet, discRim, makeObstacles, makeSoftObstacles, oldTownBase, oldTownWidth, planStreets, simplifyProfile, writePost, writeStreets } from '../../src/world/streets.js';
import { signedArea } from '../../src/geo.js';
import { MeshWriter } from '../../src/world/meshwriter.js';

const road = (id, type, width, pts, extra = {}) => ({ id, type, name: extra.name || `Rue ${id}`, width, pts, nodeIds: pts.map((_, i) => id * 100 + i), bridge: false, tunnel: false, oneway: false, surface: '', sidewalk: '', ...extra });
const box = (x0, z0, x1, z1) => ({ outer: [[x0, z0], [x1, z0], [x1, z1], [x0, z1]], holes: [] });

// 十字路: 東西の大通り（tertiary 8 m）と南北の通り（secondary 5 m。幹線道路どうしの交差点）。北東・南東の角に建物
function crossroads(nsType = 'secondary') {
  const ew = road(1, 'tertiary', 8, [[-100, 0], [0, 0], [100, 0]]);
  const ns = road(2, nsType, 5, [[0, -100], [0, 0]]);
  const ns2 = road(3, nsType, 5, [[0, 0], [0, 100]]);
  return { roads: [ew, ns, ns2], buildings: [box(10, 9, 60, 30), box(10, -30, 60, -7.5)] };
}

test('通りの種類: 旧市街の細い通りは石畳（一部 Rue du Taur 型）、それ以外の車道は縁石と歩道', () => {
  assert.equal(classifyStreet(road(1, 'pedestrian', 6, [[0, 0], [1, 0]]), true).kind, 'shared');
  assert.equal(classifyStreet(road(1, 'residential', 3, [[0, 0], [1, 0]], { name: 'Rue du Taur' }), true).kind, 'taur');
  assert.equal(classifyStreet(road(1, 'residential', 3, [[0, 0], [1, 0]], { name: 'Rue du Taur' }), false).kind, 'curb');
  assert.equal(classifyStreet(road(1, 'secondary', 7, [[0, 0], [1, 0]], { name: 'Rue de Metz' }), true).kind, 'curb');
  // 広い歩行者の通り（Alsace-Lorraine の一部）は小舗石でなく、壁から壁まで石の板
  const wide = classifyStreet(road(1, 'living_street', 9, [[0, 0], [1, 0]]), true);
  assert.equal(wide.kind, 'shared');
  assert.equal(wide.slabs, true);
  assert.equal(classifyStreet(road(1, 'living_street', 9, [[0, 0], [1, 0]]), false).kind, 'plain', '旧市街の外は今まで通り');
  assert.equal(classifyStreet(road(1, 'footway', 2.5, [[0, 0], [1, 0]]), false).kind, 'plain');
  assert.equal(classifyStreet(road(1, 'residential', 5, [[0, 0], [1, 0]], { bridge: true }), false).kind, 'bridge');
  // 石畳の通りは IGN の幅（車道だけ）より広い範囲でほかの道の歩道を切る
  assert.ok(classifyStreet(road(1, 'residential', 3, [[0, 0], [1, 0]]), true).band >= 3);
});

test('通りの計画: 交差点・続きの道・横断歩道と停止線、横断歩道の所で縁石を下げる', () => {
  const { roads } = crossroads();
  const plan = planStreets({ roads }, () => false);
  assert.equal(plan.junctions.length, 1);
  // 南北の 2 本はまっすぐつながる「続きの道」、東西の道とはつながらない
  assert.ok(plan.info.get(roads[1]).cont.has(roads[2]));
  assert.ok(!plan.info.get(roads[0]).cont.has(roads[1]));
  // 幹線道路どうしの交差点なので、4 本の腕すべてに横断歩道（交差する道の端から 1.2 m あけて）
  assert.equal(plan.crossings.length, 4);
  const ew = plan.crossings.filter((c) => c.road === roads[0]);
  assert.equal(ew.length, 2);
  for (const c of ew) {
    assert.ok(Math.abs(c.z) < 1e-9 && Math.abs(Math.abs(c.x) - (2.5 + 0.2 + 1.2 + 2)) < 1e-9, `大通りの横断歩道の中心 ${c.x}`);
    assert.equal(c.stop, 'half', '対面通行は交差点へ向かう半分に停止線');
  }
  // 旧市街の外で、幹線道路に住宅街の道が出るだけの交差点には横断歩道を引かない
  assert.equal(planStreets({ roads: crossroads('residential').roads }, () => false).crossings.length, 0);
  // 旧市街では引くが、停止線は格下の腕（住宅街の道）だけ。優先道路（tertiary）の側には引かない
  const old = planStreets({ roads: crossroads('residential').roads.map((r) => ({ ...r, width: r.type === 'residential' ? 7 : 8 })) }, () => true);
  assert.ok(old.crossings.length > 0);
  for (const q of old.crossings) assert.equal(q.stop === null, q.road.type === 'tertiary', `${q.road.type} の停止線`);
  // 縁石の高さ: 横断歩道の端で下がり、離れると元の高さ
  const c = ew[0];
  assert.ok(plan.curbHeight(c.x, 4.1) < 0.05);
  assert.equal(plan.curbHeight(c.x + 20 * Math.sign(c.x), 4.1), CURB_H);
  // 同じ parsed なら計画は使い回す
  assert.equal(planStreets({ roads }, () => false) === plan, false, '別の parsed なら作り直す');
});

test('通りの断面: 歩道は建物の壁まで延び、交差点で切れ、自転車は歩道の高さに上がる', () => {
  const { roads, buildings } = crossroads();
  const parsed = { roads };
  const plan = planStreets(parsed, () => false);
  const writers = {};
  const out = (k) => (writers[k] ||= new MeshWriter());
  const raised = new RaisedIndex();
  const clip = { minX: -100, minZ: -100, maxX: 100, maxZ: 100 };
  const stats = writeStreets(parsed, plan, clip, { buildings }, out, raised);
  assert.equal(stats.crossings, 4);
  for (const k of ['curb', 'sidewalk', 'gutter', 'marking']) assert.ok(writers[k] && !writers[k].empty, k);
  // 北東の建物（壁 z = 9）の前の歩道: 縁石（z = 4〜4.2）から壁まで高さ 13 cm
  assert.equal(raised.heightAt(30, 4.1), CURB_H);
  assert.equal(raised.heightAt(30, 8.5), CURB_H);
  // 車道の上と、交差点（南北の道の中）は 0
  assert.equal(raised.heightAt(30, 2), 0);
  assert.equal(raised.heightAt(0, 6), 0);
  // 建物のない北西側は既定の幅（2.5 m）で止まる
  assert.equal(raised.heightAt(-50, 6.5), CURB_H);
  assert.equal(raised.heightAt(-50, 7.5), 0);
  // 横断歩道の所は縁石が低い
  const c = plan.crossings.find((q) => q.road === roads[0] && q.x > 0);
  assert.ok(raised.heightAt(c.x, 4.1) < 0.05);
  // 横断歩道の脇の車止めは歩道の上にだけ立つ（車道の中・交差点の中には立たない）
  assert.ok(stats.posts > 0 && !writers.post.empty);
  const pp = writers.post.pos;
  for (let k = 0; k < pp.length; k += 3) if (pp[k + 1] < 0.5) assert.ok(raised.heightAt(pp[k], pp[k + 2]) > 0, `車止めの足元 ${pp[k]},${pp[k + 2]}`);
});

test('車止め: 角柱と頭（10 三角形）、足元は歩道の高さ', () => {
  const w = new MeshWriter();
  writePost(w, 1, 2, CURB_H, [0, 0, 0]);
  assert.equal(w.pos.length / 9, 10);
  const ys = w.pos.filter((_, i) => i % 3 === 1);
  assert.equal(Math.min(...ys), CURB_H);
  assert.ok(Math.abs(Math.max(...ys) - (CURB_H + 1)) < 1e-9);
});

test('壁までの距離と断面の間引き', () => {
  const ob = makeObstacles([box(0, 5, 10, 10)]);
  assert.ok(Math.abs(ob.ray(5, 0, 0, 1, 8).t - 5) < 1e-9);
  assert.equal(ob.ray(5, 0, 0, -1, 8), null);
  assert.ok(ob.ray(5, 7, 0, 1, 8).inside, '建物の中から出る');
  // 一直線に並んだ値は両端だけ残す。keep の点は残す
  const sts = [0, 2, 4, 6, 8].map((s) => ({ s, keep: false }));
  assert.deepEqual(simplifyProfile(sts, [[1, 1.1, 1.2, 1.3, 1.4]]), [0, 4]);
  sts[2].keep = true;
  assert.deepEqual(simplifyProfile(sts, [[1, 1.1, 1.2, 1.3, 1.4]]), [0, 2, 4]);
  // 壁の中へは深く入ってよいが、手前で止まってはいけない
  const s2 = [0, 2, 4].map((s) => ({ s, keep: false }));
  assert.deepEqual(simplifyProfile(s2, [[1, 0.6, 1]], [[[0.5, 0.1], [0.5, 0.1], [0.5, 0.1]]]), [0, 2]);
  assert.deepEqual(simplifyProfile(s2, [[1, 1.4, 1]], [[[0.5, 0.1], [0.5, 0.1], [0.5, 0.1]]]), [0, 1, 2]);
});

// 東西の大通り（tertiary 8 m、縁石の外は z = 4.2 から）と、北側の平らな面（線路・広場）
function straight(extra = {}) {
  const ew = road(1, 'tertiary', 8, [[-100, 0], [100, 0]]);
  return { roads: [ew], areas: [], rails: [], ...extra };
}
function build(parsed, clip, buildings = []) {
  const plan = planStreets(parsed, () => false);
  const writers = {};
  const raised = new RaisedIndex();
  const stats = writeStreets(parsed, plan, clip, { buildings }, (k) => (writers[k] ||= new MeshWriter()), raised);
  return { raised, writers, stats };
}
const ALL = { minX: -100, minZ: -100, maxX: 100, maxZ: 100 };

test('歩道は線路（トラムの軌道）の手前で止まり、自転車も線路の上で持ち上がらない', () => {
  const parsed = straight({ rails: [{ type: 'tram', pts: [[-100, 6.2], [100, 6.2]], bridge: false }] });
  const { raised } = build(parsed, ALL);
  for (const x of [-60, -10, 25, 70]) {
    assert.equal(raised.heightAt(x, 6.2), 0, `線路の上 ${x}`);
    assert.equal(raised.heightAt(x, 5), 0, `線路の脇 ${x}`);
    assert.equal(raised.heightAt(x, -5), CURB_H, `線路のない南側の歩道 ${x}`);
  }
});

test('歩道は広場・緑地の縁で止まり、広場の中には入らない', () => {
  const plaza = { type: 'plaza', ...box(-30, 5.5, 30, 40) };
  plaza.bounds = { minX: -30, minZ: 5.5, maxX: 30, maxZ: 40 };
  const { raised } = build(straight({ areas: [plaza] }), ALL);
  assert.equal(raised.heightAt(0, 4.8), CURB_H, '広場の手前までは歩道');
  assert.equal(raised.heightAt(0, 6), 0, '広場の中');
  assert.equal(raised.heightAt(-60, 6.5), CURB_H, '広場のない所は既定の幅');
});

test('車道・縁石に重なり、縁が歩道の最大幅より遠い広場でも、その中には歩道を敷かない', () => {
  // 広場の縁は車道の中（z = 2）、反対側の縁は 40 m 先（歩道を調べる 8 m より遠い）
  const plaza = { type: 'plaza', ...box(-30, 2, 30, 40) };
  plaza.bounds = { minX: -30, minZ: 2, maxX: 30, maxZ: 40 };
  const { raised } = build(straight({ areas: [plaza] }), ALL);
  for (const z of [4.3, 5, 6, 9]) assert.equal(raised.heightAt(0, z), 0, `広場の中 z=${z}`);
  assert.equal(raised.heightAt(-60, 6.5), CURB_H, '広場のない所は既定の幅');
  assert.equal(raised.heightAt(0, -5), CURB_H, '反対側の歩道はそのまま');
  // 面の中の判定（点の判定なので、縁がどこにあっても効く）
  const soft = makeSoftObstacles({ areas: [plaza], rails: [] }, ALL);
  assert.equal(soft.inside(0, 4.4), true);
  assert.equal(soft.inside(0, 1), false);
});

test('旧市街の石畳: 広場の中では幅を広げず、道の端の円も広場に入れない', () => {
  // 東西の細い通りが広場を横切り、南北の通りが広場の中で終わる
  const plaza = { type: 'plaza', ...box(-20, -30, 20, 30) };
  plaza.bounds = { minX: -20, minZ: -30, maxX: 20, maxZ: 30 };
  const parsed = { roads: [road(1, 'residential', 4, [[-100, 0], [100, 0]]), road(2, 'pedestrian', 4, [[0, -100], [0, 0]])], areas: [plaza], rails: [] };
  const plan = planStreets(parsed, () => true);
  const writers = {};
  writeStreets(parsed, plan, ALL, {}, (k) => (writers[k] ||= new MeshWriter()), new RaisedIndex());
  let outside = 0;
  for (const k of ['setts', 'slabs', 'gutter']) {
    const pos = writers[k]?.pos || [];
    for (let i = 0; i < pos.length; i += 9) {
      const cx = (pos[i] + pos[i + 3] + pos[i + 6]) / 3, cz = (pos[i + 2] + pos[i + 5] + pos[i + 8]) / 3;
      // 断面の間隔（2.5 m）より奥の広場の中には石畳がない
      assert.ok(!(Math.abs(cx) < 17 && Math.abs(cz) < 27), `${k} の三角形が広場の中 (${cx.toFixed(1)}, ${cz.toFixed(1)})`);
      if (Math.abs(cx) > 25 || cz < -35) outside++;
    }
  }
  assert.ok(outside > 0, '広場の外には石畳がある');
  // 広場で止まる所は最低の幅を強制しない。ほかの車道で止まる所は車道の幅まで
  assert.equal(oldTownWidth({ t: 0, stop: 'soft' }, 2, 8), 0);
  assert.equal(oldTownWidth({ t: 1.1, stop: 'soft' }, 2, 8), 1.1);
  assert.equal(oldTownWidth({ t: 0, stop: 'road' }, 2, 8), 2);
  assert.equal(oldTownWidth({ t: 3, stop: 'facade' }, 2, 8), 3.3);
});

test('道の端の円は広場の縁で縮み、中心が広場の中なら描かない', () => {
  const plaza = { type: 'plaza', ...box(1, -10, 20, 10) };
  plaza.bounds = { minX: 1, minZ: -10, maxX: 20, maxZ: 10 };
  const soft = makeSoftObstacles({ areas: [plaza], rails: [] }, ALL);
  const rim = discRim(0, 0, 3, 12, soft);
  assert.equal(rim.length, 12);
  for (const [x] of rim) assert.ok(x <= 1 + 1e-6, `円の点が広場の中 x=${x}`);
  assert.ok(Math.abs(rim[6][0] + 3) < 1e-9, '広場と反対側は元の半径');
  assert.equal(discRim(5, 0, 3, 12, soft), null);
});

test('旧市街の地面の下地: 範囲の中の旧市街の外形をマスごとに切る（すき間も重なりもない）', () => {
  const ring = [[-40, -40], [120, -40], [120, 120], [-40, 120]];
  const cells = oldTownBase(ring, { minX: 0, minZ: 0, maxX: 100, maxZ: 100 });
  assert.equal(cells.length, 4);
  const area = cells.reduce((a, r) => a + Math.abs(signedArea(r)), 0);
  assert.ok(Math.abs(area - 10000) < 1e-6, `面積 ${area}`);
  assert.deepEqual(oldTownBase(ring, { minX: 200, minZ: 200, maxX: 300, maxZ: 300 }), []);
  assert.deepEqual(oldTownBase(null, { minX: 0, minZ: 0, maxX: 1, maxZ: 1 }), []);
});

test('タイルの境: 2 つの範囲に分けて作っても、境の両側で歩道の高さがそろう', () => {
  // 境 x = 0 のあたりで壁までの距離が変わる建物の並び
  const buildings = [box(-40, 9, -12, 30), box(-12, 6.5, 3, 30), box(3, 11, 30, 30), box(-25, -30, 8, -7.2), box(14, -30, 50, -12)];
  const parsed = straight();
  const W = build(parsed, { minX: -100, minZ: -100, maxX: 0, maxZ: 100 }, buildings);
  const E = build(parsed, { minX: 0, minZ: -100, maxX: 100, maxZ: 100 }, buildings);
  const one = build(parsed, ALL, buildings);
  const H = (x, z) => Math.max(W.raised.heightAt(x, z), E.raised.heightAt(x, z));
  let n = 0;
  for (let z = -14; z <= 14; z += 0.1) {
    const a = H(-0.05, z), b = H(0.05, z);
    assert.ok(Math.abs(a - b) < 1e-6, `境の両側 z=${z.toFixed(1)}: ${a} / ${b}`);
    assert.ok(Math.abs(a - one.raised.heightAt(-0.05, z)) < 1e-6, `1 つの範囲で作ったときと同じ z=${z.toFixed(1)}`);
    if (a > 0) n++;
  }
  assert.ok(n > 50, '境に歩道がある');
});
