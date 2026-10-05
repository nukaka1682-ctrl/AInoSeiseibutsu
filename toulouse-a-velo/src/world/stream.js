// 広いエリア（トゥールーズ全体・半径 5 km）の街。自転車の周りの 500 m タイルだけを LiDAR と航空写真で詳しく作り、
// 遠くは粗い表面モデル（10 m 格子）に航空写真の全体図を貼った遠景で見せる。走るにつれてタイルを読み込み、遠ざかったら捨てる。
// - 道路・水域・公園・名所はエリア全体を最初に読み込むので、ナビ・地図・通りの名前はどこでも使える
// - 当たり判定と地面の高さは、読み込んだタイルのもの（まだのところは粗い地形）を合わせて使う
import * as THREE from 'three';
import { Grid, closestOnSegment, pointInPolygon } from '../geo.js';
import { parseOsm } from './parse.js';
import { MeshWriter, writeFlatPolygon } from './meshwriter.js';
import { HeightGrid } from '../data/lidar.js';
import { DTM_RES, loadTileBuildings, loadTileLidar, tileAt, tileBounds, tileLayout } from '../data/tiles.js';
import { OrthoManager, orthoUV } from './ortho.js';
import { clampUnderwater, levelWater, median, writeBridge, writeLidarBuilding } from './realcity.js';
import { detectTrees } from './lidartrees.js';
import { buildTrees } from './trees.js';
import { findCapitoleFacade } from './landmarkfacades.js';
import { areaFrame, makeSurfaceAt } from './assemble.js';
import { makeWaterTest } from './ground.js';
import { CollisionWorld } from '../game/collision.js';
import { RoadNetwork } from '../game/roadnet.js';
import { resolveLandmarks } from '../game/landmarks.js';

export const NEAR = 650; // これより近いタイルを詳しく作る（m、タイルの端までの距離）
export const FAR = 1000; // これより遠いタイルは捨てる
const FAR_GRID = 20; // 遠景の格子（m）
const FAR_BLOCK = 1000; // 遠景のメッシュ 1 つの大きさ（m）
const MAX_HIDDEN = 48; // 遠景を消す（詳しいタイルがある）範囲の最大数
const pause = () => new Promise((r) => setTimeout(r, 0));

