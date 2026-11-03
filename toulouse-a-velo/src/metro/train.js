// VAL 208（Siemens）の車両。写真（Wikimedia Commons の Toulouse の VAL 208 の車内・車外）を手本に:
// - 1 両 13 m・幅 2.08 m。片側に両開きの扉が 3 つ（2 両で 1 編成、A 線は 2 編成をつないだ 4 両）
// - 車内: 黄色のつやのある壁、赤い斑点の床、真ん中が黒っぽい穴あきの天井で両脇に白い照明（路線図の帯）、
//   黄色の殻に青紫の布の座席（窓の区画ごとに向かい合わせ・反対側は腰掛けのバー）、端は横向きの座席、
//   ステンレスの縦の手すりと天井沿いの横の手すり、扉の上に赤い非常通報の箱
// - 車外: 白い車体、窓の帯は濃い灰色、屋根の縁に路線の色（A 線は赤、B 線は黄色）、先頭は丸い白い顔に青い帯と黄色の「tisséo」
// 局所座標: x が前（車両の長さ）、y が上（0 = 床）、z が右。車両の中心が原点
import * as THREE from 'three';
import { Builder } from './geom.js';
import { NavLayer } from './nav.js';
import { LAYOUT, LINE_COLORS, trackAt } from './network.js';
import { metroTextures, signTexture } from './textures.js';
import { carPassengers } from './crowd.js';

export const CAR = { half: 6.5, width: 2.08, inner: 0.95, floor: 0, ceil: 2.08, roof: 2.4, under: -0.85 };
const DOOR_W = LAYOUT.doorW, DOOR_H = 1.92;
const YELLOW = [0.98, 0.74, 0.02], WHITE = [0.93, 0.93, 0.92], BAND = [0.17, 0.18, 0.2], BLACK = [0.06, 0.06, 0.07], STEEL = [0.85, 0.86, 0.88];

let mats = null;
export function trainMaterials() {
  if (mats) return mats;
  const t = metroTextures();
  const std = (o) => new THREE.MeshStandardMaterial({ vertexColors: true, ...o });
  const lineMap = signTexture(1.2, 0.3, (x, W, H) => {
    x.fillStyle = '#f7f7f2';
    x.fillRect(0, 0, W, H);
    x.lineWidth = H * 0.06;
    x.strokeStyle = LINE_COLORS.A;
    x.beginPath();
    x.moveTo(W * 0.04, H * 0.35);
    x.lineTo(W * 0.96, H * 0.35);
    x.stroke();
    x.strokeStyle = LINE_COLORS.B;
    x.beginPath();
    x.moveTo(W * 0.04, H * 0.7);
    x.lineTo(W * 0.96, H * 0.7);
    x.stroke();
    for (let i = 0; i < 18; i++) {
      x.fillStyle = '#ffffff';
      x.strokeStyle = '#333';
      x.lineWidth = 1;
      for (const yy of [0.35, 0.7]) {
        x.beginPath();
        x.arc(W * (0.06 + 0.05 * i), H * yy, H * 0.05, 0, Math.PI * 2);
        x.fill();
        x.stroke();
      }
    }
  });
  const logo = signTexture(1.4, 0.4, (x, W, H) => {
    x.fillStyle = '#1e3a8f';
    x.fillRect(0, 0, W, H);
    x.fillStyle = '#f2c230';
    x.font = `italic 600 ${Math.round(H * 0.62)}px Georgia, serif`;
    x.textAlign = 'center';
    x.textBaseline = 'middle';
    x.fillText('tisséo', W / 2, H * 0.52);
  });
  mats = {
    shell: std({ roughness: 0.22 }), // 車内の黄色・車体の白（頂点の色）
    floor: std({ map: t.trainFloor, roughness: 0.6 }),
    fabric: std({ map: t.fabric, roughness: 0.95 }),
    ceiling: std({ map: t.darkPerforated, roughness: 0.6, metalness: 0.3 }),
    steel: std({ map: t.brushed, roughness: 0.25, metalness: 0.9 }),
    paint: std({ roughness: 0.55 }),
    rubber: std({ roughness: 0.9 }),
    glass: new THREE.MeshStandardMaterial({ color: '#9fb2b4', roughness: 0.04, metalness: 0.2, transparent: true, opacity: 0.22, depthWrite: false, side: THREE.DoubleSide }),
    light: new THREE.MeshBasicMaterial({ color: '#fbfaf3' }),
    lineMap: new THREE.MeshBasicMaterial({ map: lineMap }),
    logo: new THREE.MeshBasicMaterial({ map: logo, side: THREE.DoubleSide }),
    red: new THREE.MeshStandardMaterial({ color: '#c8141b', roughness: 0.4 }),
    head: new THREE.MeshBasicMaterial({ color: '#fff7e0' }),
    tail: new THREE.MeshBasicMaterial({ color: '#ff2a2a' }),
  };
  return mats;
}

