// 通りの断面（写真 street-oldtown・sidewalk-curb を手本に）:
// - 旧市街の細い通り・歩行者の通りは、壁から壁まで約 10 cm の小舗石（pavés）を敷き詰め、2 列の大きめの石の側溝を通す
//   （縁石も車線もない）。車の通れる通りの一部は Rue du Taur 型: 小舗石の車道（3.5〜4 m）の両側に側溝、
//   その外は段差のないばら色の石の板の歩道
// - それ以外の車道は、花崗岩の縁石（幅 20 cm・高さ 13 cm、車道側に立ち上がりの面）と、建物の壁まで一段高い歩道
//   （灰色かえんじ色のアスファルト）。縁石の足元には 2 列の小舗石の側溝。交差点の中では縁石を切る
// - 旧市街の交差点と、幹線道路どうしの交差点（信号のある交差点の代わり）には、横断歩道（幅 50 cm の白い帯）と停止線。
//   横断歩道のところは縁石を下げる。停止線は信号のある交差点の全部の腕と、優先道路に出る格下の腕だけ
// - 歩道は広場・緑地・駐車場（地面に平らに描く面）と線路の手前で止める（一段高い歩道で隠さない）
//
// 通りの種類・交差点・横断歩道の位置はエリアで 1 回だけ決め（planStreets）、形はタイル（範囲 clip）ごとに作る。
// 断面は道全体で同じ位置に置き（ANCHOR m ごとに必ず残す）、タイルの外へ少し延ばして計算してから範囲で切るので、
// 隣のタイルとは境目で同じ形になる。
import { CAR_ROADS } from './parse.js';
import { Grid, clipPolylineToRect, clipRingToRect, closestOnSegment, hash01, pointInPolygon, signedArea } from '../geo.js';

export const CURB_H = 0.13; // 縁石（一段高い歩道）の高さ
export const CURB_W = 0.2; // 縁石の幅
const LOW_H = 0.03; // 横断歩道で下げた縁石の高さ
const SIDEWALK_MAX = 8; // 歩道を壁まで延ばす最大の幅
const SIDEWALK_DEFAULT = 2.5; // 近くに壁がないときの歩道の幅
const GUTTER_W = 0.32; // 側溝（2 列の石）の幅
const STEP = 2.5; // 断面を調べる間隔（m）
const TOL = 0.3; // 歩道の幅の変化をまとめる許容差（m）
const OVERSHOOT = 0.3; // 壁の中まで少し延ばして、壁際のすき間を見せない
const SHARED_EXTRA = 6; // 旧市街の通りの石畳を、車道の外へ延ばす最大の幅
const SETT_TILE = 2.56; // 小舗石のテクスチャ 1 枚の大きさ（m）
const SLAB_TILE = 2.4;
const PROBE = 1.5; // 歩道の外の端を横へ調べる間隔（m）。境目は二分法で詰める
const RAIL_HALF = 1.5; // 線路（1 本の軌道）の中心からこの幅には歩道を敷かない
const ANCHOR = 20; // 道の始点からこの間隔ごとに断面を必ず残す（タイルの境の両側で同じ間引きになる）
const SEAM_PAD = 50; // 範囲の外へ延ばして断面を計算する長さ（ANCHOR ＋ 壁のすき間をつなぐ 30 m）
const STS_CACHE = 3000; // ステーションを覚えておく道の数の上限
const CENTRE_R = 1300; // 車止めを立てる中心部（原点＝Pont Neuf からの距離。旧市街の外の Saint-Cyprien・Château d'eau も）
const MAIN = new Set(['trunk', 'primary', 'secondary', 'tertiary', 'trunk_link', 'primary_link', 'secondary_link', 'tertiary_link']);
// 道の格（停止線は格の高い道に出る腕に引く）
const RANK = { trunk: 5, trunk_link: 5, primary: 4, primary_link: 4, secondary: 3, secondary_link: 3, tertiary: 2, tertiary_link: 2 };
const rankOf = (road) => RANK[road.type] || 1;
const OLD_MINOR = new Set(['residential', 'unclassified', 'living_street', 'pedestrian', 'service', 'road', 'tertiary']);
// 歩道を切る「ほかの道路」（車道・歩行者の通り・橋）。歩道・自転車道・小道は歩道の下に入ってよい
const NEAR_TYPES = new Set([...CAR_ROADS, 'pedestrian', 'living_street', 'service']);

const strHash = (s) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
};

// 通りの種類: shared（旧市街の石畳の共有空間）/ taur（小舗石の車道＋石の板の歩道）/ curb（縁石と一段高い歩道）/
// bridge（橋。歩道は作らないが、ほかの歩道を切る）/ plain（それ以外: 歩道なしの車道・歩行者の通り・小道）
export function classifyStreet(road, old) {
  const t = road.type;
  const car = CAR_ROADS.has(t);
  const h = strHash(road.name || `#${road.id}`);
  const near = NEAR_TYPES.has(t) || road.bridge;
  if (road.bridge) return { kind: 'bridge', band: road.width / 2 + (car ? 2 : 0.3), near };
  if (old && (t === 'pedestrian' || t === 'living_street') && road.width > 6.5) {
    // 旧市街の広い歩行者の通り（Rue d'Alsace-Lorraine・Rue de la Pomme の広い所）: 壁から壁まで段差のない石の板、
    // 真ん中に 2 列の石の側溝
    return { kind: 'shared', slabs: true, band: road.width / 2 + 1.2, gutter: 0, near };
  }
  if (old && OLD_MINOR.has(t) && road.width <= (t === 'tertiary' ? 5 : 6.5)) {
    // 旧市街の細い通り（IGN の幅は車道だけなので、壁から壁は広い）。車の通れる通りの 3 割は Rue du Taur 型
    const taur = t !== 'pedestrian' && (/^Rue du Taur$/i.test(road.name) || hash01(h, 31) < 0.3);
    // 側溝: 歩行者の通りは真ん中、ほかは半分が真ん中、半分は片側の壁寄り（幅の 1/3 あたり）
    const gutter = t === 'pedestrian' || t === 'living_street' || hash01(h, 32) < 0.5 ? 0 : (hash01(h, 33) < 0.5 ? -0.9 : 0.9);
    return { kind: taur ? 'taur' : 'shared', band: Math.max(road.width / 2 + 1.2, 3), gutter, near };
  }
  if (car && road.sidewalk !== 'no' && road.sidewalk !== 'none') {
    // 歩道の舗装: 中心部はえんじ色（赤茶）の舗装が多く、外は灰色のアスファルトが多い（通りの両側で違うこともある）
    const p = old ? 0.55 : 0.2;
    // 縁石の足元の 2 列の小舗石の側溝は、中心部と幹線道路だけ（郊外の住宅街はアスファルトのまま）
    return { kind: 'curb', band: road.width / 2, red: [hash01(h, 34) < p, hash01(h, 35) < p], gutter: old || MAIN.has(t), near };
  }
  return { kind: 'plain', band: road.width / 2, near };
}

// 頂点を 10 cm 単位で束ねる数の鍵（文字列より速い。±50 km まで）
const keyOf = (p) => (Math.round(p[0] * 10) + 500000) * 1000003 + Math.round(p[1] * 10) + 500000;

// 折れ線の頂点ごとの累積の長さ
function cumulative(pts) {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  return cum;
}

// 道 road の頂点 i から向き dir（+1 / -1）へ d m 進んだ点と、その向き（i から離れる向き）
function alongFrom(pts, i, dir, d) {
  let left = d;
  for (let k = i; k + dir >= 0 && k + dir < pts.length; k += dir) {
    const a = pts[k], b = pts[k + dir];
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (L < 1e-6) continue;
    const ux = (b[0] - a[0]) / L, uz = (b[1] - a[1]) / L;
    if (left <= L || k + 2 * dir < 0 || k + 2 * dir >= pts.length) return { x: a[0] + ux * left, z: a[1] + uz * left, ux, uz };
    left -= L;
  }
  return null;
}

