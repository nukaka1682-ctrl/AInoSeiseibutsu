// 地下の駅のメッシュ（stationplan.js の間取りから）。写真（Wikimedia Commons）を手本に:
// - ホーム: 灰色のタイルの床、ホームドアの前に淡い花崗岩の帯、白いタイルの壁に駅名の板（白地に紺の帯、黒い大文字）、
//   青い穴あきの 3 人掛けのベンチ、穴あきの金属の天井と蛍光灯の帯。ホームドアは全面ガラス（ステンレスの枠、扉の下半分に横の帯、
//   上につや消しの帯に「DIRECTION 〜」）。キャピトルは白いタイルのヴォールト
// - 改札階: 花崗岩の床、ステンレスの三脚の回転式改札（緑の矢印）、ガラスの仕切り、赤と白の券売機、青い方面の吊り看板、
//   黄色の出口の吊り看板。吹き抜けにガラスの手すりの階段と上りのエスカレーター
// - 通路: タイルの壁、天井の真ん中に照明の帯
import * as THREE from 'three';
import { Builder } from './geom.js';
import { LAYOUT, LINE_COLORS, wallT } from './network.js';
import { CORR_H, ESC_FLAT, HALL_H, PLAT_H, RISE, TREAD, MID_LANDING, corridorPieces, corridorProfile, escalatorHeight, flightHeight, gateLanes, hallBoundary, inRect, offsetPolyline, pitInfo, wellPoly } from './stationplan.js';
import { drawLineBadge, drawMetroLogo, fitText, floorNormalTexture, metroTextures, signTexture, stripedTileTexture, tileNormalTexture } from './textures.js';
import { entranceDoor, entranceFrame } from '../world/metro.js';
import { hash01, mulberry32 } from '../geo.js';

const C = {
  steel: [0.82, 0.84, 0.86], darkSteel: [0.35, 0.36, 0.38], black: [0.08, 0.08, 0.09], white: [1, 1, 1],
  trackbed: [0.32, 0.31, 0.3], pad: [0.62, 0.61, 0.58], bench: [0.12, 0.22, 0.55], header: [0.86, 0.87, 0.88],
  ticketRed: [0.78, 0.1, 0.12], screen: [0.05, 0.07, 0.1], copper: [0.72, 0.36, 0.16], concrete: [0.66, 0.65, 0.63],
};

// 駅ごとの見た目（写真で決めた駅と、ほかは名前から決まった帯の色）
const ACCENTS = ['#1d3f8f', '#b3261e', '#2f7d4f', '#c08a1e', '#6a3d8f', '#1f7a8c', '#8f1d5b'];
export function stationStyle(station) {
  const k = Math.floor(hash01(station.id.length * 131 + station.id.charCodeAt(0) * 17 + station.id.charCodeAt(station.id.length - 1), 3) * ACCENTS.length);
  const style = { accent: ACCENTS[k], vault: false, hallFloor: 'granite', art: 'mural', columns: true };
  if (station.id === 'capitole') Object.assign(style, { accent: '#1d3f8f', vault: true });
  if (station.id === 'esquirol') Object.assign(style, { accent: '#1d3f8f', art: 'cone' });
  if (station.id === 'jean-jaures') Object.assign(style, { accent: '#4b4f55', hallFloor: 'darkGranite', art: 'columns', ceilingTint: [1.45, 0.5, 0.42] }); // A 線の改札階の赤い天井
  if (station.id === 'marengo') Object.assign(style, { accent: '#222222' });
  if (station.id === 'palais-de-justice') Object.assign(style, { accent: '#1d3f8f', art: 'devise' }); // 「LIBERTÉ ÉGALITÉ FRATERNITÉ」
  if (station.id === 'compans-caffarelli') Object.assign(style, { art: 'pink' }); // ばら色の光の柱
  if (station.id === 'patte-d-oie') Object.assign(style, { art: 'halo' }); // 天井の丸い照明
  return style;
}

let shared = null;
export function stationMaterials() {
  if (shared) return shared;
  const t = metroTextures();
  const std = (o) => new THREE.MeshStandardMaterial({ vertexColors: true, ...o });
  shared = {
    // 磨いた床のタイル・花崗岩と、釉薬のかかった壁のタイル（映り込みが見える粗さ。目地は法線マップでくぼむ）
    floor: std({ map: t.floor, roughness: 0.24, normalMap: floorNormalTexture(), normalScale: new THREE.Vector2(0.8, 0.8) }),
    granite: std({ map: t.granite, roughness: 0.22 }),
    darkGranite: std({ map: t.darkGranite, roughness: 0.26 }),
    tile: std({ map: t.tile, roughness: 0.14, normalMap: tileNormalTexture(), normalScale: new THREE.Vector2(1, 1) }),
    ceiling: std({ map: t.perforated, roughness: 0.55, metalness: 0.4 }),
    darkCeiling: std({ map: t.darkPerforated, roughness: 0.7, metalness: 0.3 }),
    steel: std({ map: t.brushed, roughness: 0.32, metalness: 0.85 }),
    paint: std({ roughness: 0.6 }),
    gloss: std({ roughness: 0.25 }),
    concrete: std({ map: t.concrete, roughness: 0.9 }),
    dark: std({ roughness: 0.9, color: '#ffffff' }),
    copper: std({ roughness: 0.3, metalness: 0.9 }),
    glass: new THREE.MeshStandardMaterial({ color: '#c9d6d4', roughness: 0.05, metalness: 0.1, transparent: true, opacity: 0.16, depthWrite: false, side: THREE.DoubleSide }),
    light: new THREE.MeshBasicMaterial({ color: new THREE.Color('#fffaf0').multiplyScalar(6) }), // 蛍光灯（HDR。映り込みとにじみで光って見える）
    pink: new THREE.MeshBasicMaterial({ color: '#ff8fc4' }),
    green: new THREE.MeshBasicMaterial({ color: '#29d36a' }),
    red: new THREE.MeshBasicMaterial({ color: '#ff3b30' }),
  };
  return shared;
}

// 照明の焼き込み（頂点の明るさ）: 天井の照明の帯（Builder の lights）を 0.5 m ごとの光の点にして、各頂点の照度を足す
// （光の点は下向き、横にも少し。受ける面の向きと距離の 2 乗で弱まる）。光より下 4.6 m までの面だけ照らす（上の階・下の階の
// 照明が床を通して漏れない）。照明から遠い所・照明の帯のあいだは暗くなり、帯の真下の床と、帯に近い壁の上の方が明るい。
// 床との隅は少し暗く（環境光の遮り）
export function bakeStationLight(lights, floorYs, { ambient = 0.52, gain = 1.35, reach = 7.5 } = {}) {
  const pts = [], cell = 3, grid = new Map();
  for (const L of lights) {
    const n = Math.max(1, Math.round(L.len / 0.5));
    for (let k = 0; k < n; k++) {
      const u = -L.len / 2 + ((k + 0.5) * L.len) / n;
      pts.push({ x: L.x + L.ux * u, z: L.z + L.uz * u, y: L.y - 0.02, p: (L.len / n) * Math.min(1.6, L.wid / 0.14) });
    }
  }
  pts.forEach((q, i) => {
    const key = `${Math.floor(q.x / cell)},${Math.floor(q.z / cell)}`;
    (grid.get(key) || grid.set(key, []).get(key)).push(i);
  });
  const R = Math.ceil(reach / cell);
  const memo = new Map(); // 同じ頂点（三角形どうしで共有する角）は 1 回だけ
  return (x, y, z, nx, ny, nz) => {
    const key = `${Math.round(x * 50)},${Math.round(y * 50)},${Math.round(z * 50)},${Math.round(nx * 10)},${Math.round(ny * 10)},${Math.round(nz * 10)}`;
    const hit = memo.get(key);
    if (hit !== undefined) return hit;
    let E = 0;
    const cx = Math.floor(x / cell), cz = Math.floor(z / cell);
    for (let i = cx - R; i <= cx + R; i++) {
      for (let j = cz - R; j <= cz + R; j++) {
        const list = grid.get(`${i},${j}`);
        if (!list) continue;
        for (const k of list) {
          const q = pts[k], dy = q.y - y;
          if (dy < -0.05 || dy > 4.6) continue;
          const dx = q.x - x, dz = q.z - z, d2 = dx * dx + dy * dy + dz * dz;
          if (d2 > reach * reach) continue;
          const d = Math.sqrt(d2) || 1e-3;
          const cr = (nx * dx + ny * dy + nz * dz) / d;
          if (cr <= 0) continue;
          const ce = 0.25 + 0.75 * Math.max(0, dy / d);
          E += (q.p * cr * ce) / (d2 + 0.35);
        }
      }
    }
    let k = ambient + gain * E;
    // 床との隅
    if (ny < 0.5) {
      let near = Infinity;
      for (const fy of floorYs) if (y >= fy - 0.3) near = Math.min(near, y - fy);
      if (near < 0.6) k *= 0.8 + 0.33 * Math.max(0, near);
    }
    k = Math.min(1.7, k);
    memo.set(key, k);
    return k;
  };
}

// 文字の板の材質（同じ文字は 1 つ）
class Signs {
  constructor() {
    this.cache = new Map();
    this.builder = new Builder();
  }

  material(key, w, h, draw, opts = undefined) {
    if (!this.cache.has(key)) {
      const map = signTexture(w, h, draw, opts);
      this.cache.set(key, new THREE.MeshBasicMaterial({ map, toneMapped: true, side: THREE.DoubleSide }));
    }
    return key;
  }

  // 鉛直の板（中心 (x, y, z)、横の向き (ux, uz)、表の向き (nx, nz)）
  panel(key, x, y, z, ux, uz, w, h, nx, nz, off = 0.006) {
    const ox = nx * off, oz = nz * off, hw = w / 2, hh = h / 2;
    const p = (i, j) => [x + ox + ux * hw * i, y + hh * j, z + oz + uz * hw * i];
    this.builder.quad(key, p(-1, -1), p(1, -1), p(1, 1), p(-1, 1), [nx, 0, nz], { uvs: [[0, 0], [1, 0], [1, 1], [0, 1]] });
  }

  build() {
    const mats = Object.fromEntries(this.cache);
    return this.builder.build(mats, { name: 'signs' });
  }
}

const upper = (s) => s.toLocaleUpperCase('fr-FR');

function nameDraw(name, accent) {
  return (x, W, H) => {
    x.fillStyle = '#ffffff';
    x.fillRect(0, 0, W, H);
    x.fillStyle = accent;
    x.fillRect(0, H * 0.06, W, H * 0.07);
    x.fillRect(0, H * 0.87, W, H * 0.07);
    x.fillStyle = '#1b1b1b';
    x.textAlign = 'center';
    x.textBaseline = 'middle';
    fitText(x, upper(name), W * 0.9, H * 0.5, '700');
    x.fillText(upper(name), W / 2, H * 0.52);
  };
}

