// 街の小物（写真 street-furniture-*・residential-*、ユーザーの写真のメモ 1・2・5・7 を手本に）。タイル（一度に作る街は
// 街全体）ごとに、通りの断面（streets.js が書いた縁石の区間）・広場・駐車場から位置を決め、種類ごとに 1 つの
// InstancedMesh で描く:
// - 街灯: 旧市街の外の車道の歩道に、灰色の柱に横向きの灯具（高さ約 7 m）を約 27 m おき（広い通りは左右交互、狭い
//   通りは片側だけ）。広い大通りは高い円盤形の街灯（約 10 m）を両側に向かい合わせて。旧市街は建物の壁の街灯
//   （facades.js）のまま、広場（Capitole を除く）の縁に黒い燭台形の街灯を少し
// - 花崗岩の円柱の車止め（直径 28 cm・高さ 55 cm・頭が丸い）: 広場・中心部の広い歩道が車道に接する縁石沿いに
//   1.4 m おき（Place Olivier、Saint-Cyprien の広場）。横断歩道の所はあける
// - 路上駐車の車: 旧市街の外の住宅街・二次的な通りの、車道が広い所（自転車のために 3 m 以上あける）に縁石に沿って
//   縦列に。車道が 4〜5 m の住宅街の通りは、歩道が広ければ片側に歩道へ半分乗り上げて（少し傾けて）。交差点・
//   横断歩道・橋・トラムの近くはあける。駐車場（amenity=parking）には列に並べる
// 「旧市街」は右岸の歴史的な中心だけ（config.js の historicCoreTest）。左岸のサン・シプリアン（Place Olivier・
// Château d'eau の角）は外と同じ（ユーザーの写真のメモ 1・5・7）
// - ごみ箱（黒い輪の形）: 横断歩道の近く・広場・ときどき歩道。大きなごみ収集容器（緑・青）: 広い歩道にときどき
// 位置は道の始点からの距離（s）や広場の外周の長さで決めるので、どのタイルで作っても同じ所に同じ物が立つ。
// 小さな物なので、自転車から FURNITURE_FAR m より遠い物は描かない（インスタンスを並べ替えて近い物だけ描く）。
import * as THREE from 'three';
import { Grid, hash01, pointInPolygon, pointInRing, polylineLength } from '../geo.js';
import { MeshWriter } from './meshwriter.js';
import { CURB_W } from './streets.js';
import { CAR_ROADS } from './parse.js';

export const FURNITURE_FAR = 280; // これより遠い小物は描かない（m、自転車から）
const REFILL = 12; // 自転車がこれだけ動いたら、描く小物を選び直す（m）

const LIGHT_STEP = 27; // 横向きの灯具の街灯の間隔（片側だけの通り。左右交互の通りは片側でこの 2 倍）
const DISC_STEP = 32; // 大通りの円盤形の街灯の間隔（両側に向かい合わせ）
const BOULEVARD = new Set(['trunk', 'primary', 'secondary']);
export const CAR_L = 4.2, CAR_W = 1.8;
const CAR_PITCH = 5.6; // 縦列駐車の 1 台分の長さ（車＋前後のすき間）
const CURB_GAP = 0.15; // 縁石と駐車の車のすき間
export const BIKE_LANE = 3; // 駐車の車の横に残す車道の幅（自転車が通れるように）
const PARK_TYPES = new Set(['residential', 'unclassified', 'tertiary', 'secondary', 'road']);
const KERB_TYPES = new Set(['residential', 'unclassified', 'road']); // 歩道に半分乗り上げて止める通り
const KERB_OVER = 0.85; // 半分乗り上げた車の、縁石の車道側の縁から歩道へ出る幅
const KERB_MIN_E = 1.6; // 半分乗り上げて止める歩道の最小の幅
const BOLLARD_STEP = 1.4;
const CENTRE_R = 1500; // 広い歩道に車止めを並べる中心部（原点＝Pont Neuf からの距離）

// 車の色（写真の路上駐車: 白・銀・灰・黒・紺が大半、赤やほかの色は少し）。[sRGB, 割合]
const CAR_PALETTE = [
  ['#e6e6e3', 0.24], ['#b3b7ba', 0.16], ['#6c7074', 0.14], ['#3b3e41', 0.1], ['#151618', 0.14],
  ['#1e2a45', 0.08], ['#3d5c8a', 0.03], ['#8c1c1c', 0.05], ['#b7ab93', 0.02], ['#2e4838', 0.02], ['#5a3b2c', 0.02],
];
const BIN_COLORS = ['#2f6a3c', '#2c5a94']; // ごみ収集容器（緑・青）

// ---------------------------------------------------------------- 位置の計算（純粋な関数）
// 道の始点からの距離 [s0, s1] の中の、step おきの位置（phase だけずらす）。k: 何番目か（道全体で決まる）
export function slotsAlong(s0, s1, step, phase = 0) {
  const out = [];
  for (let k = Math.ceil((s0 - phase) / step - 1e-9); phase + k * step <= s1 + 1e-9; k++) out.push({ k, s: phase + k * step });
  return out;
}

// 縁石の区間の列 rows（s の順）の、距離 s の点（前後の断面を補間）。
// a: 縁石の車道側、c: 縁石の歩道側、n: 歩道の向き、u: 縁石に沿う向き（s の増える向き）、e: 歩道の幅
export function curbAt(rows, s) {
  let k = 0;
  while (k + 2 < rows.length && rows[k + 1].s < s) k++;
  const A = rows[k], B = rows[k + 1] || rows[k];
  const L = B.s - A.s;
  const t = L > 1e-9 ? Math.min(1, Math.max(0, (s - A.s) / L)) : 0;
  const mix = (p, q) => p + (q - p) * t;
  let ux = B.ax - A.ax, uz = B.az - A.az;
  const l = Math.hypot(ux, uz);
  if (l > 1e-9) [ux, uz] = [ux / l, uz / l];
  else [ux, uz] = [A.nz, -A.nx];
  return { s, ax: mix(A.ax, B.ax), az: mix(A.az, B.az), cx: mix(A.cx, B.cx), cz: mix(A.cz, B.cz), nx: A.nx, nz: A.nz, ux, uz, e: Math.min(A.e, B.e), facade: A.facade && B.facade };
}

// 縁石が道の進む向き（u）の右側か（右側通行: 右側の駐車の車は進む向きを向く）。x = 東・z = 南なので右は (-uz, ux)
export const rightSide = (p) => p.nx * -p.uz + p.nz * p.ux > 0;

