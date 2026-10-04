// 実写 3D（Google Photorealistic 3D Tiles / Cesium ion）モードの確認。
// 本物のトゥールーズの地図データ（public/data/centre.json）とトークンが必要。
//   CESIUM_ION_TOKEN=... npm run build && node test/photoreal.mjs
// 地図データの道路（黄）と建物の外形（赤）を実写の上に重ねた画像も保存し、位置が合っているか確かめる。
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const token = process.env.CESIUM_ION_TOKEN;
if (!token) {
  console.log('CESIUM_ION_TOKEN が未設定なのでスキップ');
  process.exit(0);
}
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'test', 'output');
await mkdir(out, { recursive: true });
const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
  ...(proxy ? { proxy: { server: proxy } } : {}),
});
const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, ignoreHTTPSErrors: !!proxy });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => m.type() === 'warning' && /実写/.test(m.text()) && console.log('warn:', m.text()));
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm' };
await page.route('http://game.test/**', async (r) => {
  const path = decodeURIComponent(new URL(r.request().url()).pathname).replace(/^\/$/, '/index.html');
  try {
    r.fulfill({ body: await readFile(join(root, 'dist', path)), contentType: TYPES[extname(path)] || 'application/octet-stream' });
  } catch {
    r.fulfill({ status: 404, body: 'not found' });
  }
});
await page.route(/overpass|geopf/, (r) => r.abort('connectionrefused')); // 地図データは同梱のものを使う
await page.addInitScript((t) => localStorage.setItem('tav-ion-token', JSON.stringify(t)), token);
const t0 = Date.now();
await page.goto(`http://game.test/?area=${process.env.AREA || 'centre'}&autostart=1`);
await page.waitForFunction(() => window.__tav?.phase === 'play' || !document.getElementById('error-screen').classList.contains('hidden'), null, { timeout: 600000 });
const st = await page.evaluate(() => ({ phase: window.__tav.phase, photoOn: window.__tav.photoOn, toast: document.getElementById('toast').textContent, models: window.__tav.photo?.loadedModels }));
console.log(`${((Date.now() - t0) / 1000).toFixed(0)} 秒`, st);
if (!st.photoOn) {
  await browser.close();
  console.log('✘ 実写 3D に切り替わらなかった');
  process.exit(1);
}

// 地図データの道路・建物の外形を重ねる（位置合わせの確認用）
async function overlay(on) {
  await page.evaluate((on) => {
    const { THREE, scene } = window.__tavDebug;
    let g = scene.getObjectByName('align-overlay');
    if (!on) {
      if (g) g.visible = false;
      return;
    }
    if (!g) {
      const w = window.__tav.world;
      const road = [], bld = [];
      for (const r of w.parsed.roads) for (let i = 0; i + 1 < r.pts.length; i++) road.push(r.pts[i][0], 0.5, r.pts[i][1], r.pts[i + 1][0], 0.5, r.pts[i + 1][1]);
      for (const b of w.parsed.buildings) for (let i = 0; i < b.outer.length; i++) {
        const a = b.outer[i], c = b.outer[(i + 1) % b.outer.length];
        bld.push(a[0], b.info.height, a[1], c[0], b.info.height, c[1]);
      }
      g = new THREE.Group();
      g.name = 'align-overlay';
      const mk = (arr, color) => {
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3));
        const l = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color, depthTest: false }));
        l.renderOrder = 999;
        return l;
      };
      g.add(mk(road, '#ffd400'), mk(bld, '#ff2a2a'));
      scene.add(g);
    }
    g.visible = true;
  }, on);
}

async function shot(name, v, wait = 25000) {
  await page.evaluate((v) => {
    const s = window.__tav;
    if (v.lm) {
      const lm = s.world.landmarks.find((l) => l.id === v.lm);
      const a = lm.approach;
      const h = Math.atan2(lm.x - a.x, -(lm.z - a.z) || 1e-9) + (v.turn || 0);
      s.bike.place(a.x - Math.sin(h) * (v.back || 0), a.z + Math.cos(h) * (v.back || 0), h);
    } else s.bike.place(v.x, v.z, v.heading || 0);
    s.rig.mode = v.camera || 'chase';
    s.rig.initialized = false;
    document.getElementById('toast').classList.remove('show');
  }, v);
  // 実際のゲームと同じく、少しずつ進めながらタイルの読み込みを待つ
  const end = Date.now() + wait;
  while (Date.now() < end) {
    await page.evaluate(() => window.__tavSimulate(0.05, {}));
    await page.waitForTimeout(500);
    const p = await page.evaluate(() => window.__tav.photo.progress);
    if (p >= 1 && Date.now() > end - wait + 6000) break;
  }
  await page.evaluate(() => window.__tavSimulate(0.3, {}));
  await page.waitForTimeout(800);
  const y = await page.evaluate(() => window.__tav.bike.y.toFixed(2));
  await page.screenshot({ path: join(out, `${name}.jpg`), type: 'jpeg', quality: 85 });
  console.log(`  ${name}: 地面の高さ y=${y}`);
}

await shot('photo-capitole', { lm: 'place-capitole' });
await shot('photo-pontneuf', { x: -330, z: 299, heading: 1.31 });
await shot('photo-garonne', { x: -250, z: 200, heading: -0.9 });
await shot('photo-sernin', { lm: 'saint-sernin', back: 40 });
await shot('photo-high', { lm: 'place-capitole', camera: 'high' });
await overlay(true);
await shot('photo-align-high', { lm: 'place-capitole', camera: 'high' }, 8000);
await shot('photo-align-street', { lm: 'saint-sernin', back: 40 }, 8000);
await overlay(false);
// 少し走ってみる（地面に沿って高さが変わるか）
const ys = await page.evaluate(() => {
  const s = window.__tav;
  const out = [];
  for (let i = 0; i < 20; i++) {
    window.__tavSimulate(0.5, { throttle: 1 });
    out.push(+s.bike.y.toFixed(2));
  }
  return out;
});
console.log('  走行中の高さ:', ys.join(' '));
await browser.close();
console.log(errors.length ? `✘ エラー:\n${errors.join('\n')}` : '✔ 実写 3D モードで表示できた');
process.exit(errors.length ? 1 : 0);
