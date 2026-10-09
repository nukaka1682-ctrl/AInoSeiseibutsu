// 屋根の細部（roofdetail.js: 軒の génoise の区間・煙突の置き場所、roofs.js の棟・軒の辺）の単体テスト
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRoof } from '../../src/world/roofs.js';
import { chimneyCount, eaveRuns, eaveShifts, miterShift, placeChimneys, roofHeightAt, writeGenoise, writeRidgeTiles } from '../../src/world/roofdetail.js';
import { roofPlan, traditionalHouse } from '../../src/world/buildings.js';
import { buildingInfo } from '../../src/world/parse.js';
import { pointInRing } from '../../src/geo.js';

const segs = (r) => {
  const out = [];
  for (let i = 0; i < r.length; i += 6) out.push(r.slice(i, i + 6));
  return out;
};
const near = (a, b, e = 1e-6) => Math.abs(a - b) < e;

test('屋根の棟: 寄棟の長方形は棟 1 本と隅棟 4 本、切妻は棟 1 本だけ、L 字の谷は含まない', () => {
  const rect = [[0, 0], [20, 0], [20, 10], [0, 10]];
  const hip = buildRoof(rect, [], { slope: 0.33, maxHeight: 4 });
  assert.equal(hip.eaves.length, 4);
  const hs = segs(hip.ridges);
  assert.equal(hs.length, 5);
  // 水平な棟は z = 5、x = 5〜15、高さ = 5 × 勾配
  const ridge = hs.find((s) => near(s[1], s[4]));
  assert.ok(ridge && near(ridge[2], 5) && near(ridge[5], 5) && near(Math.abs(ridge[0] - ridge[3]), 10));
  assert.ok(near(ridge[1], 5 * hip.slope, 1e-6));

  const gable = buildRoof(rect, [], { slope: 0.33, maxHeight: 4, weights: [[1, 0, 1, 0]] });
  assert.deepEqual(gable.eaves.map((e) => e.edge).sort(), [0, 2]);
  const gs = segs(gable.ridges);
  assert.equal(gs.length, 1);
  assert.ok(near(Math.abs(gs[0][0] - gs[0][3]), 20));

  // L 字: 凹んだ角 (8, 8) から上る谷は棟瓦を載せない
  const L = buildRoof([[0, 0], [20, 0], [20, 8], [8, 8], [8, 20], [0, 20]], [], { slope: 0.33, maxHeight: 4 });
  for (const s of segs(L.ridges)) {
    for (const [x, z] of [[s[0], s[2]], [s[3], s[5]]]) assert.ok(!(near(x, 8) && near(z, 8)), '谷が棟に入っている');
  }
  // 時計回りの外形でも、軒の辺の番号は元の向きのまま
  const cw = buildRoof([[0, 0], [0, 10], [20, 10], [20, 0]], [], { slope: 0.33, maxHeight: 4, weights: [[0, 1, 0, 1]] });
  assert.deepEqual(cw.eaves.map((e) => e.edge).sort(), [1, 3]);
});

