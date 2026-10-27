// 名所の専用モデル（写真とユーザーの写真のメモを手本に組み立てる）。データの建物の外形の代わりに描く
// （当たり判定は元の外形のまま。像・柵は円の当たり判定を足す）。
//   シャトー・ドー:   円形のレンガの基壇（半円アーチの扉）・円筒の塔・手すり付きのテラス・細い上の円筒・灰色のドームと風見・黒い鉄柵
//   スタディアム:     外形（穴 = ピッチ）から、白い外壁・すり鉢の観客席・屋根・ピッチ・4 本の照明塔
//   カバニス:         3 つの外形をまとめた門の形（中央の大きな四角い開口）、テラコッタ色のルーバーと白い階の帯、屋上のガラスの庇
//   オクシタン十字:   キャピトル広場の石畳に埋め込まれたブロンズの十字（12 の玉に星座のメダル）。地面に貼る薄い板
//   雄鶏の像:         オリヴィエ広場。蹄鉄を溶接した暗い錆色の雄鶏（足元にラグビーボール）、赤い木の台（上面は黒）
//   ファストフード店: Route de Bayonne のマクドナルド（ユーザーのストリートビューと航空写真）。ガラスの店先の平屋に外へ傾いた
//                     オレンジ色の羽板の帯と濃い緑の寄棟の屋根、緑と赤の看板塔、道路との間の白い砂利と大きな石の植え込み
//   オテル・デューの中庭: 刈り込んだ四角い木の列に挟まれた砂利の園路、芝の中の低いツゲの模様、北の端の丸い池（ストリートビュー）
//   日本庭園:         コンパン・カファレリの Jardin japonais Pierre-Baudis（ユーザーの写真）。白い塀に囲まれた砂紋の枯山水と石組み、
//                     池の西の茶屋（深い軒の苔むした寄棟）、池の南の入り江に架かる朱色の太鼓橋、白い玉石の州浜と石灯籠、玉作りの松
import * as THREE from 'three';
import { MeshWriter, triangulate } from './meshwriter.js';
import { centroid, hash01, mulberry32, pointInPolygon, pointInRing, signedArea } from '../geo.js';
import { ORDER } from './ground.js';
import { TERRAIN_ORDER } from './terrainmesh.js';
import { CAR_ROADS } from './parse.js';
import { ramblasLayout } from './ramblas.js';
import { LOCKS, lockFrame } from './locks.js';

