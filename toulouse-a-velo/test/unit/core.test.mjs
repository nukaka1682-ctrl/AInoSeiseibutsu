import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LocalProjection, bboxAround, clipRingToRect, clipPolylineToRect, pointInRing, signedArea, simplifyRing,
} from '../../src/geo.js';
import { assembleRings, interiorPoint, parseOsm, parseLength } from '../../src/world/parse.js';
import { RoadNetwork } from '../../src/game/roadnet.js';
import { CollisionWorld } from '../../src/game/collision.js';
import { fetchBdTopo } from '../../src/data/bdtopo.js';
import { buildOverpassQuery, compactOsm } from '../../src/data/overpass.js';
import { makeFixture } from '../fixture.mjs';

test('投影の往復と bbox', () => {
  const p = new LocalProjection(43.6, 1.44);
  const [x, z] = p.project(43.61, 1.45);
  assert.ok(x > 790 && x < 820, `x=${x}`); // 経度 0.01° ≈ 806 m
  assert.ok(z < -1100 && z > -1120, `z=${z}`); // 北は -z
  const [lat, lon] = p.unproject(x, z);
  assert.ok(Math.abs(lat - 43.61) < 1e-9 && Math.abs(lon - 1.45) < 1e-9);
  const b = bboxAround(43.6, 1.44, 1000);
  const [x0] = p.project(43.6, b.w);
  const [, z0] = p.project(b.n, 1.44);
  assert.ok(Math.abs(x0 + 1000) < 1 && Math.abs(z0 + 1000) < 1);
});

test('ポリゴンの単純化・内部点・クリップ', () => {
  const ring = [[0, 0], [5, 0.05], [10, 0], [10, 10], [5, 10], [0, 10]];
  assert.equal(simplifyRing(ring).length, 4);
  const L = [[0, 0], [10, 0], [10, 2], [2, 2], [2, 10], [0, 10]];
  const ip = interiorPoint(L);
  assert.ok(pointInRing(ip[0], ip[1], L));
  const clipped = clipRingToRect([[-5, -5], [5, -5], [5, 5], [-5, 5]], 0, 0, 10, 10);
  assert.equal(Math.round(Math.abs(signedArea(clipped))), 25);
  const parts = clipPolylineToRect([[-5, 5], [5, 5], [15, 5]], 0, 0, 10, 10);
  assert.deepEqual(parts, [[[0, 5], [5, 5], [10, 5]]]);
  assert.equal(parseLength('12,5 m'), 12.5);
  assert.ok(Math.abs(parseLength("30'") - 9.144) < 1e-9);
});

test('マルチポリゴンのリング組み立て', () => {
  const rings = assembleRings([[1, 2, 3], [5, 6, 1], [3, 4, 5]]);
  assert.equal(rings.length, 1);
  assert.equal(rings[0].length, 6);
  assert.equal(assembleRings([[1, 2, 3]]).length, 0); // 閉じないものは捨てる
});

test('Overpass クエリとタグの圧縮', () => {
  const q = buildOverpassQuery({ s: 1, w: 2, n: 3, e: 4 });
  assert.match(q, /way\["building"\]\(1,2,3,4\)/);
  const c = compactOsm({ elements: [{ type: 'way', id: 1, nodes: [1, 2], tags: { building: 'yes', 'addr:street': 'x', source: 'cadastre' } }] });
  assert.deepEqual(c.elements[0].tags, { building: 'yes' });
});

test('BD TOPO: [lat,lon] 順の GeoJSON を [lon,lat] にそろえる', async () => {
  const fx = makeFixture('light');
  const orig = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (url) => {
    calls++;
    assert.match(String(url), /TYPENAMES=BDTOPO_V3%3Abatiment/);
    return { ok: true, json: async () => fx.bdtopo };
  };
  try {
    const out = await fetchBdTopo(fx.bbox);
    assert.equal(calls, 1);
    assert.equal(out.length, fx.bdtopo.features.length);
    const [lon, lat] = out[0].ring[0];
    assert.ok(lon > 1 && lon < 2 && lat > 43 && lat < 44, `${lon},${lat}`);
    assert.ok(out[0].h > 0);
  } finally {
    globalThis.fetch = orig;
  }
});

