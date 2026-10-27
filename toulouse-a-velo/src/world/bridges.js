// 橋の形（ground.js の buildGroundDetail から、橋の中ほどの点が入る範囲で作る）。
//
// - 深い水（ガロンヌ川）を渡る石の橋: 水の区間に橋脚とアーチを並べ、アーチの面の迫石（せりいし）の輪、アーチの下面
//   （レンガのヴォールト）、アーチの間の壁（スパンドレル）、上流・下流に尖った水切りと段々の石のピラミッドの笠を作る。
//   ポン・ヌフは写真と実物の寸法を手本に、大きさの違う 7 つのかご形のアーチ（中ほどがいちばん大きい約 30 m）、
//   白い石の迫石とレンガが交互のアーチの輪、橋脚の上を貫く丸い穴（デグロワール、直径約 4 m、石の縁取り）、
//   橋脚の下の低い石の台、両側の欄干の白鳥の首の街灯（吊り下げの灯具 1 つ、25〜30 m おき）、淡い花崗岩の板の歩道。
// - 近代の橋（ポン・サン・ピエール、ポン・サン・ミシェル、歩道橋、高速道路など、石の橋の一覧にないもの）: 薄いコンクリートの桁と細い橋脚。
// - 浅い水（運河）や道路の上の橋: 平らな橋（側面と底）。
// 橋の側面は、橋の軸に沿った距離 s と高さ y の 2 次元で組み立てて、橋の折れ線に沿って 3D に置く。
// 車道の橋に歩道の橋が並ぶ（別の way）ときは、いちばん主要な way（親）が並んだ way の分まで幅を広げて橋の本体を作り、
// 並んだ way は橋面と欄干だけを作る（アーチや橋脚が重ならないように）。
import * as THREE from 'three';
import { MeshWriter } from './meshwriter.js';
import { CAR_ROADS } from './parse.js';
import { Grid, clipPolylineToRect, closestOnSegment } from '../geo.js';
import { offsets, roadStyle } from './ground.js';
import { DATUM } from './terrain.js';
import { cleanProfile, fitDeckEnds, segmentsCross } from './terraincond.js';
import { laneLayout, writeRoadMarkings } from './markings.js';

const c3 = (hex, k = 1) => {
  const c = new THREE.Color(hex);
  return [c.r * k, c.g * k, c.b * k];
};
// 白っぽいレンガ模様のテクスチャ（plain、平均の明るさ約 0.85）に掛ける色なので、写真の色より少し明るくする
const T = (hex, k = 1) => c3(hex, 1.16 * k);

export const ARCH_MIN_DEPTH = 3; // これより深い水を渡る区間にだけアーチと橋脚を作る（m）
const CORNICE = -0.9; // 側面の蛇腹（コーニス）の下端。ここから上は橋面の way ごとに欄干と一緒に作る
const LAND_BOTTOM = -1.3; // 平らな橋・陸の上の橋の底
const SLAB_BOTTOM = -1.5; // 近代の橋の桁の下面
const FLAT_UV = [0.5, 0.5]; // 模様のない面（壁のテクスチャの 1 点）
const OVERPASS_DEPTH = 1.6; // 陸の上の高架の桁の深さ（利用者のストリートビュー: A620 の桁は約 1.5 m の平らなコンクリート）
const PARAPET = 1.05; // 欄干の高さ
const PONT_NEUF_HALF = 10.5; // ポン・ヌフの幅の半分（実物は欄干の外まで約 21 m）
// ポン・ヌフ: 左岸（西）から右岸へ、7 つのアーチの径間と 6 つの橋脚の厚み（m、水の区間の長さに合わせて伸縮）
export const PONT_NEUF = { spans: [14.4, 20.4, 25.0, 31.7, 28.6, 25.4, 22.0], piers: [6.2, 6.6, 7.0, 7.2, 7.0, 6.6] };
// 石・レンガのアーチ橋として作る橋の名前（データに橋の構造・材料のタグがないので、実物が石積みの橋だけを挙げる）。
// ほかの深い水を渡る橋は近代の橋
const TRUSS_NAME = /^pont saint[- ]pierre$/i;
export const MASONRY_NAME = /^pont (neuf|des catalans|de la croix[- ]de[- ]pierre|de tounis)$/i;
// 高速道路・幹線道路（とそのランプ）を含むまとまりは、名前によらず近代の橋
const MOTOR_TYPES = new Set(['motorway', 'motorway_link', 'trunk', 'trunk_link']);
// 並んだ way のまとまりの親を選ぶ順位（大きいほど親になる）。ランプは本線より下、歩道より上
const RANK = {
  motorway: 10, trunk: 9, primary: 8, secondary: 7, tertiary: 6, unclassified: 5, residential: 5, living_street: 4, service: 4,
  motorway_link: 3, trunk_link: 3, primary_link: 3, secondary_link: 3, tertiary_link: 3, pedestrian: 2, track: 2,
};
const rankOf = (r) => RANK[r.type] ?? 1;

const COL = {
  brick: T('#b9815c'), // スパンドレルの細長いレンガ
  vault: T('#a26a4b'), // アーチの下面（全面レンガ）
  stone: T('#c3b9a7'), // 迫石
  stoneWarm: T('#cbb995'), // 黄色みのある迫石（縁取りで交互に）
  ashlar: T('#c9bfae'), // 橋脚の切石
  nose: T('#d6c3a0'), // 水切り
  footing: T('#b9a77a'), // 橋脚の下の台
  cornice: T('#b3a58c'),
  parapet: T('#d9cfbd'), // 淡い石の欄干（写真 10・11）
  coping: T('#e3dacb'),
  flat: T('#c58a6e'),
  concrete: T('#b7b3ab'),
  soffit: T('#8f979c'),
  concreteDark: T('#9a978f'),
  railing: T('#56697c'), // 高架の鉄の手すり（青灰色）
  steel: T('#7f8a93'), // サン・ピエール橋の鋼のトラス（利用者の写真 NCM_0105: 明るい灰色 #7a8590）
  pierBrick: T('#9a7464'),
  lamp: T('#8a9890'), // 明るい灰緑の鋳鉄（利用者の写真 0310_160523254: #8f948c 前後。日なたで茶色く見えないよう緑に寄せる）
  globe: T('#f1eee4'),
  brass: T('#b08d4a'), // 灯具の真鍮の帯
};

// 淡いコンクリートのアーチ橋（利用者の写真 NCM_0102・0103: Pont des Catalans は 1913 年の淡い灰色のコンクリート #b8b4ac）。
// 石の橋と同じ形で、レンガ・石の色だけ淡い灰色に替える（withPalette）
const PALE_NAME = /^pont des catalans$/i;
const PALE = {
  brick: T('#bdb8ae'), vault: T('#a9a49b'), stone: T('#c9c4ba'), stoneWarm: T('#c4bfb5'), ashlar: T('#c3beb4'),
  nose: T('#cfcac0'), footing: T('#b1aca2'), cornice: T('#bab5ab'), parapet: T('#d2cdc3'), coping: T('#dcd7cd'),
};
function withPalette(pal, fn) {
  if (!pal) return fn();
  const saved = {};
  for (const k of Object.keys(pal)) [saved[k], COL[k]] = [COL[k], pal[k]];
  try {
    return fn();
  } finally {
    Object.assign(COL, saved);
  }
}

export function deckHalf(road) {
  // ポン・ヌフは欄干の外まで約 21 m（歩道の上も橋面の高さ。地図の車道の幅だけだと歩道の所で橋の下の地面に落ちた）
  if (road.name === 'Pont Neuf' && CAR_ROADS.has(road.type)) return PONT_NEUF_HALF;
  return road.width / 2 + (CAR_ROADS.has(road.type) ? 2 : 0.3);
}

// ---- 折れ線に沿った距離 s で位置を引く ----
export function polyFrame(pts) {
  const cum = [0];
  for (let i = 0; i + 1 < pts.length; i++) cum.push(cum[i] + Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]));
  const length = cum[cum.length - 1];
  // s のある区間と、その中での割合（両端の外は端の区間を延ばす）
  const locate = (s) => {
    let i = 0;
    while (i < cum.length - 2 && s > cum[i + 1]) i++;
    return [i, (s - cum[i]) / (cum[i + 1] - cum[i] || 1)];
  };
  const tangent = (i) => {
    const dx = pts[i + 1][0] - pts[i][0], dz = pts[i + 1][1] - pts[i][1];
    const l = Math.hypot(dx, dz) || 1;
    return [dx / l, dz / l];
  };
  // line: pts と同じ点数の線（左右にずらした線など）の上で、中心線の距離 s に当たる点
  const at = (line, s) => {
    const [i, f] = locate(s);
    return [line[i][0] + (line[i + 1][0] - line[i][0]) * f, line[i][1] + (line[i + 1][1] - line[i][1]) * f];
  };
  return { cum, length, locate, tangent, at };
}

