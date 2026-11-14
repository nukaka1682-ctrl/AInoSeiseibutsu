#!/usr/bin/env node
// メトロの線路の本物の線形を OpenStreetMap（ODbL。route=subway の路線と railway=subway の線）から取り、
// 線ごとの中心線にして public/data/toulouse-metro-tracks.json に保存する（小さいので Git に入れる）。
// 地上・高架の区間の高さは IGN BD TOPO の線路（troncon_de_voie_ferree の nature='Métro'。3 次元の点。Licence Ouverte）から。
//
//   NODE_USE_ENV_PROXY=1 node scripts/metro-tracks.mjs                       # Overpass と IGN から取る
//   node scripts/metro-tracks.mjs --from overpass.json --bd bdtopo.json       # 保存した答えから作る
//
// 線ごとに lines.<線>: [[緯度, 経度, 種類, 標高], ...]（約 4 m ごと。起点 → 終点の順。A 線は Basso Cambo → Balma-Gramont、
// B 線は Borderouge → Ramonville）。
// - 中心線: 2 つの向きの路線（上りと下り）の線路の真ん中。OSM の折れ線は地下では 50 m ごとほどの点なので、
//   点を通る Catmull-Rom 曲線にしてから軽くならす
// - 種類: 't' トンネル（tunnel=yes）、'c' 覆いのある所（covered=yes。掘割のふた・橋の覆い）、'b' 橋・高架（bridge）、'o' 地上
// - 標高: 線路の面の標高（m、NGF）。BD TOPO の線路が 12 m 以内にある所だけ（地下は null）
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const BBOX = '43.52,1.33,43.67,1.52';
const ENDPOINTS = ['https://overpass-api.de/api/interpreter', 'https://maps.mail.ru/osm/tools/overpass/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
const QUERY = `[out:json][timeout:90];(way["railway"="subway"](${BBOX});relation["route"="subway"](${BBOX}););out body geom;`;
const BD_URL = 'https://data.geopf.fr/wfs/ows?SERVICE=WFS&VERSION=2.0.0&REQUEST=GetFeature&TYPENAMES=BDTOPO_V3:troncon_de_voie_ferree&OUTPUTFORMAT=application/json&COUNT=2000&SRSNAME=EPSG:4326'
  + `&CQL_FILTER=${encodeURIComponent("nature='Métro' AND BBOX(geometrie,1.33,43.52,1.52,43.67,'EPSG:4326')")}`;
// 路線の起点（OSM の from）。線の向きをそろえる
const FROM = { A: 'Basso Cambo', B: 'Borderouge' };
const STEP = 4;

const args = process.argv.slice(2);
const opt = (k) => (args.includes(k) ? args[args.indexOf(k) + 1] : null);

async function fetchOverpass() {
  for (const url of ENDPOINTS) {
    for (let k = 0; k < 2; k++) {
      try {
        const r = await fetch(url, { method: 'POST', body: new URLSearchParams({ data: QUERY }), signal: AbortSignal.timeout(150000) });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = await r.json();
        if (Array.isArray(j.elements) && j.elements.length) return j;
      } catch (e) {
        console.warn(`${url}: ${e.message}`);
      }
    }
  }
  throw new Error('Overpass に接続できません');
}

// 緯度経度 → m（トゥールーズのあたりの平面。線の中の計算だけに使う）
const LAT0 = 43.6, KX = 111320 * Math.cos((LAT0 * Math.PI) / 180), KZ = 110950;
const toM = (lat, lon) => [(lon - 1.44) * KX, (lat - LAT0) * KZ];
const toLL = (x, z) => [LAT0 + z / KZ, 1.44 + x / KX];
const d2 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

const kindOf = (t = {}) => (t.tunnel && t.tunnel !== 'no' ? 't' : t.bridge && t.bridge !== 'no' ? 'b' : t.covered === 'yes' ? 'c' : 'o');

// 路線の線（メンバーの順）をつないで 1 本の折れ線 [{ p: [x, z], k: 種類（この点から次の点までの区間） }]
function chain(rel, ways) {
  const segs = rel.members.filter((m) => m.type === 'way' && m.geometry?.length > 1).map((m) => ({
    pts: m.geometry.map((g) => toM(g.lat, g.lon)),
    k: kindOf(ways.get(m.ref)?.tags),
  }));
  const out = [];
  segs.forEach((s, i) => {
    let pts = s.pts;
    const last = out.length ? out[out.length - 1].p : null;
    if (last) {
      if (d2(last, pts[pts.length - 1]) < d2(last, pts[0])) pts = [...pts].reverse();
    } else if (segs[1]) {
      const n = segs[1].pts, near = (p) => Math.min(d2(p, n[0]), d2(p, n[n.length - 1]));
      if (near(pts[0]) < near(pts[pts.length - 1])) pts = [...pts].reverse();
    }
    pts.forEach((p, j) => {
      if (j === 0 && last && d2(last, p) < 0.5) {
        out[out.length - 1].k = s.k;
        return;
      }
      out.push({ p, k: s.k });
    });
    void i;
  });
  return out;
}

// 折れ線の上で点にいちばん近い所 { d, p, i, t }
function nearest(line, p) {
  let best = { d: Infinity };
  for (let i = 0; i + 1 < line.length; i++) {
    const a = line[i].p, b = line[i + 1].p, dx = b[0] - a[0], dz = b[1] - a[1], l2 = dx * dx + dz * dz || 1;
    const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / l2));
    const q = [a[0] + dx * t, a[1] + dz * t], d = d2(p, q);
    if (d < best.d) best = { d, p: q, i, t };
  }
  return best;
}

