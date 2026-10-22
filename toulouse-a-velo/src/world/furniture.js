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
// - 街灯の種類（ユーザーの写真 4・8・10・26）: 中心部（Saint-Cyprien を含む）は灰緑の柱に白鳥の首の腕と吊り下げの灯具、
//   広い大通りは細い鋼の高い柱に斜めの腕（Jean Jaurès・Grande-Bretagne）、幹線の環状道路とスタジアムの近くは円盤形
// - 車止めは歩道では黒い細い柱（potelets、写真 7・8・17・21・23・27）、広場と Rue de Metz（写真 13）は花崗岩の円柱
// - バス・自転車レーンが縁石に沿う側（markings.js の laneLayout）には路上駐車しない
// - Place du Capitole: 暗い灰青色の高い 5 灯の燭台形の街灯を広場の縁に約 12 本（キャピトルの正面の側はあける）、
//   西と南のアーケードの前にカフェのテラス（白い四角のパラソル・テーブル 2 つ・椅子 4 つ）、縁に花崗岩の角石・ベンチ・
//   車止めの列、南の縁に暗い植木箱。Place Wilson も縁にテラス
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
import { inLaneBand } from './markings.js';

export const FURNITURE_FAR = 280; // これより遠い小物は描かない（m、自転車から）
const REFILL = 12; // 自転車がこれだけ動いたら、描く小物を選び直す（m）

const PROMENADE_STEP = 18; // 河岸の下の遊歩道の街灯の間隔
const PROMENADES = /^Promenade Henri[- ]Martin$/i; // 街灯を並べる河岸の下の遊歩道
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
const NARROW_BOLLARD_R = 1100, NARROW_BOLLARD_STEP = 2.1; // 狭い歩道の縁にも車止めを並べる中心部（Saint-Cyprien を含む）と間隔（m）

// 車の色（写真の路上駐車: 白・銀・灰・黒・紺が大半、赤やほかの色は少し）。[sRGB, 割合]
// （ユーザーのストリートビュー: 白・銀・灰が多く、黒は少ない）
const CAR_PALETTE = [
  ['#e6e6e3', 0.3], ['#b3b7ba', 0.2], ['#6c7074', 0.16], ['#3b3e41', 0.08], ['#151618', 0.07],
  ['#1e2a45', 0.07], ['#3d5c8a', 0.03], ['#8c1c1c', 0.05], ['#b7ab93', 0.02], ['#2e4838', 0.01], ['#5a3b2c', 0.01],
];
const SWAN_R = 1300; // 白鳥の首の街灯にする中心部（原点＝Pont Neuf からの距離。Saint-Cyprien を含む）
const STADIUM = [-440, 1820], STADIUM_R = 650; // スタジアムの近くは円盤形の街灯のまま
const DISC_TYPES = new Set(['trunk', 'trunk_link']);
const MAST_NAME = /^(All[ée]es |Boulevard |Avenue de (la )?Grande[- ]Bretagne$|Route de Bayonne$)/i;
const BIN_COLORS = ['#2f6a3c', '#2c5a94']; // ごみ収集容器（緑・青）

// ---------------------------------------------------------------- 位置の計算（純粋な関数）
// 道の始点からの距離 [s0, s1] の中の、step おきの位置（phase だけずらす）。k: 何番目か（道全体で決まる）
const PLANTER_STREETS = /^Rue d'Alsace[- ]Lorraine$/i;
const PLANTER_STEP = 28;

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

