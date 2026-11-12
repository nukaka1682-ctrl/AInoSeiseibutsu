// OpenStreetMap の屋内の地図から組み立てる駅（osmplan.js・osmentrances.js）と、島式のホーム（network.js）
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { LocalProjection, bboxAround } from '../../src/geo.js';
import { LAYOUT, buildNetwork, doorSideAt, islandOf, stationFrame, trackAt } from '../../src/metro/network.js';
import { projectEntrances, entranceFrame } from '../../src/world/metro.js';
import { Nav } from '../../src/metro/nav.js';
import {
  alignShallowPits, buildOsmStationNav, completeShallowPits, levelHeights, osmCapable, osmConnected, osmStationDepth, planOsmStation, projectStationOsm,
} from '../../src/metro/osmplan.js';

const root = new URL('../../public/data/', import.meta.url);
// Git に入っているデータだけで調べる（ほかの地図データは CI でテストのあとに取る）。駅の位置は OSM のホームから
const osm = JSON.parse(readFileSync(new URL('toulouse-metro-osm.json', root), 'utf8'));
const bbox = bboxAround(43.5994, 1.4395, 5000);
const proj = new LocalProjection((bbox.s + bbox.n) / 2, (bbox.w + bbox.e) / 2);
const network = buildNetwork(proj, { osm: osm.stations });

// 平らな地面（y = 0）で駅を組み立てる（ゲームの main.js の metroAdjust と同じ順）
function plan(id) {
  const s = network.byId.get(id), o = osm.stations[id];
  const bouches = (o.bouches || []).filter((b) => b.kind === 'metro');
  let pits = projectEntrances(bouches, proj).map((e) => ({ ...e, rim: 0, slope: [0, 0] }));
  alignShallowPits(s, pits);
  pits = pits.concat(completeShallowPits(s, pits));
  osmStationDepth(s, pits, () => 0);
  return planOsmStation(s, projectStationOsm(o, proj), pits, { ground: 0, network });
}

test('OSM の駅のデータ: 37 駅、高架の 2 駅のほかは地上の出入口（吹き抜け）がある', () => {
  assert.equal(Object.keys(osm.stations).length, 37);
  assert.match(osm.meta.source, /OpenStreetMap/);
  for (const [id, st] of Object.entries(osm.stations)) {
    const pits = st.bouches.filter((b) => b.kind === 'metro');
    if (id === 'basso-cambo' || id === 'jolimont') assert.equal(pits.length, 0, id);
    else assert.ok(pits.length >= 1, `${id} の出入口`);
    for (const b of pits) assert.ok(b.level < 0 && b.len >= 6 && b.wid >= 2.8, `${id} の吹き抜けの形`);
  }
});

test('ホームの位置と向き: OSM のホームの形から（Esquirol は南北）、階は地下', () => {
  const esq = network.byId.get('esquirol');
  assert.ok(Math.abs(esq.axis.A[1]) > 0.95, `Esquirol のホームは南北: ${esq.axis.A}`);
  assert.equal(esq.osmLevel.A, -4);
  assert.equal(network.byId.get('capitole').osmLevel.A, -2);
  assert.equal(network.byId.get('basso-cambo').osmLevel.A, 2); // 高架
  assert.equal(osmCapable(network.byId.get('basso-cambo')), false);
  assert.equal(osmCapable(network.byId.get('carmes')), true);
});

