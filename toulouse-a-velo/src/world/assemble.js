// 地図データから「遊べる街」を組み立てる: 解析 → 道路網 → 地面・水・橋 → 当たり判定 → 木 → 建物 → 名所。
// 描画まわり（ミニマップ・目的地の光の柱など）以外はここにまとめ、ブラウザと Node のテストで共通に使う。
//
// data.lidar（IGN LiDAR HD の表面・地形モデル）があれば「本物モード」: 地形・屋根・木・橋の高さを実測で作り、
// 地面と屋根に航空写真を貼る（realcity.js）。なければ従来どおり地図データから生成する（ground.js・buildings.js）。
import * as THREE from 'three';
import { Grid, LocalProjection, pointInPolygon, pointInRing } from '../geo.js';
import { CAR_ROADS, parseOsm } from './parse.js';
import { buildBuildings } from './buildings.js';
import { buildGround, makeWaterTest } from './ground.js';
import { buildTrees, fillParkTrees, streetTrees } from './trees.js';
import { buildRealCity } from './realcity.js';
import { detectTrees } from './lidartrees.js';
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
  collision.onRoad = (x, z) => roadnet.onRoad(x, z, 0.4);

  const bGrid = new Grid(30);
  parsed.buildings.forEach((b, i) => bGrid.insertBounds(b.bounds.minX, b.bounds.minZ, b.bounds.maxX, b.bounds.maxZ, i));
  const insideBuilding = (x, z) => {
    let hit = false;
    bGrid.queryPoint(x, z, 0, (i) => {
      if (!hit && pointInRing(x, z, parsed.buildings[i].outer)) hit = true;
    });
    return hit;
  };

  let real = null, ground = null, buildingStats;
  let treePts;
  if (data.lidar) {
    // ---- 本物モード ----
    const waterMaterial = groundMats.water.clone();
    // 航空写真の川面には橋そのもの（斜めに写った橋面）や影が写っているので、水面は不透明にして隠す
    real = await buildRealCity({
      parsed, rect, proj, lidar: data.lidar, materials: buildingMats, waterMaterial,
      progress: (t, p) => progress(t, 0.1 + p * 0.8),
    });
    group.add(real.group);
    buildingStats = { ...statsOf(parsed.buildings), lidar: true };
    progress('LiDAR から木を探しています…', 0.9);
    await pause();
    treePts = detectTrees({
      dsm: real.dsm, dtm: real.dtm, buildings: parsed.buildings,
      isExcluded: (x, z) => inWater(x, z) || real.heightAt(x, z) > real.dtm.sample(x, z) + 1, // 水の上・橋の上
    });
  } else {
    // ---- 地図から生成 ----
    progress('道路と川を作成中…', 0.15);
    await pause();
    ground = buildGround(parsed, rect, groundMats);
    group.add(ground.group);
    progress('街路樹を植えています…', 0.25);
    await pause();
    const m = 30;
    const inRect = ([x, z]) => x > rect.minX - m && x < rect.maxX + m && z > rect.minZ - m && z < rect.maxZ + m;
    const extra = fillParkTrees(parsed.areas, parsed.trees, (x, z) => !roadnet.onRoad(x, z, 1.5) && !inWater(x, z) && !insideBuilding(x, z));
    // IGN のデータには個々の木がないので、並木道（Allées・Boulevard など）の車道沿いに木を植える
    const avenue = data.provider === 'ign'
      ? streetTrees(parsed.roads.filter((r) => CAR_ROADS.has(r.type) || r.type === 'pedestrian'), (x, z) => inRect([x, z]) && !roadnet.onRoad(x, z, 0.2) && !inWater(x, z) && !insideBuilding(x, z))
      : [];
    treePts = parsed.trees.filter(inRect).concat(extra, avenue);
    const buildings = await buildBuildings(parsed, buildingMats, (p) => progress(`建物を建てています… ${Math.round(p * 100)}%`, 0.3 + p * 0.6));
    group.add(buildings.group);
    buildingStats = buildings.stats;
  }

  const trees = buildTrees(treePts);
  group.add(trees);
  // 木の幹は道路の上でなければ当たり判定を付ける（道路に張り出した枝の下は通れる）
  for (const t of trees.userData.points || []) {
    const x = t.x ?? t[0], z = t.z ?? t[1];
    if (!roadnet.onRoad(x, z, 0.3)) collision.addCircle(x, z, 0.3);
  }

  // 路面の種類（転がり抵抗用）
  const greenGrid = new Grid(40);
  const greens = parsed.areas.filter((a) => a.type === 'grass' || a.type === 'forest' || a.type === 'pitch');
  greens.forEach((a, i) => greenGrid.insertBounds(a.bounds.minX, a.bounds.minZ, a.bounds.maxX, a.bounds.maxZ, i));
  const surfaceAt = (x, z) => {
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

  progress('名所を探しています…', 0.95);
  await pause();
  const landmarks = resolveLandmarks(parsed, proj, rect, roadnet);
  const heightAt = real ? real.heightAt : () => 0;
  for (const lm of landmarks) lm.y = heightAt(lm.x, lm.z);

  return {
    proj, rect, parsed, roadnet, ground, collision, trees, landmarks, group, surfaceAt,
    real, heightAt, groundAt: real ? real.groundAt : null, realNote: real?.note || '',
    stats: {
      buildings: buildingStats,
      roads: parsed.roads.length,
      trees: treePts.length,
      passages: opened,
      source: data.source,
      provider: data.provider,
      fallbackReason: data.fallbackReason,
      fetchedAt: data.fetchedAt,
      lidar: !!real,
      triangles: real?.stats.triangles,
    },
  };
}

function statsOf(buildings) {
  const st = { total: buildings.length };
  for (const b of buildings) st[b.info.heightSource] = (st[b.info.heightSource] || 0) + 1;
  return st;
}