// ---- 並んだ way のまとまり ----
// 返り値: Map(road → { half: 橋面の幅の半分, root: 本体を作る親の way, extL/extR/members: 親だけ、本体の左右の幅とまとまりの way })
const groupCache = new WeakMap();
export function bridgeGroups(roads) {
  let info = groupCache.get(roads);
  if (info) return info;
  info = new Map();
  const list = roads.filter((r) => r.bridge && !r.tunnel && r.pts.length >= 2);
  const box = (r) => {
    let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
    for (const [x, z] of r.pts) {
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
    }
    return { minX, minZ, maxX, maxZ };
  };
  const better = (a, b) => {
    if (rankOf(a) !== rankOf(b)) return rankOf(a) > rankOf(b);
    if (a.width !== b.width) return a.width > b.width;
    return (a.id ?? 0) < (b.id ?? 0);
  };
  const near = (pts, x, z) => {
    let best = null;
    for (let i = 0; i + 1 < pts.length; i++) {
      const c = closestOnSegment(x, z, pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]);
      if (!best || c.d2 < best.d2) best = { ...c, i };
    }
    const dx = pts[best.i + 1][0] - pts[best.i][0], dz = pts[best.i + 1][1] - pts[best.i][1];
    const l = Math.hypot(dx, dz) || 1;
    best.u = [dx / l, dz / l];
    best.lat = (x - best.x) * (-dz / l) + (z - best.z) * (dx / l); // 左（offsets の L 側）が正
    best.clamped = (best.i === 0 && best.t <= 1e-6) || (best.i === pts.length - 2 && best.t >= 1 - 1e-6); // 線の端より外
    return best;
  };
  const sampleAt = (r, ts) => {
    const fr = polyFrame(r.pts);
    return ts.map((t) => ({ p: fr.at(r.pts, fr.length * t), u: fr.tangent(fr.locate(fr.length * t)[0]) }));
  };
  const items = list.map((r) => ({ r, b: box(r), half: deckHalf(r), parent: null, members: [] }));
  const grid = new Grid(60);
  items.forEach((it, i) => grid.insertBounds(it.b.minX, it.b.minZ, it.b.maxX, it.b.maxZ, i));
  for (const it of items) {
    const ss = sampleAt(it.r, [0.25, 0.5, 0.75]);
    let bestD = Infinity;
    const seen = new Set();
    grid.queryPoint(ss[1].p[0], ss[1].p[1], 40, (j) => {
      const o = items[j];
      if (o === it || seen.has(j) || !better(o.r, it.r)) return;
      seen.add(j);
      // 同じ名前の平行な道（2 本に分かれた車道）は、もう少し離れていても 1 つの本体に（間の水にすき間ができないように）
      const lim = it.half + o.half + 3 + (it.r.name && it.r.name === o.r.name ? 8 : 0);
      let sum = 0;
      for (const s of ss) {
        const c = near(o.r.pts, s.p[0], s.p[1]);
        if (c.d2 > lim * lim || Math.abs(c.u[0] * s.u[0] + c.u[1] * s.u[1]) < 0.8) return;
        sum += Math.sqrt(c.d2);
      }
      if (sum < bestD) {
        bestD = sum;
        it.parent = o;
      }
    });
  }
  const rootOf = (it) => {
    while (it.parent) it = it.parent;
    return it;
  };
  const regroup = () => {
    for (const it of items) it.members = [];
    for (const it of items) rootOf(it).members.push(it);
  };
  const T5 = [0.1, 0.3, 0.5, 0.7, 0.9];
  // way m の橋面の、親 it の中心線からの横の範囲 [右端, 左端]（親の端より外の点は数えない）。parallel: 親と平行な所だけ
  const lateral = (it, m, parallel = false) => {
    let lo = Infinity, hi = -Infinity;
    for (const s of sampleAt(m.r, T5)) {
      const c = near(it.r.pts, s.p[0], s.p[1]);
      if (c.clamped || (parallel && Math.abs(c.u[0] * s.u[0] + c.u[1] * s.u[1]) < 0.8)) continue;
      lo = Math.min(lo, c.lat - m.half);
      hi = Math.max(hi, c.lat + m.half);
    }
    return lo <= hi ? [lo, hi] : null;
  };
  const near2 = (a, b, pad) => a.minX - pad <= b.maxX && b.minX - pad <= a.maxX && a.minZ - pad <= b.maxZ && b.minZ - pad <= a.maxZ;
  // 親の本体は並んだ way の分まで、親の全長にわたって広がる。その広げた所（並んだ way の列）に、ほかのまとまりの橋が
  // 並んでいるとき（片側の車道が 2 本の way に分かれ、別々の親についた所など）は、本体どうしが重なるので、
  // 並んだ way を親から外して自分で本体を作る
  for (let pass = 0; pass < 3; pass++) {
    regroup();
    let changed = false;
    for (const it of items) {
      if (it.parent) continue;
      for (const m of it.members) {
        if (m === it) continue;
        const e = lateral(it, m);
        if (!e) continue;
        const lanes = [];
        if (e[1] > it.half + 0.5) lanes.push([Math.max(e[0], it.half), e[1]]);
        if (e[0] < -it.half - 0.5) lanes.push([e[0], Math.min(e[1], -it.half)]);
        const clash = lanes.length && items.some((o) => {
          if (rootOf(o) === it || !near2(o.b, it.b, 30)) return false;
          const f = lateral(it, o, true);
          return f && lanes.some(([a, b]) => Math.min(f[1], b) - Math.max(f[0], a) > 0.5);
        });
        if (clash) {
          m.parent = null;
          changed = true;
        }
      }
    }
    if (!changed) break;
  }
  regroup();
  for (const it of items) {
    const root = rootOf(it);
    const v = { half: it.half, root: root.r };
    info.set(it.r, v);
  }
  // 親: 並んだ way の外側の縁までを本体の幅にする。ポン・ヌフ（1 本の way だけのとき）は実物の幅に
  for (const it of items) {
    if (it.parent) continue;
    const v = info.get(it.r);
    v.members = it.members.map((m) => m.r);
    if (it.members.length === 1 && it.r.name === 'Pont Neuf' && CAR_ROADS.has(it.r.type)) v.half = Math.max(v.half, PONT_NEUF_HALF);
    let L = v.half, R = v.half;
    for (const m of it.members) {
      if (m === it) continue;
      const e = lateral(it, m);
      if (!e) continue;
      L = Math.max(L, e[1]);
      R = Math.max(R, -e[0]);
    }
    v.extL = L;
    v.extR = R;
  }
  // 橋面の上かどうか（欄干を立てるか、当たり判定）
  const segs = [];
  const segGrid = new Grid(20);
  for (const it of items) {
    const half = info.get(it.r).half;
    for (let i = 0; i + 1 < it.r.pts.length; i++) {
      const [ax, az] = it.r.pts[i], [bx, bz] = it.r.pts[i + 1];
      segGrid.insertSegment(ax, az, bx, bz, segs.length);
      segs.push({ ax, az, bx, bz, half, road: it.r });
    }
  }
  info.onDeck = (x, z, self = null, inset = 0.1) => {
    let hit = false;
    segGrid.queryPoint(x, z, 25, (i) => {
      const s = segs[i];
      if (hit || s.road === self) return;
      if (closestOnSegment(x, z, s.ax, s.az, s.bx, s.bz).d2 < (s.half - inset) ** 2) hit = true;
    });
    return hit;
  };
  groupCache.set(roads, info);
  return info;
}

// 当たり判定用: 橋面（欄干の内側）の上なら true（橋の上では水に落ちない）
export function makeDeckTest(roads) {
  const info = bridgeGroups(roads);
  return (x, z) => info.onDeck(x, z, null, 0.5);
}

// ---- アーチの並べ方（純粋な計算） ----

// 橋の軸に沿って step ごとに測った水の深さ depths（depths[i] は s = (i + 0.5) * step）から、深い水を渡る区間
// { s0, s1, depth } の一覧を返す。8 m より短い陸のすき間はつなぎ、6 m より短い区間は捨てる
export function wetIntervals(depths, step, minDepth = ARCH_MIN_DEPTH) {
  const out = [];
  let cur = null;
  depths.forEach((d, i) => {
    if (!(d > minDepth)) return;
    const s = i * step;
    if (cur && s - cur.s1 < 8) {
      cur.s1 = s + step;
      cur.depth = Math.max(cur.depth, d);
    } else out.push((cur = { s0: s, s1: s + step, depth: d }));
  });
  return out.filter((w) => w.s1 - w.s0 >= 6);
}

// 水の区間 [s0, s1] にアーチと橋脚を並べる。spans/piers を渡すとその比率で（区間の長さに合わせて伸縮、reverse で逆順）、
// なければ target 前後（minSpan〜maxSpan）の等しい径間。返り値: arches [{ c: 中心の s, a: 径間の半分 }]、piers [{ s0, s1 }]
export function archLayout(s0, s1, { spans = null, piers = null, reverse = false, target = 32, minSpan = 25, maxSpan = 40 } = {}) {
  const W = s1 - s0;
  let sp, pr;
  if (spans) {
    const total = spans.reduce((a, b) => a + b, 0) + piers.reduce((a, b) => a + b, 0);
    const k = W / total;
    sp = spans.map((x) => x * k);
    pr = piers.map((x) => x * k);
    if (reverse) {
      sp.reverse();
      pr.reverse();
    }
  } else {
    // 径間が target にいちばん近くなる数（比で比べる）。maxSpan を超えるものは、ほかに選べるなら選ばない
    const p = Math.max(3, target * 0.17);
    const spanOf = (m) => (W - (m - 1) * p) / m;
    let n = 1, best = Infinity;
    for (let m = 1; spanOf(m) >= Math.min(minSpan * 0.6, W); m++) {
      const cost = Math.abs(Math.log(spanOf(m) / target)) + (spanOf(m) > maxSpan ? 10 : 0);
      if (cost < best) {
        best = cost;
        n = m;
      }
    }
    sp = new Array(n).fill(spanOf(n));
    pr = new Array(n - 1).fill(p);
  }
  const arches = [], pierList = [];
  let s = s0;
  sp.forEach((span, i) => {
    arches.push({ c: s + span / 2, a: span / 2 });
    s += span;
    if (i < pr.length) {
      pierList.push({ s0: s, s1: s + pr[i] });
      s += pr[i];
    }
  });
  return { arches, piers: pierList };
}

// アーチの高さ: 起拱線（アーチの付け根）は水面の 0.7 m 上、要石の下は蛇腹から迫石の輪の分だけ下まで
export function archRise(a, depth, ring) {
  const spring = -depth + 0.7;
  const crownMax = CORNICE - ring - 0.25;
  return { spring, rise: Math.max(0, Math.min(crownMax - spring, 0.3 * 2 * a)) };
}

// ---- メッシュ ----

// ---- 地形があるときの橋の高さ ----
// 橋のまとまり（親の way）ごとの橋面の縦断面を地形に登録する（terrain.deck）。事前取得で表面モデルから測った縦断面
// （両端の緯度経度で合わせる）があればそれ、なければ両端の地面を結ぶ線に少し山なりを足したもの。両端は 30 m かけて
// 地面の高さに合わせる（取り付けの道路と段差ができないように）。戻り値: 親の way → 縦断面 { pts, y, step, length, half }
const deckCache = new WeakMap();
export function setupDecks(terrain, roads, proj, waterDepthAt = () => 0) {
  if (!terrain || terrain.flat) return new Map();
  const info = bridgeGroups(roads);
  const baked = (terrain.profiles || []).map((b) => ({ ...b, pa: proj.project(...b.a), pb: proj.project(...b.b) }));
  const near = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]) < 3;
  const out = new Map();
  const raw = [], seen = new Set();
  for (const v of info.values()) {
    const r = v.root;
    if (seen.has(r)) continue;
    seen.add(r);
    const fr = polyFrame(r.pts), L = fr.length, step = 5;
    const p0 = r.pts[0], p1 = r.pts[r.pts.length - 1];
    const b = baked.find((e) => near(e.pa, p0) && near(e.pb, p1));
    const n = Math.max(2, Math.ceil(L / step) + 1);
    const h0 = terrain.h(p0[0], p0[1]), h1 = terrain.h(p1[0], p1[1]);
    // 測った縦断面（外れ値を捨てる。信用できなければ両端の地面を結ぶ直線 + ゆるいアーチ）
    let y = null;
    if (b) {
      const ys = [];
      for (let k = 0; k < n; k++) ys.push(b.y[Math.min(b.y.length - 1, Math.round(Math.min(L, k * step) / step))] - DATUM);
      y = cleanProfile(ys);
    }
    if (!y) {
      y = [];
      for (let k = 0; k < n; k++) {
        const t = Math.min(L, k * step) / (L || 1);
        y.push(h0 + (h1 - h0) * t + Math.min(1.2, 0.01 * L) * 4 * t * (1 - t));
      }
    }
    raw.push({ r, y, L, step, p0, p1, h0, h1, measured: !!b });
  }
  // 両端の高さ: ふつうの道路につながる端は地面（取り付ける道路の高さ）、ほかの橋の端とだけつながる所（高架の続き）は両方の端の平均。
  // 差が大きいときは橋の中に長い坂を作る（fitDeckEnds）。どの橋も、端では必ず道路とつながる
  const ends = [];
  raw.forEach((e, i) => {
    ends.push({ i, k: 0, p: e.p0, y: e.y[0] });
    ends.push({ i, k: 1, p: e.p1, y: e.y[e.y.length - 1] });
  });
  const endGrid = new Grid(20);
  ends.forEach((e, j) => endGrid.insertPoint(e.p[0], e.p[1], j));
  // 橋ではない道路の点（橋の端がふつうの道路につながるか）
  const roadNodes = new Grid(20);
  for (const o of roads) if (!o.bridge && !o.tunnel) for (const q of o.pts) roadNodes.insertPoint(q[0], q[1], q);
  const onLand = (p) => {
    let hit = false;
    roadNodes.queryPoint(p[0], p[1], 1.5, (q) => {
      if (!hit && Math.hypot(q[0] - p[0], q[1] - p[1]) < 1.5) hit = true;
    });
    return hit;
  };
  const target = (e, i, k) => {
    const p = k ? e.p1 : e.p0;
    if (onLand(p)) return k ? e.h1 : e.h0;
    const mates = [];
    endGrid.queryPoint(p[0], p[1], 2, (j) => {
      const o = ends[j];
      if (o.i !== i && Math.hypot(o.p[0] - p[0], o.p[1] - p[1]) < 2) mates.push(o.y);
    });
    if (!mates.length) return k ? e.h1 : e.h0;
    const own = k ? e.y[e.y.length - 1] : e.y[0];
    return (own + mates.reduce((s, v) => s + v, 0)) / (mates.length + 1);
  };
  const targets = raw.map((e, i) => [target(e, i, 0), target(e, i, 1)]);
  raw.forEach((e, i) => {
    const { r } = e;
    const y = fitDeckEnds(e.y, e.step, e.L, targets[i][0], targets[i][1]);
    const { step, L } = e;
    // 半幅: 並んだ way（歩道橋など）も含めた橋全体
    let half = deckHalf(r);
    for (const [m, mv] of info) {
      if (mv.root !== r || m === r) continue;
      const mid = m.pts[m.pts.length >> 1];
      let d2 = Infinity;
      for (let i = 0; i + 1 < r.pts.length; i++) d2 = Math.min(d2, closestOnSegment(mid[0], mid[1], ...r.pts[i], ...r.pts[i + 1]).d2);
      half = Math.max(half, Math.sqrt(d2) + deckHalf(m));
    }
    out.set(r, { pts: r.pts, y, step, length: L, half: half + 0.3, measured: e.measured });
  });
  terrain.setDecks([...out.values()]);
  deckCache.set(terrain, out);
  terrain.abutments = abutmentWalls(terrain, roads, waterDepthAt);
  return out;
}

