// キャンバスで手続き的に作るテクスチャ。画像ファイルを持たずに「ばら色の街」らしい見た目を出す。
// 色は頂点カラーで建物ごとに付けるので、壁テクスチャはほぼ白で描いておく。
import * as THREE from 'three';
import { mulberry32 } from '../geo.js';

function canvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return [c, c.getContext('2d')];
}

function toTexture(c, { repeat = true, srgb = true, anisotropy = 8 } = {}) {
  const t = new THREE.CanvasTexture(c);
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = anisotropy;
  t.needsUpdate = true;
  return t;
}

// レンガ・漆喰の細かいムラ
function speckle(ctx, w, h, rnd, n, alpha) {
  for (let i = 0; i < n; i++) {
    const v = Math.floor(rnd() * 60);
    ctx.fillStyle = `rgba(${v},${v * 0.8},${v * 0.7},${alpha * rnd()})`;
    ctx.fillRect(rnd() * w, rnd() * h, 2 + rnd() * 7, 1 + rnd() * 2);
  }
}

const SHUTTERS = ['#7d8b8f', '#8c9a8a', '#a7a59b', '#6f7f8e', '#9a8f86', '#77857a'];

// 1 フロア × 4 ベイ分（1 ベイ = 3.5 m）。上の階用。
export function makeUpperFacadeTexture() {
  const W = 512, H = 128;
  const [c, ctx] = canvas(W, H);
  const rnd = mulberry32(42);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, H);
  speckle(ctx, W, H, rnd, 1400, 0.10);
  // 階の境目のかすかなライン（コーニス）
  ctx.fillStyle = 'rgba(0,0,0,0.06)';
  ctx.fillRect(0, H - 4, W, 4);
  for (let bay = 0; bay < 4; bay++) {
    const cx = bay * 128 + 64;
    const ww = 40, wh = 76, top = 22;
    const variant = bay % 4;
    // 窓枠
    ctx.fillStyle = '#f4f1ea';
    ctx.fillRect(cx - ww / 2 - 5, top - 5, ww + 10, wh + 9);
    // ガラス
    const g = ctx.createLinearGradient(0, top, 0, top + wh);
    g.addColorStop(0, '#5c6a76');
    g.addColorStop(1, '#262f38');
    ctx.fillStyle = g;
    ctx.fillRect(cx - ww / 2, top, ww, wh);
    // 窓の桟
    ctx.fillStyle = '#e8e4dc';
    ctx.fillRect(cx - 1.5, top, 3, wh);
    ctx.fillRect(cx - ww / 2, top + wh * 0.38, ww, 3);
    // 鎧戸（よろい戸）
    const sc = SHUTTERS[(bay * 3 + 1) % SHUTTERS.length];
    if (variant !== 2) {
      for (const side of [-1, 1]) {
        const sx = side < 0 ? cx - ww / 2 - 5 - 21 : cx + ww / 2 + 5;
        ctx.fillStyle = sc;
        ctx.fillRect(sx, top - 3, 21, wh + 5);
        ctx.fillStyle = 'rgba(0,0,0,0.18)';
        for (let y = top; y < top + wh; y += 5) ctx.fillRect(sx + 2, y, 17, 1.5);
      }
    } else {
      // 閉じた鎧戸
      ctx.fillStyle = sc;
      ctx.fillRect(cx - ww / 2, top, ww, wh);
      ctx.fillStyle = 'rgba(0,0,0,0.18)';
      for (let y = top; y < top + wh; y += 5) ctx.fillRect(cx - ww / 2 + 2, y, ww - 4, 1.5);
      ctx.fillRect(cx - 1, top, 2, wh);
    }
    // 手すり（バルコネット）
    if (variant === 1 || variant === 3) {
      ctx.strokeStyle = '#2b2b2b';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(cx - ww / 2 - 4, top + wh - 22);
      ctx.lineTo(cx + ww / 2 + 4, top + wh - 22);
      for (let x = cx - ww / 2; x <= cx + ww / 2; x += 6) {
        ctx.moveTo(x, top + wh - 22);
        ctx.lineTo(x, top + wh + 2);
      }
      ctx.stroke();
    }
  }
  return toTexture(c);
}

