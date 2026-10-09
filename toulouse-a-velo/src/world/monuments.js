// 名所の専用モデル（写真とユーザーの写真のメモを手本に組み立てる）。データの建物の外形の代わりに描く
// （当たり判定は元の外形のまま。像・柵は円の当たり判定を足す）。
//   シャトー・ドー:   円形のレンガの基壇（半円アーチの扉）・円筒の塔・手すり付きのテラス・細い上の円筒・灰色のドームと風見・黒い鉄柵
//   スタディアム:     外形（穴 = ピッチ）から、白い外壁・すり鉢の観客席・屋根・ピッチ・4 本の照明塔
//   カバニス:         3 つの外形をまとめた門の形（中央の大きな四角い開口）、テラコッタ色のルーバーと白い階の帯、屋上のガラスの庇
//   オクシタン十字:   キャピトル広場の石畳に埋め込まれたブロンズの十字（12 の玉に星座のメダル）。地面に貼る薄い板
//   雄鶏の像:         オリヴィエ広場。蹄鉄を溶接した暗い錆色の雄鶏（足元にラグビーボール）、赤い木の台（上面は黒）
import * as THREE from 'three';
import { MeshWriter, triangulate } from './meshwriter.js';
import { centroid, hash01, mulberry32, pointInPolygon, pointInRing, signedArea } from '../geo.js';
import { ORDER } from './ground.js';

export const MONUMENTS = [
  { id: 'chateau-eau', kind: 'chateau', lat: 43.59870, lon: 1.43693, r: 20 },
  { id: 'stadium', kind: 'stadium', lat: 43.58330, lon: 1.43404, r: 40 },
  // front: 庇のある正面（門）が向く先。ジャン・ジョレス通り（allées Jean-Jaurès）の軸の突き当たりに門が建つ
  { id: 'cabanis', kind: 'cabanis', lat: 43.61024, lon: 1.45576, r: 45, minHeight: 25, front: [43.6061, 1.4490] },
  { id: 'coq', kind: 'coq', lat: 43.59823, lon: 1.43445, plaza: /^Place Olivier$/i },
  { id: 'croix-occitane', kind: 'cross', plaza: /^Place du Capitole$/i, radius: 8 },
];

// ---------------------------------------------------------------- 形を決める計算（DOM なし。単体テストあり）

// 輪の中心と平均の半径（円形の外形）
export function circleOf(ring) {
  const [x, z] = centroid(ring);
  let r = 0;
  for (const p of ring) r += Math.hypot(p[0] - x, p[1] - z);
  return { x, z, r: r / ring.length };
}

function hull(points) {
  const p = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [], up = [];
  for (const q of p) {
    while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop();
    lo.push(q);
  }
  for (let i = p.length - 1; i >= 0; i--) {
    while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], p[i]) <= 0) up.pop();
    up.push(p[i]);
  }
  return lo.slice(0, -1).concat(up.slice(0, -1));
}

// 点の集まりを囲む、面積が最小の向きの付いた長方形。e1: 長い辺の向き（単位）、e2: それに直交、a ≥ b: 半分の長さ
export function orientedBox(points) {
  const h = hull(points);
  let best = null;
  for (let i = 0; i < h.length; i++) {
    const p = h[i], q = h[(i + 1) % h.length];
    const L = Math.hypot(q[0] - p[0], q[1] - p[1]);
    if (L < 1e-6) continue;
    const ux = (q[0] - p[0]) / L, uz = (q[1] - p[1]) / L;
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (const r of h) {
      const u = r[0] * ux + r[1] * uz, v = -r[0] * uz + r[1] * ux;
      u0 = Math.min(u0, u);
      u1 = Math.max(u1, u);
      v0 = Math.min(v0, v);
      v1 = Math.max(v1, v);
    }
    const area = (u1 - u0) * (v1 - v0);
    if (!best || area < best.area) best = { area, ux, uz, u0, u1, v0, v1 };
  }
  const { ux, uz, u0, u1, v0, v1 } = best;
  const cu = (u0 + u1) / 2, cv = (v0 + v1) / 2;
  const cx = cu * ux - cv * uz, cz = cu * uz + cv * ux;
  let e1 = [ux, uz], e2 = [-uz, ux], a = (u1 - u0) / 2, b = (v1 - v0) / 2;
  if (b > a) [e1, e2, a, b] = [e2, [-e2[0], -e2[1]], b, a];
  return { cx, cz, e1, e2, a, b };
}

// (cx, cz) から向き (dx, dz) の半直線が輪と交わるいちばん遠い距離（交わらなければ 0）
export function rayRing(cx, cz, dx, dz, ring) {
  let best = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    const ex = b[0] - a[0], ez = b[1] - a[1];
    const den = dx * ez - dz * ex;
    if (Math.abs(den) < 1e-12) continue;
    const t = ((a[0] - cx) * ez - (a[1] - cz) * ex) / den;
    const s = ((a[0] - cx) * dz - (a[1] - cz) * dx) / den;
    if (t > 0 && s >= 0 && s <= 1) best = Math.max(best, t);
  }
  return best;
}

// スタジアム: 中心から n 本の放射線で、内側（ピッチの穴）と外側（外壁）までの距離を測る
export function stadiumRays(outer, hole, n = 72) {
  const ref = hole && hole.length >= 3 ? hole : outer;
  const [cx, cz] = centroid(ref);
  const rays = [];
  for (let i = 0; i < n; i++) {
    const t = (i / n) * Math.PI * 2;
    const dx = Math.cos(t), dz = Math.sin(t);
    const rout = rayRing(cx, cz, dx, dz, outer);
    let rin = hole && hole.length >= 3 ? rayRing(cx, cz, dx, dz, hole) : rout * 0.62;
    if (!(rin > 0) || rin > rout - 6) rin = rout * 0.62;
    rays.push({ dx, dz, rin, rout });
  }
  return { cx, cz, rays };
}

// カバニス: 外形の集まりから、門の枠（向きの付いた長方形）と中央の開口（u の範囲）を決める。
// 開口は、長い向き（u）に並んだ外形の真ん中のもの（なければ中央の 1/4 の幅）。mid: 開口にした外形の番号（なければ -1）
export function cabanisLayout(rings, frontPoint = null) {
  const box = orientedBox(rings.flat());
  const proj = (p) => (p[0] - box.cx) * box.e1[0] + (p[1] - box.cz) * box.e1[1];
  let m0 = -box.a * 0.12, m1 = box.a * 0.12, mid = -1;
  if (rings.length >= 3) {
    // 小さなかけら（面積の小さい外形）は数えない
    const big = rings.map((r, i) => ({ i, u: proj(centroid(r)), area: Math.abs(signedArea(r)) })).filter((q) => q.area >= 100).sort((p, q) => p.u - q.u);
    if (big.length >= 3) {
      mid = big[Math.floor(big.length / 2)].i;
      const us = rings[mid].map(proj);
      m0 = Math.min(...us);
      m1 = Math.max(...us);
    }
    // 端まで届く（真ん中にない）ときや、細すぎ・太すぎのときは中央に置く
    if (mid < 0 || m0 < -box.a * 0.9 || m1 > box.a * 0.9 || m1 - m0 < 6 || m1 - m0 > box.a) {
      m0 = -box.a * 0.12;
      m1 = box.a * 0.12;
      mid = -1;
    }
  }
  let front = 1;
  if (frontPoint) front = (frontPoint[0] - box.cx) * box.e2[0] + (frontPoint[1] - box.cz) * box.e2[1] >= 0 ? 1 : -1;
  return { ...box, m0, m1, mid, front };
}

const bez = (p0, c, p1, n, out) => {
  for (let i = 1; i <= n; i++) {
    const t = i / n, s = 1 - t;
    out.push([s * s * p0[0] + 2 * s * t * c[0] + t * t * p1[0], s * s * p0[1] + 2 * s * t * c[1] + t * t * p1[1]]);
  }
};
// オクシタン十字（トゥールーズの十字: 中が空いて、腕の先が鍵の形に分かれ、12 の玉が付く）。
// 中心 (0,0)、腕は ±x・±z、R: 中心から先端の玉までの距離。ring: 輪郭（閉じた折れ線）、pommels: 12 の玉の位置
export function occitanCross(R = 8) {
  const inner = [0.13 * R, 0.13 * R], corner = [0.9 * R, 0.47 * R], tip = [R, 0];
  // 1 本の腕（+x）の上半分: 付け根の内角 → 広がる脇の線 → 角の玉 → 先端の内側へ戻る弧 → 先端の玉
  const half = [inner];
  bez(inner, [0.52 * R, 0.15 * R], corner, 10, half);
  bez(corner, [0.6 * R, 0.17 * R], tip, 8, half);
  const arm = half.concat(half.slice(0, -1).reverse().map(([x, z]) => [x, -z]));
  arm.pop(); // 下半分の付け根の内角は、次の腕の最初の点と同じ
  const rot = ([x, z], k) => (k === 0 ? [x, z] : k === 1 ? [z, -x] : k === 2 ? [-x, -z] : [-z, x]);
  const ring = [];
  const pommels = [];
  for (let k = 0; k < 4; k++) {
    for (const p of arm) ring.push(rot(p, k));
    pommels.push(rot(corner, k), rot(tip, k), rot([corner[0], -corner[1]], k));
  }
  return { ring, pommels };
}

