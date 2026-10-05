// 「本物そっくり」の街: LiDAR HD の地形・表面モデルと IGN の航空写真から組み立てる。
// - 地形: 地面の高さ（MNT）の格子メッシュに航空写真を貼る（道路の白線・石畳・広場の模様も写真のまま）
// - 建物: 外形から壁を立て、屋根は表面の高さ（MNS）から作った実物どおりの形に航空写真を貼る
// - 橋: 表面の高さから橋面の高さを取り、橋脚を川面まで下ろす
// - 水面: 地形の川底（実際には水面の高さ）の上に、半透明の水を張る
// エリアを区画に分け、区画ごとに 1 枚の航空写真を使う（ortho.js が距離に応じて解像度を変える）。
import * as THREE from 'three';
import { MeshWriter, writeFlatPolygon } from './meshwriter.js';
import { BAY, facadeStyle, facadeTint, wallColor } from './buildings.js';
import { CHURCH_TILE } from './facades.js';
import { CAR_ROADS } from './parse.js';
import { offsets } from './ground.js';
import { roofFromDsm } from './lidarroof.js';
import { forEachCellIn } from './lidartrees.js';
import { facadeSpan } from './landmarkfacades.js';
import { findTowers, hiddenByTower, writeTower } from './towers.js';
import { HeightGrid } from '../data/lidar.js';
import { OrthoManager, orthoUV } from './ortho.js';
import { Grid, closestOnSegment, hash01, pointInPolygon, signedArea } from '../geo.js';

const CHUNK_TARGET = 250; // 区画の大きさ（m）
const pause = () => new Promise((r) => setTimeout(r, 0));

export function median(arr) {
  const a = arr.filter(Number.isFinite).sort((x, y) => x - y);
  return a.length ? a[a.length >> 1] : NaN;
}

// 川・運河ごとに、内側の地形の高さの中央値を水面の高さ（a.level）にする。橋の下を埋めたパッチは重なる川の高さにそろえる
export function levelWater(parsed, dtm) {
  const waters = parsed.areas.filter((a) => a.type === 'water' && !a.patch);
  for (const a of waters) {
    const samples = [];
    for (let i = 0; i < 40; i++) {
      const x = a.bounds.minX + hash01(a.id, i) * (a.bounds.maxX - a.bounds.minX);
      const z = a.bounds.minZ + hash01(a.id, i + 100) * (a.bounds.maxZ - a.bounds.minZ);
      if (pointInPolygon(x, z, a)) samples.push(dtm.sample(x, z));
    }
    const level = median(samples);
    if (Number.isFinite(level)) a.level = level;
  }
  for (const a of parsed.areas) {
    if (!a.patch) continue;
    const levels = waters.filter((w) => Number.isFinite(w.level) && w.bounds.minX < a.bounds.maxX && w.bounds.maxX > a.bounds.minX && w.bounds.minZ < a.bounds.maxZ && w.bounds.maxZ > a.bounds.minZ).map((w) => w.level);
    if (levels.length) a.level = Math.min(...levels);
  }
  return parsed.areas.filter((a) => a.type === 'water' && Number.isFinite(a.level));
}

// 水の中の地形は水面より下に下げる（橋の下の地形モデルは岸から補間されていて水面より上に出ることがあり、
// そこに航空写真の橋が写って見えてしまうため）
export function clampUnderwater(waterAreas, dtm) {
  for (const a of waterAreas) {
    const top = a.level + dtm.base - 0.6;
    forEachCellIn(a, dtm, (i) => {
      if (dtm.data[i] > top) dtm.data[i] = top;
    });
  }
}

