// 橋の形（ground.js の buildGroundDetail から、橋の中ほどの点が入る範囲で作る）。
//
// - 深い水（ガロンヌ川）を渡る石の橋: 水の区間に橋脚とアーチを並べ、アーチの面の迫石（せりいし）の輪、アーチの下面
//   （レンガのヴォールト）、アーチの間の壁（スパンドレル）、上流・下流に尖った水切りと段々の石のピラミッドの笠を作る。
//   ポン・ヌフは写真と実物の寸法を手本に、大きさの違う 7 つのかご形のアーチ（中ほどがいちばん大きい約 30 m）、
//   白い石の迫石とレンガが交互のアーチの輪、橋脚の上を貫く丸い穴（デグロワール、直径約 4 m、石の縁取り）、
//   橋脚の下の低い石の台、両側の欄干の 5 灯の燭台形の街灯（25〜30 m おき）。
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
const PARAPET = 1.05; // 欄干の高さ
const PONT_NEUF_HALF = 10.5; // ポン・ヌフの幅の半分（実物は欄干の外まで約 21 m）
// ポン・ヌフ: 左岸（西）から右岸へ、7 つのアーチの径間と 6 つの橋脚の厚み（m、水の区間の長さに合わせて伸縮）
export const PONT_NEUF = { spans: [14.4, 20.4, 25.0, 31.7, 28.6, 25.4, 22.0], piers: [6.2, 6.6, 7.0, 7.2, 7.0, 6.6] };
// 石・レンガのアーチ橋として作る橋の名前（データに橋の構造・材料のタグがないので、実物が石積みの橋だけを挙げる）。
// ほかの深い水を渡る橋は近代の橋
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
  parapet: T('#ac997d'),
  coping: T('#c0b39c'),
  flat: T('#c58a6e'),
  concrete: T('#b7b3ab'),
  concreteDark: T('#9a978f'),
  lamp: T('#5b6a63'), // 灰緑の鋳鉄
  globe: T('#f1eee4'),
};