// 折れ線の線（幅 width、中心線から offset 横にずらす）を四角形の列にする。閉じた折れ線は closed
export function strokeQuads(pts, closed, offset, width) {
  const n = pts.length;
  const segN = (i) => {
    const a = pts[i], b = pts[(i + 1) % n];
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    return [(b[1] - a[1]) / L, -(b[0] - a[0]) / L];
  };
  const side = [];
  for (let i = 0; i < n; i++) {
    const hasPrev = closed || i > 0, hasNext = closed || i < n - 1;
    const n0 = hasPrev ? segN((i - 1 + n) % n) : segN(i);
    const n1 = hasNext ? segN(i) : n0;
    let mx = n0[0] + n1[0], mz = n0[1] + n1[1];
    const ml = Math.hypot(mx, mz) || 1;
    mx /= ml;
    mz /= ml;
    const k = 1 / Math.max(0.35, mx * n1[0] + mz * n1[1]); // 角を尖らせすぎない
    const p = pts[i];
    const o0 = (offset - width / 2) * k, o1 = (offset + width / 2) * k;
    side.push([[p[0] + mx * o0, p[1] + mz * o0], [p[0] + mx * o1, p[1] + mz * o1]]);
  }
  const quads = [];
  for (let i = 0; i < (closed ? n : n - 1); i++) {
    const a = side[i], b = side[(i + 1) % n];
    quads.push([a[0], a[1], b[1], b[0]]);
  }
  return quads;
}

// 広場の中で、hint にいちばん近い置ける場所（ok(x, z) が真）。らせん状に探す
export function placeOnPlaza(plaza, hint, ok, maxR = 30) {
  const inside = (x, z) => (plaza ? pointInPolygon(x, z, plaza) : true) && ok(x, z);
  if (inside(hint[0], hint[1])) return hint;
  for (let r = 1; r <= maxR; r += 1) {
    const n = Math.max(8, Math.round(r * 4));
    for (let i = 0; i < n; i++) {
      const t = (i / n) * Math.PI * 2;
      const x = hint[0] + Math.cos(t) * r, z = hint[1] + Math.sin(t) * r;
      if (inside(x, z)) return [x, z];
    }
  }
  return null;
}

// スタジアムの外壁に食い込んだ小さな建物（角の階段の塔など）: 外形の頂点と頂点を共有する、高さ 6 m 以上のもの
// （低い売店・切符売り場はそのまま）
export function stadiumAnnexes(stadium, buildings, maxArea = 400) {
  const near = (p) => stadium.outer.some((q) => Math.hypot(p[0] - q[0], p[1] - q[1]) < 1.5);
  return buildings.filter((b) => b !== stadium && b.info.area < maxArea && (b.info.height || 0) >= 6 && b.outer.some(near));
}

// 名所の専用モデルの置き場所を決める。buildings: このタイル（エリア）の建物、bounds: このタイルの範囲
// （像・十字はその中にあるときだけ作る）、onRoad(x, z): 車道の上か。replaced の建物は描かない（当たり判定は残す）
export function findMonuments(proj, { buildings = [], areas = [], facade = null, bounds = null, onRoad = () => false } = {}) {
  const out = [];
  const inB = (x, z) => !bounds || (x >= bounds.minX && x < bounds.maxX && z >= bounds.minZ && z < bounds.maxZ);
  const inBuilding = (x, z, m = 0) => buildings.some((b) => x > b.bounds.minX - m && x < b.bounds.maxX + m && z > b.bounds.minZ - m && z < b.bounds.maxZ + m && pointInRing(x, z, b.outer));
  for (const spec of MONUMENTS) {
    const [x, z] = spec.lat != null ? proj.project(spec.lat, spec.lon) : [0, 0];
    if (spec.kind === 'chateau') {
      // 円形の基壇の外形（頂点の多い、小さめの建物）
      let best = null;
      for (const b of buildings) {
        const d = Math.hypot(b.inside[0] - x, b.inside[1] - z);
        if (d > spec.r || b.outer.length < 8 || b.info.area < 60 || b.info.area > 700) continue;
        if (!best || d < best.d) best = { b, d };
      }
      if (!best) continue;
      const c = circleOf(best.b.outer);
      out.push({ spec, kind: 'chateau', x: c.x, z: c.z, rBase: Math.min(11, Math.max(5, c.r)), replaced: [best.b] });
    } else if (spec.kind === 'stadium') {
      const b = buildings.find((q) => q.info.area > 5000 && Math.hypot(centroid(q.outer)[0] - x, centroid(q.outer)[1] - z) < spec.r);
      if (!b) continue;
      const hole = b.holes.slice().sort((p, q) => q.length - p.length)[0] || null;
      const annex = stadiumAnnexes(b, buildings);
      out.push({ spec, kind: 'stadium', outer: b.outer, hole, annex: annex.map((q) => q.outer), replaced: [b, ...annex], height: b.info.height || 12 });
    } else if (spec.kind === 'cabanis') {
      const parts = buildings.filter((b) => (b.info.height || 0) >= spec.minHeight && Math.hypot(centroid(b.outer)[0] - x, centroid(b.outer)[1] - z) < spec.r);
      if (!parts.length) continue;
      const front = spec.front ? proj.project(spec.front[0], spec.front[1]) : null;
      const lay = cabanisLayout(parts.map((b) => b.outer), front);
      // 開口の下（真ん中の外形）は通り抜けられる（当たり判定を付けない）
      out.push({ spec, kind: 'cabanis', layout: lay, height: Math.max(...parts.map((b) => b.info.height)), replaced: parts, open: lay.mid >= 0 ? [parts[lay.mid]] : [] });
    } else if (spec.kind === 'coq') {
      const plaza = areas.find((a) => spec.plaza.test(a.name || ''));
      // 車道から 2 m 以上、建物から 3 m 以上離す
      const free = (px, pz) => {
        for (let k = 0; k < 8; k++) {
          const t = (k / 8) * Math.PI * 2;
          if (onRoad(px + Math.cos(t) * 2.5, pz + Math.sin(t) * 2.5)) return false;
        }
        return !inBuilding(px, pz, 3);
      };
      const p = placeOnPlaza(plaza, [x, z], free);
      if (!p || !inB(p[0], p[1])) continue;
      // 像はいちばん近い車道の方を向く
      let angle = 0, bestD = Infinity;
      for (let k = 0; k < 16; k++) {
        const t = (k / 16) * Math.PI * 2;
        for (let d = 2.5; d < 40; d += 0.5) {
          if (onRoad(p[0] + Math.cos(t) * d, p[1] + Math.sin(t) * d)) {
            if (d < bestD) [bestD, angle] = [d, t];
            break;
          }
        }
      }
      out.push({ spec, kind: 'coq', x: p[0], z: p[1], angle, replaced: [] });
    } else if (spec.kind === 'cross') {
      const plaza = areas.find((a) => spec.plaza.test(a.name || ''));
      if (!plaza) continue;
      let [cx, cz] = centroid(plaza.outer);
      let ax = [1, 0];
      if (facade) {
        // キャピトルの正面の中央から、広場の中心へ（十字は正面の軸の上）
        const t = (facade.t0 + facade.t1) / 2;
        const mx = facade.origin[0] + facade.dir[0] * t, mz = facade.origin[1] + facade.dir[1] * t;
        const d = (cx - mx) * facade.normal[0] + (cz - mz) * facade.normal[1];
        cx = mx + facade.normal[0] * d;
        cz = mz + facade.normal[1] * d;
        ax = facade.normal;
      }
      if (!inB(cx, cz)) continue;
      out.push({ spec, kind: 'cross', x: cx, z: cz, ax, radius: spec.radius, replaced: [] });
    }
  }
  return out;
}

// 木を植えない所（像・塔のまわり）
export function monumentClearance(list) {
  const circles = [];
  for (const m of list) {
    if (m.kind === 'chateau') circles.push([m.x, m.z, m.rBase + 9]); // 柵の外の歩道まで（交差点から塔が見えるように）
    if (m.kind === 'coq') circles.push([m.x, m.z, 3]);
  }
  return (x, z) => circles.some(([cx, cz, r]) => Math.hypot(x - cx, z - cz) < r);
}

// 名所の台・柵の内側（街の小物 furniture.js を置かない所）。buildMonuments の当たり判定の円 [x, z, r] だけを見る
export function monumentSolid(colliders, pad = 0.4) {
  const circles = colliders.filter((c) => c.length === 3);
  return (x, z) => circles.some(([cx, cz, r]) => Math.hypot(x - cx, z - cz) < r + pad);
}

// ---------------------------------------------------------------- メッシュ

// テクスチャの区画（makeMonumentTexture）。1 区画 = 256 px 四方
const CELL = { brick: 0, louvre: 1, seats: 2, pitch: 3, cladding: 4, plain: 5 };
const NCELL = 6;
const UE = 0.004; // 区画の境のにじみを避ける
const cu = (cell, u) => (cell + UE + Math.min(1, Math.max(0, u)) * (1 - 2 * UE)) / NCELL;
const PLAIN_UV = [cu(CELL.plain, 0.5), 0.5];
const col = (hex) => {
  const c = new THREE.Color(hex);
  return [c.r, c.g, c.b];
};
const WHITE = [1, 1, 1];

