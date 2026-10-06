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

// トゥールーズの薄いレンガ（brique foraine）の壁を描く。写真（Wikimedia Commons の Toulouse の煉瓦壁）を手本に:
// レンガは長さ約 36 cm・厚さ約 5.5 cm、目地は 2 cm 前後と太く、砂色の石灰モルタル。縦目地の位置は段ごとに不規則。
// レンガは焼きムラで濃淡があり、角が丸く下の縁に影ができる。ppm: 1 m あたりのピクセル数
function brickWall(ctx, W, H, ppm, rnd, { bricks, mortar, grain = 0.18 }) {
  const course = Math.round(0.078 * ppm), bh = Math.max(2, Math.round(0.05 * ppm));
  ctx.fillStyle = mortar;
  ctx.fillRect(0, 0, W, H);
  // モルタルのざらつき
  for (let i = 0; i < (W * H) / 14; i++) {
    ctx.fillStyle = rnd() < 0.5 ? 'rgba(90,70,50,0.18)' : 'rgba(255,250,235,0.22)';
    ctx.fillRect(rnd() * W, rnd() * H, 1, 1);
  }
  for (let y = 0; y < H; y += course) {
    let x = -Math.floor(rnd() * 0.3 * ppm);
    while (x < W) {
      const len = Math.round((0.3 + rnd() * 0.12) * ppm);
      const gap = Math.max(1, Math.round((0.012 + rnd() * 0.012) * ppm));
      const c = bricks[Math.floor(rnd() * bricks.length)];
      const k = 0.93 + rnd() * 0.12;
      const top = y + Math.round((course - bh) / 2) + (rnd() < 0.2 ? 1 : 0);
      ctx.fillStyle = shade(c, k);
      ctx.fillRect(x, top, len, bh);
      // 下の縁の影・上の縁の明るさ（角の丸み）
      ctx.fillStyle = 'rgba(40,20,10,0.28)';
      ctx.fillRect(x, top + bh - 1, len, 1);
      ctx.fillStyle = 'rgba(255,235,210,0.18)';
      ctx.fillRect(x, top, len, 1);
      // 焼きムラ（端が濃い・中ほどに斑点）
      if (rnd() < 0.5) {
        ctx.fillStyle = 'rgba(60,25,10,0.18)';
        ctx.fillRect(rnd() < 0.5 ? x : x + len - len * 0.25, top, len * 0.25, bh);
      }
      for (let k2 = 0; k2 < len / 6; k2++) {
        ctx.fillStyle = rnd() < 0.5 ? `rgba(70,30,15,${grain})` : `rgba(255,225,190,${grain})`;
        ctx.fillRect(x + rnd() * len, top + rnd() * bh, 1 + rnd() * 2, 1);
      }
      // 角の欠け
      if (rnd() < 0.15) {
        ctx.fillStyle = mortar;
        ctx.fillRect(rnd() < 0.5 ? x : x + len - 2, top, 2, 1 + Math.floor(rnd() * 2));
      }
      x += len + gap;
    }
  }
}

function shade(hex, k) {
  const c = new THREE.Color(hex);
  return `rgb(${Math.min(255, Math.round(c.r * 255 * k))},${Math.min(255, Math.round(c.g * 255 * k))},${Math.min(255, Math.round(c.b * 255 * k))})`;
}

// 窓のない壁（教会・切妻部分・隣と接する壁など）。色は頂点カラーで付けるので、明るさの模様だけ（4 m で 1 周）
export function makePlainWallTexture() {
  const S = 512;
  const [c, ctx] = canvas(S, S);
  brickWall(ctx, S, S, S / 4, mulberry32(11), { bricks: ['#d8d0cc', '#cfc4bf', '#e2dad5', '#c6bbb5', '#ddd2c9'], mortar: '#fffaf2', grain: 0.12 });
  return toTexture(c);
}

