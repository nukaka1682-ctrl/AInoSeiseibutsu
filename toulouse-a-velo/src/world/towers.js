// トゥールーズの八角形の鐘楼（サン・セルナン大聖堂、ジャコバン修道院）を、写真を手本に組み立てる。
// 位置・高さ・太さ・付け根（屋根から出る高さ）は IGN LiDAR HD の表面モデル（0.5 m）で測った値。
// その寸法で段（アーケードの層）・冠・尖塔を作る。高さは地面から（m）。
//   サン・セルナン: 半円アーチの層 ×3 ＋ 尖頭（ミトラ形）アーチの層 ×2、小塔の付いた冠、石の尖塔
//   ジャコバン:     ミトラ形アーチの層 ×4、平らな冠（尖塔なし）
import * as THREE from 'three';
import { mulberry32 } from '../geo.js';

export const TOWERS = [
  { id: 'saint-sernin', lat: 43.60848, lon: 1.442154, base: 22.4, top: 67, radius: 6.3, tiers: ['round', 'round', 'round', 'mitre', 'mitre'], spire: true },
  { id: 'jacobins', lat: 43.603612, lon: 1.440426, base: 28, top: 46, radius: 4, tiers: ['mitre', 'mitre', 'mitre', 'mitre'], spire: false },
];

// buildings（教会）のそばにある鐘楼。buildings に教会がないとき（別のタイル）は作らない
export function findTowers(proj, buildings) {
  const out = [];
  for (const spec of TOWERS) {
    const [x, z] = proj.project(spec.lat, spec.lon);
    const m = 15;
    const b = buildings.find((q) => q.info.isChurch && x > q.bounds.minX - m && x < q.bounds.maxX + m && z > q.bounds.minZ - m && z < q.bounds.maxZ + m);
    if (b) out.push({ spec, building: b, x, z, ground: 0, base: spec.base, top: spec.top, radius: spec.radius });
  }
  return out;
}