// 縦の壁 a→b（[x, z]）、高さ y0〜y1。テクスチャの区画 1 枚を cw × ch m に敷き詰める（端数は区画を伸ばす）
function wall(w, a, b, y0, y1, n, cell, cw, ch, color = WHITE) {
  const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const nu = Math.max(1, Math.round(L / cw)), nv = Math.max(1, Math.round((y1 - y0) / ch));
  for (let i = 0; i < nu; i++) {
    const s0 = i / nu, s1 = (i + 1) / nu;
    const p0 = [a[0] + (b[0] - a[0]) * s0, a[1] + (b[1] - a[1]) * s0], p1 = [a[0] + (b[0] - a[0]) * s1, a[1] + (b[1] - a[1]) * s1];
    for (let j = 0; j < nv; j++) {
      const ya = y0 + ((y1 - y0) * j) / nv, yb = y0 + ((y1 - y0) * (j + 1)) / nv;
      w.quad([p0[0], ya, p0[1]], [p1[0], ya, p1[1]], [p1[0], yb, p1[1]], [p0[0], yb, p0[1]], n,
        [cu(cell, 0), 0], [cu(cell, 1), 0], [cu(cell, 1), 1], [cu(cell, 0), 1], color);
    }
  }
}

// 円筒（半径 r0→r1、y0〜y1）。外向き（inward なら内向き）。区画 1 枚 ≒ cw × ch m
function cylinder(w, cx, cz, r0, r1, y0, y1, { seg = 24, cell = CELL.plain, cw = 1e9, ch = 1e9, color = WHITE, inward = false } = {}) {
  const nv = Math.max(1, Math.round((y1 - y0) / ch));
  const per = Math.max(1, Math.round((2 * Math.PI * Math.max(r0, r1)) / seg / cw));
  for (let k = 0; k < seg; k++) {
    const a0 = (k / seg) * Math.PI * 2, a1 = ((k + 1) / seg) * Math.PI * 2, am = (a0 + a1) / 2;
    const sl = (r0 - r1) / Math.max(0.01, y1 - y0);
    const nl = Math.hypot(1, sl), sg = inward ? -1 : 1;
    const n = [(Math.cos(am) / nl) * sg, (sl / nl) * sg, (Math.sin(am) / nl) * sg];
    for (let j = 0; j < nv; j++) {
      const ya = y0 + ((y1 - y0) * j) / nv, yb = y0 + ((y1 - y0) * (j + 1)) / nv;
      const ra = r0 + ((r1 - r0) * j) / nv, rb = r0 + ((r1 - r0) * (j + 1)) / nv;
      const P = (a, r, y) => [cx + Math.cos(a) * r, y, cz + Math.sin(a) * r];
      const uvs = cell === CELL.plain ? [PLAIN_UV, PLAIN_UV, PLAIN_UV, PLAIN_UV]
        : [[cu(cell, (k % per) / per), 0], [cu(cell, ((k % per) + 1) / per), 0], [cu(cell, ((k % per) + 1) / per), 1], [cu(cell, (k % per) / per), 1]];
      w.quad(P(a0, ra, ya), P(a1, ra, ya), P(a1, rb, yb), P(a0, rb, yb), n, ...uvs, color);
    }
  }
}

// 水平の輪（r0〜r1、高さ y）。up: 上向き
function annulus(w, cx, cz, r0, r1, y, seg, color, up = true) {
  for (let k = 0; k < seg; k++) {
    const a0 = (k / seg) * Math.PI * 2, a1 = ((k + 1) / seg) * Math.PI * 2;
    const P = (a, r) => [cx + Math.cos(a) * r, y, cz + Math.sin(a) * r];
    if (r0 < 0.01) w.tri([cx, y, cz], P(a0, r1), P(a1, r1), [0, up ? 1 : -1, 0], PLAIN_UV, PLAIN_UV, PLAIN_UV, color);
    else w.quad(P(a0, r0), P(a1, r0), P(a1, r1), P(a0, r1), [0, up ? 1 : -1, 0], PLAIN_UV, PLAIN_UV, PLAIN_UV, PLAIN_UV, color);
  }
}

// 向きの付いた箱。o: 中心、ex/ey/ez: 半分の辺のベクトル（3 次元）。colors: { top, side, bottom }
function box(w, o, ex, ey, ez, color, { top = color, bottom = color } = {}) {
  const V = (sx, sy, sz) => [o[0] + ex[0] * sx + ey[0] * sy + ez[0] * sz, o[1] + ex[1] * sx + ey[1] * sy + ez[1] * sz, o[2] + ex[2] * sx + ey[2] * sy + ez[2] * sz];
  const N = (v, s) => {
    const l = Math.hypot(...v) || 1;
    return [(v[0] / l) * s, (v[1] / l) * s, (v[2] / l) * s];
  };
  const face = (a, b, c, d, n, cl) => w.quad(a, b, c, d, n, PLAIN_UV, PLAIN_UV, PLAIN_UV, PLAIN_UV, cl);
  face(V(1, -1, -1), V(1, 1, -1), V(1, 1, 1), V(1, -1, 1), N(ex, 1), color);
  face(V(-1, -1, -1), V(-1, 1, -1), V(-1, 1, 1), V(-1, -1, 1), N(ex, -1), color);
  face(V(-1, 1, -1), V(1, 1, -1), V(1, 1, 1), V(-1, 1, 1), N(ey, 1), top);
  face(V(-1, -1, -1), V(1, -1, -1), V(1, -1, 1), V(-1, -1, 1), N(ey, -1), bottom);
  face(V(-1, -1, 1), V(1, -1, 1), V(1, 1, 1), V(-1, 1, 1), N(ez, 1), color);
  face(V(-1, -1, -1), V(1, -1, -1), V(1, 1, -1), V(-1, 1, -1), N(ez, -1), color);
}

// 縦の平面の上の凸多角形（s: 面に沿った向き、pts: [s, y]）。n: 表の向き
function vpoly(w, o, s, pts, n, color) {
  const P = ([a, y]) => [o[0] + s[0] * a, y, o[1] + s[1] * a];
  for (let i = 1; i + 1 < pts.length; i++) w.tri(P(pts[0]), P(pts[i]), P(pts[i + 1]), n, PLAIN_UV, PLAIN_UV, PLAIN_UV, color);
}
// 半円アーチの開口の形（幅 wd、高さ ht、足元 y0）
const archShape = (wd, ht, y0, seg = 10) => {
  const r = wd / 2, pts = [[-r, y0], [r, y0]];
  for (let i = 0; i <= seg; i++) {
    const t = (i / seg) * Math.PI;
    pts.push([Math.cos(t) * r, y0 + ht - r + Math.sin(t) * r]);
  }
  return pts;
};

// でこぼこの塊（だ円体を角張った面で）。o: 中心、r: [rx, ry, rz]、yaw: y 軸まわりの回転、colorAt(i): 面ごとの色
function blob(w, o, r, yaw, seg, rings, colorAt) {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  const P = (i, j) => {
    const ph = (j / rings) * Math.PI, th = (i / seg) * Math.PI * 2;
    const lx = Math.sin(ph) * Math.cos(th) * r[0], ly = Math.cos(ph) * r[1], lz = Math.sin(ph) * Math.sin(th) * r[2];
    return [o[0] + lx * c - lz * s, o[1] + ly, o[2] + lx * s + lz * c];
  };
  let f = 0;
  for (let j = 0; j < rings; j++) {
    for (let i = 0; i < seg; i++) {
      const a = P(i, j), b = P(i + 1, j), cc = P(i + 1, j + 1), d = P(i, j + 1);
      const m = [(a[0] + cc[0]) / 2 - o[0], (a[1] + cc[1]) / 2 - o[1], (a[2] + cc[2]) / 2 - o[2]];
      const l = Math.hypot(...m) || 1;
      const n = [m[0] / l, m[1] / l, m[2] / l];
      const cl = colorAt(f++);
      if (j === 0) w.tri(a, cc, d, n, PLAIN_UV, PLAIN_UV, PLAIN_UV, cl);
      else if (j === rings - 1) w.tri(a, b, d, n, PLAIN_UV, PLAIN_UV, PLAIN_UV, cl);
      else w.quad(a, b, cc, d, n, PLAIN_UV, PLAIN_UV, PLAIN_UV, PLAIN_UV, cl);
    }
  }
}

