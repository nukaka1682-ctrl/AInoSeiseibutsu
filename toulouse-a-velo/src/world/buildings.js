// 建物の 3D メッシュ生成。OSM の外形を押し出し、壁に窓のテクスチャ、屋根に瓦を貼る。
// 300 m 四方のチャンクごとにまとめて描画コールを減らし、視錐台カリングを効かせる。
import * as THREE from 'three';
import { MeshWriter, writeFlatPolygon } from './meshwriter.js';
import { Grid, centroid, hash01, isConvex, signedArea } from '../geo.js';
import { writeTower } from './towers.js';
import { CHURCH_TILE, STYLE, useFacadeAtlas } from './facades.js';
import { facadeSpan } from './landmarkfacades.js';

const CHUNK = 300;
export const BAY = 3.5; // 窓 1 列分の幅（m）

// トゥールーズ「ばら色の街」の壁の色（レンガ）と、漆喰・石の色
const BRICK = ['#c9846c', '#bf745b', '#d39277', '#b86c55', '#cc8b70', '#c27b63', '#d69c80'];
const STUCCO = ['#e4d6be', '#d9c6a5', '#ece2ce', '#d4bf9c', '#e8d2b3', '#dccbb4'];
const STONE = ['#cfc5b3', '#c4b9a5', '#d8cfbf'];
const GLASS = ['#8d9ba5', '#7f8f99'];
const ROOF_TILE = ['#b4633f', '#a8573b', '#bb6e4a', '#9f5238', '#ad6244', '#b85f3c'];
const FLAT_ROOF = ['#9b928a', '#8f8b86', '#a59c90', '#878079'];

const tmpColor = new THREE.Color();

function colorFromTag(value) {
  if (!value) return null;
  try {
    tmpColor.setStyle(String(value).split(';')[0].trim().replace(/^([0-9a-f]{6})$/i, '#$1'));
    return [tmpColor.r, tmpColor.g, tmpColor.b];
  } catch {
    return null;
  }
}

function paletteColor(palette, id, salt) {
  tmpColor.set(palette[Math.floor(hash01(id, salt) * palette.length)]);
  const k = 0.93 + hash01(id, salt + 1) * 0.12;
  return [tmpColor.r * k, tmpColor.g * k, tmpColor.b * k];
}

export function wallColor(b) {
  const t = b.tags;
  const tag = colorFromTag(t['building:colour']);
  if (tag) return tag;
  const mat = t['building:material'];
  if (mat === 'brick') return paletteColor(BRICK, b.id, 1);
  if (mat === 'stone' || mat === 'concrete' || mat === 'sandstone' || mat === 'limestone') return paletteColor(STONE, b.id, 1);
  if (mat === 'plaster' || mat === 'render') return paletteColor(STUCCO, b.id, 1);
  if (mat === 'glass') return paletteColor(GLASS, b.id, 1);
  if (b.info.isChurch) return paletteColor(BRICK, b.id, 1); // 南仏ゴシックのレンガ造り
  return hash01(b.id, 2) < 0.66 ? paletteColor(BRICK, b.id, 1) : paletteColor(STUCCO, b.id, 1);
}

// ファサードの様式（facades.js）: 壁の材料ごとに、トゥールーズで見かける割合で選ぶ
const STYLE_MIX = {
  brick: [[STYLE.brickStone, 0.3], [STYLE.brickShutters, 0.36], [STYLE.rose, 0.12], [STYLE.ochre, 0.1], [STYLE.salmon, 0.12]],
  stone: [[STYLE.cream, 0.6], [STYLE.brickStone, 0.2], [STYLE.taupe, 0.2]],
  concrete: [[STYLE.modern, 0.6], [STYLE.cream, 0.25], [STYLE.ochre, 0.15]],
  wood: [[STYLE.modern, 1]],
  other: [[STYLE.brickStone, 0.2], [STYLE.brickShutters, 0.22], [STYLE.ochre, 0.12], [STYLE.taupe, 0.11], [STYLE.salmon, 0.12], [STYLE.cream, 0.1], [STYLE.rose, 0.13]],
};
export function facadeStyle(b) {
  if (b.style != null) return b.style; // 決まった様式（landmarkfacades.js の歴史的な建物）
  const mat = b.tags['building:material'];
  const mix = STYLE_MIX[mat === 'sandstone' || mat === 'limestone' ? 'stone' : mat === 'plaster' || mat === 'render' ? 'other' : mat] || STYLE_MIX.other;
  let r = hash01(b.id, 21);
  for (const [style, p] of mix) {
    if ((r -= p) < 0) return style;
  }
  return mix[0][0];
}
// ファサードの色はテクスチャに描いてあるので、頂点カラーは建物ごとのわずかな明るさの違いだけ
export function facadeTint(b) {
  const k = 0.9 + hash01(b.id, 22) * 0.14, warm = hash01(b.id, 23) * 0.04;
  return [k, k * (1 - warm * 0.5), k * (1 - warm)];
}

