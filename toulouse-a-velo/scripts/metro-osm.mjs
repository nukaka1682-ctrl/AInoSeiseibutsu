#!/usr/bin/env node
// メトロの駅の中と出入口を OpenStreetMap（ODbL。屋内の地図）から取り、駅ごとに整理して public/data/toulouse-metro-osm.json に保存する。
//
//   NODE_USE_ENV_PROXY=1 node scripts/metro-osm.mjs              # Overpass から取る
//   node scripts/metro-osm.mjs --from overpass.json              # 保存した Overpass の答え（out geom の JSON）から作る
//
// 駅ごとに（駅の印から 170 m 以内）:
// - platforms: メトロのホーム（railway=platform・public_transport=platform。参照番号 4xxxx は A 線、5xxxx は B 線）の形と階
// - steps: 階段・エスカレーター（conveying）の線と、つなぐ 2 つの階（level="-1;0" など）・上りの向き（incline）
// - elevators: エレベーター（つなぐ階）
// - entrances: 出入口（railway=subway_entrance）の位置と階
// - paths: 地下・屋内の通路（footway・corridor）の線と階
// - areas: 屋内の部屋・広間（indoor=room・area・corridor・yes）の形と階
// 座標は [緯度, 経度]（7 桁）。階は数（"-0.5" もある）
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stationList } from '../src/metro/network.js';
import { STATION_FACTS, stationBouches } from '../src/metro/osmentrances.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const BBOX = '43.54,1.37,43.65,1.50';
const R = 170; // 駅の印から集める範囲（m）
const ENDPOINTS = ['https://overpass-api.de/api/interpreter', 'https://maps.mail.ru/osm/tools/overpass/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
const QUERY = `[out:json][timeout:180];(
node["railway"="subway_entrance"](${BBOX});
way["railway"="platform"](${BBOX});
way["public_transport"="platform"](${BBOX});
node["railway"="station"](${BBOX});
way["highway"~"^(footway|steps|corridor|elevator)$"]["tunnel"](${BBOX});
way["highway"~"^(footway|steps|corridor)$"]["level"~"^-"](${BBOX});
way["highway"~"^(footway|steps|corridor)$"]["layer"~"^-"](${BBOX});
way["highway"="steps"]["level"~";"](${BBOX});
way["indoor"](${BBOX});
node["highway"="elevator"](${BBOX});
way["conveying"](${BBOX});
);out geom;`;

async function fetchOverpass() {
  for (const url of ENDPOINTS) {
    try {
      const r = await fetch(url, { method: 'POST', body: new URLSearchParams({ data: QUERY }), signal: AbortSignal.timeout(240000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      if (Array.isArray(j.elements)) return j;
    } catch (e) {
      console.warn(`${url}: ${e.message}`);
    }
  }
  throw new Error('Overpass に接続できません');
}

const r7 = (v) => Math.round(v * 1e7) / 1e7;
const pt = (p) => [r7(p.lat), r7(p.lon)];
const dist = (a, b) => Math.hypot((a[0] - b[0]) * 111200, (a[1] - b[1]) * 80500);
// "0;-1" → [-1, 0]（小さい順）。数でなければ空
function levels(v) {
  if (v == null) return [];
  return [...new Set(String(v).split(';').map((s) => parseFloat(s)).filter((x) => Number.isFinite(x)))].sort((a, b) => a - b);
}
const closed = (g) => g.length > 3 && g[0].lat === g[g.length - 1].lat && g[0].lon === g[g.length - 1].lon;
const centroid = (g) => [g.reduce((a, p) => a + p.lat, 0) / g.length, g.reduce((a, p) => a + p.lon, 0) / g.length];
const norm = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z]/g, '');

const args = process.argv.slice(2);
const from = args.includes('--from') ? args[args.indexOf('--from') + 1] : null;
const osm = from ? JSON.parse(await readFile(from, 'utf8')) : await fetchOverpass();
const els = osm.elements;

// 駅の印（OSM）と、ゲームの駅の対応（名前が似ていて近いもの。なければゲームの位置）
const osmStations = els.filter((e) => e.type === 'node' && e.tags?.railway === 'station' && e.tags.station === 'subway');
const out = {};
for (const s of stationList()) {
  let best = null;
  for (const o of osmStations) {
    const d = dist([o.lat, o.lon], [s.lat, s.lon]);
    const n1 = norm(o.tags.name || ''), n2 = norm(s.bd);
    const named = n1.includes(n2.slice(0, 6)) || n2.includes(n1.slice(0, 6));
    if (d < 250 && (named || d < 60) && (!best || d < best.d)) best = { d, o };
  }
  const c = best ? [best.o.lat, best.o.lon] : [s.lat, s.lon];
  const st = { name: s.name, bd: s.bd, osm: best ? best.o.tags.name : null, c: [r7(c[0]), r7(c[1])], platforms: [], steps: [], elevators: [], entrances: [], paths: [], areas: [] };
  for (const e of els) {
    const t = e.tags || {};
    if (e.type === 'node') {
      const p = [e.lat, e.lon];
      if (dist(p, c) > R) continue;
      if (t.railway === 'subway_entrance') {
        st.entrances.push({ p: pt(e), levels: levels(t.level), elevator: t.highway === 'elevator', wheelchair: t.wheelchair || null, name: t.name || null, id: e.id });
      } else if (t.highway === 'elevator') st.elevators.push({ p: pt(e), levels: levels(t.level), id: e.id });
      continue;
    }
    const g = e.geometry || [];
    if (!g.length) continue;
    if (dist(centroid(g), c) > R && !g.some((q) => dist([q.lat, q.lon], c) < R)) continue;
    const lv = levels(t.level);
    const metroRef = /^[45]\d{4}$/.test(t.ref || '');
    if ((t.railway === 'platform' || t.public_transport === 'platform') && closed(g)) {
      // メトロのホーム: 参照番号か、地下・空中の階と「Quai」の名前
      if (metroRef || (lv.length === 1 && lv[0] !== 0 && /^Quai/.test(t.name || ''))) {
        st.platforms.push({ line: metroRef ? (t.ref[0] === '4' ? 'A' : 'B') : null, level: lv[0] ?? null, ref: t.ref || null, name: t.name || null, poly: g.map(pt) });
      }
      continue;
    }
    if (t.highway === 'steps') {
      st.steps.push({ levels: lv, conveying: t.conveying || null, incline: t.incline || null, pts: g.map(pt), width: parseFloat(t.width) || null, tunnel: t.tunnel || null, indoor: t.indoor || null, id: e.id });
      continue;
    }
    if (t.highway === 'elevator') {
      st.elevators.push({ p: (() => { const q = centroid(g); return [r7(q[0]), r7(q[1])]; })(), levels: lv, id: e.id });
      continue;
    }
    if (t.highway === 'footway' || t.highway === 'corridor') {
      if (lv.length !== 1 && !t.tunnel) continue;
      st.paths.push({ level: lv.length === 1 ? lv[0] : null, pts: g.map(pt), tunnel: t.tunnel || null, indoor: t.indoor || null, id: e.id });
      continue;
    }
    if (t.indoor && closed(g) && lv.length >= 1) {
      st.areas.push({ levels: lv, kind: t.indoor, conveying: t.conveying || null, poly: g.map(pt), id: e.id });
    }
  }
  out[s.id] = st;
}
// 出入口の形（地上の階段・エスカレーターから。LiDAR の吹き抜けがあればその形）
const lidar = JSON.parse(await readFile(join(root, 'public', 'data', 'toulouse-metro.json'), 'utf8')).entrances;
for (const [id, st] of Object.entries(out)) {
  st.bouches = STATION_FACTS[id]?.hall === 'aerial' ? [] : stationBouches(st, lidar, STATION_FACTS[id] || {});
}
const file = join(root, 'public', 'data', 'toulouse-metro-osm.json');
const meta = { source: 'OpenStreetMap contributors (ODbL 1.0)', fetchedAt: osm.osm3s?.timestamp_osm_base || null, radius: R };
await writeFile(file, JSON.stringify({ meta, stations: out }));
const sum = (k) => Object.values(out).reduce((a, s) => a + s[k].length, 0);
console.log(`${file}: 駅 ${Object.keys(out).length}、ホーム ${sum('platforms')}、階段 ${sum('steps')}、出入口 ${sum('entrances')}、通路 ${sum('paths')}、部屋 ${sum('areas')}`);
for (const [id, s] of Object.entries(out)) {
  if (!s.osm || !s.platforms.length) console.warn(`  ${id}: OSM の駅 ${s.osm || 'なし'}、ホーム ${s.platforms.length}`);
  const k = (kind) => s.bouches.filter((b) => b.kind === kind).length;
  console.log(`  ${id.padEnd(26)} 出入口 ${s.entrances.length}: 吹き抜け ${k('metro')}（LiDAR ${s.bouches.filter((b) => b.src === 'osm+lidar').length}）・建物 ${k('door')}・エレベーター ${k('elevator')}`);
}
