// 地図データから「遊べる街」を組み立てる: 解析 → 道路網 → 地面・水・橋 → 当たり判定 → 木 → 建物 → 名所。
// 描画まわり（ミニマップ・目的地の光の柱など）以外はここにまとめ、ブラウザと Node のテストで共通に使う。
//
// data.walls / data.trees（同梱データにある、地籍と LiDAR から見つけた塀と木）があれば、それも置く。
import * as THREE from 'three';
import { Grid, LocalProjection, pointInPolygon, pointInRing } from '../geo.js';
import { CAR_ROADS, parseOsm } from './parse.js';
import { buildBuildings } from './buildings.js';
import { buildGround, makeWaterTest } from './ground.js';
import { makeDeckTest } from './bridges.js';
import { buildTrees, fillParkTrees, planeTreeTest, streetTrees } from './trees.js';
import { buildEnclosures, clearRoads, projectTrees, projectWalls } from './enclosures.js';
import { findTowers } from './towers.js';
import { findCapitoleFacade, markBrickSites } from './landmarkfacades.js';
import { oldTownTest } from '../config.js';
import { POST_HIT } from './streets.js';
import { CollisionWorld } from '../game/collision.js';
import { RoadNetwork } from '../game/roadnet.js';
import { resolveLandmarks } from '../game/landmarks.js';

const defaultPause = () => new Promise((r) => setTimeout(r, 0));

export function areaFrame(bbox) {
  const lat0 = (bbox.s + bbox.n) / 2, lon0 = (bbox.w + bbox.e) / 2;
  const proj = new LocalProjection(lat0, lon0);
  const rect = {
    minX: proj.project(lat0, bbox.w)[0], maxX: proj.project(lat0, bbox.e)[0],
    minZ: proj.project(bbox.n, lon0)[1], maxZ: proj.project(bbox.s, lon0)[1],
  };
  return { proj, rect };
}