function directionDraw(line, terminus, { bg = '#1f4e9e', fg = '#ffffff', arrow = '' } = {}) {
  return (x, W, H) => {
    x.fillStyle = bg;
    x.fillRect(0, 0, W, H);
    drawLineBadge(x, line, H * 0.55, H / 2, H * 0.36);
    x.fillStyle = fg;
    x.textAlign = 'left';
    x.textBaseline = 'middle';
    const txt = `Direction ${terminus}`;
    fitText(x, txt, W - H * 1.3 - (arrow ? H : 0), H * 0.42, '600');
    x.fillText(txt, H * 1.05, H * 0.53);
    if (arrow) {
      x.textAlign = 'right';
      x.font = `700 ${Math.round(H * 0.6)}px Arial`;
      x.fillText(arrow, W - H * 0.2, H * 0.53);
    }
  };
}

// 出口の看板（緑の地に白い文字と、扉から出る矢印の絵）
function exitDraw(street) {
  return (x, W, H) => {
    x.fillStyle = '#00864b';
    x.fillRect(0, 0, W, H);
    const s = H * (street ? 0.62 : 0.78), cx = H * 0.12 + s / 2, cy = H * (street ? 0.36 : 0.5);
    x.strokeStyle = '#ffffff';
    x.fillStyle = '#ffffff';
    x.lineWidth = s * 0.08;
    x.strokeRect(cx - s * 0.42, cy - s * 0.42, s * 0.5, s * 0.84);
    x.beginPath();
    x.moveTo(cx - s * 0.1, cy);
    x.lineTo(cx + s * 0.32, cy);
    x.stroke();
    x.beginPath();
    x.moveTo(cx + s * 0.44, cy);
    x.lineTo(cx + s * 0.22, cy - s * 0.16);
    x.lineTo(cx + s * 0.22, cy + s * 0.16);
    x.closePath();
    x.fill();
    x.textBaseline = 'middle';
    x.textAlign = 'left';
    const tx = H * 0.24 + s;
    x.font = `700 ${Math.round(H * (street ? 0.42 : 0.5))}px "Helvetica Neue", Arial, sans-serif`;
    x.fillText('Sortie', tx, cy + H * 0.02);
    if (street) {
      fitText(x, street, W - H * 0.3, H * 0.26, '500');
      x.fillText(street, H * 0.14, H * 0.8);
    }
  };
}

// 改札の上の案内（青の地に線の丸と、左右の方面）
function gateSignDraw(line, left, right) {
  return (x, W, H) => {
    x.fillStyle = '#1f4e9e';
    x.fillRect(0, 0, W, H);
    drawLineBadge(x, line, W / 2, H / 2, H * 0.36);
    x.fillStyle = '#ffffff';
    x.textBaseline = 'middle';
    const half = W / 2 - H * 0.6;
    x.textAlign = 'left';
    x.font = `700 ${Math.round(H * 0.6)}px Arial`;
    x.fillText('←', H * 0.15, H * 0.52);
    left = `Direction ${left}`;
    right = `Direction ${right}`;
    fitText(x, left, half - H * 0.9, H * 0.36, '600');
    x.fillText(left, H * 0.85, H * 0.53);
    x.textAlign = 'right';
    x.font = `700 ${Math.round(H * 0.6)}px Arial`;
    x.fillText('→', W - H * 0.15, H * 0.52);
    fitText(x, right, half - H * 0.9, H * 0.36, '600');
    x.fillText(right, W - H * 0.85, H * 0.53);
  };
}

function psdHeaderDraw(terminus) {
  return (x, W, H) => {
    x.fillStyle = '#d6d8da';
    x.fillRect(0, 0, W, H);
    x.fillStyle = '#4a4c50';
    x.textAlign = 'center';
    x.textBaseline = 'middle';
    const t = upper(`Direction ${terminus}`);
    fitText(x, t, W * 0.92, H * 0.55, '500');
    x.fillText(t, W / 2, H * 0.55);
  };
}

function muralDraw(station, accent) {
  return (x, W, H) => {
    const rnd = mulberry32(station.id.length * 977 + station.id.charCodeAt(1));
    x.fillStyle = '#f3efe6';
    x.fillRect(0, 0, W, H);
    const cols = [accent, '#e2231a', '#f6b400', '#1b1b1b', '#7fb3d5', '#d98c5f'];
    for (let i = 0; i < 28; i++) {
      x.fillStyle = cols[Math.floor(rnd() * cols.length)];
      x.globalAlpha = 0.55 + rnd() * 0.4;
      const X = rnd() * W, Y = rnd() * H, r = (0.04 + rnd() * 0.16) * H;
      if (rnd() < 0.5) {
        x.beginPath();
        x.arc(X, Y, r, 0, Math.PI * 2);
        x.fill();
      } else x.fillRect(X - r, Y - r * 0.3, r * 2.5, r * 0.6);
    }
    x.globalAlpha = 1;
    x.fillStyle = '#1b1b1b';
    x.font = `600 ${Math.round(H * 0.05)}px Arial`;
    x.textAlign = 'right';
    x.fillText(`Œuvre de la station ${station.name}`, W - H * 0.04, H * 0.94);
  };
}

function hashId(id) {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) % 9973;
  return h;
}

// 広告（いろいろな催し・売り出し）
function posterDraw(bg, fg, title, sub, dates, shape) {
  return (x, W, H) => {
    const g = x.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, bg[0]);
    g.addColorStop(1, bg[1]);
    x.fillStyle = g;
    x.fillRect(0, 0, W, H);
    x.globalAlpha = 0.85;
    shape(x, W, H);
    x.globalAlpha = 1;
    x.fillStyle = fg;
    x.textAlign = 'left';
    x.textBaseline = 'alphabetic';
    fitText(x, title, W * 0.86, H * 0.11, '800');
    x.fillText(title, W * 0.07, H * 0.72);
    fitText(x, sub, W * 0.86, H * 0.045, '500');
    x.fillText(sub, W * 0.07, H * 0.79);
    x.font = `700 ${Math.round(H * 0.04)}px Arial`;
    x.fillText(dates, W * 0.07, H * 0.9);
  };
}
const circles = (cols) => (x, W, H) => {
  cols.forEach((c, i) => {
    x.fillStyle = c;
    x.beginPath();
    x.arc(W * (0.3 + 0.25 * (i % 2)), H * (0.18 + 0.14 * i), W * (0.32 - 0.06 * i), 0, Math.PI * 2);
    x.fill();
  });
};
const stripes = (c) => (x, W, H) => {
  x.fillStyle = c;
  for (let i = 0; i < 7; i++) {
    x.save();
    x.translate(W * 0.5, H * 0.3);
    x.rotate(-0.5 + i * 0.16);
    x.fillRect(-W, -H * 0.012, W * 2, H * 0.024);
    x.restore();
  }
};
const POSTERS = [
  posterDraw(['#1d2b53', '#7e2553'], '#ffffff', 'EXPOSITION', 'Peintures du Midi, de 1850 à nos jours', 'du 6 au 29 novembre', circles(['#ff77a8', '#ffccaa', '#29adff'])),
  posterDraw(['#f2c14e', '#f78154'], '#1b1b1b', 'FESTIVAL', 'Musiques du monde · bords de Garonne', '14 · 15 · 16 novembre', stripes('#ffffff')),
  posterDraw(['#c5161d', '#8f0e13'], '#ffffff', 'SOLDES', 'Jusqu’à -50 % sur toute la collection', 'en magasin et en ligne', circles(['#ff4d4d', '#ffffff'])),
  posterDraw(['#2b2d42', '#000000'], '#edf2f4', 'CONCERT', 'Orchestre symphonique · saison 2026-2027', 'jeudi 20 novembre · 20 h', stripes('#ef233c')),
  posterDraw(['#3a7d44', '#1b4332'], '#f1faee', 'THÉÂTRE', 'Une comédie en trois actes', 'du 2 au 13 décembre', circles(['#95d5b2', '#d8f3dc'])),
  posterDraw(['#5e60ce', '#48bfe3'], '#ffffff', 'CINÉMA', 'Rencontres du film documentaire', '22 → 30 novembre', stripes('#ffffff')),
];

// 路線図（A 線・B 線と駅。ここの駅に印）
function networkMapDraw(network, here) {
  return (x, W, H) => {
    x.fillStyle = '#ffffff';
    x.fillRect(0, 0, W, H);
    x.fillStyle = '#1b1b1b';
    x.textAlign = 'left';
    x.textBaseline = 'middle';
    x.font = `700 ${Math.round(H * 0.055)}px Arial`;
    x.fillText('Plan du réseau métro', W * 0.03, H * 0.06);
    const pts = network.stations.map((s) => [s.x, s.z]);
    const minX = Math.min(...pts.map((p) => p[0])), maxX = Math.max(...pts.map((p) => p[0]));
    const minZ = Math.min(...pts.map((p) => p[1])), maxZ = Math.max(...pts.map((p) => p[1]));
    const pad = W * 0.1, top = H * 0.12, k = Math.min((W - 2 * pad) / (maxX - minX), (H - top - pad * 0.5) / (maxZ - minZ));
    const X = (v) => pad + (v - minX) * k + (W - 2 * pad - (maxX - minX) * k) / 2, Y = (v) => top + (v - minZ) * k;
    for (const [line, path] of Object.entries(network.lines)) {
      x.strokeStyle = LINE_COLORS[line];
      x.lineWidth = H * 0.016;
      x.lineCap = x.lineJoin = 'round';
      x.beginPath();
      path.pts.forEach((p, i) => (i ? x.lineTo(X(p.x), Y(p.z)) : x.moveTo(X(p.x), Y(p.z))));
      x.stroke();
    }
    x.font = `500 ${Math.round(H * 0.022)}px Arial`;
    for (const s of network.stations) {
      const r = s.lines.length > 1 ? H * 0.013 : H * 0.009;
      x.fillStyle = '#ffffff';
      x.strokeStyle = '#1b1b1b';
      x.lineWidth = H * 0.004;
      x.beginPath();
      x.arc(X(s.x), Y(s.z), r, 0, Math.PI * 2);
      x.fill();
      x.stroke();
      const right = s.x < (minX + maxX) / 2 ? -1 : 1;
      x.fillStyle = '#1b1b1b';
      x.textAlign = right > 0 ? 'left' : 'right';
      x.fillText(s.name.replace(' – ', '-'), X(s.x) + right * r * 1.8, Y(s.z));
    }
    // ここ
    x.strokeStyle = '#e2231a';
    x.lineWidth = H * 0.008;
    x.beginPath();
    x.arc(X(here.x), Y(here.z), H * 0.03, 0, Math.PI * 2);
    x.stroke();
    x.fillStyle = '#e2231a';
    x.font = `700 ${Math.round(H * 0.026)}px Arial`;
    x.textAlign = 'center';
    x.fillText('Vous êtes ici', X(here.x), Y(here.z) - H * 0.05);
  };
}