// 窓の区画と扉: 扉の中心 LAYOUT.doorX、窓は扉と扉のあいだと両端
function sideOpenings() {
  const doors = LAYOUT.doorX.map((x) => [x - DOOR_W / 2, x + DOOR_W / 2]);
  const wins = [];
  let x = -CAR.half + 0.55;
  for (const [a, b] of doors) {
    if (a - x > 0.6) wins.push([x + 0.25, a - 0.25]);
    x = b;
  }
  wins.push([x + 0.25, CAR.half - 0.8]);
  return { doors, wins };
}

// 1 両の形（先頭の顔は +x の端。nose が false なら両端とも連結の妻）
function buildCar(line, nose) {
  const B = new Builder();
  const roofColor = new THREE.Color(LINE_COLORS[line]).toArray();
  const { doors, wins } = sideOpenings();
  const H = CAR.half, W = CAR.width / 2, I = CAR.inner;
  const xEnd = nose ? H - 0.5 : H; // 先頭は車体の箱が少し短く、前に丸い顔
  // ---------------- 車外（左右の側面: 窓と扉の穴をあけた白い板、窓の帯は濃い灰色）
  for (const sg of [1, -1]) {
    const z = W * sg, n = [0, sg];
    const holes = [...doors.map(([a, b]) => [a, b, 0, DOOR_H]), ...wins.map(([a, b]) => [a, b, 0.85, 1.85])].sort((p, q) => p[0] - q[0]);
    // 下の帯（床の下から窓の下まで）は穴（扉）以外を一続きに
    let x0 = -H;
    for (const [a, b, y0, y1] of holes) {
      if (y0 === 0) {
        sideStrip(B, x0, a, z, n, -0.25, 0.85, WHITE);
        x0 = b;
      }
      void y1;
    }
    sideStrip(B, x0, xEnd, z, n, -0.25, 0.85, WHITE);
    // 窓の高さの帯（濃い灰色）: 窓と扉のあいだの柱
    x0 = -H;
    for (const [a, b] of holes) {
      sideStrip(B, x0, a, z, n, 0.85, 1.85, BAND);
      x0 = b;
    }
    sideStrip(B, x0, xEnd, z, n, 0.85, 1.85, BAND);
    // 扉の上・窓の上の帯（白）と屋根の縁の路線の色
    x0 = -H;
    for (const [a, b, y0] of holes) {
      if (y0 === 0) {
        sideStrip(B, x0, a, z, n, 1.85, DOOR_H, BAND);
        x0 = b;
      }
    }
    sideStrip(B, x0, xEnd, z, n, 1.85, DOOR_H, BAND);
    sideStrip(B, -H, xEnd, z, n, DOOR_H, 2.08, WHITE);
    sideStrip(B, -H, xEnd, z, n, 2.08, 2.22, roofColor);
    // 窓のガラスとゴムの縁
    for (const [a, b] of wins) {
      B.quad('glass', [a, 0.85, z], [b, 0.85, z], [b, 1.85, z], [a, 1.85, z], [0, 0, sg]);
      frameRect(B, a, b, 0.85, 1.85, z, sg);
    }
    // 床下（黒っぽい機器の箱とゴムのタイヤの影）
    B.box('paint', 0, z * 0.85, CAR.under, -0.25, 1, 0, 2 * H - 1.5, 0.2, { color: [0.12, 0.12, 0.13] });
  }
  // 屋根（明るい灰色）
  B.quad('shell', [-H, 2.22, -W], [xEnd, 2.22, -W], [xEnd, CAR.roof, -W * 0.7], [-H, CAR.roof, -W * 0.7], [0, 0.8, -0.6], { color: [0.78, 0.79, 0.8] });
  B.quad('shell', [-H, CAR.roof, W * 0.7], [xEnd, CAR.roof, W * 0.7], [xEnd, 2.22, W], [-H, 2.22, W], [0, 0.8, 0.6], { color: [0.78, 0.79, 0.8] });
  B.quad('shell', [-H, CAR.roof, -W * 0.7], [xEnd, CAR.roof, -W * 0.7], [xEnd, CAR.roof, W * 0.7], [-H, CAR.roof, W * 0.7], [0, 1, 0], { color: [0.78, 0.79, 0.8] });
  // 床下の面
  B.quad('paint', [-H, CAR.under, -W], [xEnd, CAR.under, -W], [xEnd, CAR.under, W], [-H, CAR.under, W], [0, -1, 0], { color: BLACK });
  // 妻（連結の側: 窓つきの平らな面）
  endWall(B, -H, -1);
  if (!nose) endWall(B, H, 1);
  else noseFace(B, xEnd, line);

  // ---------------- 車内
  const yC = CAR.ceil;
  // 床
  B.floor('floor', [[-H + 0.12, -I], [xEnd - 0.05, -I], [xEnd - 0.05, I], [-H + 0.12, I]], 0.002, { uv: 1 });
  // 側面の内側（黄色）: 窓と扉を除く
  for (const sg of [1, -1]) {
    const z = I * sg, n = [0, -sg];
    const holes = [...doors.map(([a, b]) => [a, b, 0, DOOR_H]), ...wins.map(([a, b]) => [a, b, 0.85, 1.85])].sort((p, q) => p[0] - q[0]);
    let x0 = -H + 0.12;
    for (const [a, b, y0] of holes) {
      sideStrip(B, x0, a, z, n, 0, 1.85, YELLOW, 'shell');
      if (y0 > 0) sideStrip(B, a, b, z, n, 0, 0.85, YELLOW, 'shell');
      x0 = b;
    }
    sideStrip(B, x0, xEnd - 0.05, z, n, 0, 1.85, YELLOW, 'shell');
    // 窓の上・扉の上の帯から天井へ（斜めの照明）
    sideStrip(B, -H + 0.12, xEnd - 0.05, z, n, 1.85, 1.95, YELLOW, 'shell');
    // 窓の黒い縁（内側）
    for (const [a, b] of wins) frameRect(B, a, b, 0.85, 1.85, z, -sg, 0.035);
    // 扉の枠（黄色の柱）と赤い非常通報の箱
    for (const [a, b] of doors) {
      for (const x of [a - 0.04, b + 0.04]) B.box('shell', x, z - sg * 0.04, 0, DOOR_H, 1, 0, 0.08, 0.1, { color: YELLOW });
      B.box('red', (a + b) / 2 - 0.45, z - sg * 0.08, 1.93, 2.0, 1, 0, 0.22, 0.12);
    }
    // 斜めの照明（白く光る）と路線図の板
    for (let x = -H + 0.4; x < xEnd - 0.5; x += 1.6) {
      const x1 = Math.min(xEnd - 0.3, x + 1.45);
      const p = (xx, zz, yy) => [xx, yy, zz];
      const key = Math.round((x + H) / 1.6) % 3 === 1 ? 'lineMap' : 'light';
      B.quad(key, p(x, 0.92 * sg, 1.95), p(x1, 0.92 * sg, 1.95), p(x1, 0.55 * sg, yC), p(x, 0.55 * sg, yC), [0, -0.9, -0.42 * sg], { uvs: sg > 0 ? [[0, 0], [1, 0], [1, 1], [0, 1]] : [[1, 1], [0, 1], [0, 0], [1, 0]] });
    }
  }
  // 天井の真ん中（黒っぽい穴あきの板）
  B.floor('ceiling', [[-H + 0.12, -0.55], [xEnd - 0.05, -0.55], [xEnd - 0.05, 0.55], [-H + 0.12, 0.55]], yC, { up: false, uv: 1.2 });
  // 妻の内側（黄色、窓つき）
  endInside(B, -H + 0.12, 1);
  endInside(B, xEnd - 0.05, -1);
  // 座席
  seats(B, doors, xEnd);
  // 手すり: 扉の真ん中の縦の棒、天井沿いの横の棒
  for (const [a, b] of doors) B.cyl('steel', (a + b) / 2, 0, 0, yC, 0.019, { seg: 8, color: STEEL });
  for (const sg of [1, -1]) {
    B.bar('steel', [-H + 0.6, 1.88, 0.5 * sg], [xEnd - 0.6, 1.88, 0.5 * sg], 0.032, { color: STEEL });
    for (let x = -H + 0.6; x <= xEnd - 0.6; x += 2.4) B.bar('steel', [x, 1.88, 0.5 * sg], [x, yC, 0.52 * sg], 0.025, { color: STEEL });
  }
  const group = B.build(trainMaterials(), { name: `val208-${line}${nose ? '-nose' : ''}` });
  group.traverse((o) => {
    if (o.isMesh) o.matrixAutoUpdate = false;
  });
  return group;
}

