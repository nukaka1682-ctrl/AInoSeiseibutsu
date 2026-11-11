// トゥールーズのメトロ（A 線・B 線）の路線と駅、線路の線形（three.js を使わない。単体テストできる）。
// - 駅の位置: IGN BD TOPO の equipement_de_transport（nature = 'Station de métro'、営業中。Licence Ouverte）。
//   同梱の <エリア>-metro.json の駅があればそちらを使う（同じ名前の駅が 2 つあれば平均）
// - 地下のトンネルの線形はオープンデータにないので、駅のホームを直線にして、駅と駅のあいだを 3 次のエルミート曲線でつなぐ
//   （ホームの向きは前後の駅を結ぶ向き。Jean Jaurès の B 線は A 線と直交させ、改札階を十字にする）
// - 右側通行: 終点（A 線は Balma-Gramont、B 線は Ramonville）へ向かう電車は、進む向きの右の線路
// 座標はゲームのローカル座標（x 東・z 南、m）。駅の局所座標は s（ホームの向き、終点へ向かう向きが +）と t（その右が +）

export const LINE_COLORS = { A: '#e2231a', B: '#f6b400' };

// [id, BD TOPO の名前, 案内の名前, 日本語, 緯度, 経度]
const STATIONS = [
  ['basso-cambo', 'Basso Cambo', 'Basso Cambo', 'バッソ・カンボ', 43.5699, 1.39228],
  ['bellefontaine', 'Bellefontaine', 'Bellefontaine', 'ベルフォンテーヌ', 43.56607, 1.39825],
  ['reynerie', 'Reynerie', 'Reynerie', 'レイネリー', 43.57078, 1.40227],
  ['mirail-universite', 'Mirail Université', 'Mirail-Université', 'ミライユ・ユニヴェルシテ', 43.57473, 1.40199],
  ['bagatelle', 'Bagatelle', 'Bagatelle', 'バガテル', 43.57991, 1.41239],
  ['mermoz', 'Mermoz', 'Mermoz', 'メルモーズ', 43.58336, 1.41501],
  ['fontaine-lestang', 'Fontaine-Lestang', 'Fontaine-Lestang', 'フォンテーヌ・レスタン', 43.58757, 1.41836],
  ['arenes', 'Arènes', 'Arènes', 'アレーヌ', 43.59286, 1.41812],
  ['patte-d-oie', "Patte-d'Oie", "Patte d'Oie", 'パット・ドワ', 43.59641, 1.42321],
  ['saint-cyprien', 'Saint-Cyprien République', 'Saint-Cyprien – République', 'サン・シプリアン＝レピュブリック', 43.59812, 1.43159],
  ['esquirol', 'Esquirol', 'Esquirol', 'エスキロール', 43.60045, 1.44417],
  ['capitole', 'Capitole', 'Capitole', 'キャピトル', 43.60462, 1.44521],
  ['jean-jaures', 'Jean Jaurès', 'Jean Jaurès', 'ジャン・ジョレス', 43.60555, 1.44843],
  ['marengo', 'Marengo', 'Marengo – SNCF', 'マレンゴ＝SNCF', 43.61081, 1.45502],
  ['jolimont', 'Jolimont', 'Jolimont', 'ジョリモン', 43.61556, 1.4638],
  ['roseraie', 'Roseraie', 'Roseraie', 'ロズレ', 43.61988, 1.46943],
  ['argoulets', 'Argoulets', 'Argoulets', 'アルグレ', 43.62485, 1.47767],
  ['balma-gramont', 'Balma-Gramont', 'Balma – Gramont', 'バルマ＝グラモン', 43.627, 1.4826],
  ['borderouge', 'Borderouge', 'Borderouge', 'ボルドルージュ', 43.64161, 1.45301],
  ['trois-cocus', 'Trois Cocus', 'Trois Cocus', 'トロワ・ココ', 43.63832, 1.44404],
  ['la-vache', 'la Vache', 'La Vache', 'ラ・ヴァッシュ', 43.63347, 1.43584],
  ['barriere-de-paris', 'Barrière de Paris', 'Barrière de Paris', 'バリエール・ド・パリ', 43.62667, 1.43364],
  ['minimes', 'Minimes Claude Nougaro', 'Minimes – Claude Nougaro', 'ミニム＝クロード・ヌガロ', 43.62032, 1.43598],
  ['canal-du-midi', 'Canal du Midi', 'Canal du Midi', 'カナル・デュ・ミディ', 43.61543, 1.4339],
  ['compans-caffarelli', 'Compans Caffarelli', 'Compans-Caffarelli', 'コンパン＝カファレリ', 43.61048, 1.43565],
  ['jeanne-d-arc', "Jeanne d'Arc", "Jeanne d'Arc", 'ジャンヌ・ダルク', 43.60881, 1.4456],
  ['francois-verdier', 'François Verdier', 'François Verdier', 'フランソワ・ヴェルディエ', 43.60057, 1.45199],
  ['carmes', 'Carmes', 'Carmes', 'カルム', 43.59767, 1.44549],
  ['palais-de-justice', 'Palais de Justice', 'Palais de Justice', 'パレ・ド・ジュスティス', 43.59206, 1.44444],
  ['saint-michel', 'Saint-Michel Marcel Langer', 'Saint-Michel – Marcel Langer', 'サン・ミシェル＝マルセル・ランジェ', 43.58611, 1.44729],
  ['empalot', 'Empalot', 'Empalot', 'アンパロ', 43.58003, 1.44216],
  ['saint-agne', 'Saint-Agne', 'Saint-Agne SNCF', 'サン・タニュ SNCF', 43.58037, 1.44954],
  ['saouzelong', 'Saouzelong', 'Saouzelong', 'ソーズロン', 43.5797, 1.45899],
  ['rangueil', 'Rangueil', 'Rangueil', 'ランゲイユ', 43.57486, 1.46187],
  ['faculte-de-pharmacie', 'Faculté de Pharmacie', 'Faculté de Pharmacie', 'ファキュルテ・ド・ファルマシー', 43.5679, 1.46444],
  ['universite-paul-sabatier', 'Université Paul Sabatier', 'Université Paul Sabatier', 'ユニヴェルシテ・ポール・サバティエ', 43.56131, 1.46304],
  ['ramonville', 'Ramonville', 'Ramonville', 'ラモンヴィル', 43.55581, 1.47677],
];

