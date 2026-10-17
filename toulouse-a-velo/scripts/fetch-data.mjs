#!/usr/bin/env node
// 地図データを事前にダウンロードして public/data/<preset>.json に保存する。
// 同梱しておくと、ゲーム起動時に地図サーバーを待たずにすぐ遊べる。
//
//   npm run fetch-data                    # 標準エリア（centre）。OSM を試し、だめなら IGN BD TOPO
//   npm run fetch-data -- light           # 軽量エリア
//   npm run fetch-data -- all             # すべてのプリセット
//   npm run fetch-data -- centre --ign    # IGN BD TOPO だけで作る
//   npm run fetch-data -- toulouse        # トゥールーズ全体（半径 5 km）: 道路などの基本データ（toulouse.json）と、
//                                         # 建物・塀・木・地面の覆いを 500 m のタイルに分けたファイル（toulouse-tiles/<i>_<j>.json）
//   npm run fetch-data -- toulouse --resume  # 途中で止まった取得の続き（今の形式で保存済みのタイルは取得し直さない）
//   npm run fetch-data -- all --terrain   # 地形（<preset>-terrain.bin）だけ作り直す（保存済みの <preset>.json を使う）
//
// どのプリセットも最後に地形（LiDAR HD の地形モデルの 5 m の格子・水面の高さ・橋の縦断面）を <preset>-terrain.bin に保存する
//
// 塀と木は、地籍（敷地の境界）と LiDAR HD の表面モデルから見つける（src/data/walls.js）。
// 地面の覆い（公道・敷地の中・芝生・木の下）は、さらに赤外線航空写真の植生指数を使う（src/data/cover.js）。
//
// npm run 経由では NODE_USE_ENV_PROXY=1 が付く（HTTPS_PROXY のある環境で Node の fetch をプロキシ経由にする）。
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AREA_PRESETS, DEFAULT_AREA } from '../src/config.js';
import { bboxAround } from '../src/geo.js';
import { fetchAreaData } from '../src/data/load.js';
import { boundsToBbox, fetchBaseData, featureTile, splitTileFeatures, tileBounds, tileLayout } from '../src/data/tiles.js';
import { fetchSiteFeatures, grow } from '../src/data/walls.js';
import { fetchWfsLayer } from '../src/data/bdtopo.js';
import { IGN_LAYERS } from '../src/data/ign.js';
import { areaFrame } from '../src/world/assemble.js';
import { DATA_VERSION } from '../src/config.js';
import { parseOsm } from '../src/world/parse.js';
import { bakeTerrain } from '../src/data/terrainbake.js';
import { DATUM, Terrain, encodeTerrain } from '../src/world/terrain.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const provider = args.includes('--ign') ? 'ign' : 'auto';
const resume = args.includes('--resume');
const terrainOnly = args.includes('--terrain');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const arg = args.find((a) => !a.startsWith('--')) || DEFAULT_AREA;
const ids = arg === 'all' ? Object.keys(AREA_PRESETS) : [arg];

for (const id of ids) {
  const preset = AREA_PRESETS[id];
  if (!preset) {
    console.error(`不明なエリア: ${id}（${Object.keys(AREA_PRESETS).join(', ')}）`);
    process.exit(1);
  }
  const bbox = bboxAround(preset.lat, preset.lon, preset.radius);
  console.log(`[${id}] bbox ${JSON.stringify(bbox)}`);
  if (terrainOnly) {
    await bakeTerrainFile(id, bbox);
    continue;
  }
  if (preset.stream) {
    await bakeStream(id, bbox);
    await bakeTerrainFile(id, bbox);
    continue;
  }
  let last = '';
  const data = await fetchAreaData(bbox, {
    provider,
    overpassOptions: {
      headers: { 'User-Agent': 'toulouse-a-velo-data-fetch/0.1 (cycling game; OSM data bake script)' },
      attempts: 4,
      deadlineMs: 10 * 60 * 1000,
    },
    onStatus: (t) => {
      const line = t.replace(/\n/g, ' / ');
      if (line !== last) process.stdout.write(`\r  ${line}`.padEnd(110));
      last = line;
    },
  });
  console.log(`\n  出典: ${data.provider}${data.fallbackReason ? `（OSM に接続できず IGN に切り替え: ${data.fallbackReason}）` : ''}`);
  console.log(`  要素: ${data.osm.elements.length.toLocaleString()} / IGN の建物の高さ: ${data.bdtopo.length.toLocaleString()}`);
  // 塀と木と地面の覆い（500 m ずつ）
  try {
    const site = await bakeSite(bbox);
    data.walls = site.walls;
    data.trees = site.trees;
    data.cover = site.cover;
    const kb = site.cover.reduce((s, c) => s + c.rle.length, 0) / 1024;
    console.log(`  塀 ${site.walls.length.toLocaleString()} か所、木 ${site.trees.length.toLocaleString()} 本、地面の覆い ${site.cover.length} ブロック（${kb.toFixed(0)} KB）`);
  } catch (err) {
    console.log(`  塀と木を見つけられませんでした: ${err.message}`);
  }
  const out = join(root, 'public', 'data', `${id}.json`);
  await mkdir(dirname(out), { recursive: true });
  const save = { ...data };
  delete save.fallbackReason;
  const json = JSON.stringify(save);
  await writeFile(out, json);
  console.log(`  保存: ${out} (${(json.length / 1048576).toFixed(1)} MB)`);
  await bakeTerrainFile(id, bbox);
}

