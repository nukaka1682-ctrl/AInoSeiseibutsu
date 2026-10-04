// 見た目の確認用: 指定した位置・向き・カメラでスクリーンショットを撮る（合成データ使用）
//   node test/shot.mjs '[{"name":"a","x":0,"z":0,"heading":0,"camera":"chase"}]'
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { preview } from 'vite';
import { chromium } from 'playwright';
import { makeFixture } from './fixture.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'test', 'output');
await mkdir(out, { recursive: true });
const views = JSON.parse(process.argv[2] || '[{"name":"shot"}]');
const fx = makeFixture('light');
const server = await preview({ root, preview: { port: 4180, strictPort: true }, logLevel: 'warn' });
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', (e) => console.error('pageerror', e));
page.on('console', (m) => m.type() === 'error' && console.error(m.text()));
// REAL=1: public/data/centre.json（本物のトゥールーズ）を使う。それ以外は合成データ
const real = process.env.REAL === '1';
if (!real) {
  await page.route('**/api/interpreter', (r) => r.fulfill({ contentType: 'application/json', body: JSON.stringify(fx.osm) }));
  await page.route('**/data.geopf.fr/**', (r) => r.fulfill({ contentType: 'application/json', body: JSON.stringify(fx.bdtopo) }));
}
await page.goto(`http://localhost:4180/?area=${real ? 'centre' : 'light'}&autostart=1`);
await page.waitForFunction(() => window.__tav?.phase === 'play' || !document.getElementById('error-screen').classList.contains('hidden'), null, { timeout: 300000 });
if (await page.evaluate(() => window.__tav?.phase !== 'play')) {
  console.error(await page.textContent('#error-text'));
  process.exit(1);
}
for (const v of views) {
  await page.evaluate((v) => {
    const s = window.__tav;
    if (v.lm) {
      const lm = s.world.landmarks.find((l) => l.id === v.lm);
      const a = lm.approach;
      const back = v.back || 0; // 名所から少し離れた位置から見る
      const h = Math.atan2(lm.x - a.x, -(lm.z - a.z)) + (v.turn || 0);
      s.bike.place(a.x - Math.sin(h) * back, a.z + Math.cos(h) * back, h);
    } else if (v.x != null) s.bike.place(v.x, v.z, v.heading || 0);
    s.rig.mode = v.camera || 'chase';
    s.rig.initialized = false;
    window.__tavSimulate(v.sim || 0.6, v.ctl || {});
    document.getElementById('toast').classList.toggle('show', !!v.toast);
  }, v);
  await page.waitForTimeout(700);
  if (v.map) {
    await page.keyboard.press('KeyM');
    await page.waitForTimeout(800);
  }
  // JPEG=1 なら README 用に JPEG で保存
  await page.screenshot(process.env.JPEG ? { path: join(out, `${v.name}.jpg`), type: 'jpeg', quality: 82 } : { path: join(out, `${v.name}.png`) });
  if (v.map) await page.keyboard.press('KeyM');
}
await browser.close();
server.httpServer.close();
