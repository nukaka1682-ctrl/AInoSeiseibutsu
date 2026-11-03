// メトロの駅・車両・トンネルの手続き的なテクスチャ（キャンバス）。写真（Wikimedia Commons）を手本に:
// - 駅の壁: 白い小さな長方形のタイル（約 20 × 10 cm）の馬目地、灰色の目地。駅によって色の帯（紺・赤など）
// - 床: 灰色の正方形のタイル（30 cm）、ホームドアの前は淡いベージュの花崗岩の帯
// - 天井: 灰色の穴あきの金属板（60 cm の板）
// - VAL 208 の車内: 赤い斑点の床（テラゾー風）、青紫の地に赤・黄・水色の点の座席の布、黒っぽい穴あきの天井
// - トンネル: 灰色のコンクリート（セグメントの継ぎ目・しみ）
// 1 枚のテクスチャは size m 四方（uv は m / size）
import * as THREE from 'three';
import { mulberry32 } from '../geo.js';

function canvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return [c, c.getContext('2d')];
}

function tex(c, { srgb = true, anisotropy = 8, repeat = true } = {}) {
  const t = new THREE.CanvasTexture(c);
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = anisotropy;
  t.needsUpdate = true;
  return t;
}

function noise(ctx, W, H, rnd, n, a, light = '255,255,255', dark = '0,0,0') {
  for (let i = 0; i < n; i++) {
    ctx.fillStyle = rnd() < 0.5 ? `rgba(${light},${a * rnd()})` : `rgba(${dark},${a * rnd()})`;
    ctx.fillRect(rnd() * W, rnd() * H, 1 + rnd() * 1.5, 1 + rnd() * 1.5);
  }
}

// 白いタイルの壁（1.2 m 四方）。stripe: 色の帯の色（null なら無地）
export function tileWallTexture({ stripe = null, tile = '#f2f1ec', grout = '#b9bab6' } = {}) {
  const S = 512, ppm = S / 1.2, rnd = mulberry32(7);
  const [c, x] = canvas(S, S);
  x.fillStyle = grout;
  x.fillRect(0, 0, S, S);
  const tw = 0.2 * ppm, th = 0.1 * ppm, g = Math.max(1, 0.006 * ppm);
  for (let r = 0; r * th < S; r++) {
    const off = r % 2 ? tw / 2 : 0;
    for (let k = -1; k * tw < S; k++) {
      const X = k * tw + off, Y = r * th;
      const v = 0.95 + rnd() * 0.06;
      const base = stripe && (r === 3 || r === 4) ? stripe : tile;
      const col = new THREE.Color(base).multiplyScalar(v);
      x.fillStyle = `#${col.getHexString()}`;
      x.fillRect(X + g / 2, Y + g / 2, tw - g, th - g);
      // 釉薬の光沢（上の縁が明るい）
      x.fillStyle = 'rgba(255,255,255,0.25)';
      x.fillRect(X + g / 2, Y + g / 2, tw - g, 1.5);
      x.fillStyle = 'rgba(0,0,0,0.06)';
      x.fillRect(X + g / 2, Y + th - g / 2 - 1.5, tw - g, 1.5);
    }
  }
  return tex(c);
}

// 灰色の正方形の床のタイル（1.2 m 四方、30 cm のタイル 4 × 4）
export function floorTileTexture({ base = '#8d8f91', grout = '#6e6f70', size = 0.3 } = {}) {
  const S = 512, ppm = S / 1.2, rnd = mulberry32(11);
  const [c, x] = canvas(S, S);
  x.fillStyle = grout;
  x.fillRect(0, 0, S, S);
  const t = size * ppm, g = Math.max(1, 0.004 * ppm);
  for (let i = 0; i * t < S; i++) {
    for (let j = 0; j * t < S; j++) {
      const col = new THREE.Color(base).multiplyScalar(0.93 + rnd() * 0.1);
      x.fillStyle = `#${col.getHexString()}`;
      x.fillRect(i * t + g / 2, j * t + g / 2, t - g, t - g);
    }
  }
  noise(x, S, S, rnd, 9000, 0.12);
  return tex(c);
}

