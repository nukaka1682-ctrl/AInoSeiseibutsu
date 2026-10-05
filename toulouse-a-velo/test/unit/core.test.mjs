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

// ---- IGN BD TOPO → OSM 形式の変換 ----
import { ignToOsm, prettifyName } from '../../src/data/ign.js';
import { fillWaterUnderBridges } from '../../src/world/parse.js';

test('IGN: 略記の道路名を読みやすくする', () => {
  assert.equal(prettifyName('R DES PENITENTS GRIS'), 'Rue des Penitents Gris');
  assert.equal(prettifyName("PL DE L'EUROPE"), "Place de l'Europe");
  assert.equal(prettifyName('Rue des Pénitents Gris'), 'Rue des Pénitents Gris');
});

test('IGN: 建物・道路・水域・広場を OSM 形式に変換する', () => {
  const bbox = { s: 43.59, w: 1.43, n: 43.61, e: 1.46 };
  const sq = (lon, lat, d) => [[lon, lat, 150], [lon + d, lat, 150], [lon + d, lat + d, 150], [lon, lat + d, 150], [lon, lat, 150]];
  const layers = {
    batiment: [
      { geometry: { type: 'MultiPolygon', coordinates: [[sq(1.44, 43.60, 0.0002), sq(1.44005, 43.60005, 0.00005)]] },
        properties: { hauteur: 12.3, nombre_d_etages: 4, nature: 'Indifférenciée', usage_1: 'Résidentiel', materiaux_des_murs: '40', materiaux_de_la_toiture: '10', altitude_minimale_toit: 160, altitude_maximale_toit: 162 } },
      { geometry: { type: 'MultiPolygon', coordinates: [[sq(1.45, 43.60, 0.0002)]] },
        properties: { hauteur: 20, nature: 'Eglise', materiaux_de_la_toiture: '40', altitude_minimale_toit: 170, altitude_maximale_toit: 175 } },
    ],
    troncon_de_route: [
      { geometry: { type: 'LineString', coordinates: [[1.44, 43.601, 150], [1.441, 43.601, 150]] },
        properties: { nature: 'Route à 1 chaussée', importance: '5', acces_vehicule_leger: 'Physiquement impossible', nom_voie_ban_gauche: "Rue d'Alsace-Lorraine", largeur_de_chaussee: 7, position_par_rapport_au_sol: '0' } },
      { geometry: { type: 'LineString', coordinates: [[1.441, 43.601, 150], [1.442, 43.601, 150]] },
        properties: { nature: 'Route à 2 chaussées', importance: '3', acces_vehicule_leger: 'Libre', nom_voie_ban_gauche: 'Pont Neuf', largeur_de_chaussee: 9, position_par_rapport_au_sol: '1', sens_de_circulation: 'Sens direct' } },
    ],
    surface_hydrographique: [{ geometry: { type: 'MultiPolygon', coordinates: [[sq(1.435, 43.595, 0.003)]] }, properties: { nature: 'Ecoulement naturel' } }],
    zone_d_activite_ou_d_interet: [
      { geometry: { type: 'MultiPolygon', coordinates: [[sq(1.443, 43.604, 0.0005)]] }, properties: { nature: 'Espace public', nature_detaillee: 'Esplanade', toponyme: 'Place du Capitole' } },
      { geometry: { type: 'MultiPolygon', coordinates: [[sq(1.442, 43.608, 0.0005)]] }, properties: { nature: 'Culte chrétien', toponyme: 'Basilique Saint-Sernin' } },
    ],
  };
  const { elements } = ignToOsm(layers, bbox);
  const ways = elements.filter((e) => e.type === 'way' && e.tags);
  const rel = elements.find((e) => e.type === 'relation');
  // 中庭のある建物はマルチポリゴン、壁はレンガ、屋根の高さ 2 m を足した全体の高さ
  assert.equal(rel.tags.building, 'yes');
  assert.equal(rel.tags['building:material'], 'brick');
  assert.equal(rel.tags.height, '14.3');
  assert.equal(rel.tags['roof:height'], '2');
  assert.equal(rel.members.filter((m) => m.role === 'inner').length, 1);
  // コンクリート屋根の教会は陸屋根
  const church = ways.find((w) => w.tags.building === 'church');
  assert.equal(church.tags['roof:shape'], 'flat');
  assert.equal(church.tags.height, '20');
  // 歩行者専用の通りと橋
  assert.equal(ways.find((w) => w.tags.name === "Rue d'Alsace-Lorraine").tags.highway, 'pedestrian');
  const bridge = ways.find((w) => w.tags.name === 'Pont Neuf');
  assert.equal(bridge.tags.bridge, 'yes');
  assert.equal(bridge.tags.oneway, 'yes');
  // 2 本の道路は同じ点でつながる
  const a = ways.find((w) => w.tags.name === "Rue d'Alsace-Lorraine"), b = bridge;
  assert.equal(a.nodes.at(-1), b.nodes[0]);
  assert.equal(ways.find((w) => w.tags.natural === 'water').tags.water, 'river');
  assert.equal(ways.find((w) => w.tags.name === 'Place du Capitole').tags.highway, 'pedestrian');
  assert.ok(elements.some((e) => e.type === 'node' && e.tags?.name === 'Basilique Saint-Sernin'));
  // 解析まで通る
  const proj = new LocalProjection(43.6, 1.445);
  const parsed = parseOsm({ elements }, proj, { minX: -1500, minZ: -1500, maxX: 1500, maxZ: 1500 }, []);
  const court = parsed.buildings.find((x) => x.holes.length === 1);
  assert.equal(court.info.heightSource, 'IGN');
  assert.ok(Math.abs(court.info.height - 12.3) < 1e-6, `wall height ${court.info.height}`); // 壁は軒の高さまで
  assert.equal(court.info.roofHeight, 2);
});

