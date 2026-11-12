// 音の確認（耳で聞けないので、数で確かめる）: ビルド済みのページ（タイトル画面）を開き、
// OfflineAudioContext（2 ch・44.1 kHz）にゲームと同じ音の作りをつないで場面ごとに 3 秒描き、
// 左右の RMS・最大の振幅・NaN の有無を表にする。
//   npx vite build && CHROMIUM_PATH=/opt/pw-browsers/chromium node test/audio-check.mjs
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { preview } from 'vite';
import { chromium } from 'playwright';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const server = await preview({ root, preview: { port: 4189, strictPort: false }, logLevel: 'warn' });
const port = server.config.preview.port;
const url = server.resolvedUrls?.local?.[0] || `http://localhost:${port}/`;
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });

// 場面: name, scene（audio.js の audioTest の形）, 条件
const quiet = { oldTown: true, nearWater: 0, people: 0, park: 0 };
const one = (name, arg) => ({ ambient: quiet, shots: [{ at: 0.1, name, arg }] });
const SCENES = [
  ['1 止まっている・昼の旧市街・人なし', { ambient: quiet, bike: { speed: 0 } }, { maxRms: 0.02 }],
  ['2 石畳を 6 m/s', { ambient: quiet, bike: { speed: 6, surface: 'paving', pedaling: true } }, { moreThan: 1 }],
  ['3 アスファルトを 6 m/s', { ambient: quiet, bike: { speed: 6, surface: 'road', pedaling: true } }, { lessThan: 2 }],
  ['4 川のそば・公園・朝', { ambient: { ...quiet, oldTown: false, nearWater: 1, park: 1, morning: true }, bike: { speed: 0 } }, { moreThan: 1 }],
  ['5 夜の公園（虫）', { ambient: { ...quiet, oldTown: false, park: 1, night: true }, bike: { speed: 0 } }, { audible: true }],
  ['6a 鐘（サン・セルナン 100 m）', { ambient: quiet, bells: { id: 'saint-sernin', d: 100 } }, { audible: true }],
  ['6b トラムの鐘', one('event', { type: 'tram-bell', x: 10, z: -10 }), { audible: true }],
  ['6c 羽ばたき', one('event', { type: 'pigeons' }), { audible: true }],
  ['6d ファンファーレ（金）', one('fanfare', 'gold'), { audible: true }],
  ['6e スミレ', one('collect'), { audible: true }],
  ['6f シャッター', one('shutter'), { audible: true }],
  ['6g UI', one('ui'), { audible: true }],
  ['6h 人にぶつかった（トン）', one('event', { type: 'person' }), { audible: true }],
  ['6i ほかの自転車のベル', one('event', { type: 'bike-bell', x: -5, z: 0 }), { audible: true }],
  ['6j ブレーキ（8 m/s）', { ambient: quiet, bike: { speed: 8, surface: 'road', braking: true } }, { audible: true }],
  ['7 全部を同時に', {
    ambient: { oldTown: false, nearWater: 1, weir: true, people: 1, park: 1, morning: true, tram: { d: 10, dx: 10, dz: 0 } },
    bike: { speed: 8, surface: 'paving', pedaling: true, braking: true },
    bells: { id: 'saint-sernin', d: 20 },
    shots: [{ at: 0.4, name: 'bell' }, { at: 0.5, name: 'event', arg: { type: 'tram-bell' } }, { at: 0.6, name: 'event', arg: { type: 'pigeons' } },
      { at: 0.7, name: 'fanfare', arg: 'gold' }, { at: 0.8, name: 'collect' }, { at: 0.9, name: 'chime' }, { at: 1, name: 'bump', arg: 1 }],
  }, { audible: true }],
];

let failed = false;
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(url);
  await page.waitForFunction(() => typeof window.__tavAudioTest === 'function', null, { timeout: 60000 });
  const res = [];
  for (const [name, scene, cond] of SCENES) {
    const r = await page.evaluate((s) => window.__tavAudioTest(s), scene);
    res.push({ name, r, cond });
  }
  const rmsOf = (r) => Math.max(...r.rms);
  console.log('| 場面 | RMS 左 | RMS 右 | 最大の振幅 | NaN | 判定 |');
  console.log('| --- | --- | --- | --- | --- | --- |');
  for (const { name, r, cond } of res) {
    const m = rmsOf(r);
    const why = [];
    if (r.nan) why.push('NaN');
    if (!(r.peak < 1)) why.push('割れ');
    if (cond.maxRms != null && !(m < cond.maxRms)) why.push(`RMS ≥ ${cond.maxRms}`);
    if ((cond.audible || cond.moreThan || cond.lessThan) && !(m > 0.001)) why.push('無音');
    if (cond.moreThan && !(m > rmsOf(res[cond.moreThan - 1].r))) why.push(`場面 ${cond.moreThan} 以下`);
    if (cond.lessThan && !(m < rmsOf(res[cond.lessThan - 1].r))) why.push(`場面 ${cond.lessThan} 以上`);
    if (why.length) failed = true;
    console.log(`| ${name} | ${r.rms[0].toFixed(4)} | ${r.rms[1].toFixed(4)} | ${r.peak.toFixed(3)} | ${r.nan ? 'あり' : 'なし'} | ${why.length ? `✘ ${why.join('・')}` : '✔'} |`);
  }
  if (errors.length) {
    failed = true;
    console.log('ページのエラー:', errors.join('\n'));
  }
} catch (e) {
  console.error(e);
  failed = true;
} finally {
  await browser.close();
  await new Promise((r) => server.httpServer.close(r));
}
console.log(failed ? '✘ 音の確認に失敗' : '✔ 音の確認: すべて合格');
process.exit(failed ? 1 : 0);
