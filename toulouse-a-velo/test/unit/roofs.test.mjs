// 屋根（roofs.js のストレートスケルトン）の単体テスト
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRoof, cleanRing, clipGable, ringArea, ringsSimple } from '../../src/world/roofs.js';
import { buildBuildings, edgeWeights, makePartyIndex, roofPlan } from '../../src/world/buildings.js';
import { buildingInfo } from '../../src/world/parse.js';
import { mulberry32, pointInRing } from '../../src/geo.js';

// 三角形 [x, y, z] × 3 の並び → 三角形の配列
const tris = (arr) => {
  const out = [];
  for (let i = 0; i < arr.length; i += 9) out.push([[arr[i], arr[i + 1], arr[i + 2]], [arr[i + 3], arr[i + 4], arr[i + 5]], [arr[i + 6], arr[i + 7], arr[i + 8]]]);
  return out;
};
const triArea = ([a, b, c]) => Math.abs((b[0] - a[0]) * (c[2] - a[2]) - (c[0] - a[0]) * (b[2] - a[2])) / 2;
// 重み（w）が 0 でない辺までの距離
const distToRing = (x, z, ring, w = null) => {
  let best = Infinity;
  for (let i = 0; i < ring.length; i++) {
    if (w && !(w[i] > 0)) continue;
    const a = ring[i], b = ring[(i + 1) % ring.length];
    const dx = b[0] - a[0], dz = b[1] - a[1];
    const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / (dx * dx + dz * dz)));
    best = Math.min(best, Math.hypot(a[0] + dx * t - x, a[1] + dz * t - z));
  }
  return best;
};

// 点から辺 a→b を通る直線までの距離
const distToLine = (p, a, b) => Math.abs((b[0] - a[0]) * (p[2] - a[1]) - (b[1] - a[1]) * (p[0] - a[0])) / Math.hypot(b[0] - a[0], b[1] - a[1]);

// 屋根が外形をすき間なく・はみ出さずに覆い、とげがないことを確かめる
//   - 三角形の面積の合計 = 外形の面積、三角形はすべて外形の内側
//   - 傾いた三角形は、どれかの軒（重み 0 でない辺）の屋根面の上にある（高さ = 勾配 × その辺の直線までの距離）
//   - 重みがすべて 1 なら、高さは「勾配 × 外形までの距離」を超えない
function checkRoof(r, outer, holes = [], { cap = Infinity, weights = null, tol = 1e-6 } = {}) {
  assert.ok(r, '屋根を作れなかった');
  const all = tris(r.roof).concat(tris(r.top));
  const area = all.reduce((s, t) => s + triArea(t), 0);
  const fp = Math.abs(ringArea(outer)) - holes.reduce((s, h) => s + Math.abs(ringArea(h)), 0);
  assert.ok(Math.abs(area - fp) < tol * fp + tol, `面積 ${area} ≠ ${fp}`);
  const eaves = [];
  [outer, ...holes].forEach((ring, ri) => ring.forEach((a, i) => {
    if (!weights || weights[ri][i] > 0) eaves.push([a, ring[(i + 1) % ring.length]]);
  }));
  const unweighted = !weights || weights.every((w) => w.every((x) => x === 1));
  for (const t of all) {
    // 三角形の重心は外形の内側・穴の外側
    const cx = (t[0][0] + t[1][0] + t[2][0]) / 3, cz = (t[0][2] + t[1][2] + t[2][2]) / 3;
    assert.ok(pointInRing(cx, cz, outer) && !holes.some((h) => pointInRing(cx, cz, h)), `外にはみ出した三角形 ${JSON.stringify(t)}`);
    for (const p of t) {
      assert.ok(p[1] >= -1e-9 && p[1] <= Math.min(cap, r.height) + 1e-9, `高さ ${p[1]}`);
      if (unweighted) {
        const d = Math.min(distToRing(p[0], p[2], outer), ...holes.map((h) => distToRing(p[0], p[2], h)));
        assert.ok(p[1] <= r.slope * d + 1e-6, `とげ: 高さ ${p[1]}、外形まで ${d} m`);
      }
    }
  }
  for (const t of tris(r.roof)) {
    const onPlane = eaves.some(([a, b]) => t.every((p) => Math.abs(p[1] - r.slope * distToLine(p, a, b)) < 1e-6));
    assert.ok(onPlane, `どの軒の屋根面にものっていない三角形 ${JSON.stringify(t)}`);
  }
  return all;
}