// 次の電車の LED 表示（吊り下げ、両面）。update(eta) で書き換える
function ledDisplay(B, extra, L, side, c, y, along, yCeil, term) {
  const [x, z] = c, [ux, uz] = along, w = 1.7, h = 0.36;
  B.box('paint', x, z, y - h / 2 - 0.03, y + h / 2 + 0.03, ux, uz, w + 0.08, 0.12, { color: C.black });
  for (const k of [-w / 2 + 0.2, w / 2 - 0.2]) B.bar('steel', [x + ux * k, y + h / 2 + 0.03, z + uz * k], [x + ux * k, yCeil, z + uz * k], 0.025);
  const cv = document.createElement('canvas');
  cv.width = 512;
  cv.height = 108;
  const ctx = cv.getContext('2d');
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  const mat = new THREE.MeshBasicMaterial({ map: tex, toneMapped: false });
  const geo = new THREE.PlaneGeometry(w, h);
  for (const sg of [1, -1]) {
    const m = new THREE.Mesh(geo, mat);
    const nx = -uz * sg, nz = ux * sg;
    m.position.set(x + nx * 0.062, y, z + nz * 0.062);
    m.rotation.y = Math.atan2(nx, nz);
    extra.add(m);
  }
  let last = null;
  const d = {
    line: L.line, side,
    update(eta) {
      if (eta === last) return;
      last = eta;
      ctx.fillStyle = '#0b0b0c';
      ctx.fillRect(0, 0, 512, 108);
      ctx.fillStyle = '#ffab1a';
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'left';
      ctx.font = '600 22px "Courier New", monospace';
      ctx.fillText('Prochain métro', 14, 22);
      ctx.font = '700 40px "Courier New", monospace';
      fitText(ctx, term, 330, 40, '700', '"Courier New", monospace');
      ctx.fillText(term, 14, 70);
      ctx.textAlign = 'right';
      ctx.font = '700 40px "Courier New", monospace';
      ctx.fillText(eta, 498, 70);
      // 点の目（LED の粒）
      ctx.fillStyle = 'rgba(0,0,0,0.35)';
      for (let yy = 0; yy < 108; yy += 4) ctx.fillRect(0, yy, 512, 1);
      for (let xx = 0; xx < 512; xx += 4) ctx.fillRect(xx, 0, 1, 108);
      tex.needsUpdate = true;
    },
  };
  d.update('…');
  return d;
}

function ticketDraw() {
  return (x, W, H) => {
    x.fillStyle = '#c5161d';
    x.fillRect(0, 0, W, H);
    x.fillStyle = '#f7c600';
    x.fillRect(0, 0, W, H * 0.12);
    x.fillStyle = '#1b1b1b';
    x.font = `800 ${Math.round(H * 0.07)}px Arial`;
    x.textAlign = 'center';
    x.textBaseline = 'middle';
    x.fillText('TICKETS', W / 2, H * 0.06);
    x.fillStyle = '#0d1520';
    x.fillRect(W * 0.12, H * 0.2, W * 0.76, H * 0.3);
    x.fillStyle = '#3d8fd6';
    x.fillRect(W * 0.16, H * 0.24, W * 0.68, H * 0.06);
    x.fillStyle = '#ffffff';
    x.font = `600 ${Math.round(H * 0.035)}px Arial`;
    x.fillText('Touchez l’écran', W / 2, H * 0.4);
    x.fillStyle = '#e8e8e8';
    x.fillRect(W * 0.2, H * 0.58, W * 0.6, H * 0.12);
    x.fillStyle = '#222';
    x.fillRect(W * 0.3, H * 0.76, W * 0.4, H * 0.04);
    x.fillStyle = '#ffffff';
    x.font = `700 ${Math.round(H * 0.05)}px Arial`;
    x.fillText('tisséo', W / 2, H * 0.9);
  };
}