export const LINES = {
  A: ['basso-cambo', 'bellefontaine', 'reynerie', 'mirail-universite', 'bagatelle', 'mermoz', 'fontaine-lestang', 'arenes', 'patte-d-oie',
    'saint-cyprien', 'esquirol', 'capitole', 'jean-jaures', 'marengo', 'jolimont', 'roseraie', 'argoulets', 'balma-gramont'],
  B: ['borderouge', 'trois-cocus', 'la-vache', 'barriere-de-paris', 'minimes', 'canal-du-midi', 'compans-caffarelli', 'jeanne-d-arc', 'jean-jaures',
    'francois-verdier', 'carmes', 'palais-de-justice', 'saint-michel', 'empalot', 'saint-agne', 'saouzelong', 'rangueil', 'faculte-de-pharmacie',
    'universite-paul-sabatier', 'ramonville'],
};

// 駅の局所の寸法（m）
export const LAYOUT = {
  trackOff: 1.9, // 線路の中心（トンネルの軸からの横のずれ）
  psd: 3.15, // ホームドアの線（軸から）
  platformW: 5.0, // ホームの幅
  floorDrop: 1.0, // ホームの床から走行路の上面まで
  hallDrop: 5.5, // 改札階の床からホームの床まで（A 線と、B 線の 1 段目）
  carLen: 13.0, // VAL 208 の 1 両（m）
  carPitch: 13.15, // 連結した車両の中心の間隔
  carWidth: 2.08,
  doorX: [-4.1, 0, 4.1], // 1 両の扉の中心（車両の中心から）
  doorW: 1.3,
};
// 電車の両数（A 線は 2019 年から 2 編成をつないだ 52 m・4 両、B 線は 26 m・2 両）
export const TRAIN_CARS = { A: 4, B: 2 };

export const wallT = () => LAYOUT.psd + LAYOUT.platformW; // ホームの奥の壁（軸から）

// 駅の一覧（緯度経度は同梱の駅 bdStations があればそれで置き換える）
export function stationList(bdStations = null) {
  const pos = new Map();
  for (const s of bdStations || []) {
    const p = pos.get(s.name) || { lat: 0, lon: 0, n: 0 };
    p.lat += s.lat;
    p.lon += s.lon;
    p.n++;
    pos.set(s.name, p);
  }
  return STATIONS.map(([id, bd, name, ja, lat, lon]) => {
    const p = pos.get(bd);
    const lines = Object.keys(LINES).filter((l) => LINES[l].includes(id));
    return { id, bd, name, ja, lat: p ? p.lat / p.n : lat, lon: p ? p.lon / p.n : lon, lines };
  });
}

