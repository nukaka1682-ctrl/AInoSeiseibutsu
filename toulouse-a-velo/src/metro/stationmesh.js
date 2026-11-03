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
import { CORR_H, ESC_FLAT, HALL_H, PLAT_H, RISE, TREAD, MID_LANDING, corridorPieces, corridorProfile, escalatorHeight, flightHeight, gateLanes, hallBoundary, inRect, offsetPolyline } from './stationplan.js';
import { drawLineBadge, drawMetroLogo, fitText, metroTextures, signTexture, stripedTileTexture } from './textures.js';
import { entranceDoor } from '../world/metro.js';
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
  if (station.id === 'jean-jaures') Object.assign(style, { accent: '#4b4f55', hallFloor: 'darkGranite', art: 'columns' });
  if (station.id === 'marengo') Object.assign(style, { accent: '#222222' });
  return style;
}

let shared = null;
export function stationMaterials() {
  if (shared) return shared;
  const t = metroTextures();
  const std = (o) => new THREE.MeshStandardMaterial({ vertexColors: true, ...o });
  shared = {
    floor: std({ map: t.floor, roughness: 0.42 }),
    granite: std({ map: t.granite, roughness: 0.38 }),
    darkGranite: std({ map: t.darkGranite, roughness: 0.38 }),
    tile: std({ map: t.tile, roughness: 0.28 }),
    ceiling: std({ map: t.perforated, roughness: 0.55, metalness: 0.4 }),
    darkCeiling: std({ map: t.darkPerforated, roughness: 0.7, metalness: 0.3 }),
    steel: std({ map: t.brushed, roughness: 0.32, metalness: 0.85 }),
    paint: std({ roughness: 0.6 }),
    gloss: std({ roughness: 0.25 }),
    concrete: std({ map: t.concrete, roughness: 0.9 }),
    dark: std({ roughness: 0.9, color: '#ffffff' }),
    copper: std({ roughness: 0.3, metalness: 0.9 }),
    glass: new THREE.MeshStandardMaterial({ color: '#c9d6d4', roughness: 0.05, metalness: 0.1, transparent: true, opacity: 0.16, depthWrite: false, side: THREE.DoubleSide }),
    light: new THREE.MeshBasicMaterial({ color: '#fffaf0' }),
    green: new THREE.MeshBasicMaterial({ color: '#29d36a' }),
    red: new THREE.MeshBasicMaterial({ color: '#ff3b30' }),
  };
  return shared;
}

// 照明の焼き込み: 天井は暗め、床は明るめ、壁は下ほど少し暗い（床との隅）
function bakeLight(floorYs) {
  return (x, y, z, nx, ny) => {
    if (ny < -0.5) return 0.95;
    if (ny > 0.5) return 1.0;
    let near = Infinity;
    for (const fy of floorYs) if (y >= fy - 0.3) near = Math.min(near, y - fy);
    const ao = near < 0.5 ? 0.82 + 0.36 * Math.max(0, near) : 1;
    return 0.95 * ao;
  };
}

// 文字の板の材質（同じ文字は 1 つ）
class Signs {
  constructor() {
    this.cache = new Map();
    this.builder = new Builder();
  }

