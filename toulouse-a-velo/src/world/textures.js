// キャンバスで手続き的に作るテクスチャ。画像ファイルを持たずに「ばら色の街」らしい見た目を出す。
// 建物の正面（窓のある壁）は facades.js で色付きで描く。それ以外は色を頂点カラーで付けるので、ほぼ白で描いておく。
import * as THREE from 'three';
import { mulberry32 } from '../geo.js';
import { makeCapitoleTexture, makeChurchTexture, makeFacadeAtlases } from './facades.js';
import { makeTowerTexture } from './towers.js';

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

// 窓のない壁（教会・切妻部分など）
export function makePlainWallTexture() {
  const W = 256, H = 256;
  const [c, ctx] = canvas(W, H);
  const rnd = mulberry32(11);
  // トゥールーズの薄いレンガ（約 40×5 cm）の段。目地は明るく、レンガは焼きムラで濃淡を付ける（色は頂点カラー）
  ctx.fillStyle = '#fbf6f0';
  ctx.fillRect(0, 0, W, H);
  for (let y = 0, row = 0; y < H; y += 4, row++) {
    const off = row % 2 ? 0 : 16;
    for (let x = -32; x < W; x += 32) {
      const v = 190 + Math.floor(rnd() * 50);
      ctx.fillStyle = `rgb(${v},${v - 6},${v - 10})`;
      ctx.fillRect(x + off + 1, y, 31, 3);
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
  const facades = makeFacadeAtlases();
  return {
    upper: facades.upper,
    shopfront: facades.ground,
    capitole: makeCapitoleTexture(),
    tower: makeTowerTexture(),
    church: makeChurchTexture(),
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
