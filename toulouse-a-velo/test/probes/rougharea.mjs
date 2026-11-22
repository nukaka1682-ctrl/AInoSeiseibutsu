// node test/probes/rougharea.mjs 名前 緯度 経度 [半径 m=300]  → その範囲の道の大きな折れ・横の傾き
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url));
const [name, lat, lon, r = 300] = process.argv.slice(2);
const src = readFileSync(join(here, 'rough.js'), 'utf8').replace('for (const r of W.parsed.roads) {', `const [CX, CZ] = P.project(${+lat}, ${+lon});\n  for (const r of W.parsed.roads) {\n    if (!r.pts.some(([x, z]) => Math.hypot(x - CX, z - CZ) < ${+r})) continue;`);
execFileSync('sh', [join(here, '..', 'cmd.sh'), JSON.stringify([{ name: 'warm-' + name, at: [+lat, +lon], camera: 'drone', wait: 30 }, { name, eval: src }])], { encoding: 'utf8' });
const q = JSON.parse(readFileSync(join(here, '..', 'output', `${name}.json`), 'utf8'));
if (q.error) console.log(q.error);
console.log('km', q.km, '平均の折れ', q.meanKink, '平均の傾き', q.meanTilt, '大きな折れ', q.bigK, '大きな傾き', q.bigT);
for (const k of q.kinks.slice(0, 12)) console.log('  折れ', k.join(' '));
for (const k of q.tilts.slice(0, 12)) console.log('  傾き', k.join(' '));