// 点を通る Catmull-Rom 曲線（centripetal）を step m ごとに。区間の種類は元の区間のもの
function spline(line, step) {
  const out = [];
  const P = (i) => line[Math.max(0, Math.min(line.length - 1, i))].p;
  for (let i = 0; i + 1 < line.length; i++) {
    const p0 = P(i - 1), p1 = P(i), p2 = P(i + 1), p3 = P(i + 2), L = d2(p1, p2);
    if (L < 1e-6) continue;
    const t0 = 0, t1 = t0 + Math.sqrt(d2(p0, p1)) || 1e-3, t2 = t1 + Math.sqrt(L), t3 = t2 + (Math.sqrt(d2(p2, p3)) || 1e-3);
    const n = Math.max(1, Math.round(L / step));
    for (let k = 0; k < n; k++) {
      const t = t1 + ((t2 - t1) * k) / n;
      const lerp = (a, b, ta, tb) => (tb - ta < 1e-9 ? a : [a[0] + ((b[0] - a[0]) * (t - ta)) / (tb - ta), a[1] + ((b[1] - a[1]) * (t - ta)) / (tb - ta)]);
      const a1 = lerp(p0, p1, t0, t1), a2 = lerp(p1, p2, t1, t2), a3 = lerp(p2, p3, t2, t3);
      const b1 = lerp(a1, a2, t0, t2), b2 = lerp(a2, a3, t1, t3);
      out.push({ p: lerp(b1, b2, t1, t2), k: line[i].k });
    }
  }
  out.push({ p: line[line.length - 1].p, k: line[line.length - 2].k });
  return out;
}

// 等間隔に取り直す
function resample(line, step) {
  const out = [{ ...line[0] }];
  let acc = 0;
  for (let i = 0; i + 1 < line.length; i++) {
    const a = line[i].p, b = line[i + 1].p, L = d2(a, b);
    let u = step - acc;
    while (u <= L) {
      out.push({ p: [a[0] + ((b[0] - a[0]) * u) / L, a[1] + ((b[1] - a[1]) * u) / L], k: line[i].k });
      u += step;
    }
    acc = (acc + L) % step;
  }
  return out;
}

function smooth(line, half, passes) {
  let cur = line.map((q) => q.p);
  for (let pass = 0; pass < passes; pass++) {
    cur = cur.map((p, i) => {
      const h = Math.min(half, i, cur.length - 1 - i);
      if (!h) return p;
      let x = 0, z = 0;
      for (let j = i - h; j <= i + h; j++) {
        x += cur[j][0];
        z += cur[j][1];
      }
      return [x / (2 * h + 1), z / (2 * h + 1)];
    });
  }
  return line.map((q, i) => ({ p: cur[i], k: q.k }));
}