export async function assembleWorld(data, bbox, { buildingMats, groundMats, progress = () => {}, pause = defaultPause }) {
  const { proj, rect } = areaFrame(bbox);
  progress('建物・道路・水辺を解析中…', 0);
  await pause();
  const parsed = parseOsm(data.osm, proj, rect, data.bdtopo);
  const roadnet = new RoadNetwork(parsed.roads);
  const group = new THREE.Group();

  // 当たり判定。道路の中心線が建物の壁を横切っている所（建物の下をくぐる通路など）は壁を開けておく
  const collision = new CollisionWorld(rect);
  let opened = 0;
  const isPassage = (a, b) => {
    const hit = roadnet.crossesRoad(a[0], a[1], b[0], b[1]);
    if (hit) opened++;
    return hit;
  };
  for (const b of parsed.buildings) {
    if (!b.info.collide) continue;
    collision.addRing(b.outer, isPassage);
    for (const h of b.holes) collision.addRing(h, isPassage);
  }
  for (const p of parsed.parts) if (!p.hasParent && p.info.collide) collision.addRing(p.outer, isPassage);
  const inWater = makeWaterTest(parsed.areas);
  collision.inWater = inWater;
  const onDeck = makeDeckTest(parsed.roads); // 橋の上は欄干まで走れる
  collision.onRoad = (x, z) => roadnet.onRoad(x, z, 0.4) || onDeck(x, z);

  const bGrid = new Grid(30);
  parsed.buildings.forEach((b, i) => bGrid.insertBounds(b.bounds.minX, b.bounds.minZ, b.bounds.maxX, b.bounds.maxZ, i));
  const insideBuilding = (x, z) => {
    let hit = false;
    bGrid.queryPoint(x, z, 0, (i) => {
      if (!hit && pointInRing(x, z, parsed.buildings[i].outer)) hit = true;
    });
    return hit;
  };

  const facade = findCapitoleFacade(parsed); // キャピトルの正面には専用のテクスチャ
  progress('道路と川を作成中…', 0.15);
  await pause();
  // 塀（地籍の敷地の境界と LiDAR から見つけたもの）。歩道は建物の壁・塀まで延ばすので、地面より先に用意する
  const walls = clearRoads(projectWalls(data.walls || [], proj), (x, z) => roadnet.onRoad(x, z, 0.3));
  const ground = buildGround(parsed, rect, groundMats, { buildings: parsed.buildings, walls, inOldTown: oldTownTest(proj) });
  group.add(ground.group);
  for (const [x, z] of ground.posts) collision.addCircle(x, z, POST_HIT); // 横断歩道の脇の車止め
  group.add(buildEnclosures(walls, buildingMats, collision));

  progress('木を植えています…', 0.25);
  await pause();
  let treePts;
  if (data.trees?.length) {
    // LiDAR で見つけた木（水の上・道路の真ん中は除く）
    treePts = projectTrees(data.trees, proj).filter((p) => !inWater(p.x, p.z) && !roadnet.onRoad(p.x, p.z, -1.5));
  } else {
    const m = 30;
    const inRect = ([x, z]) => x > rect.minX - m && x < rect.maxX + m && z > rect.minZ - m && z < rect.maxZ + m;
    const extra = fillParkTrees(parsed.areas, parsed.trees, (x, z) => !roadnet.onRoad(x, z, 1.5) && !inWater(x, z) && !insideBuilding(x, z));
    // IGN のデータには個々の木がないので、並木道（Allées・Boulevard など）の車道沿いに木を植える
    const avenue = data.provider === 'ign'
      ? streetTrees(parsed.roads.filter((r) => CAR_ROADS.has(r.type) || r.type === 'pedestrian'), (x, z) => inRect([x, z]) && !roadnet.onRoad(x, z, 0.2) && !inWater(x, z) && !insideBuilding(x, z))
      : [];
    treePts = parsed.trees.filter(inRect).concat(extra, avenue);
  }
  treePts = treePts.concat(ground.bankTrees || []); // 街の外れの川岸の土手の木
  const towers = findTowers(proj, parsed.buildings); // 八角形の鐘楼は専用のモデル
  markBrickSites(proj, parsed.buildings, parsed.areas);
  const buildings = await buildBuildings(parsed, buildingMats, (p) => progress(`建物を建てています… ${Math.round(p * 100)}%`, 0.3 + p * 0.6), facade, { towers, groundAt: ground.heightAt });
  group.add(buildings.group);
  const buildingStats = buildings.stats;

  // 街路・運河沿いはプラタナス。横に広い LiDAR の塊を分けた木は、道路・水・建物の上には置かない
  const trees = buildTrees(treePts, {
    isPlane: planeTreeTest(roadnet, inWater),
    canPlace: (x, z) => !roadnet.onRoad(x, z, 0.3) && !inWater(x, z) && !insideBuilding(x, z),
  });
  group.add(trees);
  // 木の幹は道路の上でなければ当たり判定を付ける（道路に張り出した枝の下は通れる）
  for (const [x, z] of trees.userData.trunks) {
    if (!roadnet.onRoad(x, z, 0.3)) collision.addCircle(x, z, 0.3);
  }

  const surfaceAt = makeSurfaceAt(parsed, roadnet);

  progress('名所を探しています…', 0.95);
  await pause();
  const landmarks = resolveLandmarks(parsed, proj, rect, roadnet);
  for (const lm of landmarks) lm.y = 0;

  return {
    proj, rect, parsed, roadnet, ground, collision, trees, landmarks, group, surfaceAt,
    // 一段高い歩道の上では自転車も歩道の高さに上がる
    heightAt: ground.heightAt, groundAt: ground.heightAt,
    stats: {
      buildings: buildingStats,
      roads: parsed.roads.length,
      trees: treePts.length,
      passages: opened,
      source: data.source,
      provider: data.provider,
      fallbackReason: data.fallbackReason,
      fetchedAt: data.fetchedAt,
      walls: walls.length,
    },
  };
}

// 路面の種類（転がり抵抗用）
export function makeSurfaceAt(parsed, roadnet) {
  const greenGrid = new Grid(40);
  const greens = parsed.areas.filter((a) => a.type === 'grass' || a.type === 'forest' || a.type === 'pitch');
  greens.forEach((a, i) => greenGrid.insertBounds(a.bounds.minX, a.bounds.minZ, a.bounds.maxX, a.bounds.maxZ, i));
  return (x, z) => {
    const s = roadnet.nearestSegment(x, z, roadnet.maxHalfWidth + 0.5);
    if (s && Math.sqrt(s.d2) < s.seg.road.width / 2 + 0.3) {
      const r = s.seg.road;
      if (/^(gravel|fine_gravel|compacted|dirt|ground|earth|grass|sand|unpaved)$/.test(r.surface)) return 'gravel';
      if (r.type === 'pedestrian' || r.type === 'living_street' || /^(paving_stones|sett|cobblestone)$/.test(r.surface)) return 'paving';
      return 'road';
    }
    let g = false;
    greenGrid.queryPoint(x, z, 0, (i) => {
      if (!g && pointInPolygon(x, z, greens[i])) g = true;
    });
    return g ? 'grass' : 'paving';
  };
}