// 敷地の塀（4 m で 1 周、v = 0 が地面）。brick: レンガむき出し、render: 漆喰（ところどころはがれてレンガが見える）
export function makeEnclosureTexture(kind) {
  const S = 512, ppm = S / 4;
  const [c, ctx] = canvas(S, S);
  const rnd = mulberry32(kind === 'brick' ? 21 : 22);
  brickWall(ctx, S, S, ppm, rnd, {
    bricks: ['#cf8a62', '#d6956b', '#c27a52', '#dda07a', '#c98258', '#bb734e', '#d89470', '#c7845e'],
    mortar: '#cdb99b',
  });
  if (kind === 'render') {
    // 漆喰: 大きな面で覆い、はがれた所だけレンガを残す
    const [m, mctx] = canvas(S, S);
    mctx.fillStyle = '#ddcaa8';
    mctx.fillRect(0, 0, S, S);
    for (let i = 0; i < 40; i++) {
      const r = 20 + rnd() * 80, x = rnd() * S, y = rnd() * S;
      const g = mctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, rnd() < 0.5 ? 'rgba(120,100,70,0.12)' : 'rgba(255,248,230,0.14)');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      mctx.fillStyle = g;
      mctx.fillRect(x - r, y - r, r * 2, r * 2);
    }
    for (let i = 0; i < S * 12; i++) {
      mctx.fillStyle = rnd() < 0.5 ? 'rgba(80,60,40,0.12)' : 'rgba(255,255,245,0.15)';
      mctx.fillRect(rnd() * S, rnd() * S, 1, 1);
    }
    // はがれ（不規則な形）
    mctx.globalCompositeOperation = 'destination-out';
    for (let i = 0; i < 7; i++) {
      const cx = rnd() * S, cy = S - rnd() * S * 0.5;
      mctx.beginPath();
      for (let k = 0; k < 12; k++) {
        const a = (k / 12) * Math.PI * 2, r = (12 + rnd() * 30) * (0.6 + rnd() * 0.6);
        mctx.lineTo(cx + Math.cos(a) * r * 1.6, cy + Math.sin(a) * r);
      }
      mctx.fill();
    }
    mctx.globalCompositeOperation = 'source-over';
    ctx.drawImage(m, 0, 0);
  }
  // 地面から 0.5 m ほどの湿気・泥はね、上から雨だれ
  const g = ctx.createLinearGradient(0, S, 0, S - 0.6 * ppm);
  g.addColorStop(0, 'rgba(50,40,30,0.35)');
  g.addColorStop(1, 'rgba(50,40,30,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, S - 0.6 * ppm, S, 0.6 * ppm);
  for (let i = 0; i < 14; i++) {
    const x = rnd() * S, len = (0.3 + rnd() * 1.2) * ppm;
    const top = S - (1.6 + rnd() * 1.4) * ppm;
    const sg = ctx.createLinearGradient(0, top, 0, top + len);
    sg.addColorStop(0, 'rgba(40,35,30,0.18)');
    sg.addColorStop(1, 'rgba(40,35,30,0)');
    ctx.fillStyle = sg;
    ctx.fillRect(x, top, 3 + rnd() * 10, len);
  }
  return toTexture(c);
}