// 地形のファイル（保存済みの地図データの水域と橋を使う）。最後に、確かめやすい場所の高さを表示する
async function bakeTerrainFile(id, bbox) {
  const base = JSON.parse(await readFile(join(root, 'public', 'data', `${id}.json`), 'utf8'));
  const { proj, rect } = areaFrame(bbox);
  const parsed = parseOsm(base.osm, proj, rect, []);
  let last = '';
  const t0 = Date.now();
  const data = await bakeTerrain({
    bbox, parsed, proj,
    onStatus: (t) => {
      if (t !== last) process.stdout.write(`\r  地形: ${t}`.padEnd(70));
      last = t;
    },
  });
  const buf = await encodeTerrain(data);
  const out = join(root, 'public', 'data', `${id}-terrain.bin`);
  await writeFile(out, buf);
  console.log(`\n  保存: ${out}（${(buf.length / 1048576).toFixed(2)} MB、${data.near.cols} × ${data.near.rows} 点、橋の縦断面 ${data.bridges.length}、${((Date.now() - t0) / 1000).toFixed(0)} 秒）`);
  // 確かめ: 標高（m）。トゥールーズ全体の座標（x = 東, z = 南）から緯度経度にして引く
  const t = new Terrain(data, proj);
  const T = areaFrame({ s: 43.5994, n: 43.5994, w: 1.4395, e: 1.4395 }).proj;
  const probes = [
    ['ポン・ヌフの右岸の端', 73, -22], ['ポン・ヌフの頂上（原点の近く）', -14, 0], ['ポン・ヌフの左岸の端', -142, 32], ['シャトー・ドーの角', -215, 40],
    ['共和国通り', -306, 95], ['キャピトル', 330, -560], ['ドラード港の低い河岸', 10, -110], ['ポン・ヌフの下の水面', -40, 0, 'w'],
    ['大ブルターニュ通り（平ら）', -2000, -300], ['パーパン', -3415, -960], ['バイヨンヌ通り（トゥシュの谷）', -4511, -994],
    ['栄光通りの上', 2155, -845], ['ペシュ・ダヴィッド', 605, 3941], ['ミディ運河（バヤール閘門の上）', 1150, -1300, 'w'], ['バザクルの下の水面', -700, -500, 'w'],
  ];
  for (const [name, x, z, w] of probes) {
    const [x2, z2] = proj.project(...T.unproject(x, z));
    const y = w ? t.waterLevel(x2, z2) : t.h(x2, z2);
    console.log(`    ${name}${w ? '（水面）' : ''}: ${(y + DATUM).toFixed(1)} m`);
  }
  const pn = data.bridges.find((b) => b.name === 'Pont Neuf');
  if (pn) console.log(`    ポン・ヌフの橋面（5 m ごと）: ${pn.y.filter((_, i) => i % 4 === 0).map((v) => v.toFixed(1)).join(' ')}`);
}

