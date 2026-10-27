// 地面まわりのメッシュ: 地面、公園・広場・駐車場、道路と歩道、路面標示、線路、水面と河岸の壁、橋。
//
// 地面と同じ高さ (y=0) に重なる面は、深度を書かずに renderOrder の順に塗り重ねる（Z ファイティング防止）。
// 一段高い歩道と縁石（streets.js）は深度を書き、平らな面をすべて塗った後に描く（下に隠れた車道は描かれない）。
// 川や運河は地面より低い位置に水面を置き、ステンシルで地面に「穴」をあけて見せる。
// 地形（terrain.js）があるときは、地面はタイルごとの高さの格子（terrainmesh.js）で、平らな面・歩道・縁石は地形に載せる
// （MeshWriter の drape。y は地面からの高さ）。水面は本当の水面の高さ、岸は本当の岸の高さから水面まで（bankY）。
import * as THREE from 'three';
import { MeshWriter, writeFlatPolygon } from './meshwriter.js';
import { COVER_COLORS, createCoverShared } from './cover.js';
import { Grid, centroid, clipPolylineToRect, clipRingToRect, closestOnSegment, freeRects, hash01, pointInPolygon, ringBounds, signedArea } from '../geo.js';
import { ramblasLayout } from './ramblas.js';
import { LOCKS, lockFrame } from './locks.js';
import { RaisedIndex, oldTownBase, planStreets, streetSteps, writePrism } from './streets.js';
import { CAR_ROADS } from './parse.js';
import { catenaryStations, mergeIntervals, slicePolyline, subtract, tramCrossCuts } from './markings.js';
import { bridgeGroups, buildAbutments, buildBridges, setupDecks } from './bridges.js';
import { DRAPE_LIFT, FLAT_TERRAIN } from './terrain.js';
import { buildFarTerrain, createTerrainMaterials, splitGeometry, TERRAIN_ORDER } from './terrainmesh.js';
import { conditionRoads, despike, sharpenQuays, WALK_DEF } from './terraincond.js';
import { buildMetroEntrances, createMetroMaterials, fillMetroPits, orientRamps, projectEntrances, writeEntranceMasks } from './metro.js';

export const ORDER = {
  waterMask: -50,
  ground: -40,
  oldTown: -39.5, // 旧市街の地面の下地（小舗石。通り・広場・緑地の下。地面の覆いのない所だけ）
  cover: -39, // 地面の覆い（cover.js）
  water: -35,
  green: -30,
  parking: -29,
  plaza: -28,
  sidewalk: -27,
  footway: -26,
  service: -25,
  pedestrian: -24.3, // 歩行者の通りは交差する車道の下（車道が交差点を通り抜ける）
  road: -24,
  cycleway: -22,
  rail: -21,
  marking: -20,
  route: -19,
  raised: -15, // 一段高い歩道・縁石（深度を書く）
};

const c3 = (hex, k = 1) => {
  const c = new THREE.Color(hex);
  return [c.r * k, c.g * k, c.b * k];
};

const GREEN_COLOR = {
  grass: c3('#ffffff'), forest: c3('#c9d8b8'), cemetery: c3('#d7dccb'), pitch: c3('#e6f2d6'),
};

// 広場の舗装。覆いのあるタイルでは、名前で決まった舗装の広場のほかは描かない（広場は覆いの公道になり、広場の中の
// 芝生・木の下も見える。data/cover.js の stampCover）。覆いのない所では、旧市街の広場（キャピトル広場など）は覆いの公道と
// 同じばら色がかった石畳。名前で決まった舗装の広場: Place Olivier は赤みがかった黄土色の固めた砂利・樹脂舗装（利用者の
// 写真 #a07f62 前後。砂利のテクスチャの平均 #c7b898 に掛けてその色になる色）
const PLAZA_SURFACES = [
  { match: /^Place Olivier$/i, tex: 'gravel', uv: 3, color: c3('#cdb0a4') },
  // キャピトル広場: 灰色の小舗石に淡い石の斜めの帯（textures.js の makeCapitoleSquareTexture）
  { match: /^Place du Capitole$/i, tex: 'capitole', uv: 8, color: c3('#ffffff') },
];
const namedSurface = (area) => PLAZA_SURFACES.find((p) => p.match.test(area.name || ''));
// 壁から壁まで石の板の並木道（利用者の Street View 212222・212248: Allées Roosevelt は車の通らない、淡いばら色がかった
// ベージュの石の板 #d8c8bb〜#e8dfd6 の広場。真ん中の道は streets.js で同じ石の板）。中心線から half m の帯
const SLAB_ALLEES = [{ name: /^All[ée]es du Pr[ée]sident Franklin Roosevelt$/i, half: 14, color: c3('#f0e2d8') }];
export function plazaSurface(area, inOldTown = () => false) {
  const s = namedSurface(area);
  if (s) return s;
  const [x, z] = centroid(area.outer);
  return inOldTown(x, z) ? { tex: 'paving', uv: 4, color: c3(COVER_COLORS.old) } : { tex: 'paving', uv: 4, color: c3('#ffffff') };
}

export function createGroundMaterials(tex) {
  const flat = (map, extra = {}) => new THREE.MeshLambertMaterial({
    map, vertexColors: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -4, ...extra,
  });
  const waterNormal = tex.waterNormal;
  const mats = {
    flat: {
      asphalt: flat(tex.asphalt),
      paving: flat(tex.paving),
      sidewalk: flat(tex.sidewalk),
      setts: flat(tex.setts),
      // 旧市街の地面の下地: 地面と同じく水面の穴（ステンシル）には描かない
      settsBase: flat(tex.setts, { stencilWrite: true, stencilRef: 1, stencilFunc: THREE.NotEqualStencilFunc, stencilFail: THREE.KeepStencilOp, stencilZFail: THREE.KeepStencilOp, stencilZPass: THREE.KeepStencilOp }),
      slabs: flat(tex.slabs),
      alsace: flat(tex.alsace),
      gutter: flat(tex.gutter),
      grass: flat(tex.grass),
      gravel: flat(tex.gravel),
      capitole: flat(tex.capitoleSquare),
      plain: flat(null),
      marks: flat(tex.marks, { alphaTest: 0.5 }), // 路面の絵（自転車・矢印・BUS・30）のアトラス
    },
    // 一段高い歩道と縁石。角で重なる所は、縁石 → えんじ色の歩道 → 灰色の歩道の順に手前に出す
    raised: {
      curb: new THREE.MeshLambertMaterial({ map: tex.curb, vertexColors: true, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -3 }),
      sidewalkRed: new THREE.MeshLambertMaterial({ map: tex.sidewalk, vertexColors: true, polygonOffset: true, polygonOffsetFactor: -0.5, polygonOffsetUnits: -1.5 }),
      sidewalk: new THREE.MeshLambertMaterial({ map: tex.sidewalk, vertexColors: true }),
      post: new THREE.MeshLambertMaterial({ vertexColors: true }), // 横断歩道の脇の黒い車止め
    },
    ground: new THREE.MeshLambertMaterial({
      map: tex.ground,
      stencilWrite: true,
      stencilRef: 1,
      stencilFunc: THREE.NotEqualStencilFunc,
      stencilFail: THREE.KeepStencilOp,
      stencilZFail: THREE.KeepStencilOp,
      stencilZPass: THREE.KeepStencilOp,
    }),
    // 水の穴（ステンシル）。地形があるときは地面のあとに深度テスト付きで描き、手前の土手・岸壁に隠れた所には穴をあけない
    // （地面と同じ面なので少し手前に出す）
    waterMask: new THREE.MeshBasicMaterial({
      colorWrite: false,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -4,
      stencilWrite: true,
      stencilRef: 1,
      stencilFunc: THREE.AlwaysStencilFunc,
      stencilZPass: THREE.ReplaceStencilOp,
    }),
    water: waterMaterial(waterNormal),
    // 岸壁の際の水面の陰（岸壁の影と、暗い岸壁の映り込み）
    waterEdge: new THREE.MeshBasicMaterial({
      color: '#141a12', alphaMap: tex.contact, transparent: true, opacity: 0.85, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -4,
    }),
    quai: new THREE.MeshStandardMaterial({ map: tex.plain, vertexColors: true, roughness: 0.95 }),
    // 運河の石積み・水面の段差の壁・土手の袖壁（敷石のテクスチャは壁では市松模様に見えるので、無地の壁のテクスチャに色を掛ける）
    quaiStone: new THREE.MeshStandardMaterial({ map: tex.plain, vertexColors: true, roughness: 0.95 }),
    // 岸壁の上の歩道の板（淡い花崗岩の敷石。橋の歩道と同じテクスチャ。地面の下に隠れる所があるので深度はずらさない）
    quayWalk: new THREE.MeshStandardMaterial({ map: tex.granite, vertexColors: true, roughness: 0.9 }),
    // 草の土手（運河・街の外れの川岸の斜面）
    bank: new THREE.MeshLambertMaterial({ map: tex.grass, vertexColors: true }),
    deck: new THREE.MeshStandardMaterial({ map: tex.asphalt, vertexColors: true, roughness: 0.95, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -6 }),
    // 石の橋の歩道（淡い花崗岩の板）と、橋面の標示（線も絵もアトラス 1 枚で）
    deckWalk: new THREE.MeshStandardMaterial({ map: tex.granite, vertexColors: true, roughness: 0.9, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -6 }),
    deckMarks: new THREE.MeshLambertMaterial({ map: tex.marks, vertexColors: true, alphaTest: 0.5, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -8 }),
    bridge: new THREE.MeshStandardMaterial({ map: tex.plain, vertexColors: true, roughness: 0.9 }),
    cover: createCoverShared(tex, ORDER.cover),
  };
  mats.terrain = createTerrainMaterials(mats.ground);
  mats.metro = createMetroMaterials(tex);
  // 地面の上の面（道路・歩道・縁石など）は、水とメトロの吹き抜けの穴（ステンシル 1）には描かない
  const holeTest = { stencilWrite: true, stencilRef: 1, stencilFunc: THREE.NotEqualStencilFunc, stencilFail: THREE.KeepStencilOp, stencilZFail: THREE.KeepStencilOp, stencilZPass: THREE.KeepStencilOp };
  for (const m of [...Object.values(mats.flat), ...Object.values(mats.raised)]) Object.assign(m, holeTest);
  return mats;
}

