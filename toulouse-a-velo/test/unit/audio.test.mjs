// 音の計算（DOM・WebAudio に依らない部分）: 路面の音・街の音の層の釣り合い・鐘の鳴る時刻・左右の寄せ・まわりのようす・音量の保存
import test from 'node:test';
import assert from 'node:assert/strict';
import { ambientMix, bellDistance, bellTimes, panFor, surfaceSound } from '../../src/game/audiologic.js';
import { ambientInfo } from '../../src/game/ambientinfo.js';
import { AudioFx } from '../../src/game/audio.js';
import { LocalProjection } from '../../src/geo.js';

test('surfaceSound: 止まっていれば無音、石畳がいちばん大きい', () => {
  for (const k of ['road', 'paving', 'gravel', 'grass']) assert.equal(surfaceSound(k, 0).gain, 0);
  const at = (k) => surfaceSound(k, 6).gain;
  assert.ok(at('paving') > at('gravel') && at('paving') > at('road') && at('paving') > at('grass'));
  assert.ok(at('road') <= 0.06 && at('paving') <= 0.22 && at('gravel') <= 0.16 && at('grass') <= 0.08);
  // 知らない路面はアスファルト扱い
  assert.equal(surfaceSound('???', 6).kind, 'road');
});

test('surfaceSound: 速いほど大きく、頭打ちになる。石畳の継ぎ目の周期は 30 Hz まで', () => {
  const g = [1, 3, 6, 8, 12, 20].map((s) => surfaceSound('paving', s).gain);
  for (let i = 1; i < g.length; i++) assert.ok(g[i] >= g[i - 1]);
  assert.equal(surfaceSound('paving', 12).gain, surfaceSound('paving', 20).gain);
  assert.equal(surfaceSound('paving', 20).gain, 0.22);
  assert.ok(Math.abs(surfaceSound('paving', 2.8).rumble - 20) < 1e-9); // 2.8 m/s ÷ 0.14 m
  assert.equal(surfaceSound('paving', 10).rumble, 30);
  // アスファルトは速いほど高い「サー」（900〜1600 Hz）
  assert.ok(surfaceSound('road', 2).freq < surfaceSound('road', 8).freq);
  assert.ok(surfaceSound('road', 8).freq <= 1600 && surfaceSound('road', 0.5).freq >= 900);
  // 負の速さ（後退）も同じ
  assert.equal(surfaceSound('gravel', -5).gain, surfaceSound('gravel', 5).gain);
});

test('ambientMix: 夜は鳥が鳴かず、公園では虫が鳴く。朝は鳥が強い', () => {
  const day = ambientMix({ park: 1 });
  const morning = ambientMix({ park: 1, morning: true });
  const night = ambientMix({ park: 1, night: true });
  assert.ok(day.birds > 0 && morning.birds > day.birds);
  assert.equal(night.birds, 0);
  assert.ok(night.crickets > 0);
  assert.equal(day.crickets, 0);
  // 夜の旧市街の中（公園なし）は虫なし、外は少し
  assert.equal(ambientMix({ night: true, oldTown: true }).crickets, 0);
  assert.ok(ambientMix({ night: true, oldTown: false }).crickets > 0);
  // 夜は街のざわめきが 0.4 倍
  assert.ok(Math.abs(ambientMix({ night: true }).city - 0.4 * ambientMix({}).city) < 1e-9);
});

test('ambientMix: 水の近くで water、堰で weir、人が多いと crowd、全部の層が 0〜1', () => {
  assert.equal(ambientMix({}).water, 0);
  assert.ok(ambientMix({ nearWater: 1 }).water > ambientMix({ nearWater: 0.3 }).water);
  assert.ok(ambientMix({ nearWater: 0.6, weir: true }).weir > 0);
  assert.equal(ambientMix({ nearWater: 1 }).weir, 0);
  assert.ok(ambientMix({ people: 1 }).crowd > ambientMix({ people: 0.2 }).crowd);
  assert.ok(ambientMix({ people: 1, night: true }).crowd < ambientMix({ people: 1 }).crowd);
  assert.ok(ambientMix({ tram: { d: 10 } }).tram > ambientMix({ tram: { d: 50 } }).tram);
  assert.equal(ambientMix({ tram: { d: 80 } }).tram, 0);
  const extremes = [{}, { people: 5, park: 3, nearWater: 2, weir: true, morning: true, tram: { d: 0 } }, { night: true, park: 1, people: -1 }];
  for (const info of extremes) {
    for (const [k, v] of Object.entries(ambientMix(info))) assert.ok(v >= 0 && v <= 1, `${k} = ${v}`);
  }
});

test('ambientMix: 旧市街の外の方が街のざわめきが大きい', () => {
  assert.ok(ambientMix({ oldTown: false }).city > ambientMix({ oldTown: true }).city);
});

test('bellTimes: 75 秒ごとに 3 回（1.8 秒おき）、教会ごとに 20 秒ずれる', () => {
  assert.deepEqual(bellTimes(0, 0, 74), []);
  const t = bellTimes(0, 70, 80);
  assert.equal(t.length, 3);
  assert.ok(Math.abs(t[0] - 75) < 1e-9 && Math.abs(t[1] - 76.8) < 1e-9 && Math.abs(t[2] - 78.6) < 1e-9);
  assert.equal(bellTimes(0, 140, 155)[0], 150);
  // 教会ごとのずれ
  assert.equal(bellTimes(1, 0, 25)[0], 20);
  assert.equal(bellTimes(2, 0, 45)[0], 40);
  assert.equal(bellTimes(3, 0, 65)[0], 60);
});