// ---- シャトー・ドー
const BRICK_CW = 1.5; // レンガの区画 1 枚の大きさ（m）
function writeChateau(m, W, groundAt, colliders, onRoad) {
  const { x, z } = m;
  const y0 = groundAt(x, z);
  const rB = m.rBase, hB = 5, rT = 3.5, yT = y0 + 19, rU = 2.3, yU = y0 + 21.8, rD = 2.45;
  const STONE = col('#e4d8c4'), DARK = col('#2a2420'), IRON = col('#1b1b1c'), ROOF = col('#a39486');
  const w = W.main;
  // 基壇（太い円形のレンガ）と石の笠、平らな屋上
  cylinder(w, x, z, rB, rB, y0 - 0.5, y0 + hB - 0.45, { seg: 64, cell: CELL.brick, cw: BRICK_CW, ch: BRICK_CW });
  cylinder(w, x, z, rB + 0.15, rB + 0.15, y0 + hB - 0.45, y0 + hB, { seg: 64, color: STONE });
  annulus(w, x, z, rB + 0.15, rB, y0 + hB - 0.45, 64, STONE, false);
  annulus(w, x, z, rT, rB + 0.15, y0 + hB, 64, ROOF);
  // 半円アーチの扉（北・南・西の 3 か所、白い石の枠）
  for (const a of [-Math.PI / 2, Math.PI / 2, Math.PI]) {
    const n = [Math.cos(a), 0, Math.sin(a)], s = [-Math.sin(a), Math.cos(a)];
    vpoly(w, [x + n[0] * (rB + 0.06), z + n[2] * (rB + 0.06)], s, archShape(3.1, 4.1, y0), n, STONE);
    vpoly(w, [x + n[0] * (rB + 0.14), z + n[2] * (rB + 0.14)], s, archShape(2.3, 3.6, y0), n, DARK);
  }
  // 塔（円筒のレンガ）と石の帯、細い窓
  cylinder(w, x, z, rT, rT, y0 + hB, yT, { seg: 24, cell: CELL.brick, cw: BRICK_CW, ch: BRICK_CW });
  for (const yb of [y0 + hB + 4.6, y0 + hB + 9.4]) cylinder(w, x, z, rT + 0.08, rT + 0.08, yb, yb + 0.35, { seg: 24, color: STONE });
  for (let k = 0; k < 4; k++) {
    const a = (k / 4) * Math.PI * 2 + Math.PI / 4;
    const n = [Math.cos(a), 0, Math.sin(a)], s = [-Math.sin(a), Math.cos(a)];
    for (const yw of [y0 + hB + 1.6, y0 + hB + 6.3, y0 + hB + 10.6]) {
      vpoly(w, [x + n[0] * (rT + 0.05), z + n[2] * (rT + 0.05)], s, archShape(0.6, 1.7, yw, 6), n, DARK);
    }
  }
  // テラス（張り出した石の床）と黒い鉄の手すり
  const rS = rT + 0.75;
  cylinder(w, x, z, rS, rS, yT - 0.45, yT, { seg: 24, color: STONE });
  annulus(w, x, z, 0, rS, yT - 0.45, 24, STONE, false);
  annulus(w, x, z, rU, rS, yT, 24, ROOF);
  const mt = W.metal;
  const rR = rS - 0.12;
  cylinder(mt, x, z, rR, rR, yT + 1.0, yT + 1.07, { seg: 32, color: IRON });
  cylinder(mt, x, z, rR, rR, yT + 1.0, yT + 1.07, { seg: 32, color: IRON, inward: true });
  const nb = Math.round((2 * Math.PI * rR) / 0.3);
  for (let k = 0; k < nb; k++) {
    const a = (k / nb) * Math.PI * 2;
    const p = [x + Math.cos(a) * rR, z + Math.sin(a) * rR], s = [-Math.sin(a), Math.cos(a)];
    for (const sg of [1, -1]) vpoly(mt, p, s, [[-0.02, yT], [0.02, yT], [0.02, yT + 1.0], [-0.02, yT + 1.0]], [Math.cos(a) * sg, 0, Math.sin(a) * sg], IRON);
  }
  // 上の細い円筒と、灰色のドーム、小さな頂塔と風見
  cylinder(w, x, z, rU, rU, yT, yU, { seg: 20, cell: CELL.brick, cw: BRICK_CW, ch: BRICK_CW });
  cylinder(w, x, z, rU + 0.12, rU + 0.12, yU - 0.3, yU, { seg: 20, color: STONE });
  annulus(w, x, z, rD, rU + 0.12, yU, 20, STONE);
  for (let k = 0; k < 4; k++) {
    const a = (k / 4) * Math.PI * 2;
    const n = [Math.cos(a), 0, Math.sin(a)], s = [-Math.sin(a), Math.cos(a)];
    vpoly(w, [x + n[0] * (rU + 0.04), z + n[2] * (rU + 0.04)], s, archShape(0.55, 1.3, yT + 0.6, 6), n, DARK);
  }
  const ZINC = col('#8b9196');
  for (let j = 0; j < 6; j++) {
    const p0 = (j / 6) * (Math.PI / 2), p1 = ((j + 1) / 6) * (Math.PI / 2);
    cylinder(mt, x, z, Math.cos(p0) * rD, Math.max(0.3, Math.cos(p1) * rD), yU + Math.sin(p0) * rD * 0.9, yU + Math.sin(p1) * rD * 0.9, { seg: 20, color: ZINC });
  }
  const yL = yU + rD * 0.9;
  cylinder(mt, x, z, 0.32, 0.32, yL - 0.1, yL + 0.55, { seg: 8, color: ZINC });
  cylinder(mt, x, z, 0.42, 0.02, yL + 0.55, yL + 1.0, { seg: 8, color: ZINC });
  box(mt, [x, yL + 1.6, z], [0.03, 0, 0], [0, 0.65, 0], [0, 0, 0.03], IRON);
  box(mt, [x + 0.15, yL + 1.95, z], [0.55, 0, 0], [0, 0.05, 0], [0, 0, 0.012], IRON); // 風見の矢
  vpoly(mt, [x - 0.35, z], [1, 0], [[0, yL + 1.85], [-0.12, yL + 2.15], [-0.32, yL + 2.15], [-0.22, yL + 1.95]], [0, 0, 1], IRON);
  vpoly(mt, [x - 0.35, z], [1, 0], [[0, yL + 1.85], [-0.12, yL + 2.15], [-0.32, yL + 2.15], [-0.22, yL + 1.95]], [0, 0, -1], IRON);
  box(mt, [x, yL + 1.45, z], [0.35, 0, 0], [0, 0.02, 0], [0, 0, 0.02], IRON);
  box(mt, [x, yL + 1.45, z], [0.02, 0, 0], [0, 0.02, 0], [0, 0, 0.35], IRON);
  // 基壇を囲む黒い鉄柵（道路の上には立てない）。当たり判定は全部立てば円 1 つ、すき間があれば立てた区間ごとの線分
  const rF = rB + 1.4;
  const nf = Math.round((2 * Math.PI * rF) / 0.16);
  const P = (k) => {
    const a = (k / nf) * Math.PI * 2;
    return [x + Math.cos(a) * rF, z + Math.sin(a) * rF];
  };
  const up = [];
  for (let k = 0; k < nf; k++) up.push(!onRoad(...P(k)));
  for (let k = 0; k < nf; k++) {
    if (!up[k]) continue;
    const a = (k / nf) * Math.PI * 2;
    const [px, pz] = P(k);
    const yg = groundAt(px, pz);
    const s = [-Math.sin(a), Math.cos(a)];
    for (const sg of [1, -1]) vpoly(mt, [px, pz], s, [[-0.018, yg], [0.018, yg], [0.018, yg + 1.35], [-0.018, yg + 1.35]], [Math.cos(a) * sg, 0, Math.sin(a) * sg], IRON);
    // 横の桟は次の次の柱まで（間の柱が道路で抜けていれば渡さない）
    if (k % 2 === 0 && up[(k + 1) % nf] && up[(k + 2) % nf]) {
      const [qx, qz] = P(k + 2);
      for (const yy of [yg + 0.12, yg + 1.22]) {
        for (const sg of [1, -1]) {
          mt.quad([px, yy, pz], [qx, yy, qz], [qx, yy + 0.05, qz], [px, yy + 0.05, pz], [Math.cos(a) * sg, 0, Math.sin(a) * sg], PLAIN_UV, PLAIN_UV, PLAIN_UV, PLAIN_UV, IRON);
        }
      }
    }
  }
  for (const c of fenceColliders(x, z, rF, up)) colliders.push(c);
}

// 円い柵の当たり判定: 全部の柱が立てば円 [x, z, r]、抜けがあれば立った柱の続く区間を 8 本ごとの線分 [ax, az, bx, bz] にする
export function fenceColliders(x, z, r, up) {
  const n = up.length;
  if (up.every(Boolean)) return [[x, z, r + 0.05]];
  const P = (k) => [x + Math.cos((k / n) * Math.PI * 2) * r, z + Math.sin((k / n) * Math.PI * 2) * r];
  const out = [];
  const start = up.indexOf(false); // 抜けの所から回れば、区間が一周の境目で切れない
  if (start < 0) return out;
  let run = [];
  const flush = () => {
    for (let i = 0; i + 1 < run.length; i += 8) {
      const a = P(run[i]), b = P(run[Math.min(i + 8, run.length - 1)]);
      out.push([a[0], a[1], b[0], b[1]]);
    }
    run = [];
  };
  for (let j = 1; j <= n; j++) {
    const k = (start + j) % n;
    if (up[k]) run.push(k);
    else flush();
  }
  flush();
  return out;
}

