// 名所の建物の正面に、専用のテクスチャ（facades.js）を貼る場所を決める。
// いまはキャピトル（市庁舎）: キャピトル広場に面した、いちばん長い建物の壁を正面とする。
// あわせて、旧市街の建物・レンガ造りの歴史的な建物群・キャピトル広場を囲む建物に印を付ける（ファサードの様式を選ぶため）。
import { closestOnSegment, hash01, pointInPolygon, signedArea } from '../geo.js';
import { oldTownTest } from '../config.js';
import { CAPITOLE_HEIGHT, STYLE } from './facades.js';

/**
 * @returns {{ building, origin:number[], dir:number[], normal:number[], t0:number, t1:number, height:number } | null}
 *   dir: 正面に沿った単位ベクトル、normal: 外向き、t0〜t1: 正面の範囲（origin からの距離）
 */
export function findCapitoleFacade(parsed) {
  const square = parsed.areas.find((a) => /^Place du Capitole$/i.test(a.name || ''));
  if (!square) return null;
  const sb = square.bounds;
  const cx = (sb.minX + sb.maxX) / 2, cz = (sb.minZ + sb.maxZ) / 2;
  const nearSquare = (x, z) => {
    let best = Infinity;
    const r = square.outer;
    for (let i = 0; i < r.length; i++) {
      const a = r[i], b = r[(i + 1) % r.length];
      best = Math.min(best, closestOnSegment(x, z, a[0], a[1], b[0], b[1]).d2);
    }
    return Math.sqrt(best);
  };
  let best = null;
  for (const b of parsed.buildings) {
    const bb = b.bounds;
    if (bb.maxX < sb.minX - 20 || bb.minX > sb.maxX + 20 || bb.maxZ < sb.minZ - 20 || bb.minZ > sb.maxZ + 20) continue;
    const s = signedArea(b.outer) > 0 ? 1 : -1;
    const edges = [];
    let total = 0;
    for (let i = 0; i < b.outer.length; i++) {
      const a = b.outer[i], c = b.outer[(i + 1) % b.outer.length];
      const L = Math.hypot(c[0] - a[0], c[1] - a[1]);
      if (L < 3) continue;
      const nx = ((c[1] - a[1]) / L) * s, nz = (-(c[0] - a[0]) / L) * s;
      const mx = (a[0] + c[0]) / 2, mz = (a[1] + c[1]) / 2;
      const tl = Math.hypot(cx - mx, cz - mz) || 1;
      if ((nx * (cx - mx) + nz * (cz - mz)) / tl < 0.6 || nearSquare(mx, mz) > 15) continue;
      edges.push({ a, c, L, nx, nz });
      total += L;
    }
    if (total > 50 && (!best || total > best.total)) best = { b, edges, total };
  }
  if (!best) return null;
  // 正面の向き: 辺の法線の長さ重み付き平均
  let nx = 0, nz = 0;
  for (const e of best.edges) {
    nx += e.nx * e.L;
    nz += e.nz * e.L;
  }
  const nl = Math.hypot(nx, nz);
  nx /= nl;
  nz /= nl;
  const dir = [nz, -nx]; // 広場から見て左から右へ（テクスチャが裏返らないように）
  const origin = best.edges[0].a;
  let t0 = Infinity, t1 = -Infinity;
  for (const e of best.edges) {
    for (const p of [e.a, e.c]) {
      const t = (p[0] - origin[0]) * dir[0] + (p[1] - origin[1]) * dir[1];
      t0 = Math.min(t0, t);
      t1 = Math.max(t1, t);
    }
  }
  return { building: best.b, origin, dir, normal: [nx, nz], t0, t1, height: CAPITOLE_HEIGHT, edges: best.edges };
}

// 壁の一部（a→c、外向きの法線 n）が正面に含まれるなら、テクスチャの横の範囲 [u0, u1] を返す
export function facadeSpan(f, a, c, n) {
  if (!f || n[0] * f.normal[0] + n[2] * f.normal[1] < 0.7) return null;
  const onFacade = (p) => f.edges.some((e) => closestOnSegment(p[0], p[1], e.a[0], e.a[1], e.c[0], e.c[1]).d2 < 2.5 * 2.5);
  if (!onFacade(a) || !onFacade(c)) return null;
  const u = (p) => ((p[0] - f.origin[0]) * f.dir[0] + (p[1] - f.origin[1]) * f.dir[1] - f.t0) / (f.t1 - f.t0);
  return [u(a), u(c)];
}