// 鐘楼のメッシュを W.tower（テクスチャの区画は TOWER_CELLS）に書く
const CELL = { round: 0, mitre: 1, crown: 2, spire: 3 };
const NCELL = 4;
export function writeTower(t, W) {
  const { spec } = t;
  const n = spec.tiers.length;
  const tiersTop = spec.spire ? t.base + (t.top - t.base) * 0.6 : t.top - 1.6;
  const tierH = (tiersTop - t.base) / n;
  const corner = (r, k, y) => {
    const a = ((k + 0.5) / 8) * Math.PI * 2;
    return [t.x + Math.cos(a) * r, y, t.z + Math.sin(a) * r];
  };
  const face = (r0, r1, y0, y1, cell, uRepeat = 1) => {
    for (let k = 0; k < 8; k++) {
      const a = corner(r0, k, y0), b = corner(r0, k + 1, y0), c = corner(r1, k + 1, y1), d = corner(r1, k, y1);
      const am = ((k + 1) / 8) * Math.PI * 2;
      const n3 = [Math.cos(am), (r0 - r1) / Math.max(0.1, y1 - y0), Math.sin(am)];
      const l = Math.hypot(...n3);
      const u0 = cell / NCELL, u1 = (cell + uRepeat) / NCELL;
      W.quad(a, b, c, d, [n3[0] / l, n3[1] / l, n3[2] / l], [u0, 0], [u1, 0], [u1, 1], [u0, 1]);
    }
  };
  const ledge = (rIn, rOut, y) => {
    // 段の上の張り出し（白い石の帯の上面）
    for (let k = 0; k < 8; k++) {
      const a = corner(rIn, k, y), b = corner(rIn, k + 1, y), c = corner(rOut, k + 1, y), d = corner(rOut, k, y);
      W.quad(a, b, c, d, [0, 1, 0], [0.505, 0.02], [0.52, 0.02], [0.52, 0.04], [0.505, 0.04]);
    }
  };
  // 段: 下から順に少しずつ細くなる
  let r = t.radius;
  // 付け根より下（屋根に埋まる部分）も少し作って、すき間が見えないようにする
  face(r + 0.2, r + 0.2, t.base - 3, t.base, CELL.crown);
  for (let i = 0; i < n; i++) {
    const y0 = t.base + i * tierH, y1 = y0 + tierH;
    const rNext = r * 0.965;
    face(r, r, y0, y1, CELL[spec.tiers[i]]);
    ledge(rNext, r + 0.15, y1);
    r = rNext;
  }
  // 冠（小さなアーチの手すり）と四隅の小塔
  const crownTop = tiersTop + 1.6;
  face(r + 0.15, r + 0.15, tiersTop, crownTop, CELL.crown);
  ledge(0, r + 0.15, tiersTop + 0.02); // 屋上の床
  const turret = (x, z) => {
    const R = 0.42, H = 2.4, seg = 6;
    for (let k = 0; k < seg; k++) {
      const a0 = (k / seg) * Math.PI * 2, a1 = ((k + 1) / seg) * Math.PI * 2;
      const p = (a, rr, y) => [x + Math.cos(a) * rr, y, z + Math.sin(a) * rr];
      const am = (a0 + a1) / 2;
      W.quad(p(a0, R, tiersTop), p(a1, R, tiersTop), p(a1, R, tiersTop + H), p(a0, R, tiersTop + H), [Math.cos(am), 0, Math.sin(am)],
        [0.55, 0.3], [0.56, 0.3], [0.56, 0.5], [0.55, 0.5]);
      W.tri(p(a0, R + 0.05, tiersTop + H), p(a1, R + 0.05, tiersTop + H), [x, tiersTop + H + 1.3, z], [Math.cos(am), 0.5, Math.sin(am)],
        [0.8, 0.1], [0.81, 0.1], [0.805, 0.3]);
    }
  };
  if (spec.spire) {
    for (let k = 0; k < 8; k++) {
      const p = corner(r + 0.1, k, 0);
      turret(p[0], p[2]);
    }
  }
  // 尖塔（八角錐）と頂上の球・十字
  if (spec.spire) {
    const r0 = r * 0.82, y0 = tiersTop + 0.2;
    for (let k = 0; k < 8; k++) {
      const a = corner(r0, k, y0), b = corner(r0, k + 1, y0);
      const am = ((k + 1) / 8) * Math.PI * 2;
      const slope = r0 / (t.top - 1.2 - y0);
      const nl = Math.hypot(1, slope);
      W.tri(a, b, [t.x, t.top - 1.2, t.z], [Math.cos(am) / nl, slope / nl, Math.sin(am) / nl], [0.75, 0], [1, 0], [0.875, 1]);
    }
    const ball = 0.45, by = t.top - 1.0;
    for (let k = 0; k < 6; k++) {
      const a0 = (k / 6) * Math.PI * 2, a1 = ((k + 1) / 6) * Math.PI * 2;
      const p = (a, y, rr) => [t.x + Math.cos(a) * rr, y, t.z + Math.sin(a) * rr];
      W.quad(p(a0, by - ball, ball * 0.6), p(a1, by - ball, ball * 0.6), p(a1, by + ball, ball * 0.6), p(a0, by + ball, ball * 0.6),
        [Math.cos((a0 + a1) / 2), 0, Math.sin((a0 + a1) / 2)], [0.66, 0.9], [0.67, 0.9], [0.67, 0.95], [0.66, 0.95]);
    }
    const cr = (x0, x1, y0, y1) => {
      W.quad([t.x + x0, y0, t.z], [t.x + x1, y0, t.z], [t.x + x1, y1, t.z], [t.x + x0, y1, t.z], [0, 0, 1], [0.66, 0.9], [0.67, 0.9], [0.67, 0.95], [0.66, 0.95]);
      W.quad([t.x + x0, y0, t.z], [t.x + x1, y0, t.z], [t.x + x1, y1, t.z], [t.x + x0, y1, t.z], [0, 0, -1], [0.66, 0.9], [0.67, 0.9], [0.67, 0.95], [0.66, 0.95]);
    };
    cr(-0.06, 0.06, t.top - 0.5, t.top + 1.0);
    cr(-0.35, 0.35, t.top + 0.35, t.top + 0.47);
  }
}

