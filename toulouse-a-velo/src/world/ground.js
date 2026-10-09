// 地面まわりのメッシュ: 地面、公園・広場・駐車場、道路と歩道、路面標示、線路、水面と河岸の壁、橋。
//
// 地面と同じ高さ (y=0) に重なる面は、深度を書かずに renderOrder の順に塗り重ねる（Z ファイティング防止）。
// 一段高い歩道と縁石（streets.js）は深度を書き、平らな面をすべて塗った後に描く（下に隠れた車道は描かれない）。
// 川や運河は地面より低い位置に水面を置き、ステンシルで地面に「穴」をあけて見せる。
import * as THREE from 'three';
import { MeshWriter, writeFlatPolygon } from './meshwriter.js';
import { COVER_COLORS, createCoverShared } from './cover.js';
import { CAR_ROADS } from './parse.js';
import { Grid, centroid, clipPolylineToRect, clipRingToRect, closestOnSegment, freeRects, hash01, pointInPolygon, signedArea } from '../geo.js';
import { RaisedIndex, oldTownBase, planStreets, streetSteps } from './streets.js';
import { bridgeGroups, buildBridges } from './bridges.js';

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
];
const namedSurface = (area) => PLAZA_SURFACES.find((p) => p.match.test(area.name || ''));
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
  return {
    flat: {
      asphalt: flat(tex.asphalt),
      paving: flat(tex.paving),
      sidewalk: flat(tex.sidewalk),
      setts: flat(tex.setts),
      // 旧市街の地面の下地: 地面と同じく水面の穴（ステンシル）には描かない
      settsBase: flat(tex.setts, { stencilWrite: true, stencilRef: 1, stencilFunc: THREE.NotEqualStencilFunc, stencilFail: THREE.KeepStencilOp, stencilZFail: THREE.KeepStencilOp, stencilZPass: THREE.KeepStencilOp }),
      slabs: flat(tex.slabs),
      gutter: flat(tex.gutter),
      grass: flat(tex.grass),
      gravel: flat(tex.gravel),
      plain: flat(null),
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
    waterMask: new THREE.MeshBasicMaterial({
      colorWrite: false,
      depthWrite: false,
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
    // 草の土手（運河・街の外れの川岸の斜面）
    bank: new THREE.MeshLambertMaterial({ map: tex.grass, vertexColors: true }),
    deck: new THREE.MeshStandardMaterial({ map: tex.asphalt, vertexColors: true, roughness: 0.95, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -6 }),
    bridge: new THREE.MeshStandardMaterial({ map: tex.plain, vertexColors: true, roughness: 0.9 }),
    cover: createCoverShared(tex, ORDER.cover),
  };
}

// 水面: ガロンヌ川はにごったオリーブ色の灰緑（写真 #4b5642〜#7b888a）、運河は暗い緑（#45523a）。色は頂点カラーで付ける。
// 波の法線マップは 6 m ごとに繰り返し、大きさと向きの違う 2 枚を別々に流して、同じ模様の繰り返しを見えなくする。
// 波は弱く（流れのゆるい川面）、少し粗くして空の映り込みをぼかす。空の映り込みは物理どおり真上からはほとんど映らず、
// 斜めから見るほど強い（強さは main.js で水だけ別に決める）。にごった水に映る空は青くなく灰緑に見えるので、映り込みの色を
// 灰色に寄せて水の色を少し掛ける
const WATER_TILE = 6; // 波の法線マップ 1 枚の大きさ（m）
const WATER_COLOR = { river: c3('#4f5a46'), canal: c3('#424e37'), pond: c3('#4a5540') };
function waterMaterial(normalMap) {
  const m = new THREE.MeshStandardMaterial({
    color: '#ffffff', vertexColors: true, roughness: 0.13, metalness: 0,
    normalMap, normalScale: new THREE.Vector2(0.06, 0.06),
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
          radiance = mix(vec3(dot(radiance, vec3(0.2126, 0.7152, 0.0722))), radiance, 0.3) * vec3(0.9, 1.0, 0.93);
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

function writeDashes(w, pts, dash, gap, width, y, color) {
  const up = [0, 1, 0];
  let carry = 0;
  for (let i = 0; i + 1 < pts.length; i++) {
    const [ax, az] = pts[i], [bx, bz] = pts[i + 1];
    const len = Math.hypot(bx - ax, bz - az);
    if (len < 0.01) continue;
    const ux = (bx - ax) / len, uz = (bz - az) / len;
    const nx = -uz * width / 2, nz = ux * width / 2;
    let s = carry;
    while (s < len) {
      const e = Math.min(len, s + dash);
      const p0 = [ax + ux * s, az + uz * s], p1 = [ax + ux * e, az + uz * e];
      w.quad([p0[0] + nx, y, p0[1] + nz], [p0[0] - nx, y, p0[1] - nz], [p1[0] - nx, y, p1[1] - nz], [p1[0] + nx, y, p1[1] + nz], up, [0, 0], [1, 0], [1, 1], [0, 1], color);
      s += dash + gap;
    }
    carry = s - len;
  }
}

export function roadStyle(road) {
  const t = road.type;
  const s = road.surface;
  const paved = /^(paving_stones|sett|cobblestone|unhewn_cobblestone|bricks|stone)$/.test(s);
  const loose = /^(gravel|fine_gravel|compacted|dirt|ground|earth|grass|sand|pebblestone|unpaved)$/.test(s);
  if (t === 'cycleway') return { order: ORDER.cycleway, tex: 'asphalt', color: c3('#8fb59a') };
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

// 地図から生成する地面（エリア全体をまとめて作る）
export function buildGround(parsed, rect, mats, opts = {}) {
  const base = buildGroundBase(parsed, rect, mats);
  const pad = 120;
  const detail = buildGroundDetail(parsed, { minX: rect.minX - pad, minZ: rect.minZ - pad, maxX: rect.maxX + pad, maxZ: rect.maxZ + pad }, mats, base.waterDepthAt, opts);
  base.group.add(detail.group);
  return { ...base, bridges: detail.bridges, heightAt: detail.heightAt, posts: detail.posts };
}

// 岸の形: ガロンヌ川は旧市街のまわり（バザクルからポン・サン・ミシェルの先まで）だけ高いレンガの岸壁、その外は草の土手。
// 運河は草の斜面か、草の土手の下に低い石積み（高さ約 1 m、笠石 #9c7c56）。橋・閘門の近くだけ高さいっぱいの石の壁
// 岸壁の範囲の中心（ポン・ヌフの少し西、緯度・経度）。エリアごとに原点が違うので、そのエリアの投影で座標にする
const QUAY_LATLON = [43.5994, 1.4364], QUAY_RADIUS = 1250;
const BANK = {
  // 岸壁のレンガ（写真の日なた #b89676〜#bb7d4f）、明るい石の根石（#ccc3b4）と笠石。白っぽいテクスチャに掛けるので少し明るく
  brickA: c3('#b89676', 1.16), brickB: c3('#bb7d4f', 1.16), quayBase: c3('#ccc3b4', 1.16), quayCoping: c3('#c9bfae', 1.16),
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

// 地面の板と水（エリア全体で 1 回だけ作る）
export function buildGroundBase(parsed, rect, mats) {
  const group = new THREE.Group();
  group.name = 'ground';

  // ---- 地面（水面部分はステンシルで抜く） ----
  // 1 枚の巨大な三角形だと深度の補間の誤差で上に重ねた道路の面が隠れることがあるので、約 250 m ごとに分ける
  {
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
  const bankTrees = []; // 街の外れの土手に植える木 { x, z, y, h, r }
  {
    const mask = new MeshWriter();
    const surface = new MeshWriter();
    const walls = new MeshWriter();
    const stoneWalls = new MeshWriter();
    const bank = new MeshWriter();
    const quayCentre = parsed.proj ? parsed.proj.project(...QUAY_LATLON) : [-250, 0];
    const edge = new MeshWriter();
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
      if (a.kind === 'canal') {
        if (a.tags.water !== 'canal' || nearBridge(mx, mz, 14)) return 'wall';
        // 岸の形は 500 m ほどの区間ごとに（両岸で別々に決まる）
        return hash01(((a.id | 0) * 131 + chunk) | 0, 7) < 0.45 ? 'slope' : 'step';
      }
      return 'old';
    };
    // stepOnly: 橋の下を埋めたパッチ（陸との岸は作らず、隣の浅い水との段差の壁だけ）
    const writeQuai = (ring0, isHole, a, stepOnly = false) => {
      const ring = subdivideRing(ring0, 10);
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
              bankTrees.push({ x, z, y: naturalHeight(f, d), h: 10 + hash01(hs, 3) * 8, r: 2.8 + hash01(hs, 4) * 2 });
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
      const m = new THREE.Mesh(mask.toGeometry(), mats.waterMask);
      m.renderOrder = ORDER.waterMask;
      m.name = 'water-mask';
      group.add(m);
      const s = new THREE.Mesh(surface.toGeometry(), mats.water);
      s.renderOrder = ORDER.water;
      s.receiveShadow = true;
      s.name = 'water';
      group.add(s);
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

  return { group, water, inWater, waterDepthAt, bankTrees };
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
  const group = new THREE.Group();
  group.name = 'ground-detail';
  const writers = new Map();
  const W = (order, tex, set = 'flat') => {
    const k = `${order}|${tex}|${set}`;
    let w = writers.get(k);
    if (!w) writers.set(k, (w = { order, tex, set, w: new MeshWriter() }));
    return w.w;
  };
  const plan = planStreets(parsed, opts.inOldTown);
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
    const isCar = CAR_ROADS.has(road.type);
    for (const pts of parts) {
      const w = W(st.order, st.tex);
      writeRibbon(w, pts, half, 0, st.color);
      writeDisc(w, pts[0], half, 0, st.color);
      writeDisc(w, pts[pts.length - 1], half, 0, st.color);
      if (isCar && road.width >= 7 && !road.oneway) writeDashes(W(ORDER.marking, 'plain'), pts, 3, 5, 0.15, 0, c3('#f2f2ee'));
    }
  }
  // 縁石・一段高い歩道（建物の壁まで）・旧市街の石畳・側溝・横断歩道と停止線
  const raised = new RaisedIndex();
  const OUT = {
    setts: () => W(ORDER.road - 0.6, 'setts'),
    slabs: () => W(ORDER.road - 0.5, 'slabs'),
    gutter: () => W(ORDER.road + 0.5, 'gutter'),
    marking: () => W(ORDER.marking, 'plain'),
    curb: () => W(ORDER.raised, 'curb', 'raised'),
    sidewalk: () => W(ORDER.raised, 'sidewalk', 'raised'),
    sidewalkRed: () => W(ORDER.raised + 0.1, 'sidewalkRed', 'raised'),
    post: () => W(ORDER.raised + 0.2, 'post', 'raised'),
  };
  yield;
  const streetStats = yield* streetSteps(parsed, plan, clip, { buildings: opts.buildings || [], walls: opts.walls || [], waterDepthAt }, (k) => OUT[k](), raised);

  // ---- 線路（トラム・鉄道） ----
  for (const r of parsed.rails) {
    if (r.bridge) continue;
    for (const pts of clipPolylineToRect(r.pts, ...clipRect)) {
      if (r.type === 'rail') writeRibbon(W(ORDER.rail - 0.5, 'gravel'), pts, 1.5, 0, c3('#9a9088'));
      const { L, R } = offsets(pts, 0.72);
      writeRibbon(W(ORDER.rail, 'plain'), L, 0.06, 0, c3('#55585c'));
      writeRibbon(W(ORDER.rail, 'plain'), R, 0.06, 0, c3('#55585c'));
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
  group.add(buildBridges(bridges, parsed.roads, mats, waterDepthAt, big));

  // posts: 横断歩道の脇の車止めの位置（当たり判定に足す）
  return { group, bridges, heightAt: (x, z) => raised.heightAt(x, z), streetStats, raised, posts: streetStats.postPts };
}
