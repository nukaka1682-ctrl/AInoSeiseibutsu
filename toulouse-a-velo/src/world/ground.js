// 地面まわりのメッシュ: 地面、公園・広場・駐車場、道路と歩道、路面標示、線路、水面と河岸の壁、橋。
//
// 地面と同じ高さ (y=0) に重なる面は、深度を書かずに renderOrder の順に塗り重ねる（Z ファイティング防止）。
// 一段高い歩道と縁石（streets.js）は深度を書き、平らな面をすべて塗った後に描く（下に隠れた車道は描かれない）。
// 川や運河は地面より低い位置に水面を置き、ステンシルで地面に「穴」をあけて見せる。
import * as THREE from 'three';
import { MeshWriter, writeFlatPolygon } from './meshwriter.js';
import { CAR_ROADS } from './parse.js';
import { Grid, clipPolylineToRect, clipRingToRect, closestOnSegment, pointInPolygon, signedArea } from '../geo.js';
import { RaisedIndex, oldTownBase, planStreets, streetSteps } from './streets.js';

export const ORDER = {
  waterMask: -50,
  ground: -40,
  oldTown: -39, // 旧市街の地面の下地（小舗石。通り・広場・緑地の下）
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
    deck: new THREE.MeshStandardMaterial({ map: tex.asphalt, vertexColors: true, roughness: 0.95, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -6 }),
    bridge: new THREE.MeshStandardMaterial({ map: tex.plain, vertexColors: true, roughness: 0.9 }),
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
  {
    const mask = new MeshWriter();
    const surface = new MeshWriter();
    const walls = new MeshWriter();
    const edge = new MeshWriter();
    const onRectEdge = (p, q) => {
      const e = 0.01;
      return (Math.abs(p[0] - rect.minX) < e && Math.abs(q[0] - rect.minX) < e) ||
        (Math.abs(p[0] - rect.maxX) < e && Math.abs(q[0] - rect.maxX) < e) ||
        (Math.abs(p[1] - rect.minZ) < e && Math.abs(q[1] - rect.minZ) < e) ||
        (Math.abs(p[1] - rect.maxZ) < e && Math.abs(q[1] - rect.maxZ) < e);
    };
    const quaiColor = (a) => (a.kind === 'river' ? c3('#b47c64') : c3('#b3aa9a'));
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
        // 岸壁の際の水面を暗く（幅は川で 7 m、運河・池で 3 m。v = 0 が岸壁の際）
        const w = a.kind === 'river' ? 7 : 3, yw = -a.depth + 0.01;
        edge.quad([p[0], yw, p[1]], [q[0], yw, q[1]], [q[0] + nx * w, yw, q[1] + nz * w], [p[0] + nx * w, yw, p[1] + nz * w], [0, 1, 0],
          [0.5, 0], [0.5, 0], [0.5, 1], [0.5, 1]);
      }
    };
    for (const a of water) {
      writeFlatPolygon(mask, a.outer, a.holes, 0, 10);
      writeFlatPolygon(surface, a.outer, a.holes, -a.depth, WATER_TILE, WATER_COLOR[a.kind] || WATER_COLOR.canal);
      if (a.patch) continue; // 橋の下を埋めたパッチには岸壁を作らない
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
    if (!edge.empty && mats.waterEdge) {
      const m = new THREE.Mesh(edge.toGeometry(), mats.waterEdge);
      m.renderOrder = ORDER.water + 1;
      m.name = 'water-edge';
      group.add(m);
    }
  }

  return { group, water, inWater, waterDepthAt };
}

// 緑地・広場・駐車場・道路・線路・橋を、範囲 clip の中だけ作る（広いエリアではタイルごとに呼ぶ）。
// 範囲をまたぐ緑地は切り取り、道路は範囲の端で切る。橋は中ほどの点が範囲に入るものだけ。
// opts.buildings / opts.walls（範囲の建物と隣の建物・塀）があれば、歩道を建物の壁まで延ばす。opts.inOldTown: 旧市街の判定
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
  const contains = (b) => b.minX >= clip.minX && b.maxX <= clip.maxX && b.minZ >= clip.minZ && b.maxZ <= clip.maxZ;

  // ---- 旧市街の地面の下地（小舗石）: 通りの石畳の帯の間（広い交差点・地図にない小さな広場）が土のままにならないように。
  // 建物の中庭も石畳になるが、旧市街の中庭はたいてい舗装なのでよしとする
  for (const r of oldTownBase(opts.inOldTown?.ring, clip)) writeFlatPolygon(W(ORDER.oldTown, 'settsBase'), r, [], 0, 2.56, c3('#f4e2d6'));
  // ---- 緑地・広場・駐車場 ----
  for (const a of parsed.areas) {
    if (a.type === 'water' || !overlaps(a.bounds)) continue;
    let outer = a.outer, holes = a.holes;
    if (!contains(a.bounds)) {
      outer = clipRingToRect(outer, ...clipRect);
      if (outer.length < 3) continue;
      holes = holes.map((h) => clipRingToRect(h, ...clipRect)).filter((h) => h.length >= 3);
    }
    if (a.type === 'plaza') writeFlatPolygon(W(ORDER.plaza, 'paving'), outer, holes, 0, 4, c3('#ffffff'));
    else if (a.type === 'parking') writeFlatPolygon(W(ORDER.parking, 'asphalt'), outer, holes, 0, 4, c3('#d0d0d0'));
    else writeFlatPolygon(W(ORDER.green, 'grass'), outer, holes, 0, 6, GREEN_COLOR[a.type] || GREEN_COLOR.grass);
  }
  // ---- 道路 ----
  // 車道の面・中央の破線はここで、縁石・歩道・旧市街の石畳・横断歩道は streets.js で作る
  const bridges = [];
  for (const road of parsed.roads) {
    if (road.tunnel) continue;
    if (road.bridge) {
      const mid = road.pts[road.pts.length >> 1];
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
  group.add(buildBridges(bridges, mats, waterDepthAt, big));

  // posts: 横断歩道の脇の車止めの位置（当たり判定に足す）
  return { group, bridges, heightAt: (x, z) => raised.heightAt(x, z), streetStats, raised, posts: streetStats.postPts };
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
