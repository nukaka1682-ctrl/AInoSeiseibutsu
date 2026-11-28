import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { LocalProjection, pointInPolygon } from '../../src/geo.js';
import {
  MONUMENTS, ZODIAC, buildMonuments, cabanisLayout, circleOf, fenceColliders, findMonuments, kerbSpot, monumentClearance, monumentSolid, occitanCross, orientedBox, placeOnPlaza, rayRing, stadiumAnnexes, stadiumRays, strokeQuads,
} from '../../src/world/monuments.js';

const rect = (cx, cz, a, b, t = 0) => {
  const c = Math.cos(t), s = Math.sin(t);
  return [[-a, -b], [a, -b], [a, b], [-a, b]].map(([u, v]) => [cx + u * c - v * s, cz + u * s + v * c]);
};
const circle = (cx, cz, r, n = 24) => Array.from({ length: n }, (_, i) => [cx + Math.cos((i / n) * Math.PI * 2) * r, cz + Math.sin((i / n) * Math.PI * 2) * r]);
const bld = (outer, info = {}, holes = []) => {
  const xs = outer.map((p) => p[0]), zs = outer.map((p) => p[1]);
  const area = Math.abs(outer.reduce((s, p, i) => s + p[0] * outer[(i + 1) % outer.length][1] - outer[(i + 1) % outer.length][0] * p[1], 0) / 2);
  const cx = xs.reduce((s, x) => s + x, 0) / xs.length, cz = zs.reduce((s, z) => s + z, 0) / zs.length;
  return { outer, holes, inside: [cx, cz], bounds: { minX: Math.min(...xs), maxX: Math.max(...xs), minZ: Math.min(...zs), maxZ: Math.max(...zs) }, info: { area, height: 12, ...info }, tags: {} };
};

test('オクシタン十字: 12 の玉、中心について 4 回対称、差し渡し 2R', () => {
  const R = 8;
  const { ring, pommels } = occitanCross(R);
  assert.equal(pommels.length, 12);
  const ext = Math.max(...ring.map(([x, z]) => Math.max(Math.abs(x), Math.abs(z))));
  assert.ok(Math.abs(ext - R) < 1e-9, '先端の玉までの距離が R');
  for (const [x, z] of ring) {
    // 90° 回した点も輪の上にある
    assert.ok(ring.some(([p, q]) => Math.hypot(p - z, q + x) < 1e-9));
  }
  // 玉はたがいに重ならない（メダルの半径 1.3 m）
  for (let i = 0; i < 12; i++) for (let j = i + 1; j < 12; j++) assert.ok(Math.hypot(pommels[i][0] - pommels[j][0], pommels[i][1] - pommels[j][1]) > 2.7);
  assert.equal(ZODIAC.length, 12);
});

test('線を四角形にする: 開いた折れ線は n-1、閉じた折れ線は n 枚、幅がそろう', () => {
  const q = strokeQuads([[0, 0], [10, 0], [10, 10]], false, 0, 0.2);
  assert.equal(q.length, 2);
  assert.ok(Math.abs(Math.hypot(q[0][0][0] - q[0][1][0], q[0][0][1] - q[0][1][1]) - 0.2) < 1e-9);
  assert.equal(strokeQuads(rect(0, 0, 5, 5), true, 0.3, 0.1).length, 4);
});

test('向きの付いた長方形・放射線・円', () => {
  const t = 0.4;
  const box = orientedBox(rect(10, -5, 30, 12, t));
  assert.ok(Math.abs(box.a - 30) < 1e-6 && Math.abs(box.b - 12) < 1e-6);
  assert.ok(Math.abs(Math.abs(box.e1[0] * Math.cos(t) + box.e1[1] * Math.sin(t)) - 1) < 1e-6, '長い辺の向き');
  assert.ok(Math.hypot(box.cx - 10, box.cz + 5) < 1e-6);
  // 縦長の長方形（長い辺が 2 番目の向き）: e1 は長い辺、e2 は e1 に直角
  const tall = orientedBox(rect(0, 0, 8, 25, 0));
  assert.ok(Math.abs(tall.a - 25) < 1e-6 && Math.abs(tall.b - 8) < 1e-6);
  assert.ok(Math.abs(tall.e1[0] * tall.e2[0] + tall.e1[1] * tall.e2[1]) < 1e-9, 'e2 は e1 に直角');
  assert.ok(Math.abs(rayRing(0, 0, 1, 0, rect(0, 0, 20, 10)) - 20) < 1e-9);
  const c = circleOf(circle(3, 4, 9));
  assert.ok(Math.hypot(c.x - 3, c.z - 4) < 1e-6 && Math.abs(c.r - 9) < 1e-6);
});

