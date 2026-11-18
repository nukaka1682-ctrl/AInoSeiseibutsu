// node test/probes/oddities.mjs 名前 緯度 経度 [半径 m=150]
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url));
const [name, lat, lon, r = 150] = process.argv.slice(2);
const code = `(() => { const ARGS = ${JSON.stringify({ lat: +lat, lon: +lon, r: +r })}; return (\n${readFileSync(join(here, 'oddities.js'), 'utf8')}\n); })()`;
execFileSync('sh', [join(here, '..', 'cmd.sh'), JSON.stringify([{ name: 'warm-' + name, at: [+lat, +lon], camera: 'drone', wait: 30 }, { name, eval: code }])], { encoding: 'utf8' });
const d = JSON.parse(readFileSync(join(here, '..', 'output', `${name}.json`), 'utf8'));
if (d.error) console.log(d.error);
else {
  console.log('小物', JSON.stringify(d.counts));
  console.log('浮いた・沈んだ小物', d.float.length); for (const f of d.float.slice(0, 15)) console.log('  ', f.join(' '));
  console.log('建物の中の木', d.trunkIn.length); for (const f of d.trunkIn.slice(0, 10)) console.log('  ', f.join(' '));
  console.log('細い建物', d.thinBld.length); for (const f of d.thinBld.slice(0, 10)) console.log('  ', f.join(' '));
}