// 1 階（地上階）用。店舗・アーチの扉・車庫など。
export function makeGroundFacadeTexture() {
  const W = 512, H = 128;
  const [c, ctx] = canvas(W, H);
  const rnd = mulberry32(7);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, H);
  speckle(ctx, W, H, rnd, 1400, 0.12);
  // 腰の部分を少し暗く
  ctx.fillStyle = 'rgba(0,0,0,0.08)';
  ctx.fillRect(0, H - 12, W, 12);
  ctx.fillStyle = 'rgba(0,0,0,0.05)';
  ctx.fillRect(0, 0, W, 5);
  const glass = (x, y, w, h) => {
    const g = ctx.createLinearGradient(0, y, 0, y + h);
    g.addColorStop(0, '#4d5a66');
    g.addColorStop(1, '#1b2128');
    ctx.fillStyle = g;
    ctx.fillRect(x, y, w, h);
  };
  // ベイ 0: ショーウィンドウ＋日よけ
  glass(10, 30, 108, 90);
  ctx.fillStyle = '#e9e6df';
  ctx.fillRect(62, 30, 4, 90);
  ctx.fillStyle = '#8b2f2a';
  ctx.beginPath();
  ctx.moveTo(4, 30);
  ctx.lineTo(124, 30);
  ctx.lineTo(118, 18);
  ctx.lineTo(10, 18);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.35)';
  for (let x = 10; x < 120; x += 12) ctx.fillRect(x, 19, 6, 11);
  // ベイ 1: アーチ型の木の扉（トゥールーズの邸宅風）
  ctx.fillStyle = '#efe9df';
  ctx.beginPath();
  ctx.arc(192, 56, 34, Math.PI, 0);
  ctx.lineTo(226, 128);
  ctx.lineTo(158, 128);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = '#4a3326';
  ctx.beginPath();
  ctx.arc(192, 58, 28, Math.PI, 0);
  ctx.lineTo(220, 128);
  ctx.lineTo(164, 128);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = 'rgba(0,0,0,0.25)';
  ctx.fillRect(191, 40, 2, 88);
  // ベイ 2: 小窓
  ctx.fillStyle = '#f4f1ea';
  ctx.fillRect(296, 40, 48, 56);
  glass(301, 45, 38, 46);
  ctx.strokeStyle = '#333';
  ctx.lineWidth = 2;
  for (let x = 305; x < 340; x += 7) {
    ctx.beginPath();
    ctx.moveTo(x, 45);
    ctx.lineTo(x, 91);
    ctx.stroke();
  }
  // ベイ 3: カフェ（ガラス＋看板帯）
  ctx.fillStyle = '#2d4a3e';
  ctx.fillRect(388, 14, 116, 16);
  glass(392, 34, 108, 88);
  ctx.fillStyle = '#e9e6df';
  ctx.fillRect(444, 34, 4, 88);
  return toTexture(c);
}

// 窓のない壁（教会・切妻部分など）
export function makePlainWallTexture() {
  const W = 256, H = 256;
  const [c, ctx] = canvas(W, H);
  const rnd = mulberry32(11);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, H);
  // レンガの段
  for (let y = 0; y < H; y += 8) {
    const off = (y / 8) % 2 ? 0 : 16;
    for (let x = -32; x < W; x += 32) {
      const v = 225 + Math.floor(rnd() * 30);
      ctx.fillStyle = `rgb(${v},${v - 4},${v - 8})`;
      ctx.fillRect(x + off + 1, y + 1, 30, 6);
    }
  }
  return toTexture(c);
}

// 瓦屋根（トゥールーズの丸瓦 = tuile canal）。u: 棟と平行, v: 勾配方向。
export function makeRoofTileTexture() {
  const W = 128, H = 128;
  const [c, ctx] = canvas(W, H);
  const rnd = mulberry32(5);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, H);
  for (let x = 0; x < W; x += 16) {
    for (let y = 0; y < H; y += 32) {
      const g = ctx.createLinearGradient(x, 0, x + 16, 0);
      const k = 0.85 + rnd() * 0.15;
      const v = Math.floor(255 * k);
      g.addColorStop(0, `rgb(${v - 60},${v - 70},${v - 75})`);
      g.addColorStop(0.5, `rgb(${v},${v - 6},${v - 10})`);
      g.addColorStop(1, `rgb(${v - 60},${v - 70},${v - 75})`);
      ctx.fillStyle = g;
      ctx.fillRect(x, y + (x / 16) % 2 * 16, 16, 32);
      ctx.fillStyle = 'rgba(0,0,0,0.25)';
      ctx.fillRect(x, y + (x / 16) % 2 * 16 + 30, 16, 2);
    }
  }
  return toTexture(c);
}