// エリア全体の計画（parsed ごとに 1 回）: 通りの種類、交差点（同じ点を通る道）、続きの道、横断歩道と停止線
const plans = new WeakMap();
const notOld = () => false;
export function planStreets(parsed, inOld = notOld) {
  let plan = plans.get(parsed);
  if (plan && plan.inOld === inOld) return plan;
  const info = new Map();
  for (const road of parsed.roads) {
    if (road.tunnel || road.pts.length < 2) continue;
    const mid = road.pts[road.pts.length >> 1];
    const inf = classifyStreet(road, inOld(mid[0], mid[1]));
    inf.cum = cumulative(road.pts);
    inf.cont = new Set();
    info.set(road, inf);
  }
  // 交差点: 道の頂点を座標で束ねる
  const nodes = new Map();
  for (const [road, inf] of info) {
    if (!inf.near) continue;
    const pts = road.pts, last = pts.length - 1;
    for (let i = 0; i <= last; i++) {
      const k = keyOf(pts[i]);
      let n = nodes.get(k);
      if (!n) nodes.set(k, (n = { x: pts[i][0], z: pts[i][1], arms: [] }));
      for (const dir of [-1, 1]) {
        const j = i + dir;
        if (j < 0 || j > last) continue;
        const L = Math.hypot(pts[j][0] - pts[i][0], pts[j][1] - pts[i][1]) || 1;
        n.arms.push({
          road, i, dir, end: i === 0 || i === last,
          ux: (pts[j][0] - pts[i][0]) / L, uz: (pts[j][1] - pts[i][1]) / L,
          len: dir > 0 ? inf.cum[last] - inf.cum[i] : inf.cum[i],
        });
      }
    }
  }
  const junctions = [];
  for (const n of nodes.values()) {
    const roads = new Set(n.arms.map((a) => a.road));
    if (roads.size < 2) continue;
    junctions.push(n);
    // ほぼまっすぐつながる道どうし（140° 以上）は「続きの道」。互いの歩道を切らない
    for (const a of n.arms) {
      for (const b of n.arms) {
        if (a.road === b.road || !a.end || !b.end) continue;
        if (a.ux * b.ux + a.uz * b.uz < -0.766) info.get(a.road).cont.add(b.road);
      }
    }
  }
  // 横断歩道: 旧市街の交差点と、2 本の幹線道路が交わる交差点（信号のある交差点の代わり）で、縁石のある車道を横切る。
  // 交差する道の端から約 1.2 m あけて置く。郊外の住宅街の交差点には引かない
  const crossings = [];
  const sameStreet = (a, b) => a.road === b.road || info.get(a.road).cont.has(b.road) || (a.road.name && a.road.name === b.road.name);
  for (const n of junctions) {
    if (n.arms.length < 3) continue;
    const old = inOld(n.x, n.z);
    const mains = n.arms.filter((a) => MAIN.has(a.road.type));
    const lights = mains.some((a) => mains.some((b) => !sameStreet(a, b)));
    if (!lights && !old) continue;
    const top = Math.max(...n.arms.map((a) => rankOf(a.road)));
    const centre = old || Math.hypot(n.x, n.z) < CENTRE_R;
    for (const a of n.arms) {
      const ia = info.get(a.road);
      if (ia.kind !== 'curb' || a.road.width < 3.5) continue;
      let reach = 0;
      for (const b of n.arms) if (b.road !== a.road && !ia.cont.has(b.road)) reach = Math.max(reach, info.get(b.road).band);
      if (!reach) continue;
      const len = MAIN.has(a.road.type) ? 4 : 3;
      const d = reach + CURB_W + 1.2 + len / 2;
      if (a.len < d + len / 2 + 4) continue;
      const c = alongFrom(a.road.pts, a.i, a.dir, d);
      if (!c) continue;
      // 停止線は交差点へ向かう車線（右側通行）。一方通行は道の向き（頂点の順）に走る車だけ。
      // 信号のある交差点の腕と、格の高い道（優先道路）に出る腕だけ（優先道路の側には引かない）
      let stop = null;
      if (lights || (mains.length && rankOf(a.road) < top)) stop = !a.road.oneway ? 'half' : a.dir < 0 ? 'full' : null;
      // 車止め: 中心部の横断歩道の 4 つの角のうち、約 6 割（ビット k = 角 k）
      let posts = 0;
      if (centre) {
        const hp = strHash(`${Math.round(c.x * 10)},${Math.round(c.z * 10)}`);
        for (let k = 0; k < 4; k++) if (hash01(hp, 40 + k) < 0.6) posts |= 1 << k;
      }
      crossings.push({ road: a.road, ...c, half: a.road.width / 2, len, stop, posts });
    }
  }
  // 縁石を下げる点（横断歩道の両端の縁石の上）
  const ramps = [];
  const rampGrid = new Grid(16);
  for (const c of crossings) {
    const nx = -c.uz, nz = c.ux;
    for (const s of [1, -1]) {
      const r = { x: c.x + nx * s * (c.half + CURB_W / 2), z: c.z + nz * s * (c.half + CURB_W / 2), r0: c.len / 2 + 0.3, r1: c.len / 2 + 1.8 };
      rampGrid.insertPoint(r.x, r.z, ramps.length);
      ramps.push(r);
    }
  }
  const curbHeight = (x, z) => {
    let h = CURB_H;
    rampGrid.queryPoint(x, z, 4, (k) => {
      const r = ramps[k];
      const d = Math.hypot(x - r.x, z - r.z);
      if (d >= r.r1) return;
      const t = Math.max(0, (d - r.r0) / (r.r1 - r.r0));
      h = Math.min(h, LOW_H + (CURB_H - LOW_H) * t * t * (3 - 2 * t));
    });
    return h;
  };
  // 道を 100 m のマスで引けるように（タイルの近くの道だけを見る）
  const roadGrid = new Grid(100);
  const roadList = [...info.keys()];
  roadList.forEach((road, k) => {
    const b = (info.get(road).bounds = boundsOf(road));
    roadGrid.insertBounds(b.minX, b.minZ, b.maxX, b.maxZ, k);
  });
  const roadsNear = (clip, pad) => {
    const set = new Set();
    roadGrid.query(clip.minX - pad, clip.minZ - pad, clip.maxX + pad, clip.maxZ + pad, (k) => set.add(roadList[k]));
    return roadList.filter((r) => set.has(r)); // 元の順番のまま（作る順が変わらないように）
  };
  plan = { inOld, info, junctions, crossings, ramps, rampGrid, curbHeight, roadsNear };
  plans.set(parsed, plan);
  return plan;
}

// ---------------------------------------------------------------- 壁・ほかの道路・水までの距離
// 建物の外形の辺（外向きの法線つき）と塀を索引にし、点から向きへの半直線が最初に当たる所を探す
export function makeObstacles(buildings, walls = []) {
  const grid = new Grid(10);
  const segs = [];
  const addRing = (ring, sign) => {
    const s = (signedArea(ring) > 0 ? 1 : -1) * sign;
    for (let i = 0; i < ring.length; i++) {
      const p = ring[i], q = ring[(i + 1) % ring.length];
      const dx = q[0] - p[0], dz = q[1] - p[1];
      const L = Math.hypot(dx, dz);
      if (L < 0.05) continue;
      grid.insertSegment(p[0], p[1], q[0], q[1], segs.length);
      segs.push([p[0], p[1], q[0], q[1], (dz / L) * s, (-dx / L) * s]);
    }
  };
  for (const b of buildings) {
    addRing(b.outer, 1);
    for (const h of b.holes || []) addRing(h, -1);
  }
  for (const [ax, az, bx, bz] of walls) {
    grid.insertSegment(ax, az, bx, bz, segs.length);
    segs.push([ax, az, bx, bz, 0, 0]);
  }
  // (px, pz) から (dx, dz)（単位ベクトル）へ tMax m までで最初に当たる壁。{ t, inside }（inside: 建物の中から出た）
  const seen = new Uint32Array(segs.length);
  let stamp = 0;
  const ray = (px, pz, dx, dz, tMax) => {
    let best = tMax, inside = false, hit = false;
    const ex = px + dx * tMax, ez = pz + dz * tMax;
    stamp++;
    grid.query(Math.min(px, ex), Math.min(pz, ez), Math.max(px, ex), Math.max(pz, ez), (k) => {
      if (seen[k] === stamp) return;
      seen[k] = stamp;
      const [ax, az, bx, bz, ox, oz] = segs[k];
      const sx = bx - ax, sz = bz - az;
      const den = dx * sz - dz * sx;
      if (Math.abs(den) < 1e-9) return;
      const wx = ax - px, wz = az - pz;
      const t = (wx * sz - wz * sx) / den;
      const u = (wx * dz - wz * dx) / den;
      if (t < 0 || t >= best || u < 0 || u > 1) return;
      best = t;
      hit = true;
      inside = ox * dx + oz * dz > 0.05;
    });
    return hit ? { t: best, inside } : null;
  };
  return { ray, count: segs.length };
}