test('屋根: 正方形は四角錐、長方形は寄棟（棟が長辺と平行）', () => {
  const sq = [[0, 0], [10, 0], [10, 10], [0, 10]];
  const r1 = buildRoof(sq, [], { slope: 0.3 });
  checkRoof(r1, sq);
  assert.equal(r1.roof.length / 9, 4);
  assert.ok(Math.abs(r1.height - 1.5) < 1e-9);

  const rect = [[0, 0], [20, 0], [20, 8], [0, 8]];
  const r2 = buildRoof(rect, [], { slope: 0.3 });
  checkRoof(r2, rect);
  assert.ok(Math.abs(r2.height - 1.2) < 1e-9);
  // 棟（いちばん高い点）は x = 4〜16、z = 4
  const top = tris(r2.roof).flat().filter((p) => p[1] > 1.2 - 1e-9);
  assert.deepEqual([...new Set(top.map((p) => p[0].toFixed(3)))].sort(), ['16.000', '4.000']);
  assert.ok(top.every((p) => Math.abs(p[2] - 4) < 1e-9));
  // 向き（時計回り）が逆でも同じ屋根
  const r3 = buildRoof(rect.slice().reverse(), [], { slope: 0.3 });
  checkRoof(r3, rect);
  assert.equal(r3.roof.length, r2.roof.length);
});

test('屋根: 重み 0 の辺は切妻の壁になり、棟がその辺まで通る', () => {
  // 間口 5 m・奥行き 12 m の町家。両側（x = 0, x = 5）が隣の家と接する
  const house = [[0, 0], [5, 0], [5, 12], [0, 12]];
  const r = buildRoof(house, [], { weights: [[1, 0, 1, 0]], height: 2, minSlope: 0.25, maxSlope: 0.45 });
  checkRoof(r, house, [], { weights: [[1, 0, 1, 0]] });
  assert.ok(Math.abs(r.slope - 2 / 6) < 1e-9 && Math.abs(r.height - 2) < 1e-9);
  // 棟は z = 6 で x = 0〜5（通りと平行）
  const ridge = tris(r.roof).flat().filter((p) => p[1] > 2 - 1e-9);
  assert.ok(ridge.every((p) => Math.abs(p[2] - 6) < 1e-9));
  assert.deepEqual([...new Set(ridge.map((p) => p[0]))].sort(), [0, 5]);
  // 切妻の壁は 2 枚の三角形（底辺 12 m・高さ 2 m）、元の辺の番号と向きで返る
  assert.equal(r.gables.length, 2);
  for (const g of r.gables) {
    assert.ok(g.edge === 1 || g.edge === 3);
    assert.ok(Math.abs(Math.abs(ringArea(g.pts)) - 12) < 1e-9);
    assert.equal(Math.max(...g.pts.map((p) => p[1])), 2);
  }
  // 3 方が接する: 片流れ（奥まで上り、上限で平ら）
  const lean = buildRoof(house, [], { weights: [[1, 0, 0, 0]], height: 2 });
  checkRoof(lean, house, [], { cap: 2, weights: [[1, 0, 0, 0]] });
  assert.equal(lean.gables.length, 3);
});

test('屋根: L 字・T 字・凹んだ星形', () => {
  const L = [[0, 0], [20, 0], [20, 8], [6, 8], [6, 20], [0, 20]];
  const r1 = buildRoof(L, [], { slope: 0.3 });
  checkRoof(r1, L);
  assert.ok(Math.abs(r1.height - 0.3 * 4) < 1e-9); // 太い方の棟（幅 8 m）
  // L 字の内角（凹んだ角）から谷が伸びる: 内角の頂点 (6, 8) の高さは 0
  assert.ok(tris(r1.roof).flat().some((p) => p[0] === 6 && p[2] === 8 && p[1] === 0));

  const T = [[0, 0], [24, 0], [24, 8], [15, 8], [15, 20], [9, 20], [9, 8], [0, 8]];
  checkRoof(buildRoof(T, [], { slope: 0.3 }), T);
  const U = [[0, 0], [20, 0], [20, 15], [14, 15], [14, 6], [6, 6], [6, 15], [0, 15]];
  checkRoof(buildRoof(U, [], { slope: 0.3 }), U);
  const star = [[0, 0], [10, 3], [20, 0], [17, 10], [20, 20], [10, 17], [0, 20], [3, 10]];
  checkRoof(buildRoof(star, [], { slope: 0.3 }), star);
});