// 通りの駐車の仕方: 'both'（両側）・'one'（片側）・'kerb'（片側に歩道へ半分乗り上げて）・null（止めない）。
// 自転車のために車道を BIKE_LANE m 以上あける。e: 歩道の幅
export function parkMode(road, e) {
  if (!PARK_TYPES.has(road.type)) return null;
  const one = CURB_GAP + CAR_W;
  if (road.width >= 2 * one + BIKE_LANE) return 'both';
  if (road.width >= one + BIKE_LANE) return 'one';
  if (KERB_TYPES.has(road.type) && e >= KERB_MIN_E && road.width - (CAR_W - KERB_OVER) >= BIKE_LANE) return 'kerb';
  return null;
}

// Y 軸まわりの回転角（模型の +x を (ux, uz) に向ける）
export const yaw = (ux, uz) => Math.atan2(-uz, ux);

// 外周 ring に沿って step m おき（phase から）の点を、内側へ inset m 入れた所。i: 何番目か（外周全体で決まる）
export function ringSamples(ring, step, inset, phase = 0) {
  const out = [];
  let acc = 0, next = phase, i = 0;
  for (let k = 0; k < ring.length; k++) {
    const a = ring[k], b = ring[(k + 1) % ring.length];
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (L < 1e-6) continue;
    const ux = (b[0] - a[0]) / L, uz = (b[1] - a[1]) / L;
    while (next <= acc + L) {
      const t = next - acc;
      const px = a[0] + ux * t, pz = a[1] + uz * t;
      for (const s of [1, -1]) {
        const x = px - uz * inset * s, z = pz + ux * inset * s;
        if (pointInRing(x, z, ring)) {
          out.push({ i, x, z, ux, uz, nx: -uz * s, nz: ux * s });
          break;
        }
      }
      i++;
      next += step;
    }
    acc += L;
  }
  return out;
}

// 駐車場の区画: 一番長い辺の向きに、奥行き 5 m の区画を 2 列（背中合わせ）＋通路 6 m の繰り返しで並べる。
// 車の 4 隅が駐車場の中に入る区画だけ。ux, uz: 車の向き（列の外側を向く）
const stallCache = new WeakMap();
export function parkingStalls(area, { depth = 5, width = 2.5, aisle = 6 } = {}) {
  if (stallCache.has(area)) return stallCache.get(area);
  const ring = area.outer;
  let best = 0, ux = 1, uz = 0;
  for (let k = 0; k < ring.length; k++) {
    const a = ring[k], b = ring[(k + 1) % ring.length];
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (L > best) [best, ux, uz] = [L, (b[0] - a[0]) / L, (b[1] - a[1]) / L];
  }
  const nx = -uz, nz = ux;
  let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
  for (const [x, z] of ring) {
    const u = x * ux + z * uz, v = x * nx + z * nz;
    [u0, u1, v0, v1] = [Math.min(u0, u), Math.max(u1, u), Math.min(v0, v), Math.max(v1, v)];
  }
  const out = [];
  const hl = CAR_L / 2, hw = CAR_W / 2;
  let k = 0;
  for (let v = v0 + 0.3; v + depth <= v1; v += 2 * depth + aisle) {
    for (const [rv, face] of [[v + depth / 2, -1], [v + depth * 1.5, 1]]) {
      if (rv + depth / 2 > v1) continue;
      for (let u = u0 + 0.3 + width / 2; u + width / 2 <= u1; u += width, k++) {
        const x = u * ux + rv * nx, z = u * uz + rv * nz;
        const ok = [[1, 1], [1, -1], [-1, 1], [-1, -1]].every(([a, b]) => pointInPolygon(x + nx * a * hl + ux * b * hw, z + nz * a * hl + uz * b * hw, area));
        if (ok) out.push({ k, x, z, ux: nx * face, uz: nz * face });
      }
    }
  }
  stallCache.set(area, out);
  return out;
}

// 車の色（重みつきで選ぶ）
export function carColor(r) {
  for (const [hex, p] of CAR_PALETTE) {
    if (r < p) return hex;
    r -= p;
  }
  return CAR_PALETTE[0][0];
}