test('bellTimes: 細かい区間に分けて進めても、どの打ちも 1 回だけ', () => {
  for (const idx of [0, 1, 2, 3]) {
    const all = [];
    const dt = 1 / 60;
    for (let t = 0; t < 310; t += dt) all.push(...bellTimes(idx, t, t + dt));
    const once = bellTimes(idx, 0, 310 + dt);
    assert.equal(all.length, once.length);
    assert.equal(new Set(all.map((v) => v.toFixed(6))).size, all.length);
    assert.equal(all.length, 4 * 3); // 310 秒の間に 4 回鳴る
  }
});

test('panFor: 右にある物は正、左は負、前後は 0 近く', () => {
  // 北を向いている（heading 0）: 東（+x）が右
  assert.ok(panFor(10, 0, 0) > 0.99);
  assert.ok(panFor(-10, 0, 0) < -0.99);
  assert.ok(Math.abs(panFor(0, 10, 0)) < 1e-9); // 後ろ
  assert.ok(Math.abs(panFor(0, -10, 0)) < 1e-9); // 前
  // 東を向いている（heading π/2）: 南（+z）が右
  assert.ok(panFor(0, 10, Math.PI / 2) > 0.99);
  assert.equal(panFor(0, 0, 1), 0);
  for (const [dx, dz, h] of [[3, 4, 0.3], [-7, 1, 2], [1e6, -1e6, -1]]) {
    const p = panFor(dx, dz, h);
    assert.ok(p >= -1 && p <= 1);
  }
});

test('bellDistance: 遠いほど小さく、こもる', () => {
  const a = bellDistance(20), b = bellDistance(300);
  assert.ok(Math.abs(bellDistance(80).gain - 0.5) < 1e-9);
  assert.ok(a.gain > b.gain && a.lowpass > b.lowpass);
});

test('ambientInfo: 水・堰・人・芝・時間帯・トラムを調べる（無いものは無いまま動く）', () => {
  const proj = new LocalProjection(43.6, 1.44);
  const world = {
    proj,
    collision: { blockedByWater: (x) => x > 35 }, // 東 35 m より先は川
    landmarks: [{ id: 'bazacle', x: 100, z: 0 }],
    surfaceAt: (x, z) => (z < -10 ? 'grass' : 'road'),
    life: { near: () => 18 },
    traffic: { nearestTram: () => ({ x: 30, z: 40 }) },
  };
  const bike = { x: 0, z: 0, heading: 0, speed: -3, surface: 'road' };
  const info = ambientInfo(world, bike, { timeOfDay: 'night' });
  assert.equal(info.nearWater, 0.6); // 20 m の輪には無く、40 m の輪で当たる
  assert.equal(info.weir, true);
  assert.equal(info.people, 1); // 18 ÷ 12 → 1 で頭打ち
  assert.equal(info.park, 1);
  assert.equal(info.night, true);
  assert.equal(info.morning, false);
  assert.equal(info.speed, 3);
  assert.equal(info.tram.d, 50);
  assert.equal(typeof info.oldTown, 'boolean');
  // 計画 B・D がまだ無い（timeOfDay なし・traffic なし・life なし）
  const bare = ambientInfo({ proj, collision: { blockedByWater: () => false }, landmarks: [], surfaceAt: () => 'paving' }, { x: 0, z: 0, surface: 'paving' }, {});
  assert.deepEqual([bare.nearWater, bare.weir, bare.people, bare.park, bare.night, bare.morning, bare.tram], [0, false, 0, 0, false, false, null]);
});

test('AudioFx: 音量と消音を tav-audio に保存し、復元する（AudioContext が無くても例外なし）', () => {
  const data = new Map();
  const store = { get: (k, d) => (data.has(k) ? JSON.parse(data.get(k)) : d), set: (k, v) => data.set(k, JSON.stringify(v)) };
  const a = new AudioFx();
  a.restorePrefs(store);
  assert.equal(a.volume, 0.7); // 既定 70
  assert.equal(a.muted, false);
  a.setVolume(0.35);
  a.setMuted(true);
  a.savePrefs(store);
  assert.deepEqual(JSON.parse(data.get('tav-audio')), { volume: 35, muted: true });
  const b = new AudioFx();
  b.restorePrefs(store);
  assert.equal(b.volume, 0.35);
  assert.equal(b.muted, true);
  // 音を出せない所でも、呼んで例外を出さない
  b.update(1 / 60, { speed: 5, surface: 'paving', braking: true });
  b.update(1 / 60, 5, true);
  b.setAmbient({ park: 1 });
  b.event({ type: 'pigeons' }, { x: 0, z: 0 });
  b.bells([{ id: 'jacobins', x: 0, z: 0 }], { x: 0, z: 0 }, 20, 0.1);
  b.ui();
  b.shutter();
  b.fanfare('gold');
});