export async function assembleStreamWorld({ base, coarse, bbox, presetId, buildingMats, groundMats, progress = () => {} }) {
  const { proj, rect } = areaFrame(bbox);
  const layout = tileLayout(rect);
  progress('道路・川・公園を解析中…', 0.05);
  await pause();
  const parsed = parseOsm(base.osm, proj, rect, []);
  progress('道路網を作成中…', 0.25);
  await pause();
  const roadnet = new RoadNetwork(parsed.roads);
  const inWater = makeWaterTest(parsed.areas);
  const onRoad = (x, z) => roadnet.onRoad(x, z, 0.4);

  // 高さの基準: エリア中心（ポン・ヌフ）付近の地面を y = 0 に
  const raw = new HeightGrid(coarse.dtm, rect);
  const baseY = median([[0, 0], [60, 0], [-60, 0], [0, 60], [0, -60]].map(([x, z]) => raw.sample(x, z)));
  const cDtm = new HeightGrid(coarse.dtm, rect, baseY);
  const cDsm = new HeightGrid(coarse.dsm, rect, baseY);
  const waterAreas = levelWater(parsed, cDtm);
  clampUnderwater(waterAreas, cDtm);

  const group = new THREE.Group();
  group.name = 'stream-city';

  // 水面（エリア全体）
  progress('川と運河…', 0.35);
  const water = new MeshWriter();
  for (const a of waterAreas) writeFlatPolygon(water, a.outer, a.holes, a.level + (a.patch ? 0.22 : 0.25), 25);
  const waterMaterial = groundMats.water.clone(); // 航空写真に写った橋や影を隠すため不透明
  if (!water.empty) {
    const m = new THREE.Mesh(water.toGeometry(), waterMaterial);
    m.renderOrder = 1;
    group.add(m);
  }

  // 遠景
  progress('遠くの街並み（粗い表面モデル）…', 0.45);
  await pause();
  const far = new FarField(rect, cDsm);
  group.add(far.group);
  // エリアの外: 端の高さで外側へ広げる（地面の切れ目を隠す）
  {
    const skirt = new MeshWriter();
    const y = median([[rect.minX, rect.minZ], [rect.maxX, rect.maxZ], [rect.minX, rect.maxZ], [rect.maxX, rect.minZ]].map(([x, z]) => cDtm.sample(x, z)));
    const big = 6000;
    const ring = [[rect.minX - big, rect.minZ - big], [rect.maxX + big, rect.minZ - big], [rect.maxX + big, rect.maxZ + big], [rect.minX - big, rect.maxZ + big]];
    const hole = [[rect.minX + 1, rect.minZ + 1], [rect.maxX - 1, rect.minZ + 1], [rect.maxX - 1, rect.maxZ - 1], [rect.minX + 1, rect.maxZ - 1]];
    writeFlatPolygon(skirt, ring, [hole], y - 1, 50, [0.6, 0.6, 0.53]);
    const m = new THREE.Mesh(skirt.toGeometry(), new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false }));
    m.name = 'outside';
    group.add(m);
  }

  // 航空写真（全体図は遠景と、読み込んだばかりのタイルに使う）
  const ortho = new OrthoManager(proj, rect, []);
  let note = '';
  if (typeof document !== 'undefined') {
    ortho.loadOverview(4096).then((tex) => far.setPhoto(tex)).catch((err) => {
      console.warn('航空写真の全体図を取得できませんでした', err);
    });
  }

  progress('名所を探しています…', 0.6);
  await pause();
  const landmarks = resolveLandmarks(parsed, proj, rect, roadnet);
  const surfaceAt = makeSurfaceAt(parsed, roadnet);
  const collision = new StreamCollision(rect, inWater, onRoad);
  const bridges = new BridgeIndex();

  const streamer = new TileStreamer({
    presetId, bbox, rect, proj, layout, baseY, parsed, roadnet, waterAreas, inWater, onRoad,
    materials: buildingMats, ortho, collision, bridges, far, group,
    bridgeRoads: parsed.roads.filter((r) => r.bridge && !r.tunnel && r.pts.length >= 2),
  });

  const heightAt = (x, z) => {
    const decks = bridges.decks(x, z);
    if (decks.length) return Math.max(...decks);
    const t = streamer.readyTileAt(x, z);
    return t ? t.dtm.sample(x, z) : cDtm.sample(x, z);
  };
  // 走行中: 地面と橋面のうち、今の高さに近いもの（橋の下の河岸から橋へ飛び乗らないように）
  const groundAt = (x, z, y) => {
    const t = streamer.readyTileAt(x, z);
    let best = t ? t.dtm.sample(x, z) : cDtm.sample(x, z);
    for (const d of bridges.decks(x, z)) if (Math.abs(d - y) < Math.abs(best - y) && d < y + 1.5) best = d;
    return best;
  };
  for (const lm of landmarks) lm.y = heightAt(lm.x, lm.z);

  return {
    proj, rect, parsed, roadnet, ground: null, collision, trees: null, landmarks, group, surfaceAt,
    real: { ortho }, heightAt, groundAt, realNote: note, stream: streamer,
    stats: {
      buildings: { total: 0 },
      roads: parsed.roads.length,
      trees: 0,
      passages: 0,
      source: base.source,
      provider: 'ign',
      fetchedAt: base.fetchedAt,
      lidar: true,
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
    this.totals = { buildings: 0, trees: 0, triangles: 0, failed: 0 };
    for (const r of this.bridgeRoads) r.mid = r.pts[r.pts.length >> 1];
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
      const osm = await loadTileBuildings({ presetId: this.presetId, areaBbox: this.bbox, layout: this.layout, i: t.i, j: t.j });
      const tp = parseOsm(osm, this.proj, this.rect, []);
      const buildings = tp.buildings;
      const B = t.bounds;
      const inside = (p) => p[0] >= B.minX && p[0] < B.maxX && p[1] >= B.minZ && p[1] < B.maxZ;
      const bridges = this.bridgeRoads.filter((r) => inside(r.mid));
      // LiDAR を取る範囲: タイルと、そこに属する建物・橋がはみ出す分
      const lb = { ...B };
      const grow = (minX, minZ, maxX, maxZ) => {
        lb.minX = Math.min(lb.minX, minX);
        lb.minZ = Math.min(lb.minZ, minZ);
        lb.maxX = Math.max(lb.maxX, maxX);
        lb.maxZ = Math.max(lb.maxZ, maxZ);
      };
      for (const b of buildings) grow(b.bounds.minX, b.bounds.minZ, b.bounds.maxX, b.bounds.maxZ);
      for (const r of bridges) for (const [x, z] of r.pts) grow(x - r.width, z - r.width, x + r.width, z + r.width);
      for (const k of ['minX', 'minZ']) lb[k] -= 8;
      for (const k of ['maxX', 'maxZ']) lb[k] += 8;
      let lidar = null;
      try {
        lidar = await loadTileLidar({ areaBbox: this.bbox, rect: this.rect, bounds: lb, key: `${t.key}:${Math.round(lb.minX)},${Math.round(lb.minZ)},${Math.round(lb.maxX)},${Math.round(lb.maxZ)}` });
      } catch (err) {
        console.warn(`タイル ${t.key} の LiDAR を取得できませんでした（粗い高さで作ります）`, err);
      }
      if (t.state !== 'loading') return;
      // 組み立ては順番に（並行すると 1 フレームが長くなる）
      const job = this.building.then(() => this.build(t, buildings, bridges, lidar));
      this.building = job.catch(() => {});
      await job;
    } catch (err) {
      console.warn(`タイル ${t.key} を作れませんでした`, err);
      t.state = 'failed';
      this.totals.failed++;
    }
  }

  async build(t, buildings, bridges, lidar) {
    const B = t.bounds;
    const dtm = lidar ? new HeightGrid(lidar.dtm, lidar.dtm.rect, this.baseY) : null;
    const dsm = lidar ? new HeightGrid(lidar.dsm, lidar.dsm.rect, this.baseY) : null;
    const coarse = this.far.dsm; // LiDAR がないときの代わり（表面モデルしかないので地面にも使う）
    const groundGrid = dtm || coarse;
    const surfaceGrid = dsm || coarse;
    if (dtm) clampUnderwater(this.waterAreas.filter((a) => a.bounds.maxX > dtm.minX && a.bounds.minZ < dtm.minZ + dtm.rows * dtm.dz), dtm);

    // 区画（2 × 2）。地形の格子はエリア全体でそろえる（隣のタイルとすき間ができないように）
    const g = DTM_RES * 2;
    const nx = Math.max(1, Math.round((B.maxX - B.minX) / g)), nz = Math.max(1, Math.round((B.maxZ - B.minZ) / g));
    const gx = (B.maxX - B.minX) / nx, gz = (B.maxZ - B.minZ) / nz;
    const hx = nx >> 1, hz = nz >> 1;
    const chunks = [];
    for (const [i0, i1] of [[0, hx], [hx, nx]]) {
      for (const [j0, j1] of [[0, hz], [hz, nz]]) {
        if (i1 <= i0 || j1 <= j0) continue;
        const bounds = { minX: B.minX + i0 * gx, maxX: B.minX + i1 * gx, minZ: B.minZ + j0 * gz, maxZ: B.minZ + j1 * gz };
        chunks.push({ i0, i1, j0, j1, bounds, image: { ...bounds } });
      }
    }
    const chunkAt = (x, z) => chunks.find((c) => x < c.bounds.maxX && z < c.bounds.maxZ) || chunks[chunks.length - 1];
    const expand = (c, b, m = 2) => {
      c.image.minX = Math.min(c.image.minX, b.minX - m);
      c.image.maxX = Math.max(c.image.maxX, b.maxX + m);
      c.image.minZ = Math.min(c.image.minZ, b.minZ - m);
      c.image.maxZ = Math.max(c.image.maxZ, b.maxZ + m);
    };
    const home = new Map();
    for (const b of buildings) {
      const c = chunkAt(b.inside[0], b.inside[1]);
      home.set(b, c);
      expand(c, b.bounds);
    }
    for (const r of bridges) {
      const c = chunkAt(r.mid[0], r.mid[1]);
      r.chunk = c;
      let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
      for (const [x, z] of r.pts) {
        minX = Math.min(minX, x); maxX = Math.max(maxX, x); minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
      }
      expand(c, { minX, minZ, maxX, maxZ }, r.width + 4);
    }
    this.ortho.addChunks(chunks);
    const photoW = new Map(chunks.map((c) => [c, new MeshWriter()]));
    const walls = new Map(chunks.map((c) => [c, { upper: new MeshWriter(), ground: new MeshWriter(), plain: new MeshWriter(), capitole: new MeshWriter() }]));

    // 地形（建物の真下に隠れるマスは作らない）
    const bGrid = new Grid(30);
    buildings.forEach((b, k) => bGrid.insertBounds(b.bounds.minX, b.bounds.minZ, b.bounds.maxX, b.bounds.maxZ, k));
    const covered = (x, z) => {
      let hit = false;
      bGrid.queryPoint(x, z, 0, (k) => {
        if (!hit && pointInPolygon(x, z, buildings[k])) hit = true;
      });
      return hit;
    };
    const cover = new Uint8Array((nx + 1) * (nz + 1));
    for (let j = 0; j <= nz; j++) for (let i = 0; i <= nx; i++) cover[j * (nx + 1) + i] = covered(B.minX + i * gx, B.minZ + j * gz) ? 1 : 0;
    const P = (i, j) => {
      const x = i === nx ? B.maxX : B.minX + i * gx, z = j === nz ? B.maxZ : B.minZ + j * gz;
      return [x, groundGrid.sample(x, z), z];
    };
    const up = [0, 1, 0];
    for (const c of chunks) {
      const w = photoW.get(c);
      const uv = (p) => orthoUV(c.image, p[0], p[2]);
      for (let j = c.j0; j < c.j1; j++) {
        for (let i = c.i0; i < c.i1; i++) {
          const k = j * (nx + 1) + i, k2 = k + nx + 1;
          if (cover[k] && cover[k + 1] && cover[k2] && cover[k2 + 1]) continue;
          const a = P(i, j), b = P(i + 1, j), d = P(i, j + 1), e = P(i + 1, j + 1);
          w.tri(a, d, b, up, uv(a), uv(d), uv(b));
          w.tri(b, d, e, up, uv(b), uv(d), uv(e));
        }
      }
    }
    await pause();

    // 建物（キャピトルの正面には専用のテクスチャ）
    const facade = findCapitoleFacade({ areas: this.parsed.areas, buildings });
    const dsmAt = (x, z) => surfaceGrid.sample(x, z);
    for (let k = 0; k < buildings.length; k++) {
      const b = buildings[k];
      const c = home.get(b);
      writeLidarBuilding(b, photoW.get(c), walls.get(c), c.image, groundGrid, dsmAt, facade);
      if (k % 40 === 39) {
        await pause();
        if (t.state !== 'loading') return this.abandon(t, chunks);
      }
    }

    // 橋
    const bridgeBody = new MeshWriter();
    const profiles = bridges.map((r) => writeBridge(r, photoW.get(r.chunk), bridgeBody, groundGrid, surfaceGrid));
    await pause();

    // 木（樹冠の高さから。タイルの中のものだけ）
    let trees = null, treePts = [];
    if (dtm && dsm) {
      const inB = (x, z) => x >= B.minX && x < B.maxX && z >= B.minZ && z < B.maxZ;
      treePts = detectTrees({
        dsm, dtm, buildings,
        isExcluded: (x, z) => !inB(x, z) || this.inWater(x, z) || this.bridges.decksWith(profiles, x, z).length > 0,
      });
      trees = buildTrees(treePts);
    }

    // メッシュ
    const group = new THREE.Group();
    group.name = `tile-${t.key}`;
    let tris = 0;
    for (const c of chunks) {
      const w = photoW.get(c);
      if (!w.empty) {
        const m = new THREE.Mesh(w.toGeometry(), c.material);
        m.name = 'photo';
        m.matrixAutoUpdate = false;
        tris += w.pos.length / 9;
        group.add(m);
      }
      const ws = walls.get(c);
      for (const key of ['upper', 'ground', 'plain', 'capitole']) {
        if (ws[key].empty) continue;
        const m = new THREE.Mesh(ws[key].toGeometry(), this.materials[key]);
        m.castShadow = m.receiveShadow = true;
        m.matrixAutoUpdate = false;
        tris += ws[key].pos.length / 9;
        group.add(m);
      }
    }
    if (!bridgeBody.empty) {
      const m = new THREE.Mesh(bridgeBody.toGeometry(), this.materials.plain);
      m.name = 'bridges';
      m.castShadow = m.receiveShadow = true;
      tris += bridgeBody.pos.length / 9;
      group.add(m);
    }
    if (trees) group.add(trees);

    // 当たり判定（建物の壁。道路が横切る所は通路として開ける。道路の上でない木の幹）
    const cw = new CollisionWorld({ minX: B.minX - 80, maxX: B.maxX + 80, minZ: B.minZ - 80, maxZ: B.maxZ + 80 });
    const isPassage = (a, b) => this.roadnet.crossesRoad(a[0], a[1], b[0], b[1]);
    for (const b of buildings) {
      if (!b.info.collide) continue;
      cw.addRing(b.outer, isPassage);
      for (const h of b.holes) cw.addRing(h, isPassage);
    }
    for (const p of treePts) if (!this.roadnet.onRoad(p.x, p.z, 0.3)) cw.addCircle(p.x, p.z, 0.3);

    if (t.state !== 'loading') return this.abandon(t, chunks, group);
    Object.assign(t, { group, chunks, cw, profiles, dtm: groundGrid, buildings: buildings.length, trees: treePts.length, triangles: tris, state: 'ready' });
    this.group.add(group);
    this.collision.add(cw);
    this.bridges.add(t.key, profiles);
    this.far.setHidden([...this.tiles.values()].filter((x) => x.state === 'ready').map((x) => x.bounds));
    this.onTileReady?.(t, buildings);
    this.totals.buildings += buildings.length;
    this.totals.trees += treePts.length;
    this.totals.triangles += tris;
  }

  abandon(t, chunks, group = null) {
    this.ortho.removeChunks(chunks);
    if (group) disposeGroup(group);
  }

  unload(t) {
    t.state = 'gone';
    this.tiles.delete(t.key);
    this.group.remove(t.group);
    disposeGroup(t.group);
    this.ortho.removeChunks(t.chunks);
    this.collision.remove(t.cw);
    this.bridges.remove(t.key);
    this.far.setHidden([...this.tiles.values()].filter((x) => x.state === 'ready').map((x) => x.bounds));
    this.totals.buildings -= t.buildings;
    this.totals.trees -= t.trees;
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

// ---------------------------------------------------------------- 遠景
// 粗い表面モデル（10 m）を 20 m の格子にして、航空写真の全体図を貼る。詳しいタイルがある所はシェーダーで消す
class FarField {
  constructor(rect, dsm) {
    this.rect = rect;
    this.dsm = dsm;
    this.group = new THREE.Group();
    this.group.name = 'far-field';
    this.hidden = Array.from({ length: MAX_HIDDEN }, () => new THREE.Vector4(0, 0, 0, 0));
    this.uniforms = { uHide: { value: this.hidden }, uHideCount: { value: 0 } };
    this.material = new THREE.MeshBasicMaterial({ color: '#a29b8e', toneMapped: false });
    this.material.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this.uniforms);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec2 vFarXZ;')
        .replace('#include <project_vertex>', '#include <project_vertex>\nvFarXZ = (modelMatrix * vec4(transformed, 1.0)).xz;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>
          varying vec2 vFarXZ;
          uniform vec4 uHide[${MAX_HIDDEN}];
          uniform int uHideCount;`)
        .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>
          for (int i = 0; i < ${MAX_HIDDEN}; i++) {
            if (i >= uHideCount) break;
            vec4 h = uHide[i];
            if (vFarXZ.x > h.x && vFarXZ.x < h.z && vFarXZ.y > h.y && vFarXZ.y < h.w) discard;
          }`);
    };
    this.material.customProgramCacheKey = () => 'far-field';
    const W = rect.maxX - rect.minX, H = rect.maxZ - rect.minZ;
    for (let bz = rect.minZ; bz < rect.maxZ - 1; bz += FAR_BLOCK) {
      for (let bx = rect.minX; bx < rect.maxX - 1; bx += FAR_BLOCK) {
        const x1 = Math.min(rect.maxX, bx + FAR_BLOCK), z1 = Math.min(rect.maxZ, bz + FAR_BLOCK);
        const nx = Math.max(1, Math.round((x1 - bx) / FAR_GRID)), nz = Math.max(1, Math.round((z1 - bz) / FAR_GRID));
        const pos = new Float32Array((nx + 1) * (nz + 1) * 3), uv = new Float32Array((nx + 1) * (nz + 1) * 2);
        for (let j = 0, k = 0; j <= nz; j++) {
          for (let i = 0; i <= nx; i++, k++) {
            const x = bx + ((x1 - bx) * i) / nx, z = bz + ((z1 - bz) * j) / nz;
            pos.set([x, dsm.sample(x, z) - 0.4, z], k * 3);
            uv.set([(x - rect.minX) / W, 1 - (z - rect.minZ) / H], k * 2);
          }
        }
        const index = [];
        for (let j = 0; j < nz; j++) {
          for (let i = 0; i < nx; i++) {
            const a = j * (nx + 1) + i, b = a + 1, d = a + nx + 1, e = d + 1;
            index.push(a, d, b, b, d, e);
          }
        }
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
        geo.setIndex(index);
        geo.computeBoundingSphere();
        const m = new THREE.Mesh(geo, this.material);
        m.matrixAutoUpdate = false;
        this.group.add(m);
      }
    }
  }

  setPhoto(tex) {
    this.material.map = tex;
    this.material.color.set('#ffffff');
    this.material.needsUpdate = true;
  }

  setHidden(list) {
    const n = Math.min(MAX_HIDDEN, list.length);
    for (let i = 0; i < n; i++) this.hidden[i].set(list[i].minX, list[i].minZ, list[i].maxX, list[i].maxZ);
    this.uniforms.uHideCount.value = n;
  }
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