// 水面: 色は頂点カラーで付ける（WATER_COLOR）。
// 波の法線マップは 6 m ごとに繰り返し、大きさと向きの違う 2 枚を別々に流して、同じ模様の繰り返しを見えなくする。
// 波は弱く（流れのゆるい川面）、少し粗くして空の映り込みをぼかす。空の映り込みは物理どおり真上からはほとんど映らず、
// 斜めから見るほど強い（強さは main.js で水だけ別に決める）。にごった水に映る空は少しくすむので、映り込みの色を
// 少し灰色に寄せて水の色を少し掛ける
// 運河の港 Port Saint-Sauveur（利用者の写真 NCM_0183・0184）: 広い水面の両岸は草の土手ではなく、垂直の石の岸壁。
// 中心（緯度・経度）から東西 ±hx m・南北 ±hz m の中の運河の岸
const PORT_SAUVEUR = { latlon: [43.59634, 1.4564], hx: 70, hz: 270 };
// 運河 Canal de Brienne（利用者の写真 NCM_0186）: 両岸とも水際から並木道まで約 3 m の草の斜面（壁はない）。この線から 30 m 以内の岸
// （運河の芯線に沿った折れ線。閘門の上で北へ曲がってから北西へ）
const BRIENNE = { line: [[43.604413, 1.434409], [43.604811, 1.434372], [43.605083, 1.434089], [43.605282, 1.433639], [43.606512, 1.430163]], reach: 30 };
const JGARDEN_POND = [43.6119432, 1.4318864]; // 日本庭園（Jardin japonais Pierre Baudis）の池の中心のあたり
const WATER_TILE = 6; // 波の法線マップ 1 枚の大きさ（m）
// 利用者の写真では、晴れた日の川と運河の港は空を映して青みがかった灰色（ガロンヌ川 #3e5f86 前後、Port Saint-Sauveur
// #5c7189〜#a0afbe）。水の色は灰緑から青灰色に寄せ、映り込みの空の青も半分ほど残す
const WATER_COLOR = { river: c3('#4a5856'), canal: c3('#46555a'), pond: c3('#4a5548') };
function waterMaterial(normalMap) {
  const m = new THREE.MeshStandardMaterial({
    color: '#ffffff', vertexColors: true, roughness: 0.13, metalness: 0,
    normalMap, normalScale: new THREE.Vector2(0.035, 0.035), // 利用者の写真では川も運河もほとんど鏡のよう
  });
  m.userData.time = { value: 0 };
  m.onBeforeCompile = (shader) => {
    shader.uniforms.waterTime = m.userData.time;
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float waterTime;')
      .replace('vec3 mapN = texture2D( normalMap, vNormalMapUv ).xyz * 2.0 - 1.0;', `
        // 細かいさざ波（ガロンヌ川の流れる北へ流す）と、2.7 倍の大きさで 40° 回したうねり（ゆっくり別の向きに）
        vec2 uvA = vNormalMapUv + vec2(0.011, -0.043) * waterTime;
        const mat2 ROT = mat2(0.766, 0.643, -0.643, 0.766);
        vec2 uvB = ROT * vNormalMapUv * 0.37 + vec2(-0.017, 0.006) * waterTime;
        vec3 nA = texture2D( normalMap, uvA ).xyz * 2.0 - 1.0;
        vec3 nB = texture2D( normalMap, uvB ).xyz * 2.0 - 1.0;
        nB.xy = transpose(ROT) * nB.xy;
        vec3 mapN = normalize(vec3(nA.xy + nB.xy * 1.3, nA.z * nB.z));`)
      .replace('#include <lights_fragment_maps>', `#include <lights_fragment_maps>
        #if defined( USE_ENVMAP ) && defined( RE_IndirectSpecular )
          radiance = mix(vec3(dot(radiance, vec3(0.2126, 0.7152, 0.0722))), radiance, 0.6) * vec3(0.92, 0.98, 1.0);
        #endif`);
  };
  m.customProgramCacheKey = () => 'water-two-layers';
  return m;
}

// 折れ線の左右のオフセット（マイター結合、長さ制限付き）
export function offsets(pts, half) {
  const n = pts.length;
  const L = [], R = [];
  for (let i = 0; i < n; i++) {
    const p = pts[i];
    let dx = 0, dz = 0;
    if (i > 0) {
      const l = Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1]) || 1;
      dx += (p[0] - pts[i - 1][0]) / l;
      dz += (p[1] - pts[i - 1][1]) / l;
    }
    if (i < n - 1) {
      const l = Math.hypot(pts[i + 1][0] - p[0], pts[i + 1][1] - p[1]) || 1;
      dx += (pts[i + 1][0] - p[0]) / l;
      dz += (pts[i + 1][1] - p[1]) / l;
    }
    const dl = Math.hypot(dx, dz) || 1;
    dx /= dl;
    dz /= dl;
    let nx = -dz, nz = dx;
    let scale = 1;
    if (i > 0 && i < n - 1) {
      const l = Math.hypot(pts[i + 1][0] - p[0], pts[i + 1][1] - p[1]) || 1;
      const sx = (pts[i + 1][0] - p[0]) / l, sz = (pts[i + 1][1] - p[1]) / l;
      const cos = Math.abs(nx * -sz + nz * sx);
      scale = Math.min(2.5, 1 / Math.max(cos, 0.2));
    }
    L.push([p[0] + nx * half * scale, p[1] + nz * half * scale]);
    R.push([p[0] - nx * half * scale, p[1] - nz * half * scale]);
  }
  return { L, R };
}

function writeRibbon(w, pts, half, y, color, uvScale = 4) {
  if (pts.length < 2) return;
  const { L, R } = offsets(pts, half);
  const up = [0, 1, 0];
  const uv = (p) => [p[0] / uvScale, -p[1] / uvScale];
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = L[i], b = R[i], c = R[i + 1], d = L[i + 1];
    w.quad([a[0], y, a[1]], [b[0], y, b[1]], [c[0], y, c[1]], [d[0], y, d[1]], up, uv(a), uv(b), uv(c), uv(d), color);
  }
}

function writeDisc(w, p, r, y, color, uvScale = 4, seg = 10) {
  const up = [0, 1, 0];
  const uv = (q) => [q[0] / uvScale, -q[1] / uvScale];
  for (let i = 0; i < seg; i++) {
    const a0 = (i / seg) * Math.PI * 2, a1 = ((i + 1) / seg) * Math.PI * 2;
    const q0 = [p[0] + Math.cos(a0) * r, p[1] + Math.sin(a0) * r];
    const q1 = [p[0] + Math.cos(a1) * r, p[1] + Math.sin(a1) * r];
    w.tri([p[0], y, p[1]], [q0[0], y, q0[1]], [q1[0], y, q1[1]], up, uv(p), uv(q0), uv(q1), color);
  }
}

// トラムの架線柱と架線（地面からの高さで書く）。柱の位置は線の始点からの距離で決め、範囲 clip の中の柱だけ書く。
// cutsFor(t): 線 t が車道・横断歩道を横切る区間（tramCrossCuts）。柱はその中に立てない（catenaryStations）。戻り値: 柱の位置（当たり判定）
// 柱は路面電車（幅 2.4 m、半幅 1.2 m＋揺れ）にかからない所: 複線（隣のトラムの線が 2〜5.5 m 横）は 2 本の線の真ん中に
// 1 本（腕を両側へ。2 本のうち一覧で先の線が立てる）、単線は右へ 2.2 m（芝の帯の外の縁）
const CAT_STEP = 35, CAT_SIDE = 2.2, WIRE_Y = 5.8;
export function writeCatenary(rails, clip, w, cutsFor = () => []) {
  const trams = rails.filter((r) => r.type === 'tram' && !r.bridge);
  const grey = c3('#8b9094'), wire = c3('#2a2c2e');
  const inClip = (x, z) => x >= clip.minX && x < clip.maxX && z >= clip.minZ && z < clip.maxZ;
  // 隣のトラムの線（横のずれ d、+ = 右）と、その線の一覧での順番
  const neighbour = (ti, x, z, nx, nz) => {
    let best = null;
    trams.forEach((t, k) => {
      if (k === ti) return;
      const b = t.bounds;
      if (b && (x < b[0] - 6 || x > b[2] + 6 || z < b[1] - 6 || z > b[3] + 6)) return;
      for (let i = 0; i + 1 < t.pts.length; i++) {
        const c = closestOnSegment(x, z, t.pts[i][0], t.pts[i][1], t.pts[i + 1][0], t.pts[i + 1][1]);
        if (c.d2 > 5.5 * 5.5) continue;
        const d = (c.x - x) * nx + (c.z - z) * nz;
        if (Math.abs(d) >= 2 && Math.abs(d) * Math.abs(d) > c.d2 * 0.8 && (!best || Math.abs(d) < Math.abs(best.d))) best = { d, k };
      }
    });
    return best;
  };
  const poles = [];
  for (const t of trams) {
    if (!t.bounds) t.bounds = t.pts.reduce((a, [x, z]) => [Math.min(a[0], x), Math.min(a[1], z), Math.max(a[2], x), Math.max(a[3], z)], [Infinity, Infinity, -Infinity, -Infinity]);
  }
  trams.forEach((t, ti) => {
    const b = t.bounds;
    if (b[2] < clip.minX - 10 || b[0] > clip.maxX + 10 || b[3] < clip.minZ - 10 || b[1] > clip.maxZ + 10) return;
    let total = 0;
    for (let i = 0; i + 1 < t.pts.length; i++) total += Math.hypot(t.pts[i + 1][0] - t.pts[i][0], t.pts[i + 1][1] - t.pts[i][1]);
    const stations = catenaryStations(total, cutsFor(t), CAT_STEP);
    let acc = 0, si = 0;
    for (let i = 0; i + 1 < t.pts.length && si < stations.length; i++) {
      const [ax, az] = t.pts[i], [bx, bz] = t.pts[i + 1];
      const L = Math.hypot(bx - ax, bz - az);
      if (L < 1e-6) continue;
      const ux = (bx - ax) / L, uz = (bz - az) / L, nx = -uz, nz = ux;
      for (; si < stations.length && stations[si] <= acc + L; si++) {
        const x = ax + ux * (stations[si] - acc), z = az + uz * (stations[si] - acc);
        if (!inClip(x, z)) continue;
        const nb = neighbour(ti, x, z, nx, nz);
        if (nb && nb.k < ti) continue; // 複線の真ん中の柱は隣の線が立てる
        const off = nb ? nb.d / 2 : CAT_SIDE;
        const px = x + nx * off, pz = z + nz * off;
        writePrism(w, px, pz, ux, uz, 0.11, 0.11, 0, 7.5, grey);
        // 腕: 柱から線の上へ（複線は両方の線の上まで）
        const a0 = nb ? Math.min(0, nb.d) : 0, a1 = nb ? Math.max(0, nb.d) : off;
        writePrism(w, x + nx * (a0 + a1) / 2, z + nz * (a0 + a1) / 2, nx, nz, (a1 - a0) / 2 + 0.1, 0.04, WIRE_Y + 0.35, WIRE_Y + 0.45, grey);
        writePrism(w, x, z, nx, nz, 0.03, 0.03, WIRE_Y, WIRE_Y + 0.4, grey); // 吊り金具
        if (nb) writePrism(w, x + nx * nb.d, z + nz * nb.d, nx, nz, 0.03, 0.03, WIRE_Y, WIRE_Y + 0.4, grey);
        poles.push([px, pz]);
      }
      acc += L;
    }
    // 架線: 線の上の細い黒い帯（縦と横の 2 枚）
    for (const pts of clipPolylineToRect(t.pts, clip.minX, clip.minZ, clip.maxX, clip.maxZ)) {
      for (let i = 0; i + 1 < pts.length; i++) {
        const [ax, az] = pts[i], [bx, bz] = pts[i + 1];
        const L = Math.hypot(bx - ax, bz - az);
        if (L < 1e-6) continue;
        const nx = -(bz - az) / L * 0.012, nz = (bx - ax) / L * 0.012;
        w.quad([ax - nx, WIRE_Y, az - nz], [bx - nx, WIRE_Y, bz - nz], [bx + nx, WIRE_Y, bz + nz], [ax + nx, WIRE_Y, az + nz], [0, -1, 0], [0, 0], [0, 0], [0, 0], [0, 0], wire);
        w.quad([ax, WIRE_Y, az], [bx, WIRE_Y, bz], [bx, WIRE_Y + 0.03, bz], [ax, WIRE_Y + 0.03, az], [nx / 0.012, 0, nz / 0.012], [0, 0], [0, 0], [0, 0], [0, 0], wire);
      }
    }
  });
  return poles;
}

