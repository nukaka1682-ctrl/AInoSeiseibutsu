// 街路樹・公園の木（InstancedMesh で数千本を 2 回の描画コールで描く）。
// OSM に登録されている木（natural=tree / tree_row）に加え、木の少ない公園には木を補う。
// 樹冠は木ごとに違うこぶのある形（シェーダーで作る）、幹は途中で 2 本に分かれ、街路・運河沿いのプラタナスはまだらな樹皮。
import * as THREE from 'three';
import { mergeGeometries, mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { Grid, hash01, mulberry32, pointInPolygon } from '../geo.js';
import { CAR_ROADS } from './parse.js';
import { makeBarkTexture } from './textures.js';

const MAX_TREES = 16000;

// 木の登録が少ない公園に木を補う。isFree(x,z) が false の場所（道・水・建物）には置かない
export function fillParkTrees(areas, mappedTrees, isFree) {
  const out = [];
  const grid = new Grid(30);
  mappedTrees.forEach((p, i) => grid.insertPoint(p[0], p[1], i));
  for (const a of areas) {
    if (a.type !== 'grass' && a.type !== 'forest') continue;
    if (a.area < 600) continue;
    const spacing = a.type === 'forest' ? 7 : 13;
    let existing = 0;
    grid.query(a.bounds.minX, a.bounds.minZ, a.bounds.maxX, a.bounds.maxZ, (i) => {
      const p = mappedTrees[i];
      if (pointInPolygon(p[0], p[1], a)) existing++;
    });
    if (existing > a.area / (spacing * spacing * 3)) continue; // すでに十分登録されている
    const rnd = mulberry32(Math.abs(a.id) % 2147483647);
    for (let x = a.bounds.minX + spacing / 2; x < a.bounds.maxX; x += spacing) {
      for (let z = a.bounds.minZ + spacing / 2; z < a.bounds.maxZ; z += spacing) {
        if (rnd() < 0.35) continue;
        const px = x + (rnd() - 0.5) * spacing * 0.8, pz = z + (rnd() - 0.5) * spacing * 0.8;
        if (pointInPolygon(px, pz, a) && isFree(px, pz)) out.push([px, pz]);
      }
    }
  }
  return out;
}

// 並木道: 個々の木のデータがないとき（IGN データ）に、名前から並木道と分かる通りの両側に木を植える。
// トゥールーズの Allées・Boulevard・Cours・Port（運河沿い）はプラタナス並木が多い
export const TREE_LINED = /^(Allées?|Boulevard|Cours|Port)\b/;

export function streetTrees(roads, isFree, spacing = 11) {
  const out = [];
  for (const r of roads) {
    if (r.bridge || r.tunnel || !TREE_LINED.test(r.name)) continue;
    const off = r.width / 2 + 1.4; // 歩道の上
    let acc = 6;
    for (let i = 0; i + 1 < r.pts.length; i++) {
      const [ax, az] = r.pts[i], [bx, bz] = r.pts[i + 1];
      const len = Math.hypot(bx - ax, bz - az);
      if (len < 0.01) continue;
      const ux = (bx - ax) / len, uz = (bz - az) / len;
      for (; acc < len; acc += spacing) {
        const px = ax + ux * acc, pz = az + uz * acc;
        for (const side of [1, -1]) {
          const x = px - uz * off * side, z = pz + ux * off * side;
          if (isFree(x, z)) out.push([x, z]);
        }
      }
      acc -= len;
    }
  }
  return out;
}

// プラタナスにする場所: 車道の端から 6 m 以内（街路樹）か、川・運河の岸から 15 m 以内（運河・河岸の並木）
export function planeTreeTest(roadnet, inWater) {
  const car = (s) => CAR_ROADS.has(s.road.type);
  return (x, z) => {
    const s = roadnet.nearestSegment(x, z, roadnet.maxHalfWidth + 6, car);
    if (s && Math.sqrt(s.d2) < s.seg.road.width / 2 + 6) return true;
    return inWater(x + 15, z) || inWater(x - 15, z) || inWater(x, z + 15) || inWater(x, z - 15);
  };
}

// ---------------------------------------------------------------- 木の形
// LiDAR の「木」は、数本の木の樹冠がつながった塊のことがある（半径 9 m・高さ 6 m など）。そのまま作ると平たい板になるので、
// 樹冠は「高さ（半分）が半径の CROWN_ASPECT 倍以上」の形に限り、その形が木の高さ（幹の下枝の高さより上）に収まる
// 半径まで抑える（crownLimit）。抑えた半径の 1.4 倍より横に広い塊は、塊の向き（分からないので種から決める）に沿って
// 2〜3 本の木に分ける。canPlace(x, z) が false の場所（道路・水・建物）には分けた木を置かない。
// 返す木: { x, z, y, r: 樹冠の半径, crownH: 樹冠の高さの半分, crownY: 樹冠の中心の高さ, trunkH, seed }
export const CROWN_ASPECT = 0.75;

// 高さ h の木の、下枝の高さ（bottom）と樹冠の半径の上限（rmax）
export function crownLimit(h) {
  const bottom = Math.max(1.6, Math.min(h * 0.22, 5)); // 下枝の高さ（高さの 2 割ほど、街路樹のプラタナスで 3〜5 m）
  return { bottom, rmax: Math.max(1.5, Math.min(0.45 * h + 1, (h - bottom) / (2 * CROWN_ASPECT))) };
}

export function shapeTrees(points, canPlace = () => true) {
  const out = [];
  for (const t of points) {
    const x = t.x ?? t[0], z = t.z ?? t[1], y = t.y ?? 0;
    const seed = treeSeed(x, z);
    if (!(t.h > 0) || !(t.r > 0)) {
      // 大きさの分からない木（OSM・並木道・公園に補った木）
      const r = 2.4 + hash01(seed, 1) * 2.4;
      const trunkH = 2.6 + hash01(seed, 2) * 2.2;
      const crownH = r * (0.85 + hash01(seed, 4) * 0.3);
      out.push({ x, z, y, r, crownH, crownY: trunkH + crownH * 0.9, trunkH, seed });
      continue;
    }
    const R = t.r * 1.05;
    const { rmax } = crownLimit(t.h);
    const n = R > 2.2 * rmax ? 3 : R > 1.4 * rmax ? 2 : 1;
    const ang = hash01(seed, 8) * Math.PI;
    const ux = Math.cos(ang), uz = Math.sin(ang);
    let placed = 0;
    for (let k = 0; k < n; k++) {
      const off = n === 1 ? 0 : ((2 * k + 1) / n - 1) * R; // 塊の直径を n 等分した中心
      let px = x + ux * off, pz = z + uz * off;
      if (off !== 0 && !canPlace(px, pz)) {
        if (k < n - 1 || placed) continue;
        [px, pz] = [x, z]; // 1 本も置けなければ元の位置に 1 本
      }
      const h = t.h * (n === 1 || off === 0 ? 1 : 0.85 + hash01(seed, 10 + k) * 0.15);
      const lim = crownLimit(h);
      const r = Math.max(1.5, Math.min(n === 1 ? R : Math.max((R / n) * 1.3, lim.rmax * 0.75), lim.rmax));
      // 樹冠は下枝の高さより上。細長くなりすぎないように（そのぶん幹が伸びる）
      const crownH = Math.max(CROWN_ASPECT * r, Math.min((h - lim.bottom) / 2, r * 1.3));
      const crownY = Math.max(crownH * 0.75, h - crownH);
      out.push({ x: px, z: pz, y, r, crownH, crownY, trunkH: crownY - crownH * 0.4, seed: seed + k * 7919 });
      placed++;
    }
  }
  return out;
}

const treeSeed = (x, z) => Math.floor(x * 7.13) * 31 + Math.floor(z * 3.71);

// 樹冠の土台: 球の表面を少しでこぼこにした形（葉の塊らしく）。木ごとの大きなこぶはシェーダーで付ける（LUMPS_GLSL）
function lumpyCrown() {
  let g = new THREE.IcosahedronGeometry(1, 1); // 80 面（1 万本で 80 万面）
  g.deleteAttribute('normal');
  g.deleteAttribute('uv');
  g = mergeVertices(g); // 頂点を共有させて滑らかな陰影にする
  const pos = g.attributes.position;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const n = Math.sin(v.x * 5.1 + v.y * 2.3) * Math.cos(v.z * 4.7 - v.y * 3.1) + Math.sin(v.x * 3.7 - v.z * 4.3) * 0.5;
    v.multiplyScalar(0.92 * (1 + n * 0.07)); // こぶの分だけ小さく
    if (v.y < 0) v.y *= 0.85; // 下側は少し平ら
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  g.computeVertexNormals();
  return g;
}

// 幹: 高さの 6 割ほどで 2 本に分かれる（プラタナスのように）。高さ 1 に正規化（木ごとに幹の高さで拡大するので、
// 太さも高さに比例する: 高さ 8 m で直径約 0.45 m）。UV: u = 幹の周り、v = 高さ（約 1 m で 1 周の樹皮の模様）
function forkedTrunk() {
  const parts = [];
  const main = new THREE.CylinderGeometry(0.021, 0.028, 0.62, 5, 1, true);
  main.translate(0, 0.31, 0);
  parts.push(main.toNonIndexed());
  for (const s of [1, -1]) {
    const b = new THREE.CylinderGeometry(0.011, 0.018, 0.48, 4, 1, true);
    b.translate(0, 0.24, 0);
    b.rotateZ(s * 0.34);
    b.rotateY(s > 0 ? 0.3 : -0.2);
    b.translate(0, 0.56, 0);
    parts.push(b.toNonIndexed());
  }
  const g = mergeGeometries(parts);
  const uv = g.attributes.uv, pos = g.attributes.position;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * 1.5, pos.getY(i) * 8);
  return g;
}

