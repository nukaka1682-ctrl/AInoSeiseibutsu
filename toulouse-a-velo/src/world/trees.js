// 街路樹・公園の木（InstancedMesh で数千本を 2 回の描画コールで描く）。
// OSM に登録されている木（natural=tree / tree_row）に加え、木の少ない公園には木を補う。
import * as THREE from 'three';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { Grid, hash01, mulberry32, pointInPolygon } from '../geo.js';

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

// 樹冠: 球の表面を少しでこぼこにした形（葉の塊らしく）
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
    v.multiplyScalar(1 + n * 0.09);
    if (v.y < 0) v.y *= 0.8; // 下側は少し平ら
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  g.computeVertexNormals();
  return g;
}

// 葉の塊のまだら模様と、樹冠の下側の陰（UV を使わず、樹冠の中の位置から 3D ノイズで作る）
function leafShading(material) {
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vLeafPos;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvLeafPos = position;');
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
        diffuseColor.rgb *= (0.62 + leaf * 0.7) * (0.7 + 0.3 * smoothstep(-0.9, 0.5, vLeafPos.y));`);
  };
  material.customProgramCacheKey = () => 'leaf-shading';
}

export function buildTrees(points) {
  const pts = points.length > MAX_TREES ? points.filter((_, i) => i % Math.ceil(points.length / MAX_TREES) === 0) : points;
  const n = pts.length;
  const group = new THREE.Group();
  group.name = 'trees';
  if (!n) return group;

  const trunkGeo = new THREE.CylinderGeometry(0.16, 0.26, 1, 6);
  trunkGeo.translate(0, 0.5, 0);
  const crownGeo = lumpyCrown();
  const trunkMat = new THREE.MeshLambertMaterial({ color: '#7a6c5a' });
  const crownMat = new THREE.MeshLambertMaterial({ color: '#ffffff' });
  leafShading(crownMat);
  const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, n);
  const crowns = new THREE.InstancedMesh(crownGeo, crownMat, n);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const s = new THREE.Vector3();
  const p = new THREE.Vector3();
  const col = new THREE.Color();
  const greens = ['#4b6a2e', '#56753a', '#435f2a', '#5d7a3e', '#3e5a2b', '#64803f'];
  for (let i = 0; i < n; i++) {
    // 点は [x, z]（大きさは推定）か { x, z, y, h, r }（LiDAR で測った高さと枝の広がり）
    const t = pts[i];
    const x = t.x ?? t[0], z = t.z ?? t[1], y = t.y ?? 0;
    const seed = Math.floor(x * 7.13) * 31 + Math.floor(z * 3.71);
    let r = 2.4 + hash01(seed, 1) * 2.4;
    let trunkH = 2.6 + hash01(seed, 2) * 2.2;
    let crownH = r * (0.8 + hash01(seed, 4) * 0.3);
    let crownY = trunkH + crownH * 0.9;
    if (t.h) {
      // 測った高さ: 樹冠は高さの上 7 割ほど（プラタナスなどの街路樹は下枝が 3〜6 m）
      r = Math.max(1.5, t.r * 1.05);
      const bottom = Math.max(1.8, Math.min(t.h * 0.32, 6));
      crownH = Math.max(1, Math.min((t.h - bottom) / 2, r * 1.3)); // 細長くなりすぎないように（そのぶん幹が伸びる）
      crownY = t.h - crownH;
      trunkH = crownY - crownH * 0.4;
    }
    q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), hash01(seed, 3) * Math.PI * 2);
    m.compose(p.set(x, y, z), q, s.set(1 + r * 0.06, trunkH + crownH * 0.6, 1 + r * 0.06));
    trunks.setMatrixAt(i, m);
    m.compose(p.set(x, y + crownY, z), q, s.set(r, crownH, r));
    crowns.setMatrixAt(i, m);
    col.set(greens[Math.floor(hash01(seed, 5) * greens.length)]);
    crowns.setColorAt(i, col);
  }
  trunks.castShadow = crowns.castShadow = true;
  trunks.receiveShadow = crowns.receiveShadow = true;
  trunks.computeBoundingSphere();
  crowns.computeBoundingSphere();
  group.add(trunks, crowns);
  group.userData.points = pts;
  return group;
}