test('屋根: 中庭（穴）のある建物と、上限で平らになる屋根（terrasson）', () => {
  const outer = [[0, 0], [30, 0], [30, 30], [0, 30]];
  const hole = [[10, 10], [10, 20], [20, 20], [20, 10]];
  const r = buildRoof(outer, [hole], { slope: 0.3 });
  checkRoof(r, outer, [hole]);
  assert.ok(Math.abs(r.height - 0.3 * 5) < 1e-9); // 幅 10 m の翼の棟

  // 40 m × 30 m・屋根の高さ 3 m: 勾配は下限 0.25 → 奥行き 12 m で 3 m に達し、その先は平ら
  const big = [[0, 0], [40, 0], [40, 30], [0, 30]];
  const r2 = buildRoof(big, [], { height: 3, minSlope: 0.25, maxSlope: 0.45 });
  checkRoof(r2, big, [], { cap: 3 });
  assert.equal(r2.slope, 0.25);
  assert.ok(r2.top.length > 0 && tris(r2.top).flat().every((p) => p[1] === 3));
  const topArea = tris(r2.top).reduce((s, t) => s + triArea(t), 0);
  assert.ok(Math.abs(topArea - 16 * 6) < 1e-6, `上面 ${topArea}`);

  // 中庭のまわりも上限で平らになる（上面に穴が残る）
  const o2 = [[0, 0], [60, 0], [60, 60], [0, 60]], h2 = [[25, 25], [25, 35], [35, 35], [35, 25]];
  const r3 = buildRoof(o2, [h2], { height: 2 });
  checkRoof(r3, o2, [h2], { cap: 2 });
  assert.ok(r3.top.length > 0);
});

test('屋根: 乱れた外形（とげ・重なった頂点・一直線の頂点・自己交差）', () => {
  // とげ（幅 10 cm・長さ 10 m）と、重なった頂点を除く
  const spiky = [[0, 0], [10, 0], [10, 0.001], [10, 5], [10.05, 15], [10.1, 5], [10, 6], [0, 6], [0, 3], [0, 3.000001]];
  const clean = cleanRing(spiky);
  assert.ok(clean.every((p) => p[1] <= 6));
  assert.ok(!clean.some((p, i) => clean.some((q, j) => i !== j && Math.hypot(p[0] - q[0], p[1] - q[1]) < 0.05)));
  assert.ok(!clean.some((p) => p[0] === 0 && p[1] === 3)); // 一直線の頂点
  checkRoof(buildRoof(clean, []), clean);
  // 切妻（重み 0）の壁の延長と、平行な軒（重み 1）がぶつかる実際の外形: 重み付きでは決まらないので寄棟で作り直す
  const odd = [[0, 0], [-13.14, -3.44], [-14.535, 1.692], [-10.722, 2.727], [-12.116, 7.859], [-3.491, 9.996]];
  const ro = buildRoof(odd, [], { weights: [[0, 1, 1, 0, 0, 1]], height: 2.6 });
  checkRoof(ro, odd, [], { cap: 2.6, weights: ro?.unweighted ? null : [[0, 1, 1, 0, 0, 1]] });
  // 面積のない輪・一直線の輪
  assert.equal(cleanRing([[0, 0], [10, 0], [20, 0]]), null);
  assert.equal(cleanRing([[0, 0], [1, 0]]), null);
  assert.equal(buildRoof([[0, 0], [10, 0], [20, 0]], []), null);
  // 自己交差（8 の字）・穴が外周に接する・穴が外周からはみ出す
  assert.equal(ringsSimple([[[0, 0], [10, 10], [10, 0], [0, 10]]]), false);
  const sq = [[0, 0], [10, 0], [10, 10], [0, 10]];
  assert.equal(ringsSimple([sq, [[0, 5], [5, 7], [5, 3]]]), false);
  assert.equal(ringsSimple([sq, [[8, 4], [12, 5], [8, 6]]]), false);
  assert.equal(ringsSimple([sq, [[2, 2], [2, 4], [4, 4]]]), true);
});

