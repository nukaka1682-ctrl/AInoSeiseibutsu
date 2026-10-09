// ブラウザでの通しテスト: ビルド済みのゲームを開き、地図サーバーへの通信を合成データで差し替えて
// 「読み込み → 走行 → 衝突 → 地図 → タイムアタック」が動くことを確かめ、スクリーンショットを保存する。
//   npm run build && npm run test:e2e
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { preview } from 'vite';
import { chromium } from 'playwright';
import { fakeIgnRaster, makeFixture } from './fixture.mjs';
import { DATA_VERSION } from '../src/config.js';

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

async function newPage(query, baked = null) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  // 同梱データ（data/light.json）の代わり
  if (baked) await page.route('**/data/light.json', (r) => r.fulfill({ contentType: 'application/json', body: JSON.stringify(baked) }));
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
  const capitole = (p) => p.evaluate(() => {
    let tris = 0;
    window.__tav.world.group.traverse((o) => {
      if (o.isMesh && o.material.alphaTest === 0.5) tris += o.geometry.attributes.position.count / 3;
    });
    return tris;
  });
  const capTris = await capitole(page);
  check(capTris >= 2, `キャピトルの正面に専用のファサード（${capTris} 三角形）`);

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

  // ---- 塀（同梱データの、地籍と LiDAR から見つけた塀）----
  // スタート地点の 10 m 先に、道を横切る長さ 16 m の塀を置く: 道路の上は切り取られて通れ、道の外の部分は当たり判定がある
  const ahead = (d, side) => [start.x + Math.sin(start.heading) * d + Math.cos(start.heading) * side, start.z - Math.cos(start.heading) * d + Math.sin(start.heading) * side];
  const lonLat = ([x, z]) => fx.proj.unproject(x, z).reverse();
  const fence = [...lonLat(ahead(10, -8)), ...lonLat(ahead(10, 8)), 2.4];
  const baked = { version: DATA_VERSION, bbox: fx.bbox, provider: 'osm', osm: fx.osm, bdtopo: [], walls: [fence], trees: [[...lonLat(ahead(-20, 6)), 11, 3.5]] };
  const wp = await newPage('', baked);
  // 木の数は同梱データの木だけ（街の外れの川岸の土手に自動で植える木は除く）
  const ws = await wp.evaluate(() => ({ walls: window.__tav.world.stats.walls, trees: window.__tav.world.stats.trees - (window.__tav.world.stats.bankTrees || 0) }));
  check(ws.walls >= 1 && ws.walls <= 2 && ws.trees === 1, `同梱データの塀と木を置く（道路の上を切り取って塀 ${ws.walls}・木 ${ws.trees}）`);
  const [p0, p1] = [ahead(5, -7.5), ahead(15, -7.5)];
  const hit = await wp.evaluate(([a, b]) => window.__tav.world.collision.raycast(a[0], a[1], b[0], b[1]), [p0, p1]);
  check(hit > 0.4 && hit < 0.6, `道の外の塀には当たる（${hit.toFixed(2)}）`);
  await wp.evaluate((s) => window.__tav.bike.place(s.x, s.z, s.heading), start);
  await wp.evaluate(() => window.__tavSimulate(6, { throttle: 1 }));
  const passed = await wp.evaluate((s) => {
    const b = window.__tav.bike;
    return (b.x - s.x) * Math.sin(s.heading) - (b.z - s.z) * Math.cos(s.heading);
  }, start);
  check(passed > 12, `道路の上は塀でふさがない（スタートから ${passed.toFixed(1)} m 進んだ）`);
  await wp.screenshot({ path: join(out, '11-wall.png') });
  await wp.close();
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