export function deckHalf(road) {
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

// 橋（tile の中の橋 bridges）を作る。allRoads: エリア全体の道路（並んだ橋のまとまりを調べる）
export function buildBridges(bridges, allRoads, mats, waterDepthAt, clipRect) {
  const info = bridgeGroups(allRoads);
  const deck = new MeshWriter();
  const body = new MeshWriter();
  for (const road of bridges) {
    const v = info.get(road);
    if (!v) continue;
    const root = info.get(v.root);
    if (!root.style) root.style = bridgeStyle(v.root, root, waterDepthAt);
    writeDeck(deck, body, road, v.half, root.style.kind, info, clipRect);
    if (v.root === road) writeStructure(body, road, root);
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

// 橋の種類と、水の区間ごとのアーチの並び
export function bridgeStyle(road, v, waterDepthAt) {
  const fr = polyFrame(road.pts);
  const step = 1.5;
  const depths = [];
  for (let s = step / 2; s < fr.length; s += step) {
    const [x, z] = fr.at(road.pts, s);
    depths.push(waterDepthAt(x, z));
  }
  const wet = wetIntervals(depths, step).map((w) => ({ ...w, s1: Math.min(w.s1, fr.length) }));
  if (!wet.length) return { kind: 'flat', wet };
  // 石の橋の一覧にない橋と、高速道路・幹線道路を含むまとまりは近代の橋
  const members = v.members || [road];
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
function writeDeck(deck, body, road, half, kind, info, clipRect) {
  const topY = CAR_ROADS.has(road.type) ? 0.08 : 0.14; // 歩道橋は少し高くして、重なっても Z ファイティングしないように
  const st = roadStyle(road);
  const modern = kind === 'modern';
  for (const pts of clipPolylineToRect(road.pts, ...clipRect)) {
    if (pts.length < 2) continue;
    // 車道の橋は、車道の両側を明るい歩道に（暗いアスファルトのテクスチャを明るくする色）
    const car = CAR_ROADS.has(road.type) && st.tex === 'asphalt';
    writeDeckRibbon(deck, pts, half, car ? road.width / 2 : half, topY, st.tex === 'asphalt' ? st.color : c3('#c9c4ba'), c3('#e2d8ca', 1.6));
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
        vq(pa, pb, ct, top, n, COL.parapet);
        hq(pa, pb, ib, ia, top, up, COL.coping);
        vq(ia, ib, topY, top, ni, COL.parapet);
      }
    }
  }
}

function writeDeckRibbon(w, pts, half, inner, y, color, sideColor) {
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
  strip(out.L, mid.L, sideColor);
  strip(mid.R, out.R, sideColor);
}

// 橋の本体（親の way だけ）: 側面・底・アーチ・橋脚・水切り・街灯
function writeStructure(w, road, v) {
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
  // 側面の 2 次元の四角形（a..d: [s, y]）。stone: 石の目地の大きさのテクスチャ
  const fq = (sd, a, b, c, d, color, stone = false) => {
    if (Math.abs((b[0] - a[0]) * (d[1] - a[1]) - (b[1] - a[1]) * (d[0] - a[0])) + Math.abs((c[0] - b[0]) * (d[1] - b[1]) - (c[1] - b[1]) * (d[0] - b[0])) < 1e-4) return;
    const uv = (q) => (stone ? [(q[0] * sd) / 8, q[1] / 20] : [(q[0] * sd) / 4, q[1] / 4]);
    w.quad(P(sd, ...a), P(sd, ...b), P(sd, ...c), P(sd, ...d), N(sd, (a[0] + c[0]) / 2), uv(a), uv(b), uv(c), uv(d), color);
  };
  const fl = fr.length;
  const plainSides = (bottom, color) => {
    // 平らな側面（bottom〜蛇腹）と底面
    const ss = [...fr.cum];
    for (const sd of [1, -1]) for (let i = 0; i + 1 < ss.length; i++) fq(sd, [ss[i], bottom], [ss[i + 1], bottom], [ss[i + 1], CORNICE], [ss[i], CORNICE], color);
    for (let i = 0; i + 1 < ss.length; i++) {
      const a = P(1, ss[i], bottom), b = P(-1, ss[i], bottom), c = P(-1, ss[i + 1], bottom), d = P(1, ss[i + 1], bottom);
      w.quad(a, b, c, d, [0, -1, 0], [0, 0], [1, 0], [1, 1], [0, 1], color);
    }
  };
  if (kind === 'flat') return plainSides(LAND_BOTTOM, COL.flat);
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
        const x = c[0] + n[0] * (half - 0.15), z = c[1] + n[2] * (half - 0.15);
        writeLamp(w, x, z, U(s), 0.08);
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

// ポン・ヌフの街灯: 欄干の中の石の台座、灰緑の鋳鉄の柱（高さ約 8.5 m）、十字の腕の先と頂上に 5 つの白い球
function writeLamp(w, x, z, [ux, uz], baseY) {
  const vx = -uz, vz = ux;
  const box = (cx, cz, y0, y1, hu, hv, color) => {
    const c = (a, b) => [cx + ux * a + vx * b, cz + uz * a + vz * b];
    const P4 = [c(-hu, -hv), c(hu, -hv), c(hu, hv), c(-hu, hv)];
    for (let i = 0; i < 4; i++) {
      const a = P4[i], b = P4[(i + 1) % 4];
      const mx = (a[0] + b[0]) / 2 - cx, mz = (a[1] + b[1]) / 2 - cz, ml = Math.hypot(mx, mz) || 1;
      w.quad([a[0], y0, a[1]], [b[0], y0, b[1]], [b[0], y1, b[1]], [a[0], y1, a[1]], [mx / ml, 0, mz / ml], [0, 0], [0.2, 0], [0.2, 0.3], [0, 0.3], color);
    }
    w.quad([P4[0][0], y1, P4[0][1]], [P4[1][0], y1, P4[1][1]], [P4[2][0], y1, P4[2][1]], [P4[3][0], y1, P4[3][1]], [0, 1, 0], [0, 0], [0.2, 0], [0.2, 0.2], [0, 0.2], color);
  };
  const y0 = baseY;
  box(x, z, y0, y0 + PARAPET + 0.3, 0.38, 0.38, COL.coping); // 台座
  box(x, z, y0 + PARAPET + 0.3, y0 + PARAPET + 0.9, 0.2, 0.2, COL.lamp); // 柱の根元
  // 柱（6 角、上ほど細い）
  const yb = y0 + PARAPET + 0.9, yt = y0 + 8.1;
  for (let i = 0; i < 6; i++) {
    const a0 = (i / 6) * Math.PI * 2, a1 = ((i + 1) / 6) * Math.PI * 2, am = (a0 + a1) / 2;
    const p = (a, r, y) => [x + Math.cos(a) * r, y, z + Math.sin(a) * r];
    w.quad(p(a0, 0.12, yb), p(a1, 0.12, yb), p(a1, 0.07, yt), p(a0, 0.07, yt), [Math.cos(am), 0.05, Math.sin(am)], [0, 0], [0.1, 0], [0.1, 1], [0, 1], COL.lamp);
  }
  // 十字の腕と 5 つの球
  const ya = y0 + 7.5;
  box(x, z, ya - 0.05, ya + 0.05, 0.62, 0.04, COL.lamp);
  box(x, z, ya - 0.05, ya + 0.05, 0.04, 0.62, COL.lamp);
  const globes = [[0.62, 0], [-0.62, 0], [0, 0.62], [0, -0.62]].map(([a, b]) => [x + ux * a + vx * b, ya + 0.3, z + uz * a + vz * b]);
  globes.push([x, yt + 0.3, z]);
  for (const [gx, gy, gz] of globes) writeGlobe(w, gx, gy, gz, 0.23, COL.globe);
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
