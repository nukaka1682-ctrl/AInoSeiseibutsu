// 広場の真ん中の庭: Place Wilson の Jardin Pierre-Goudouli（航空写真 2024（IGN）、利用者のストリートビュー 212146、
// Wikimedia Commons「Alexandre Falguière - Pèire Godolin -Toulouse」「Jardin Pierre Goudouli, Place Wilson」「Dans le centre
// de la Place Wilson」から）。地図（IGN）には庭の外形がなく、まわりの環状の車道の内側が一面の石畳になっていた。
// - 庭: 環状の車道の内側の縁石まで（gardenOutline。車道がなければ中心 c・半径 r の円）。縁石の外に車止めの列。地面は芝と木の下（data/cover.js の stampCover）、
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
    ring: /^Place (du Président Thomas (Woodrow )?)?Wilson$/i, // まわりの環状の車道の名前（庭の縁は gardenOutline）
  },
];
const KERB_GAP = 0.4; // 環状の車道の縁から庭の縁石まで（m）

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

// 庭の縁（環状の車道の内側の縁石）: 中心から N 本の放射線で、まわりの環状の車道（spec.ring の名前）の芯線までの距離を測り、
// 道幅の半分と KERB_GAP を引く。Place Wilson は楕円に近く、地図の芯線は中心から 35〜44 m（決まった半径の円では、北西で
// 縁石と車止めが車道の上に立ち、自転車が止まった）。車道に当たらない向き（交差点のすき間）は両隣から補う。環状の車道が
// なければ（地図にない・単体テスト）半径 r の円。roads ごとに 1 回。R: 向き k（角度 2πk/N）の半径、rAt(角度)、ring: 外形
const outlineCache = new WeakMap();
export function gardenOutline(sq, roads = []) {
  let per = outlineCache.get(roads);
  if (!per) outlineCache.set(roads, (per = new Map()));
  if (per.has(sq.id)) return per.get(sq.id);
  const N = 96, R = new Float64Array(N);
  const segs = [];
  for (const rd of roads) {
    if (!sq.spec.ring || !sq.spec.ring.test(rd.name || '') || rd.bridge || rd.tunnel || rd.pts.length < 2) continue;
    for (let i = 0; i + 1 < rd.pts.length; i++) segs.push([...rd.pts[i], ...rd.pts[i + 1], (rd.width || 5) / 2]);
  }
  for (let k = 0; k < N; k++) {
    const a = (k / N) * Math.PI * 2, dx = Math.cos(a), dz = Math.sin(a);
    let best = NaN;
    for (const [ax, az, bx, bz, h] of segs) {
      const ex = bx - ax, ez = bz - az, den = dx * ez - dz * ex;
      if (Math.abs(den) < 1e-9) continue;
      const t = ((ax - sq.cx) * ez - (az - sq.cz) * ex) / den, u = ((ax - sq.cx) * dz - (az - sq.cz) * dx) / den;
      if (u < 0 || u > 1 || t < sq.r * 0.6 || t > sq.r * 1.4) continue;
      const v = t - h - KERB_GAP;
      if (!(v >= best)) best = v;
    }
    R[k] = best;
  }
  const ok = [...R.keys()].filter((k) => R[k] > 0);
  if (!ok.length) R.fill(sq.r);
  else {
    for (let k = 0; k < N; k++) {
      if (R[k] > 0) continue;
      // 前と後ろのいちばん近い値の、角度の線形補間
      let p = 1, q = 1;
      while (!(R[(k - p + N) % N] > 0)) p++;
      while (!(R[(k + q) % N] > 0)) q++;
      R[k] = R[(k - p + N) % N] + ((R[(k + q) % N] - R[(k - p + N) % N]) * p) / (p + q);
    }
  }
  const rAt = (a) => {
    const f = ((((a / (Math.PI * 2)) * N) % N) + N) % N, i = Math.floor(f), t = f - i;
    return R[i % N] * (1 - t) + R[(i + 1) % N] * t;
  };
  const ring = Array.from({ length: N }, (_, k) => {
    const a = (k / N) * Math.PI * 2;
    return [sq.cx + Math.cos(a) * R[k], sq.cz + Math.sin(a) * R[k]];
  });
  const out = { N, R, rAt, ring };
  per.set(sq.id, out);
  return out;
}

// 庭の中か（縁石の内側。pad: 内側へ狭める m。roads: 環状の車道のある地図の道。なければ円）
export function inSquareGarden(sq, x, z, pad = 0, roads = []) {
  const o = gardenOutline(sq, roads);
  return Math.hypot(x - sq.cx, z - sq.cz) < o.rAt(Math.atan2(z - sq.cz, x - sq.cx)) - pad;
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

// 庭の入口: 地図の小道（gardenPaths で砂にしたもの）が庭の縁（gardenOutline）を横切る所の角度（中心から見た向き、ラジアン）
export function gardenGates(sq, roads) {
  const o = gardenOutline(sq, roads), out = [];
  const f = (x, z) => Math.hypot(x - sq.cx, z - sq.cz) - o.rAt(Math.atan2(z - sq.cz, x - sq.cx));
  for (const r of roads) {
    if (r.garden !== sq.id) continue;
    for (let i = 0; i + 1 < r.pts.length; i++) {
      const [ax, az] = r.pts[i], [bx, bz] = r.pts[i + 1];
      const da = f(ax, az), db = f(bx, bz);
      if (da * db > 0 || da === db) continue;
      const t = da / (da - db), x = ax + (bx - ax) * t, z = az + (bz - az) * t;
      const a = Math.atan2(z - sq.cz, x - sq.cx);
      if (!out.some((q) => Math.abs(Math.atan2(Math.sin(q - a), Math.cos(q - a))) < 0.1)) out.push(a);
    }
  }
  return out;
}

// 庭の園路の線分 [ax, az, bx, bz, 半分の幅]（ベンチ・街灯を園路の上に置かない）
export function gardenPathSegments(sq, roads) {
  const out = [];
  for (const r of roads) if (r.garden === sq.id) for (let i = 0; i + 1 < r.pts.length; i++) out.push([...r.pts[i], ...r.pts[i + 1], r.width / 2]);
  return out;
}

// 庭の砂の広場（噴水と回転木馬のまわり）の外形（円の和を多角形の並びで。ground.js が 1 つずつ描く）
export function gardenPlazaRings(sq, n = 28) {
  return sq.plazas.map(([x, z, r]) => Array.from({ length: n }, (_, i) => [x + Math.cos((i / n) * Math.PI * 2) * r, z + Math.sin((i / n) * Math.PI * 2) * r]));
}