test('génoise の区間: 角はどちらも軒なら留め継ぎ、隣の家との境は小口でふさぐ', () => {
  const ring = [[0, 0], [10, 0], [10, 6], [0, 6]]; // 符号付き面積が正（outwardSign = 1）
  const full = ring.map((a, i) => [[0, Math.hypot(ring[(i + 1) % 4][0] - a[0], ring[(i + 1) % 4][1] - a[1])]]);
  const runs = eaveRuns(ring, 1, full);
  assert.equal(runs.length, 4);
  for (const r of runs) {
    assert.ok(!r.capA && !r.capB);
    // 直角の留め継ぎ: 2 つの外向きの法線の和（長さ √2）。外向きなので外形の外に出る
    assert.ok(near(Math.hypot(r.ma[0], r.ma[1]), Math.SQRT2, 1e-9) && near(Math.hypot(r.mb[0], r.mb[1]), Math.SQRT2, 1e-9));
    assert.ok(near(r.ma[2], 1) && near(r.mb[2], 1));
    assert.ok(!pointInRing(r.a[0] + r.ma[0] * 0.3, r.a[1] + r.ma[1] * 0.3, ring));
  }
  // 辺 0 の外向きは z の負の向き
  assert.ok(near(runs[0].o[0], 0) && near(runs[0].o[1], -1));
  // 辺 1 が隣の家との境（軒でない）、辺 2 は途中まで隣の家に隠れる
  const part = [full[0], null, [[0, 4]], full[3]];
  const r2 = eaveRuns(ring, 1, part);
  assert.equal(r2.length, 3);
  assert.ok(r2[0].capB && !r2[0].capA); // 辺 0 の終点は境の壁
  assert.ok(r2[1].capA && !r2[1].capB); // 辺 2 は始点が境の角（小口）、終点が途中（隣の家の陰）
  assert.ok(near(r2[1].mb[0], r2[1].o[0]) && near(r2[1].mb[1], r2[1].o[1]));
  assert.ok(near(r2[1].s0, 0) && near(Math.hypot(r2[1].b[0] - r2[1].a[0], r2[1].b[1] - r2[1].a[1]), 4));
  // 短すぎる区間は省く
  assert.equal(eaveRuns(ring, 1, [[[0, 1]], null, null, null]).length, 0);
  // 小口: 留め継ぎでない端は縦の三角形でふさぐ（辺 0 の終点の 1 つ）
  const tris = [];
  writeGenoise({ quad: () => {}, tri: (...a) => tris.push(a) }, r2[0], 5, 3, [1, 1, 1]);
  assert.equal(tris.length, 1);
  const [p0, p1, p2, n] = tris[0];
  assert.ok(near(p0[0], 10) && near(p2[0], 10) && near(p1[0], 10) && near(n[0], 1)); // 端の面 x = 10、外向き +x
  assert.ok(near(p1[2], -0.24, 1e-9) && near(p1[1], 5 + 0.27, 1e-9));
});

test('鋭い角: 留め継ぎは縮めても両方の辺の屋根面にのり、棟瓦は動かした屋根の角で止まる', () => {
  // 25° の鋭い角（原点）をもつ三角形の家（符号付き面積が正）
  const t = Math.tan((25 * Math.PI) / 180);
  const ring = [[0, 0], [20, 0], [20, 20 * t]];
  const o1 = [0, -1], o2 = [-Math.sin((25 * Math.PI) / 180), Math.cos((25 * Math.PI) / 180)]; // 辺 0・辺 2 の外向きの法線
  const m = miterShift(o2, o1);
  assert.ok(near(Math.hypot(m[0], m[1]), 2, 1e-9) && m[2] < 0.5 && m[2] > 0.1);
  assert.ok(near(m[0] * o1[0] + m[1] * o1[1], m[2], 1e-9) && near(m[0] * o2[0] + m[1] * o2[1], m[2], 1e-9));
  assert.equal(miterShift([1, 0], [-1, 0]), null); // 折り返し
  const shifts = eaveShifts(ring, 1, [true, true, true]);
  assert.ok(shifts.every((s) => s && Math.hypot(s[0], s[1]) <= 2 + 1e-9));
  const roof = buildRoof(ring, [], { slope: 0.33, maxHeight: 8 });
  const ext = 0.3, top = 6;
  const corners = ring.map(([x, z], i) => [x + shifts[i][0] * ext, top - shifts[i][2] * ext * roof.slope, z + shifts[i][1] * ext]);
  const corner = (x, z) => {
    const i = ring.findIndex((p) => near(p[0], x, 1e-6) && near(p[1], z, 1e-6));
    return i < 0 ? null : corners[i];
  };
  const quads = [];
  writeRidgeTiles({ quad: (...a) => quads.push(a) }, roof.ridges, top, corner, [1, 1, 1], 1);
  assert.ok(quads.length >= 3);
  let ends = 0;
  for (const q of quads) {
    for (const [v, w] of [[q[0], q[3]], [q[1], q[2]]]) {
      const c = [(v[0] + w[0]) / 2, (v[1] + w[1]) / 2 - 0.05, (v[2] + w[2]) / 2];
      const k = corners.findIndex((p) => Math.hypot(p[0] - c[0], p[2] - c[2]) < 1e-6);
      if (k >= 0) {
        ends++;
        assert.ok(near(c[1], corners[k][1], 1e-6)); // 角の高さ
      } else assert.ok(pointInRing(c[0], c[2], ring), `棟瓦の端 ${c} が屋根の外`);
    }
  }
  assert.equal(ends, 3); // 3 本の隅棟がそれぞれ角で止まる
});