function sideStrip(B, x0, x1, z, n, y0, y1, color, key = 'shell') {
  if (x1 - x0 < 1e-3 || y1 - y0 < 1e-3) return;
  B.quad(key, [x0, y0, z], [x1, y0, z], [x1, y1, z], [x0, y1, z], [0, 0, n[1] ?? n], { color });
}

function frameRect(B, a, b, y0, y1, z, sg, t = 0.05) {
  const zz = z + sg * 0.004;
  B.quad('rubber', [a, y0, zz], [b, y0, zz], [b, y0 + t, zz], [a, y0 + t, zz], [0, 0, sg], { color: BLACK });
  B.quad('rubber', [a, y1 - t, zz], [b, y1 - t, zz], [b, y1, zz], [a, y1, zz], [0, 0, sg], { color: BLACK });
  B.quad('rubber', [a, y0, zz], [a + t, y0, zz], [a + t, y1, zz], [a, y1, zz], [0, 0, sg], { color: BLACK });
  B.quad('rubber', [b - t, y0, zz], [b, y0, zz], [b, y1, zz], [b - t, y1, zz], [0, 0, sg], { color: BLACK });
}

// 連結の妻（外）: 白い面に窓
function endWall(B, x, sg) {
  const W = CAR.width / 2;
  const n = [sg, 0, 0];
  B.quad('shell', [x, CAR.under * 0.3, -W], [x, CAR.under * 0.3, W], [x, 0.9, W], [x, 0.9, -W], n, { color: WHITE });
  B.quad('shell', [x, 1.75, -W], [x, 1.75, W], [x, 2.22, W], [x, 1.75 + 0.47, -W], n, { color: WHITE });
  B.quad('shell', [x, 0.9, -W], [x, 0.9, -0.45], [x, 1.75, -0.45], [x, 1.75, -W], n, { color: WHITE });
  B.quad('shell', [x, 0.9, 0.45], [x, 0.9, W], [x, 1.75, W], [x, 1.75, 0.45], n, { color: WHITE });
  B.quad('glass', [x, 0.9, -0.45], [x, 0.9, 0.45], [x, 1.75, 0.45], [x, 1.75, -0.45], n);
}