// 広いエリア: 基本データ（建物以外）と、建物をタイルに分けたファイル
async function bakeStream(id, bbox) {
  const base = await fetchBaseData(bbox, { onStatus: ({ count }) => process.stdout.write(`\r  基本データ: ${count.toLocaleString()} 件`.padEnd(60)) });
  const json = JSON.stringify(base);
  const out = join(root, 'public', 'data', `${id}.json`);
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, json);
  console.log(`\n  保存: ${out} (${(json.length / 1048576).toFixed(1)} MB、要素 ${base.osm.elements.length.toLocaleString()})`);

  // 建物: 1 km 四方ずつ取得して、500 m のタイルに振り分ける（同じ建物が 2 回来ても 1 回だけ）
  const { rect } = areaFrame(bbox);
  const layout = tileLayout(rect);
  const tiles = new Map();
  const seen = new Set();
  const blocks = [];
  const n = Math.ceil(layout.cols / 2), m = Math.ceil(layout.rows / 2);
  for (let j = 0; j < m; j++) {
    for (let i = 0; i < n; i++) {
      blocks.push({
        w: bbox.w + ((bbox.e - bbox.w) * i) / n, e: bbox.w + ((bbox.e - bbox.w) * (i + 1)) / n,
        n: bbox.n - ((bbox.n - bbox.s) * j) / m, s: bbox.n - ((bbox.n - bbox.s) * (j + 1)) / m,
      });
    }
  }
  let done = 0, count = 0;
  const worker = async () => {
    while (blocks.length) {
      const b = blocks.shift();
      const features = await fetchWfsLayer('batiment', b, { propertyNames: IGN_LAYERS.batiment, maxPages: 40 });
      for (const f of features) {
        const fid = f.id || JSON.stringify(f.geometry?.coordinates?.[0]?.[0]);
        if (seen.has(fid)) continue;
        seen.add(fid);
        const t = featureTile(f, layout, bbox);
        if (!t) continue;
        const key = `${t[0]}_${t[1]}`;
        if (!tiles.has(key)) tiles.set(key, []);
        tiles.get(key).push(f);
        count++;
      }
      process.stdout.write(`\r  建物: ${++done}/${n * m} ブロック、${count.toLocaleString()} 棟`.padEnd(60));
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  const dir = join(root, 'public', 'data', `${id}-tiles`);
  if (!resume) await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });

  // タイルごと: 隣のタイルの境近くの建物（ctx）と、塀・木・地面の覆い。
  // 通信が切れても（WMS・WFS はときどき失敗する）、間を空けて 5 回まで取得し直す
  const queue = [];
  for (let j = 0; j < layout.rows; j++) for (let i = 0; i < layout.cols; i++) queue.push([i, j]);
  let bytes = 0, coverBytes = 0, finished = 0, walls = 0, trees = 0, failed = 0, skipped = 0;
  const total = queue.length;
  const tileWorker = async () => {
    while (queue.length) {
      const [i, j] = queue.shift();
      const file = join(dir, `${i}_${j}.json`);
      if (resume) {
        const old = await readFile(file, 'utf8').then(JSON.parse).catch(() => null);
        if (old?.version === DATA_VERSION && old.cover) {
          skipped++;
          finished++;
          continue;
        }
      }
      const near = [];
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) near.push(...(tiles.get(`${i + di}_${j + dj}`) || []));
      const { own, ctx } = splitTileFeatures(near, layout, bbox, i, j);
      const tb = boundsToBbox(bbox, layout.rect, tileBounds(layout, i, j));
      let site = { walls: [], trees: [], cover: null };
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          site = await fetchSiteFeatures(tb, own.concat(ctx), { needCover: true });
          break;
        } catch (err) {
          if (attempt === 4) {
            failed++;
            console.log(`\n  タイル ${i}_${j}: 塀と木・地面の覆いを見つけられませんでした（${err.message}）`);
          } else await wait(5000 * (attempt + 1));
        }
      }
      walls += site.walls.length;
      trees += site.trees.length;
      const s = JSON.stringify({ version: DATA_VERSION, features: own, ctx, walls: site.walls, trees: site.trees, cover: site.cover });
      bytes += s.length;
      coverBytes += site.cover?.rle.length || 0;
      await writeFile(file, s);
      process.stdout.write(`\r  タイル: ${++finished}/${total}、塀 ${walls.toLocaleString()} か所、木 ${trees.toLocaleString()} 本`.padEnd(80));
    }
  };
  await Promise.all([tileWorker(), tileWorker(), tileWorker(), tileWorker()]);
  console.log(`\n  保存: ${dir}（${total - skipped} タイル、${(bytes / 1048576).toFixed(1)} MB、うち地面の覆い ${(coverBytes / 1048576).toFixed(1)} MB` +
    `${skipped ? `、保存済みで飛ばした ${skipped} タイル` : ''}${failed ? `、塀と木・覆いなし ${failed} タイル（--resume で取り直せる）` : ''}）`);
}

// 小さいエリア: 500 m ずつ、塀と木と地面の覆いを見つける（覆いはブロックの番号 i・j と一緒に入れる）
async function bakeSite(bbox) {
  const { rect } = areaFrame(bbox);
  const layout = tileLayout(rect);
  const out = { walls: [], trees: [], cover: [] };
  for (let j = 0; j < layout.rows; j++) {
    for (let i = 0; i < layout.cols; i++) {
      const tb = boundsToBbox(bbox, rect, tileBounds(layout, i, j));
      for (let attempt = 0; ; attempt++) {
        try {
          const buildings = await fetchWfsLayer('batiment', grow(tb, 30), { propertyNames: ['geometrie'] });
          const site = await fetchSiteFeatures(tb, buildings, { needCover: true });
          out.walls.push(...site.walls);
          out.trees.push(...site.trees);
          out.cover.push({ i, j, ...site.cover });
          break;
        } catch (err) {
          if (attempt === 4) throw err;
          await wait(5000 * (attempt + 1));
        }
      }
      process.stdout.write(`\r  塀と木・地面の覆い: ${j * layout.cols + i + 1}/${layout.cols * layout.rows}`.padEnd(60));
    }
  }
  process.stdout.write('\n');
  return out;
}