test('橋の下で切り抜かれた水面を埋める', () => {
  // 川（x: -50〜50）を、橋の幅（z: -10〜10）だけ岸から岸まで切り抜いて 2 つに分けた形
  const river = (z0, z1) => ({ type: 'water', outer: [[-50, z0], [50, z0], [50, z1], [-50, z1]], holes: [], depth: 6, kind: 'river', bounds: { minX: -50, maxX: 50, minZ: Math.min(z0, z1), maxZ: Math.max(z0, z1) } });
  const areas = [river(-200, -10), river(10, 200)];
  const roads = [{ bridge: true, tunnel: false, width: 8, pts: [[-80, 0], [80, 0]] }];
  fillWaterUnderBridges(areas, roads);
  const patch = areas.find((a) => a.patch);
  assert.ok(patch, 'パッチができる');
  assert.ok(pointInRing(0, 0, patch.outer) && pointInRing(-45, 9, patch.outer));
  assert.ok(!pointInRing(-75, 0, patch.outer), '岸の上までは広げない');
  assert.equal(patch.depth, 6);
});

// ---- LiDAR（表面・地形モデル）----
import { HeightGrid, fillNoData, lidarResolution } from '../../src/data/lidar.js';
import { roofFromDsm } from '../../src/world/lidarroof.js';
import { detectTrees } from '../../src/world/lidartrees.js';

// 100 m × 100 m、1 m 格子の合成データ: 平らな地面 140 m、切妻屋根の建物（軒 10 m・棟 13 m）、木 1 本（高さ 12 m）
function syntheticLidar() {
  const rect = { minX: -50, maxX: 50, minZ: -50, maxZ: 50 };
  const cols = 100, rows = 100;
  const dtm = new Float32Array(cols * rows).fill(140);
  const dsm = new Float32Array(cols * rows).fill(140);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = -50 + c + 0.5, z = -50 + r + 0.5;
      if (x > -20 && x < 0 && z > -10 && z < 10) dsm[r * cols + c] = 150 + 3 * (1 - Math.abs(z) / 10); // 棟は z = 0（東西方向）
      const d = Math.hypot(x - 25, z - 25);
      if (d < 4) dsm[r * cols + c] = 140 + 12 - d * 1.2;
    }
  }
  return { rect, dsm: { data: dsm, cols, rows }, dtm: { data: dtm, cols, rows } };
}

