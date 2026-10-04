// 地面まわりのメッシュ: 地面、公園・広場・駐車場、道路と歩道、路面標示、線路、水面と河岸の壁、橋。
//
// 地面と同じ高さ (y=0) に重なる面は、深度を書かずに renderOrder の順に塗り重ねる（Z ファイティング防止）。
// 川や運河は地面より低い位置に水面を置き、ステンシルで地面に「穴」をあけて見せる。
import * as THREE from 'three';
import { MeshWriter, writeFlatPolygon } from './meshwriter.js';
import { CAR_ROADS } from './parse.js';
import { Grid, clipPolylineToRect, closestOnSegment, pointInPolygon, signedArea } from '../geo.js';

export const ORDER = {
  waterMask: -50,
  ground: -40,
  water: -35,
  green: -30,
  parking: -29,
  plaza: -28,
  sidewalk: -27,
  footway: -26,
  service: -25,
  road: -24,
  pedestrian: -23,
  cycleway: -22,
  rail: -21,
  marking: -20,
  route: -19,
};

const c3 = (hex, k = 1) => {
  const c = new THREE.Color(hex);
  return [c.r * k, c.g * k, c.b * k];
};

const GREEN_COLOR = {
  grass: c3('#ffffff'), forest: c3('#c9d8b8'), cemetery: c3('#d7dccb'), pitch: c3('#e6f2d6'),
};

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
      grass: flat(tex.grass),
      gravel: flat(tex.gravel),
      plain: flat(null),
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
    water: new THREE.MeshStandardMaterial({
      color: '#3d5a4f',
      roughness: 0.16,
      metalness: 0,
      normalMap: waterNormal,
      normalScale: new THREE.Vector2(0.25, 0.25),
    }),
    quai: new THREE.MeshStandardMaterial({ map: tex.plain, vertexColors: true, roughness: 0.95 }),
    deck: new THREE.MeshStandardMaterial({ map: tex.asphalt, vertexColors: true, roughness: 0.95, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -6 }),
    bridge: new THREE.MeshStandardMaterial({ map: tex.plain, vertexColors: true, roughness: 0.9 }),
  };
}