// 木ごとの大きなこぶ（3〜5 個）を、樹冠の頂点を法線の向きに押し出して作る。こぶの向き・大きさは、
// 木の位置（インスタンスの行列の平行移動）から作る種で決まるので、同じ形の木が並ばない。
// 法線もこぶに合わせて傾けるので、こぶの日の当たらない側は暗くなる。影（customDepthMaterial）も同じ形にする
const LUMPS_GLSL = `
  float lumpHash(vec2 p, float k) { return fract(sin(dot(p, vec2(12.9898, 78.233)) + k * 37.719) * 43758.5453); }
  vec3 crownLumps(vec3 p, vec3 n, out vec3 nOut) {
    #ifdef USE_INSTANCING
      vec2 sd = floor(instanceMatrix[3].xz * 4.0) * 0.25;
    #else
      vec2 sd = vec2(0.0);
    #endif
    sd = mod(sd, 997.0);
    float f = 0.0;
    vec3 g = vec3(0.0);
    float count = 3.0 + floor(lumpHash(sd, 1.0) * 2.99);
    for (int i = 0; i < 5; i++) {
      float fi = float(i);
      if (fi >= count) break;
      float az = lumpHash(sd, fi + 2.0) * 6.2832;
      float el = mix(-0.25, 1.0, lumpHash(sd, fi + 9.0));
      vec3 d = vec3(cos(az) * cos(el), sin(el), sin(az) * cos(el));
      float a = mix(0.07, 0.17, lumpHash(sd, fi + 17.0));
      float c = max(0.0, dot(n, d));
      f += a * c * c;
      g += a * 2.0 * c * (d - dot(n, d) * n);
    }
    nOut = normalize(n - g * 0.6);
    return p + n * f;
  }
`;

