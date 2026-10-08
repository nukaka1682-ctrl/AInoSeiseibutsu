import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalProjection } from '../../src/geo.js';
import { OLD_TOWN, oldTownTest } from '../../src/config.js';
import { CROWN_ASPECT, crownLimit, shapeTrees } from '../../src/world/trees.js';
import {
  TONE_MAPPING_GLSL, displayColor, environmentIntensity, linearToSrgb, neutralToneMap, probeEnvironment, toneMap,
} from '../../src/world/light.js';
import { facadeStyle } from '../../src/world/buildings.js';
import { STYLE, stylePlainColor } from '../../src/world/facades.js';
import { facingSquare } from '../../src/world/landmarkfacades.js';

test('旧市街の範囲: 環状の大通りの内側と左岸のサン・シプリアン', () => {
  const proj = new LocalProjection(43.5994, 1.4395);
  const inOld = oldTownTest(proj);
  const at = (lat, lon) => inOld(...proj.project(lat, lon));
  assert.ok(OLD_TOWN.length >= 10);
  assert.ok(at(43.6044, 1.4436), 'キャピトル');
  assert.ok(at(43.6083, 1.4419), 'サン・セルナン');
  assert.ok(at(43.6000, 1.4513), 'サン・テティエンヌ');
  assert.ok(at(43.5993, 1.4366), 'オテル・デュー（左岸）');
  assert.ok(at(43.6009, 1.4320), 'ラ・グラーヴ（左岸）');
  assert.ok(at(43.5994, 1.4385), 'ポン・ヌフの上（ガロンヌ川）');
  assert.ok(!at(43.6112, 1.4541), 'マタビオ駅（運河の外）');
  assert.ok(!at(43.5929, 1.4507), '植物園（グラン・ロンの南）');
  assert.ok(!at(43.5926, 1.4207), 'サン・シプリアンの住宅街（Rue de Cugnaux）');
  assert.ok(!at(43.6008, 1.4590), '大通りの東');
});

test('木の形: LiDAR の横に広い塊を平たい板にしない', () => {
  // 高さ 6 m・半径 9 m の塊（数本の木がつながったもの）
  const wide = shapeTrees([{ x: 0, z: 0, y: 0, h: 6, r: 9 }]);
  assert.ok(wide.length >= 2 && wide.length <= 3, `分ける: ${wide.length}`);
  for (const t of wide) {
    assert.ok(t.r <= crownLimit(6).rmax + 1e-9, `半径 ${t.r}`);
    assert.ok(t.crownH >= CROWN_ASPECT * t.r - 1e-9, `樹冠の高さ ${t.crownH} / 半径 ${t.r}`);
    assert.ok(t.crownY + t.crownH <= 6 + 1e-9);
    assert.ok(t.trunkH > 0);
  }
  // 分けた木の幹は、塊の範囲の中
  for (const t of wide) assert.ok(Math.hypot(t.x, t.z) <= 9 * 1.05 + 1e-9);
  // 置けない場所には分けない（元の位置に 1 本だけ）
  const blocked = shapeTrees([{ x: 10, z: 5, y: 0, h: 6, r: 9 }], () => false);
  assert.equal(blocked.length, 1);
  assert.deepEqual([blocked[0].x, blocked[0].z], [10, 5]);
  // ふつうの街路樹（高さ 20 m・半径 6 m）はそのまま 1 本
  const plane = shapeTrees([{ x: 0, z: 0, y: 0, h: 20, r: 6 }]);
  assert.equal(plane.length, 1);
  assert.ok(Math.abs(plane[0].r - 6.3) < 1e-9);
  assert.ok(Math.abs(plane[0].crownY + plane[0].crownH - 20) < 1e-9);
  // 実際の LiDAR の木の大きさの範囲（高さ 4〜45 m、半径 1.5〜9 m）のどれも、樹冠は平たくならず、木の高さに収まる
  for (let h = 4; h <= 45; h += 0.7) {
    for (let r = 1.5; r <= 9; r += 0.5) {
      const ts = shapeTrees([{ x: h * 31, z: r * 17, y: 0, h, r }]);
      assert.ok(ts.length >= 1 && ts.length <= 3);
      for (const t of ts) {
        assert.ok(t.crownH >= CROWN_ASPECT * t.r - 1e-9, `h ${h} r ${r}: ${t.crownH} / ${t.r}`);
        assert.ok(t.crownY + t.crownH <= h + 1e-9 && t.trunkH > 0, `h ${h} r ${r}`);
        assert.ok(2 * t.r <= Math.max(3, 0.9 * h + 2) + 1e-9, `h ${h} r ${r}: 直径 ${2 * t.r}`);
      }
    }
  }
  // 大きさの分からない木と、決定的な形
  const est = shapeTrees([[3, 4]]);
  assert.equal(est.length, 1);
  assert.ok(est[0].crownH >= CROWN_ASPECT * est[0].r);
  assert.deepEqual(shapeTrees([[3, 4]]), est);
});

