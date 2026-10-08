// 建物の 3D メッシュ生成。OSM の外形を押し出し、壁に窓のテクスチャ、屋根に瓦を貼る。
// 屋根は roofs.js のストレートスケルトンで、どんな外形にも寄棟・切妻をかける（隣と接する壁は切妻の壁）。
// 300 m 四方のチャンクごとにまとめて描画コールを減らし、視錐台カリングを効かせる。
import * as THREE from 'three';
import { MeshWriter, writeFlatPolygon } from './meshwriter.js';
import { Grid, centroid, hash01, isConvex, signedArea } from '../geo.js';
import { writeTower } from './towers.js';
import { CHURCH_TILE, STYLE, useFacadeAtlas } from './facades.js';
import { facadeSpan } from './landmarkfacades.js';
import { buildRoof, cleanRing, clipGable, ringsSimple, triangulate2 } from './roofs.js';

const CHUNK = 300;
export const BAY = 3.5; // 窓 1 列分の幅（m）

// トゥールーズ「ばら色の街」の壁の色（レンガ）と、漆喰・石の色
const BRICK = ['#c47a58', '#bd6f4f', '#cf8763', '#b96b4c', '#c98260', '#c17656', '#d39270'];
const STUCCO = ['#e4d6be', '#d9c6a5', '#ece2ce', '#d4bf9c', '#e8d2b3', '#dccbb4'];
const STONE = ['#cfc5b3', '#c4b9a5', '#d8cfbf'];
const GLASS = ['#8d9ba5', '#7f8f99'];
// 丸瓦の色: 葺き替えたばかりの明るい橙赤と、年月を経た茶色・くすんだばら色が建物ごとに混ざる（屋根の写真の色）
const ROOF_TILE = ['#b86a48', '#c27852', '#b4644a', '#ad7558', '#a5705a', '#bb8262', '#a97c64', '#c4845e'];
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

