// 本物のネットワークを使う通しテスト（地図サーバーに接続できる環境用）。
// Overpass API を意図的に失敗させ、ブラウザが IGN BD TOPO に自動で切り替えて
// 本物のトゥールーズ（軽量エリア）を組み立てられることを確かめる。
//   npm run build && node test/e2e-network.mjs
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'test', 'output');
await mkdir(out, { recursive: true });
const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  ...(proxy ? { proxy: { server: proxy, bypass: 'localhost,127.0.0.1' } } : {}),
});
const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, ignoreHTTPSErrors: !!proxy });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
let ignRequests = 0;
page.on('request', (r) => {
  if (r.url().includes('data.geopf.fr')) ignRequests++;
});
// ゲーム本体は dist/ からそのまま返す（プロキシ環境では localhost もプロキシに送られてしまうため）
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
await page.route('http://game.test/**', async (r) => {
  const path = new URL(r.request().url()).pathname.replace(/^\/$/, '/index.html');
  try {
    r.fulfill({ body: await readFile(join(root, 'dist', path)), contentType: TYPES[extname(path)] || 'application/octet-stream' });
  } catch {
    r.fulfill({ status: 404, body: 'not found' });
  }
});
// Overpass は失敗させる（IGN への自動切り替えを確かめるため）
await page.route(/overpass|maps\.mail\.ru/, (r) => r.abort('connectionrefused'));
const t0 = Date.now();
await page.goto('http://game.test/?area=light&autostart=1');
await page.waitForFunction(() => window.__tav?.phase === 'play' || !document.getElementById('error-screen').classList.contains('hidden'), null, { timeout: 300000 });
const result = await page.evaluate(() => {
  const s = window.__tav;
  if (s.phase !== 'play') return { error: document.getElementById('error-text').textContent };
  const st = s.world.stats;
  return {
    provider: st.provider,
    fallback: st.fallbackReason,
    buildings: st.buildings.total,
    ign: st.buildings.IGN,
    roads: st.roads,
    landmarks: s.world.landmarks.map((l) => `${l.matched ? '✔' : '·'}${l.id}`).join(' '),
  };
});
console.log(`${((Date.now() - t0) / 1000).toFixed(0)} 秒, IGN へのリクエスト ${ignRequests} 回`);
console.log(result);
await page.evaluate(() => document.getElementById('toast').classList.remove('show'));
await page.waitForTimeout(1000);
await page.screenshot({ path: join(out, 'network-light.png') });
await browser.close();
const ok = !result.error && result.provider === 'ign' && result.buildings > 1000 && result.ign > result.buildings * 0.9 && errors.length === 0;
console.log(ok ? '✔ IGN への自動切り替えで本物の街を組み立てられた' : `✘ 失敗 ${errors.join('\n')}`);
process.exit(ok ? 0 : 1);