test('スタジアム: 内側（ピッチ）は外壁より内、穴がなければ外形の 0.62 倍', () => {
  const outer = rect(0, 0, 100, 80), hole = rect(0, 0, 60, 40);
  const { rays } = stadiumRays(outer, hole, 36);
  assert.equal(rays.length, 36);
  for (const r of rays) assert.ok(r.rin > 0 && r.rin < r.rout - 6);
  assert.ok(Math.abs(rays[0].rin - 60) < 1e-6 && Math.abs(rays[0].rout - 100) < 1e-6);
  const { rays: r2 } = stadiumRays(outer, null, 8);
  assert.ok(Math.abs(r2[0].rin - 62) < 1e-6);
});

test('カバニス: 3 つの外形の真ん中が開口、正面は front の点の側', () => {
  const t = 0.8;
  const at = (u, v) => [u * Math.cos(t) - v * Math.sin(t), u * Math.sin(t) + v * Math.cos(t)];
  const strip = (u0, u1) => [at(u0, -23), at(u1, -23), at(u1, 23), at(u0, 23)];
  const lay = cabanisLayout([strip(0, 22), strip(22, 37), strip(37, 67)], at(30, 200));
  assert.ok(Math.abs(lay.a - 33.5) < 1e-6 && Math.abs(lay.b - 23) < 1e-6);
  assert.ok(Math.abs(lay.m1 - lay.m0 - 15) < 1e-6, '開口の幅');
  const um = (lay.m0 + lay.m1) / 2;
  assert.ok(Math.abs(Math.abs(um) - 4) < 1e-6, '開口の中心は枠の中心から 4 m');
  // 正面（庇）は駅の方
  const fv = at(30, 200);
  assert.ok(((fv[0] - lay.cx) * lay.e2[0] + (fv[1] - lay.cz) * lay.e2[1]) * lay.front > 0);
  assert.equal(lay.mid, 1, '開口にした外形（通り抜けられる）');
  // 小さなかけらは数えない（大きな外形が 2 つだけなら開口は中央の既定の幅、通り抜けなし）
  const lay2 = cabanisLayout([strip(0, 30), strip(30, 31), strip(31, 67)]);
  assert.equal(lay2.mid, -1);
  assert.ok(Math.abs(lay2.m1 - lay2.m0 - lay2.a * 0.24) < 1e-6);
});

test('スタジアム: 外壁に食い込んだ角の塔は頂点を共有する高いものだけ', () => {
  const outer = [[0, 0], [100, 0], [100, 6], [100, 60], [0, 60]];
  const stadium = { outer, info: { area: 6000, height: 12 } };
  const tower = { outer: [[100, 0], [104, 0], [104, 6], [100, 6]], info: { area: 24, height: 20 } };
  const corner = { outer: [[0.8, -0.6], [-5, 0], [-5, -5], [0, -5]], info: { area: 20, height: 20 } };
  const kiosk = { outer: [[0, 60], [-3, 60], [-3, 63], [0, 63]], info: { area: 9, height: 3 } };
  const away = { outer: [[120, 0], [124, 0], [124, 4], [120, 4]], info: { area: 16, height: 20 } };
  const big = { outer: [[100, 0], [140, 0], [140, 60], [100, 60]], info: { area: 2400, height: 12 } };
  const got = stadiumAnnexes(stadium, [stadium, tower, corner, kiosk, away, big]);
  assert.deepEqual(got, [tower, corner]);
});

test('広場の上の置き場所: 車道・建物を避け、広場の中', () => {
  const plaza = { outer: rect(0, 0, 30, 20), holes: [] };
  const onRoad = (x, z) => z > 15;
  const p = placeOnPlaza(plaza, [0, 18], (x, z) => !onRoad(x, z) && !onRoad(x, z + 2.5));
  assert.ok(p && pointInPolygon(p[0], p[1], plaza) && p[1] + 2.5 <= 15);
  assert.equal(placeOnPlaza(plaza, [0, 0], () => false, 5), null);
});

