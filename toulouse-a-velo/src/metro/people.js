// 人の形（なめらかな体）: 回転体（胴・脚・腕）と楕円体（頭・手・靴）で、実際の体の比率（身長 1.75 m を基準）に作る。
// 部品ごとの形を返すので、駅の人（動かない。1 つの形にまとめる）と街を歩く人（部品ごとに InstancedMesh で脚と腕を振る）で使う。
// 局所の座標: 足もとが原点、y が上、-z が前。脚は股関節、腕は肩が原点（下へ伸びる）
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

export const HIP_Y = 0.88, HIP_X = 0.09, SHOULDER_Y = 1.43, SHOULDER_X = 0.195;
const V = (r, y) => new THREE.Vector2(r, y);

// 形に色（頂点カラー）を付け、merge できるように属性をそろえる
function paint(g, color) {
  g = g.index ? g.toNonIndexed() : g;
  const n = g.attributes.position.count, c = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) c.set(color, i * 3);
  g.setAttribute('color', new THREE.BufferAttribute(c, 3));
  if (!g.attributes.uv) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n * 2), 2));
  return g;
}

function ellipsoid(r, sx, sy, sz, x, y, z, seg = 12) {
  const g = new THREE.SphereGeometry(r, seg, Math.max(6, seg * 0.6 | 0));
  g.scale(sx, sy, sz);
  g.translate(x, y, z);
  return g;
}

// 体つきの種類: 'm'（肩幅が広い）・'f'（腰が広く、腰のくびれ）
function torsoProfile(kind, coat) {
  const f = kind === 'f';
  const pts = [V(0.001, HIP_Y - 0.02), V(f ? 0.165 : 0.15, HIP_Y - 0.01), V(f ? 0.17 : 0.158, HIP_Y + 0.07), V(f ? 0.13 : 0.142, 1.08), V(f ? 0.15 : 0.16, 1.2),
    V(f ? 0.16 : 0.178, 1.32), V(f ? 0.168 : 0.192, 1.41), V(0.13, 1.47), V(0.06, 1.5), V(0.001, 1.505)];
  if (coat) {
    // コート: 腰の下まで（裾が少し広がる）
    pts.splice(0, 2, V(0.001, HIP_Y - 0.26), V(f ? 0.19 : 0.18, HIP_Y - 0.25), V(f ? 0.175 : 0.165, HIP_Y - 0.05));
  }
  return pts;
}

// 胴（服の色）。上着の前の合わせ目は少し暗い線
export function torsoGeometry({ kind = 'm', coat = false } = {}) {
  const g = new THREE.LatheGeometry(torsoProfile(kind, coat), 18);
  g.scale(1, 1, 0.66);
  return g;
}

// 頭と首（肌）
export function headGeometry() {
  const neck = new THREE.CylinderGeometry(0.052, 0.058, 0.12, 10);
  neck.translate(0, 1.52, 0.005);
  const head = ellipsoid(0.1, 0.93, 1.16, 1.02, 0, 1.655, -0.005, 16);
  const nose = ellipsoid(0.018, 0.9, 1.4, 1.2, 0, 1.64, -0.103, 6);
  const ears = [-1, 1].map((s) => ellipsoid(0.022, 0.5, 1.2, 0.9, s * 0.093, 1.655, 0.005, 6));
  return mergeGeometries([neck, head, nose, ...ears].map((q) => paint(q, [1, 1, 1])));
}

// 髪（短い・長い・帽子なし）
export function hairGeometry(style = 0) {
  const cap = new THREE.SphereGeometry(0.108, 16, 10, 0, Math.PI * 2, 0, Math.PI * (style === 2 ? 0.62 : 0.5));
  cap.scale(0.97, 1.12, 1.05);
  cap.rotateX(0.32); // 後ろへ深く
  cap.translate(0, 1.675, 0.012);
  const parts = [cap];
  if (style === 1) {
    // 長い髪（肩まで）
    const back = new THREE.CapsuleGeometry(0.085, 0.16, 4, 10);
    back.scale(1.12, 1, 0.55);
    back.translate(0, 1.56, 0.06);
    parts.push(back);
  }
  return mergeGeometries(parts.map((q) => paint(q, [1, 1, 1])));
}