function roofColor(b, flat) {
  const tag = colorFromTag(b.tags['roof:colour']);
  if (tag) return tag;
  return flat ? paletteColor(FLAT_ROOF, b.id, 5) : paletteColor(ROOF_TILE, b.id, 5);
}

function outwardSign(ring) {
  return signedArea(ring) > 0 ? 1 : -1;
}

// 隣の建物と接する壁（境界の壁）を見つけるための索引。
// 壁の辺ごとに、ほぼ同じ線上（0.8 m 以内・平行）にある別の建物の辺と、その建物の高さを返す
export function makePartyIndex(list) {
  const grid = new Grid(20);
  const segs = [];
  for (const b of list) {
    for (const ring of [b.outer, ...b.holes]) {
      for (let i = 0; i < ring.length; i++) {
        const p = ring[i], q = ring[(i + 1) % ring.length];
        grid.insertSegment(p[0], p[1], q[0], q[1], segs.length);
        segs.push({ p, q, b });
      }
    }
  }
  const TOL = 0.8;
  // 辺 a→c のうち、隣の建物に接している区間 [t0, t1]（m）と、そこを隠す高さ
  return (b, a, c) => {
    const L = Math.hypot(c[0] - a[0], c[1] - a[1]);
    if (L < 0.3) return [];
    const ux = (c[0] - a[0]) / L, uz = (c[1] - a[1]) / L;
    const out = [];
    const seen = new Set();
    grid.query(Math.min(a[0], c[0]) - TOL, Math.min(a[1], c[1]) - TOL, Math.max(a[0], c[0]) + TOL, Math.max(a[1], c[1]) + TOL, (k) => {
      if (seen.has(k)) return;
      seen.add(k);
      const s = segs[k];
      if (s.b === b || s.b.info.minHeight > 1 || s.b.info.kind === 'roof') return;
      const sl = Math.hypot(s.q[0] - s.p[0], s.q[1] - s.p[1]);
      if (sl < 0.3) return;
      if (Math.abs(((s.q[0] - s.p[0]) * ux + (s.q[1] - s.p[1]) * uz) / sl) < 0.97) return;
      const d = (pt) => Math.abs((pt[0] - a[0]) * -uz + (pt[1] - a[1]) * ux);
      if (d(s.p) > TOL || d(s.q) > TOL) return;
      const tp = (s.p[0] - a[0]) * ux + (s.p[1] - a[1]) * uz, tq = (s.q[0] - a[0]) * ux + (s.q[1] - a[1]) * uz;
      const t0 = Math.max(0, Math.min(tp, tq)), t1 = Math.min(L, Math.max(tp, tq));
      if (t1 - t0 > 0.3) out.push([t0, t1, s.b.info.height]);
    });
    return out;
  };
}

// 辺を、隣の建物に隠れる高さが同じ区間に分ける: [[t0, t1, 隠れる高さ], ...]
function coverIntervals(L, covers) {
  if (!covers.length) return [[0, L, 0]];
  const cuts = [...new Set([0, L, ...covers.flatMap(([t0, t1]) => [t0, t1])])].sort((x, y) => x - y);
  const out = [];
  for (let i = 0; i + 1 < cuts.length; i++) {
    const t0 = cuts[i], t1 = cuts[i + 1];
    if (t1 - t0 < 0.05) continue;
    const m = (t0 + t1) / 2;
    let h = 0;
    for (const [c0, c1, ch] of covers) if (m > c0 && m < c1) h = Math.max(h, ch);
    const last = out[out.length - 1];
    if (last && last[2] === h) last[1] = t1;
    else out.push([t0, t1, h]);
  }
  return out;
}

