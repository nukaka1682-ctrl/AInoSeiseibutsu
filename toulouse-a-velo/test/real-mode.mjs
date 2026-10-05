// 「本物そっくりモード」を本物のネットワーク（IGN の地図・LiDAR・航空写真）で開き、指定の場所で撮影する。
//   npm run build && node test/real-mode.mjs '[{"name":"a","lm":"place-capitole"}]'
//   AREA=centre で標準エリア（既定は light）。地図データは public/data/<area>.json があればそれを使う。
//   IGN への通信は Node 経由（NODE_USE_ENV_PROXY=1 でプロキシを使う）で、test/output/cache にキャッシュする。
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'test', 'output');
await mkdir(out, { recursive: true });
const views = JSON.parse(process.argv[2] || '[{"name":"real-start"}]');
const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
  ...(proxy ? { proxy: { server: proxy } } : {}),
});
const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, ignoreHTTPSErrors: !!proxy });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => (m.type() === 'error' || m.type() === 'warning') && console.log(`[${m.type()}]`, m.text().slice(0, 200)));
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
await page.route('http://game.test/**', async (r) => {
  const path = decodeURIComponent(new URL(r.request().url()).pathname).replace(/^\/$/, '/index.html');
  try {
    r.fulfill({ body: await readFile(join(root, 'dist', path)), contentType: TYPES[extname(path)] || 'application/octet-stream' });
  } catch {
    r.fulfill({ status: 404, body: 'not found' });
  }
});
await page.route(/overpass|maps\.mail\.ru/, (r) => r.abort('connectionrefused')); // この環境からはつながらないので IGN を使う
// IGN への通信は Node 経由で行い、ディスクにキャッシュする（ブラウザ＋プロキシは不安定で、何度も撮り直すと遅いため）
// Node からプロキシを使うには NODE_USE_ENV_PROXY=1 で実行する
const cacheDir = join(out, 'cache');
await mkdir(cacheDir, { recursive: true });
await page.route('https://data.geopf.fr/**', async (r) => {
  const url = r.request().url();
  const file = join(cacheDir, createHash('sha1').update(url).digest('hex'));
  let body = await readFile(file).catch(() => null);
  let type = /FORMAT=image%2Fjpeg/i.test(url) ? 'image/jpeg' : /x-bil/i.test(url) ? 'application/octet-stream' : 'application/json';
  for (let i = 0; !body && i < 4; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(120000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      type = res.headers.get('content-type') || type;
      body = Buffer.from(await res.arrayBuffer());
      if (!/xml|html/.test(type)) await writeFile(file, body);
    } catch (e) {
      if (i === 3) console.log('  IGN の取得に失敗:', String(e).slice(0, 100), url.slice(0, 100));
    }
  }
  if (!body) return r.abort('failed');
  r.fulfill({ body, contentType: type, headers: { 'access-control-allow-origin': '*' } });
});
const t0 = Date.now();
await page.goto(`http://game.test/?area=${process.env.AREA || 'light'}&autostart=1`);
const ticker = setInterval(async () => {
  try {
    const t = await page.textContent('#loading-text');
    console.log(`  … ${((Date.now() - t0) / 1000).toFixed(0)} 秒: ${t.replace(/\n/g, ' / ').slice(0, 140)}`);
  } catch {
    // 読み込み画面が消えた
  }
}, 15000);
await page.waitForFunction(() => window.__tav?.phase === 'play' || !document.getElementById('error-screen').classList.contains('hidden'), null, { timeout: 900000 });
clearInterval(ticker);
const st = await page.evaluate(() => {
  const s = window.__tav;
  if (s.phase !== 'play') return { error: document.getElementById('error-text').textContent };
  return { ...s.world.stats, buildings: s.world.stats.buildings.total, toast: document.getElementById('toast').textContent.slice(0, 160) };
});
console.log(`${((Date.now() - t0) / 1000).toFixed(0)} 秒`, st);