// 葉の塊のまだら模様と、樹冠の下側の陰（UV を使わず、樹冠の中の位置から 3D ノイズで作る）
function leafShading(material) {
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vLeafPos;\n${LUMPS_GLSL}`)
      .replace('#include <beginnormal_vertex>', '#include <beginnormal_vertex>\nvec3 lumpN;\nvec3 lumpP = crownLumps(position, objectNormal, lumpN);\nobjectNormal = lumpN;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\ntransformed = lumpP;\nvLeafPos = lumpP;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 vLeafPos;
        float leafHash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
        float leafNoise(vec3 x) {
          vec3 i = floor(x), f = fract(x);
          f = f * f * (3.0 - 2.0 * f);
          return mix(mix(mix(leafHash(i), leafHash(i + vec3(1, 0, 0)), f.x), mix(leafHash(i + vec3(0, 1, 0)), leafHash(i + vec3(1, 1, 0)), f.x), f.y),
                     mix(mix(leafHash(i + vec3(0, 0, 1)), leafHash(i + vec3(1, 0, 1)), f.x), mix(leafHash(i + vec3(0, 1, 1)), leafHash(i + vec3(1, 1, 1)), f.x), f.y), f.z);
        }`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        float leaf = leafNoise(vLeafPos * 5.0) * 0.55 + leafNoise(vLeafPos * 13.0) * 0.45;
        diffuseColor.rgb *= (0.68 + leaf * 0.58) * (0.66 + 0.34 * smoothstep(-0.9, 0.6, vLeafPos.y));`);
  };
  material.customProgramCacheKey = () => 'leaf-shading';
}

// 樹冠の影の形もこぶに合わせる
function lumpyDepthMaterial() {
  const m = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  m.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${LUMPS_GLSL}`)
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvec3 lumpN;\ntransformed = crownLumps(position, normal, lumpN);');
  };
  m.customProgramCacheKey = () => 'leaf-depth';
  return m;
}