export const MONUMENTS = [
  { id: 'chateau-eau', kind: 'chateau', lat: 43.59870, lon: 1.43693, r: 20 },
  { id: 'stadium', kind: 'stadium', lat: 43.58330, lon: 1.43404, r: 40 },
  // front: 庇のある正面（門）が向く先。ジャン・ジョレス通り（allées Jean-Jaurès）の軸の突き当たりに門が建つ
  { id: 'cabanis', kind: 'cabanis', lat: 43.61024, lon: 1.45576, r: 45, minHeight: 25, front: [43.6061, 1.4490] },
  { id: 'coq', kind: 'coq', lat: 43.59823, lon: 1.43445, plaza: /^Place Olivier$/i },
  { id: 'croix-occitane', kind: 'cross', plaza: /^Place du Capitole$/i, radius: 8 },
  // ラ・グラーヴの円屋根（Chapelle Saint-Joseph de la Grave。利用者の写真 NCM_0102・0105・0107）: 礼拝堂の建物の上に、
  // 直径約 19 m のレンガのドラム（高さ約 25 m まで）と鉛色のドーム（約 38 m）、頂塔と十字架（約 44 m）
  { id: 'grave-dome', kind: 'dome', lat: 43.60082, lon: 1.43301, r: 25 },
  // パット・ドワのロータリーの島（利用者の Street View 210522）: 直径約 18 m の、ばら色のレンガの低い擁壁（0.6 m）に
  // 囲まれた植え込み（低木と小さな木）と、暗い青灰色の鋼の門の形の彫刻（高さ約 6 m・幅約 7 m）
  // サン・シプリアンの Place Intérieure（利用者の Street View 210226）: 2 本の車道のあいだの、ベージュの石灰岩の板の
  // 一段高い歩行者の島（約 45 × 10 m、東の端は丸い）と淡い石の縁石、平らな暗い鉄の格子。line: 島の芯線の東端・西端
  { id: 'st-cyprien-island', kind: 'island', line: [[43.598026, 1.432008], [43.597945, 1.431499]], half: 4.6 },
  // サン・セルナン大聖堂（利用者の写真 NCM_0099）: 地図の外形を押し出しただけの箱の代わりに、身廊・側廊・袖廊の
  // 低い勾配の瓦屋根と、東の端の段々の後陣（放射状の 5 つの小礼拝堂 8 m → 周歩廊 13 m → 後陣の円筒 20 m、どれも
  // 半円錐の瓦屋根）。crossing: 交差部（八角形の鐘楼 towers.js）、apex: 東の端の方向
  { id: 'saint-sernin', kind: 'basilica', lat: 43.60848, lon: 1.442154, r: 40, apex: [43.60863, 1.44250], chevet: [43.608545, 1.442328] },
  // サン・テティエンヌ大聖堂の石の内陣（利用者の写真 NCM_0095）: 石の壁（buildings.js）の外に、控え壁と尖塔飾り、
  // 2 段の尖頭アーチの高い窓、足元のすすけた帯、軒の手すり。landmarkfacades.js の STONE_CHOIRS と同じ所・向き
  { id: 'saint-etienne-choir', kind: 'choir', lat: 43.59988, lon: 1.45046, r: 30, east: [43.59996, 1.4515], split: 1 },
  // オーギュスタン美術館のダルシー棟（利用者の Street View 211548）: Rue d'Alsace-Lorraine に面した壁は、灰色の砂岩の
  // 腰石（1.5 m）の上に背の高い半円アーチのアーケード（幅 3.5 m・高さ 7 m、ガラス）、7.5 m の石の帯、2 つ並びの半円アーチの窓、
  // 12 m の持ち送りの軒（Rue de Metz の側も同じ）。建物の、facing のどれかの方を向いた長さ 10 m 以上の壁に重ねて描く
  { id: 'augustins', kind: 'arcades', lat: 43.60101, lon: 1.44620, r: 40, minArea: 3000, facing: [[43.60101, 1.44533], [43.60030, 1.44620]] },
  // オテル・デューの川側（利用者の写真 NCM_0107・0125・0136）: 真ん中の張り出しの三角の破風、水際の 2 つの大きなアーチ、
  // 正面の前の川の中に残るポン・ヴィユー（古い橋）の橋脚の跡（幅約 8 m、アーチの付け根）
  { id: 'hotel-dieu-river', kind: 'riverfront', lat: 43.59988, lon: 1.43720, r: 45, minArea: 5000, facing: [43.59994, 1.43851] },
  // Port Saint-Sauveur（利用者の写真 NCM_0183・0184）: 港の南西の端のカピテヌリー（北を向いた半円のガラスの正面、
  // 暗い灰色の金属のかまぼこ屋根、レンガの横の壁、棟まで約 9.5 m）と、西の岸壁に沿ってつないだ平底船（péniche）の列
  { id: 'capitainerie', kind: 'capitainerie', lat: 43.59508, lon: 1.45592, r: 15, front: [43.59600, 1.45592] },
  { id: 'port-boats', kind: 'moorings', quay: [[43.596166, 1.455856], [43.595088, 1.455965]], water: [43.59563, 1.45610] },
  // ジャンヌ・ダルクの騎馬像（利用者の写真 NCM_0100）: Place Jeanne d'Arc の南の端の島。灰色の花崗岩の段と台座
  // （約 2.5 m 角・4.5 m、軒のモールディング）の上に、旗を掲げた騎士と馬の暗いブロンズ像（全体で約 8.5 m）
  { id: 'jeanne-arc', kind: 'equestrian', lat: 43.60952, lon: 1.44657, facing: [43.60800, 1.44620] },
  // アリエージュ＝ガロンヌの泉（利用者の写真 NCM_0134）: Place Auguste-Lafourcade の建物の窓のない壁に付いた、淡い石の
  // 壁泉（幅約 6 m・高さ約 7 m、切り石の付け柱・軒・半円のニッチ、白い大理石の 2 人の女性像、貝の形の小さな水盤と大きな水盤）
  { id: 'ariege-garonne', kind: 'wallFountain', lat: 43.59221, lon: 1.44454, r: 30 },
  ...LOCKS, // 閘門（locks.js）
  // サン・シプリアンの入市税の門の小屋（Pavillons de l'octroi。利用者のストリートビュー 2026-10-02 210226、航空写真）:
  // Place Intérieure Saint-Cyprien の西の端、噴水のロータリーの両脇に、淡い石の小さな平屋（約 6 m 四方）。正面は広場（東）を向き、
  // 三角の破風と頂の壺の飾り。at: 2 つの小屋の真ん中、face: 正面が向く点
  { id: 'octroi-saint-cyprien', kind: 'pavilion', at: [[43.598079, 1.430942], [43.597622, 1.430764]], face: [43.59790, 1.43230], size: [5.6, 6], h: 4.6 },
  { id: 'patte-oie', kind: 'roundabout', lat: 43.59640, lon: 1.42303, radius: 9 },
  // ノートルダム・ド・ラ・ドラード大聖堂の川側の正面（利用者の写真 NCM_0110・0112）: 灰色の石の 6 本の円柱（約 12 m）と
  // 三角の破風の柱廊。教会の建物の、川（facing）の方を向いたいちばん長い壁の前に建てる
  { id: 'daurade', kind: 'portico', lat: 43.60097, lon: 1.43983, r: 30, facing: [43.60097, 1.43876] },
  // キャピトルの主塔（Donjon du Capitole。利用者の Street View 211806）: 淡いクリーム色の壁（約 18 m）、出し狭間の帯と
  // 狭間のある胸壁、急なスレートの寄棟屋根に時計の屋根窓、正面の角に円錐の屋根の小塔 2 つ、真ん中に八角形の鐘楼と尖塔（約 40 m）。
  // front: 正面（時計）が向く先（Square Charles-de-Gaulle）
  { id: 'donjon', kind: 'donjon', lat: 43.60442, lon: 1.44478, r: 12, front: [43.60448, 1.44508] },
  // リケの像（Monument à Pierre-Paul Riquet。利用者の写真 212520）: ジャン・ジョレス通りの北東の端、運河の手前。
  // 淡い灰色の花崗岩の島に、2 段の台・石灰岩の台座（3 m 角・4.5 m）と白い大理石の立像（約 3.5 m）
  { id: 'riquet', kind: 'statue', lat: 43.60906, lon: 1.45389, facing: [43.6061, 1.4490] },
  // front: 道路の側（ガラスの面と看板が向く先）。pylon: 道端の看板塔。gravel: 白い砂利の植え込み、mulch: その中の木のチップの島
  // [緯度, 経度, 半径 m]（航空写真 2024 から）
  {
    id: 'mcdo-bayonne', kind: 'fastfood', lat: 43.60828, lon: 1.39535, r: 15, minArea: 150, maxArea: 900,
    front: [43.60795, 1.39540], pylon: [43.60802, 1.39513],
    gravel: [[43.608084, 1.394805], [43.608147, 1.3949], [43.608128, 1.39503], [43.608092, 1.39515], [43.607988, 1.39515], [43.607988, 1.394805]],
    mulch: [[43.608150, 1.39489, 3.2], [43.608075, 1.39502, 3.6], [43.608032, 1.39509, 3.4]],
  },
  // オテル・デュー・サン・ジャックの中庭（航空写真 2024 とストリートビューから）: 中庭の外周、刈り込んだ木の列（左右）、芝の区画、池
  {
    id: 'hotel-dieu-parterre', kind: 'parterre', lat: 43.59969, lon: 1.436825,
    outer: [[43.59981, 1.436675], [43.59985, 1.436775], [43.599844, 1.4369], [43.5998, 1.437], [43.59934, 1.43725], [43.599296, 1.437225], [43.599206, 1.43685], [43.59922, 1.4368]],
    rows: [[[43.59976, 1.436695], [43.599224, 1.43683]], [[43.59978, 1.436995], [43.599328, 1.437235]]],
    lawn: [[43.59963, 1.4367875], [43.59966, 1.4369125], [43.599344, 1.437195], [43.599264, 1.4369125]],
    basin: [43.59969, 1.436825],
  },
  // 日本庭園（航空写真 2024 と写真から）: 茶屋の位置（データの建物を置き換える）、枯山水の砂利の面と白い塀（砂利の側から見て
  // 左から右へ）、茶屋へ渡る木の縁台、太鼓橋の両端、州浜、石灯籠、石組みと玉作りの松の位置 [緯度, 経度]
  {
    id: 'jardin-japonais', kind: 'jgarden', lat: 43.6119432, lon: 1.4318864, r: 12,
    gravel: [[43.6121396, 1.4315433], [43.6121733, 1.4318014], [43.6121306, 1.4318168], [43.6119196, 1.4317349], [43.6119825, 1.4316468], [43.6120633, 1.4315402]],
    wall: [[43.6120633, 1.4315402], [43.6121396, 1.4315433], [43.6121733, 1.4318014]],
    deck: [[43.6120835, 1.4318276], [43.6120767, 1.4319358], [43.6120655, 1.4319343], [43.6120711, 1.4318261]],
    bridge: [[43.6118467, 1.4320888], [43.6118691, 1.4321939]],
    spit: [[43.6120992, 1.4319915], [43.6121306, 1.4320332], [43.6121194, 1.4321105], [43.6120947, 1.4321182], [43.6120633, 1.4320564], [43.6120689, 1.4320023]],
    lantern: [43.6121059, 1.432044],
    rocks: [[43.6121082, 1.4316082], [43.6120992, 1.4316236], [43.6121306, 1.4317318], [43.6121216, 1.4317442], [43.6120296, 1.4316855], [43.6120633, 1.43201], [43.6120296, 1.4319636], [43.6118725, 1.4321491], [43.6119286, 1.4322264], [43.6119174, 1.4322728], [43.6121194, 1.4321337], [43.6120633, 1.4322418]],
    pines: [[43.6121172, 1.4315927], [43.6121351, 1.431755], [43.6120128, 1.4317009], [43.6120296, 1.4322032], [43.6119398, 1.4322805], [43.6118725, 1.4319636], [43.612097, 1.4322264], [43.6120633, 1.4323037]],
  },
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
  if (b > a) [e1, e2, a, b] = [e2, [-e1[0], -e1[1]], b, a]; // 長い辺を e1 に（e2 は e1 に直角のまま）
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

// 車道に沿った広い歩道の上の置き場所（雄鶏の像: 写真では車道の縁の車止めの列のすぐ後ろ、奥に路上駐車の車）。
// roads: 車道 [{ pts, width }]。見える車道（中心線が広場の外を通る所。広場の下を通る道は舗装に隠れる）の縁から
// gap m の、広場の中の点のうち、hint に近く gap が 3 m に近いもの。free(x, z): 置けるか。
// 返り値 { x, z, angle（(cos, sin) が車道の方）} か null
export function kerbSpot(plaza, roads, hint, free, { gaps = [3, 2.5, 3.5, 4], step = 1, maxD = 60 } = {}) {
  let best = null;
  for (const r of roads) {
    const half = r.width / 2;
    for (let i = 0; i + 1 < r.pts.length; i++) {
      const [ax, az] = r.pts[i], [bx, bz] = r.pts[i + 1];
      if (Math.min(ax, bx) > hint[0] + maxD || Math.max(ax, bx) < hint[0] - maxD || Math.min(az, bz) > hint[1] + maxD || Math.max(az, bz) < hint[1] - maxD) continue;
      const L = Math.hypot(bx - ax, bz - az);
      if (L < 1e-6) continue;
      const ux = (bx - ax) / L, uz = (bz - az) / L;
      const n = Math.ceil(L / step);
      for (let k = 0; k <= n; k++) {
        const qx = ax + (bx - ax) * (k / n), qz = az + (bz - az) * (k / n);
        if (Math.hypot(qx - hint[0], qz - hint[1]) > maxD || (plaza && pointInPolygon(qx, qz, plaza))) continue;
        for (const sd of [1, -1]) {
          for (const g of gaps) {
            const px = qx - uz * sd * (half + g), pz = qz + ux * sd * (half + g);
            const score = Math.hypot(px - hint[0], pz - hint[1]) + 2 * Math.abs(g - 3);
            if ((best && score >= best.score) || (plaza && !pointInPolygon(px, pz, plaza)) || !free(px, pz)) continue;
            best = { x: px, z: pz, angle: Math.atan2(qz - pz, qx - px), score };
          }
        }
      }
    }
  }
  return best && { x: best.x, z: best.z, angle: best.angle };
}

// スタジアムの外壁に食い込んだ小さな建物（角の階段の塔など）: 外形の頂点と頂点を共有する、高さ 6 m 以上のもの
// （低い売店・切符売り場はそのまま）
export function stadiumAnnexes(stadium, buildings, maxArea = 400) {
  const near = (p) => stadium.outer.some((q) => Math.hypot(p[0] - q[0], p[1] - q[1]) < 1.5);
  return buildings.filter((b) => b !== stadium && b.info.area < maxArea && (b.info.height || 0) >= 6 && b.outer.some(near));
}

// 名所の専用モデルの置き場所を決める。buildings: このタイル（エリア）の建物、bounds: このタイルの範囲
// （像・十字はその中にあるときだけ作る）、onRoad(x, z): 車道の上か（広場の下を通る道も）、roads: 道路（parse.js。
// 雄鶏の像を見える車道の縁に置くため）。replaced の建物は描かない（当たり判定は残す）
export function findMonuments(proj, { buildings = [], areas = [], facade = null, bounds = null, onRoad = () => false, roads = [] } = {}) {
  const out = [];
  const carRoads = roads.filter((r) => CAR_ROADS.has(r.type) && !r.bridge && !r.tunnel && r.pts?.length >= 2);
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
    } else if (spec.kind === 'dome') {
      // 礼拝堂の建物（いちばん近い 200 m² 以上の建物）の上に載せる
      let best = null;
      for (const b of buildings) {
        const d = Math.hypot(b.inside[0] - x, b.inside[1] - z);
        if (d > spec.r || b.info.area < 200) continue;
        if (!best || d < best.d) best = { b, d };
      }
      if (!best) continue;
      out.push({ spec, kind: 'dome', x, z, base: best.b.info.height || 14, replaced: [] });
    } else if (spec.kind === 'donjon') {
      let best = null;
      for (const b of buildings) {
        const d = Math.hypot(b.inside[0] - x, b.inside[1] - z);
        if (d > spec.r || b.info.area < 80 || b.info.area > 500) continue;
        if (!best || d < best.d) best = { b, d };
      }
      if (!best) continue;
      const ob = orientedBox(best.b.outer);
      const [fx, fz] = proj.project(...spec.front);
      const fl = Math.hypot(fx - ob.cx, fz - ob.cz) || 1;
      out.push({ spec, kind: 'donjon', ...ob, front: [(fx - ob.cx) / fl, (fz - ob.cz) / fl], replaced: [best.b] });
    } else if (spec.kind === 'portico') {
      let best = null;
      for (const b of buildings) {
        const d = Math.hypot(b.inside[0] - x, b.inside[1] - z);
        if (d > spec.r || b.info.area < 500) continue;
        if (!best || d < best.d) best = { b, d };
      }
      if (!best) continue;
      const [fx, fz] = proj.project(...spec.facing);
      const fl = Math.hypot(fx - x, fz - z) || 1, f = [(fx - x) / fl, (fz - z) / fl];
      const ring = best.b.outer, sg = signedArea(ring) > 0 ? 1 : -1;
      let face = null;
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i], c = ring[(i + 1) % ring.length];
        const L = Math.hypot(c[0] - a[0], c[1] - a[1]);
        if (L < 12) continue;
        const n = [((c[1] - a[1]) / L) * sg, (-(c[0] - a[0]) / L) * sg];
        const score = (n[0] * f[0] + n[1] * f[1]) * Math.min(L, 30);
        if (n[0] * f[0] + n[1] * f[1] > 0.7 && (!face || score > face.score)) face = { a, c, L, n, score };
      }
      if (!face) continue;
      out.push({ spec, kind: 'portico', mid: [(face.a[0] + face.c[0]) / 2, (face.a[1] + face.c[1]) / 2], t: [(face.c[0] - face.a[0]) / face.L, (face.c[1] - face.a[1]) / face.L], n: face.n, width: Math.min(22, face.L - 2), replaced: [] });
    } else if (spec.kind === 'basilica') {
      const b = buildings.find((q) => q.info.isChurch && q.info.area > 2000 && Math.hypot(q.inside[0] - x, q.inside[1] - z) < spec.r);
      if (!b) continue;
      const ob = orientedBox(b.outer);
      const [px, pz] = proj.project(...spec.apex);
      const sg = (px - ob.cx) * ob.e1[0] + (pz - ob.cz) * ob.e1[1] >= 0 ? 1 : -1;
      const e1 = [ob.e1[0] * sg, ob.e1[1] * sg], e2 = [-e1[1], e1[0]];
      const sc = (x - ob.cx) * e1[0] + (z - ob.cz) * e1[1];
      out.push({ spec, kind: 'basilica', cx: ob.cx, cz: ob.cz, e1, e2, a: ob.a, b: ob.b, sc, height: b.info.height, replaced: [b] });
    } else if (spec.kind === 'capitainerie') {
      let best = null;
      for (const b of buildings) {
        const d = Math.hypot(b.inside[0] - x, b.inside[1] - z);
        if (d < spec.r && b.info.area > 150 && b.info.area < 800 && (!best || d < best.d)) best = { b, d };
      }
      if (!best) continue;
      const ob = orientedBox(best.b.outer);
      const [fx, fz] = proj.project(...spec.front);
      const fl = Math.hypot(fx - ob.cx, fz - ob.cz) || 1, f = [(fx - ob.cx) / fl, (fz - ob.cz) / fl];
      // かまぼこ屋根の軸は正面の向きに近い方の辺
      const along1 = Math.abs(ob.e1[0] * f[0] + ob.e1[1] * f[1]) >= Math.abs(ob.e2[0] * f[0] + ob.e2[1] * f[1]);
      let ax = along1 ? ob.e1 : ob.e2;
      if (ax[0] * f[0] + ax[1] * f[1] < 0) ax = [-ax[0], -ax[1]];
      out.push({ spec, kind: 'capitainerie', cx: ob.cx, cz: ob.cz, ax, hl: along1 ? ob.a : ob.b, hw: along1 ? ob.b : ob.a, replaced: [best.b] });
    } else if (spec.kind === 'moorings') {
      const [a, b] = spec.quay.map((ll) => proj.project(...ll)), [wx, wz] = proj.project(...spec.water);
      const L = Math.hypot(b[0] - a[0], b[1] - a[1]), t = [(b[0] - a[0]) / L, (b[1] - a[1]) / L];
      let n = [-t[1], t[0]];
      if ((wx - a[0]) * n[0] + (wz - a[1]) * n[1] < 0) n = [-n[0], -n[1]];
      const water = areas.find((q) => q.type === 'water' && pointInPolygon(wx, wz, q));
      const boats = [];
      for (let s = 4, k = 0; s < L - 8; k++) {
        const len = 16 + hash01(k, 71) * 10;
        const c = s + len / 2, off = 3.4 + hash01(k, 72) * 0.6;
        const bx = a[0] + t[0] * c + n[0] * off, bz = a[1] + t[1] * c + n[1] * off;
        if (inB(bx, bz)) boats.push({ x: bx, z: bz, len, k });
        s += len + 2.5 + hash01(k, 73) * 3;
      }
      if (boats.length) out.push({ spec, kind: 'moorings', t, n, boats, area: water || null, replaced: [] });
    } else if (spec.kind === 'riverfront') {
      const b = buildings.find((q) => q.info.area >= spec.minArea && Math.hypot(q.inside[0] - x, q.inside[1] - z) < spec.r);
      if (!b) continue;
      const [fx, fz] = proj.project(...spec.facing);
      const fl = Math.hypot(fx - x, fz - z) || 1, f = [(fx - x) / fl, (fz - z) / fl];
      const sg = signedArea(b.outer) > 0 ? 1 : -1;
      let best = null;
      for (let i = 0; i < b.outer.length; i++) {
        const p = b.outer[i], q = b.outer[(i + 1) % b.outer.length], L = Math.hypot(q[0] - p[0], q[1] - p[1]);
        const n = [((q[1] - p[1]) / L) * sg, (-(q[0] - p[0]) / L) * sg];
        if (L >= 15 && n[0] * f[0] + n[1] * f[1] > 0.6 && (!best || L > best.L)) best = { p, q, L, n };
      }
      if (best) out.push({ spec, kind: 'riverfront', ...best, height: b.info.height || 18, replaced: [] });
    } else if (spec.kind === 'arcades') {
      const b = buildings.find((q) => q.info.area >= spec.minArea && Math.hypot(q.inside[0] - x, q.inside[1] - z) < spec.r);
      if (!b) continue;
      const fs = spec.facing.map((ll) => {
        const [fx, fz] = proj.project(...ll), fl = Math.hypot(fx - x, fz - z) || 1;
        return [(fx - x) / fl, (fz - z) / fl];
      });
      const sg = signedArea(b.outer) > 0 ? 1 : -1, edges = [];
      for (let i = 0; i < b.outer.length; i++) {
        const p = b.outer[i], q = b.outer[(i + 1) % b.outer.length], L = Math.hypot(q[0] - p[0], q[1] - p[1]);
        const n = [((q[1] - p[1]) / L) * sg, (-(q[0] - p[0]) / L) * sg];
        if (L >= 10 && fs.some((f) => n[0] * f[0] + n[1] * f[1] > 0.8)) edges.push({ p, q, L, n });
      }
      if (!edges.length) continue;
      b.blank = true; // 建物の壁は窓のないレンガ（窓・アーケードはこのモデルで描く。buildings.js）
      out.push({ spec, kind: 'arcades', edges, replaced: [] });
    } else if (spec.kind === 'choir') {
      const b = buildings.find((q) => q.info.isChurch && Math.hypot(q.inside[0] - x, q.inside[1] - z) < spec.r);
      if (!b) continue;
      const [ex, ez] = proj.project(...spec.east);
      const l = Math.hypot(ex - x, ez - z) || 1, e = [(ex - x) / l, (ez - z) / l], s0 = x * e[0] + z * e[1] + spec.split;
      const sg = signedArea(b.outer) > 0 ? 1 : -1, edges = [];
      for (let i = 0; i < b.outer.length; i++) {
        const p = b.outer[i], q = b.outer[(i + 1) % b.outer.length], L = Math.hypot(q[0] - p[0], q[1] - p[1]);
        if (L < 3 || ((p[0] + q[0]) / 2) * e[0] + ((p[1] + q[1]) / 2) * e[1] < s0) continue;
        edges.push({ p, q, L, n: [((q[1] - p[1]) / L) * sg, (-(q[0] - p[0]) / L) * sg] });
      }
      out.push({ spec, kind: 'choir', edges, height: b.info.height || 22, replaced: [] });
    } else if (spec.kind === 'lock') {
      const a = proj.project(...spec.a), b = proj.project(...spec.b);
      if (!inB((a[0] + b[0]) / 2, (a[1] + b[1]) / 2)) continue;
      const water = areas.find((q) => q.type === 'water' && pointInPolygon((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, q));
      out.push({ spec, kind: 'lock', a, b, width: spec.width, from: spec.from, area: water || null, replaced: [] });
    } else if (spec.kind === 'pavilion') {
      const [fx, fz] = proj.project(...spec.face);
      for (const ll of spec.at) {
        const [px, pz] = proj.project(...ll);
        if (!inB(px, pz)) continue;
        const fl = Math.hypot(fx - px, fz - pz) || 1;
        out.push({ spec, kind: 'pavilion', x: px, z: pz, f: [(fx - px) / fl, (fz - pz) / fl], size: spec.size, h: spec.h, replaced: [] });
      }
    } else if (spec.kind === 'equestrian') {
      if (!inB(x, z)) continue;
      const [fx, fz] = proj.project(...spec.facing);
      out.push({ spec, kind: 'equestrian', x, z, angle: Math.atan2(fz - z, fx - x), replaced: [] });
    } else if (spec.kind === 'wallFountain') {
      // (x, z) の方を向いた、いちばん近い長さ 7 m 以上の建物の壁の真ん中
      let best = null;
      for (const b of buildings) {
        const sg = signedArea(b.outer) > 0 ? 1 : -1;
        for (let i = 0; i < b.outer.length; i++) {
          const p = b.outer[i], q = b.outer[(i + 1) % b.outer.length], L = Math.hypot(q[0] - p[0], q[1] - p[1]);
          if (L < 7) continue;
          const n = [((q[1] - p[1]) / L) * sg, (-(q[0] - p[0]) / L) * sg], mx = (p[0] + q[0]) / 2, mz = (p[1] + q[1]) / 2;
          const d = Math.hypot(x - mx, z - mz);
          if (d > spec.r || (x - mx) * n[0] + (z - mz) * n[1] < 0.5 * d || (best && d >= best.d)) continue;
          best = { d, mid: [mx, mz], n, t: [(q[0] - p[0]) / L, (q[1] - p[1]) / L] };
        }
      }
      if (!best || !inB(...best.mid)) continue;
      out.push({ spec, kind: 'wallFountain', mid: best.mid, n: best.n, t: best.t, replaced: [] });
    } else if (spec.kind === 'island') {
      const [a, b] = spec.line.map((ll) => proj.project(...ll));
      if (!inB((a[0] + b[0]) / 2, (a[1] + b[1]) / 2)) continue;
      out.push({ spec, kind: 'island', a, b, half: spec.half, replaced: [] });
    } else if (spec.kind === 'roundabout') {
      if (!inB(x, z)) continue;
      out.push({ spec, kind: 'roundabout', x, z, radius: spec.radius, replaced: [] });
    } else if (spec.kind === 'statue') {
      if (!inB(x, z)) continue;
      const [fx, fz] = proj.project(...spec.facing);
      out.push({ spec, kind: 'statue', x, z, angle: Math.atan2(fz - z, fx - x), replaced: [] });
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
      // 見える車道の縁石から 2.5〜4 m の歩道の上（車止めの列・路上駐車の車のそば）。なければ広場の中の hint の近く
      const k = kerbSpot(plaza, carRoads, [x, z], free);
      const p = k ? [k.x, k.z] : placeOnPlaza(plaza, [x, z], free);
      if (!p || !inB(p[0], p[1])) continue;
      // 像は車道の方を向く（縁に置けなかったときは、いちばん近い車道の方）
      let angle = k ? k.angle : 0, bestD = Infinity;
      for (let j = 0; !k && j < 16; j++) {
        const t = (j / 16) * Math.PI * 2;
        for (let d = 2.5; d < 40; d += 0.5) {
          if (onRoad(p[0] + Math.cos(t) * d, p[1] + Math.sin(t) * d)) {
            if (d < bestD) [bestD, angle] = [d, t];
            break;
          }
        }
      }
      out.push({ spec, kind: 'coq', x: p[0], z: p[1], angle, replaced: [] });
    } else if (spec.kind === 'fastfood') {
      let best = null;
      for (const b of buildings) {
        const [bx, bz] = centroid(b.outer), d = Math.hypot(bx - x, bz - z);
        if (d > spec.r || b.info.area < spec.minArea || b.info.area > spec.maxArea) continue;
        if (!best || d < best.d) best = { b, d };
      }
      if (!best) continue;
      const ll = (p) => proj.project(p[0], p[1]);
      out.push({
        spec, kind: 'fastfood', outer: best.b.outer, height: Math.max(4.8, (best.b.info.height || 0) + 0.9), replaced: [best.b],
        front: ll(spec.front), pylon: ll(spec.pylon), gravel: spec.gravel.map(ll), mulch: spec.mulch.map((m) => [...ll(m), m[2]]),
      });
    } else if (spec.kind === 'parterre') {
      const ll = (p) => proj.project(p[0], p[1]);
      const outer = spec.outer.map(ll), [cx, cz] = centroid(outer);
      if (!inB(cx, cz)) continue;
      out.push({ spec, kind: 'parterre', x: cx, z: cz, outer, rows: spec.rows.map((r) => r.map(ll)), lawn: spec.lawn.map(ll), basin: ll(spec.basin), replaced: [] });
    } else if (spec.kind === 'jgarden') {
      const ll = (p) => proj.project(p[0], p[1]);
      const gravel = spec.gravel.map(ll), [gx, gz] = centroid(gravel);
      if (!inB(gx, gz)) continue;
      // 茶屋: 近くの小さな建物（データでは 4 m の箱）を置き換える
      let tea = null;
      for (const b of buildings) {
        const [bx, bz] = centroid(b.outer), d = Math.hypot(bx - x, bz - z);
        if (d < spec.r && b.info.area < 400 && (!tea || d < tea.d)) tea = { b, d };
      }
      out.push({
        spec, kind: 'jgarden', x: gx, z: gz, gravel, wall: spec.wall.map(ll), deck: spec.deck.map(ll), bridge: spec.bridge.map(ll), spit: spec.spit.map(ll),
        lantern: ll(spec.lantern), rocks: spec.rocks.map(ll), pines: spec.pines.map(ll), tea: tea ? tea.b.outer : null, replaced: tea ? [tea.b] : [],
      });
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
  // ジャン・ジョレス通りの遊歩道の植え込み（ramblas.js）: 帯に沿って 2.3 m ごとに低木、約 7.5 m ごとに若い木
  const rl = roads.length ? ramblasLayout(roads, proj) : null;
  if (rl) {
    const shrubs = [], young = [];
    for (const line of rl.beds) {
      let next = 0, acc = 0, nextTree = 3;
      for (let i = 0; i + 1 < line.length; i++) {
        const p = line[i], q = line[i + 1], L = Math.hypot(q[0] - p[0], q[1] - p[1]);
        const ux = (q[0] - p[0]) / L, uz = (q[1] - p[1]) / L;
        for (; next < acc + L; next += 2.3) {
          const t = next - acc, k = Math.round(next / 2.3), off = (k % 2 ? 1 : -1) * (0.8 + hash01(k, 61) * 1.2);
          const x = p[0] + ux * t - uz * off, z = p[1] + uz * t + ux * off;
          if (inB(x, z)) shrubs.push([x, z, k]);
        }
        for (; nextTree < acc + L; nextTree += 6 + hash01(Math.round(nextTree), 62) * 3) {
          const t = nextTree - acc, off = (hash01(Math.round(nextTree), 63) - 0.5) * 2.4;
          const x = p[0] + ux * t - uz * off, z = p[1] + uz * t + ux * off;
          if (inB(x, z)) young.push([x, z, Math.round(nextTree)]);
        }
        acc += L;
      }
    }
    if (shrubs.length || young.length) out.push({ kind: 'ramblas', shrubs, young, replaced: [] });
  }
  return out;
}

// 木を植えない所（像・塔のまわり）
// proj: あれば、タイルの外の名所の所も（隣のタイルの木を名所の前に植えない）
export function monumentClearance(list, proj = null) {
  const circles = [];
  // サン・セルナンの東の端（後陣・周歩廊・礼拝堂）の前は開けた広場（利用者の写真 NCM_0099）。chevet: 後陣の中心
  if (proj) for (const spec of MONUMENTS) if (spec.kind === 'basilica' && spec.chevet) circles.push([...proj.project(...spec.chevet), 30]);
  for (const m of list) {
    if (m.kind === 'chateau') circles.push([m.x, m.z, m.rBase + 9]); // 柵の外の歩道まで（交差点から塔が見えるように）
    if (m.kind === 'coq') circles.push([m.x, m.z, 3]);
    if (m.kind === 'roundabout') circles.push([m.x, m.z, m.radius + 0.5]); // 島の木は島のモデルで描く
    if (m.kind === 'statue') circles.push([m.x, m.z, 6]);
    if (m.kind === 'pavilion') circles.push([m.x, m.z, 5]);
  }
  // 中庭の刈り込んだ木は専用の形で描くので、地形モデルの木（丸い樹冠）は植えない。日本庭園の枯山水の砂利の面にも
  // 植えない（利用者の写真 NCM_0117: 砂利の面には石組みのそばの小さな松だけ）
  const rings = list.filter((m) => m.kind === 'parterre').map((m) => m.outer).concat(list.filter((m) => m.kind === 'jgarden').map((m) => m.gravel));
  return (x, z) => circles.some(([cx, cz, r]) => Math.hypot(x - cx, z - cz) < r) || rings.some((r) => pointInRing(x, z, r));
}

// 名所の台・柵の内側（街の小物 furniture.js を置かない所）。buildMonuments の keepOut の円 [x, z, r]
// （柵に抜けがあって当たり判定が線分のときも、柵の円の内側全体）
export function monumentSolid(keepOut, pad = 0.4) {
  const circles = keepOut.filter((c) => c.length === 3);
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
// 利用者の写真（Street View 211021・29_163047303MP）: 14 角形の低いレンガの基壇（持ち送りの胸壁）、上に向かって細くなる
// オレンジがかったレンガの塔（直径約 7.5 → 6 m、白い帯はなく細いレンガの帯だけ、半円アーチの窓が縦に 3 つ）、
// レンガの持ち送りの上の淡い灰色の石の手すりの回廊、小さな四角い窓が輪に並ぶ上の細い円筒と、暗いスレートのドーム
const BRICK_CW = 1.5; // レンガの区画 1 枚の大きさ（m）
function writeChateau(m, W, groundAt, colliders, onRoad, keepOut) {
  const { x, z } = m;
  const y0 = groundAt(x, z);
  const rB = m.rBase, hB = 5, rT0 = 3.75, rT = 3.0, yT = y0 + 19, rU = 2.25, yU = y0 + 22, rD = 2.4;
  const STONE = col('#e4d8c4'), GREY = col('#c9c5bd'), DARK = col('#2a2420'), IRON = col('#1b1b1c'), ROOF = col('#a39486');
  const TOWER = col('#e2b292'); // レンガの区画に掛ける色（写真の塔は基壇より濃いオレンジ）
  const w = W.main;
  // 基壇（14 角形のレンガ）と、持ち送りの胸壁、平らな屋上
  const NB = 14;
  cylinder(w, x, z, rB, rB, y0 - 0.5, y0 + hB - 0.9, { seg: NB, cell: CELL.brick, cw: BRICK_CW, ch: BRICK_CW });
  cylinder(w, x, z, rB, rB + 0.3, y0 + hB - 0.9, y0 + hB - 0.6, { seg: NB, cell: CELL.brick, cw: BRICK_CW, ch: BRICK_CW });
  cylinder(w, x, z, rB + 0.3, rB + 0.3, y0 + hB - 0.6, y0 + hB, { seg: NB, cell: CELL.brick, cw: BRICK_CW, ch: BRICK_CW });
  annulus(w, x, z, rB + 0.12, rB + 0.3, y0 + hB, NB, STONE);
  annulus(w, x, z, rT0, rB + 0.12, y0 + hB - 0.25, NB, ROOF);
  // 半円アーチの扉（北・南・西の 3 か所、白い石の枠）
  for (const a of [-Math.PI / 2, Math.PI / 2, Math.PI]) {
    const n = [Math.cos(a), 0, Math.sin(a)], s = [-Math.sin(a), Math.cos(a)];
    vpoly(w, [x + n[0] * (rB + 0.06), z + n[2] * (rB + 0.06)], s, archShape(3.1, 4.1, y0), n, STONE);
    vpoly(w, [x + n[0] * (rB + 0.14), z + n[2] * (rB + 0.14)], s, archShape(2.3, 3.6, y0), n, DARK);
  }
  // 塔（上に向かって細くなるレンガの円筒）、細いレンガの帯、半円アーチの窓（縦に 3 つ、4 方向）
  cylinder(w, x, z, rT0, rT, y0 + hB - 0.3, yT - 1.1, { seg: 28, cell: CELL.brick, cw: BRICK_CW, ch: BRICK_CW, color: TOWER });
  const rAt = (y) => rT0 + ((rT - rT0) * (y - y0 - hB + 0.3)) / (yT - 1.1 - y0 - hB + 0.3);
  for (const yb of [y0 + hB + 4.6, y0 + hB + 9.4]) cylinder(w, x, z, rAt(yb) + 0.06, rAt(yb + 0.18) + 0.06, yb, yb + 0.18, { seg: 28, cell: CELL.brick, cw: BRICK_CW, ch: BRICK_CW, color: col('#c99878') });
  for (let k = 0; k < 4; k++) {
    const a = (k / 4) * Math.PI * 2 + Math.PI / 4;
    const n = [Math.cos(a), 0, Math.sin(a)], s = [-Math.sin(a), Math.cos(a)];
    for (const yw of [y0 + hB + 1.6, y0 + hB + 6.3, y0 + hB + 10.6]) {
      const r = rAt(yw + 0.8) + 0.05;
      vpoly(w, [x + n[0] * (r + 0.04), z + n[2] * (r + 0.04)], s, archShape(1.0, 2.0, yw - 0.1, 6), n, col('#c08a6a'));
      vpoly(w, [x + n[0] * (r + 0.08), z + n[2] * (r + 0.08)], s, archShape(0.7, 1.75, yw, 6), n, DARK);
    }
  }
  // レンガの持ち送り（上に広がる）と、張り出した回廊の床、淡い灰色の石の手すり（手すり子の影の縦の線）
  const rS = rT + 0.8;
  cylinder(w, x, z, rT, rS, yT - 1.1, yT - 0.45, { seg: 28, cell: CELL.brick, cw: BRICK_CW, ch: BRICK_CW, color: TOWER });
  cylinder(w, x, z, rS, rS, yT - 0.45, yT, { seg: 28, color: GREY });
  annulus(w, x, z, rU, rS, yT, 28, ROOF);
  const rR = rS - 0.1;
  cylinder(w, x, z, rR, rR, yT, yT + 0.95, { seg: 28, color: GREY });
  cylinder(w, x, z, rR - 0.2, rR - 0.2, yT, yT + 0.95, { seg: 28, color: GREY, inward: true });
  annulus(w, x, z, rR - 0.2, rR + 0.05, yT + 0.95, 28, col('#d8d4cc'));
  const nb = 56;
  for (let k = 0; k < nb; k++) {
    const a = (k / nb) * Math.PI * 2;
    const p = [x + Math.cos(a) * (rR + 0.01), z + Math.sin(a) * (rR + 0.01)], s = [-Math.sin(a), Math.cos(a)];
    vpoly(w, p, s, [[-0.05, yT + 0.18], [0.05, yT + 0.18], [0.05, yT + 0.8], [-0.05, yT + 0.8]], [Math.cos(a), 0, Math.sin(a)], col('#77736c'));
  }
  // 上の細い円筒（小さな四角い窓が 8 つ）と石の軒、暗いスレートのドーム、小さな頂塔と風見
  const mt = W.metal;
  cylinder(w, x, z, rU, rU, yT, yU, { seg: 24, cell: CELL.brick, cw: BRICK_CW, ch: BRICK_CW, color: TOWER });
  cylinder(w, x, z, rU + 0.15, rU + 0.15, yU - 0.35, yU, { seg: 24, color: STONE });
  annulus(w, x, z, rD, rU + 0.15, yU, 24, STONE);
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * Math.PI * 2 + Math.PI / 8;
    const n = [Math.cos(a), 0, Math.sin(a)], s = [-Math.sin(a), Math.cos(a)];
    vpoly(w, [x + n[0] * (rU + 0.04), z + n[2] * (rU + 0.04)], s, [[-0.28, yT + 1.4], [0.28, yT + 1.4], [0.28, yT + 2.2], [-0.28, yT + 2.2]], n, DARK);
  }
  const SLATE = col('#3c4450');
  for (let j = 0; j < 6; j++) {
    const p0 = (j / 6) * (Math.PI / 2), p1 = ((j + 1) / 6) * (Math.PI / 2);
    cylinder(mt, x, z, Math.cos(p0) * rD, Math.max(0.3, Math.cos(p1) * rD), yU + Math.sin(p0) * rD * 0.9, yU + Math.sin(p1) * rD * 0.9, { seg: 20, color: SLATE });
  }
  const yL = yU + rD * 0.9;
  const ZINC = col('#5a626c');
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
  keepOut.push([x, z, rF + 0.05]);
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
  // 開口の上端: 利用者の写真 212520・NCM_0101 では高さの約 2/3（階の帯にそろえる）
  const Ho = y0 + Math.min(H - 2 * FL, Math.max(12, Math.round((0.65 * H) / FL) * FL));
  const Y = y0 + H;
  const at = (u, v) => [L.cx + e1[0] * u + e2[0] * v, L.cz + e1[1] * u + e2[1] * v];
  const n3 = (v2, s = 1) => [v2[0] * s, 0, v2[1] * s];
  const w = W.main, mt = W.metal;
  // 写真: ルーバーは暗いえんじ色がかった茶（#7a4a40 前後。テクスチャのテラコッタ色に掛ける）、開口の天井と奥は暗い
  const GLASS = col('#8a8480'), SOFFIT = col('#3a3230'), ROOF = col('#9b9a96'), LOUVRE = col('#c49a90'), TOPGLASS = col('#4a5a62');
  // 正面と裏（開口の部分は上の梁だけ）
  for (const sv of [1, -1]) {
    const v = sv * B, n = n3(e2, sv);
    const seg = (u0, u1, ya, yb) => {
      const p = sv > 0 ? [at(u1, v), at(u0, v)] : [at(u0, v), at(u1, v)];
      wall(w, p[0], p[1], ya, yb, n, CELL.louvre, FL, FL, LOUVRE);
    };
    seg(-A, m0, y0, Y);
    seg(m1, A, y0, Y);
    seg(m0, m1, Ho, Y);
  }
  // 両脇
  for (const su of [1, -1]) {
    const u = su * A;
    wall(w, at(u, su > 0 ? -B : B), at(u, su > 0 ? B : -B), y0, Y, n3(e1, su), CELL.louvre, FL, FL, LOUVRE);
  }
  // いちばん上の階は全面ガラス（庇の下の暗い緑がかった灰色の帯。壁の少し外に貼る）
  const g = 0.06;
  for (const [p, q, n] of [[at(-A - g, -B - g), at(A + g, -B - g), n3(e2, -1)], [at(A + g, B + g), at(-A - g, B + g), n3(e2, 1)], [at(A + g, -B - g), at(A + g, B + g), n3(e1, 1)], [at(-A - g, B + g), at(-A - g, -B - g), n3(e1, -1)]]) {
    w.quad([p[0], Y - FL, p[1]], [q[0], Y - FL, q[1]], [q[0], Y - 0.3, q[1]], [p[0], Y - 0.3, p[1]], n, PLAIN_UV, PLAIN_UV, PLAIN_UV, PLAIN_UV, TOPGLASS);
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
function writeCoq(m, W, groundAt, colliders, onRoad, keepOut) {
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
  keepOut.push([m.x, m.z, 1.8]);
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

// ---- ファストフード店（Route de Bayonne のマクドナルド）
// 黄色の M（2 つのアーチ。幅 2w・高さ h、中心 (0, 0) から下へ）の線
function archM(w, h) {
  const arch = (cx) => Array.from({ length: 13 }, (_, i) => {
    const t = i / 12, a = Math.PI * t;
    return [cx - Math.cos(a) * (w / 2), -h + Math.sin(a) ** 0.7 * h * (1 - 0.45 * Math.sin(a) ** 8)];
  });
  return [...arch(-w / 2), ...arch(w / 2).slice(1)];
}
function writeFastfood(m, W, groundAt, colliders) {
  // ユーザーのストリートビュー（22 Rte de Bayonne、2025 年 8 月）: 平屋。床から 3 m は大きなガラスの店先（横・裏は淡い黄土色の壁）、
  // その上に外へ傾いたオレンジ色の縦の羽板の帯（白い店名）、帯の上に濃い緑の寄棟の屋根。道端の看板塔は濃い緑の板に黄色の M、下に赤い板
  const w = W.main, ring = m.outer;
  const [cx, cz] = centroid(ring);
  const y0 = groundAt(cx, cz) - 0.05, G = y0 + 3, F = y0 + 4.4, R = y0 + 5.8;
  const GLASS = col('#2b3439'), FRAME = col('#3a3d3f'), WALL = col('#d8c79e'), SLAT = col('#c8652f'), SLAT_D = col('#93421f');
  const ROOF = col('#3e5a47'), SOFFIT = col('#2f3a33'), RED = col('#bd2a24'), GREEN = col('#2c5a3a'), YELLOW = col('#f7bf1a'), POLE = col('#6b6e72');
  const s = signedArea(ring) > 0 ? 1 : -1;
  const fx = m.front[0] - cx, fz = m.front[1] - cz, fl = Math.hypot(fx, fz) || 1;
  const OUT = 0.55; // 羽板の帯の上の縁の張り出し
  let sign = null;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (L < 0.3) continue;
    // 外向きの法線。壁の面は外から見て反時計回り（a → b を外から見て左から右）
    const nx = ((b[1] - a[1]) / L) * s, nz = (-(b[0] - a[0]) / L) * s;
    const [p, q] = s > 0 ? [b, a] : [a, b];
    const n = [nx, 0, nz];
    const front = (nx * fx + nz * fz) / fl > 0.3 && L > 3;
    if (front) {
      // 店先: 足元の帯と大きなガラス（1.5 m ごとの細い枠）
      wall(w, p, q, y0, y0 + 0.3, n, CELL.plain, 1e9, 1e9, FRAME);
      wall(w, p, q, y0 + 0.3, G, n, CELL.plain, 1e9, 1e9, GLASS);
      const k = Math.max(1, Math.round(L / 1.5));
      for (let j = 0; j <= k; j++) {
        const t = j / k, x = p[0] + (q[0] - p[0]) * t + nx * 0.05, z = p[1] + (q[1] - p[1]) * t + nz * 0.05;
        box(w, [x, (y0 + G) / 2, z], [0.05, 0, 0], [0, (G - y0) / 2, 0], [0, 0, 0.05], FRAME);
      }
      if (!sign || L > sign.L) sign = { p, q, n, L };
    } else wall(w, p, q, y0, G, n, CELL.plain, 1e9, 1e9, WALL);
    // 外へ傾いたオレンジ色の羽板の帯（G → F、上の縁は OUT m 外）と、縦の羽板の影の線（0.4 m ごと）
    const P = (pt, y, o) => [pt[0] + nx * o, y, pt[1] + nz * o];
    const nn = [nx * 0.93, 0.37, nz * 0.93];
    w.quad(P(p, G, 0), P(q, G, 0), P(q, F, OUT), P(p, F, OUT), nn, PLAIN_UV, PLAIN_UV, PLAIN_UV, PLAIN_UV, SLAT);
    const ks = Math.floor(L / 0.4);
    for (let j = 1; j < ks; j++) {
      const t = j / ks, x0 = p[0] + (q[0] - p[0]) * t, z0 = p[1] + (q[1] - p[1]) * t, ux = ((q[0] - p[0]) / L) * 0.05, uz = ((q[1] - p[1]) / L) * 0.05;
      const A = [x0 - ux + nx * 0.02, G, z0 - uz + nz * 0.02], B = [x0 + ux + nx * 0.02, G, z0 + uz + nz * 0.02];
      const C = [x0 + ux + nx * (OUT + 0.02), F, z0 + uz + nz * (OUT + 0.02)], D = [x0 - ux + nx * (OUT + 0.02), F, z0 - uz + nz * (OUT + 0.02)];
      w.quad(A, B, C, D, nn, PLAIN_UV, PLAIN_UV, PLAIN_UV, PLAIN_UV, SLAT_D);
    }
  }
  // 濃い緑の寄棟の屋根: 羽板の帯の上の縁（外へ OUT m）から、外形を中心へ 0.45 倍に縮めた輪（R）まで。上は平ら。帯の上の軒裏
  const out = ring.map(([x, z], i) => {
    const pv = ring[(i - 1 + ring.length) % ring.length], nx2 = ring[(i + 1) % ring.length];
    let ex = 0, ez = 0;
    for (const [a, b] of [[pv, [x, z]], [[x, z], nx2]]) {
      const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
      ex += ((b[1] - a[1]) / L) * s;
      ez += (-(b[0] - a[0]) / L) * s;
    }
    const l = Math.hypot(ex, ez) || 1;
    return [x + (ex / l) * OUT, z + (ez / l) * OUT];
  });
  const inner = ring.map(([x, z]) => [cx + (x - cx) * 0.45, cz + (z - cz) * 0.45]);
  for (let i = 0; i < ring.length; i++) {
    const j = (i + 1) % ring.length;
    const [A, B] = s > 0 ? [out[j], out[i]] : [out[i], out[j]], [C, D] = s > 0 ? [inner[i], inner[j]] : [inner[j], inner[i]];
    w.quad([A[0], F, A[1]], [B[0], F, B[1]], [C[0], R, C[1]], [D[0], R, D[1]], [0, 1, 0], PLAIN_UV, PLAIN_UV, PLAIN_UV, PLAIN_UV, ROOF);
    const [E, H] = s > 0 ? [ring[j], ring[i]] : [ring[i], ring[j]];
    w.quad([B[0], F - 0.02, B[1]], [A[0], F - 0.02, A[1]], [E[0], F - 0.02, E[1]], [H[0], F - 0.02, H[1]], [0, -1, 0], PLAIN_UV, PLAIN_UV, PLAIN_UV, PLAIN_UV, SOFFIT);
  }
  const tri = triangulate(inner);
  for (let i = 0; i < tri.indices.length; i += 3) {
    const P3 = [0, 1, 2].map((k) => tri.points[tri.indices[i + k]]);
    const [A, B, C] = (s > 0 ? [P3[0], P3[2], P3[1]] : P3).map((v) => [v[0], R, v[1]]);
    w.tri(A, B, C, [0, 1, 0], PLAIN_UV, PLAIN_UV, PLAIN_UV, ROOF);
  }
  // 黄色の M（2 つのアーチ）
  const letter = (o, ux, uz, nx, nz, size) => {
    const pts = archM(size / 2, size * 0.85);
    for (const q of strokeQuads(pts, false, 0, size * 0.065)) {
      const V = q.map(([u, v]) => [o[0] + ux * u + nx * 0.02, o[1] + v + size * 0.42, o[2] + uz * u + nz * 0.02]);
      w.quad(V[0], V[1], V[2], V[3], [nx, 0, nz], PLAIN_UV, PLAIN_UV, PLAIN_UV, PLAIN_UV, YELLOW);
    }
  };
  if (sign) {
    // 羽板の帯の端に黄色の M（帯の上に白い店名があるが、文字は描かない）
    const { p, q, n, L } = sign, ux = (q[0] - p[0]) / L, uz = (q[1] - p[1]) / L;
    const o = [p[0] + ux * 1.2 + n[0] * (OUT + 0.15), F - 0.95, p[1] + uz * 1.2 + n[2] * (OUT + 0.15)];
    letter(o, ux, uz, n[0], n[2], 1.1);
  }
  // 道端の看板塔（高さ約 8 m: 灰色の柱の上に濃い緑の板と黄色の M、その下に赤い板）
  {
    const [px, pz] = m.pylon, g = groundAt(px, pz), ux = -fz / fl, uz = fx / fl, ex = fx / fl, ez = fz / fl;
    box(w, [px, g + 2.4, pz], [ux * 0.25, 0, uz * 0.25], [0, 2.4, 0], [ex * 0.25, 0, ez * 0.25], POLE);
    box(w, [px, g + 5.6, pz], [ux * 0.95, 0, uz * 0.95], [0, 0.8, 0], [ex * 0.18, 0, ez * 0.18], RED);
    const top = g + 6.4 + 1.0;
    box(w, [px, top, pz], [ux * 0.95, 0, uz * 0.95], [0, 1.0, 0], [ex * 0.18, 0, ez * 0.18], GREEN);
    letter([px + ex * 0.19, top - 0.85, pz + ez * 0.19], ux, uz, ex, ez, 1.6);
    letter([px - ex * 0.19, top - 0.85, pz - ez * 0.19], -ux, -uz, -ex, -ez, 1.6);
    colliders.push([px, pz, 0.6]);
  }
  // 白い砂利の植え込みと、赤茶の木のチップの島（地面に貼る板）、砂利の上の淡い色の大きな石
  const flat = (poly, lift, color) => {
    const t = triangulate(poly);
    const sg = signedArea(poly) > 0 ? 1 : -1;
    for (let i = 0; i < t.indices.length; i += 3) {
      const P3 = [0, 1, 2].map((k) => t.points[t.indices[i + k]]);
      const [A, B, C] = (sg > 0 ? [P3[0], P3[2], P3[1]] : P3).map((v) => [v[0], groundAt(v[0], v[1]) + lift, v[1]]);
      W.inlay.tri(A, B, C, [0, 1, 0], PLAIN_UV, PLAIN_UV, PLAIN_UV, color);
    }
  };
  flat(m.gravel, 0.03, col('#ecebe6'));
  for (const [x, z, r] of m.mulch) flat(circ(x, z, r, 0, Math.PI * 2, 16).slice(0, -1), 0.045, col('#8a4a36'));
  const rnd = mulberry32(911);
  const gx = m.gravel.map((p) => p[0]), gz = m.gravel.map((p) => p[1]);
  for (let k = 0, placed = 0; k < 80 && placed < 9; k++) {
    const x = Math.min(...gx) + rnd() * (Math.max(...gx) - Math.min(...gx)), z = Math.min(...gz) + rnd() * (Math.max(...gz) - Math.min(...gz));
    if (!pointInRing(x, z, m.gravel) || m.mulch.some(([mx, mz, r]) => Math.hypot(x - mx, z - mz) < r)) continue;
    const a = rnd() * Math.PI, sx = 0.5 + rnd() * 0.4, sz = 0.4 + rnd() * 0.3, sy = 0.3 + rnd() * 0.25;
    box(w, [x, groundAt(x, z) + sy * 0.8, z], [Math.cos(a) * sx, 0, Math.sin(a) * sx], [0, sy, 0], [-Math.sin(a) * sz, 0, Math.cos(a) * sz], col(rnd() < 0.5 ? '#cfc8bc' : '#bdb5a8'));
    placed++;
  }
}

// ---- オテル・デューの中庭
function writeParterre(m, W, groundAt) {
  const w = W.main, HEDGE = col('#3c5a2b'), CLIP = [col('#41602f'), col('#3a5829'), col('#46653a')], TRUNK = col('#5a4a3c');
  const flat = (poly, lift, color) => {
    const t = triangulate(poly);
    for (let i = 0; i < t.indices.length; i += 3) {
      const [A, B, C] = [0, 1, 2].map((k) => t.points[t.indices[i + k]]).map((v) => [v[0], groundAt(v[0], v[1]) + lift, v[1]]);
      W.inlay.tri(A, B, C, [0, 1, 0], PLAIN_UV, PLAIN_UV, PLAIN_UV, color);
    }
  };
  // 砂利の園路の面と芝の区画
  flat(m.outer, 0.03, col('#c9bca4'));
  flat(m.lawn, 0.05, col('#5f803a'));
  // 低いツゲ（高さ 0.5 m、幅 0.4 m）: 芝の区画の縁と、対角線、内側の菱形
  const hedge = (a, b, h = 0.5, wd = 0.4, color = HEDGE) => {
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (L < 0.2) return;
    const ux = (b[0] - a[0]) / L, uz = (b[1] - a[1]) / L, g = Math.min(groundAt(...a), groundAt(...b));
    box(w, [(a[0] + b[0]) / 2, g + h / 2, (a[1] + b[1]) / 2], [ux * L / 2, 0, uz * L / 2], [0, h / 2, 0], [-uz * wd / 2, 0, ux * wd / 2], color);
  };
  const lw = m.lawn, n = lw.length;
  for (let i = 0; i < n; i++) hedge(lw[i], lw[(i + 1) % n]);
  const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const ms = lw.map((a, i) => mid(a, lw[(i + 1) % n]));
  for (let i = 0; i < n; i++) hedge(ms[i], ms[(i + 1) % n]);
  hedge(lw[0], lw[2]);
  hedge(lw[1], lw[3]);
  // 外周の北の丸い所の低い生け垣（高さ 1 m）
  for (let i = 0; i < 4; i++) hedge(m.outer[i], m.outer[i + 1], 1.0, 0.8);
  // 左右の刈り込んだ四角い木の列（幹 2 m、四角い樹冠 3 × 3 × 3 m、3.6 m おき）
  for (const [a, b] of m.rows) {
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]), ux = (b[0] - a[0]) / L, uz = (b[1] - a[1]) / L, k = Math.floor(L / 3.6);
    for (let j = 0; j <= k; j++) {
      const x = a[0] + ux * (L * j) / k, z = a[1] + uz * (L * j) / k, g = groundAt(x, z);
      box(w, [x, g + 1.1, z], [0.12, 0, 0], [0, 1.1, 0], [0, 0, 0.12], TRUNK);
      box(w, [x, g + 3.6, z], [ux * 1.55, 0, uz * 1.55], [0, 1.5, 0], [-uz * 1.5, 0, ux * 1.5], CLIP[j % CLIP.length]);
    }
  }
  // 北の端の丸い池（石の縁、水面、真ん中の小さな噴水の台）
  const [bx, bz] = m.basin, g = groundAt(bx, bz);
  const rim = circ(bx, bz, 3.6, 0, Math.PI * 2, 24).slice(0, -1);
  for (const q of strokeQuads(rim, true, 0, 0.45)) w.quad(...q.map(([x, z]) => [x, g + 0.45, z]), [0, 1, 0], PLAIN_UV, PLAIN_UV, PLAIN_UV, PLAIN_UV, col('#cfc6b6'));
  for (let i = 0; i < rim.length; i++) {
    const p = rim[i], q = rim[(i + 1) % rim.length], nx = (p[0] + q[0]) / 2 - bx, nz = (p[1] + q[1]) / 2 - bz;
    const o = (pt) => [bx + (pt[0] - bx) * 1.06, bz + (pt[1] - bz) * 1.06];
    wall(w, o(q), o(p), g, g + 0.45, [nx, 0, nz], CELL.plain, 1e9, 1e9, col('#c4bba9'));
  }
  flat(circ(bx, bz, 3.4, 0, Math.PI * 2, 24).slice(0, -1), 0.35, col('#5b6d6a'));
  box(w, [bx, g + 0.6, bz], [0.35, 0, 0], [0, 0.6, 0], [0, 0, 0.35], col('#c4bba9'));
}

// ---- 日本庭園（Jardin japonais Pierre-Baudis）
// 楕円体（x, z 方向の半径 rx, rz、高さの半径 ry）。石・刈り込みの植木に使う
function ellipsoid(w, c, rx, ry, rz, color, seg = 8) {
  const P = (i, j) => {
    const th = (i / seg) * Math.PI * 2, ph = (j / (seg / 2)) * Math.PI - Math.PI / 2;
    return [Math.cos(ph) * Math.cos(th), Math.sin(ph), Math.cos(ph) * Math.sin(th)];
  };
  for (let i = 0; i < seg; i++) {
    for (let j = 0; j < seg / 2; j++) {
      const q = [P(i, j), P(i + 1, j), P(i + 1, j + 1), P(i, j + 1)];
      const V = q.map(([x, y, z]) => [c[0] + x * rx, c[1] + y * ry, c[2] + z * rz]);
      const n = q.reduce((a, v) => [a[0] + v[0], a[1] + v[1], a[2] + v[2]], [0, 0, 0]);
      w.quad(V[0], V[1], V[2], V[3], n, PLAIN_UV, PLAIN_UV, PLAIN_UV, PLAIN_UV, color);
    }
  }
}
function writeJgarden(m, W, groundAt, colliders, onRoad, keepOut) {
  const w = W.main, rnd = mulberry32(1983);
  const GRAVEL = col('#b5b4b0'), RAKE = col('#8f8e8a'), WALL = col('#ebe4d3'), TILE = col('#55574f'), ROCK = [col('#8f8d88'), col('#a19e97'), col('#7f7d78')];
  const PINE = [col('#2e4a2a'), col('#35532f'), col('#2a4426')], TRUNK = col('#5a4636'), WOOD = col('#8d7f72'), RED = col('#d9432a'), STONE = col('#9a978f');
  const flat = (poly, lift, color) => {
    const t = triangulate(poly);
    for (let i = 0; i < t.indices.length; i += 3) {
      const [A, B, C] = [0, 1, 2].map((k) => t.points[t.indices[i + k]]).map((v) => [v[0], groundAt(v[0], v[1]) + lift, v[1]]);
      W.inlay.tri(A, B, C, [0, 1, 0], PLAIN_UV, PLAIN_UV, PLAIN_UV, color);
    }
  };
  // 枯山水: 灰白色の砂利の面に、塀と平行に 0.5 m おきの波の砂紋（面の中だけ）と、石組みのまわりの同心円
  flat(m.gravel, 0.04, GRAVEL);
  const [w0, w1] = [m.wall[m.wall.length - 2], m.wall[m.wall.length - 1]];
  const L0 = Math.hypot(w1[0] - w0[0], w1[1] - w0[1]), ux = (w1[0] - w0[0]) / L0, uz = (w1[1] - w0[1]) / L0;
  const inG = (x, z) => pointInRing(x, z, m.gravel);
  const inRock = (x, z) => m.rocks.some(([rx, rz]) => Math.hypot(x - rx, z - rz) < 2.2);
  const [gx, gz] = centroid(m.gravel);
  for (let off = -30; off <= 30; off += 0.5) {
    let run = [];
    const flush = () => {
      if (run.length > 1) for (const q of strokeQuads(run, false, 0, 0.035)) W.inlay.quad(...q.map(([x, z]) => [x, groundAt(x, z) + 0.05, z]), [0, 1, 0], PLAIN_UV, PLAIN_UV, PLAIN_UV, PLAIN_UV, RAKE);
      run = [];
    };
    for (let t = -30; t <= 30; t += 0.6) {
      const wv = Math.sin(t * 0.9 + off) * 0.12, x = gx + ux * t - uz * (off + wv), z = gz + uz * t + ux * (off + wv);
      if (inG(x, z) && !inRock(x, z)) run.push([x, z]);
      else flush();
    }
    flush();
  }
  for (const [rx, rz] of m.rocks) {
    if (!inG(rx, rz)) continue;
    for (const r of [1.5, 2.0]) for (const q of strokeQuads(circ(rx, rz, r, 0, Math.PI * 2, 20).slice(0, -1), true, 0, 0.035)) W.inlay.quad(...q.map(([x, z]) => [x, groundAt(x, z) + 0.05, z]), [0, 1, 0], PLAIN_UV, PLAIN_UV, PLAIN_UV, PLAIN_UV, RAKE);
  }
  // 白い塀（高さ 2 m、厚さ 0.35 m）と、少し張り出した暗い瓦の笠
  for (let i = 0; i + 1 < m.wall.length; i++) {
    const a = m.wall[i], b = m.wall[i + 1], L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const nx = -(b[1] - a[1]) / L, nz = (b[0] - a[0]) / L, y0 = Math.min(groundAt(...a), groundAt(...b)) - 0.1, y1 = y0 + 2.1;
    const o = 0.175;
    for (const sd of [1, -1]) wall(w, [a[0] + nx * o * sd, a[1] + nz * o * sd], [b[0] + nx * o * sd, b[1] + nz * o * sd], y0, y1, [nx * sd, 0, nz * sd], CELL.plain, 1e9, 1e9, WALL);
    const mid = [(a[0] + b[0]) / 2, y1 + 0.12, (a[1] + b[1]) / 2], e = [((b[0] - a[0]) / 2) * 1.01, 0, ((b[1] - a[1]) / 2) * 1.01];
    box(w, mid, e, [0, 0.12, 0], [nx * 0.42, 0, nz * 0.42], TILE);
    colliders.push([a[0], a[1], b[0], b[1]]);
  }
  // 石組み: 丸い灰色の石（0.5〜1.4 m）を 2〜4 個ずつ
  for (const [rx, rz] of m.rocks) {
    const n = 2 + Math.floor(rnd() * 3);
    for (let k = 0; k < n; k++) {
      const x = rx + (rnd() - 0.5) * 2, z = rz + (rnd() - 0.5) * 2, r = 0.35 + rnd() * 0.45;
      ellipsoid(w, [x, groundAt(x, z) + r * 0.35, z], r * (1 + rnd() * 0.5), r * 0.7, r, ROCK[k % ROCK.length], 8);
    }
  }
  // 玉作りの松: 細い幹に平たい葉の玉を 3〜4 段
  for (const [px, pz] of m.pines) {
    const g = groundAt(px, pz), h = 2.2 + rnd() * 1.6;
    box(w, [px, g + h / 2, pz], [0.09, 0, 0], [0, h / 2, 0], [0, 0, 0.09], TRUNK);
    const n = 3 + Math.floor(rnd() * 2);
    for (let k = 0; k < n; k++) {
      const t = (k + 1) / n, a = rnd() * Math.PI * 2, d = (1 - t) * 0.8, r = 0.9 - t * 0.35 + rnd() * 0.3;
      ellipsoid(w, [px + Math.cos(a) * d, g + h * t + 0.1, pz + Math.sin(a) * d], r * 1.2, r * 0.45, r, PINE[k % PINE.length], 8);
    }
  }
  // 州浜（白い玉石）と石灯籠
  flat(m.spit, 0.05, col('#e8e6df'));
  {
    const [lx, lz] = m.lantern, g = groundAt(lx, lz);
    box(w, [lx, g + 0.15, lz], [0.4, 0, 0], [0, 0.15, 0], [0, 0, 0.4], STONE);
    box(w, [lx, g + 0.75, lz], [0.12, 0, 0], [0, 0.45, 0], [0, 0, 0.12], STONE);
    box(w, [lx, g + 1.35, lz], [0.3, 0, 0], [0, 0.18, 0], [0, 0, 0.3], col('#b2aea5'));
    box(w, [lx, g + 1.6, lz], [0.45, 0, 0], [0, 0.07, 0], [0, 0, 0.45], STONE);
    ellipsoid(w, [lx, g + 1.7, lz], 0.18, 0.15, 0.18, STONE, 6);
  }
  // 茶屋へ渡る木の縁台（0.4 m の高さ、手すり）
  {
    const t = triangulate(m.deck);
    for (let i = 0; i < t.indices.length; i += 3) {
      const [A, B, C] = [0, 1, 2].map((k) => t.points[t.indices[i + k]]).map((v) => [v[0], groundAt(v[0], v[1]) + 0.4, v[1]]);
      w.tri(A, B, C, [0, 1, 0], PLAIN_UV, PLAIN_UV, PLAIN_UV, WOOD);
    }
    for (const [x, z] of m.deck) box(w, [x, groundAt(x, z) + 0.6, z], [0.06, 0, 0], [0, 0.6, 0], [0, 0, 0.06], col('#7a6a58'));
  }
  // 朱色の太鼓橋（長さ L、幅 1.8 m、中ほどの高さ 1.5 m）: 反った床と、低い欄干（柱と 2 本の横木）
  {
    const [A, B] = m.bridge, L = Math.hypot(B[0] - A[0], B[1] - A[1]), bx = (B[0] - A[0]) / L, bz = (B[1] - A[1]) / L, nx = -bz, nz = bx;
    const ga = groundAt(...A), gb = groundAt(...B), n = 14;
    const at = (t) => [A[0] + bx * L * t, ga + (gb - ga) * t + 1.5 * Math.sin(Math.PI * t), A[1] + bz * L * t];
    for (let k = 0; k < n; k++) {
      const p = at(k / n), q = at((k + 1) / n), c = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2, (p[2] + q[2]) / 2];
      const e = [(q[0] - p[0]) / 2 * 1.05, (q[1] - p[1]) / 2, (q[2] - p[2]) / 2 * 1.05];
      box(w, c, e, [0, 0.08, 0], [nx * 0.9, 0, nz * 0.9], RED, { top: col('#a86a4a') });
      for (const sd of [1, -1]) {
        for (const hh of [0.5, 0.9]) box(w, [c[0] + nx * 0.85 * sd, c[1] + hh, c[2] + nz * 0.85 * sd], e, [0, 0.04, 0], [nx * 0.05, 0, nz * 0.05], RED);
      }
    }
    for (let k = 0; k <= n; k += 2) {
      const p = at(k / n);
      for (const sd of [1, -1]) box(w, [p[0] + nx * 0.85 * sd, p[1] + 0.47, p[2] + nz * 0.85 * sd], [0.06, 0, 0], [0, 0.5, 0], [0, 0, 0.06], RED);
    }
    // 橋の下の支え（両端と中の 2 本の柱）
    for (const t of [0.3, 0.7]) {
      const p = at(t);
      for (const sd of [1, -1]) box(w, [p[0] + nx * 0.7 * sd, (p[1] + Math.min(ga, gb) - 1) / 2, p[2] + nz * 0.7 * sd], [0.08, 0, 0], [0, (p[1] - Math.min(ga, gb) + 1) / 2, 0], [0, 0, 0.08], RED);
    }
  }
  // 茶屋: 0.5 m の木の床、細い柱、腰の低い板壁と障子の帯、深い軒（0.9 m）の苔むした寄棟の屋根
  if (m.tea) {
    const ring = m.tea, [cx, cz] = centroid(ring), g = Math.min(...ring.map(([x, z]) => groundAt(x, z)));
    const y0 = g + 0.5, y1 = y0 + 2.5, ROOF = col('#4b5544'), POST = col('#4a3a2c'), SHOJI = col('#e9e2cf');
    const sgn = signedArea(ring) > 0 ? 1 : -1;
    const flr = triangulate(ring);
    for (let i = 0; i < flr.indices.length; i += 3) {
      const [A, B, C] = [0, 1, 2].map((k) => flr.points[flr.indices[i + k]]).map((v) => [v[0], y0, v[1]]);
      w.tri(A, B, C, [0, 1, 0], PLAIN_UV, PLAIN_UV, PLAIN_UV, col('#7a6450'));
    }
    const ext = ring.map(([x, z]) => {
      const dx = x - cx, dz = z - cz, l = Math.hypot(dx, dz) || 1;
      return [x + (dx / l) * 1.2, z + (dz / l) * 1.2];
    });
    const ridge = ring.map(([x, z]) => [cx + (x - cx) * 0.25, cz + (z - cz) * 0.25]);
    for (let i = 0; i < ring.length; i++) {
      const j = (i + 1) % ring.length, a = ring[i], b = ring[j], L = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (L < 0.5) continue;
      const nx = ((b[1] - a[1]) / L) * sgn, nz = (-(b[0] - a[0]) / L) * sgn;
      wall(w, a, b, g - 0.2, y0, [nx, 0, nz], CELL.plain, 1e9, 1e9, col('#6e5a48'));
      wall(w, a, b, y0, y0 + 0.8, [nx, 0, nz], CELL.plain, 1e9, 1e9, col('#8a7058'));
      if (i % 2 === 0) wall(w, [a[0] - nx * 0.4, a[1] - nz * 0.4], [b[0] - nx * 0.4, b[1] - nz * 0.4], y0 + 0.8, y1 - 0.3, [nx, 0, nz], CELL.plain, 1e9, 1e9, SHOJI);
      const k = Math.max(1, Math.round(L / 2));
      for (let s2 = 0; s2 <= k; s2++) {
        const x = a[0] + (b[0] - a[0]) * (s2 / k), z = a[1] + (b[1] - a[1]) * (s2 / k);
        box(w, [x, (y0 + y1) / 2, z], [0.09, 0, 0], [0, (y1 - y0) / 2, 0], [0, 0, 0.09], POST);
      }
      const E1 = ext[i], E2 = ext[j], R1 = ridge[i], R2 = ridge[j];
      w.quad([E1[0], y1 - 0.25, E1[1]], [E2[0], y1 - 0.25, E2[1]], [R2[0], y1 + 1.9, R2[1]], [R1[0], y1 + 1.9, R1[1]], [nx, 1.4, nz], PLAIN_UV, PLAIN_UV, PLAIN_UV, PLAIN_UV, ROOF);
      w.quad([E1[0], y1 - 0.27, E1[1]], [E2[0], y1 - 0.27, E2[1]], [b[0], y1, b[1]], [a[0], y1, a[1]], [0, -1, 0], PLAIN_UV, PLAIN_UV, PLAIN_UV, PLAIN_UV, col('#5b4a3a'));
    }
    const top = triangulate(ridge);
    for (let i = 0; i < top.indices.length; i += 3) {
      const [A, B, C] = [0, 1, 2].map((k) => top.points[top.indices[i + k]]).map((v) => [v[0], y1 + 1.9, v[1]]);
      w.tri(A, B, C, [0, 1, 0], PLAIN_UV, PLAIN_UV, PLAIN_UV, ROOF);
    }
  }
  // 見る人の側の砂利の縁（塀のない辺）: 低い木の杭（0.6 m、2.5 m おき）にたるんだ麻の縄、外に灰色の飛び石。
  // 塀の外（裏）に竹の茂み 2 つ、州浜のそばに白い石（利用者の写真 NCM_0117・0121・0122）
  const POST = col('#706964'), ROPE = col('#808288'), SLAB = col('#bababe'), BAMBOO = col('#6a7d3a'), BLEAF = col('#5d7a32'), WHITE = col('#d9d6cf');
  const g = m.gravel, wallSet = new Set(m.wall.map(([x, z]) => `${x.toFixed(2)},${z.toFixed(2)}`));
  const isWall = (p, q) => wallSet.has(`${p[0].toFixed(2)},${p[1].toFixed(2)}`) && wallSet.has(`${q[0].toFixed(2)},${q[1].toFixed(2)}`);
  for (let i = 0; i < g.length; i++) {
    const p = g[i], q = g[(i + 1) % g.length];
    if (isWall(p, q)) continue;
    const L = Math.hypot(q[0] - p[0], q[1] - p[1]);
    if (L < 1) continue;
    const ux = (q[0] - p[0]) / L, uz = (q[1] - p[1]) / L;
    // 外向き（砂利の中心から離れる向き）
    let nx = -uz, nz = ux;
    if ((p[0] + ux * L / 2 - gx) * nx + (p[1] + uz * L / 2 - gz) * nz < 0) [nx, nz] = [-nx, -nz];
    const n = Math.max(1, Math.round(L / 2.5));
    let prev = null;
    for (let k = 0; k <= n; k++) {
      const x = p[0] + ux * (L * k) / n + nx * 0.3, z = p[1] + uz * (L * k) / n + nz * 0.3, y = groundAt(x, z);
      box(w, [x, y + 0.3, z], [0.06, 0, 0], [0, 0.3, 0], [0, 0, 0.06], POST);
      if (prev) {
        // 縄: 2 つの区間でたるませる
        const mx = (prev[0] + x) / 2, mz = (prev[1] + z) / 2, my = (prev[2] + y) / 2 + 0.42;
        for (const [a, b] of [[[prev[0], prev[2] + 0.55, prev[1]], [mx, my, mz]], [[mx, my, mz], [x, y + 0.55, z]]]) {
          w.quad([a[0], a[1], a[2]], [b[0], b[1], b[2]], [b[0], b[1] + 0.03, b[2]], [a[0], a[1] + 0.03, a[2]], [nx, 0, nz], PLAIN_UV, PLAIN_UV, PLAIN_UV, PLAIN_UV, ROPE);
        }
      }
      prev = [x, z, y];
    }
    for (let t = 0.8; t < L - 0.6; t += 1.7) {
      const x = p[0] + ux * t + nx * 1.4, z = p[1] + uz * t + nz * 1.4;
      box(W.inlay, [x, groundAt(x, z) + 0.05, z], [ux * 0.6, 0, uz * 0.6], [0, 0.04, 0], [nx * 0.3, 0, nz * 0.3], SLAB);
    }
  }
  for (const end of [m.wall[0], m.wall[m.wall.length - 1]]) {
    let ox = end[0] - gx, oz = end[1] - gz;
    const ol = Math.hypot(ox, oz) || 1;
    ox /= ol;
    oz /= ol;
    const bx = end[0] + ox * 2.2, bz = end[1] + oz * 2.2, y = groundAt(bx, bz);
    for (let k = 0; k < 14; k++) {
      const a = rnd() * Math.PI * 2, r = rnd() * 1.1, h = 3.8 + rnd() * 1.6;
      const sx = bx + Math.cos(a) * r, sz = bz + Math.sin(a) * r;
      cylinder(w, sx, sz, 0.035, 0.025, y, y + h, { seg: 4, color: BAMBOO });
      blob(w, [sx, y + h - 0.6, sz], [0.6, 0.9, 0.6], rnd() * 6, 6, 4, () => BLEAF);
    }
  }
  for (const [rx, rz] of m.spit.slice(0, 3)) blob(w, [rx, groundAt(rx, rz) + 0.25, rz], [0.55, 0.35, 0.45], rnd() * 6, 7, 4, () => WHITE);
  keepOut.push([m.x, m.z, 14]);
}