// 範囲 clip のまわりの道路（歩道を切る相手）の索引
const MAX_MARGIN = CURB_W + 0.05;
// 範囲の外で調べる幅: 境の外で計算する断面（SEAM_PAD + ANCHOR）と、その横の歩道の幅まで
const INDEX_PAD = SEAM_PAD + ANCHOR + 40;
function makeRoadIndex(parsed, plan, clip, pad = INDEX_PAD) {
  // 帯の幅だけ広げた範囲で索引にして、点の問い合わせは 1 マスだけ見る
  const grid = new Grid(8);
  const segs = [];
  for (const road of plan.roadsNear(clip, pad)) {
    const inf = plan.info.get(road);
    if (!inf.near) continue;
    const pts = road.pts;
    const r = inf.band + MAX_MARGIN;
    for (let i = 0; i + 1 < pts.length; i++) {
      const [ax, az] = pts[i], [bx, bz] = pts[i + 1];
      if (Math.max(ax, bx) < clip.minX - pad || Math.min(ax, bx) > clip.maxX + pad || Math.max(az, bz) < clip.minZ - pad || Math.min(az, bz) > clip.maxZ + pad) continue;
      grid.insertBounds(Math.min(ax, bx) - r, Math.min(az, bz) - r, Math.max(ax, bx) + r, Math.max(az, bz) + r, segs.length);
      segs.push({ ax, az, bx, bz, road, band: inf.band });
    }
  }
  // (x, z) がほかの道路（続きの道を除く）の帯（片側 band + margin）の中か
  const inOther = (x, z, self, margin) => {
    const cont = plan.info.get(self)?.cont;
    let hit = false;
    grid.queryPoint(x, z, 0, (k) => {
      if (hit) return;
      const s = segs[k];
      if (s.road === self || cont?.has(s.road)) return;
      if (closestOnSegment(x, z, s.ax, s.az, s.bx, s.bz).d2 < (s.band + margin) ** 2) hit = true;
    });
    return hit;
  };
  return { inOther };
}

// 歩道を敷かない平らな面: 広場・緑地・駐車場（地面に描く面。外形の縁で止める）と、線路（軌道の中心から RAIL_HALF m）。
// どれも深度を書かない y = 0 の面なので、一段高い歩道が上に来ると隠れてしまう
export function makeSoftObstacles(parsed, clip, pad = INDEX_PAD) {
  const near = (b) => b.maxX > clip.minX - pad && b.minX < clip.maxX + pad && b.maxZ > clip.minZ - pad && b.minZ < clip.maxZ + pad;
  const polys = (parsed.areas || []).filter((a) => a.type !== 'water' && near(a.bounds));
  const edges = makeObstacles(polys);
  // 点が面の中か（車道・縁石に重なる広場や、縁が遠い・壁の向こうにある面でも、中から始まる歩道を止める）
  const areaGrid = new Grid(50);
  polys.forEach((a, i) => areaGrid.insertBounds(a.bounds.minX, a.bounds.minZ, a.bounds.maxX, a.bounds.maxZ, i));
  const inside = (x, z) => {
    let hit = false;
    areaGrid.queryPoint(x, z, 0, (i) => {
      if (!hit && pointInPolygon(x, z, polys[i])) hit = true;
    });
    return hit;
  };
  const grid = new Grid(8);
  const segs = [];
  for (const r of parsed.rails || []) {
    if (r.bridge) continue;
    for (let i = 0; i + 1 < r.pts.length; i++) {
      const [ax, az] = r.pts[i], [bx, bz] = r.pts[i + 1];
      const b = { minX: Math.min(ax, bx) - RAIL_HALF, minZ: Math.min(az, bz) - RAIL_HALF, maxX: Math.max(ax, bx) + RAIL_HALF, maxZ: Math.max(az, bz) + RAIL_HALF };
      if (!near(b)) continue;
      grid.insertBounds(b.minX, b.minZ, b.maxX, b.maxZ, segs.length);
      segs.push([ax, az, bx, bz]);
    }
  }
  const onRail = (x, z) => {
    let hit = false;
    grid.queryPoint(x, z, 0, (k) => {
      if (hit) return;
      const [ax, az, bx, bz] = segs[k];
      if (closestOnSegment(x, z, ax, az, bx, bz).d2 < RAIL_HALF * RAIL_HALF) hit = true;
    });
    return hit;
  };
  return { ray: edges.ray, onRail, inside };
}

// 歩道・石畳を横へどこまで延ばすか: (px, pz) から (dx, dz) へ、壁・ほかの道路（の縁石の外）・広場や緑地の縁・線路・水に
// 当たるまで。返り値 { t, stop: 'facade' | 'inside' | 'road' | 'soft' | 'none' }（soft: 広場・緑地・駐車場の縁。
// 線路・水は 'road' と同じ扱い）。広場などの中から始まるときは、縁が遠くても壁の向こうでも t = 0
export function makeExtent(obstacles, soft, roads, waterDepthAt) {
  return (px, pz, dx, dz, tMax, self, margin = CURB_W) => {
    if (soft.inside(px, pz)) return { t: 0, stop: 'soft' };
    const f = obstacles.ray(px, pz, dx, dz, tMax);
    if (f?.inside) return { t: 0, stop: 'inside' };
    let lim = f ? f.t : tMax;
    let end = f ? 'facade' : 'none';
    const a = soft.ray(px, pz, dx, dz, lim);
    if (a) {
      if (a.inside) return { t: 0, stop: 'soft' }; // 広場・緑地の中から始まる（点の判定の境目）
      lim = a.t;
      end = 'soft';
    }
    // 水は岸の近くだけなので、終わりと中ほどで水に入るときだけ細かく調べる
    const wet = waterDepthAt(px + dx * lim, pz + dz * lim) > 0 || waterDepthAt(px + dx * lim * 0.5, pz + dz * lim * 0.5) > 0;
    const bad = (t) => {
      const x = px + dx * t, z = pz + dz * t;
      return roads.inOther(x, z, self, margin) || soft.onRail(x, z) || (wet && waterDepthAt(x, z) > 0);
    };
    let prev = 0;
    for (let t = 0; ; t = Math.min(lim, t + PROBE)) {
      if (bad(t)) {
        if (t === 0) return { t: 0, stop: 'road' };
        // 境目を二分法で約 9 cm まで詰める
        let lo = prev, hi = t;
        for (let k = 0; k < 4; k++) {
          const m = (lo + hi) / 2;
          if (bad(m)) hi = m;
          else lo = m;
        }
        return { t: lo, stop: 'road' };
      }
      prev = t;
      if (t >= lim) break;
    }
    return end === 'facade' ? { t: f.t, stop: 'facade' } : end === 'soft' ? { t: lim, stop: 'soft' } : { t: tMax, stop: 'none' };
  };
}

