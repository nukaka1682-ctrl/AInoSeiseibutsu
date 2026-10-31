// 車道の標示（ユーザーのストリートビュー 1・5・7・10〜13・24・29 を手本に）: 中央線・車線の破線・路側線、
// 自転車レーン（破線と自転車・矢印のマーク）、バスレーン（太い実線と「BUS」）、自転車道の自転車マーク、
// 交差点を出た所の「30」「20」。
// 位置は道の始点からの距離 s だけで決め、中心が範囲（タイル）にある物だけを書くので、隣のタイルと継ぎ目なくつながる。
// 書く高さは地面からの高さ（0 = 路面）。地形の起伏は書き込み先（MeshWriter の drape）が付ける。
// 交差点の中と、横断歩道・停止線の手前（cuts: planStreets が決める）には線を引かない
import { CAR_ROADS } from './parse.js';
import { hash01 } from '../geo.js';

export const MARK_W = 0.12; // 中央線・車線の線の幅（m）
export const CELLS = 8; // 標示のアトラス（textures.js makeMarkingTexture）の升の数（横に並ぶ）
export const CELL = { bike: 0, arrow: 1, bus: 2, n30: 3, n20: 4, solid: 5 };
// 絵の大きさ（m）: [道の向きの長さ, 幅]。路面の文字は運転席から読めるよう道の向きに長く引き伸ばす
export const PIC_SIZE = { bike: [1.8, 1.0], arrow: [3, 0.7], bus: [3.6, 1.5], n30: [2.8, 1.4], n20: [2.8, 1.4] };
// 線の種類 [線, すき間]: T1（中央線・車線、3 m と 10 m）、T3（自転車レーン・路側線、3 m と 3.5 m）、実線（バスレーン）
export const DASH = { t1: [3, 10], t3: [3, 3.5], solid: [6, 0], fill: [6, 0] };
export const RED_LANE = [0.5, 0.21, 0.17]; // 赤い舗装の自転車レーン（kind: 'fill' の線の色）

// バスレーン・自転車レーンのある通り（IGN のデータに車線の種類がないので名前で。OSM の cycleway=lane も使う）
export const LANE_LIST = [
  { match: /^Pont Neuf$/i, bus: true, bike: true },
  { match: /^Rue de Metz$/i, bus: true },
  { match: /^Rue de la R[ée]publique$/i, bike: true },
  { match: /^All[ée]es Jean[- ]Jaur[èe]s$/i, bike: true },
  { match: /^Avenue de (la )?Grande[- ]Bretagne$/i, bike: true },
  { match: /^Route de Bayonne$/i, bike: true, red: true }, // 赤い舗装の自転車レーン（ユーザーの写真: 22 Route de Bayonne）
  { match: /^Avenue [EÉ]tienne Billi[èe]res$/i, bike: true },
];
const LANE_MIN = 2.5; // 一覧の通りでレーンを取ったあとの一般の車線の最小の幅（m）
const MINOR = new Set(['residential', 'unclassified', 'living_street', 'road', 'service']);
const SPEED_TYPES = new Set(['residential', 'unclassified', 'tertiary', 'road']);
const SPEED_R = 1700; // 路面に「30」を書く中心部（原点＝Pont Neuf からの距離）
const SPEED_GAP = 150; // 同じ道の「30」の最小の間隔（m）
// サン・シプリアンの「ゾーン 20」（ユーザーの写真 1・5 の路面の「20」）
export const zone20 = (x, z) => x > -1000 && x < -150 && z > -150 && z < 650;