export async function buildRealCity({ parsed, rect, proj, lidar, materials, waterMaterial, facade = null, progress = () => {} }) {
  // 高さの基準: エリア中心の地面を y = 0 に
  const dtmRaw = new HeightGrid(lidar.dtm, rect);
  const base = median([[0, 0], [30, 0], [-30, 0], [0, 30], [0, -30]].map(([x, z]) => dtmRaw.sample(x, z)));
  const dtm = new HeightGrid(lidar.dtm, rect, base);
  const dsm = new HeightGrid(lidar.dsm, rect, base);
  const group = new THREE.Group();
  group.name = 'real-city';

  // ---- 区画（地形の格子にそろえる） ----
  const g = dtm.dx * 2; // 地形メッシュの格子間隔（約 4 m）
  const cellsX = Math.round((rect.maxX - rect.minX) / g), cellsZ = Math.round((rect.maxZ - rect.minZ) / g);
  const per = Math.max(8, Math.round(CHUNK_TARGET / g));
  const chunks = [];
  for (let cz = 0; cz < cellsZ; cz += per) {
    for (let cx = 0; cx < cellsX; cx += per) {
      const i1 = Math.min(cellsX, cx + per), j1 = Math.min(cellsZ, cz + per);
      const bounds = { minX: rect.minX + cx * g, maxX: rect.minX + i1 * g, minZ: rect.minZ + cz * g, maxZ: rect.minZ + j1 * g };
      chunks.push({ i0: cx, i1, j0: cz, j1, bounds, image: { ...bounds }, items: [] });
    }
  }
  const nx = Math.ceil(cellsX / per);
  const chunkAt = (x, z) => {
    const i = Math.min(nx - 1, Math.max(0, Math.floor((x - rect.minX) / g / per)));
    const j = Math.min(Math.ceil(cellsZ / per) - 1, Math.max(0, Math.floor((z - rect.minZ) / g / per)));
    return chunks[j * nx + i];
  };
  const expand = (c, b, m = 2) => {
    c.image.minX = Math.min(c.image.minX, b.minX - m);
    c.image.maxX = Math.max(c.image.maxX, b.maxX + m);
    c.image.minZ = Math.min(c.image.minZ, b.minZ - m);
    c.image.maxZ = Math.max(c.image.maxZ, b.maxZ + m);
  };

  // 建物と橋を区画に割り当て、写真の範囲を広げる
  const buildings = parsed.buildings;
  for (const b of buildings) {
    const c = chunkAt(b.inside[0], b.inside[1]);
    c.items.push(b);
    expand(c, b.bounds);
  }
  const bridges = parsed.roads.filter((r) => r.bridge && !r.tunnel && r.pts.length >= 2);
  for (const r of bridges) {
    const m = r.pts[r.pts.length >> 1];
    const c = chunkAt(m[0], m[1]);
    r.chunk = c;
    let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
    for (const [x, z] of r.pts) {
      minX = Math.min(minX, x); maxX = Math.max(maxX, x); minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
    }
    expand(c, { minX, minZ, maxX, maxZ }, r.width + 4);
  }

  const ortho = new OrthoManager(proj, rect, chunks);
  const photoW = new Map(chunks.map((c) => [c, new MeshWriter()]));
  const wallChunks = new Map(); // 区画ごとの壁（視錐台カリングのため）
  const wallsOf = (c) => {
    let w = wallChunks.get(c);
    if (!w) wallChunks.set(c, (w = { upper: new MeshWriter(), ground: new MeshWriter(), plain: new MeshWriter(), capitole: new MeshWriter(), tower: new MeshWriter(), church: new MeshWriter() }));
    return w;
  };

  // ---- 水面の高さ ----
  const waterAreas = levelWater(parsed, dtm);
  clampUnderwater(waterAreas, dtm);

  // ---- 地形 ----
  progress('地形を作成中…', 0.05);
  // 建物の真下に隠れるマスは作らない（4 隅がすべて建物の中）
  const bGrid = new Grid(30);
  buildings.forEach((b, i) => bGrid.insertBounds(b.bounds.minX, b.bounds.minZ, b.bounds.maxX, b.bounds.maxZ, i));
  const insideIdx = (x, z) => {
    let hit = -1;
    bGrid.queryPoint(x, z, 0, (i) => {
      if (hit < 0 && pointInPolygon(x, z, buildings[i])) hit = i;
    });
    return hit;
  };
  const cover = new Int32Array((cellsX + 1) * (cellsZ + 1));
  for (let j = 0; j <= cellsZ; j++) for (let i = 0; i <= cellsX; i++) cover[j * (cellsX + 1) + i] = insideIdx(rect.minX + i * g, rect.minZ + j * g);
  const hidden = (i, j) => {
    const k = j * (cellsX + 1) + i, k2 = k + cellsX + 1;
    return cover[k] >= 0 && cover[k + 1] >= 0 && cover[k2] >= 0 && cover[k2 + 1] >= 0;
  };
  for (const c of chunks) {
    const w = photoW.get(c);
    const up = [0, 1, 0];
    const P = (i, j) => {
      const x = rect.minX + i * g, z = rect.minZ + j * g;
      return [x, dtm.sample(x, z), z];
    };
    for (let j = c.j0; j < c.j1; j++) {
      for (let i = c.i0; i < c.i1; i++) {
        if (hidden(i, j)) continue;
        const a = P(i, j), b = P(i + 1, j), d = P(i, j + 1), e = P(i + 1, j + 1);
        const uv = (p) => orthoUV(c.image, p[0], p[2]);
        w.tri(a, d, b, up, uv(a), uv(d), uv(b));
        w.tri(b, d, e, up, uv(b), uv(d), uv(e));
      }
    }
  }
  // エリアの外: 端の高さで外側へ広げる（地形の切れ目を隠す）
  {
    const skirt = new MeshWriter();
    const y = median([dtm.sample(rect.minX, rect.minZ), dtm.sample(rect.maxX, rect.maxZ), dtm.sample(rect.minX, rect.maxZ), dtm.sample(rect.maxX, rect.minZ)]);
    const big = 4000;
    const ring = [[rect.minX - big, rect.minZ - big], [rect.maxX + big, rect.minZ - big], [rect.maxX + big, rect.maxZ + big], [rect.minX - big, rect.maxZ + big]];
    const hole = [[rect.minX + 1, rect.minZ + 1], [rect.maxX - 1, rect.minZ + 1], [rect.maxX - 1, rect.maxZ - 1], [rect.minX + 1, rect.maxZ - 1]];
    writeFlatPolygon(skirt, ring, [hole], y - 0.5, 8, [0.62, 0.6, 0.55]);
    const m = new THREE.Mesh(skirt.toGeometry(), new THREE.MeshBasicMaterial({ map: materials.groundMap || null, vertexColors: true, toneMapped: false }));
    m.name = 'outside';
    group.add(m);
  }

  // ---- 建物 ----
  const dsmAt = (x, z) => dsm.sample(x, z);
  const towers = findTowers(proj, buildings, dsm, dtm); // 八角形の鐘楼は専用のモデルにする
  for (const t of towers) writeTower(t, wallsOf(chunkAt(t.x, t.z)).tower);
  let tris = 0;
  for (let k = 0; k < buildings.length; k++) {
    const b = buildings[k];
    const c = chunkAt(b.inside[0], b.inside[1]);
    writeLidarBuilding(b, photoW.get(c), wallsOf(c), c.image, dtm, dsmAt, facade, towers);
    if (k % 600 === 599) {
      progress(`建物を建てています（屋根は LiDAR の実測）… ${Math.round((k / buildings.length) * 100)}%`, 0.15 + (k / buildings.length) * 0.65);
      await pause();
    }
  }

  // ---- 橋 ----
  progress('橋を架けています…', 0.82);
  const bridgeProfiles = [];
  const bridgeBody = new MeshWriter();
  for (const r of bridges) bridgeProfiles.push(writeBridge(r, photoW.get(r.chunk), bridgeBody, dtm, dsm));

  // ---- 水面 ----
  const water = new MeshWriter();
  for (const a of waterAreas) writeFlatPolygon(water, a.outer, a.holes, a.level + (a.patch ? 0.22 : 0.25), 25);

  // ---- メッシュにまとめる ----
  for (const c of chunks) {
    const w = photoW.get(c);
    if (!w.empty) {
      const m = new THREE.Mesh(w.toGeometry(), c.material);
      m.name = 'photo';
      m.matrixAutoUpdate = false;
      tris += w.pos.length / 9;
      group.add(m);
    }
    const ws = wallChunks.get(c);
    if (!ws) continue;
    for (const key of ['upper', 'ground', 'plain', 'capitole', 'tower', 'church']) {
      if (ws[key].empty) continue;
      const m = new THREE.Mesh(ws[key].toGeometry(), materials[key]);
      m.castShadow = true;
      m.receiveShadow = true;
      m.matrixAutoUpdate = false;
      tris += ws[key].pos.length / 9;
      group.add(m);
    }
  }
  if (!bridgeBody.empty) {
    const m = new THREE.Mesh(bridgeBody.toGeometry(), materials.plain);
    m.name = 'bridges';
    m.castShadow = m.receiveShadow = true;
    tris += bridgeBody.pos.length / 9;
    group.add(m);
  }
  if (!water.empty) {
    const m = new THREE.Mesh(water.toGeometry(), waterMaterial);
    m.renderOrder = 1;
    group.add(m);
  }

  // ---- 高さの問い合わせ ----
  const bridgeGrid = new Grid(20);
  bridgeProfiles.forEach((p, i) => {
    for (let k = 0; k + 1 < p.pts.length; k++) bridgeGrid.insertSegment(p.pts[k][0], p.pts[k][1], p.pts[k + 1][0], p.pts[k + 1][1], [i, k]);
  });
  const deckHeights = (x, z) => {
    const out = [];
    bridgeGrid.queryPoint(x, z, 15, ([i, k]) => {
      const p = bridgeProfiles[i];
      const a = p.pts[k], b2 = p.pts[k + 1];
      const cl = closestOnSegment(x, z, a[0], a[1], b2[0], b2[1]);
      if (cl.d2 < (p.half + 0.3) ** 2) out.push(p.ys[k] + (p.ys[k + 1] - p.ys[k]) * cl.t);
    });
    return out;
  };
  const heightAt = (x, z) => {
    const decks = deckHeights(x, z);
    return decks.length ? Math.max(...decks) : dtm.sample(x, z);
  };
  // 走行中: 地面と橋面のうち、今の高さに近いもの（橋の下の河岸を走っているときに橋へ飛び乗らないように）
  const groundAt = (x, z, y) => {
    let best = dtm.sample(x, z);
    for (const d of deckHeights(x, z)) if (Math.abs(d - y) < Math.abs(best - y) && d < y + 1.5) best = d;
    return best;
  };

  let note = '';
  try {
    if (typeof document !== 'undefined') await ortho.loadOverview(2048); // Node（テスト）では写真を読まない
  } catch (err) {
    console.warn('航空写真を取得できませんでした', err);
    note = '航空写真を取得できなかったため、地面と屋根は灰色で表示しています';
  }
  return {
    note,
    group, ortho, chunks, dtm, dsm, base, heightAt, groundAt,
    stats: { triangles: Math.round(tris), chunks: chunks.length },
  };
}

