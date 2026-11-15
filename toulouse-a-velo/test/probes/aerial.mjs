// 斜めの空撮の一覧を作って、開いたままのセッションに渡す:
//   node test/probes/aerial.mjs 名前,緯度,経度[,距離 m=35,高さ m=22,カメラのある方角（度。0=北の側から南を見る）=180,見る高さ=0] …
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const views = process.argv.slice(2).map((a) => {
  const [name, lat, lon, dist = 35, h = 22, brg = 180, ly = 0] = a.split(',').map((v, i) => (i ? Number(v) : v));
  const k = Math.cos((lat * Math.PI) / 180) * 111320, r = (brg * Math.PI) / 180;
  return { name, cam: { posLL: [lat + (Math.cos(r) * dist) / 111320, lon + (Math.sin(r) * dist) / k, h], lookLL: [lat, lon, ly] }, wait: 3 };
});
console.log(execFileSync('sh', [join(dirname(fileURLToPath(import.meta.url)), '..', 'cmd.sh'), JSON.stringify(views)], { encoding: 'utf8' }));
