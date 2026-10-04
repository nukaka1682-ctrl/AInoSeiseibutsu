// 街路樹・公園の木（InstancedMesh で数千本を 2 回の描画コールで描く）。
// OSM に登録されている木（natural=tree / tree_row）に加え、木の少ない公園には木を補う。
import * as THREE from 'three';
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

export function buildTrees(points) {
  const pts = points.length > MAX_TREES ? points.filter((_, i) => i % Math.ceil(points.length / MAX_TREES) === 0) : points;
  const n = pts.length;
  const group = new THREE.Group();
  group.name = 'trees';
  if (!n) return group;

  const trunkGeo = new THREE.CylinderGeometry(0.16, 0.26, 1, 6);
  trunkGeo.translate(0, 0.5, 0);
  const crownGeo = new THREE.IcosahedronGeometry(1, 1);
  const trunkMat = new THREE.MeshLambertMaterial({ color: '#8a7a66' });
  const crownMat = new THREE.MeshLambertMaterial({ color: '#ffffff', flatShading: true });
  const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, n);
  const crowns = new THREE.InstancedMesh(crownGeo, crownMat, n);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const s = new THREE.Vector3();
  const p = new THREE.Vector3();
  const col = new THREE.Color();
  const greens = ['#5e7f3a', '#6b8c42', '#557534', '#738f48', '#4f6d33', '#7b9a4f'];
  for (let i = 0; i < n; i++) {
    const [x, z] = pts[i];
    const seed = Math.floor(x * 7.13) * 31 + Math.floor(z * 3.71);
    const r = 2.4 + hash01(seed, 1) * 2.4;
    const trunkH = 2.6 + hash01(seed, 2) * 2.2;
    q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), hash01(seed, 3) * Math.PI * 2);
    m.compose(p.set(x, 0, z), q, s.set(1 + r * 0.06, trunkH + r * 0.5, 1 + r * 0.06));
    trunks.setMatrixAt(i, m);
    m.compose(p.set(x, trunkH + r * 0.75, z), q, s.set(r, r * (0.8 + hash01(seed, 4) * 0.3), r));
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
