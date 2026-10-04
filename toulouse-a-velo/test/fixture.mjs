// テスト用の合成データ（本物の OSM ではない）。
// 開発環境から Overpass / IGN に接続できないときでも、読み込み〜描画〜操作の流れを検証するために使う。
// 実在の位置関係をおおまかに真似ている: 西にガロンヌ川、ポン・ヌフ、その東にメス通り、キャピトル広場など。
import { crc32, deflateSync } from 'node:zlib';
import { LocalProjection, bboxAround } from '../src/geo.js';
import { AREA_PRESETS } from '../src/config.js';

export function makeFixture(presetId = 'light', { split = 3 } = {}) {
  const preset = AREA_PRESETS[presetId];
  const bbox = bboxAround(preset.lat, preset.lon, preset.radius);
  const proj = new LocalProjection((bbox.s + bbox.n) / 2, (bbox.w + bbox.e) / 2);
  const elements = [];
  const nodeByKey = new Map();
  let nextId = 1;
  const node = (x, z, tags) => {
    const key = `${Math.round(x * 100)},${Math.round(z * 100)}`;
    if (!tags && nodeByKey.has(key)) return nodeByKey.get(key);
    const [lat, lon] = proj.unproject(x, z);
    const id = nextId++;
    elements.push({ type: 'node', id, lat, lon, ...(tags ? { tags } : {}) });
    if (!tags) nodeByKey.set(key, id);
    return id;
  };
  const way = (pts, tags, close = false) => {
    const ids = pts.map(([x, z]) => node(x, z));
    if (close) ids.push(ids[0]);
    const id = nextId++;
    elements.push({ type: 'way', id, nodes: ids, ...(tags ? { tags } : {}) });
    return id;
  };
  const rect = (x0, z0, x1, z1) => [[x0, z0], [x1, z0], [x1, z1], [x0, z1]];

  // ガロンヌ川（マルチポリゴン: 外周を 2 本の way に分割、島を 1 つ）
  const riverA = way([[-560, -900], [-400, -900], [-395, 0], [-405, 900]]);
  const riverB = way([[-405, 900], [-570, 900], [-565, 0], [-560, -900]]);
  const island = way(rect(-505, -320, -455, -220), null, true);
  elements.push({
    type: 'relation', id: nextId++,
    members: [{ type: 'way', ref: riverA, role: 'outer' }, { type: 'way', ref: riverB, role: 'outer' }, { type: 'way', ref: island, role: 'inner' }],
    tags: { type: 'multipolygon', natural: 'water', water: 'river', name: 'La Garonne' },
  });
  // ブリエンヌ運河
  way(rect(-380, -690, 200, -672), { natural: 'water', water: 'canal', name: 'Canal de Brienne' }, true);

  // 通りの格子（右岸）
  const xs = [], zs = [];
  const ext = preset.radius - 70;
  for (let x = -330; x <= ext; x += 90) xs.push(x);
  for (let z = -630; z <= ext; z += 90) zs.push(z);
  xs.forEach((x, i) => {
    const pts = zs.map((z) => [x, z]);
    way(pts, { highway: i === 4 ? 'pedestrian' : 'residential', name: i === 4 ? "Rue d'Alsace-Lorraine" : `Rue Test ${i}` });
  });
  zs.forEach((z, j) => {
    const pts = xs.map((x) => [x, z]);
    const tags = z === 450 ? { highway: 'primary', name: 'Rue de Metz', lanes: '2' } : { highway: 'residential', name: `Rue Horizontale ${j}` };
    way(pts, tags);
  });
  // ポン・ヌフ（橋）と左岸の河岸道路
  way([[-640, 450], [-330, 450]], { highway: 'primary', bridge: 'yes', layer: '1', name: 'Pont Neuf' });
  // 橋の歩道が別の way として並んでいる（実際の OSM によくある形）
  for (const dz of [-8.5, 8.5]) way([[-640, 450 + dz], [-330, 450 + dz]], { highway: 'footway', footway: 'sidewalk', bridge: 'yes', layer: '1' });
  way([[-640, -650], [-640, 450], [-640, 650]], { highway: 'secondary', name: 'Quai de Tounis Test' });
  // 右岸の河岸の歩道
  way([[-380, -600], [-380, 600]], { highway: 'footway', name: 'Quai de la Daurade' });

  // 広場・公園・駐車場
  way(rect(120, -90, 210, 0), { highway: 'pedestrian', area: 'yes', name: 'Place du Capitole' }, true);
  way(rect(-390, -120, -335, -40), { highway: 'pedestrian', area: 'yes', name: 'Place Saint-Pierre' }, true);
  way(rect(213, -87, 297, -3), { leisure: 'park', name: 'Square Charles de Gaulle' }, true);
  way([[213, -45], [297, -45]], { highway: 'footway' });
  way(rect(393, 93, 477, 177), { amenity: 'parking' }, true);
  way([[480, -630], [480, 630]], { railway: 'tram' });
  way([[-330, 270], [570, 270]].map(([x, z]) => [x, z + 4]), { natural: 'tree_row' });
  for (let x = -300; x < 500; x += 40) node(x, -626, { natural: 'tree' });

  // 建物
  const buildings = [];
  const special = new Map([
    ['30,-90', { name: 'Capitole de Toulouse', building: 'townhall', height: '21' }],
    ['-60,-540', { name: 'Basilique Saint-Sernin', building: 'church' }],
    ['-240,-90', { name: 'Église des Jacobins', building: 'church', height: '28' }],
  ]);
  const skip = new Set(['120,-90', '210,-90', '390,90']);
  let k = 0;
  for (let i = 0; i + 1 < xs.length; i++) {
    for (let j = 0; j + 1 < zs.length; j++) {
      const x0 = xs[i] + 6, x1 = xs[i + 1] - 6, z0 = zs[j] + 6, z1 = zs[j + 1] - 6;
      const key = `${xs[i]},${zs[j]}`;
      if (skip.has(key)) continue;
      if (special.has(key)) {
        const tags = special.get(key);
        const id = way(rect(x0, z0, x1, z1), tags, true);
        buildings.push({ id, ring: rect(x0, z0, x1, z1), h: 18, flat: true });
        if (tags.name === 'Basilique Saint-Sernin') {
          // 鐘楼（building:part）
          way(rect(-25, -505, -5, -485), { 'building:part': 'yes', height: '64', 'roof:shape': 'pyramidal', 'roof:height': '12' }, true);
          way(rect(x0, z0, x1, z1), { 'building:part': 'yes', height: '22', 'roof:shape': 'gabled' }, true);
        }
        continue;
      }
      // split×split に分割した建物（中央は中庭、隣と接する）
      const w = (x1 - x0) / split, d = (z1 - z0) / split;
      for (let a = 0; a < split; a++) {
        for (let b = 0; b < split; b++) {
          if (split === 3 && a === 1 && b === 1) continue; // 中庭
          const bx0 = x0 + a * w, bz0 = z0 + b * d;
          // 一直線上の余分な頂点を入れて単純化をテスト
          const ring = [[bx0, bz0], [bx0 + w / 2, bz0], [bx0 + w, bz0], [bx0 + w, bz0 + d], [bx0, bz0 + d]];
          const tags = { building: k % 7 === 0 ? 'apartments' : 'yes' };
          if (k % 3 === 0) tags.height = String(9 + (k % 5) * 3);
          else if (k % 3 === 1) tags['building:levels'] = String(2 + (k % 4));
          if (k % 11 === 0) tags['roof:shape'] = 'hipped';
          const id = way(ring, tags, true);
          buildings.push({ id, ring, h: 8 + ((k * 7) % 13) });
          k++;
        }
      }
    }
  }
  // 左岸の建物
  for (let z = -600; z < 400; z += 60) {
    way(rect(-690, z, -655, z + 50), { building: 'yes' }, true);
    buildings.push({ ring: rect(-690, z, -655, z + 50), h: 12, bdtopo: false });
  }
  // 名前付きのポイント
  node(-386, -80, { name: 'Basilique Notre-Dame de la Daurade', amenity: 'place_of_worship' });

  // IGN BD TOPO 風の GeoJSON（座標は [lat, lon] の順 = 軸順の判定をテストする）
  const features = buildings.filter((b, i) => b.bdtopo !== false && i % 2 === 0).map((b, i) => ({
    type: 'Feature',
    properties: { hauteur: b.h, nombre_d_etages: Math.max(1, Math.round(b.h / 3)) },
    geometry: {
      type: 'Polygon',
      coordinates: [[...b.ring, b.ring[0]].map(([x, z]) => {
        const [lat, lon] = proj.unproject(x, z);
        return [lat, lon];
      })],
    },
    id: `batiment.${i}`,
  }));
  return { bbox, proj, buildings, osm: { elements }, bdtopo: { type: 'FeatureCollection', features } };
}