test('名所の専用モデルを見つける: 外形の置き換えと、タイルの範囲', () => {
  const proj = new LocalProjection(43.5994, 1.4395);
  const spec = (id) => MONUMENTS.find((m) => m.id === id);
  const [cx, cz] = proj.project(spec('chateau-eau').lat, spec('chateau-eau').lon);
  const tower = bld(circle(cx + 2, cz - 1, 9.5));
  const other = bld(rect(cx + 30, cz, 6, 6));
  const [sx, sz] = proj.project(spec('stadium').lat, spec('stadium').lon);
  const stadium = bld(rect(sx, sz, 100, 80), {}, [rect(sx, sz, 60, 40)]);
  const [ox, oz] = proj.project(spec('coq').lat, spec('coq').lon);
  const olivier = { name: 'Place Olivier', outer: rect(ox, oz, 25, 20), holes: [], bounds: {} };
  const onRoad = (x, z) => z > oz + 12;
  const all = findMonuments(proj, { buildings: [tower, other, stadium], areas: [olivier], onRoad });
  const ch = all.find((m) => m.kind === 'chateau');
  assert.ok(ch && ch.replaced[0] === tower && Math.abs(ch.rBase - 9.5) < 0.1);
  assert.ok(Math.hypot(ch.x - cx - 2, ch.z - cz + 1) < 1e-6);
  const st = all.find((m) => m.kind === 'stadium');
  assert.ok(st && st.replaced[0] === stadium && st.hole);
  const coq = all.find((m) => m.kind === 'coq');
  assert.ok(coq && Math.abs(coq.angle - Math.PI / 2) < 0.2, '像は車道の方（+z）を向く');
  assert.equal(all.filter((m) => m.kind === 'cross').length, 0, 'キャピトル広場がなければ十字は作らない');
  // タイルの範囲の外の像は作らない
  const none = findMonuments(proj, { buildings: [], areas: [olivier], onRoad, bounds: { minX: ox + 100, maxX: ox + 600, minZ: oz, maxZ: oz + 500 } });
  assert.equal(none.length, 0);
  // 塔と像のまわりには木を植えない
  const clear = monumentClearance(all);
  assert.ok(clear(ch.x + 5, ch.z) && clear(coq.x + 1, coq.z) && !clear(ch.x + 40, ch.z));
});

test('オクシタン十字はキャピトルの正面の軸の上、広場の中', () => {
  const proj = new LocalProjection(43.5994, 1.4395);
  const square = { name: 'Place du Capitole', outer: rect(300, -550, 40, 55), holes: [], bounds: {} };
  const facade = { origin: [345, -620], dir: [0, 1], normal: [-1, 0], t0: 0, t1: 120, edges: [] };
  const [cross] = findMonuments(proj, { areas: [square], facade }).filter((m) => m.kind === 'cross');
  assert.ok(cross);
  assert.ok(Math.abs(cross.z - -560) < 1e-6, '正面の中央の正面');
  assert.ok(Math.abs(cross.x - 300) < 1e-6);
  assert.deepEqual(cross.ax, [-1, 0]);
});

test('円い柵の当たり判定: 全部立てば円 1 つ、抜けがあれば立った区間だけの線分', () => {
  const n = 64;
  assert.deepEqual(fenceColliders(10, 20, 5, Array(n).fill(true)), [[10, 20, 5.05]]);
  // 0..9 の柱が道路で抜ける: 線分は残りの柱の上だけ、抜けた所をまたがない
  const up = Array.from({ length: n }, (_, k) => k >= 10);
  const segs = fenceColliders(0, 0, 5, up);
  assert.ok(segs.length >= 6);
  const angleOf = (x, z) => ((Math.atan2(z, x) / (Math.PI * 2)) * n + n) % n;
  for (const [ax, az, bx, bz] of segs) {
    assert.ok(Math.abs(Math.hypot(ax, az) - 5) < 1e-9 && Math.abs(Math.hypot(bx, bz) - 5) < 1e-9, '柵の円の上');
    for (const t of [0, 0.5, 1]) {
      const k = angleOf(ax + (bx - ax) * t, az + (bz - az) * t);
      assert.ok(k > 9.5 - 1e-9, `抜けの区間（0..9）をまたがない: ${k}`);
    }
  }
  // 区間の両端の柱まで覆う
  const ks = segs.flatMap(([ax, az, bx, bz]) => [angleOf(ax, az), angleOf(bx, bz)]);
  assert.ok(Math.min(...ks) < 10 + 1e-6 && Math.max(...ks) > 63 - 1e-6);
});

test('木を植えない所: シャトー・ドーは柵の外の歩道まで、雄鶏の像は台のまわりだけ', () => {
  const clear = monumentClearance([{ kind: 'chateau', x: 0, z: 0, rBase: 9.5 }, { kind: 'coq', x: 100, z: 0 }]);
  assert.ok(clear(0, 17) && !clear(0, 19));
  assert.ok(clear(102, 0) && !clear(104, 0));
});