// ---- ラ・グラーヴの円屋根: 半円アーチの窓と付け柱のあるレンガのドラム、石の軒、鉛色のドーム（リブ付き）、頂塔
function writeDome(m, W, groundAt) {
  const { x, z } = m;
  const y0 = groundAt(x, z) + m.base - 0.6;
  // 鼓胴は地面から 28 m 以上まで（利用者の写真 NCM_0102・0106・211211: ドームは病院の屋根の上に高い鼓胴ごと突き出し、
  // ポン・ヌフからもオテル・デューの屋根の上に大きく見える）
  const rDr = 9.4, yDr = Math.max(y0 + 11.5, groundAt(x, z) + 28), rDo = 9.7, hDo = 12.5;
  const w = W.main, mt = W.metal;
  const STONE = col('#d9cfbf'), DARK = col('#2b2523'), LEAD = col('#8c9a92'), BRICK = col('#d6aa94'); // 鉛の屋根は灰緑
  cylinder(w, x, z, rDr, rDr, y0, yDr, { seg: 32, cell: CELL.brick, cw: BRICK_CW, ch: BRICK_CW, color: BRICK });
  for (let k = 0; k < 16; k++) {
    const a = (k / 16) * Math.PI * 2;
    const n = [Math.cos(a), 0, Math.sin(a)], s = [-Math.sin(a), Math.cos(a)];
    if (k % 2) {
      // 付け柱
      vpoly(w, [x + n[0] * (rDr + 0.12), z + n[2] * (rDr + 0.12)], s, [[-0.45, y0 + 0.6], [0.45, y0 + 0.6], [0.45, yDr - 0.8], [-0.45, yDr - 0.8]], n, STONE);
    } else {
      // 鼓胴の上のほうの窓（高い鼓胴では窓の段を上に置き、下は低いアーチの窓）
      const yw = yDr - y0 > 16 ? yDr - 7.4 : y0 + 3.2;
      vpoly(w, [x + n[0] * (rDr + 0.06), z + n[2] * (rDr + 0.06)], s, archShape(2.4, 5.4, yw, 8), n, STONE);
      vpoly(w, [x + n[0] * (rDr + 0.12), z + n[2] * (rDr + 0.12)], s, archShape(1.8, 5.0, yw + 0.2, 8), n, DARK);
      if (yw > y0 + 6) vpoly(w, [x + n[0] * (rDr + 0.12), z + n[2] * (rDr + 0.12)], s, archShape(1.4, 2.6, y0 + 2.4, 6), n, DARK);
    }
  }
  cylinder(w, x, z, rDr + 0.5, rDr + 0.5, yDr - 0.8, yDr, { seg: 32, color: STONE });
  annulus(w, x, z, rDr, rDr + 0.5, yDr - 0.8, 32, STONE, false);
  annulus(w, x, z, rDo, rDr + 0.5, yDr, 32, STONE);
  // ドーム（だ円の断面）と 16 本のリブ
  const N = 10;
  for (let j = 0; j < N; j++) {
    const p0 = (j / N) * (Math.PI / 2), p1 = ((j + 1) / N) * (Math.PI / 2);
    cylinder(mt, x, z, Math.cos(p0) * rDo, Math.max(1.4, Math.cos(p1) * rDo), yDr + Math.sin(p0) * hDo, yDr + Math.sin(p1) * hDo, { seg: 32, color: LEAD });
  }
  const yTop = yDr + hDo;
  for (let k = 0; k < 16; k++) {
    const a = (k / 16) * Math.PI * 2 + Math.PI / 16;
    for (let j = 0; j < N; j++) {
      const p0 = (j / N) * (Math.PI / 2), p1 = ((j + 1) / N) * (Math.PI / 2);
      const r0 = Math.cos(p0) * rDo + 0.08, r1 = Math.max(1.4, Math.cos(p1) * rDo) + 0.08;
      const y0r = yDr + Math.sin(p0) * hDo, y1r = yDr + Math.sin(p1) * hDo;
      const s = [-Math.sin(a), Math.cos(a)], c = [Math.cos(a), Math.sin(a)];
      const P = (r, y, o) => [x + c[0] * r + s[0] * o, y, z + c[1] * r + s[1] * o];
      const nn = [c[0] * (y1r - y0r), r0 - r1, c[1] * (y1r - y0r)];
      const l = Math.hypot(...nn) || 1;
      mt.quad(P(r0, y0r, -0.18), P(r0, y0r, 0.18), P(r1, y1r, 0.18), P(r1, y1r, -0.18), [nn[0] / l, nn[1] / l, nn[2] / l], PLAIN_UV, PLAIN_UV, PLAIN_UV, PLAIN_UV, col('#949ca3'));
    }
  }
  // 頂塔（窓のある円筒と小さな円屋根）と十字架
  cylinder(w, x, z, 1.5, 1.5, yTop - 0.3, yTop + 3.0, { seg: 12, color: STONE });
  for (let k = 0; k < 6; k++) {
    const a = (k / 6) * Math.PI * 2;
    const n = [Math.cos(a), 0, Math.sin(a)], s = [-Math.sin(a), Math.cos(a)];
    vpoly(w, [x + n[0] * 1.52, z + n[2] * 1.52], s, archShape(0.55, 1.8, yTop + 0.6, 6), n, DARK);
  }
  annulus(w, x, z, 0, 1.75, yTop + 3.0, 12, STONE, false);
  for (let j = 0; j < 4; j++) {
    const p0 = (j / 4) * (Math.PI / 2), p1 = ((j + 1) / 4) * (Math.PI / 2);
    cylinder(mt, x, z, Math.cos(p0) * 1.75, Math.max(0.15, Math.cos(p1) * 1.75), yTop + 3.0 + Math.sin(p0) * 1.6, yTop + 3.0 + Math.sin(p1) * 1.6, { seg: 12, color: LEAD });
  }
  const yc = yTop + 4.6;
  box(mt, [x, yc + 1.0, z], [0.07, 0, 0], [0, 1.0, 0], [0, 0, 0.07], col('#3a3a38'));
  box(mt, [x, yc + 1.4, z], [0.45, 0, 0], [0, 0.07, 0], [0, 0, 0.07], col('#3a3a38'));
}

