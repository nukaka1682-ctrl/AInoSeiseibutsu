// トゥールーズのファサード（建物の正面）の手続き的テクスチャ。
// 実際の街並みの写真を手本に、よくある 9 つの様式を描き分けて 1 枚のアトラスにまとめる。
//   0 レンガむき出し＋白い石の窓枠（邸宅の中庭など）   1 レンガ＋木の鎧戸と鉄の手すり
//   2 黄土色の漆喰＋レンガの窓枠                          3 灰褐色の漆喰＋レンガと石を交互に積んだ窓枠
//   4 サーモン色の漆喰＋白い鎧戸                          5 クリーム色の石造り（オスマン風）
//   6 現代的な建物                                        7 ばら色の漆喰＋半円アーチの窓
//   8 キャピトル広場を囲むレンガ造り（1 階は半円アーチのアーケード、窓の下に石の手すり）
// 漆喰の色は写真の色（日なたで黄土色 #c8b48a・サーモン色・灰褐色）に合わせて、彩度を抑えてある（黄色・橙に寄りすぎない）。
// どの様式も、雨だれ（窓台の両端から下へ）と、1 階の足元の暗い石の腰壁（約 0.8 m）で古びた感じを出す。
// アトラスは様式ごとに縦に並べた 1024×256 のセル（横 4 ベイ = 14 m、縦 1 フロア）。
// 頂点の UV は u = 壁に沿った位置 / 14 m、v = 様式 × 1000 + 階数 で、シェーダーで様式のセルを選ぶ。
import * as THREE from 'three';
import { mulberry32 } from '../geo.js';

export const FACADE_STYLES = 9;
export const STYLE = { brickStone: 0, brickShutters: 1, ochre: 2, taupe: 3, salmon: 4, cream: 5, modern: 6, rose: 7, arcade: 8 };

const W = 1024, CELL = 256, BAYW = 256;

const STYLES = [
  { wall: 'brick', bricks: ['#c27d5a', '#c98a66', '#b8704e', '#cf9874', '#c4825f', '#ad6a4c', '#cc916e', '#bb7b5b'], mortar: '#d6c7ad', trim: 'stone', shutters: null, panes: 4, balcony: [0, 0, 1, 0], lintel: true, band: 'stone', door: '#3e4a45', shop: '#2f3b36' },
  { wall: 'brick', bricks: ['#c6876a', '#bb7b60', '#cd9475', '#b3715a', '#c98d70', '#d09c80', '#bf8064'], mortar: '#d9c8b2', trim: 'brick', shutters: ['#8a9a9c', '#7d8f86', '#97a2a4', '#6f8592'], panes: 3, balcony: [1, 0, 1, 1], band: 'brick', door: '#5a3a2a', shop: '#6b2a2a' },
  { wall: 'plaster', plaster: '#cdb38c', trim: 'brick', shutters: null, panes: 4, balcony: [0, 1, 0, 0], band: 'brick', door: '#2f4a3c', shop: '#24332c', keystone: true },
  { wall: 'plaster', plaster: '#b9ac94', trim: 'harpe', shutters: null, panes: 4, balcony: [0, 0, 0, 0], band: 'brick', door: '#4a3426', shop: '#3b3330' },
  { wall: 'plaster', plaster: '#cb9f86', trim: 'brick', shutters: ['#efeee8', '#e9e7df', '#f3f1ea', '#e5e3da'], panes: 3, balcony: [1, 0, 0, 1], band: 'brick', door: '#2a2d33', shop: '#1f2226' },
  { wall: 'stone', plaster: '#d8cbb0', trim: 'molded', shutters: ['#9aa0a0', '#a4a8a6', '#8f9696', '#a9aba8'], panes: 3, balcony: [1, 1, 1, 1], band: 'stone', door: '#3b3530', shop: '#2c2a28' },
  { wall: 'plaster', plaster: '#d3ccc0', trim: 'none', shutters: null, panes: 1, balcony: [0, 1, 0, 1], band: 'none', modern: true, door: '#555b60', shop: '#3a4046' },
  { wall: 'plaster', plaster: '#cfa594', trim: 'brick', shutters: null, panes: 3, balcony: [0, 0, 0, 0], band: 'brick', arched: true, door: '#4b3a2c', shop: '#5c2c28' },
  { wall: 'brick', bricks: ['#bf7454', '#b66d4f', '#c47e5e', '#ad684b', '#c17a59', '#b97250'], mortar: '#d6c3a8', trim: 'brick', shutters: null, panes: 3, balcony: [0, 0, 0, 0], balustrade: true, band: 'brick', arcade: true, door: '#3a3632', shop: '#2b2826' },
];

function canvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return [c, c.getContext('2d')];
}

function shade(hex, k) {
  const c = new THREE.Color(hex);
  return `rgb(${Math.min(255, Math.round(c.r * 255 * k))},${Math.min(255, Math.round(c.g * 255 * k))},${Math.min(255, Math.round(c.b * 255 * k))})`;
}

// トゥールーズの薄いレンガ（brique foraine）。写真を手本に、1 段 5 px（約 7 cm）のうちレンガは 3.5 px で、
// 目地（砂色の石灰モルタル）は太め。レンガの長さ 26〜34 px（約 36〜46 cm）で、縦目地の位置は段ごとに不規則
function brickFill(ctx, x0, y0, w, h, st, rnd) {
  ctx.fillStyle = st.mortar;
  ctx.fillRect(x0, y0, w, h);
  ctx.save();
  ctx.beginPath();
  ctx.rect(x0, y0, w, h);
  ctx.clip();
  for (let y = y0, row = 0; y < y0 + h; y += 5, row++) {
    let x = x0 - Math.floor(rnd() * 30);
    while (x < x0 + w) {
      const len = 26 + Math.floor(rnd() * 9);
      const base = st.bricks[Math.floor(rnd() * st.bricks.length)];
      ctx.fillStyle = shade(base, 0.9 + rnd() * 0.2);
      ctx.fillRect(x + 1, y + 0.7, len - 1.5, 3.5);
      if (rnd() < 0.35) {
        // 焼きムラ: 端が濃い
        ctx.fillStyle = 'rgba(70,30,15,0.18)';
        ctx.fillRect(rnd() < 0.5 ? x + 1 : x + len - 8, y + 0.7, 7, 3.5);
      }
      x += len;
    }
  }
  ctx.restore();
  // 汚れ・色あせ
  for (let i = 0; i < (w * h) / 900; i++) {
    ctx.fillStyle = `rgba(${rnd() < 0.5 ? '40,20,10' : '255,230,200'},${0.05 + rnd() * 0.07})`;
    ctx.fillRect(x0 + rnd() * w, y0 + rnd() * h, 6 + rnd() * 30, 3 + rnd() * 10);
  }
}