// 葉の色: プラタナス（街路・運河・河岸）は黄みのオリーブ色、公園などの木はいろいろな緑（写真の樹冠は #414c1f〜#645731）
const LEAF = {
  plane: ['#6a7535', '#737d3a', '#626e31', '#7a823f', '#6e7a38'],
  other: ['#5b7034', '#667a3a', '#52682f', '#6d7c3d', '#587036', '#5f7440', '#737c37', '#4f6033'],
};
// 幹の色（樹皮の模様に掛ける）: プラタナスはまだらな樹皮をそのまま、ほかの木は暗い灰褐色
const BARK_TINT = { plane: '#ffffff', other: '#7a6c5e' };

let barkTexture = null;

// points: [x, z]（大きさは推定）か { x, z, y, h, r }（LiDAR で測った高さと枝の広がり）。
// isPlane(x, z): プラタナス（まだらな樹皮・オリーブ色の葉）にする場所、canPlace(x, z): 塊を分けた木を置ける場所。
// group.userData.trunks に、実際に幹を立てた位置（当たり判定用）を入れる
export function buildTrees(points, { isPlane = () => false, canPlace = () => true } = {}) {
  const src = points.length > MAX_TREES ? points.filter((_, i) => i % Math.ceil(points.length / MAX_TREES) === 0) : points;
  const trees = shapeTrees(src, canPlace);
  const n = trees.length;
  const group = new THREE.Group();
  group.name = 'trees';
  group.userData.points = src;
  group.userData.trunks = trees.map((t) => [t.x, t.z]);
  if (!n) return group;

  if (typeof document !== 'undefined') barkTexture ||= makeBarkTexture(); // Node（テストの自動走行）ではテクスチャなし
  const trunkMat = new THREE.MeshLambertMaterial({ map: barkTexture });
  const crownMat = new THREE.MeshLambertMaterial({ color: '#ffffff' });
  leafShading(crownMat);
  const trunks = new THREE.InstancedMesh(forkedTrunk(), trunkMat, n);
  const crowns = new THREE.InstancedMesh(lumpyCrown(), crownMat, n);
  crowns.customDepthMaterial = lumpyDepthMaterial();
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const s = new THREE.Vector3();
  const p = new THREE.Vector3();
  const col = new THREE.Color();
  const Y = new THREE.Vector3(0, 1, 0);
  for (let i = 0; i < n; i++) {
    const t = trees[i];
    const kind = isPlane(t.x, t.z) ? 'plane' : 'other';
    q.setFromAxisAngle(Y, hash01(t.seed, 3) * Math.PI * 2);
    // 幹は分かれ目が樹冠の中に隠れる高さまで。太さは木ごとに少し変える
    const th = t.trunkH + t.crownH * 0.55;
    const thick = (0.85 + hash01(t.seed, 6) * 0.4) * (kind === 'plane' ? 1.15 : 1);
    m.compose(p.set(t.x, t.y, t.z), q, s.set(th * thick, th, th * thick));
    trunks.setMatrixAt(i, m);
    trunks.setColorAt(i, col.set(BARK_TINT[kind]));
    // 樹冠は木ごとに少し楕円に（向きは幹と同じく種で回す）
    const squash = (hash01(t.seed, 7) - 0.5) * 0.2;
    m.compose(p.set(t.x, t.y + t.crownY, t.z), q, s.set(t.r * (1 + squash), t.crownH, t.r * (1 - squash)));
    crowns.setMatrixAt(i, m);
    const greens = LEAF[kind];
    crowns.setColorAt(i, col.set(greens[Math.floor(hash01(t.seed, 5) * greens.length)]));
  }
  trunks.castShadow = crowns.castShadow = true;
  trunks.receiveShadow = crowns.receiveShadow = true;
  trunks.computeBoundingSphere();
  crowns.computeBoundingSphere();
  group.add(trunks, crowns);
  return group;
}
