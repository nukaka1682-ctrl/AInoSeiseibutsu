// node test/probes/things.mjs 名前 緯度 経度 [半径 m=15]
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url));
const [name, lat, lon, r = 15] = process.argv.slice(2);
const code = `(() => { const ARGS = ${JSON.stringify({ lat: +lat, lon: +lon, r: +r })}; return (\n${readFileSync(join(here, 'things.js'), 'utf8')}\n); })()`;
execFileSync('sh', [join(here, '..', 'cmd.sh'), JSON.stringify([{ name, eval: code }])], { encoding: 'utf8' });
const d = JSON.parse(readFileSync(join(here, '..', 'output', `${name}.json`), 'utf8'));
for (const [k, l] of Object.entries(d.furniture || {})) console.log(k.padEnd(14), l.length, JSON.stringify(l.slice(0, 8)));
for (const g of d.groups || []) console.log('  mesh', g.join(' '));
if (d.error) console.log(d.error);