// 旧市街の石畳の、中心線から片側の幅（extent の結果 e から）。壁の所は壁の中まで、ほかの車道の所は最低でも車道の幅。
// 広場・緑地・駐車場（soft）で止まる所は、その縁まで（車道の幅を下回っても広げない。その先は広場の面が見える）
export function oldTownWidth(e, half, reach) {
  if (e.stop === 'soft') return Math.min(reach, e.t);
  const f = e.stop === 'facade' ? e.t + OVERSHOOT : e.stop === 'none' ? half + 1 : e.t;
  return Math.min(reach, Math.max(f, half, 1.2));
}

// 中心 (x, z)・半径 r の seg 角形の周の点。広場・緑地などの面（soft）の縁で半径を縮める。中心が面の中なら null
export function discRim(x, z, r, seg, soft) {
  if (soft.inside(x, z)) return null;
  const rim = [];
  for (let i = 0; i < seg; i++) {
    const a = (i / seg) * Math.PI * 2, dx = Math.cos(a), dz = Math.sin(a);
    const hit = soft.ray(x, z, dx, dz, r);
    const t = hit ? (hit.inside ? 0 : hit.t) : r;
    rim.push([x + dx * t, z + dz * t]);
  }
  return rim;
}

// 旧市街の地面の下地（通りの帯の間の交差点の広がり・地図にない小さな広場が土のままにならないように）: 範囲 clip の中の
// 旧市街の外形を、cell m のマスごとに切った面の列（大きな三角形は深度の補間の誤差で地面に隠れるので小分けにする）
export function oldTownBase(ring, clip, cell = 50) {
  if (!ring || ring.length < 3) return [];
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
  for (const [x, z] of ring) {
    minX = Math.min(minX, x);
    minZ = Math.min(minZ, z);
    maxX = Math.max(maxX, x);
    maxZ = Math.max(maxZ, z);
  }
  const x0 = Math.max(minX, clip.minX), x1 = Math.min(maxX, clip.maxX), z0 = Math.max(minZ, clip.minZ), z1 = Math.min(maxZ, clip.maxZ);
  const out = [];
  for (let x = x0; x < x1 - 1e-6; x += cell) {
    for (let z = z0; z < z1 - 1e-6; z += cell) {
      const r = clipRingToRect(ring, x, z, Math.min(x + cell, x1), Math.min(z + cell, z1));
      if (r.length >= 3 && Math.abs(signedArea(r)) > 0.01) out.push(r);
    }
  }
  return out;
}

// ---------------------------------------------------------------- 道に沿った断面の点（ステーション）
// 折れ線 pts の頂点（マイター）と、その間 STEP m ごと、extra（始点からの距離）の位置に点を置く
function stations(pts, extra = []) {
  const out = [];
  const n = pts.length;
  let s = 0;
  const segN = (i) => {
    const L = Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]) || 1;
    return [(pts[i + 1][0] - pts[i][0]) / L, (pts[i + 1][1] - pts[i][1]) / L, L];
  };
  const ex = [...extra].sort((a, b) => a - b);
  let e = 0;
  for (let i = 0; i < n; i++) {
    // 頂点: 前後の辺の向きの平均の法線と、辺に平行になるよう長さの補正（offsets と同じ）
    let dx = 0, dz = 0;
    if (i > 0) {
      const [ux, uz] = segN(i - 1);
      dx += ux;
      dz += uz;
    }
    if (i < n - 1) {
      const [ux, uz] = segN(i);
      dx += ux;
      dz += uz;
    }
    const dl = Math.hypot(dx, dz) || 1;
    dx /= dl;
    dz /= dl;
    let sc = 1;
    if (i > 0 && i < n - 1) {
      const [ux, uz] = segN(i);
      sc = Math.min(2.5, 1 / Math.max(Math.abs(-dz * -uz + dx * ux), 0.2));
    }
    out.push({ x: pts[i][0], z: pts[i][1], ux: dx, uz: dz, nx: -dz, nz: dx, sc, s, vertex: true, keep: true });
    if (i === n - 1) break;
    const [ux, uz, L] = segN(i);
    const cuts = [];
    const m = Math.floor(L / STEP);
    for (let k = 1; k <= m; k++) if (L - k * (L / (m + 1)) > 0.3) cuts.push({ d: k * (L / (m + 1)), keep: false });
    while (e < ex.length && ex[e] < s + L) {
      if (ex[e] > s + 0.05 && ex[e] < s + L - 0.05) cuts.push({ d: ex[e] - s, keep: true });
      e++;
    }
    cuts.sort((a, b) => a.d - b.d);
    for (const c of cuts) out.push({ x: pts[i][0] + ux * c.d, z: pts[i][1] + uz * c.d, ux, uz, nx: -uz, nz: ux, sc: 1, s: s + c.d, vertex: false, keep: c.keep });
    s += L;
  }
  return out;
}

// 2 つのステーションの間の点（境目を探すとき用）
function lerpStation(a, b, t) {
  return { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t, ux: b.vertex ? a.ux : b.ux, uz: b.vertex ? a.uz : b.uz, nx: b.vertex ? a.nx : b.nx, nz: b.vertex ? a.nz : b.nz, sc: 1, s: a.s + (b.s - a.s) * t, vertex: false, keep: true };
}

// 道全体のステーション列のうち、[s0, s1] を SEAM_PAD m ずつ広げ、さらにその外の keep の点までを含む範囲。
// keep の点から先の間引きは前の点によらないので、隣のタイルと重なる所では同じ断面になる
export function stationWindow(sts, s0, s1) {
  let i0 = 0, i1 = sts.length - 1;
  for (let i = 0; i < sts.length && sts[i].s <= s0 - SEAM_PAD; i++) if (sts[i].keep) i0 = i;
  for (let i = sts.length - 1; i >= 0 && sts[i].s >= s1 + SEAM_PAD; i--) if (sts[i].keep) i1 = i;
  return sts.slice(i0, i1 + 1);
}

// 道に沿って並んだ断面 rows（st.s の昇順）を [s0, s1] で切る。範囲の端は前後の断面の間を lerp(A, B, s) で補間する
export function clipRows(rows, s0, s1, lerp) {
  const out = [];
  const eps = 1e-6;
  for (let k = 0; k < rows.length; k++) {
    const r = rows[k], s = r.st.s, p = rows[k - 1];
    if (s < s0 - eps) continue;
    if (s <= s1 + eps) {
      if (!out.length && p && p.st.s < s0 - eps) out.push(lerp(p, r, s0));
      out.push(r);
      continue;
    }
    if (p && p.st.s < s1 - eps) {
      if (!out.length && p.st.s < s0 - eps) out.push(lerp(p, r, s0));
      out.push(lerp(p, r, s1));
    }
    break;
  }
  return out;
}

// 値 vals[][k] の変化が直線で許容差の中なら、間のステーションを省く（keep の点は残す）。
// tols[][k] = [直線が値より大きくてよい量, 小さくてよい量]（壁の中へは深く入ってよいが、手前で止まってはいけない）
export function simplifyProfile(sts, vals, tols = null) {
  const out = [0];
  let i = 0;
  while (i < sts.length - 1) {
    let j = i + 1;
    for (let k = i + 2; k < sts.length; k++) {
      if (sts[k - 1].keep) break;
      let ok = true;
      for (let m = i + 1; m < k && ok; m++) {
        const t = (sts[m].s - sts[i].s) / Math.max(1e-6, sts[k].s - sts[i].s);
        for (let q = 0; q < vals.length && ok; q++) {
          const v = vals[q];
          const d = v[i] + (v[k] - v[i]) * t - v[m];
          const [up, down] = tols ? tols[q][m] : [TOL, TOL];
          if (d > up || -d > down) ok = false;
        }
      }
      if (!ok) break;
      j = k;
    }
    out.push(j);
    i = j;
  }
  return out;
}

// ---------------------------------------------------------------- 書き込み
const UP = [0, 1, 0];