// ---- 円柱と破風の柱廊（壁 mid の前、外向き n、壁に沿った t、幅 width）
function writePortico(m, W, groundAt, colliders) {
  const { mid, t, n, width } = m;
  const w = W.main;
  const STONE = col('#cbc6bd'), SHADE = col('#b5b0a6'), DARK = col('#4a4744');
  const y0 = groundAt(mid[0] + n[0] * 1.5, mid[1] + n[1] * 1.5);
  const D = 2.6, hw = width / 2, yC = y0 + 1.0, yE = yC + 11.5, yP = yE + 1.6, rise = Math.min(4.6, hw * 0.38);
  const at = (u, v) => [mid[0] + t[0] * u + n[0] * v, mid[1] + t[1] * u + n[1] * v];
  const T = (h) => [t[0] * h, 0, t[1] * h], N = (h) => [n[0] * h, 0, n[1] * h], Y = (h) => [0, h, 0];
  // 段（基壇）と、柱の後ろの暗い壁（柱廊の奥）
  const c0 = at(0, D / 2);
  box(w, [c0[0], y0 + 0.5, c0[1]], T(hw + 0.4), Y(0.6), N(D / 2 + 0.2), SHADE);
  const back = at(0, 0.08);
  vpoly(w, back, t, [[-hw, yC], [hw, yC], [hw, yE], [-hw, yE]], [n[0], 0, n[1]], DARK);
  // 6 本の円柱（礎盤・柱身・柱頭）
  for (let k = 0; k < 6; k++) {
    const u = -hw + 1.0 + ((2 * hw - 2.0) * k) / 5, [px, pz] = at(u, D - 0.8);
    box(w, [px, yC + 0.25, pz], T(0.75), Y(0.25), N(0.75), STONE);
    cylinder(w, px, pz, 0.62, 0.55, yC + 0.5, yE - 0.7, { seg: 14, color: STONE });
    box(w, [px, yE - 0.35, pz], T(0.75), Y(0.35), N(0.75), STONE);
    colliders.push([px, pz, 0.7]);
  }
  // 梁（エンタブラチュア）と三角の破風（前面・屋根の斜面・下面）
  const ce = at(0, D / 2);
  box(w, [ce[0], (yE + yP) / 2, ce[1]], T(hw + 0.3), Y((yP - yE) / 2), N(D / 2 + 0.3), STONE);
  const fr = at(0, D + 0.3), bk = at(0, -0.2);
  const tri = [[-hw - 0.3, yP], [hw + 0.3, yP], [0, yP + rise]];
  vpoly(w, fr, t, tri, [n[0], 0, n[1]], STONE);
  vpoly(w, at(0, D + 0.35), t, [[-hw + 1.2, yP + 0.5], [hw - 1.2, yP + 0.5], [0, yP + rise - 0.6]], [n[0], 0, n[1]], SHADE);
  for (const sgn of [-1, 1]) {
    const e = [fr[0] + t[0] * sgn * (hw + 0.3), fr[1] + t[1] * sgn * (hw + 0.3)], e2 = [bk[0] + t[0] * sgn * (hw + 0.3), bk[1] + t[1] * sgn * (hw + 0.3)];
    const nn = [t[0] * sgn * rise, hw + 0.3, t[1] * sgn * rise], l = Math.hypot(...nn);
    w.quad([e[0], yP, e[1]], [e2[0], yP, e2[1]], [bk[0], yP + rise, bk[1]], [fr[0], yP + rise, fr[1]], [nn[0] / l, nn[1] / l, nn[2] / l], PLAIN_UV, PLAIN_UV, PLAIN_UV, PLAIN_UV, col('#8a8580'));
  }
}

