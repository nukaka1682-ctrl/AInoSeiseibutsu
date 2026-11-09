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
await page.goto(`http://localhost:4181/metro.html?autostart=1&station=${station}&start=${start}${process.env.CAM ? `&cam=${process.env.CAM}` : ''}${process.env.PHOTO ? `&photo=${process.env.PHOTO}` : ''}`);
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
// 歩く: ホーム → 階段 → 改札階 → 改札 → 出入口（ホールの中の吹き抜けか通路）→ 地上。歩ける所を幅優先で探した道筋をたどる
if (shots.includes('all') || shots.includes('walk')) {
  const plan = await page.evaluate(() => {
    const st = window.__metro.station, rec = window.__metro.stations.get(st.id), p = rec.plan, nav = window.__metroDebug.nav;
    const osm = p.layout === 'osm'; // OpenStreetMap の間取り（osmplan.js）
    let start, yStart;
    if (osm) {
      const b = p.blocks.find((q) => q.toPlatform && q.lanes.some((l) => l.kind === 'stairs')) || p.blocks.find((q) => q.toPlatform);
      start = b ? b.frame.at(b.len + 1.2, 0) : p.lines[0].frame.at(0, p.lines[0].island ? 0 : 5);
      yStart = b ? b.y1 : p.lines[0].yp;
    } else {
      const stair = p.stairs.find((s) => s.kind === 'stairs' && s.side === 1 && s.line === st.lines[0]);
      start = stair.frame.at(stair.s0 + (stair.len + 1.2) * stair.dirS, (stair.t0 + stair.t1) / 2);
      yStart = stair.y1;
    }
    const open = p.pits.filter((e) => !p.closed.includes(e));
    const e = osm ? open[0] : p.direct[0] || open[0];
    const fx = Math.cos(e.ang) * e.down, fz = Math.sin(e.ang) * e.down;
    const goal = [e.x - fx * (e.len / 2 + 2.5), e.z - fz * (e.len / 2 + 2.5)];
    const outside = (x, z) => p.pits.every((q) => {
      const dx = Math.cos(q.ang) * q.down, dz = Math.sin(q.ang) * q.down, u = (x - q.x) * dx + (z - q.z) * dz, v = -(x - q.x) * dz + (z - q.z) * dx;
      return Math.abs(u) > q.len / 2 + 1.5 || Math.abs(v) > q.wid / 2 + 1.5;
    });
    // 幅優先（0.25 m の格子、高さは 1.2 m ごとに分ける）。壁から 0.26 m 離れた所だけ（体が通れる）
    const step = 0.25, key = (x, z, y) => `${Math.round(x / step)},${Math.round(z / step)},${Math.round(y / 1.2)}`;
    // 改札の通路（0.8 m）は格子では通りにくいので、道を探すあいだだけ改札の壁をなくす（あとで通路の真ん中を通る点を足す）
    const gateWalls = [];
    for (const L of nav.layers) for (const w of L.walls) if (w.gate && w.active) gateWalls.push(w);
    for (const w of gateWalls) w.active = false;
    const f0 = nav.floorAt(start[0], start[1], yStart);
    const q = [[start[0], start[1], f0.y, null, f0.region?.kind || 'surface']];
    const seen = new Map([[key(start[0], start[1], f0.y), 0]]);
    let found = -1;
    for (let i = 0; i < q.length && i < 400000; i++) {
      const [x, z, y, , kind] = q[i];
      // 地上に出て、どの出入口の吹き抜けからも 1.5 m 離れた所（いちばん近い出口）
      if (kind === 'surface' && (osm ? outside(x, z) : Math.hypot(x - goal[0], z - goal[1]) < 0.8)) {
        found = i;
        break;
      }
      for (const [dx, dz] of [[step, 0], [-step, 0], [0, step], [0, -step]]) {
        const r = nav.step(x, z, y, x + dx, z + dz);
        if (!r) continue;
        const k = key(x + dx, z + dz, r.y);
        if (seen.has(k)) continue;
        seen.set(k, q.length);
        if (nav.resolve(x + dx, z + dz, 0.26, r.y).hit) continue; // 歩く人の半径 0.24 m より少し広く
        q.push([x + dx, z + dz, r.y, i, r.region?.kind || 'surface']);
      }
    }
    if (found < 0) {
      for (const w of gateWalls) w.active = true;
      return { error: `道が見つからない（${q.length} 点）` };
    }
    const nearGate = (x, z, y) => Math.abs(y - p.ym) < 1 && p.gates.some((g) => {
      const [s, t] = g.frame.local(x, z);
      return Math.abs(s - g.s) < 1.4 && t > g.t0 - 0.3 && t < g.t1 + 0.3;
    });
    // 改札の通路の真ん中（OSM の間取りは osmplan.js の osmGateLanes と同じ並び）
    const laneCenters = (g) => {
      if (!osm) return Array.from({ length: 6 }, (_, k) => -3.025 + 0.4 + k * 1.05);
      const n = g.lanes, s0 = (g.t0 + g.t1) / 2 - (n * 1.05 + 0.25) / 2 + 0.25;
      return Array.from({ length: n }, (_, k) => s0 + k * 1.05 + 0.4);
    };
    const path = [];
    for (let i = found; i != null; i = q[i][3]) path.push(q[i]);
    path.reverse();
    // 点 a から b へまっすぐ歩けるか（0.2 m ごとに、段差と壁と体の幅を調べる。改札の壁はまだない）
    const clear = (a, b) => {
      let [x, z, y] = a;
      const n = Math.max(1, Math.ceil(Math.hypot(b[0] - x, b[1] - z) / 0.2));
      for (let k = 1; k <= n; k++) {
        const nx = a[0] + ((b[0] - a[0]) * k) / n, nz = a[1] + ((b[1] - a[1]) * k) / n;
        const r = nav.step(x, z, y, nx, nz);
        if (!r || nav.resolve(nx, nz, 0.26, r.y).hit) return false;
        [x, z, y] = [nx, nz, r.y];
      }
      return true;
    };
    // 歩く点: まっすぐ行けなくなる手前の点（曲がり角でも壁の端を切らない）と、場所の種類が変わる所（撮影）。3 m より離さない。
    // 改札を通る所は通路の真ん中を
    const keep = new Set();
    let anchor = 0;
    for (let i = 1; i < path.length; i++) {
      const change = path[i][4] !== path[i - 1][4];
      if (change || i === path.length - 1 || i - anchor >= 12 || (i + 1 < path.length && !clear(path[anchor], path[i + 1]))) {
        keep.add(i);
        anchor = i;
      }
    }
    for (const w of gateWalls) w.active = true;
    const pts = [];
    let last = null;
    path.forEach(([x, z, y, , kind], i) => {
      const change = last && kind !== last;
      if (i > 0) {
        const [px, pz] = path[i - 1];
        for (const g of p.gates) {
          if (Math.abs(y - p.ym) > 1) continue; // 改札は改札の階だけ（ほかの階で同じ線を横切っても通らない）
          const [s0, t0] = g.frame.local(px, pz), [s1, t1] = g.frame.local(x, z);
          if ((s0 - g.s) * (s1 - g.s) > 0 || t1 < g.t0 - 0.3 || t1 > g.t1 + 0.3 || (!osm && Math.abs(t1) > 8.2)) continue;
          const tc = laneCenters(g).reduce((a, b) => (Math.abs(b - t1) < Math.abs(a - t1) ? b : a));
          const dir = Math.sign(s1 - s0);
          pts.push([...g.frame.at(g.s - dir * 1.2, tc), null], [...g.frame.at(g.s + dir * 1.2, tc), 'gate']);
        }
      }
      if (keep.has(i) && !nearGate(x, z, y)) pts.push([x, z, change ? `${kind}-${i}` : null]);
      last = kind;
    });
    return { start, y: f0.y, pts };
  });
  if (plan.error) console.log(plan.error);
  else {
    await page.evaluate(([x, z, y]) => {
      const w = window.__metroDebug.walker;
      w.place(x, y, z);
      w.region = window.__metroDebug.nav.floorAt(x, z, y)?.region || null;
    }, [...plan.start, plan.y]);
    await shot('walk-0-platform');
    const walkTo = async (x, z, max = 30) => {
      for (let k = 0; k < max; k++) {
        const d = await page.evaluate(([x, z]) => {
          const w = window.__metroDebug.walker;
          const dx = x - w.x, dz = z - w.z, d = Math.hypot(dx, dz);
          window.__metro.viewYaw = Math.atan2(dx, -dz);
          return d;
        }, [x, z]);
        if (d < 0.35) return true;
        await sim(Math.min(1, d / 1.45), { fwd: 1, side: 0, run: false });
      }
      return false;
    };
    let n = 1;
    for (const [x, z, name] of plan.pts) {
      const ok = await walkTo(x, z);
      if (!ok) {
        console.log('STUCK', await page.evaluate(([x, z]) => {
          const w = window.__metroDebug.walker, st = window.__metro.station, p = window.__metro.stations.get(st.id).plan, f = p.frame;
          return JSON.stringify({ at: f.local(w.x, w.z).map((v) => v.toFixed(2)), y: w.y.toFixed(2), target: f.local(x, z).map((v) => v.toFixed(2)), kind: w.region?.kind || 'surface' });
        }, [x, z]));
        await shot(`walk-${n++}-STUCK`);
        break;
      }
      if (name) await shot(`walk-${n++}-${name}`);
    }
    await sim(0.3, { fwd: 0, side: 0 });
    await shot(`walk-${n++}-street`);
    await look(await page.evaluate(() => window.__metro.viewYaw + Math.PI), -0.25);
    await sim(0.3, { fwd: 0, side: 0 });
    await shot(`walk-${n++}-street-back`);
  }
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
    const g = p.gates.find((q) => q.line === L.line);
    const out = {};
    out.platform = { pos: [...f.at(-22, 6.6)].flatMap((v, i) => (i === 0 ? [v, L.yp + 1.65] : [v])), look: [...f.at(8, 4.2)].flatMap((v, i) => (i === 0 ? [v, L.yp + 1.9] : [v])) };
    out.gates = { pos: [...g.frame.at(g.s - g.side * 7, -3.5)].flatMap((v, i) => (i === 0 ? [v, p.ym + 1.65] : [v])), look: [...g.frame.at(g.s + g.side * 3, 0.5)].flatMap((v, i) => (i === 0 ? [v, p.ym + 1.0] : [v])) };
    const w = p.wells[0];
    out.well = { pos: [...w.frame.at(w.s0 - w.dirS * 3, -w.side * 2)].flatMap((v, i) => (i === 0 ? [v, p.ym + 1.7] : [v])), look: [...w.frame.at(w.s0 + w.dirS * 4, (w.t0 + w.t1) / 2)].flatMap((v, i) => (i === 0 ? [v, p.ym - 1.0] : [v])) };
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