export function roadStyle(road) {
  const t = road.type;
  const s = road.surface;
  const paved = /^(paving_stones|sett|cobblestone|unhewn_cobblestone|bricks|stone)$/.test(s);
  const loose = /^(gravel|fine_gravel|compacted|dirt|ground|earth|grass|sand|pebblestone|unpaved)$/.test(s);
  // 自転車道: トゥールーズは赤茶色の舗装（ユーザーの写真 6・33。灰色のアスファルトのテクスチャに掛けて赤茶に見える色）
  if (t === 'cycleway') return { order: ORDER.cycleway, tex: 'asphalt', color: [2.05, 0.8, 0.6] };
  if (t === 'pedestrian' || t === 'living_street') return { order: ORDER.pedestrian, tex: 'paving', color: c3('#ffffff') };
  if (t === 'footway' || t === 'path' || t === 'bridleway' || t === 'track' || t === 'steps') {
    if (loose) return { order: ORDER.footway, tex: 'gravel', color: c3('#ffffff') };
    if (paved) return { order: ORDER.footway, tex: 'paving', color: c3('#f0ece4') };
    return { order: ORDER.footway, tex: 'sidewalk', color: c3(t === 'steps' ? '#d8d2c8' : '#efebe5') };
  }
  if (paved) return { order: ORDER.road, tex: 'paving', color: c3('#d9d1c4') };
  if (t === 'service') return { order: ORDER.service, tex: 'asphalt', color: c3('#e6e6e6') };
  return { order: ORDER.road, tex: 'asphalt', color: c3('#ffffff') };
}

// 水の上かどうかの判定（当たり判定用。描画とは独立）
export function makeWaterTest(areas) {
  const water = areas.filter((a) => a.type === 'water');
  const grid = new Grid(50);
  water.forEach((a, i) => grid.insertBounds(a.bounds.minX, a.bounds.minZ, a.bounds.maxX, a.bounds.maxZ, i));
  return (x, z) => {
    let hit = false;
    grid.queryPoint(x, z, 0, (i) => {
      if (!hit && pointInPolygon(x, z, water[i])) hit = true;
    });
    return hit;
  };
}

// 水の穴の三角形が地面より下に沈んでいないか調べる点（重心座標）
const MASK_SAMPLES = [[1 / 3, 1 / 3], [0.5, 0], [0, 0.5], [0.5, 0.5], [0.15, 0.15], [0.7, 0.15], [0.15, 0.7], [0.25, 0], [0.75, 0], [0, 0.25], [0, 0.75], [0.25, 0.75], [0.75, 0.25]];

// 地図から生成する地面（エリア全体をまとめて作る）
export function buildGround(parsed, rect, mats, opts = {}) {
  const base = buildGroundBase(parsed, rect, mats, opts.terrain, opts.layout);
  if (opts.terrain && !opts.terrain.flat) setupDecks(opts.terrain, parsed.roads, opts.proj, base.waterDepthAt); // 橋の縦断面
  if (opts.terrain?.abutments?.length) base.group.add(buildAbutments(opts.terrain.abutments, mats)); // 高架の下の擁壁
  const pad = 120;
  const detail = buildGroundDetail(parsed, { minX: rect.minX - pad, minZ: rect.minZ - pad, maxX: rect.maxX + pad, maxZ: rect.maxZ + pad }, mats, base.waterDepthAt, opts);
  base.group.add(detail.group);
  return { ...base, bridges: detail.bridges, heightAt: detail.heightAt, posts: detail.posts, curbs: detail.streetStats.curbs };
}

// 岸の形: ガロンヌ川は旧市街のまわり（バザクルからポン・サン・ミシェルの先まで）だけ高いレンガの岸壁、その外は草の土手。
// 運河は草の斜面か、草の土手の下に低い石積み（高さ約 1 m、笠石 #9c7c56）。橋・閘門の近くだけ高さいっぱいの石の壁
// 岸壁の範囲の中心（ポン・ヌフの少し西、緯度・経度）。エリアごとに原点が違うので、そのエリアの投影で座標にする
const QUAY_LATLON = [43.5994, 1.4364], QUAY_RADIUS = 1250;
const BANK = {
  // 岸壁のレンガ（写真の日なた #b89676〜#bb7d4f）、明るい石の根石（#ccc3b4）と笠石。白っぽいテクスチャに掛けるので少し明るく
  brickA: c3('#b89676', 1.16), brickB: c3('#bb7d4f', 1.16), quayBase: c3('#ccc3b4', 1.16), quayCoping: c3('#c9bfae', 1.16), quayWalk: c3('#d6d0c4', 1.0),
  // 運河の石積み・段差の壁（切石のテクスチャ（敷石と同じ）に掛ける色。仕上がりが #a8957a・笠石 #9c7c56 ほど）
  canalStone: c3('#c9c1b5'), canalCoping: c3('#bd9f7b'), canalLow: c3('#b3ab9c'), drop: c3('#bfb7aa'),
  // 草の土手（緑のテクスチャ #6f8f45 に掛ける色。写真の土手はくすんだオリーブ色 #4f5338〜#58544d、水際は土）。
  // 緑と黄を抑えて青を足し、仕上がりを灰色がかったオリーブにする（チャンネルごとの掛け算なので 1 を超えてよい）
  grass: [0.62, 0.4, 1.0], grassLow: [0.56, 0.37, 0.92], earth: [0.9, 0.42, 1.15],
};

// 街の外れの川岸の土手の断面（幅 W に対する割合, 深さ d に対する割合）: 上の斜面、途中の小段、下の斜面、水際のゆるい土の斜面
// 上の縁は 2 段に分けて丸める
const NATURAL = [[0, 0], [0.05, 0.02], [0.13, 0.12], [0.3, 0.4], [0.45, 0.45], [0.75, 0.82], [1, 1]];
const naturalY = (f, d) => (f >= 1 ? -d - 0.3 : -d * f);

// 頂点ごとの土手の幅。両側が土手なら両側の辺の小さい方。土手と壁の岸（岸壁・橋台・段差の壁）の境目でも細くせず、
// 土手の切り口は石の袖壁でふさぐ（細くすると、隣の辺の全体が切り立った草の崖になる）。
// prof: 辺ごとの岸の形（null は岸なし）、wid: 辺ごとの土手の幅。頂点 i は辺 i - 1 と辺 i の間
export function bankVertexWidths(prof, wid) {
  const n = prof.length;
  return wid.map((W, i) => {
    const j = (i + n - 1) % n, k0 = prof[j], k1 = prof[i];
    if (k0 === 'natural' && k1 === 'natural') return Math.min(W, wid[j]);
    return k0 === 'natural' ? wid[j] : W;
  });
}

// 岸を作る前に、長い辺を maxLen m 以下に分ける（岸の形・土手の幅を短い区間ごとに決められるように）
export function subdivideRing(ring, maxLen = 10) {
  const out = [];
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i], q = ring[(i + 1) % ring.length];
    const k = Math.max(1, Math.ceil(Math.hypot(q[0] - p[0], q[1] - p[1]) / maxLen));
    for (let j = 0; j < k; j++) out.push([p[0] + ((q[0] - p[0]) * j) / k, p[1] + ((q[1] - p[1]) * j) / k]);
  }
  return out;
}

// 土手の断面で、岸からの割合 f の所の高さ
export function naturalHeight(f, d) {
  for (let k = 0; k + 1 < NATURAL.length; k++) {
    const [f0, g0] = NATURAL[k], [f1, g1] = NATURAL[k + 1];
    if (f <= f1) return naturalY(g0 + ((g1 - g0) * (f - f0)) / (f1 - f0 || 1), d);
  }
  return naturalY(1, d);
}

// 土手の切り口の断面（岸からの距離, 高さ）。垂直の壁の岸は null。W: 街の外れの川岸の土手の幅
function bankSection(kind, d, W = 16) {
  if (kind === 'natural') return [[0, -d - 0.3], ...NATURAL.map(([f, g]) => [f * W, naturalY(g, d)])];
  if (kind === 'slope') return [[0, -d - 0.25], [0, 0], [3.6, -d - 0.25]];
  if (kind === 'step') return [[0, -d - 0.3], [0, 0], [2.0, -(d - 1)], [2.4, -(d - 1)], [2.4, -d - 0.3]];
  return null;
}