// 縦の面 p→q（下端 0、上端 hp/hq）。法線は (tx, tz) の向き
function wallQuad(w, p, q, hp, hq, tx, tz, u0, u1, v0, color) {
  const dx = q[0] - p[0], dz = q[1] - p[1];
  const L = Math.hypot(dx, dz) || 1;
  let nx = -dz / L, nz = dx / L;
  if (nx * tx + nz * tz < 0) { nx = -nx; nz = -nz; }
  w.quad([p[0], 0, p[1]], [q[0], 0, q[1]], [q[0], hq, q[1]], [p[0], hp, p[1]], [nx, 0, nz], [u0, v0], [u1, v0], [u1, v0 + hq / 0.5], [u0, v0 + hp / 0.5], color);
}

// 一段高い歩道の当たり判定用の索引（自転車の高さ）。四角形 [x0,z0,h0, ... x3,z3,h3]
export class RaisedIndex {
  constructor() {
    this.grid = new Grid(10);
    this.quads = [];
  }

  add(q) {
    let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
    for (let k = 0; k < 12; k += 3) {
      minX = Math.min(minX, q[k]);
      maxX = Math.max(maxX, q[k]);
      minZ = Math.min(minZ, q[k + 1]);
      maxZ = Math.max(maxZ, q[k + 1]);
    }
    this.grid.insertBounds(minX, minZ, maxX, maxZ, this.quads.length);
    this.quads.push(q);
  }

  // (x, z) の歩道の高さ（歩道でなければ 0）
  heightAt(x, z) {
    let best = 0;
    this.grid.queryPoint(x, z, 0, (k) => {
      const q = this.quads[k];
      for (const [a, b, c] of [[0, 3, 6], [0, 6, 9]]) {
        const h = triHeight(x, z, q, a, b, c);
        if (h !== null && h > best) best = h;
      }
    });
    return best;
  }
}

function triHeight(x, z, q, a, b, c) {
  const x0 = q[a], z0 = q[a + 1], x1 = q[b], z1 = q[b + 1], x2 = q[c], z2 = q[c + 1];
  const den = (z1 - z2) * (x0 - x2) + (x2 - x1) * (z0 - z2);
  if (Math.abs(den) < 1e-9) return null;
  const l0 = ((z1 - z2) * (x - x2) + (x2 - x1) * (z - z2)) / den;
  const l1 = ((z2 - z0) * (x - x2) + (x0 - x2) * (z - z2)) / den;
  const l2 = 1 - l0 - l1;
  if (l0 < -1e-6 || l1 < -1e-6 || l2 < -1e-6) return null;
  return l0 * q[a + 2] + l1 * q[b + 2] + l2 * q[c + 2];
}

const lerp2 = (p, q, t) => [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];

// 範囲 clip の通りの断面を作る（同期版）。out: 書き込み先（setts / slabs / gutter / curb / sidewalk / sidewalkRed / marking / post）
// を返す関数、raised: RaisedIndex（一段高い歩道の高さ）
export function writeStreets(...args) {
  const it = streetSteps(...args);
  for (;;) {
    const r = it.next();
    if (r.done) return r.value;
  }
}