function writeWalls(W, ring, sign, b, plainColor, facade, party = null) {
  const info = b.info;
  const y0 = info.minHeight;
  const y1 = info.height;
  if (y1 - y0 < 0.3) return;
  const floorH = info.floorHeight;
  const groundH = Math.max(3.4, floorH * 1.15);
  const bayShift = Math.floor(hash01(b.id, 9) * 4);
  const sv = facadeStyle(b) * 1000; // v に様式の番号を入れる（facades.js）
  const tint = facadeTint(b);
  let along = 0;
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    const a = ring[i], c = ring[(i + 1) % n];
    const dx = c[0] - a[0], dz = c[1] - a[1];
    const L = Math.hypot(dx, dz);
    if (L < 0.05) continue;
    const nrm = [(dz / L) * sign, 0, (-dx / L) * sign];
    const A = (y) => [a[0], y, a[1]];
    const C = (y) => [c[0], y, c[1]];
    const span = facade?.building === b ? facadeSpan(facade, a, c, nrm) : null;
    if (span) {
      const top = Math.max(y1, y0 + facade.height);
      W.capitole.quad(A(y0), C(y0), C(top), A(top), nrm, [span[0], 0], [span[1], 0], [span[1], (top - y0) / facade.height], [span[0], (top - y0) / facade.height]);
      continue;
    }
    // 隣の建物に接する所: 隣の高さまでは隠れるので作らず、それより上は窓のない壁（境界の壁）
    const parts = coverIntervals(L, party ? party(b, a, c) : []);
    for (const [t0, t1, cover] of parts) {
      if (cover >= y1 - 0.2) continue;
      const P = (t, y) => [a[0] + (dx / L) * t, y, a[1] + (dz / L) * t];
      const l = t1 - t0;
      if (cover > y0 + 0.3) {
        const yc = cover;
        W.plain.quad(P(t0, yc), P(t1, yc), P(t1, y1), P(t0, y1), nrm, [t0 / 4, yc / 4], [t1 / 4, yc / 4], [t1 / 4, y1 / 4], [t0 / 4, y1 / 4], plainColor);
        continue;
      }
      if (info.isChurch && L >= 1.6) {
        // 教会の壁: 地面からの高さで窓の段がそろう
        const s0 = (along + t0) / CHURCH_TILE.w, s1 = (along + t1) / CHURCH_TILE.w;
        W.church.quad(P(t0, y0), P(t1, y0), P(t1, y1), P(t0, y1), nrm, [s0, y0 / CHURCH_TILE.h], [s1, y0 / CHURCH_TILE.h], [s1, y1 / CHURCH_TILE.h], [s0, y1 / CHURCH_TILE.h], tint);
        continue;
      }
      if (info.isChurch || L < 1.6 || info.kind === 'roof' || l < 1.2) {
        W.plain.quad(P(t0, y0), P(t1, y0), P(t1, y1), P(t0, y1), nrm, [t0 / 4, y0 / 4], [t1 / 4, y0 / 4], [t1 / 4, y1 / 4], [t0 / 4, y1 / 4], plainColor);
        continue;
      }
      const nb = L / BAY;
      const e0 = (bayShift + 0.5 - nb / 2) / 4;
      const u0 = e0 + t0 / BAY / 4, u1 = e0 + t1 / BAY / 4;
      let yb = y0;
      if (y0 < 0.5) {
        const gt = Math.min(y1, y0 + groundH);
        const v1 = (gt - y0) / groundH;
        W.ground.quad(P(t0, y0), P(t1, y0), P(t1, gt), P(t0, gt), nrm, [u0, sv], [u1, sv], [u1, sv + v1], [u0, sv + v1], tint);
        yb = gt;
      }
      if (y1 > yb + 0.05) {
        const v1 = (y1 - yb) / floorH;
        W.upper.quad(P(t0, yb), P(t1, yb), P(t1, y1), P(t0, y1), nrm, [u0, sv], [u1, sv], [u1, sv + v1], [u0, sv + v1], tint);
      }
    }
    along += L;
  }
}

// 傾斜した屋根の三角形。法線を計算し、瓦が勾配方向に流れるよう UV を合わせる
function roofTri(w, a, b, c, color) {
  const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
  const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
  let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
  const len = Math.hypot(nx, ny, nz) || 1;
  nx /= len; ny /= len; nz /= len;
  if (ny < 0) { nx = -nx; ny = -ny; nz = -nz; }
  let gx = nx, gz = nz;
  const gl = Math.hypot(gx, gz);
  if (gl < 1e-4) { gx = 1; gz = 0; } else { gx /= gl; gz /= gl; }
  const rx = -gz, rz = gx;
  const uv = (p) => [(p[0] * rx + p[2] * rz) / 1.6, (p[0] * gx + p[2] * gz) / 2.0 - p[1] / 2.0];
  w.tri(a, b, c, [nx, ny, nz], uv(a), uv(b), uv(c), color);
}