// ---- スタディアム
function writeStadium(m, W, groundAt) {
  const { cx, cz, rays } = stadiumRays(m.outer, m.hole, 72);
  const y0 = groundAt(cx, cz);
  const H = Math.max(17, Math.min(24, m.height + 6)); // 外壁の高さ（IGN の高さは屋根の縁より低め）
  const ySeat = y0 + H - 4, yRoofO = y0 + H + 0.4, yRoofI = y0 + H + 2.6;
  const n = rays.length;
  const P = (i, f, y) => {
    const r = rays[i % n];
    const d = r.rin + (r.rout - r.rin) * f;
    return [cx + r.dx * d, y, cz + r.dz * d];
  };
  const PO = (i, extra, y) => {
    const r = rays[i % n];
    return [cx + r.dx * (r.rout + extra), y, cz + r.dz * (r.rout + extra)];
  };
  const w = W.main, mt = W.metal;
  const GREY = col('#b9b6af'), WALLIN = col('#8f8c86'), ROOFTOP = col('#d7d8d6'), ROOFBOT = col('#6d6f73'), FASCIA = col('#f1f1ee');
  const FSEAT = 0.84; // 観客席の上端（内側から外壁までの割合）
  for (let i = 0; i < n; i++) {
    const r0 = rays[i], r1 = rays[(i + 1) % n];
    const am = Math.atan2(r0.dz + r1.dz, r0.dx + r1.dx);
    const out = [Math.cos(am), 0, Math.sin(am)], inn = [-out[0], 0, -out[2]];
    // 外壁（白いパネル）
    wall(w, [PO(i, 0, 0)[0], PO(i, 0, 0)[2]], [PO(i + 1, 0, 0)[0], PO(i + 1, 0, 0)[2]], y0 - 0.3, yRoofO, out, CELL.cladding, 8, yRoofO - y0 + 0.3);
    // ピッチ側の低い壁
    const a = P(i, 0, 0), b = P(i + 1, 0, 0);
    w.quad([a[0], y0, a[2]], [b[0], y0, b[2]], [b[0], y0 + 1.2, b[2]], [a[0], y0 + 1.2, a[2]], inn, PLAIN_UV, PLAIN_UV, PLAIN_UV, PLAIN_UV, GREY);
    // すり鉢の観客席（区画 1 枚 ≒ 5 m）
    const slope = Math.hypot((r0.rout - r0.rin) * FSEAT, ySeat - y0);
    const ns = Math.max(1, Math.round(slope / 5));
    const segL = Math.hypot(P(i + 1, FSEAT, 0)[0] - P(i, FSEAT, 0)[0], P(i + 1, FSEAT, 0)[2] - P(i, FSEAT, 0)[2]);
    const nu = Math.max(1, Math.round(segL / 5));
    const rise = (ySeat - y0 - 1.2) / Math.max(1, (r0.rout - r0.rin) * FSEAT);
    const sn = [inn[0] * rise, 1, inn[2] * rise], sl = Math.hypot(...sn);
    for (let j = 0; j < ns; j++) {
      const f0 = (FSEAT * j) / ns, f1 = (FSEAT * (j + 1)) / ns;
      const ya = y0 + 1.2 + ((ySeat - y0 - 1.2) * j) / ns, yb = y0 + 1.2 + ((ySeat - y0 - 1.2) * (j + 1)) / ns;
      for (let k = 0; k < nu; k++) {
        const lerp = (p, q, t) => [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t, p[2] + (q[2] - p[2]) * t];
        const A = lerp(P(i, f0, ya), P(i + 1, f0, ya), k / nu), B = lerp(P(i, f0, ya), P(i + 1, f0, ya), (k + 1) / nu);
        const C = lerp(P(i, f1, yb), P(i + 1, f1, yb), (k + 1) / nu), D = lerp(P(i, f1, yb), P(i + 1, f1, yb), k / nu);
        w.quad(A, B, C, D, [sn[0] / sl, sn[1] / sl, sn[2] / sl], [cu(CELL.seats, 0), 0], [cu(CELL.seats, 1), 0], [cu(CELL.seats, 1), 1], [cu(CELL.seats, 0), 1]);
      }
    }
    // 観客席の上の奥の壁（屋根の下）
    const c0 = P(i, FSEAT, 0), c1 = P(i + 1, FSEAT, 0);
    w.quad([c0[0], ySeat, c0[2]], [c1[0], ySeat, c1[2]], [c1[0], yRoofO - 0.2, c1[2]], [c0[0], yRoofO - 0.2, c0[2]], inn, PLAIN_UV, PLAIN_UV, PLAIN_UV, PLAIN_UV, WALLIN);
    // 屋根（外壁から内側へ少し上がる）。上面と下面、内側の縁の白い鉄骨の帯
    const o0 = PO(i, 0.8, yRoofO), o1 = PO(i + 1, 0.8, yRoofO), i0 = P(i, 0.1, yRoofI), i1 = P(i + 1, 0.1, yRoofI);
    const rl = Math.hypot(r0.rout + 0.8 - (r0.rin + (r0.rout - r0.rin) * 0.1), yRoofI - yRoofO);
    const up = [(out[0] * (yRoofI - yRoofO)) / rl, (r0.rout - r0.rin) / rl, (out[2] * (yRoofI - yRoofO)) / rl];
    mt.quad(o0, o1, i1, i0, up, PLAIN_UV, PLAIN_UV, PLAIN_UV, PLAIN_UV, ROOFTOP);
    mt.quad(o0, o1, i1, i0, [-up[0], -up[1], -up[2]], PLAIN_UV, PLAIN_UV, PLAIN_UV, PLAIN_UV, ROOFBOT);
    mt.quad([i0[0], yRoofI - 1.4, i0[2]], [i1[0], yRoofI - 1.4, i1[2]], i1, i0, inn, PLAIN_UV, PLAIN_UV, PLAIN_UV, PLAIN_UV, FASCIA);
    mt.quad([o0[0], yRoofO - 0.5, o0[2]], [o1[0], yRoofO - 0.5, o1[2]], o1, o0, out, PLAIN_UV, PLAIN_UV, PLAIN_UV, PLAIN_UV, FASCIA);
  }
  // 外壁に食い込んだ角の塔: 同じ白い外壁のパネルで、外壁より少し高く
  for (const ring of m.annex || []) {
    const yt = yRoofO + 1.2;
    const ccw = signedArea(ring) > 0;
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i], b = ring[(i + 1) % ring.length];
      const L2 = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (L2 < 0.05) continue;
      let nx = (b[1] - a[1]) / L2, nz = -(b[0] - a[0]) / L2;
      if (!ccw) [nx, nz] = [-nx, -nz];
      const [p, q] = ccw ? [a, b] : [b, a];
      wall(w, p, q, y0 - 0.3, yt, [nx, 0, nz], CELL.cladding, 8, yt - y0 + 0.3);
    }
    const { points, indices } = triangulate(ring, []);
    for (let i = 0; i < indices.length; i += 3) {
      const [a, b, c] = [points[indices[i]], points[indices[i + 1]], points[indices[i + 2]]];
      w.tri([a[0], yt, a[1]], [b[0], yt, b[1]], [c[0], yt, c[1]], [0, 1, 0], PLAIN_UV, PLAIN_UV, PLAIN_UV, ROOFTOP);
    }
  }
  // ピッチ（縞の芝と白線）と、まわりの芝
  const ring = rays.map((r) => [cx + r.dx * r.rin, cz + r.dz * r.rin]);
  const { points, indices } = triangulate(ring, []);
  const APRON = col('#5f8a48');
  for (let i = 0; i < indices.length; i += 3) {
    const [a, b, c] = [points[indices[i]], points[indices[i + 1]], points[indices[i + 2]]];
    w.tri([a[0], y0 + 0.06, a[1]], [b[0], y0 + 0.06, b[1]], [c[0], y0 + 0.06, c[1]], [0, 1, 0], PLAIN_UV, PLAIN_UV, PLAIN_UV, APRON);
  }
  const box2 = orientedBox(m.outer);
  const e1 = box2.e1, e2 = box2.e2;
  let hx = Infinity, hz = Infinity;
  for (const r of rays) {
    const p1 = Math.abs(r.dx * e1[0] + r.dz * e1[1]), p2 = Math.abs(r.dx * e2[0] + r.dz * e2[1]);
    if (p1 > 0.7) hx = Math.min(hx, r.rin * p1);
    if (p2 > 0.7) hz = Math.min(hz, r.rin * p2);
  }
  const L = Math.min(52.5, hx - 4), Wd = Math.min(34, hz - 3);
  if (L > 20 && Wd > 15) {
    const Q = (s, t) => [cx + e1[0] * s + e2[0] * t, y0 + 0.12, cz + e1[1] * s + e2[1] * t];
    w.quad(Q(-L, -Wd), Q(L, -Wd), Q(L, Wd), Q(-L, Wd), [0, 1, 0], [cu(CELL.pitch, 0), 0], [cu(CELL.pitch, 1), 0], [cu(CELL.pitch, 1), 1], [cu(CELL.pitch, 0), 1]);
  }
  // 照明塔（4 隅、屋根の上に高く。鉄骨の柱と、ピッチを向いた灯具）
  const STEEL = col('#9da3a8'), LAMP = col('#fbf7e4'), FRAME = col('#4a4e52');
  for (const [s1, s2] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
    let dx = e1[0] * s1 * box2.a + e2[0] * s2 * box2.b, dz = e1[1] * s1 * box2.a + e2[1] * s2 * box2.b;
    const dl = Math.hypot(dx, dz);
    dx /= dl;
    dz /= dl;
    const rout = rayRing(cx, cz, dx, dz, m.outer);
    let rin = m.hole && m.hole.length >= 3 ? rayRing(cx, cz, dx, dz, m.hole) : rout * 0.62;
    if (!(rin > 0) || rin > rout - 6) rin = rout * 0.62;
    const rr = rout - 5;
    const px = cx + dx * rr, pz = cz + dz * rr;
    // 柱の根元は屋根の上面（屋根は外壁の縁 yRoofO から内側の縁 yRoofI へ上がる）。屋根を突き抜けて観客席の上に浮かないように
    const ri = rin + (rout - rin) * 0.1;
    const yBase = yRoofO + ((yRoofI - yRoofO) * (rout + 0.8 - rr)) / Math.max(1, rout + 0.8 - ri) - 0.05;
    const top = y0 + H + 22;
    // 先細りの四角い柱
    for (let k = 0; k < 4; k++) {
      const a0 = (k / 4) * Math.PI * 2 + Math.PI / 4, a1 = ((k + 1) / 4) * Math.PI * 2 + Math.PI / 4;
      const am = (a0 + a1) / 2;
      const Pp = (a, r, y) => [px + Math.cos(a) * r, y, pz + Math.sin(a) * r];
      mt.quad(Pp(a0, 1.1, yBase), Pp(a1, 1.1, yBase), Pp(a1, 0.5, top), Pp(a0, 0.5, top), [Math.cos(am), 0.02, Math.sin(am)], PLAIN_UV, PLAIN_UV, PLAIN_UV, PLAIN_UV, STEEL);
    }
    // 灯具: ピッチの中心を向き、少し下に傾けた板
    const fx = -dx, fz = -dz;
    const sx = -fz, sz = fx;
    const tilt = 0.45;
    const o = [px + fx * 0.6, top + 1.6, pz + fz * 0.6];
    const ex = [sx * 4, 0, sz * 4], ey = [-fx * Math.sin(tilt) * 2.2, Math.cos(tilt) * 2.2, -fz * Math.sin(tilt) * 2.2], ez = [fx * Math.cos(tilt) * 0.35, Math.sin(tilt) * 0.35, fz * Math.cos(tilt) * 0.35];
    box(mt, o, ex, ey, ez, FRAME);
    const f = [o[0] + ez[0] * 1.05, o[1] + ez[1] * 1.05, o[2] + ez[2] * 1.05];
    const V = (a, b) => [f[0] + ex[0] * a + ey[0] * b, f[1] + ex[1] * a + ey[1] * b, f[2] + ex[2] * a + ey[2] * b];
    const nl = Math.hypot(...ez);
    mt.quad(V(-0.92, -0.85), V(0.92, -0.85), V(0.92, 0.85), V(-0.92, 0.85), [ez[0] / nl, ez[1] / nl, ez[2] / nl], PLAIN_UV, PLAIN_UV, PLAIN_UV, PLAIN_UV, LAMP);
  }
}