const osm = opt('--from') ? JSON.parse(await readFile(opt('--from'), 'utf8')) : await fetchOverpass();
const bd = opt('--bd') ? JSON.parse(await readFile(opt('--bd'), 'utf8')) : await (await fetch(BD_URL, { signal: AbortSignal.timeout(120000) })).json();
const ways = new Map(osm.elements.filter((e) => e.type === 'way').map((e) => [e.id, e]));
const rels = osm.elements.filter((e) => e.type === 'relation' && e.tags?.route === 'subway');
// BD TOPO の線路（営業中）の 3 次元の区間
const bdSegs = [];
for (const f of bd.features || []) {
  if (f.properties.etat_de_l_objet !== 'En service') continue;
  const lines = f.geometry.type === 'MultiLineString' ? f.geometry.coordinates : [f.geometry.coordinates];
  for (const c of lines) for (let i = 0; i + 1 < c.length; i++) bdSegs.push([[...toM(c[i][1], c[i][0]), c[i][2]], [...toM(c[i + 1][1], c[i + 1][0]), c[i + 1][2]]]);
}
function altAt(p) {
  let best = 12, alt = null;
  for (const [a, b] of bdSegs) {
    const dx = b[0] - a[0], dz = b[1] - a[1], l2 = dx * dx + dz * dz || 1;
    const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / l2));
    const d = Math.hypot(p[0] - a[0] - dx * t, p[1] - a[1] - dz * t);
    if (d < best) [best, alt] = [d, a[2] + (b[2] - a[2]) * t];
  }
  return alt;
}

const lines = {};
for (const line of Object.keys(FROM)) {
  const mine = rels.filter((r) => r.tags.ref === line);
  const fwdRel = mine.find((r) => r.tags.from === FROM[line]), backRel = mine.find((r) => r !== fwdRel);
  if (!fwdRel || !backRel) throw new Error(`${line} 線の路線が OSM に見つかりません`);
  const fwd = chain(fwdRel, ways), back = chain(backRel, ways).reverse();
  // 逆向きの路線の種類は区間の後ろの点に付いているので、1 つずらす
  for (let i = 0; i + 1 < back.length; i++) back[i].k = back[i + 1].k;
  const a = resample(spline(fwd, STEP), STEP), b = resample(spline(back, STEP), STEP);
  // 中心線: 向こうの線路のいちばん近い所との真ん中（30 m より遠ければ、こちらの線路だけ）
  const mid = a.map((q) => {
    const n = nearest(b, q.p);
    if (n.d > 30) return q;
    return { p: [(q.p[0] + n.p[0]) / 2, (q.p[1] + n.p[1]) / 2], k: q.k };
  });
  const sm = resample(smooth(mid, 4, 3), STEP);
  lines[line] = sm.map((q) => {
    const [lat, lon] = toLL(q.p[0], q.p[1]);
    const alt = q.k === 't' ? null : altAt(q.p);
    return [Math.round(lat * 1e6) / 1e6, Math.round(lon * 1e6) / 1e6, q.k, alt == null ? null : Math.round(alt * 10) / 10];
  });
  const len = (sm.length - 1) * STEP;
  const runs = [];
  for (const q of lines[line]) {
    if (runs.length && runs[runs.length - 1][0] === q[2]) runs[runs.length - 1][1] += STEP;
    else runs.push([q[2], STEP]);
  }
  console.log(`${line} 線: ${(len / 1000).toFixed(2)} km、${lines[line].length} 点。区間: ${runs.map(([k, l]) => `${k}${l}`).join(' ')}`);
}

const out = {
  meta: {
    source: 'OpenStreetMap contributors (ODbL 1.0)・IGN BD TOPO (Licence Ouverte 2.0)',
    fetchedAt: (osm.osm3s?.timestamp_osm_base || new Date().toISOString()).slice(0, 19) + 'Z',
    step: STEP,
  },
  lines,
};
const file = join(root, 'public', 'data', 'toulouse-metro-tracks.json');
await writeFile(file, JSON.stringify(out));
console.log(`保存: ${file}（${(JSON.stringify(out).length / 1024).toFixed(0)} KB）`);
