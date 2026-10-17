import test from 'node:test';
import assert from 'node:assert/strict';
import { buildEnclosures, wallProfile } from '../../src/world/enclosures.js';

// 5 m の格子の段差（z = 0 の北が 3 m 高い）を、少しずつ角度を付けて横切る塀。地面にそのまま沿わせると上端がのこぎりの歯になる
const step = { flat: false, h: (x, z) => (Math.floor(z / 5) + (Math.floor(x / 5) % 2 ? 0.4 : 0) < 0 ? 0 : -3) };

test('地形の上の塀: 上端はなめらか、地面より下がらず、足は地面に埋まる', () => {
  const P = wallProfile(step, -40, -6, 40, 6, 2);
  assert.ok(P.length > 30);
  const l = Math.hypot(80, 12), nx = (-12 / l) * 0.2, nz = (80 / l) * 0.2; // 塀の両側の面（厚さ 0.4 m）
  for (let i = 0; i < P.length; i++) {
    const p = P[i], g = [step.h(p.x, p.z), step.h(p.x + nx, p.z + nz), step.h(p.x - nx, p.z - nz)];
    assert.ok(p.top >= Math.min(...g) + 2 - 1e-9, `低い側から ${2} m 以上 ${p.top}`);
    assert.ok(p.top >= Math.max(...g) + 1 - 1e-9, `高い側にも胸壁 ${p.top}`);
    assert.ok(p.base < Math.min(...g), `足が地面より上 ${p.base}`);
    if (i) assert.ok(Math.abs(p.top - P[i - 1].top) < 0.8, `上端の段 ${P[i - 1].top} → ${p.top}`);
  }
  // 2 点おきの上端の上下（のこぎりの歯）がない: 2 階差分の符号の変わる回数が少ない
  let flips = 0;
  for (let i = 2; i < P.length; i++) {
    const d1 = P[i - 1].top - P[i - 2].top, d2 = P[i].top - P[i - 1].top;
    if (d1 * d2 < -1e-6) flips++;
  }
  assert.ok(flips <= 2, `上下の繰り返し ${flips}`);
});

test('地形の上の塀: 平らな地面では上端 = 地面 + 高さ。平らな地形では今までどおり', () => {
  const plane = { flat: false, h: () => 1.5 };
  for (const p of wallProfile(plane, 0, 0, 10, 0, 2.5)) assert.ok(Math.abs(p.top - 4) < 1e-9);
  const mats = { enclosureBrick: {}, enclosureRender: {}, roof: {} };
  const g = buildEnclosures([[0, 0, 10, 0, 2.5], [0, 5, 0, 20, 1.8]], mats, null, plane);
  assert.ok(g.children.length >= 2);
  const f = buildEnclosures([[0, 0, 10, 0, 2.5]], mats, null, null);
  assert.ok(f.children.length >= 2);
});

test('盛り土の脇の塀は土留め: 上端は盛り土の上 + 胸壁、盛り土の側に平らな面の印', () => {
  // 東西の塀（z = 0）。北（z < 0）は 5 m の格子で 3 m 下がる斜面の下、南（z > 0）の 5 m 先は盛り土の上（3 m 高い）
  const emb = { flat: false, h: (x, z) => (z >= 5 ? 3 : z <= 0 ? 0 : (3 * z) / 5) };
  const P = wallProfile(emb, -20, 0, 20, 0, 2);
  for (const p of P) {
    assert.ok(p.fill && p.fill.y === 3, `土留めの印 ${JSON.stringify(p.fill)}`);
    assert.ok(Math.abs(p.top - 4) < 1e-9, `上端は盛り土 + 1 m ${p.top}`);
  }
  // 法線 (-uz, ux) = (0, 1) の側（南）が盛り土
  assert.equal(P[0].fill.s, 1);
  // 平らな地面・ゆるい坂では印なし
  for (const p of wallProfile({ flat: false, h: (x, z) => 0.1 * z }, -20, 0, 20, 0, 2)) assert.equal(p.fill, null);
  // メッシュも作れる（平らな面の分のメッシュが増える）
  const mats = { enclosureBrick: {}, enclosureRender: {}, roof: {} };
  assert.ok(buildEnclosures([[-20, 0, 20, 0, 2]], mats, null, emb).children.length >= 3);
});
