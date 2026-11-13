// 走るもの（ほかの自転車乗り・トラム）の計算（src/game/trafficlogic.js）と、RoadNetwork.segsAt
import test from 'node:test';
import assert from 'node:assert/strict';
import { chainRails, laneOffset, legIK, makePath, nearOnPath, nextSegment, pointAlong, slopeFactor, stopsAlong, tramSpeed } from '../../src/game/trafficlogic.js';
import { RoadNetwork } from '../../src/game/roadnet.js';
import { mulberry32 } from '../../src/geo.js';

const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;
const len = (p) => makePath(p).length;

test('chainRails: 端が近い 2 本はつながる・逆向きもつながる', () => {
  const a = { pts: [[0, 0], [100, 0]] };
  const b = { pts: [[101, 0.5], [200, 0]] }; // 端が 1.1 m 離れている
  const c = { pts: [[300, 0], [201, 1]] }; // 逆向き（終点が b の終点のそば）
  const out = chainRails([a, b, c]);
  assert.equal(out.length, 1);
  assert.ok(near(len(out[0].pts), 100 + Math.hypot(1, 0.5) + 99.0012626 + Math.hypot(1, 1) + 99.0050503, 0.01), String(len(out[0].pts)));
  const xs = out[0].pts.map((p) => p[0]);
  // 端から端へ順に並ぶ（どちら向きでも）
  const sorted = xs.slice().sort((p, q) => p - q);
  assert.ok(xs.join() === sorted.join() || xs.join() === sorted.reverse().join(), xs.join());
  assert.equal(out[0].segBridge.length, out[0].pts.length - 1);
});

test('chainRails: 離れた線はつながらない。分岐では曲がりの小さい方へ', () => {
  const far = chainRails([{ pts: [[0, 0], [100, 0]] }, { pts: [[110, 0], [200, 0]] }]);
  assert.equal(far.length, 2);
  // (100, 0) で 3 本が集まる: まっすぐの線と、60° 曲がる線
  const main = { pts: [[0, 0], [100, 0]] };
  const straight = { pts: [[100, 0], [150, 1]] };
  const branch = { pts: [[100, 0], [125, 43]] };
  const out = chainRails([main, straight, branch]);
  const long = out[0];
  assert.ok(long.pts.some((p) => p[0] === 150 && p[1] === 1), JSON.stringify(long.pts));
  assert.ok(!long.pts.some((p) => p[0] === 125), '曲がる線は別の線になる');
  // 橋の way の区間の印
  const br = chainRails([{ pts: [[0, 0], [10, 0]] }, { pts: [[10, 0], [20, 0]], bridge: true }])[0];
  assert.equal(br.bridge, true);
  assert.deepEqual(br.segBridge.filter(Boolean).length, 1);
});

test('pointAlong: 道のりから位置と向き。端で止まる', () => {
  const p = makePath([[0, 0], [10, 0], [10, 10]]);
  assert.equal(p.length, 20);
  const a = pointAlong(p, 5);
  assert.ok(near(a.x, 5) && near(a.z, 0) && near(a.dx, 1) && near(a.dz, 0), JSON.stringify(a));
  const b = pointAlong(p, 15);
  assert.ok(near(b.x, 10) && near(b.z, 5) && near(b.dx, 0) && near(b.dz, 1), JSON.stringify(b));
  const c = pointAlong(p, 99);
  assert.ok(near(c.x, 10) && near(c.z, 10));
  const d = pointAlong(p, -3);
  assert.ok(near(d.x, 0) && near(d.z, 0));
  // 線からの距離（範囲の中だけを見る）
  assert.ok(near(nearOnPath(p, 0, 20, 5, 2).d, 2));
  assert.ok(near(nearOnPath(p, 0, 8, 12, 5).d, Math.hypot(4, 5)));
  assert.ok(near(nearOnPath(p, 12, 20, 12, 5).s, 15));
});

// 十字路の小さな道のネットワーク（節点 1 が交差点）
function crossNet() {
  const roads = [
    { type: 'residential', width: 6, pts: [[0, 100], [0, 0]], nodeIds: [10, 1] }, // 南から交差点へ（北向き）
    { type: 'residential', width: 6, pts: [[0, 0], [2, -100]], nodeIds: [1, 20] }, // ほぼまっすぐ北へ
    { type: 'residential', width: 6, pts: [[0, 0], [100, 0]], nodeIds: [1, 30] }, // 東へ
    { type: 'residential', width: 6, pts: [[0, 0], [-100, 0]], nodeIds: [1, 40] }, // 西へ
    { type: 'residential', width: 6, pts: [[500, 500], [600, 500]], nodeIds: [50, 51] }, // 行き止まり
  ];
  return new RoadNetwork(roads);
}

