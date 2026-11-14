import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { AREA_PRESETS } from '../../src/config.js';
import { bboxAround } from '../../src/geo.js';
import { areaFrame } from '../../src/world/assemble.js';
import { buildNetwork, kindAt, pathAt, stationTrack } from '../../src/metro/network.js';

const data = new URL('../../public/data/', import.meta.url);
const pr = AREA_PRESETS.toulouse, { proj } = areaFrame(bboxAround(pr.lat, pr.lon, pr.radius));
const osm = JSON.parse(readFileSync(new URL('toulouse-metro-osm.json', data))).stations;
const tracks = JSON.parse(readFileSync(new URL('toulouse-metro-tracks.json', data)));
const net = buildNetwork(proj, { osm, tracks });

test('本物の線形: 駅は線路の上に順に並び、ホームは直線、曲がりはなめらか', () => {
  for (const [line, path] of Object.entries(net.lines)) {
    let prev = -1000;
    for (const s of path.stations) {
      assert.ok(stationTrack(net, s, line).d < 20, `${s.name} は線路の近く`);
      assert.ok(s.S[line] > prev + 250, `${s.name} は順に並ぶ`);
      prev = s.S[line];
      const [ax, az] = s.axis[line];
      for (const u of [-20, 0, 20]) {
        const q = pathAt(path, s.S[line] + u);
        assert.ok(q.hx * ax + q.hz * az > 0.999, `${s.name} のホームの向き`);
      }
    }
    for (let i = 1; i < path.pts.length; i++) {
      const a = path.pts[i - 1], b = path.pts[i];
      assert.ok(a.hx * b.hx + a.hz * b.hz > Math.cos((6 * Math.PI) / 180), `${line} の曲線 S=${b.S.toFixed(0)}`);
      assert.ok(Number.isFinite(b.y), '高さ');
    }
  }
  // 実際の長さ（駅から駅まで）: A 線 約 12 km、B 線 約 15.4 km。Empalot → Saint-Agne は大きく回る
  assert.ok(Math.abs(net.lines.A.length - 11970) < 200, `A 線 ${net.lines.A.length}`);
  assert.ok(Math.abs(net.lines.B.length - 15440) < 200, `B 線 ${net.lines.B.length}`);
  const e = net.byId.get('empalot'), a = net.byId.get('saint-agne');
  assert.ok(a.S.B - e.S.B > 1150);
});

test('本物の線形: A 線の地上・高架の区間（Basso Cambo・環状道路の橋・Jolimont の高架橋・エール川の橋）、B 線は全部トンネル', () => {
  const A = net.lines.A, B = net.lines.B;
  assert.ok(B.pts.every((p) => p.k === 't'));
  const runs = [];
  for (const p of A.pts) {
    const open = p.k !== 't';
    if (runs.length && runs[runs.length - 1].open === open) runs[runs.length - 1].S1 = p.S;
    else runs.push({ open, S0: p.S, S1: p.S });
  }
  assert.equal(runs.filter((r) => r.open).length, 4);
  const bc = net.byId.get('basso-cambo'), jo = net.byId.get('jolimont');
  assert.equal(kindAt(A, bc.S.A), 'b');
  assert.ok(bc.aerial?.A > 160 && bc.aerial.A < 165, 'Basso Cambo は高架の駅（線路の標高 約 162 m）');
  assert.equal(kindAt(A, jo.S.A + 60), 'b');
  // 高架橋の上の高さは線路の標高から（Jolimont の高架橋は東へ下る）
  assert.ok(pathAt(A, jo.S.A + 100).y > pathAt(A, jo.S.A + 300).y + 8);
});

// 床から床へ 0.4 m 刻みで歩いて広がる（metro-station.test.mjs の flood と同じ）
function flood(nav, start, step = 0.4) {
  const seen = new Set(), out = [];
  const key = (x, z, y) => `${Math.round(x / step)},${Math.round(z / step)},${Math.round(y / 1.2)}`;
  const f0 = nav.floorAt(start[0], start[1], start[2]);
  if (!f0) return out;
  const q = [[start[0], start[1], f0.y, f0.region]];
  seen.add(key(start[0], start[1], f0.y));
  while (q.length && out.length < 400000) {
    const [x, z, y, region] = q.shift();
    out.push({ x, z, y, region });
    for (const [dx, dz] of [[step, 0], [-step, 0], [0, step], [0, -step]]) {
      const f = nav.step(x, z, y, x + dx, z + dz);
      if (!f) continue;
      const k = key(x + dx, z + dz, f.y);
      if (seen.has(k)) continue;
      seen.add(k);
      q.push([x + dx, z + dz, f.y, f.region]);
    }
  }
  return out;
}

test('高架の駅（Basso Cambo・Jolimont）: 街への扉から切符売り場・改札・階段を通って両方のホームへ歩ける', async () => {
  const { RAIL_ALT_TO_FLOOR } = await import('../../src/metro/network.js');
  const { aerialLevels, buildAerialNav, isAerial, planAerialStation, aerialFootprints } = await import('../../src/metro/aerial.js');
  const { Nav } = await import('../../src/metro/nav.js');
  const aerial = net.stations.filter(isAerial);
  assert.deepEqual(aerial.map((s) => s.id), ['basso-cambo', 'jolimont']);
  for (const s of aerial) {
    const ground = () => s.aerial.A + RAIL_ALT_TO_FLOOR - 7; // 平らな地面（ホームの 7 m 下）
    const lv = aerialLevels(s, RAIL_ALT_TO_FLOOR, ground);
    s.ym = lv.ym;
    s.yp = lv.yp;
    assert.ok(Math.abs(s.yp.A - s.ym - 6.85) < 1e-6);
    assert.equal(aerialFootprints(s, ground).length, 1);
    const plan = planAerialStation(s, ground, net);
    assert.equal(plan.doors.length, 3);
    const nav = new Nav();
    nav.add(buildAerialNav(plan));
    for (const d of plan.doors) {
      const got = flood(nav, [d.x + d.nx * 1.5, d.z + d.nz * 1.5, s.ym]);
      for (const side of [1, -1]) {
        assert.ok(got.some((p) => p.region?.kind === 'platform' && p.region.side === side && Math.abs(p.y - s.yp.A) < 0.01), `${s.id}: 扉から ${side > 0 ? '+' : '−'} のホームへ`);
      }
      // ホームから線路へは出られない（ホームドアは閉まっている）
      const f = plan.frame;
      assert.ok(!got.some((p) => Math.abs(p.y - s.yp.A) < 0.5 && Math.abs(f.local(p.x, p.z)[1]) < 3));
    }
  }
});