// ---- テクスチャ（4 区画: 半円アーチの層・ミトラ形アーチの層・冠と石・尖塔の石）----
export function makeTowerTexture() {
  const W = 1024, H = 384, CW = 256;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const ctx = c.getContext('2d');
  const rnd = mulberry32(1096);
  const BRICK = ['#c9785a', '#c06f52', '#d08463', '#b9694e', '#cc7d5e'];
  const STONE = '#ebe2d1', STONE_D = '#cfc4b0', DARK = '#2a2421';
  const bricks = (x0, y0, w, h) => {
    ctx.fillStyle = '#d9b6a0';
    ctx.fillRect(x0, y0, w, h);
    for (let y = y0, row = 0; y < y0 + h; y += 4, row++) {
      for (let x = x0 - 14 + (row % 2 ? 7 : 0); x < x0 + w; x += 14) {
        ctx.fillStyle = BRICK[Math.floor(rnd() * BRICK.length)];
        ctx.fillRect(Math.max(x0, x), y, Math.min(13, x0 + w - x), 3);
      }
    }
  };
  // 層の面: 2 つの開口、中央と両端に白い石の小円柱、下に石の帯
  const tier = (x0, mitre) => {
    bricks(x0, 0, CW, H);
    // 下の石の帯（コーニス）
    ctx.fillStyle = STONE;
    ctx.fillRect(x0, H - 22, CW, 22);
    ctx.fillStyle = 'rgba(0,0,0,0.2)';
    ctx.fillRect(x0, H - 22, CW, 3);
    for (const cx of [x0 + 70, x0 + 186]) {
      const w = 66, top = 70, bottom = H - 40;
      // 外側の縁（レンガの段のアーチ）
      ctx.fillStyle = shadeHex(BRICK[2], 0.9);
      ctx.beginPath();
      if (mitre) {
        ctx.moveTo(cx - w / 2 - 12, bottom);
        ctx.lineTo(cx - w / 2 - 12, top + 20);
        ctx.lineTo(cx, top - 30);
        ctx.lineTo(cx + w / 2 + 12, top + 20);
        ctx.lineTo(cx + w / 2 + 12, bottom);
      } else {
        ctx.moveTo(cx - w / 2 - 12, bottom);
        ctx.lineTo(cx - w / 2 - 12, top + 10);
        ctx.arc(cx, top + 10, w / 2 + 12, Math.PI, 0);
        ctx.lineTo(cx + w / 2 + 12, bottom);
      }
      ctx.fill();
      // 開口（暗い）
      ctx.fillStyle = DARK;
      ctx.beginPath();
      if (mitre) {
        ctx.moveTo(cx - w / 2, bottom);
        ctx.lineTo(cx - w / 2, top + 26);
        ctx.lineTo(cx, top - 10);
        ctx.lineTo(cx + w / 2, top + 26);
        ctx.lineTo(cx + w / 2, bottom);
      } else {
        ctx.moveTo(cx - w / 2, bottom);
        ctx.lineTo(cx - w / 2, top + 10);
        ctx.arc(cx, top + 10, w / 2, Math.PI, 0);
        ctx.lineTo(cx + w / 2, bottom);
      }
      ctx.fill();
      // 菱形の飾り（ミトラ形の上）
      if (mitre) {
        ctx.fillStyle = STONE_D;
        ctx.beginPath();
        ctx.moveTo(cx, top - 62);
        ctx.lineTo(cx + 12, top - 48);
        ctx.lineTo(cx, top - 34);
        ctx.lineTo(cx - 12, top - 48);
        ctx.fill();
      }
      // 開口の下の手すり
      ctx.fillStyle = STONE_D;
      ctx.fillRect(cx - w / 2, bottom - 12, w, 12);
    }
    // 小円柱（白い石）
    for (const x of [x0 + 2, x0 + 128 - 6, x0 + CW - 14]) {
      ctx.fillStyle = STONE;
      ctx.fillRect(x, 40, 12, H - 62);
      ctx.fillStyle = 'rgba(0,0,0,0.15)';
      ctx.fillRect(x + 9, 40, 3, H - 62);
      ctx.fillStyle = STONE_D;
      ctx.fillRect(x - 3, 34, 18, 10); // 柱頭
    }
  };
  tier(0, false);
  tier(CW, true);
  // 冠: レンガに小さなアーチの並び、上に石の笠
  {
    const x0 = 2 * CW;
    bricks(x0, 0, CW, H);
    for (let i = 0; i < 6; i++) {
      const cx = x0 + 22 + i * 42;
      ctx.fillStyle = DARK;
      ctx.beginPath();
      ctx.moveTo(cx - 12, H - 60);
      ctx.lineTo(cx - 12, H - 200);
      ctx.arc(cx, H - 200, 12, Math.PI, 0);
      ctx.lineTo(cx + 12, H - 60);
      ctx.fill();
    }
    ctx.fillStyle = STONE;
    ctx.fillRect(x0, 0, CW, 40);
    ctx.fillRect(x0, H - 40, CW, 40);
    // 小塔の円錐（灰色の石）用の小さな区画（u ≒ 0.8）
  }
  // 尖塔: 灰緑の石の鱗
  {
    const x0 = 3 * CW;
    ctx.fillStyle = '#a9a48f';
    ctx.fillRect(x0, 0, CW, H);
    for (let y = 0, row = 0; y < H; y += 10, row++) {
      for (let x = x0 + (row % 2 ? 9 : 0); x < x0 + CW; x += 18) {
        const v = 150 + Math.floor(rnd() * 40);
        ctx.fillStyle = `rgb(${v},${v - 4},${v - 22})`;
        ctx.fillRect(x, y, 16, 8);
      }
    }
    // 細い窓（ルカルヌ）
    ctx.fillStyle = DARK;
    ctx.fillRect(x0 + CW / 2 - 6, H - 120, 12, 40);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

function shadeHex(hex, k) {
  const c = new THREE.Color(hex);
  return `rgb(${Math.round(c.r * 255 * k)},${Math.round(c.g * 255 * k)},${Math.round(c.b * 255 * k)})`;
}
