// ブラウザでの通しテスト: ビルド済みのゲームを開き、地図サーバーへの通信を合成データで差し替えて
// 「読み込み → 走行 → 衝突 → 地図 → タイムアタック」が動くことを確かめ、スクリーンショットを保存する。
//   npm run build && npm run test:e2e
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { preview } from 'vite';
import { chromium } from 'playwright';
import { fakeIgnRaster, fakeTerrain, makeFixture } from './fixture.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'test', 'output');
await mkdir(out, { recursive: true });

const fx = makeFixture('light');
const server = await preview({ root, preview: { port: 4179, strictPort: true }, logLevel: 'warn' });
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const errors = [];
let failed = false;
const check = (cond, msg) => {
  console.log(`${cond ? '✔' : '✘'} ${msg}`);
  if (!cond) failed = true;
};

async function newPage(query) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.route('**/api/interpreter', (r) => r.fulfill({ contentType: 'application/json', body: JSON.stringify(fx.osm) }));
  await page.route('**/data.geopf.fr/**', (r) => {
    const url = r.request().url();
    // LiDAR（標高の BIL）と航空写真は合成、BD TOPO（WFS）は合成の GeoJSON
    r.fulfill(url.includes('/wms-r/') ? fakeIgnRaster(fx, url) : { contentType: 'application/json', body: JSON.stringify(fx.bdtopo) });
  });
  await page.goto(`http://localhost:4179/?area=light&autostart=1${query}`);
  await page.waitForFunction(() => window.__tav?.phase === 'play', null, { timeout: 120000 });
  return page;
}

const bikeState = (page) => page.evaluate(() => {
  const b = window.__tav.bike;
  return { x: b.x, z: b.z, speed: b.speed, heading: b.heading };
});