// 道 1 本の標示の並び（純粋な関数）。off: 中心線からの横のずれ（+ = 頂点の順に進む車の右）。
// lines: { off, kind, w, color? }（kind: 'fill' は赤い舗装のレーンの面）、pics: { off, dir（+1 = 頂点の順の向き）, kind, step, phase }、
// bike: 自転車レーンがあるか（交差点の自転車の待機ボックス）、right / left: 縁石に沿ってバス・自転車レーンがある側
// （頂点の順に進む向きの右・左。そこには路上駐車しない: furniture.js）、rw / lw: その幅（m）、speed: 交差点を出た所に書く数字（'n30' / 'n20'）
export function laneLayout(road, { x = 0, z = 0, old = false } = {}) {
  const lines = [], pics = [];
  const out = { lines, pics, bike: false, right: false, left: false, rw: 0, lw: 0, speed: null };
  if (road.type === 'cycleway') {
    // 自転車道（赤茶色の舗装）: 25 m おきに白い自転車マーク
    if (road.width >= 1.5) pics.push({ off: 0, dir: 1, kind: 'bike', step: 25, phase: 8 });
    return out;
  }
  const cur = LANE_LIST.find((l) => l.match.test(road.name || '')) || {};
  if (road.bare || !CAR_ROADS.has(road.type) || road.type === 'service' || road.width < (cur.bike ? 3.5 : 4)) return out;
  const W = road.width, h = W / 2, two = !road.oneway;
  let lo = -h, hi = h;
  // 名前の一覧にある通りは、そのレーンを優先する（ユーザーの写真の Rue de Metz の BUS レーン・Billières の自転車レーン）:
  // 一般の車線は 1 本 LANE_MIN m まで狭めてよい（足りなければ中央線は引かない）。一覧にない通りは車線 1 本 2.8〜3 m を残す
  const need = (cur.bus || cur.bike ? LANE_MIN : 3) * (two ? 2 : 1);
  // バスレーン（右端 3〜3.2 m、自転車も通る）。太い実線と「BUS」・自転車マーク
  if (cur.bus && W - need >= 3) {
    const bw = Math.min(3.2, W - need);
    lines.push({ off: hi - bw, kind: 'solid', w: 0.25 });
    pics.push({ off: hi - bw / 2, dir: 1, kind: 'bus', step: 50, phase: 14 }, { off: hi - bw / 2, dir: 1, kind: 'bike', step: 50, phase: 34 });
    hi -= bw;
    out.bike = out.right = true;
    out.rw = bw;
  }
  // 自転車レーン（1〜1.5 m）: 破線と、自転車マーク＋矢印を 40 m おき。両方向の道は両側（左側は逆向き）、
  // 両側に取れない一覧の通りは右側だけ
  const bikeLane = cur.bike || /^(lane|opposite_lane|share_busway)$/.test(road.cycleway || '');
  if (bikeLane && !cur.bus) {
    let room = hi - lo - need;
    // 一覧の通りは、狭い区間でも 1 m のレーンを通す（一般の車線を 1 本 2 m まで狭める。IGN の区間ごとに途切れないように:
    // ユーザーの写真 7 の Rue de la République は Pont Neuf の袂までレーンと中央線がある）
    if (cur.bike && room < 1 && hi - lo - (two ? 4 : 2) >= 1) room = 1;
    const bw = Math.min(1.5, two && room >= 3 ? room / 2 : room);
    if (bw >= (cur.bike ? 1 : 1.5)) {
      if (cur.red) lines.push({ off: hi - bw / 2, kind: 'fill', w: bw - 0.05, color: RED_LANE });
      lines.push({ off: hi - bw, kind: 't3', w: 0.2 });
      pics.push({ off: hi - bw / 2, dir: 1, kind: 'bike', step: 40, phase: 10 }, { off: hi - bw / 2, dir: 1, kind: 'arrow', step: 40, phase: 13.5 });
      hi -= bw;
      out.bike = out.right = true;
      out.rw = bw;
      if (two && room >= 2 * bw) {
        if (cur.red) lines.push({ off: lo + bw / 2, kind: 'fill', w: bw - 0.05, color: RED_LANE });
        lines.push({ off: lo + bw, kind: 't3', w: 0.2 });
        pics.push({ off: lo + bw / 2, dir: -1, kind: 'bike', step: 40, phase: 30 }, { off: lo + bw / 2, dir: -1, kind: 'arrow', step: 40, phase: 26.5 });
        lo += bw;
        out.left = true;
        out.lw = bw;
      }
    }
  } else if (bikeLane && two && hi - lo - need >= 1.5) {
    // バスレーンのある両方向の道の左側
    lines.push({ off: lo + 1.5, kind: 't3', w: 0.2 });
    pics.push({ off: lo + 0.75, dir: -1, kind: 'bike', step: 40, phase: 30 }, { off: lo + 0.75, dir: -1, kind: 'arrow', step: 40, phase: 26.5 });
    lo += 1.5;
    out.left = true;
    out.lw = 1.5;
  }
  // 一般の車線: 車線の数（IGN の nombre_de_voies。なければ幅から）で破線、両方向の道は真ん中に中央線（4 車線以上は実線）。
  // 住宅街の一方通行は 1 車線（余った幅は路上駐車）
  const span = hi - lo;
  let n = road.lanes > 0 ? road.lanes - (cur.bus ? 1 : 0) : 0;
  if (!(n >= 1)) n = two ? 2 * Math.max(1, Math.round(span / 6.4)) : MINOR.has(road.type) ? 1 : Math.max(1, Math.round(span / 3.2));
  if (two) n = Math.max(2, n - (n % 2));
  while (n > (two ? 2 : 1) && span / n < LANE_MIN) n -= two ? 2 : 1;
  const centre = two && W >= 6 && span >= (cur.bike ? 4 : 2 * LANE_MIN) && (!MINOR.has(road.type) || W >= 8);
  for (let i = 1; i < n; i++) {
    const off = lo + (i * span) / n;
    if (two && i === n / 2) {
      if (centre) lines.push({ off, kind: n >= 4 ? 'solid' : 't1', w: MARK_W });
    } else if (span / n >= LANE_MIN) lines.push({ off, kind: 't1', w: MARK_W });
  }
  // 広い道の路側線（T3 の破線）。バス・自転車レーンのある所はその線が縁になる
  if (W > 9 && !old && !cur.bus && !out.bike) {
    lines.push({ off: -h + 0.3, kind: 't3', w: 0.15 }, { off: h - 0.3, kind: 't3', w: 0.15 });
  }
  if (SPEED_TYPES.has(road.type) && Math.hypot(x, z) < SPEED_R) out.speed = zone20(x, z) ? 'n20' : 'n30';
  return out;
}

