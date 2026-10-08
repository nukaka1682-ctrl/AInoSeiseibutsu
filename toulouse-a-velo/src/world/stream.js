// 広いエリア（トゥールーズ全体・半径 5 km）の街。自転車の周りの 500 m タイルだけ建物・道路・木・塀を作り、
// 走るにつれてタイルを読み込み、遠ざかったら捨てる（遠くは霧に溶ける）。
// - 道路・水域・公園・名所はエリア全体を最初に読み込むので、ナビ・地図・通りの名前はどこでも使える
// - 地面の板と川はエリア全体で 1 つ。緑地・道路・線路・橋はタイルごとに切り分けて作る
// - 当たり判定は、読み込んだタイルのものを合わせて使う
import * as THREE from 'three';
import { Grid, pointInRing } from '../geo.js';
import { CAR_ROADS, parseOsm } from './parse.js';
import { loadTileData, tileAt, tileBounds, tileLayout } from '../data/tiles.js';
import { buildBuildings } from './buildings.js';
import { buildTrees, fillParkTrees, planeTreeTest, streetTrees } from './trees.js';
import { buildEnclosures, clearRoads, projectTrees, projectWalls } from './enclosures.js';
import { findCapitoleFacade, markBrickSites } from './landmarkfacades.js';
import { findTowers } from './towers.js';
import { areaFrame, makeSurfaceAt } from './assemble.js';
import { buildGroundBase, buildGroundDetail, makeWaterTest } from './ground.js';
import { CollisionWorld } from '../game/collision.js';
import { RoadNetwork } from '../game/roadnet.js';
import { resolveLandmarks } from '../game/landmarks.js';

export const NEAR = 650; // これより近いタイルを作る（m、タイルの端までの距離）
export const FAR = 1000; // これより遠いタイルは捨てる
const pause = () => new Promise((r) => setTimeout(r, 0));

export async function assembleStreamWorld({ base, bbox, presetId, buildingMats, groundMats, progress = () => {} }) {
  const { proj, rect } = areaFrame(bbox);
  const layout = tileLayout(rect);
  progress('道路・川・公園を解析中…', 0.05);
  await pause();
  const parsed = parseOsm(base.osm, proj, rect, []);
  progress('道路網を作成中…', 0.3);
  await pause();
  const roadnet = new RoadNetwork(parsed.roads);
  const onRoad = (x, z) => roadnet.onRoad(x, z, 0.4);

  progress('地面と川…', 0.5);
  await pause();
  const group = new THREE.Group();
  group.name = 'stream-city';
  const ground = buildGroundBase(parsed, rect, groundMats);
  group.add(ground.group);
  const inWater = makeWaterTest(parsed.areas);

  progress('名所を探しています…', 0.7);
  await pause();
  const landmarks = resolveLandmarks(parsed, proj, rect, roadnet);
  const surfaceAt = makeSurfaceAt(parsed, roadnet);
  const collision = new StreamCollision(rect, inWater, onRoad);
  // 並木道（IGN のデータには個々の木がないので、LiDAR の木がないタイルで使う）
  const avenues = parsed.roads.filter((r) => CAR_ROADS.has(r.type) || r.type === 'pedestrian');

  const streamer = new TileStreamer({
    presetId, bbox, rect, proj, layout, parsed, roadnet, inWater, onRoad, avenues,
    materials: buildingMats, groundMats, waterDepthAt: ground.waterDepthAt, collision, group,
  });
  for (const lm of landmarks) lm.y = 0;

  return {
    proj, rect, parsed, roadnet, ground, collision, trees: null, landmarks, group, surfaceAt,
    heightAt: () => 0, groundAt: null, stream: streamer,
    stats: {
      buildings: { total: 0 },
      roads: parsed.roads.length,
      trees: 0,
      passages: 0,
      source: base.source,
      provider: 'ign',
      fetchedAt: base.fetchedAt,
      stream: true,
      tiles: layout.cols * layout.rows,
    },
  };
}