// エリア全体の索引（計画ごとに 1 回）: 交差点・横断歩道・橋の端・線路・広場・駐車場
const contexts = new WeakMap();
function contextOf(parsed, plan) {
  let c = contexts.get(plan);
  if (c) return c;
  const near = (grid, list, x, z, r, test) => {
    let hit = false;
    grid.queryPoint(x, z, r, (i) => {
      if (!hit && test(list[i])) hit = true;
    });
    return hit;
  };
  const jGrid = new Grid(25);
  plan.junctions.forEach((n, i) => jGrid.insertPoint(n.x, n.z, i));
  const xGrid = new Grid(25);
  plan.crossings.forEach((k, i) => xGrid.insertPoint(k.x, k.z, i));
  const ends = [];
  for (const r of parsed.roads) if (r.bridge && r.pts.length > 1) ends.push(r.pts[0], r.pts[r.pts.length - 1]);
  const eGrid = new Grid(30);
  ends.forEach((p, i) => eGrid.insertPoint(p[0], p[1], i));
  const rails = [];
  for (const r of parsed.rails || []) for (let i = 0; i + 1 < r.pts.length; i++) rails.push([r.pts[i][0], r.pts[i][1], r.pts[i + 1][0], r.pts[i + 1][1]]);
  const rGrid = new Grid(20);
  rails.forEach((s, i) => rGrid.insertSegment(s[0], s[1], s[2], s[3], i));
  // 車道の中心線（車止めを車道の縁に並べるため）: [ax, az, bx, bz, 半分の幅]
  const carSegs = [];
  for (const r of parsed.roads) {
    if (!CAR_ROADS.has(r.type) || r.bridge || r.tunnel) continue;
    for (let i = 0; i + 1 < r.pts.length; i++) carSegs.push([r.pts[i][0], r.pts[i][1], r.pts[i + 1][0], r.pts[i + 1][1], r.width / 2]);
  }
  const cGrid = new Grid(20);
  carSegs.forEach((q, i) => cGrid.insertSegment(q[0], q[1], q[2], q[3], i));
  const areas = parsed.areas || [];
  const plazas = areas.filter((a) => a.type === 'plaza' && a.outer?.length >= 3);
  const pGrid = new Grid(40);
  plazas.forEach((a, i) => pGrid.insertBounds(a.bounds.minX, a.bounds.minZ, a.bounds.maxX, a.bounds.maxZ, i));
  const segD = (x, z, s) => {
    const dx = s[2] - s[0], dz = s[3] - s[1], L2 = dx * dx + dz * dz || 1;
    const t = Math.max(0, Math.min(1, ((x - s[0]) * dx + (z - s[1]) * dz) / L2));
    return Math.hypot(x - s[0] - dx * t, z - s[1] - dz * t);
  };
  c = {
    plazas,
    parkings: areas.filter((a) => a.type === 'parking' && a.outer?.length >= 3),
    nearJunction: (x, z, r) => near(jGrid, plan.junctions, x, z, r, (n) => Math.hypot(n.x - x, n.z - z) < r),
    nearBridgeEnd: (x, z, r) => near(eGrid, ends, x, z, r, (p) => Math.hypot(p[0] - x, p[1] - z) < r),
    nearRail: (x, z, r) => near(rGrid, rails, x, z, r, (s) => segD(x, z, s) < r),
    // (x, z) を含む広場（Capitole の広場は除く）
    plazaAt: (x, z) => {
      let hit = null;
      pGrid.queryPoint(x, z, 0, (i) => {
        if (!hit && pointInPolygon(x, z, plazas[i])) hit = plazas[i];
      });
      return hit && !/Capitole/i.test(hit.name) ? hit : null;
    },
    // (x, z) にいちばん近い車道の縁（r m 以内）: { edge（縁までの距離）, half, qx, qz（中心線の点）, ux, uz（車道の向き） }。
    // accept(qx, qz): 中心線の点を使ってよいか（広場の下を通る道を除くため）
    nearestCar: (x, z, r, accept = () => true) => {
      let best = null;
      cGrid.queryPoint(x, z, r, (i) => {
        const q = carSegs[i];
        const dx = q[2] - q[0], dz = q[3] - q[1], L2 = dx * dx + dz * dz || 1;
        const t = Math.max(0, Math.min(1, ((x - q[0]) * dx + (z - q[1]) * dz) / L2));
        const qx = q[0] + dx * t, qz = q[1] + dz * t, d = Math.hypot(x - qx, z - qz);
        if ((!best || d - q[4] < best.edge) && accept(qx, qz)) best = { edge: d - q[4], d, half: q[4], qx, qz, ux: dx / Math.sqrt(L2), uz: dz / Math.sqrt(L2) };
      });
      return best;
    },
    // どれかの横断歩道の所
    nearCrossing: (x, z, extra) => near(xGrid, plan.crossings, x, z, 20, (k) => {
      const dx = x - k.x, dz = z - k.z;
      return Math.abs(dx * k.ux + dz * k.uz) < k.len / 2 + extra && Math.abs(-dx * k.uz + dz * k.ux) < k.half + 3;
    }),
    // 道 road の横断歩道の所（横断歩道の長さ＋extra の範囲）
    crossingZone: (road, x, z, extra) => near(xGrid, plan.crossings, x, z, 20, (k) => {
      if (k.road !== road) return false;
      const dx = x - k.x, dz = z - k.z;
      return Math.abs(dx * k.ux + dz * k.uz) < k.len / 2 + extra && Math.abs(-dx * k.uz + dz * k.ux) < k.half + 12;
    }),
  };
  contexts.set(plan, c);
  return c;
}