function chooseRoof(b, ring) {
  const info = b.info;
  let shape = info.roofShape;
  const quadOk = ring.length === 4 && b.holes.length === 0 && isConvex(ring);
  if (shape === 'auto') {
    if (quadOk && info.area < 3000) shape = 'gabled';
    else shape = 'flat';
  }
  if ((shape === 'gabled' || shape === 'hipped' || shape === 'half-hipped' || shape === 'saltbox') && !quadOk) shape = 'flat';
  if ((shape === 'pyramidal' || shape === 'dome' || shape === 'onion' || shape === 'cone' || shape === 'round') && (!isConvex(ring) || b.holes.length)) shape = 'flat';
  if (shape !== 'gabled' && shape !== 'hipped' && shape !== 'half-hipped' && shape !== 'saltbox' &&
      shape !== 'pyramidal' && shape !== 'dome' && shape !== 'onion' && shape !== 'cone' && shape !== 'round') shape = 'flat';
  return shape;
}

function writeRoof(W, ring, b, wColor, plainColor) {
  const info = b.info;
  const top = info.height;
  const shape = chooseRoof(b, ring);

  if (shape === 'flat') {
    // 小さな住宅系は瓦、大きい建物は灰色の陸屋根
    const tiled = !b.tags['roof:colour'] && info.area < 600 && !/^(industrial|warehouse|retail|commercial|office|supermarket|parking|school|university)$/.test(info.kind);
    if (tiled) writeFlatPolygon(W.roof, ring, b.holes, top, 1.8, roofColor(b, false));
    else writeFlatPolygon(W.flat, ring, b.holes, top, 4, roofColor(b, true));
    return;
  }

  const rColor = roofColor(b, false);
  if (shape === 'pyramidal' || shape === 'dome' || shape === 'onion' || shape === 'cone' || shape === 'round') {
    const c = centroid(ring);
    const size = Math.sqrt(info.area);
    let rh = info.roofHeight;
    if (!(rh > 0)) rh = shape === 'pyramidal' ? Math.min(6, size * 0.35) : Math.min(14, size * 0.6);
    const apex = [c[0], top + rh, c[1]];
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i], d = ring[(i + 1) % ring.length];
      roofTri(W.roof, [a[0], top, a[1]], [d[0], top, d[1]], apex, rColor);
    }
    return;
  }

  // 切妻（gabled）・寄棟（hipped）: 短い2辺の中点を結ぶ線を棟にする
  let [A, B, C, D] = ring;
  const len = (p, q) => Math.hypot(q[0] - p[0], q[1] - p[1]);
  if (len(A, B) + len(C, D) > len(B, C) + len(D, A)) [A, B, C, D] = [B, C, D, A];
  const short = (len(A, B) + len(C, D)) / 2;
  let rh = info.roofHeight;
  if (!(rh > 0)) rh = info.isChurch ? Math.min(9, short * 0.42) : Math.min(3.5, short * 0.2);
  const yr = top + rh;
  let R1 = [(A[0] + B[0]) / 2, (A[1] + B[1]) / 2];
  let R2 = [(C[0] + D[0]) / 2, (C[1] + D[1]) / 2];
  const hipped = shape !== 'gabled' && shape !== 'saltbox';
  if (hipped) {
    const rl = len(R1, R2);
    const inset = Math.min(short / 2, rl / 2 - 0.05);
    if (inset > 0 && rl > 0) {
      const ux = (R2[0] - R1[0]) / rl, uz = (R2[1] - R1[1]) / rl;
      R1 = [R1[0] + ux * inset, R1[1] + uz * inset];
      R2 = [R2[0] - ux * inset, R2[1] - uz * inset];
    }
  }
  const P = (p, y) => [p[0], y, p[1]];
  roofTri(W.roof, P(B, top), P(C, top), P(R2, yr), rColor);
  roofTri(W.roof, P(B, top), P(R2, yr), P(R1, yr), rColor);
  roofTri(W.roof, P(D, top), P(A, top), P(R1, yr), rColor);
  roofTri(W.roof, P(D, top), P(R1, yr), P(R2, yr), rColor);
  if (hipped) {
    roofTri(W.roof, P(A, top), P(B, top), P(R1, yr), rColor);
    roofTri(W.roof, P(C, top), P(D, top), P(R2, yr), rColor);
  } else {
    // 切妻の三角形の壁
    const sign = outwardSign(ring);
    for (const [p, q, r] of [[A, B, R1], [C, D, R2]]) {
      const dx = q[0] - p[0], dz = q[1] - p[1];
      const L = Math.hypot(dx, dz) || 1;
      const nrm = [(dz / L) * sign, 0, (-dx / L) * sign];
      W.plain.tri(P(p, top), P(q, top), P(r, yr), nrm, [0, top / 4], [L / 4, top / 4], [L / 8, yr / 4], plainColor || wColor);
    }
  }
}