// 陸の上の高速道路の高架の下をくぐる車道の両脇の擁壁（ユーザーのストリートビュー: A620 の下の Grande-Bretagne 通りは、
// 盛り土を支える淡いコンクリートの垂直な壁に赤い帯）。高架と交わる車道に沿って、交わる所から前後 ABUT_REACH m まで
// ABUT_STEP m ごとに道の縁から外へ地面を測り、道より 1 m 以上高くなる所（盛り土の斜面）があれば、その手前の足元に盛り土の上
// （その先 10 m の最高）までの壁を立てる（道より ABUT_RISE m 以上高い所だけ）。ほかの道（盛り土を上る坂・階段）を横切る壁は捨てる。
// 返り値: [{ ax, az, at, ab, bx, bz, bt, bb, nx, nz }]（at/ab: 上端・下端の y。n: 道の側に向く水平の向き）
// 利用者のストリートビュー 210711: 擁壁は高架の下の短い橋台だけで、その手前は木と草の盛り土の斜面
const ABUT_REACH = 30, ABUT_STEP = 2, ABUT_RISE = 1.8;
export function abutmentWalls(terrain, roads, waterDepthAt = () => 0) {
  if (!terrain || terrain.flat || !terrain.deck) return [];
  const og = new Grid(50), osegs = [];
  for (const r of roads) {
    if (!r.bridge || r.tunnel || !MOTOR_TYPES.has(r.type)) continue;
    for (let i = 0; i + 1 < r.pts.length; i++) {
      og.insertSegment(...r.pts[i], ...r.pts[i + 1], osegs.length);
      osegs.push([...r.pts[i], ...r.pts[i + 1]]);
    }
  }
  if (!osegs.length) return [];
  const all = new Grid(30), segs = [];
  for (const r of roads) {
    if (r.tunnel || (r.layer || 0) < 0) continue;
    for (let i = 0; i + 1 < r.pts.length; i++) {
      all.insertSegment(...r.pts[i], ...r.pts[i + 1], segs.length);
      segs.push([r, ...r.pts[i], ...r.pts[i + 1]]);
    }
  }
  const out = [];
  for (const road of roads) {
    if (!CAR_ROADS.has(road.type) || road.bridge || road.tunnel || road.pts.length < 2) continue;
    const fr = polyFrame(road.pts);
    // 高架と交わる所（道からの距離 s）。橋面が道より 3 m 以上高いものだけ
    const hits = [];
    for (let i = 0; i + 1 < road.pts.length; i++) {
      const [ax, az] = road.pts[i], [bx, bz] = road.pts[i + 1];
      og.query(Math.min(ax, bx), Math.min(az, bz), Math.max(ax, bx), Math.max(az, bz), (k) => {
        const [cx, cz, dx, dz] = osegs[k];
        if (!segmentsCross(ax, az, bx, bz, cx, cz, dx, dz)) return;
        const den = (bx - ax) * (dz - cz) - (bz - az) * (dx - cx);
        if (Math.abs(den) < 1e-9) return;
        const t = ((cx - ax) * (dz - cz) - (cz - az) * (dx - cx)) / den;
        const x = ax + (bx - ax) * t, z = az + (bz - az) * t;
        const D = terrain.deck(x, z);
        if (D != null && D - terrain.h(x, z) > 3) hits.push(fr.cum[i] + t * Math.hypot(bx - ax, bz - az));
      });
    }
    if (!hits.length) continue;
    const ss = [];
    for (let s = 0; s <= fr.length; s += ABUT_STEP) if (hits.some((h) => Math.abs(s - h) <= ABUT_REACH)) ss.push(s);
    const hw = road.width / 2;
    for (const sd of [1, -1]) {
      let prev = null;
      const run = [];
      const flush = () => {
        // 上端を前後の 3 点でならして、隣どうしを壁でつなぐ
        const tops = run.map((p, i) => (run[Math.max(0, i - 1)].top + p.top + run[Math.min(run.length - 1, i + 1)].top) / 3);
        for (let i = 0; i + 1 < run.length; i++) {
          const A = run[i], B = run[i + 1];
          out.push({ ax: A.x, az: A.z, at: tops[i], ab: A.bot, bx: B.x, bz: B.z, bt: tops[i + 1], bb: B.bot, nx: A.nx, nz: A.nz, road });
        }
        run.length = 0;
      };
      for (const s of ss) {
        if (prev != null && s - prev > ABUT_STEP + 1e-6) flush();
        prev = s;
        const [x, z] = fr.at(road.pts, s), [ux, uz] = fr.tangent(fr.locate(s)[0]);
        const nx = -uz * sd, nz = ux * sd, y0 = terrain.h(x, z);
        if (waterDepthAt(x, z) > 0) {
          flush();
          continue;
        }
        let foot = hw + 0.5, rise = 0;
        for (let d = hw + 0.5; d <= hw + 25; d += 0.5) {
          const y = terrain.h(x + nx * d, z + nz * d) - y0;
          if (y < 0.4) foot = d;
          else if (y > 1) {
            rise = d;
            break;
          }
        }
        let top = -Infinity;
        if (rise) for (let d = rise; d <= rise + 10; d += 1) top = Math.max(top, terrain.h(x + nx * d, z + nz * d));
        if (!rise || top - y0 < ABUT_RISE) {
          flush();
          continue;
        }
        const px = x + nx * foot, pz = z + nz * foot;
        run.push({ x: px, z: pz, top, bot: terrain.h(px, pz) - 0.3, nx: -nx, nz: -nz });
      }
      flush();
    }
  }
  // ほかの道（盛り土を上る坂・階段・歩道）を横切る壁は捨てる
  return out.filter((w) => {
    let hit = false;
    all.query(Math.min(w.ax, w.bx), Math.min(w.az, w.bz), Math.max(w.ax, w.bx), Math.max(w.az, w.bz), (k) => {
      const [r, cx, cz, dx, dz] = segs[k];
      if (!hit && r !== w.road && segmentsCross(w.ax, w.az, w.bx, w.bz, cx, cz, dx, dz)) hit = true;
    });
    // 壁の裏（盛り土の側）のすぐそばを別の車道が壁の足元と同じ高さで通るなら、そこは盛り土ではなく分離帯（上下線の分かれた通りの
    // 真ん中。利用者のストリートビュー 225619: Grande-Bretagne 通りの高架の下に、車線のあいだの壁はない）
    const mx = (w.ax + w.bx) / 2, mz = (w.az + w.bz) / 2;
    for (const d of [1.5, 4, 7, 10]) {
      if (hit) break;
      const qx = mx - w.nx * d, qz = mz - w.nz * d;
      all.queryPoint(qx, qz, 20, (k) => {
        const [r, cx, cz, dx, dz] = segs[k];
        if (hit || r === w.road || r.bridge || !CAR_ROADS.has(r.type)) return;
        if (closestOnSegment(qx, qz, cx, cz, dx, dz).d2 < (r.width / 2 + 0.5) ** 2 && terrain.h(qx, qz) < (w.ab + w.bb) / 2 + 1.5) hit = true;
      });
    }
    delete w.road;
    return !hit;
  });
}

// 擁壁の形: 道の側の面（ベージュのコンクリートに、上から 0.5 m と 0.83 m の細いテラコッタの帯）、厚さ 0.4 m の笠と裏の面
const ABUT_COL = { face: T('#cbc2b2'), band: T('#b5654c'), cap: T('#d0ccc4') }; // 利用者の Street View 225619: ベージュのコンクリートに細いテラコッタの帯 2 本
export function buildAbutments(list, mats) {
  const w = new MeshWriter();
  for (const q of list) {
    let { ax, az, at, ab, bx, bz, bt, bb } = q;
    const { nx, nz } = q;
    // 表の面（反時計回り）が n を向く並び
    if ((bx - ax) * nz - (bz - az) * nx < 0) [ax, az, at, ab, bx, bz, bt, bb] = [bx, bz, bt, bb, ax, az, at, ab];
    const L = Math.hypot(bx - ax, bz - az), th = 0.4, px = -nx * th, pz = -nz * th;
    const face = (y0a, y0b, y1a, y1b, color) => {
      if (y1a <= y0a && y1b <= y0b) return;
      w.quad([ax, y0a, az], [bx, y0b, bz], [bx, y1b, bz], [ax, y1a, az], [nx, 0, nz], FLAT_UV, FLAT_UV, FLAT_UV, FLAT_UV, color); // 打ち放しのコンクリート（模様なし）
    };
    // 上端から下へ: 面 0.5 m・帯 0.12 m・面 0.21 m・帯 0.12 m・残りは面（壁が低ければ下端で切る）
    const F = ABUT_COL.face, B = ABUT_COL.band;
    for (const [d0, d1, color] of [[0, 0.5, F], [0.5, 0.62, B], [0.62, 0.83, F], [0.83, 0.95, B], [0.95, Infinity, F]]) {
      face(Math.max(ab, at - d1), Math.max(bb, bt - d1), Math.max(ab, at - d0), Math.max(bb, bt - d0), color);
    }
    w.quad([ax, at, az], [ax + px, at, az + pz], [bx + px, bt, bz + pz], [bx, bt, bz], [0, 1, 0], FLAT_UV, FLAT_UV, FLAT_UV, FLAT_UV, ABUT_COL.cap);
    w.quad([bx + px, bb, bz + pz], [ax + px, ab, az + pz], [ax + px, at, az + pz], [bx + px, bt, bz + pz], [-nx, 0, -nz], FLAT_UV, FLAT_UV, FLAT_UV, FLAT_UV, ABUT_COL.face);
  }
  const m = new THREE.Mesh(w.toGeometry(), mats.bridge);
  m.castShadow = true;
  m.receiveShadow = true;
  m.name = 'abutments';
  return m;
}