// 脚 1 本（股関節が原点）。knee: 膝の曲がり（ラジアン、すねが後ろへ）。shoe: 靴の色（頂点カラー。服の色を掛けても暗いまま）
export function legGeometry({ knee = 0, skirt = false } = {}) {
  const thigh = new THREE.LatheGeometry([V(0.001, 0.02), V(0.085, 0.0), V(0.08, -0.12), V(0.068, -0.3), V(0.056, -0.43), V(0.001, -0.45)], 12);
  const shin = new THREE.LatheGeometry([V(0.001, 0.0), V(0.055, -0.01), V(0.057, -0.1), V(0.046, -0.24), V(0.034, -0.36), V(0.03, -0.39), V(0.001, -0.4)], 12);
  const shoe = ellipsoid(0.06, 0.85, 0.62, 2.1, 0, -0.415, -0.045, 10);
  const lower = mergeGeometries([paint(shin, [1, 1, 1]), paint(shoe, [0.11, 0.1, 0.1])]);
  lower.rotateX(-knee);
  lower.translate(0, -0.44, 0);
  return mergeGeometries([paint(thigh, [1, 1, 1]), lower]);
}

// スカート（腰から膝の上まで。服の下の色）
export function skirtGeometry() {
  const g = new THREE.LatheGeometry([V(0.001, HIP_Y + 0.08), V(0.15, HIP_Y + 0.08), V(0.17, HIP_Y - 0.1), V(0.21, HIP_Y - 0.36), V(0.001, HIP_Y - 0.37)], 18);
  g.scale(1, 1, 0.75);
  return paint(g, [1, 1, 1]);
}

// 腕 1 本（肩が原点）。袖（服の色）と、手（肌の色は別の形 handGeometry）。elbow: 肘の曲がり（前へ）
export function armGeometry({ elbow = 0.1, short = false } = {}) {
  const upper = new THREE.LatheGeometry([V(0.001, 0.02), V(0.052, 0.0), V(0.05, -0.12), V(0.043, -0.28), V(0.001, -0.3)], 10);
  const fore = new THREE.LatheGeometry([V(0.001, 0.0), V(0.042, -0.01), V(0.04, -0.1), V(0.032, -0.25), V(0.001, -0.27)], 10);
  fore.rotateX(elbow);
  fore.translate(0, -0.29, 0);
  if (short) return paint(upper, [1, 1, 1]);
  return mergeGeometries([paint(upper, [1, 1, 1]), paint(fore, [1, 1, 1])]);
}

// 手（と、半袖なら前腕。肌）
export function handGeometry({ elbow = 0.1, short = false } = {}) {
  const hand = ellipsoid(0.045, 0.62, 1.35, 0.95, 0, -0.31, 0, 8);
  const parts = [hand];
  if (short) {
    const fore = new THREE.LatheGeometry([V(0.001, 0.0), V(0.04, -0.01), V(0.037, -0.1), V(0.03, -0.25), V(0.001, -0.27)], 10);
    parts.push(fore);
  }
  const g = mergeGeometries(parts.map((q) => paint(q, [1, 1, 1])));
  g.rotateX(elbow);
  g.translate(0, -0.29, 0);
  return g;
}

// 鞄（肩掛け・リュック）
export function bagGeometry(kind = 0) {
  if (kind === 0) {
    const b = new THREE.BoxGeometry(0.3, 0.38, 0.13, 1, 1, 1);
    b.translate(0, 1.2, 0.17); // リュック（背中）
    return paint(b, [1, 1, 1]);
  }
  const b = new THREE.BoxGeometry(0.08, 0.26, 0.32);
  b.translate(0.24, 0.95, 0);
  return paint(b, [1, 1, 1]);
}