function endInside(B, x, sg) {
  const I = CAR.inner, n = [sg, 0, 0];
  B.quad('shell', [x, 0, -I], [x, 0, I], [x, 0.9, I], [x, 0.9, -I], n, { color: YELLOW });
  B.quad('shell', [x, 1.75, -I], [x, 1.75, I], [x, CAR.ceil, I], [x, CAR.ceil, -I], n, { color: YELLOW });
  B.quad('shell', [x, 0.9, -I], [x, 0.9, -0.45], [x, 1.75, -0.45], [x, 1.75, -I], n, { color: YELLOW });
  B.quad('shell', [x, 0.9, 0.45], [x, 0.9, I], [x, 1.75, I], [x, 1.75, 0.45], n, { color: YELLOW });
}

// 先頭の顔（丸い白い面、大きな前面の窓、青い帯と「tisséo」、前照灯）
function noseFace(B, x0, line) {
  const W = CAR.width / 2, segs = 6, depth = 0.5;
  // 横から見た形: 下は前へ出て、上は丸く後ろへ（窓の部分が傾く）
  const prof = [];
  for (let k = 0; k <= segs; k++) {
    const y = CAR.under * 0.3 + ((2.3 - CAR.under * 0.3) * k) / segs;
    const tY = (y - 0.2) / 2.1;
    const xo = depth * Math.cos(Math.max(0, Math.min(1, tY)) * Math.PI * 0.45);
    prof.push([x0 + xo, y]);
  }
  for (let k = 0; k < segs; k++) {
    const [xa, ya] = prof[k], [xb, yb] = prof[k + 1];
    const dx = xb - xa, dy = yb - ya, l = Math.hypot(dx, dy);
    const n = [dy / l, -dx / l, 0];
    const glass = ya >= 0.85 && yb <= 2.0;
    const band = ya >= 0.3 && yb <= 0.9;
    // 角は丸めて（z を少し狭める）
    const wa = W * (0.9 + 0.1 * Math.cos((k / segs) * Math.PI * 0.5)), wb = W * (0.9 + 0.1 * Math.cos(((k + 1) / segs) * Math.PI * 0.5));
    B.quad(glass ? 'glass' : 'shell', [xa, ya, -wa], [xa, ya, wa], [xb, yb, wb], [xb, yb, -wb], n, { color: band ? [0.12, 0.23, 0.56] : WHITE });
    // 横の丸み（車体の側面から顔へ）
    for (const sg of [1, -1]) {
      B.quad('shell', [x0, ya, W * sg], [xa, ya, wa * sg], [xb, yb, wb * sg], [x0, yb, W * sg], [0.3, 0, sg], { color: glass ? BAND : band ? [0.12, 0.23, 0.56] : WHITE });
    }
  }
  // 「tisséo」の字（青い帯の上）と前照灯・尾灯
  const xs = prof[2][0] + 0.02;
  B.quad('logo', [xs, 0.35, -0.55], [xs, 0.35, 0.55], [xs, 0.78, 0.55], [xs, 0.78, -0.55], [1, 0, 0], { uvs: [[1, 0], [0, 0], [0, 1], [1, 1]] });
  for (const sg of [1, -1]) {
    B.box('head', xs, 0.82 * sg, 0.12, 0.24, 0, 1, 0.16, 0.05);
    B.box('tail', xs, 0.62 * sg, 0.12, 0.24, 0, 1, 0.1, 0.05);
  }
  void line;
}