// 駅のメッシュ。plan: planStation の結果、opts.network（終点の名前）、opts.streetAt(x, z)（出口の看板の通りの名前）
export function buildStationMesh(plan, { streetAt = () => '', network = null } = {}) {
  const mats = stationMaterials();
  const style = stationStyle(plan.station);
  const tileKey = `tile:${style.accent}`;
  const striped = stripedTileTexture(style.accent);
  const mtl = { ...mats, [tileKey]: Object.assign(mats.tile.clone(), { map: striped }) };
  const B = new Builder({ tess: 1.6 }), signs = new Signs();
  const { ym } = plan, WT = wallT(), P = LAYOUT.psd;
  const st = plan.station;
  const nameKey = signs.material('name', 2.4, 0.6, nameDraw(st.name, style.accent));
  const doorsMeshes = [];
  const displays = [], extra = new THREE.Group(); // 次の電車の表示（テクスチャを書き換える）

  // ---------------------------------------------------------------- ホーム階
  for (const L of plan.lines) {
    const f = L.frame, at = f.at, yp = L.yp, Lb = L.Lb, yc = yp + PLAT_H;
    const T = (s, t) => at(s, t);
    for (const side of [1, -1]) {
      const n = [f.nx * -side, f.nz * -side]; // 壁から内向き
      const tW = WT * side, tP = P * side;
      const well = plan.wells.find((w) => w.line === L.line && w.side === side);
      const ws0 = Math.min(well.s0, well.s1), ws1 = Math.max(well.s0, well.s1), tIn = side > 0 ? well.t0 : well.t1;
      const term = L.dirs.find((d) => d.side === side).terminus?.name || '';
      // 床（ホームドアの前の花崗岩の帯）
      B.floor('floor', rect(T, -Lb, Lb, tP + 0.9 * side, tW), yp);
      B.floor('granite', rect(T, -Lb, Lb, tP, tP + 0.9 * side), yp + 0.002);
      // 奥の壁（キャピトルはヴォールトの下の部分）
      if (style.vault) {
        // 白いタイルのヴォールト: 壁の上 2.6 m から、ホームドアの上の天井まで（4 分の 1 の楕円）
        const segs = 8, r1 = WT - P - 0.6, y0 = yp + 2.4, h = PLAT_H + 0.9 - 2.4;
        B.wall(tileKey, T(-Lb, tW), T(Lb, tW), yp, y0, { n });
        for (let k = 0; k < segs; k++) {
          const a0 = (k / segs) * (Math.PI / 2), a1 = ((k + 1) / segs) * (Math.PI / 2);
          const t0 = (WT - r1 * (1 - Math.cos(a0))) * side, t1 = (WT - r1 * (1 - Math.cos(a1))) * side;
          const y1a = y0 + h * Math.sin(a0), y1b = y0 + h * Math.sin(a1);
          const am = (a0 + a1) / 2;
          const nn = [-Math.cos(am) * side, -Math.sin(am)];
          B.quad(tileKey, [...pt3(T(-Lb, t0), y1a)], [...pt3(T(Lb, t0), y1a)], [...pt3(T(Lb, t1), y1b)], [...pt3(T(-Lb, t1), y1b)], [f.nx * nn[0], nn[1], f.nz * nn[0]], { uvs: [[0, 0], [2 * Lb / 1.2, 0], [2 * Lb / 1.2, 0.5], [0, 0.5]] });
        }
      } else {
        B.wall(tileKey, T(-Lb, tW), T(Lb, tW), yp, yc, { n });
      }
      // 両端の壁
      for (const se of [-Lb, Lb]) B.wall(tileKey, T(se, tP), T(se, tW), yp, yc, { n: [-f.ax * Math.sign(se), -f.az * Math.sign(se)] });
      // 天井（吹き抜けを除く）と照明の帯
      const yCeil = style.vault ? yc + 0.9 : yc;
      for (const r of [[-Lb, ws0, tP, tW], [ws1, Lb, tP, tW], [ws0, ws1, tP, tIn]]) {
        if (Math.abs(r[1] - r[0]) < 0.01 || Math.abs(r[3] - r[2]) < 0.01) continue;
        if (style.vault && r[3] === tW) continue;
        B.floor('ceiling', rect(T, r[0], r[1], r[2], style.vault ? tP + (P + 0.6 - P) * side : r[3]), yCeil, { up: false });
      }
      if (style.vault) B.floor('ceiling', rect(T, ws0, ws1, tP, tIn), yc, { up: false });
      for (const tl of [P + 1.0, ...(style.vault ? [] : [WT - 1.3])]) {
        for (const [a, b] of [[-Lb + 1, ws0 - 0.5], [ws1 + 0.5, Lb - 1]]) {
          if (b - a < 1) continue;
          const [cx, cz] = T((a + b) / 2, tl * side);
          B.box('light', cx, cz, yCeil - 0.07, yCeil - 0.005, f.ax, f.az, b - a, 0.14);
        }
      }
      // 吹き抜けの下（階段の囲い）: 内側の壁と上の端の壁、吹き抜けの縁（天井から改札階の床まで）
      B.wall(tileKey, T(ws0, tIn), T(ws1, tIn), yp, ym, { n: [f.nx * -side, f.nz * -side] });
      const sTopEnd = well.s0; // 階段の上の端の側（ホーム階では囲い）
      B.wall(tileKey, T(sTopEnd, tIn), T(sTopEnd, tW), yp, ym, { n: [-f.ax * side, -f.az * side] });
      B.wall(tileKey, T(ws0, tW), T(ws1, tW), yc, ym, { n });
      // ホームドア
      const psdDoors = buildPSD(B, signs, L, side, term, mats);
      doorsMeshes.push(psdDoors);
      // ベンチと駅名の板（階段の囲いを避ける）
      for (let s = -Lb + 4; s < Lb - 3; s += 11) {
        if (s > ws0 - 2.5 && s < ws1 + 2.5) continue;
        const [bx, bz] = T(s, (WT - 0.35) * side);
        bench(B, bx, bz, yp, f.ax, f.az);
        const [sx, sz] = T(s + 4.5, (WT - 0.02) * side);
        if (s + 4.5 < ws0 - 1.5 || s + 4.5 > ws1 + 1.5) signs.panel(nameKey, sx, yp + 2.15, sz, -f.ax * side, -f.az * side, 2.4, 0.6, n[0], n[1]);
      }
      // 吊り看板: 出口（階段の下の端の前）と方面（階段から離れた所）
      const sBot = well.s1; // 吹き抜けの奥の端（階段の下）
      const exitKey = signs.material('exit-plat', 1.6, 0.4, exitDraw(''));
      hangSign(B, signs, exitKey, T(sBot + well.dirS * 1.5, (P + WT) / 2 * side), yc - 0.9, [f.nx, f.nz], 1.6, 0.4, yCeil);
      const dirKey = signs.material(`dir-${L.line}-${side}`, 3.2, 0.42, directionDraw(L.line, term));
      const sDir = [-14, 14, 0, -24, 24].find((q) => Math.abs(q) < Lb - 3 && (q < ws0 - 4 || q > ws1 + 4)) ?? 0;
      hangSign(B, signs, dirKey, T(sDir, (P + WT) / 2 * side), yc - 0.9, [f.nx, f.nz], 3.2, 0.42, yCeil);
      // 次の電車の表示（オレンジ色の LED。方面の看板の横）
      const sLed = sDir + (sDir + 5 < Lb - 2 ? 5 : -5);
      if (typeof document !== 'undefined') displays.push(ledDisplay(B, extra, L, side, T(sLed, (P + WT) / 2 * side), yc - 0.85, [f.nx, f.nz], yCeil, term));
      // 奥の壁の広告と路線図（ベンチのあいだ）
      const wallFree = (s0, s1) => s0 > -Lb + 1 && s1 < Lb - 1 && (s1 < ws0 - 1 || s0 > ws1 + 1);
      let k = 0;
      for (let s = -Lb + 4; s < Lb - 3; s += 11) {
        const sp = s + 8;
        if (!wallFree(sp - 0.7, sp + 0.7)) continue;
        const [px, pz] = T(sp, (WT - 0.03) * side);
        const isMap = k === 1 && network;
        const w = isMap ? 1.8 : 1.2, h = isMap ? 1.2 : 1.76;
        const key = isMap ? signs.material(`plan-${plan.station.id}`, w, h, networkMapDraw(network, plan.station), { ppm: 560 }) : signs.material(`poster-${(k + hashId(plan.station.id) + side) % POSTERS.length}`, w, h, POSTERS[(k + hashId(plan.station.id) + side) % POSTERS.length]);
        B.box('steel', px, pz, yp + 0.55 - 0.04, yp + 0.55 + h + 0.04, f.ax, f.az, w + 0.08, 0.04);
        signs.panel(key, px + n[0] * 0.025, yp + 0.55 + h / 2, pz + n[1] * 0.025, -f.ax * side, -f.az * side, w, h, n[0], n[1], 0);
        k++;
      }
    }
    // 線路（走行路・案内軌条・中央の柱）
    trackZone(B, L, plan, style);
  }

  // ---------------------------------------------------------------- 改札階
  const hallKey = style.hallFloor, yH = ym + HALL_H;
  const pits = plan.direct.map((e) => ({ e, poly: pitInfo(e, plan.frame).poly, door: entranceDoor(e), f: entranceFrame(e) }));
  for (const r of plan.rects) {
    const at = r.frame.at;
    const outer = rect(at, r.s0, r.s1, r.t0, r.t1);
    const ph = pits.filter((p) => p.poly.every(([x, z]) => inRect(r, x, z, 0)));
    if (ph.length) {
      // 出入口の吹き抜けの所は床と天井に穴（吹き抜けの囲いの中は出入口の階段）
      B.floorPoly(hallKey, outer, ph.map((p) => p.poly), ym);
      B.floorPoly('ceiling', outer, ph.map((p) => p.poly), yH, { up: false, color: style.ceilingTint });
    } else {
      const cuts = plan.wells.map((w) => localBox(r.frame, wellPoly(w)));
      for (const [s0, s1, t0, t1] of rectMinus(r, cuts)) B.floor(hallKey, rect(at, s0, s1, t0, t1), ym);
      B.floor('ceiling', outer, yH, { up: false, color: style.ceilingTint });
    }
    // 照明の帯（長い向きに 3.6 m おき。出入口の吹き抜けを避ける）
    const nT = Math.max(1, Math.round((r.t1 - r.t0) / 3.6));
    for (let k = 0; k < nT; k++) {
      const t = r.t0 + ((k + 0.5) * (r.t1 - r.t0)) / nT;
      let a = null;
      const flush = (b) => {
        if (a != null && b - a > 1) {
          const [cx, cz] = at((a + b) / 2, t);
          B.box('light', cx, cz, yH - 0.07, yH - 0.005, r.frame.ax, r.frame.az, b - a, 0.14);
        }
        a = null;
      };
      for (let s = r.s0 + 0.8; s <= r.s1 - 0.8 + 1e-6; s += 0.4) {
        const [x, z] = at(s, t);
        if (ph.some((p) => inPit(p, x, z, 0.5))) flush(s - 0.4);
        else if (a == null) a = s;
      }
      flush(r.s1 - 0.8);
    }
  }
  // 外周の壁（内側を向く）
  for (const [a, b] of hallBoundary(plan)) {
    const mx = (a[0] + b[0]) / 2, mz = (a[1] + b[1]) / 2, dx = b[0] - a[0], dz = b[1] - a[1], l = Math.hypot(dx, dz);
    let n = [-dz / l, dx / l];
    if (!plan.rects.some((r) => inRect(r, mx + n[0] * 0.2, mz + n[1] * 0.2))) n = [-n[0], -n[1]];
    B.wall(tileKey, a, b, ym, yH, { n });
  }
  // 通路の口の上（通路の天井からホールの天井まで）
  for (const o of plan.openings) B.wall(tileKey, o.a, o.b, ym + CORR_H, yH, { n: o.n });
  // ホールの中の出入口の吹き抜けの囲い（外側にタイル。下の端に扉の口）と、扉の前の数段の階段
  for (const p of pits) pitBoxMesh(B, p, ym, yH, tileKey);
  for (const e of plan.boxed || []) pitBoxMesh(B, { e, f: entranceFrame(e), door: entranceDoor(e) }, ym, yH, tileKey, true);
  for (const ds of plan.doorSteps) doorStepsMesh(B, ds);
  // 吹き抜け: 縁・腰壁・階段・エスカレーター
  for (const w of plan.wells) wellMesh(B, plan, w, tileKey);
  for (const s of plan.stairs) {
    if (s.kind === 'stairs') stairsMesh(B, s);
    else escalatorMesh(B, s);
  }
  // 改札
  for (const g of plan.gates) gatesMesh(B, signs, g, ym, plan);
  // 吹き抜けの上の方面の吊り看板（下りる人の前に）
  for (const w of plan.wells) {
    const L = plan.lines.find((q) => q.line === w.line), term = L.dirs.find((d) => d.side === w.side).terminus?.name || '';
    const key = signs.material(`well-${w.line}-${w.side}`, 3.0, 0.42, directionDraw(w.line, term, { arrow: '↓' }));
    const c = w.frame.at(w.s0 - w.dirS * 0.4, (w.t0 + w.t1) / 2);
    hangSign(B, signs, key, c, yH - 0.62, [w.frame.nx, w.frame.nz], 3.0, 0.42, yH);
  }
  // 券売機・出口の看板・駅名・作品（改札の外のホール）
  hallFurniture(B, signs, plan, style, pits, streetAt);

  // ---------------------------------------------------------------- 通路
  for (const c of plan.corridors) corridorMesh(B, signs, c, tileKey, streetAt);
  // 閉まった出入口の扉
  for (const e of plan.closed) {
    const d = entranceDoor(e);
    const a = [d.x - d.sx * d.dw, d.z - d.sz * d.dw], b = [d.x + d.sx * d.dw, d.z + d.sz * d.dw];
    B.wall('dark', a, b, d.yb, d.yb + d.dh, { n: [-d.dx, -d.dz], color: [0.12, 0.14, 0.16] });
    const key = signs.material('ferme', 1.2, 0.3, (x, W, H) => {
      x.fillStyle = '#ffffff';
      x.fillRect(0, 0, W, H);
      x.fillStyle = '#c5161d';
      x.font = `800 ${Math.round(H * 0.5)}px Arial`;
      x.textAlign = 'center';
      x.textBaseline = 'middle';
      x.fillText('FERMÉ', W / 2, H * 0.55);
    });
    signs.panel(key, d.x - d.dx * 0.02, d.yb + 1.5, d.z - d.dz * 0.02, d.sx, d.sz, 1.2, 0.3, -d.dx, -d.dz, 0.01);
  }

  const floorYs = [ym, ...plan.lines.map((L) => L.yp), ...plan.corridors.flatMap((c) => [c.yTop, c.yBot])];
  const group = B.build(mtl, { light: bakeStationLight(B.lights, floorYs), name: `station-${st.id}` });
  group.add(signs.build());
  for (const d of doorsMeshes) group.add(d.group);
  group.add(extra);
  return { group, doors: doorsMeshes, style, displays };
}

// 局所座標の外接長方形（frame の s, t）
function localBox(frame, poly) {
  const L = poly.map(([x, z]) => frame.local(x, z));
  return { s0: Math.min(...L.map((p) => p[0])), s1: Math.max(...L.map((p) => p[0])), t0: Math.min(...L.map((p) => p[1])), t1: Math.max(...L.map((p) => p[1])) };
}

// 長方形 r から長方形 cuts を除いた残りを、長方形 [s0, s1, t0, t1] に分ける
function rectMinus(r, cuts) {
  const cl = (v, a, b) => Math.max(a, Math.min(b, v));
  const ss = [r.s0, r.s1], ts = [r.t0, r.t1];
  const cs = cuts.filter((c) => c.s1 > r.s0 + 0.01 && c.s0 < r.s1 - 0.01 && c.t1 > r.t0 + 0.01 && c.t0 < r.t1 - 0.01);
  for (const c of cs) {
    ss.push(cl(c.s0, r.s0, r.s1), cl(c.s1, r.s0, r.s1));
    ts.push(cl(c.t0, r.t0, r.t1), cl(c.t1, r.t0, r.t1));
  }
  const uniq = (a) => [...new Set(a.map((v) => Math.round(v * 1000) / 1000))].sort((p, q) => p - q);
  const S = uniq(ss), T = uniq(ts), out = [];
  for (let j = 0; j + 1 < T.length; j++) {
    let run = null;
    for (let i = 0; i + 1 < S.length; i++) {
      const sm = (S[i] + S[i + 1]) / 2, tm = (T[j] + T[j + 1]) / 2;
      const cut = cs.some((c) => sm > c.s0 && sm < c.s1 && tm > c.t0 && tm < c.t1);
      if (cut) {
        if (run != null) out.push([S[run], S[i], T[j], T[j + 1]]);
        run = null;
      } else if (run == null) run = i;
    }
    if (run != null) out.push([S[run], S[S.length - 1], T[j], T[j + 1]]);
  }
  return out;
}

// (x, z) が出入口の吹き抜け（m m 広げた長方形）の中か
function inPit(p, x, z, m = 0) {
  const e = p.e, f = p.f, u = (x - e.x) * f.dx + (z - e.z) * f.dz, v = (x - e.x) * f.sx + (z - e.z) * f.sz;
  return Math.abs(u) < e.len / 2 + m && Math.abs(v) < e.wid / 2 + m;
}