// 橋 root の頂点の高さの置き換え: 蛇腹より上（相対 y ≥ −1.5）は縦断面に載せ、下（アーチ・橋脚）は縦断面の 1.5 m 下から
// 水面（陸の上なら地面）まで引き延ばす。wet: 水の区間（相対の高さで作った水面の深さ depth。区間の外は最大の深さ）
// slab: 橋面からこの深さまでは橋面の縦断面に沿わせる（その下は水面・地面まで伸ばす）。陸の上の高架は桁の下面まで
function deckMap(terrain, prof, wet, waterDepthAt, slab = 1.5) {
  const dMax = Math.max(2, ...wet.map((w) => w.depth));
  const fr = polyFrame(prof.pts);
  const sAt = (x, z) => {
    let best = Infinity, s = 0;
    for (let i = 0; i + 1 < prof.pts.length; i++) {
      const c = closestOnSegment(x, z, ...prof.pts[i], ...prof.pts[i + 1]);
      if (c.d2 < best) {
        best = c.d2;
        s = fr.cum[i] + c.t * (fr.cum[i + 1] - fr.cum[i]);
      }
    }
    return s;
  };
  return (x, y, z) => {
    const s = sAt(x, z), D = terrain.deckY(prof, s);
    if (y >= -slab) return D + y;
    const dRef = Math.max(2, wet.find((w) => s >= w.s0 - 4 && s <= w.s1 + 4)?.depth ?? dMax);
    const low = waterDepthAt(x, z) > 0 ? terrain.waterLevel(x, z) : terrain.h(x, z);
    if (y < -dRef) return low + (y + dRef);
    const k = (D - 1.5 - low) / Math.max(0.5, dRef - 1.5);
    return D - 1.5 + (y + 1.5) * k;
  };
}