// 範囲 clip の小物の位置を決める。curbs: このタイルが書いた縁石の区間（streets.js の stats.curbs）。
// inOldTown: 旧市街の小物にする所か（右岸の歴史的な中心。config.js の historicCoreTest）。
// heightAt: 一段高い歩道の高さ、onRoad(x, z, margin): 道路の上か、solid(x, z): 建物・水の中か、trunks: 木の幹 [x, z]。
// 戻り値: 種類ごとの { x, y, z, a（向き）, sx, sy（大きさ）, color } の列と、当たり判定（colliders）
export function planFurniture({ parsed, plan, clip, curbs = [], inOldTown = () => false, heightAt = () => 0, onRoad = () => false, solid = () => false, trunks = [] }) {
  const ctx = contextOf(parsed, plan);
  const out = { lights: [], discs: [], candelabra: [], bollards: [], cars: [], bins: [], containers: [], colliders: [] };
  const inClip = (x, z) => x >= clip.minX && x < clip.maxX && z >= clip.minZ && z < clip.maxZ;
  const tGrid = new Grid(10);
  trunks.forEach(([x, z], i) => tGrid.insertPoint(x, z, i));
  const used = []; // 置いた小物（重ならないように）: [x, z, r]
  const uGrid = new Grid(10);
  const near = (x, z, r) => {
    let hit = false;
    tGrid.queryPoint(x, z, r + 0.4, (i) => {
      if (!hit && Math.hypot(trunks[i][0] - x, trunks[i][1] - z) < r + 0.4) hit = true;
    });
    uGrid.queryPoint(x, z, r + 1, (i) => {
      if (!hit && Math.hypot(used[i][0] - x, used[i][1] - z) < r + used[i][2]) hit = true;
    });
    return hit;
  };
  const clear = (x, z, r) => !near(x, z, r) && !solid(x, z);
  const take = (x, z, r) => {
    uGrid.insertPoint(x, z, used.length);
    used.push([x, z, r]);
  };
  const circle = (x, z, r) => out.colliders.push({ x, z, r });
  const boxC = (x, z, ux, uz, hl, hw) => out.colliders.push({ x, z, ux, uz, hl, hw });
  // 区間の端が範囲の境（隣のタイルへ続く）か
  const atEdge = (x, z, m) => x < clip.minX + m || x > clip.maxX - m || z < clip.minZ + m || z > clip.maxZ - m;

  for (const { road, rows } of curbs) {
    if (rows.length < 2) continue;
    const s0 = rows[0].s, s1 = rows[rows.length - 1].s;
    if (s1 - s0 < 1) continue;
    const right = rightSide(curbAt(rows, (s0 + s1) / 2));
    const id = road.id | 0;
    const side = right ? 1 : 0;
    // 区間の端が範囲の境（隣のタイルへ続く）なら、そこでは間をあけない（位置 s の入る区間が置く）
    const first = curbAt(rows, s0), last = curbAt(rows, s1);
    const open0 = atEdge(first.ax, first.az, road.width / 2 + 2.5), open1 = atEdge(last.ax, last.az, road.width / 2 + 2.5);
    const range = (m) => [open0 ? s0 : s0 + m, open1 ? s1 - 1e-6 : s1 - m];

    // ---- 街灯（旧市街の外）
    const boulevard = BOULEVARD.has(road.type) && road.width >= 9;
    let step = LIGHT_STEP, phase = hash01(id, 50) * LIGHT_STEP;
    if (boulevard) [step, phase] = [DISC_STEP, hash01(id, 50) * DISC_STEP];
    else if (road.width >= 6 || BOULEVARD.has(road.type)) [step, phase] = [2 * LIGHT_STEP, hash01(id, 50) * 2 * LIGHT_STEP + (right ? 0 : LIGHT_STEP)];
    else if ((hash01(id, 51) < 0.5) !== right) step = 0; // 狭い通りは片側だけ
    if (step) {
      for (const { s } of slotsAlong(...range(1), step, phase)) {
        const p = curbAt(rows, s);
        if (p.e < 0.9) continue;
        const off = Math.min(0.55, p.e * 0.5);
        const x = p.cx + p.nx * off, z = p.cz + p.nz * off;
        if (inOldTown(x, z) || ctx.crossingZone(road, x, z, 1.5) || ctx.nearJunction(x, z, 3) || !clear(x, z, 0.6)) continue;
        out[boulevard ? 'discs' : 'lights'].push({ x, z, y: heightAt(x, z), a: yaw(-p.nx, -p.nz) });
        take(x, z, 0.4);
        circle(x, z, boulevard ? 0.16 : 0.12);
      }
    }

    // ---- 花崗岩の車止め: 中心部の広い歩道（通りの片側ごとに半分。広場の縁は下で広場の外周から）
    if (hash01(id * 2 + side, 52) < 0.5) {
      for (const { s } of slotsAlong(...range(0.6), BOLLARD_STEP, 0.7)) {
        const p = curbAt(rows, s);
        const x = p.cx + p.nx * 0.3, z = p.cz + p.nz * 0.3;
        if (p.e < 6.5 || Math.hypot(x, z) > CENTRE_R || ctx.plazaAt(x, z)) continue;
        if (ctx.crossingZone(road, x, z, 2.3) || ctx.nearJunction(x, z, road.width / 2 + 1) || !clear(x, z, 0.14)) continue;
        out.bollards.push({ x, z, y: heightAt(x, z) });
        take(x, z, 0.16);
        circle(x, z, 0.15);
      }
    }

    // ---- 路上駐車の車（旧市街の外、車道が広い通り。自転車のために BIKE_LANE m 以上あける）。
    // 車道が狭い住宅街の通り（IGN の幅 4〜5 m が多い）は、歩道が広ければ片側に歩道へ半分乗り上げて（フォーブールの通りの写真）
    const mode = parkMode(road, curbAt(rows, (s0 + s1) / 2).e);
    if (mode && !road.bridge) {
      if (mode === 'both' || (hash01(id, 60) < 0.5) === right) {
        const kerb = mode === 'kerb';
        const off = kerb ? -KERB_OVER + CAR_W / 2 : CURB_GAP + CAR_W / 2; // 縁石の車道側の縁から車の中心まで（車道の側へ）
        for (const { k, s: sk } of slotsAlong(s0 - CAR_PITCH, s1 + CAR_PITCH, CAR_PITCH, hash01(id, 61) * CAR_PITCH)) {
          const h = (id ^ Math.imul(k + 7919 * side, 0x9e3779b1)) | 0;
          const s = sk + (hash01(h, 62) - 0.5) * 0.7;
          if (s < s0 || s >= s1) continue; // 真ん中のある区間（タイル）が置く
          if (hash01(h, 63) > 0.8 || hash01((id ^ Math.imul(Math.floor(s / 45) + 31 * side, 0x85ebca6b)) | 0, 64) < 0.18) continue; // 空いた所・空いた区画
          const sl = 0.93 + hash01(h, 65) * 0.14;
          if ((!open0 && s - (CAR_L / 2) * sl - 0.3 < s0) || (!open1 && s + (CAR_L / 2) * sl + 0.3 > s1)) continue;
          const p = curbAt(rows, s);
          if (kerb && p.e < KERB_MIN_E) continue;
          const x = p.ax - p.nx * off, z = p.az - p.nz * off;
          if (inOldTown(x, z) || ctx.nearJunction(x, z, 11) || ctx.crossingZone(road, x, z, 4.5) || ctx.nearBridgeEnd(x, z, 14) || ctx.nearRail(x, z, 4.5)) continue;
          // ほかの通りの歩道にかかる所（交差点の角）は置かない。車道側の車輪の下は車道（高さ 0）
          const hx = p.ux * (CAR_L / 2) * sl, hz = p.uz * (CAR_L / 2) * sl;
          const ox = kerb ? -p.nx * (CAR_W / 2 - 0.2) : 0, oz = kerb ? -p.nz * (CAR_W / 2 - 0.2) : 0;
          if (heightAt(x + ox + hx, z + oz + hz) > 0.02 || heightAt(x + ox - hx, z + oz - hz) > 0.02 || heightAt(x + ox, z + oz) > 0.02) continue;
          const fwd = right || road.oneway ? 1 : -1;
          let y = 0, roll = 0;
          if (kerb) {
            // 歩道側の車輪は歩道の上: 歩道の街灯・木・ごみ箱・建物にかからない所だけ。車を横に少し傾ける
            const ix = p.cx + p.nx * (KERB_OVER - CURB_W) * 0.5, iz = p.cz + p.nz * (KERB_OVER - CURB_W) * 0.5;
            if ([-1, 0, 1].some((t) => !clear(ix + hx * t * 0.8, iz + hz * t * 0.8, 0.45))) continue;
            const hs = heightAt(p.cx + p.nx * 0.3, p.cz + p.nz * 0.3);
            y = hs / 2;
            // 進む向きの右（模型の +z）が歩道なら右を上げる（x 軸まわりの回転が正だと右が下がる）
            const sideR = p.nx * -p.uz * fwd + p.nz * p.ux * fwd > 0;
            roll = Math.atan2(hs, 1.55) * (sideR ? -1 : 1);
            for (const t of [-1, 0, 1]) take(ix + hx * t * 0.8, iz + hz * t * 0.8, 0.5);
          }
          out.cars.push({ x, z, y, a: yaw(p.ux * fwd, p.uz * fwd), roll, sx: sl, sy: 0.94 + hash01(h, 66) * 0.16, color: carColor(hash01(h, 67)) });
          boxC(x, z, p.ux, p.uz, (CAR_L / 2) * sl, CAR_W / 2);
        }
      }
    }

    // ---- ごみ収集容器（広い歩道にときどき、旧市街の外）・歩道のごみ箱
    for (const { k, s } of slotsAlong(s0 + 3, s1 - 3, 75, hash01(id, 70) * 75)) {
      const h = (id ^ Math.imul(k + 101 * side, 0x27d4eb2d)) | 0;
      const p = curbAt(rows, s);
      if (p.e < 2.6 || hash01(h, 71) > 0.3) continue;
      const n = hash01(h, 72) < 0.5 ? 2 : 1;
      for (let m = 0; m < n; m++) {
        const x = p.cx + p.nx * 0.85 + p.ux * m * 1.4, z = p.cz + p.nz * 0.85 + p.uz * m * 1.4;
        if (inOldTown(x, z) || ctx.crossingZone(road, x, z, 2) || ctx.nearJunction(x, z, 6) || !clear(x, z, 0.8)) continue;
        out.containers.push({ x, z, y: heightAt(x, z), a: yaw(p.ux, p.uz), color: BIN_COLORS[(hash01(h, 73 + m) < 0.55) ? 0 : 1] });
        take(x, z, 0.8);
        boxC(x, z, p.ux, p.uz, 0.65, 0.55);
      }
    }
    for (const { k, s } of slotsAlong(s0 + 2, s1 - 2, 60, hash01(id, 75) * 60)) {
      const p = curbAt(rows, s);
      if (p.e < 1.6 || hash01((id ^ Math.imul(k + 37 * side, 0x165667b1)) | 0, 76) > 0.3) continue;
      const x = p.cx + p.nx * 0.45, z = p.cz + p.nz * 0.45;
      if (ctx.crossingZone(road, x, z, 1.5) || !clear(x, z, 0.4)) continue;
      out.bins.push({ x, z, y: heightAt(x, z), a: yaw(p.nx, p.nz) });
      take(x, z, 0.35);
      circle(x, z, 0.28);
    }
  }

  // ---- ごみ箱: 横断歩道の角（約 3 割）。歩道の上だけ
  for (const c of plan.crossings) {
    if (c.x < clip.minX - 12 || c.x >= clip.maxX + 12 || c.z < clip.minZ - 12 || c.z >= clip.maxZ + 12) continue;
    const nx = -c.uz, nz = c.ux;
    const hc = (Math.round(c.x * 10) * 73856093) ^ (Math.round(c.z * 10) * 19349663);
    let corner = 0;
    for (const s of [1, -1]) {
      for (const d of [1, -1]) {
        if (hash01(hc, 80 + corner++) > 0.3) continue;
        const along = d * (c.len / 2 + 2.7), off = s * (c.half + CURB_W + 0.6);
        const x = c.x + c.ux * along + nx * off, z = c.z + c.uz * along + nz * off;
        if (!inClip(x, z) || heightAt(x, z) < 0.02 || !clear(x, z, 0.4)) continue;
        out.bins.push({ x, z, y: heightAt(x, z), a: yaw(-nx * s, -nz * s) });
        take(x, z, 0.35);
        circle(x, z, 0.28);
      }
    }
  }

  // ---- 広場: 旧市街の広場の縁に黒い燭台形の街灯（Capitole の広場は除く）、ごみ箱を 2〜4 個
  for (const a of ctx.plazas) {
    const b = a.bounds;
    if (b.maxX < clip.minX || b.minX > clip.maxX || b.maxZ < clip.minZ || b.minZ > clip.maxZ || /Capitole/i.test(a.name)) continue;
    const hid = a.id | 0;
    const ok = (x, z, r) => inClip(x, z) && pointInPolygon(x, z, a) && !onRoad(x, z, 0.8) && clear(x, z, r);
    // 花崗岩の車止め: 広場の縁が車道に沿って接する所に 1.4 m おき。車道の縁石のすぐ後ろ（縁から 0.5 m）に立てる。
    // 広場の下を通る道（広場の舗装に隠れる）は使わない。広場の縁より 1 m 以上内側には立てない
    const outside = (qx, qz) => !pointInPolygon(qx, qz, a);
    for (const p of ringSamples(a.outer, BOLLARD_STEP, 0.4, 0.7)) {
      const c = ctx.nearestCar(p.x, p.z, 16, outside);
      if (!c || c.edge < 0.2 || c.edge > 4 || Math.abs(p.ux * c.ux + p.uz * c.uz) < 0.7) continue;
      const k = (c.half + CURB_W + 0.3) / c.d;
      const x = c.qx + (p.x - c.qx) * k, z = c.qz + (p.z - c.qz) * k;
      if ((x - p.x) * p.nx + (z - p.z) * p.nz > 0.6 || onRoad(x, z, 0.05)) continue;
      if (!inClip(x, z) || ctx.nearCrossing(x, z, 1) || ctx.nearJunction(x, z, c.half + 1) || !clear(x, z, 0.14)) continue;
      out.bollards.push({ x, z, y: heightAt(x, z) });
      take(x, z, 0.16);
      circle(x, z, 0.15);
    }
    if (a.area >= 800) {
      // 22 m おき、大きな広場は外周を 8 等分（どのタイルで作っても同じ所に最大 8 本）
      const step = Math.max(22, polylineLength([...a.outer, a.outer[0]]) / 8);
      for (const p of ringSamples(a.outer, step, 1.6, hash01(hid, 90) * step)) {
        if (!inOldTown(p.x, p.z) || !ok(p.x, p.z, 0.7)) continue;
        out.candelabra.push({ x: p.x, z: p.z, y: heightAt(p.x, p.z), a: yaw(p.ux, p.uz) });
        take(p.x, p.z, 0.5);
        circle(p.x, p.z, 0.16);
      }
    }
    if (a.area >= 500) {
      for (const p of ringSamples(a.outer, 37, 1.4, 11 + hash01(hid, 91) * 37)) {
        if (p.i >= 4 || hash01(hid, 92 + p.i) > 0.7 || !ok(p.x, p.z, 0.4)) continue;
        out.bins.push({ x: p.x, z: p.z, y: heightAt(p.x, p.z), a: yaw(p.nx, p.nz) });
        take(p.x, p.z, 0.35);
        circle(p.x, p.z, 0.28);
      }
    }
  }

  // ---- 駐車場の車（約 2/3 の区画）
  for (const a of ctx.parkings) {
    const b = a.bounds;
    if (b.maxX < clip.minX || b.minX > clip.maxX || b.maxZ < clip.minZ || b.minZ > clip.maxZ) continue;
    const hid = a.id | 0;
    for (const st of parkingStalls(a)) {
      if (!inClip(st.x, st.z)) continue;
      const h = (hid ^ Math.imul(st.k + 1, 0x9e3779b1)) | 0;
      if (hash01(h, 81) > 0.68) continue;
      const hx = st.ux * CAR_L / 2, hz = st.uz * CAR_L / 2;
      const ends = [[st.x + hx, st.z + hz], [st.x - hx, st.z - hz], [st.x, st.z]];
      if (ends.some(([x, z]) => onRoad(x, z, 0.3) || solid(x, z)) || near(st.x, st.z, 1.4)) continue;
      const nx = -st.uz * CAR_W / 2, nz = st.ux * CAR_W / 2;
      if ([[1, 1], [1, -1], [-1, 1], [-1, -1]].some(([u, v]) => heightAt(st.x + hx * u + nx * v, st.z + hz * u + nz * v) > 0.02)) continue;
      const sl = 0.93 + hash01(h, 82) * 0.12;
      out.cars.push({ x: st.x, z: st.z, y: 0, a: yaw(st.ux, st.uz), sx: sl, sy: 0.94 + hash01(h, 83) * 0.16, color: carColor(hash01(h, 84)) });
      boxC(st.x, st.z, st.ux, st.uz, (CAR_L / 2) * sl, CAR_W / 2);
    }
  }
  return out;
}