function segDist(x, z, a, b) {
  const dx = b[0] - a[0], dz = b[1] - a[1], l2 = dx * dx + dz * dz || 1;
  const u = Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / l2));
  return Math.hypot(a[0] + dx * u - x, a[1] + dz * u - z);
}

function pt3([x, z], y) {
  return [x, y, z];
}

function rect(at, s0, s1, t0, t1) {
  return [at(s0, t0), at(s1, t0), at(s1, t1), at(s0, t1)];
}

function bench(B, x, z, y, ux, uz) {
  // 青い穴あきの 3 人掛け（座面と背もたれ、黒い脚）
  B.box('paint', x, z, y + 0.42, y + 0.47, ux, uz, 1.75, 0.42, { color: C.bench });
  B.box('paint', x - uz * 0.19, z + ux * 0.19, y + 0.47, y + 0.85, ux, uz, 1.75, 0.04, { color: C.bench });
  for (const k of [-0.75, 0.75]) B.box('paint', x + ux * k, z + uz * k, y, y + 0.42, ux, uz, 0.06, 0.36, { color: C.black });
}

// 天井から吊った看板（両面）。c: [x, z]、along: 板の横の向き
// oneSided: 表（along の左を向く面。along が見る人の右）だけ（矢印のある看板）
function hangSign(B, signs, key, c, y, along, w, h, yCeil, oneSided = false) {
  const [x, z] = c, [ux, uz] = along, nx = -uz, nz = ux;
  B.box('paint', x, z, y - h / 2, y + h / 2, ux, uz, w + 0.04, 0.06, { color: C.darkSteel });
  signs.panel(key, x, y, z, ux, uz, w, h, nx, nz, 0.032);
  if (!oneSided) signs.panel(key, x, y, z, -ux, -uz, w, h, -nx, -nz, 0.032);
  for (const k of [-w / 2 + 0.15, w / 2 - 0.15]) B.bar('steel', [x + ux * k, y + h / 2, z + uz * k], [x + ux * k, yCeil, z + uz * k], 0.025);
}

// ホームドア: 扉の位置に開け閉めする扉（InstancedMesh）、そのあいだにガラスの板、上に「DIRECTION 〜」の帯
function buildPSD(B, signs, L, side, term, mats) {
  const f = L.frame, at = f.at, yp = L.yp, P = (L.P ?? LAYOUT.psd) * side, yc = yp + PLAT_H;
  const half = L.psdHalf, Lb = L.Lb;
  const inward = L.island ? -side : side; // ホームドアの線からホームの側への向き（島式のホームは軸の側）
  const n = [f.nx * inward, f.nz * inward]; // ホームの側を向く
  const gaps = L.doorsS.map((s) => [s - 0.8, s + 0.8]);
  // ガラスの板と柱（扉と扉のあいだ）
  const fixed = [];
  let s = -half;
  for (const [a, b] of gaps) {
    fixed.push([s, a]);
    s = b;
  }
  fixed.push([s, half]);
  const post = (sp) => {
    const [x, z] = at(sp, P);
    B.box('steel', x, z, yp, yp + 2.3, f.ax, f.az, 0.1, 0.14);
  };
  for (const [a, b] of fixed) {
    const k = Math.max(1, Math.round((b - a) / 1.4));
    for (let i = 0; i < k; i++) {
      const s0 = a + ((b - a) * i) / k, s1 = a + ((b - a) * (i + 1)) / k;
      post(s0);
      const [x, z] = at((s0 + s1) / 2, P);
      // 下の板（ステンレスに黒い横の帯）とガラス
      B.box('steel', x, z, yp, yp + 0.95, f.ax, f.az, s1 - s0, 0.05);
      for (const y of [yp + 0.25, yp + 0.5, yp + 0.75]) B.box('paint', x - n[0] * 0.028, z - n[1] * 0.028, y, y + 0.08, f.ax, f.az, s1 - s0 - 0.2, 0.002, { color: C.black, top: false });
      B.box('glass', x, z, yp + 0.95, yp + 2.3, f.ax, f.az, s1 - s0, 0.02);
    }
    post(b);
  }
  // 扉の外（ホームの端まで）は板の壁
  for (const [a, b] of [[-Lb, -half], [half, Lb]]) {
    const [x, z] = at((a + b) / 2, P);
    B.box('steel', x, z, yp, yc, f.ax, f.az, b - a, 0.08);
  }
  // 上の帯（つや消し）と、その上の天井までの板
  {
    const [x, z] = at(0, P);
    B.box('steel', x, z, yp + 2.3, yp + 3.0, f.ax, f.az, 2 * half, 0.16, { color: C.header });
    B.box('paint', x, z, yp + 3.0, yc, f.ax, f.az, 2 * half, 0.1, { color: [0.28, 0.29, 0.31] });
    const key = signs.material(`psd-${L.line}-${side}`, 3.2, 0.26, psdHeaderDraw(term));
    for (let k = 0; k < L.doorsS.length; k += 2) {
      const [hx, hz] = at(L.doorsS[k], P + n[0] * 0 * side);
      signs.panel(key, hx + n[0] * 0.081, yp + 2.62, hz + n[1] * 0.081, f.ax * inward, f.az * inward, 3.0, 0.26, n[0], n[1], 0);
    }
  }
  // 扉（2 枚ずつ）。開くと横へ 0.78 m ずれる
  const leafW = 0.82, leafH = 2.25;
  const frameGeo = leafGeometry(leafW, leafH, false), glassGeo = leafGeometry(leafW, leafH, true);
  const count = L.doorsS.length * 2;
  const frame = new THREE.InstancedMesh(frameGeo, mats.steel, count), glass = new THREE.InstancedMesh(glassGeo, mats.glass, count);
  glass.renderOrder = 2;
  frame.frustumCulled = glass.frustumCulled = false;
  const group = new THREE.Group();
  group.add(frame, glass);
  const leaves = [];
  for (const sd of L.doorsS) for (const k of [-1, 1]) leaves.push({ s: sd, k });
  const m = new THREE.Matrix4(), q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), f.rotY), one = new THREE.Vector3(1, 1, 1), v = new THREE.Vector3();
  const tLeaf = P - 0.06 * inward; // 線路の側にずらして、開くと板の裏へ
  const door = {
    line: L.line, side, open: 0, group,
    set(open) {
      this.open = open;
      leaves.forEach((lf, i) => {
        const sOff = lf.s + lf.k * (leafW / 2 + open * 0.78);
        const [x, z] = at(sOff, tLeaf);
        v.set(x, yp, z);
        m.compose(v, q, one);
        frame.setMatrixAt(i, m);
        glass.setMatrixAt(i, m);
      });
      frame.instanceMatrix.needsUpdate = glass.instanceMatrix.needsUpdate = true;
    },
  };
  door.set(0);
  return door;
}

// 扉 1 枚（局所: x が横、y が上、z が厚さ）。glass: ガラスの部分、でなければ枠と下の板
const leafCache = new Map();
function leafGeometry(w, h, glass) {
  const key = `${w}-${h}-${glass}`;
  if (leafCache.has(key)) return leafCache.get(key);
  const b = new Builder();
  if (glass) b.box('g', 0, 0, 0.95, h - 0.08, 1, 0, w - 0.12, 0.02);
  else {
    b.box('g', 0, 0, 0, 0.95, 1, 0, w, 0.05);
    b.box('g', 0, 0, h - 0.08, h, 1, 0, w, 0.05);
    for (const x of [-w / 2 + 0.03, w / 2 - 0.03]) b.box('g', x, 0, 0.95, h - 0.08, 1, 0, 0.06, 0.05);
    for (const y of [0.25, 0.5, 0.75]) b.box('g', 0, 0, y, y + 0.08, 1, 0, w - 0.12, 0.056, { color: [0.15, 0.15, 0.16] });
  }
  const g = b.writers.get('g').toGeometry();
  leafCache.set(key, g);
  return g;
}

function trackZone(B, L, plan, style) {
  const f = L.frame, at = f.at, yp = L.yp, Lb = L.Lb, P = LAYOUT.psd, yc = yp + PLAT_H, ybed = yp - 1.3;
  // 線路の床・ホームの縁の側面・天井
  B.floor('concrete', rect(at, -Lb, Lb, -P, P), ybed, { color: [0.6, 0.6, 0.6] });
  for (const side of [1, -1]) B.wall('concrete', at(-Lb, P * side), at(Lb, P * side), ybed, yp, { n: [-f.nx * side, -f.nz * side] });
  B.floor('darkCeiling', rect(at, -Lb, Lb, -P, P), yc + (style.vault ? 0.9 : 0), { up: false });
  // 走行路（2 本のコンクリートの帯）と案内軌条（鋼）
  for (const side of [1, -1]) {
    const tc = LAYOUT.trackOff * side;
    for (const o of [-0.86, 0.86]) {
      const [x, z] = at(0, tc + o);
      B.box('paint', x, z, ybed, yp - 1.0, f.ax, f.az, 2 * Lb, 0.36, { color: C.pad });
    }
    for (const o of [-1.22, 1.22]) {
      const [x, z] = at(0, tc + o);
      B.box('steel', x, z, yp - 0.95, yp - 0.78, f.ax, f.az, 2 * Lb, 0.08, { color: [0.55, 0.56, 0.58] });
    }
  }
  // 中央の丸い柱（6 m ごと）
  for (let s = -Lb + 3; s <= Lb - 3; s += 6) {
    const [x, z] = at(s, 0);
    B.cyl('concrete', x, z, ybed, yc + (style.vault ? 0.9 : 0), 0.28, { color: [0.85, 0.85, 0.83] });
  }
  // 両端の壁（トンネルの口を開ける）
  for (const se of [-Lb, Lb]) {
    const n = [-f.ax * Math.sign(se), -f.az * Math.sign(se)];
    B.wall('concrete', at(se, -P), at(se, P), yp + 3.6, yc + (style.vault ? 0.9 : 0), { n });
  }
}

