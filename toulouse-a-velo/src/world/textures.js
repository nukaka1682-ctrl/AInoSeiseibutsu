// キャンバスで手続き的に作るテクスチャ。画像ファイルを持たずに「ばら色の街」らしい見た目を出す。
// 建物の正面（窓のある壁）は facades.js で色付きで描く。それ以外は色を頂点カラーで付けるので、ほぼ白で描いておく。
import * as THREE from 'three';
import { mulberry32 } from '../geo.js';
import { makeCapitoleTexture, makeChurchTexture, makeFacadeAtlases } from './facades.js';
import { makeTowerTexture } from './towers.js';
import { makeMonumentTexture } from './monuments.js';

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

// 16 進数の色を k 倍した sRGB の色。shade() は THREE.Color が線形の色に直した値をそのまま使うので、書いた色より
// かなり暗く・濃くなる（既存のテクスチャはその色合いで合わせてある）。通りの石は写真の色をそのまま書けるようこちらを使う
function shadeSrgb(hex, k) {
  const v = parseInt(hex.slice(1), 16);
  const f = (x) => Math.min(255, Math.round(x * k));
  return `rgb(${f((v >> 16) & 255)},${f((v >> 8) & 255)},${f(v & 255)})`;
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
    bricks: ['#c58a68', '#cc9471', '#b97c5a', '#d29e7e', '#bf835f', '#b27556', '#cd9374', '#bd8463'],
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

// 石 1 個の表面: 花崗岩の細かい粒（明暗の点）と、上の縁の照り・下の縁の陰（丸みのある石の角）
// bevel: 石の縁の明暗（丸みのある小舗石・縁石）。磨いた平らな石の板では付けない
function stoneGrain(ctx, rnd, x, y, w, h, dots, alpha = 0.35, bevel = true) {
  for (let k = 0; k < dots; k++) {
    const v = rnd();
    ctx.fillStyle = v < 0.45 ? `rgba(40,34,34,${alpha})` : v < 0.9 ? `rgba(200,192,190,${alpha})` : `rgba(240,236,232,${alpha + 0.2})`;
    ctx.fillRect(x + rnd() * w, y + rnd() * h, 1 + (rnd() < 0.2 ? 1 : 0), 1);
  }
  if (!bevel) return;
  ctx.fillStyle = 'rgba(255,250,245,0.10)';
  ctx.fillRect(x, y, w, Math.max(1, h * 0.18));
  ctx.fillStyle = 'rgba(20,16,16,0.16)';
  ctx.fillRect(x, y + h * 0.78, w, h * 0.22);
}

// 旧市街の小舗石（pavés）: 約 10 cm 角の灰色〜ふじ色がかった花崗岩（写真 #706c6d〜#8a8080、日陰 #5d5656）を、
// 通りを横切る浅い弧の列（segmental arcs、弦 1.28 m・高さ 12 cm）に並べたもの。目地は暗い砂。
// 通りに沿った UV（u = 横方向、v = 通りの向き）で貼り、2.56 m で 1 周
export function makeSettsTexture() {
  const S = 512, ppm = S / 2.56;
  const [c, ctx] = canvas(S, S);
  const rnd = mulberry32(21);
  ctx.fillStyle = '#4e4645';
  ctx.fillRect(0, 0, S, S);
  // 石は写真の日なたの色（#706c6d〜#8a8080、ふじ色・茶色がかった灰色 #7f675d）。日陰の青い空の光で冷たく見えすぎないよう少し暖かく
  const stones = ['#8a807d', '#928782', '#9a8f89', '#857c7a', '#968a84', '#7d7472', '#9d928c', '#8e8480', '#a2968f'];
  const P = S / 2, sag = 0.12 * ppm; // 弧の幅・高さ
  const rows = 26, rowH = S / rows;
  const arc = (x) => {
    const f = (((x % P) + P) % P) / P * 2 - 1;
    return sag * (1 - f * f);
  };
  for (let r = 0; r < rows; r++) {
    // 列の中の石の幅（8〜12 cm）。端で S にそろえて継ぎ目なく繰り返す
    const xs = [0];
    while (xs[xs.length - 1] < S - 0.13 * ppm) xs.push(xs[xs.length - 1] + (0.08 + rnd() * 0.045) * ppm);
    xs[xs.length - 1] = S;
    for (let k = 0; k + 1 < xs.length; k++) {
      const x0 = xs[k] + 1, x1 = xs[k + 1] - 1;
      const col = shadeSrgb(stones[Math.floor(rnd() * stones.length)], 0.9 + rnd() * 0.16);
      const steps = 4;
      for (const dy of [-S, 0, S]) {
        const y0 = r * rowH + dy;
        ctx.fillStyle = col;
        ctx.beginPath();
        for (let s = 0; s <= steps; s++) {
          const x = x0 + ((x1 - x0) * s) / steps;
          ctx.lineTo(x, y0 + arc(x) + 1.2);
        }
        for (let s = steps; s >= 0; s--) {
          const x = x0 + ((x1 - x0) * s) / steps;
          ctx.lineTo(x, y0 + arc(x) + rowH - 1.2);
        }
        ctx.closePath();
        ctx.fill();
      }
      const yc = r * rowH + arc((x0 + x1) / 2);
      for (const dy of [-S, 0, S]) stoneGrain(ctx, rnd, x0, yc + dy + 1, x1 - x0, rowH - 2, 14, 0.18);
    }
  }
  // 雨の跡・油じみのムラ
  for (let i = 0; i < 14; i++) {
    const r = 30 + rnd() * 90, x = rnd() * S, y = rnd() * S;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, rnd() < 0.5 ? 'rgba(30,26,26,0.14)' : 'rgba(170,160,156,0.10)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    for (const dx of [-S, 0, S]) for (const dy of [-S, 0, S]) ctx.fillRect(x + dx - r, y + dy - r, r * 2, r * 2);
  }
  return toTexture(c);
}

// 側溝（caniveau）: 少し大きな細長い花崗岩（約 12×25 cm）を通りに沿って 2 列に並べた帯。中央の継ぎ目に向かって
// 少しくぼむので、真ん中を暗く。u = 帯の幅（0〜1 で 0.32 m）、v = 通りの向き（2.56 m で 1 周）
export function makeGutterTexture() {
  const W = 64, H = 512, ppm = H / 2.56;
  const [c, ctx] = canvas(W, H);
  const rnd = mulberry32(22);
  ctx.fillStyle = '#4a4544';
  ctx.fillRect(0, 0, W, H);
  const stones = ['#86807e', '#8e8785', '#7f7978', '#958d8a', '#837c7b'];
  for (let col = 0; col < 2; col++) {
    const ys = [col ? -0.12 * ppm : 0];
    while (ys[ys.length - 1] < H - 0.3 * ppm) ys.push(ys[ys.length - 1] + (0.22 + rnd() * 0.08) * ppm);
    ys.push(H + ys[0]);
    for (let k = 0; k + 1 < ys.length; k++) {
      const x0 = col * 32 + 1, y0 = ys[k] + 1, h = ys[k + 1] - ys[k] - 2;
      ctx.fillStyle = shadeSrgb(stones[Math.floor(rnd() * stones.length)], 0.92 + rnd() * 0.14);
      for (const dy of [-H, 0, H]) ctx.fillRect(x0, y0 + dy, 30, h);
      for (const dy of [-H, 0, H]) stoneGrain(ctx, rnd, x0, y0 + dy, 30, h, 30, 0.25);
    }
  }
  const g = ctx.createLinearGradient(0, 0, W, 0);
  g.addColorStop(0, 'rgba(0,0,0,0)');
  g.addColorStop(0.5, 'rgba(10,8,8,0.18)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  return toTexture(c);
}

// 歩道の石の板（Rue du Taur の改修後）: 約 60×30 cm のばら色がかったベージュの石（写真 #bcafa1）を、長い辺を
// 通りに沿わせて 1 列ごとに半分ずらして敷く。目地は細い。u = 横方向、v = 通りの向き（2.4 m で 1 周）
export function makeSlabTexture() {
  const S = 512, ppm = S / 2.4;
  const [c, ctx] = canvas(S, S);
  const rnd = mulberry32(23);
  ctx.fillStyle = '#9c8d80';
  ctx.fillRect(0, 0, S, S);
  // 磨いた石の板は 1 枚ごとの色の差が小さい（写真では遠目にほぼ一様なばら色のベージュ）
  const stones = ['#bcafa1', '#c0b2a4', '#b8ab9d', '#c4b6a9', '#baac9f', '#bfb2a6', '#b5a89b'];
  const cw = 0.3 * ppm, rh = 0.6 * ppm;
  for (let col = 0; col < S / cw; col++) {
    for (let r = -1; r < S / rh + 1; r++) {
      const x = col * cw, y = r * rh + (col % 2) * rh / 2;
      ctx.fillStyle = shadeSrgb(stones[Math.floor(rnd() * stones.length)], 0.97 + rnd() * 0.05);
      ctx.fillRect(x + 1, y + 1, cw - 2, rh - 2);
      stoneGrain(ctx, rnd, x + 1, y + 1, cw - 2, rh - 2, 60, 0.07, false);
      if (rnd() < 0.2) {
        ctx.fillStyle = 'rgba(70,58,50,0.07)';
        ctx.beginPath();
        ctx.ellipse(x + rnd() * cw, y + rnd() * rh, 5 + rnd() * 12, 4 + rnd() * 8, 0, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
  return toTexture(c);
}

// 縁石の花崗岩: 明るい灰色（写真 #8d817d〜#9c9a94）の長さ 0.8〜1.2 m の石を継ぎ目でつないだもの。
// u = 通りの向き（4 m で 1 周）、v = 縁石の天端と立ち上がり（0.5 m）
export function makeCurbTexture() {
  const W = 512, H = 64, ppm = W / 4;
  const [c, ctx] = canvas(W, H);
  const rnd = mulberry32(24);
  ctx.fillStyle = '#6a6562';
  ctx.fillRect(0, 0, W, H);
  const stones = ['#a39f99', '#9c958f', '#aaa59e', '#958c87', '#a19b94'];
  const xs = [0];
  while (xs[xs.length - 1] < W - 1.3 * ppm) xs.push(xs[xs.length - 1] + (0.8 + rnd() * 0.4) * ppm);
  xs.push(W);
  for (let k = 0; k + 1 < xs.length; k++) {
    ctx.fillStyle = shadeSrgb(stones[Math.floor(rnd() * stones.length)], 0.95 + rnd() * 0.1);
    ctx.fillRect(xs[k] + 1.5, 0, xs[k + 1] - xs[k] - 3, H);
    stoneGrain(ctx, rnd, xs[k] + 1.5, 0, xs[k + 1] - xs[k] - 3, H, 500, 0.22);
  }
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

// 水面の法線マップ（スクロールさせて波に見せる。1 枚 = 約 6 m）。さざ波の高さを、向きのそろった（風下へ ±70°）
// 多数の正弦波の和で作る。波長が短いほど小さく（波のスペクトル）、波数は整数で継ぎ目なく繰り返す
export function makeWaterNormalTexture() {
  const S = 256;
  const [c, ctx] = canvas(S, S);
  const img = ctx.createImageData(S, S);
  const rnd = mulberry32(9);
  const waves = [];
  for (let i = 0; i < 40; i++) {
    const k = 2 + Math.pow(rnd(), 1.4) * 14; // 1 枚あたりの波の数
    const ang = 0.35 + (rnd() - 0.5) * 2.4;
    const kx = Math.round(Math.cos(ang) * k), kz = Math.round(Math.sin(ang) * k);
    if (!kx && !kz) continue;
    waves.push({ kx, kz, ph: rnd() * Math.PI * 2, a: (0.6 + rnd() * 0.8) / Math.pow(Math.hypot(kx, kz), 1.25) });
  }
  const gx = new Float32Array(S * S), gz = new Float32Array(S * S);
  let max = 0;
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      let dx = 0, dz = 0;
      for (const w of waves) {
        const d = -Math.sin(((w.kx * x + w.kz * y) / S) * Math.PI * 2 + w.ph) * w.a;
        dx += d * w.kx;
        dz += d * w.kz;
      }
      gx[y * S + x] = dx;
      gz[y * S + x] = dz;
      max = Math.max(max, Math.abs(dx), Math.abs(dz));
    }
  }
  const k = 0.9 / max;
  for (let i = 0; i < S * S; i++) {
    const nx = -gx[i] * k, nz = -gz[i] * k;
    const l = Math.hypot(nx, nz, 1);
    img.data[i * 4] = 128 + (nx / l) * 127;
    img.data[i * 4 + 1] = 128 + (nz / l) * 127;
    img.data[i * 4 + 2] = 128 + (1 / l) * 127;
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return toTexture(c, { srgb: false });
}

// プラタナスのまだらな樹皮（運河沿いの写真: クリーム色 #d6cdb0・オリーブ色 #8a866e・茶色がはがれたうろこ状に混ざる）。
// 木の幹の 1 周 × 約 1 m で 1 枚。プラタナス以外の木は、暗い灰褐色を掛けて使う
export function makeBarkTexture() {
  const S = 256;
  const [c, ctx] = canvas(S, S);
  const rnd = mulberry32(31);
  ctx.fillStyle = '#8c876c';
  ctx.fillRect(0, 0, S, S);
  const colors = ['#d4cbad', '#c9c29f', '#a6a283', '#7d7a58', '#958262', '#b8b394', '#6f6c50'];
  for (let i = 0; i < 70; i++) {
    const cx = rnd() * S, cy = rnd() * S;
    const rx = 10 + rnd() * 34, ry = 8 + rnd() * 26;
    const col = colors[Math.floor(rnd() * colors.length)];
    const pts = [];
    for (let k = 0; k < 9; k++) {
      const a = (k / 9) * Math.PI * 2, f = 0.6 + rnd() * 0.5;
      pts.push([Math.cos(a) * rx * f, Math.sin(a) * ry * f]);
    }
    for (const dx of [-S, 0, S]) {
      for (const dy of [-S, 0, S]) {
        ctx.beginPath();
        pts.forEach(([px, py], k) => (k ? ctx.lineTo(cx + dx + px, cy + dy + py) : ctx.moveTo(cx + dx + px, cy + dy + py)));
        ctx.closePath();
        ctx.fillStyle = col;
        ctx.fill();
        ctx.strokeStyle = 'rgba(60,55,40,0.35)';
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }
  }
  for (let i = 0; i < S * S * 0.25; i++) {
    ctx.fillStyle = rnd() < 0.5 ? 'rgba(40,36,25,0.18)' : 'rgba(255,250,230,0.14)';
    ctx.fillRect(rnd() * S, rnd() * S, 1, 1 + (rnd() < 0.3 ? 1 : 0));
  }
  return toTexture(c);
}

// 壁際の地面の陰の濃さ（alphaMap。v = 0 が壁際で濃く、v = 1 で消える）
export function makeContactTexture() {
  const H = 64;
  const [c, ctx] = canvas(4, H);
  for (let y = 0; y < H; y++) {
    const v = 1 - (y + 0.5) / H; // 画像は上下が反転して貼られる（v = 0 が画像の下端）
    const a = 0.42 * Math.pow(1 - v, 1.8);
    const g = Math.round(a * 255);
    ctx.fillStyle = `rgb(${g},${g},${g})`;
    ctx.fillRect(0, y, 4, 1);
  }
  const t = toTexture(c, { repeat: false, srgb: false, anisotropy: 1 });
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  return t;
}

export function makeTextures() {
  const facades = makeFacadeAtlases();
  return {
    upper: facades.upper,
    shopfront: facades.ground,
    capitole: makeCapitoleTexture(),
    tower: makeTowerTexture(),
    monument: makeMonumentTexture(), // 名所の専用モデル（monuments.js）
    church: makeChurchTexture(),
    plain: makePlainWallTexture(),
    enclosureBrick: makeEnclosureTexture('brick'),
    enclosureRender: makeEnclosureTexture('render'),
    roof: makeRoofTileTexture(),
    flatRoof: makeNoiseTexture({ base: '#ffffff', spots: ['#777', '#999', '#555'], seed: 4, count: 3000, alpha: 0.3 }),
    asphalt: makeAsphaltTexture(),
    sidewalk: makeSidewalkTexture(),
    paving: makePavingTexture(),
    setts: makeSettsTexture(),
    gutter: makeGutterTexture(),
    slabs: makeSlabTexture(),
    curb: makeCurbTexture(),
    grass: makeNoiseTexture({ base: '#6f8f45', spots: ['#5a7a35', '#86a356', '#4f6e2e', '#93a85e'], seed: 14, count: 9000, spotSize: 4, alpha: 0.6 }),
    ground: makeGroundTexture(),
    gravel: makeNoiseTexture({ base: '#c9b999', spots: ['#b5a585', '#ddd0b2', '#a39373'], seed: 16, count: 9000, spotSize: 2, alpha: 0.6 }),
    waterNormal: makeWaterNormalTexture(),
    contact: makeContactTexture(),
  };
}