// ---------------------------------------------------------------- 形（MeshWriter。uv の u は塗装の印: 1 = 車の色をかける）
const UP = [0, 1, 0], DOWN = [0, -1, 0];
const rgb = (hex) => {
  const c = new THREE.Color(hex);
  return [c.r, c.g, c.b];
};

// 凸多角形の面（扇形に三角形分割）
function face(w, pts, n, color, paint = 0) {
  const t = [paint, 0];
  for (let i = 1; i + 1 < pts.length; i++) w.tri(pts[0], pts[i], pts[i + 1], n, t, t, t, color);
}

function box(w, x0, y0, z0, x1, y1, z1, color, { paint = 0, bottom = null, top = color } = {}) {
  const P = (x, y, z) => [x, y, z];
  face(w, [P(x0, y1, z0), P(x1, y1, z0), P(x1, y1, z1), P(x0, y1, z1)], UP, top, paint);
  if (bottom) face(w, [P(x0, y0, z0), P(x1, y0, z0), P(x1, y0, z1), P(x0, y0, z1)], DOWN, bottom, 0);
  face(w, [P(x1, y0, z0), P(x1, y1, z0), P(x1, y1, z1), P(x1, y0, z1)], [1, 0, 0], color, paint);
  face(w, [P(x0, y0, z0), P(x0, y0, z1), P(x0, y1, z1), P(x0, y1, z0)], [-1, 0, 0], color, paint);
  face(w, [P(x0, y0, z1), P(x1, y0, z1), P(x1, y1, z1), P(x0, y1, z1)], [0, 0, 1], color, paint);
  face(w, [P(x0, y0, z0), P(x0, y1, z0), P(x1, y1, z0), P(x1, y0, z0)], [0, 0, -1], color, paint);
}