// 吹き抜け（改札階からホームへ）: 床の縁の面と、まわりの腰壁（A 線はタイル張りの腰壁、B 線はガラス）
function wellMesh(B, plan, w, tileKey) {
  const f = w.frame, at = f.at, ym = plan.ym, yc = w.yBot + PLAT_H;
  const tIn = w.side > 0 ? w.t0 : w.t1, tOut = w.side > 0 ? w.t1 : w.t0;
  const sFar = w.s1, into = Math.sign(tOut - tIn), d = w.dirS;
  // 床の縁（改札階の床からホーム階の天井まで）
  B.wall(tileKey, at(w.s0, tIn), at(sFar, tIn), yc, ym, { n: [f.nx * into, f.nz * into] });
  B.wall(tileKey, at(sFar, tIn), at(sFar, tOut), yc, ym, { n: [-f.ax * d, -f.az * d] });
  const len = Math.abs(sFar - w.s0), sm = (w.s0 + sFar) / 2;
  if (w.line === 'A') {
    // タイル張りの腰壁（厚さ 0.16 m、高さ 1.05 m）とステンレスの笠木
    const T = 0.16, H = 1.05;
    const [x1, z1] = at(sm + d * T / 2, tIn - into * T / 2);
    B.box(tileKey, x1, z1, ym, ym + H, f.ax, f.az, len + T, T);
    B.box('steel', x1, z1, ym + H, ym + H + 0.05, f.ax, f.az, len + T + 0.04, T + 0.04);
    const [x2, z2] = at(sFar + d * T / 2, (tIn + tOut) / 2);
    B.box(tileKey, x2, z2, ym, ym + H, f.nx, f.nz, Math.abs(tOut - tIn), T);
    B.box('steel', x2, z2, ym + H, ym + H + 0.05, f.nx, f.nz, Math.abs(tOut - tIn) + 0.04, T + 0.04);
    return;
  }
  // ガラスの手すり（内側の辺と奥の端）
  for (const [p, q] of [[at(w.s0, tIn), at(sFar, tIn)], [at(sFar, tIn), at(sFar, tOut)]]) {
    const mx = (p[0] + q[0]) / 2, mz = (p[1] + q[1]) / 2, dx = q[0] - p[0], dz = q[1] - p[1], l = Math.hypot(dx, dz);
    B.box('glass', mx, mz, ym + 0.05, ym + 1.0, dx / l, dz / l, l, 0.02);
    B.box('steel', mx, mz, ym + 1.0, ym + 1.06, dx / l, dz / l, l, 0.06);
    B.box('steel', mx, mz, ym, ym + 0.08, dx / l, dz / l, l, 0.06);
  }
}

// 改札階の中の出入口の吹き抜けの囲い（外側の面。タイル張り）。下の端に扉の口
function pitBoxMesh(B, p, ym, yH, tileKey, closed = false) {
  const e = p.e, f = p.f, d = p.door, L = e.len / 2 + 0.03, W = e.wid / 2 + 0.03;
  const Q = (u, v) => f.at(u, v);
  B.wall(tileKey, Q(-L, -W), Q(L, -W), ym, yH, { n: [-f.sx, -f.sz] });
  B.wall(tileKey, Q(-L, W), Q(L, W), ym, yH, { n: [f.sx, f.sz] });
  B.wall(tileKey, Q(-L, -W), Q(-L, W), ym, yH, { n: [-f.dx, -f.dz] });
  if (closed) {
    B.wall(tileKey, Q(L, -W), Q(L, W), ym, yH, { n: [f.dx, f.dz] });
    return;
  }
  const dw = d.dw + 0.08, top = Math.min(yH, d.yb + d.dh + 0.08);
  B.wall(tileKey, Q(L, -W), Q(L, -dw), ym, yH, { n: [f.dx, f.dz] });
  B.wall(tileKey, Q(L, dw), Q(L, W), ym, yH, { n: [f.dx, f.dz] });
  if (top < yH - 0.01) B.wall(tileKey, Q(L, -dw), Q(L, dw), top, yH, { n: [f.dx, f.dz] });
  if (d.yb > ym + 0.02) B.wall('granite', Q(L, -dw), Q(L, dw), ym, d.yb, { n: [f.dx, f.dz] });
  // 扉の口の縁（ステンレス）
  for (const v of [-dw, dw]) {
    const [x, z] = Q(L + 0.02, v);
    B.box('steel', x, z, d.yb, top, f.dx, f.dz, 0.06, 0.1);
  }
  const [x, z] = Q(L + 0.02, 0);
  B.box('steel', x, z, top - 0.08, top, f.sx, f.sz, 2 * dw + 0.1, 0.06);
}

// 出入口の扉の前の数段の階段（扉の高さから改札階の床へ）
function doorStepsMesh(B, ds) {
  const d = ds.door, h = ds.w / 2, st = ds.st;
  const P = (u, v) => [d.x + d.dx * u + d.sx * v, d.z + d.dz * u + d.sz * v];
  const y = (k) => ds.y0 + ((ds.y1 - ds.y0) * k) / st.n;
  const per = Math.ceil(st.n / st.flights);
  B.floor('darkGranite', [P(0, -h), P(0.2, -h), P(0.2, h), P(0, h)], ds.y0);
  const side = (u0, u1, yy) => {
    for (const v of [-h, h]) B.wall('granite', P(u0, v), P(u1, v), ds.y1, yy, { n: [d.sx * Math.sign(v), d.sz * Math.sign(v)] });
  };
  side(0, 0.2, ds.y0);
  let u = 0.2, k = 0;
  for (let fl = 0; fl < st.flights; fl++) {
    const steps = Math.min(per, st.n - k);
    for (let i = 0; i < steps; i++) {
      const yy = y(k + i + 1);
      B.wall('granite', P(u, -h), P(u, h), yy, y(k + i), { n: [d.dx, d.dz] });
      if (k + i + 1 < st.n) {
        B.floor('darkGranite', [P(u, -h), P(u + TREAD, -h), P(u + TREAD, h), P(u, h)], yy);
        side(u, u + TREAD, yy);
      }
      u += TREAD;
    }
    k += steps;
    if (fl + 1 < st.flights) {
      B.floor('darkGranite', [P(u, -h), P(u + MID_LANDING, -h), P(u + MID_LANDING, h), P(u, h)], y(k));
      side(u, u + MID_LANDING, y(k));
      u += MID_LANDING;
    }
  }
  // 両側の手すり
  for (const v of [-h + 0.05, h - 0.05]) {
    const a = P(0.1, v), b = P(0.2 + st.run, v);
    B.bar('steel', [a[0], ds.y0 + 0.9, a[1]], [b[0], ds.y1 + 0.9, b[1]], 0.045);
    for (const [pp, yy] of [[a, ds.y0], [b, ds.y1]]) B.bar('steel', [pp[0], yy, pp[1]], [pp[0], yy + 0.9, pp[1]], 0.04);
  }
}

function stairsMesh(B, s) {
  const f = s.frame, at = f.at, d = s.dirS;
  const per = Math.ceil(s.n / s.flights);
  let u = 0, k = 0;
  const y = (kk) => s.y0 + ((s.y1 - s.y0) * kk) / s.n;
  const tread = (u0, u1, yy) => {
    B.floor('darkGranite', rect(at, s.s0 + u0 * d, s.s0 + u1 * d, s.t0, s.t1), yy);
  };
  for (let fl = 0; fl < s.flights; fl++) {
    const steps = Math.min(per, s.n - k);
    for (let i = 0; i < steps; i++) {
      const yy = y(k + i + 1);
      tread(u, u + TREAD, yy);
      // 蹴上げ（上の段から）
      B.wall('granite', at(s.s0 + u * d, s.t0), at(s.s0 + u * d, s.t1), yy, y(k + i), { n: [-f.ax * d, -f.az * d] });
      // 段鼻の黒い線
      const [x, z] = at(s.s0 + (u + 0.03) * d, (s.t0 + s.t1) / 2);
      B.box('paint', x, z, yy, yy + 0.006, f.ax, f.az, 0.05, s.t1 - s.t0, { color: C.black });
      u += TREAD;
    }
    k += steps;
    if (fl + 1 < s.flights) {
      tread(u, u + MID_LANDING, y(k));
      u += MID_LANDING;
    }
  }
  if (s.len > s.run + 0.01) tread(s.run, s.len, s.y1);
  // 手すり（両側。床から 0.9 m）
  for (const t of [s.t0 + 0.05, s.t1 - 0.05]) {
    let prev = null;
    for (let uu = 0; uu <= s.run + 0.01; uu += 1) {
      const yy = flightHeight(Math.min(uu, s.run), s.run, s.y0, s.y1, s.n, s.flights) + 0.9;
      const [x, z] = at(s.s0 + uu * d, t);
      if (prev) B.bar('steel', prev, [x, yy, z], 0.045);
      prev = [x, yy, z];
    }
  }
}

function escalatorMesh(B, s) {
  const f = s.frame, at = f.at, d = s.dirS, run = s.run;
  const yAt = (u) => escalatorHeight(u, run, s.y0, s.y1);
  // 段（黒いアルミ。1 m ごとの斜面）
  for (let u = 0; u < run - 1e-6; u += 0.5) {
    const u1 = Math.min(run, u + 0.5);
    const p = (uu, t) => [...pt3(at(s.s0 + uu * d, t), yAt(uu))];
    const a = p(u, s.t0 + 0.1), b = p(u1, s.t0 + 0.1), c = p(u1, s.t1 - 0.1), e = p(u, s.t1 - 0.1);
    B.quad('paint', a, b, c, e, [0, 1, 0], { color: [0.2, 0.21, 0.22] });
  }
  if (s.len > run + 0.01) B.floor('paint', rect(at, s.s0 + run * d, s.s0 + s.len * d, s.t0, s.t1), s.y1, { color: [0.4, 0.4, 0.42] });
  // 欄干（ステンレスの板）と黒い手すり
  for (const t of [s.t0 + 0.04, s.t1 - 0.04]) {
    for (let u = 0; u < run - 1e-6; u += 1) {
      const u1 = Math.min(run, u + 1);
      const a = at(s.s0 + u * d, t), b = at(s.s0 + u1 * d, t);
      B.wall('steel', a, b, yAt(u), yAt(u) + 0.95, { n: [f.nx, f.nz], yb: [yAt(u1), yAt(u1) + 0.95] });
      B.bar('paint', [a[0], yAt(u) + 1.0, a[1]], [b[0], yAt(u1) + 1.0, b[1]], 0.08, { color: C.black });
    }
  }
}