// 岸壁の線のすき間をふさぐ壁 [始点, 終点]（緯度・経度）。終点は岸壁の線の端で、高さと向きはその壁から写す
// ポン・ヌフの北の欄干の端 → ドラード河岸の岸壁の端（利用者のストリートビュー 2026-10-17 210627: 橋の欄干がそのまま河岸の
// 手すり壁に続く。地形の格子の岸壁の線は橋の 3 m 手前で切れ、下の段と川が見えていた）
// fill: 壁の上の段の高さに敷く歩道の板（橋のたもとの角の、格子の斜面の 1 マスを隠す）
const QUAY_LINKS = [{
  wall: [[43.5996839, 1.4403807], [43.5997144, 1.4403683]],
  fill: [[43.5996893, 1.4403733], [43.5996893, 1.4404365], [43.5996632, 1.4404365], [43.5996632, 1.4403832]],
}];
export function quayLinks(walls, proj) {
  const out = [];
  for (const { wall: [la, lb], fill } of QUAY_LINKS) {
    const [ax, az] = proj.project(...la), [bx, bz] = proj.project(...lb);
    let best = null;
    for (const q of walls) {
      for (const [x, z, t, b] of [[q.ax, q.az, q.at, q.ab], [q.bx, q.bz, q.bt, q.bb]]) {
        const d = Math.hypot(x - bx, z - bz);
        if (d < 1.5 && (!best || d < best.d)) best = { d, q, t, b };
      }
    }
    if (!best) continue;
    const { q, t, b } = best;
    out.push({ ax, az, at: t, ab: b, bx, bz, bt: t, bb: b, nx: q.nx, nz: q.nz, wa: q.wa, wb: q.wb, fill: fill?.map((ll) => proj.project(...ll)) });
  }
  return out;
}

// 旧市街のまわりの岸壁（terraincond.js の sharpenQuays の線）: 上の河岸から下の遊歩道まで垂直のレンガの壁と手すり壁、
// 壁の上から河岸の車道の縁までの歩道の板（壁の裏の 1 マスの斜面を隠す）
const QUAY_PARAPET = 1.0; // 岸壁の上のレンガの手すり壁の高さ（m）
function buildQuayWalls(list, mats) {
  const w = new MeshWriter(), walk = new MeshWriter();
  // 端の点の向き: まわり NEAR_N m の壁の向き（n）の長さの重みの平均（壁の線は格子の三角形の辺の階段なので、1 本ずつの向きは
  // 45° ずつ違う。つながる壁で同じ向きを使うので、手すり壁・歩道の板の角もすき間なく合い、板の外の縁もなめらかになる）
  const NEAR_N = 7;
  const key = (x, z) => `${Math.round(x * 100)},${Math.round(z * 100)}`;
  const mid = new Grid(10);
  list.forEach((q, i) => mid.insertPoint((q.ax + q.bx) / 2, (q.az + q.bz) / 2, i));
  const vn = new Map();
  const dirAt = (x, z) => {
    const k = key(x, z);
    if (vn.has(k)) return vn.get(k);
    let sx = 0, sz = 0;
    mid.queryPoint(x, z, NEAR_N, (i) => {
      const q = list[i];
      if (Math.hypot((q.ax + q.bx) / 2 - x, (q.az + q.bz) / 2 - z) > NEAR_N) return;
      const L = Math.hypot(q.bx - q.ax, q.bz - q.az);
      sx += q.nx * L;
      sz += q.nz * L;
    });
    const l = Math.hypot(sx, sz), v = l > 1e-6 ? [sx / l, sz / l] : null;
    vn.set(k, v);
    return v;
  };
  for (const q of list) {
    let { ax, az, at, ab, bx, bz, bt, bb, wa: ka = WALK_DEF, wb: kb = WALK_DEF } = q;
    const { nx, nz } = q;
    // 表の面（反時計回り）が n を向く並び: 辺の向き (dx, dz) に対して (-dz, 0, dx) が n の側
    if ((bx - ax) * nz - (bz - az) * nx < 0) [ax, az, at, ab, ka, bx, bz, bt, bb, kb] = [bx, bz, bt, bb, kb, ax, az, at, ab, ka];
    const L = Math.hypot(bx - ax, bz - az), h0 = ab - 0.4, ha = at - h0, hb = bt - h0;
    const t = hash01(Math.round(ax * 7 + az * 13), 3);
    const brick = BANK.brickA.map((c, j) => c * (1 - t) + BANK.brickB[j] * t);
    // 端の点の向き（手すり壁の厚さは壁の面に垂直に保つので、向きの違いの分だけ 1.6 倍まで伸ばす）
    const [aex, aez] = dirAt(ax, az) || [nx, nz], [bex, bez] = dirAt(bx, bz) || [nx, nz];
    const am = Math.min(1.6, 1 / Math.max(0.3, aex * nx + aez * nz)), bm = Math.min(1.6, 1 / Math.max(0.3, bex * nx + bez * nz));
    const [anx, anz, bnx, bnz] = [aex * am, aez * am, bex * bm, bez * bm];
    // 壁の面は上の河岸の高さ + 胸壁（QUAY_PARAPET m）まで（写真: ドラード河岸・トゥニ河岸は上の歩道の縁にレンガの手すり壁）
    const P = QUAY_PARAPET, ta = at + P, tb = bt + P;
    w.quad([ax, h0, az], [bx, h0, bz], [bx, tb, bz], [ax, ta, az], [nx, 0, nz], [0, 0], [L / 4, 0], [L / 4, (hb + P) / 4], [0, (ha + P) / 4], brick);
    // 手すり壁の内側の面と上面（厚さ 0.45 m、レンガの笠）
    const T = 0.45, pax = ax - anx * T, paz = az - anz * T, pbx = bx - bnx * T, pbz = bz - bnz * T;
    w.quad([pbx, bt, pbz], [pax, at, paz], [pax, ta, paz], [pbx, tb, pbz], [-nx, 0, -nz], [0, 0], [L / 4, 0], [L / 4, P / 4], [0, P / 4], brick);
    w.quad([ax, ta, az], [pax, ta, paz], [pbx, tb, pbz], [bx, tb, bz], [0, 1, 0], [0, 0], [0, T / 4], [L / 4, T / 4], [L / 4, 0], brick.map((c) => c * 0.85));
    // 足元の石積みの帯（遊歩道から 1.3 m。写真では淡い石の切石の土台の上にレンガが積まれている）。壁の面より 3 cm 手前
    const sa = Math.min(at, ab + 1.3), sb = Math.min(bt, bb + 1.3), ox = nx * 0.03, oz = nz * 0.03;
    if (sa > h0 + 0.5 && sb > h0 + 0.5) w.quad([ax + ox, h0, az + oz], [bx + ox, h0, bz + oz], [bx + ox, sb, bz + oz], [ax + ox, sa, az + oz], [nx, 0, nz], [0, 0], [L / 2, 0], [L / 2, (sb - h0) / 2], [0, (sa - h0) / 2], BANK.quayBase);
    // 手すり壁の内側から河岸の車道の縁までの歩道の板（淡い花崗岩。写真: 河岸の上の歩道。壁の裏の 1 マスの斜面と、並木の下の
    // 航空写真の緑を隠す。上の段の地面より 2 cm 下なので、平らな所では地面の下に隠れる）。板の先の縁は 3 m 下まで垂らす
    const cy = (y) => y - 0.02;
    const uax = ax - aex * ka, uaz = az - aez * ka, ubx = bx - bex * kb, ubz = bz - bez * kb;
    walk.quad([pax, cy(at), paz], [uax, cy(at), uaz], [ubx, cy(bt), ubz], [pbx, cy(bt), pbz], [0, 1, 0], [pax / 2.4, paz / 2.4], [uax / 2.4, uaz / 2.4], [ubx / 2.4, ubz / 2.4], [pbx / 2.4, pbz / 2.4], BANK.quayWalk);
    walk.quad([ubx, cy(bt) - 3, ubz], [uax, cy(at) - 3, uaz], [uax, cy(at), uaz], [ubx, cy(bt), ubz], [-nx, 0, -nz], [0, 0], [L / 2.4, 0], [L / 2.4, 1.25], [0, 1.25], BANK.quayWalk);
    if (q.fill) {
      const F = q.fill.map(([x, z]) => [x, cy(at), z]);
      for (let i = 1; i + 1 < F.length; i++) walk.tri(F[0], F[i], F[i + 1], [0, 1, 0], [F[0][0] / 2.4, F[0][2] / 2.4], [F[i][0] / 2.4, F[i][2] / 2.4], [F[i + 1][0] / 2.4, F[i + 1][2] / 2.4], BANK.quayWalk);
    }
  }
  const g = new THREE.Group();
  g.name = 'quay-walls';
  for (const [writer, mat] of [[w, mats.quai], [walk, mats.quayWalk]]) {
    const m = new THREE.Mesh(writer.toGeometry(), mat);
    m.castShadow = writer === w;
    m.receiveShadow = true;
    g.add(m);
  }
  return g;
}

