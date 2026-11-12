// 街の音の層を決めるための、自転車のまわりのようす（audio.setAmbient に渡す）。
// main.js から 0.5 秒ごとに呼ぶ。DOM・WebAudio に依らない（__tavSimulate・単体テストでも動く）
import { oldTownTest } from '../config.js';

const oldTown = new WeakMap(); // proj → 旧市街の中かを調べる関数（1 回だけ作る）
const RINGS = [[20, 1], [40, 0.6], [60, 0.3]]; // 水を探す輪の半径（m）と、当たったときの近さ
const WEIR_RANGE = 250; // バザクルの堰の轟きが聞こえる距離（m）
const PARK_PROBE = 15; // 芝を探す距離（m）

export function ambientInfo(world, bike, state = {}) {
  const x = bike.x, z = bike.z;
  // 旧市街の中か
  let inOld = false;
  if (world.proj) {
    let test = oldTown.get(world.proj);
    if (!test) oldTown.set(world.proj, (test = oldTownTest(world.proj)));
    inOld = test(x, z);
  }
  // 川・運河の近さ: まわり 20・40・60 m の輪を 8 方位で調べ、当たったいちばん近い輪から 1・0.6・0.3
  let nearWater = 0;
  const water = world.collision?.blockedByWater ? (px, pz) => world.collision.blockedByWater(px, pz) : null;
  if (water) {
    for (const [r, v] of RINGS) {
      let hit = false;
      for (let k = 0; k < 8 && !hit; k++) {
        const a = (k * Math.PI) / 4;
        hit = water(x + Math.cos(a) * r, z + Math.sin(a) * r);
      }
      if (hit) {
        nearWater = v;
        break;
      }
    }
  }
  // バザクルの堰
  const baz = world.landmarks?.find((l) => l.id === 'bazacle');
  const weir = !!baz && Math.hypot(baz.x - x, baz.z - z) < WEIR_RANGE;
  // 近くの人（25 m 以内の歩く人と客の数 ÷ 12、1 で頭打ち）
  const n = world.life?.near?.(x, z, 25) || 0;
  const people = Math.min(1, n / 12);
  // 公園・芝: 自転車が芝の上か、まわり 15 m の 4 点に芝があれば 1
  let park = bike.surface === 'grass' ? 1 : 0;
  if (!park && world.surfaceAt) {
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      if (world.surfaceAt(x + dx * PARK_PROBE, z + dz * PARK_PROBE) === 'grass') {
        park = 1;
        break;
      }
    }
  }
  // 近くのトラム（計画 D の world.traffic。無ければ鳴らさない）
  let tram = null;
  const t = world.traffic?.nearestTram?.(bike);
  if (t && Number.isFinite(t.x) && Number.isFinite(t.z)) {
    const dx = t.x - x, dz = t.z - z;
    tram = { d: Number.isFinite(t.d) ? t.d : Math.hypot(dx, dz), dx, dz };
  }
  // 時間帯（計画 B の state.timeOfDay: morning・afternoon・golden・night。無ければ昼）
  const tod = state?.timeOfDay;
  return {
    oldTown: inOld, nearWater, weir, people, park,
    night: tod === 'night', morning: tod === 'morning',
    speed: Math.abs(bike.speed || 0), heading: bike.heading || 0, tram,
  };
}