test('屋根: 乱数で作った多数の建物の外形でも、覆い方が正しいか失敗（null）になる', () => {
  // 直交する辺の外形（町家の連なり・L 字・凹凸）に少しゆがみを加える
  const rnd = mulberry32(7);
  let ok = 0;
  const N = 300;
  for (let n = 0; n < N; n++) {
    const pts = [];
    const steps = 3 + Math.floor(rnd() * 5);
    // 下辺を左から右へ、上辺を右から左へ、段差をつけてたどる
    let x = 0;
    const tops = [];
    for (let i = 0; i < steps; i++) {
      const w = 2 + rnd() * 10, h = 5 + rnd() * 15;
      tops.push([x, x + w, h]);
      x += w;
    }
    pts.push([0, 0], [x, 0]);
    for (let i = tops.length - 1; i >= 0; i--) {
      const [x0, x1, h] = tops[i];
      pts.push([x1, h], [x0, h]);
    }
    const jit = pts.map(([px, pz]) => [px + (rnd() - 0.5) * 0.3, pz + (rnd() - 0.5) * 0.3]);
    const ring = cleanRing(jit);
    if (!ring || !ringsSimple([ring])) continue;
    // 切妻（重み 0）は、両隣の辺と角をなす辺だけ（一直線に続く辺どうしは buildRoof が重みをそろえるため）
    const turn = (i) => {
      const a = ring[(i - 1 + ring.length) % ring.length], b = ring[i], c = ring[(i + 1) % ring.length];
      const u = [b[0] - a[0], b[1] - a[1]], v = [c[0] - b[0], c[1] - b[1]];
      return Math.abs(u[0] * v[1] - u[1] * v[0]) / (Math.hypot(...u) * Math.hypot(...v));
    };
    const weights = [ring.map((_, i) => (rnd() < 0.25 && turn(i) > 0.2 && turn((i + 1) % ring.length) > 0.2 ? 0 : 1))];
    const r = buildRoof(ring, [], { weights, height: 1 + rnd() * 3 });
    if (!r) continue;
    ok++;
    checkRoof(r, ring, [], { weights: weights[0].some((x) => x > 0) && !r.unweighted ? weights : null, tol: 0.006 });
  }
  assert.ok(ok >= N * 0.95, `成功 ${ok}/${N}`);
});

test('屋根: 切妻の壁を隣の建物の高さで切る', () => {
  const g = [[0, 0], [12, 0], [6, 2]];
  const all = clipGable(g, 0, 12, 0);
  assert.ok(Math.abs(Math.abs(ringArea(all)) - 12) < 1e-9);
  const upper = clipGable(g, 0, 12, 1); // 高さ 1 m より上: 上半分の三角形
  assert.ok(Math.abs(Math.abs(ringArea(upper)) - 3) < 1e-9);
  const part = clipGable(g, 0, 6, 0); // 左半分
  assert.ok(Math.abs(Math.abs(ringArea(part)) - 6) < 1e-9);
  assert.equal(clipGable(g, 0, 12, 2.5), null); // 隣の方が高い: 見えない
});

test('屋根: 材料と形の選び方・隣と接する辺の重み', () => {
  const mk = (tags, outer = [[0, 0], [10, 0], [10, 8], [0, 8]]) => {
    const b = { id: 1, tags, outer, holes: [], bdHeight: 0 };
    b.info = buildingInfo(b);
    return b;
  };
  // IGN: 屋根の高さあり・瓦 → 傾斜屋根（瓦）、高さ 2 m
  assert.deepEqual(roofPlan(mk({ building: 'yes', height: '14', 'roof:height': '2', 'roof:material': 'roof_tiles' })), { shape: 'pitched', material: 'tile', height: 2 });
  // 商業施設（1 階が店の町家）でも、屋根の高さがあれば瓦屋根
  assert.equal(roofPlan(mk({ building: 'commercial', height: '14', 'roof:height': '2' })).shape, 'pitched');
  // コンクリートの屋根・平らな屋根は灰色の陸屋根
  assert.equal(roofPlan(mk({ building: 'yes', height: '12', 'roof:shape': 'flat', 'roof:material': 'concrete' })).material, 'flat');
  assert.equal(roofPlan(mk({ building: 'yes', height: '12', 'roof:shape': 'flat' })).shape, 'flat');
  // 瓦なのに平ら（高低差 0.5 m 以下）→ 低い瓦屋根
  assert.deepEqual(roofPlan(mk({ building: 'yes', height: '12', 'roof:shape': 'flat', 'roof:material': 'roof_tiles' })), { shape: 'pitched', material: 'tile', height: 0.5 });
  // スレート・亜鉛（IGN の屋根の色）
  assert.equal(roofPlan(mk({ building: 'yes', height: '20', 'roof:height': '4', 'roof:colour': '#5f646b' })).material, 'slate');
  // 屋根の情報がない大きな工場は陸屋根、教会は傾斜屋根
  const big = [[0, 0], [100, 0], [100, 50], [0, 50]];
  assert.equal(roofPlan(mk({ building: 'industrial', height: '9' }, big)).shape, 'flat');
  assert.equal(roofPlan(mk({ building: 'church', height: '20' }, big)).shape, 'pitched');

  // 町家の並び: 両隣と接する辺（高さが同じくらい）は重み 0、ずっと低い隣（物置）とは 1
  const b1 = { id: 1, outer: [[0, 0], [5, 0], [5, 12], [0, 12]], holes: [], info: { height: 12, minHeight: 0, kind: 'yes' } };
  const b2 = { id: 2, outer: [[5, 0], [10, 0], [10, 12], [5, 12]], holes: [], info: { height: 13, minHeight: 0, kind: 'yes' } };
  const b3 = { id: 3, outer: [[-4, 0], [0, 0], [0, 12], [-4, 12]], holes: [], info: { height: 3, minHeight: 0, kind: 'yes' } };
  const party = makePartyIndex([b1, b2, b3]);
  const ring = b1.outer;
  const covers = [ring.map((a, i) => party(b1, a, ring[(i + 1) % 4]))];
  assert.deepEqual(edgeWeights(b1, [ring], covers), [[1, 0, 1, 1]]);
});