// 地面の板と水（エリア全体で 1 回だけ作る）。地形があるときは、平らな板の代わりに遠くの地面（読み込んだタイルの中は
// タイルの地面 terrainmesh.js の buildTerrainTile が描く。layout: タイルの並び。far.setTile で印を付ける）
export function buildGroundBase(parsed, rect, mats, terrain = FLAT_TERRAIN, layout = null) {
  const group = new THREE.Group();
  group.name = 'ground';
  const T = terrain || FLAT_TERRAIN;
  let far = null;

  // ---- 地面（水面部分はステンシルで抜く） ----
  // 1 枚の巨大な三角形だと深度の補間の誤差で上に重ねた道路の面が隠れることがあるので、約 250 m ごとに分ける
  if (T.flat) {
    const big = 3000;
    const sw = rect.maxX - rect.minX + big * 2, sh = rect.maxZ - rect.minZ + big * 2;
    const g = new THREE.PlaneGeometry(sw, sh, Math.ceil(sw / 250), Math.ceil(sh / 250));
    g.rotateX(-Math.PI / 2);
    const uv = g.attributes.uv;
    const sx = (rect.maxX - rect.minX + big * 2) / 6, sz = (rect.maxZ - rect.minZ + big * 2) / 6;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * sx, uv.getY(i) * sz);
    const ground = new THREE.Mesh(g, mats.ground);
    ground.position.set((rect.minX + rect.maxX) / 2, 0, (rect.minZ + rect.maxZ) / 2);
    ground.receiveShadow = true;
    ground.renderOrder = ORDER.ground;
    ground.name = 'ground-plane';
    group.add(ground);
  }
  // ---- 水 ----
  const water = parsed.areas.filter((a) => a.type === 'water');
  const waterGrid = new Grid(50);
  water.forEach((a, i) => waterGrid.insertBounds(a.bounds.minX, a.bounds.minZ, a.bounds.maxX, a.bounds.maxZ, i));
  const inWater = (x, z) => {
    let hit = false;
    waterGrid.queryPoint(x, z, 0, (i) => {
      if (!hit && pointInPolygon(x, z, water[i])) hit = true;
    });
    return hit;
  };
  const waterDepthAt = (x, z) => {
    let d = 0;
    waterGrid.queryPoint(x, z, 0, (i) => {
      if (water[i].depth > d && pointInPolygon(x, z, water[i])) d = water[i].depth;
    });
    return d;
  };
  // 地形の手直し（エリアで 1 回だけ。地面・道路・橋を作る前に）: 車道の縦断面でならし、旧市街のまわりの岸壁を段差に戻す
  if (!T.flat && !T.conditioned) {
    T.conditioned = true;
    // メトロの出入口: 地形モデルに写った吹き抜けの穴を周りの高さで埋める（穴は下でステンシルにして、中に階段を作る）
    // 狭い通りの車道の中に落ちたメトロの階段は捨てる（LiDAR の穴の見誤り。利用者の写真 NCM_0095: Rue Bertrand de l'Isle の車道の
    // 真ん中に階段ができていた）。駐車場の坂は車道から下りるので残す。広い通り・並木道は真ん中の遊歩道に出入口があるので見ない
    const carSegs = [];
    for (const r of parsed.roads) {
      if (!CAR_ROADS.has(r.type) || r.bridge || r.tunnel || r.width > 5) continue;
      for (let i = 0; i + 1 < r.pts.length; i++) carSegs.push([...r.pts[i], ...r.pts[i + 1], r.width / 2]);
    }
    const inCarriageway = (x, z) => carSegs.some(([ax, az, bx, bz, h]) => x > Math.min(ax, bx) - h && x < Math.max(ax, bx) + h && z > Math.min(az, bz) - h && z < Math.max(az, bz) + h && closestOnSegment(x, z, ax, az, bx, bz).d2 < h * h);
    T.metro = projectEntrances(T.metroRaw, T.proj).filter((e) => !inWater(e.x, e.z) && !(e.kind === 'metro' && inCarriageway(e.x, e.z)));
    orientRamps(T.metro, parsed.roads);
    fillMetroPits(T, T.metro);
    conditionRoads(T, parsed.roads, inWater);
    // ブリエンヌ運河の岸は草の土手（利用者の写真 NCM_0186）。地形の段を岸壁にしない
    const brienne = parsed.proj ? BRIENNE.line.map((ll) => parsed.proj.project(...ll)) : [];
    const onBrienne = (x, z) => brienne.some((p, i) => i + 1 < brienne.length && closestOnSegment(x, z, ...p, ...brienne[i + 1]).d2 < 25 * 25);
    const quays = sharpenQuays(T, parsed.proj ? parsed.proj.project(...QUAY_LATLON) : [-250, 0], QUAY_RADIUS + 150, { inWater, paths: parsed.roads })
      .filter((q) => !onBrienne((q.ax + q.bx) / 2, (q.az + q.bz) / 2));
    T.setQuayWalls(parsed.proj ? quays.concat(quayLinks(quays, parsed.proj)) : quays);
    despike(T);
  }
  if (!T.flat && T.quayWalls.length) group.add(buildQuayWalls(T.quayWalls, mats));
  if (!T.flat && T.metro.length) {
    // メトロの出入口の吹き抜け: 水と同じステンシルの穴（地面のあとに深度テスト付きで印を付け、その所の深度を一番奥に戻す）
    const hole = new MeshWriter();
    writeEntranceMasks(hole, T.metro);
    const geo = hole.toGeometry();
    const m = new THREE.Mesh(geo, mats.waterMask);
    m.renderOrder = TERRAIN_ORDER.mask;
    m.name = 'metro-mask';
    const r = new THREE.Mesh(geo, mats.terrain.maskReset);
    r.renderOrder = TERRAIN_ORDER.maskReset;
    r.name = 'metro-mask-reset';
    group.add(m, r, buildMetroEntrances(T.metro, mats.metro));
  }
  const bankTrees = []; // 街の外れの土手に植える木 { x, z, y, h, r }
  {
    // 地形があるとき: 水面は本当の水面の高さ（堰・閘門の段差の所だけ細かく分ける）。岸は、相対の高さ（陸 0、水面 −d）を
    // 本当の岸の高さ（地面）から水面までに引き延ばす（水面より下はそのまま）
    let cur = null;
    const bankY = (x, y, z) => {
      const d = cur.depth, wl = T.waterLevel(x, z, cur), ht = Math.max(T.h(x, z), wl + 0.3);
      return y >= -d ? wl + ((y + d) * (ht - wl)) / d : wl + (y + d);
    };
    const tf = !T.flat;
    const bankOpts = tf ? { map: bankY, maxEdge: 8 } : {};
    // 水の穴の形: 地面（川の上は岸から延ばしたなめらかな面）から 0.5 m 浮かせ、辺 15 m 以下に分けて載せる
    // （地面より下だと穴があかない。辺 30 m では三角形の間で地面が穴の面より上に出て、水面に細い線が見えた。
    // 地面の格子どおりに切るとガロンヌ川全体で 80 万枚を超える）
    // 地面が三角形の平面より上に出る所（岸・堰の近く）だけ、辺 4 m まで細かく分ける
    const bulge = (A, B, C) => {
      const ha = T.h(A[0], A[2]), hb = T.h(B[0], B[2]), hc = T.h(C[0], C[2]);
      for (const [a, b] of MASK_SAMPLES) {
        const c = 1 - a - b;
        if (T.h(A[0] * c + B[0] * a + C[0] * b, A[2] * c + B[2] * a + C[2] * b) - (ha * c + hb * a + hc * b) > 0.3) return true;
      }
      return false;
    };
    const mask = new MeshWriter(tf ? { map: (x, y, z) => T.h(x, z) + 0.5, maxEdge: 4, split: (A, B, C) => bulge(A, B, C) || Math.max((A[0] - B[0]) ** 2 + (A[2] - B[2]) ** 2, (B[0] - C[0]) ** 2 + (B[2] - C[2]) ** 2, (C[0] - A[0]) ** 2 + (C[2] - A[2]) ** 2) > 225 } : {});
    const surface = new MeshWriter(tf ? {
      // 堰・閘門の段差の所だけ細かく分ける（下流の流れる区間のゆるい傾きは三角形の平面のままでよい）
      map: (x, y, z) => T.waterLevel(x, z, cur), maxEdge: 6,
      split: (A, B, C) => {
        const a = T.waterLevel(A[0], A[2], cur), b = T.waterLevel(B[0], B[2], cur), c = T.waterLevel(C[0], C[2], cur);
        const M = T.waterLevel((A[0] + B[0] + C[0]) / 3, (A[2] + B[2] + C[2]) / 3, cur);
        return Math.max(a, b, c) - Math.min(a, b, c) > 0.5 || Math.abs(M - (a + b + c) / 3) > 0.15;
      },
    } : {});
    const walls = new MeshWriter(bankOpts);
    const stoneWalls = new MeshWriter(bankOpts);
    const bank = new MeshWriter(bankOpts);
    const quayCentre = parsed.proj ? parsed.proj.project(...QUAY_LATLON) : [-250, 0];
    const port = parsed.proj ? parsed.proj.project(...PORT_SAUVEUR.latlon) : null;
    const inPort = (x, z) => port && Math.abs(x - port[0]) < PORT_SAUVEUR.hx && Math.abs(z - port[1]) < PORT_SAUVEUR.hz;
    const brienne = parsed.proj ? BRIENNE.line.map((ll) => parsed.proj.project(...ll)) : null;
    const inBrienne = (x, z) => brienne && brienne.some((p, i) => i + 1 < brienne.length && closestOnSegment(x, z, ...p, ...brienne[i + 1]).d2 < BRIENNE.reach ** 2);
    const jg = parsed.proj ? parsed.proj.project(...JGARDEN_POND) : null;
    const inJGarden = (x, z) => jg && Math.hypot(x - jg[0], z - jg[1]) < 45;
    // 閘門の閘室（monuments.js の writeLock が石の壁を作る）の岸には土手を作らない
    const locks = parsed.proj ? LOCKS.map((l) => ({ l, f: lockFrame(parsed.proj.project(...l.a), parsed.proj.project(...l.b)) })) : [];
    const inLock = (x, z) => locks.some(({ l, f }) => {
      const [u, v] = f.uv(x, z);
      return u > l.from - 2 && u < f.L + 2 && Math.abs(v) < l.width / 2 + 4;
    });
    const edge = new MeshWriter(bankOpts);
    const onRectEdge = (p, q) => {
      const e = 0.01;
      return (Math.abs(p[0] - rect.minX) < e && Math.abs(q[0] - rect.minX) < e) ||
        (Math.abs(p[0] - rect.maxX) < e && Math.abs(q[0] - rect.maxX) < e) ||
        (Math.abs(p[1] - rect.minZ) < e && Math.abs(q[1] - rect.minZ) < e) ||
        (Math.abs(p[1] - rect.maxZ) < e && Math.abs(q[1] - rect.maxZ) < e);
    };
    const quaiColor = (a) => (a.kind === 'river' ? c3('#b47c64') : c3('#b3aa9a'));
    // 運河の岸は橋の近くだけ垂直の石の壁にする
    const bridgeGrid = new Grid(40);
    const bridgeSegs = [];
    for (const r of parsed.roads) {
      if (!r.bridge || r.tunnel) continue;
      for (let i = 0; i + 1 < r.pts.length; i++) {
        bridgeGrid.insertSegment(r.pts[i][0], r.pts[i][1], r.pts[i + 1][0], r.pts[i + 1][1], bridgeSegs.length);
        bridgeSegs.push([r.pts[i][0], r.pts[i][1], r.pts[i + 1][0], r.pts[i + 1][1], r.width / 2]);
      }
    }
    const nearBridge = (x, z, d) => {
      let hit = false;
      bridgeGrid.queryPoint(x, z, d + 10, (i) => {
        const [ax, az, bx, bz, h] = bridgeSegs[i];
        if (!hit && closestOnSegment(x, z, ax, az, bx, bz).d2 < (d + h) ** 2) hit = true;
      });
      return hit;
    };
    // 辺ごとの岸の形
    const profileOf = (a, mx, mz, chunk, isHole) => {
      // 中州（穴）の岸は草の土手
      // 橋の下とその両脇（橋の端から 9 m）は、土手ではなく垂直の石の橋台（端のアーチが土手に埋まらないように）
      if (a.kind === 'river' && a.depth >= 9) {
        if (!isHole && Math.hypot(mx - quayCentre[0], mz - quayCentre[1]) < QUAY_RADIUS) return 'quay';
        return nearBridge(mx, mz, 9) ? 'wall' : 'natural';
      }
      // 日本庭園の池は芝と石の自然な岸（利用者の写真 NCM_0122）
      if (a.kind === 'pond' && inJGarden(mx, mz)) return 'slope';
      if (a.kind === 'canal') {
        if (inLock(mx, mz)) return null;
        if (a.tags.water !== 'canal' || nearBridge(mx, mz, 14) || inPort(mx, mz)) return 'wall';
        if (inBrienne(mx, mz)) return 'slope';
        // 岸の形は 500 m ほどの区間ごとに（両岸で別々に決まる）
        return hash01(((a.id | 0) * 131 + chunk) | 0, 7) < 0.45 ? 'slope' : 'step';
      }
      return 'old';
    };
    // stepOnly: 橋の下を埋めたパッチ（陸との岸は作らず、隣の浅い水との段差の壁だけ）
    const writeQuai = (ring0, isHole, a, stepOnly = false) => {
      const ring = subdivideRing(ring0, tf ? 7 : 10);
      const s = signedArea(ring) > 0 ? 1 : -1;
      const d = a.depth, n = ring.length;
      // 辺ごとの水側の向き（外周なら内向き、島（穴）なら外向き）と、頂点ごとの斜めの向き（隣の辺の向きの平均）
      const nrm = [];
      for (let i = 0; i < n; i++) {
        const p = ring[i], q = ring[(i + 1) % n];
        const L = Math.hypot(q[0] - p[0], q[1] - p[1]) || 1;
        const ox = ((q[1] - p[1]) / L) * s, oz = (-(q[0] - p[0]) / L) * s; // リング自身の外向き
        nrm.push(isHole ? [ox, oz] : [-ox, -oz]);
      }
      const miter = nrm.map((b, i) => {
        const a2 = nrm[(i + n - 1) % n];
        let mx = a2[0] + b[0], mz = a2[1] + b[1];
        const ml = Math.hypot(mx, mz);
        if (ml < 1e-6) return b;
        mx /= ml;
        mz /= ml;
        const k = 1 / Math.max(0.77, mx * b[0] + mz * b[1]); // 尖った角で土手が長く伸びないように 1.3 倍まで
        return [mx * k, mz * k];
      });
      // 1 回目: 辺ごとの岸の形と、街の外れの川岸の土手の幅
      const prof = [], wid = [], nds = [];
      let acc = 0;
      for (let i = 0; i < n; i++) {
        const p = ring[i], q = ring[(i + 1) % n];
        const L = Math.hypot(q[0] - p[0], q[1] - p[1]);
        const [nx, nz] = nrm[i];
        const cx = (p[0] + q[0]) / 2, cz = (p[1] + q[1]) / 2;
        const nd = waterDepthAt(cx - nx * 0.6, cz - nz * 0.6); // 岸の向こう側の水の深さ（陸なら 0）
        let kind = null;
        // 範囲の端・ごく短い辺・隣が同じ深さ以上の水（ポリゴンの継ぎ目）の辺には岸を作らない。隣が浅い水なら段差の壁
        if (!onRectEdge(p, q) && L >= 0.05 && nd < d - 0.01) {
          if (nd > 0) kind = 'drop';
          else if (!stepOnly) kind = profileOf(a, cx, cz, Math.floor(acc / 500), isHole);
        } else if (stepOnly && L >= 0.05 && nd > d + 0.01) {
          kind = 'rise'; // 運河の口のパッチの、深い川に面した縁: 川の水面まで下りる外向きの壁
        }
        let W = 16;
        if (kind === 'natural') {
          // 向こう岸（または中州）までの距離の 4 割まで（狭い流れで両岸の土手がぶつからないように）
          for (let t = 4; t <= 40; t += 4) {
            if (!inWater(cx + nx * t, cz + nz * t)) {
              W = Math.max(5, Math.min(16, 0.42 * t));
              break;
            }
          }
        }
        prof.push(kind);
        wid.push(W);
        nds.push(nd);
        acc += L;
      }
      const vw = bankVertexWidths(prof, wid);
      // 2 回目: 岸を作る
      acc = 0;
      let nextPilaster = 8 + hash01(a.id | 0, 3) * 20, nextTree = hash01(a.id | 0, 4) * 8;
      for (let i = 0; i < n; i++) {
        const p = ring[i], q = ring[(i + 1) % n];
        const dx = q[0] - p[0], dz = q[1] - p[1];
        const L = Math.hypot(dx, dz);
        const [nx, nz] = nrm[i];
        const kind = prof[i];
        if (!kind) {
          acc += L;
          continue;
        }
        const mp = miter[i], mq = miter[(i + 1) % n];
        const u0 = acc / 4, u1 = (acc + L) / 4;
        const at = (v, m, off, y) => [v[0] + m[0] * off, y, v[1] + m[1] * off];
        // 縦の帯（off: 岸からの水側への距離、y の関数）
        const band = (w, y0, y1, off0, off1, col, stone, nn = [nx, 0, nz]) => {
          const ku = stone ? 2 : 1, kv = stone ? 5 : 1;
          w.quad(at(p, mp, off0, y0), at(q, mq, off0, y0), at(q, mq, off1, y1), at(p, mp, off1, y1), nn,
            [u0 / ku, y0 / 4 / kv], [u1 / ku, y0 / 4 / kv], [u1 / ku, y1 / 4 / kv], [u0 / ku, y1 / 4 / kv], col);
        };
        // 水平の帯（y の高さで off0〜off1）
        const flat = (w, y, off0, off1, col, up = true) => w.quad(at(p, mp, off0, y), at(q, mq, off0, y), at(q, mq, off1, y), at(p, mp, off1, y), [0, up ? 1 : -1, 0],
          [u0, off0 / 4], [u1, off0 / 4], [u1, off1 / 4], [u0, off1 / 4], col);
        // 斜面（草の土手）。uv は地面と同じく真上から
        // （offQ0/offQ1: q の側の距離が違うとき）
        const slope = (y0, y1, off0, off1, col, offQ0 = off0, offQ1 = off1) => {
          const a0 = at(p, mp, off0, y0), b0 = at(q, mq, offQ0, y0), b1 = at(q, mq, offQ1, y1), a1 = at(p, mp, off1, y1);
          const h = y0 - y1, w2 = (off1 - off0 + offQ1 - offQ0) / 2, hl = Math.hypot(h, w2) || 1;
          const uv = (v) => [v[0] / 6, -v[2] / 6];
          // 頂点ごとに明るさと色味を少しゆらす（位置から決めるので、隣の辺と共有する頂点は同じ色）
          const tint = (v) => {
            const hs = (Math.round(v[0] * 4) * 73856093) ^ (Math.round(v[2] * 4) * 19349663);
            const k = 0.86 + hash01(hs | 0, 11) * 0.26, g = 0.94 + hash01(hs | 0, 12) * 0.12;
            return [col[0] * k, col[1] * k * g, col[2] * k];
          };
          bank.quad(a0, b0, b1, a1, [(nx * h) / hl, w2 / hl, (nz * h) / hl], uv(a0), uv(b0), uv(b1), uv(a1), [tint(a0), tint(b0), tint(b1), tint(a1)]);
        };
        let edge0 = 0, edge1 = null; // 水面の陰を始める岸からの距離（edge1: q の側が違うとき）
        if (kind === 'quay') {
          // レンガの高い岸壁（少し傾いて立つ）: 明るい石の根石、レンガ、石の笠石（8 cm 張り出す）、30〜40 m ごとの付け柱
          const H = d + 0.6, BAT = 0.35;
          const off = (y) => (BAT * -y) / H;
          const k = 0.94 + hash01(((a.id | 0) * 977 + Math.floor(acc / 40)) | 0, 5) * 0.1;
          const t = hash01(((a.id | 0) * 613 + Math.floor(acc / 90)) | 0, 9);
          const brick = BANK.brickA.map((c, j) => (c * (1 - t) + BANK.brickB[j] * t) * k);
          const lean = [nx, BAT / H, nz];
          band(walls, -H, -d + 1.1, off(-H), off(-d + 1.1), BANK.quayBase, true, lean);
          band(walls, -d + 1.1, -0.5, off(-d + 1.1), off(-0.5), brick, false, lean);
          band(walls, -0.5, 0, off(-0.5) + 0.08, 0.08, BANK.quayCoping, true);
          flat(walls, -0.5, off(-0.5), off(-0.5) + 0.08, BANK.quayCoping, false);
          flat(walls, 0, 0, 0.08, BANK.quayCoping);
          // 付け柱（幅 1.4 m、22 cm 張り出す）
          const ex = dx / (L || 1), ez = dz / (L || 1);
          while (nextPilaster < acc + L - 0.7) {
            if (nextPilaster < acc + 0.7) nextPilaster = acc + 0.7;
            if (nextPilaster > acc + L - 0.7) break;
            const tc = nextPilaster - acc;
            const c = [p[0] + ex * tc, p[1] + ez * tc];
            const y0 = -d + 1.1, y1 = -0.5;
            const P = (side, y, extra) => [c[0] + ex * side * 0.7 + nx * (off(y) + extra), y, c[1] + ez * side * 0.7 + nz * (off(y) + extra)];
            const pc = brick.map((v) => v * 1.06);
            walls.quad(P(-1, y0, 0.22), P(1, y0, 0.22), P(1, y1, 0.22), P(-1, y1, 0.22), lean, [0, y0 / 4], [0.35, y0 / 4], [0.35, y1 / 4], [0, y1 / 4], pc);
            for (const side of [-1, 1]) {
              walls.quad(P(side, y0, 0), P(side, y0, 0.22), P(side, y1, 0.22), P(side, y1, 0), [ex * side, 0, ez * side], [0, y0 / 4], [0.05, y0 / 4], [0.05, y1 / 4], [0, y1 / 4], pc);
            }
            nextPilaster += 36;
          }
          edge0 = off(-d);
        } else if (kind === 'natural') {
          // 街の外れの川岸: 幅 5〜16 m の草の斜面の土手（途中に小段、水際は土のゆるい斜面）。幅は頂点ごと
          const Wp = vw[i], Wq = vw[(i + 1) % n], last = NATURAL.length - 2;
          for (let k = 0; k <= last; k++) {
            const [f0, g0] = NATURAL[k], [f1, g1] = NATURAL[k + 1];
            slope(naturalY(g0, d), naturalY(g1, d), f0 * Wp, f1 * Wp, k === last ? BANK.earth : k === last - 1 ? BANK.grassLow : BANK.grass, f0 * Wq, f1 * Wq);
          }
          // 水面の陰は、頂点ごとの土手の幅から（隣の辺の陰と頂点でつながるように）
          const toe = 0.75 + (0.25 * 0.18 * d) / (0.18 * d + 0.3);
          edge0 = Wp * toe;
          edge1 = Wq * toe;
          // 土手の上の斜面と小段に、川辺の木（位置から決める。橋のそばには植えない）
          while (nextTree < acc + L) {
            const t = (nextTree - acc) / (L || 1);
            const x0 = p[0] + dx * t, z0 = p[1] + dz * t;
            const hs = ((Math.round(x0) * 73856093) ^ (Math.round(z0) * 19349663)) | 0;
            const f = 0.06 + hash01(hs, 2) * 0.36, Wt = Wp + (Wq - Wp) * t;
            const x = x0 + nx * f * Wt, z = z0 + nz * f * Wt;
            if (hash01(hs, 1) < 0.62 && Wt >= 6 && !nearBridge(x, z, 8)) {
              bankTrees.push({ x, z, y: tf ? bankY(x, naturalHeight(f, d), z) : naturalHeight(f, d), abs: tf, h: 10 + hash01(hs, 3) * 8, r: 2.8 + hash01(hs, 4) * 2 });
            }
            nextTree += 6 + hash01(hs, 5) * 6;
          }
        } else if (kind === 'slope') {
          // 運河: 水に直接入る草の斜面
          const W = 3.6, yb = -d - 0.25;
          slope(0, yb * 0.6, 0, W * 0.6, BANK.grass);
          slope(yb * 0.6, yb, W * 0.6, W, BANK.earth);
          edge0 = (W * d) / (d + 0.25);
        } else if (kind === 'step') {
          // 運河: 草の土手の下に、石の笠石を載せた高さ約 1 m の低い石積み
          const W1 = 2.0, yS = -(d - 1.0);
          slope(0, yS, 0, W1, BANK.grass);
          flat(stoneWalls, yS, W1, W1 + 0.45, BANK.canalCoping);
          band(stoneWalls, yS - 0.25, yS, W1 + 0.45, W1 + 0.45, BANK.canalCoping, false);
          flat(stoneWalls, yS - 0.25, W1 + 0.4, W1 + 0.45, BANK.canalCoping, false);
          band(stoneWalls, -d - 0.3, yS - 0.25, W1 + 0.4, W1 + 0.4, BANK.canalLow, false);
          edge0 = W1 + 0.4;
        } else if (kind === 'wall') {
          // 運河の橋・閘門の近く: 高さいっぱいの石の壁と笠石
          band(stoneWalls, -d - 0.3, -0.3, 0, 0, BANK.canalStone, false);
          band(stoneWalls, -0.3, 0, 0.06, 0.06, BANK.canalCoping, false);
          flat(stoneWalls, -0.3, 0, 0.06, BANK.canalCoping, false);
          flat(stoneWalls, 0, 0, 0.06, BANK.canalCoping);
        } else if (kind === 'drop') {
          // 隣の浅い水（支流・運河の口・池）との水面の段差: 隣の水面から下の石の壁（堰のよう）
          band(stoneWalls, -d - 0.6, -nds[i], 0, 0, BANK.drop, false);
        } else if (kind === 'rise') {
          // 橋の下のパッチ（浅い水）から、隣の深い水の底まで下りる壁。深い水の側を向く
          band(stoneWalls, -nds[i] - 0.6, -d, 0, 0, BANK.drop, false, [-nx, 0, -nz]);
          acc += L;
          continue;
        } else {
          band(walls, -d - 0.6, 0, 0, 0, quaiColor(a), false);
        }
        // 岸の際の水面を暗く（幅は川で 7 m、運河・池で 3 m。v = 0 が岸の際）
        const w = a.kind === 'river' ? 7 : 3, yw = -d + 0.01;
        const e1 = edge1 ?? edge0;
        edge.quad(at(p, mp, edge0, yw), at(q, mq, e1, yw), [q[0] + mq[0] * e1 + nx * w, yw, q[1] + mq[1] * e1 + nz * w], [p[0] + mp[0] * edge0 + nx * w, yw, p[1] + mp[1] * edge0 + nz * w], [0, 1, 0],
          [0.5, 0], [0.5, 0], [0.5, 1], [0.5, 1]);
        acc += L;
      }
      // 岸の形が変わる頂点で、土手の斜面の切り口をふさぐ（両面）。川の土手は石の袖壁、運河の土手は土の色
      for (let i = 0; i < n; i++) {
        const k0 = prof[(i + n - 1) % n], k1 = prof[i];
        if (k0 === k1) continue;
        for (const kind of [k0, k1]) {
          const sec = bankSection(kind, d, vw[i]);
          if (!sec) continue;
          const v = ring[i], m = miter[i];
          const tx = -m[1], tz = m[0], tl = Math.hypot(tx, tz) || 1;
          const P = ([o, y]) => [v[0] + m[0] * o, y, v[1] + m[1] * o];
          const wing = kind === 'natural';
          for (let j = 1; j + 1 < sec.length; j++) {
            const T = ([o, y]) => [o / 4, y / 4];
            for (const sg of [1, -1]) {
              if (wing) stoneWalls.tri(P(sec[0]), P(sec[j]), P(sec[j + 1]), [(tx / tl) * sg, 0, (tz / tl) * sg], T(sec[0]), T(sec[j]), T(sec[j + 1]), BANK.drop);
              // 土の色で、法線を少し上に向けて明るく
              else bank.tri(P(sec[0]), P(sec[j]), P(sec[j + 1]), [(tx / tl) * sg * 0.7, 0.7, (tz / tl) * sg * 0.7], [0, 0], [0.2, 0], [0, 0.2], BANK.earth);
            }
          }
        }
      }
    };
    for (const a of water) {
      cur = a;
      writeFlatPolygon(mask, a.outer, a.holes, 0, 10);
      writeFlatPolygon(surface, a.outer, a.holes, -a.depth, WATER_TILE, WATER_COLOR[a.kind] || WATER_COLOR.canal);
      // 橋の下を埋めたパッチには岸壁を作らない（隣の浅い水との段差の壁だけ）
      if (a.patch) {
        writeQuai(a.outer, false, a, true);
        continue;
      }
      writeQuai(a.outer, false, a);
      for (const h of a.holes) writeQuai(h, true, a);
    }
    if (!mask.empty) {
      // 地形があるときは 500 m ごとに分ける（見えない所の水の穴・水面を描かない）
      const cells = (geo) => (tf ? splitGeometry(geo, 500) : [geo]);
      for (const geo of cells(mask.toGeometry())) {
        const m = new THREE.Mesh(geo, mats.waterMask);
        m.renderOrder = tf ? TERRAIN_ORDER.mask : ORDER.waterMask; // 地形があるときは地面のあと（terrainmesh.js）
        m.name = 'water-mask';
        group.add(m);
        if (tf) {
          // 見えている水の所の深度を一番奥に戻す（地形の深度を先に書いたので、そのままでは水面が隠れる）
          const r = new THREE.Mesh(geo, mats.terrain.maskReset);
          r.renderOrder = TERRAIN_ORDER.maskReset;
          r.name = 'water-mask-reset';
          group.add(r);
        }
      }
      for (const geo of cells(surface.toGeometry())) {
        const s = new THREE.Mesh(geo, mats.water);
        s.renderOrder = ORDER.water;
        s.receiveShadow = true;
        s.name = 'water';
        group.add(s);
      }
    }
    if (!walls.empty) {
      const m = new THREE.Mesh(walls.toGeometry(), mats.quai);
      m.renderOrder = ORDER.water;
      m.receiveShadow = true;
      group.add(m);
    }
    if (!stoneWalls.empty) {
      const m = new THREE.Mesh(stoneWalls.toGeometry(), mats.quaiStone || mats.quai);
      m.renderOrder = ORDER.water;
      m.receiveShadow = true;
      m.name = 'stone-walls';
      group.add(m);
    }
    if (!bank.empty && mats.bank) {
      const m = new THREE.Mesh(bank.toGeometry(), mats.bank);
      m.renderOrder = ORDER.water;
      m.receiveShadow = true;
      m.name = 'banks';
      group.add(m);
    }
    if (!edge.empty && mats.waterEdge) {
      const m = new THREE.Mesh(edge.toGeometry(), mats.waterEdge);
      m.renderOrder = ORDER.water + 1;
      m.name = 'water-edge';
      group.add(m);
    }
  }

  if (!T.flat) {
    far = buildFarTerrain(T, rect, mats, layout, { inWater });
    group.add(far.group);
  }
  return { group, water, inWater, waterDepthAt, bankTrees, far };
}