// 橋（tile の中の橋 bridges）を作る。allRoads: エリア全体の道路（並んだ橋のまとまりを調べる）。terrain: 地形（あれば橋面を縦断面に載せる）
export function buildBridges(bridges, allRoads, mats, waterDepthAt, clipRect, terrain = null) {
  const info = bridgeGroups(allRoads);
  const decks = terrain && !terrain.flat ? deckCache.get(terrain) : null;
  const deck = new MeshWriter(decks ? { maxEdge: 5 } : {});
  const body = new MeshWriter(decks ? { maxEdge: 5 } : {});
  const walk = new MeshWriter(decks ? { maxEdge: 5 } : {}); // 石の橋の歩道（花崗岩の板）
  const marks = new MeshWriter(decks ? { maxEdge: 5 } : {}); // 橋面の標示
  const writers = [deck, body, walk, marks];
  for (const road of bridges) {
    const v = info.get(road);
    if (!v) continue;
    const root = info.get(v.root);
    const prof = decks?.get(v.root);
    if (!root.style) root.style = bridgeStyle(v.root, root, waterDepthAt, prof ? (x, z) => terrain.waterLevel(x, z) : null, prof && ((s) => terrain.deckY(prof, s)));
    if (prof) {
      const map = deckMap(terrain, prof, root.style.wet, waterDepthAt, root.style.kind === 'overpass' ? OVERPASS_DEPTH + 0.01 : 1.5);
      for (const w of writers) w.map = map;
    }
    withPalette(PALE_NAME.test(v.root.name || '') ? PALE : null, () => {
      writeDeck({ deck, body, walk, marks }, road, v.half, root.style.kind, info, clipRect);
      if (v.root === road) {
        writeStructure(body, road, root, walk);
        // 陸の上の高架（A620 の Grande-Bretagne 通りの上。利用者のストリートビュー）は橋台から橋台まで 1 径間で、通りの中に橋脚はない
        if (prof && root.style.kind !== 'overpass') writeLandPiers(body, road, root, prof, terrain, waterDepthAt, Math.max(2, ...root.style.wet.map((w) => w.depth)));
      }
    });
    for (const w of writers) w.map = null;
  }
  const g = new THREE.Group();
  g.name = 'bridges';
  for (const [w, mat, order] of [[deck, mats.deck, 0], [walk, mats.deckWalk || mats.deck, 0], [marks, mats.deckMarks, 0.5]]) {
    if (w.empty || !mat) continue;
    const m = new THREE.Mesh(w.toGeometry(), mat);
    m.receiveShadow = true;
    m.renderOrder = order; // 標示は橋面の後に描く（深度を書かない）
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

// 陸の上の高い橋（道路・線路を越える橋）: 橋面が地面より 2.5 m 以上高い所に、約 25 m ごとにコンクリートの橋脚
function writeLandPiers(w, road, v, prof, terrain, waterDepthAt, dRef) {
  const fr = polyFrame(road.pts);
  const n = Math.floor(fr.length / 25);
  for (let k = 1; k <= n; k++) {
    const s = (fr.length * k) / (n + 1);
    const [x, z] = fr.at(road.pts, s);
    if (waterDepthAt(x, z) > 0) continue;
    const D = terrain.deckY(prof, s);
    if (D - terrain.h(x, z) < 2.5) continue;
    const [ux, uz] = fr.tangent(fr.locate(s)[0]);
    const off = ((v.extL ?? 3) - (v.extR ?? 3)) / 2;
    writePier(w, x - uz * off, z + ux * off, ux, uz, ((v.extL ?? 3) + (v.extR ?? 3)) * 0.3, 0.6, 1.2, SLAB_BOTTOM, -dRef - 0.6, COL.concreteDark);
  }
}

// 橋の種類と、水の区間ごとのアーチの並び。levelAt(x, z) / deckAt(s): 地形があるときの水面と橋面の高さ（水の区間の深さを
// 本当の橋面から水面までの高さにして、アーチの大きさを本物の橋に合わせる）
export function bridgeStyle(road, v, waterDepthAt, levelAt = null, deckAt = null) {
  const fr = polyFrame(road.pts);
  const step = 1.5;
  const depths = [];
  for (let s = step / 2; s < fr.length; s += step) {
    const [x, z] = fr.at(road.pts, s);
    depths.push(waterDepthAt(x, z));
  }
  const wet = wetIntervals(depths, step).map((w) => ({ ...w, s1: Math.min(w.s1, fr.length) }));
  if (levelAt && deckAt) {
    for (const w of wet) {
      const hs = [];
      for (let s = w.s0; s <= w.s1; s += 4) hs.push(deckAt(s) - levelAt(...fr.at(road.pts, s)));
      hs.sort((a, b) => a - b);
      if (hs.length) w.depth = Math.max(w.depth, Math.min(18, hs[hs.length >> 1]));
    }
  }
  const members = v.members || [road];
  // 陸の上の高速道路・幹線道路の高架（A620 の Grande-Bretagne 通りの上など。写真: 淡いコンクリートの桁と青灰色の鉄の手すり）
  if (!wet.length) return { kind: members.some((m) => MOTOR_TYPES.has(m.type)) ? 'overpass' : 'flat', wet };
  // サン・ピエール橋（利用者の写真 NCM_0105・0125）: レンガの橋脚 2 本の上の、下弦が弧になった鋼のトラス（3 径間）
  if (TRUSS_NAME.test(road.name || '')) return { kind: 'truss', wet };
  // 石の橋の一覧にない橋と、高速道路・幹線道路を含むまとまりは近代の橋
  if (!MASONRY_NAME.test(road.name || '') || members.some((m) => MOTOR_TYPES.has(m.type))) return { kind: 'modern', wet };
  const pontNeuf = road.name === 'Pont Neuf';
  const longest = wet.reduce((a, b) => (b.s1 - b.s0 > a.s1 - a.s0 ? b : a));
  for (const w of wet) {
    const ring = pontNeuf ? 1.1 : 0.9;
    // way の端が水の中（橋が何本かの way に分かれている）なら、継ぎ目に橋脚の半分を残す
    const s0 = w.s0 < 1 ? 2.5 : w.s0, s1 = w.s1 > fr.length - 1 ? fr.length - 2.5 : w.s1;
    if (s1 - s0 < 6) continue;
    const maxRise = CORNICE - ring - 0.25 - (-w.depth + 0.7);
    if (maxRise < 1.5) continue;
    const target = Math.max(12, Math.min(32, maxRise / 0.24));
    const opts = pontNeuf && w === longest
      ? { ...PONT_NEUF, reverse: road.pts[0][0] > road.pts[road.pts.length - 1][0] }
      : { target, minSpan: target * 0.75, maxSpan: target * 1.25 };
    const lay = archLayout(s0, s1, opts);
    w.ring = ring;
    w.arches = lay.arches.map((ar) => ({ ...ar, ...archRise(ar.a, w.depth, ring), t: ring }));
    w.piers = lay.piers;
    w.pontNeuf = pontNeuf && w === longest;
    w.a0 = s0;
    w.a1 = s1;
  }
  const arched = wet.filter((w) => w.arches);
  return arched.length ? { kind: pontNeuf ? 'pontneuf' : 'arch', wet: arched } : { kind: 'flat', wet };
}

// 橋面と欄干（way ごと）。並んだ橋の橋面の上には欄干を立てない
function writeDeck({ deck, body, walk, marks }, road, half, kind, info, clipRect) {
  const topY = CAR_ROADS.has(road.type) ? 0.08 : 0.14; // 歩道橋は少し高くして、重なっても Z ファイティングしないように
  const st = roadStyle(road);
  const modern = kind === 'modern' || kind === 'overpass' || kind === 'truss';
  const car = CAR_ROADS.has(road.type) && st.tex === 'asphalt';
  // 車道の標示（中央線・バスレーン・自転車レーン。ポン・ヌフは写真 10・11）。橋の両端 4 m はあける
  if (car) {
    const cum = [0];
    for (let i = 1; i < road.pts.length; i++) cum.push(cum[i - 1] + Math.hypot(road.pts[i][0] - road.pts[i - 1][0], road.pts[i][1] - road.pts[i - 1][1]));
    const total = cum[cum.length - 1];
    const clip = { minX: clipRect[0], minZ: clipRect[1], maxX: clipRect[2], maxZ: clipRect[3] };
    writeRoadMarkings(road, cum, laneLayout(road), [[-1, 4], [total - 4, total + 1]], clip, marks, marks, { y: topY + 0.01, solid: true });
  }
  for (const pts of clipPolylineToRect(road.pts, ...clipRect)) {
    if (pts.length < 2) continue;
    // 車道の橋は、車道の両側を明るい歩道に（暗いアスファルトのテクスチャを明るくする色）。
    // 石の橋は淡い花崗岩の板の歩道（写真 10・11）と、車道の縁の濃い石の帯（縁石）。並んだ橋の内側は今までどおり
    const stone = car && !modern && kind !== 'flat';
    writeDeckRibbon(deck, pts, half, car ? road.width / 2 : half, topY, st.tex === 'asphalt' ? st.color : c3('#c9c4ba'), c3('#e2d8ca', 1.6), stone ? { walk, road, info } : null);
    const edge = offsets(pts, half);
    const cor = offsets(pts, half + 0.3);
    const par = offsets(pts, half + 0.1);
    const inner = offsets(pts, half - (modern ? 0.3 : 0.4));
    for (const k of ['L', 'R']) {
      const side = edge[k], sgn = k === 'L' ? 1 : -1;
      for (let i = 0; i + 1 < side.length; i++) {
        const a = side[i], b = side[i + 1];
        const dx = b[0] - a[0], dz = b[1] - a[1];
        const l = Math.hypot(dx, dz) || 1;
        const n = [(-dz / l) * sgn, 0, (dx / l) * sgn]; // 外向き
        if (info.onDeck((a[0] + b[0]) / 2 + n[0] * 0.8, (a[1] + b[1]) / 2 + n[2] * 0.8, road)) continue;
        const ia = inner[k][i], ib = inner[k][i + 1];
        const ni = [-n[0], 0, -n[2]], up = [0, 1, 0], down = [0, -1, 0];
        const uvs = (y0, y1) => [[0, y0 / 20], [l / 8, y0 / 20], [l / 8, y1 / 20], [0, y1 / 20]]; // 石の目地の大きさ
        const vq = (p, q, y0, y1, nn, col) => body.quad([p[0], y0, p[1]], [q[0], y0, q[1]], [q[0], y1, q[1]], [p[0], y1, p[1]], nn, ...uvs(y0, y1), col);
        const hq = (p, q, r, s, y, nn, col) => body.quad([p[0], y, p[1]], [q[0], y, q[1]], [r[0], y, r[1]], [s[0], y, s[1]], nn, [0, 0], [l / 4, 0], [l / 4, 0.1], [0, 0.1], col);
        if (kind === 'overpass') {
          // コンクリートの縁（0.35 m）の上に青灰色の鉄の手すり（支柱 1.6 m おき・上と中の横桟、高さ 1.1 m）
          const ct = topY + 0.35, rt = topY + 1.1;
          vq(a, b, CORNICE, ct, n, COL.concrete);
          hq(a, b, ib, ia, ct, up, COL.concrete);
          vq(ia, ib, topY, ct, ni, COL.concrete);
          const ma = [(a[0] + ia[0]) / 2, (a[1] + ia[1]) / 2], mb = [(b[0] + ib[0]) / 2, (b[1] + ib[1]) / 2];
          const tx = (mb[0] - ma[0]) / l, tz = (mb[1] - ma[1]) / l, ox = n[0] * 0.03, oz = n[2] * 0.03;
          for (const y of [rt, topY + 0.7]) {
            body.quad([ma[0] + ox, y - 0.06, ma[1] + oz], [mb[0] + ox, y - 0.06, mb[1] + oz], [mb[0] + ox, y, mb[1] + oz], [ma[0] + ox, y, ma[1] + oz], n, [0, 0], [1, 0], [1, 1], [0, 1], COL.railing);
            body.quad([mb[0] - ox, y - 0.06, mb[1] - oz], [ma[0] - ox, y - 0.06, ma[1] - oz], [ma[0] - ox, y, ma[1] - oz], [mb[0] - ox, y, mb[1] - oz], ni, [0, 0], [1, 0], [1, 1], [0, 1], COL.railing);
          }
          for (let d = 0.8; d < l; d += 1.6) {
            const px = ma[0] + tx * d, pz = ma[1] + tz * d;
            for (const sg of [1, -1]) {
              const qx = px + n[0] * 0.04 * sg, qz = pz + n[2] * 0.04 * sg;
              body.quad([qx - tx * 0.04, ct, qz - tz * 0.04], [qx + tx * 0.04, ct, qz + tz * 0.04], [qx + tx * 0.04, rt, qz + tz * 0.04], [qx - tx * 0.04, rt, qz - tz * 0.04], sg > 0 ? n : ni, [0, 0], [1, 0], [1, 1], [0, 1], COL.railing);
            }
          }
          continue;
        }
        if (modern) {
          const top = topY + 0.95;
          vq(a, b, CORNICE, top, n, COL.concrete);
          hq(a, b, ib, ia, top, up, COL.concrete);
          vq(ia, ib, topY, top, ni, COL.concrete);
          continue;
        }
        // 石の蛇腹（30 cm 張り出す）と、その上の石の欄干（笠石付き）
        const ca = cor[k][i], cb = cor[k][i + 1], pa = par[k][i], pb = par[k][i + 1];
        const ct = topY + 0.15, top = topY + PARAPET;
        vq(ca, cb, CORNICE, ct, n, COL.cornice);
        hq(a, b, cb, ca, CORNICE, down, COL.cornice);
        hq(pa, pb, cb, ca, ct, up, COL.cornice);
        // 欄干の面は淡い切り石（写真 10・11: 淡い石の約 1 m の欄干）。レンガではなく花崗岩の板のテクスチャ（walk。
        // 2.4 m で 1 周: 長さ 1.2 m・高さ 0.6 m の石。目地は細い横の線）に暖かい白の色をかける
        const sq = (p, q, y0, y1, nn) => walk.quad([p[0], y0, p[1]], [q[0], y0, q[1]], [q[0], y1, q[1]], [p[0], y1, p[1]], nn, [0, y0 / 2.4], [l / 2.4, y0 / 2.4], [l / 2.4, y1 / 2.4], [0, y1 / 2.4], PARAPET_STONE);
        sq(pa, pb, ct, top, n);
        // 笠石: 欄干の面と同じ切り石のテクスチャ（体のテクスチャのレンガの縞にしない。利用者の写真: 平らな淡い石の笠）
        walk.quad([pa[0], top, pa[1]], [pb[0], top, pb[1]], [ib[0], top, ib[1]], [ia[0], top, ia[1]], up, [0, 0.1], [l / 2.4, 0.1], [l / 2.4, 0.3], [0, 0.3], COPING_STONE);
        sq(ia, ib, topY, top, ni);
      }
    }
  }
}

const COPING_STONE = c3('#f0e8da'); // 欄干の笠石
const PARAPET_STONE = c3('#fbf3e6'); // 欄干・街灯の台座の淡い切り石（花崗岩の板のテクスチャにかける色）
// 花崗岩の板と、縁石の濃い帯。利用者の写真（ポン・ヌフの歩道）: 板は中くらいの灰色 #8f8b84 前後（テクスチャの淡い色を暗くする）
// 歩道の花崗岩（利用者の写真・Street View: ポン・ヌフの歩道は灰色の花崗岩、車道の縁に濃い帯）
const GRANITE = c3('#a6a7a6'), GRANITE_EDGE = c3('#8c8d8c');
function writeDeckRibbon(w, pts, half, inner, y, color, sideColor, stone = null) {
  const up = [0, 1, 0];
  const uv = (p) => [p[0] / 4, -p[1] / 4];
  const strip = (A, B, col) => {
    for (let i = 0; i + 1 < pts.length; i++) {
      const a = A[i], b = B[i], c = B[i + 1], d = A[i + 1];
      w.quad([a[0], y, a[1]], [b[0], y, b[1]], [c[0], y, c[1]], [d[0], y, d[1]], up, uv(a), uv(b), uv(c), uv(d), col);
    }
  };
  const out = offsets(pts, half);
  if (inner > half - 0.3) return strip(out.L, out.R, color);
  const mid = offsets(pts, inner);
  strip(mid.L, mid.R, color);
  if (!stone) {
    strip(out.L, mid.L, sideColor);
    strip(mid.R, out.R, sideColor);
    return;
  }
  // 花崗岩の板の歩道: テクスチャの u = 橋の向き（2.4 m で 1 枚）、v = 横。車道の縁から 0.35 m は濃い縁石の帯。
  // 並んだ橋の内側（外に別の橋面がある辺）は今までどおりの明るいアスファルト
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  const band = offsets(pts, inner + 0.35);
  for (const [k, sgn] of [['L', 1], ['R', -1]]) {
    for (let i = 0; i + 1 < pts.length; i++) {
      const a = out[k][i], b = out[k][i + 1];
      const nx = (a[0] - pts[i][0]) / half, nz = (a[1] - pts[i][1]) / half;
      if (stone.info.onDeck((a[0] + b[0]) / 2 + nx * 0.8, (a[1] + b[1]) / 2 + nz * 0.8, stone.road)) {
        const A = [mid[k][i], mid[k][i + 1]], B = [a, b];
        w.quad([A[0][0], y, A[0][1]], [B[0][0], y, B[0][1]], [B[1][0], y, B[1][1]], [A[1][0], y, A[1][1]], up, uv(A[0]), uv(B[0]), uv(B[1]), uv(A[1]), sideColor);
        continue;
      }
      const u0 = cum[i] / 2.4, u1 = cum[i + 1] / 2.4;
      const q = (P0, P1, t0, t1, col) => {
        const [p0, p1, p2, p3] = sgn > 0 ? [P0[i], P1[i], P1[i + 1], P0[i + 1]] : [P1[i], P0[i], P0[i + 1], P1[i + 1]];
        const [v0, v1] = sgn > 0 ? [t0, t1] : [t1, t0];
        stone.walk.quad([p0[0], y, p0[1]], [p1[0], y, p1[1]], [p2[0], y, p2[1]], [p3[0], y, p3[1]], up, [u0, v0], [u0, v1], [u1, v1], [u1, v0], col);
      };
      q(mid[k], band[k], 0, 0.35 / 2.4, GRANITE_EDGE);
      q(band[k], out[k], 0.35 / 2.4, (half - inner) / 2.4, GRANITE);
    }
  }
}

// 橋の本体（親の way だけ）: 側面・底・アーチ・橋脚・水切り・街灯
function writeStructure(w, road, v, stone = w) {
  const { kind, wet } = v.style;
  const pts = road.pts;
  const fr = polyFrame(pts);
  const lines = { 1: offsets(pts, v.extL).L, [-1]: offsets(pts, v.extR).R };
  const U = (s) => fr.tangent(fr.locate(s)[0]);
  const N = (sd, s) => {
    const [ux, uz] = U(s);
    return sd > 0 ? [-uz, 0, ux] : [uz, 0, -ux];
  };
  const P = (sd, s, y) => {
    const [x, z] = fr.at(lines[sd], s);
    return [x, y, z];
  };
  // 側面の 2 次元の四角形（a..d: [s, y]）。stone: 石の目地の大きさのテクスチャ、'panel': 模様のない打ち放しのコンクリート
  // （テクスチャの 1 点だけを使う）
  const fq = (sd, a, b, c, d, color, stone = false) => {
    if (Math.abs((b[0] - a[0]) * (d[1] - a[1]) - (b[1] - a[1]) * (d[0] - a[0])) + Math.abs((c[0] - b[0]) * (d[1] - b[1]) - (c[1] - b[1]) * (d[0] - b[0])) < 1e-4) return;
    const uv = (q) => (stone === 'panel' ? FLAT_UV : stone ? [(q[0] * sd) / 8, q[1] / 20] : [(q[0] * sd) / 4, q[1] / 4]);
    w.quad(P(sd, ...a), P(sd, ...b), P(sd, ...c), P(sd, ...d), N(sd, (a[0] + c[0]) / 2), uv(a), uv(b), uv(c), uv(d), color);
  };
  const fl = fr.length;
  const plainSides = (bottom, color, panel = false, under = color) => {
    // 平らな側面（bottom〜蛇腹）と底面
    const ss = [...fr.cum];
    for (const sd of [1, -1]) for (let i = 0; i + 1 < ss.length; i++) fq(sd, [ss[i], bottom], [ss[i + 1], bottom], [ss[i + 1], CORNICE], [ss[i], CORNICE], color, panel && 'panel');
    for (let i = 0; i + 1 < ss.length; i++) {
      const a = P(1, ss[i], bottom), b = P(-1, ss[i], bottom), c = P(-1, ss[i + 1], bottom), d = P(1, ss[i + 1], bottom);
      // 打ち放しの下面: 法線を上向きにして、空の明るさ（青みの灰色）で照らす（下向きの面は地面の照り返しの茶色だけになり、
      // 写真の灰色の下面より暗く茶色い）。桁の上面の影の中なので日は当たらない。面は下から見えるように並べる
      if (panel) {
        const n0 = w.nor.length;
        w.quad(a, b, c, d, [0, -1, 0], FLAT_UV, FLAT_UV, FLAT_UV, FLAT_UV, under);
        for (let j = n0; j < w.nor.length; j += 3) [w.nor[j], w.nor[j + 1], w.nor[j + 2]] = [0, 1, 0];
      }
      else w.quad(a, b, c, d, [0, -1, 0], [0, 0], [1, 0], [1, 1], [0, 1], under);
    }
  };
  if (kind === 'flat') return plainSides(LAND_BOTTOM, COL.flat);
  // 桁の高さ（写真の A620 は淡いコンクリートの厚い桁）。下面は日陰の灰色（暖かい色の照り返しで茶色くならないよう青みに寄せる）
  if (kind === 'overpass') return plainSides(-OVERPASS_DEPTH, COL.concrete, true, COL.soffit);
  if (kind === 'truss') {
    // 桁の側面（鋼）と、両側の弧の下弦・縦材・斜材のトラス。径間の真ん中で浅く（1.2 m）、橋脚で深い（5 m）
    plainSides(SLAB_BOTTOM, COL.steel);
    for (const wt of wet) {
      const W = wt.s1 - wt.s0, n = 3, span = W / n;
      const depth = (s) => {
        const u = (((s - wt.s0) % span) + span) % span / span;
        return 1.2 + 3.8 * (2 * u - 1) ** 2;
      };
      for (const sd of [1, -1]) {
        const step = span / Math.max(6, Math.round(span / 3.2));
        for (let s = wt.s0; s < wt.s1 - 1e-6; s += step) {
          const s1 = Math.min(wt.s1, s + step);
          const b0 = SLAB_BOTTOM - depth(s), b1 = SLAB_BOTTOM - depth(s1);
          fq(sd, [s, b0 - 0.45], [s1, b1 - 0.45], [s1, b1], [s, b0], COL.steel); // 下弦
          fq(sd, [s - 0.12, b0], [s + 0.12, b0], [s + 0.12, SLAB_BOTTOM], [s - 0.12, SLAB_BOTTOM], COL.steel); // 縦材
          const up = Math.floor((s - wt.s0) / step) % 2 === 0;
          const [sa, ya, sb, yb] = up ? [s, b0, s1, SLAB_BOTTOM] : [s, SLAB_BOTTOM, s1, b1];
          fq(sd, [sa - 0.12, ya], [sa + 0.12, ya], [sb + 0.12, yb], [sb - 0.12, yb], COL.steel); // 斜材
        }
      }
      // 径間の境のレンガの橋脚と、橋面の上に立つ四角い柱（両側）
      for (let k = 1; k < n; k++) {
        const s = wt.s0 + span * k;
        const c = fr.at(pts, s), [ux, uz] = U(s);
        const off = (v.extL - v.extR) / 2;
        // 利用者の写真 NCM_0105・0106・0109: 橋脚は厚いレンガの塊で、橋面の両脇に高さ 4 m ほどの塊になって突き出す
        writePier(w, c[0] - uz * off, c[1] + ux * off, ux, uz, (v.extL + v.extR) * 0.5, 1.2, 3.4, SLAB_BOTTOM - 5, -wt.depth - 0.6, COL.pierBrick);
        for (const sd of [1, -1]) {
          const q = fr.at(lines[sd], s);
          writePier(w, q[0], q[1], ux, uz, 1.1, 0, 3.4, 4.0, SLAB_BOTTOM - 5, COL.pierBrick);
        }
      }
    }
    return;
  }
  if (kind === 'modern') {
    plainSides(SLAB_BOTTOM, COL.concrete);
    for (const wt of wet) {
      const W = wt.s1 - wt.s0;
      const n = Math.max(1, Math.round(W / 45));
      for (let k = 1; k < n; k++) {
        const s = wt.s0 + (W * k) / n;
        const c = fr.at(pts, s), [ux, uz] = U(s);
        const off = (v.extL - v.extR) / 2;
        writePier(w, c[0] - uz * off, c[1] + ux * off, ux, uz, (v.extL + v.extR) * 0.32, 0.9, 1.6, SLAB_BOTTOM, -wt.depth - 0.6, COL.concreteDark);
      }
    }
    return;
  }

  // ---- アーチ橋 ----
  // 側面の下端の線（[s, y]、s の順）。陸の上は LAND_BOTTOM、橋脚と橋台は水の底まで、アーチは迫石の輪の外側の楕円
  const bottom = [];
  const push = (s, y) => {
    if (s < 0 || s > fl) return;
    bottom.push([s, y]);
  };
  // 陸（とアーチを作らない短い水）の上: 底は LAND_BOTTOM（底面も作る）
  const land = (s0, s1) => {
    const ss = [s0, ...fr.cum.filter((s) => s > s0 && s < s1), s1];
    for (const s of ss) push(s, LAND_BOTTOM);
    for (let i = 0; i + 1 < ss.length; i++) {
      if (ss[i + 1] - ss[i] < 1e-3) continue;
      const a = P(1, ss[i], LAND_BOTTOM), b = P(-1, ss[i], LAND_BOTTOM), c = P(-1, ss[i + 1], LAND_BOTTOM), d = P(1, ss[i + 1], LAND_BOTTOM);
      w.quad(a, b, c, d, [0, -1, 0], [0, 0], [1, 0], [1, 1], [0, 1], COL.brick);
    }
  };
  let cur = 0;
  const boxes = []; // 丸い穴（デグロワール）の正方形 [s0, s1, y0, y1]
  const oculi = [];
  for (const wt of wet) {
    const { arches, ring: t } = wt;
    const first = arches[0], last = arches[arches.length - 1];
    const deep = -wt.depth - 0.6;
    const a0 = Math.max(cur, first.c - first.a - t - 3);
    land(cur, a0);
    push(a0, deep);
    arches.forEach((ar, k) => {
      push(ar.c - ar.a - t, deep);
      const K = voussoirs(ar);
      for (let j = 0; j <= K; j++) {
        const th = Math.PI * (1 - j / K);
        push(...archPoint(ar, th, t));
      }
      push(ar.c + ar.a + t, deep);
      if (k + 1 < arches.length) push(arches[k + 1].c - arches[k + 1].a - t, deep);
    });
    const a1 = Math.min(fl, last.c + last.a + t + 3);
    push(a1, deep);
    cur = a1;
    // 橋脚の上の丸い穴（ポン・ヌフ）: 水切りの笠の上から蛇腹の下までに入る大きさで
    if (wt.pontNeuf) {
      wt.piers.forEach((p, k) => {
        const A = arches[k], B = arches[k + 1];
        const sc = (p.s0 + p.s1) / 2;
        const capTop = cutwaterTop(A, B) + 3 * CAP_STEP + CAP_TIP * 0.5; // 尖りの先は縁取りの下のレンガにかかってよい
        for (let r = 2.0; r >= 1.4; r -= 0.05) {
          const R = r + 0.75 + 0.2;
          let low = capTop;
          for (let q = -R; q <= R; q += 0.25) low = Math.max(low, archY(A, sc + q, t), archY(B, sc + q, t));
          const yc = low + R + 0.1;
          if (yc + R <= CORNICE - 0.15) {
            boxes.push([sc - R, sc + R, yc - R, yc + R]);
            oculi.push({ sc, yc, r, R });
            break;
          }
        }
      });
    }
  }
  land(cur, fl);

  // 側面（スパンドレル・橋脚の面・陸の上の壁）: 縦の短冊で、下は切石、上はレンガ
  const stoneTop = wet.length ? Math.max(...wet.flatMap((wt) => wt.arches.map((ar) => ar.spring))) + 0.2 : LAND_BOTTOM;
  for (const sd of [1, -1]) {
    columns((a, b, c, d, color, stone) => fq(sd, a, b, c, d, color, stone), bottom, CORNICE, boxes, [[stoneTop, COL.ashlar, true], [Infinity, COL.brick, false]]);
  }
  for (const wt of wet) {
    const t = wt.ring;
    const deep = -wt.depth - 0.6;
    for (const ar of wt.arches) {
      const K = voussoirs(ar);
      const I = (th) => archPoint(ar, th, 0);
      const O = (th) => archPoint(ar, th, t);
      for (const sd of [1, -1]) {
        // 迫石の輪: ポン・ヌフは白い石とレンガを交互に、ほかは石
        for (let j = 0; j < K; j++) {
          const t0 = Math.PI * (1 - j / K), t1 = Math.PI * (1 - (j + 1) / K);
          const col = wt.pontNeuf ? (j % 2 ? COL.brick : COL.stone) : j % 2 ? COL.stoneWarm : COL.stone;
          fq(sd, I(t0), I(t1), O(t1), O(t0), col, true);
        }
        // 起拱線より下の、輪の外側の橋脚の面
        fq(sd, [ar.c - ar.a - t, deep], [ar.c - ar.a, deep], [ar.c - ar.a, ar.spring], [ar.c - ar.a - t, ar.spring], COL.ashlar, true);
        fq(sd, [ar.c + ar.a, deep], [ar.c + ar.a + t, deep], [ar.c + ar.a + t, ar.spring], [ar.c + ar.a, ar.spring], COL.ashlar, true);
      }
      // 起拱線より下の橋脚・橋台の、アーチの開口に向いた面（幅いっぱい）
      for (const [s, sg] of [[ar.c - ar.a, 1], [ar.c + ar.a, -1]]) {
        const [ux, uz] = U(s);
        w.quad(P(1, s, deep), P(-1, s, deep), P(-1, s, ar.spring), P(1, s, ar.spring), [ux * sg, 0, uz * sg],
          [v.extL / 8, deep / 20], [-v.extR / 8, deep / 20], [-v.extR / 8, ar.spring / 20], [v.extL / 8, ar.spring / 20], COL.ashlar);
      }
      // アーチの下面（レンガのヴォールト）
      for (let j = 0; j < K; j++) {
        const t0 = Math.PI * (1 - j / K), t1 = Math.PI * (1 - (j + 1) / K);
        const p0 = I(t0), p1 = I(t1);
        const [ux, uz] = U((p0[0] + p1[0]) / 2);
        const [ns, ny] = archNormal(ar, (t0 + t1) / 2);
        const arc0 = (ar.a * (Math.PI - t0)) / 4, arc1 = (ar.a * (Math.PI - t1)) / 4;
        w.quad(P(1, ...p0), P(-1, ...p0), P(-1, ...p1), P(1, ...p1), [ux * ns, ny, uz * ns],
          [arc0, v.extL / 4], [arc0, -v.extR / 4], [arc1, -v.extR / 4], [arc1, v.extL / 4], COL.vault);
      }
    }
    // 水切り（上流・下流の両側）
    wt.piers.forEach((p, k) => {
      const A = wt.arches[k], B = wt.arches[k + 1];
      for (const sd of [1, -1]) writeCutwater(w, P, N, sd, p, deep, cutwaterTop(A, B), wt.pontNeuf);
    });
  }
  // 丸い穴: 縁取りの石（外側はぎざぎざ）、まわりのレンガ、橋を貫く筒
  for (const o of oculi) writeOculus(w, P, U, o);
  // ポン・ヌフの街灯
  for (const wt of wet) {
    if (!wt.pontNeuf) continue;
    for (let s = wt.a0 + 6; s < wt.a1 - 3; s += 26.5) {
      for (const sd of [1, -1]) {
        const half = sd > 0 ? v.extL : v.extR;
        const c = fr.at(pts, s), n = N(sd, s);
        // 台座は欄干の内側に沿って歩道の上に立つ（利用者の写真 0310_160523254）
        const x = c[0] + n[0] * (half - 0.8), z = c[1] + n[2] * (half - 0.8);
        writeLamp(w, x, z, U(s), 0.08, [-n[0], -n[2]], stone);
      }
    }
  }
}

// かご形のアーチ（楕円より肩の張った超楕円 |x/a|^p + |y/b|^p = 1）。th: 0〜π（π が左の付け根）、grow: 輪の外側へ広げる幅
const ARCH_P = 2.4;
function archPoint(ar, th, grow = 0) {
  const c = Math.cos(th), sn = Math.sin(th), e = 2 / ARCH_P;
  return [ar.c + (ar.a + grow) * Math.sign(c) * Math.abs(c) ** e, ar.spring + (ar.rise + grow) * Math.abs(sn) ** e];
}
// アーチの下面の内向きの法線（[s 方向, y 方向]）
function archNormal(ar, th) {
  const c = Math.cos(th), sn = Math.sin(th), q = (2 * (ARCH_P - 1)) / ARCH_P;
  const ns = (-Math.sign(c) * Math.abs(c) ** q) / ar.a, ny = -(Math.abs(sn) ** q) / Math.max(ar.rise, 0.1);
  const l = Math.hypot(ns, ny) || 1;
  return [ns / l, ny / l];
}
// s の位置での、輪の外側（grow）の高さ（アーチの外なら -Infinity）
export function archY(ar, s, grow = 0) {
  const x = Math.abs(s - ar.c) / (ar.a + grow);
  return x < 1 ? ar.spring + (ar.rise + grow) * (1 - x ** ARCH_P) ** (1 / ARCH_P) : -Infinity;
}

// アーチ 1 つの迫石の数（奇数にして両端を石にする）
function voussoirs(ar) {
  const K = Math.max(9, Math.round((Math.PI * (ar.a + ar.rise)) / 2 / 0.85));
  return K % 2 ? K : K + 1;
}

// 水切りの胴の上端: 両側の低い方のアーチの 1/3 ほどの高さ。笠は 22 cm の段 3 つと、50 cm の尖り
const CAP_STEP = 0.22, CAP_TIP = 0.5;
function cutwaterTop(A, B) {
  return Math.max(A.spring, B.spring) + 0.32 * Math.min(A.rise, B.rise);
}

// 縦の短冊で壁を埋める。bottom: 下端の折れ線 [s, y]（s の順。同じ s が続く所は段差）、top: 上端の高さ。
// boxes の中は穴の側で作るので、短冊を上下に分ける。bands: 下から順に [上端の高さ, 色, 石か]
export function columns(fq, bottom, top, boxes, bands) {
  const stack = (a, ya, b, yb, yTop) => {
    let ca = ya, cb = yb;
    if (yTop <= Math.max(ya, yb) + 1e-3) return;
    for (const [lv, color, stone] of bands) {
      const lim = Math.min(lv, yTop);
      if (lim <= Math.max(ca, cb) + 0.01) {
        if (lv >= yTop) break;
        continue;
      }
      fq([a, ca], [b, cb], [b, lim], [a, lim], color, stone);
      ca = cb = lim;
      if (lim >= yTop) break;
    }
  };
  for (let k = 0; k + 1 < bottom.length; k++) {
    const [s0, y0] = bottom[k], [s1, y1] = bottom[k + 1];
    if (s1 - s0 < 1e-3) continue;
    const cuts = [s0, s1];
    for (const q of boxes) for (const e of [q[0], q[1]]) if (e > s0 + 1e-3 && e < s1 - 1e-3) cuts.push(e);
    cuts.sort((a, b) => a - b);
    for (let j = 0; j + 1 < cuts.length; j++) {
      const a = cuts[j], b = cuts[j + 1];
      const ya = y0 + ((y1 - y0) * (a - s0)) / (s1 - s0), yb = y0 + ((y1 - y0) * (b - s0)) / (s1 - s0);
      const m = (a + b) / 2;
      const q = boxes.find((bx) => m > bx[0] && m < bx[1]);
      if (q) {
        stack(a, ya, b, yb, q[2]);
        stack(a, q[3], b, q[3], top);
      } else stack(a, ya, b, yb, top);
    }
  }
}

// 水切り: 橋脚から上流・下流に突き出た三角柱（胴は切石）と、段々のピラミッドの笠。ポン・ヌフは足元に低い石の台
function writeCutwater(w, P, N, sd, pier, deep, topY, big) {
  const mid = (pier.s0 + pier.s1) / 2;
  const n = N(sd, mid);
  const len = (pier.s1 - pier.s0) * (big ? 0.85 : 0.7);
  const xz = (q) => [q[0], q[2]];
  const A = xz(P(sd, pier.s0, 0)), B = xz(P(sd, pier.s1, 0)), M = xz(P(sd, mid, 0));
  // 橋の面の上の底辺 A-B と、外へ突き出た頂点。f で面の中点 M に向かって縮める
  const tri = (f) => {
    const sc = (p) => [M[0] + (p[0] - M[0]) * f, M[1] + (p[1] - M[1]) * f];
    return [sc(A), [M[0] + n[0] * len * f, M[1] + n[2] * len * f], sc(B)];
  };
  const prism = (t, y0, y1, color) => {
    const cx = (t[0][0] + t[1][0] + t[2][0]) / 3, cz = (t[0][1] + t[1][1] + t[2][1]) / 3;
    for (let i = 0; i < 2; i++) {
      const p = t[i], q = t[i + 1];
      const dx = q[0] - p[0], dz = q[1] - p[1];
      const l = Math.hypot(dx, dz) || 1;
      let nx = dz / l, nz = -dx / l;
      if (((p[0] + q[0]) / 2 - cx) * nx + ((p[1] + q[1]) / 2 - cz) * nz < 0) {
        nx = -nx;
        nz = -nz;
      }
      w.quad([p[0], y0, p[1]], [q[0], y0, q[1]], [q[0], y1, q[1]], [p[0], y1, p[1]], [nx, 0, nz],
        [0, y0 / 20], [l / 8, y0 / 20], [l / 8, y1 / 20], [0, y1 / 20], color);
    }
  };
  const flat = (t, y, color) => w.tri([t[0][0], y, t[0][1]], [t[1][0], y, t[1][1]], [t[2][0], y, t[2][1]], [0, 1, 0], [0, 0], [0.5, 0], [0, 0.5], color);
  const ring = (t0, t1, y, color) => {
    for (let i = 0; i < 2; i++) {
      const a = t0[i], b = t0[i + 1], c = t1[i + 1], d = t1[i];
      w.quad([a[0], y, a[1]], [b[0], y, b[1]], [c[0], y, c[1]], [d[0], y, d[1]], [0, 1, 0], [0, 0], [0.3, 0], [0.3, 0.3], [0, 0.3], color);
    }
  };
  const body = tri(1);
  if (big) {
    // 足元の低い台（水面の 0.35 m 上まで、胴より少し広い）
    const foot = [[A[0] - (B[0] - A[0]) * 0.06, A[1] - (B[1] - A[1]) * 0.06], [M[0] + n[0] * (len + 0.7), M[1] + n[2] * (len + 0.7)], [B[0] + (B[0] - A[0]) * 0.06, B[1] + (B[1] - A[1]) * 0.06]];
    const fy = deep + 0.95;
    prism(foot, deep, fy, COL.footing);
    ring(foot, body, fy, COL.footing);
  }
  prism(body, deep, topY, COL.nose);
  // 段々の笠（ポン・ヌフは 3 段＋尖り、ほかは 2 段＋尖り）
  const steps = big ? 3 : 2;
  let prev = body, y = topY;
  for (let k = 1; k <= steps; k++) {
    const f = 1 - k * (big ? 0.2 : 0.25);
    const t = tri(f);
    ring(prev, t, y, COL.ashlar);
    prism(t, y, y + CAP_STEP, COL.ashlar);
    prev = t;
    y += CAP_STEP;
  }
  // 頂点へすぼまる尖り（外向き＋上向きの法線）
  const apex = [M[0] + n[0] * len * 0.12, M[1] + n[2] * len * 0.12];
  const cx = (prev[0][0] + prev[1][0] + prev[2][0]) / 3, cz = (prev[0][1] + prev[1][1] + prev[2][1]) / 3;
  for (let i = 0; i < 2; i++) {
    const p = prev[i], q = prev[i + 1];
    const ox = (p[0] + q[0]) / 2 - cx, oz = (p[1] + q[1]) / 2 - cz;
    const ol = Math.hypot(ox, oz) || 1;
    w.tri([p[0], y, p[1]], [q[0], y, q[1]], [apex[0], y + CAP_TIP, apex[1]], [(ox / ol) * 0.8, 0.6, (oz / ol) * 0.8], [0, 0], [0.3, 0], [0.15, 0.2], COL.ashlar);
  }
  flat(prev, y - 0.001, COL.ashlar);
}

// 丸い穴（デグロワール）: 正方形 [sc±R, yc±R] の中を、穴の縁（石の迫石、外側はぎざぎざ）とレンガで埋め、橋を貫く筒を作る
function writeOculus(w, P, U, { sc, yc, r, R }) {
  const NA = 24; // 15° ごと（正方形の角 45° を含む）
  const pts = [];
  for (let j = 0; j <= NA; j++) {
    const th = (j / NA) * Math.PI * 2;
    const c = Math.cos(th), s = Math.sin(th);
    const sq = R / Math.max(Math.abs(c), Math.abs(s));
    const mid = r + 0.75 * (j % 2 ? 1 : 0.62);
    pts.push({ c, s, in: [sc + r * c, yc + r * s], mid: [sc + mid * c, yc + mid * s], out: [sc + sq * c, yc + sq * s] });
  }
  for (const sd of [1, -1]) {
    const [ux, uz] = U(sc);
    const n = sd > 0 ? [-uz, 0, ux] : [uz, 0, -ux];
    const q = (a, b, c, d, color, k) => w.quad(P(sd, ...a), P(sd, ...b), P(sd, ...c), P(sd, ...d), n,
      [(a[0] * sd) / k, a[1] / k], [(b[0] * sd) / k, b[1] / k], [(c[0] * sd) / k, c[1] / k], [(d[0] * sd) / k, d[1] / k], color);
    for (let j = 0; j < NA; j++) {
      const a = pts[j], b = pts[j + 1];
      q(a.in, b.in, b.mid, a.mid, j % 2 ? COL.stone : COL.stoneWarm, 6);
      q(a.mid, b.mid, b.out, a.out, COL.brick, 4);
    }
  }
  // 筒の内側（レンガ）
  for (let j = 0; j < NA; j++) {
    const a = pts[j], b = pts[j + 1];
    const [ux, uz] = U(sc);
    const cm = (a.c + b.c) / 2, sm = (a.s + b.s) / 2;
    const n = [-cm * ux, -sm, -cm * uz];
    w.quad(P(1, ...a.in), P(-1, ...a.in), P(-1, ...b.in), P(1, ...b.in), n, [j / 6, 0], [j / 6, 5], [(j + 1) / 6, 5], [(j + 1) / 6, 0], COL.vault);
  }
}

// 近代の橋の橋脚: 流れの方向（橋と直交）に尖った細い六角柱
function writePier(w, x, z, ux, uz, halfAcross, nose, thick, top, bottom, color) {
  const vx = -uz, vz = ux;
  const t = thick / 2;
  const pts = [
    [x + vx * (halfAcross + nose), z + vz * (halfAcross + nose)],
    [x + vx * halfAcross + ux * t, z + vz * halfAcross + uz * t],
    [x - vx * halfAcross + ux * t, z - vz * halfAcross + uz * t],
    [x - vx * (halfAcross + nose), z - vz * (halfAcross + nose)],
    [x - vx * halfAcross - ux * t, z - vz * halfAcross - uz * t],
    [x + vx * halfAcross - ux * t, z + vz * halfAcross - uz * t],
  ];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    const dx = b[0] - a[0], dz = b[1] - a[1];
    const l = Math.hypot(dx, dz) || 1;
    let nx = dz / l, nz = -dx / l;
    if (((a[0] + b[0]) / 2 - x) * nx + ((a[1] + b[1]) / 2 - z) * nz < 0) {
      nx = -nx;
      nz = -nz;
    }
    w.quad([a[0], top, a[1]], [b[0], top, b[1]], [b[0], bottom, b[1]], [a[0], bottom, a[1]], [nx, 0, nz],
      [0, top / 4], [l / 4, top / 4], [l / 4, bottom / 4], [0, bottom / 4], color);
  }
}

// ポン・ヌフの街灯（写真 10・11）: 欄干の中の石の台座、灰緑の鋳鉄の柱（高さ約 6.6 m）、車道の側へ曲がった白鳥の首の
// 腕（約 1.2 m）の先に吊り下げた灯具 1 つ。[ix, iz]: 車道の側（内向き）
function writeLamp(w, x, z, [ux, uz], baseY, [ix, iz], stone = w) {
  const vx = -uz, vz = ux;
  const box = (cx, cz, y0, y1, hu, hv, color, out = w, uvk = 0) => {
    const c = (a, b) => [cx + ux * a + vx * b, cz + uz * a + vz * b];
    const P4 = [c(-hu, -hv), c(hu, -hv), c(hu, hv), c(-hu, hv)];
    for (let i = 0; i < 4; i++) {
      const a = P4[i], b = P4[(i + 1) % 4];
      const mx = (a[0] + b[0]) / 2 - cx, mz = (a[1] + b[1]) / 2 - cz, ml = Math.hypot(mx, mz) || 1;
      // uvk 0: 塗った鋳鉄（模様なし）
      if (!uvk) out.quad([a[0], y0, a[1]], [b[0], y0, b[1]], [b[0], y1, b[1]], [a[0], y1, a[1]], [mx / ml, 0, mz / ml], FLAT_UV, FLAT_UV, FLAT_UV, FLAT_UV, color);
      else out.quad([a[0], y0, a[1]], [b[0], y0, b[1]], [b[0], y1, b[1]], [a[0], y1, a[1]], [mx / ml, 0, mz / ml], [0, y0 * uvk], [0.2, y0 * uvk], [0.2, y1 * uvk], [0, y1 * uvk], color);
    }
    out.quad([P4[0][0], y1, P4[0][1]], [P4[1][0], y1, P4[1][1]], [P4[2][0], y1, P4[2][1]], [P4[3][0], y1, P4[3][1]], [0, 1, 0], FLAT_UV, FLAT_UV, FLAT_UV, FLAT_UV, color);
  };
  const y0 = baseY;
  // 台座: 歩道の上に立つ鋳鉄の四角い足と、輪の付いた太い根元（利用者の写真 0310_160523254・NCM_0123・0124: 欄干に石の
  // 柱はなく、灰緑の鋳鉄の柱が歩道に直に立つ）
  box(x, z, y0, y0 + 0.32, 0.27, 0.27, COL.lamp);
  box(x, z, y0 + 0.32, y0 + 0.42, 0.22, 0.22, COL.lamp);
  box(x, z, y0 + 0.42, y0 + PARAPET + 0.9, 0.15, 0.15, COL.lamp); // 柱の根元
  for (const yr of [y0 + 1.15, y0 + PARAPET + 0.9]) box(x, z, yr - 0.06, yr + 0.06, 0.19, 0.19, COL.lamp); // 輪
  // 柱（6 角、上ほど細い）
  const yb = y0 + PARAPET + 0.9, yt = y0 + 6.6;
  for (let i = 0; i < 6; i++) {
    const a0 = (i / 6) * Math.PI * 2, a1 = ((i + 1) / 6) * Math.PI * 2, am = (a0 + a1) / 2;
    const p = (a, r, y) => [x + Math.cos(a) * r, y, z + Math.sin(a) * r];
    w.quad(p(a0, 0.12, yb), p(a1, 0.12, yb), p(a1, 0.065, yt), p(a0, 0.065, yt), [Math.cos(am), 0.05, Math.sin(am)], FLAT_UV, FLAT_UV, FLAT_UV, FLAT_UV, COL.lamp); // 塗った鋳鉄（模様なし）
  }
  // 白鳥の首の腕: [内への距離, 高さ] の 5 点を 4 本の角棒でつなぐ
  const arm = [[0, 6.5], [0.12, 6.95], [0.42, 7.22], [0.85, 7.28], [1.22, 7.15]];
  const r = 0.04;
  for (let k = 0; k + 1 < arm.length; k++) {
    const [h0, a0] = arm[k], [h1, a1] = arm[k + 1];
    const L = Math.hypot(h1 - h0, a1 - a0) || 1;
    const ph = -(a1 - a0) / L, py = (h1 - h0) / L; // 腕に直角な向き（腕の面の中で上側）
    const V = (h, a, du, dn) => [x + ix * (h + ph * dn) + ux * du, y0 + a + py * dn, z + iz * (h + ph * dn) + uz * du];
    // 面の向きは法線で決まる（MeshWriter が巻きの向きを合わせる）
    const q = ([du0, dn0], [du1, dn1], n) => w.quad(V(h0, a0, du0, dn0), V(h1, a1, du0, dn0), V(h1, a1, du1, dn1), V(h0, a0, du1, dn1), n, FLAT_UV, FLAT_UV, FLAT_UV, FLAT_UV, COL.lamp);
    q([-r, -r], [-r, r], [-ux, 0, -uz]);
    q([r, -r], [r, r], [ux, 0, uz]);
    q([-r, r], [r, r], [ix * ph, py, iz * ph]);
    q([-r, -r], [r, -r], [-ix * ph, -py, -iz * ph]);
  }
  // 吊り下げの灯具（腕の先から下がる。笠・ガラス・下の飾り）
  const [hl, al] = arm[arm.length - 1];
  const lx = x + ix * hl, lz = z + iz * hl, ya = y0 + al;
  // 鐘の形の灯具（笠・下に広がるガラス・真鍮の帯・下の飾り）
  box(lx, lz, ya - 0.18, ya, 0.025, 0.025, COL.lamp);
  box(lx, lz, ya - 0.3, ya - 0.18, 0.22, 0.22, COL.lamp);
  box(lx, lz, ya - 0.45, ya - 0.3, 0.12, 0.12, COL.globe);
  box(lx, lz, ya - 0.6, ya - 0.45, 0.16, 0.16, COL.globe);
  box(lx, lz, ya - 0.64, ya - 0.6, 0.2, 0.2, COL.brass);
  box(lx, lz, ya - 0.76, ya - 0.64, 0.19, 0.19, COL.globe);
  box(lx, lz, ya - 0.84, ya - 0.76, 0.08, 0.08, COL.lamp);
}

function writeGlobe(w, x, y, z, r, color) {
  const lat = 4, lon = 6;
  const p = (i, j) => {
    const t = (i / lat) * Math.PI, f = (j / lon) * Math.PI * 2;
    return [x + Math.sin(t) * Math.cos(f) * r, y + Math.cos(t) * r, z + Math.sin(t) * Math.sin(f) * r];
  };
  for (let i = 0; i < lat; i++) {
    for (let j = 0; j < lon; j++) {
      const a = p(i, j), b = p(i, j + 1), c = p(i + 1, j + 1), d = p(i + 1, j);
      const m = [(a[0] + c[0]) / 2 - x, (a[1] + c[1]) / 2 - y, (a[2] + c[2]) / 2 - z];
      const ml = Math.hypot(...m) || 1;
      const n = [m[0] / ml, m[1] / ml, m[2] / ml];
      if (i === 0) w.tri(a, c, d, n, [0, 0], [1, 1], [0, 1], color);
      else if (i === lat - 1) w.tri(a, b, d, n, [0, 0], [1, 0], [0, 1], color);
      else w.quad(a, b, c, d, n, [0, 0], [1, 0], [1, 1], [0, 1], color);
    }
  }
}
