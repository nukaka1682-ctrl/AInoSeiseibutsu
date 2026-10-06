// 本物の地図データ（public/data/<area>.json）の上で、ゲームのナビのルートに沿って自転車を自動で走らせ、
// すべての名所にたどり着けるか（道が建物でふさがっていないか、川で止まらないか等）を確かめる。
// 描画はせず、ゲームと同じコード（world/assemble.js・game/bike.js）で物理だけを動かす。
//   npm run fetch-data && node test/autopilot.mjs [centre]
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assembleWorld } from '../src/world/assemble.js';
import { Bike } from '../src/game/bike.js';
import { distanceToLandmark } from '../src/game/landmarks.js';
import { LANDMARKS, TOUR_ROUTE } from '../src/config.js';
import { closestOnSegment } from '../src/geo.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const area = process.argv[2] || 'centre';
let data;
try {
  data = JSON.parse(await readFile(join(root, 'public', 'data', `${area}.json`), 'utf8'));
} catch {
  console.log(`public/data/${area}.json がないのでスキップ（npm run fetch-data -- ${area} で作成）`);
  process.exit(0);
}
const noTex = new Proxy({}, { get: () => null });
const { createBuildingMaterials } = await import('../src/world/buildings.js');
const { createGroundMaterials } = await import('../src/world/ground.js');
const w = await assembleWorld({ ...data, source: 'test' }, data.bbox, {
  buildingMats: createBuildingMaterials(noTex),
  groundMats: createGroundMaterials(noTex),
});
console.log(`建物 ${w.stats.buildings.total} / 道 ${w.stats.roads} / 木 ${w.stats.trees} / 通路として開けた壁 ${w.stats.passages}${w.real ? ' / LiDAR の地形' : ''}`);

const DT = 1 / 30;
const world = { collision: w.collision, surfaceAt: w.surfaceAt, groundAt: w.groundAt };
const bike = new Bike();
const L = (id) => w.landmarks.find((l) => l.id === id);
const start = w.roadnet.nearestRideablePoint(L('place-capitole').approach.x, L('place-capitole').approach.z);
bike.place(start.x, start.z, start.heading, w.heightAt(start.x, start.z));

// プレイヤーの代わりに、ナビのルート上の少し先の点に向かってハンドルを切る
function ride(target, limit = 600) {
  let route = null, rt = 0, wedged = 0, backing = 0, lastT = 0, lx = bike.x, lz = bike.z;
  for (let t = 0; t < limit; t += DT) {
    if ((rt -= DT) <= 0) {
      route = w.roadnet.route(bike.x, bike.z, target.approach.x, target.approach.z);
      rt = 1;
    }
    let steer = 0, throttle = 1, brake = 0;
    if (route && route.length > 1) {
      // ルート上で自分に一番近い点から、速さに応じた距離（3〜9 m）だけ先の点を目標にする（pure pursuit）
      let bi = 0, bt = 0, bd = Infinity;
      for (let i = 0; i + 1 < route.length; i++) {
        const c = closestOnSegment(bike.x, bike.z, route[i][0], route[i][1], route[i + 1][0], route[i + 1][1]);
        if (c.d2 < bd) {
          bd = c.d2;
          bi = i;
          bt = c.t;
        }
      }
      let left = Math.max(3, Math.min(9, 2.5 + Math.abs(bike.speed) * 0.6));
      let goal = route[route.length - 1];
      for (let i = bi; i + 1 < route.length; i++) {
        const [ax, az] = route[i], [bx, bz] = route[i + 1];
        const len = Math.hypot(bx - ax, bz - az);
        const from = i === bi ? bt * len : 0;
        if (len - from >= left) {
          const f = (from + left) / (len || 1);
          goal = [ax + (bx - ax) * f, az + (bz - az) * f];
          break;
        }
        left -= len - from;
      }
      let diff = Math.atan2(goal[0] - bike.x, -(goal[1] - bike.z)) - bike.heading;
      diff = Math.atan2(Math.sin(diff), Math.cos(diff));
      steer = Math.max(-1, Math.min(1, diff * 2.5));
      if (Math.abs(diff) > 0.9 && bike.speed > 3) {
        throttle = 0;
        brake = 1;
      }
    }
    // 壁に押し付けられて止まったら、プレイヤーが S を押すのと同じようにバックする
    wedged = bike.contact && Math.abs(bike.speed) < 1 ? wedged + DT : 0;
    if (wedged > 0.7) {
      backing = 1.6;
      wedged = 0;
    }
    if (backing > 0) {
      backing -= DT;
      throttle = 0;
      brake = 1;
      steer = -steer || 1;
    }
    bike.update(DT, { throttle, brake, steer, sprint: false }, world);
    bike.events.length = 0;
    if (distanceToLandmark(target, bike.x, bike.z) < 22) return { ok: true, t };
    if (t - lastT > 15) {
      if (Math.hypot(bike.x - lx, bike.z - lz) < 8) return { ok: false, t, why: `(${bike.x.toFixed(0)}, ${bike.z.toFixed(0)}) で動けなくなった` };
      lastT = t;
      lx = bike.x;
      lz = bike.z;
    }
  }
  return { ok: false, t: limit, why: '時間切れ' };
}

const seq = [...TOUR_ROUTE.slice(1), ...LANDMARKS.map((l) => l.id)].filter((id) => L(id));
let fails = 0, total = 0;
for (const id of seq) {
  const r = ride(L(id));
  total += r.t;
  console.log(`${r.ok ? '✔' : '✘'} → ${L(id).ja.padEnd(16, '　')} ${r.t.toFixed(0)} 秒${r.ok ? '' : `  ${r.why}`}`);
  if (!r.ok) {
    fails++;
    const p = w.roadnet.nearestRideablePoint(bike.x, bike.z);
    bike.place(p.x, p.z, p.heading, w.heightAt(p.x, p.z));
  }
}
console.log(`走行 ${(bike.odometer / 1000).toFixed(1)} km / ${(total / 60).toFixed(0)} 分（ゲーム内時間）`);
console.log(fails ? `✘ ${fails} か所にたどり着けなかった` : '✔ すべての名所に自動走行でたどり着けた');
process.exit(fails ? 1 : 0);