// 緑地・広場・駐車場・道路・線路・橋を、範囲 clip の中だけ作る（広いエリアではタイルごとに呼ぶ）。
// 範囲をまたぐ緑地は切り取り、道路は範囲の端で切る。橋は中ほどの点が範囲に入るものだけ。
// opts.buildings / opts.walls（範囲の建物と隣の建物・塀）があれば、歩道を建物の壁まで延ばす。opts.inOldTown(x, z): 旧市街の判定
// （.ring があれば旧市街の地面の下地も、広場の舗装にも使う）。opts.covered: 地面の覆い（cover.js）のある矩形の配列。その中の緑地と
// 広場は描かない（芝生・木の下・広場の舗装は覆いの方が正確）。ただし運動場（人工芝は近赤外を返さず、覆いでは敷地の中の地面になる）と
// 名前で舗装の決まった広場は残す
export function buildGroundDetail(parsed, clip, mats, waterDepthAt, opts = {}) {
  const it = groundDetailSteps(parsed, clip, mats, waterDepthAt, opts);
  for (;;) {
    const r = it.next();
    if (r.done) return r.value;
  }
}

// buildGroundDetail と同じものを、budget ms ごとに pause() で描画のフレームに譲りながら作る（走行中のタイルの読み込み）
export async function buildGroundDetailAsync(parsed, clip, mats, waterDepthAt, opts, pause, budget = 8) {
  const it = groundDetailSteps(parsed, clip, mats, waterDepthAt, opts);
  let t = performance.now();
  for (;;) {
    const r = it.next();
    if (r.done) return r.value;
    if (performance.now() - t > budget) {
      await pause();
      t = performance.now();
    }
  }
}