function parsedFixture() {
  const fx = makeFixture('light');
  const proj = new LocalProjection((fx.bbox.s + fx.bbox.n) / 2, (fx.bbox.w + fx.bbox.e) / 2);
  const rect = {
    minX: proj.project(proj.lat0, fx.bbox.w)[0], maxX: proj.project(proj.lat0, fx.bbox.e)[0],
    minZ: proj.project(fx.bbox.n, proj.lon0)[1], maxZ: proj.project(fx.bbox.s, proj.lon0)[1],
  };
  const bd = fx.bdtopo.features.map((f) => ({ ring: f.geometry.coordinates[0].map(([lat, lon]) => [lon, lat]), h: f.properties.hauteur, levels: f.properties.nombre_d_etages }));
  return { fx, proj, rect, parsed: parseOsm(fx.osm, proj, rect, bd) };
}

test('OSM の解析: 建物・川・橋・名前', () => {
  const { parsed, rect } = parsedFixture();
  assert.ok(parsed.buildings.length > 500, `buildings=${parsed.buildings.length}`);
  // 単純化で一直線上の頂点が消えて四角形になる
  const simple = parsed.buildings.find((b) => b.tags.building === 'yes' && !b.tags.name);
  assert.equal(simple.outer.length, 4);
  // 高さの出典
  const src = {};
  for (const b of parsed.buildings) src[b.info.heightSource] = (src[b.info.heightSource] || 0) + 1;
  assert.ok(src.IGN > 50, JSON.stringify(src));
  assert.ok(src.OSM > 50);
  // OSM の height タグは IGN より優先
  const tagged = parsed.buildings.find((b) => b.tags.height && b.bdHeight);
  assert.equal(tagged.info.heightSource, 'OSM');
  // サン・セルナンはパーツで描く
  const sernin = parsed.buildings.find((b) => b.tags.name === 'Basilique Saint-Sernin');
  assert.ok(sernin.hasParts);
  const tower = parsed.parts.find((p) => p.tags.height === '64');
  assert.equal(tower.info.height, 52); // 64 m から屋根 12 m を引いた壁の高さ
  // 川: 2 本の way が 1 つのリングになり、島が穴になり、エリアでクリップされる
  const river = parsed.areas.find((a) => a.type === 'water' && a.name === 'La Garonne');
  assert.ok(river);
  assert.equal(river.holes.length, 1);
  assert.equal(river.depth, 6);
  assert.ok(river.bounds.minZ >= rect.minZ - 1e-6 && river.bounds.maxZ <= rect.maxZ + 1e-6);
  // 橋
  const bridge = parsed.roads.find((r) => r.name === 'Pont Neuf');
  assert.ok(bridge.bridge);
  assert.ok(parsed.named.some((n) => n.name === 'Place du Capitole' && n.polygon));
  assert.ok(parsed.trees.length > 20);
});

test('道路ネットワーク: 通りの名前とルート探索', () => {
  const { parsed } = parsedFixture();
  const net = new RoadNetwork(parsed.roads);
  assert.equal(net.streetNameAt(0, 450.5)?.name, 'Rue de Metz');
  // 左岸から橋を渡って右岸の東端まで
  const r = net.route(-640, 300, 560, -600);
  assert.ok(r && r.length > 5);
  const crossesBridge = r.some(([x, z]) => x < -450 && Math.abs(z - 450) < 1);
  assert.ok(crossesBridge, '橋を通るはず');
  assert.ok(net.onRoad(-500, 450)); // 橋の上
  assert.ok(!net.onRoad(-500, 300)); // 川の上
});

test('当たり判定: 壁から押し出される・レイが壁で止まる', () => {
  const cw = new CollisionWorld({ minX: -100, minZ: -100, maxX: 100, maxZ: 100 });
  cw.addRing([[0, 0], [10, 0], [10, 10], [0, 10]]);
  const r = cw.resolve(5, -0.2, 0.5);
  assert.ok(r.hit);
  assert.ok(Math.abs(r.z + 0.5) < 1e-6, `z=${r.z}`);
  assert.ok(Math.abs(r.nz + 1) < 1e-6);
  const t = cw.raycast(5, -10, 5, 5);
  assert.ok(Math.abs(t - 10 / 15) < 1e-6);
  assert.ok(cw.outOfBounds(95, 0));
});