test('軒の出の頂点のずれ: 両側が軒なら留め継ぎ、片側だけなら軒の辺の法線、どちらも軒でなければ動かさない', () => {
  const ring = [[0, 0], [10, 0], [10, 6], [0, 6]];
  const all = eaveShifts(ring, 1, [true, true, true, true]);
  assert.ok(near(all[0][0], -1) && near(all[0][1], -1)); // 角 (0, 0): 外へ斜め
  assert.ok(near(all[2][0], 1) && near(all[2][1], 1));
  // 辺 0・2 が軒、辺 1・3 が切妻: 頂点は軒の辺の法線の向き（切妻の壁の面の中を動く）
  const gable = eaveShifts(ring, 1, [true, false, true, false]);
  assert.deepEqual(gable.map((m) => m.map((v) => Math.round(v))), [[0, -1, 1], [0, -1, 1], [0, 1, 1], [0, 1, 1]]);
  // 軒のない頂点（両側が隣の家との境）
  assert.equal(eaveShifts(ring, 1, [true, false, false, false])[3], null);
  // 屋根面を延ばした軒の頂点は、元の屋根面の平面にのる（勾配 s で、辺から d 外へ出ると高さ −d s）
  const roof = buildRoof(ring, [], { slope: 0.3, maxHeight: 4 });
  const ext = 0.27;
  const [mx, mz] = all[1]; // 角 (10, 0)
  const p = [10 + mx * ext, -ext * 0.3, 0 + mz * ext];
  // 辺 0（z = 0）の屋根面: y = 0.3 z、辺 1（x = 10）の屋根面: y = 0.3 (10 − x)
  assert.ok(near(p[1], 0.3 * p[2], 1e-9) && near(p[1], 0.3 * (10 - p[0]), 1e-9));
  assert.ok(roof.slope === 0.3);
});