test('雄鶏の像: 見える車道の縁石から 2.5〜4 m の歩道の上で、車道の方を向く（広場の下を通る道は使わない）', () => {
  const plaza = { outer: rect(0, 0, 30, 20), holes: [] };
  // 広場の北の縁に沿う車道（幅 6 m、中心線 z = -23）と、広場の下を通る道（z = 5。舗装に隠れる）
  const visible = { type: 'secondary', width: 6, pts: [[-50, -23], [50, -23]] };
  const hidden = { type: 'residential', width: 4, pts: [[-50, 5], [50, 5]] };
  const onRoad = (x, z) => Math.abs(z + 23) < 3.3 || Math.abs(z - 5) < 2.3;
  const free = (x, z) => Array.from({ length: 8 }, (_, k) => (k / 8) * Math.PI * 2).every((t) => !onRoad(x + Math.cos(t) * 2.5, z + Math.sin(t) * 2.5));
  const k = kerbSpot(plaza, [visible, hidden], [3, 8], free);
  assert.ok(k && pointInPolygon(k.x, k.z, plaza));
  const edge = Math.abs(k.z + 23) - 3;
  assert.ok(edge >= 2.5 && edge <= 4, `縁石から ${edge} m`);
  assert.ok(Math.abs(k.angle + Math.PI / 2) < 0.01, '北（-z）の車道の方を向く');
  assert.equal(kerbSpot(plaza, [hidden], [3, 8], free), null, '広場の下を通る道の縁には置かない');
  // findMonuments: 道路を渡せば縁に置き、渡さなければ広場の中の hint の近く
  const proj = new LocalProjection(43.5994, 1.4395);
  const spec = MONUMENTS.find((m) => m.id === 'coq');
  const [ox, oz] = proj.project(spec.lat, spec.lon);
  const shift = (r) => ({ ...r, pts: r.pts.map(([x, z]) => [x + ox, z + oz]) });
  const olivier = { name: 'Place Olivier', outer: rect(ox, oz, 30, 20), holes: [], bounds: {} };
  const onRoadW = (x, z) => onRoad(x - ox, z - oz);
  const coq = findMonuments(proj, { areas: [olivier], roads: [shift(visible), shift(hidden), { ...shift(visible), type: 'footway' }], onRoad: onRoadW }).find((m) => m.kind === 'coq');
  assert.ok(coq && Math.abs(coq.z - oz + 17) < 1.01 && Math.abs(coq.angle + Math.PI / 2) < 0.01);
});

test('小物を置かない所: シャトー・ドーの柵に抜けがあっても（当たり判定は線分）柵の円の内側全体', () => {
  const ch = { kind: 'chateau', x: 0, z: 0, rBase: 9, replaced: [] };
  const full = buildMonuments([ch], {});
  const gap = buildMonuments([ch], {}, { onRoad: (x, z) => x > 9 && Math.abs(z) < 3 });
  assert.ok(full.colliders.some((c) => c.length === 3));
  assert.ok(gap.colliders.every((c) => c.length === 4), '柵の抜けがあれば当たり判定は線分だけ');
  for (const m of [full, gap]) {
    const solid = monumentSolid(m.keepOut);
    assert.ok(solid(9.8, 0) && solid(0, -10) && !solid(13, 0));
  }
});

test('ファストフード店: 近くの外形を置き換え、看板塔・砂利の植え込みの位置を持つ。正面のガラスと屋根を作る', () => {
  const proj = new LocalProjection(43.5994, 1.4395);
  const spec = MONUMENTS.find((m) => m.id === 'mcdo-bayonne');
  const [x, z] = proj.project(spec.lat, spec.lon);
  const shop = bld(rect(x, z, 14, 9), { height: 3.9 });
  const far = bld(rect(x + 60, z, 14, 9));
  const [m] = findMonuments(proj, { buildings: [shop, far] }).filter((q) => q.kind === 'fastfood');
  assert.ok(m && m.replaced[0] === shop && m.height >= 4.8);
  assert.equal(m.gravel.length, spec.gravel.length);
  assert.ok(Math.hypot(m.pylon[0] - x, m.pylon[1] - z) < 40, '看板塔は店の近く');
  const built = buildMonuments([m], { monument: {}, monumentMetal: {}, monumentInlay: {} }, { groundAt: () => 0 });
  assert.ok(built.colliders.some((c) => c.length === 3 && Math.hypot(c[0] - m.pylon[0], c[1] - m.pylon[1]) < 1e-6), '看板塔の当たり判定');
});