// 立方体の 6 面（各面 size×size）の環境を作る
function cube(fn, S = 12) {
  const views = [
    { forward: [0, 1, 0], up: [0, 0, -1], right: [1, 0, 0] }, { forward: [0, -1, 0], up: [0, 0, 1], right: [1, 0, 0] },
    { forward: [1, 0, 0], up: [0, 1, 0], right: [0, 0, 1] }, { forward: [-1, 0, 0], up: [0, 1, 0], right: [0, 0, -1] },
    { forward: [0, 0, 1], up: [0, 1, 0], right: [-1, 0, 0] }, { forward: [0, 0, -1], up: [0, 1, 0], right: [1, 0, 0] },
  ];
  return views.map((f) => {
    const data = new Float32Array(S * S * 4);
    for (let j = 0; j < S; j++) {
      for (let i = 0; i < S; i++) {
        const u = (2 * (i + 0.5)) / S - 1, v = (2 * (j + 0.5)) / S - 1;
        const d = [0, 1, 2].map((k) => f.forward[k] + u * f.right[k] + v * f.up[k]);
        const l = Math.hypot(...d);
        const c = fn(d.map((x) => x / l));
        data.set([...c, 1], (j * S + i) * 4);
      }
    }
    return { ...f, data, size: S };
  });
}

test('光の較正: 環境の明るさの測り方とトーンマッピング', () => {
  // 一様な空 L: 上向きの面も壁も L
  const u = probeEnvironment(cube(() => [0.5, 0.6, 0.7]));
  for (const [k, v] of [[0, 0.5], [1, 0.6], [2, 0.7]]) {
    assert.ok(Math.abs(u.up[k] - v) < 0.02, `up ${u.up}`);
    assert.ok(Math.abs(u.side[k] - v) < 0.02, `side ${u.side}`);
    assert.ok(Math.abs(u.horizon[k] - v) < 1e-6);
  }
  // 上半分が空 1、下半分が地面 0: 上向きの面は 1、壁は半分
  const h = probeEnvironment(cube((d) => (d[1] > 0 ? [1, 1, 1] : [0, 0, 0])));
  assert.ok(Math.abs(h.up[0] - 1) < 0.03 && Math.abs(h.side[0] - 0.5) < 0.03, `${h.up} ${h.side}`);
  // 環境マップの強さ: 環境の拡散光が半球光の空の光の share 倍になる
  const k = environmentIntensity([0.4, 0.4, 0.4], [0.6, 0.7, 0.8], 1.2, 0.5);
  assert.ok(Math.abs(k * 0.4 - (0.5 * (0.2126 * 0.6 + 0.7152 * 0.7 + 0.0722 * 0.8) * 1.2) / Math.PI) < 1e-9);
  assert.equal(environmentIntensity([0, 0, 0], [1, 1, 1], 1, 0.5), null);
  // Neutral トーンマッピング: 暗い色から黒を差し引く。ゲームの toneMap は差し引かず、暗い色はそのまま。明るい色は 1 に収まる
  const dark = neutralToneMap([0.2, 0.1, 0.05]);
  assert.ok(Math.abs(dark[0] - 0.16) < 0.01 && dark[2] >= 0);
  assert.deepEqual(toneMap([0.2, 0.1, 0.05]), [0.2, 0.1, 0.05]);
  assert.deepEqual(toneMap([0.1, 0.1, 0.1], 2), [0.2, 0.2, 0.2]);
  for (const v of neutralToneMap([8, 4, 2])) assert.ok(v <= 1 && v > 0.5);
  for (const v of toneMap([8, 4, 2])) assert.ok(v <= 1 && v > 0.5);
  assert.match(TONE_MAPPING_GLSL, /vec3 CustomToneMapping\( vec3 color \)/);
  assert.ok(Math.abs(linearToSrgb(0.5) - 0.7354) < 1e-3);
  const c = displayColor([0.6, 0.7, 0.9]);
  assert.ok(c.every((v) => v > 0.7 && v <= 1));
});

test('ファサード: 旧市街のレンガ・材料不明の建物は 8 割がレンガの様式、キャピトル広場の建物はアーケード', () => {
  const brickish = new Set([STYLE.brickStone, STYLE.brickShutters, STYLE.rose]);
  const share = (oldTown, mat) => {
    let n = 0;
    for (let id = 1; id <= 4000; id++) {
      const b = { id, tags: mat ? { 'building:material': mat } : {}, oldTown };
      if (brickish.has(facadeStyle(b))) n++;
    }
    return n / 4000;
  };
  assert.ok(share(true, null) >= 0.75, `旧市街・材料不明 ${share(true, null)}`);
  assert.ok(share(true, 'brick') >= 0.75, `旧市街・レンガ ${share(true, 'brick')}`);
  assert.ok(share(false, null) < 0.75, `旧市街の外 ${share(false, null)}`);
  assert.equal(facadeStyle({ id: 5, tags: {}, style: STYLE.arcade }), STYLE.arcade);
  assert.equal(stylePlainColor(STYLE.brickShutters), null);
  assert.match(stylePlainColor(STYLE.ochre), /^#[0-9a-f]{6}$/);

  // 広場に面した建物（広場の縁から 4 m 以内に、広場を向いた壁がある）
  const square = { outer: [[0, 0], [40, 0], [40, 30], [0, 30]], holes: [], bounds: { minX: 0, minZ: 0, maxX: 40, maxZ: 30 } };
  const box = (id, x0, z0, x1, z1) => ({ id, outer: [[x0, z0], [x1, z0], [x1, z1], [x0, z1]], holes: [], bounds: { minX: x0, minZ: z0, maxX: x1, maxZ: z1 } });
  const front = box(1, 5, -12, 30, 0); // 広場の北側に接する
  const back = box(2, 5, -40, 30, -25); // 通りをはさんだ向こう
  const side = box(3, 42, 5, 60, 25); // 東側（2 m 離れている）
  assert.deepEqual(facingSquare(square, [front, back, side]).map((b) => b.id), [1, 3]);
});