test('屋根: 退化した入力（空の輪・閉じた輪・細い帯・重みがすべて 0・面積のない穴）', () => {
  assert.equal(cleanRing([]), null);
  assert.equal(cleanRing([[5, 5], [5, 5], [5, 5]]), null);
  // 最後の頂点が最初と同じ（閉じた輪）: 重複を除いて普通に屋根がかかる
  const closed = cleanRing([[0, 0], [12, 0], [12, 8], [0, 8], [0, 0]]);
  assert.equal(closed.length, 4);
  checkRoof(buildRoof(closed, []), closed);
  // 幅 10 cm・長さ 20 m の細い帯: 作れるなら正しく覆い、高さはほぼ 0
  const strip = [[0, 0], [20, 0], [20, 0.1], [0, 0.1]];
  const rs = buildRoof(strip, [], { height: 3 });
  if (rs) {
    checkRoof(rs, strip, [], { cap: 3 });
    assert.ok(rs.height < 0.05);
  }
  // 四方の辺がすべて高い隣と接する（重みがすべて 0）: 寄棟にする
  const sq = [[0, 0], [10, 0], [10, 10], [0, 10]];
  checkRoof(buildRoof(sq, [], { weights: [[0, 0, 0, 0]], height: 2 }), sq, [], { cap: 2 });
  // 面積のない穴は作らない（cleanRing で null → 呼び出し側で除く）、穴に重複した頂点があっても覆い方は正しい
  assert.equal(cleanRing([[2, 2], [4, 4], [6, 6]]), null);
  const outer = [[0, 0], [30, 0], [30, 20], [0, 20]];
  const hole = cleanRing([[10, 5], [10, 15], [10, 15], [20, 15], [20, 5]]);
  checkRoof(buildRoof(outer, [hole], { height: 3 }), outer, [hole], { cap: 3 });
  // 返り値の reach: 軒から棟までの水平距離（10 m × 30 m の寄棟なら 5 m）
  const r = buildRoof([[0, 0], [30, 0], [30, 10], [0, 10]], []);
  assert.ok(Math.abs(r.reach - 5) < 1e-9);
});

test('屋根: 大きな建物で IGN の屋根の高さがごく低いもの（工場・商業施設）は灰色の陸屋根、町家は瓦の傾斜屋根', async () => {
  const mk = (id, tags, outer) => {
    const b = { id, tags, outer, holes: [], bdHeight: 0 };
    b.info = buildingInfo(b);
    b.inside = [outer[0][0] + 1, outer[0][1] + 1];
    return b;
  };
  const mats = new Proxy({}, { get: () => null });
  const build = async (b) => (await buildBuildings({ buildings: [b], parts: [] }, mats)).stats.roofs;
  // 100 m × 60 m の商業施設、屋根の高さ 1.2 m（勾配にすると 4%）
  assert.deepEqual(await build(mk(1, { building: 'commercial', height: '9', 'roof:height': '1.2' }, [[0, 0], [100, 0], [100, 60], [0, 60]])), { pitched: 0, flat: 1, fallback: 0 });
  // 同じ大きさでも屋根の高さが勾配に見合う（6 m = 20%）なら瓦の傾斜屋根
  assert.deepEqual(await build(mk(2, { building: 'commercial', height: '14', 'roof:height': '6' }, [[0, 0], [100, 0], [100, 60], [0, 60]])), { pitched: 1, flat: 0, fallback: 0 });
  // 小さな町家は屋根が低くても瓦の傾斜屋根
  assert.deepEqual(await build(mk(3, { building: 'yes', height: '12', 'roof:height': '0.6' }, [[0, 0], [8, 0], [8, 15], [0, 15]])), { pitched: 1, flat: 0, fallback: 0 });
});