// 瓦屋根（トゥールーズの丸瓦 = tuile canal）。u: 棟と平行（1.6 m で 1 周）, v: 勾配方向（2 m で 1 周）。
// 下向きの瓦（谷）と上向きの瓦（山）が交互に並び、瓦ごとに焼き色が違い、古い瓦は黒ずむ。色は頂点カラーで付ける
export function makeRoofTileTexture() {
  const W = 256, H = 256;
  const [c, ctx] = canvas(W, H);
  const rnd = mulberry32(5);
  ctx.fillStyle = '#5a4a44';
  ctx.fillRect(0, 0, W, H);
  const tw = 32, th = 52; // 瓦 1 枚: 幅約 20 cm・長さ約 40 cm
  const tint = () => {
    const r = rnd();
    // 焼き色のばらつき: 明るい橙・濃い赤・黄土・黒ずみ
    const hue = r < 0.55 ? [1, 0.97, 0.93] : r < 0.75 ? [0.93, 0.84, 0.8] : r < 0.9 ? [1, 1, 0.86] : [0.72, 0.7, 0.68];
    const k = 0.82 + rnd() * 0.18;
    return hue.map((v) => Math.round(255 * v * k));
  };
  for (const cover of [false, true]) {
    for (let x = cover ? tw / 2 : 0; x < W + tw; x += tw) {
      for (let y = -th + ((x / tw) % 2) * (th / 2) * (cover ? 1 : 0); y < H + th; y += th * 0.8) {
        const [r, g, b] = tint();
        const w = cover ? tw * 0.62 : tw * 0.9;
        const x0 = x - w / 2;
        const grad = ctx.createLinearGradient(x0, 0, x0 + w, 0);
        // 丸みの陰影（山は中央が明るく、谷は中央が暗い）
        const dk = (k) => `rgb(${Math.round(r * k)},${Math.round(g * k)},${Math.round(b * k)})`;
        if (cover) {
          grad.addColorStop(0, dk(0.55));
          grad.addColorStop(0.45, dk(1));
          grad.addColorStop(1, dk(0.6));
        } else {
          grad.addColorStop(0, dk(0.9));
          grad.addColorStop(0.5, dk(0.7));
          grad.addColorStop(1, dk(0.9));
        }
        ctx.fillStyle = grad;
        for (const dx of [-W, 0, W]) for (const dy of [-H, 0, H]) ctx.fillRect(x0 + dx, y + dy, w, th);
        // 瓦の下端の影
        ctx.fillStyle = 'rgba(30,15,10,0.45)';
        for (const dx of [-W, 0, W]) for (const dy of [-H, 0, H]) ctx.fillRect(x0 + dx, y + dy + th - 3, w, 3);
      }
    }
  }
  // 地衣類・苔の斑点
  for (let i = 0; i < 260; i++) {
    ctx.fillStyle = rnd() < 0.6 ? 'rgba(60,55,45,0.25)' : 'rgba(230,220,170,0.25)';
    ctx.beginPath();
    ctx.arc(rnd() * W, rnd() * H, 1 + rnd() * 3, 0, Math.PI * 2);
    ctx.fill();
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

// 石畳（歩行者天国・広場）: 旧市街の歩行者専用の通り（Rue Saint-Rome など）は、淡いベージュ〜灰色の石の板を
// 段ごとにずらして敷き詰めたもの。板は幅 40 cm・長さ 50〜90 cm、色は石ごとに少しずつ違い、目地は細く暗い（4 m で 1 周）
export function makePavingTexture() {
  const S = 512, ppm = S / 4;
  const [c, ctx] = canvas(S, S);
  const rnd = mulberry32(3);
  ctx.fillStyle = '#8f8676';
  ctx.fillRect(0, 0, S, S);
  const stones = ['#d9d1c2', '#cfc6b5', '#e0d8ca', '#c8bfae', '#d4cab6', '#bfb7a8', '#dcd6cc'];
  const row = 0.4 * ppm;
  for (let y = 0; y < S; y += row) {
    let x = -rnd() * 0.6 * ppm;
    while (x < S) {
      const len = (0.5 + rnd() * 0.4) * ppm;
      ctx.fillStyle = shade(stones[Math.floor(rnd() * stones.length)], 0.94 + rnd() * 0.1);
      ctx.fillRect(x + 1, y + 1, len - 2, row - 2);
      // 石の表面のざらつき・すり減り
      for (let k = 0; k < len / 2; k++) {
        ctx.fillStyle = rnd() < 0.5 ? 'rgba(90,80,65,0.12)' : 'rgba(255,255,250,0.14)';
        ctx.fillRect(x + rnd() * len, y + rnd() * row, 1 + rnd() * 2, 1 + rnd() * 2);
      }
      if (rnd() < 0.2) {
        ctx.fillStyle = 'rgba(60,50,40,0.10)';
        ctx.beginPath();
        ctx.ellipse(x + rnd() * len, y + rnd() * row, 4 + rnd() * 10, 3 + rnd() * 6, 0, 0, Math.PI * 2);
        ctx.fill();
      }
      x += len;
    }
  }
  wrapEdges(ctx, S);
  return toTexture(c);
}

// アスファルト（車道）: 細かい骨材の粒、補修の跡（色の違う四角）、細いひび割れ、タイヤの通り道のすり減り。4 m で 1 周
export function makeAsphaltTexture() {
  const S = 512;
  const [c, ctx] = canvas(S, S);
  const rnd = mulberry32(12);
  ctx.fillStyle = '#5f5b57';
  ctx.fillRect(0, 0, S, S);
  // 大きなムラ
  for (let i = 0; i < 30; i++) {
    const r = 30 + rnd() * 110, x = rnd() * S, y = rnd() * S;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, rnd() < 0.5 ? 'rgba(30,30,32,0.18)' : 'rgba(150,148,145,0.12)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    for (const dx of [-S, 0, S]) for (const dy of [-S, 0, S]) ctx.fillRect(x + dx - r, y + dy - r, r * 2, r * 2);
  }
  // 補修の跡
  for (let i = 0; i < 2; i++) {
    const w = 40 + rnd() * 100, h = 30 + rnd() * 70, x = rnd() * (S - w), y = rnd() * (S - h);
    ctx.fillStyle = rnd() < 0.6 ? 'rgba(25,25,28,0.14)' : 'rgba(130,128,124,0.12)';
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = 'rgba(20,20,20,0.25)';
    ctx.lineWidth = 1;
    ctx.strokeRect(x, y, w, h);
  }
  // 骨材の粒
  for (let i = 0; i < S * S * 0.35; i++) {
    const v = rnd();
    ctx.fillStyle = v < 0.45 ? 'rgba(35,35,38,0.55)' : v < 0.9 ? 'rgba(120,118,115,0.5)' : 'rgba(185,180,172,0.7)';
    ctx.fillRect(rnd() * S, rnd() * S, 1, 1);
  }
  // ひび割れ
  ctx.strokeStyle = 'rgba(20,20,22,0.55)';
  ctx.lineWidth = 1;
  for (let i = 0; i < 9; i++) {
    let x = rnd() * S, y = rnd() * S;
    ctx.beginPath();
    ctx.moveTo(x, y);
    const a0 = rnd() * Math.PI * 2;
    for (let k = 0; k < 10; k++) {
      const a = a0 + (rnd() - 0.5) * 1.6;
      x += Math.cos(a) * (5 + rnd() * 12);
      y += Math.sin(a) * (5 + rnd() * 12);
      ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  wrapEdges(ctx, S);
  return toTexture(c);
}

// 歩道: 明るい灰色のアスファルト（トゥールーズの歩道に多い）に細かい粒。4 m で 1 周
export function makeSidewalkTexture() {
  const S = 512;
  const [c, ctx] = canvas(S, S);
  const rnd = mulberry32(13);
  ctx.fillStyle = '#8c8a86';
  ctx.fillRect(0, 0, S, S);
  for (let i = 0; i < 24; i++) {
    const r = 40 + rnd() * 120, x = rnd() * S, y = rnd() * S;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, rnd() < 0.5 ? 'rgba(60,58,55,0.16)' : 'rgba(200,196,188,0.14)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    for (const dx of [-S, 0, S]) for (const dy of [-S, 0, S]) ctx.fillRect(x + dx - r, y + dy - r, r * 2, r * 2);
  }
  for (let i = 0; i < S * S * 0.3; i++) {
    const v = rnd();
    ctx.fillStyle = v < 0.5 ? 'rgba(70,68,65,0.4)' : 'rgba(175,172,166,0.45)';
    ctx.fillRect(rnd() * S, rnd() * S, 1, 1);
  }
  // ガムのしみ
  for (let i = 0; i < 40; i++) {
    ctx.fillStyle = 'rgba(40,40,40,0.35)';
    ctx.beginPath();
    ctx.arc(rnd() * S, rnd() * S, 1.5 + rnd() * 2, 0, Math.PI * 2);
    ctx.fill();
  }
  wrapEdges(ctx, S);
  return toTexture(c);
}

// 道路・建物以外の地面（広場の端・中庭・空き地）: 明るい灰色の舗装と砂利が混ざった、細かい粒の面（6 m で 1 周）
export function makeGroundTexture() {
  const S = 512;
  const [c, ctx] = canvas(S, S);
  const rnd = mulberry32(15);
  ctx.fillStyle = '#9a948a';
  ctx.fillRect(0, 0, S, S);
  for (let i = 0; i < 40; i++) {
    const r = 30 + rnd() * 120, x = rnd() * S, y = rnd() * S;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, rnd() < 0.5 ? 'rgba(90,82,70,0.16)' : 'rgba(200,192,176,0.16)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    for (const dx of [-S, 0, S]) for (const dy of [-S, 0, S]) ctx.fillRect(x + dx - r, y + dy - r, r * 2, r * 2);
  }
  for (let i = 0; i < S * S * 0.3; i++) {
    const v = rnd();
    ctx.fillStyle = v < 0.5 ? 'rgba(80,74,64,0.35)' : 'rgba(190,184,172,0.4)';
    ctx.fillRect(rnd() * S, rnd() * S, 1 + (rnd() < 0.1 ? 1 : 0), 1);
  }
  wrapEdges(ctx, S);
  return toTexture(c);
}

// 繰り返しの継ぎ目を目立たなくする: 端の数ピクセルを反対側と混ぜる
function wrapEdges(ctx, S) {
  const n = 6;
  const img = ctx.getImageData(0, 0, S, S);
  const d = img.data;
  const mix = (i, j, t) => {
    for (let k = 0; k < 3; k++) {
      const a = d[i + k], b = d[j + k];
      d[i + k] = a * (1 - t) + b * t;
    }
  };
  for (let y = 0; y < S; y++) for (let k = 0; k < n; k++) {
    const t = 0.5 * (1 - k / n);
    mix((y * S + k) * 4, (y * S + S - 1 - k) * 4, t);
    mix((y * S + S - 1 - k) * 4, (y * S + k) * 4, t);
  }
  for (let x = 0; x < S; x++) for (let k = 0; k < n; k++) {
    const t = 0.5 * (1 - k / n);
    mix((k * S + x) * 4, ((S - 1 - k) * S + x) * 4, t);
    mix(((S - 1 - k) * S + x) * 4, (k * S + x) * 4, t);
  }
  ctx.putImageData(img, 0, 0);
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
    enclosureBrick: makeEnclosureTexture('brick'),
    enclosureRender: makeEnclosureTexture('render'),
    roof: makeRoofTileTexture(),
    flatRoof: makeNoiseTexture({ base: '#ffffff', spots: ['#777', '#999', '#555'], seed: 4, count: 3000, alpha: 0.3 }),
    asphalt: makeAsphaltTexture(),
    sidewalk: makeSidewalkTexture(),
    paving: makePavingTexture(),
    grass: makeNoiseTexture({ base: '#6f8f45', spots: ['#5a7a35', '#86a356', '#4f6e2e', '#93a85e'], seed: 14, count: 9000, spotSize: 4, alpha: 0.6 }),
    ground: makeGroundTexture(),
    gravel: makeNoiseTexture({ base: '#c9b999', spots: ['#b5a585', '#ddd0b2', '#a39373'], seed: 16, count: 9000, spotSize: 2, alpha: 0.6 }),
    waterNormal: makeWaterNormalTexture(),
  };
}