// 縦の角柱（n 角）: 中心 (cx, cz)、半径 r0（下）→ r1（上）、高さ y0 → y1。r1 = 0 なら錐
function column(w, cx, cz, r0, r1, y0, y1, n, color, { top = null, bottom = null, paint = 0 } = {}) {
  const ring = (r, y) => Array.from({ length: n }, (_, i) => [cx + Math.cos((i / n) * 2 * Math.PI) * r, y, cz + Math.sin((i / n) * 2 * Math.PI) * r]);
  const A = ring(r0, y0), B = ring(r1, y1);
  const k = (r0 - r1) / Math.max(1e-6, y1 - y0);
  const t = [paint, 0];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n, am = ((i + 0.5) / n) * 2 * Math.PI;
    const L = Math.hypot(1, k);
    const nn = [Math.cos(am) / L, k / L, Math.sin(am) / L];
    if (r1 > 1e-4) w.quad(A[i], A[j], B[j], B[i], nn, t, t, t, t, color);
    else w.tri(A[i], A[j], [cx, y1, cz], nn, t, t, t, color);
  }
  if (top && r1 > 1e-4) face(w, B, UP, top, paint);
  if (bottom) face(w, A, DOWN, bottom, 0);
}

// 横から見た形（x: 前後、y: 高さの凸多角形、反時計回り）を、幅 ±hw に押し出す。edge(i): 辺 i の面の { color, paint }
function extrude(w, prof, hw, color, paint, edge) {
  for (const s of [1, -1]) face(w, prof.map(([x, y]) => [x, y, s * hw]), [0, 0, s], color, paint);
  for (let i = 0; i < prof.length; i++) {
    const e = edge(i);
    if (!e) continue;
    const [x0, y0] = prof[i], [x1, y1] = prof[(i + 1) % prof.length];
    const L = Math.hypot(x1 - x0, y1 - y0);
    face(w, [[x0, y0, -hw], [x1, y1, -hw], [x1, y1, hw], [x0, y0, hw]], [(y1 - y0) / L, -(x1 - x0) / L, 0], e.color, e.paint);
  }
}

// 車輪（6 角の円柱、外側の面だけ）
function wheel(w, x, zIn, zOut, r, color, cap) {
  const n = 6, y = r;
  const P = (i, z) => [x + Math.cos((i / n) * 2 * Math.PI + Math.PI / 6) * r, y + Math.sin((i / n) * 2 * Math.PI + Math.PI / 6) * r, z];
  const t = [0, 0];
  for (let i = 0; i < n; i++) {
    const am = ((i + 0.5) / n) * 2 * Math.PI + Math.PI / 6;
    w.quad(P(i, zIn), P(i + 1, zIn), P(i + 1, zOut), P(i, zOut), [Math.cos(am), Math.sin(am), 0], t, t, t, t, color);
  }
  face(w, Array.from({ length: n }, (_, i) => P(i, zOut)), [0, 0, Math.sign(zOut)], cap);
}