// 建物 1 棟: 壁（地面から屋根の端まで）と、LiDAR の屋根（ゆるい面は航空写真、急な面は壁の材質）
export function writeLidarBuilding(b, photo, W, image, dtm, dsmAt, facade, towers = []) {
  const info = b.info;
  const roof = roofFromDsm(b.outer, b.holes, dsmAt);
  const groundYs = b.outer.map(([x, z]) => dtm.sample(x, z));
  const baseY = Math.min(...groundYs) - 0.4;
  const groundMed = groundYs.sort((x, y) => x - y)[groundYs.length >> 1];
  // LiDAR が取れていない（または低すぎる）所は IGN / OSM の高さで補う
  const fallbackTop = groundMed + info.height;
  // 屋根に覆いかぶさる木を拾わないよう、IGN の屋根の最高点（なければ建物の高さから推定）より上は切る。
  // 教会は IGN に最高点がなく、鐘楼・尖塔が高いので切らない
  const maxEle = Number(b.tags['roof:max_ele']);
  const cap = Math.max(fallbackTop, maxEle > 0 ? maxEle - dtm.base + 1.5 : info.isChurch ? Infinity : groundMed + Math.max(info.height * 1.6, info.height + 8));
  const hs = roof.heights.map((h) => (Number.isFinite(h) && h > groundMed + 2 ? Math.min(h, cap) : fallbackTop));
  const color = wallColor(b); // 窓のない壁（教会など）の色
  const sv = facadeStyle(b) * 1000; // ファサードの様式（v に入れる。facades.js）
  const tint = facadeTint(b);
  const groundH = Math.max(3.4, info.floorHeight * 1.15);
  const pts = roof.points;
  // 2 階以上の階の高さ: 軒の高さでちょうど割り切れるようにする（最上階の窓が軒で切れないように）
  const outerHs = hs.slice(0, roof.rings[0].count).sort((x, y) => x - y);
  const upperH = outerHs[Math.floor(outerHs.length * 0.3)] - (groundMed + groundH);
  const floorH = upperH > info.floorHeight * 0.7 ? upperH / Math.max(1, Math.round(upperH / info.floorHeight)) : info.floorHeight;
  const bayShift = Math.floor(hash01(b.id, 9) * 4);

  // 壁
  for (const [ri, ring] of roof.rings.entries()) {
    const ringPts = pts.slice(ring.start, ring.start + ring.count);
    const s = signedArea(ringPts) > 0 ? 1 : -1;
    const sign = ri === 0 ? s : -s; // 中庭の壁は内向き
    const P = (i) => pts[ring.start + ((i + ring.count) % ring.count)];
    let along = 0, narrow = false;
    for (let i = 0; i < ring.count; i++) {
      const ia = ring.start + i, ib = ring.start + ((i + 1) % ring.count);
      if (i === 0 || P(i).orig) {
        // 元の外形の辺ごとに、窓の並びを辺の中央にそろえる（角で窓が切れないように）
        let len = 0;
        for (let k = i; k < i + ring.count; k++) {
          len += Math.hypot(P(k + 1)[0] - P(k)[0], P(k + 1)[1] - P(k)[1]);
          if (P(k + 1).orig) break;
        }
        along = (bayShift + 0.5 - len / BAY / 2) * BAY;
        narrow = len < 2.2;
      }
      const a = pts[ia], c = pts[ib];
      const dx = c[0] - a[0], dz = c[1] - a[1];
      const L = Math.hypot(dx, dz);
      if (L < 0.02) continue;
      const nrm = [(dz / L) * sign, 0, (-dx / L) * sign];
      const ya = hs[ia], yc = hs[ib];
      const u0 = along / BAY / 4, u1 = (along + L) / BAY / 4;
      along += L;
      const span = facade?.building === b ? facadeSpan(facade, a, c, nrm) : null;
      if (span) {
        // 名所の正面（キャピトル）: 地面から専用テクスチャの高さまで
        const top = groundMed + facade.height;
        const v = (y) => (y - groundMed) / facade.height;
        W.capitole.quad([a[0], baseY, a[1]], [c[0], baseY, c[1]], [c[0], Math.max(top, yc), c[1]], [a[0], Math.max(top, ya), a[1]], nrm,
          [span[0], v(baseY)], [span[1], v(baseY)], [span[1], v(Math.max(top, yc))], [span[0], v(Math.max(top, ya))]);
        continue;
      }
      if (info.isChurch && !narrow) {
        // 教会の壁: 地面からの高さで窓の段がそろう（facades.js の CHURCH_TILE）
        const s0 = (along - L) / CHURCH_TILE.w, s1 = along / CHURCH_TILE.w;
        const v = (y) => (y - groundMed) / CHURCH_TILE.h;
        W.church.quad([a[0], baseY, a[1]], [c[0], baseY, c[1]], [c[0], yc, c[1]], [a[0], ya, a[1]], nrm,
          [s0, v(baseY)], [s1, v(baseY)], [s1, v(yc)], [s0, v(ya)], tint);
        continue;
      }
      if (info.isChurch || narrow) {
        W.plain.quad([a[0], baseY, a[1]], [c[0], baseY, c[1]], [c[0], yc, c[1]], [a[0], ya, a[1]], nrm,
          [u0 * 3.5, baseY / 4], [u1 * 3.5, baseY / 4], [u1 * 3.5, yc / 4], [u0 * 3.5, ya / 4], color);
        continue;
      }
      // 1 階（店・扉）と 2 階以上（窓）
      const g0 = groundMed, gt = groundMed + groundH;
      const vg = (y) => sv + (y - g0) / groundH;
      W.ground.quad([a[0], baseY, a[1]], [c[0], baseY, c[1]], [c[0], Math.min(gt, yc), c[1]], [a[0], Math.min(gt, ya), a[1]], nrm,
        [u0, vg(baseY)], [u1, vg(baseY)], [u1, vg(Math.min(gt, yc))], [u0, vg(Math.min(gt, ya))], tint);
      if (ya > gt || yc > gt) {
        const ta = Math.max(gt, ya), tc = Math.max(gt, yc);
        W.upper.quad([a[0], gt, a[1]], [c[0], gt, c[1]], [c[0], tc, c[1]], [a[0], ta, a[1]], nrm,
          [u0, sv], [u1, sv], [u1, sv + (tc - gt) / floorH], [u0, sv + (ta - gt) / floorH], tint);
      }
    }
  }

  // 屋根
  const gt = groundMed + groundH;
  const t = roof.triangles;
  for (let i = 0; i < t.length; i += 3) {
    const A = [pts[t[i]][0], hs[t[i]], pts[t[i]][1]];
    const B = [pts[t[i + 1]][0], hs[t[i + 1]], pts[t[i + 1]][1]];
    const C = [pts[t[i + 2]][0], hs[t[i + 2]], pts[t[i + 2]][1]];
    const ux = B[0] - A[0], uy = B[1] - A[1], uz = B[2] - A[2];
    const vx = C[0] - A[0], vy = C[1] - A[1], vz = C[2] - A[2];
    // 鐘楼のモデルに置き換える所の屋根は作らない
    if (towers.length && hiddenByTower(towers, (A[0] + B[0] + C[0]) / 3, (A[2] + B[2] + C[2]) / 3, Math.max(A[1], B[1], C[1]))) continue;
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l; ny /= l; nz /= l;
    if (ny < 0) { nx = -nx; ny = -ny; nz = -nz; }
    if (ny < 0.3) {
      // ほぼ垂直な面（高さの違う棟の境の壁・塔の側面）は壁として描く。教会以外は窓のある壁
      const hl = Math.hypot(nx, nz) || 1;
      const ax = -nz / hl, az = nx / hl; // 面に沿った水平方向
      const uv = (P) => [(P[0] * ax + P[2] * az) / BAY / 4, sv + (P[1] - gt) / floorH];
      if (info.isChurch) W.plain.tri(A, B, C, [nx, ny, nz], [A[0] / 4, A[1] / 4], [B[0] / 4, B[1] / 4], [C[0] / 4, C[1] / 4], color);
      else W.upper.tri(A, B, C, [nx, ny, nz], uv(A), uv(B), uv(C), tint);
    } else {
      photo.tri(A, B, C, [0, 1, 0], orthoUV(image, A[0], A[2]), orthoUV(image, B[0], B[2]), orthoUV(image, C[0], C[2]));
    }
  }
}