// 花崗岩の円柱の車止めを歩道に並べる通り（ほかの歩道は黒い potelets）
const GRANITE_STREETS = /^Rue de Metz$/i;

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
    promenades: (parsed.roads || []).filter((r) => PROMENADES.test(r.name || '') && !r.bridge && !r.tunnel),
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
  const out = { lights: [], discs: [], candelabra: [], bollards: [], blocks: [], planters: [], cars: [], bins: [], containers: [], terraces: [], colliders: [] };
  const inClip = (x, z) => x >= clip.minX && x < clip.maxX && z >= clip.minZ && z < clip.maxZ;
  // バス・自転車レーンの帯（markings.js の断面）にかかる車は、どこから置いた車でも置かない（縁石の列は隣の区間の車道・
  // 駐車場の区画が車道にかかる所も。Avenue de Grande-Bretagne の自転車レーン）
  const laneRoads = plan?.layout && plan.roadsNear ? plan.roadsNear(clip, 20).filter((r) => { const l = plan.layout(r); return l.right || l.left; }) : [];
  const onLane = (x, z) => laneRoads.length > 0 && inLaneBand(x, z, laneRoads, plan.layout, CAR_W / 2 - 0.3);
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
    // 大通り: 広い幹線道路と、名前の分かる並木の大通り（Jean Jaurès・Grande-Bretagne・Route de Bayonne。IGN の車道は片側ずつ）
    const boulevard = BOULEVARD.has(road.type) && (road.width >= 9 || MAST_NAME.test(road.name || ''));
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
        // 種類: 大通りは鋼の高い柱（mast）か円盤形（disc: 環状道路・スタジアムの近く）、ほかは中心部が白鳥の首（swan）
        const type = boulevard
          ? (DISC_TYPES.has(road.type) || Math.hypot(x - STADIUM[0], z - STADIUM[1]) < STADIUM_R ? 'disc' : 'mast')
          : Math.hypot(x, z) < SWAN_R ? 'swan' : 'arm';
        out[boulevard ? 'discs' : 'lights'].push({ x, z, y: heightAt(x, z), a: yaw(-p.nx, -p.nz), type });
        take(x, z, 0.4);
        circle(x, z, boulevard ? 0.16 : 0.12);
      }
    }

    // ---- 花崗岩の車止め: 中心部の広い歩道（通りの片側ごとに半分。広場の縁は下で広場の外周から）と、中心部の狭い歩道の縁
    // （ユーザーのストリートビュー: Rue de la République・Place Esquirol・Rue Laganne は狭い歩道の縁にも黒い車止めが約 2 m おきに並ぶ。
    // 大通りと、歩道に半分乗り上げて止める通りは除く）
    const wideSide = hash01(id * 2 + side, 52) < 0.5;
    {
      let lastNarrow = -Infinity;
      for (const { s } of slotsAlong(...range(0.6), BOLLARD_STEP, 0.7)) {
        const p = curbAt(rows, s);
        const x = p.cx + p.nx * 0.3, z = p.cz + p.nz * 0.3;
        const narrow = p.e >= 1.2 && p.e < 6.5;
        if (narrow ? Math.hypot(x, z) > NARROW_BOLLARD_R || s - lastNarrow < NARROW_BOLLARD_STEP || road.width >= 9 || parkMode(road, p.e) === 'kerb' : !wideSide || p.e < 6.5 || Math.hypot(x, z) > CENTRE_R) continue;
        if (ctx.plazaAt(x, z)) continue;
        if (ctx.crossingZone(road, x, z, 2.3) || ctx.nearJunction(x, z, road.width / 2 + 1) || !clear(x, z, 0.14)) continue;
        const granite = GRANITE_STREETS.test(road.name || '');
        // 黒い細い車止めは一続きにせず、約 7 m の組ごとに 3 割ほど抜く（写真: 横断歩道の近く・切れ目ごとの組）
        if (!granite && hash01((id * 2 + side) ^ Math.imul(Math.floor(s / 7) + 1, 0x2c1b3c6d), 53) < 0.3) continue;
        // 歩道は黒い細い車止め（potelets。ユーザーの写真 7・8・17・21・23: 旧市街の Alsace-Lorraine・Lafayette も）。
        // 灰色の花崗岩の円柱は広場（下の広場の外周）と、石の柱の並ぶ通り（Rue de Metz、写真 13）だけ
        out.bollards.push({ x, z, y: heightAt(x, z), type: granite ? 'granite' : 'potelet', a: yaw(p.ux, p.uz) });
        if (narrow) lastNarrow = s;
        take(x, z, 0.16);
        circle(x, z, 0.15);
      }
    }

    // ---- 路上駐車の車（旧市街の外、車道が広い通り。自転車のために BIKE_LANE m 以上あける）。
    // 車道が狭い住宅街の通り（IGN の幅 4〜5 m が多い）は、歩道が広ければ片側に歩道へ半分乗り上げて（フォーブールの通りの写真）
    // バス・自転車レーンが縁石に沿う側（markings.js の laneLayout と同じ断面）には止めない
    const lay = plan?.layout ? plan.layout(road) : null;
    const lane = lay && (right ? lay.right : lay.left);
    const mode = lane ? null : parkMode(road, curbAt(rows, (s0 + s1) / 2).e);
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
          if (inOldTown(x, z) || onLane(x, z) || ctx.nearJunction(x, z, 11) || ctx.crossingZone(road, x, z, 4.5) || ctx.nearBridgeEnd(x, z, 14) || ctx.nearRail(x, z, 4.5)) continue;
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

  // ---- Rue d'Alsace-Lorraine（利用者の Street View 211548・211704）: 通りの真ん中から少し西寄りに、低い植え込みの箱
  // （3 × 1.4 m・高さ 0.5 m、低木と小さな常緑のタイサンボク）を約 28 m おき。位置は道の始点からの距離で決める
  for (const road of parsed.roads) {
    if (!PLANTER_STREETS.test(road.name || '') || road.bridge || road.tunnel) continue;
    const pts = road.pts, hid = road.id | 0;
    let acc = 0;
    for (let i = 0; i + 1 < pts.length; i++) {
      const [ax, az] = pts[i], [bx, bz] = pts[i + 1], L = Math.hypot(bx - ax, bz - az);
      if (L < 1e-6) continue;
      const ux = (bx - ax) / L, uz = (bz - az) / L;
      // 道の向きによらず西寄り（x の小さい側）
      const sx = -uz < 0 ? -1 : 1, nx = -uz * sx, nz = ux * sx;
      for (const { s } of slotsAlong(acc + 6, acc + L - 6, PLANTER_STEP, hash01(hid, 95) * PLANTER_STEP)) {
        const t = s - acc, x = ax + ux * t + nx * 2.2, z = az + uz * t + nz * 2.2;
        if (!inClip(x, z) || ctx.nearJunction(x, z, 6) || !clear(x, z, 1.6)) continue;
        out.planters.push({ x, z, y: heightAt(x, z), a: yaw(ux, uz), type: 'low' });
        take(x, z, 1.6);
        boxC(x, z, ux, uz, 1.5, 0.7);
      }
      acc += L;
    }
  }

  // ---- 広場: 旧市街の広場の縁に黒い燭台形の街灯（Capitole の広場は別）、ごみ箱を 2〜4 個
  const terrace = (p, ok) => {
    if (!ok(p.x, p.z, 2.1)) return;
    out.terraces.push({ x: p.x, z: p.z, y: heightAt(p.x, p.z), a: yaw(p.ux, p.uz) });
    take(p.x, p.z, 2.1);
    boxC(p.x, p.z, p.ux, p.uz, 1.45, 1.45);
  };
  for (const a of ctx.plazas) {
    const b = a.bounds;
    if (b.maxX < clip.minX || b.minX > clip.maxX || b.maxZ < clip.minZ || b.minZ > clip.maxZ) continue;
    const hid = a.id | 0;
    const ok = (x, z, r) => inClip(x, z) && pointInPolygon(x, z, a) && !onRoad(x, z, 0.8) && clear(x, z, r);
    if (/Capitole/i.test(a.name)) {
      // 広場の中を通る歩行者の道（データの道）は走れる道でも小物を置いてよい。車道（と縁から 1 m）だけ避ける
      const okC = (x, z, r) => inClip(x, z) && pointInPolygon(x, z, a) && !(ctx.nearestCar(x, z, 12)?.edge < r + 1) && clear(x, z, r);
      // Place du Capitole（ユーザーの写真 19）: 灰色の高い 5 灯の街灯を縁から 6 m 内側に 12 本。東（キャピトルの正面）の縁はあける
      const per = polylineLength([...a.outer, a.outer[0]]);
      for (const p of ringSamples(a.outer, per / 12, 6, hash01(hid, 93) * per / 12)) {
        if (p.nx < -0.7 || !okC(p.x, p.z, 0.8)) continue;
        out.candelabra.push({ x: p.x, z: p.z, y: heightAt(p.x, p.z), a: yaw(p.ux, p.uz), type: 'capitole' });
        take(p.x, p.z, 0.6);
        circle(p.x, p.z, 0.2);
      }
      // カフェのテラス: 西と南の縁（アーケードの前。縁の車道の外）から 7.5 m 内側に 9 m おき
      for (const p of ringSamples(a.outer, 9, 7.5, 3)) if (p.nx > 0.7 || p.nz < -0.7) terrace(p, okC);
      // 利用者の写真（Street View・NCM_0097）: 縁の道と広場の境に、ばら色がかった灰色の花崗岩の角石（0.55 m 角）と長い石の
      // ベンチ、円柱の車止めを約 1.9 m おきに並べる（約 20 m ごとに 4 m の切れ目）。キャピトルの正面の側はあける
      for (const p of ringSamples(a.outer, 1.9, 3, 0.5)) {
        if (p.nx < -0.7 || p.i % 11 >= 9 || !okC(p.x, p.z, 0.5)) continue;
        const k = p.i % 11, y = heightAt(p.x, p.z), ang = yaw(p.ux, p.uz);
        if (k % 3 === 2) out.bollards.push({ x: p.x, z: p.z, y, type: 'granite', a: ang });
        else out.blocks.push({ x: p.x, z: p.z, y, a: ang, type: k === 4 ? 'bench' : 'cube' });
        take(p.x, p.z, 0.5);
        if (k === 4) boxC(p.x, p.z, p.ux, p.uz, 0.62, 0.27);
        else circle(p.x, p.z, k % 3 === 2 ? 0.15 : 0.32);
      }
      // 南の縁（テラスの前）: 暗い灰緑色の大きな植木箱（1.6 m 角・高さ 1.3 m、常緑の丸い木）を 6 m おき
      for (const p of ringSamples(a.outer, 6, 12, 2)) {
        if (!(p.nz < -0.7) || !okC(p.x, p.z, 1.1)) continue;
        out.planters.push({ x: p.x, z: p.z, y: heightAt(p.x, p.z), a: yaw(p.ux, p.uz) });
        take(p.x, p.z, 1.1);
        boxC(p.x, p.z, p.ux, p.uz, 0.8, 0.8);
      }
      continue;
    }
    if (/Wilson/i.test(a.name)) for (const p of ringSamples(a.outer, 13, 3.5, 4)) if (hash01(hid + p.i, 94) < 0.6) terrace(p, ok);
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
      if (ends.some(([x, z]) => onRoad(x, z, 0.3) || solid(x, z)) || near(st.x, st.z, 1.4) || onLane(st.x, st.z)) continue;
      const nx = -st.uz * CAR_W / 2, nz = st.ux * CAR_W / 2;
      if ([[1, 1], [1, -1], [-1, 1], [-1, -1]].some(([u, v]) => heightAt(st.x + hx * u + nx * v, st.z + hz * u + nz * v) > 0.02)) continue;
      const sl = 0.93 + hash01(h, 82) * 0.12;
      out.cars.push({ x: st.x, z: st.z, y: 0, a: yaw(st.ux, st.uz), sx: sl, sy: 0.94 + hash01(h, 83) * 0.16, color: carColor(hash01(h, 84)) });
      boxC(st.x, st.z, st.ux, st.uz, (CAR_L / 2) * sl, CAR_W / 2);
    }
  }

  // ---- 河岸の下の遊歩道の街灯（利用者の写真 NCM_0125・0138・0174: ラ・ドラードから Saint-Pierre までの下の段の遊歩道に
  // 街灯が並ぶ）。道の陸の側（岸壁の足元）に PROMENADE_STEP m ごと
  for (const r of ctx.promenades) {
    let next = hash01(r.id | 0, 61) * PROMENADE_STEP, s0 = 0;
    for (let i = 0; i + 1 < r.pts.length; i++) {
      const [ax, az] = r.pts[i], [bx, bz] = r.pts[i + 1], L = Math.hypot(bx - ax, bz - az);
      const ux = (bx - ax) / (L || 1), uz = (bz - az) / (L || 1);
      for (; next < s0 + L; next += PROMENADE_STEP) {
        const t = next - s0;
        const cx = ax + ux * t, cz = az + uz * t;
        // 陸の側: 6 m 先が水（solid）でない側
        const sd = !solid(cx - uz * 6, cz + ux * 6) ? 1 : !solid(cx + uz * 6, cz - ux * 6) ? -1 : 0;
        if (!sd) continue;
        const off = r.width / 2 + 0.4, x = cx - uz * off * sd, z = cz + ux * off * sd;
        if (!inClip(x, z) || !clear(x, z, 0.6) || onRoad(x, z, 0.2)) continue;
        out.lights.push({ x, z, y: heightAt(x, z), a: yaw(uz * sd, -ux * sd), type: 'swan' });
        take(x, z, 0.4);
        circle(x, z, 0.12);
      }
      s0 += L;
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

// 法線を形から求める凸多角形の面（hint の向きの側を表に）
function faceAuto(w, pts, hint, color, paint = 0) {
  let nx = 0, ny = 0, nz = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    nx += (a[1] - b[1]) * (a[2] + b[2]);
    ny += (a[2] - b[2]) * (a[0] + b[0]);
    nz += (a[0] - b[0]) * (a[1] + b[1]);
  }
  const L = Math.hypot(nx, ny, nz) || 1;
  const sg = nx * hint[0] + ny * hint[1] + nz * hint[2] < 0 ? -1 : 1;
  face(w, pts, [(sg * nx) / L, (sg * ny) / L, (sg * nz) / L], color, paint);
}

// 乗用車（長さ 4.2・幅 1.8・高さ 1.45 m、前が +x）: 車体・上ほど細い客室（傾いた前後の窓、紺がかった暗いガラス、
// 車体の色の柱と屋根）・少し暗いバンパー・車輪・前照灯と尾灯（約 150 三角形）。ユーザーの写真 1〜3・27
export function carGeometry() {
  const w = new MeshWriter();
  const paint = [1, 1, 1], dark = [0.72, 0.72, 0.72], glass = rgb('#2b3640'), tyre = rgb('#181818'), hub = rgb('#3a3c3e');
  const body = [[-2.1, 0.26], [2.1, 0.26], [2.12, 0.6], [2.02, 0.8], [0.95, 0.93], [-1.85, 0.96], [-2.08, 0.86]];
  extrude(w, body, 0.89, paint, 1, (i) => (i === 0 ? null : { color: paint, paint: 1 }));
  box(w, 2.02, 0.24, -0.86, 2.13, 0.5, 0.86, dark, { paint: 1 }); // 前のバンパー
  box(w, -2.13, 0.24, -0.86, -2.02, 0.52, 0.86, dark, { paint: 1 }); // 後ろのバンパー
  // 客室: 下（窓の下の線、y 0.94）は x -1.8〜0.9・幅 ±0.84、上（屋根、y 1.42）は x -1.25〜0.05・幅 ±0.68
  const yb = 0.94, yt = 1.42;
  const S = (t, v, s) => [-1.8 + 2.7 * t + (0.55 - 1.4 * t) * v, yb + (yt - yb) * v, s * (0.84 - 0.16 * v)];
  for (const s of [1, -1]) {
    // 横の窓: 後ろの柱（C）・窓・中の柱（B）・窓・前の柱（A）
    const cuts = [[0, 0.12, 1], [0.12, 0.47, 0], [0.47, 0.53, 1], [0.53, 0.93, 0], [0.93, 1, 1]];
    for (const [t0, t1, pt] of cuts) faceAuto(w, [S(t0, 0, s), S(t1, 0, s), S(t1, 1, s), S(t0, 1, s)], [0, 0, s], pt ? paint : glass, pt);
  }
  faceAuto(w, [S(1, 0, 1), S(1, 0, -1), S(1, 1, -1), S(1, 1, 1)], [1, 0.5, 0], glass); // 前の窓
  faceAuto(w, [S(0, 0, 1), S(0, 0, -1), S(0, 1, -1), S(0, 1, 1)], [-1, 0.5, 0], glass); // 後ろの窓
  faceAuto(w, [S(0, 1, 1), S(1, 1, 1), S(1, 1, -1), S(0, 1, -1)], [0, 1, 0], paint, 1); // 屋根
  for (const x of [-1.38, 1.38]) for (const s of [1, -1]) wheel(w, x, s * 0.66, s * 0.92, 0.31, tyre, hub);
  const lamp = rgb('#e8e6dc'), tail = rgb('#8a1414');
  for (const s of [1, -1]) {
    face(w, [[2.13, 0.52, s * 0.5], [2.13, 0.52, s * 0.82], [2.13, 0.64, s * 0.82], [2.13, 0.64, s * 0.5]], [1, 0, 0], lamp);
    face(w, [[-2.1, 0.66, s * 0.55], [-2.1, 0.66, s * 0.85], [-2.1, 0.79, s * 0.85], [-2.1, 0.79, s * 0.55]], [-1, 0, 0], tail);
  }
  return toGeometry(w);
}

// 2 点を結ぶ角棒（半幅 r）
function bar(w, p, q, r, color) {
  const d = [q[0] - p[0], q[1] - p[1], q[2] - p[2]], L = Math.hypot(...d) || 1;
  const t = d.map((v) => v / L);
  let a = [t[2], 0, -t[0]];
  if (Math.hypot(a[0], a[2]) < 1e-3) a = [1, 0, 0];
  const al = Math.hypot(...a);
  a = a.map((v) => v / al);
  const b = [t[1] * a[2] - t[2] * a[1], t[2] * a[0] - t[0] * a[2], t[0] * a[1] - t[1] * a[0]];
  const V = (o, i, j) => [o[0] + (a[0] * i + b[0] * j) * r, o[1] + (a[1] * i + b[1] * j) * r, o[2] + (a[2] * i + b[2] * j) * r];
  for (const [i0, j0, i1, j1, n] of [[1, -1, 1, 1, a], [-1, 1, -1, -1, a.map((v) => -v)], [1, 1, -1, 1, b], [-1, -1, 1, -1, b.map((v) => -v)]]) {
    w.quad(V(p, i0, j0), V(q, i0, j0), V(q, i1, j1), V(p, i1, j1), n, [0, 0], [0, 0], [0, 0], [0, 0], color);
  }
}

// 白鳥の首の街灯（高さ約 6.5 m、灰緑の柱、+x の車道の方へ曲がった腕の先に吊り下げの灯具）。写真 8・10、ポン・ヌフ（bridges.js）と同じ形
export function swanLampGeometry() {
  const w = new MeshWriter();
  const green = rgb('#55625c'), glass = rgb('#e8e4d6');
  column(w, 0, 0, 0.13, 0.11, 0, 0.7, 8, green, { top: green });
  column(w, 0, 0, 0.08, 0.055, 0.7, 6.3, 6, green);
  const arm = [[0, 6.2], [0.12, 6.65], [0.42, 6.92], [0.85, 6.98], [1.22, 6.85]];
  for (let k = 0; k + 1 < arm.length; k++) bar(w, [arm[k][0], arm[k][1], 0], [arm[k + 1][0], arm[k + 1][1], 0], 0.035, green);
  const [hx, hy] = arm[arm.length - 1];
  box(w, hx - 0.02, hy - 0.18, -0.02, hx + 0.02, hy, 0.02, green);
  box(w, hx - 0.19, hy - 0.3, -0.19, hx + 0.19, hy - 0.18, 0.19, green);
  box(w, hx - 0.14, hy - 0.72, -0.14, hx + 0.14, hy - 0.3, 0.14, glass, { bottom: glass });
  return toGeometry(w);
}

// 大通りの細い鋼の高い街灯（約 9 m、+x の車道の方へ上向きに傾いた腕 1.5 m と平たい灯具）。写真 26（Jean Jaurès）
export function mastLampGeometry() {
  const w = new MeshWriter();
  const steel = rgb('#9aa0a4'), head = rgb('#6d7377'), lens = rgb('#e6e3da');
  column(w, 0, 0, 0.12, 0.1, 0, 0.5, 8, steel, { top: steel });
  column(w, 0, 0, 0.09, 0.05, 0.5, 9.0, 6, steel);
  bar(w, [0, 8.9, 0], [1.45, 9.3, 0], 0.035, steel);
  box(w, 1.2, 9.22, -0.13, 1.95, 9.34, 0.13, head, { bottom: lens });
  return toGeometry(w);
}

// 黒い細い車止め（potelet、9 cm 角・高さ 1 m、頭に白い帯）。写真 7・8・27
export function poteletGeometry() {
  const w = new MeshWriter();
  const black = rgb('#262928'), band = rgb('#d8d8d2');
  box(w, -0.045, 0, -0.045, 0.045, 0.86, 0.045, black);
  box(w, -0.046, 0.86, -0.046, 0.046, 0.92, 0.046, band);
  box(w, -0.045, 0.92, -0.045, 0.045, 1.0, 0.045, black);
  return toGeometry(w);
}

// Place du Capitole の燭台形の街灯（利用者の写真・Street View）: 暗い灰青色の鋳鉄（#4a5058）、高さ約 9.5 m、
// 溝の付いた柱に 4 本の腕と頂上の、六角形のパリ風の角灯 5 つ（ガラスと尖った冠）
export function capitoleLampGeometry() {
  const w = new MeshWriter();
  const iron = rgb('#4a5058'), glass = rgb('#ece6d4');
  column(w, 0, 0, 0.3, 0.22, 0, 1.2, 8, iron, { top: iron });
  column(w, 0, 0, 0.16, 0.12, 1.2, 1.5, 8, iron, { top: iron });
  column(w, 0, 0, 0.11, 0.08, 1.5, 8.3, 8, iron);
  for (const [ux, uz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    // 腕（上の横木と、下の短い支え）
    const arm = (L, y0, y1) => box(w, ux ? Math.min(0, ux * L) : -0.03, y0, uz ? Math.min(0, uz * L) : -0.03, ux ? Math.max(0, ux * L) : 0.03, y1, uz ? Math.max(0, uz * L) : 0.03, iron);
    arm(0.95, 7.38, 7.46);
    arm(0.45, 7.0, 7.05);
  }
  const lantern = (x, y, z) => {
    column(w, x, z, 0.06, 0.1, y, y + 0.12, 6, iron, { bottom: iron });
    column(w, x, z, 0.13, 0.19, y + 0.12, y + 0.62, 6, glass);
    column(w, x, z, 0.23, 0.05, y + 0.62, y + 0.86, 6, iron, { bottom: iron });
    column(w, x, z, 0.03, 0, y + 0.86, y + 1.0, 4, iron);
  };
  for (const [x, z] of [[0.95, 0], [-0.95, 0], [0, 0.95], [0, -0.95]]) lantern(x, 7.46, z);
  lantern(0, 8.3, 0);
  return toGeometry(w);
}

// キャピトル広場の縁の花崗岩の角石（0.55 m 角・高さ 0.45 m）と長い石のベンチ（1.25 × 0.5 m）。ばら色がかった灰色
export function graniteBlockGeometry(long = false) {
  const w = new MeshWriter();
  const g = rgb('#a2958f'), top = rgb('#b3a7a1');
  const hx = long ? 0.62 : 0.275, hz = long ? 0.25 : 0.275;
  box(w, -hx, 0, -hz, hx, 0.45, hz, g, { top });
  return toGeometry(w);
}

// 低い植え込みの箱（3 × 1.4 m・高さ 0.5 m、暗い灰色）に低木と小さな常緑の木（高さ約 5 m）。x 軸が箱の長い向き
export function lowPlanterGeometry() {
  const w = new MeshWriter();
  const boxCol = rgb('#4a4d4f'), soil = rgb('#3a2e24'), shrub = rgb('#3d4a26'), bark = rgb('#5a524a'), leaf = rgb('#3f4b22');
  box(w, -1.5, 0, -0.7, 1.5, 0.5, 0.7, boxCol, { top: soil });
  for (const x of [-1.0, 1.0]) {
    const prof = [[0.2, 0], [0.5, 0.15], [0.55, 0.4], [0.35, 0.65], [0, 0.75]];
    for (let k = 0; k + 1 < prof.length; k++) column(w, x, 0, prof[k][0], prof[k + 1][0], 0.5 + prof[k][1], 0.5 + prof[k + 1][1], 7, shrub, { bottom: k === 0 ? shrub : null });
  }
  column(w, 0, 0, 0.08, 0.06, 0.5, 2.6, 5, bark);
  const prof = [[0.4, 0], [1.3, 0.5], [1.5, 1.3], [1.2, 2.1], [0.6, 2.6], [0, 2.8]];
  for (let k = 0; k + 1 < prof.length; k++) column(w, 0, 0, prof[k][0], prof[k + 1][0], 2.1 + prof[k][1], 2.1 + prof[k + 1][1], 9, leaf, { bottom: k === 0 ? leaf : null });
  return toGeometry(w);
}

// 暗い灰緑色の大きな植木箱（1.6 m 角・高さ 1.3 m）に、刈り込んだ常緑の丸い木（幹 1 m・樹冠の直径約 1.8 m）
export function planterGeometry() {
  const w = new MeshWriter();
  const boxCol = rgb('#3c4644'), rim = rgb('#4a5452'), soil = rgb('#3a2e24'), bark = rgb('#4a3f36'), leaf = rgb('#344a2c');
  box(w, -0.8, 0, -0.8, 0.8, 1.25, 0.8, boxCol, { top: soil });
  for (const [x0, z0, x1, z1] of [[-0.82, -0.82, 0.82, -0.7], [-0.82, 0.7, 0.82, 0.82], [-0.82, -0.7, -0.7, 0.7], [0.7, -0.7, 0.82, 0.7]]) box(w, x0, 1.25, z0, x1, 1.32, z1, rim);
  column(w, 0, 0, 0.07, 0.06, 1.25, 2.4, 5, bark);
  const prof = [[0.2, 0], [0.75, 0.25], [0.95, 0.75], [0.85, 1.25], [0.5, 1.6], [0, 1.75]];
  for (let k = 0; k + 1 < prof.length; k++) column(w, 0, 0, prof[k][0], prof[k + 1][0], 2.2 + prof[k][1], 2.2 + prof[k + 1][1], 9, leaf, { bottom: k === 0 ? leaf : null });
  return toGeometry(w);
}

// カフェのテラス（3 × 3 m）: 真ん中に白い四角のパラソル（高さ 2.4 m）、テーブル 2 つ、椅子 4 つ。写真 13・19・22
export function terraceGeometry() {
  const w = new MeshWriter();
  const white = rgb('#f2f0ea'), pole = rgb('#8c8c88'), table = rgb('#3a3b3c'), chair = rgb('#8a6b4c');
  column(w, 0, 0, 0.035, 0.035, 0, 2.75, 4, pole);
  const H = 2.35, A = 2.72, R = 1.5;
  const c = [[R, H, R], [-R, H, R], [-R, H, -R], [R, H, -R]];
  for (let i = 0; i < 4; i++) {
    const p = c[i], q = c[(i + 1) % 4];
    faceAuto(w, [p, q, [0, A, 0]], [p[0] + q[0], 1, p[2] + q[2]], white);
    faceAuto(w, [p, q, [0, A, 0]], [-(p[0] + q[0]), -1, -(p[2] + q[2])], white); // 下から見た面
    faceAuto(w, [p, q, [q[0], H - 0.2, q[2]], [p[0], H - 0.2, p[2]]], [p[0] + q[0], 0, p[2] + q[2]], white); // 垂れ
  }
  for (const tx of [-0.75, 0.75]) {
    column(w, tx, 0, 0.03, 0.03, 0, 0.72, 4, table);
    box(w, tx - 0.33, 0.72, -0.33, tx + 0.33, 0.76, 0.33, table);
    for (const s of [1, -1]) {
      const cz = s * 0.62;
      box(w, tx - 0.21, 0.42, cz - 0.21, tx + 0.21, 0.46, cz + 0.21, chair);
      box(w, tx - 0.21, 0, cz + s * 0.17, tx + 0.21, 0.42, cz + s * 0.21, chair); // 脚の板
      box(w, tx - 0.21, 0.46, cz + s * 0.17, tx + 0.21, 0.86, cz + s * 0.21, chair); // 背もたれ
    }
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
    const mats = new Float32Array(n * 16), xz = new Float32Array(n * 2), ys = new Float32Array(n);
    const cols = items[0].color ? new Float32Array(n * 3) : null;
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), s = new THREE.Vector3(), e = new THREE.Euler(), c = new THREE.Color();
    items.forEach((it, i) => {
      // a: Y 軸まわりの向き、roll: 模型の x 軸（前後）まわりの傾き（歩道に乗り上げた車）
      m.compose(p.set(it.x, it.y || 0, it.z), q.setFromEuler(e.set(it.roll || 0, it.a || 0, it.pitch || 0, 'YXZ')), s.set(it.sx || 1, it.sy || 1, 1));
      m.toArray(mats, i * 16);
      xz[2 * i] = it.x;
      xz[2 * i + 1] = it.z;
      ys[i] = it.y || 0;
      if (cols) c.set(it.color).toArray(cols, i * 3);
    });
    if (cols) mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3);
    mesh.castShadow = shadow;
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    mesh.count = 0;
    mesh.visible = false;
    mesh.boundingSphere = new THREE.Sphere();
    this.parts.push({ mesh, mats, xz, ys, cols, n });
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
      let k = 0, x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      for (let i = 0; i < P.n; i++) {
        const ix = P.xz[2 * i], iz = P.xz[2 * i + 1], dx = ix - x, dz = iz - z;
        if (dx * dx + dz * dz > r2) continue;
        [x0, z0, x1, z1] = [Math.min(x0, ix), Math.min(z0, iz), Math.max(x1, ix), Math.max(z1, iz)];
        y0 = Math.min(y0, P.ys[i]);
        y1 = Math.max(y1, P.ys[i]);
        dst.set(P.mats.subarray(i * 16, i * 16 + 16), k * 16);
        if (dc) dc.set(P.cols.subarray(i * 3, i * 3 + 3), k * 3);
        k++;
      }
      P.mesh.count = k;
      P.mesh.visible = k > 0;
      P.mesh.instanceMatrix.needsUpdate = true;
      if (dc) P.mesh.instanceColor.needsUpdate = true;
      // 描く物をすべて囲む球（視錐台カリング用。小物の大きさの分 12 m 足す）
      // （坂の上下に並ぶ物も囲むように、高さの幅も入れる）
      if (k) P.mesh.boundingSphere.set(P.mesh.boundingSphere.center.set((x0 + x1) / 2, (y0 + y1) / 2 + 5, (z0 + z1) / 2), Math.hypot(x1 - x0, z1 - z0, y1 - y0) / 2 + 12);
    }
  }
}

