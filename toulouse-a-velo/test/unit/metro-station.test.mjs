import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalProjection } from '../../src/geo.js';
import { buildNetwork, LAYOUT } from '../../src/metro/network.js';
import { buildStationNav, planStation, stationLevels, flightHeight, stairRun, escalatorHeight, escalatorRun } from '../../src/metro/stationplan.js';
import { Nav } from '../../src/metro/nav.js';
import { entranceDoor } from '../../src/world/metro.js';

const proj = new LocalProjection(43.5994, 1.4395);

// 平らな地面（高さ 0）に置いた出入口（world/metro.js の形。rim・slope 付き）
function pit(station, du, dv, ang, down = 1, { len = 11, wid = 4.4 } = {}) {
  const [ax, az] = station.axis[station.lines[0]];
  const x = station.x + ax * du - az * dv, z = station.z + az * du + ax * dv;
  return { kind: 'metro', station: station.bd, x, z, ang, down, len, wid, depth: 4, rim: 0, slope: [0, 0] };
}

// 床から床へ 0.4 m 刻みで歩いて広がる（壁は横切らない）。start: [x, z, y]。行けた所の { x, z, y, region } を返す
export function flood(nav, start, { step = 0.4, limit = 400000 } = {}) {
  const seen = new Map(), out = [];
  const key = (x, z, y) => `${Math.round(x / step)},${Math.round(z / step)},${Math.round(y / 1.2)}`;
  const f0 = nav.floorAt(start[0], start[1], start[2]);
  if (!f0) return out;
  const q = [[start[0], start[1], f0.y, f0.region]];
  seen.set(key(start[0], start[1], f0.y), true);
  while (q.length && out.length < limit) {
    const [x, z, y, region] = q.shift();
    out.push({ x, z, y, region });
    for (const [dx, dz] of [[step, 0], [-step, 0], [0, step], [0, -step]]) {
      const f = nav.step(x, z, y, x + dx, z + dz);
      if (!f) continue;
      const k = key(x + dx, z + dz, f.y);
      if (seen.has(k)) continue;
      seen.set(k, true);
      q.push([x + dx, z + dz, f.y, f.region]);
    }
  }
  return out;
}

test('メトロの駅: 階段・エスカレーターの高さ（踊り場つき）', () => {
  const st = stairRun(5.5);
  assert.equal(st.n, 34);
  assert.equal(st.flights, 2);
  assert.equal(flightHeight(0, st.run, 10, 4.5, st.n, st.flights), 10);
  assert.equal(flightHeight(st.run, st.run, 10, 4.5, st.n, st.flights), 4.5);
  // 1 段ずつ下りる（段差は 0.165 m 以下）
  let prev = 10;
  for (let u = 0; u <= st.run; u += 0.05) {
    const y = flightHeight(u, st.run, 10, 4.5, st.n, st.flights);
    assert.ok(prev - y < 0.17 && y <= prev + 1e-9);
    prev = y;
  }
  const er = escalatorRun(5.5);
  assert.ok(Math.abs(escalatorHeight(er / 2, er, 10, 4.5) - 7.25) < 1e-9);
});

test('メトロの駅: 地上の出入口から通路・改札を通ってホームの両側まで歩ける（単線の駅・2 線の駅）', () => {
  const net = buildNetwork(proj);
  for (const id of ['capitole', 'jean-jaures', 'carmes']) {
    const s = net.byId.get(id);
    // 出入口: ホームの先・横・駅の真上（改札階が深くなる）・逆を向いたもの
    const pits = [pit(s, 45, 14, Math.atan2(s.axis[s.lines[0]][1], s.axis[s.lines[0]][0]), 1), pit(s, -5, 30, 0.3, -1), pit(s, 2, 2, 1.0, 1), pit(s, -40, -20, 2.0, -1)];
    const plan = planStation(s, pits, 0, net);
    // 通路を通せない出入口は閉める（ほかの通路と交わるより）。4 つのうち 3 つ以上は開いている
    assert.ok(plan.corridors.length >= pits.length - 1, `${id}: 出入口ごとに通路 ${plan.corridors.length}`);
    assert.equal(plan.corridors.length + plan.closed.length, pits.length);
    assert.ok(plan.deep, '出入口が改札階の上にかかるので深くする');
    const lv = stationLevels(s, pits.map(entranceDoor), 0, { deep: true });
    assert.ok(Math.abs(plan.ym - lv.ym) < 1e-9);
    for (const L of plan.lines) assert.ok(Math.abs(plan.ym - L.yp - LAYOUT.hallDrop - (L.line === s.lines[0] ? 0 : 7.5)) < 1e-9);
    const nav = new Nav();
    nav.add(buildStationNav(plan));
    for (const e of pits.filter((q) => !plan.closed.includes(q))) {
      // 吹き抜けの上の端（地上の高さ 0）の少し下りた所から
      const fx = Math.cos(e.ang) * e.down, fz = Math.sin(e.ang) * e.down;
      const start = [e.x - fx * (e.len / 2 - 0.4), e.z - fz * (e.len / 2 - 0.4), 0];
      const got = flood(nav, start);
      for (const L of plan.lines) {
        for (const side of [1, -1]) {
          const ok = got.some((p) => p.region?.kind === 'platform' && p.region.line === L.line && p.region.side === side && Math.abs(p.y - L.yp) < 0.01);
          assert.ok(ok, `${id}: 出入口 (${e.x.toFixed(0)}, ${e.z.toFixed(0)}) から ${L.line} 線の ${side > 0 ? '+' : '−'} のホームへ`);
        }
      }
      // ホームから線路には下りられない（ホームドアの扉は閉まっている）
      assert.ok(!got.some((p) => !p.region && p.y < plan.ym - 1), '線路に落ちない');
    }
  }
});