// ---- メディアテーク・ジョゼ・カバニス
function writeCabanis(m, W, groundAt) {
  const L = m.layout;
  const { e1, e2, a: A, b: B, m0, m1, front } = L;
  const y0 = groundAt(L.cx, L.cz);
  const H = m.height, FL = H / Math.max(1, Math.round(H / 4.2)); // 階の高さ（ルーバーの区画 1 枚）
  const Ho = y0 + Math.min(H - 2 * FL, Math.max(12, Math.ceil((m1 - m0) / FL - 0.15) * FL)); // 開口の上端: 幅とほぼ同じ高さの四角い開口（階の帯にそろえる）
  const Y = y0 + H;
  const at = (u, v) => [L.cx + e1[0] * u + e2[0] * v, L.cz + e1[1] * u + e2[1] * v];
  const n3 = (v2, s = 1) => [v2[0] * s, 0, v2[1] * s];
  const w = W.main, mt = W.metal;
  const GLASS = col('#c9c3bb'), SOFFIT = col('#d6d1c8'), ROOF = col('#9b9a96');
  // 正面と裏（開口の部分は上の梁だけ）
  for (const sv of [1, -1]) {
    const v = sv * B, n = n3(e2, sv);
    const seg = (u0, u1, ya, yb) => {
      const p = sv > 0 ? [at(u1, v), at(u0, v)] : [at(u0, v), at(u1, v)];
      wall(w, p[0], p[1], ya, yb, n, CELL.louvre, FL, FL);
    };
    seg(-A, m0, y0, Y);
    seg(m1, A, y0, Y);
    seg(m0, m1, Ho, Y);
  }
  // 両脇
  for (const su of [1, -1]) {
    const u = su * A;
    wall(w, at(u, su > 0 ? -B : B), at(u, su > 0 ? B : -B), y0, Y, n3(e1, su), CELL.louvre, FL, FL);
  }
  // 開口の内側の壁（ガラスとルーバー）と天井
  wall(w, at(m0, -B), at(m0, B), y0, Ho, n3(e1, 1), CELL.louvre, FL, FL, GLASS);
  wall(w, at(m1, B), at(m1, -B), y0, Ho, n3(e1, -1), CELL.louvre, FL, FL, GLASS);
  const S = (u, v, y) => {
    const p = at(u, v);
    return [p[0], y, p[1]];
  };
  w.quad(S(m0, -B, Ho), S(m1, -B, Ho), S(m1, B, Ho), S(m0, B, Ho), [0, -1, 0], PLAIN_UV, PLAIN_UV, PLAIN_UV, PLAIN_UV, SOFFIT);
  // 屋上
  w.quad(S(-A, -B, Y), S(A, -B, Y), S(A, B, Y), S(-A, B, Y), [0, 1, 0], PLAIN_UV, PLAIN_UV, PLAIN_UV, PLAIN_UV, ROOF);
  // 屋上の大きく張り出したガラスと鉄骨の庇（正面の側）。ガラスの板ごとに少し色を変える
  const vb = front * (B - 7), vf = front * (B + 11), ya = Y + 0.8, yb = Y + 1.5;
  // 下から見上げるとガラス越しの空で明るい（暗い板に見えないように明るめの灰色）
  const GL = [col('#b4cbd5'), col('#bdd2db'), col('#a9c2cd')], STEEL = col('#c9ccd0'), UNDER = col('#c4cacf');
  const nu = Math.max(4, Math.round((2 * A + 2) / 3.2)), nv = 6;
  for (let i = 0; i < nu; i++) {
    for (let j = 0; j < nv; j++) {
      const u0 = -A - 1 + ((2 * A + 2) * i) / nu, u1 = -A - 1 + ((2 * A + 2) * (i + 1)) / nu;
      const v0 = vb + ((vf - vb) * j) / nv, v1 = vb + ((vf - vb) * (j + 1)) / nv;
      const g = GL[Math.floor(hash01(i * 31 + j, 7) * GL.length)];
      w.quad(S(u0 + 0.08, v0 + 0.08, yb), S(u1 - 0.08, v0 + 0.08, yb), S(u1 - 0.08, v1 - 0.08, yb), S(u0 + 0.08, v1 - 0.08, yb), [0, 1, 0], PLAIN_UV, PLAIN_UV, PLAIN_UV, PLAIN_UV, g); // ガラスは金属にしない（上から暗い板に見えないように）
    }
  }
  // 鉄骨の枠（上面の格子は板のすき間から下の面が見える）、下面、縁
  mt.quad(S(-A - 1, vb, yb - 0.04), S(A + 1, vb, yb - 0.04), S(A + 1, vf, yb - 0.04), S(-A - 1, vf, yb - 0.04), [0, 1, 0], PLAIN_UV, PLAIN_UV, PLAIN_UV, PLAIN_UV, STEEL);
  mt.quad(S(-A - 1, vb, ya), S(A + 1, vb, ya), S(A + 1, vf, ya), S(-A - 1, vf, ya), [0, -1, 0], PLAIN_UV, PLAIN_UV, PLAIN_UV, PLAIN_UV, UNDER);
  const edge = (p, q, n) => mt.quad([p[0], ya, p[1]], [q[0], ya, q[1]], [q[0], yb, q[1]], [p[0], yb, p[1]], n, PLAIN_UV, PLAIN_UV, PLAIN_UV, PLAIN_UV, STEEL);
  edge(at(-A - 1, vf), at(A + 1, vf), n3(e2, front));
  edge(at(-A - 1, vb), at(A + 1, vb), n3(e2, -front));
  edge(at(-A - 1, vb), at(-A - 1, vf), n3(e1, -1));
  edge(at(A + 1, vb), at(A + 1, vf), n3(e1, 1));
  // 庇を支える細い柱（屋上から）
  for (const u of [-A + 2, (m0 + m1) / 2, A - 2]) {
    const p = at(u, front * (B - 1));
    box(mt, [p[0], (Y + ya) / 2, p[1]], [0.18, 0, 0], [0, (ya - Y) / 2 + 0.02, 0], [0, 0, 0.18], STEEL);
  }
}

