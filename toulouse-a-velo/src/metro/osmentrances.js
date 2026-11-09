// 駅の出入口を OpenStreetMap の屋内の地図から作る（three.js を使わない。単体テストできる）。
// 地上と地下をつなぐ階段・エスカレーター（level="0;-1" など）を、並んだもの（階段とエスカレーターが並ぶ出入口）ごとにまとめ、
// 上の端（地上）から下の端（地下）へ下りる吹き抜け（world/metro.js の出入口の形）にする。LiDAR の地形モデルで見つけた吹き抜けが
// 同じ所・同じ向きにあれば、その形（長さ・幅・中心）を使う（測った形の方が正確）。
// - 屋根の下・建物の中の階段（tunnel=yes・indoor）は「建物の入口」（door）
// - エレベーターだけの出入口は「エレベーター」（elevator）
// - 地上の駅舎（édicule）の駅は、吹き抜けを駅舎で覆う（covered）
// 座標は [緯度, 経度]。計算は駅の中心の局所座標（m。x 東・z 南）
import { LocalProjection } from '../geo.js';

// 写真・記事（フランス語版ウィキペディアの各駅の記事）で決めた駅のつくり
// - hall: 'surface'（切符売り場が地上の駅舎の中。階段は駅舎の中から下りる）、'aerial'（高架の駅。駅舎は地上、ホームは上）
// - platform: 線ごとのホームの形（'central' 島式、既定は相対式）
export const STATION_FACTS = {
  'basso-cambo': { hall: 'aerial' },
  jolimont: { hall: 'aerial' },
  bellefontaine: { hall: 'surface' }, // 「salle des billets dans un édicule en rez-de-chaussée」
  'mirail-universite': { hall: 'surface' }, // 「accessible depuis un grand bâtiment」
  'fontaine-lestang': { hall: 'surface' }, // 「salle des billets ... en rez-de-chaussée, dans un petit bâtiment」
  argoulets: { hall: 'surface' }, // 「accessible depuis un grand bâtiment」
  empalot: { hall: 'surface' }, // 「une seule entrée, accessible depuis un grand bâtiment」
  'faculte-de-pharmacie': { hall: 'surface' }, // 「accessible par un bâtiment」
  ramonville: { hall: 'surface' }, // 出入口は地上（「faire rentrer la lumière du jour jusqu'aux quais」）
  capitole: { platform: { A: 'central' } }, // 「un grand quai central」
  esquirol: { platform: { A: 'central' } }, // 「un grand quai central」
  'jean-jaures': { platform: { A: 'central' } }, // ligne A : 1 central（B 線は島式と相対式の両方。ここでは相対式）
};

const STAIRS_HALF = 0.95, ESC_HALF = 0.6, LANDING = 2.4;

function unit(x, z) {
  const l = Math.hypot(x, z) || 1;
  return [x / l, z / l];
}

// 階段の線の上の端（地上の側）と下の端。incline（上りの向き）がなければ、駅の中心から遠い方を上に
function stepEnds(s, P) {
  const a = P(s.pts[0]), b = P(s.pts[s.pts.length - 1]);
  if (s.incline === 'up') return { U: b, D: a };
  if (s.incline === 'down') return { U: a, D: b };
  return Math.hypot(...a) >= Math.hypot(...b) ? { U: a, D: b } : { U: b, D: a };
}