// 区間の列をまとめる（重なる区間をつなぐ）
export function mergeIntervals(list) {
  const s = list.filter((c) => c[1] > c[0]).sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const c of s) {
    const last = out[out.length - 1];
    if (last && c[0] <= last[1]) last[1] = Math.max(last[1], c[1]);
    else out.push([c[0], c[1]]);
  }
  return out;
}

// [a, b] から cuts（まとめた区間）を除いた部分
export function subtract(a, b, cuts) {
  const out = [];
  let s = a;
  for (const [c0, c1] of cuts) {
    if (c1 <= s) continue;
    if (c0 >= b) break;
    if (c0 > s) out.push([s, c0]);
    s = Math.max(s, c1);
    if (s >= b) break;
  }
  if (s < b) out.push([s, b]);
  return out;
}

// 折れ線 pts（累積の長さ cum）の距離 s の点と向き
export function frameAt(pts, cum, s) {
  let lo = 0, hi = cum.length - 1;
  if (s <= 0) lo = 0;
  else if (s >= cum[hi]) lo = hi - 1;
  else {
    while (hi - lo > 1) {
      const m = (lo + hi) >> 1;
      if (cum[m] <= s) lo = m;
      else hi = m;
    }
  }
  const a = pts[lo], b = pts[lo + 1];
  const L = cum[lo + 1] - cum[lo] || 1;
  const t = (s - cum[lo]) / L;
  return { x: a[0] + (b[0] - a[0]) * t, z: a[1] + (b[1] - a[1]) * t, ux: (b[0] - a[0]) / L, uz: (b[1] - a[1]) / L };
}

// 折れ線 pts（累積の長さ cum）の [a, b] の部分
export function slicePolyline(pts, cum, a, b) {
  const out = [];
  const at = (s) => {
    const f = frameAt(pts, cum, s);
    return [f.x, f.z];
  };
  out.push(at(a));
  for (let i = 1; i + 1 < pts.length; i++) if (cum[i] > a && cum[i] < b) out.push(pts[i]);
  out.push(at(b));
  return out;
}