test('島式のホーム: Capitole・Esquirol・Jean Jaurès の A 線は、線路がホームの両側に広がり、扉は左側に開く', () => {
  for (const id of ['capitole', 'esquirol', 'jean-jaures']) {
    const s = network.byId.get(id), path = network.lines.A;
    assert.ok(islandOf(s, 'A'), id);
    assert.equal(doorSideAt(s, 'A'), -1);
    const p = trackAt(path, s.S.A, 1), f = stationFrame(s, 'A');
    const [, t] = f.local(p.x, p.z);
    assert.ok(Math.abs(t - (islandOf(s, 'A') + LAYOUT.psd - LAYOUT.trackOff)) < 0.05, `${id} の線路の横のずれ ${t}`);
  }
  assert.equal(islandOf(network.byId.get('jean-jaures'), 'B'), null);
  assert.equal(doorSideAt(network.byId.get('carmes'), 'B'), 1);
  // 駅と駅のあいだでは、ふつうの線路の間隔に戻る（Saint-Cyprien と Esquirol の真ん中）
  const a = network.byId.get('saint-cyprien'), b = network.byId.get('esquirol');
  const p = trackAt(network.lines.A, (a.S.A + b.S.A) / 2, 1);
  assert.ok(Math.abs(p.off - LAYOUT.trackOff) < 1e-6);
});

test('階の高さ: 地下 1 階から 5 m ごと、ホームの階の上は 5.5 m、半階は間', () => {
  const Y = levelHeights(-5, 0, new Set([-3]));
  assert.equal(Y(-1), -5);
  assert.equal(Y(-2), -10);
  assert.equal(Y(-3), -15.5);
  assert.equal(Y(-0.5), -2.5);
  assert.equal(Y(-2.5), -12.75);
});

test('OSM の間取り: 地下の駅はどれも、出入口からどのホームにも行ける（OSM に駅の中の階段がない Compans-Caffarelli は今までの間取り）。データの印 layout と合う', () => {
  for (const s of network.stations) {
    const flag = osm.stations[s.id].layout;
    if (!osmCapable(s)) {
      assert.equal(flag, 'synth', s.id);
      continue;
    }
    const p = plan(s.id);
    assert.ok(p, s.id);
    assert.equal(osmConnected(p), s.id !== 'compans-caffarelli', `${s.id} のつながり`);
    assert.equal(flag, osmConnected(p) ? 'osm' : 'synth', `${s.id} の印（scripts/metro-osm.mjs で作り直す）`);
  }
});

// 歩ける所を 0.25 m ごとに幅優先でたどって、出入口の上の端からホームの両側に着くか
function walkable(p) {
  const nav = new Nav();
  nav.add(buildOsmStationNav(p));
  const G = 0.25, seen = new Set(), q = [];
  const key = (x, z, y) => `${Math.round(x / G)},${Math.round(z / G)},${Math.round(y)}`;
  for (const e of p.pits) {
    const [x, z] = entranceFrame(e).at(-e.len / 2 + 0.4, 0), fl = nav.floorAt(x, z, 0.2);
    if (fl) q.push([x, z, fl.y]);
  }
  const reached = new Set();
  for (let i = 0; i < q.length && i < 120000; i++) {
    const [x, z, y] = q[i];
    for (const [dx, dz] of [[G, 0], [-G, 0], [0, G], [0, -G]]) {
      const st = nav.step(x, z, y, x + dx, z + dz);
      if (!st) continue;
      const k = key(x + dx, z + dz, st.y);
      if (seen.has(k)) continue;
      seen.add(k);
      if (st.region?.kind === 'platform') reached.add(`${st.region.line}${st.region.side}`);
      q.push([x + dx, z + dz, st.y]);
    }
  }
  return reached;
}

test('OSM の間取りを歩く: 島式（Capitole・Esquirol）・2 つの線（Jean Jaurès）・浅いホーム（Bellefontaine）・B 線の 3 層（Barrière de Paris）', () => {
  for (const id of ['capitole', 'esquirol', 'jean-jaures', 'bellefontaine', 'barriere-de-paris']) {
    const p = plan(id), reached = walkable(p);
    for (const L of p.lines) for (const side of [1, -1]) assert.ok(reached.has(`${L.line}${side}`), `${id} の ${L.line} 線 ${side} のホーム（${[...reached]}）`);
  }
});