// 駅 1 つの出入口。st: toulouse-metro-osm.json の駅、lidar: LiDAR で見つけた吹き抜け（toulouse-metro.json の entrances）、
// facts: STATION_FACTS の駅の項目
export function stationBouches(st, lidar = [], facts = {}) {
  const proj = new LocalProjection(st.c[0], st.c[1]);
  const P = (q) => proj.project(q[0], q[1]);
  const LL = (x, z) => proj.unproject(x, z).map((v) => Math.round(v * 1e7) / 1e7);
  const out = [];
  const street = st.steps.filter((s) => s.levels.length >= 2 && s.levels.includes(0) && s.levels.some((l) => l < 0) && s.pts.length >= 2);
  // 屋根のある階段: 建物の中（tunnel）は「建物の入口」、駅舎の中（indoor）は駅舎で覆った吹き抜け
  const covered = (s) => (s.tunnel === 'yes' || s.tunnel === 'building_passage' ? 'door' : s.indoor === 'yes' || facts.hall === 'surface' ? 'hall' : null);
  // 並んだ階段をまとめる
  const items = street.map((s) => {
    const { U, D } = stepEnds(s, P);
    const len = Math.hypot(D[0] - U[0], D[1] - U[1]);
    return { s, U, D, len, dir: unit(D[0] - U[0], D[1] - U[1]), mid: [(U[0] + D[0]) / 2, (U[1] + D[1]) / 2], esc: !!s.conveying && s.conveying !== 'no', cov: covered(s) };
  }).filter((it) => it.len > 1.5);
  const groups = [];
  for (const it of items) {
    let g = groups.find((q) => {
      const a = q.items[0];
      if (a.cov !== it.cov) return false;
      const cos = a.dir[0] * it.dir[0] + a.dir[1] * it.dir[1];
      if (cos < Math.cos((30 * Math.PI) / 180)) return false;
      const dx = it.mid[0] - a.mid[0], dz = it.mid[1] - a.mid[1];
      const lat = Math.abs(-a.dir[1] * dx + a.dir[0] * dz), along = Math.abs(a.dir[0] * dx + a.dir[1] * dz);
      return lat < 4.8 && along < Math.max(a.len, it.len) / 2 + 3;
    });
    if (!g) groups.push((g = { items: [] }));
    g.items.push(it);
  }
  // 出入口の印（OSM の subway_entrance）の近く（15 m）の階段だけ（鉄道の駅の地下道などの階段を除く）
  const entPts = st.entrances.map((e) => P(e.p));
  const nearEntrance = (g) => g.items.some((it) => entPts.some((q) => [it.U, it.D, it.mid].some((p) => Math.hypot(p[0] - q[0], p[1] - q[1]) < 15)));
  const used = new Set();
  for (const g of groups) {
    if (!nearEntrance(g)) continue;
    g.items.forEach((it) => entPts.forEach((q, k) => {
      if ([it.U, it.D, it.mid].some((p) => Math.hypot(p[0] - q[0], p[1] - q[1]) < 15)) used.add(k);
    }));
    // 向き（下りる向き）の平均と、上の端・下の端・横の広がり
    const dir = unit(g.items.reduce((a, it) => a + it.dir[0], 0), g.items.reduce((a, it) => a + it.dir[1], 0));
    const o = g.items[0].mid, side = [-dir[1], dir[0]];
    const u = (p) => (p[0] - o[0]) * dir[0] + (p[1] - o[1]) * dir[1], v = (p) => (p[0] - o[0]) * side[0] + (p[1] - o[1]) * side[1];
    const uTop = Math.min(...g.items.map((it) => u(it.U))), uBot = Math.max(...g.items.map((it) => u(it.D)));
    const v0 = Math.min(...g.items.map((it) => v(it.mid) - (it.esc ? ESC_HALF : STAIRS_HALF))), v1 = Math.max(...g.items.map((it) => v(it.mid) + (it.esc ? ESC_HALF : STAIRS_HALF)));
    const esc = g.items.some((it) => it.esc);
    let len = Math.min(30, Math.max(6, uBot - uTop + LANDING)), wid = Math.min(9, Math.max(2.8, v1 - v0 + 0.5));
    if (esc) wid = Math.max(wid, 4.6);
    const uc = uTop + len / 2, vc = (v0 + v1) / 2;
    let cx = o[0] + dir[0] * uc + side[0] * vc, cz = o[1] + dir[1] * uc + side[1] * vc;
    let ang = Math.atan2(dir[1], dir[0]), down = 1, src = 'osm', depth = null;
    if (g.items[0].cov === 'door') {
      // 建物の中の階段: 建物の入口（上の端）
      const [lat, lon] = LL(o[0] + dir[0] * uTop + side[0] * vc, o[1] + dir[1] * uTop + side[1] * vc);
      out.push({ kind: 'door', station: st.bd, lat, lon, ang, src });
      continue;
    }
    // LiDAR の吹き抜け（同じ所で同じ向き）があれば、その形
    let best = null;
    for (const e of lidar) {
      if (e.kind !== 'metro' || e.synthetic) continue;
      const [ex, ez] = P([e.lat, e.lon]);
      const d = Math.hypot(ex - cx, ez - cz);
      const ed = [Math.cos(e.ang), Math.sin(e.ang)];
      const c = Math.abs(ed[0] * dir[0] + ed[1] * dir[1]);
      if (d < 9 && c > Math.cos((35 * Math.PI) / 180) && (!best || d < best.d)) best = { d, e, ex, ez, ed };
    }
    if (best) {
      const { e, ex, ez, ed } = best;
      cx = ex;
      cz = ez;
      len = e.len;
      wid = Math.max(e.wid, esc ? 4.6 : 0);
      ang = e.ang;
      down = ed[0] * dir[0] + ed[1] * dir[1] >= 0 ? 1 : -1; // OSM の下りる向きにそろえる
      depth = e.depth;
      src = 'osm+lidar';
    }
    const [lat, lon] = LL(cx, cz);
    const level = Math.min(...g.items.flatMap((it) => it.s.levels)); // 着く階
    out.push({ kind: 'metro', station: st.bd, lat, lon, len: +len.toFixed(1), wid: +wid.toFixed(1), ang: +ang.toFixed(3), down, depth, esc, covered: g.items[0].cov === 'hall', level, src });
  }
  // 階段の地図のない出入口: エレベーター、地上の入口（駅舎の扉）、LiDAR の吹き抜け、どれもなければ駅の方へ下りる吹き抜け。
  // 着く階は出入口の印の地下の階（なければ地下 1 階）
  const lowest = (e) => (e.levels.some((l) => l < 0) ? Math.max(...e.levels.filter((l) => l < 0)) : -1);
  const near = (x, z, kinds, r) => out.some((q) => kinds.includes(q.kind) && Math.hypot(...P([q.lat, q.lon]).map((v, i) => v - [x, z][i])) < r);
  st.entrances.forEach((e, k) => {
    const [x, z] = P(e.p);
    if (e.elevator) {
      if (!near(x, z, ['metro', 'elevator'], 6)) out.push({ kind: 'elevator', station: st.bd, lat: e.p[0], lon: e.p[1], src: 'osm' });
      return;
    }
    if (used.has(k) || near(x, z, ['metro', 'door'], 10)) return;
    // LiDAR の吹き抜け（15 m 以内）
    let best = null;
    for (const q of lidar) {
      if (q.kind !== 'metro' || q.synthetic) continue;
      const d = Math.hypot(...P([q.lat, q.lon]).map((v, i) => v - [x, z][i]));
      if (d < 15 && (!best || d < best.d)) best = { d, q };
    }
    if (best && !near(...P([best.q.lat, best.q.lon]), ['metro'], 4)) {
      const q = best.q;
      out.push({ kind: 'metro', station: st.bd, lat: q.lat, lon: q.lon, len: q.len, wid: q.wid, ang: q.ang, down: q.down, depth: q.depth, esc: q.wid >= 4.2, covered: facts.hall === 'surface', level: lowest(e), src: 'lidar@osm' });
      return;
    }
    if (e.levels.length === 1 && e.levels[0] === 0 && facts.hall !== 'surface') {
      // 地上の扉（建物の入口）。向きは駅の中心へ
      out.push({ kind: 'door', station: st.bd, lat: e.p[0], lon: e.p[1], ang: Math.atan2(-z, -x), src: 'osm' });
      return;
    }
    // 下の階の出入口で、地上の階段の地図がない: 印から駅の中心へ下りる 11 m の吹き抜け（印は下の端。地上の駅舎の駅は印が上の端）
    const [dx, dz] = unit(-x, -z);
    const L = 11, top = facts.hall === 'surface' && e.levels.includes(0);
    const k0 = top ? -(L / 2) : L / 2 - 1.2;
    const [lat, lon] = LL(x - dx * k0, z - dz * k0);
    out.push({ kind: 'metro', station: st.bd, lat, lon, len: L, wid: 3.6, ang: +Math.atan2(dz, dx).toFixed(3), down: 1, depth: null, esc: false, covered: facts.hall === 'surface', level: lowest(e), src: 'osm-guess' });
  });
  return dedupe(out, P);
}

