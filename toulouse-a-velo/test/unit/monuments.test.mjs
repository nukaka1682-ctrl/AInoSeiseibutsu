import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalProjection, pointInPolygon } from '../../src/geo.js';
import {
  MONUMENTS, ZODIAC, cabanisLayout, circleOf, fenceColliders, findMonuments, monumentClearance, occitanCross, orientedBox, placeOnPlaza, rayRing, stadiumAnnexes, stadiumRays, strokeQuads,
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