// ---- 合成の LiDAR（表面・地形モデル）と航空写真 ----
// 地面は標高 140 m（川は 132 m）、建物は地面 + 高さ（4 棟に 1 棟は切妻屋根）、ポン・ヌフの橋面は 141 m、
// 並木の位置に樹冠。WMS の GetMap の URL（BBOX・WIDTH・HEIGHT・LAYERS）に合わせて BIL（float32）を返す。
const RIVER = (x) => x > -560 && x < -400;
export function fakeTerrain(x, z) {
  return RIVER(x) ? 132 : 140;
}
export function fakeIgnRaster(fx, url) {
  const q = new URL(url).searchParams;
  const layer = q.get('LAYERS') || '';
  if (/ORTHO/i.test(layer)) return { contentType: 'image/png', body: fakePhoto() };
  const [s, w, n, e] = q.get('BBOX').split(',').map(Number);
  const W = +q.get('WIDTH'), H = +q.get('HEIGHT');
  const xs = new Float64Array(W), zs = new Float64Array(H);
  for (let c = 0; c < W; c++) xs[c] = fx.proj.project((s + n) / 2, w + ((c + 0.5) * (e - w)) / W)[0];
  for (let r = 0; r < H; r++) zs[r] = fx.proj.project(n - ((r + 0.5) * (n - s)) / H, (w + e) / 2)[1];
  const out = new Float32Array(W * H);
  for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) out[r * W + c] = fakeTerrain(xs[c], zs[r]);
  if (/MNS/i.test(layer)) {
    const cols = (a, b) => [...xs.keys()].filter((c) => xs[c] >= a && xs[c] <= b);
    const rows = (a, b) => [...zs.keys()].filter((r) => zs[r] >= a && zs[r] <= b);
    fx.buildings.forEach((bd, k) => {
      const x0 = Math.min(...bd.ring.map((p) => p[0])), x1 = Math.max(...bd.ring.map((p) => p[0]));
      const z0 = Math.min(...bd.ring.map((p) => p[1])), z1 = Math.max(...bd.ring.map((p) => p[1]));
      const zc = (z0 + z1) / 2;
      for (const r of rows(z0, z1)) {
        const gable = !bd.flat && k % 4 === 0 ? 3 * (1 - Math.abs(zs[r] - zc) / ((z1 - z0) / 2)) : 0;
        for (const c of cols(x0, x1)) out[r * W + c] = 140 + bd.h + gable;
      }
    });
    for (const r of rows(441, 459)) for (const c of cols(-640, -330)) out[r * W + c] = Math.max(out[r * W + c], 141);
    for (let tx = -300; tx < 500; tx += 40) {
      for (const r of rows(-631, -621)) {
        for (const c of cols(tx - 5, tx + 5)) {
          const d = Math.hypot(xs[c] - tx, zs[r] + 626);
          if (d < 4) out[r * W + c] = Math.max(out[r * W + c], 150 - d * 1.2);
        }
      }
    }
  }
  return { contentType: 'application/octet-stream', body: Buffer.from(out.buffer) };
}

// 航空写真の代わり: 16×16 の市松模様の PNG
let photo = null;
function fakePhoto() {
  if (photo) return photo;
  const size = 16, raw = Buffer.alloc(size * (size * 3 + 1));
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const v = (x + y) % 2 ? 150 : 110;
      raw.set([v, v - 10, v - 30], y * (size * 3 + 1) + 1 + x * 3);
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4), crc = Buffer.alloc(4), td = Buffer.concat([Buffer.from(type), data]);
    len.writeUInt32BE(data.length);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  photo = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
  return photo;
}