// 花崗岩（1 m 四方）。base: 地の色。黒・白・ばら色の粒
export function graniteTexture({ base = '#cbbfa9', joint = 0.6 } = {}) {
  const S = 512, ppm = S / 1.2, rnd = mulberry32(13);
  const [c, x] = canvas(S, S);
  x.fillStyle = base;
  x.fillRect(0, 0, S, S);
  for (let i = 0; i < 26000; i++) {
    const r = rnd();
    x.fillStyle = r < 0.35 ? 'rgba(40,38,36,0.55)' : r < 0.6 ? 'rgba(255,255,250,0.55)' : r < 0.8 ? 'rgba(170,120,110,0.45)' : 'rgba(120,115,110,0.5)';
    const s = 1 + rnd() * 2.2;
    x.fillRect(rnd() * S, rnd() * S, s, s);
  }
  // 板の継ぎ目
  x.strokeStyle = 'rgba(60,55,50,0.45)';
  x.lineWidth = 1.5;
  const t = joint * ppm;
  for (let k = 0; k * t <= S; k++) {
    x.beginPath();
    x.moveTo(k * t, 0);
    x.lineTo(k * t, S);
    x.moveTo(0, k * t);
    x.lineTo(S, k * t);
    x.stroke();
  }
  return tex(c);
}

// 穴あきの金属の天井板（1.2 m 四方、60 cm の板）
export function perforatedTexture({ base = '#8b8e91', hole = '#3a3c3f' } = {}) {
  const S = 512, ppm = S / 1.2, rnd = mulberry32(17);
  const [c, x] = canvas(S, S);
  x.fillStyle = base;
  x.fillRect(0, 0, S, S);
  x.fillStyle = hole;
  const step = 0.012 * ppm;
  for (let i = 0; i * step < S; i++) {
    for (let j = 0; j * step < S; j++) {
      const X = i * step + (j % 2 ? step / 2 : 0), Y = j * step;
      x.fillRect(X, Y, step * 0.45, step * 0.45);
    }
  }
  // 板の継ぎ目
  x.fillStyle = 'rgba(20,20,22,0.8)';
  const p = 0.6 * ppm;
  for (let k = 0; k * p <= S; k++) {
    x.fillRect(k * p - 1, 0, 2.5, S);
    x.fillRect(0, k * p - 1, S, 2.5);
  }
  noise(x, S, S, rnd, 3000, 0.1);
  return tex(c);
}

// つや消しのステンレス（横の筋。1 m 四方）
export function brushedTexture() {
  const S = 256, rnd = mulberry32(19);
  const [c, x] = canvas(S, S);
  x.fillStyle = '#c4c7ca';
  x.fillRect(0, 0, S, S);
  for (let i = 0; i < 1400; i++) {
    x.fillStyle = rnd() < 0.5 ? `rgba(255,255,255,${0.15 * rnd()})` : `rgba(60,62,66,${0.15 * rnd()})`;
    x.fillRect(rnd() * S, rnd() * S, 20 + rnd() * 120, 1);
  }
  return tex(c);
}

// トンネルのコンクリート（4 m 四方。セグメントの継ぎ目 1.4 m ごと・しみ）
export function concreteTexture({ base = '#7d7b77' } = {}) {
  const S = 512, ppm = S / 4, rnd = mulberry32(23);
  const [c, x] = canvas(S, S);
  x.fillStyle = base;
  x.fillRect(0, 0, S, S);
  for (let i = 0; i < 60; i++) {
    const g = x.createRadialGradient(rnd() * S, rnd() * S, 0, rnd() * S, rnd() * S, 30 + rnd() * 80);
    g.addColorStop(0, `rgba(${rnd() < 0.5 ? '40,38,35' : '200,198,190'},0.12)`);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    x.fillStyle = g;
    x.fillRect(0, 0, S, S);
  }
  noise(x, S, S, rnd, 22000, 0.18);
  x.fillStyle = 'rgba(30,30,30,0.5)';
  for (let k = 0; k * 1.4 * ppm < S; k++) x.fillRect(k * 1.4 * ppm, 0, 2, S);
  return tex(c);
}

// VAL 208 の車内の床（赤い斑点。1 m 四方）
export function trainFloorTexture() {
  const S = 512, rnd = mulberry32(29);
  const [c, x] = canvas(S, S);
  x.fillStyle = '#9a2f22';
  x.fillRect(0, 0, S, S);
  for (let i = 0; i < 30000; i++) {
    const r = rnd();
    x.fillStyle = r < 0.3 ? 'rgba(240,220,200,0.6)' : r < 0.55 ? 'rgba(60,15,10,0.5)' : r < 0.7 ? 'rgba(230,150,60,0.45)' : 'rgba(180,60,40,0.5)';
    const s = 1 + rnd() * 2;
    x.fillRect(rnd() * S, rnd() * S, s, s);
  }
  return tex(c);
}