export function makeNoiseTexture({ base, spots, size = 256, seed = 1, count = 4000, spotSize = 3, alpha = 0.25 }) {
  const [c, ctx] = canvas(size, size);
  const rnd = mulberry32(seed);
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, size, size);
  for (let i = 0; i < count; i++) {
    ctx.fillStyle = spots[Math.floor(rnd() * spots.length)];
    ctx.globalAlpha = alpha * rnd();
    const s = 1 + rnd() * spotSize;
    ctx.fillRect(rnd() * size, rnd() * size, s, s);
  }
  ctx.globalAlpha = 1;
  return toTexture(c);
}

// 石畳（歩行者天国・広場）
export function makePavingTexture() {
  const S = 256;
  const [c, ctx] = canvas(S, S);
  const rnd = mulberry32(3);
  ctx.fillStyle = '#b9ad98';
  ctx.fillRect(0, 0, S, S);
  const n = 8;
  const cell = S / n;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const v = 190 + Math.floor(rnd() * 40);
      ctx.fillStyle = `rgb(${v},${v - 8},${v - 22})`;
      ctx.fillRect(x * cell + 1.5 + (y % 2) * cell / 2, y * cell + 1.5, cell - 3, cell - 3);
      if (x === n - 1 && y % 2) ctx.fillRect(1.5 - cell / 2, y * cell + 1.5, cell - 3, cell - 3);
    }
  }
  return toTexture(c);
}

// 水面の法線マップ（スクロールさせて波に見せる）
export function makeWaterNormalTexture() {
  const S = 256;
  const [c, ctx] = canvas(S, S);
  const img = ctx.createImageData(S, S);
  const rnd = mulberry32(9);
  const waves = Array.from({ length: 10 }, () => ({
    kx: Math.round((rnd() - 0.5) * 12), kz: Math.round((rnd() - 0.5) * 12), ph: rnd() * Math.PI * 2, a: 0.3 + rnd() * 0.7,
  }));
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      let dx = 0, dz = 0;
      for (const w of waves) {
        const p = ((w.kx * x + w.kz * y) / S) * Math.PI * 2 + w.ph;
        const d = Math.cos(p) * w.a;
        dx += d * w.kx;
        dz += d * w.kz;
      }
      const i = (y * S + x) * 4;
      img.data[i] = 128 + Math.max(-127, Math.min(127, dx * 2.2));
      img.data[i + 1] = 128 + Math.max(-127, Math.min(127, dz * 2.2));
      img.data[i + 2] = 255;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return toTexture(c, { srgb: false });
}

export function makeTextures() {
  return {
    upper: makeUpperFacadeTexture(),
    shopfront: makeGroundFacadeTexture(),
    plain: makePlainWallTexture(),
    roof: makeRoofTileTexture(),
    flatRoof: makeNoiseTexture({ base: '#ffffff', spots: ['#777', '#999', '#555'], seed: 4, count: 3000, alpha: 0.3 }),
    asphalt: makeNoiseTexture({ base: '#5d5f63', spots: ['#45474b', '#77797d', '#6a6c70'], seed: 12, count: 9000, spotSize: 2, alpha: 0.5 }),
    sidewalk: makeNoiseTexture({ base: '#9d978d', spots: ['#868076', '#b1aba1'], seed: 13, count: 5000, alpha: 0.4 }),
    paving: makePavingTexture(),
    grass: makeNoiseTexture({ base: '#6f8f45', spots: ['#5a7a35', '#86a356', '#4f6e2e', '#93a85e'], seed: 14, count: 9000, spotSize: 4, alpha: 0.6 }),
    ground: makeNoiseTexture({ base: '#8f887a', spots: ['#80796c', '#9d9688', '#756e62'], seed: 15, count: 6000, spotSize: 4, alpha: 0.4 }),
    gravel: makeNoiseTexture({ base: '#c9b999', spots: ['#b5a585', '#ddd0b2', '#a39373'], seed: 16, count: 9000, spotSize: 2, alpha: 0.6 }),
    waterNormal: makeWaterNormalTexture(),
  };
}