// レンガ造りの歴史的な建物群（IGN のデータに壁の材料がないことが多い）。中心から半径 r m の大きな建物は
// ばら色のレンガに白い石の窓枠の様式にする
const BRICK_SITES = [
  // 利用者の写真（NCM_0107・0136・211104）: 背の高い 3 階（1 階 約 5 m）と屋根裏、低い勾配の瓦の寄棟屋根
  { name: 'Hôtel-Dieu Saint-Jacques', lat: 43.59935, lon: 1.43655, r: 85, floor: 5.2, tiles: true },
  { name: 'Hôpital de La Grave', lat: 43.60095, lon: 1.43405, r: 110 },
];
// 石の内陣の教会（利用者の写真 NCM_0095: サン・テティエンヌ大聖堂の東の内陣はレンガではなく、風雨にさらされた灰色がかった
// ベージュの石灰岩）。建物の中心から east の向きに split m より先の壁を石の色にする（buildings.js の教会の壁）
const STONE_CHOIRS = [{ name: 'Cathédrale Saint-Étienne', lat: 43.59988, lon: 1.45046, r: 30, east: [43.59996, 1.4515], split: 1 }];
// 屋根の材料がデータにない名所の屋根
const SLATE_ROOFS = [{ name: 'Donjon du Capitole', lat: 43.60442, lon: 1.44478, r: 10, colour: '#5f5f61' }];
// areas: 広場など（キャピトル広場に面した建物を見つけるのに使う）
export function markBrickSites(proj, buildings, areas = []) {
  // 旧市街の中の建物（ファサードの様式の割合を変える。buildings.js の facadeStyle）
  const inOld = oldTownTest(proj);
  for (const b of buildings) b.oldTown = inOld(b.inside[0], b.inside[1]);
  for (const s of BRICK_SITES) {
    const [x, z] = proj.project(s.lat, s.lon);
    for (const b of buildings) {
      if (b.info.area > 150 && Math.hypot(b.inside[0] - x, b.inside[1] - z) < s.r) {
        b.tags['building:material'] = 'brick';
        b.style = STYLE.brickStone;
        if (s.floor) b.info.floorHeight = s.floor;
        if (s.tiles) {
          b.tags['roof:material'] = 'roof_tiles';
          if (b.info.roofShape === 'flat') b.info.roofShape = 'auto';
          b.info.roofHeight = Math.max(b.info.roofHeight || 0, 3.5);
        }
      }
    }
  }
  for (const c of STONE_CHOIRS) {
    const [x, z] = proj.project(c.lat, c.lon), [ex, ez] = proj.project(...c.east);
    const l = Math.hypot(ex - x, ez - z) || 1, e = [(ex - x) / l, (ez - z) / l];
    for (const b of buildings) {
      if (b.info.isChurch && Math.hypot(b.inside[0] - x, b.inside[1] - z) < c.r) b.stoneFrom = { e, s0: x * e[0] + z * e[1] + c.split };
    }
  }
  // キャピトルの主塔（donjon）は急なスレートの屋根
  for (const s of SLATE_ROOFS) {
    const [x, z] = proj.project(s.lat, s.lon);
    for (const b of buildings) {
      if (Math.hypot(b.inside[0] - x, b.inside[1] - z) < s.r) {
        b.tags['roof:material'] = 'slate';
        b.tags['roof:colour'] = s.colour;
      }
    }
  }
  // キャピトル広場を囲む建物は、そろいのレンガ造り（1 階はアーケード）
  // 利用者の写真: 1 階がアーケードなのは西側の一続きの建物（Galerie des Arcades）だけ。北と南は 1 階が店のレンガ造り
  const square = areas.find((a) => /^Place du Capitole$/i.test(a.name || ''));
  if (square) {
    for (const b of facingSquare(square, buildings)) {
      b.tags['building:material'] = 'brick';
      b.style = b.inside[0] < square.bounds.minX + 6 ? STYLE.arcade : STYLE.brickStone;
    }
  }
}

// 広場の方を向いた 6 m 以上の壁がある建物。広場の地図の範囲は、まわりの通りを除いた石畳だけのことが多いので、
// 壁の前 4〜22 m のどこかが広場の中なら、広場に面しているとする
export function facingSquare(square, buildings) {
  const sb = square.bounds;
  const out = [];
  for (const b of buildings) {
    const bb = b.bounds;
    if (bb.maxX < sb.minX - 20 || bb.minX > sb.maxX + 20 || bb.maxZ < sb.minZ - 20 || bb.minZ > sb.maxZ + 20) continue;
    const s = signedArea(b.outer) > 0 ? 1 : -1;
    let facing = 0;
    for (let i = 0; i < b.outer.length; i++) {
      const a = b.outer[i], c = b.outer[(i + 1) % b.outer.length];
      const L = Math.hypot(c[0] - a[0], c[1] - a[1]);
      if (L < 1) continue;
      const nx = ((c[1] - a[1]) / L) * s, nz = (-(c[0] - a[0]) / L) * s;
      const mx = (a[0] + c[0]) / 2, mz = (a[1] + c[1]) / 2;
      if ([4, 10, 16, 22].some((d) => pointInPolygon(mx + nx * d, mz + nz * d, square))) facing += L;
    }
    if (facing >= 6) out.push(b);
  }
  return out;
}