// 座席: 窓の区画ごとに、片側は向かい合わせの 2 席、反対側は腰掛けのバー。両端は横向きの座席
function seats(B, doors, xEnd) {
  const I = CAR.inner;
  const bays = [];
  let x = -CAR.half + 0.12;
  for (const [a, b] of doors) {
    bays.push([x, a]);
    x = b;
  }
  bays.push([x, xEnd - 0.05]);
  bays.forEach(([a, b], i) => {
    const end = i === 0 || i === bays.length - 1;
    const mid = (a + b) / 2;
    if (end) {
      // 妻の側の横向きの座席（両側に 2 人掛け、通路側を向く）
      const atEnd = i === 0 ? a : b, dir = i === 0 ? 1 : -1;
      for (const sg of [1, -1]) shellSeat(B, atEnd + dir * 0.32, sg * (I - 0.45), dir, 0.8);
      return;
    }
    const sgS = i % 2 ? 1 : -1;
    // 向かい合わせの 2 席
    shellSeat(B, mid - 0.5, sgS * (I - 0.27), 1, 0.45);
    shellSeat(B, mid + 0.5, sgS * (I - 0.27), -1, 0.45);
    // 反対側の腰掛けのバー（青い布）
    const z = -sgS * (I - 0.12);
    B.box('fabric', mid, z, 0.72, 0.8, 1, 0, b - a - 0.5, 0.16);
    B.box('steel', mid, z, 0.66, 0.72, 1, 0, b - a - 0.5, 0.06, { color: STEEL });
  });
}