// ホームの長さ（局所の s の半分）。A 線は 52 m の電車、B 線は 26 m の電車（Jean Jaurès の B 線は改札階から深いので長い）
export function boxHalf(line, station) {
  if (line === 'B') return station.id === 'jean-jaures' ? 46 : 22;
  return 31.5;
}

const norm = (x, z) => {
  const l = Math.hypot(x, z) || 1;
  return [x / l, z / l];
};

// 路線網。proj: LocalProjection、levelOf(station) → { ym, yp: { A, B } }（改札階・ホームの床の高さ。地形と出入口から決める。
// 省略すると平らな地面の 6 m 下を改札階に）
export function buildNetwork(proj, { bdStations = null, levelOf = null } = {}) {
  const stations = stationList(bdStations);
  const byId = new Map(stations.map((s) => [s.id, s]));
  for (const s of stations) [s.x, s.z] = proj.project(s.lat, s.lon);
  // ホームの向き（前後の駅を結ぶ向き。終点へ向かう向き）
  for (const [line, ids] of Object.entries(LINES)) {
    ids.forEach((id, i) => {
      const s = byId.get(id), p = byId.get(ids[Math.max(0, i - 1)]), n = byId.get(ids[Math.min(ids.length - 1, i + 1)]);
      const [ax, az] = norm(n.x - p.x, n.z - p.z);
      s.axis = s.axis || {};
      s.axis[line] = [ax, az];
    });
  }
  // 2 つの線の駅（Jean Jaurès）: 2 本目の線のホームは 1 本目に直交させる（向きは元の向きに近い方）
  for (const s of stations) {
    if (s.lines.length < 2) continue;
    const [ax, az] = s.axis[s.lines[0]], [bx, bz] = s.axis[s.lines[1]];
    const r = [-az, ax], side = r[0] * bx + r[1] * bz >= 0 ? 1 : -1;
    s.axis[s.lines[1]] = [r[0] * side, r[1] * side];
  }
  const network = { stations, byId, lines: {} };
  relevelNetwork(network, levelOf);
  return network;
}

// 駅の高さを決め直して、線路の縦断面を作り直す（地形と出入口が分かってから。駅のオブジェクトはそのまま）
export function relevelNetwork(network, levelOf = null) {
  for (const s of network.stations) {
    const lv = levelOf ? levelOf(s) : null;
    s.ym = lv?.ym ?? -6;
    s.yp = {};
    s.lines.forEach((l, k) => {
      s.yp[l] = lv?.yp?.[l] ?? s.ym - LAYOUT.hallDrop - k * 7.5;
    });
  }
  for (const [line, ids] of Object.entries(LINES)) network.lines[line] = buildLinePath(line, ids.map((id) => network.byId.get(id)));
  return network;
}

// 線路の線形: 駅のホームは直線、駅のあいだは 3 次のエルミート曲線。2 m ごとの点 { S, x, z, y, hx, hz }
// y はホームの床の高さ（車両の床）。駅の中心の S を station.S[line] に入れる
export function buildLinePath(line, list) {
  const pts = [];
  const push = (x, z, y, hx, hz) => {
    const last = pts[pts.length - 1];
    const S = last ? last.S + Math.hypot(x - last.x, z - last.z) : 0;
    if (last && S - last.S < 1e-6) return;
    pts.push({ S, x, z, y, hx, hz });
  };
  list.forEach((s, i) => {
    const [ax, az] = s.axis[line], L = boxHalf(line, s), y = s.yp[line];
    // 1 つ前の駅からの曲線
    if (i > 0) {
      const p = list[i - 1], [px, pz] = p.axis[line], Lp = boxHalf(line, p), yp0 = p.yp[line];
      const x0 = p.x + px * Lp, z0 = p.z + pz * Lp, x1 = s.x - ax * L, z1 = s.z - az * L;
      const chord = Math.hypot(x1 - x0, z1 - z0), m = chord * 0.45;
      const n = Math.max(4, Math.ceil(chord / 2));
      for (let k = 1; k < n; k++) {
        const t = k / n, t2 = t * t, t3 = t2 * t;
        const h00 = 2 * t3 - 3 * t2 + 1, h10 = t3 - 2 * t2 + t, h01 = -2 * t3 + 3 * t2, h11 = t3 - t2;
        const x = h00 * x0 + h10 * m * px + h01 * x1 + h11 * m * ax, z = h00 * z0 + h10 * m * pz + h01 * z1 + h11 * m * az;
        const d00 = 6 * t2 - 6 * t, d10 = 3 * t2 - 4 * t + 1, d01 = -6 * t2 + 6 * t, d11 = 3 * t2 - 2 * t;
        const [hx, hz] = norm(d00 * x0 + d10 * m * px + d01 * x1 + d11 * m * ax, d00 * z0 + d10 * m * pz + d01 * z1 + d11 * m * az);
        const sy = t2 * (3 - 2 * t); // 縦断面はなめらかに
        push(x, z, yp0 + (y - yp0) * sy, hx, hz);
      }
    }
    // ホーム（直線）
    const n = Math.ceil((2 * L) / 2);
    for (let k = 0; k <= n; k++) {
      const u = -L + (2 * L * k) / n;
      push(s.x + ax * u, s.z + az * u, y, ax, az);
    }
  });
  // 駅の中心の S（ホームの直線の上で駅の中心に最も近い点を、線分の上で正確に）
  for (const s of list) {
    let best = Infinity, bestS = 0;
    for (let i = 0; i + 1 < pts.length; i++) {
      const a = pts[i], b = pts[i + 1], dx = b.x - a.x, dz = b.z - a.z, l2 = dx * dx + dz * dz;
      const t = Math.max(0, Math.min(1, ((s.x - a.x) * dx + (s.z - a.z) * dz) / (l2 || 1)));
      const d = Math.hypot(a.x + dx * t - s.x, a.z + dz * t - s.z);
      if (d < best) [best, bestS] = [d, a.S + (b.S - a.S) * t];
    }
    s.S = s.S || {};
    s.S[line] = bestS;
  }
  return { line, stations: list, pts, length: pts[pts.length - 1].S };
}

