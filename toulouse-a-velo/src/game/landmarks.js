// 名所: 設定の「だいたいの座標」を、OSM データ内の同名の地物の実際の位置に合わせる。
// あわせて、自転車で近づける道路上の地点（approach）を求める。
import * as THREE from 'three';
import { LANDMARKS } from '../config.js';
import { closestOnSegment } from '../geo.js';

function nearestPointOnFeature(f, hx, hz) {
  if (f.polygon) return { x: f.x, z: f.z, d: Math.hypot(f.x - hx, f.z - hz) };
  if (f.line) {
    let best = null;
    for (let i = 0; i + 1 < f.pts.length; i++) {
      const c = closestOnSegment(hx, hz, f.pts[i][0], f.pts[i][1], f.pts[i + 1][0], f.pts[i + 1][1]);
      if (!best || c.d2 < best.d2) best = c;
    }
    if (best) return { x: best.x, z: best.z, d: Math.sqrt(best.d2) };
  }
  return { x: f.x, z: f.z, d: Math.hypot(f.x - hx, f.z - hz) };
}

export function resolveLandmarks(parsed, proj, rect, roadnet) {
  const out = [];
  for (const lm of LANDMARKS) {
    const [hx, hz] = proj.project(lm.lat, lm.lon);
    let best = null;
    for (const f of parsed.named) {
      if (!lm.match.test(f.name)) continue;
      const p = nearestPointOnFeature(f, hx, hz);
      if (p.d > 700) continue;
      // 建物や広場（面）を優先し、次に距離
      const score = p.d - (f.polygon ? 80 : 0);
      if (!best || score < best.score) best = { ...p, score, f };
    }
    const x = best ? best.x : hx;
    const z = best ? best.z : hz;
    const m = 25;
    if (x < rect.minX + m || x > rect.maxX - m || z < rect.minZ + m || z > rect.maxZ - m) continue;
    const seg = roadnet.nearestSegment(x, z, 200, (s) => s.bike);
    if (!seg) continue;
    out.push({
      ...lm,
      x, z,
      matched: !!best,
      approach: { x: seg.x, z: seg.z },
      height: best?.f?.building ? 25 : 12,
    });
  }
  return out;
}

export function distanceToLandmark(lm, x, z) {
  return Math.min(Math.hypot(lm.approach.x - x, lm.approach.z - z), Math.hypot(lm.x - x, lm.z - z) + 8);
}

// 目的地の光の柱
export function createBeacon() {
  const g = new THREE.Group();
  const mat = new THREE.MeshBasicMaterial({ color: '#ffcf4a', transparent: true, opacity: 0.35, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
  const col = new THREE.Mesh(new THREE.CylinderGeometry(2.2, 2.2, 120, 24, 1, true), mat);
  col.position.y = 60;
  const ringMat = new THREE.MeshBasicMaterial({ color: '#ffd75e', transparent: true, opacity: 0.8, depthWrite: false, side: THREE.DoubleSide });
  const ring = new THREE.Mesh(new THREE.RingGeometry(5, 6.2, 40), ringMat);
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.15;
  g.add(col, ring);
  g.userData = { col, ring, mat, ringMat };
  g.visible = false;
  return g;
}

export function animateBeacon(beacon, t) {
  const { ring, mat, ringMat } = beacon.userData;
  const k = (Math.sin(t * 3) + 1) / 2;
  mat.opacity = 0.22 + k * 0.18;
  ringMat.opacity = 0.5 + k * 0.4;
  ring.scale.setScalar(1 + k * 0.15);
}