// writeStreets の本体。道 1 本ごとに yield するので、呼ぶ側は時間を見て描画のフレームに譲れる（タイルの読み込み中）
export function* streetSteps(parsed, plan, clip, { buildings = [], walls = [], waterDepthAt = () => 0 }, out, raised) {
  // 索引づくりも小分けにして譲る（読み込み中のタイルで描画のフレームを長く止めない）
  const obstacles = makeObstacles(buildings, walls);
  yield;
  const roads = makeRoadIndex(parsed, plan, clip);
  yield;
  const soft = makeSoftObstacles(parsed, clip);
  yield;
  const extent = makeExtent(obstacles, soft, roads, waterDepthAt);
  const inClip = (x, z) => x >= clip.minX && x < clip.maxX && z >= clip.minZ && z < clip.maxZ;
  const H = plan.curbHeight;
  const stats = { stations: 0, crossings: 0, posts: 0, postPts: [] }; // postPts: 車止めの位置（当たり判定用）
  // 石の色は日陰の青い空の光で冷たく見えるので、頂点カラーで少し暖かく（写真: 小舗石の日陰 #5d5656、Rue du Taur の
  // 石の板はばら色のベージュ）。slabWide: 広い歩行者の通りの石の板は少し暗く灰色寄り（Rue de la Pomme・Alsace-Lorraine）。
  // 側溝の石は日なたで赤く見えないよう、ほぼ無彩色（写真 sidewalk-curb: 灰色の花崗岩）
  const warm = c3n(0xffeee4);
  const colors = { curb: [1, 1, 1], grey: c3n(0xd2cfca), red: c3n(0xe2b6a0), setts: warm, slab: c3n(0xffe6d2), slabWide: c3n(0xf0e2d8), gutter: c3n(0xe4e4e6), white: c3n(0xf2f2ee), post: c3n(0x2a2d2c) };

  // 道 road の折れ線 part（clip で切った一部）の、元の道の始点からの距離
  const startS = (road, part) => {
    const inf = plan.info.get(road);
    const [px, pz] = part[0];
    let best = Infinity, s = 0;
    for (let i = 0; i + 1 < road.pts.length; i++) {
      const c = closestOnSegment(px, pz, road.pts[i][0], road.pts[i][1], road.pts[i + 1][0], road.pts[i + 1][1]);
      if (c.d2 < best) {
        best = c.d2;
        s = inf.cum[i] + c.t * (inf.cum[i + 1] - inf.cum[i]);
      }
    }
    return s;
  };
  // 道全体のステーション（計画に覚えておく）: ANCHOR m ごとの keep の点と、横断歩道の縁石を下げる点の前後
  // （ゆるい坂の形を出す）。どのタイルで作っても同じ位置になる
  const roadStations = (road, inf) => {
    if (inf.sts) return inf.sts;
    const total = inf.cum[inf.cum.length - 1];
    const extra = [];
    for (let s = ANCHOR; s < total - 1; s += ANCHOR) extra.push(s);
    if (inf.kind === 'curb') {
      const reach = road.width / 2 + CURB_W + 3;
      const b = inf.bounds;
      plan.rampGrid.query(b.minX - reach, b.minZ - reach, b.maxX + reach, b.maxZ + reach, (k) => {
        const r = plan.ramps[k];
        let best = Infinity, s = 0;
        for (let i = 0; i + 1 < road.pts.length; i++) {
          const c = closestOnSegment(r.x, r.z, road.pts[i][0], road.pts[i][1], road.pts[i + 1][0], road.pts[i + 1][1]);
          if (c.d2 < best) {
            best = c.d2;
            s = inf.cum[i] + c.t * (inf.cum[i + 1] - inf.cum[i]);
          }
        }
        if (best < (reach + r.r1) ** 2) for (const o of [-r.r1, -r.r0, 0, r.r0, r.r1]) extra.push(s + o);
      });
    }
    // 覚えておく道の数には上限（走って読み込み・破棄を続けても増え続けないよう、古いものから捨てる。作り直しても同じ点）
    const q = (plan.stsQueue ||= []);
    q.push(inf);
    if (q.length > STS_CACHE) q.shift().sts = null;
    return (inf.sts = stations(road.pts, extra));
  };

  // ---- 縁石・一段高い歩道・側溝の帯。P: 断面の列 { st, nx, nz, e, facade, a（縁石の車道側）, c（縁石の歩道側）, o（歩道の外）,
  // g（側溝の車道側）, ha, hc, ho }。端の面は両端に作る（タイルの境では隣のタイルの歩道に隠れるが、幅が違ったときの口をふさぐ）
  const rowPoints = (st, nx, nz, off, e, facade) => {
    const a = [st.x + nx * off, st.z + nz * off];
    const c = [a[0] + nx * CURB_W, a[1] + nz * CURB_W];
    const o = [c[0] + nx * e, c[1] + nz * e];
    const g = [a[0] - nx * GUTTER_W, a[1] - nz * GUTTER_W];
    return { st, nx, nz, e, facade, a, c, o, g, ha: H(a[0], a[1]), hc: H(c[0], c[1]), ho: H(o[0], o[1]) };
  };
  const lerpRow = (A, B, s) => {
    const t = (s - A.st.s) / Math.max(1e-9, B.st.s - A.st.s);
    const a = lerp2(A.a, B.a, t), c = lerp2(A.c, B.c, t), o = lerp2(A.o, B.o, t), g = lerp2(A.g, B.g, t);
    return { st: { s, ux: A.st.ux, uz: A.st.uz }, nx: A.nx, nz: A.nz, e: A.e + (B.e - A.e) * t, facade: A.facade && B.facade, a, c, o, g, ha: H(a[0], a[1]), hc: H(c[0], c[1]), ho: H(o[0], o[1]) };
  };
  const writeRaised = (P, red, gutter, fanUV = false) => {
    const curb = out('curb'), walk = out(red ? 'sidewalkRed' : 'sidewalk'), gut = gutter ? out('gutter') : null;
    const sw = red ? colors.red : colors.grey;
    const uvw = (p) => [p[0] / 4, -p[1] / 4];
    for (let k = 0; k + 1 < P.length; k++) {
      const A = P[k], B = P[k + 1];
      const u0 = A.st.s / 4, u1 = B.st.s / 4;
      // 縁石の立ち上がり（車道側）と天端
      wallQuad(curb, A.a, B.a, A.ha, B.ha, -A.nx, -A.nz, u0, u1, 0.4, colors.curb);
      curb.quad([A.a[0], A.ha, A.a[1]], [B.a[0], B.ha, B.a[1]], [B.c[0], B.hc, B.c[1]], [A.c[0], A.hc, A.c[1]], UP, [u0, 0], [u1, 0], [u1, 0.4], [u0, 0.4], colors.curb);
      // 歩道の面と、壁に当たらない所の外側の面
      if (A.e > 0 || B.e > 0) {
        walk.quad([A.c[0], A.hc, A.c[1]], [B.c[0], B.hc, B.c[1]], [B.o[0], B.ho, B.o[1]], [A.o[0], A.ho, A.o[1]], UP, uvw(A.c), uvw(B.c), uvw(B.o), uvw(A.o), sw);
        if (!A.facade || !B.facade) wallQuad(walk, A.o, B.o, A.ho, B.ho, A.nx, A.nz, u0, u1, 0, sw);
      }
      raised.add([A.a[0], A.a[1], A.ha, B.a[0], B.a[1], B.ha, B.o[0], B.o[1], B.ho, A.o[0], A.o[1], A.ho]);
      // 縁石の足元の側溝（2 列の小舗石）
      const v0 = fanUV ? 0 : A.st.s / SETT_TILE, v1 = fanUV ? 0.1 : B.st.s / SETT_TILE;
      if (gut) gut.quad([A.g[0], 0, A.g[1]], [B.g[0], 0, B.g[1]], [B.a[0], 0, B.a[1]], [A.a[0], 0, A.a[1]], UP, [0, v0], [0, v1], [1, v1], [1, v0], colors.gutter);
    }
  };
  const writeEnds = (P, red) => {
    const curb = out('curb'), walk = out(red ? 'sidewalkRed' : 'sidewalk');
    const sw = red ? colors.red : colors.grey;
    for (const [E, dir] of [[P[0], -1], [P[P.length - 1], 1]]) {
      wallQuad(curb, E.a, E.c, E.ha, E.hc, E.st.ux * dir, E.st.uz * dir, 0, CURB_W / 4, 0.4, colors.curb);
      if (E.e > 0) wallQuad(walk, E.c, E.o, E.hc, E.ho, E.st.ux * dir, E.st.uz * dir, 0, E.e / 4, 0, sw);
    }
  };

  // ---- 縁石と一段高い歩道（片側）
  // sts: ステーション列（道全体の一部。[s0, s1] より広い）、side: +1 = 左 / -1 =右。形は [s0, s1] の所だけ書く
  const writeCurbSide = (road, sts, side, s0, s1, red) => {
    const half = road.width / 2;
    const blockedAt = (st, off) => {
      const x = st.x + st.nx * side * (off + CURB_W / 2), z = st.z + st.nz * side * (off + CURB_W / 2);
      return roads.inOther(x, z, road, CURB_W) || soft.onRail(x, z);
    };
    // 各ステーション: ふさがれているか（縁石がほかの道路・線路の中）、歩道の幅
    const rows = sts.map((st) => ({ st, nx: st.nx * side, nz: st.nz * side, off: st.sc * half, blocked: blockedAt(st, st.sc * half) }));
    // ふさがれている所との境目を二分法で探して足す
    const all = [];
    for (let k = 0; k < rows.length; k++) {
      if (k > 0 && rows[k].blocked !== rows[k - 1].blocked) {
        let lo = 0, hi = 1;
        const a = rows[k - 1], b = rows[k];
        for (let it = 0; it < 7; it++) {
          const m = (lo + hi) / 2;
          if (blockedAt(lerpStation(a.st, b.st, m), half) === a.blocked) lo = m;
          else hi = m;
        }
        const st = lerpStation(a.st, b.st, a.blocked ? hi : lo);
        all.push({ st, nx: st.nx * side, nz: st.nz * side, off: half, blocked: false, edge: true });
      }
      all.push(rows[k]);
    }
    // ふさがれていない区間ごとに作る
    let run = [];
    for (const r of all) {
      if (r.blocked) {
        if (run.length >= 2) writeCurbRun(road, run, s0, s1, red);
        run = [];
      } else run.push(r);
    }
    if (run.length >= 2) writeCurbRun(road, run, s0, s1, red);
  };

  const writeCurbRun = (road, run, s0, s1, red) => {
    if (run[run.length - 1].st.s < s0 || run[0].st.s > s1) return;
    // 歩道の幅（縁石の外から、壁・ほかの道路・広場・線路・水まで）
    for (const r of run) {
      const cx = r.st.x + r.nx * (r.off + CURB_W), cz = r.st.z + r.nz * (r.off + CURB_W);
      const e = extent(cx, cz, r.nx, r.nz, SIDEWALK_MAX, road);
      r.facade = e.stop === 'facade' || e.stop === 'inside';
      r.stop = e.stop;
      r.e = e.stop === 'facade' ? Math.min(SIDEWALK_MAX, e.t + OVERSHOOT) : e.stop === 'none' ? SIDEWALK_DEFAULT : e.t;
      if (r.e < 0.25) r.e = 0;
    }
    // 建物と建物のすき間（庭・路地の入口）は、両側の壁の線をつないだ所で歩道を止める（歩道の端をそろえる）
    for (let k = 0; k < run.length; k++) {
      if (run[k].stop !== 'none') continue;
      let k1 = k;
      while (k1 + 1 < run.length && run[k1 + 1].stop === 'none') k1++;
      const A = run[k - 1], B = run[k1 + 1];
      if (A?.stop === 'facade' && B?.stop === 'facade' && B.st.s - A.st.s < 30) {
        for (let m = k; m <= k1; m++) {
          const t = (run[m].st.s - A.st.s) / Math.max(1e-6, B.st.s - A.st.s);
          run[m].e = Math.min(SIDEWALK_DEFAULT + 1, A.e + (B.e - A.e) * t - OVERSHOOT);
        }
      }
      k = k1;
    }
    const keep = simplifyProfile(run.map((r) => r.st), [run.map((r) => r.e)], [run.map((r) => (r.facade ? [0.5, 0.12] : [0.2, 0.3]))]);
    const P = clipRows(keep.map((k) => run[k]).map((r) => rowPoints(r.st, r.nx, r.nz, r.off, r.e, r.facade)), s0, s1, lerpRow);
    if (P.length < 2) return;
    stats.stations += P.length;
    writeRaised(P, red, plan.info.get(road).gutter);
    // 区間の端の面（交差点で切った所・行き止まり・タイルの境）
    writeEnds(P, red);
  };

  // ---- 旧市街の石畳（壁から壁まで）。taur: 小舗石の車道＋側溝＋石の板の歩道
  const writeOldTown = (road, inf, sts, s0, s1, ends) => {
    const half = road.width / 2;
    const reach = half + SHARED_EXTRA;
    const fL = [], fR = [], sL = [], sR = []; // sL / sR: 広場・緑地の縁で止まった（側溝・石の板もそこで切る）
    for (const st of sts) {
      for (const [side, arr, soft] of [[1, fL, sL], [-1, fR, sR]]) {
        const e = extent(st.x, st.z, st.nx * side, st.nz * side, reach, road, 0);
        arr.push(oldTownWidth(e, half, reach));
        soft.push(e.stop === 'soft');
      }
    }
    const keep = simplifyProfile(sts, [fL, fR]);
    // 残した断面を [s0, s1] で切る。端の断面 { A, B, t } は前後の断面の点を補間する（隣のタイルと同じ線で切れる）
    const K = clipRows(keep.map((k) => ({ st: sts[k], fL: fL[k], fR: fR[k], sL: sL[k], sR: sR[k] })), s0, s1, (A, B, s) => ({ A, B, t: (s - A.st.s) / Math.max(1e-9, B.st.s - A.st.s), st: { s } }));
    if (K.length < 2) return;
    stats.stations += K.length;
    const setts = out('setts');
    // 断面 e の、中心線から横へ off(e) の点（off は断面ごとの値を返す関数）
    const at = (e, off) => {
      if (e.A) return lerp2(at(e.A, off), at(e.B, off), e.t);
      const o = off(e);
      return [e.st.x + e.st.nx * o, e.st.z + e.st.nz * o];
    };
    const val = (e, off) => (e.A ? off(e.A) + (off(e.B) - off(e.A)) * e.t : off(e));
    // 帯 [o0, o1]（中心線からの横の位置、左が +）を、断面の間ごとに書く
    const band = (w, o0, o1, tile, color, uFlat = false) => {
      for (let m = 0; m + 1 < K.length; m++) {
        const A = K[m], B = K[m + 1];
        const a0 = val(A, o0), a1 = val(A, o1), b0 = val(B, o0), b1 = val(B, o1);
        if (a1 - a0 < 0.02 && b1 - b0 < 0.02) continue;
        const p0 = at(A, o0), p1 = at(A, o1), q0 = at(B, o0), q1 = at(B, o1);
        const vi = A.st.s / tile, vj = B.st.s / tile;
        const u = (o) => (uFlat ? o : o / tile);
        w.quad([p0[0], 0, p0[1]], [q0[0], 0, q0[1]], [q1[0], 0, q1[1]], [p1[0], 0, p1[1]], UP, [u(uFlat ? 0 : a0), vi], [u(uFlat ? 0 : b0), vj], [u(uFlat ? 1 : b1), vj], [u(uFlat ? 1 : a1), vi], color);
      }
    };
    if (inf.kind === 'taur') {
      const c = Math.min(2.1, Math.max(1.75, half));
      const slabs = out('slabs'), gut = out('gutter');
      const room = (f) => f > c + GUTTER_W + 0.5; // 石の板の歩道を置く幅があるか
      const capL = (e, v) => (e.sL ? Math.min(v, e.fL) : v), capR = (e, v) => (e.sR ? Math.min(v, e.fR) : v); // 広場の縁で切る
      band(setts, (e) => -(room(e.fR) ? c : e.fR), (e) => (room(e.fL) ? c : e.fL), SETT_TILE, colors.setts);
      band(gut, (e) => capL(e, c), (e) => capL(e, c + GUTTER_W), SETT_TILE, colors.gutter, true);
      band(gut, (e) => -capR(e, c + GUTTER_W), (e) => -capR(e, c), SETT_TILE, colors.gutter, true);
      band(slabs, (e) => Math.min(c + GUTTER_W, e.fL), (e) => (room(e.fL) ? e.fL : capL(e, c + GUTTER_W)), SLAB_TILE, colors.slab);
      band(slabs, (e) => (room(e.fR) ? -e.fR : -capR(e, c + GUTTER_W)), (e) => -Math.min(c + GUTTER_W, e.fR), SLAB_TILE, colors.slab);
    } else {
      if (inf.slabs) band(out('slabs'), (e) => -e.fR, (e) => e.fL, SLAB_TILE, colors.slabWide);
      else band(setts, (e) => -e.fR, (e) => e.fL, SETT_TILE, colors.setts);
      // 側溝の線: ほかの車道の中には引かない
      const g = inf.gutter, gut = out('gutter');
      const G = (d) => () => g + d;
      for (let m = 0; m + 1 < K.length; m++) {
        const A = K[m], B = K[m + 1];
        const pi = at(A, G(0)), pj = at(B, G(0));
        const mx = (pi[0] + pj[0]) / 2, mz = (pi[1] + pj[1]) / 2;
        if (roads.inOther(mx, mz, road, 0) || soft.inside(mx, mz)) continue;
        const a0 = at(A, G(-GUTTER_W / 2)), a1 = at(A, G(GUTTER_W / 2)), b0 = at(B, G(-GUTTER_W / 2)), b1 = at(B, G(GUTTER_W / 2));
        const vi = A.st.s / SETT_TILE, vj = B.st.s / SETT_TILE;
        gut.quad([a0[0], 0, a0[1]], [b0[0], 0, b0[1]], [b1[0], 0, b1[1]], [a1[0], 0, a1[1]], UP, [0, vi], [0, vj], [1, vj], [1, vi], colors.gutter);
      }
    }
    // 道の端（交差点）は、端の断面と同じ向きの小舗石の円で埋める（折れた所のすき間をなくす）。広場・緑地の中には入れない
    for (const [e, isEnd] of [[K[0], ends[0]], [K[K.length - 1], ends[1]]]) {
      if (!isEnd || e.A) continue;
      const st = e.st;
      const r = inf.kind === 'taur' ? Math.min(2.1, Math.max(1.75, half)) : Math.min(Math.max(e.fL, e.fR), half + 2);
      const rim = discRim(st.x, st.z, r, 12, soft);
      if (!rim) continue;
      const tile = inf.slabs ? SLAB_TILE : SETT_TILE;
      const w = inf.slabs ? out('slabs') : setts, col = inf.slabs ? colors.slabWide : colors.setts;
      const uv = (q) => [((q[0] - st.x) * st.nx + (q[1] - st.z) * st.nz) / tile, (st.s + (q[0] - st.x) * st.ux + (q[1] - st.z) * st.uz) / tile];
      for (let i = 0; i < rim.length; i++) {
        const q0 = rim[i], q1 = rim[(i + 1) % rim.length];
        w.tri([st.x, 0, st.z], [q0[0], 0, q0[1]], [q1[0], 0, q1[1]], UP, uv([st.x, st.z]), uv(q0), uv(q1), col);
      }
    }
  };

  // ---- 道ごと（道全体の断面のうち、この範囲に入る所だけ書く。隣のタイルと同じ断面を同じ所で切る）
  for (const road of plan.roadsNear(clip, 1)) {
    const inf = plan.info.get(road);
    if (!inf || (inf.kind !== 'curb' && inf.kind !== 'shared' && inf.kind !== 'taur')) continue;
    const b = inf.bounds;
    if (b.maxX < clip.minX || b.minX > clip.maxX || b.maxZ < clip.minZ || b.minZ > clip.maxZ) continue;
    const all = roadStations(road, inf);
    for (const part of clipParts(road, clip)) {
      if (part.length < 2) continue;
      const first = part[0], last = part[part.length - 1];
      const o0 = road.pts[0], o1 = road.pts[road.pts.length - 1];
      const cut0 = Math.hypot(first[0] - o0[0], first[1] - o0[1]) > 1e-4;
      const cut1 = Math.hypot(last[0] - o1[0], last[1] - o1[1]) > 1e-4;
      const s0 = cut0 ? startS(road, part) : 0;
      const s1 = cut1 ? s0 + cumulative(part)[part.length - 1] : all[all.length - 1].s;
      const sts = stationWindow(all, s0, s1);
      if (inf.kind === 'curb') {
        writeCurbSide(road, sts, 1, s0, s1, inf.red[0]);
        writeCurbSide(road, sts, -1, s0, s1, inf.red[1]);
      } else {
        writeOldTown(road, inf, sts, s0, s1, [!cut0, !cut1]);
      }
    }
    yield;
  }

  // ---- 道のつなぎ目の外側（折れて 180° を超える側）の歩道の扇形
  let nj = 0;
  for (const n of plan.junctions) {
    if (!inClip(n.x, n.z)) continue;
    if (++nj % 40 === 0) yield;
    const arms = n.arms.filter((a) => a.end && plan.info.get(a.road).kind === 'curb')
      .map((a) => ({ ...a, ang: Math.atan2(a.uz, a.ux) })).sort((p, q) => p.ang - q.ang);
    if (arms.length < 2 || arms.length !== n.arms.length) continue;
    for (let k = 0; k < arms.length; k++) {
      const a = arms[k], b = arms[(k + 1) % arms.length];
      if (a.road === b.road) continue;
      let span = b.ang - a.ang;
      if (span <= 0) span += Math.PI * 2;
      if (span < Math.PI + 0.03) continue;
      writeCornerFan(n, a, b, span - Math.PI);
    }
  }

  function writeCornerFan(n, a, b, span) {
    const ia = plan.info.get(a.road);
    const ha = a.road.width / 2, hb = b.road.width / 2;
    const steps = Math.max(2, Math.ceil(span / 0.3));
    const phi0 = a.ang + Math.PI / 2;
    const P = [];
    for (let k = 0; k <= steps; k++) {
      const t = k / steps, phi = phi0 + span * t;
      const nx = Math.cos(phi), nz = Math.sin(phi);
      const off = ha + (hb - ha) * t;
      const cx = n.x + nx * (off + CURB_W), cz = n.z + nz * (off + CURB_W);
      const e = extent(cx, cz, nx, nz, SIDEWALK_MAX, k < steps / 2 ? a.road : b.road);
      const facade = e.stop === 'facade' || e.stop === 'inside';
      const w = e.stop === 'facade' ? Math.min(SIDEWALK_MAX, e.t + OVERSHOOT) : e.stop === 'none' ? SIDEWALK_DEFAULT : e.t;
      P.push(rowPoints({ x: n.x, z: n.z, s: span * off * t }, nx, nz, off, w < 0.25 ? 0 : w, facade));
    }
    // 角の歩道の色は a の道の側に合わせる
    writeRaised(P, ia.red[a.dir > 0 ? 0 : 1], ia.gutter, true);
  }
  yield;

  // ---- 横断歩道と停止線（中心がこの範囲にあるものだけ）
  const mark = out('marking');
  for (const c of plan.crossings) {
    if (!inClip(c.x, c.z)) continue;
    stats.crossings++;
    const nx = -c.uz, nz = c.ux;
    const bar = 0.5, gap = 0.6;
    const usable = 2 * c.half - 0.5;
    const count = Math.max(1, Math.floor((usable + gap) / (bar + gap)));
    const first = -((count - 1) * (bar + gap)) / 2;
    for (let k = 0; k < count; k++) {
      const o = first + k * (bar + gap);
      rect(mark, c.x + nx * o, c.z + nz * o, c.ux, c.uz, c.len / 2, bar / 2, colors.white);
    }
    if (c.stop) {
      // 停止線（幅 30 cm）: 横断歩道の 1 m 手前。交差点へ向かう車の右側（u の向きから見て右 = -n 側）
      const d = c.len / 2 + 1.15;
      const sx = c.x + c.ux * d, sz = c.z + c.uz * d;
      const o0 = c.stop === 'full' ? -c.half + 0.2 : 0.1, o1 = c.half - 0.2;
      const mid = (o0 + o1) / 2;
      // 交差点へ向かう向き（-u）の右は (uz, -ux) = -n
      rect(mark, sx - nx * mid, sz - nz * mid, nx, nz, (o1 - o0) / 2, 0.15, colors.white);
    }
  }
  // 横断歩道の脇の歩道の縁に、黒い細い車止め（potelets、9 cm 角・高さ 1 m）を 2 本ずつ（写真 sidewalk-curb-2・
  // ユーザーの写真 chateau-deau）。中心部の横断歩道の、計画で選んだ角（c.posts のビット）だけ。
  // 歩道の上（一段高い所）にだけ立てる。その所の縁石を書くタイル（車止めの横の中心線の点がある範囲）が立てる
  const pad = 8;
  for (const c of plan.crossings) {
    if (!c.posts || c.x < clip.minX - pad || c.x >= clip.maxX + pad || c.z < clip.minZ - pad || c.z >= clip.maxZ + pad) continue;
    const nx = -c.uz, nz = c.ux;
    let corner = 0;
    for (const s of [1, -1]) {
      const off = s * (c.half + CURB_W + 0.35);
      for (const d of [1, -1]) {
        if (!((c.posts >> corner++) & 1)) continue;
        for (let k = 0; k < 2; k++) {
          const along = d * (c.len / 2 + 0.55 + k * 1.25);
          const cx = c.x + c.ux * along, cz = c.z + c.uz * along;
          if (!inClip(cx, cz)) continue;
          const px = cx + nx * off, pz = cz + nz * off;
          const h = raised.heightAt(px, pz);
          if (h < 0.02) continue;
          writePost(out('post'), px, pz, h, colors.post, c.ux, c.uz);
          stats.posts++;
          stats.postPts.push([px, pz]);
        }
      }
    }
  }
  return stats;
}

