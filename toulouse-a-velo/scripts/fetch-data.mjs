#!/usr/bin/env node
// 地図データを事前にダウンロードして public/data/<preset>.json に保存する。
// 同梱しておくと、ゲーム起動時に Overpass API を待たずにすぐ遊べる。
//
//   npm run fetch-data              # 標準エリア（centre）
//   npm run fetch-data -- light     # 軽量エリア
//   npm run fetch-data -- all       # すべてのプリセット
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AREA_PRESETS, DEFAULT_AREA, DATA_VERSION } from '../src/config.js';
import { bboxAround } from '../src/geo.js';
import { fetchOverpass } from '../src/data/overpass.js';
import { fetchBdTopo } from '../src/data/bdtopo.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const arg = process.argv[2] || DEFAULT_AREA;
const ids = arg === 'all' ? Object.keys(AREA_PRESETS) : [arg];

for (const id of ids) {
  const preset = AREA_PRESETS[id];
  if (!preset) {
    console.error(`不明なエリア: ${id}（${Object.keys(AREA_PRESETS).join(', ')}）`);
    process.exit(1);
  }
  const bbox = bboxAround(preset.lat, preset.lon, preset.radius);
  console.log(`[${id}] bbox ${JSON.stringify(bbox)}`);

  const osm = await fetchOverpass(bbox, {
    headers: { 'User-Agent': 'toulouse-a-velo-data-fetch/0.1 (cycling game; OSM data bake script)' },
    onStatus: ({ host, bytes }) => process.stdout.write(`\r  OSM ${host}: ${(bytes / 1048576).toFixed(1)} MB   `),
  });
  console.log(`\n  OSM: ${osm.elements.length} 要素`);

  let bdtopo = [];
  try {
    bdtopo = await fetchBdTopo(bbox, { onStatus: ({ count }) => process.stdout.write(`\r  BD TOPO: ${count} 棟   `) });
    console.log('');
  } catch (err) {
    console.warn(`\n  BD TOPO を取得できませんでした（OSM の高さだけを使います）: ${err.message}`);
  }

  const out = join(root, 'public', 'data', `${id}.json`);
  await mkdir(dirname(out), { recursive: true });
  const json = JSON.stringify({ version: DATA_VERSION, bbox, fetchedAt: new Date().toISOString(), osm, bdtopo });
  await writeFile(out, json);
  console.log(`  保存: ${out} (${(json.length / 1048576).toFixed(1)} MB)`);
}