const parsedColors = new Map(); // 色の文字列 → [r, g, b]（毎回の文字列の解析を省く）
function paletteColor(palette, id, salt) {
  const hex = palette[Math.floor(hash01(id, salt) * palette.length)];
  let c = parsedColors.get(hex);
  if (!c) {
    tmpColor.set(hex);
    parsedColors.set(hex, (c = [tmpColor.r, tmpColor.g, tmpColor.b]));
  }
  const k = 0.93 + hash01(id, salt + 1) * 0.12;
  return [c[0] * k, c[1] * k, c[2] * k];
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

const SLATE = ['#5f646b', '#686c70', '#73787e'];

// material: 'tile' | 'slate' | 'flat'（roofPlan）
function roofColor(b, material) {
  const tag = colorFromTag(b.tags['roof:colour']);
  if (tag) return tag;
  return paletteColor(material === 'flat' ? FLAT_ROOF : material === 'slate' ? SLATE : ROOF_TILE, b.id, 5);
}

// 屋根の形と材料を決める。
//   shape: 'flat'（陸屋根）| 'pitched'（ストレートスケルトンの寄棟・切妻）| 'pyramidal' など（頂点 1 つの尖った屋根）
//   material: 'tile'（丸瓦）| 'slate'（スレート・亜鉛: 灰色）| 'flat'（陸屋根の防水・砂利）
//   height: 屋根の高さ（m、軒から。分からなければ 0 で、勾配から決める）
// トゥールーズの旧市街は、IGN の屋根の最高点と最低点の差がある建物（9 割近く）がほぼすべて低い勾配の丸瓦屋根。
// 灰色の陸屋根は、コンクリートの屋根・IGN が平らとする屋根・大きな工場や商業施設だけにする
const BIG_FLAT_KINDS = /^(industrial|warehouse|retail|supermarket|parking|hangar|garages|greenhouse|service|office)$/;
const POINTY = new Set(['pyramidal', 'dome', 'onion', 'cone', 'round']);
export function roofPlan(b) {
  const info = b.info, t = b.tags;
  const mat = t['roof:material'];
  const colour = colorFromTag(t['roof:colour']);
  // 色が灰色（彩度が低い）か、材料がスレート・金属ならスレート・亜鉛の屋根
  const greyish = colour && Math.max(...colour) - Math.min(...colour) < 0.08;
  const slate = /^(slate|metal|zinc|copper|tin)$/.test(mat || '') || greyish;
  let shape = info.roofShape;
  if (info.kind === 'roof' || info.kind === 'carport' || mat === 'concrete' || mat === 'glass') shape = 'flat';
  else if (POINTY.has(shape)) {
    if (!isConvex(b.outer) || b.holes.length) shape = 'pitched';
  } else if (shape === 'flat') {
    // IGN で屋根の高低差が 0.5 m 以下でも、瓦の屋根は平らにはできないので低い瓦屋根にする
    if (mat && /tile/.test(mat)) return { shape: 'pitched', material: 'tile', height: 0.5 };
  } else if (shape === 'auto') {
    // 屋根の高さが分かっていれば傾斜屋根。情報がなければ、教会・小さな建物は傾斜屋根、大きな建物・工場・商業施設は陸屋根
    if (info.roofHeight > 0 || info.isChurch || (info.area < 2500 && !BIG_FLAT_KINDS.test(info.kind) && !(info.roofHeight === 0))) shape = 'pitched';
    else shape = 'flat';
  } else {
    shape = 'pitched'; // gabled・hipped・half-hipped・mansard など
  }
  if (shape === 'flat') {
    // 材料の分からない小さな平らな屋根（中庭の離れなど）は瓦の色、それ以外は灰色の陸屋根
    const small = mat == null && !colour && info.area < 600 && !BIG_FLAT_KINDS.test(info.kind) && !/^(commercial|school|university|roof|carport)$/.test(info.kind);
    return { shape, material: small ? 'tile' : 'flat', height: 0 };
  }
  return { shape, material: slate ? 'slate' : 'tile', height: info.roofHeight > 0 ? info.roofHeight : 0 };
}

// 屋根の勾配の範囲（高さ / 水平距離）: 丸瓦は 18〜42%（10〜23°。IGN の屋根の高さが低い古い屋根は 20% 前後まで下げ、
// それより低い所だけ平らな terrasson にする）、スレート・亜鉛はもっと急、教会は 40〜80%、塔（キャピトルの主塔など）は尖った急な屋根
function slopeRange(b, plan) {
  if (b.info.kind === 'tower') return { minSlope: 0.8, maxSlope: 1.6, slope: 1.2, maxHeight: 10 };
  if (b.info.isChurch) return { minSlope: 0.4, maxSlope: 0.8, slope: 0.6, maxHeight: 12 };
  if (plan.material === 'slate') return { minSlope: 0.3, maxSlope: 1, slope: 0.6, maxHeight: 6 };
  return { minSlope: 0.18, maxSlope: 0.42, slope: 0.33, maxHeight: 4 };
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
    if (b.info.minHeight > 1 || b.info.kind === 'roof') continue; // 浮いているパーツ・屋根だけの構造物は隣の壁を隠さない
    for (const ring of [b.outer, ...b.holes]) {
      for (let i = 0; i < ring.length; i++) {
        const p = ring[i], q = ring[(i + 1) % ring.length];
        const sl = Math.sqrt((q[0] - p[0]) ** 2 + (q[1] - p[1]) ** 2);
        if (sl < 0.3) continue;
        grid.insertSegment(p[0], p[1], q[0], q[1], segs.length);
        segs.push({ p, q, b, ux: (q[0] - p[0]) / sl, uz: (q[1] - p[1]) / sl, seen: 0 });
      }
    }
  }
  const TOL = 0.8;
  let query = 0; // 同じ辺を 2 度数えないための印（問い合わせごとに増やす）
  // 辺 a→c のうち、隣の建物に接している区間 [t0, t1]（m）と、そこを隠す高さ
  return (b, a, c) => {
    const L = Math.sqrt((c[0] - a[0]) ** 2 + (c[1] - a[1]) ** 2);
    if (L < 0.3) return [];
    const ux = (c[0] - a[0]) / L, uz = (c[1] - a[1]) / L;
    const out = [];
    const mark = ++query;
    grid.query(Math.min(a[0], c[0]) - TOL, Math.min(a[1], c[1]) - TOL, Math.max(a[0], c[0]) + TOL, Math.max(a[1], c[1]) + TOL, (k) => {
      const s = segs[k];
      if (s.seen === mark) return;
      s.seen = mark;
      if (s.b === b || Math.abs(s.ux * ux + s.uz * uz) < 0.97) return;
      const dp = Math.abs((s.p[0] - a[0]) * -uz + (s.p[1] - a[1]) * ux), dq = Math.abs((s.q[0] - a[0]) * -uz + (s.q[1] - a[1]) * ux);
      if (dp > TOL || dq > TOL) return;
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

// covers: 辺ごとの、隣の建物に接している区間（makePartyIndex の結果）
function writeWalls(W, ring, sign, b, plainColor, facade, covers = null) {
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
    const parts = coverIntervals(L, covers?.[i] || []);
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

// 辺の重み（roofs.js）: 隣の建物（自分の軒の高さ − 3 m 以上の高さ）と接している長さが辺の半分以上なら 0（切妻の壁）
const PARTY_DROP = 3;
export function edgeWeights(b, rings, covers) {
  return rings.map((ring, ri) => ring.map((a, i) => {
    const c = ring[(i + 1) % ring.length];
    const L = Math.hypot(c[0] - a[0], c[1] - a[1]);
    let cov = 0;
    for (const [t0, t1, h] of covers[ri][i]) if (h >= b.info.height - PARTY_DROP) cov += t1 - t0;
    return cov >= 0.5 * L ? 0 : 1;
  }));
}

// 尖った屋根（ピラミッド・円錐など、凸形の建物だけ）
function writePointyRoof(W, ring, b, rColor) {
  const info = b.info;
  const top = info.height;
  const c = centroid(ring);
  const size = Math.sqrt(info.area);
  let rh = info.roofHeight;
  if (!(rh > 0)) rh = info.roofShape === 'pyramidal' ? Math.min(6, size * 0.35) : Math.min(14, size * 0.6);
  const apex = [c[0], top + rh, c[1]];
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], d = ring[(i + 1) % ring.length];
    roofTri(W.roof, [a[0], top, a[1]], [d[0], top, d[1]], apex, rColor);
  }
}

// 大きな建物で、IGN の屋根の高さを屋根全体に広げると勾配がこれより緩いもの（工場・商業施設・病院などの金属の低い屋根や、
// 屋上の設備の分だけ高低差がある陸屋根）は、瓦ではなく灰色の陸屋根にする
const LOW_PITCH = 0.08;
const LOW_PITCH_AREA = 2000;

// 屋根を書く。rings: [外周, ...穴]（壁と同じ輪）、covers: 辺ごとの隣と接する区間。
// 傾斜屋根が作れなければ（外形が乱れているなど）、軒の高さの陸屋根にする。
// 返り値: 'pitched'（傾斜屋根）| 'flat'（陸屋根）| 'fallback'（傾斜屋根を作れず陸屋根）
function writeRoof(W, rings, b, plainColor, covers, plan) {
  const info = b.info;
  const top = info.height;
  const [outer, ...holes] = rings;
  const tile = plan.material === 'tile';
  const rColor = roofColor(b, plan.material);
  if (plan.shape === 'flat') {
    if (tile) writeFlatPolygon(W.roof, outer, holes, top, 1.8, rColor);
    else writeFlatPolygon(W.flat, outer, holes, top, 4, rColor);
    return 'flat';
  }
  if (POINTY.has(plan.shape)) {
    writePointyRoof(W, outer, b, rColor);
    return 'pitched';
  }
  const w = tile ? W.roof : W.flat;
  let weights = edgeWeights(b, rings, covers);
  // 切妻（OSM の roof:shape=gabled）の四角形: 短い 2 辺を切妻の壁にする
  if (info.roofShape === 'gabled' && outer.length === 4 && !holes.length) {
    const len = (i) => Math.hypot(outer[(i + 1) % 4][0] - outer[i][0], outer[(i + 1) % 4][1] - outer[i][1]);
    const s = len(0) + len(2) < len(1) + len(3) ? 0 : 1;
    weights = [weights[0].map((x, i) => (i % 2 === s ? 0 : x))];
  }
  let roof = null;
  try {
    if (ringsSimple(rings)) roof = buildRoof(outer, holes, { weights, height: plan.height, ...slopeRange(b, plan) });
  } catch (err) {
    console.warn(`建物 ${b.id} の屋根を作れませんでした`, err); // 想定外の外形でも、タイル全体は止めない
  }
  if (!roof) {
    writeFlatPolygon(w, outer, holes, top, tile ? 1.8 : 4, rColor);
    return 'fallback';
  }
  if (tile && plan.height > 0 && info.area > LOW_PITCH_AREA && !info.isChurch && !b.tags['roof:material'] && plan.height < LOW_PITCH * roof.reach) {
    writeFlatPolygon(W.flat, outer, holes, top, 4, roofColor(b, 'flat'));
    return 'flat';
  }
  const R = roof.roof;
  const at = (arr, i) => [arr[i], top + arr[i + 1], arr[i + 2]];
  for (let i = 0; i < R.length; i += 9) roofTri(w, at(R, i), at(R, i + 3), at(R, i + 6), rColor);
  const T = roof.top;
  if (T.length) {
    // 上限で平らになった上面（terrasson）: 広ければ亜鉛・防水の灰色、狭ければ屋根の続き
    let area = 0;
    for (let i = 0; i < T.length; i += 9) area += Math.abs((T[i + 3] - T[i]) * (T[i + 8] - T[i + 2]) - (T[i + 6] - T[i]) * (T[i + 5] - T[i + 2])) / 2;
    const flat = area > 60;
    const tc = flat ? paletteColor(FLAT_ROOF, b.id, 6) : rColor;
    for (let i = 0; i < T.length; i += 9) {
      const p0 = at(T, i), p1 = at(T, i + 3), p2 = at(T, i + 6);
      if (flat) W.flat.tri(p0, p1, p2, [0, 1, 0], [p0[0] / 4, -p0[2] / 4], [p1[0] / 4, -p1[2] / 4], [p2[0] / 4, -p2[2] / 4], tc);
      else roofTri(w, p0, p1, p2, tc);
    }
  }
  // 切妻の壁（重み 0 の辺の上の三角形）: 隣の建物より高い所だけ、窓のない壁で埋める
  for (const g of roof.gables) {
    const ring = rings[g.ring];
    const sign = g.ring === 0 ? outwardSign(ring) : -outwardSign(ring);
    const dx = g.b[0] - g.a[0], dz = g.b[1] - g.a[1];
    const L = Math.hypot(dx, dz);
    const nrm = [(dz / L) * sign, 0, (-dx / L) * sign];
    for (const [t0, t1, cover] of coverIntervals(L, covers[g.ring][g.edge])) {
      const poly = clipGable(g.pts, t0, t1, Math.max(0, cover - top));
      if (!poly) continue;
      const idx = triangulate2(poly);
      const P = (q) => [g.a[0] + (dx / L) * q[0], top + q[1], g.a[1] + (dz / L) * q[0]];
      const U = (q) => [q[0] / 4, (top + q[1]) / 4];
      for (let i = 0; i < idx.length; i += 3) {
        const p0 = poly[idx[i]], p1 = poly[idx[i + 1]], p2 = poly[idx[i + 2]];
        W.plain.tri(P(p0), P(p1), P(p2), nrm, U(p0), U(p1), U(p2), plainColor);
      }
    }
  }
  return 'pitched';
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
    enclosureBrick: std(tex.enclosureBrick, { roughness: 0.95 }), // 敷地の塀（レンガ）
    enclosureRender: std(tex.enclosureRender, { roughness: 0.95 }), // 敷地の塀（漆喰）
    roof: std(tex.roof, { roughness: 0.85 }),
    flat: std(tex.flatRoof),
  };
}

const nextFrame = () => new Promise((r) => setTimeout(r, 0));
const now = () => globalThis.performance?.now() ?? Date.now();
const YIELD_MS = 30; // これだけ続けて計算したらフレームを譲る

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
  // ms: 組み立ての計算時間（フレームを譲って待った時間は除く）
  const stats = { total: list.length, OSM: 0, IGN: 0, 'OSM（階数）': 0, 推定: 0, roofs: { pitched: 0, flat: 0, fallback: 0 }, ms: 0 };
  let lastYield = now();
  const party = makePartyIndex(list.concat(context.filter((b) => !b.hasParts)));
  for (const t of towers) writeTower(t, getChunk(t.x, t.z).tower);
  for (let i = 0; i < list.length; i++) {
    const b = list[i];
    stats[b.info.heightSource] = (stats[b.info.heightSource] || 0) + 1;
    const W = getChunk(b.inside[0], b.inside[1]);
    // 外形のとげ・重なった頂点を除く（頂点を間引くだけなので、壁と屋根の両方にこの輪を使う）
    const outer = cleanRing(b.outer);
    const rings = outer ? [outer, ...b.holes.map((h) => cleanRing(h)).filter(Boolean)] : [b.outer, ...b.holes];
    // 八角形の鐘楼（towers.js のモデル）の中にある塔の外形は、尖った屋根をかけない（モデルの冠が見えるように）
    const inTower = towers.some((t) => t.building !== b && Math.hypot(b.inside[0] - t.x, b.inside[1] - t.z) < t.radius + 1);
    const plan = !outer ? { shape: 'flat', material: 'flat', height: 0 } : inTower ? { shape: 'flat', material: 'tile', height: 0 } : roofPlan(b);
    // 辺ごとの、隣の建物と接する区間（壁・屋根の切妻で使う）
    const covers = rings.map((ring) => ring.map((a, k) => party(b, a, ring[(k + 1) % ring.length])));
    const color = wallColor(b);
    writeWalls(W, rings[0], outwardSign(rings[0]), b, color, facade, covers[0]);
    for (let k = 1; k < rings.length; k++) writeWalls(W, rings[k], -outwardSign(rings[k]), b, color, null, covers[k]); // 中庭の壁は内向き
    if (b.info.minHeight > 0.5) {
      // 浮いているパーツ（張り出しなど）の底面
      writeFlatPolygon(W.plain, rings[0], rings.slice(1), b.info.minHeight, 4, color, false);
    }
    stats.roofs[writeRoof(W, rings, b, color, covers, plan)]++;
    // 組み立てが長くなったら 1 フレーム譲る（走行中のタイルの読み込みでカクつかないように）
    const busy = now() - lastYield;
    if (busy > YIELD_MS) {
      stats.ms += busy;
      onProgress?.(i / list.length);
      await nextFrame();
      lastYield = now();
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
  stats.ms += now() - lastYield;
  onProgress?.(1);
  return { group, stats };
}
