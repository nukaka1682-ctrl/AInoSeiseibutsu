import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalProjection } from '../../src/geo.js';
import { LAYOUT, LINES, buildNetwork, carOffsets, doorOffsets, pathAt, runTime, stationFrame, stationList, terminusOf, trackAt } from '../../src/metro/network.js';

const proj = new LocalProjection(43.5994, 1.4395);

test('メトロの路線網: A 線 18 駅・B 線 20 駅、Jean Jaurès で乗り換え', () => {
  assert.equal(LINES.A.length, 18);
  assert.equal(LINES.B.length, 20);
  const st = stationList();
  assert.equal(st.length, 37);
  const jj = st.find((s) => s.id === 'jean-jaures');
  assert.deepEqual(jj.lines, ['A', 'B']);
  // 同梱の駅（BD TOPO の名前）があれば位置を置き換える（同じ名前が 2 つなら平均）
  const moved = stationList([{ name: 'Capitole', lat: 43.6, lon: 1.44 }, { name: "Patte-d'Oie", lat: 43.5, lon: 1.4 }, { name: "Patte-d'Oie", lat: 43.6, lon: 1.5 }]);
  assert.equal(moved.find((s) => s.id === 'capitole').lat, 43.6);
  assert.ok(Math.abs(moved.find((s) => s.id === 'patte-d-oie').lon - 1.45) < 1e-9);
});

test('メトロの線形: 駅のホームは直線で、駅の中心の S は駅の位置に一致し、駅は順に並ぶ', () => {
  const net = buildNetwork(proj);
  for (const [line, path] of Object.entries(net.lines)) {
    let prev = -1;
    for (const s of path.stations) {
      const p = pathAt(path, s.S[line]);
      assert.ok(Math.hypot(p.x - s.x, p.z - s.z) < 0.05, `${s.name} の中心`);
      assert.ok(s.S[line] > prev, '駅は順に並ぶ');
      prev = s.S[line];
      // ホームの両端でも向きは駅の軸と同じ（直線）
      for (const u of [-20, 0, 20]) {
        const q = pathAt(path, s.S[line] + u);
        const [ax, az] = s.axis[line];
        assert.ok(q.hx * ax + q.hz * az > 0.999, `${s.name} のホームの向き`);
      }
    }
    // 曲線は急すぎない（2 m ごとの向きの変わり 6° 以下）
    for (let i = 1; i < path.pts.length; i++) {
      const a = path.pts[i - 1], b = path.pts[i];
      assert.ok(a.hx * b.hx + a.hz * b.hz > Math.cos((6 * Math.PI) / 180), `${line} の曲線 S=${b.S.toFixed(0)}`);
    }
  }
  // 路線の長さ（駅から駅まで。A 線 約 12.5 km、B 線 約 15.7 km は車庫への線を含む）
  assert.ok(net.lines.A.length > 11000 && net.lines.A.length < 14500, `A 線 ${net.lines.A.length}`);
  assert.ok(net.lines.B.length > 13000 && net.lines.B.length < 17500, `B 線 ${net.lines.B.length}`);
});

test('メトロの線形: 右側通行。終点へ向かう電車は軸の右の線路、Jean Jaurès の B 線のホームは A 線と直交', () => {
  const net = buildNetwork(proj);
  const cap = net.byId.get('capitole'), f = stationFrame(cap, 'A');
  const p = trackAt(net.lines.A, cap.S.A, 1), q = trackAt(net.lines.A, cap.S.A, -1);
  assert.ok(Math.abs(f.local(p.x, p.z)[1] - LAYOUT.trackOff) < 0.01);
  assert.ok(Math.abs(f.local(q.x, q.z)[1] + LAYOUT.trackOff) < 0.01);
  assert.ok(q.fx * p.fx + q.fz * p.fz < -0.99, '逆向き');
  const jj = net.byId.get('jean-jaures');
  const [ax, az] = jj.axis.A, [bx, bz] = jj.axis.B;
  assert.ok(Math.abs(ax * bx + az * bz) < 1e-9);
  assert.equal(terminusOf(net, 'A', 1).id, 'balma-gramont');
  assert.equal(terminusOf(net, 'B', -1).id, 'borderouge');
});

test('メトロの電車: 両の中心と扉の位置、駅間の所要時間', () => {
  assert.deepEqual(carOffsets(2).map((v) => +v.toFixed(3)), [-6.575, 6.575]);
  assert.equal(doorOffsets(4).length, 12);
  const t = runTime(800);
  assert.ok(t > 50 && t < 70, `800 m で ${t.toFixed(0)} 秒`);
  assert.ok(Math.abs(runTime(10) - 2 * Math.sqrt(10 / 1.2)) < 1e-9);
});