test('閘門: 閘室の両側の柵は当たり判定の線、上の面は地面の切り抜き（ステンシル）', async () => {
  const { LOCKS, lockFrame } = await import('../../src/world/locks.js');
  const proj = new LocalProjection(43.6045, 1.4345);
  const spec = LOCKS.find((l) => l.id === 'ecluse-saint-pierre');
  const list = findMonuments(proj, { buildings: [], areas: [], roads: [], bounds: null }).filter((m) => m.kind === 'lock');
  assert.equal(list.length, 1);
  const f = lockFrame(list[0].a, list[0].b);
  const [u, v] = f.uv(...f.at(7, -2));
  assert.ok(Math.abs(u - 7) < 1e-9 && Math.abs(v + 2) < 1e-9);
  const { group, colliders } = buildMonuments(list, {}, { groundAt: () => 0, waterAt: () => -3 });
  assert.ok(group.children.some((c) => c.name === 'monument-mask') && group.children.some((c) => c.name === 'monument-mask-reset'));
  // 柵: 閘室の芯線から幅の半分 + 0.3 m の所に、閘室に沿った線分
  const side = colliders.filter((c) => c.length === 4 && Math.abs(Math.abs(f.uv(c[0], c[1])[1]) - (spec.width / 2 + 0.3)) < 1e-6);
  assert.ok(side.length >= 4);
});

test('入市税の門の小屋: 2 つ、正面は広場（東）を向き、壁は当たり判定の 4 辺', () => {
  const proj = new LocalProjection(43.5979, 1.4310);
  const list = findMonuments(proj, { buildings: [], areas: [], roads: [], bounds: null }).filter((m) => m.kind === 'pavilion');
  assert.equal(list.length, 2);
  for (const m of list) assert.ok(m.f[0] > 0.8); // 東向き
  const { colliders } = buildMonuments(list, {}, { groundAt: () => 0 });
  assert.equal(colliders.length, 8);
});

test('メトロ Jean-Jaurès のエレベーターの小屋: 1 つ、ガラスの壁と当たり判定の 4 辺', () => {
  const proj = new LocalProjection(43.6056, 1.4486);
  const list = findMonuments(proj, { buildings: [], areas: [], roads: [], bounds: null }).filter((m) => m.kind === 'lift');
  assert.equal(list.length, 1);
  const { colliders } = buildMonuments(list, {}, { groundAt: () => 0 });
  assert.equal(colliders.length, 4);
});

test('Purpan の病院の門: 塀はアーチの所であいていて、門柱と柵に当たり判定', () => {
  const proj = new LocalProjection(43.6081, 1.3977);
  const [px, pz] = proj.project(43.608147, 1.397792);
  const porch = { id: 1, tags: {}, info: { area: 21, height: 2.2 }, inside: [px, pz], outer: [[px - 2, pz - 3], [px + 2, pz - 3], [px + 2, pz + 3], [px - 2, pz + 3]], holes: [], bounds: { minX: px - 2, minZ: pz - 3, maxX: px + 2, maxZ: pz + 3 } };
  const list = findMonuments(proj, { buildings: [porch], areas: [], roads: [], bounds: null }).filter((m) => m.kind === 'hgate');
  assert.equal(list.length, 1);
  assert.deepEqual(list[0].replaced, [porch]); // アーチの小屋はモデルで描く
  const { colliders } = buildMonuments(list, {}, { groundAt: () => 0 });
  // 塀の当たり判定は 2 本（アーチの通り抜けの両側）、門柱 2 本 × 4 辺、柵 1 本
  assert.equal(colliders.length, 2 + 8 + 1);
  const [cx, cz] = list[0].arch;
  const wall = colliders.slice(0, 2);
  for (const [x0, z0, x1, z1] of wall) {
    const t = ((cx - x0) * (x1 - x0) + (cz - z0) * (z1 - z0)) / ((x1 - x0) ** 2 + (z1 - z0) ** 2);
    assert.ok(t < 0 || t > 1, 'アーチの中心は塀の当たり判定の外');
  }
});

test('Place de la Trinité の噴水: 1 つ、水盤の外の縁に当たり判定の円、まわりに小物を置かない', () => {
  const proj = new LocalProjection(43.5997, 1.4441);
  const list = findMonuments(proj, { buildings: [], areas: [], roads: [], bounds: null }).filter((m) => m.kind === 'trinite');
  assert.equal(list.length, 1);
  const { colliders, keepOut } = buildMonuments(list, {}, { groundAt: () => 0 });
  assert.equal(colliders.length, 1);
  assert.ok(Math.abs(colliders[0][2] - 2.95) < 1e-9, '水盤の外径 約 5.9 m');
  assert.ok(keepOut[0][2] > colliders[0][2]);
});

