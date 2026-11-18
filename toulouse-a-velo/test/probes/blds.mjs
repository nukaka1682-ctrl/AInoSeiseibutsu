// node test/probes/blds.mjs 名前 緯度 経度 [半径 m=30]
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url));
const [name, lat, lon, r = 30] = process.argv.slice(2);
const code = `(() => { const ARGS = ${JSON.stringify({ lat: +lat, lon: +lon, r: +r })}; return (\n${readFileSync(join(here, 'blds.js'), 'utf8')}\n); })()`;
execFileSync('sh', [join(here, '..', 'cmd.sh'), JSON.stringify([{ name, eval: code }])], { encoding: 'utf8' });
const d = JSON.parse(readFileSync(join(here, '..', 'output', `${name}.json`), 'utf8'));
if (d.error) console.log(d.error);
else for (const b of d) console.log(JSON.stringify(b));
