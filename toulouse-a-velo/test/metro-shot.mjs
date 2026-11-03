// メトロのゲームを本物の地図データで開いて、いろいろな場所を撮影する（test/output/metro-*.png）。
//   npm run build && node test/metro-shot.mjs [駅の id] [はじめる場所: train | platform | street]
// 同梱データ（npm run fetch-data -- toulouse）が要る。CHROMIUM_PATH でブラウザを指定できる
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { preview } from 'vite';
import { chromium } from 'playwright';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'test', 'output');
await mkdir(out, { recursive: true });
const station = process.argv[2] || 'capitole';
const start = process.argv[3] || 'platform';
const shots = (process.argv[4] || 'all').split(',');
const server = await preview({ root, preview: { port: 4181, strictPort: true }, logLevel: 'warn' });
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
const t0 = Date.now();
await page.goto(`http://localhost:4181/metro.html?autostart=1&station=${station}&start=${start}${process.env.CAM ? `&cam=${process.env.CAM}` : ''}`);
await page.waitForFunction(() => window.__metro?.phase === 'play' || !document.getElementById('error-screen').classList.contains('hidden'), null, { timeout: 600000 });
console.log(`読み込み ${((Date.now() - t0) / 1000).toFixed(0)} 秒`);
const err = await page.evaluate(() => document.getElementById('error-text').textContent);
if (err) console.log('エラー画面:', err);
const shot = async (name) => {
  if (process.env.CLEAN) await page.evaluate(() => document.getElementById('toast').classList.remove('show'));
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  await page.screenshot({ path: join(out, `metro-${station}-${name}.png`) });
  const info = await page.evaluate(() => ({ place: window.__metroApi.placeKind(), y: window.__metro && window.__metroDebug.walker.y.toFixed(2), hud: document.getElementById('hud-place').innerText }));
  console.log(name, JSON.stringify(info));
};
const sim = (s, ctl) => page.evaluate(([s, ctl]) => window.__metroSimulate(s, ctl), [s, ctl]);
const look = (yaw, pitch = 0) => page.evaluate(([y, p]) => {
  window.__metro.viewYaw = y;
  window.__metro.viewPitch = p;
}, [yaw, pitch]);
await shot('start');
if (process.env.EVAL) {
  console.log(await page.evaluate(process.env.EVAL));
  await shot('eval');
}
if (shots.includes('all') || shots.includes('tps')) {
  await page.evaluate(() => window.__metroApi.toggleCam());
  await sim(0.5, { fwd: 0, side: 0 });
  await shot('tps');
  await page.evaluate(() => window.__metroApi.toggleCam());
}
// 歩く: ホーム → 改札階 → 通路 → 地上（間取りから道筋を作って、そこへ向かって歩かせる）
if (shots.includes('all') || shots.includes('walk')) {
  const plan = await page.evaluate(() => {
    const st = window.__metro.station, rec = window.__metro.stations.get(st.id), p = rec.plan;
    const stair = p.stairs.find((s) => s.kind === 'stairs' && s.side === 1 && s.line === st.lines[0]);
    const f = stair.frame;
    const c = p.corridors[0];
    return {
      // 階段の下の端の手前（ホーム）→ 階段の上 → 改札 → コンコース → 通路の入口 → 通路 → 扉 → 地上
      pts: [
        [...f.at(stair.s0 + (stair.len + 1.6) * stair.dirS, (3.15 + stair.t0 * Math.sign(stair.t0) - 0.3) / 2 * stair.side), 'platform-passage'],
        [...f.at(stair.s0 + (stair.len + 0.7) * stair.dirS, (stair.t0 + stair.t1) / 2), 'platform-bottom'],
        [...f.at(stair.s0 + (stair.len - 0.5) * stair.dirS, (stair.t0 + stair.t1) / 2), 'stairs-low'],
        [...f.at(stair.s0 - 0.6 * stair.dirS, (stair.t0 + stair.t1) / 2), 'hall-top'],
        [...f.at(stair.s0 - 0.6 * stair.dirS, 0.46), 'wing'],
        [...f.at(p.hall.lines[0].c0 * stair.dirS + 1.2 * stair.dirS, 0.46), 'gate-in'],
        [...f.at(p.hall.lines[0].c0 * stair.dirS - 1.5 * stair.dirS, 0.46), 'concourse'],
        ...c.pts.slice().reverse().map((q, i) => [...q, `corr${i}`]),
      ],
      pit: c.door.e,
    };
  });
  const walkTo = async (x, z, max = 40) => {
    for (let k = 0; k < max; k++) {
      const d = await page.evaluate(([x, z]) => {
        const w = window.__metroDebug.walker;
        const dx = x - w.x, dz = z - w.z, d = Math.hypot(dx, dz);
        window.__metro.viewYaw = Math.atan2(dx, -dz);
        return d;
      }, [x, z]);
      if (process.env.VERBOSE_WALK) console.log("  d", d.toFixed(2));
      if (d < 0.6) return true;
      await sim(Math.min(1, d / 1.45), { fwd: 1, side: 0, run: false });
    }
    return false;
  };
  for (const [x, z, name] of plan.pts) {
    const ok = await walkTo(x, z);
    await shot(`walk-${name}${ok ? '' : '-STUCK'}`);
  }
  // 扉を出て階段を上り、地上へ
  const e = plan.pit;
  const up = await page.evaluate((e) => {
    const fx = Math.cos(e.ang) * e.down, fz = Math.sin(e.ang) * e.down;
    return [e.x - fx * (e.len / 2 + 3), e.z - fz * (e.len / 2 + 3)];
  }, e);
  const ok = await walkTo(up[0], up[1], 60);
  await sim(0.3, { fwd: 0, side: 0 });
  await shot(`walk-street${ok ? '' : '-STUCK'}`);
  await look(await page.evaluate(() => window.__metro.viewYaw + Math.PI), -0.25);
  await sim(0.3, { fwd: 0, side: 0 });
  await shot('walk-street-back');
}
// 電車に乗る: 走る → 着いて扉が開く → 降りる → ホームから電車を見る
if (shots.includes('ride')) {
  for (const [sec, name] of [[3, 'ride-tunnel'], [6, 'ride-tunnel-front']]) {
    await sim(sec, { fwd: 0, side: 0 });
    if (name === 'ride-tunnel-front') await look(await page.evaluate(() => { const t = window.__metro.playerTrain; const p = t.cars[0].pose; return Math.atan2(p.fx, -p.fz); }), -0.05);
    await shot(name);
  }
  // 着くまで
  for (let k = 0; k < 60; k++) {
    const st = await page.evaluate(() => window.__metro.playerTrain?.state + ':' + (window.__metro.playerTrain?.doorOpen ?? 0).toFixed(2));
    if (st.startsWith('dwell') && st.endsWith('1.00')) break;
    await sim(1, { fwd: 0, side: 0 });
  }
  await look(await page.evaluate(() => { const t = window.__metro.playerTrain; const p = t.cars[0].pose; return Math.atan2(-p.fz, p.fx) + 0; }), 0);
  await shot('ride-doors-open');
  // 扉から降りる（進む向きの右）
  const yaw = await page.evaluate(() => { const t = window.__metro.playerTrain, p = t.cars[0].pose; return Math.atan2(-p.fz, -p.fx); });
  const door = await page.evaluate(() => {
    const t = window.__metro.playerTrain, w = window.__metroDebug.walker;
    const c = t.cars.find((q) => q.nav === w.region.layer), p = c.pose;
    // いちばん近い扉（局所 x）
    const lx = (w.x - p.x) * p.fx + (w.z - p.z) * p.fz;
    const dx = [-4.1, 0, 4.1].reduce((a, b) => (Math.abs(b - lx) < Math.abs(a - lx) ? b : a));
    const rx = -p.fz, rz = p.fx;
    return [[p.x + p.fx * dx, p.z + p.fz * dx], [p.x + p.fx * dx + rx * 2.2, p.z + p.fz * dx + rz * 2.2]];
  });
  void yaw;
  for (const [x, z] of door) {
    for (let k = 0; k < 20; k++) {
      const d = await page.evaluate(([x, z]) => { const w = window.__metroDebug.walker; const dx = x - w.x, dz = z - w.z; window.__metro.viewYaw = Math.atan2(dx, -dz); return Math.hypot(dx, dz); }, [x, z]);
      if (d < 0.3) break;
      await sim(Math.min(0.5, d / 1.45), { fwd: 1, side: 0 });
    }
  }
  await shot('ride-out');
  // 振り返って電車を見る（三人称）
  await page.evaluate(() => window.__metroApi.toggleCam());
  await look(await page.evaluate(() => window.__metro.viewYaw + Math.PI * 0.8), -0.1);
  await sim(0.5, { fwd: 0, side: 0 });
  await shot('ride-train-tps');
  await sim(12, { fwd: 0, side: 0 });
  await shot('ride-train-leaving');
}
// ホームで電車が着くのを待つ（来る方を見る）
if (shots.includes('arrive')) {
  const yaw = await page.evaluate(() => {
    const st = window.__metro.station, L = window.__metro.stations.get(st.id).plan.lines[0], f = L.frame;
    const w = window.__metroDebug.walker, [x, z] = f.at(-14, 4.0);
    w.place(x, L.yp, z);
    window.__metro.camInit = false;
    // 電車の来る方（-s）を少し斜めに
    return Math.atan2(-f.ax * 0.95 + f.nx * -0.3, f.az * 0.95 - f.nz * -0.3);
  });
  await look(yaw, -0.02);
  for (let k = 0; k < 70; k++) {
    const d = await page.evaluate(() => {
      const st = window.__metro.station;
      const t = window.__metro.trains.find((q) => q.dir === 1 && q.stops[0] === st);
      return t ? Math.abs(st.S[t.line] - t.S) : -1;
    });
    if (d >= 0 && d < 75) break;
    await sim(1, { fwd: 0, side: 0 });
  }
  await sim(0.5, { fwd: 0, side: 0 });
  await shot('arrive-1');
  await sim(2.5, { fwd: 0, side: 0 });
  await shot('arrive-2');
}
// 説明の写真（docs/）: 自由なカメラで
if (shots.includes('docs')) {
  const views = await page.evaluate(() => {
    const st = window.__metro.station, rec = window.__metro.stations.get(st.id), p = rec.plan, L = p.lines[0], f = L.frame;
    const fP = p.rects[0].frame, g = p.gates.find((q) => q.side === 1 && q.line === L.line);
    const out = {};
    out.platform = { pos: [...f.at(-22, 6.6)].flatMap((v, i) => (i === 0 ? [v, L.yp + 1.65] : [v])), look: [...f.at(8, 4.2)].flatMap((v, i) => (i === 0 ? [v, L.yp + 1.9] : [v])) };
    out.gates = { pos: [...fP.at(-p.hall.Cs + 1.2, -2.5)].flatMap((v, i) => (i === 0 ? [v, p.ym + 1.65] : [v])), look: [...g.frame.at(g.s + 3, 0.5)].flatMap((v, i) => (i === 0 ? [v, p.ym + 1.0] : [v])) };
    return out;
  });
  for (const [name, v] of Object.entries(views)) {
    await page.evaluate((v) => {
      window.__metro.freeCam = v;
      window.__metroDebug.walker.root.visible = false;
    }, v);
    await sim(0.1, { fwd: 0, side: 0 });
    await page.evaluate(() => {
      window.__metroDebug.walker.root.position.y = -1000;
    });
    await shot(`docs-${name}`);
  }
  await page.evaluate(() => {
    window.__metro.freeCam = null;
  });
}
console.log('エラー', errors.slice(0, 10));
await browser.close();
await server.close();