// 乗用車（長さ 4.2・幅 1.8・高さ 1.45 m、前が +x）: 車体・窓の暗い客室・屋根・柱・車輪・前照灯と尾灯（約 120 三角形）
export function carGeometry() {
  const w = new MeshWriter();
  const paint = [1, 1, 1], glass = rgb('#1b2126'), tyre = rgb('#181818'), hub = rgb('#3a3c3e');
  const body = [[-2.1, 0.24], [2.1, 0.24], [2.12, 0.6], [2.02, 0.8], [0.95, 0.97], [-1.85, 1.0], [-2.08, 0.86]];
  extrude(w, body, 0.89, paint, 1, (i) => (i === 0 ? null : { color: paint, paint: 1 }));
  const cabin = [[-1.82, 0.99], [0.85, 0.96], [0.12, 1.4], [-1.3, 1.42]];
  extrude(w, cabin, 0.76, glass, 0, (i) => (i === 1 || i === 3 ? { color: glass, paint: 0 } : null));
  box(w, -1.34, 1.39, -0.775, 0.16, 1.46, 0.775, paint, { paint: 1 }); // 屋根
  for (const s of [1, -1]) {
    const z = s * 0.765;
    face(w, [[-0.5, 0.99, z], [-0.34, 0.99, z], [-0.34, 1.41, z], [-0.5, 1.41, z]], [0, 0, s], paint, 1); // 中の柱
  }
  for (const x of [-1.38, 1.38]) for (const s of [1, -1]) wheel(w, x, s * 0.66, s * 0.92, 0.31, tyre, hub);
  const lamp = rgb('#e8e6dc'), tail = rgb('#8a1414');
  for (const s of [1, -1]) {
    face(w, [[2.13, 0.5, s * 0.5], [2.13, 0.5, s * 0.82], [2.13, 0.63, s * 0.82], [2.13, 0.63, s * 0.5]], [1, 0, 0], lamp);
    face(w, [[-2.1, 0.66, s * 0.55], [-2.1, 0.66, s * 0.85], [-2.1, 0.79, s * 0.85], [-2.1, 0.79, s * 0.55]], [-1, 0, 0], tail);
  }
  return toGeometry(w);
}

// 灰色の柱に横向きの灯具（高さ約 7 m、腕は +x の車道の方へ）。ユーザーの写真 chateau-deau
export function lampGeometry() {
  const w = new MeshWriter();
  const grey = rgb('#7c8184'), head = rgb('#5d6266'), lens = rgb('#e2ded2');
  column(w, 0, 0, 0.13, 0.11, 0, 0.6, 6, grey, { top: grey });
  column(w, 0, 0, 0.085, 0.06, 0.6, 7.0, 6, grey, { top: grey });
  box(w, 0, 6.86, -0.03, 1.0, 6.92, 0.03, grey);
  box(w, 0.9, 6.8, -0.17, 1.65, 6.95, 0.17, head, { bottom: lens });
  return toGeometry(w);
}

// 大通りの高い円盤形の街灯（約 10 m）。ユーザーの写真 stadium
export function discLampGeometry() {
  const w = new MeshWriter();
  const grey = rgb('#8b8f91'), disc = rgb('#6e7275'), lens = rgb('#e6e3da');
  column(w, 0, 0, 0.2, 0.17, 0, 0.8, 8, grey, { top: grey });
  column(w, 0, 0, 0.12, 0.075, 0.8, 9.9, 8, grey);
  column(w, 0, 0, 0.72, 0.72, 9.9, 10.08, 10, disc, { top: disc, bottom: lens });
  column(w, 0, 0, 0.035, 0, 10.08, 10.45, 4, grey);
  return toGeometry(w);
}

// 旧市街の広場の黒い燭台形の街灯（約 4.6 m、腕 2 本と真ん中に提灯 3 つ）。写真 street-furniture-2
export function candelabraGeometry() {
  const w = new MeshWriter();
  const black = rgb('#1b1c1d'), glass = rgb('#ddd2a8');
  column(w, 0, 0, 0.17, 0.12, 0, 0.9, 8, black, { top: black });
  column(w, 0, 0, 0.075, 0.06, 0.9, 4.0, 8, black);
  box(w, -0.62, 3.88, -0.03, 0.62, 3.94, 0.03, black);
  for (const [x, y] of [[-0.6, 3.94], [0.6, 3.94], [0, 4.0]]) {
    column(w, x, 0, 0.1, 0.15, y, y + 0.42, 4, glass);
    column(w, x, 0, 0.2, 0, y + 0.42, y + 0.6, 4, black, { bottom: black });
  }
  return toGeometry(w);
}

// 花崗岩の円柱の車止め（直径 28 cm・高さ 55 cm・頭が丸い）。ユーザーの写真 coq-statue、写真 street-furniture-1
export function bollardGeometry() {
  const w = new MeshWriter();
  const granite = rgb('#8d9095'), band = rgb('#74777c');
  column(w, 0, 0, 0.14, 0.14, 0, 0.36, 8, granite);
  column(w, 0, 0, 0.14, 0.14, 0.36, 0.44, 8, band);
  column(w, 0, 0, 0.14, 0.075, 0.44, 0.55, 8, granite, { top: granite });
  return toGeometry(w);
}

// 黒い輪の形のごみ箱（柱に輪と袋。高さ約 1 m、柱は -x 側）。ユーザーの写真の虹の写真
export function binGeometry() {
  const w = new MeshWriter();
  const black = rgb('#202324'), bag = rgb('#3a3d3b'), inside = rgb('#101111');
  column(w, -0.27, 0, 0.035, 0.035, 0, 1.0, 4, black, { top: black });
  column(w, 0, 0, 0.21, 0.23, 0.32, 0.84, 8, bag);
  column(w, 0, 0, 0.255, 0.255, 0.84, 0.9, 8, black, { top: inside });
  return toGeometry(w);
}

// 大きなごみ収集容器（約 1.25×1.05×1.2 m、ふた付き。色はインスタンスの色）
export function containerGeometry() {
  const w = new MeshWriter();
  const paint = [1, 1, 1], lid = [0.72, 0.72, 0.72], dark = rgb('#1c1c1c');
  box(w, -0.6, 0, -0.5, 0.6, 0.1, 0.5, dark);
  box(w, -0.62, 0.1, -0.52, 0.62, 1.12, 0.52, paint, { paint: 1 });
  box(w, -0.66, 1.12, -0.56, 0.66, 1.19, 0.57, lid, { paint: 1, top: lid });
  return toGeometry(w);
}

