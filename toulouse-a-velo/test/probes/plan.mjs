// node test/probes/plan.mjs 名前 緯度 経度 [半径 m=80] [px=1200] [names]
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url));
const [name, lat, lon, r = 80, px = 1200, names] = process.argv.slice(2);
const code = `(() => { const ARGS = ${JSON.stringify({ lat: +lat, lon: +lon, r: +r, px: +px, names: !!names })}; return (\n${readFileSync(join(here, 'plan.js'), 'utf8')}\n); })()`;
console.log(execFileSync('sh', [join(here, '..', 'cmd.sh'), JSON.stringify([{ name, eval: code }])], { encoding: 'utf8' }));