// 漆喰: 地の色に大きなムラ・細かいざらつき・雨だれ
function plasterFill(ctx, x0, y0, w, h, color, rnd, ashlar = false) {
  ctx.fillStyle = color;
  ctx.fillRect(x0, y0, w, h);
  for (let i = 0; i < 26; i++) {
    const r = 30 + rnd() * 90, x = x0 + rnd() * w, y = y0 + rnd() * h;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    const dark = rnd() < 0.55;
    g.addColorStop(0, dark ? 'rgba(60,50,40,0.10)' : 'rgba(255,250,235,0.10)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    for (const dx of [-W, 0, W]) ctx.fillRect(x + dx - r, y - r, r * 2, r * 2);
  }
  for (let i = 0; i < (w * h) / 40; i++) {
    const v = rnd() < 0.5 ? 0 : 255;
    ctx.fillStyle = `rgba(${v},${v},${v},${0.03 + rnd() * 0.05})`;
    ctx.fillRect(x0 + rnd() * w, y0 + rnd() * h, 1 + rnd() * 2, 1 + rnd() * 2);
  }
  for (let i = 0; i < 10; i++) {
    ctx.fillStyle = 'rgba(50,40,30,0.05)';
    ctx.fillRect(x0 + rnd() * w, y0, 2 + rnd() * 5, h);
  }
  if (ashlar) {
    // 切り石の目地
    ctx.fillStyle = 'rgba(90,80,65,0.22)';
    for (let y = y0 + 32; y < y0 + h; y += 32) ctx.fillRect(x0, y, w, 1);
    for (let y = y0, row = 0; y < y0 + h; y += 32, row++) {
      for (let x = x0 + (row % 2 ? 0 : 48); x < x0 + w; x += 96) ctx.fillRect(x, y, 1, 32);
    }
  }
}

function wallFill(ctx, x0, y0, w, h, st, rnd) {
  if (st.wall === 'brick') brickFill(ctx, x0, y0, w, h, st, rnd);
  else plasterFill(ctx, x0, y0, w, h, st.plaster, rnd, st.wall === 'stone');
}

const STONE = '#e6dac2', STONE_DARK = '#cbbd9f', BRICK_TRIM = ['#ad5c43', '#a1543e', '#b6654a', '#a8583f'];

function brickBlocks(ctx, x, y, w, h, rnd, k = 1) {
  for (let yy = y; yy < y + h; yy += 5) {
    ctx.fillStyle = '#d4b29a';
    ctx.fillRect(x, yy, w, 5);
    ctx.fillStyle = shade(BRICK_TRIM[Math.floor(rnd() * BRICK_TRIM.length)], k * (0.92 + rnd() * 0.15));
    ctx.fillRect(x, yy, w, 4);
  }
}

// 窓まわりの枠（石・レンガ・レンガと石の交互積み・モールディング）
function surround(ctx, st, x, y, w, h, rnd, arched) {
  const t = 14;
  if (st.trim === 'none') return;
  if (st.trim === 'stone' || st.trim === 'molded') {
    ctx.fillStyle = STONE;
    ctx.fillRect(x - t, y - t, w + t * 2, h + t);
    ctx.fillStyle = 'rgba(0,0,0,0.12)';
    ctx.fillRect(x - t, y - t, w + t * 2, 2);
    ctx.fillRect(x - 3, y - 3, w + 6, 3);
    if (st.trim === 'molded') {
      ctx.strokeStyle = 'rgba(80,70,55,0.35)';
      ctx.lineWidth = 1;
      ctx.strokeRect(x - t + 4, y - t + 4, w + t * 2 - 8, h + t - 4);
    }
    return;
  }
  if (st.trim === 'harpe') {
    // レンガ 3 段と石を交互に（灰緑の漆喰の家）
    for (let yy = y - t, i = 0; yy < y + h; yy += 15, i++) {
      const long = i % 2 === 0;
      for (const side of [-1, 1]) {
        const bx = side < 0 ? x - t - (long ? 6 : 0) : x + w;
        const bw = t + (long ? 6 : 0);
        if (i % 2) {
          ctx.fillStyle = STONE;
          ctx.fillRect(bx, yy, bw, 14);
        } else brickBlocks(ctx, bx, yy, bw, 15, rnd);
      }
    }
    brickBlocks(ctx, x - t, y - t, w + t * 2, 15, rnd);
    return;
  }
  // レンガの枠（上は弓形のアーチ）
  brickBlocks(ctx, x - t, y, t, h, rnd);
  brickBlocks(ctx, x + w, y, t, h, rnd);
  if (!arched) {
    ctx.save();
    ctx.beginPath();
    ctx.ellipse(x + w / 2, y + 8, w / 2 + t, 22, 0, Math.PI, 0);
    ctx.lineTo(x + w + t, y + 8);
    ctx.closePath();
    ctx.clip();
    brickBlocks(ctx, x - t, y - 16, w + t * 2, 26, rnd, 0.95);
    ctx.restore();
    if (st.keystone) {
      ctx.fillStyle = STONE;
      ctx.fillRect(x + w / 2 - 7, y - 16, 14, 20);
    }
  }
}

function glass(ctx, x, y, w, h, rnd, curtains) {
  const g = ctx.createLinearGradient(x, y, x + w * 0.3, y + h);
  g.addColorStop(0, '#6d7f8c');
  g.addColorStop(0.45, '#33404b');
  g.addColorStop(1, '#1d242b');
  ctx.fillStyle = g;
  ctx.fillRect(x, y, w, h);
  if (curtains) {
    ctx.fillStyle = 'rgba(235,232,225,0.55)';
    ctx.fillRect(x + 2, y + 2, w * 0.38, h - 4);
    ctx.fillRect(x + w * 0.62 - 2, y + 2, w * 0.38, h - 4);
  }
  ctx.fillStyle = 'rgba(255,255,255,0.10)';
  ctx.beginPath();
  ctx.moveTo(x, y + h * 0.15);
  ctx.lineTo(x + w * 0.5, y);
  ctx.lineTo(x + w * 0.75, y);
  ctx.lineTo(x, y + h * 0.5);
  ctx.fill();
}

// 窓（両開きのフランス窓。小さなガラスに分かれた桟）
function windowPanes(ctx, x, y, w, h, panes, modern) {
  ctx.fillStyle = '#f1efe9';
  const f = 3;
  ctx.fillRect(x, y, w, f);
  ctx.fillRect(x, y + h - f, w, f);
  ctx.fillRect(x, y, f, h);
  ctx.fillRect(x + w - f, y, f, h);
  ctx.fillRect(x + w / 2 - 2, y, 4, h);
  if (modern) return;
  for (let i = 1; i < panes; i++) ctx.fillRect(x, y + (h * i) / panes - 1, w, 2);
  // 欄間
  ctx.fillRect(x, y + h * 0.18, w, 3);
}

function shutters(ctx, x, y, w, h, color, closed, rnd) {
  const leaf = (sx, sw) => {
    ctx.fillStyle = color;
    ctx.fillRect(sx, y - 2, sw, h + 4);
    ctx.fillStyle = 'rgba(0,0,0,0.20)';
    for (let yy = y + 3; yy < y + h; yy += 4) ctx.fillRect(sx + 3, yy, sw - 6, 1.5);
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    ctx.fillRect(sx, y - 2, 1, h + 4);
    ctx.fillRect(sx + sw - 1, y - 2, 1, h + 4);
    ctx.fillRect(sx, y + h * 0.5, sw, 2);
  };
  if (closed) {
    leaf(x, w / 2);
    leaf(x + w / 2, w / 2);
  } else {
    leaf(x - w / 2 - 15, w / 2);
    leaf(x + w + 15, w / 2);
  }
  if (rnd() < 0.3) {
    ctx.fillStyle = 'rgba(0,0,0,0.12)';
    ctx.fillRect(x - w / 2 - 15, y + h * 0.2, w / 2, 3);
  }
}

// 鉄の手すり（バルコネット）。portion = 窓の下からの高さ
function railing(ctx, x, y, w, rnd, fancy) {
  ctx.fillStyle = '#1e1e1e';
  ctx.fillRect(x - 6, y, w + 12, 3);
  ctx.fillRect(x - 6, y + 58, w + 12, 3);
  for (let xx = x - 4; xx <= x + w + 4; xx += 6) ctx.fillRect(xx, y, 1.5, 60);
  if (fancy) {
    ctx.strokeStyle = '#1e1e1e';
    ctx.lineWidth = 1.5;
    for (let xx = x + 8; xx < x + w; xx += 24) {
      ctx.beginPath();
      ctx.arc(xx, y + 30, 8, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
}

// 窓台の両端（とときどき中ほど）から下へ流れる雨だれ。セルは縦に繰り返すので、下端を越えた分は上端（下の階）に続ける
function rainStreaks(ctx, x0, x1, y, rnd) {
  const xs = [x0, x1];
  if (rnd() < 0.5) xs.push(x0 + (x1 - x0) * (0.3 + rnd() * 0.4));
  for (const x of xs) {
    const w = 3 + rnd() * 8, len = 45 + rnd() * 80, a = 0.07 + rnd() * 0.09;
    for (const dy of [0, -CELL]) {
      const g = ctx.createLinearGradient(0, y + dy, 0, y + dy + len);
      g.addColorStop(0, `rgba(45,36,28,${a})`);
      g.addColorStop(1, 'rgba(45,36,28,0)');
      ctx.fillStyle = g;
      ctx.fillRect(x - w / 2, y + dy, w, len);
    }
  }
}

// 窓の下の石の手すり（キャピトル広場の建物）
function balustrade(ctx, x, y, w) {
  ctx.fillStyle = '#e3d6c0';
  ctx.fillRect(x, y, w, 7);
  ctx.fillRect(x, y + 44, w, 8);
  for (let xx = x + 5; xx < x + w - 6; xx += 13) {
    ctx.fillStyle = '#ddcfb7';
    ctx.beginPath();
    ctx.ellipse(xx + 4, y + 26, 4.5, 15, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(70,50,35,0.25)';
    ctx.fillRect(xx + 6, y + 12, 2, 28);
  }
  ctx.fillStyle = 'rgba(0,0,0,0.22)';
  ctx.fillRect(x, y + 7, w, 2);
  ctx.fillRect(x, y + 52, w, 2);
}

// 上の階のセル
function drawUpper(ctx, st, rnd) {
  wallFill(ctx, 0, 0, W, CELL, st, rnd);
  // 階の境の帯（石・レンガの持ち送り）
  if (st.band === 'stone') {
    ctx.fillStyle = STONE;
    ctx.fillRect(0, CELL - 10, W, 10);
    ctx.fillStyle = 'rgba(0,0,0,0.15)';
    ctx.fillRect(0, CELL - 10, W, 2);
  } else if (st.band === 'brick') {
    brickBlocks(ctx, 0, CELL - 10, W, 10, rnd, 0.85);
    ctx.fillStyle = 'rgba(0,0,0,0.18)';
    ctx.fillRect(0, CELL - 11, W, 1);
  }
  for (let b = 0; b < 4; b++) {
    const cx = b * BAYW + BAYW / 2;
    const ww = st.modern ? 104 : 88, top = st.modern ? 60 : 44, wh = st.modern ? 150 : 178;
    const x = cx - ww / 2;
    surround(ctx, st, x, top, ww, wh, rnd, st.arched);
    if (st.arched) {
      // 半円アーチの窓（レンガのアーチ）
      ctx.save();
      ctx.beginPath();
      ctx.arc(cx, top + ww / 2, ww / 2 + 14, Math.PI, 0);
      ctx.closePath();
      ctx.clip();
      brickBlocks(ctx, x - 14, top - 14, ww + 28, ww / 2 + 14, rnd);
      ctx.restore();
      ctx.save();
      ctx.beginPath();
      ctx.arc(cx, top + ww / 2, ww / 2, Math.PI, 0);
      ctx.lineTo(x + ww, top + wh);
      ctx.lineTo(x, top + wh);
      ctx.closePath();
      ctx.clip();
      glass(ctx, x, top, ww, wh, rnd, b % 2 === 0);
      windowPanes(ctx, x, top, ww, wh, st.panes, false);
      ctx.restore();
    } else {
      glass(ctx, x, top, ww, wh, rnd, b === 1 || b === 2);
      windowPanes(ctx, x, top, ww, wh, st.panes, st.modern);
    }
    if (st.modern) {
      // 巻き上げシャッターの箱
      ctx.fillStyle = '#c9c6bf';
      ctx.fillRect(x - 4, top - 16, ww + 8, 14);
      ctx.fillStyle = 'rgba(0,0,0,0.25)';
      ctx.fillRect(x - 4, top - 3, ww + 8, 2);
    }
    // 石の窓台
    ctx.fillStyle = st.trim === 'brick' || st.trim === 'harpe' ? STONE_DARK : STONE;
    ctx.fillRect(x - 18, top + wh, ww + 36, 7);
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    ctx.fillRect(x - 18, top + wh + 7, ww + 36, 2);
    if (st.lintel) {
      // 窓の上の石のひさし
      ctx.fillStyle = STONE;
      ctx.fillRect(x - 22, top - 26, ww + 44, 10);
      ctx.fillStyle = 'rgba(0,0,0,0.2)';
      ctx.fillRect(x - 22, top - 16, ww + 44, 2);
    }
    if (st.shutters) shutters(ctx, x, top, ww, wh, st.shutters[b % st.shutters.length], b === 3, rnd);
    if (st.balcony[b]) railing(ctx, x, top + wh - 60, ww, rnd, st.wall === 'stone' || b === 2);
    if (st.balustrade) balustrade(ctx, x - 10, top + wh - 54, ww + 20);
    // 窓台の両端からの雨だれ
    rainStreaks(ctx, x - 14, x + ww + 14, top + wh + 9, rnd);
  }
}

// 足元の腰壁（soubassement、約 0.8 m）: レンガの家は暗い灰褐色の切り石、漆喰の家は漆喰より暗い色。下ほど泥はねで暗い
function plinth(ctx, st, rnd) {
  const PH = 52; // 1 階の高さ 3.4〜3.8 m のうち約 0.8 m
  const y0 = CELL - PH;
  ctx.fillStyle = st.wall === 'brick' ? '#7f7468' : st.modern ? '#8c8781' : shade(st.plaster, 0.66);
  ctx.fillRect(0, y0, W, PH);
  for (let i = 0; i < W * PH / 12; i++) {
    ctx.fillStyle = rnd() < 0.5 ? 'rgba(30,25,20,0.12)' : 'rgba(255,245,230,0.10)';
    ctx.fillRect(rnd() * W, y0 + rnd() * PH, 1 + rnd() * 2, 1);
  }
  if (!st.modern) {
    // 切り石の目地（2 段）
    ctx.fillStyle = 'rgba(30,24,18,0.28)';
    ctx.fillRect(0, y0 + PH / 2, W, 1.5);
    for (let row = 0; row < 2; row++) {
      for (let x = rnd() * 70; x < W; x += 60 + rnd() * 50) ctx.fillRect(x, y0 + row * (PH / 2) + 2, 1.5, PH / 2 - 2);
    }
  }
  // 天端の水切り（明るい縁と影）
  ctx.fillStyle = 'rgba(255,248,235,0.25)';
  ctx.fillRect(0, y0, W, 3);
  ctx.fillStyle = 'rgba(0,0,0,0.25)';
  ctx.fillRect(0, y0 + 3, W, 2);
  const g = ctx.createLinearGradient(0, CELL, 0, y0 - 12);
  g.addColorStop(0, 'rgba(35,28,22,0.40)');
  g.addColorStop(1, 'rgba(35,28,22,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, y0 - 12, W, PH + 12);
}

// キャピトル広場のアーケード: 各ベイに半円アーチ（幅約 2.6 m）。奥は暗く、店のガラスと吊り下げた角灯が見える
function arcade(ctx, st, rnd) {
  for (let b = 0; b < 4; b++) {
    const cx = b * BAYW + BAYW / 2, r = 94, spring = 118;
    const opening = () => {
      ctx.beginPath();
      ctx.arc(cx, spring, r, Math.PI, 0);
      ctx.lineTo(cx + r, CELL);
      ctx.lineTo(cx - r, CELL);
      ctx.closePath();
    };
    // レンガのアーチの迫石
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, spring, r + 20, Math.PI, 0);
    ctx.arc(cx, spring, r, 0, Math.PI, true);
    ctx.closePath();
    ctx.clip();
    brickBlocks(ctx, cx - r - 22, spring - r - 22, (r + 22) * 2, r + 24, rnd, 0.92);
    ctx.restore();
    ctx.fillStyle = STONE;
    ctx.fillRect(cx - 9, spring - r - 22, 18, 24); // 要石
    for (const s of [-1, 1]) ctx.fillRect(cx + s * (r + 10) - 12, spring - 6, 24, 9); // 迫元の石
    // 奥（アーケードの中は日陰）
    ctx.save();
    opening();
    ctx.clip();
    ctx.fillStyle = '#2b2522';
    ctx.fillRect(cx - r, spring - r, r * 2, CELL);
    glass(ctx, cx - r * 0.62, spring - 22, r * 1.24, CELL - spring + 6, rnd, false);
    ctx.fillStyle = 'rgba(25,20,18,0.55)';
    ctx.fillRect(cx - r, spring - r, r * 2, CELL);
    const g = ctx.createLinearGradient(0, spring - r, 0, spring);
    g.addColorStop(0, 'rgba(10,8,6,0.6)');
    g.addColorStop(1, 'rgba(10,8,6,0)');
    ctx.fillStyle = g;
    ctx.fillRect(cx - r, spring - r, r * 2, r);
    // 吊り下げた角灯
    ctx.fillStyle = '#1b1a18';
    ctx.fillRect(cx - 1, spring - r, 2, 40);
    ctx.fillRect(cx - 10, spring - r + 40, 20, 4);
    ctx.fillStyle = '#d8cfae';
    ctx.fillRect(cx - 8, spring - r + 44, 16, 22);
    ctx.fillStyle = '#1b1a18';
    ctx.fillRect(cx - 10, spring - r + 66, 20, 3);
    ctx.restore();
  }
}

// 1 階（地上階）のセル: 馬車門・店・格子の窓・玄関
function drawGround(ctx, st, rnd) {
  wallFill(ctx, 0, 0, W, CELL, st, rnd);
  plinth(ctx, st, rnd);
  // 1 階の上の帯
  ctx.fillStyle = st.wall === 'plaster' ? shade(st.plaster, 0.9) : STONE;
  ctx.fillRect(0, 0, W, 8);
  if (st.arcade) {
    arcade(ctx, st, rnd);
    return;
  }
  const trimStone = st.trim === 'stone' || st.trim === 'molded' || st.trim === 'none';

  // ベイ 0: 半円アーチの馬車門（porte cochère）
  {
    const cx = 128, r = 92, spring = 110;
    if (trimStone) {
      ctx.fillStyle = STONE;
      ctx.beginPath();
      ctx.arc(cx, spring, r + 16, Math.PI, 0);
      ctx.lineTo(cx + r + 16, CELL);
      ctx.lineTo(cx - r - 16, CELL);
      ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,0.18)';
      ctx.lineWidth = 1;
      for (let a = Math.PI; a <= 2 * Math.PI + 0.01; a += Math.PI / 9) {
        ctx.beginPath();
        ctx.moveTo(cx + Math.cos(a) * r, spring + Math.sin(a) * r);
        ctx.lineTo(cx + Math.cos(a) * (r + 16), spring + Math.sin(a) * (r + 16));
        ctx.stroke();
      }
    } else {
      // レンガと石を交互に積んだアーチ
      for (let i = 0; i < 12; i++) {
        const a0 = Math.PI + (i / 12) * Math.PI, a1 = Math.PI + ((i + 1) / 12) * Math.PI;
        ctx.fillStyle = i % 2 ? STONE : shade(BRICK_TRIM[i % 4], 1);
        ctx.beginPath();
        ctx.arc(cx, spring, r + 18, a0, a1);
        ctx.arc(cx, spring, r, a1, a0, true);
        ctx.fill();
      }
      for (let y = spring, i = 0; y < CELL; y += 18, i++) {
        for (const sx of [cx - r - 18, cx + r]) {
          if (i % 2) {
            ctx.fillStyle = STONE;
            ctx.fillRect(sx, y, 18, 17);
          } else brickBlocks(ctx, sx, y, 18, 18, rnd);
        }
      }
    }
    ctx.fillStyle = st.door;
    ctx.beginPath();
    ctx.arc(cx, spring, r, Math.PI, 0);
    ctx.lineTo(cx + r, CELL - 2);
    ctx.lineTo(cx - r, CELL - 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.35)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(cx, spring - r);
    ctx.lineTo(cx, CELL);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    for (const px of [cx - r + 14, cx + 14]) {
      for (let y = spring - 10; y < CELL - 20; y += 44) ctx.strokeRect(px, y, r - 28, 36);
    }
  }
  // ベイ 1: 店（塗装した木の枠・看板・ショーウィンドウ）
  {
    const x = 256 + 22, w = 212;
    ctx.fillStyle = st.shop;
    ctx.fillRect(x, 26, w, CELL - 26);
    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    for (let i = 0; i < 9; i++) ctx.fillRect(x + 40 + i * 15, 38, 10, 10);
    glass(ctx, x + 12, 66, w - 24, CELL - 66 - 30, rnd, false);
    ctx.fillStyle = 'rgba(240,220,170,0.25)';
    ctx.fillRect(x + 20, CELL - 90, w - 40, 50);
    ctx.fillStyle = st.shop;
    ctx.fillRect(x + w / 2 - 3, 66, 6, CELL - 96);
    ctx.fillRect(x, CELL - 30, w, 30);
  }
  // ベイ 2: 鉄格子の小窓
  {
    const x = 512 + 80, y = 56, w = 96, h = 120;
    surround(ctx, st, x, y, w, h, rnd, false);
    glass(ctx, x, y, w, h, rnd, false);
    windowPanes(ctx, x, y, w, h, 3, false);
    ctx.fillStyle = '#2a2a2a';
    for (let xx = x + 6; xx < x + w; xx += 11) ctx.fillRect(xx, y - 4, 3, h + 6);
    ctx.fillRect(x - 4, y + h * 0.33, w + 8, 3);
    ctx.fillRect(x - 4, y + h * 0.66, w + 8, 3);
    ctx.fillStyle = STONE_DARK;
    ctx.fillRect(x - 14, y + h, w + 28, 7);
  }
  // ベイ 3: 玄関（木の扉と明かり取り）
  {
    const x = 768 + 84, y = 40, w = 88, h = CELL - 40;
    ctx.fillStyle = trimStone || st.trim === 'harpe' ? STONE : shade(BRICK_TRIM[0], 1);
    ctx.fillRect(x - 16, y - 16, w + 32, h + 16);
    ctx.fillStyle = STONE;
    ctx.fillRect(x + w / 2 - 9, y - 18, 18, 22);
    glass(ctx, x, y, w, 40, rnd, false);
    ctx.fillStyle = '#2a2a2a';
    for (let xx = x + 8; xx < x + w; xx += 12) ctx.fillRect(xx, y, 2, 40);
    ctx.fillStyle = st.door;
    ctx.fillRect(x, y + 44, w, h - 44);
    ctx.strokeStyle = 'rgba(255,255,255,0.1)';
    ctx.lineWidth = 2;
    ctx.strokeRect(x + 10, y + 56, w / 2 - 15, 70);
    ctx.strokeRect(x + w / 2 + 5, y + 56, w / 2 - 15, 70);
    ctx.strokeRect(x + 10, y + 140, w / 2 - 15, h - 160);
    ctx.strokeRect(x + w / 2 + 5, y + 140, w / 2 - 15, h - 160);
    ctx.fillStyle = '#c9a85a';
    ctx.fillRect(x + w / 2 + 8, y + 130, 4, 4);
  }
  // 壁付けの街灯（トゥールーズの角灯）
  {
    const x = 640 + 100;
    ctx.strokeStyle = '#1e1e1e';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(x, 30);
    ctx.quadraticCurveTo(x + 22, 18, x + 34, 30);
    ctx.stroke();
    ctx.fillStyle = '#1e1e1e';
    ctx.fillRect(x + 26, 30, 16, 4);
    ctx.fillStyle = '#e8e2c8';
    ctx.fillRect(x + 28, 34, 12, 18);
    ctx.fillStyle = '#1e1e1e';
    ctx.fillRect(x + 26, 52, 16, 3);
  }
}

// 窓のない壁（境界の壁・切妻など）の色: 漆喰・石の様式はその色、レンガの様式は null（レンガの色にする）
export function stylePlainColor(style) {
  const st = STYLES[style];
  return st && st.wall !== 'brick' ? st.plaster : null;
}

// 上の階用と 1 階用のアトラス（どちらも 1024 × 256·様式数）
export function makeFacadeAtlases() {
  const make = (draw, seed) => {
    const [c, ctx] = canvas(W, CELL * FACADE_STYLES);
    STYLES.forEach((st, k) => {
      const rnd = mulberry32(seed + k * 101);
      const y0 = CELL * (FACADE_STYLES - 1 - k); // 画像は上下が反転して貼られる（v = 0 が画像の下端）
      ctx.save();
      ctx.translate(0, y0);
      ctx.beginPath();
      ctx.rect(0, 0, W, CELL);
      ctx.clip();
      draw(ctx, st, rnd);
      ctx.restore();
    });
    const t = new THREE.CanvasTexture(c);
    t.wrapS = THREE.RepeatWrapping;
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 8;
    return t;
  };
  return { upper: make(drawUpper, 17), ground: make(drawGround, 29) };
}

// 壁の足元の陰（地面に近いほど空が見えず暗い。世界座標の高さ vWallY で決める）
const CONTACT_SHADE = 'diffuseColor.rgb *= mix(0.7, 1.0, smoothstep(0.0, 1.3, vWallY));';
function addWallY(shader) {
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nvarying float vWallY;')
    .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWallY = (modelMatrix * vec4(transformed, 1.0)).y;');
  shader.fragmentShader = shader.fragmentShader.replace('#include <common>', '#include <common>\nvarying float vWallY;');
}

// 窓のない壁・教会の壁にも足元の陰を付ける
export function useContactShade(material) {
  material.onBeforeCompile = (shader) => {
    addWallY(shader);
    shader.fragmentShader = shader.fragmentShader.replace('#include <color_fragment>', `#include <color_fragment>\n${CONTACT_SHADE}`);
  };
  material.customProgramCacheKey = () => 'contact-shade';
  return material;
}

// アトラスから様式のセルを選んで縦に繰り返すようにマテリアルを書き換える。
// 頂点カラーには（明るさ, 暖かさ, 軒の高さ）を入れてある（buildings.js の facadeColor）: 軒下の 1 m は雨が当たらず
// 汚れが残り、軒の陰にもなるので少し暗くする。足元の陰も付ける
export function useFacadeAtlas(material) {
  material.onBeforeCompile = (shader) => {
    addWallY(shader);
    shader.fragmentShader = shader.fragmentShader.replace('#include <color_fragment>', `#ifdef USE_COLOR
        diffuseColor.rgb *= vColor.r * vec3(1.0, 1.0 - vColor.g * 0.5, 1.0 - vColor.g);
        diffuseColor.rgb *= mix(0.8, 1.0, smoothstep(0.0, 1.0, vColor.b - vWallY));
      #endif
      ${CONTACT_SHADE}`);
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <map_fragment>',
      `#ifdef USE_MAP
        float facadeStyle = floor((vMapUv.y + 100.0) / 1000.0);
        vec2 facadeUv = vec2(vMapUv.x, vMapUv.y - facadeStyle * 1000.0);
        const float FN = ${FACADE_STYLES}.0;
        vec2 atlasUv = vec2(facadeUv.x, (facadeStyle + 0.015 + fract(facadeUv.y) * 0.97) / FN);
        vec2 gScale = vec2(1.0, 0.97 / FN);
        vec4 sampledDiffuseColor = textureGrad(map, atlasUv, dFdx(facadeUv) * gScale, dFdy(facadeUv) * gScale);
        diffuseColor *= sampledDiffuseColor;
      #endif`,
    );
  };
  material.customProgramCacheKey = () => 'facade-atlas';
  return material;
}

// ---- キャピトル（市庁舎）の正面 ----
// 長さ 128 m・高さ 24 m を 4096×768 px（32 px/m）に描く。上の空の部分は透明（手すりの上の壺・彫像・破風だけ残す）。
// 1 階はレンガと白い石の縞、2 階はばら色のレンガに白い石の付け柱、中央に 8 本のばら色の大理石の円柱と
// 「CAPITOLIUM」の破風、屋上に手すり。
export const CAPITOLE_HEIGHT = 24;
export function makeCapitoleTexture() {
  const PX = 32, WIDTH = 4096, HEIGHT = CAPITOLE_HEIGHT * PX;
  const [c, ctx] = canvas(WIDTH, HEIGHT);
  const rnd = mulberry32(1760);
  const X = (m) => m * PX;
  const Y = (m) => HEIGHT - m * PX; // 高さ m の画像上の y
  const rect = (x0, y0, x1, y1, color) => {
    ctx.fillStyle = color;
    ctx.fillRect(X(x0), Y(y1), X(x1 - x0), (y1 - y0) * PX);
  };
  const PINK_BRICK = ['#c4765e', '#bb6c55', '#c97f66', '#b5664f', '#c27560'];
  const STONE_W = '#eee7da', STONE_S = '#d8cfbf', SHADOW = 'rgba(60,40,30,0.25)';
  const LEFT = [10, 52], RIGHT = [76, 118], CENTER = [52, 76];
  const bays = [];
  for (const [a, b] of [LEFT, RIGHT]) for (let i = 0; i < 11; i++) bays.push(a + ((b - a) * (i + 0.5)) / 11);
  const BAY_W = (LEFT[1] - LEFT[0]) / 11;

  // 2 階（7.0〜16.6 m）: ばら色の細かいレンガ（先に目地の色で塗っておく。透明のままだと穴が開く）
  rect(0, 7.0, 128, 16.6, '#d9b8a5');
  for (let y = Y(16.6); y < Y(7.0); y += 4) {
    const off = (y / 4) % 2 ? 0 : 12;
    for (let x = -24 + off; x < WIDTH; x += 24) {
      ctx.fillStyle = shade(PINK_BRICK[Math.floor(rnd() * PINK_BRICK.length)], 0.95 + rnd() * 0.1);
      ctx.fillRect(x, y, 23, 3);
    }
  }
  ctx.fillStyle = 'rgba(225,190,170,0.35)';
  for (let y = Y(16.6) + 3; y < Y(7.0); y += 4) ctx.fillRect(0, y, WIDTH, 1);
  // 1 階（0〜6.4 m）: 白い石とレンガの縞
  for (let m = 0.6; m < 6.4; m += 0.75) {
    rect(0, m, 128, Math.min(6.4, m + 0.45), '#bf6f57');
    rect(0, m + 0.45, 128, Math.min(6.4, m + 0.75), '#e9e1d2');
    rect(0, m + 0.45, 128, m + 0.47, SHADOW);
  }
  rect(0, 0, 128, 0.6, '#b9b2a6');
  // 1 階と 2 階の間の帯、2 階の上の entablature（梁）
  rect(0, 6.4, 128, 7.0, STONE_W);
  rect(0, 6.4, 128, 6.46, SHADOW);
  rect(0, 16.6, 128, 18.0, STONE_W);
  rect(0, 16.6, 128, 16.66, SHADOW);
  for (let x = 0; x < 128; x += 0.4) rect(x, 17.55, x + 0.22, 17.75, STONE_S); // 歯飾り
  rect(0, 17.75, 128, 18.0, '#f4eee3');

  const glassFill = (x0, y0, x1, y1) => {
    const g = ctx.createLinearGradient(0, Y(y1), 0, Y(y0));
    g.addColorStop(0, '#536373');
    g.addColorStop(1, '#25303a');
    ctx.fillStyle = g;
    ctx.fillRect(X(x0), Y(y1), X(x1 - x0), (y1 - y0) * PX);
    ctx.fillStyle = '#f2efe8';
    ctx.fillRect(X((x0 + x1) / 2) - 2, Y(y1), 4, (y1 - y0) * PX);
    for (let m = y0 + (y1 - y0) / 4; m < y1 - 0.05; m += (y1 - y0) / 4) ctx.fillRect(X(x0), Y(m) - 1, X(x1 - x0), 2);
  };
  // 半円アーチの開口（1 階の窓・扉）
  const arch = (cx, w, y0, y1, door) => {
    const r = w / 2;
    ctx.fillStyle = STONE_W;
    ctx.beginPath();
    ctx.arc(X(cx), Y(y1 - r), X(r + 0.22), Math.PI, 0);
    ctx.lineTo(X(cx + r + 0.22), Y(y0));
    ctx.lineTo(X(cx - r - 0.22), Y(y0));
    ctx.fill();
    ctx.save();
    ctx.beginPath();
    ctx.arc(X(cx), Y(y1 - r), X(r), Math.PI, 0);
    ctx.lineTo(X(cx + r), Y(y0));
    ctx.lineTo(X(cx - r), Y(y0));
    ctx.closePath();
    ctx.clip();
    if (door) {
      ctx.fillStyle = '#4a3a2e';
      ctx.fillRect(X(cx - r), Y(y1), X(w), (y1 - y0) * PX);
      ctx.strokeStyle = 'rgba(255,255,255,0.12)';
      ctx.lineWidth = 2;
      for (const s of [-1, 1]) for (let m = y0 + 0.4; m < y1 - r; m += 1.1) ctx.strokeRect(X(cx + (s < 0 ? -r + 0.2 : 0.15)), Y(m + 0.9), X(r - 0.35), 0.9 * PX - 4);
      ctx.fillStyle = 'rgba(0,0,0,0.4)';
      ctx.fillRect(X(cx) - 1, Y(y1), 2, (y1 - y0) * PX);
    } else {
      glassFill(cx - r, y0, cx + r, y1);
      ctx.fillStyle = '#26282a';
      for (let x = cx - r + 0.18; x < cx + r; x += 0.22) ctx.fillRect(X(x), Y(y1), 3, (y1 - y0) * PX);
    }
    ctx.restore();
    rect(cx - 0.15, y1 - 0.25, cx + 0.15, y1 + 0.2, STONE_W); // 要石
  };
  // 2 階の窓（石の枠・弓形の破風・バルコネット・上の飾り板）
  const tallWindow = (cx, w, balcony = true) => {
    const x0 = cx - w / 2, x1 = cx + w / 2;
    rect(x0 - 0.28, 7.5, x1 + 0.28, 12.9, STONE_W);
    rect(x0 - 0.28, 7.5, x1 + 0.28, 7.56, SHADOW);
    glassFill(x0, 7.7, x1, 12.65);
    // 弓形の破風
    ctx.fillStyle = STONE_W;
    ctx.beginPath();
    ctx.ellipse(X(cx), Y(13.0), X(w / 2 + 0.55), 0.55 * PX, 0, Math.PI, 0);
    ctx.fill();
    rect(x0 - 0.55, 12.9, x1 + 0.55, 13.05, STONE_S);
    // 飾り板（花綱の浮き彫り）
    rect(cx - 0.75, 13.9, cx + 0.75, 15.5, STONE_S);
    rect(cx - 0.62, 14.0, cx + 0.62, 15.4, STONE_W);
    ctx.strokeStyle = 'rgba(120,100,80,0.45)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.ellipse(X(cx), Y(14.7), X(0.42), 0.5 * PX, 0, 0, Math.PI * 2);
    ctx.stroke();
    if (balcony) {
      ctx.fillStyle = '#1d1c1a';
      ctx.fillRect(X(x0 - 0.15), Y(8.75), X(w + 0.3), 4);
      ctx.fillRect(X(x0 - 0.15), Y(7.75), X(w + 0.3), 4);
      for (let x = x0; x <= x1; x += 0.12) ctx.fillRect(X(x), Y(8.75), 2, 1.0 * PX);
      ctx.fillStyle = '#c9a85a'; // 金の飾り
      for (let x = x0 + 0.25; x < x1; x += 0.5) ctx.fillRect(X(x) - 3, Y(8.3) - 3, 6, 6);
    }
  };
  // 白い石の付け柱
  const pilaster = (x) => {
    rect(x - 0.35, 7.0, x + 0.35, 16.6, '#f1ece2');
    rect(x - 0.35, 7.0, x - 0.3, 16.6, 'rgba(0,0,0,0.12)');
    rect(x - 0.48, 15.9, x + 0.48, 16.6, STONE_W);
    rect(x - 0.48, 15.9, x + 0.48, 15.96, SHADOW);
    rect(x - 0.45, 7.0, x + 0.45, 7.4, STONE_S);
  };
  // 手すりと台座・壺
  const balustrade = (x0, x1) => {
    rect(x0, 18.0, x1, 18.25, '#efe9de');
    rect(x0, 18.95, x1, 19.25, '#f3eee5');
    for (let x = x0 + 0.1; x < x1 - 0.05; x += 0.26) {
      ctx.fillStyle = '#ece5d8';
      ctx.beginPath();
      ctx.ellipse(X(x + 0.08), Y(18.6), 0.09 * PX, 0.32 * PX, 0, 0, Math.PI * 2);
      ctx.fill();
    }
  };
  const urn = (x, y = 19.25) => {
    rect(x - 0.4, y, x + 0.4, y + 0.55, '#ebe4d6');
    ctx.fillStyle = '#e7e0d1';
    ctx.beginPath();
    ctx.ellipse(X(x), Y(y + 1.05), 0.32 * PX, 0.45 * PX, 0, 0, Math.PI * 2);
    ctx.fill();
    rect(x - 0.1, y + 1.4, x + 0.1, y + 1.75, '#e7e0d1');
  };
  const statue = (x, y, h = 2.2) => {
    ctx.fillStyle = '#ddd5c6';
    rect(x - 0.45, y, x + 0.45, y + 0.5, '#e9e2d4');
    ctx.beginPath();
    ctx.moveTo(X(x - 0.35), Y(y + 0.5));
    ctx.lineTo(X(x - 0.25), Y(y + h * 0.75));
    ctx.lineTo(X(x - 0.45), Y(y + h * 0.85));
    ctx.lineTo(X(x - 0.1), Y(y + h * 0.9));
    ctx.lineTo(X(x + 0.3), Y(y + h * 0.7));
    ctx.lineTo(X(x + 0.35), Y(y + 0.5));
    ctx.fill();
    ctx.beginPath();
    ctx.arc(X(x), Y(y + h * 0.95), 0.17 * PX, 0, Math.PI * 2);
    ctx.fill();
  };

  // 両翼のベイ
  for (const x of bays) {
    arch(x, 1.5, 0.9, 4.9, false);
    tallWindow(x, 1.6, true);
  }
  for (let i = 0; i <= 11; i++) {
    pilaster(LEFT[0] + i * BAY_W);
    pilaster(RIGHT[0] + i * BAY_W);
  }
  balustrade(0, 128);
  for (let i = 0; i <= 11; i += 2) {
    urn(LEFT[0] + i * BAY_W);
    urn(RIGHT[0] + i * BAY_W);
  }
  // 両端のパビリオン
  for (const [a, b] of [[0, 10], [118, 128]]) {
    const cx = (a + b) / 2;
    arch(cx, 2.6, 0.6, 5.6, true);
    tallWindow(cx - 2.4, 1.6, false);
    tallWindow(cx + 2.4, 1.6, false);
    pilaster(a + 0.5);
    pilaster(b - 0.5);
    pilaster(cx);
    urn(a + 0.6);
    urn(b - 0.6);
  }
  // 中央部: 3 つの窓・時計・8 本の円柱
  rect(CENTER[0], 7.0, CENTER[1], 16.6, 'rgba(255,240,230,0.10)');
  for (const x of [58, 70]) {
    arch(x, 1.6, 0.9, 5.0, false);
    tallWindow(x, 1.7, true);
  }
  arch(64, 3.0, 0.6, 5.6, true);
  tallWindow(64, 1.9, true);
  // 時計
  ctx.fillStyle = STONE_W;
  ctx.beginPath();
  ctx.arc(X(64), Y(14.6), 0.85 * PX, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#f8f6f0';
  ctx.beginPath();
  ctx.arc(X(64), Y(14.6), 0.65 * PX, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#2a2a2a';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(X(64), Y(14.6));
  ctx.lineTo(X(64), Y(15.1));
  ctx.moveTo(X(64), Y(14.6));
  ctx.lineTo(X(64.35), Y(14.5));
  ctx.stroke();
  // 国旗・EU 旗・オクシタニーの旗
  [['#2b4fa0', '#f5f5f5', '#d23a3a'], ['#1f3f99'], ['#c8102e']].forEach((cols, i) => {
    const x = 63.2 + i * 0.75;
    ctx.fillStyle = '#c9a85a';
    ctx.fillRect(X(x), Y(10.6), 3, 1.6 * PX);
    cols.forEach((col, k) => rect(x + 0.05, 9.0 + (k * 1.4) / cols.length, x + 0.65, 9.0 + ((k + 1) * 1.4) / cols.length, col));
    if (i === 2) rect(x + 0.25, 9.5, x + 0.45, 9.9, '#f2c94c');
  });
  // ばら色の大理石の円柱（2 本ずつ）
  for (const x of [53.6, 55.2, 60.8, 62.0, 66.0, 67.2, 72.8, 74.4]) {
    const g = ctx.createLinearGradient(X(x - 0.5), 0, X(x + 0.5), 0);
    g.addColorStop(0, '#b5786c');
    g.addColorStop(0.35, '#e1aa9d');
    g.addColorStop(1, '#a86c60');
    ctx.fillStyle = g;
    ctx.fillRect(X(x - 0.45), Y(16.0), X(0.9), 9.0 * PX);
    rect(x - 0.6, 15.9, x + 0.6, 16.6, '#f3eee4'); // 柱頭
    ctx.fillStyle = '#d9cfbd';
    ctx.beginPath();
    ctx.arc(X(x - 0.45), Y(16.15), 0.16 * PX, 0, Math.PI * 2);
    ctx.arc(X(x + 0.45), Y(16.15), 0.16 * PX, 0, Math.PI * 2);
    ctx.fill();
    rect(x - 0.6, 7.0, x + 0.6, 7.45, '#ece5d8'); // 柱礎
  }
  // 梁の「CAPITOLIUM」
  ctx.fillStyle = '#b8924a';
  ctx.font = `bold ${Math.round(0.42 * PX)}px serif`;
  ctx.textAlign = 'center';
  ctx.fillText('C A P I T O L I U M', X(64), Y(16.95));
  // 破風（中央の三角形）と彫刻
  ctx.fillStyle = '#efe8dc';
  ctx.beginPath();
  ctx.moveTo(X(53), Y(18.0));
  ctx.lineTo(X(64), Y(22.2));
  ctx.lineTo(X(75), Y(18.0));
  ctx.fill();
  ctx.strokeStyle = '#d3c9b6';
  ctx.lineWidth = 6;
  ctx.stroke();
  ctx.fillStyle = '#d7cdbb';
  ctx.beginPath();
  ctx.ellipse(X(64), Y(19.6), 1.6 * PX, 1.0 * PX, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = 'rgba(110,95,75,0.5)';
  ctx.lineWidth = 2;
  for (let i = 0; i < 9; i++) {
    ctx.beginPath();
    ctx.arc(X(60 + i), Y(19.0 + (i % 3) * 0.25), 0.35 * PX, 0, Math.PI * 1.5);
    ctx.stroke();
  }
  statue(64, 22.0, 1.9);
  statue(53.4, 18.0, 2.3);
  statue(74.6, 18.0, 2.3);
  // 汚れ・雨だれ
  for (let i = 0; i < 400; i++) {
    ctx.fillStyle = `rgba(60,45,35,${0.02 + rnd() * 0.04})`;
    ctx.fillRect(rnd() * WIDTH, Y(18) + rnd() * 18 * PX, 2 + rnd() * 6, 10 + rnd() * 60);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

// ---- 教会の壁（サン・セルナンなど南仏のレンガの教会）----
// 8 m × 16 m を 512 × 1024 px に描く（u = 壁に沿って 8 m、v = 地面から 16 m で繰り返す）。
// 下は石の腰と白い石の縞、端に控え壁（石とレンガの交互積み）、中ほどに半円アーチの高窓、軒下に小さな窓の列
export const CHURCH_TILE = { w: 8, h: 16 };
export function makeChurchTexture() {
  const PX = 64, WIDTH = CHURCH_TILE.w * PX, HEIGHT = CHURCH_TILE.h * PX;
  const [c, ctx] = canvas(WIDTH, HEIGHT);
  const rnd = mulberry32(1080);
  const Y = (m) => HEIGHT - m * PX;
  const BR = ['#c9785a', '#c27154', '#cf8263', '#b9694f', '#d08867', '#c47658'];
  const STONE = '#e9e0cf', STONE_D = '#d4c8b2', DARK = '#2c2f33';
  // レンガ
  ctx.fillStyle = '#dcbca7';
  ctx.fillRect(0, 0, WIDTH, HEIGHT);
  for (let y = 0, row = 0; y < HEIGHT; y += 4, row++) {
    for (let x = -26 + (row % 2 ? 13 : 0); x < WIDTH; x += 26) {
      ctx.fillStyle = BR[Math.floor(rnd() * BR.length)];
      ctx.fillRect(x, y, 25, 3);
    }
  }
  // 腰石と白い石の縞
  ctx.fillStyle = STONE_D;
  ctx.fillRect(0, Y(0.8), WIDTH, 0.8 * PX);
  for (const m of [1.5, 2.6, 3.7]) {
    ctx.fillStyle = '#dfd4bf';
    ctx.fillRect(0, Y(m + 0.15), WIDTH, 0.15 * PX);
  }
  // 控え壁（左右の端）: 少し濃いレンガで、張り出した影を付ける
  for (const x0 of [0, WIDTH - 0.5 * PX]) {
    ctx.fillStyle = 'rgba(70,30,20,0.16)';
    ctx.fillRect(x0, 0, 0.5 * PX, HEIGHT);
    ctx.fillStyle = 'rgba(0,0,0,0.12)';
    ctx.fillRect(x0 === 0 ? 0.5 * PX - 3 : x0, 0, 3, HEIGHT);
  }
  // 半円アーチの高窓（石の縁取り）
  const arched = (cx, w, y0, y1, ring) => {
    const r = w / 2;
    ctx.fillStyle = STONE;
    ctx.beginPath();
    ctx.moveTo(cx - r - ring, Y(y0));
    ctx.lineTo(cx - r - ring, Y(y1 - r / PX));
    ctx.arc(cx, Y(y1) + r, r + ring, Math.PI, 0);
    ctx.lineTo(cx + r + ring, Y(y0));
    ctx.fill();
    ctx.fillStyle = DARK;
    ctx.beginPath();
    ctx.moveTo(cx - r, Y(y0));
    ctx.lineTo(cx - r, Y(y1 - r / PX));
    ctx.arc(cx, Y(y1) + r, r, Math.PI, 0);
    ctx.lineTo(cx + r, Y(y0));
    ctx.fill();
    // 鉛の桟
    ctx.strokeStyle = 'rgba(160,170,180,0.35)';
    ctx.lineWidth = 1.5;
    for (let m = y0 + 0.4; m < y1 - 0.4; m += 0.45) {
      ctx.beginPath();
      ctx.moveTo(cx - r, Y(m));
      ctx.lineTo(cx + r, Y(m));
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.moveTo(cx, Y(y0));
    ctx.lineTo(cx, Y(y1) + r);
    ctx.stroke();
    ctx.fillStyle = STONE_D;
    ctx.fillRect(cx - r - ring - 4, Y(y0) - 2, 2 * (r + ring) + 8, 8); // 窓台
  };
  arched(WIDTH / 2, 1.5 * PX, 5.6, 11.4, 14);
  for (const cx of [WIDTH * 0.32, WIDTH * 0.68]) arched(cx, 0.55 * PX, 13.0, 14.6, 8);
  // 軒の石の帯
  ctx.fillStyle = STONE;
  ctx.fillRect(0, Y(15.75), WIDTH, 0.3 * PX);
  ctx.fillStyle = 'rgba(0,0,0,0.18)';
  ctx.fillRect(0, Y(15.45), WIDTH, 3);
  // 汚れ
  for (let i = 0; i < 260; i++) {
    ctx.fillStyle = `rgba(50,35,25,${0.02 + rnd() * 0.05})`;
    ctx.fillRect(rnd() * WIDTH, rnd() * HEIGHT, 2 + rnd() * 5, 20 + rnd() * 80);
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}