// 通りの名前で決まる様式。通りの中心線から 道幅の半分 + STREET_REACH m 以内に、通りに沿った（向きの差 35° 以内）
// 長さ 4 m 以上の壁が通りの方を向いている建物（高さ 10 m 以上）に、styles から建物ごとに選んだ様式を付ける
// - 19 世紀末に切り開かれた通り（利用者の写真: Rue d'Alsace-Lorraine・Rue de Metz・Esquirol）: 砂色の切り石の
//   建物（STYLE.haussmann）と灰色の亜鉛の屋根。Alsace-Lorraine の建物は IGN でレンガとされていても写真では石
// - Rue de la République（サン・シプリアン。利用者の Street View）: 7 割はクリーム色・黄土色・サーモン色の漆喰に
//   レンガの窓枠、3 割はレンガのまま
const STREET_STYLES = [
  { name: /^(Rue d'Alsace[- ]Lorraine|Rue du Languedoc)$/i, styles: [[STYLE.haussmann, 1]], slate: true },
  // Rue de Metz・Esquirol はレンガの建物も混じる（利用者の写真: Esquirol のブラッスリー、Rue Bertrand de l'Isle の角）。
  // IGN の壁の材料がレンガの建物はそのまま
  { name: /^(Rue de Metz|Place [EÉ]tienne[- ]Esquirol)$/i, styles: [[STYLE.haussmann, 1]], slate: true, keepBrick: true },
  { name: /^Rue de la R[ée]publique$/i, styles: [[STYLE.ochre, 0.25], [STYLE.salmon, 0.25], [STYLE.cream, 0.2], [STYLE.brickStone, 0.15], [STYLE.brickShutters, 0.15]] },
];
const STREET_REACH = 10;
export function markStreetStyles(buildings, roads) {
  for (const rule of STREET_STYLES) {
    const segs = [];
    for (const r of roads) {
      if (r.tunnel || r.bridge || !rule.name.test(r.name || '')) continue;
      for (let i = 0; i + 1 < r.pts.length; i++) segs.push([r.pts[i], r.pts[i + 1], r.width / 2 + STREET_REACH]);
    }
    if (!segs.length) continue;
    for (const b of buildings) {
      if (b.style === STYLE.arcade || b.info.height < 10 || b.info.isChurch || (rule.keepBrick && b.tags['building:material'] === 'brick') || !facesStreet(b, segs)) continue;
      let r = hash01(b.id, 24);
      b.style = rule.styles.find(([, p]) => (r -= p) < 0)?.[0] ?? rule.styles[0][0];
      if (rule.slate) {
        b.tags['roof:material'] = 'slate';
        b.tags['roof:colour'] ||= '#6c6e72';
      }
    }
  }
}

function facesStreet(b, segs) {
  const bb = b.bounds;
  const s = signedArea(b.outer) > 0 ? 1 : -1;
  for (const [p, q, reach] of segs) {
    if (Math.max(p[0], q[0]) + reach < bb.minX || Math.min(p[0], q[0]) - reach > bb.maxX || Math.max(p[1], q[1]) + reach < bb.minZ || Math.min(p[1], q[1]) - reach > bb.maxZ) continue;
    const sl = Math.hypot(q[0] - p[0], q[1] - p[1]) || 1, ux = (q[0] - p[0]) / sl, uz = (q[1] - p[1]) / sl;
    for (let i = 0; i < b.outer.length; i++) {
      const a = b.outer[i], c = b.outer[(i + 1) % b.outer.length];
      const L = Math.hypot(c[0] - a[0], c[1] - a[1]);
      if (L < 4 || Math.abs(((c[0] - a[0]) * ux + (c[1] - a[1]) * uz) / L) < 0.82) continue;
      const mx = (a[0] + c[0]) / 2, mz = (a[1] + c[1]) / 2;
      const h = closestOnSegment(mx, mz, p[0], p[1], q[0], q[1]);
      if (h.d2 > reach * reach) continue;
      const nx = ((c[1] - a[1]) / L) * s, nz = (-(c[0] - a[0]) / L) * s;
      if (nx * (h.x - mx) + nz * (h.z - mz) > 0) return true;
    }
  }
  return false;
}