// 重なった吹き抜け（同じ開口の両端から下りる階段を別々にまとめたもの・LiDAR の吹き抜けと重なったもの）は 1 つに。
// LiDAR の形を持つ方、なければ長い方を残す
function dedupe(list, P) {
  const pits = list.filter((b) => b.kind === 'metro');
  const score = (b) => (b.src.includes('lidar') ? 1000 : 0) + b.len * b.wid;
  pits.sort((a, b) => score(b) - score(a));
  const keep = [];
  for (const b of pits) {
    const [x, z] = P([b.lat, b.lon]), d = [Math.cos(b.ang), Math.sin(b.ang)];
    const dup = keep.some((k) => {
      const [kx, kz] = P([k.lat, k.lon]), kd = [Math.cos(k.ang), Math.sin(k.ang)];
      const u = Math.abs((x - kx) * kd[0] + (z - kz) * kd[1]), v = Math.abs(-(x - kx) * kd[1] + (z - kz) * kd[0]);
      return Math.abs(d[0] * kd[0] + d[1] * kd[1]) > 0.8 && u < (k.len + b.len) / 2 - 1 && v < (k.wid + b.wid) / 2;
    });
    if (!dup) keep.push(b);
  }
  return [...keep, ...list.filter((b) => b.kind !== 'metro')];
}