try {
  // ---- 自由走行 ----
  const page = await newPage('&refresh=1&real=0');
  await page.waitForTimeout(1500);
  await page.screenshot({ path: join(out, '01-start.png') });
  const start = await bikeState(page);
  check(true, `スタート地点 (${start.x.toFixed(1)}, ${start.z.toFixed(1)})`);

  // 物理は描画速度に依存しないよう __tavSimulate でゲーム内時間を進める
  const sim = (sec, ctl) => page.evaluate(([s, c]) => window.__tavSimulate(s, c), [sec, ctl]);
  await sim(4, { throttle: 1 });
  const moving = await bikeState(page);
  await page.screenshot({ path: join(out, '02-riding.png') });
  check(moving.speed > 5 && moving.speed < 10, `こぐと加速する（${(moving.speed * 3.6).toFixed(1)} km/h）`);
  check(Math.hypot(moving.x - start.x, moving.z - start.z) > 10, `前に進む（${Math.hypot(moving.x - start.x, moving.z - start.z).toFixed(1)} m）`);
  await sim(1.0, { throttle: 1, steer: 1 });
  const turned = await bikeState(page);
  check(Math.abs(turned.heading - moving.heading) > 0.3, `右に曲がる（${(turned.heading - moving.heading).toFixed(2)} rad）`);
  await sim(3, { brake: 1 });
  const stopped = await bikeState(page);
  check(Math.abs(stopped.speed) < 2, `ブレーキで止まる/後退する（${(stopped.speed * 3.6).toFixed(1)} km/h）`);
  await page.screenshot({ path: join(out, '03-turn.png') });

  // 建物への衝突: 建物の南側の壁に向かって北向きに走らせる
  const wall = await page.evaluate(() => {
    const w = window.__tav.world;
    const b = w.parsed.buildings.find((q) => !q.tags.name && q.info.collide && q.bounds.maxX - q.bounds.minX > 10 && q.bounds.maxZ < 300);
    const x = (b.bounds.minX + b.bounds.maxX) / 2;
    const z = b.bounds.maxZ + 6;
    window.__tav.bike.place(x, z, 0);
    return { x, wallZ: b.bounds.maxZ };
  });
  await sim(4, { throttle: 1, sprint: true });
  const afterWall = await bikeState(page);
  check(afterWall.z > wall.wallZ, `建物を通り抜けない（壁 z=${wall.wallZ.toFixed(1)}, 自転車 z=${afterWall.z.toFixed(1)}）`);
  await page.screenshot({ path: join(out, '04-wall.png') });

  // 川: 橋のない所で川に向かって西へ
  await page.evaluate(() => window.__tav.bike.place(-370, 100, -Math.PI / 2));
  await sim(6, { throttle: 1 });
  const atRiver = await bikeState(page);
  check(atRiver.x > -400, `橋以外では川に入れない（x=${atRiver.x.toFixed(1)}）`);

  // 橋: ポン・ヌフを西へ渡る
  await page.evaluate(() => window.__tav.bike.place(-345, 450, -Math.PI / 2));
  await sim(2, { throttle: 1, sprint: true });
  await page.screenshot({ path: join(out, '05-bridge.png') });
  await sim(25, { throttle: 1, sprint: true });
  const crossed = await bikeState(page);
  check(crossed.x < -560, `橋を渡って左岸へ（x=${crossed.x.toFixed(1)}）`);
  await page.waitForTimeout(500);
  const street = await page.textContent('#hud-street');
  check(street.length > 0, `通りの名前を表示（「${street}」）`);

  // 上空カメラ
  await page.keyboard.press('KeyC');
  await page.keyboard.press('KeyC');
  await page.waitForTimeout(800);
  await page.screenshot({ path: join(out, '06-high-camera.png') });
  await page.keyboard.press('KeyC');
  await page.waitForTimeout(800);
  const drone = await page.evaluate(() => window.__tav.rig.mode);
  check(drone === 'drone', `空撮カメラに切り替わる（${drone}）`);
  await page.keyboard.press('KeyC');

  // 地図とナビ
  await page.keyboard.press('KeyM');
  await page.waitForTimeout(500);
  await page.click('#landmark-list li:first-child');
  await page.screenshot({ path: join(out, '07-map.png') });
  await page.keyboard.press('KeyM');
  await page.waitForTimeout(1500);
  const nav = await page.evaluate(() => ({ target: window.__tav.target?.id, route: window.__tav.route?.length || 0 }));
  check(!!nav.target && nav.route > 2, `目的地を選ぶとルートが出る（${nav.target}, ${nav.route} 点）`);
  await page.screenshot({ path: join(out, '08-navigation.png') });

  // 一人称
  await page.keyboard.press('KeyC');
  await sim(1.5, { throttle: 1 });
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(out, '09-fpv.png') });
  await page.close();

  // ---- タイムアタック ----
  const tour = await newPage('&mode=tour&real=0');
  const t = await tour.evaluate(() => ({ list: window.__tav.tour?.list.map((l) => l.id), target: window.__tav.target?.id }));
  check(t.list && t.list.length >= 3, `タイムアタックのコース: ${t.list?.join(' → ')}`);
  // チェックポイントにワープして通過を確認
  await tour.evaluate(() => {
    const lm = window.__tav.target;
    window.__tav.bike.place(lm.approach.x, lm.approach.z, 0);
  });
  await tour.evaluate(() => window.__tavSimulate(0.5, { throttle: 1 }));
  const idx = await tour.evaluate(() => window.__tav.tour.index);
  check(idx === 2, `チェックポイント通過（index=${idx}）`);
  await tour.screenshot({ path: join(out, '10-tour.png') });
  await tour.close();

  // ---- 本物そっくりモード（合成の LiDAR・航空写真）----
  const real = await newPage('&refresh=1');
  const rs = await real.evaluate(() => {
    const w = window.__tav.world;
    const b = window.__tav.bike;
    return { lidar: w.stats.lidar, base: w.real?.base, y: b.y, x: b.x, z: b.z, trees: w.stats.trees, tris: w.stats.triangles };
  });
  check(rs.lidar, `LiDAR の実測データで街を作る（三角形 ${rs.tris?.toLocaleString()}・木 ${rs.trees} 本）`);
  check(Math.abs(rs.base + rs.y - fakeTerrain(rs.x, rs.z)) < 0.3, `自転車が地面の上にいる（標高 ${(rs.base + rs.y).toFixed(1)} m）`);
  check(rs.trees >= 15 && rs.trees <= 25, `樹冠から木を見つける（${rs.trees} 本、並木は 20 本）`);
  const roof = await real.evaluate(() => {
    // 建物の中心の真上の高さ（屋根の上）
    const w = window.__tav.world;
    const b = w.parsed.buildings.find((q) => q.tags.name === 'Capitole de Toulouse');
    const x = (b.bounds.minX + b.bounds.maxX) / 2, z = (b.bounds.minZ + b.bounds.maxZ) / 2;
    const ray = new window.__tavDebug.THREE.Raycaster(new window.__tavDebug.THREE.Vector3(x, 200, z), new window.__tavDebug.THREE.Vector3(0, -1, 0));
    const hit = ray.intersectObject(w.real.group, true)[0];
    return hit ? hit.point.y + w.real.base : null;
  });
  check(roof != null && Math.abs(roof - 158) < 1, `屋根の高さが表面モデルと一致（${roof?.toFixed(1)} m、実測 158 m）`);
  // ポン・ヌフ: 橋面（141 m）の上を走り、川（132 m）に落ちない
  await real.evaluate(() => {
    const s = window.__tav;
    s.bike.place(-345, 450, -Math.PI / 2, s.world.heightAt(-345, 450));
  });
  await real.evaluate(() => window.__tavSimulate(14, { throttle: 1, sprint: true }));
  const onBridge = await real.evaluate(() => ({ x: window.__tav.bike.x, y: window.__tav.bike.y + window.__tav.world.real.base }));
  check(onBridge.x < -420 && Math.abs(onBridge.y - 141) < 0.6, `橋の上を走る（x=${onBridge.x.toFixed(1)}、標高 ${onBridge.y.toFixed(1)} m）`);
  await real.screenshot({ path: join(out, '11-real-bridge.png') });
  await real.close();
} catch (err) {
  console.error(err);
  failed = true;
} finally {
  await browser.close();
  server.httpServer.close();
}

const relevant = errors.filter((e) => !/favicon|data\/light\.json/.test(e));
check(relevant.length === 0, `コンソールエラーなし${relevant.length ? `: \n${relevant.join('\n')}` : ''}`);
console.log(`スクリーンショット: ${out}`);
process.exit(failed ? 1 : 0);