// ---------------------------------------------------------------- タイルの読み込み・組み立て・破棄
class TileStreamer {
  constructor(ctx) {
    Object.assign(this, ctx);
    this.tiles = new Map();
    this.loading = 0;
    this.focus = [0, 0];
    this.building = Promise.resolve(); // 組み立ては 1 枚ずつ（通信は並行）
    this.totals = { buildings: 0, trees: 0, walls: 0, triangles: 0, failed: 0, built: 0, buildMs: 0 };
  }

  key(i, j) {
    return `${i}_${j}`;
  }

  distTo(b, x, z) {
    const dx = Math.max(b.minX - x, 0, x - b.maxX), dz = Math.max(b.minZ - z, 0, z - b.maxZ);
    return Math.hypot(dx, dz);
  }

  // 自転車（カメラ）の位置に合わせて、必要なタイルを読み込み、遠いタイルを捨てる
  update(x, z) {
    this.focus = [x, z];
    const L = this.layout;
    const reach = Math.ceil(NEAR / L.size) + 1;
    const c = tileAt(L, Math.min(Math.max(x, L.rect.minX), L.rect.maxX - 1), Math.min(Math.max(z, L.rect.minZ), L.rect.maxZ - 1));
    if (c) {
      for (let j = c[1] - reach; j <= c[1] + reach; j++) {
        for (let i = c[0] - reach; i <= c[0] + reach; i++) {
          if (i < 0 || j < 0 || i >= L.cols || j >= L.rows) continue;
          const key = this.key(i, j);
          if (this.tiles.has(key)) continue;
          const bounds = tileBounds(L, i, j);
          if (this.distTo(bounds, x, z) < NEAR) this.tiles.set(key, { i, j, key, bounds, state: 'queued' });
        }
      }
    }
    for (const t of this.tiles.values()) {
      const d = this.distTo(t.bounds, x, z);
      if (d > FAR && t.state === 'ready') this.unload(t);
      else if (d > NEAR && t.state === 'queued') this.tiles.delete(t.key);
    }
    this.pump();
  }

  pump() {
    while (this.loading < 2) {
      let next = null, best = Infinity;
      for (const t of this.tiles.values()) {
        if (t.state !== 'queued') continue;
        const d = this.distTo(t.bounds, this.focus[0], this.focus[1]);
        if (d < best) [next, best] = [t, d];
      }
      if (!next) return;
      next.state = 'loading';
      this.loading++;
      this.load(next).finally(() => {
        this.loading--;
        this.pump();
      });
    }
  }

  readyTileAt(x, z) {
    const c = tileAt(this.layout, x, z);
    const t = c && this.tiles.get(this.key(c[0], c[1]));
    return t?.state === 'ready' ? t : null;
  }

  // (x, z) のタイルが組み上がっているか（まだなら自転車を止めて待つ）
  readyAt(x, z) {
    return !tileAt(this.layout, x, z) || !!this.readyTileAt(x, z) || this.tiles.get(this.key(...tileAt(this.layout, x, z)))?.state === 'failed';
  }

  // (x, z) から radius m 以内のタイルがすべて組み上がるまで待つ（スタート地点・ワープ先）
  async ensure(x, z, radius, onProgress) {
    this.update(x, z);
    const want = [...this.tiles.values()].filter((t) => this.distTo(t.bounds, x, z) < radius);
    for (;;) {
      const done = want.filter((t) => t.state === 'ready' || t.state === 'failed').length;
      onProgress?.(done, want.length);
      if (done >= want.length) return;
      await new Promise((r) => setTimeout(r, 150));
    }
  }

  async load(t) {
    try {
      const data = await loadTileData({ presetId: this.presetId, areaBbox: this.bbox, layout: this.layout, i: t.i, j: t.j });
      if (t.state !== 'loading') return;
      // 組み立ては順番に（並行すると 1 フレームが長くなる）
      const job = this.building.then(() => this.build(t, data));
      this.building = job.catch(() => {});
      await job;
    } catch (err) {
      console.warn(`タイル ${t.key} を作れませんでした`, err);
      t.state = 'failed';
      this.totals.failed++;
    }
  }