// 2 cm ごとに床をたどる（歩く人は 1 フレームに数 cm ずつ進むので、すき間があると止まる）
function seamless(nav, a, b, y) {
  const n = Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 0.02);
  for (let i = 0; i <= n; i++) {
    const x = a[0] + ((b[0] - a[0]) * i) / n, z = a[1] + ((b[1] - a[1]) * i) / n, f = nav.floorAt(x, z, y);
    if (!f) return `(${x.toFixed(2)}, ${z.toFixed(2)})`;
    y = f.y;
  }
  return null;
}

test('OSM の間取りのつなぎ目: 出入口の扉・階段の上と下に床のすき間がない（全駅）', () => {
  for (const s of network.stations) {
    if (!osmCapable(s)) continue;
    const p = plan(s.id);
    if (!osmConnected(p)) continue;
    const nav = new Nav();
    nav.add(buildOsmStationNav(p));
    for (const q of p.pitInfo) {
      const d = q.d, at = (u) => [d.x + d.dx * u, d.z + d.dz * u];
      const gap = seamless(nav, at(-0.8), at(q.step ? q.step.len + 0.8 : 0.8), d.yb);
      assert.equal(gap, null, `${s.id} の出入口の扉 ${gap}`);
    }
    for (const b of p.blocks) {
      if (b.doorStep) continue;
      for (const ln of b.lanes) {
        const t = (ln.t0 + ln.t1) / 2;
        assert.equal(seamless(nav, b.frame.at(-0.8, t), b.frame.at(0.6, t), b.y0), null, `${s.id} の ${b.hi}→${b.lo} の上の端`);
        assert.equal(seamless(nav, b.frame.at(b.len - 0.6, t), b.frame.at(b.len + 0.8, t), b.y1), null, `${s.id} の ${b.hi}→${b.lo} の下の端`);
      }
    }
  }
});

// 体の幅で歩く（壁から 0.2 m 離れたマスだけ。改札の通路 0.8 m は格子が粗いので除く）: 出入口からホームの両側へ、ホームからどの出入口へも
function walkableWide(p) {
  const nav = new Nav(), layer = buildOsmStationNav(p);
  for (const w of layer.walls) if (w.gate) w.active = false;
  nav.add(layer);
  const G = 0.25, seen = new Set(), q = [];
  const key = (x, z, y) => `${Math.round(x / G)},${Math.round(z / G)},${Math.round(y / 1.2)}`;
  for (const e of p.pits) {
    const [x, z] = entranceFrame(e).at(-e.len / 2 + 0.6, 0), fl = nav.floorAt(x, z, 0.3);
    if (fl) q.push([x, z, fl.y]);
  }
  const reached = new Set(), landings = new Set();
  for (let i = 0; i < q.length && i < 200000; i++) {
    const [x, z, y] = q[i];
    for (const [dx, dz] of [[G, 0], [-G, 0], [0, G], [0, -G]]) {
      const st = nav.step(x, z, y, x + dx, z + dz);
      if (!st) continue;
      const k = key(x + dx, z + dz, st.y);
      if (seen.has(k)) continue;
      seen.add(k);
      if (nav.resolve(x + dx, z + dz, 0.2, st.y).hit) continue;
      if (st.region?.kind === 'platform') reached.add(`${st.region.line}${st.region.side}`);
      if (st.region?.kind === 'landing') landings.add(st.region.pit);
      q.push([x + dx, z + dz, st.y]);
    }
  }
  return { reached, landings };
}

test('OSM の間取りを体の幅で歩く: 折り返しの階段（Esquirol）・吹き抜けのまわり（Carmes）・通路のつなぎ目（Marengo）・改札（Saint-Cyprien）', () => {
  for (const id of ['esquirol', 'carmes', 'marengo', 'saint-cyprien']) {
    const p = plan(id), { reached, landings } = walkableWide(p);
    for (const L of p.lines) for (const side of [1, -1]) assert.ok(reached.has(`${L.line}${side}`), `${id} の ${L.line} 線 ${side} のホーム`);
    assert.equal(landings.size, p.pits.length, `${id} のどの出入口の踊り場にも着く`);
  }
});