export function createBuildingMaterials(tex) {
  const std = (map, extra = {}) => new THREE.MeshStandardMaterial({ map, vertexColors: true, roughness: 0.92, metalness: 0, ...extra });
  return {
    upper: useFacadeAtlas(std(tex.upper)),
    ground: useFacadeAtlas(std(tex.shopfront)),
    plain: std(tex.plain),
    capitole: std(tex.capitole, { alphaTest: 0.5 }), // キャピトルの正面（屋上の手すりの上は透明）
    tower: std(tex.tower), // サン・セルナン・ジャコバンの八角形の鐘楼
    church: std(tex.church), // 教会の壁（石の縞・控え壁・半円アーチの窓）
    roof: std(tex.roof, { roughness: 0.85 }),
    flat: std(tex.flatRoof),
  };
}

const nextFrame = () => new Promise((r) => setTimeout(r, 0));

// context: 隣のタイルの建物（作らないが、接する壁を見分けるのに使う）、towers: 八角形の鐘楼（towers.js）
export async function buildBuildings(parsed, materials, onProgress, facade = null, { context = [], towers = [] } = {}) {
  const group = new THREE.Group();
  group.name = 'buildings';
  const chunks = new Map();
  const getChunk = (x, z) => {
    const key = `${Math.floor(x / CHUNK)},${Math.floor(z / CHUNK)}`;
    let c = chunks.get(key);
    if (!c) {
      c = { upper: new MeshWriter(), ground: new MeshWriter(), plain: new MeshWriter(), capitole: new MeshWriter(), church: new MeshWriter(), tower: new MeshWriter(), roof: new MeshWriter(), flat: new MeshWriter() };
      chunks.set(key, c);
    }
    return c;
  };

  const list = parsed.buildings.filter((b) => !b.hasParts).concat(parsed.parts);
  const stats = { total: list.length, OSM: 0, IGN: 0, 'OSM（階数）': 0, 推定: 0 };
  const party = makePartyIndex(list.concat(context.filter((b) => !b.hasParts)));
  for (const t of towers) writeTower(t, getChunk(t.x, t.z).tower);
  for (let i = 0; i < list.length; i++) {
    const b = list[i];
    stats[b.info.heightSource] = (stats[b.info.heightSource] || 0) + 1;
    const W = getChunk(b.inside[0], b.inside[1]);
    // 傾斜屋根を作れない形（四角形以外）で屋根の高さが分かっている場合は、屋根の中間の高さで陸屋根にする
    if (chooseRoof(b, b.outer) === 'flat' && b.info.roofShape !== 'flat' && b.info.roofHeight > 0 && !b.info.raised) {
      b.info.height += b.info.roofHeight / 2;
      b.info.raised = true;
    }
    const color = wallColor(b);
    const plainColor = color;
    writeWalls(W, b.outer, outwardSign(b.outer), b, plainColor, facade, party);
    for (const h of b.holes) writeWalls(W, h, -outwardSign(h), b, plainColor, null, party); // 中庭の壁は内向き
    if (b.info.minHeight > 0.5) {
      // 浮いているパーツ（張り出しなど）の底面
      writeFlatPolygon(W.plain, b.outer, b.holes, b.info.minHeight, 4, plainColor, false);
    }
    writeRoof(W, b.outer, b, color, plainColor);
    if (i % 1500 === 1499) {
      onProgress?.(i / list.length);
      await nextFrame();
    }
  }

  for (const c of chunks.values()) {
    for (const key of ['upper', 'ground', 'plain', 'capitole', 'church', 'tower', 'roof', 'flat']) {
      if (c[key].empty) continue;
      const mesh = new THREE.Mesh(c[key].toGeometry(), materials[key]);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      group.add(mesh);
    }
  }
  onProgress?.(1);
  return { group, stats };
}
