// 音の計算（DOM・WebAudio に依らない部分。Node の単体テストから使う）。
// 路面の音の強さ・街の音の層の釣り合い・鐘の鳴る時刻・左右の寄せ。

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

// ---------------------------------------------------------------- ① 路面の音
// 路面（bike.surface）と速さ（m/s）から、ノイズにかけるフィルターと強さを決める。
//   gain: 強さ（止まっていれば 0）、filter: フィルターの種類、freq: フィルターの周波数（Hz）、q、
//   rumble: 石畳の継ぎ目の周期（振幅の揺れの Hz。0 = 揺れなし）、grain: 砂利の不規則な粒の揺れの深さ（0〜1）
export const SURFACE_MAX = { road: 0.06, paving: 0.22, gravel: 0.16, grass: 0.08 };
const JOINT = 0.14; // 石畳の継ぎ目の間隔（m）
export function surfaceSound(surface, speed) {
  const s = Math.abs(speed || 0);
  const kind = SURFACE_MAX[surface] ? surface : 'road';
  // 速さで強くなり、8 m/s（29 km/h）で頭打ち。歩くより遅い所（0.3 m/s 未満）は無音
  const f = s < 0.3 ? 0 : Math.min(1, s / 8);
  const gain = SURFACE_MAX[kind] * f;
  if (kind === 'paving') return { kind, gain, filter: 'lowpass', freq: 220, q: 0.7, rumble: Math.min(30, s / JOINT), grain: 0 };
  if (kind === 'gravel') return { kind, gain, filter: 'highpass', freq: 1800, q: 0.7, rumble: 0, grain: 0.8 };
  if (kind === 'grass') return { kind, gain, filter: 'bandpass', freq: 500, q: 0.6, rumble: 0, grain: 0.3 };
  // アスファルト: 細かい「サー」。速いほど高く（900〜1600 Hz）
  return { kind, gain, filter: 'bandpass', freq: 900 + 700 * f, q: 0.8, rumble: 0, grain: 0 };
}

// ---------------------------------------------------------------- ② 街の音の層
// info: { oldTown, nearWater（0〜1）, weir, people（0〜1）, park（0〜1）, night, morning, speed, tram（{ d } | null） }
// 返り値: 層ごとの強さ（0〜1）。実際の大きさは Soundscape の層の最大（0.05〜0.12）を掛ける
export function ambientMix(info = {}) {
  const night = !!info.night, morning = !!info.morning;
  const park = clamp01(+info.park || 0);
  const people = clamp01(+info.people || 0);
  const water = clamp01(+info.nearWater || 0);
  // 街のざわめき: 旧市街の中（細い通り・車が少ない）は小さく、外の大通りで大きい。夜は 0.4 倍
  const city = (info.oldTown ? 0.35 : 1) * (night ? 0.4 : 1);
  // 鳥: 公園・芝・木の近く。朝は 1.5 倍、夜は鳴かない
  const birds = night ? 0 : clamp01(park * 0.6 * (morning ? 1.5 : 1));
  // 虫: 夜の公園・旧市街の外だけ
  const crickets = night ? Math.max(park, info.oldTown ? 0 : 0.5) : 0;
  // 堰（バザクルの堰から 250 m 以内）の低い轟き
  const weir = info.weir ? Math.max(0.5, water) : 0;
  // 人の声: 近くの人の数。夜は 0.6 倍
  const crowd = people * (night ? 0.6 : 1);
  // 近くのトラムの走行音（60 m 以内。近いほど大きい）
  const td = info.tram && Number.isFinite(info.tram.d) ? info.tram.d : Infinity;
  const tram = td < 60 ? 1 - td / 60 : 0;
  return { city: clamp01(city), birds, crickets: clamp01(crickets), water, weir: clamp01(weir), crowd: clamp01(crowd), tram: clamp01(tram) };
}

// ---------------------------------------------------------------- ③ 鐘
// 教会ごとに、遊んだ時間で 75 秒ごと（教会ごとに 20 秒ずらす）に 3 回（1.8 秒おき）鳴らす。
// この更新の区間 (t0, t1] に鳴る打ちの時刻を返す（区間をまたいで 2 重に鳴らないよう、始めは含めず終わりを含める）
export const BELL_PERIOD = 75;
export const BELL_OFFSET = 20;
export const BELL_STRIKES = 3;
export const BELL_GAP = 1.8;
export function bellTimes(lmIndex, t0, t1, out = []) {
  out.length = 0;
  if (!(t1 > t0)) return out;
  const off = (lmIndex * BELL_OFFSET) % BELL_PERIOD;
  const last = (BELL_STRIKES - 1) * BELL_GAP;
  // この区間に打ちがかかりうる鳴り始めの番号 k（鳴り始めは off + k × 75。0 秒ちょうどには鳴らさない）
  const k0 = Math.max(0, Math.floor((t0 - last - off) / BELL_PERIOD));
  const k1 = Math.floor((t1 - off) / BELL_PERIOD);
  for (let k = k0; k <= k1; k++) {
    const start = off + k * BELL_PERIOD;
    if (start <= 0) continue;
    for (let j = 0; j < BELL_STRIKES; j++) {
      const t = start + j * BELL_GAP;
      if (t > t0 && t <= t1) out.push(t);
    }
  }
  return out;
}

// ---------------------------------------------------------------- 左右の寄せ
// 自転車から見て (dx, dz) の向きにある音を左右に寄せる（−1 = 左、1 = 右）。
// heading はコンパス方位（0 = 北 = −z、時計回りが正）。右の向きは (cos h, sin h)
export function panFor(dx, dz, heading = 0) {
  const d = Math.hypot(dx, dz);
  if (!(d > 1e-6)) return 0;
  const p = (dx * Math.cos(heading) + dz * Math.sin(heading)) / d;
  return p < -1 ? -1 : p > 1 ? 1 : p;
}

// 鐘の距離での弱まり（1 / (1 + d / 80)）と、こもり（遠いほどローパスを下げる。Hz）
export function bellDistance(d) {
  return { gain: 1 / (1 + d / 80), lowpass: Math.max(700, 9000 / (1 + d / 60)) };
}