function gatesMesh(B, signs, g, ym, plan) {
  const f = g.frame, at = f.at, lanes = gateLanes(g), yH = ym + HALL_H;
  // 改札の箱（ステンレス、上は黒）
  const housings = [];
  let t = lanes[0][0] - 0.3;
  for (const [a, b] of lanes) {
    housings.push([t, a]);
    t = b;
  }
  housings.push([t, t + 0.3]);
  for (const [a, b] of housings) {
    const [x, z] = at(g.s, (a + b) / 2);
    B.box('steel', x, z, ym, ym + 0.98, f.ax, f.az, 1.4, b - a);
    B.box('paint', x, z, ym + 0.98, ym + 1.02, f.ax, f.az, 1.4, b - a, { color: C.black });
  }
  // 通路ごとのランプ（入る通路は改札の外の側が緑の矢印・中の側が赤、出る通路は逆）と三脚
  lanes.forEach(([a, b], k) => {
    const entry = g.both ? k % 2 === 0 : true;
    for (const sg of [1, -1]) {
      const outside = sg * g.side < 0; // 改札の外の側の面
      const [lx, lz] = at(g.s + sg * 0.701, a - 0.15);
      B.box(outside === entry ? 'green' : 'red', lx, lz, ym + 0.75, ym + 0.83, f.nx, f.nz, 0.1, 0.004);
    }
    const [x, z] = at(g.s, a + 0.02);
    for (let i = 0; i < 3; i++) {
      const ang = (i / 3) * Math.PI * 2;
      const dir = [Math.cos(ang) * 0.3, Math.sin(ang) * 0.3];
      const tip = at(g.s + dir[0] * 0.4, a + 0.05 + 0.45);
      B.bar('steel', [x, ym + 0.88, z], [tip[0], ym + 0.88 + dir[1] * 0.5, tip[1]], 0.035);
    }
    void b;
  });
  // ガラスの仕切り（改札の両脇から壁まで）
  for (const [a, b] of [[g.t0, housings[0][0]], [housings[housings.length - 1][1], g.t1]]) {
    if (b - a < 0.05) continue;
    const [x, z] = at(g.s, (a + b) / 2);
    B.box('glass', x, z, ym, ym + 1.15, f.nx, f.nz, b - a, 0.02);
    B.box('steel', x, z, ym + 1.15, ym + 1.2, f.nx, f.nz, b - a, 0.05);
    B.box('steel', x, z, ym, ym + 0.06, f.nx, f.nz, b - a, 0.05);
  }
  // 改札の上の案内（改札の外の側を向く）: 1 つの線の駅は左右の方面、十字の駅はその改札の方面。中の側には出口
  const [hx, hz] = at(g.s - g.side * 0.8, 0);
  if (g.both) {
    const L = plan.lines.find((q) => q.line === g.line);
    const name = (side) => L.dirs.find((d) => d.side === side).terminus?.name || '';
    const key = signs.material(`gate-${g.line}-${g.end}`, 4.6, 0.45, gateSignDraw(g.line, name(g.end), name(-g.end)));
    hangSign(B, signs, key, [hx, hz], yH - 0.75, [-f.nx * g.end, -f.nz * g.end], 4.6, 0.45, yH, true);
  } else {
    const term = g.dir?.terminus?.name || '';
    const key = signs.material(`gate-${g.line}-${g.side}`, 3.4, 0.45, directionDraw(g.line, term, { arrow: '' }));
    hangSign(B, signs, key, [hx, hz], yH - 0.75, [f.nx, f.nz], 3.4, 0.45, yH);
  }
  const [ex, ez] = at(g.s + g.side * 0.8, 0);
  const exitKey = signs.material('exit-gate', 1.8, 0.45, exitDraw(''));
  hangSign(B, signs, exitKey, [ex, ez], yH - 0.75, [f.nx, f.nz], 1.8, 0.45, yH);
}

// 改札の外のホールの備品: 券売機（壁ぎわ）、出口の吊り看板（通路の口・出入口の扉の前）、駅名の板、作品
function hallFurniture(B, signs, plan, style, pits, streetAt) {
  const ym = plan.ym, yH = ym + HALL_H;
  const halls = plan.rects.filter((r) => r.kind === 'unpaid');
  const inHall = (x, z) => halls.some((r) => inRect(r, x, z, 0));
  // 物を置けない所: 通路の口の前、出入口の吹き抜けと扉の前、改札の前
  const busy = (x, z, m = 0) => {
    for (const o of plan.openings) if (segDist(x, z, o.a, o.b) < o.w / 2 + 1.2 + m) return true;
    for (const p of pits) {
      if (inPit(p, x, z, 0.5 + m)) return true;
      const d = p.door, u = (x - d.x) * d.dx + (z - d.z) * d.dz, v = (x - d.x) * d.sx + (z - d.z) * d.sz;
      if (u > -0.5 && u < 4.5 + m && Math.abs(v) < d.dw + 1.2 + m) return true;
    }
    for (const g of plan.gates) {
      const [s, t] = g.frame.local(x, z);
      if (Math.abs(s - g.s) < 2.8 + m && t > g.t0 - 1 && t < g.t1 + 1) return true;
    }
    return false;
  };
  // 壁ぎわの置き場所（外周の壁の、改札の外のホールの側）: { x, z, n: 内向き, u: 壁の向き, wall }
  const spots = [];
  hallBoundary(plan).forEach(([a, b], wi) => {
    const dx = b[0] - a[0], dz = b[1] - a[1], l = Math.hypot(dx, dz);
    if (l < 1.2) return;
    const ux = dx / l, uz = dz / l;
    let n = [-uz, ux];
    const mx = (a[0] + b[0]) / 2, mz = (a[1] + b[1]) / 2;
    if (!plan.rects.some((r) => inRect(r, mx + n[0] * 0.2, mz + n[1] * 0.2))) n = [-n[0], -n[1]];
    if (!inHall(mx + n[0] * 0.3, mz + n[1] * 0.3)) return;
    for (let u = 0.6; u <= l - 0.6 + 1e-6; u += 0.9) spots.push({ x: a[0] + ux * u, z: a[1] + uz * u, n, u: [ux, uz], wall: wi, at: u, len: l });
  });
  const free = (sp, depth, m = 0) => !busy(sp.x + sp.n[0] * depth, sp.z + sp.n[1] * depth, m) && inHall(sp.x + sp.n[0] * depth, sp.z + sp.n[1] * depth);
  const used = new Set();
  // 券売機（赤と白。2〜3 台並べる）: 改札に近い壁ぎわ
  const tk = signs.material('ticket', 0.75, 1.75, ticketDraw());
  const gate = plan.gates[0];
  const gp = gate ? gate.frame.at(gate.s, 0) : [plan.station.x, plan.station.z];
  for (const r of halls) {
    const cand = spots.filter((sp) => inRect(r, sp.x + sp.n[0] * 0.3, sp.z + sp.n[1] * 0.3, 0) && free(sp, 0.3, 0.3))
      .sort((p, q) => Math.hypot(p.x - gp[0], p.z - gp[1]) - Math.hypot(q.x - gp[0], q.z - gp[1]));
    let placed = 0;
    for (const sp of cand) {
      if (placed >= 3) break;
      const key = `${sp.wall}:${sp.at.toFixed(1)}`;
      if (used.has(key)) continue;
      if (placed && !spots.some((q) => q.wall === sp.wall && used.has(`${q.wall}:${q.at.toFixed(1)}`) && Math.abs(q.at - sp.at) < 1)) continue;
      used.add(key);
      placed++;
      const x = sp.x + sp.n[0] * 0.27, z = sp.z + sp.n[1] * 0.27;
      B.box('paint', x, z, ym, ym + 1.8, sp.u[0], sp.u[1], 0.8, 0.5, { color: C.ticketRed });
      signs.panel(tk, x + sp.n[0] * 0.251, ym + 0.95, z + sp.n[1] * 0.251, sp.n[1], -sp.n[0], 0.75, 1.7, sp.n[0], sp.n[1], 0);
      const r2 = 0.3;
      for (const [p, q] of [[[-0.42, -r2], [0.42, -r2]], [[0.42, -r2], [0.42, r2]], [[0.42, r2], [-0.42, r2]], [[-0.42, r2], [-0.42, -r2]]]) {
        const P = (k) => [x + sp.u[0] * k[0] + sp.n[0] * k[1], z + sp.u[1] * k[0] + sp.n[1] * k[1]];
        const [A, Bq] = [P(p), P(q)];
        plan.nav?.addWall(A[0], A[1], Bq[0], Bq[1], ym - 0.2, ym + 1.8);
      }
    }
  }
  // 出口の吊り看板: 通路の口と、ホールの中の出入口の扉の前（通りの名前）
  for (const o of plan.openings) {
    const c = plan.corridors.find((q) => q.idx === o.idx);
    const street = c ? streetAt(c.door.e.x, c.door.e.z) || '' : '';
    const mx = (o.a[0] + o.b[0]) / 2 + o.n[0] * 1.2, mz = (o.a[1] + o.b[1]) / 2 + o.n[1] * 1.2;
    const dx = o.b[0] - o.a[0], dz = o.b[1] - o.a[1], l = Math.hypot(dx, dz);
    const key = signs.material(`exit-${o.idx}`, 2.0, 0.5, exitDraw(street));
    hangSign(B, signs, key, [mx, mz], yH - 0.6, [dx / l, dz / l], 2.0, 0.5, yH);
  }
  pits.forEach((p, i) => {
    const d = p.door, street = streetAt(p.e.x, p.e.z) || '';
    const key = signs.material(`exit-pit-${i}`, 2.0, 0.5, exitDraw(street));
    hangSign(B, signs, key, [d.x + d.dx * 1.4, d.z + d.dz * 1.4], yH - 0.6, [d.sx, d.sz], 2.0, 0.5, yH);
  });
  // 駅名の板と壁画（長い壁の空いている所）
  const nameKey = signs.material('name', 2.4, 0.6, nameDraw(plan.station.name, style.accent));
  const muralKey = signs.material('mural', 3.0, 1.8, muralDraw(plan.station, style.accent));
  const walls = new Map();
  for (const sp of spots) if (!used.has(`${sp.wall}:${sp.at.toFixed(1)}`)) (walls.get(sp.wall) || walls.set(sp.wall, []).get(sp.wall)).push(sp);
  let names = 0, murals = 0;
  for (const list of [...walls.values()].sort((p, q) => q.length - p.length)) {
    // 壁の中で、続けて空いている所（板の幅ぶん）
    const ok = list.filter((sp) => free(sp, 0.4, 0.2));
    const pick = (w) => ok.find((sp) => ok.filter((q) => Math.abs(q.at - sp.at) <= w / 2 + 0.01).length >= Math.floor(w / 0.9));
    if (style.art === 'mural' && murals < 1) {
      const sp = pick(3.4);
      if (sp) {
        murals++;
        signs.panel(muralKey, sp.x + sp.n[0] * 0.02, ym + 1.65, sp.z + sp.n[1] * 0.02, sp.n[1], -sp.n[0], 3.0, 1.8, sp.n[0], sp.n[1], 0);
        continue;
      }
    }
    if (names < 2) {
      const sp = pick(2.6);
      if (sp) {
        names++;
        signs.panel(nameKey, sp.x + sp.n[0] * 0.02, ym + 2.55, sp.z + sp.n[1] * 0.02, sp.n[1], -sp.n[0], 2.4, 0.6, sp.n[0], sp.n[1], 0);
      }
    }
  }
  // 作品
  const center = (() => {
    const r = halls.reduce((a, b) => ((b.s1 - b.s0) * (b.t1 - b.t0) > (a.s1 - a.s0) * (a.t1 - a.t0) ? b : a), halls[0]);
    return { r, at: r.frame.at((r.s0 + r.s1) / 2, (r.t0 + r.t1) / 2) };
  })();
  if (style.art === 'devise') {
    // Palais de Justice: 長い壁に「LIBERTÉ · ÉGALITÉ · FRATERNITÉ」
    const key = signs.material('devise', 7.2, 0.7, (x, W, H) => {
      x.fillStyle = '#f4f2ec';
      x.fillRect(0, 0, W, H);
      x.fillStyle = '#1b2a5c';
      x.textAlign = 'center';
      x.textBaseline = 'middle';
      fitText(x, 'LIBERTÉ · ÉGALITÉ · FRATERNITÉ', W * 0.94, H * 0.62, '700', 'Georgia, "Times New Roman", serif');
      x.fillText('LIBERTÉ · ÉGALITÉ · FRATERNITÉ', W / 2, H * 0.54);
    });
    const list = [...walls.values()].sort((p, q) => q.length - p.length)[0] || [];
    const ok = list.filter((sp) => free(sp, 0.4, 0));
    const sp = ok[Math.floor(ok.length / 2)];
    if (sp && ok.length >= 8) signs.panel(key, sp.x + sp.n[0] * 0.02, ym + 2.9, sp.z + sp.n[1] * 0.02, sp.n[1], -sp.n[0], 7.2, 0.7, sp.n[0], sp.n[1], 0);
  } else if (style.art === 'pink') {
    // Compans-Caffarelli: ばら色に光る柱（改札の外のホールに 4 本）
    const r = center.r;
    for (const [a, b] of [[0.3, 0.3], [0.7, 0.3], [0.3, 0.7], [0.7, 0.7]]) {
      const [x, z] = r.frame.at(r.s0 + (r.s1 - r.s0) * a, r.t0 + (r.t1 - r.t0) * b);
      if (busy(x, z, 0.6)) continue;
      B.cyl('pink', x, z, ym, yH, 0.22, { seg: 16 });
      for (let k = 0; k < 8; k++) {
        const a0 = (k / 8) * Math.PI * 2, a1 = ((k + 1) / 8) * Math.PI * 2;
        plan.nav?.addWall(x + Math.cos(a0) * 0.3, z + Math.sin(a0) * 0.3, x + Math.cos(a1) * 0.3, z + Math.sin(a1) * 0.3, ym - 0.2, yH);
      }
    }
  } else if (style.art === 'halo') {
    // Patte d'Oie: 天井の大きな丸い照明（光の輪）
    const [x, z] = center.at;
    B.cyl('light', x, z, yH - 0.12, yH - 0.02, 1.6, { seg: 40 });
    B.cyl('paint', x, z, yH - 0.16, yH - 0.12, 1.75, { seg: 40, color: C.darkSteel });
    B.floor('light', Array.from({ length: 40 }, (_, k) => [x + Math.cos((k / 40) * Math.PI * 2) * 1.6, z + Math.sin((k / 40) * Math.PI * 2) * 1.6]), yH - 0.12, { up: false });
  }
  if (style.art === 'cone') {
    // Esquirol の銅色の円錐の柱（改札の外のホールの真ん中）
    const r = halls[0], [x, z] = r.frame.at((r.s0 + r.s1) / 2, (r.t0 + r.t1) / 2);
    if (!busy(x, z, 0.5)) {
      const segs = 6;
      for (let k = 0; k < segs; k++) {
        const y0 = ym + (HALL_H * k) / segs, y1 = ym + (HALL_H * (k + 1)) / segs;
        B.cyl('copper', x, z, y0, y1, 0.85 - (0.45 * (k + 0.5)) / segs, { seg: 24, color: C.copper });
      }
      for (let k = 0; k < 12; k++) {
        const a0 = (k / 12) * Math.PI * 2, a1 = ((k + 1) / 12) * Math.PI * 2;
        plan.nav?.addWall(x + Math.cos(a0) * 0.9, z + Math.sin(a0) * 0.9, x + Math.cos(a1) * 0.9, z + Math.sin(a1) * 0.9, ym - 0.2, yH);
      }
    }
  } else if (style.art === 'columns' && plan.hall) {
    const at = plan.rects[0].frame.at;
    for (const [s, t] of [[-6, -6], [6, -6], [-6, 6], [6, 6]]) {
      const [x, z] = at(s, t);
      B.cyl('concrete', x, z, ym, yH, 0.45, { seg: 20, color: [0.86, 0.86, 0.84] });
    }
  }
}