test('店の並ぶ通りの飾り: 通りに面した建物の正面の辺だけ（裏の辺・離れた建物・ほかの通りは除く）', () => {
  const proj = new LocalProjection(43.598, 1.432);
  // 東西の Rue de la République（z = 0、幅 8 m）。北側（z < 0）に正面が通りに接する建物、南に離れた建物、ほかの通り沿いの建物
  const road = { name: 'Rue de la République', type: 'secondary', width: 8, pts: [[-100, 0], [100, 0]] };
  const other = { name: 'Rue Réclusane', type: 'residential', width: 6, pts: [[-100, 200], [100, 200]] };
  const near = bld(rect(0, -10, 10, 6), { height: 14, floorHeight: 3, minHeight: 0 });
  const far = bld(rect(0, 40, 10, 6), { height: 14, floorHeight: 3, minHeight: 0 });
  const side = bld(rect(0, 190, 10, 6), { height: 14, floorHeight: 3, minHeight: 0 });
  const list = findMonuments(proj, { buildings: [near, far, side], areas: [], roads: [road, other], bounds: null }).filter((m) => m.kind === 'shopstreet');
  assert.equal(list.length, 1);
  const { fronts } = list[0];
  assert.equal(fronts.length, 1, '通りに面した北の建物の南の辺だけ');
  assert.equal(fronts[0].b, near);
  assert.ok(fronts[0].n[1] > 0.99, '外向きの法線は通り（南）を向く');
  assert.ok(Math.abs(fronts[0].L - 20) < 1e-9);
  const mat = new THREE.MeshBasicMaterial();
  const { group } = buildMonuments(list, { monument: mat, monumentMetal: mat }, { groundAt: () => 0 });
  const metal = group.children.find((m) => m.name === 'monument-metal');
  assert.ok(metal && metal.geometry.attributes.position.count > 100, '縦樋・手すりなどの金物のメッシュ');
});

test('自転車置き場: 線に沿って 1 m ごとの輪と自転車、当たり判定は線分 1 本', () => {
  const proj = new LocalProjection(43.598, 1.4317);
  const list = findMonuments(proj, { buildings: [], areas: [], roads: [], bounds: null }).filter((m) => m.kind === 'bikeracks');
  assert.equal(list.length, 2);
  const mat = new THREE.MeshBasicMaterial();
  const { group, colliders } = buildMonuments(list, { monument: mat, monumentMetal: mat }, { groundAt: () => 0 });
  assert.equal(colliders.length, 2);
  assert.ok(colliders.every((c) => c.length === 4 && Math.hypot(c[2] - c[0], c[3] - c[1]) > 8));
  const metal = group.children.find((m) => m.name === 'monument-metal');
  assert.ok(metal.geometry.attributes.position.count >= 2 * 10 * 3 * 24, '輪（3 本の棒）が 20 個以上');
  const pos = metal.geometry.attributes.position;
  let top = 0;
  for (let i = 0; i < pos.count; i++) top = Math.max(top, pos.getY(i));
  assert.ok(top > 0.75 && top < 1.1, `輪の高さ ${top}`);
});