// 車止め（potelet）: 縁石に向きをそろえた 9 cm 角・高さ 1 m の柱と、平らな頭（10 三角形。数が多いので円柱にはしない）
const POST_R = 0.045, POST_H = 1.0;
export const POST_HIT = 0.08; // 車止めの当たり判定の半径
export function writePost(w, x, z, y0, color, ux = 1, uz = 0) {
  const top = y0 + POST_H;
  const c = [[1, 1], [-1, 1], [-1, -1], [1, -1]].map(([a, b]) => [x + (ux * a - uz * b) * POST_R, z + (uz * a + ux * b) * POST_R]);
  for (let i = 0; i < 4; i++) {
    const p = c[i], q = c[(i + 1) % 4];
    const mx = (p[0] + q[0]) / 2 - x, mz = (p[1] + q[1]) / 2 - z, L = Math.hypot(mx, mz) || 1;
    w.quad([p[0], y0, p[1]], [q[0], y0, q[1]], [q[0], top, q[1]], [p[0], top, p[1]], [mx / L, 0, mz / L], [0, 0], [0, 0], [0, 0], [0, 0], color);
  }
  w.quad([c[0][0], top, c[0][1]], [c[1][0], top, c[1][1]], [c[2][0], top, c[2][1]], [c[3][0], top, c[3][1]], UP, [0, 0], [0, 0], [0, 0], [0, 0], color);
}

// 中心 (x, z)、長い向き (ux, uz) に半長 a・半幅 b の長方形（路面標示）
function rect(w, x, z, ux, uz, a, b, color) {
  const nx = -uz, nz = ux, y = 0;
  const p = (s, t) => [x + ux * s + nx * t, y, z + uz * s + nz * t];
  w.quad(p(-a, -b), p(a, -b), p(a, b), p(-a, b), UP, [0, 0], [1, 0], [1, 1], [0, 1], color);
}

function boundsOf(road) {
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
  for (const [x, z] of road.pts) {
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minZ = Math.min(minZ, z);
    maxZ = Math.max(maxZ, z);
  }
  return { minX, minZ, maxX, maxZ };
}

function clipParts(road, clip) {
  return clipPolylineToRect(road.pts, clip.minX, clip.minZ, clip.maxX, clip.maxZ);
}

function c3n(hex) {
  // sRGB の 16 進数を線形の色に（THREE.Color と同じ変換）
  const f = (v) => {
    const c = v / 255;
    return c < 0.04045 ? c * 0.0773993808 : Math.pow(c * 0.9478672986 + 0.0521327014, 2.4);
  };
  return [f((hex >> 16) & 255), f((hex >> 8) & 255), f(hex & 255)];
}