// ---- キャピトルの主塔
function writeDonjon(m, W, groundAt, colliders) {
  const { cx, cz, e1, e2, a, b } = m;
  const y0 = groundAt(cx, cz) - 0.3, H = 18, yM = y0 + H, yP = yM + 1.4;
  const w = W.main, mt = W.metal;
  const STONE = col('#e8dfd0'), SHADE = col('#cfc5b4'), DARK = col('#2c2826'), SLATE = col('#64666a'), WHITE_C = col('#f4f1ea');
  const P = (u, v, y) => [cx + e1[0] * u + e2[0] * v, y, cz + e1[1] * u + e2[1] * v];
  const E1 = (h) => [e1[0] * h, 0, e1[1] * h], E2 = (h) => [e2[0] * h, 0, e2[1] * h], EY = (h) => [0, h, 0];
  // 塔の体と、少し張り出した出し狭間の帯、狭間のある胸壁
  box(w, [cx, (y0 + yM) / 2, cz], E1(a), EY((yM - y0) / 2), E2(b), STONE);
  box(w, [cx, yM + 0.7, cz], E1(a + 0.4), EY(0.7), E2(b + 0.4), SHADE);
  // 四つの面: 外向きの法線 n・面に沿った向き t・面の半分の幅 hw・中心からの距離 d
  const sides = [[e1, e2, b, a], [[-e1[0], -e1[1]], e2, b, a], [e2, e1, a, b], [[-e2[0], -e2[1]], e1, a, b]];
  for (const [n, t, hw, d] of sides) {
    const N = [n[0], 0, n[1]];
    // 出し狭間の持ち送りのあいだの暗いすき間
    for (let o = -hw - 0.2; o <= hw + 0.2; o += 0.9) {
      vpoly(w, [cx + n[0] * (d + 0.41) + t[0] * o, cz + n[1] * (d + 0.41) + t[1] * o], t, [[-0.25, yM], [0.25, yM], [0.25, yM + 0.5], [-0.25, yM + 0.5]], N, DARK);
    }
    // 胸壁の凸部
    for (let o = -hw; o <= hw + 0.01; o += 1.6) {
      const q = [cx + n[0] * (d + 0.25) + t[0] * o, cz + n[1] * (d + 0.25) + t[1] * o];
      box(w, [q[0], yP + 0.5, q[1]], [t[0] * 0.4, 0, t[1] * 0.4], EY(0.5), [n[0] * 0.15, 0, n[1] * 0.15], STONE);
    }
    // 小さな窓（2 つずつ、4 段）
    for (const yw of [y0 + 4.5, y0 + 8.5, y0 + 12.5, y0 + 15.5]) {
      for (const o of [-hw * 0.45, hw * 0.45]) {
        for (const dx of [-0.45, 0.45]) {
          vpoly(w, [cx + n[0] * (d + 0.05) + t[0] * (o + dx), cz + n[1] * (d + 0.05) + t[1] * (o + dx)], t, [[-0.3, yw], [0.3, yw], [0.3, yw + 1.3], [-0.3, yw + 1.3]], N, DARK);
        }
      }
    }
  }
  // 急なスレートの寄棟屋根（棟は長い辺の向き）
  const A = a - 0.15, B = b - 0.15, yR = yP + B * 1.45, ra = Math.max(0.5, A - B);
  const face = (pts, n) => {
    for (let i = 1; i + 1 < pts.length; i++) mt.tri(pts[0], pts[i], pts[i + 1], n, PLAIN_UV, PLAIN_UV, PLAIN_UV, SLATE);
  };
  const nrm = (p, q, r) => {
    const u = [q[0] - p[0], q[1] - p[1], q[2] - p[2]], v = [r[0] - p[0], r[1] - p[1], r[2] - p[2]];
    const c = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const l = Math.hypot(...c) || 1;
    return c[1] < 0 ? [-c[0] / l, -c[1] / l, -c[2] / l] : [c[0] / l, c[1] / l, c[2] / l];
  };
  const c00 = P(-A, -B, yP), c10 = P(A, -B, yP), c11 = P(A, B, yP), c01 = P(-A, B, yP), r0 = P(-ra, 0, yR), r1 = P(ra, 0, yR);
  for (const f of [[c00, c10, r1, r0], [c11, c01, r0, r1], [c10, c11, r1], [c01, c00, r0]]) face(f, nrm(f[0], f[1], f[2]));
  // 時計の屋根窓（正面の側の屋根の真ん中）
  const fs = sides.reduce((best, sd) => (sd[0][0] * m.front[0] + sd[0][1] * m.front[1] > best[0][0] * m.front[0] + best[0][1] * m.front[1] ? sd : best));
  {
    const [n, t, , d] = fs;
    const N = [n[0], 0, n[1]];
    const q = [cx + n[0] * (d - 0.6), cz + n[1] * (d - 0.6)];
    box(w, [q[0], yP + 1.3, q[1]], [t[0] * 1.3, 0, t[1] * 1.3], EY(1.3), [n[0] * 0.6, 0, n[1] * 0.6], STONE);
    vpoly(mt, [q[0] + n[0] * 0.61, q[1] + n[1] * 0.61], t, [[-1.45, yP + 2.6], [1.45, yP + 2.6], [0, yP + 4.0]], N, SLATE);
    for (let k = 0; k < 16; k++) {
      const a0 = (k / 16) * Math.PI * 2, a1 = ((k + 1) / 16) * Math.PI * 2;
      vpoly(w, [q[0] + n[0] * 0.62, q[1] + n[1] * 0.62], t, [[0, yP + 1.35], [Math.cos(a0) * 0.85, yP + 1.35 + Math.sin(a0) * 0.85], [Math.cos(a1) * 0.85, yP + 1.35 + Math.sin(a1) * 0.85]], N, k % 4 === 0 ? DARK : WHITE_C);
    }
  }
  // 正面の角の小塔（持ち送りの上の円筒と円錐の屋根）
  for (const sv of [-1, 1]) {
    const [n, t, hw, d] = fs;
    const q = [cx + n[0] * (d + 0.3) + t[0] * (hw + 0.3) * sv, cz + n[1] * (d + 0.3) + t[1] * (hw + 0.3) * sv];
    cylinder(w, q[0], q[1], 0.3, 1.25, yM - 4.5, yM - 2.5, { seg: 12, color: STONE });
    cylinder(w, q[0], q[1], 1.25, 1.25, yM - 2.5, yP + 1.0, { seg: 12, color: STONE });
    cylinder(mt, q[0], q[1], 1.45, 0.02, yP + 1.0, yP + 6.0, { seg: 12, color: SLATE });
  }
  // 真ん中の八角形の鐘楼（アーチの開口）と尖塔、頂の飾り
  const yb = yR - 0.8;
  cylinder(w, cx, cz, 1.7, 1.7, yb, yb + 4.2, { seg: 8, color: STONE });
  for (let k = 0; k < 8; k++) {
    const an = ((k + 0.5) / 8) * Math.PI * 2;
    const n = [Math.cos(an), 0, Math.sin(an)], t = [-Math.sin(an), Math.cos(an)];
    const rr = 1.7 * Math.cos(Math.PI / 8) + 0.03;
    vpoly(w, [cx + n[0] * rr, cz + n[2] * rr], t, archShape(0.8, 2.2, yb + 1.3, 6), n, DARK);
  }
  annulus(w, cx, cz, 0, 1.95, yb + 4.2, 8, SHADE, false);
  cylinder(w, cx, cz, 1.95, 1.95, yb + 4.2, yb + 4.5, { seg: 8, color: SHADE });
  cylinder(mt, cx, cz, 1.85, 0.03, yb + 4.5, yb + 11.5, { seg: 8, color: SLATE });
  box(mt, [cx, yb + 12.2, cz], [0.05, 0, 0], [0, 0.8, 0], [0, 0, 0.05], DARK);
  for (const [p, q] of [[P(-a, -b, 0), P(a, -b, 0)], [P(a, -b, 0), P(a, b, 0)], [P(a, b, 0), P(-a, b, 0)], [P(-a, b, 0), P(-a, -b, 0)]]) colliders.push([p[0], p[2], q[0], q[2]]);
}