// 座席の位置（車体の局所座標。人を座らせる）: [{ x, z, dir }]
export function seatSpots() {
  const I = CAR.inner, xEnd = CAR.half - 0.5;
  const { doors } = sideOpenings();
  const bays = [];
  let x = -CAR.half + 0.12;
  for (const [a, b] of doors) {
    bays.push([x, a]);
    x = b;
  }
  bays.push([x, xEnd - 0.05]);
  const out = [];
  bays.forEach(([a, b], i) => {
    if (i === 0 || i === bays.length - 1) {
      const atEnd = i === 0 ? a : b, dir = i === 0 ? 1 : -1;
      for (const sg of [1, -1]) for (const dz of [-0.2, 0.2]) out.push({ x: atEnd + dir * 0.32, z: sg * (I - 0.45) + dz, dir });
      return;
    }
    const sgS = i % 2 ? 1 : -1, mid = (a + b) / 2;
    out.push({ x: mid - 0.5, z: sgS * (I - 0.27), dir: 1 }, { x: mid + 0.5, z: sgS * (I - 0.27), dir: -1 });
  });
  return out;
}

// 黄色の殻の座席（青紫の布の座面と背もたれ）。x, z: 座面の中心、dir: 向き（+1 で +x を向く）、w: 幅（z の向き）
function shellSeat(B, x, z, dir, w) {
  const d = 0.42;
  B.box('shell', x, z, 0.0, 0.42, 1, 0, d, w, { color: YELLOW });
  B.box('fabric', x + dir * 0.02, z, 0.42, 0.47, 1, 0, d - 0.06, w - 0.08);
  const xb = x - dir * (d / 2 + 0.04);
  B.box('shell', xb, z, 0.42, 1.12, 1, 0, 0.08, w, { color: YELLOW });
  B.box('fabric', xb + dir * 0.045, z, 0.5, 1.02, 1, 0, 0.012, w - 0.1);
}

// 扉 1 枚（局所: x が横、y が上、z が厚さ）
function doorLeafGeometry(glass) {
  const b = new Builder(), w = DOOR_W / 2;
  if (glass) b.box('g', 0, 0, 0.75, 1.8, 1, 0, w - 0.1, 0.012);
  else {
    b.box('g', 0, 0, 0, 0.75, 1, 0, w, 0.04, { color: [0.3, 0.31, 0.33] });
    b.box('g', 0, 0, 1.8, DOOR_H, 1, 0, w, 0.04, { color: [0.3, 0.31, 0.33] });
    for (const x of [-w / 2 + 0.025, w / 2 - 0.025]) b.box('g', x, 0, 0.75, 1.8, 1, 0, 0.05, 0.04, { color: [0.3, 0.31, 0.33] });
  }
  return b.writers.get('g').toGeometry();
}