function corridorMesh(B, signs, c, tileKey, streetAt) {
  const prof = corridorProfile(c);
  const { L, R } = offsetPolyline(c.pts, c.w);
  const n = c.pts.length;
  const pieces = corridorPieces(c);
  const yAtU = (u) => (prof.ramp ? c.yTop + ((c.yBot - c.yTop) * u) / pieces.find((q) => q.kind === 'rect' && q.seg === prof.segment).len
    : u <= prof.flat0 ? c.yTop : u >= prof.flat0 + prof.run ? c.yBot : flightHeight(u - prof.flat0, prof.run, c.yTop, c.yBot, c.stair.n, c.stair.flights));
  for (const pc of pieces) {
    if (pc.kind === 'joint' || pc.seg !== prof.segment) {
      const y = pc.kind === 'joint' && pc.seg === n - 1 ? c.yBot : c.yTop;
      B.floor('floor', pc.poly, y);
      B.floor('ceiling', pc.poly, y + CORR_H, { up: false });
      if (pc.kind === 'rect') {
        const [cx, cz] = pc.at(pc.len / 2, 0);
        B.box('light', cx, cz, y + CORR_H - 0.06, y + CORR_H - 0.005, pc.ux, pc.uz, Math.max(0.5, pc.len - 1.2), 0.12);
      }
      continue;
    }
    // 階段の区間: 平ら・段・平ら。天井は 1 m ごとに段の高さ + CORR_H
    const { at, len } = pc;
    for (let u = 0; u < len - 1e-6; u += 1) {
      const u1 = Math.min(len, u + 1);
      const ya = yAtU(u), yb = yAtU(u1);
      B.quad('ceiling', [...pt3(at(u, -1), ya + CORR_H)], [...pt3(at(u1, -1), yb + CORR_H)], [...pt3(at(u1, 1), yb + CORR_H)], [...pt3(at(u, 1), ya + CORR_H)], [0, -1, 0]);
    }
    if (prof.ramp) B.floor('floor', pc.poly, (x, z) => yAtU(pc.along(x, z)));
    else {
      B.floor('floor', [at(0, -1), at(prof.flat0, -1), at(prof.flat0, 1), at(0, 1)], c.yTop);
      B.floor('floor', [at(prof.flat0 + prof.run, -1), at(len, -1), at(len, 1), at(prof.flat0 + prof.run, 1)], c.yBot);
      const per = Math.ceil(c.stair.n / c.stair.flights);
      let u = prof.flat0, k = 0;
      for (let fl = 0; fl < c.stair.flights; fl++) {
        const steps = Math.min(per, c.stair.n - k);
        for (let i = 0; i < steps; i++) {
          const y0 = c.yTop + ((c.yBot - c.yTop) * (k + i)) / c.stair.n, y1 = c.yTop + ((c.yBot - c.yTop) * (k + i + 1)) / c.stair.n;
          B.floor('darkGranite', [at(u, -1), at(u + TREAD, -1), at(u + TREAD, 1), at(u, 1)], y1);
          B.wall('granite', at(u, -1), at(u, 1), y1, y0, { n: [-pc.ux, -pc.uz] });
          u += TREAD;
        }
        k += steps;
        if (fl + 1 < c.stair.flights) {
          const yy = c.yTop + ((c.yBot - c.yTop) * k) / c.stair.n;
          B.floor('darkGranite', [at(u, -1), at(u + MID_LANDING, -1), at(u + MID_LANDING, 1), at(u, 1)], yy);
          u += MID_LANDING;
        }
      }
      // 手すり
      for (const v of [-0.96, 0.96]) {
        let prev = null;
        for (let uu = prof.flat0; uu <= prof.flat0 + prof.run + 0.01; uu += 1) {
          const yy = yAtU(Math.min(uu, prof.flat0 + prof.run)) + 0.9;
          const [x, z] = at(Math.min(uu, prof.flat0 + prof.run), v);
          if (prev) B.bar('steel', prev, [x, yy, z], 0.045);
          prev = [x, yy, z];
        }
      }
    }
    const [cx, cz] = at(len / 2, 0);
    void cx;
    void cz;
  }
  // 壁（左右。留め継ぎの折れ線。階段の区間は 1 m ごとに段の高さから）
  for (let i = 0; i + 1 < n; i++) {
    for (const [A, Bp, inward] of [[L[i], L[i + 1], -1], [R[i], R[i + 1], 1]]) {
      const pc = pieces.find((q) => q.kind === 'rect' && q.seg === i);
      const nn = [-pc.uz * inward, pc.ux * inward]; // 通路の内側を向く
      if (i !== prof.segment) {
        B.wall(tileKey, A, Bp, c.yTop, c.yTop + CORR_H, { n: nn });
        continue;
      }
      const len = Math.hypot(Bp[0] - A[0], Bp[1] - A[1]), m = Math.max(1, Math.ceil(len));
      for (let k = 0; k < m; k++) {
        const p0 = [A[0] + ((Bp[0] - A[0]) * k) / m, A[1] + ((Bp[1] - A[1]) * k) / m], p1 = [A[0] + ((Bp[0] - A[0]) * (k + 1)) / m, A[1] + ((Bp[1] - A[1]) * (k + 1)) / m];
        const ya = yAtU(Math.max(0, Math.min(pc.len, pc.along(...p0)))), yb = yAtU(Math.max(0, Math.min(pc.len, pc.along(...p1))));
        B.wall(tileKey, p0, p1, Math.min(ya, yb) - 0.2, ya + CORR_H, { n: nn, yb: [Math.min(ya, yb) - 0.2, yb + CORR_H] });
      }
    }
  }
  // 出口の看板（扉の手前。通りの名前）
  const [ex, ez] = c.pts[0];
  const street = streetAt(c.door.e.x, c.door.e.z) || '';
  c.street = street;
  const key = signs.material(`sortie-${c.idx}`, 1.8, 0.45, exitDraw(street));
  const p1 = c.pts[1], dx = p1[0] - ex, dz = p1[1] - ez, dl = Math.hypot(dx, dz) || 1;
  hangSign(B, signs, key, [ex + (dx / dl) * 1.0, ez + (dz / dl) * 1.0], c.yTop + CORR_H - 0.45, [-dz / dl, dx / dl], 1.8, 0.45, c.yTop + CORR_H);
}

export { LINE_COLORS, drawMetroLogo, ESC_FLAT, RISE };
// OSM の間取りの駅（osmmesh.js）で使う部品
export { C as STATION_COLORS, Signs, nameDraw, directionDraw, exitDraw, gateSignDraw, muralDraw, hashId, POSTERS, networkMapDraw, ledDisplay, ticketDraw, buildPSD, bench, hangSign };