test('屋根の高さの測定と煙突の置き場所: 屋根の上にのり、決まった結果になる', () => {
  const ring = [[0, 0], [8, 0], [8, 14], [0, 14]];
  const roof = buildRoof(ring, [], { slope: 0.33, maxHeight: 4, weights: [[0, 1, 0, 1]] }); // 両側が隣の家との境
  assert.ok(near(roofHeightAt([roof.roof, roof.top], 4, 7), 4 * roof.slope, 1e-9));
  assert.ok(near(roofHeightAt([roof.roof], 1, 7), 1 * roof.slope, 1e-9));
  assert.equal(roofHeightAt([roof.roof], -1, 7), null);
  assert.equal(chimneyCount(20, 1), 0);
  // 煙突の数の分布: ふつうの家はほとんど 1 本以上、120 m² は 2 本が多い、200 m² は 2〜3 本
  const dist = (area) => {
    const c = [0, 0, 0, 0];
    for (let id = 1; id <= 2000; id++) c[chimneyCount(area, id)]++;
    return c;
  };
  const d50 = dist(50), d120 = dist(120), d200 = dist(200);
  assert.ok(d50[0] < 200 && d50[1] > 1200, `50 m²: ${d50}`);
  assert.ok(d120[0] < 200 && d120[2] > 1200, `120 m²: ${d120}`);
  assert.ok(d200[0] < 200 && d200[1] === 0 && d200[3] > 100, `200 m²: ${d200}`);
  let total = 0;
  for (let id = 1; id <= 40; id++) {
    const cs = placeChimneys(roof, id, 112);
    assert.deepEqual(cs, placeChimneys(roof, id, 112)); // 同じ建物なら同じ結果
    assert.ok(cs.length <= 3);
    total += cs.length;
    for (const c of cs) {
      assert.ok(pointInRing(c.x, c.z, ring));
      const y = roofHeightAt([roof.roof, roof.top], c.x, c.z);
      assert.ok(c.y1 - y >= 0.8 - 1e-9 && c.y1 - y <= 1.5 + 0.2, `屋根から ${c.y1 - y} m`);
      assert.ok(c.y0 <= y && c.y0 >= -0.2);
      assert.ok(c.w >= 0.5 && c.w <= 0.7 && c.d >= 0.4 && c.d <= 0.5);
    }
    for (let i = 0; i < cs.length; i++) {
      for (let j = i + 1; j < cs.length; j++) {
        const sameWall = cs[i].group && cs[i].group === cs[j].group; // 同じ境の壁の上に並ぶ 2 本
        assert.ok(Math.hypot(cs[i].x - cs[j].x, cs[i].z - cs[j].z) >= (sameWall ? 1.2 : 3));
      }
    }
  }
  assert.ok(total > 50, `煙突が少なすぎる（${total} 本）`);
});

test('génoise・煙突をつける建物: 旧市街の家は付け、教会・商業施設・高い集合住宅・現代的な建物は付けない', () => {
  const mk = (tags, outer = [[0, 0], [8, 0], [8, 12], [0, 12]]) => {
    const b = { id: 7, tags, outer, holes: [], bdHeight: 0 };
    b.info = buildingInfo(b);
    return b;
  };
  const house = mk({ building: 'yes', height: '12', 'roof:height': '2', 'building:material': 'brick' });
  assert.ok(traditionalHouse(house, roofPlan(house)));
  const church = mk({ building: 'church', height: '15' });
  assert.ok(!traditionalHouse(church, roofPlan(church)));
  // 1 階が店の家（BD TOPO の commercial）は付ける、大きな商業施設・物置は付けない
  const shop = mk({ building: 'commercial', height: '9', 'roof:height': '2', 'roof:material': 'roof_tiles' });
  assert.ok(traditionalHouse(shop, roofPlan(shop)));
  const mall = mk({ building: 'commercial', height: '9', 'roof:height': '2', 'roof:material': 'roof_tiles' }, [[0, 0], [40, 0], [40, 30], [0, 30]]);
  assert.ok(!traditionalHouse(mall, roofPlan(mall)));
  const shed = mk({ building: 'shed', height: '3.5', 'roof:height': '1', 'roof:material': 'roof_tiles' });
  assert.ok(!traditionalHouse(shed, roofPlan(shed)));
  const tall = mk({ building: 'apartments', height: '40', 'roof:height': '2' });
  assert.ok(!traditionalHouse(tall, roofPlan(tall)));
  const modern = mk({ building: 'yes', height: '12', 'roof:height': '2', 'building:material': 'wood' });
  assert.ok(!traditionalHouse(modern, roofPlan(modern)));
  const slate = mk({ building: 'yes', height: '12', 'roof:height': '2', 'roof:material': 'slate' });
  assert.ok(!traditionalHouse(slate, roofPlan(slate)));
  const landmark = mk({ building: 'yes', height: '12', 'roof:height': '2' });
  landmark.style = 3;
  assert.ok(!traditionalHouse(landmark, roofPlan(landmark)));
});
