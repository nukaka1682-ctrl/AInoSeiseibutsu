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