// ---- ロマネスクの大聖堂（サン・セルナン）。u: 東へ（e1）、v: 横（e2）、高さは地面から
function writeBasilica(m, W, groundAt) {
  const { cx, cz, e1, e2, a, b, sc } = m;
  const y0 = groundAt(cx, cz) - 0.3;
  const w = W.main, mt = W.metal;
  const BR = col('#efc1a8'), TILE = col('#a35c47'), DARK = col('#3a2c26'), STONE = col('#ddd2c2');
  const P = (u, v, y) => [cx + e1[0] * u + e2[0] * v, y0 + y, cz + e1[1] * u + e2[1] * v];
  const P2 = (u, v) => [cx + e1[0] * u + e2[0] * v, cz + e1[1] * u + e2[1] * v];
  const N = (du, dv) => [e1[0] * du + e2[0] * dv, 0, e1[1] * du + e2[1] * dv];
  const side = (p, q, ya, yb, n) => wall(w, P2(...p), P2(...q), y0 + ya, y0 + yb, n, CELL.brick, BRICK_CW, BRICK_CW, BR);
  // 窓: p・n・along は世界の座標（P2・T で変換したもの）
  const win = (p, n, along, yb, ht, wd = 1.3) => vpoly(w, [p[0] + n[0] * 0.06, p[1] + n[1] * 0.06], along, archShape(wd, ht, y0 + yb, 6), [n[0], 0, n[1]], DARK);
  const T = (dir) => [e1[0] * dir[0] + e2[0] * dir[1], e1[1] * dir[0] + e2[1] * dir[1]]; // (u, v) の向き → 世界
  // 箱（u0..u1 × v0..v1、高さ h）の 4 面と、窓（step m おき）
  const block = (u0, u1, v0, v1, h, winY = null, winH = 3.5, skip = '') => {
    if (!skip.includes('s')) side([u0, v0], [u1, v0], 0, h, N(0, -1));
    if (!skip.includes('n')) side([u1, v1], [u0, v1], 0, h, N(0, 1));
    if (!skip.includes('w')) side([u0, v1], [u0, v0], 0, h, N(-1, 0));
    if (!skip.includes('e')) side([u1, v0], [u1, v1], 0, h, N(1, 0));
    if (winY == null) return;
    for (let u = u0 + 3; u < u1 - 2; u += 6) {
      for (const [v, n] of [[v0, [0, -1]], [v1, [0, 1]]]) win(P2(u, v), T(n), T([1, 0]), winY, winH);
    }
  };
  // 切妻の瓦屋根（棟は along = 'u' か 'v'）。軒 ye・棟 yr
  const gable = (u0, u1, v0, v1, ye, yr, along) => {
    const q = (A, B, C, D) => {
      const n = (() => {
        const ux = B[0] - A[0], uy = B[1] - A[1], uz = B[2] - A[2], vx = D[0] - A[0], vy = D[1] - A[1], vz = D[2] - A[2];
        const c = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx], l = Math.hypot(...c) || 1;
        return c[1] < 0 ? c.map((t) => -t / l) : c.map((t) => t / l);
      })();
      mt.quad(A, B, C, D, n, PLAIN_UV, PLAIN_UV, PLAIN_UV, PLAIN_UV, TILE);
    };
    const tri = (A, B, C, n) => w.tri(A, B, C, n, PLAIN_UV, PLAIN_UV, PLAIN_UV, BR);
    if (along === 'u') {
      const vm = (v0 + v1) / 2;
      q(P(u0 - 0.4, v0 - 0.6, ye), P(u1 + 0.4, v0 - 0.6, ye), P(u1 + 0.4, vm, yr), P(u0 - 0.4, vm, yr));
      q(P(u0 - 0.4, v1 + 0.6, ye), P(u1 + 0.4, v1 + 0.6, ye), P(u1 + 0.4, vm, yr), P(u0 - 0.4, vm, yr));
      tri(P(u0, v0, ye), P(u0, v1, ye), P(u0, vm, yr), N(-1, 0));
      tri(P(u1, v0, ye), P(u1, v1, ye), P(u1, vm, yr), N(1, 0));
    } else {
      const um = (u0 + u1) / 2;
      q(P(u0 - 0.6, v0 - 0.4, ye), P(u0 - 0.6, v1 + 0.4, ye), P(um, v1 + 0.4, yr), P(um, v0 - 0.4, yr));
      q(P(u1 + 0.6, v0 - 0.4, ye), P(u1 + 0.6, v1 + 0.4, ye), P(um, v1 + 0.4, yr), P(um, v0 - 0.4, yr));
      tri(P(u0, v0, ye), P(u1, v0, ye), P(um, v0, yr), N(0, -1));
      tri(P(u0, v1, ye), P(u1, v1, ye), P(um, v1, yr), N(0, 1));
    }
  };
  // 片流れの屋根（側廊）: 外の軒 yo（v = vo）から内の壁 yi（v = vi）へ
  const leanTo = (u0, u1, vo, vi, yo, yi) => {
    const A = P(u0, vo, yo), B = P(u1, vo, yo), C = P(u1, vi, yi), D = P(u0, vi, yi);
    const n = N(0, Math.sign(vo - vi) * (yi - yo));
    n[1] = Math.abs(vi - vo);
    const l = Math.hypot(...n);
    mt.quad(A, B, C, D, n.map((t) => t / l), PLAIN_UV, PLAIN_UV, PLAIN_UV, PLAIN_UV, TILE);
  };
  const tan = Math.tan((20 * Math.PI) / 180);
  const W0 = -a + 1, tH = 9, sA = sc + 16, vN = 6.5, vA = 16, hA = 12, hN = 21, hT = 21;
  const vT = Math.min(b - 1, 31);
  // 身廊と側廊（西の正面から交差部の手前まで）
  block(W0, sc - tH, -vA, vA, hA, 4.5, 4, 'e');
  block(W0, sc - tH, -vN, vN, hN, 16, 3.2, 'e');
  for (const sgn of [-1, 1]) leanTo(W0, sc - tH, sgn * vA, sgn * vN, hA, hA + (vA - vN) * tan * 1.6);
  gable(W0, sc - tH, -vN, vN, hN, hN + vN * tan, 'u');
  // 袖廊
  block(sc - tH, sc + tH, -vT, vT, hT, 5, 4.5, '');
  gable(sc - tH, sc + tH, -vT, vT, hT, hT + tH * tan, 'v');
  // 内陣（袖廊から後陣の中心まで）
  block(sc + tH, sA, -vA, vA, hA, null, 0, 'w');
  block(sc + tH, sA, -vN, vN, hN, null, 0, 'we');
  for (const sgn of [-1, 1]) leanTo(sc + tH, sA, sgn * vA, sgn * vN, hA, hA + (vA - vN) * tan * 1.6);
  gable(sc + tH, sA, -vN, vN, hN, hN + vN * tan, 'u');
  // 東の端: 半円の壁・半円錐の屋根（中心は後陣の中心、角度は e1 から ±90°）
  const dir = (t) => [Math.cos(t), Math.sin(t)];
  const arc = (ou, ov, r, t0, t1, h, seg, yb = 0) => {
    for (let k = 0; k < seg; k++) {
      const ta = t0 + ((t1 - t0) * k) / seg, tb = t0 + ((t1 - t0) * (k + 1)) / seg, tm = (ta + tb) / 2;
      const [ca, sa] = dir(ta), [cb, sb] = dir(tb), [cm, sm] = dir(tm);
      side([ou + ca * r, ov + sa * r], [ou + cb * r, ov + sb * r], yb, h, N(cm, sm));
    }
  };
  const cone = (ou, ov, r, t0, t1, ye, yt, seg, rIn = 0) => {
    for (let k = 0; k < seg; k++) {
      const ta = t0 + ((t1 - t0) * k) / seg, tb = t0 + ((t1 - t0) * (k + 1)) / seg, tm = (ta + tb) / 2;
      const [ca, sa] = dir(ta), [cb, sb] = dir(tb), [cm, sm] = dir(tm);
      const ro = r + 0.5, n = N(cm * (yt - ye), sm * (yt - ye));
      n[1] = ro - rIn;
      const l = Math.hypot(...n);
      mt.quad(P(ou + ca * ro, ov + sa * ro, ye), P(ou + cb * ro, ov + sb * ro, ye), P(ou + cb * rIn, ov + sb * rIn, yt), P(ou + ca * rIn, ov + sa * rIn, yt), n.map((t) => t / l), PLAIN_UV, PLAIN_UV, PLAIN_UV, PLAIN_UV, TILE);
    }
  };
  // 半円の壁に沿った白い石の帯（半径 r、高さ ya〜yb）
  const band = (ou, ov, r, t0, t1, ya, yb, seg) => {
    for (let k = 0; k < seg; k++) {
      const ta = t0 + ((t1 - t0) * k) / seg, tb = t0 + ((t1 - t0) * (k + 1)) / seg, tm = (ta + tb) / 2;
      const [ca, sa] = dir(ta), [cb, sb] = dir(tb), [cm, sm] = dir(tm);
      w.quad(P(ou + ca * r, ov + sa * r, ya), P(ou + cb * r, ov + sb * r, ya), P(ou + cb * r, ov + sb * r, yb), P(ou + ca * r, ov + sa * r, yb), N(cm, sm), PLAIN_UV, PLAIN_UV, PLAIN_UV, PLAIN_UV, STONE);
    }
  };
  const H = Math.PI / 2;
  // 後陣の円筒（20 m）と半円錐の屋根、半円アーチの窓
  arc(sA, 0, vN, -H, H, 20, 10, hA);
  cone(sA, 0, vN, -H, H, 20, 24.5, 10);
  for (let k = 0; k < 5; k++) {
    const t = -H + ((k + 0.5) / 5) * Math.PI, [c, sn] = dir(t);
    win(P2(sA + c * vN, sn * vN), T([c, sn]), T([-sn, c]), 15.2, 3.4, 1.1);
  }
  // 周歩廊（13 m）と片流れの屋根
  const rAm = 14;
  arc(sA, 0, rAm, -H, H, 13, 16);
  for (const [sgn] of [[-1], [1]]) side([sA, sgn * vA], [sA, sgn * rAm], 0, hA, N(-1, 0));
  cone(sA, 0, rAm, -H, H, 13, 15.5, 16, vN);
  // 放射状の 5 つの小礼拝堂（直径 6 m・8 m）と半円錐の屋根。窓は 3 つ（利用者の写真 NCM_0099: 礼拝堂・周歩廊・後陣が
  // 段々に重なり、どの段にも半円アーチの窓と白い石の帯）
  for (let k = 0; k < 5; k++) {
    const t = -H + ((k + 0.5) / 5) * Math.PI, [c, sn] = dir(t);
    const ou = sA + c * (rAm + 0.6), ov = sn * (rAm + 0.6);
    arc(ou, ov, 3, t - H, t + H, 8, 8);
    cone(ou, ov, 3, t - H, t + H, 8, 10.2, 8);
    for (const dt of [-0.75, 0, 0.75]) {
      const [cw, sw] = dir(t + dt);
      win(P2(ou + cw * 3, ov + sw * 3), T([cw, sw]), T([-sw, cw]), 3.0, 3.0, 0.85);
    }
    // 周歩廊の、礼拝堂の屋根の上の窓
    win(P2(sA + c * rAm, sn * rAm), T([c, sn]), T([-sn, c]), 10.5, 2.2, 1.0);
    band(ou, ov, 3.06, t - H, t + H, 7.5, 7.8, 8);
  }
  // 周歩廊の、礼拝堂のあいだの窓と、白い石の帯
  for (let k = 1; k < 5; k++) {
    const t = -H + (k / 5) * Math.PI, [c, sn] = dir(t);
    win(P2(sA + c * rAm, sn * rAm), T([c, sn]), T([-sn, c]), 4.5, 3.6, 1.2);
  }
  band(sA, 0, rAm + 0.06, -H, H, 12.4, 12.8, 16);
  band(sA, 0, vN + 0.06, -H, H, 19.4, 19.8, 10);
  // 白い石の帯（側廊の窓の下）
  for (const [v, n] of [[-vA, [0, -1]], [vA, [0, 1]]]) {
    const p = P2(W0, v), q = P2(sc - tH, v);
    const nn = N(...n);
    w.quad([p[0] + nn[0] * 0.05, y0 + 3.6, p[1] + nn[2] * 0.05], [q[0] + nn[0] * 0.05, y0 + 3.6, q[1] + nn[2] * 0.05], [q[0] + nn[0] * 0.05, y0 + 4.0, q[1] + nn[2] * 0.05], [p[0] + nn[0] * 0.05, y0 + 4.0, p[1] + nn[2] * 0.05], nn, PLAIN_UV, PLAIN_UV, PLAIN_UV, PLAIN_UV, STONE);
  }
}

// ---- カピテヌリー: レンガの横の壁、北の半円のガラスの正面（暗い枠）、張り出した暗い金属のかまぼこ屋根
function writeCapitainerie(m, W, groundAt, colliders) {
  const { cx, cz, ax, hl, hw } = m;
  const w = W.main, mt = W.metal;
  const y0 = groundAt(cx, cz), hWall = 4.4, rise = Math.min(5.2, hw * 0.75);
  const side = [-ax[1], ax[0]];
  const P = (u, v, y) => [cx + ax[0] * u + side[0] * v, y0 + y, cz + ax[1] * u + side[1] * v];
  const P2 = (u, v) => [cx + ax[0] * u + side[0] * v, cz + ax[1] * u + side[1] * v];
  const ROOF = col('#525a64'), GLASS = col('#3d4a52'), FRAME = col('#2a2e30'), BRICKC = col('#d39a80');
  // 横の壁（レンガ）と裏の壁
  wall(w, P2(-hl, -hw), P2(hl, -hw), y0, y0 + hWall, [-side[0], 0, -side[1]], CELL.brick, BRICK_CW, BRICK_CW, BRICKC);
  wall(w, P2(hl, hw), P2(-hl, hw), y0, y0 + hWall, [side[0], 0, side[1]], CELL.brick, BRICK_CW, BRICK_CW, BRICKC);
  wall(w, P2(-hl, hw), P2(-hl, -hw), y0, y0 + hWall, [-ax[0], 0, -ax[1]], CELL.brick, BRICK_CW, BRICK_CW, BRICKC);
  // 屋根の断面（円弧）: v → 高さ
  const N = 12, arcY = (f) => hWall + rise * Math.sin(Math.acos(Math.max(-1, Math.min(1, f))));
  const ov = 1.5, ovs = 0.5;
  for (let i = 0; i < N; i++) {
    const f0 = -1 + (2 * i) / N, f1 = -1 + (2 * (i + 1)) / N;
    const v0 = f0 * (hw + ovs), v1 = f1 * (hw + ovs), y0a = arcY(f0), y1a = arcY(f1);
    const nn = [side[0] * -(y1a - y0a), v1 - v0, side[1] * -(y1a - y0a)], l = Math.hypot(...nn);
    mt.quad(P(-hl - ov, v0, y0a), P(hl + ov, v0, y0a), P(hl + ov, v1, y1a), P(-hl - ov, v1, y1a), nn.map((q) => q / l), PLAIN_UV, PLAIN_UV, PLAIN_UV, PLAIN_UV, ROOF);
    // 正面のガラス（円弧の下の扇形）と裏の妻壁
    for (const [u, sg] of [[hl, 1], [-hl, -1]]) {
      const n3 = [ax[0] * sg, 0, ax[1] * sg];
      const vv0 = f0 * hw, vv1 = f1 * hw, ya = arcY(f0) - 0.1, yb = arcY(f1) - 0.1;
      if (sg > 0) w.quad(P(u, vv0, 0), P(u, vv1, 0), P(u, vv1, yb), P(u, vv0, ya), n3, PLAIN_UV, PLAIN_UV, PLAIN_UV, PLAIN_UV, GLASS);
      else w.quad(P(u, vv0, hWall), P(u, vv1, hWall), P(u, vv1, yb), P(u, vv0, ya), n3, PLAIN_UV, PLAIN_UV, PLAIN_UV, PLAIN_UV, BRICKC);
    }
  }
  // ガラスの正面の縦の枠
  for (let k = 0; k <= 8; k++) {
    const f = -1 + (2 * k) / 8, v = f * hw, yt = arcY(f) - 0.1;
    const c = P2(hl + 0.05, v);
    box(w, [c[0], y0 + yt / 2, c[1]], [ax[0] * 0.06, 0, ax[1] * 0.06], [0, yt / 2, 0], [side[0] * 0.08, 0, side[1] * 0.08], FRAME);
  }
  const c = P2(hl + 0.05, 0);
  box(w, [c[0], y0 + 2.6, c[1]], [ax[0] * 0.06, 0, ax[1] * 0.06], [0, 0.08, 0], [side[0] * hw, 0, side[1] * hw], FRAME);
}

// ---- つないだ平底船: 暗い紺〜黒の船体（へさきは細く）、白い操舵室とニスを塗った木の屋根
function writeMoorings(m, W, groundAt, colliders, onRoad, keepOut, waterAt) {
  const w = W.main;
  const HULLS = [col('#1e2a3a'), col('#202224'), col('#2c3b2e'), col('#3a2a24')], CABIN = col('#e8e6e0'), WOOD = col('#8a5e3a'), DECK = col('#6e6a62');
  const { t, n } = m;
  for (const { x, z, len, k } of m.boats) {
    const yw = waterAt(x, z, m.area);
    const hl = len / 2, hb = 2.2, fb = 0.9;
    const P = (u, v, y) => [x + t[0] * u + n[0] * v, yw + y, z + t[1] * u + n[1] * v];
    const hull = HULLS[k % HULLS.length];
    // 船体: 四角い胴と、細くなるへさき
    box(w, [x + t[0] * -1.5, yw + fb / 2 - 0.3, z + t[1] * -1.5], [t[0] * (hl - 1.5), 0, t[1] * (hl - 1.5)], [0, fb / 2 + 0.3, 0], [n[0] * hb, 0, n[1] * hb], hull, { top: DECK });
    const bow = [P(hl - 3, -hb, -0.6), P(hl - 3, hb, -0.6), P(hl, 0, -0.6), P(hl - 3, -hb, fb + 0.1), P(hl - 3, hb, fb + 0.1), P(hl + 0.4, 0, fb + 0.1)];
    for (const sg of [-1, 1]) {
      const a = sg < 0 ? 0 : 1, nn = [n[0] * sg + t[0] * 0.8, 0, n[1] * sg + t[1] * 0.8], l = Math.hypot(...nn);
      w.quad(bow[a], bow[2], bow[5], bow[a + 3], nn.map((q) => q / l), PLAIN_UV, PLAIN_UV, PLAIN_UV, PLAIN_UV, hull);
    }
    w.tri(bow[3], bow[4], bow[5], [0, 1, 0], PLAIN_UV, PLAIN_UV, PLAIN_UV, DECK);
    // 操舵室・居室（後ろ寄り）と木の屋根
    const cl = Math.min(hl * 1.1, 8 + hash01(k, 74) * 6), cu = -hl + 1.5 + cl / 2;
    const cc = P(cu, 0, 0);
    box(w, [cc[0], yw + fb + 0.9, cc[2]], [t[0] * cl / 2, 0, t[1] * cl / 2], [0, 0.9, 0], [n[0] * (hb - 0.4), 0, n[1] * (hb - 0.4)], CABIN, { top: WOOD });
    for (let j = 0; j < Math.floor(cl / 1.6); j++) {
      const wc = P(cu - cl / 2 + 0.9 + j * 1.6, hb - 0.38, fb + 1.15);
      for (const sg of [-1, 1]) vpoly(w, [wc[0] + n[0] * (sg < 0 ? -2 * (hb - 0.38) : 0), wc[2] + n[1] * (sg < 0 ? -2 * (hb - 0.38) : 0)], t, [[-0.45, wc[1] - 0.35], [0.45, wc[1] - 0.35], [0.45, wc[1] + 0.35], [-0.45, wc[1] + 0.35]], [n[0] * sg, 0, n[1] * sg], col('#2c3238'));
    }
  }
}

// ---- 川に面した正面: 破風・水際のアーチ・古い橋脚の跡
function writeRiverfront(m, W, groundAt) {
  const w = W.main;
  const { p, q, L, n, height: H } = m;
  const STONE = col('#d8ccb8'), DARK = col('#262322'), BRICK = col('#b78268'), PIER = col('#9a7262');
  const t = [(q[0] - p[0]) / L, (q[1] - p[1]) / L], N = [n[0], 0, n[1]];
  const at = (s, o) => [p[0] + t[0] * s + n[0] * o, p[1] + t[1] * s + n[1] * o];
  const y0 = groundAt(...at(L / 2, -2));
  // 真ん中の張り出し（幅 14 m の淡い石の枠）と三角の破風
  const c = at(L / 2, 0.08);
  vpoly(w, c, t, [[-7, y0 + H - 1.2], [7, y0 + H - 1.2], [7, y0 + H], [-7, y0 + H]], N, STONE);
  vpoly(w, at(L / 2, 0.1), t, [[-7.4, y0 + H], [7.4, y0 + H], [0, y0 + H + 3.4]], N, STONE);
  vpoly(w, at(L / 2, 0.12), t, [[-5.6, y0 + H + 0.4], [5.6, y0 + H + 0.4], [0, y0 + H + 2.7]], N, BRICK);
  for (const sx of [-7, 7]) vpoly(w, at(L / 2 + sx, 0.09), t, [[-0.5, y0], [0.5, y0], [0.5, y0 + H], [-0.5, y0 + H]], N, STONE);
  // 水際の 2 つの大きなアーチ（真ん中の左）
  const yw = groundAt(...at(L / 2, 6));
  for (const sx of [-14, -7.5]) {
    vpoly(w, at(L / 2 + sx, 0.08), t, archShape(5.0, 5.8, yw - 0.5, 10), N, STONE);
    vpoly(w, at(L / 2 + sx, 0.11), t, archShape(4.2, 5.3, yw - 0.5, 10), N, DARK);
  }
  // 川の中の古い橋脚の跡（正面から 14 m 沖）: 尖った水切りの付いた台と、片側に残るアーチの付け根
  const pc = at(L / 2 + 4, 14), yb = groundAt(...pc) - 0.5, yt = y0 - 0.6;
  if (yt - yb > 1) {
    box(w, [pc[0], (yb + yt) / 2, pc[1]], [t[0] * 4, 0, t[1] * 4], [0, (yt - yb) / 2, 0], [n[0] * 2.6, 0, n[1] * 2.6], PIER);
    cylinder(w, pc[0] + n[0] * 2.6, pc[1] + n[1] * 2.6, 2.6, 0.2, yb, yt, { seg: 4, color: PIER });
    vpoly(w, at(L / 2 + 8.05, 14), [n[0], n[1]], [[-2.6, yt], [2.6, yt], [2.6, yt + 2.2], [-2.6, yt + 0.6]], [t[0], 0, t[1]], BRICK);
  }
}

// ---- ネオロマネスクのアーケードの正面（オーギュスタン美術館）
function writeArcades(m, W, groundAt) {
  const w = W.main;
  const SAND = col('#8f877c'), STONE = col('#d2c7b6'), DARK = col('#2a2624'), GLASS = col('#46525a'), TRIM = col('#c98c6c');
  for (const { p, q, L, n } of m.edges) {
    const t = [(q[0] - p[0]) / L, (q[1] - p[1]) / L], N = [n[0], 0, n[1]];
    const y0 = groundAt((p[0] + q[0]) / 2, (p[1] + q[1]) / 2);
    const at = (s, o) => [p[0] + t[0] * s + n[0] * o, p[1] + t[1] * s + n[1] * o];
    const band = (ya, yb, o, color) => vpoly(w, at(L / 2, o), t, [[-L / 2, y0 + ya], [L / 2, y0 + ya], [L / 2, y0 + yb], [-L / 2, y0 + yb]], N, color);
    band(0, 1.5, 0.06, SAND); // 腰石
    band(7.4, 7.9, 0.08, STONE); // 石の帯
    band(11.7, 12.4, 0.12, STONE); // 軒の持ち送り
    const nb = Math.max(1, Math.floor(L / 4.6));
    for (let k = 0; k < nb; k++) {
      const sm = (L * (k + 0.5)) / nb;
      vpoly(w, at(sm, 0.07), t, archShape(4.1, 7.0, y0 + 0.2, 10), N, TRIM); // アーチの迫石
      vpoly(w, at(sm, 0.1), t, archShape(3.4, 6.6, y0 + 0.2, 10), N, GLASS); // ガラスの開口
      vpoly(w, at(sm, 0.11), t, [[-0.06, y0 + 0.2], [0.06, y0 + 0.2], [0.06, y0 + 6.6], [-0.06, y0 + 6.6]], N, DARK);
      for (const dx of [-0.75, 0.75]) vpoly(w, at(sm + dx, 0.09), t, archShape(1.0, 2.6, y0 + 8.6, 6), N, DARK); // 2 つ並びの窓
      for (const dx of [-0.6, 0, 0.6]) vpoly(w, at(sm + dx, 0.13), t, [[-0.12, y0 + 11.2], [0.12, y0 + 11.2], [0.12, y0 + 11.7], [-0.12, y0 + 11.7]], N, STONE); // 持ち送り
    }
  }
}