// 1 両の歩ける所（車両の局所座標）。doorRegions・doorWalls は扉の開け閉めで切り替える。
// flip: 車体を裏返した車両（先頭の顔が -x の端）。座席と妻の位置を裏返す（扉は前後・左右に対称）
function carNav(flip) {
  const nav = new NavLayer('car', { cell: 3 });
  const F = (x, z) => (flip ? [-x, -z] : [x, z]);
  const I = CAR.inner - 0.03, H = CAR.half, xEnd = H - 0.55;
  const [a0, b0] = [F(-H + 0.2, 0)[0], F(xEnd, 0)[0]].sort((p, q) => p - q);
  nav.addRegion([[a0, -I], [b0, -I], [b0, I], [a0, I]], 0, { kind: 'car' });
  const { doors } = sideOpenings();
  const doorRegions = [], doorWalls = [];
  for (const sg of [1, -1]) {
    let x0 = a0 - 0.05;
    for (const [a, b] of doors) {
      nav.addWall(x0, CAR.inner * sg, a, CAR.inner * sg, -0.3, 2.1);
      const w = nav.addWall(a, CAR.inner * sg, b, CAR.inner * sg, -0.3, 2.1, { door: true, sg });
      doorWalls.push(w);
      const r = nav.addRegion([[a + 0.05, CAR.inner * sg - 0.1 * sg], [b - 0.05, CAR.inner * sg - 0.1 * sg], [b - 0.05, 1.38 * sg], [a + 0.05, 1.38 * sg]], 0, { kind: 'door', sg });
      r.disabled = true;
      doorRegions.push(r);
      x0 = b;
    }
    nav.addWall(x0, CAR.inner * sg, b0 + 0.05, CAR.inner * sg, -0.3, 2.1);
  }
  nav.addWall(a0 - 0.05, -CAR.inner, a0 - 0.05, CAR.inner, -0.3, 2.1);
  nav.addWall(b0 + 0.05, -CAR.inner, b0 + 0.05, CAR.inner, -0.3, 2.1);
  // 座席（壁ぎわの箱。車体の局所座標で決めて裏返す）
  const bays = [];
  let x = -H + 0.12;
  for (const [a, b] of doors) {
    bays.push([x, a]);
    x = b;
  }
  bays.push([x, xEnd]);
  const box = (x0, x1, z0, z1) => {
    const P = [F(x0, z0), F(x1, z0), F(x1, z1), F(x0, z1)];
    for (let i = 0; i < 4; i++) nav.addWall(...P[i], ...P[(i + 1) % 4], -0.3, 0.9);
  };
  bays.forEach(([a, b], i) => {
    if (i === 0) for (const sg of [1, -1]) box(a, a + 0.6, sg > 0 ? CAR.inner - 0.85 : -CAR.inner, sg > 0 ? CAR.inner : -CAR.inner + 0.85);
    else if (i === bays.length - 1) for (const sg of [1, -1]) box(b - 0.6, b, sg > 0 ? CAR.inner - 0.85 : -CAR.inner, sg > 0 ? CAR.inner : -CAR.inner + 0.85);
    else {
      const sgS = i % 2 ? 1 : -1, mid = (a + b) / 2;
      box(mid - 0.95, mid + 0.95, sgS > 0 ? CAR.inner - 0.5 : -CAR.inner, sgS > 0 ? CAR.inner : -CAR.inner + 0.5);
      box(mid - (b - a - 0.5) / 2, mid + (b - a - 0.5) / 2, -sgS > 0 ? CAR.inner - 0.22 : -CAR.inner, -sgS > 0 ? CAR.inner : -CAR.inner + 0.22);
    }
  });
  return { nav, doorRegions, doorWalls };
}

const templates = new Map();
function carTemplate(line, nose) {
  const key = `${line}-${nose}`;
  if (!templates.has(key)) templates.set(key, buildCar(line, nose));
  return templates.get(key);
}

let leafGeo = null;