// ---------------------------------------------------------------- 橋面の高さ（読み込んだタイルの橋）
class BridgeIndex {
  constructor() {
    this.byTile = new Map();
    this.rebuild();
  }

  add(key, profiles) {
    this.byTile.set(key, profiles);
    this.rebuild();
  }

  remove(key) {
    this.byTile.delete(key);
    this.rebuild();
  }

  rebuild() {
    this.list = [...this.byTile.values()].flat();
    this.grid = new Grid(20);
    this.list.forEach((p, i) => {
      for (let k = 0; k + 1 < p.pts.length; k++) this.grid.insertSegment(p.pts[k][0], p.pts[k][1], p.pts[k + 1][0], p.pts[k + 1][1], [i, k]);
    });
  }

  decks(x, z) {
    const out = [];
    this.grid.queryPoint(x, z, 15, ([i, k]) => {
      const h = deckAt(this.list[i], k, x, z);
      if (h != null) out.push(h);
    });
    return out;
  }

  // 組み立て中のタイルの橋（まだ登録していないもの）について調べる
  decksWith(profiles, x, z) {
    const out = [];
    for (const p of profiles) {
      for (let k = 0; k + 1 < p.pts.length; k++) {
        const h = deckAt(p, k, x, z);
        if (h != null) out.push(h);
      }
    }
    return out;
  }
}

function deckAt(p, k, x, z) {
  const a = p.pts[k], b = p.pts[k + 1];
  const cl = closestOnSegment(x, z, a[0], a[1], b[0], b[1]);
  return cl.d2 < (p.half + 0.3) ** 2 ? p.ys[k] + (p.ys[k + 1] - p.ys[k]) * cl.t : null;
}