// ---- ゴシックの石の内陣: 辺ごとに控え壁（尖塔飾り付き）と、そのあいだの 2 段の尖頭アーチの窓
const lancet = (wd, ht, y0) => {
  const r = wd / 2, ys = y0 + ht - wd * 0.95;
  return [[-r, y0], [r, y0], [r, ys], [r * 0.72, ys + (y0 + ht - ys) * 0.55], [0, y0 + ht], [-r * 0.72, ys + (y0 + ht - ys) * 0.55], [-r, ys]];
};
function writeChoir(m, W, groundAt, colliders) {
  const w = W.main;
  const STONE = col('#b3a696'), SOOT = col('#4f4843'), DARK = col('#26282c'), TRACERY = col('#9a8f82');
  const H = m.height;
  for (const { p, q, L, n } of m.edges) {
    const t = [(q[0] - p[0]) / L, (q[1] - p[1]) / L], N = [n[0], 0, n[1]];
    const y0 = groundAt((p[0] + q[0]) / 2, (p[1] + q[1]) / 2);
    const at = (s, o) => [p[0] + t[0] * s + n[0] * o, p[1] + t[1] * s + n[1] * o];
    // すすけた足元（6 m）
    vpoly(w, at(L / 2, 0.04), t, [[-L / 2, y0], [L / 2, y0], [L / 2, y0 + 6], [-L / 2, y0 + 6]], N, SOOT);
    // 控え壁: 辺の両端と 6.5 m ごと
    const nb = Math.max(1, Math.round(L / 6.5));
    for (let k = 0; k <= nb; k++) {
      const c = at((L * k) / nb, 0.9);
      box(w, [c[0], y0 + H * 0.42, c[1]], [t[0] * 0.6, 0, t[1] * 0.6], [0, H * 0.42, 0], [n[0] * 0.9, 0, n[1] * 0.9], STONE);
      const c2 = at((L * k) / nb, 0.5);
      box(w, [c2[0], y0 + H * 0.92, c2[1]], [t[0] * 0.45, 0, t[1] * 0.45], [0, H * 0.08, 0], [n[0] * 0.5, 0, n[1] * 0.5], STONE);
      cylinder(w, c2[0], c2[1], 0.45, 0.02, y0 + H, y0 + H + 3.2, { seg: 4, color: STONE });
      colliders.push([c[0], c[1], 1.0]);
    }
    // 窓（控え壁のあいだごとに、下の段 4〜9 m と上の段 10.5〜19 m）
    for (let k = 0; k < nb; k++) {
      const sm = (L * (k + 0.5)) / nb, span = L / nb;
      if (span < 3) continue;
      const wd = Math.min(2.6, span - 2.2), o = at(sm, 0.05);
      vpoly(w, o, t, lancet(wd + 0.5, 6.3, y0 + 3.7), N, TRACERY);
      vpoly(w, at(sm, 0.08), t, lancet(wd, 5.8, y0 + 4), N, DARK);
      if (H > 16) {
        vpoly(w, o, t, lancet(wd + 0.5, Math.min(9, H - 12) + 0.4, y0 + 10.3), N, TRACERY);
        vpoly(w, at(sm, 0.08), t, lancet(wd, Math.min(9, H - 12), y0 + 10.5), N, DARK);
      }
    }
    // 軒の手すり（細い帯）
    vpoly(w, at(L / 2, 0.06), t, [[-L / 2, y0 + H - 0.9], [L / 2, y0 + H - 0.9], [L / 2, y0 + H + 0.6], [-L / 2, y0 + H + 0.6]], N, STONE);
  }
}

// ---- 遊歩道の植え込み: 低木の塊（高さ 1〜2 m）と、幹の細い若い木（高さ 6〜9 m）
function writeRamblas(m, W, groundAt) {
  const w = W.main;
  const SHRUB = [col('#5a6026'), col('#4a5328'), col('#3f4628'), col('#66692e')], LEAF = [col('#5f7a35'), col('#6b8238'), col('#577030')];
  for (const [x, z, k] of m.shrubs) {
    const h = 1 + hash01(k, 64) * 1.0, r = 0.7 + hash01(k, 65) * 0.5;
    blob(w, [x, groundAt(x, z) + h * 0.55, z], [r * 1.2, h * 0.55, r], hash01(k, 66) * 6, 7, 4, (f) => SHRUB[(k + f) % SHRUB.length]);
  }
  for (const [x, z, k] of m.young) {
    const y = groundAt(x, z), h = 6 + hash01(k, 67) * 3, r = 1.6 + hash01(k, 68) * 0.9;
    for (const [dx, dz] of [[0.18, 0], [-0.12, 0.15]]) cylinder(w, x + dx, z + dz, 0.08, 0.05, y, y + h - r, { seg: 5, color: col('#6a6058') });
    blob(w, [x, y + h - r * 0.9, z], [r, r * 0.95, r * 0.9], hash01(k, 69) * 6, 9, 5, (f) => LEAF[(k + f) % LEAF.length]);
  }
}

// ---- 閘門（利用者の写真 NCM_0185）: 幅 6.4 m・深さ約 4 m の石積みの閘室（灰色の切石）、底に暗い水。運河の側の端に
// 錆色の鋼の扉と、その上を渡る鋼の歩道橋（格子の床）。閘室のまわりは黒い鋼の柵（2 m ごとの X の筋交いと、交点の丸い飾り）。
// 地形モデルでは閘室が浅い窪みなので、閘室の上の面（ステンシル）で地面を切り抜き、中を壁と水で描く（メトロの出入口と同じ）
function writeLock(m, W, groundAt, colliders, onRoad, keepOut, waterAt) {
  const w = W.main, mt = W.metal;
  const { L, u, v, at: P } = lockFrame(m.a, m.b);
  const hw = m.width / 2;
  const yw = waterAt(...P(L / 2, 0), m.area) + 0.02;
  const STONE = ['#b9b3a8', '#aea89d', '#c2bcb1', '#a7a196'].map(col), COPING = col('#bfbab0'), WATER = col('#2f3a38');
  const GATE = col('#8a6a60'), IRON = col('#3a3a3c'), GRATE = col('#4a4c4e');
  const u0 = m.from, u1 = L, step = 3;
  const us = [];
  for (let k = 0; k <= Math.ceil((u1 - u0) / step); k++) us.push(Math.min(u1, u0 + k * step));
  // 両側の縁の高さ: 壁のすぐ外の地面と、閘室の中の地面（地形モデルの浅い窪み。切り抜く面より下にする）の高い方
  const inner = us.map((t) => {
    let y = -Infinity;
    for (let du = -1.5; du <= 1.5; du += 0.75) for (let dv = -hw; dv <= hw + 1e-6; dv += hw / 4) y = Math.max(y, groundAt(...P(Math.min(u1, Math.max(u0, t + du)), dv)));
    return y;
  });
  const edge = [-1, 1].map((sd) => us.map((t) => groundAt(...P(t, sd * (hw + 0.9)))));
  const top = edge.map((E) => E.map((e, k) => Math.max(yw + 1.5, e, inner[k]) + 0.05));
  // 段にならないよう、隣との差を 1 区間 0.35 m までに（低い方を持ち上げる）
  for (const T of top) {
    for (let k = 1; k < T.length; k++) T[k] = Math.max(T[k], T[k - 1] - 0.35);
    for (let k = T.length - 2; k >= 0; k--) T[k] = Math.max(T[k], T[k + 1] - 0.35);
  }
  const topAt = (si, t) => {
    const T = top[si], f = Math.min(us.length - 1.001, Math.max(0, (t - u0) / step)), i = Math.floor(f);
    return T[i] + (T[i + 1] - T[i]) * (f - i);
  };
  const ashlar = (p0, p1, y0, y1, n, seed) => {
    // 切石の目地（幅 1.2 m・高さ 0.55 m の石を半分ずつずらして積む。石ごとに色を少し変える）
    const Lw = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]), d = [(p1[0] - p0[0]) / Lw, (p1[1] - p0[1]) / Lw];
    const rows = Math.max(1, Math.round((y1 - y0) / 0.55));
    for (let r = 0; r < rows; r++) {
      const ya = y0 + ((y1 - y0) * r) / rows, yb = y0 + ((y1 - y0) * (r + 1)) / rows;
      const off = r % 2 ? 0.6 : 0;
      for (let s0 = -off; s0 < Lw; s0 += 1.2) {
        const sa = Math.max(0, s0), sb = Math.min(Lw, s0 + 1.2);
        if (sb - sa < 0.05) continue;
        const c = STONE[Math.floor(hash01(seed + r * 131 + Math.round(s0 * 10), 41) * STONE.length)];
        const A = [p0[0] + d[0] * sa, p0[1] + d[1] * sa], B = [p0[0] + d[0] * sb, p0[1] + d[1] * sb];
        w.quad([A[0], ya + 0.02, A[1]], [B[0], ya + 0.02, B[1]], [B[0], yb, B[1]], [A[0], yb, A[1]], n, PLAIN_UV, PLAIN_UV, PLAIN_UV, PLAIN_UV, c);
      }
      w.quad([p0[0], ya, p0[1]], [p1[0], ya, p1[1]], [p1[0], ya + 0.02, p1[1]], [p0[0], ya + 0.02, p0[1]], n, PLAIN_UV, PLAIN_UV, PLAIN_UV, PLAIN_UV, col('#8d877c'));
    }
  };
  const yBot = yw - 0.4;
  // 長い側の壁（内向き）と笠石、地面の切り抜き
  for (let k = 0; k + 1 < us.length; k++) {
    const t0 = us[k], t1 = us[k + 1];
    for (const [si, sd] of [[0, -1], [1, 1]]) {
      const p0 = P(t0, sd * hw), p1 = P(t1, sd * hw), yt = Math.min(top[si][k], top[si][k + 1]);
      const n = [-v[0] * sd, 0, -v[1] * sd];
      ashlar(sd < 0 ? p0 : p1, sd < 0 ? p1 : p0, yBot, yt, n, k * 7 + si * 3);
      // 笠石（幅 0.9 m の淡い花崗岩。上の面と、外側の面を 1.2 m 下ろす）と、壁の上の端（切石の上から笠石まで）
      const y0 = top[si][k] + 0.1, y1 = top[si][k + 1] + 0.1, o0 = P(t0, sd * (hw + 0.9)), o1 = P(t1, sd * (hw + 0.9));
      const up = sd < 0 ? [p0, p1, o1, o0] : [p1, p0, o0, o1], ys = sd < 0 ? [y0, y1, y1, y0] : [y1, y0, y0, y1];
      w.quad(...up.map((q, i) => [q[0], ys[i], q[1]]), [0, 1, 0], PLAIN_UV, PLAIN_UV, PLAIN_UV, PLAIN_UV, COPING);
      const on = [v[0] * sd, 0, v[1] * sd], [e0, e1, f0, f1] = sd < 0 ? [o1, o0, y1, y0] : [o0, o1, y0, y1];
      // 外側の面: 上の 0.3 m は笠石、その下は地面の下まで切石
      const yg = Math.min(edge[si][k], edge[si][k + 1]) - 0.3;
      w.quad([e0[0], f0 - 0.3, e0[1]], [e1[0], f1 - 0.3, e1[1]], [e1[0], f1, e1[1]], [e0[0], f0, e0[1]], on, PLAIN_UV, PLAIN_UV, PLAIN_UV, PLAIN_UV, COPING);
      if (yg < Math.min(f0, f1) - 0.3) ashlar(e0, e1, yg, Math.min(f0, f1) - 0.3, on, 501 + k * 5 + si);
      const [g0, g1, h0, h1] = sd < 0 ? [p0, p1, y0, y1] : [p1, p0, y1, y0];
      w.quad([g0[0], yt, g0[1]], [g1[0], yt, g1[1]], [g1[0], h1, g1[1]], [g0[0], h0, g0[1]], n, PLAIN_UV, PLAIN_UV, PLAIN_UV, PLAIN_UV, COPING);
    }
    // 水面と、地面の切り抜き（閘室の上の面。上向き）
    const A = P(t0, -hw), B = P(t1, -hw), C = P(t1, hw), D = P(t0, hw);
    w.quad([A[0], yw, A[1]], [D[0], yw, D[1]], [C[0], yw, C[1]], [B[0], yw, B[1]], [0, 1, 0], PLAIN_UV, PLAIN_UV, PLAIN_UV, PLAIN_UV, WATER);
    const yA = top[0][k] + 0.1, yB = top[0][k + 1] + 0.1, yC = top[1][k + 1] + 0.1, yD = top[1][k] + 0.1;
    W.mask.quad([A[0], yA, A[1]], [D[0], yD, D[1]], [C[0], yC, C[1]], [B[0], yB, B[1]], [0, 1, 0], [0, 0], [1, 0], [1, 1], [0, 1], WHITE);
  }
  // 両端: 下流は石の壁、上流（運河の側）は錆色の扉（上の 0.5 m は石）
  for (const [t, sg, gate] of [[u0, 1, false], [u1, -1, true]]) {
    const yt = Math.min(topAt(0, t), topAt(1, t));
    const p0 = P(t, -hw), p1 = P(t, hw), n = [u[0] * sg, 0, u[1] * sg];
    if (gate) {
      const c = P(t, 0);
      box(w, [c[0], (yBot + yt - 0.5) / 2, c[1]], [v[0] * hw, 0, v[1] * hw], [0, (yt - 0.5 - yBot) / 2, 0], [u[0] * 0.15, 0, u[1] * 0.15], GATE);
      // 扉の縦の補強（1.1 m ごと）
      for (let k = -2; k <= 2; k++) {
        const q = P(t - sg * 0.18, k * 1.1);
        box(w, [q[0], (yBot + yt - 0.5) / 2, q[1]], [v[0] * 0.06, 0, v[1] * 0.06], [0, (yt - 0.5 - yBot) / 2, 0], [u[0] * 0.04, 0, u[1] * 0.04], col('#6e5048'));
      }
      ashlar(sg > 0 ? p1 : p0, sg > 0 ? p0 : p1, yt - 0.5, yt, n, 991);
    } else ashlar(sg > 0 ? p1 : p0, sg > 0 ? p0 : p1, yBot, yt, n, 977);
    const q = P(t - sg * 0.45, 0);
    box(w, [q[0], yt - 0.45, q[1]], [v[0] * (hw + 0.9), 0, v[1] * (hw + 0.9)], [0, 0.55, 0], [u[0] * 0.45, 0, u[1] * 0.45], COPING);
  }
  // 鋼の柵（高さ 1.1 m。2 m ごとの柱、上下の横桟、X の筋交いと交点の丸い飾り）
  const rail = (p0, p1, y0f, y1f) => {
    const Lr = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]), d = [(p1[0] - p0[0]) / Lr, (p1[1] - p0[1]) / Lr], nn = [-d[1] * 0.025, 0, d[0] * 0.025];
    const n = Math.max(1, Math.round(Lr / 2));
    for (let k = 0; k <= n; k++) {
      const f = k / n, q = [p0[0] + (p1[0] - p0[0]) * f, p0[1] + (p1[1] - p0[1]) * f], y = y0f + (y1f - y0f) * f;
      box(mt, [q[0], y + 0.55, q[1]], [0.035, 0, 0], [0, 0.55, 0], [0, 0, 0.035], IRON);
    }
    for (const h of [0.08, 1.08]) {
      box(mt, [(p0[0] + p1[0]) / 2, (y0f + y1f) / 2 + h, (p0[1] + p1[1]) / 2], [(p1[0] - p0[0]) / 2, (y1f - y0f) / 2, (p1[1] - p0[1]) / 2], [0, 0.025, 0], nn, IRON);
    }
    for (let k = 0; k < n; k++) {
      const f0 = k / n, f1 = (k + 1) / n;
      const A = [p0[0] + (p1[0] - p0[0]) * f0, y0f + (y1f - y0f) * f0, p0[1] + (p1[1] - p0[1]) * f0];
      const B = [p0[0] + (p1[0] - p0[0]) * f1, y0f + (y1f - y0f) * f1, p0[1] + (p1[1] - p0[1]) * f1];
      for (const [ya, yb] of [[0.1, 1.06], [1.06, 0.1]]) {
        const c = [(A[0] + B[0]) / 2, (A[1] + B[1] + ya + yb) / 2, (A[2] + B[2]) / 2];
        box(mt, c, [(B[0] - A[0]) / 2, (B[1] + yb - A[1] - ya) / 2, (B[2] - A[2]) / 2], [0, 0.018, 0], nn, IRON);
      }
      const c = [(A[0] + B[0]) / 2, (A[1] + B[1]) / 2 + 0.58, (A[2] + B[2]) / 2];
      box(mt, c, [d[0] * 0.07, 0, d[1] * 0.07], [0, 0.07, 0], [nn[0] * 1.6, 0, nn[2] * 1.6], IRON);
    }
    colliders.push([p0[0], p0[1], p1[0], p1[1]]);
  };
  for (const [si, sd] of [[0, -1], [1, 1]]) {
    for (let k = 0; k + 1 < us.length; k++) rail(P(us[k], sd * (hw + 0.3)), P(us[k + 1], sd * (hw + 0.3)), top[si][k] + 0.1, top[si][k + 1] + 0.1);
  }
  rail(P(u0 - 0.3, -(hw + 0.3)), P(u0 - 0.3, hw + 0.3), topAt(0, u0) + 0.1, topAt(1, u0) + 0.1);
  // 上流の扉の上の歩道橋（幅 2 m、格子の床、両側に柵）
  const yd = Math.max(topAt(0, u1), topAt(1, u1)) + 0.15;
  const c = P(u1 - 1, 0);
  box(mt, [c[0], yd, c[1]], [u[0] * 1, 0, u[1] * 1], [0, 0.08, 0], [v[0] * (hw + 0.9), 0, v[1] * (hw + 0.9)], GRATE);
  for (const sd of [-1, 1]) {
    const q = P(u1 - 1 - sd * 0.97, 0), e = [v[0] * (hw + 0.9), v[1] * (hw + 0.9)];
    rail([q[0] - e[0], q[1] - e[1]], [q[0] + e[0], q[1] + e[1]], yd, yd);
  }
}

// ---- 入市税の門の小屋: 淡い石の平屋（台座・角の付け柱・軒の蛇腹）、正面（f の向き）に三角の破風と頂の壺の飾り、
// 戸口と、横の壁のめくら窓
function writePavilion(m, W, groundAt, colliders) {
  const w = W.main;
  const { x, z, f, h: H } = m, [wd, dp] = m.size, a = wd / 2, b = dp / 2;
  const s = [-f[1], f[0]];
  const P2 = (u, v) => [x + f[0] * u + s[0] * v, z + f[1] * u + s[1] * v];
  let y0 = Infinity;
  for (const [u, v] of [[-b, -a], [b, -a], [b, a], [-b, a]]) y0 = Math.min(y0, groundAt(...P2(u, v)));
  const STONE = col('#dec6a0'), SHADE = col('#ccb48f'), DARK = col('#3e3a36'), CORN = col('#e6d2b0');
  const B = (u, v, y, hu, hv, hy, c) => {
    const p = P2(u, v);
    box(w, [p[0], y, p[1]], [f[0] * hu, 0, f[1] * hu], [0, hy, 0], [s[0] * hv, 0, s[1] * hv], c);
  };
  B(0, 0, y0 + 0.1, b + 0.15, a + 0.15, 0.45, SHADE); // 台座
  B(0, 0, y0 + H / 2, b, a, H / 2, STONE); // 壁
  for (const su of [-1, 1]) for (const sv of [-1, 1]) B(su * (b - 0.2), sv * (a - 0.2), y0 + H / 2, 0.28, 0.28, H / 2, CORN); // 角の付け柱
  B(0, 0, y0 + H + 0.18, b + 0.3, a + 0.3, 0.18, CORN); // 軒の蛇腹
  B(0, 0, y0 + H + 0.5, b, a, 0.14, SHADE); // 屋上の縁
  // 正面の三角の破風（奥行き 0.5 m の三角柱）と頂の壺
  const ph = 1.25, y1 = y0 + H + 0.36;
  for (const du of [b + 0.3, b - 0.2]) {
    const o = P2(du, 0);
    vpoly(w, o, s, [[-(a + 0.3), y1], [a + 0.3, y1], [0, y1 + ph]], [f[0] * Math.sign(du - b + 0.05), 0, f[1] * Math.sign(du - b + 0.05)], CORN);
  }
  const sl = Math.hypot(a + 0.3, ph);
  for (const sv of [-1, 1]) {
    const e0 = P2(b + 0.3, sv * (a + 0.3)), e1 = P2(b - 0.2, sv * (a + 0.3)), t0 = P2(b + 0.3, 0), t1 = P2(b - 0.2, 0);
    const n = [s[0] * sv * (ph / sl), (a + 0.3) / sl, s[1] * sv * (ph / sl)];
    w.quad([e0[0], y1, e0[1]], [e1[0], y1, e1[1]], [t1[0], y1 + ph, t1[1]], [t0[0], y1 + ph, t0[1]], n, PLAIN_UV, PLAIN_UV, PLAIN_UV, PLAIN_UV, SHADE);
  }
  const u0 = P2(b + 0.05, 0);
  cylinder(w, u0[0], u0[1], 0.14, 0.2, y1 + ph, y1 + ph + 0.25, { seg: 10, color: CORN });
  cylinder(w, u0[0], u0[1], 0.26, 0.14, y1 + ph + 0.25, y1 + ph + 0.7, { seg: 10, color: CORN });
  annulus(w, u0[0], u0[1], 0, 0.14, y1 + ph + 0.7, 10, CORN);
  // 戸口（正面）とめくら窓（横）
  B(b + 0.02, 0, y0 + 0.55 + 1.25, 0.04, 0.65, 1.25, DARK);
  for (const sv of [-1, 1]) B(0, sv * (a + 0.02), y0 + 2.2, 0.6, 0.04, 1.0, SHADE);
  const C = [[-b, -a], [b, -a], [b, a], [-b, a]].map(([u, v]) => P2(u, v));
  for (let i = 0; i < 4; i++) colliders.push([...C[i], ...C[(i + 1) % 4]]);
}