// トラムの芝の軌道を止める区間（折れ線 pts の始点からの距離）: 車道を横切る所（交差点。車道の帯＋1 m）と横断歩道。
// トゥールーズのトラムは交差点をアスファルト・石畳の上で渡る。roads: 近くの車道、crossings: 横断歩道（planStreets）
export function tramCrossCuts(pts, roads, crossings = []) {
  const cuts = [];
  const hit = (s0, ax, az, ux, uz, L, bx, bz, vx, vz, M, half) => {
    // 区間 a + t·u（0..L）と b + k·v（0..M）の交わり。浅い角度（20° 未満: 並んで走る道）は数えない
    const den = ux * vz - uz * vx;
    if (Math.abs(den) < 0.34) return;
    const t = ((bx - ax) * vz - (bz - az) * vx) / den, k = ((bx - ax) * uz - (bz - az) * ux) / den;
    if (t < 0 || t > L || k < -0.5 || k > M + 0.5) return;
    const d = half / Math.abs(den);
    cuts.push([s0 + t - d, s0 + t + d]);
  };
  let s0 = 0;
  for (let i = 0; i + 1 < pts.length; i++) {
    const [ax, az] = pts[i], [bx2, bz2] = pts[i + 1];
    const L = Math.hypot(bx2 - ax, bz2 - az);
    if (L < 1e-6) continue;
    const ux = (bx2 - ax) / L, uz = (bz2 - az) / L;
    for (const r of roads) {
      for (let j = 0; j + 1 < r.pts.length; j++) {
        const [cx, cz] = r.pts[j], [dx, dz] = r.pts[j + 1];
        const M = Math.hypot(dx - cx, dz - cz);
        if (M < 1e-6) continue;
        hit(s0, ax, az, ux, uz, L, cx, cz, (dx - cx) / M, (dz - cz) / M, M, r.width / 2 + 1);
      }
    }
    for (const c of crossings) {
      // 横断歩道の帯の中心線（道を横切る向き n、長さ 2·half）
      const nx = -c.uz, nz = c.ux;
      hit(s0, ax, az, ux, uz, L, c.x - nx * c.half, c.z - nz * c.half, nx, nz, 2 * c.half, c.len / 2 + 0.3);
    }
    s0 += L;
  }
  return mergeIntervals(cuts);
}

// 点 (x, z) が道 roads のどれかのバス・自転車レーン（layout(road) の right / left、縁石から rw / lw m）の上か（純粋な関数）。
// pad: 帯を車道の中の側へ広げる幅（車の半幅など）。縁石の外（歩道）は 0.3 m まで
export function inLaneBand(x, z, roads, layout, pad = 0) {
  for (const r of roads) {
    const lay = layout(r);
    if (!lay || (!lay.right && !lay.left)) continue;
    const h = r.width / 2;
    for (let i = 0; i + 1 < r.pts.length; i++) {
      const [ax, az] = r.pts[i], [bx, bz] = r.pts[i + 1];
      const L = Math.hypot(bx - ax, bz - az);
      if (L < 1e-6) continue;
      const ux = (bx - ax) / L, uz = (bz - az) / L;
      const t = (x - ax) * ux + (z - az) * uz;
      if (t < -0.5 || t > L + 0.5) continue;
      const off = (x - ax) * -uz + (z - az) * ux; // + = 頂点の順に進む向きの右
      if (lay.right && off > h - lay.rw - pad && off < h + 0.3) return true;
      if (lay.left && off < -h + lay.lw + pad && off > -h - 0.3) return true;
    }
  }
  return false;
}

// トラムの架線柱を立てる距離（線の始点から。純粋な関数）: step m おき（最初は step / 2）。車道・横断歩道を横切る区間 cuts
// （tramCrossCuts、mergeIntervals 済み）とその前後 margin m に来る柱は区間の終わりの margin m 先へずらし、次の柱に近すぎれば立てない
export function catenaryStations(total, cuts, step, margin = 3) {
  const out = [];
  for (let s = step / 2; s <= total; s += step) {
    let p = s;
    for (const [a, b] of cuts) if (p > a - margin && p < b + margin) p = b + margin;
    if (p <= total && p < s + step - 2 * margin) out.push(p);
  }
  return out;
}

const UP = [0, 1, 0];
const WHITE = [0.9, 0.9, 0.88];
const cellUV = (k, u, v) => [(k + 0.02 + u * 0.96) / CELLS, v];