test('写真から作った名所のモデル（市場のハレット・ダルバード・カルム市場・凱旋門・ニエル兵舎・レ・ザバトワール）が組み立てられる', async () => {
  const THREE = await import('three');
  const { MONUMENTS, buildMonuments, findMonuments } = await import('../../src/world/monuments.js');
  const { LocalProjection } = await import('../../src/geo.js');
  const proj = new LocalProjection(43.5975, 1.44);
  const rect = (lat, lon, w, d, extra = {}) => {
    const [x, z] = proj.project(lat, lon);
    const outer = [[x - w / 2, z - d / 2], [x + w / 2, z - d / 2], [x + w / 2, z + d / 2], [x - w / 2, z + d / 2]];
    return { id: Math.round(lat * 1e5 + lon * 1e5), outer, holes: [], inside: [x, z], bounds: { minX: x - w / 2, maxX: x + w / 2, minZ: z - d / 2, maxZ: z + d / 2 }, tags: {}, info: { area: w * d, height: 12, ...extra } };
  };
  const buildings = [
    rect(43.59755, 1.430203, 30, 12), rect(43.59787, 1.430189, 20, 11), // サン・シプリアンの市場
    rect(43.597632, 1.442584, 50, 32, { isChurch: true, height: 28 }), // ダルバード
    rect(43.597639, 1.44481, 50, 45, { height: 20 }), // カルム市場
    rect(43.57744, 1.444198, 70, 14, { height: 13 }), // ニエル兵舎
    rect(43.600879, 1.429539, 63, 31, { height: 11.8 }), // レ・ザバトワール
  ];
  const ids = new Set(['marche-saint-cyprien', 'dalbade', 'marche-carmes', 'caserne-niel', 'monument-combattants', 'abattoirs']);
  const saved = MONUMENTS.splice(0, MONUMENTS.length, ...MONUMENTS.filter((m) => ids.has(m.id)));
  try {
    const list = findMonuments(proj, { buildings });
    const kinds = new Set(list.map((m) => m.kind));
    for (const k of ['halls', 'gothic', 'market', 'barracks', 'memorial', 'hall']) assert.ok(kinds.has(k), `${k} がない（${[...kinds].join(', ')}）`);
    // レ・ザバトワールの正面は広場（東）の側: e1（正面から奥へ）は西向き
    const hall = list.find((m) => m.kind === 'hall');
    const [fx, fz] = proj.project(43.60115, 1.43020);
    assert.ok((fx - hall.cx) * hall.e1[0] + (fz - hall.cz) * hall.e1[1] < 0, '正面は広場の側');
    const halls = list.find((m) => m.kind === 'halls');
    assert.equal(halls.halls.length, 2);
    assert.ok(halls.replaced.every((b) => b && b.outer));
    const mat = new THREE.MeshBasicMaterial();
    const { group, colliders } = buildMonuments(list, { monument: mat, monumentMetal: mat, monumentInlay: mat }, { groundAt: () => 0 });
    let tris = 0, bad = 0;
    group.traverse((o) => {
      const p = o.geometry?.attributes?.position;
      if (!p) return;
      tris += p.count / 3;
      for (let i = 0; i < p.count; i++) if (!Number.isFinite(p.getX(i)) || !Number.isFinite(p.getY(i)) || !Number.isFinite(p.getZ(i))) bad++;
    });
    assert.ok(tris > 2000, `三角形 ${tris}`);
    assert.equal(bad, 0, 'NaN の頂点');
    assert.ok(colliders.length > 0);
  } finally {
    MONUMENTS.splice(0, MONUMENTS.length, ...saved);
  }
});

test('Place Wilson の庭: 地図の小道を砂の園路に、入口は小道が縁を横切る所。噴水（水盤の当たり判定）・回転木馬（円い建物を置き換え）・木を植えない所', async () => {
  const { SQUARES, gardenGates, gardenPaths, inSquareGarden, squaresLocal } = await import('../../src/world/squares.js');
  const proj = new LocalProjection(43.6048, 1.4474);
  const [sq] = squaresLocal(proj);
  assert.equal(sq.id, 'wilson');
  assert.ok(inSquareGarden(sq, sq.fx, sq.fz) && !inSquareGarden(sq, sq.cx + sq.r + 1, sq.cz));
  // 庭の中心から西の入口へ（環状の車道の芯線まで）の小道と、庭の外の歩道
  const inner = { type: 'footway', width: 2.5, pts: [[sq.fx, sq.fz], [sq.cx - sq.r - 2.5, sq.cz]] };
  const outside = { type: 'footway', width: 2.5, pts: [[sq.cx + sq.r + 8, sq.cz], [sq.cx + sq.r + 8, sq.cz + 30]] };
  const road = { type: 'tertiary', width: 5, pts: [[sq.cx - 40, sq.cz], [sq.cx + 40, sq.cz]] };
  gardenPaths([inner, outside, road], proj);
  assert.equal(inner.surface, 'fine_gravel');
  assert.equal(inner.width, SQUARES[0].pathWidth);
  assert.ok(!outside.surface && !road.surface);
  const gates = gardenGates(sq, [inner]);
  assert.equal(gates.length, 1);
  assert.ok(Math.abs(Math.abs(gates[0]) - Math.PI) < 0.05, '西の入口');
  // 噴水と回転木馬（地図の円い 6 m の建物を置き換える）
  const carousel = bld(circle(sq.kx, sq.kz, 5.3, 16), { height: 6 });
  const list = findMonuments(proj, { buildings: [carousel], roads: [inner, road] }).filter((m) => m.kind === 'square' || m.kind === 'carousel');
  assert.equal(list.length, 2);
  assert.deepEqual(list.find((m) => m.kind === 'carousel').replaced, [carousel]);
  const { group, colliders, keepOut } = buildMonuments(list, { monument: new THREE.MeshBasicMaterial(), monumentMetal: new THREE.MeshBasicMaterial(), monumentInlay: new THREE.MeshBasicMaterial() }, { groundAt: () => 0 });
  let bad = 0;
  group.traverse((o) => {
    const p = o.geometry?.attributes?.position;
    if (p) for (let i = 0; i < p.count; i++) if (!Number.isFinite(p.getX(i) + p.getY(i) + p.getZ(i))) bad++;
  });
  assert.equal(bad, 0, 'NaN の頂点');
  assert.ok(colliders.some((c) => c.length === 3 && Math.hypot(c[0] - sq.fx, c[1] - sq.fz) < 0.01 && Math.abs(c[2] - (sq.basin + 0.06)) < 1e-9), '水盤の外の縁');
  assert.ok(colliders.some((c) => c.length === 3 && Math.hypot(c[0] - sq.kx, c[1] - sq.kz) < 0.01), '回転木馬');
  assert.ok(keepOut.length >= 2);
  // 木を植えない所: 噴水と回転木馬のまわり（隣のタイルの名所の一覧が空でも）
  const clear = monumentClearance([], proj);
  assert.ok(clear(sq.fx + 3, sq.fz) && clear(sq.kx, sq.kz + 4) && !clear(sq.cx - 25, sq.cz));
});