// ---- 騎馬像: 花崗岩の段と台座、ブロンズの馬（歩く姿）と旗を掲げた騎士
function writeEquestrian(m, W, groundAt, colliders, onRoad, keepOut) {
  const { x, z } = m;
  const y0 = groundAt(x, z);
  const w = W.main, mt = W.metal;
  const GRANITE = col('#8c8a85'), GRANITE_D = col('#7a7873'), BRONZE = col('#3d3a36');
  const c = Math.cos(m.angle), s = Math.sin(m.angle);
  const F = (h) => [c * h, 0, s * h], S = (h) => [-s * h, 0, c * h], Y = (h) => [0, h, 0];
  const at = (f, sd, y) => [x + c * f - s * sd, y, z + s * f + c * sd];
  box(w, [x, y0 + 0.15, z], F(2.2), Y(0.3), S(2.2), GRANITE_D);
  box(w, [x, y0 + 0.5, z], F(1.8), Y(0.25), S(1.8), GRANITE);
  cylinder(w, x, z, 1.75, 1.45, y0 + 0.75, y0 + 1.4, { seg: 4, color: GRANITE }); // 下の台（四角錐台）
  box(w, [x, y0 + 3.0, z], F(1.25), Y(1.6), S(1.0), GRANITE);
  box(w, [x, y0 + 4.75, z], F(1.45), Y(0.15), S(1.2), GRANITE_D); // 軒
  box(w, [x, y0 + 5.0, z], F(1.35), Y(0.1), S(1.1), GRANITE);
  const yb = y0 + 5.1;
  // 馬: 胴・首・頭・4 本の脚・尾
  blob(mt, at(0, 0, yb + 1.45), [1.15, 0.5, 0.42], -m.angle, 10, 6, () => BRONZE);
  blob(mt, at(1.05, 0, yb + 2.05), [0.45, 0.62, 0.26], -m.angle, 8, 5, () => BRONZE);
  blob(mt, at(1.45, 0, yb + 2.45), [0.42, 0.2, 0.17], -m.angle, 8, 5, () => BRONZE);
  for (const [f, sd, lift] of [[0.8, 0.22, 0.25], [0.75, -0.22, 0], [-0.8, 0.22, 0], [-0.75, -0.22, 0]]) {
    const p = at(f, sd, 0);
    cylinder(mt, p[0], p[2], 0.1, 0.07, yb + lift, yb + 1.25, { seg: 5, color: BRONZE });
  }
  blob(mt, at(-1.25, 0, yb + 1.1), [0.12, 0.5, 0.12], -m.angle, 5, 4, () => BRONZE);
  // 騎士: 脚・胴・頭、右手に高く掲げた旗竿と旗
  blob(mt, at(-0.05, 0, yb + 2.35), [0.28, 0.5, 0.3], -m.angle, 8, 5, () => BRONZE);
  blob(mt, at(0, 0, yb + 3.0), [0.14, 0.17, 0.14], 0, 6, 4, () => BRONZE);
  for (const sd of [-0.32, 0.32]) blob(mt, at(0.1, sd, yb + 1.85), [0.32, 0.12, 0.1], -m.angle, 6, 4, () => BRONZE);
  const p0 = at(0.2, 0.3, yb + 1.9), p1 = at(0.55, 0.45, yb + 4.6);
  box(mt, [(p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2, (p0[2] + p1[2]) / 2], [(p1[0] - p0[0]) / 2, (p1[1] - p0[1]) / 2, (p1[2] - p0[2]) / 2], [0.03, 0, 0], [0, 0, 0.03], BRONZE); // 旗竿
  vpoly(mt, [p1[0], p1[2]], [-c, -s], [[0, p1[1] - 1.1], [0.95, p1[1] - 0.95], [0.85, p1[1] - 0.15], [0, p1[1] - 0.05]], [-s, 0, c], BRONZE);
  vpoly(mt, [p1[0], p1[2]], [-c, -s], [[0, p1[1] - 1.1], [0.95, p1[1] - 0.95], [0.85, p1[1] - 0.15], [0, p1[1] - 0.05]], [s, 0, -c], BRONZE);
  colliders.push([x, z, 2.3]);
  keepOut.push([x, z, 3]);
}

// ---- 壁泉: 淡い石の付け柱と軒、半円のニッチ、白い大理石の像、貝の形の小さな水盤と丸い縁の大きな水盤
function writeWallFountain(m, W, groundAt, colliders) {
  const { mid, n, t } = m;
  const w = W.main;
  const STONE = col('#d6d2d4'), SHADE = col('#b9b5b8'), MARBLE = col('#eceae6'), WATER = col('#53645d'), DARK = col('#6e6b6d');
  const at = (u, o) => [mid[0] + t[0] * u + n[0] * o, mid[1] + t[1] * u + n[1] * o];
  const y0 = groundAt(...at(0, 2));
  const N = [n[0], 0, n[1]];
  const T = (h) => [t[0] * h, 0, t[1] * h], O = (h) => [n[0] * h, 0, n[1] * h], Y = (h) => [0, h, 0];
  // 背の壁面・付け柱・軒
  vpoly(w, at(0, 0.05), t, [[-3, y0], [3, y0], [3, y0 + 6.2], [-3, y0 + 6.2]], N, SHADE);
  for (const u of [-2.6, 2.6]) {
    const c = at(u, 0.35);
    for (let k = 0; k < 9; k++) box(w, [c[0], y0 + 0.35 + k * 0.62, c[1]], T(0.42), Y(k % 2 ? 0.28 : 0.3), O(0.32), STONE);
  }
  const ce = at(0, 0.4);
  box(w, [ce[0], y0 + 6.0, ce[1]], T(3.2), Y(0.35), O(0.45), STONE);
  box(w, [ce[0], y0 + 6.5, ce[1]], T(3.4), Y(0.15), O(0.55), STONE);
  // 半円のニッチ（奥の暗い面と迫石の縁）
  vpoly(w, at(0, 0.08), t, archShape(3.6, 5.2, y0 + 0.6, 12), N, DARK);
  vpoly(w, at(0, 0.06), t, archShape(4.2, 5.5, y0 + 0.5, 12), N, STONE);
  // 大理石の像（立つ女性・ひざまずく女性・岩）
  blob(w, [ce[0] + n[0] * -0.05, y0 + 1.4, ce[1] + n[1] * -0.05], [1.3, 0.8, 0.45], 0, 8, 5, () => MARBLE);
  const fs = at(0.2, 0.55);
  blob(w, [fs[0], y0 + 2.9, fs[1]], [0.28, 0.85, 0.22], 0, 8, 5, () => MARBLE);
  blob(w, [fs[0], y0 + 4.0, fs[1]], [0.13, 0.16, 0.13], 0, 6, 4, () => MARBLE);
  const k2 = at(-0.9, 0.6);
  blob(w, [k2[0], y0 + 1.85, k2[1]], [0.3, 0.45, 0.25], 0, 8, 5, () => MARBLE);
  // 水盤: 貝の形の小さな水盤と、張り出した大きな水盤（丸い縁）
  const sb = at(0, 0.9);
  cylinder(w, sb[0], sb[1], 0.4, 1.2, y0 + 1.0, y0 + 1.3, { seg: 12, color: STONE });
  annulus(w, sb[0], sb[1], 0, 1.1, y0 + 1.28, 12, WATER);
  const lb = at(0, 1.6);
  cylinder(w, lb[0], lb[1], 2.4, 2.4, y0, y0 + 0.6, { seg: 20, color: STONE });
  annulus(w, lb[0], lb[1], 2.05, 2.4, y0 + 0.6, 20, MARBLE);
  annulus(w, lb[0], lb[1], 0, 2.05, y0 + 0.45, 20, WATER);
  colliders.push([lb[0], lb[1], 2.4]);
}

// ---- 歩行者の島: 東の端（a）が丸く、西の端（b）が四角い、高さ 0.2 m の石の板の島と縁石、鉄の格子 2 枚
function writeIsland(m, W, groundAt) {
  const { a, b, half } = m;
  const L = Math.hypot(b[0] - a[0], b[1] - a[1]), u = [(b[0] - a[0]) / L, (b[1] - a[1]) / L], v = [-u[1], u[0]];
  const ring = [];
  for (let k = 0; k <= 12; k++) {
    const t = Math.PI / 2 + (k / 12) * Math.PI; // a の側の半円
    ring.push([a[0] + (u[0] * Math.cos(t) + v[0] * Math.sin(t)) * half, a[1] + (u[1] * Math.cos(t) + v[1] * Math.sin(t)) * half]);
  }
  ring.push([b[0] - v[0] * half, b[1] - v[1] * half], [b[0] + v[0] * half, b[1] + v[1] * half]);
  const y0 = groundAt((a[0] + b[0]) / 2, (a[1] + b[1]) / 2), yt = y0 + 0.2;
  const w = W.main, KERB = col('#ccb696'), TOP = col('#c5b9a6'), GRATE = col('#6f6e64');
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i], q = ring[(i + 1) % ring.length], dx = q[0] - p[0], dz = q[1] - p[1], l = Math.hypot(dx, dz) || 1;
    const sg = signedArea(ring) > 0 ? 1 : -1;
    w.quad([p[0], y0 - 0.2, p[1]], [q[0], y0 - 0.2, q[1]], [q[0], yt, q[1]], [p[0], yt, p[1]], [(dz / l) * sg, 0, (-dx / l) * sg], PLAIN_UV, PLAIN_UV, PLAIN_UV, PLAIN_UV, KERB);
  }
  const tr = triangulate(ring);
  for (let i = 0; i < tr.indices.length; i += 3) {
    const [A, B, C] = [0, 1, 2].map((k) => tr.points[tr.indices[i + k]]).map((p) => [p[0], yt, p[1]]);
    w.tri(A, B, C, [0, 1, 0], PLAIN_UV, PLAIN_UV, PLAIN_UV, TOP);
  }
  for (const f of [0.35, 0.65]) {
    const c = [a[0] + u[0] * L * f, a[1] + u[1] * L * f];
    box(w, [c[0], yt + 0.005, c[1]], [u[0] * 2, 0, u[1] * 2], [0, 0.005, 0], [v[0] * 1, 0, v[1] * 1], GRATE);
  }
}

// ---- ロータリーの島: 白いコンクリートの縁石、ばら色のレンガの低い擁壁、盛り土の植え込み（低木・小さな木）、鋼の門の彫刻
function writeRoundabout(m, W, groundAt, colliders, onRoad, keepOut) {
  const { x, z, radius: R } = m;
  const y0 = groundAt(x, z);
  const w = W.main, mt = W.metal;
  const KERB = col('#d8d6d0'), SOIL = col('#4a3c2c'), SHRUB = [col('#333a1b'), col('#3d4622'), col('#2c3418')], STEEL = col('#737d83');
  cylinder(w, x, z, R + 0.35, R + 0.35, y0 - 0.2, y0 + 0.15, { seg: 40, color: KERB });
  annulus(w, x, z, R, R + 0.35, y0 + 0.15, 40, KERB);
  cylinder(w, x, z, R, R, y0 + 0.15, y0 + 0.75, { seg: 40, cell: CELL.brick, cw: BRICK_CW, ch: BRICK_CW, color: col('#d6a088') });
  annulus(w, x, z, R - 0.25, R, y0 + 0.75, 40, col('#b98a72'));
  annulus(w, x, z, 0, R - 0.25, y0 + 0.65, 40, SOIL);
  // 低木の塊（縁に沿って 2 重の輪）と小さな木 3 本
  const rnd = mulberry32(4711);
  for (const [rr, n] of [[R - 1.2, 18], [R - 3.4, 11]]) {
    for (let k = 0; k < n; k++) {
      const a = ((k + rnd() * 0.5) / n) * Math.PI * 2, r = rr + (rnd() - 0.5) * 0.8;
      const sz = 0.8 + rnd() * 0.5;
      blob(w, [x + Math.cos(a) * r, y0 + 0.65 + sz * 0.7, z + Math.sin(a) * r], [sz * 1.2, sz * 0.9, sz * 1.1], rnd() * 6, 8, 5, () => SHRUB[Math.floor(rnd() * 3)]);
    }
  }
  for (let k = 0; k < 3; k++) {
    const a = (k / 3) * Math.PI * 2 + 0.6, r = R * 0.5;
    const tx = x + Math.cos(a) * r, tz = z + Math.sin(a) * r;
    cylinder(w, tx, tz, 0.13, 0.1, y0 + 0.65, y0 + 3.4, { seg: 6, color: col('#5a4e44') });
    blob(w, [tx, y0 + 5.0, tz], [2.0, 2.0, 2.0], rnd() * 6, 10, 6, () => col(['#4d5f2c', '#566a31', '#465a28'][Math.floor(rnd() * 3)]));
  }
  // 鋼の門の形の彫刻（2 本の柱と梁、断面 0.4 m 角）。向きは島の南北
  const hw = 3.5, H = 6;
  for (const sg of [-1, 1]) box(mt, [x + sg * hw, y0 + 0.65 + H / 2, z], [0.2, 0, 0], [0, H / 2, 0], [0, 0, 0.2], STEEL);
  box(mt, [x, y0 + 0.65 + H - 0.2, z], [hw + 0.2, 0, 0], [0, 0.2, 0], [0, 0, 0.2], STEEL);
  colliders.push([x, z, R + 0.35]);
  keepOut.push([x, z, R + 0.6]);
}

// ---- 台座の上の立像（リケの像）: 花崗岩の島、2 段の台、モールディングの付いた台座、白い大理石のマントの立像
function writeStatue(m, W, groundAt, colliders, onRoad, keepOut) {
  const { x, z } = m;
  const y0 = groundAt(x, z);
  const w = W.main;
  const GRANITE = col('#acacac'), LIME = col('#d3cbbd'), LIME_D = col('#bdb4a5'), MARBLE = col('#e2ded6');
  const c = Math.cos(m.angle), s = Math.sin(m.angle);
  const ex = (h) => [c * h, 0, s * h], ez = (h) => [-s * h, 0, c * h], ey = (h) => [0, h, 0];
  // 花崗岩の島（低い円）
  cylinder(w, x, z, 6, 6, y0 - 0.3, y0 + 0.12, { seg: 28, color: GRANITE });
  annulus(w, x, z, 0, 6, y0 + 0.12, 28, GRANITE);
  // 2 段の台と台座
  const step = (half, y1, y2, color) => box(w, [x, (y1 + y2) / 2, z], ex(half), ey((y2 - y1) / 2), ez(half), color);
  step(2.1, y0 + 0.12, y0 + 0.5, LIME_D);
  step(1.8, y0 + 0.5, y0 + 0.9, LIME_D);
  step(1.55, y0 + 0.9, y0 + 1.5, LIME);
  step(1.35, y0 + 1.5, y0 + 4.6, LIME);
  step(1.55, y0 + 4.6, y0 + 5.0, LIME); // 軒のモールディング
  step(1.3, y0 + 5.0, y0 + 5.4, LIME_D);
  // 正面の銘板（暗い石）
  box(w, [x + c * 1.37, y0 + 3.0, z + s * 1.37], ex(0.03), ey(0.8), ez(0.9), col('#8d857a'));
  // 立像: 足元の台、マントの体（だ円体を 2 つ）、頭、前に出した腕
  const yb = y0 + 5.4;
  box(w, [x, yb + 0.15, z], ex(0.7), ey(0.15), ez(0.7), MARBLE);
  blob(w, [x, yb + 1.25, z], [0.55, 1.15, 0.5], -m.angle, 10, 6, () => MARBLE);
  blob(w, [x, yb + 2.35, z], [0.5, 0.55, 0.42], -m.angle, 10, 6, () => MARBLE);
  blob(w, [x, yb + 3.15, z], [0.2, 0.25, 0.2], 0, 8, 5, () => MARBLE);
  blob(w, [x + c * 0.45 + -s * 0.3, yb + 2.45, z + s * 0.45 + c * 0.3], [0.45, 0.13, 0.13], -m.angle, 8, 4, () => MARBLE);
  colliders.push([x, z, 2.3]);
  keepOut.push([x, z, 6]);
}

const WRITERS = { pavilion: writePavilion, lock: writeLock, equestrian: writeEquestrian, wallFountain: writeWallFountain, capitainerie: writeCapitainerie, moorings: writeMoorings, riverfront: writeRiverfront, arcades: writeArcades, choir: writeChoir, ramblas: writeRamblas, basilica: writeBasilica, island: writeIsland, roundabout: writeRoundabout, portico: writePortico, donjon: writeDonjon, statue: writeStatue, dome: writeDome, chateau: writeChateau, stadium: writeStadium, cabanis: writeCabanis, coq: writeCoq, cross: writeCross, fastfood: writeFastfood, jgarden: writeJgarden, parterre: writeParterre };

// 名所のモデルを作る。colliders: 足す当たり判定の円 [x, z, r] か線分 [ax, az, bx, bz]、
// keepOut: 街の小物を置かない円 [x, z, r]（像の台・シャトー・ドーの柵の内側。monumentSolid）
const MASK_MATS = {
  mask: new THREE.MeshBasicMaterial({
    colorWrite: false, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -4,
    stencilWrite: true, stencilRef: 1, stencilFunc: THREE.AlwaysStencilFunc, stencilZPass: THREE.ReplaceStencilOp,
  }),
  reset: new THREE.ShaderMaterial({
    vertexShader: 'void main() { gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: 'void main() { gl_FragDepth = 1.0; }',
    colorWrite: false, depthWrite: true, depthFunc: THREE.AlwaysDepth,
    stencilWrite: true, stencilRef: 1, stencilFunc: THREE.EqualStencilFunc, stencilFail: THREE.KeepStencilOp, stencilZFail: THREE.KeepStencilOp, stencilZPass: THREE.KeepStencilOp,
  }),
};

export function buildMonuments(list, materials, { groundAt = () => 0, onRoad = () => false, waterAt = (x, z) => groundAt(x, z) - 2 } = {}) {
  const group = new THREE.Group();
  group.name = 'monuments';
  const W = { main: new MeshWriter(), metal: new MeshWriter(), inlay: new MeshWriter(), mask: new MeshWriter() };
  const colliders = [], keepOut = [];
  for (const m of list) WRITERS[m.kind](m, W, groundAt, colliders, onRoad, keepOut, waterAt);
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
  if (!W.mask.empty) {
    // 地面の切り抜き（閘室）: 地面のあとに深度テスト付きでステンシルに印を付け、その所の深度を一番奥に戻す（metro.js と同じ）
    const geo = W.mask.toGeometry();
    for (const [mat, order, name] of [[MASK_MATS.mask, TERRAIN_ORDER.mask, 'monument-mask'], [MASK_MATS.reset, TERRAIN_ORDER.maskReset, 'monument-mask-reset']]) {
      const mesh = new THREE.Mesh(geo, mat);
      mesh.renderOrder = order;
      mesh.name = name;
      mesh.matrixAutoUpdate = false;
      group.add(mesh);
    }
  }
  return { group, colliders, keepOut };
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