test('LiDAR: 格子の補間・欠測の穴埋め・解像度', () => {
  const g = new HeightGrid({ data: new Float32Array([0, 10, 20, 30]), cols: 2, rows: 2 }, { minX: 0, maxX: 2, minZ: 0, maxZ: 2 }, 5);
  assert.equal(g.sample(1, 0.5), 0); // セルの中心同士の真ん中: (0 + 10) / 2 - 5
  assert.equal(g.sample(1, 1), 10);
  const d = new Float32Array([1, -99999, 3, 4, 5, 6, 7, 8, 9]);
  fillNoData(d, 3, 3);
  assert.ok(Math.abs(d[1] - (1 + 3 + 5) / 3) < 1e-6);
  assert.deepEqual(lidarResolution({ minX: -1200, maxX: 1200, minZ: -1200, maxZ: 1200 }), { dsm: 1, dtm: 2 });
});

test('LiDAR: 表面モデルから切妻屋根の形を作る', () => {
  const L = syntheticLidar();
  const dsm = new HeightGrid(L.dsm, L.rect, 140);
  const outer = [[-20, -10], [0, -10], [0, 10], [-20, 10]];
  const roof = roofFromDsm(outer, [], (x, z) => dsm.sample(x, z));
  assert.ok(roof.triangles.length >= 6 && roof.triangles.length % 3 === 0);
  const ridge = Math.max(...roof.heights), eave = Math.min(...roof.heights);
  assert.ok(ridge > 12 && ridge <= 13.01, `棟 ${ridge}`);
  assert.ok(eave > 9.9 && eave < 11, `軒 ${eave}`);
  // 平らな面の上の点は省かれる（棟の上の点だけ残る）
  const steiner = roof.points.length - roof.rings[0].count;
  assert.ok(steiner < 20, `内部の点 ${steiner}`);
});

test('LiDAR: 樹冠から木を見つける（建物の上は除く）', () => {
  const L = syntheticLidar();
  const dsm = new HeightGrid(L.dsm, L.rect, 140), dtm = new HeightGrid(L.dtm, L.rect, 140);
  const building = { outer: [[-20, -10], [0, -10], [0, 10], [-20, 10]], bounds: { minX: -20, maxX: 0, minZ: -10, maxZ: 10 } };
  const trees = detectTrees({ dsm, dtm, buildings: [building] });
  assert.equal(trees.length, 1);
  assert.ok(Math.hypot(trees[0].x - 25, trees[0].z - 25) < 1.5);
  assert.ok(trees[0].h > 10 && trees[0].h < 12.5, `高さ ${trees[0].h}`);
  assert.ok(trees[0].r > 2 && trees[0].r < 6, `半径 ${trees[0].r}`);
});

// ---- 広いエリアのタイル ----
import { boundsToBbox, featureTile, tileAt, tileBounds, tileLayout } from '../../src/data/tiles.js';
import { areaFrame } from '../../src/world/assemble.js';

test('タイル: 並び・位置・緯度経度・建物の割り当て', () => {
  const bbox = bboxAround(43.5994, 1.4395, 5000);
  const { proj, rect } = areaFrame(bbox);
  const L = tileLayout(rect);
  assert.ok(L.cols >= 20 && L.cols <= 21 && L.rows >= 20 && L.rows <= 21, `${L.cols}×${L.rows}`);
  const [i, j] = tileAt(L, 0, 0);
  const b = tileBounds(L, i, j);
  assert.ok(b.minX <= 0 && b.maxX > 0 && b.minZ <= 0 && b.maxZ > 0);
  assert.equal(tileAt(L, rect.maxX + 1, 0), null);
  // タイルの範囲 → 緯度経度 → ローカル座標に戻る
  const bb = boundsToBbox(bbox, rect, b);
  const [x0, z0] = proj.project(bb.n, bb.w);
  assert.ok(Math.abs(x0 - b.minX) < 0.5 && Math.abs(z0 - b.minZ) < 0.5);
  // 建物（GeoJSON、[lon, lat] でも [lat, lon] でも）を最初の点のタイルに割り当てる
  const [lat, lon] = proj.unproject(10, 10);
  const lonLat = { geometry: { type: 'Polygon', coordinates: [[[lon, lat], [lon + 1e-4, lat], [lon, lat + 1e-4]]] } };
  const latLon = { geometry: { type: 'Polygon', coordinates: [[[lat, lon], [lat, lon + 1e-4], [lat + 1e-4, lon]]] } };
  assert.deepEqual(featureTile(lonLat, L, bbox), tileAt(L, 10, 10));
  assert.deepEqual(featureTile(latLon, L, bbox), tileAt(L, 10, 10));
});
