#!/usr/bin/env node
// 地図データを事前にダウンロードして public/data/<preset>.json に保存する。
// 同梱しておくと、ゲーム起動時に地図サーバーを待たずにすぐ遊べる。
//
//   npm run fetch-data                    # 標準エリア（centre）。OSM を試し、だめなら IGN BD TOPO
//   npm run fetch-data -- light           # 軽量エリア
//   npm run fetch-data -- all             # すべてのプリセット
//   npm run fetch-data -- centre --ign    # IGN BD TOPO だけで作る
//
// npm run 経由では NODE_USE_ENV_PROXY=1 が付く（HTTPS_PROXY のある環境で Node の fetch をプロキシ経由にする）。
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AREA_PRESETS, DEFAULT_AREA } from '../src/config.js';
import { bboxAround } from '../src/geo.js';
import { fetchAreaData } from '../src/data/load.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const provider = args.includes('--ign') ? 'ign' : 'auto';
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
  const out = join(root, 'public', 'data', `${id}.json`);
  await mkdir(dirname(out), { recursive: true });
  const save = { ...data };
  delete save.fallbackReason;
  const json = JSON.stringify(save);
  await writeFile(out, json);
  console.log(`  保存: ${out} (${(json.length / 1048576).toFixed(1)} MB)`);
}