// 範囲の小物を作り、当たり判定（cw: CollisionWorld）に足す。戻り値の group をシーンに足し、毎フレーム cull(x, z) を呼ぶ
// opts.terrain: 地形（小物を地面の高さに。車は坂に沿って前後に傾ける）
export function buildFurniture(opts, cw = null) {
  const items = planFurniture(opts);
  const T = opts.terrain;
  if (T && !T.flat) {
    for (const [k, list] of Object.entries(items)) {
      if (k === 'colliders') continue;
      for (const it of list) {
        it.y = (it.y || 0) + T.top(it.x, it.z);
        if (k === 'cars') {
          // 模型の x 軸（車の前後）の向きの勾配
          const fx = Math.cos(it.a || 0), fz = -Math.sin(it.a || 0);
          it.pitch = Math.atan((T.h(it.x + fx * 2, it.z + fz * 2) - T.h(it.x - fx * 2, it.z - fz * 2)) / 4);
        }
      }
    }
  }
  const set = new FurnitureSet();
  const mat = furnitureMaterial();
  set.add('cars', carGeometry(), mat, items.cars, { shadow: true });
  const of = (list, type, dflt) => list.filter((it) => (it.type || dflt) === type);
  set.add('lights', lampGeometry(), mat, of(items.lights, 'arm', 'arm'), { shadow: true });
  // 細い街灯（白鳥の首・鋼の柱）とテラスは影を落とさない（影の描画コールを減らす。細くて影はほとんど見えない）
  set.add('swan-lights', swanLampGeometry(), mat, of(items.lights, 'swan', 'arm'));
  set.add('disc-lights', discLampGeometry(), mat, of(items.discs, 'disc', 'disc'), { shadow: true });
  set.add('mast-lights', mastLampGeometry(), mat, of(items.discs, 'mast', 'disc'));
  set.add('candelabra', candelabraGeometry(), mat, of(items.candelabra, 'black', 'black'));
  set.add('capitole-lights', capitoleLampGeometry(), mat, of(items.candelabra, 'capitole', 'black'), { shadow: true });
  set.add('bollards', bollardGeometry(), mat, of(items.bollards, 'granite', 'granite'));
  set.add('granite-blocks', graniteBlockGeometry(), mat, of(items.blocks, 'cube', 'cube'), { shadow: true });
  set.add('granite-benches', graniteBlockGeometry(true), mat, of(items.blocks, 'bench', 'cube'), { shadow: true });
  set.add('planters', planterGeometry(), mat, of(items.planters, 'tall', 'tall'), { shadow: true });
  set.add('low-planters', lowPlanterGeometry(), mat, of(items.planters, 'low', 'tall'), { shadow: true });
  set.add('potelets', poteletGeometry(), mat, of(items.bollards, 'potelet', 'granite'));
  set.add('terraces', terraceGeometry(), mat, items.terraces);
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