  async build(t, data) {
    const t0 = performance.now();
    const B = t.bounds;
    const tp = parseOsm(data.osm, this.proj, this.rect, []);
    const buildings = tp.buildings;
    const context = parseOsm(data.ctx, this.proj, this.rect, []).buildings;
    const group = new THREE.Group();
    group.name = `tile-${t.key}`;

    // 地面（緑地・道路・線路・橋）
    const ground = buildGroundDetail(this.parsed, B, this.groundMats, this.waterDepthAt);
    group.add(ground.group);
    await pause();
    if (t.state !== 'loading') return disposeGroup(group);

    // 建物（キャピトルの正面・鐘楼は専用のモデル。隣のタイルの建物と接する壁は窓なし）
    const facade = findCapitoleFacade({ areas: this.parsed.areas, buildings });
    const towers = findTowers(this.proj, buildings);
    markBrickSites(this.proj, buildings, this.parsed.areas);
    const tb = performance.now();
    const built = await buildBuildings(tp, this.materials, null, facade, { context, towers });
    const buildingMs = performance.now() - tb;
    group.add(built.group);
    if (t.state !== 'loading') return disposeGroup(group);

    // 塀
    const cw = new CollisionWorld({ minX: B.minX - 80, maxX: B.maxX + 80, minZ: B.minZ - 80, maxZ: B.maxZ + 80 });
    const walls = clearRoads(projectWalls(data.walls, this.proj), (x, z) => this.roadnet.onRoad(x, z, 0.3));
    group.add(buildEnclosures(walls, this.materials, cw));

    // 木: LiDAR で見つけたもの（水の上・道路の真ん中・橋の上は除く）。なければ公園と並木道に植える
    const bGrid = new Grid(30);
    buildings.forEach((b, k) => bGrid.insertBounds(b.bounds.minX, b.bounds.minZ, b.bounds.maxX, b.bounds.maxZ, k));
    const insideBuilding = (x, z) => {
      let hit = false;
      bGrid.queryPoint(x, z, 0, (k) => {
        if (!hit && pointInRing(x, z, buildings[k].outer)) hit = true;
      });
      return hit;
    };
    const inB = (x, z) => x >= B.minX && x < B.maxX && z >= B.minZ && z < B.maxZ;
    let treePts;
    if (data.trees.length) {
      treePts = projectTrees(data.trees, this.proj).filter((p) => !this.inWater(p.x, p.z) && !this.roadnet.onRoad(p.x, p.z, -1.5));
    } else {
      const free = (x, z) => inB(x, z) && !this.roadnet.onRoad(x, z, 1.5) && !this.inWater(x, z) && !insideBuilding(x, z);
      const parks = this.parsed.areas.filter((a) => a.bounds.maxX > B.minX && a.bounds.minX < B.maxX && a.bounds.maxZ > B.minZ && a.bounds.minZ < B.maxZ);
      const roads = this.avenues.filter((r) => r.pts.some(([x, z]) => x > B.minX - 50 && x < B.maxX + 50 && z > B.minZ - 50 && z < B.maxZ + 50));
      treePts = fillParkTrees(parks, [], free).concat(streetTrees(roads, (x, z) => inB(x, z) && !this.roadnet.onRoad(x, z, 0.2) && !this.inWater(x, z) && !insideBuilding(x, z)));
    }
    // 街路・運河沿いはプラタナス。横に広い LiDAR の塊を分けた木は、道路・水・建物の上には置かない
    const trees = buildTrees(treePts, {
      isPlane: planeTreeTest(this.roadnet, this.inWater),
      canPlace: (x, z) => !this.roadnet.onRoad(x, z, 0.3) && !this.inWater(x, z) && !insideBuilding(x, z),
    });
    group.add(trees);

    // 当たり判定（建物の壁。道路が横切る所は通路として開ける。道路の上でない木の幹）
    const isPassage = (a, b) => this.roadnet.crossesRoad(a[0], a[1], b[0], b[1]);
    for (const b of buildings) {
      if (!b.info.collide) continue;
      cw.addRing(b.outer, isPassage);
      for (const h of b.holes) cw.addRing(h, isPassage);
    }
    for (const [x, z] of trees.userData.trunks) {
      if (!this.roadnet.onRoad(x, z, 0.3)) cw.addCircle(x, z, 0.3);
    }

    let tris = 0;
    group.traverse((o) => {
      if (o.isMesh && !o.isInstancedMesh && o.geometry.index == null) tris += o.geometry.attributes.position.count / 3;
    });
    if (t.state !== 'loading') return disposeGroup(group);
    // 組み立てにかかった時間（途中でフレームを譲った時間も含む）と三角形の数を記録する
    const ms = performance.now() - t0;
    const roofs = built.stats.roofs;
    console.info(`タイル ${t.key}: 建物 ${buildings.length} 棟（傾斜屋根 ${roofs.pitched}・陸屋根 ${roofs.flat}・作れず陸屋根 ${roofs.fallback}）・三角形 ${tris}・組み立て ${ms.toFixed(0)} ms（建物の計算 ${built.stats.ms.toFixed(0)} ms、待ちを含め ${buildingMs.toFixed(0)} ms）`);
    Object.assign(t, { group, cw, buildings: buildings.length, trees: treePts.length, walls: walls.length, triangles: tris, buildMs: ms, state: 'ready' });
    this.group.add(group);
    this.collision.add(cw);
    this.onTileReady?.(t, buildings);
    this.totals.buildings += buildings.length;
    this.totals.trees += treePts.length;
    this.totals.walls += walls.length;
    this.totals.triangles += tris;
    this.totals.built++;
    this.totals.buildMs += ms;
  }