// 折れ線の左右のオフセット（マイター結合、長さ制限付き）
function offsets(pts, half) {
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

function roadStyle(road) {
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

export function buildGround(parsed, rect, mats) {
  const group = new THREE.Group();
  group.name = 'ground';
  const writers = new Map();
  const W = (order, tex) => {
    const k = `${order}|${tex}`;
    let w = writers.get(k);
    if (!w) writers.set(k, (w = { order, tex, w: new MeshWriter() }));
    return w.w;
  };
  const pad = 120;
  const clipRect = [rect.minX - pad, rect.minZ - pad, rect.maxX + pad, rect.maxZ + pad];

  // ---- 地面（水面部分はステンシルで抜く） ----
  {
    const big = 3000;
    const g = new THREE.PlaneGeometry(rect.maxX - rect.minX + big * 2, rect.maxZ - rect.minZ + big * 2, 1, 1);
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
  {
    const mask = new MeshWriter();
    const surface = new MeshWriter();
    const walls = new MeshWriter();
    const onRectEdge = (p, q) => {
      const e = 0.01;
      return (Math.abs(p[0] - rect.minX) < e && Math.abs(q[0] - rect.minX) < e) ||
        (Math.abs(p[0] - rect.maxX) < e && Math.abs(q[0] - rect.maxX) < e) ||
        (Math.abs(p[1] - rect.minZ) < e && Math.abs(q[1] - rect.minZ) < e) ||
        (Math.abs(p[1] - rect.maxZ) < e && Math.abs(q[1] - rect.maxZ) < e);
    };
    const quaiColor = (a) => (a.kind === 'river' ? c3('#c08066') : c3('#bdb3a2'));
    const writeQuai = (ring, isHole, a) => {
      const s = signedArea(ring) > 0 ? 1 : -1;
      const y0 = 0, y1 = -a.depth - 0.6;
      const col = quaiColor(a);
      for (let i = 0; i < ring.length; i++) {
        const p = ring[i], q = ring[(i + 1) % ring.length];
        if (onRectEdge(p, q)) continue;
        const dx = q[0] - p[0], dz = q[1] - p[1];
        const L = Math.hypot(dx, dz);
        if (L < 0.05) continue;
        const ox = (dz / L) * s, oz = (-dx / L) * s; // リング自身の外向き
        // 外周なら壁は水側（内向き）、島（穴）なら水側は外向き
        const nx = isHole ? ox : -ox, nz = isHole ? oz : -oz;
        const mx = (p[0] + q[0]) / 2 - nx * 0.6, mz = (p[1] + q[1]) / 2 - nz * 0.6;
        if (inWater(mx, mz)) continue; // 隣も水（ポリゴンの継ぎ目）なら壁は不要
        walls.quad([p[0], y0, p[1]], [q[0], y0, q[1]], [q[0], y1, q[1]], [p[0], y1, p[1]], [nx, 0, nz],
          [0, y0 / 3], [L / 3, y0 / 3], [L / 3, y1 / 3], [0, y1 / 3], col);
      }
    };
    for (const a of water) {
      writeFlatPolygon(mask, a.outer, a.holes, 0, 10);
      writeFlatPolygon(surface, a.outer, a.holes, -a.depth, 25);
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
  }

  // ---- 緑地・広場・駐車場 ----
  for (const a of parsed.areas) {
    if (a.type === 'water') continue;
    if (a.type === 'plaza') writeFlatPolygon(W(ORDER.plaza, 'paving'), a.outer, a.holes, 0, 4, c3('#ffffff'));
    else if (a.type === 'parking') writeFlatPolygon(W(ORDER.parking, 'asphalt'), a.outer, a.holes, 0, 4, c3('#d0d0d0'));
    else writeFlatPolygon(W(ORDER.green, 'grass'), a.outer, a.holes, 0, 6, GREEN_COLOR[a.type] || GREEN_COLOR.grass);
  }

  // ---- 道路 ----
  const bridges = [];
  for (const road of parsed.roads) {
    if (road.tunnel) continue;
    if (road.bridge) {
      bridges.push(road);
      continue;
    }
    const parts = clipPolylineToRect(road.pts, ...clipRect);
    if (!parts.length) continue;
    const st = roadStyle(road);
    const half = road.width / 2;
    const isCar = CAR_ROADS.has(road.type);
    for (const pts of parts) {
      if (isCar && road.sidewalk !== 'no' && road.sidewalk !== 'none') {
        const sw = W(ORDER.sidewalk, 'sidewalk');
        writeRibbon(sw, pts, half + 2.2, 0, c3('#ffffff'));
        writeDisc(sw, pts[0], half + 2.2, 0, c3('#ffffff'));
        writeDisc(sw, pts[pts.length - 1], half + 2.2, 0, c3('#ffffff'));
      }
      const w = W(st.order, st.tex);
      writeRibbon(w, pts, half, 0, st.color);
      writeDisc(w, pts[0], half, 0, st.color);
      writeDisc(w, pts[pts.length - 1], half, 0, st.color);
      if (isCar && road.width >= 7 && !road.oneway) writeDashes(W(ORDER.marking, 'plain'), pts, 3, 5, 0.15, 0, c3('#f2f2ee'));
    }
  }

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

  for (const { order, tex, w } of writers.values()) {
    if (w.empty) continue;
    const m = new THREE.Mesh(w.toGeometry(), mats.flat[tex]);
    m.renderOrder = order;
    m.receiveShadow = true;
    m.matrixAutoUpdate = false;
    group.add(m);
  }

  // ---- 橋 ----
  const bridgeGroup = buildBridges(bridges, mats, waterDepthAt, clipRect);
  group.add(bridgeGroup);

  return { group, water, inWater, bridges };
}

function buildBridges(bridges, mats, waterDepthAt, clipRect) {
  const deck = new MeshWriter();
  const body = new MeshWriter();
  const bottomY = -1.3;
  const stoneColor = c3('#c58a6e');
  const parapetColor = c3('#d39a7d');
  const deckHalf = (road) => road.width / 2 + (CAR_ROADS.has(road.type) ? 2 : 0.3);
  // 歩道が別の way として並んでいる橋（ポン・ヌフなど）では、隣の橋床の上に欄干を立てない
  const segGrid = new Grid(20);
  const segs = [];
  for (const road of bridges) {
    for (let i = 0; i + 1 < road.pts.length; i++) {
      const [ax, az] = road.pts[i], [bx, bz] = road.pts[i + 1];
      segGrid.insertSegment(ax, az, bx, bz, segs.length);
      segs.push({ ax, az, bx, bz, half: deckHalf(road), road });
    }
  }
  const onOtherDeck = (x, z, self) => {
    let hit = false;
    segGrid.queryPoint(x, z, 25, (i) => {
      const s = segs[i];
      if (hit || s.road === self) return;
      if (closestOnSegment(x, z, s.ax, s.az, s.bx, s.bz).d2 < (s.half - 0.1) ** 2) hit = true;
    });
    return hit;
  };
  for (const road of bridges) {
    // 歩道橋は車道の橋より少し高くして、重なっても Z ファイティングしないように
    const topY = CAR_ROADS.has(road.type) ? 0.08 : 0.14;
    for (const pts of clipPolylineToRect(road.pts, ...clipRect)) {
      if (pts.length < 2) continue;
      const half = deckHalf(road);
      const st = roadStyle(road);
      writeRibbon(deck, pts, half, topY, st.tex === 'asphalt' ? st.color : c3('#c9c4ba'));
      const { L, R } = offsets(pts, half);
      const inner = offsets(pts, half - 0.4);
      for (const [side, innerSide, sgn] of [[L, inner.L, 1], [R, inner.R, -1]]) {
        for (let i = 0; i + 1 < side.length; i++) {
          const a = side[i], b = side[i + 1];
          const dx = b[0] - a[0], dz = b[1] - a[1];
          const l = Math.hypot(dx, dz) || 1;
          const n = [(-dz / l) * sgn, 0, (dx / l) * sgn]; // 外向き
          const parapet = !onOtherDeck((a[0] + b[0]) / 2 + n[0] * 0.8, (a[1] + b[1]) / 2 + n[2] * 0.8, road);
          const top = parapet ? topY + 1.0 : topY;
          // 側面
          body.quad([a[0], top, a[1]], [b[0], top, b[1]], [b[0], bottomY, b[1]], [a[0], bottomY, a[1]], n,
            [0, 0.5], [l / 3, 0.5], [l / 3, 0], [0, 0], stoneColor);
          if (!parapet) continue;
          // 欄干（内側の面と天端）
          const ia = innerSide[i], ib = innerSide[i + 1];
          const ni = [-n[0], 0, -n[2]];
          body.quad([ia[0], topY, ia[1]], [ib[0], topY, ib[1]], [ib[0], topY + 1.0, ib[1]], [ia[0], topY + 1.0, ia[1]], ni,
            [0, 0], [l / 3, 0], [l / 3, 0.3], [0, 0.3], parapetColor);
          body.quad([a[0], topY + 1.0, a[1]], [b[0], topY + 1.0, b[1]], [ib[0], topY + 1.0, ib[1]], [ia[0], topY + 1.0, ia[1]], [0, 1, 0],
            [0, 0], [l / 3, 0], [l / 3, 0.1], [0, 0.1], parapetColor);
        }
      }
      // 底面
      for (let i = 0; i + 1 < pts.length; i++) {
        const a = L[i], b = R[i], c = R[i + 1], d = L[i + 1];
        body.quad([a[0], bottomY, a[1]], [b[0], bottomY, b[1]], [c[0], bottomY, c[1]], [d[0], bottomY, d[1]], [0, -1, 0],
          [0, 0], [1, 0], [1, 1], [0, 1], stoneColor);
      }
      // 橋脚（水の上だけ、約 30 m おき）。車道の橋に並ぶ歩道橋には付けない
      const [m0, m1] = [pts[0], pts[pts.length - 1]];
      const mx = (m0[0] + m1[0]) / 2, mz = (m0[1] + m1[1]) / 2;
      const ml = Math.hypot(m1[0] - m0[0], m1[1] - m0[1]) || 1;
      const nx = -(m1[1] - m0[1]) / ml, nz = (m1[0] - m0[0]) / ml;
      const alongside = !CAR_ROADS.has(road.type) &&
        (onOtherDeck(mx + nx * (half + 0.8), mz + nz * (half + 0.8), road) || onOtherDeck(mx - nx * (half + 0.8), mz - nz * (half + 0.8), road));
      let acc = alongside ? Infinity : 15;
      for (let i = 0; i + 1 < pts.length; i++) {
        const [ax, az] = pts[i], [bx, bz] = pts[i + 1];
        const len = Math.hypot(bx - ax, bz - az);
        if (len < 0.01) continue;
        const ux = (bx - ax) / len, uz = (bz - az) / len;
        while (acc < len) {
          const px = ax + ux * acc, pz = az + uz * acc;
          const depth = waterDepthAt(px, pz);
          if (depth > 1.5) writePier(body, px, pz, ux, uz, half + 0.6, bottomY, -depth - 0.6, stoneColor);
          acc += 30;
        }
        acc -= len;
      }
    }
  }
  const g = new THREE.Group();
  g.name = 'bridges';
  if (!deck.empty) {
    const m = new THREE.Mesh(deck.toGeometry(), mats.deck);
    m.receiveShadow = true;
    g.add(m);
  }
  if (!body.empty) {
    const m = new THREE.Mesh(body.toGeometry(), mats.bridge);
    m.castShadow = true;
    m.receiveShadow = true;
    g.add(m);
  }
  return g;
}

// 橋脚: 流れの方向（橋と直交）に尖った六角柱
function writePier(w, x, z, ux, uz, halfAcross, top, bottom, color) {
  const vx = -uz, vz = ux; // 橋と直交（川の流れ方向）
  const t = 2.2; // 橋軸方向の厚み/2
  const pts = [
    [x + vx * (halfAcross + 2.5), z + vz * (halfAcross + 2.5)],
    [x + vx * halfAcross + ux * t, z + vz * halfAcross + uz * t],
    [x - vx * halfAcross + ux * t, z - vz * halfAcross + uz * t],
    [x - vx * (halfAcross + 2.5), z - vz * (halfAcross + 2.5)],
    [x - vx * halfAcross - ux * t, z - vz * halfAcross - uz * t],
    [x + vx * halfAcross - ux * t, z + vz * halfAcross - uz * t],
  ];
  const s = signedArea(pts) > 0 ? 1 : -1;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    const dx = b[0] - a[0], dz = b[1] - a[1];
    const l = Math.hypot(dx, dz) || 1;
    w.quad([a[0], top, a[1]], [b[0], top, b[1]], [b[0], bottom, b[1]], [a[0], bottom, a[1]], [(dz / l) * s, 0, (-dx / l) * s],
      [0, top / 3], [l / 3, top / 3], [l / 3, bottom / 3], [0, bottom / 3], color);
  }
}