// 座席の布（青紫の地に赤・黄・水色の点と短い線。0.5 m 四方）
export function seatFabricTexture() {
  const S = 256, rnd = mulberry32(31);
  const [c, x] = canvas(S, S);
  x.fillStyle = '#2b2a7a';
  x.fillRect(0, 0, S, S);
  for (let i = 0; i < 2600; i++) {
    x.fillStyle = rnd() < 0.5 ? 'rgba(90,60,170,0.5)' : 'rgba(20,20,60,0.5)';
    x.fillRect(rnd() * S, rnd() * S, 2, 2);
  }
  const cols = ['#e2332a', '#f2c230', '#4fb7e6', '#d94fa0'];
  for (let i = 0; i < 260; i++) {
    x.fillStyle = cols[Math.floor(rnd() * cols.length)];
    const X = rnd() * S, Y = rnd() * S;
    if (rnd() < 0.6) {
      x.beginPath();
      x.arc(X, Y, 1.5 + rnd() * 2, 0, Math.PI * 2);
      x.fill();
    } else x.fillRect(X, Y, 4 + rnd() * 6, 2);
  }
  return tex(c);
}

// 文字の板（キャンバス 1 枚）。draw(ctx, W, H) で描く。看板の大きさ w × h m に合わせて解像度を決める
export function signTexture(w, h, draw, { ppm = 256, max = 2048 } = {}) {
  const W = Math.min(max, Math.max(16, Math.round(w * ppm))), H = Math.min(max, Math.max(16, Math.round(h * ppm)));
  const [c, x] = canvas(W, H);
  draw(x, W, H);
  return tex(c, { repeat: false });
}

// 文字を枠の幅に収める
export function fitText(ctx, text, maxW, size, weight = '700', family = '"Helvetica Neue", Arial, sans-serif') {
  let s = size;
  ctx.font = `${weight} ${s}px ${family}`;
  while (s > 6 && ctx.measureText(text).width > maxW) {
    s -= 1;
    ctx.font = `${weight} ${s}px ${family}`;
  }
  return s;
}

// 路線の丸（A: 赤地に白い A、B: 黄色地に黒い B）
export function drawLineBadge(ctx, line, cx, cy, r) {
  ctx.fillStyle = line === 'A' ? '#e2231a' : '#f6b400';
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = line === 'A' ? '#ffffff' : '#1d1d1b';
  ctx.font = `800 ${Math.round(r * 1.35)}px "Helvetica Neue", Arial, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(line, cx, cy + r * 0.06);
}

// メトロの印（黄色地に紺の丸と M。world/metro.js の看板と同じ）
export function drawMetroLogo(ctx, cx, cy, r) {
  ctx.fillStyle = '#f9b80d';
  ctx.fillRect(cx - r, cy - r, 2 * r, 2 * r);
  ctx.strokeStyle = '#1d2a55';
  ctx.lineWidth = r * 0.14;
  ctx.beginPath();
  ctx.arc(cx, cy, r * 0.7, 0, Math.PI * 2);
  ctx.stroke();
  ctx.fillStyle = '#1d2a55';
  ctx.font = `800 ${Math.round(r)}px "Helvetica Neue", Arial, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('M', cx, cy + r * 0.06);
}

let shared = null;
// 駅・車両・トンネルで共有するテクスチャ（ブラウザで 1 回だけ作る）
export function metroTextures() {
  if (shared) return shared;
  shared = {
    tile: tileWallTexture(),
    floor: floorTileTexture(),
    granite: graniteTexture(),
    darkGranite: graniteTexture({ base: '#7b7570', joint: 0.6 }),
    perforated: perforatedTexture({ base: '#a7aaad' }),
    darkPerforated: perforatedTexture({ base: '#4a4b4e', hole: '#1c1d1f' }),
    brushed: brushedTexture(),
    concrete: concreteTexture(),
    trainFloor: trainFloorTexture(),
    fabric: seatFabricTexture(),
  };
  return shared;
}

// 駅ごとの壁のタイル（色の帯）
const stripeCache = new Map();
export function stripedTileTexture(color) {
  if (!stripeCache.has(color)) stripeCache.set(color, tileWallTexture({ stripe: color }));
  return stripeCache.get(color);
}