  unload(t) {
    t.state = 'gone';
    this.tiles.delete(t.key);
    this.group.remove(t.group);
    disposeGroup(t.group);
    this.collision.remove(t.cw);
    this.totals.buildings -= t.buildings;
    this.totals.trees -= t.trees;
    this.totals.walls -= t.walls;
    this.totals.triangles -= t.triangles;
  }

  get readyCount() {
    let n = 0;
    for (const t of this.tiles.values()) if (t.state === 'ready') n++;
    return n;
  }
}

// タイルのメッシュを捨てる（共有のマテリアルは残す。木のマテリアルはタイルごとなので捨てる）
function disposeGroup(group) {
  group.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    if (o.isInstancedMesh) {
      o.dispose();
      o.material.dispose();
    }
  });
}

// ---------------------------------------------------------------- 当たり判定（読み込んだタイルを合わせる）
class StreamCollision {
  constructor(rect, inWater, onRoad) {
    this.rect = rect;
    this.inWater = inWater;
    this.onRoad = onRoad;
    this.parts = new Set();
  }

  add(cw) {
    this.parts.add(cw);
  }

  remove(cw) {
    this.parts.delete(cw);
  }

  blockedByWater(x, z) {
    return this.inWater(x, z) && !this.onRoad(x, z);
  }

  outOfBounds(x, z, margin = 15) {
    const r = this.rect;
    return x < r.minX + margin || x > r.maxX - margin || z < r.minZ + margin || z > r.maxZ - margin;
  }

  resolve(x, z, r) {
    let hit = false, nx = 0, nz = 0;
    for (const p of this.parts) {
      const b = p.rect;
      if (x < b.minX || x > b.maxX || z < b.minZ || z > b.maxZ) continue;
      const out = p.resolve(x, z, r);
      if (out.hit) {
        hit = true;
        nx += out.nx;
        nz += out.nz;
      }
      x = out.x;
      z = out.z;
    }
    const l = Math.hypot(nx, nz) || 1;
    return { x, z, hit, nx: nx / l, nz: nz / l };
  }

  raycast(ax, az, bx, bz) {
    let best = 1;
    for (const p of this.parts) {
      const b = p.rect;
      if (Math.max(ax, bx) < b.minX || Math.min(ax, bx) > b.maxX || Math.max(az, bz) < b.minZ || Math.min(az, bz) > b.maxZ) continue;
      best = Math.min(best, p.raycast(ax, az, bx, bz));
    }
    return best;
  }
}