// 名所の発見などの通知は写さない
await page.addStyleTag({ content: '#toast { display: none !important; }' });
for (const v of views) {
  await page.evaluate((v) => {
    const s = window.__tav;
    if (v.lm) {
      const lm = s.world.landmarks.find((l) => l.id === v.lm);
      const a = lm.approach;
      const h = Math.atan2(lm.x - a.x, -(lm.z - a.z) || 1e-9) + (v.turn || 0);
      const x = a.x - Math.sin(h) * (v.back || 0), z = a.z + Math.cos(h) * (v.back || 0);
      s.bike.place(x, z, h, s.world.heightAt(x, z));
    } else if (v.street) {
      // 通りの名前で: その通りの途中に、通りに沿って置く
      const road = s.world.parsed.roads.filter((r) => r.name === v.street).sort((a, b) => b.pts.length - a.pts.length)[0];
      const i = Math.min(road.pts.length - 2, Math.floor(road.pts.length * (v.at ?? 0.5)));
      const [x, z] = road.pts[i], [x2, z2] = road.pts[i + 1];
      s.bike.place(x, z, Math.atan2(x2 - x, -(z2 - z)) + (v.turn || 0), s.world.heightAt(x, z));
    } else if (v.x != null) {
      // snap: 近くの走れる道に移す
      const p = v.snap ? s.world.roadnet.nearestRideablePoint(v.x, v.z) : v;
      s.bike.place(p.x, p.z, v.heading || 0, s.world.heightAt(p.x, p.z));
    }
    if (v.look) {
      // 指定した点の方を向く
      const b = s.bike;
      b.place(b.x, b.z, Math.atan2(v.look[0] - b.x, -(v.look[1] - b.z)), b.y);
    }
    s.rig.mode = v.camera || 'chase';
    s.rig.initialized = false;
    window.__tavSimulate(v.sim || 0.3, v.ctl || {});
    document.getElementById('toast').classList.remove('show');
  }, v);
  // 近くの区画の高解像度の航空写真が届くのを待つ
  for (let i = 0; i < (v.wait || 40); i++) {
    await page.waitForTimeout(1000);
    const pending = await page.evaluate(() => {
      const w = window.__tav.world;
      const o = w.real?.ortho;
      const tiles = w.stream ? [...w.stream.tiles.values()].filter((t) => t.state === 'queued' || t.state === 'loading').length : 0;
      return (o ? o.chunks.filter((c) => c.want > c.level).length + o.active : 0) + tiles;
    });
    if (pending === 0 && i > 5) break;
  }
  if (v.cam) {
    // カメラを指定の位置・向きに固定して撮る（ゲームの更新を止め、描画と航空写真の読み込みだけ続ける）
    await page.evaluate((cam) => {
      const s = window.__tav;
      s.phase = 'shot';
      const c = window.__tavDebug.camera;
      c.position.set(...cam.pos);
      c.lookAt(...cam.look);
    }, v.cam);
    for (let i = 0; i < 25; i++) {
      await page.waitForTimeout(1000);
      const pending = await page.evaluate(() => window.__tav.world.real.ortho.chunks.filter((c) => c.want > c.level).length + window.__tav.world.real.ortho.active);
      if (pending === 0 && i > 5) break;
    }
  }
  await page.waitForTimeout(600);
  const info = await page.evaluate(() => {
    const o = window.__tav.world.real?.ortho;
    const lv = [0, 0, 0, 0];
    for (const c of o?.chunks || []) lv[c.level]++;
    const st = window.__tav.world.stream;
    const tiles = st ? `、タイル ${st.readyCount} 枚（建物 ${st.totals.buildings}・三角形 ${st.totals.triangles}）` : '';
    return `y=${window.__tav.bike.y.toFixed(1)}、航空写真の解像度別の区画数 ${lv.join('/')}・失敗 ${o?.failures}${tiles}`;
  });
  await page.screenshot({ path: join(out, `${v.name}.jpg`), type: 'jpeg', quality: 85, timeout: 240000 });
  console.log(`  ${v.name}: 自転車の高さ ${info}`);
  if (v.cam) await page.evaluate(() => (window.__tav.phase = 'play'));
}
await browser.close();
if (errors.length) console.log('エラー:\n' + errors.join('\n'));
process.exit(errors.length ? 1 : 0);
