// メトロのゲームを本物の地図データで開いて、好きな手順で確かめる（開発用）。
//   npm run build && node test/metro-probe.mjs '<URL の問い合わせ>' '<手順の JS（async 関数の中身。page・shot(name)・sim(秒, ctl) が使える）>'
// 例: node test/metro-probe.mjs 'station=basso-cambo&start=platform' 'await shot("a")'
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { preview } from 'vite';
import { chromium } from 'playwright';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'test', 'output');
await mkdir(out, { recursive: true });
const port = 4190 + Math.floor(Math.random() * 200);
const server = await preview({ root, preview: { port, strictPort: true }, logLevel: 'warn' });
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
  if (process.env.VERBOSE) console.log('[console]', m.text());
});
page.on('pageerror', (e) => errors.push(String(e)));
await page.goto(`http://localhost:${port}/metro.html?autostart=1&${process.argv[2] || ''}`);
await page.waitForFunction(() => window.__metro?.phase === 'play' || !document.getElementById('error-screen').classList.contains('hidden'), null, { timeout: 600000 });
const shot = async (name) => {
  await page.evaluate(() => document.getElementById('toast').classList.remove('show'));
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  await page.screenshot({ path: join(out, `probe-${name}.png`) });
};
const sim = (s, ctl = { fwd: 0, side: 0 }) => page.evaluate(([s, ctl]) => window.__metroSimulate(s, ctl), [s, ctl]);
const ev = (code) => page.evaluate(code);
try {
  await new (Object.getPrototypeOf(async () => {}).constructor)('page', 'shot', 'sim', 'ev', process.argv[3] || 'await shot("start")')(page, shot, sim, ev);
} catch (e) {
  console.log('手順のエラー:', e);
}
console.log('エラー', JSON.stringify([...new Set(errors)].slice(0, 8)));
await browser.close();
await server.close();
process.exit(0);