// ---- 雄鶏の像（ローカル座標: x が前、y が上。angle の向きに回して置く）
function writeCoq(m, W, groundAt, colliders) {
  const y0 = groundAt(m.x, m.z);
  const c = Math.cos(m.angle), s = Math.sin(m.angle);
  // 台の上（y = 0.55）から上の像は K 倍（写真: 台の上で約 3 m）
  const K = 1.1, YB = 0.55;
  const T = (lx, ly, lz) => {
    const k = ly > YB ? K : 1;
    const X = lx * k, Z = lz * k, Yy = ly > YB ? YB + (ly - YB) * K : ly;
    return [m.x + X * c - Z * s, y0 + Yy, m.z + X * s + Z * c];
  };
  const V = (lx, ly, lz) => [lx * c - lz * s, ly, lx * s + lz * c];
  const VK = (lx, ly, lz) => V(lx * K, ly * K, lz * K);
  const w = W.main;
  // 赤い木の台（上面は黒い板）
  const RED = col('#a5332b'), BLACK = col('#1b1918');
  box(w, [m.x, y0 + 0.25, m.z], V(1.25, 0, 0), [0, 0.25, 0], V(0, 0, 1.25), RED, { top: BLACK });
  box(w, [m.x, y0 + 0.52, m.z], V(1.28, 0, 0), [0, 0.025, 0], V(0, 0, 1.28), BLACK);
  // 錆びた鉄（蹄鉄のつぎはぎ）: 面ごとに色を少し変える
  const IRON = [col('#2f2723'), col('#4a372b'), col('#64412b'), col('#7a4e30'), col('#3a2f2a'), col('#563826')];
  let seed = 0;
  const rust = (salt) => (f) => IRON[Math.floor(hash01(f + salt * 997, 13) * IRON.length)];
  const B = (lx, ly, lz, r, salt, seg = 10, rings = 7) => blob(w, T(lx, ly, lz), r.map((v) => v * K), -m.angle, seg, rings, rust(salt));
  B(-0.08, 1.72, 0, [0.82, 0.52, 0.42], seed++); // 胴
  B(0.42, 1.88, 0, [0.4, 0.5, 0.36], seed++); // 胸
  B(0.62, 2.38, 0, [0.21, 0.42, 0.2], seed++, 8, 6); // 首
  B(0.74, 2.82, 0, [0.21, 0.18, 0.15], seed++, 8, 5); // 頭
  // 翼（胴の両脇の平たい塊）
  for (const sz of [1, -1]) blob(w, T(-0.15, 1.78, sz * 0.36), [0.62 * K, 0.32 * K, 0.1 * K], -m.angle - sz * 0.08, 8, 5, rust(seed++));
  // くちばし
  const beak = [T(0.92, 2.86, 0), T(0.92, 2.74, 0.06), T(0.92, 2.74, -0.06), T(1.16, 2.76, 0)];
  const nb = V(1, 0, 0);
  w.tri(beak[0], beak[1], beak[3], [nb[0], 0.3, nb[2]], PLAIN_UV, PLAIN_UV, PLAIN_UV, IRON[0]);
  w.tri(beak[0], beak[2], beak[3], [nb[0], 0.3, nb[2]], PLAIN_UV, PLAIN_UV, PLAIN_UV, IRON[0]);
  w.tri(beak[1], beak[2], beak[3], [nb[0], -0.5, nb[2]], PLAIN_UV, PLAIN_UV, PLAIN_UV, IRON[1]);
  // 平たい板（ローカルの x-y 面、厚み 2·th）: とさか・肉垂れ・尾羽
  const plate = (pts, th, color) => {
    for (const sz of [1, -1]) {
      const n = V(0, 0, sz);
      for (let i = 1; i + 1 < pts.length; i++) {
        const [p, q, r] = [pts[0], pts[i], pts[i + 1]];
        w.tri(T(p[0], p[1], p[2] + sz * th), T(q[0], q[1], q[2] + sz * th), T(r[0], r[1], r[2] + sz * th), n, PLAIN_UV, PLAIN_UV, PLAIN_UV, color);
      }
    }
  };
  plate([[0.74, 2.94, 0], [0.56, 2.98, 0], [0.6, 3.16, 0], [0.67, 3.03, 0], [0.73, 3.24, 0], [0.8, 3.05, 0], [0.88, 3.17, 0], [0.9, 2.95, 0]], 0.035, IRON[2]);
  plate([[0.86, 2.7, 0], [0.84, 2.5, 0], [0.92, 2.56, 0], [0.94, 2.7, 0]], 0.03, IRON[3]);
  // 尾羽: 胴の後ろから弧を描いて立ち上がり、後ろへ垂れる鎌形の羽 7 枚
  for (let k = 0; k < 7; k++) {
    const h = 0.55 + 0.11 * k, len = 0.75 + 0.07 * k, wd = 0.13 + 0.01 * k, lz = (k % 2 ? 1 : -1) * 0.05 * ((k + 1) >> 1);
    const pts = [];
    for (let i = 0; i <= 8; i++) {
      const t = i / 8;
      pts.push([-0.72 - len * t, 1.95 + h * 1.25 * Math.sin(t * Math.PI * 0.78), lz]);
    }
    for (let i = 0; i < 8; i++) {
      const p = pts[i], q = pts[i + 1];
      const dx = q[0] - p[0], dy = q[1] - p[1], dl = Math.hypot(dx, dy);
      const ox = (-dy / dl) * wd * (1 - (i / 8) * 0.6), oy = (dx / dl) * wd * (1 - (i / 8) * 0.6);
      const ox2 = (-dy / dl) * wd * (1 - ((i + 1) / 8) * 0.6), oy2 = (dx / dl) * wd * (1 - ((i + 1) / 8) * 0.6);
      plate([[p[0] - ox / 2, p[1] - oy / 2, lz], [q[0] - ox2 / 2, q[1] - oy2 / 2, lz], [q[0] + ox2 / 2, q[1] + oy2 / 2, lz], [p[0] + ox / 2, p[1] + oy / 2, lz]], 0.02, IRON[(k + i) % IRON.length]);
    }
  }
  // 脚と指
  for (const sz of [1, -1]) {
    const top = T(0.02, 1.3, sz * 0.16), bot = T(0.08, 0.56, sz * 0.18);
    const mid = [(top[0] + bot[0]) / 2, (top[1] + bot[1]) / 2, (top[2] + bot[2]) / 2];
    const half = [(top[0] - bot[0]) / 2, (top[1] - bot[1]) / 2, (top[2] - bot[2]) / 2];
    box(w, mid, VK(0.05, 0, 0), half, VK(0, 0, 0.05), IRON[1]);
    for (const a of [-0.5, 0, 0.5, Math.PI]) {
      const d = VK(Math.cos(a) * 0.14, 0, Math.sin(a) * 0.14);
      box(w, [bot[0] + d[0], y0 + 0.57, bot[2] + d[2]], d, [0, 0.025, 0], VK(-Math.sin(a) * 0.03, 0, Math.cos(a) * 0.03), IRON[0]);
    }
  }
  // 足元のラグビーボール
  blob(w, T(0.72, 0.76, 0.34), [0.3 * K, 0.19 * K, 0.19 * K], -m.angle + 0.5, 10, 6, () => col('#5b3b28'));
  colliders.push([m.x, m.z, 1.8]);
}

// ---- オクシタン十字と星座のメダル（ブロンズの象嵌）
// 12 の星座の記号（-1〜1 の折れ線）。牡羊座から順に
const circ = (x, y, r, a0 = 0, a1 = Math.PI * 2, n = 12) => Array.from({ length: n + 1 }, (_, i) => [x + Math.cos(a0 + ((a1 - a0) * i) / n) * r, y + Math.sin(a0 + ((a1 - a0) * i) / n) * r]);
export const ZODIAC = [
  [[[-0.7, 0.2], [-0.7, 0.55], [-0.4, 0.7], [-0.12, 0.45], [0, -0.75]], [[0.7, 0.2], [0.7, 0.55], [0.4, 0.7], [0.12, 0.45], [0, -0.75]]],
  [circ(0, -0.3, 0.38), circ(0, 0.5, 0.62, Math.PI * 1.1, Math.PI * 1.9, 8)],
  [[[-0.6, 0.7], [0.6, 0.7]], [[-0.6, -0.7], [0.6, -0.7]], [[-0.3, 0.7], [-0.3, -0.7]], [[0.3, 0.7], [0.3, -0.7]]],
  [circ(-0.35, 0.22, 0.2), [[-0.35, 0.42], [0.2, 0.5], [0.6, 0.25]], circ(0.35, -0.22, 0.2), [[0.35, -0.42], [-0.2, -0.5], [-0.6, -0.25]]],
  [circ(-0.4, -0.3, 0.22), [[-0.2, -0.25], [-0.25, 0.3], [0.05, 0.65], [0.4, 0.4], [0.3, -0.3], [0.55, -0.6], [0.75, -0.45]]],
  [[[-0.7, 0.5], [-0.7, -0.6]], [[-0.7, 0.4], [-0.45, 0.6], [-0.25, 0.4], [-0.25, -0.6]], [[-0.25, 0.4], [0, 0.6], [0.2, 0.4], [0.2, -0.4], [0.5, -0.7]], [[0.2, -0.1], [0.6, 0.1], [0.55, -0.3], [0.2, -0.4]]],
  [[[-0.75, -0.55], [0.75, -0.55]], [[-0.75, -0.15], [-0.3, -0.15], ...circ(0, 0.1, 0.3, Math.PI * 1.15, -Math.PI * 0.15, 8).slice(1, -1), [0.3, -0.15], [0.75, -0.15]]],
  [[[-0.75, 0.5], [-0.75, -0.6]], [[-0.75, 0.4], [-0.5, 0.6], [-0.3, 0.4], [-0.3, -0.6]], [[-0.3, 0.4], [-0.05, 0.6], [0.15, 0.4], [0.15, -0.55], [0.45, -0.6], [0.7, -0.3]], [[0.5, -0.15], [0.7, -0.3], [0.55, -0.5]]],
  [[[-0.65, -0.65], [0.65, 0.65]], [[0.15, 0.65], [0.65, 0.65], [0.65, 0.15]], [[-0.45, 0.05], [0.05, -0.45]]],
  [[[-0.7, 0.6], [-0.4, -0.3], [-0.15, 0.55], [0.15, -0.55], [0.35, -0.75]], circ(0.4, -0.35, 0.25, Math.PI * 0.9, Math.PI * 2.9, 10)],
  [[[-0.75, 0.15], [-0.45, 0.4], [-0.15, 0.15], [0.15, 0.4], [0.45, 0.15], [0.75, 0.4]], [[-0.75, -0.35], [-0.45, -0.1], [-0.15, -0.35], [0.15, -0.1], [0.45, -0.35], [0.75, -0.1]]],
  [circ(-0.95, 0, 0.7, -Math.PI * 0.35, Math.PI * 0.35, 8), circ(0.95, 0, 0.7, Math.PI * 0.65, Math.PI * 1.35, 8), [[-0.4, 0], [0.4, 0]]],
];
function writeCross(m, W, groundAt) {
  const R = m.radius;
  const { ring, pommels } = occitanCross(R);
  const ax = m.ax, az = [-ax[1], ax[0]];
  const toW = ([u, v]) => [m.x + ax[0] * u + az[0] * v, m.z + ax[1] * u + az[1] * v];
  const w = W.inlay;
  const LINE = col('#b39368'), MEDAL = col('#8c8070'), RIM = col('#a8875a'); // 写真: 日なたの線 #b1987f、メダル #8a7e6f
  const flat = (q, lift, color) => {
    const P = q.map((p) => {
      const [x, z] = toW(p);
      return [x, groundAt(x, z) + lift, z];
    });
    w.quad(P[0], P[1], P[2], P[3], [0, 1, 0], PLAIN_UV, PLAIN_UV, PLAIN_UV, PLAIN_UV, color);
  };
  const MR = 1.3; // メダルの半径
  const inMedal = (p) => pommels.some((q) => Math.hypot(p[0] - q[0], p[1] - q[1]) < MR + 0.05);
  // 二重のブロンズの線（メダルの上は描かない）
  for (const off of [-0.2, 0.2]) {
    for (const q of strokeQuads(ring, true, off, 0.11)) {
      const mid = [(q[0][0] + q[2][0]) / 2, (q[0][1] + q[2][1]) / 2];
      if (!inMedal(mid)) flat(q, 0.035, LINE);
    }
  }
  // メダル（暗いブロンズの円盤、明るい縁、星座の記号。記号は十字の外を向いて読める向き）
  pommels.forEach((p, k) => {
    const n = 24;
    const disc = [];
    for (let i = 0; i < n; i++) {
      const a0 = (i / n) * Math.PI * 2, a1 = ((i + 1) / n) * Math.PI * 2;
      disc.push([p, [p[0] + Math.cos(a0) * MR, p[1] + Math.sin(a0) * MR], [p[0] + Math.cos(a1) * MR, p[1] + Math.sin(a1) * MR], p]);
    }
    for (const q of disc) flat(q, 0.025, MEDAL);
    const rimPts = circ(p[0], p[1], MR - 0.08, 0, Math.PI * 2, n).slice(0, -1);
    for (const q of strokeQuads(rimPts, true, 0, 0.12)) flat(q, 0.035, RIM);
    const out = Math.hypot(p[0], p[1]) || 1;
    const up = [p[0] / out, p[1] / out], right = [up[1], -up[0]];
    const g = 0.72;
    for (const line of ZODIAC[k % 12]) {
      const pts = line.map(([gx, gy]) => [p[0] + (right[0] * gx + up[0] * gy) * g, p[1] + (right[1] * gx + up[1] * gy) * g]);
      for (const q of strokeQuads(pts, false, 0, 0.09)) flat(q, 0.04, RIM);
    }
  });
}

