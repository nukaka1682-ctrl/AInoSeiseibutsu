// node test/probes/coverat.mjs 緯度,経度 …  → トゥールーズ全体のタイルの地面の覆いの種類（0 公道 1 敷地 2 芝 3 木）をまわり 40 m で数える
import { readFileSync } from 'node:fs';
import { areaFrame } from '../../src/world/assemble.js';
import { tileLayout, tileBounds } from '../../src/data/tiles.js';
import { decodeCover } from '../../src/data/cover.js';
const base = JSON.parse(readFileSync('public/data/toulouse.json', 'utf8'));
const { proj, rect } = areaFrame(base.bbox), layout = tileLayout(rect);
for (const a of process.argv.slice(2)) {
  const [lat, lon] = a.split(',').map(Number), [x, z] = proj.project(lat, lon);
  const i = Math.floor((x - layout.rect.minX) / layout.size), j = Math.floor((z - layout.rect.minZ) / layout.size);
  const t = JSON.parse(readFileSync(`public/data/toulouse-tiles/${i}_${j}.json`, 'utf8'));
  if (!t.cover) { console.log(a, 'タイル', i, j, '覆いなし'); continue; }
  const g = decodeCover(t.cover), b = tileBounds(layout, i, j), n = [0, 0, 0, 0, 0, 0];
  for (let dz = -40; dz <= 40; dz += 2) for (let dx = -40; dx <= 40; dx += 2) {
    const c = Math.floor(((x + dx - b.minX) / (b.maxX - b.minX)) * g.cols), r = Math.floor(((z + dz - b.minZ) / (b.maxZ - b.minZ)) * g.rows);
    if (c >= 0 && r >= 0 && c < g.cols && r < g.rows) n[g.data[r * g.cols + c]]++;
  }
  console.log(a, 'タイル', i, j, g.cols, 'x', g.rows, '公道/敷地/芝/木:', n.slice(0, 4).join(' / '));
}
