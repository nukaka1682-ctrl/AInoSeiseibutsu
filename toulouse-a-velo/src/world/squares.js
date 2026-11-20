// 広場の真ん中の庭: Place Wilson の Jardin Pierre-Goudouli（航空写真 2024（IGN）、利用者のストリートビュー 212146、
// Wikimedia Commons「Alexandre Falguière - Pèire Godolin -Toulouse」「Jardin Pierre Goudouli, Place Wilson」「Dans le centre
// de la Place Wilson」から）。地図（IGN）には庭の外形がなく、まわりの環状の車道の内側が一面の石畳になっていた。
// - 庭: 中心 c・半径 r の円（環状の車道の内側の縁石。外に車止めの列）。地面は芝と木の下（data/cover.js の stampCover）、
//   園路（地図の小道）は淡いベージュの固めた砂（幅 3.5 m）、噴水と回転木馬のまわりは砂の広場（plazas）
// - 噴水（グドゥリの記念碑の噴水、1898〜1908 年、Falguière ほか）: 直径約 11 m の丸い水盤（低い石の縁）、真ん中に岩の台と
//   白い大理石の座った詩人・横たわる女性像、台の足元の輪と水盤の中の輪に細い噴き上げ（monuments.js の writeSquare）
// - 回転木馬（manège de chevaux de bois）: 直径約 10.5 m（航空写真の白い円い屋根）。地図では高さ 6 m の円い建物
// - 入口（gates）: 車道から庭へ入る所（縁石・生け垣の切れ目）。地図の小道が環状の車道に着く所の向き（中心から見た角度）
export const SQUARES = [
  {
    id: 'wilson',
    c: [43.604854, 1.44738], r: 37.4,
    fountain: [43.604854, 1.447375], basin: 5.5,
    carousel: [43.604917, 1.447622], carouselR: 5.3,
    plazas: [[43.604854, 1.447375, 10.5], [43.604917, 1.447622, 8.5], [43.604885, 1.447505, 7]],
    pathWidth: 3.5, // 砂の園路の幅（gardenPaths）
  },
];

// 緯度経度の仕様をローカル座標にする（proj ごとに 1 回）
const cache = new WeakMap();
export function squaresLocal(proj) {
  let out = cache.get(proj);
  if (out) return out;
  out = SQUARES.map((s) => {
    const P = (ll) => proj.project(ll[0], ll[1]);
    const [cx, cz] = P(s.c), [fx, fz] = P(s.fountain), [kx, kz] = P(s.carousel);
    return { spec: s, id: s.id, cx, cz, r: s.r, fx, fz, basin: s.basin, kx, kz, carouselR: s.carouselR, plazas: s.plazas.map((p) => [...P(p), p[2]]) };
  });
  cache.set(proj, out);
  return out;
}

// 庭の中か（縁石の内側。pad: 内側へ狭める m）
export function inSquareGarden(sq, x, z, pad = 0) {
  return Math.hypot(x - sq.cx, z - sq.cz) < sq.r - pad;
}

// 庭の中の小道（地図の footway・path。全部の点が庭の縁から 7 m 外まで: 小道の端は環状の車道の芯線に着く）を、
// 固めた砂の幅 3.5 m の園路にする（parse.js）。車道の上に出た端は車道の面の下になる（ground.js の ORDER）
export function gardenPaths(roads, proj) {
  const sqs = squaresLocal(proj);
  for (const r of roads) {
    if (r.type !== 'footway' && r.type !== 'path') continue;
    for (const sq of sqs) {
      if (!r.pts.every(([x, z]) => Math.hypot(x - sq.cx, z - sq.cz) < sq.r + 7)) continue;
      r.surface = 'fine_gravel';
      r.width = Math.max(r.width || 0, sq.spec.pathWidth);
      r.garden = sq.id;
    }
  }
}

// 庭の入口: 地図の小道（gardenPaths で砂にしたもの）が縁石の円を横切る所の角度（中心から見た向き、ラジアン）
export function gardenGates(sq, roads) {
  const out = [];
  for (const r of roads) {
    if (r.garden !== sq.id) continue;
    for (let i = 0; i + 1 < r.pts.length; i++) {
      const [ax, az] = r.pts[i], [bx, bz] = r.pts[i + 1];
      const da = Math.hypot(ax - sq.cx, az - sq.cz) - sq.r, db = Math.hypot(bx - sq.cx, bz - sq.cz) - sq.r;
      if (da * db > 0) continue;
      const t = da / (da - db), x = ax + (bx - ax) * t, z = az + (bz - az) * t;
      const a = Math.atan2(z - sq.cz, x - sq.cx);
      if (!out.some((q) => Math.abs(Math.atan2(Math.sin(q - a), Math.cos(q - a))) < 0.1)) out.push(a);
    }
  }
  return out;
}

// 庭の砂の広場（噴水と回転木馬のまわり）の外形（円の和を多角形の並びで。ground.js が 1 つずつ描く）
export function gardenPlazaRings(sq, n = 28) {
  return sq.plazas.map(([x, z, r]) => Array.from({ length: n }, (_, i) => [x + Math.cos((i / n) * Math.PI * 2) * r, z + Math.sin((i / n) * Math.PI * 2) * r]));
}