// 道 road の標示を書く。cum: 頂点ごとの累積の長さ、lay: laneLayout、cuts: 線を止める区間（mergeIntervals 済み）、
// clip: 書く範囲（中心がこの中の物だけ）。entries: 「30」を書く入口（planStreets）。lineW: 線の書き込み先、picW: 絵（アトラスの材質）の書き込み先。
// y: 地面からの高さ（橋は橋面の高さ）、solid: 線もアトラスの白い升で書く（線と絵を 1 つの書き込み先にまとめる橋）。
// 戻り値: 書いた線と絵の数
export function writeRoadMarkings(road, cum, lay, cuts, clip, lineW, picW, { y = 0, solid = false, pad = 8, entries = [] } = {}) {
  const pts = road.pts, total = cum[cum.length - 1];
  const inClip = (x, z) => x >= clip.minX && x < clip.maxX && z >= clip.minZ && z < clip.maxZ;
  let count = 0;
  // 範囲の近くを通る区間（道の始点からの距離）
  const near = [];
  for (let i = 0; i + 1 < pts.length; i++) {
    const [ax, az] = pts[i], [bx, bz] = pts[i + 1];
    if (Math.max(ax, bx) < clip.minX - pad || Math.min(ax, bx) > clip.maxX + pad || Math.max(az, bz) < clip.minZ - pad || Math.min(az, bz) > clip.maxZ + pad) continue;
    near.push([cum[i] - pad, cum[i + 1] + pad]);
  }
  if (!near.length) return 0;
  const ranges = mergeIntervals(near);
  const P = (s, off) => {
    const f = frameAt(pts, cum, Math.max(0, Math.min(total, s)));
    return { x: f.x - f.uz * off, z: f.z + f.ux * off, ux: f.ux, uz: f.uz };
  };
  const lineUV = solid ? [cellUV(CELL.solid, 0.5, 0.5), cellUV(CELL.solid, 0.5, 0.5)] : [[0, 0], [0, 0]];
  for (const ln of lay.lines) {
    const [dash, gap] = DASH[ln.kind];
    const period = dash + gap, hw = ln.w / 2;
    for (const [r0, r1] of ranges) {
      for (let k = Math.max(0, Math.floor((r0 - dash) / period)); k * period < Math.min(r1, total); k++) {
        const a = k * period, b = Math.min(total, a + dash);
        for (const [p0, p1] of subtract(a, b, cuts)) {
          if (p1 - p0 < (gap ? 0.6 : 0.2)) continue;
          const m = P((p0 + p1) / 2, ln.off);
          if (!inClip(m.x, m.z)) continue;
          const A = P(p0, ln.off), B = P(p1, ln.off);
          const nA = [-A.uz * hw, A.ux * hw], nB = [-B.uz * hw, B.ux * hw];
          lineW.quad([A.x - nA[0], y, A.z - nA[1]], [B.x - nB[0], y, B.z - nB[1]], [B.x + nB[0], y, B.z + nB[1]], [A.x + nA[0], y, A.z + nA[1]], UP, lineUV[0], lineUV[0], lineUV[1], lineUV[1], ln.color || WHITE);
          count++;
        }
      }
    }
  }
  // 絵（自転車・矢印・BUS）: phase から step m おき。線を止める区間とその近くは書かない
  const pic = (s, off, dir, kind) => {
    const len = PIC_SIZE[kind][0];
    const a = s - len / 2 - 1, b = s + len / 2 + 1;
    if (a < 0 || b > total || cuts.some(([c0, c1]) => c1 > a && c0 < b)) return false;
    const c = P(s, off);
    if (!inClip(c.x, c.z)) return true; // 隣のタイルが書く（間隔は数える）
    writePicture(picW, c.x, c.z, c.ux * dir, c.uz * dir, kind, y);
    count++;
    return true;
  };
  for (const p of lay.pics) {
    for (const [r0, r1] of ranges) {
      for (let k = Math.max(0, Math.floor((r0 - p.phase) / p.step)); p.phase + k * p.step < Math.min(r1, total); k++) pic(p.phase + k * p.step, p.off, p.dir, p.kind);
    }
  }
  // 「30」「20」: 格上の道から入った所（entries: 交差点を出た所の距離 s と出ていく向き dir。planStreets）の 6 m 先、
  // 出ていく車線に。同じ道では SPEED_GAP m 以上あける
  if (lay.speed && !road.bridge) {
    let last = -Infinity;
    for (const e of [...entries].sort((a, b) => a.s - b.s)) {
      const s = e.s + 6 * e.dir;
      if (s - last < SPEED_GAP) continue;
      const off = road.oneway ? 0 : (e.dir * road.width) / 4;
      if (pic(s, off, e.dir, lay.speed)) last = s;
    }
  }
  return count;
}

// 絵 1 枚（アトラスの升 kind）: 中心 (x, z)、上の向き (ux, uz)（読む人の進む向き）
export function writePicture(w, x, z, ux, uz, kind, y = 0, color = WHITE) {
  const [len, wid] = PIC_SIZE[kind];
  const a = len / 2, b = wid / 2;
  const nx = -uz, nz = ux; // 進む向きの右
  const p = (s, t) => [x + ux * s + nx * t, y, z + uz * s + nz * t];
  const k = CELL[kind];
  w.quad(p(-a, -b), p(a, -b), p(a, b), p(-a, b), UP, cellUV(k, 0, 0), cellUV(k, 0, 1), cellUV(k, 1, 1), cellUV(k, 1, 0), color);
}