// 電車（n 両。dir: +1 終点へ、-1 起点へ）。place(path, S) で線路の上に置く。setDoors(open 0..1, sideSg) で扉
export class Train {
  constructor(line, n, dir, { id = '' } = {}) {
    this.line = line;
    this.n = n;
    this.dir = dir;
    this.id = id;
    this.group = new THREE.Group();
    this.group.name = `train-${line}-${id}`;
    this.cars = [];
    leafGeo ||= { frame: doorLeafGeometry(false), glass: doorLeafGeometry(true) };
    const m = trainMaterials();
    for (let k = 0; k < n; k++) {
      // 編成（2 両）の外側の端が先頭の顔。k が偶数の車両は -x の端、奇数は +x の端
      const flip = k % 2 === 0;
      const tpl = carTemplate(line, true);
      const car = new THREE.Group();
      car.name = `car-${k}`;
      const body = new THREE.Group();
      for (const c of tpl.children) {
        const mesh = new THREE.Mesh(c.geometry, c.material);
        mesh.renderOrder = c.renderOrder;
        body.add(mesh);
      }
      // 座っている人（編成ごと・車両ごとに違う）
      const people = carPassengers(seatSpots(), (id.length * 7919 + k * 104729 + Math.round(Math.random() * 1e6)) | 0);
      if (people) body.add(people);
      if (flip) body.rotation.y = Math.PI;
      car.add(body);
      // 扉（両側に 3 つずつ、2 枚ずつ）
      const frame = new THREE.InstancedMesh(leafGeo.frame, m.paint, 12), glass = new THREE.InstancedMesh(leafGeo.glass, m.glass, 12);
      glass.renderOrder = 2;
      car.add(frame, glass);
      const { nav, doorRegions, doorWalls } = carNav(flip);
      this.cars.push({ group: car, body, flip, frame, glass, nav, doorRegions, doorWalls, open: 0 });
      this.group.add(car);
    }
    this.S = 0;
    this.speed = 0;
    this.doorOpen = 0;
    this.setDoors(0);
  }

  place(path, S) {
    this.S = S;
    const p = {};
    for (let k = 0; k < this.n; k++) {
      const c = this.cars[k];
      const s = this.S + ((this.n - 1) / 2 - k) * LAYOUT.carPitch * this.dir;
      trackAt(path, s, this.dir, p);
      // 前後の点から勾配
      const pa = trackAt(path, s - 3 * this.dir, this.dir, {}), pb = trackAt(path, s + 3 * this.dir, this.dir, {});
      const pitch = Math.atan2(pb.y - pa.y, 6);
      c.group.position.set(p.x, p.y, p.z);
      c.group.rotation.set(0, Math.atan2(-p.fz, p.fx), 0);
      c.group.rotateZ(pitch);
      c.group.updateMatrixWorld(true);
      // 歩ける所の向き: 車体の局所の +x（裏返した車両は車体だけ回すので、nav は車両の向きのまま）
      c.nav.setPose(p.x, p.y, p.z, p.fx, p.fz, Math.tan(pitch));
      c.pose = { x: p.x, y: p.y, z: p.z, fx: p.fx, fz: p.fz };
    }
  }

  // 扉を開ける割合 open（0..1）。開くのは進む向きの右側（ホームの側）
  setDoors(open) {
    this.doorOpen = open;
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), one = new THREE.Vector3(1, 1, 1), v = new THREE.Vector3();
    for (const c of this.cars) {
      let i = 0;
      for (const sg of [1, -1]) {
        const o = sg > 0 ? open : 0;
        for (const dx of LAYOUT.doorX) {
          for (const k of [-1, 1]) {
            v.set(dx + k * (DOOR_W / 4 + o * (DOOR_W / 2 - 0.05)), 0, (CAR.width / 2 - 0.05) * sg);
            m.compose(v, q, one);
            c.frame.setMatrixAt(i, m);
            c.glass.setMatrixAt(i, m);
            i++;
          }
        }
      }
      c.frame.instanceMatrix.needsUpdate = c.glass.instanceMatrix.needsUpdate = true;
      const passable = open > 0.85;
      for (const r of c.doorRegions) r.disabled = !(passable && r.sg > 0);
      for (const w of c.doorWalls) w.active = !(passable && w.sg > 0);
    }
  }

  dispose() {
    for (const c of this.cars) {
      c.frame.dispose();
      c.glass.dispose();
      c.body.traverse((o) => {
        if (o.name === 'passengers') o.geometry.dispose();
      });
    }
  }
}