// 線形の上の点（S で補間）。out: { x, z, y, hx, hz }
export function pathAt(path, S, out = {}) {
  const P = path.pts;
  S = Math.max(0, Math.min(path.length, S));
  // 2 分探索
  let lo = 0, hi = P.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (P[mid].S <= S) lo = mid;
    else hi = mid;
  }
  const a = P[lo], b = P[hi], t = b.S > a.S ? (S - a.S) / (b.S - a.S) : 0;
  out.x = a.x + (b.x - a.x) * t;
  out.z = a.z + (b.z - a.z) * t;
  out.y = a.y + (b.y - a.y) * t;
  const [hx, hz] = norm(a.hx + (b.hx - a.hx) * t, a.hz + (b.hz - a.hz) * t);
  out.hx = hx;
  out.hz = hz;
  return out;
}

// 線路の上の点: 進む向き dir（+1 終点へ、-1 起点へ）の電車の線路（右側通行）。out に x, z, y と車両の向き fx, fz
export function trackAt(path, S, dir, out = {}) {
  pathAt(path, S, out);
  const rx = -out.hz, rz = out.hx, o = LAYOUT.trackOff * dir;
  out.x += rx * o;
  out.z += rz * o;
  out.fx = out.hx * dir;
  out.fz = out.hz * dir;
  return out;
}

// 駅の局所座標 (s, t) → ローカル座標 (x, z)（line のホームの向き）
export function stationFrame(station, line) {
  const [ax, az] = station.axis[line];
  const nx = -az, nz = ax;
  return {
    ax, az, nx, nz, x: station.x, z: station.z,
    at: (s, t) => [station.x + ax * s + nx * t, station.z + az * s + nz * t],
    local: (x, z) => {
      const dx = x - station.x, dz = z - station.z;
      return [dx * ax + dz * az, dx * nx + dz * nz];
    },
    rotY: Math.atan2(-az, ax), // three.js の rotation.y（局所の +x が s、+z が t）
  };
}

// 停車中の電車の両の中心（駅の中心からの s）。n 両
export function carOffsets(n) {
  return Array.from({ length: n }, (_, k) => (k - (n - 1) / 2) * LAYOUT.carPitch);
}

// 電車の扉の位置（駅の中心からの s。停車位置は駅の中心）
export function doorOffsets(n) {
  return carOffsets(n).flatMap((c) => LAYOUT.doorX.map((d) => c + d));
}

// 駅のあいだの所要時間（s）。最高 vmax m/s、加速・減速 acc m/s²
export function runTime(dist, vmax = 19, acc = 1.2) {
  const dAcc = (vmax * vmax) / acc; // 加速と減速に要る距離
  if (dist <= dAcc) return 2 * Math.sqrt(dist / acc);
  return 2 * (vmax / acc) + (dist - dAcc) / vmax;
}

// 終点の名前（dir: +1 終点、-1 起点）
export function terminusOf(network, line, dir) {
  const ids = LINES[line];
  return network.byId.get(dir > 0 ? ids[ids.length - 1] : ids[0]);
}