function* groundDetailSteps(parsed, clip, mats, waterDepthAt, opts) {
  const covered = opts.covered || [];
  const inOldTown = opts.inOldTown || (() => false);
  const terrain = opts.terrain || FLAT_TERRAIN;
  const group = new THREE.Group();
  group.name = 'ground-detail';
  const writers = new Map();
  const W = (order, tex, set = 'flat') => {
    const k = `${order}|${tex}|${set}`;
    let w = writers.get(k);
    // 地形に載せる（平らな面は 2 cm 浮かせる。一段高い歩道・縁石は y がそのまま地面からの高さ）
    if (!w) writers.set(k, (w = { order, tex, set, w: new MeshWriter({ drape: terrain, lift: set === 'flat' ? DRAPE_LIFT : 0.03 }) }));
    return w.w;
  };
  const plan = planStreets(parsed, opts.inStreetOld || opts.inOldTown); // 通りの石畳（右岸の歴史的な中心）
  const clipRect = [clip.minX, clip.minZ, clip.maxX, clip.maxZ];
  const overlaps = (b) => b.maxX > clip.minX && b.minX < clip.maxX && b.maxZ > clip.minZ && b.minZ < clip.maxZ;

  const greenClips = freeRects(clip, covered); // 覆いのない所（緑地はここだけに描く）
  // ---- 旧市街の地面の下地（小舗石）: 通りの石畳の帯の間（広い交差点・地図にない小さな広場）が土のままにならないように。
  // 建物の中庭も石畳になるが、旧市街の中庭はたいてい舗装なのでよしとする。覆いのある所は覆い（公道・中庭の舗装）にまかせる
  for (const fr of greenClips) {
    for (const r of oldTownBase(opts.inOldTown?.ring, fr)) writeFlatPolygon(W(ORDER.oldTown, 'settsBase'), r, [], 0, 2.56, c3('#f4e2d6'));
  }
  // ---- 緑地・広場・駐車場 ----
  for (const a of parsed.areas) {
    if (a.type === 'water' || !overlaps(a.bounds)) continue;
    const green = a.type !== 'plaza' && a.type !== 'parking' && a.type !== 'pitch';
    const toCover = green || (a.type === 'plaza' && !namedSurface(a)); // 覆いのある所では覆いにまかせる
    for (const r of toCover ? greenClips : [clip]) {
      const b = a.bounds;
      if (!(b.maxX > r.minX && b.minX < r.maxX && b.maxZ > r.minZ && b.minZ < r.maxZ)) continue;
      let outer = a.outer, holes = a.holes;
      if (!(b.minX >= r.minX && b.maxX <= r.maxX && b.minZ >= r.minZ && b.maxZ <= r.maxZ)) {
        outer = clipRingToRect(outer, r.minX, r.minZ, r.maxX, r.maxZ);
        if (outer.length < 3) continue;
        holes = holes.map((h) => clipRingToRect(h, r.minX, r.minZ, r.maxX, r.maxZ)).filter((h) => h.length >= 3);
      }
      if (a.type === 'plaza') {
        const s = plazaSurface(a, inOldTown);
        writeFlatPolygon(W(ORDER.plaza, s.tex), outer, holes, 0, s.uv, s.color);
      } else if (a.type === 'parking') writeFlatPolygon(W(ORDER.parking, 'asphalt'), outer, holes, 0, 4, c3('#d0d0d0'));
      else writeFlatPolygon(W(ORDER.green, 'grass'), outer, holes, 0, 6, GREEN_COLOR[a.type] || GREEN_COLOR.grass);
    }
  }
  // ---- 石の板の並木道 ----
  for (const road of parsed.roads) {
    const sa = !road.tunnel && !road.bridge && SLAB_ALLEES.find((a) => a.name.test(road.name || ''));
    if (!sa) continue;
    for (const pts of clipPolylineToRect(road.pts, ...clipRect)) {
      const w = W(ORDER.plaza, 'slabs');
      writeRibbon(w, pts, sa.half, 0, sa.color, 2.4);
      writeDisc(w, pts[0], sa.half, 0, sa.color, 2.4, 16);
      writeDisc(w, pts[pts.length - 1], sa.half, 0, sa.color, 2.4, 16);
    }
  }
  // ---- ジャン・ジョレス通りの遊歩道（ramblas.js）: 淡いベージュの固めた砂と、車道沿いの植え込みの帯（暗い土に低木）
  const rl = parsed.proj ? ramblasLayout(parsed.roads, parsed.proj) : null;
  if (rl) {
    const rb = ringBounds(rl.ring);
    if (overlaps(rb)) {
      const outer = clipRingToRect(rl.ring, clip.minX, clip.minZ, clip.maxX, clip.maxZ);
      if (outer.length >= 3) writeFlatPolygon(W(ORDER.plaza, 'gravel'), outer, [], 0, 3, c3('#f2eee8'));
    }
    for (const line of rl.beds) {
      for (const pts of clipPolylineToRect(line, ...clipRect)) writeRibbon(W(ORDER.plaza + 0.1, 'grass'), pts, rl.bedHalf, 0, c3('#8a7a5a'), 3);
    }
  }
  // ---- 道路 ----
  // 車道の面・中央の破線はここで、縁石・歩道・旧市街の石畳・横断歩道は streets.js で作る
  const bridges = [];
  const groups = bridgeGroups(parsed.roads);
  for (const road of parsed.roads) {
    if (road.tunnel) continue;
    if (road.bridge) {
      // 並んだ way は親の橋と同じタイルで作る（橋面とアーチ・橋脚が別々に読み込まれないように）
      const root = groups.get(road)?.root || road;
      const mid = root.pts[root.pts.length >> 1];
      if (mid[0] >= clip.minX && mid[0] < clip.maxX && mid[1] >= clip.minZ && mid[1] < clip.maxZ) bridges.push(road);
      continue;
    }
    const kind = plan.info.get(road)?.kind;
    if (kind === 'shared' || kind === 'taur') continue; // 旧市街の石畳は streets.js
    const parts = clipPolylineToRect(road.pts, ...clipRect);
    if (!parts.length) continue;
    const st = roadStyle(road);
    const half = road.width / 2;
    for (const pts of parts) {
      const w = W(st.order, st.tex);
      writeRibbon(w, pts, half, 0, st.color);
      writeDisc(w, pts[0], half, 0, st.color);
      writeDisc(w, pts[pts.length - 1], half, 0, st.color);
    }
  }
  // 縁石・一段高い歩道（建物の壁まで）・旧市街の石畳・側溝・横断歩道と停止線
  const raised = new RaisedIndex();
  const OUT = {
    setts: () => W(ORDER.road - 0.6, 'setts'),
    slabs: () => W(ORDER.road - 0.5, 'slabs'),
    alsace: () => W(ORDER.road - 0.5, 'alsace'),
    gutter: () => W(ORDER.road + 0.5, 'gutter'),
    marking: () => W(ORDER.marking, 'plain'),
    marks: () => W(ORDER.marking + 0.5, 'marks'),
    curb: () => W(ORDER.raised, 'curb', 'raised'),
    sidewalk: () => W(ORDER.raised, 'sidewalk', 'raised'),
    sidewalkRed: () => W(ORDER.raised + 0.1, 'sidewalkRed', 'raised'),
    post: () => W(ORDER.raised + 0.2, 'post', 'raised'),
  };
  yield;
  const streetStats = yield* streetSteps(parsed, plan, clip, { buildings: opts.buildings || [], walls: opts.walls || [], waterDepthAt }, (k) => OUT[k](), raised);

  // ---- 線路（トラム・鉄道） ----
  // トラム（ユーザーの写真 4・5・31・32、Avenue de Grande-Bretagne）: 芝の軌道（線路の間と両側の 3.5 m の帯。複線では
  // 2 本の帯がつながる）、架線柱（灰色の細い柱を約 35 m おき、複線は 2 本の線の真ん中・単線は芝の帯の縁に立てて腕を線路の上へ。
  // 車道・横断歩道を横切る所には立てない）と架線（高さ 5.8 m）
  let near = null;
  const carRoads = () => near || (near = plan.roadsNear(clip, 30).filter((r) => CAR_ROADS.has(r.type) && r.type !== 'service' && !r.bridge && !r.tunnel));
  let decks = null;
  const deckRoads = () => decks || (decks = plan.roadsNear(clip, 30).filter((r) => r.bridge && (CAR_ROADS.has(r.type) || /^motorway/.test(r.type))));
  const nearXs = plan.crossings.filter((c) => c.x > clip.minX - 30 && c.x < clip.maxX + 30 && c.z > clip.minZ - 30 && c.z < clip.maxZ + 30);
  // 架線柱は車道・横断歩道を横切る所（芝を切る所と同じ区間）と高架の車道の下に立てない
  const tramPts = writeCatenary(parsed.rails, clip, W(ORDER.raised + 0.2, 'post', 'raised'), (t) => mergeIntervals(tramCrossCuts(t.pts, carRoads(), nearXs).concat(tramCrossCuts(t.pts, deckRoads()))));
  streetStats.postPts.push(...tramPts);
  for (const r of parsed.rails) {
    if (r.bridge) continue;
    for (const pts of clipPolylineToRect(r.pts, ...clipRect)) {
      if (r.type === 'rail') writeRibbon(W(ORDER.rail - 0.5, 'gravel'), pts, 1.5, 0, c3('#9a9088'));
      // トラムの芝の軌道は車道の標示（中央分離帯に重なる車線の線）より上に描き、線を隠す
      else if (r.type === 'tram') {
        // 車道・横断歩道を横切る所は芝を切る（路面のアスファルトと横断歩道が見える）。レールだけ通す
        const cum = pts.reduce((c, p, i) => (i ? [...c, c[i - 1] + Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1])] : [0]), []);
        // 高架の車道の下は芝でなくコンクリートの軌道敷（利用者の Street View 225619: A620 の下）
        const under = tramCrossCuts(pts, deckRoads());
        const cuts = mergeIntervals(tramCrossCuts(pts, carRoads(), nearXs).concat(under));
        for (const [a, b] of subtract(0, cum[cum.length - 1], cuts)) {
          if (b - a > 0.3) writeRibbon(W(ORDER.marking + 0.7, 'grass'), slicePolyline(pts, cum, a, b), 1.75, 0, GREEN_COLOR.grass, 6);
        }
        for (const [a, b] of under) {
          const lo = Math.max(0, a), hi = Math.min(cum[cum.length - 1], b);
          if (hi - lo > 0.3) writeRibbon(W(ORDER.marking + 0.7, 'plain'), slicePolyline(pts, cum, lo, hi), 1.75, 0, c3('#8e8c88'));
        }
      }
      const { L, R } = offsets(pts, 0.72);
      const ro = r.type === 'tram' ? ORDER.marking + 0.8 : ORDER.rail;
      writeRibbon(W(ro, 'plain'), L, 0.06, 0, c3('#55585c'));
      writeRibbon(W(ro, 'plain'), R, 0.06, 0, c3('#55585c'));
    }
  }

  for (const { order, tex, set, w } of writers.values()) {
    if (w.empty) continue;
    yield; // 面ごとに譲る（大きな面の toGeometry は重い）
    const m = new THREE.Mesh(w.toGeometry(), mats[set][tex]);
    m.renderOrder = order;
    m.receiveShadow = true;
    m.matrixAutoUpdate = false;
    group.add(m);
  }

  // ---- 橋 ----
  const big = [clip.minX - 2000, clip.minZ - 2000, clip.maxX + 2000, clip.maxZ + 2000];
  group.add(buildBridges(bridges, parsed.roads, mats, waterDepthAt, big, terrain));

  // posts: 横断歩道の脇の車止めの位置（当たり判定に足す）
  return { group, bridges, heightAt: (x, z) => raised.heightAt(x, z), streetStats, raised, posts: streetStats.postPts };
}