const col = (hex) => new THREE.Color(hex).toArray();
export const PALETTE = {
  tops: ['#2a3a5e', '#7a2b23', '#2f5d3a', '#d8d4cc', '#1c1c1e', '#8c6a3f', '#4d6f9c', '#b84c66', '#c9a24a', '#5b5b63', '#efece4', '#3f6f6a', '#6b2d3a', '#2c2c34'],
  bottoms: ['#2b2f3a', '#3c3f46', '#1e2433', '#6b5a48', '#20232a', '#5d6470', '#c8b896', '#283a5a', '#4a4a4f'],
  skins: ['#f1d1bb', '#e3b899', '#c99673', '#a46f4f', '#7d4f35', '#5a3726'],
  hairs: ['#2a1d14', '#4a3222', '#141414', '#8a6a42', '#c9b38a', '#7a7a7a', '#b5aea4', '#5b2e1c'],
};

// ばらつき（人ごと）: 体つき・身長・服・髪
export function personLook(rnd) {
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const kind = rnd() < 0.5 ? 'f' : 'm';
  return {
    kind,
    h: kind === 'f' ? 0.92 + rnd() * 0.1 : 0.97 + rnd() * 0.1,
    coat: rnd() < 0.3,
    skirt: kind === 'f' && rnd() < 0.3,
    short: rnd() < 0.15,
    hair: kind === 'f' ? (rnd() < 0.65 ? 1 : 0) : rnd() < 0.15 ? 2 : 0,
    bag: rnd() < 0.45 ? (rnd() < 0.5 ? 0 : 1) : -1,
    top: pick(PALETTE.tops), bottom: pick(PALETTE.bottoms), skin: pick(PALETTE.skins), hairColor: pick(PALETTE.hairs), bagColor: pick(['#2a221c', '#1d1d1f', '#6b2b23', '#3a4a5a']),
  };
}

// 動かない人 1 人の形（頂点カラー付き、局所の座標）。pose: 'stand' | 'sit'
export function personGeometry(rnd, pose = 'stand', look = personLook(rnd)) {
  const sit = pose === 'sit';
  const parts = [];
  const add = (g, color, m) => {
    g = g.index ? g.toNonIndexed() : g.clone();
    if (m) g.applyMatrix4(m);
    const c = g.attributes.color.array, cc = col(color);
    for (let i = 0; i < c.length; i += 3) {
      c[i] *= cc[0];
      c[i + 1] *= cc[1];
      c[i + 2] *= cc[2];
    }
    parts.push(g);
  };
  const lift = sit ? new THREE.Matrix4().makeTranslation(0, 0.46 - HIP_Y, 0) : null; // 座ると腰が座面の高さ
  add(paint(torsoGeometry({ kind: look.kind, coat: look.coat && !sit }), [1, 1, 1]), look.top, lift);
  add(headGeometry(), look.skin, lift);
  add(hairGeometry(look.hair), look.hairColor, lift);
  if (look.skirt && !sit) add(skirtGeometry(), look.bottom);
  for (const s of [-1, 1]) {
    const leg = legGeometry({ knee: sit ? Math.PI / 2 : 0.02 });
    const m = new THREE.Matrix4().makeTranslation(s * HIP_X, sit ? 0.46 : HIP_Y, 0);
    if (sit) m.multiply(new THREE.Matrix4().makeRotationX(Math.PI / 2)); // 太ももを前へ
    add(leg, look.skirt && !sit ? look.skin : look.bottom, m);
    const ma = new THREE.Matrix4().makeTranslation(s * SHOULDER_X, (sit ? 0.46 - HIP_Y : 0) + SHOULDER_Y, 0).multiply(new THREE.Matrix4().makeRotationZ(s * 0.06));
    const elbow = sit ? 0.9 : 0.12;
    add(armGeometry({ elbow, short: look.short }), look.top, ma);
    add(handGeometry({ elbow, short: look.short }), look.skin, ma);
  }
  if (look.bag >= 0) add(bagGeometry(look.bag), look.bagColor, lift);
  const g = mergeGeometries(parts);
  if (look.h !== 1) g.scale(look.h, look.h, look.h);
  return g;
}