function toGeometry(w) {
  const g = w.toGeometry();
  const uv = g.getAttribute('uv');
  const paint = new Float32Array(uv.count);
  for (let i = 0; i < uv.count; i++) paint[i] = uv.getX(i);
  g.setAttribute('paint', new THREE.BufferAttribute(paint, 1));
  g.deleteAttribute('uv');
  return g;
}

// 頂点色 × インスタンスの色（塗装の印 paint のある所だけ）。車体は車の色、窓・車輪・灯火は頂点色のまま
export function furnitureMaterial() {
  const m = new THREE.MeshLambertMaterial({ vertexColors: true });
  m.onBeforeCompile = (sh) => {
    sh.vertexShader = 'attribute float paint;\n' + sh.vertexShader.replace('#include <color_vertex>', `
#if defined( USE_COLOR ) || defined( USE_INSTANCING_COLOR )
	vColor = vec4( 1.0 );
#endif
#ifdef USE_COLOR
	vColor.rgb *= color;
#endif
#ifdef USE_INSTANCING_COLOR
	vColor.rgb *= mix( vec3( 1.0 ), instanceColor.rgb, paint );
#endif`);
  };
  m.customProgramCacheKey = () => 'furniture-paint';
  return m;
}

// ---------------------------------------------------------------- タイルの小物（種類ごとに 1 つの InstancedMesh）
export class FurnitureSet {
  constructor() {
    this.group = new THREE.Group();
    this.group.name = 'furniture';
    this.parts = [];
    this.at = null;
    this.count = 0;
  }

  // items: { x, y, z, a, sx, sy, color } の列。全部の行列を覚えておき、cull で近い物だけを前に詰めて描く
  add(name, geometry, material, items, { shadow = false } = {}) {
    if (!items.length) {
      geometry.dispose();
      return;
    }
    const n = items.length;
    const mesh = new THREE.InstancedMesh(geometry, material, n);
    mesh.name = name;
    const mats = new Float32Array(n * 16), xz = new Float32Array(n * 2);
    const cols = items[0].color ? new Float32Array(n * 3) : null;
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), s = new THREE.Vector3(), e = new THREE.Euler(), c = new THREE.Color();
    items.forEach((it, i) => {
      // a: Y 軸まわりの向き、roll: 模型の x 軸（前後）まわりの傾き（歩道に乗り上げた車）
      m.compose(p.set(it.x, it.y || 0, it.z), q.setFromEuler(e.set(it.roll || 0, it.a || 0, 0, 'YXZ')), s.set(it.sx || 1, it.sy || 1, 1));
      m.toArray(mats, i * 16);
      xz[2 * i] = it.x;
      xz[2 * i + 1] = it.z;
      if (cols) c.set(it.color).toArray(cols, i * 3);
    });
    if (cols) mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3);
    mesh.castShadow = shadow;
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    mesh.count = 0;
    mesh.visible = false;
    mesh.boundingSphere = new THREE.Sphere();
    this.parts.push({ mesh, mats, xz, cols, n });
    this.group.add(mesh);
    this.count += n;
  }

  // (x, z) から FURNITURE_FAR m 以内の物だけを描く（REFILL m 動くまでは選び直さない）
  cull(x, z, force = false) {
    if (!force && this.at && Math.hypot(x - this.at[0], z - this.at[1]) < REFILL) return;
    this.at = [x, z];
    const r2 = FURNITURE_FAR * FURNITURE_FAR;
    for (const P of this.parts) {
      const dst = P.mesh.instanceMatrix.array, dc = P.mesh.instanceColor?.array;
      let k = 0, x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
      for (let i = 0; i < P.n; i++) {
        const ix = P.xz[2 * i], iz = P.xz[2 * i + 1], dx = ix - x, dz = iz - z;
        if (dx * dx + dz * dz > r2) continue;
        [x0, z0, x1, z1] = [Math.min(x0, ix), Math.min(z0, iz), Math.max(x1, ix), Math.max(z1, iz)];
        dst.set(P.mats.subarray(i * 16, i * 16 + 16), k * 16);
        if (dc) dc.set(P.cols.subarray(i * 3, i * 3 + 3), k * 3);
        k++;
      }
      P.mesh.count = k;
      P.mesh.visible = k > 0;
      P.mesh.instanceMatrix.needsUpdate = true;
      if (dc) P.mesh.instanceColor.needsUpdate = true;
      // 描く物をすべて囲む球（視錐台カリング用。小物の大きさの分 12 m 足す）
      if (k) P.mesh.boundingSphere.set(P.mesh.boundingSphere.center.set((x0 + x1) / 2, 5, (z0 + z1) / 2), Math.hypot(x1 - x0, z1 - z0) / 2 + 12);
    }
  }
}

// 範囲の小物を作り、当たり判定（cw: CollisionWorld）に足す。戻り値の group をシーンに足し、毎フレーム cull(x, z) を呼ぶ
export function buildFurniture(opts, cw = null) {
  const items = planFurniture(opts);
  const set = new FurnitureSet();
  const mat = furnitureMaterial();
  set.add('cars', carGeometry(), mat, items.cars, { shadow: true });
  set.add('lights', lampGeometry(), mat, items.lights, { shadow: true });
  set.add('disc-lights', discLampGeometry(), mat, items.discs, { shadow: true });
  set.add('candelabra', candelabraGeometry(), mat, items.candelabra);
  set.add('bollards', bollardGeometry(), mat, items.bollards);
  set.add('bins', binGeometry(), mat, items.bins);
  set.add('containers', containerGeometry(), mat, items.containers, { shadow: true });
  if (cw) {
    for (const c of items.colliders) {
      if (c.r) cw.addCircle(c.x, c.z, c.r);
      else {
        const { x, z, ux, uz, hl, hw } = c, nx = -uz, nz = ux;
        cw.addRing([[x + ux * hl + nx * hw, z + uz * hl + nz * hw], [x - ux * hl + nx * hw, z - uz * hl + nz * hw], [x - ux * hl - nx * hw, z - uz * hl - nz * hw], [x + ux * hl - nx * hw, z + uz * hl - nz * hw]]);
      }
    }
  }
  set.stats = Object.fromEntries(Object.entries(items).map(([k, v]) => [k, v.length]));
  return set;
}