test('nextSegment: まっすぐを好む（7 割）。ほかの道も選ぶ', () => {
  const net = crossNet();
  const seg = net.segs[0];
  assert.equal(net.segsAt(seg.ib).length, 4);
  const rnd = mulberry32(5);
  let straight = 0;
  const seen = new Set();
  for (let i = 0; i < 400; i++) {
    const n = nextSegment(net, seg, 1, rnd);
    seen.add(n.seg);
    assert.notEqual(n.seg, seg);
    assert.equal(n.dir, 1); // どの道も交差点（ia）から出る
    if (n.seg === net.segs[1]) straight++;
  }
  assert.ok(straight / 400 > 0.68 && straight / 400 < 0.86, String(straight)); // 0.7 + 0.3 × 0（ほかの 2 本だけ）
  assert.equal(seen.size, 3);
});

test('nextSegment: 行き止まりで U ターン。走れない道は選ばない', () => {
  const net = crossNet();
  const dead = net.segs[4];
  const u = nextSegment(net, dead, 1, mulberry32(1));
  assert.equal(u.seg, dead);
  assert.equal(u.dir, -1);
  assert.ok(near(u.turn, Math.PI));
  const seg = net.segs[0];
  const onlyEast = nextSegment(net, seg, 1, mulberry32(2), (s) => s === net.segs[2]);
  assert.equal(onlyEast.seg, net.segs[2]);
  assert.ok(near(onlyEast.turn, Math.PI / 2, 1e-9));
});

test('laneOffset: 車道の端から 0.9 m 内側。狭い道と自転車道は 0.5 m', () => {
  assert.ok(near(laneOffset({ type: 'residential', width: 8 }), 3.1));
  assert.ok(near(laneOffset({ type: 'primary', width: 3.6 }), 0.9));
  assert.ok(near(laneOffset({ type: 'residential', width: 3.4 }), 0.5));
  assert.ok(near(laneOffset({ type: 'cycleway', width: 4 }), 0.5));
});

test('slopeFactor: 上り 5 % で 0.7 倍、下りは 1.25 倍まで', () => {
  assert.ok(near(slopeFactor(0), 1));
  assert.ok(near(slopeFactor(0.05), 0.7));
  assert.ok(near(slopeFactor(-0.02), 1.1));
  assert.ok(near(slopeFactor(-0.2), 1.25));
});

test('legIK: 腿とすねの長さが保たれ、ひざが前に出る', () => {
  for (let c = 0; c < Math.PI * 2; c += 0.3) {
    for (const side of [1, -1]) {
      const { hip, knee, foot } = legIK(c, side);
      // 脚は横から見た面（y-z）で曲げる（足は股関節より 4 cm 外のペダルにあるので、長さは y-z で測る）
      const d = (a, b) => Math.hypot(a[1] - b[1], a[2] - b[2]);
      assert.ok(near(d(hip, knee), 0.46, 1e-9), `腿 ${d(hip, knee)}`);
      if (d(hip, foot) < 0.919) assert.ok(near(d(knee, foot), 0.46, 1e-6), `すね ${d(knee, foot)}`);
      // ひざは股関節と足を結ぶ線より前（-z）
      const t = (knee[1] - hip[1]) / (foot[1] - hip[1]);
      assert.ok(knee[2] <= hip[2] + (foot[2] - hip[2]) * t + 1e-9, `c=${c}`);
    }
  }
  // 左右の脚は半周ずれる
  const r = legIK(0, 1), l = legIK(0, -1);
  assert.ok(r.foot[1] < l.foot[1]);
});

test('tramSpeed: 停留所の手前でなめらかに止まれる（加速 0.9 m/s²・最高速）', () => {
  let v = 0, s = 0;
  const stop = 300, dt = 1 / 60;
  let vmaxSeen = 0, t = 0;
  while (t < 120) {
    const nv = tramSpeed(v, stop - s, 11, dt);
    assert.ok(nv - v <= 0.9 * dt + 1e-9, '加速は 0.9 m/s² まで');
    v = nv;
    s += Math.min(v * dt, stop - s);
    vmaxSeen = Math.max(vmaxSeen, v);
    t += dt;
    if (stop - s < 0.1 && v < 0.6) break;
  }
  assert.ok(near(vmaxSeen, 11, 1e-9), String(vmaxSeen));
  assert.ok(stop - s >= 0 && stop - s < 0.1, `残り ${stop - s}`);
  assert.ok(t < 60, `${t} 秒`);
  // 速すぎるときの減速は 3 m/s² まで
  assert.ok(near(tramSpeed(11, 5, 11, 0.1), 10.7));
});

test('stopsAlong: 450 m ごと（線の終わりのそばは除く）', () => {
  assert.deepEqual(stopsAlong(1000), [450, 900]);
  assert.deepEqual(stopsAlong(940), [450]);
  assert.deepEqual(stopsAlong(300), []);
});