  material(key, w, h, draw) {
    if (!this.cache.has(key)) {
      const map = signTexture(w, h, draw);
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

function exitDraw(street) {
  return (x, W, H) => {
    x.fillStyle = '#f7c600';
    x.fillRect(0, 0, W, H);
    x.fillStyle = '#1b1b1b';
    x.textBaseline = 'middle';
    x.textAlign = 'left';
    x.font = `800 ${Math.round(H * 0.5)}px "Helvetica Neue", Arial, sans-serif`;
    x.fillText('Sortie', H * 0.3, H * (street ? 0.36 : 0.53));
    if (street) {
      fitText(x, street, W - H * 0.6, H * 0.3, '600');
      x.fillText(street, H * 0.3, H * 0.76);
    }
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
export function buildStationMesh(plan, { streetAt = () => '' } = {}) {
  const mats = stationMaterials();
  const style = stationStyle(plan.station);
  const tileKey = `tile:${style.accent}`;
  const mtl = { ...mats, [tileKey]: Object.assign(mats.tile.clone(), { map: stripedTileTexture(style.accent) }) };
  const B = new Builder(), signs = new Signs();
  const { hall, ym } = plan, WT = hall.WT, P = LAYOUT.psd;
  const st = plan.station;
  const nameKey = signs.material('name', 2.4, 0.6, nameDraw(st.name, style.accent));
  const doorsMeshes = [];

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
      // 吊り看板: 出口（階段の下の端の前）と方面（ホームの真ん中）
      const sBot = well.s1; // 吹き抜けの奥の端（階段の下）
      const exitKey = signs.material('exit-plat', 1.6, 0.4, exitDraw(''));
      hangSign(B, signs, exitKey, T(sBot + side * 1.5, (P + WT) / 2 * side), yc - 0.9, [f.nx, f.nz], 1.6, 0.4, yCeil);
      const dirKey = signs.material(`dir-${L.line}-${side}`, 3.2, 0.42, directionDraw(L.line, term));
      hangSign(B, signs, dirKey, T(-sign(side) * 8, (P + WT) / 2 * side), yc - 0.9, [f.nx, f.nz], 3.2, 0.42, yCeil);
    }
    // 線路（走行路・案内軌条・中央の柱）
    trackZone(B, L, plan, style);
  }

  // ---------------------------------------------------------------- 改札階
  const hallKey = style.hallFloor;
  for (const r of plan.rects) {
    const at = r.frame.at;
    const well = plan.wells.find((w) => r.kind === 'wing' && w.line === r.line && w.side === r.side);
    const pieces = [];
    if (!well) pieces.push([r.s0, r.s1, r.t0, r.t1]);
    else {
      const ws0 = Math.min(well.s0, well.s1), ws1 = Math.max(well.s0, well.s1);
      const tFree = well.side > 0 ? [r.t0, well.t0] : [well.t1, r.t1], tw = well.side > 0 ? [well.t0, r.t1] : [r.t0, well.t1];
      pieces.push([r.s0, r.s1, ...tFree]);
      if (ws0 > r.s0 + 0.01) pieces.push([r.s0, ws0, ...tw]);
      if (ws1 < r.s1 - 0.01) pieces.push([ws1, r.s1, ...tw]);
    }
    for (const [s0, s1, t0, t1] of pieces) {
      B.floor(hallKey, rect(at, s0, s1, t0, t1), ym + (r.kind === 'wing' ? 0.003 : 0));
      B.floor('ceiling', rect(at, s0, s1, t0, t1), ym + HALL_H, { up: false });
    }
    if (well) B.floor('ceiling', rect(at, Math.min(well.s0, well.s1), Math.max(well.s0, well.s1), well.t0, well.t1), ym + HALL_H, { up: false });
    // 照明の帯（長い向き）
    for (const tl of [-(r.t1 - r.t0) / 4, (r.t1 - r.t0) / 4]) {
      const tm = (r.t0 + r.t1) / 2 + tl;
      const [cx, cz] = at((r.s0 + r.s1) / 2, tm);
      B.box('light', cx, cz, ym + HALL_H - 0.07, ym + HALL_H - 0.005, r.frame.ax, r.frame.az, r.s1 - r.s0 - 1.5, 0.14);
    }
  }
  // 外周の壁（内側を向く）
  for (const [a, b] of hallBoundary(plan)) {
    const mx = (a[0] + b[0]) / 2, mz = (a[1] + b[1]) / 2, dx = b[0] - a[0], dz = b[1] - a[1], l = Math.hypot(dx, dz);
    let n = [-dz / l, dx / l];
    if (!plan.rects.some((r) => inRect(r, mx + n[0] * 0.2, mz + n[1] * 0.2))) n = [-n[0], -n[1]];
    B.wall(tileKey, a, b, ym, ym + HALL_H, { n });
  }
  // 吹き抜け: 縁・手すり・階段・エスカレーター
  for (const w of plan.wells) wellMesh(B, plan, w, mats);
  for (const s of plan.stairs) {
    if (s.kind === 'stairs') stairsMesh(B, s);
    else escalatorMesh(B, s);
  }
  // 改札
  for (const g of plan.gates) gatesMesh(B, signs, g, ym, plan);
  // 券売機と作品（コンコースの壁ぎわ）
  concourseFurniture(B, signs, plan, style);

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
  const group = B.build(mtl, { light: bakeLight(floorYs), name: `station-${st.id}` });
  group.add(signs.build());
  for (const d of doorsMeshes) group.add(d.group);
  return { group, doors: doorsMeshes, style };
}

function sign(v) {
  return v >= 0 ? 1 : -1;
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
function hangSign(B, signs, key, c, y, along, w, h, yCeil) {
  const [x, z] = c, [ux, uz] = along, nx = -uz, nz = ux;
  B.box('paint', x, z, y - h / 2, y + h / 2, ux, uz, w + 0.04, 0.06, { color: C.darkSteel });
  signs.panel(key, x, y, z, ux, uz, w, h, nx, nz, 0.032);
  signs.panel(key, x, y, z, -ux, -uz, w, h, -nx, -nz, 0.032);
  for (const k of [-w / 2 + 0.15, w / 2 - 0.15]) B.bar('steel', [x + ux * k, y + h / 2, z + uz * k], [x + ux * k, yCeil, z + uz * k], 0.025);
}

// ホームドア: 扉の位置に開け閉めする扉（InstancedMesh）、そのあいだにガラスの板、上に「DIRECTION 〜」の帯
function buildPSD(B, signs, L, side, term, mats) {
  const f = L.frame, at = f.at, yp = L.yp, P = LAYOUT.psd * side, yc = yp + PLAT_H;
  const half = L.psdHalf, Lb = L.Lb;
  const n = [f.nx * side, f.nz * side]; // ホームの側を向く
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
      signs.panel(key, hx + n[0] * 0.081, yp + 2.62, hz + n[1] * 0.081, f.ax * side, f.az * side, 3.0, 0.26, n[0], n[1], 0);
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
  const tLeaf = P - 0.06 * side; // 線路の側にずらして、開くと板の裏へ
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

function wellMesh(B, plan, w, mats) {
  const f = w.frame, at = f.at, ym = plan.ym, yc = w.yBot + PLAT_H;
  const tIn = w.side > 0 ? w.t0 : w.t1, tOut = w.side > 0 ? w.t1 : w.t0;
  const sFar = w.s1;
  // 床の縁（改札階の床からホーム階の天井まで）
  const into = Math.sign(tOut - tIn); // 吹き抜けの中を向く
  B.wall('paint', at(w.s0, tIn), at(sFar, tIn), yc, ym, { n: [f.nx * into, f.nz * into], color: [0.85, 0.85, 0.85] });
  B.wall('paint', at(sFar, tIn), at(sFar, tOut), yc, ym, { n: [-f.ax * w.side, -f.az * w.side], color: [0.85, 0.85, 0.85] });
  // ガラスの手すり（内側の辺と奥の端）
  for (const [a, b] of [[at(w.s0 + 0.05 * w.side, tIn), at(sFar, tIn)], [at(sFar, tIn), at(sFar, tOut)]]) {
    const mx = (a[0] + b[0]) / 2, mz = (a[1] + b[1]) / 2, dx = b[0] - a[0], dz = b[1] - a[1], l = Math.hypot(dx, dz);
    B.box('glass', mx, mz, ym + 0.05, ym + 1.0, dx / l, dz / l, l, 0.02);
    B.box('steel', mx, mz, ym + 1.0, ym + 1.06, dx / l, dz / l, l, 0.06);
    B.box('steel', mx, mz, ym, ym + 0.08, dx / l, dz / l, l, 0.06);
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
  const f = g.frame, at = f.at, lanes = gateLanes(g);
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
    // 緑の矢印のランプ（両面）
    for (const sg of [1, -1]) {
      const [lx, lz] = at(g.s + sg * 0.701, (a + b) / 2);
      B.box(sg * g.side > 0 ? 'red' : 'green', lx, lz, ym + 0.75, ym + 0.83, f.nx, f.nz, Math.min(0.1, b - a - 0.04), 0.004);
    }
  }
  // 三脚（通路ごとに 3 本の腕）
  for (const [a, b] of lanes) {
    const [x, z] = at(g.s, a + 0.02);
    for (let k = 0; k < 3; k++) {
      const ang = (k / 3) * Math.PI * 2;
      const dir = [Math.cos(ang) * 0.3, Math.sin(ang) * 0.3];
      const tip = at(g.s + dir[0] * 0.4, a + 0.05 + 0.45);
      B.bar('steel', [x, ym + 0.88, z], [tip[0], ym + 0.88 + dir[1] * 0.5, tip[1]], 0.035);
    }
    void b;
  }
  // ガラスの仕切り（改札の両脇から壁まで）
  for (const [a, b] of [[g.t0, housings[0][0]], [housings[housings.length - 1][1], g.t1]]) {
    if (b - a < 0.05) continue;
    const [x, z] = at(g.s, (a + b) / 2);
    B.box('glass', x, z, ym, ym + 1.15, f.nx, f.nz, b - a, 0.02);
    B.box('steel', x, z, ym + 1.15, ym + 1.2, f.nx, f.nz, b - a, 0.05);
    B.box('steel', x, z, ym, ym + 0.06, f.nx, f.nz, b - a, 0.05);
  }
  // 方面の吊り看板（改札の上。コンコースの側を向く）
  const term = g.dir?.terminus?.name || '';
  const key = signs.material(`gate-${g.line}-${g.side}`, 3.4, 0.45, directionDraw(g.line, term, { arrow: '' }));
  const [hx, hz] = at(g.s - g.side * 0.8, 0);
  hangSign(B, signs, key, [hx, hz], ym + HALL_H - 0.75, [f.nx, f.nz], 3.4, 0.45, ym + HALL_H);
  void plan;
}

function concourseFurniture(B, signs, plan, style) {
  const fP = plan.rects[0].frame, at = fP.at, ym = plan.ym, hall = plan.hall;
  // 券売機: コンコースの長い壁の、通路の入口でない所に 2 台ずつ
  const tk = signs.material('ticket', 0.75, 1.75, ticketDraw());
  for (const sg of [1, -1]) {
    const open = plan.openings.filter((o) => o.axis === 't' && o.sign === sg);
    const cands = [-hall.Cs + 1.0, -hall.Cs + 1.9, hall.Cs - 1.0, hall.Cs - 1.9].filter((s) => !open.some((o) => Math.abs(o.pos - s) < o.w / 2 + 0.6));
    for (const s of cands.slice(0, 2)) {
      const t = sg * (hall.Ct - 0.3);
      const [x, z] = at(s, t);
      B.box('paint', x, z, ym, ym + 1.8, fP.ax, fP.az, 0.8, 0.5, { color: C.ticketRed });
      const n = [-fP.nx * sg, -fP.nz * sg];
      signs.panel(tk, x + n[0] * 0.251, ym + 0.95, z + n[1] * 0.251, fP.ax * -sg, fP.az * -sg, 0.75, 1.7, n[0], n[1], 0);
    }
  }
  // 出口の吊り看板（通路の入口の前）
  for (const o of plan.openings) {
    const P0 = o.axis === 't' ? [o.pos, o.sign * (hall.Ct - 1.2)] : [o.sign * (hall.Cs - 1.2), o.pos];
    const along = o.axis === 't' ? [fP.ax, fP.az] : [fP.nx, fP.nz];
    const c = plan.corridors.find((q) => Math.abs((o.axis === 't' ? q.local[q.local.length - 1][0] : q.local[q.local.length - 1][1]) - o.pos) < 0.01);
    const key = signs.material(`exit-${o.axis}-${o.sign}-${o.pos.toFixed(1)}`, 2.0, 0.5, exitDraw(c?.street || ''));
    hangSign(B, signs, key, at(...P0), ym + HALL_H - 0.6, along, 2.0, 0.5, ym + HALL_H);
  }
  // 作品
  if (style.art === 'cone') {
    // Esquirol の銅色の円錐の柱（コンコースの真ん中）
    const [x, z] = at(0, 0);
    const segs = 6;
    for (let k = 0; k < segs; k++) {
      const y0 = ym + (HALL_H * k) / segs, y1 = ym + (HALL_H * (k + 1)) / segs;
      B.cyl('copper', x, z, y0, y1, 0.85 - (0.45 * (k + 0.5)) / segs, { seg: 24, color: C.copper });
    }
  } else if (style.art === 'columns') {
    for (const [s, t] of [[-6, -6], [6, -6], [-6, 6], [6, 6]]) {
      const [x, z] = at(s, t);
      B.cyl('concrete', x, z, ym, ym + HALL_H, 0.45, { seg: 20, color: [0.86, 0.86, 0.84] });
    }
  } else {
    // 壁画（コンコースの長い壁の真ん中。通路の入口でなければ）
    for (const sg of [1, -1]) {
      if (plan.openings.some((o) => o.axis === 't' && o.sign === sg && Math.abs(o.pos) < o.w / 2 + 1.6)) continue;
      const key = signs.material('mural', 3.0, 1.8, muralDraw(plan.station, style.accent));
      const [x, z] = at(0, sg * (hall.Ct - 0.02));
      signs.panel(key, x, ym + 1.65, z, fP.ax * -sg, fP.az * -sg, 3.0, 1.8, -fP.nx * sg, -fP.nz * sg, 0);
      break;
    }
  }
  // 駅名の板（コンコースの壁）
  const nameKey = signs.material('name', 2.4, 0.6, nameDraw(plan.station.name, style.accent));
  for (const sg of [1, -1]) {
    const s = hall.Cs > 6 ? 0 : 0;
    if (plan.openings.some((o) => o.axis === 't' && o.sign === sg && Math.abs(o.pos - s) < o.w / 2 + 1.4)) continue;
    const [x, z] = at(s, sg * (hall.Ct - 0.02));
    signs.panel(nameKey, x, ym + 2.75, z, fP.ax * -sg, fP.az * -sg, 2.4, 0.6, -fP.nx * sg, -fP.nz * sg, 0);
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