test('Place Wilson の庭の縁: 楕円の環状の車道の内側の縁石に沿い、車止め（当たり判定）は車道の上に立たない', async () => {
  const { gardenOutline, inSquareGarden, squaresLocal } = await import('../../src/world/squares.js');
  const proj = new LocalProjection(43.6048, 1.4474);
  const [sq] = squaresLocal(proj);
  // 楕円の環状の車道（芯線の半径 東西 42 m・南北 36 m、幅 5 m）を 4 本の道に分けて
  const ell = (a) => [sq.cx + Math.cos(a) * 42, sq.cz + Math.sin(a) * 36];
  const name = 'Place du Président Thomas Woodrow Wilson';
  const roads = [0, 1, 2, 3].map((q) => ({ name, type: 'tertiary', width: 5, pts: Array.from({ length: 13 }, (_, i) => ell(((q + i / 12) * Math.PI) / 2)) }));
  const o = gardenOutline(sq, roads);
  assert.ok(Math.abs(o.rAt(0) - (42 - 2.5 - 0.4)) < 0.2, `東 ${o.rAt(0).toFixed(2)}`);
  assert.ok(Math.abs(o.rAt(Math.PI / 2) - (36 - 2.5 - 0.4)) < 0.2, `南 ${o.rAt(Math.PI / 2).toFixed(2)}`);
  assert.ok(inSquareGarden(sq, sq.cx + 38, sq.cz, 0, roads) && !inSquareGarden(sq, sq.cx, sq.cz + 34, 0, roads));
  const list = findMonuments(proj, { buildings: [], roads }).filter((m) => m.kind === 'square');
  const { colliders } = buildMonuments(list, {}, { groundAt: () => 0 });
  const seg = roads.flatMap((r) => r.pts.slice(1).map((p, i) => [...r.pts[i], ...p]));
  const d = (x, z) => Math.min(...seg.map(([ax, az, bx, bz]) => {
    const dx = bx - ax, dz = bz - az, t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz)));
    return Math.hypot(x - ax - dx * t, z - az - dz * t);
  }));
  const posts = colliders.filter((c) => c.length === 3 && Math.abs(c[2] - 0.12) < 1e-9);
  assert.ok(posts.length > 60, `車止め ${posts.length}`);
  for (const [x, z, r] of posts) assert.ok(d(x, z) > 2.5 + r - 0.01, `車止めが車道の上（芯線から ${d(x, z).toFixed(2)} m）`);
});

test('Place Saint-Étienne の噴水（Griffoul）: 1 つ、水盤の当たり判定と、まわりに木・小物を置かない', () => {
  const proj = new LocalProjection(43.5998, 1.4491);
  const list = findMonuments(proj, { buildings: [], areas: [], roads: [] }).filter((m) => m.kind === 'griffoul');
  assert.equal(list.length, 1);
  const { colliders, keepOut } = buildMonuments(list, {}, { groundAt: () => 0 });
  assert.equal(colliders.length, 1);
  assert.ok(keepOut[0][2] > colliders[0][2]);
  assert.ok(monumentClearance(list)(list[0].x + 3, list[0].z));
});