const WRITERS = { chateau: writeChateau, stadium: writeStadium, cabanis: writeCabanis, coq: writeCoq, cross: writeCross };

// 名所のモデルを作る。colliders: 足す当たり判定の円 [x, z, r] か線分 [ax, az, bx, bz]
export function buildMonuments(list, materials, { groundAt = () => 0, onRoad = () => false } = {}) {
  const group = new THREE.Group();
  group.name = 'monuments';
  const W = { main: new MeshWriter(), metal: new MeshWriter(), inlay: new MeshWriter() };
  const colliders = [];
  for (const m of list) WRITERS[m.kind](m, W, groundAt, colliders, onRoad);
  const mats = { main: materials.monument, metal: materials.monumentMetal, inlay: materials.monumentInlay };
  for (const key of ['main', 'metal', 'inlay']) {
    if (W[key].empty || !mats[key]) continue;
    const mesh = new THREE.Mesh(W[key].toGeometry(), mats[key]);
    mesh.name = `monument-${key}`;
    mesh.matrixAutoUpdate = false;
    if (key === 'inlay') {
      // 広場の石畳（地面の覆い・広場）より後に描き、polygonOffset で手前に出す
      mesh.renderOrder = ORDER.marking + 0.6;
      mesh.receiveShadow = true;
    } else {
      mesh.castShadow = true;
      mesh.receiveShadow = true;
    }
    group.add(mesh);
  }
  return { group, colliders };
}

// ---- テクスチャ（6 区画: レンガ・ルーバー・観客席・ピッチ・外壁のパネル・無地）
export function makeMonumentTexture() {
  const S = 256;
  const c = document.createElement('canvas');
  c.width = S * NCELL;
  c.height = S;
  const ctx = c.getContext('2d');
  const rnd = mulberry32(2207);
  // レンガ（1 区画 = 1.5 m 四方、段の高さ 5.5 cm）
  {
    const x0 = CELL.brick * S;
    ctx.fillStyle = '#d6b39c';
    ctx.fillRect(x0, 0, S, S);
    const BR = ['#c47658', '#bb6c50', '#cd8263', '#b5664c', '#c97b5c', '#b97a62'];
    const rowH = S / 27, bw = (0.42 / 1.5) * S;
    for (let r = 0; r < 27; r++) {
      const y = r * rowH;
      for (let x = -(r % 2) * (bw / 2); x < S; x += bw) {
        ctx.fillStyle = BR[Math.floor(rnd() * BR.length)];
        ctx.fillRect(x0 + Math.max(0, x) + 1, y + 1, Math.min(bw - 2, S - Math.max(0, x) - 1), rowH - 2);
      }
    }
  }
  // ルーバー（1 区画 = 1 階 ≒ 4.2 m 四方）: 暗いガラスの前にテラコッタ色の水平のルーバー、下に白い階の帯
  {
    const x0 = CELL.louvre * S;
    const g = ctx.createLinearGradient(0, 0, 0, S);
    g.addColorStop(0, '#4b5a66');
    g.addColorStop(1, '#2f3a44');
    ctx.fillStyle = g;
    ctx.fillRect(x0, 0, S, S);
    ctx.fillStyle = 'rgba(255,255,255,0.08)';
    for (let x = 0; x < S; x += 64) ctx.fillRect(x0 + x, 0, 3, S);
    // 羽根は幅広く明るいテラコッタ（すき間のガラスは細く）、上の縁に光、下に影の線
    for (let y = 6; y < S - 30; y += 11) {
      ctx.fillStyle = rnd() < 0.5 ? '#c0704a' : '#c97b52';
      ctx.fillRect(x0, y, S, 8);
      ctx.fillStyle = 'rgba(255,225,190,0.35)';
      ctx.fillRect(x0, y, S, 1);
      ctx.fillStyle = 'rgba(40,20,10,0.45)';
      ctx.fillRect(x0, y + 7, S, 2);
    }
    ctx.fillStyle = '#efece6';
    ctx.fillRect(x0, S - 28, S, 28);
    ctx.fillStyle = 'rgba(0,0,0,0.18)';
    ctx.fillRect(x0, S - 28, S, 2);
  }
  // 観客席（1 区画 = 5 m 四方、6 段）: 紫の座席と灰色の段
  {
    const x0 = CELL.seats * S;
    ctx.fillStyle = '#9a9890';
    ctx.fillRect(x0, 0, S, S);
    const rowH = S / 6;
    for (let r = 0; r < 6; r++) {
      const y = r * rowH;
      for (let x = 0; x < S; x += 25.6) {
        ctx.fillStyle = rnd() < 0.06 ? '#d8d6d0' : rnd() < 0.5 ? '#5a2b74' : '#663383';
        ctx.fillRect(x0 + x + 2, y + 6, 21, rowH * 0.55);
      }
      ctx.fillStyle = 'rgba(0,0,0,0.25)';
      ctx.fillRect(x0, y + rowH - 3, S, 3);
    }
  }
  // ピッチ（区画全体 = 105 × 68 m）: 縞の芝と白線
  {
    const x0 = CELL.pitch * S;
    for (let i = 0; i < 14; i++) {
      ctx.fillStyle = i % 2 ? '#4e8a3a' : '#5a9844';
      ctx.fillRect(x0 + (i * S) / 14, 0, S / 14 + 1, S);
    }
    const kx = S / 105, ky = S / 68;
    ctx.strokeStyle = 'rgba(245,245,240,0.9)';
    ctx.lineWidth = 2;
    const rect = (x, y, w, h) => ctx.strokeRect(x0 + x * kx, y * ky, w * kx, h * ky);
    rect(1, 1, 103, 66);
    ctx.beginPath();
    ctx.moveTo(x0 + S / 2, ky);
    ctx.lineTo(x0 + S / 2, S - ky);
    ctx.stroke();
    ctx.beginPath();
    ctx.ellipse(x0 + S / 2, S / 2, 9.15 * kx, 9.15 * ky, 0, 0, Math.PI * 2);
    ctx.stroke();
    rect(1, 34 - 20.15, 16.5, 40.3);
    rect(104 - 16.5, 34 - 20.15, 16.5, 40.3);
    rect(1, 34 - 9.16, 5.5, 18.32);
    rect(104 - 5.5, 34 - 9.16, 5.5, 18.32);
  }
  // スタジアムの外壁（1 区画 = 幅 8 m × 壁の高さ）: 白いパネル、上に暗いすき間の帯、下に入口の暗い帯
  {
    const x0 = CELL.cladding * S;
    ctx.fillStyle = '#eeede8';
    ctx.fillRect(x0, 0, S, S);
    ctx.fillStyle = 'rgba(0,0,0,0.12)';
    for (let x = 0; x < S; x += 64) ctx.fillRect(x0 + x, 0, 2, S);
    for (let y = 40; y < S; y += 48) ctx.fillRect(x0, y, S, 2);
    ctx.fillStyle = '#3b3f45';
    ctx.fillRect(x0, 10, S, 18);
    ctx.fillStyle = '#4a4e54';
    ctx.fillRect(x0 + 40, S - 44, 70, 44);
    ctx.fillStyle = '#c9c7c0';
    ctx.fillRect(x0, S - 6, S, 6);
  }
  // 無地（色は頂点の色）
  {
    const x0 = CELL.plain * S;
    ctx.fillStyle = '#f4f4f4';
    ctx.fillRect(x0, 0, S, S);
    for (let i = 0; i < 900; i++) {
      const v = 225 + Math.floor(rnd() * 30);
      ctx.fillStyle = `rgb(${v},${v},${v})`;
      ctx.fillRect(x0 + rnd() * S, rnd() * S, 2, 2);
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}