// 橋: 表面の高さ（MNS）から橋面の高さの断面を作り、橋面に写真。高い所は橋脚の間をレンガのアーチにする
export function writeBridge(road, photo, body, dtm, dsm) {
  const half = road.width / 2 + (CAR_ROADS.has(road.type) ? 2 : 0.3);
  // 2 m ごとに点を取り直す
  const pts = [];
  for (let i = 0; i + 1 < road.pts.length; i++) {
    const [ax, az] = road.pts[i], [bx, bz] = road.pts[i + 1];
    const len = Math.hypot(bx - ax, bz - az);
    const n = Math.max(1, Math.round(len / 2));
    for (let k = 0; k < n; k++) pts.push([ax + ((bx - ax) * k) / n, az + ((bz - az) * k) / n]);
  }
  pts.push(road.pts[road.pts.length - 1]);
  // 橋面の高さ: 中心と左右の表面の高さの中央値を、前後 5 点の中央値でならす（車や街灯を拾わないよう）
  const { L, R } = offsets(pts, half * 0.5);
  const raw = pts.map((p, i) => median([dsm.sample(p[0], p[1]), dsm.sample(L[i][0], L[i][1]), dsm.sample(R[i][0], R[i][1])]));
  const ys = raw.map((_, i) => median(raw.slice(Math.max(0, i - 2), i + 3)));
  // 両端は地面の高さに合わせる
  ys[0] = Math.max(ys[0], dtm.sample(pts[0][0], pts[0][1]));
  ys[ys.length - 1] = Math.max(ys[ys.length - 1], dtm.sample(pts[pts.length - 1][0], pts[pts.length - 1][1]));

  const edge = offsets(pts, half);
  const image = road.chunk.image;
  const rgb = (hex) => {
    const c = new THREE.Color(hex);
    return [c.r, c.g, c.b];
  };
  // ポン・ヌフのように、壁はレンガ、アーチの縁・水切り・手すりは白い石
  const col = rgb('#c98a70'), stone = rgb('#e6ded0'), dark = rgb('#3a3632');
  const n = pts.length;
  const along = [0];
  for (let i = 1; i < n; i++) along.push(along[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  const ground = pts.map(([x, z]) => dtm.sample(x, z));
  // 橋の下面の高さ。地面（川面）より 3 m 以上高い区間は、橋脚の間をアーチにする（約 26 m おき、橋脚は径間の 2 割）
  const DECK = 1.3;
  const under = ys.map((y) => y - DECK);
  const arched = ys.map(() => false);
  const piers = [];
  for (let i = 0; i < n; i++) {
    if (ys[i] - ground[i] <= 3) continue;
    let j = i;
    while (j + 1 < n && ys[j + 1] - ground[j + 1] > 3) j++;
    const a0 = i - 1, a1 = j + 1; // 橋台
    const spans = Math.max(1, Math.round((a1 - a0) / 13));
    for (let k = i; k <= j; k++) {
      const u = ((k - a0) / (a1 - a0)) * spans;
      const ta = (u - Math.floor(u) - 0.1) / 0.8;
      const rise = ta <= 0 || ta >= 1 ? 0 : Math.sin(Math.PI * ta) ** 0.6;
      const bottom = ground[k] - 1;
      under[k] = bottom + (ys[k] - DECK - bottom) * rise;
      arched[k] = rise > 0;
    }
    for (let sp = 1; sp < spans; sp++) piers.push(Math.round(a0 + ((a1 - a0) * sp) / spans));
    i = j;
  }
  for (let i = 0; i + 1 < n; i++) {
    const y0 = ys[i] + 0.05, y1 = ys[i + 1] + 0.05;
    const a = [edge.L[i][0], y0, edge.L[i][1]], b = [edge.R[i][0], y0, edge.R[i][1]];
    const c = [edge.R[i + 1][0], y1, edge.R[i + 1][1]], d = [edge.L[i + 1][0], y1, edge.L[i + 1][1]];
    const uv = (p) => orthoUV(image, p[0], p[2]);
    photo.quad(a, b, c, d, [0, 1, 0], uv(a), uv(b), uv(c), uv(d));
    // 側面（橋面からアーチの下面まで）。アーチの縁の約 1 m は白い石、その上はレンガ。上に石の手すり
    const u0 = under[i], u1 = under[i + 1];
    const r0 = Math.min(y0 - 0.3, u0 + (arched[i] || arched[i + 1] ? 1.0 : 0)), r1 = Math.min(y1 - 0.3, u1 + (arched[i] || arched[i + 1] ? 1.0 : 0));
    const s0 = along[i] / 3, s1 = along[i + 1] / 3;
    const inner = offsets(pts.slice(i, i + 2), half - 0.45);
    for (const [p, q, s, ip, iq] of [[edge.L[i], edge.L[i + 1], 1, inner.L[0], inner.L[1]], [edge.R[i], edge.R[i + 1], -1, inner.R[0], inner.R[1]]]) {
      const dx = q[0] - p[0], dz = q[1] - p[1];
      const l = Math.hypot(dx, dz) || 1;
      const nrm = [(-dz / l) * s, 0, (dx / l) * s];
      const wall = (ya, yb, yc, yd, color) =>
        body.quad([p[0], ya, p[1]], [q[0], yb, q[1]], [q[0], yc, q[1]], [p[0], yd, p[1]], nrm, [s0, ya / 3], [s1, yb / 3], [s1, yc / 3], [s0, yd / 3], color);
      wall(y0, y1, r1, r0, col);
      if (r0 > u0 + 0.01 || r1 > u1 + 0.01) wall(r0, r1, u1, u0, stone);
      // 手すり（高さ 1 m・厚さ 45 cm）
      const t0 = y0 + 1.0, t1 = y1 + 1.0;
      body.quad([p[0], y0, p[1]], [q[0], y1, q[1]], [q[0], t1, q[1]], [p[0], t0, p[1]], nrm, [s0, 0], [s1, 0], [s1, 0.33], [s0, 0.33], stone);
      body.quad([ip[0], y0, ip[1]], [iq[0], y1, iq[1]], [iq[0], t1, iq[1]], [ip[0], t0, ip[1]], [-nrm[0], 0, -nrm[2]], [s0, 0], [s1, 0], [s1, 0.33], [s0, 0.33], stone);
      body.quad([p[0], t0, p[1]], [q[0], t1, q[1]], [iq[0], t1, iq[1]], [ip[0], t0, ip[1]], [0, 1, 0], [s0, 0], [s1, 0], [s1, 0.15], [s0, 0.15], stone);
    }
    body.quad([a[0], u0, a[2]], [b[0], u0, b[2]], [c[0], u1, c[2]], [d[0], u1, d[2]], [0, -1, 0],
      [0, 0], [1, 0], [1, 1], [0, 1], col);
  }
  // 橋脚の水切り（上流・下流側に尖った形）
  for (const k of piers) {
    if (k <= 0 || k >= n - 1) continue;
    const [x, z] = pts[k];
    const ux0 = pts[k + 1][0] - pts[k - 1][0], uz0 = pts[k + 1][1] - pts[k - 1][1];
    const ul = Math.hypot(ux0, uz0) || 1;
    const ux = ux0 / ul, uz = uz0 / ul;
    const yb = ground[k] - 1, yt = ground[k] + (ys[k] - ground[k]) * 0.45;
    for (const side of [edge.L[k], edge.R[k]]) {
      const ox = side[0] - x, oz = side[1] - z;
      const ol = Math.hypot(ox, oz) || 1;
      const A = [side[0] + ux * 2.6, side[1] + uz * 2.6], B = [side[0] - ux * 2.6, side[1] - uz * 2.6];
      const C = [side[0] + (ox / ol) * 3, side[1] + (oz / ol) * 3];
      for (const [p, q] of [[A, C], [C, B]]) {
        const dx = q[0] - p[0], dz = q[1] - p[1];
        const l = Math.hypot(dx, dz) || 1;
        let nx = -dz / l, nz = dx / l;
        if (nx * (p[0] + q[0] - 2 * side[0]) + nz * (p[1] + q[1] - 2 * side[1]) < 0) { nx = -nx; nz = -nz; }
        body.quad([p[0], yt, p[1]], [q[0], yt, q[1]], [q[0], yb, q[1]], [p[0], yb, p[1]], [nx, 0, nz], [0, yt / 3], [l / 3, yt / 3], [l / 3, yb / 3], [0, yb / 3], stone);
      }
      body.tri([A[0], yt, A[1]], [C[0], yt, C[1]], [B[0], yt, B[1]], [0, 1, 0], [0, 0], [1, 0], [0, 1], stone);
      // 橋脚の上の丸い穴（ポン・ヌフの「ドゥグロワール」）: 石の輪と暗い穴
      const h = ys[k] - ground[k];
      const r = Math.max(0.8, Math.min(2.3, h * 0.14));
      const yc = ground[k] + h * 0.62;
      const o = [(ox / ol) * 0.06, (oz / ol) * 0.06];
      const nrm = [ox / ol, 0, oz / ol];
      const at = (ang, rr) => [side[0] + o[0] + ux * Math.cos(ang) * rr, yc + Math.sin(ang) * rr, side[1] + o[1] + uz * Math.cos(ang) * rr];
      const SEG = 20;
      for (let q = 0; q < SEG; q++) {
        const a0 = (q / SEG) * Math.PI * 2, a1 = ((q + 1) / SEG) * Math.PI * 2;
        body.quad(at(a0, r), at(a1, r), at(a1, r + 0.5), at(a0, r + 0.5), nrm, [0, 0], [0.2, 0], [0.2, 0.15], [0, 0.15], stone);
        body.tri([side[0] + o[0] * 1.2, yc, side[1] + o[1] * 1.2], at(a0, r), at(a1, r), nrm, [0, 0], [0.1, 0], [0, 0.1], dark);
      }
    }
  }
  return { pts, ys, half };
}
