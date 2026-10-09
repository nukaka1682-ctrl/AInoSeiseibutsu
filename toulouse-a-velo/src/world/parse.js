// OSM の生データ（Overpass JSON）を、ゲームで使う地物（ローカル座標）に変換する。
// three.js に依存しない（Node のテストから使える）。
import {
  Grid, centroid, clipRingToRect, closestOnSegment, hash01, pointInPolygon, pointInRing, ringBounds, signedArea, simplifyRing,
} from '../geo.js';

export const FLOOR_HEIGHT = 3.1;

export function parseLength(v) {
  if (v == null) return NaN;
  const s = String(v).replace(',', '.');
  const m = s.match(/-?\d+(\.\d+)?/);
  if (!m) return NaN;
  let n = parseFloat(m[0]);
  if (/ft|'/.test(s)) n *= 0.3048;
  return n;
}

// 閉じたリングの内部にある点（重心が外にある凹多角形にも対応）
export function interiorPoint(ring) {
  const c = centroid(ring);
  if (pointInRing(c[0], c[1], ring)) return c;
  const z = c[1];
  const xs = [];
  for (let i = 0, n = ring.length, j = n - 1; i < n; j = i++) {
    const a = ring[j], b = ring[i];
    if ((a[1] > z) !== (b[1] > z)) xs.push(a[0] + ((z - a[1]) / (b[1] - a[1])) * (b[0] - a[0]));
  }
  xs.sort((p, q) => p - q);
  let best = null, bestW = -1;
  for (let i = 0; i + 1 < xs.length; i += 2) {
    if (xs[i + 1] - xs[i] > bestW) {
      bestW = xs[i + 1] - xs[i];
      best = [(xs[i] + xs[i + 1]) / 2, z];
    }
  }
  return best || c;
}

// マルチポリゴンのメンバー way（ノード id 配列）をつないで閉じたリングにする
export function assembleRings(wayNodeLists) {
  const pool = wayNodeLists.filter((w) => w && w.length >= 2).map((w) => w.slice());
  const rings = [];
  while (pool.length) {
    let cur = pool.pop();
    let guard = 0;
    while (cur[0] !== cur[cur.length - 1] && guard++ < 10000) {
      const end = cur[cur.length - 1];
      let idx = -1, rev = false;
      for (let i = 0; i < pool.length; i++) {
        if (pool[i][0] === end) { idx = i; rev = false; break; }
        if (pool[i][pool[i].length - 1] === end) { idx = i; rev = true; break; }
      }
      if (idx < 0) break;
      const next = pool.splice(idx, 1)[0];
      if (rev) next.reverse();
      cur = cur.concat(next.slice(1));
    }
    if (cur.length >= 4 && cur[0] === cur[cur.length - 1]) rings.push(cur.slice(0, -1));
  }
  return rings;
}

const ROAD_DEFAULT_WIDTH = {
  motorway: 14, trunk: 12, primary: 10, secondary: 9, tertiary: 7.5,
  motorway_link: 6, trunk_link: 6, primary_link: 6, secondary_link: 6, tertiary_link: 6,
  unclassified: 6, residential: 6, road: 6, living_street: 5, service: 4,
  pedestrian: 6, footway: 2.5, path: 2, cycleway: 2.5, steps: 2.5, track: 3, bridleway: 2,
};
const SKIP_HIGHWAY = new Set(['proposed', 'construction', 'corridor', 'platform', 'bus_stop', 'elevator', 'raceway', 'abandoned', 'razed', 'services', 'rest_area']);

// 車道（歩道を描く道）
export const CAR_ROADS = new Set([
  'trunk', 'primary', 'secondary', 'tertiary', 'unclassified', 'residential', 'road',
  'trunk_link', 'primary_link', 'secondary_link', 'tertiary_link',
]);

function roadWidth(tags) {
  const hw = tags.highway;
  let w = parseLength(tags.width);
  if (!(w >= 1 && w <= 40)) {
    const lanes = parseLength(tags.lanes);
    if (lanes >= 1 && lanes <= 8 && CAR_ROADS.has(hw)) w = lanes * 3.2;
    else w = ROAD_DEFAULT_WIDTH[hw] ?? 4;
  }
  if (hw === 'service' && (tags.service === 'driveway' || tags.service === 'alley')) w = Math.min(w, 3.2);
  if (hw === 'footway' && tags.footway === 'sidewalk') w = Math.min(w, 2);
  return w;
}

function defaultLevels(tags, area, id) {
  const b = tags.building || tags['building:part'] || 'yes';
  const r = hash01(id, 7);
  switch (b) {
    case 'house': case 'detached': case 'semidetached_house': case 'terrace': case 'bungalow':
      return 2;
    case 'garage': case 'garages': case 'shed': case 'hut': case 'kiosk': case 'carport': case 'toilets': case 'cabin':
      return 1;
    case 'industrial': case 'warehouse': case 'retail': case 'supermarket': case 'service':
      return 2;
    case 'apartments': case 'residential': case 'office': case 'commercial': case 'hotel': case 'university': case 'college':
      return 4 + Math.floor(r * 3);
    default:
      if (area < 20) return 1;
      if (area < 60) return 2 + Math.floor(r * 2);
      return 3 + Math.floor(r * 3); // トゥールーズ旧市街は 3〜5 階建てが中心
  }
}

const CHURCH = new Set(['church', 'cathedral', 'chapel', 'basilica', 'religious', 'temple', 'monastery']);

export function buildingInfo(b) {
  const t = b.tags;
  const area = Math.abs(signedArea(b.outer));
  const kind = t.building || t['building:part'] || 'yes';
  const isChurch = CHURCH.has(kind) || t.amenity === 'place_of_worship';
  const osmHeight = parseLength(t.height);
  let levels = parseLength(t['building:levels']);
  const roofLevels = parseLength(t['roof:levels']);

  let wallTop, heightSource;
  let roofHeight = parseLength(t['roof:height']);
  let roofShape = t['roof:shape'];

  if (osmHeight > 0) {
    // OSM の height は屋根を含む全体の高さ
    heightSource = t['height:source'] === 'IGN' ? 'IGN' : 'OSM';
    wallTop = osmHeight;
  } else if (b.bdHeight > 0) {
    heightSource = 'IGN';
    wallTop = b.bdHeight; // BD TOPO の hauteur は軒（雨どい）までの高さ
  } else if (levels > 0) {
    heightSource = 'OSM（階数）';
    wallTop = levels * FLOOR_HEIGHT + (roofLevels > 0 ? roofLevels * 2.6 : 0);
  } else {
    heightSource = '推定';
    if (isChurch) wallTop = 14 + hash01(b.id, 3) * 6;
    else wallTop = defaultLevels(t, area, b.id) * FLOOR_HEIGHT + 0.6;
  }
  if (!(levels > 0)) levels = b.bdLevels > 0 ? b.bdLevels : Math.max(1, Math.round(wallTop / FLOOR_HEIGHT));

  if (kind === 'roof' || kind === 'carport') {
    // 屋根だけの構造物（キャノピーなど）
    return { area, kind, isChurch, height: Math.max(3, Math.min(wallTop, 6)), minHeight: Math.max(2.6, Math.min(wallTop, 6) - 0.5), roofShape: 'flat', roofHeight: 0, levels: 1, floorHeight: FLOOR_HEIGHT, heightSource, collide: false };
  }

  let minHeight = parseLength(t.min_height);
  if (!(minHeight >= 0)) {
    const ml = parseLength(t['building:min_level']);
    minHeight = ml > 0 ? ml * FLOOR_HEIGHT : 0;
  }

  if (!roofShape) roofShape = 'auto';
  if (!(roofHeight >= 0)) roofHeight = NaN;
  // OSM の高さは屋根込みなので、屋根の高さを引いて壁の高さにする
  let height = wallTop;
  if (osmHeight > 0 && roofHeight > 0 && roofHeight < osmHeight) height = osmHeight - roofHeight;
  if (minHeight >= height) minHeight = Math.max(0, height - 1);

  const floorHeight = Math.min(5, Math.max(2.6, (height - minHeight) / Math.max(1, levels)));
  return {
    area, kind, isChurch, height, minHeight, roofShape, roofHeight, levels, floorHeight, heightSource,
    collide: minHeight < 2.2,
  };
}

// 水面の低さ（depth、地面からの m）と種類。ガロンヌ川のような広い川（平均の幅 60 m 以上）は、実物の河岸の岸壁の高さに
// 合わせて約 10 m 下（橋のアーチが入る高さ）。平均の幅は 2 × 面積 / 周長。
// 川は何枚にも切れているので、最後に unifyWaterLevels で長い継ぎ目でつながった水の深さをそろえる
export function waterKind(tags, area, perimeter = 0) {
  const w = tags.water;
  if ((w === 'river' || tags.waterway === 'riverbank') && area > 20000) {
    const width = perimeter > 0 ? (2 * area) / perimeter : 0;
    return { depth: width > 60 ? 10 : 6, kind: 'river' };
  }
  if (w === 'canal' || w === 'lock' || area > 20000) return { depth: 2.2, kind: 'canal' };
  return { depth: 0.7, kind: 'pond' };
}

function greenKind(tags) {
  if (tags.leisure === 'pitch') return 'pitch';
  if (tags.landuse === 'cemetery') return 'cemetery';
  if (tags.landuse === 'forest' || tags.natural === 'wood' || tags.natural === 'scrub') return 'forest';
  if (tags.leisure || tags.landuse || tags.natural) return 'grass';
  return null;
}

/**
 * @param {object} osm Overpass JSON（compact 済み）
 * @param {import('../geo.js').LocalProjection} proj
 * @param {{minX:number,minZ:number,maxX:number,maxZ:number}} rect プレイエリア
 * @param {Array} bdtopo BD TOPO の建物（[lon,lat] リング + 高さ）
 */
export function parseOsm(osm, proj, rect, bdtopo = []) {
  const nodePos = new Map();
  const ways = new Map();
  const rels = new Map();
  const trees = [];
  const named = [];

  for (const el of osm.elements) {
    if (el.type === 'node') {
      const p = proj.project(el.lat, el.lon);
      nodePos.set(el.id, p);
      if (el.tags) {
        if (el.tags.natural === 'tree') trees.push(p);
        if (el.tags.name) named.push({ name: el.tags.name, tags: el.tags, x: p[0], z: p[1], pts: [p] });
      }
    } else if (el.type === 'way') {
      const prev = ways.get(el.id);
      if (!prev || (!prev.tags && el.tags)) ways.set(el.id, el);
    } else if (el.type === 'relation') {
      const prev = rels.get(el.id);
      if (!prev || (!prev.tags && el.tags)) rels.set(el.id, el);
    }
  }

  const coordsOf = (ids) => {
    const out = [];
    for (const id of ids) {
      const p = nodePos.get(id);
      if (p) out.push(p);
    }
    return out;
  };
  const isClosed = (w) => w.nodes && w.nodes.length >= 4 && w.nodes[0] === w.nodes[w.nodes.length - 1];

  // ポリゴン（way または multipolygon relation）を列挙
  const polygons = [];
  for (const w of ways.values()) {
    if (!w.tags || !isClosed(w)) continue;
    const outer = coordsOf(w.nodes.slice(0, -1));
    if (outer.length >= 3) polygons.push({ id: w.id, tags: w.tags, outer, holes: [] });
  }
  for (const r of rels.values()) {
    if (!r.tags || r.tags.type !== 'multipolygon') continue;
    const outerLists = [], innerLists = [];
    for (const m of r.members || []) {
      if (m.type !== 'way') continue;
      const w = ways.get(m.ref);
      if (!w || !w.nodes) continue;
      (m.role === 'inner' ? innerLists : outerLists).push(w.nodes);
    }
    const outers = assembleRings(outerLists).map(coordsOf).filter((r2) => r2.length >= 3);
    const inners = assembleRings(innerLists).map(coordsOf).filter((r2) => r2.length >= 3);
    outers.forEach((outer, i) => {
      const holes = inners.filter((h) => pointInRing(h[0][0], h[0][1], outer));
      polygons.push({ id: r.id * 10 + i + 1e12, tags: r.tags, outer, holes });
    });
  }

  // ---- 建物 ----
  const buildings = [];
  const parts = [];
  for (const p of polygons) {
    const t = p.tags;
    const isPart = t['building:part'] && t['building:part'] !== 'no';
    const isBuilding = t.building && t.building !== 'no';
    if (!isPart && !isBuilding) continue;
    if (t.location === 'underground' || parseLength(t.layer) < 0) continue;
    const outer = simplifyRing(p.outer, 0.2);
    if (outer.length < 3 || Math.abs(signedArea(outer)) < 2) continue;
    const b = { id: p.id, tags: t, outer, holes: p.holes.map((h) => simplifyRing(h, 0.2)).filter((h) => h.length >= 3), isPart };
    b.bounds = ringBounds(outer);
    b.inside = interiorPoint(outer);
    (isPart ? parts : buildings).push(b);
  }

  // building:part を持つ建物は、外形を描かずパーツを描く（当たり判定は外形で行う）
  const bGrid = new Grid(40);
  buildings.forEach((b, i) => bGrid.insertBounds(b.bounds.minX, b.bounds.minZ, b.bounds.maxX, b.bounds.maxZ, i));
  for (const part of parts) {
    const [x, z] = part.inside;
    bGrid.queryPoint(x, z, 0, (i) => {
      const b = buildings[i];
      if (!part.hasParent && pointInRing(x, z, b.outer)) {
        b.partArea = (b.partArea || 0) + Math.abs(signedArea(part.outer));
        part.hasParent = true;
      }
    });
  }
  // パーツが外形の半分以上を覆っていれば外形は描かない（Simple 3D Buildings の慣習）
  for (const b of buildings) if (b.partArea >= 0.5 * Math.abs(signedArea(b.outer))) b.hasParts = true;

  // BD TOPO の実測高さを OSM の建物に割り当てる
  if (bdtopo.length) assignBdHeights(buildings, bGrid, bdtopo, proj);
  // パーツにも親の BD TOPO 高さを引き継ぐ（パーツに高さタグが無い場合用）
  for (const part of parts) {
    const [x, z] = part.inside;
    bGrid.queryPoint(x, z, 0, (i) => {
      const b = buildings[i];
      if (part.bdHeight == null && b.bdHeight && pointInRing(x, z, b.outer)) part.bdHeight = b.bdHeight;
    });
  }

  for (const b of buildings.concat(parts)) {
    b.info = buildingInfo(b);
    if (b.tags.name) named.push({ name: b.tags.name, tags: b.tags, x: b.inside[0], z: b.inside[1], pts: b.outer, polygon: true, building: true });
  }

  // ---- 道路 ----
  const roads = [];
  const areas = [];
  const rails = [];
  const waterLines = [];
  for (const w of ways.values()) {
    const t = w.tags;
    if (!t || !w.nodes) continue;
    if (t.highway && !SKIP_HIGHWAY.has(t.highway)) {
      if (t.area === 'yes' && isClosed(w)) continue; // 広場はポリゴン側で処理
      if (t.highway === 'elevator') continue;
      const ids = [], pts = [];
      for (const id of w.nodes) {
        const p = nodePos.get(id);
        if (p) { ids.push(id); pts.push(p); }
      }
      if (pts.length < 2) continue;
      const tunnel = t.tunnel && t.tunnel !== 'no' && t.tunnel !== 'building_passage';
      const layer = parseLength(t.layer) || 0;
      roads.push({
        id: w.id,
        type: t.highway,
        name: t.name || '',
        width: roadWidth(t),
        pts,
        nodeIds: ids,
        bridge: !!(t.bridge && t.bridge !== 'no'),
        tunnel: !!tunnel,
        layer,
        oneway: t.oneway === 'yes' || t.oneway === '1',
        surface: t.surface || '',
        sidewalk: t.sidewalk || '',
      });
      if (t.name) named.push({ name: t.name, tags: t, x: pts[0][0], z: pts[0][1], pts, line: true });
    } else if (t.railway && !(t.tunnel && t.tunnel !== 'no')) {
      const pts = coordsOf(w.nodes);
      if (pts.length >= 2) rails.push({ type: t.railway, pts, bridge: !!(t.bridge && t.bridge !== 'no') });
    } else if (t.waterway === 'canal' || t.waterway === 'river') {
      const pts = coordsOf(w.nodes);
      if (pts.length >= 2) {
        waterLines.push({ name: t.name || '', pts });
        if (t.name) named.push({ name: t.name, tags: t, x: pts[0][0], z: pts[0][1], pts, line: true });
      }
    } else if (t.natural === 'tree_row') {
      const pts = coordsOf(w.nodes);
      for (let i = 1; i < pts.length; i++) {
        const [ax, az] = pts[i - 1], [bx, bz] = pts[i];
        const len = Math.hypot(bx - ax, bz - az);
        const n = Math.max(1, Math.round(len / 9));
        for (let k = i === 1 ? 0 : 1; k <= n; k++) trees.push([ax + ((bx - ax) * k) / n, az + ((bz - az) * k) / n]);
      }
    }
  }

  // ---- 面（水・緑地・広場・駐車場） ----
  const { minX, minZ, maxX, maxZ } = rect;
  const clipPoly = (p, pad = 0) => {
    const outer = clipRingToRect(p.outer, minX - pad, minZ - pad, maxX + pad, maxZ + pad);
    if (outer.length < 3) return null;
    const holes = p.holes.map((h) => clipRingToRect(h, minX - pad, minZ - pad, maxX + pad, maxZ + pad)).filter((h) => h.length >= 3);
    return { outer, holes };
  };
  for (const p of polygons) {
    const t = p.tags;
    if (t.building || t['building:part']) continue;
    let kind = null;
    let extra = {};
    if (t.natural === 'water' || t.waterway === 'riverbank') {
      const area = Math.abs(signedArea(p.outer));
      let perimeter = 0;
      for (let i = 0; i < p.outer.length; i++) {
        const a = p.outer[i], b = p.outer[(i + 1) % p.outer.length];
        perimeter += Math.hypot(b[0] - a[0], b[1] - a[1]);
      }
      const wk = waterKind(t, area, perimeter);
      kind = 'water';
      extra = wk;
    } else if (t.highway && t.area === 'yes' && (t.highway === 'pedestrian' || t.highway === 'footway' || t.highway === 'service' || t.highway === 'living_street')) {
      kind = 'plaza';
    } else if (t.amenity === 'parking' && t.parking !== 'underground' && t.parking !== 'multi-storey' && t.parking !== 'rooftop') {
      kind = 'parking';
    } else {
      kind = greenKind(t);
      if (kind) extra = { kind2: kind };
    }
    if (!kind) continue;
    const clipped = clipPoly(p, kind === 'water' ? 0 : 50);
    if (!clipped) continue;
    const a = { id: p.id, type: kind, name: t.name || '', tags: t, ...clipped, ...extra };
    if (kind !== 'water' && extra.kind2) a.type = extra.kind2;
    a.bounds = ringBounds(a.outer);
    a.area = Math.abs(signedArea(a.outer));
    areas.push(a);
    if (t.name) {
      const ip = interiorPoint(p.outer);
      named.push({ name: t.name, tags: t, x: ip[0], z: ip[1], pts: p.outer, polygon: true });
    }
  }

  unifyWaterLevels(areas);
  fillWaterUnderBridges(areas, roads);
  return { nodePos, buildings, parts, roads, areas, rails, waterLines, trees, named, proj };
}

// 水面の高さをそろえる: 長い継ぎ目（合わせて minSeam m 以上）で接している水は、いちばん深い水と同じ深さ・種類にする。
// データの川は何枚にも切れていて（範囲の切り口・データの継ぎ目）、平均の幅で決めた深さが切れ方で変わるため。
// 運河・閘門は別の水面（閘門で上がる）なので含めない。支流の合流口のような短い継ぎ目も別の水面のまま（岸に段差の壁を作る）。
// そのあと、運河に長く（minSeam / 2 m 以上）接する池・船だまりは運河と同じ水面にする（運河どうしはつながないので閘門は別のまま）
export function unifyWaterLevels(areas, minSeam = 40) {
  const all = areas.filter((a) => a.type === 'water' && !a.patch);
  if (all.length < 2) return;
  const isCanal = (a) => a.tags.water === 'canal' || a.tags.water === 'lock';
  const grid = new Grid(200);
  all.forEach((a, i) => grid.insertBounds(a.bounds.minX - 1, a.bounds.minZ - 1, a.bounds.maxX + 1, a.bounds.maxZ + 1, i));
  // 辺の中点から水の外へ 0.6 m の点が、ほかの水の中にあれば継ぎ目（両側から数えるので、片側の長さは半分）
  const seam = new Map();
  all.forEach((a, i) => {
    for (const [ring, hole] of [[a.outer, false], ...a.holes.map((h) => [h, true])]) {
      const sg = (signedArea(ring) > 0 ? 1 : -1) * (hole ? -1 : 1);
      for (let k = 0; k < ring.length; k++) {
        const p = ring[k], q = ring[(k + 1) % ring.length];
        const L = Math.hypot(q[0] - p[0], q[1] - p[1]);
        if (L < 0.05) continue;
        const x = (p[0] + q[0]) / 2 + ((q[1] - p[1]) / L) * sg * 0.6, z = (p[1] + q[1]) / 2 - ((q[0] - p[0]) / L) * sg * 0.6;
        let hit = -1;
        grid.queryPoint(x, z, 0, (j) => {
          if (hit < 0 && j !== i && pointInPolygon(x, z, all[j])) hit = j;
        });
        if (hit < 0) continue;
        const key = Math.min(i, hit) * all.length + Math.max(i, hit);
        seam.set(key, (seam.get(key) || 0) + L / 2);
      }
    }
  });
  const pairs = [...seam].map(([key, len]) => [key % all.length, Math.floor(key / all.length), len]);
  const parent = all.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (const [i, j, len] of pairs) {
    if (len >= minSeam && !isCanal(all[i]) && !isCanal(all[j])) parent[find(i)] = find(j);
  }
  const deepest = new Map();
  all.forEach((a, i) => {
    if (isCanal(a)) return;
    const r = find(i), d = deepest.get(r);
    if (!d || a.depth > d.depth) deepest.set(r, a);
  });
  all.forEach((a, i) => {
    if (isCanal(a)) return;
    const d = deepest.get(find(i));
    a.depth = d.depth;
    a.kind = d.kind;
  });
  // 運河に接する池（池から池へも伝わる）
  for (let pass = 0, changed = true; changed && pass < 4; pass++) {
    changed = false;
    const toCanal = new Map();
    for (const [i, j, len] of pairs) {
      for (const [x, y] of [[all[i], all[j]], [all[j], all[i]]]) {
        if (x.kind === 'pond' && y.kind === 'canal') toCanal.set(x, [(toCanal.get(x)?.[0] || 0) + len, y]);
      }
    }
    for (const [x, [len, y]] of toCanal) {
      if (len < minSeam / 2) continue;
      x.depth = y.depth;
      x.kind = 'canal';
      changed = true;
    }
  }
}

// IGN BD TOPO などでは、橋の下の部分が水面から切り抜かれている（穴になっている／水面が分断されている）。
// そのままだと橋が陸の上に架かって見えるので、橋の下を水に戻す。
// 橋の下を水で埋めるパッチ。深さは橋が渡る水路の深さ: 片側が池でもう片側が運河・川なら池は数えない。
// 川に注ぐ運河・支流の口（両側の深さが違う）では浅い側の深さで埋め、深い側へは水の始まる所（+0.2 m）までしか広げない
// （そこに深い水へ下りる段差の壁を岸の側で作る）。浅い側へは水の見つかった所より 2 m 先まで
export function fillWaterUnderBridges(areas, roads) {
  const water = areas.filter((a) => a.type === 'water');
  if (!water.length) return;
  const bridges = roads.filter((r) => r.bridge && !r.tunnel);
  const distToBridge = (x, z) => {
    let best = Infinity;
    for (const r of bridges) {
      for (let i = 0; i + 1 < r.pts.length; i++) {
        const d = Math.sqrt(closestOnSegment(x, z, r.pts[i][0], r.pts[i][1], r.pts[i + 1][0], r.pts[i + 1][1]).d2) - r.width / 2;
        if (d < best) best = d;
      }
    }
    return best;
  };
  // 1) 橋の真下にある穴を消す
  for (const a of water) a.holes = a.holes.filter((h) => distToBridge(...interiorPoint(h)) > 4);

  // 2) 橋に沿って調べ、橋の上流側と下流側の両方が水なら「橋の下も水」とみなしてパッチで埋める
  //    （BD TOPO では橋の下が岸から岸まで切り抜かれていて、橋の中心線上には水がない）
  const waterAt = (x, z) => {
    let best = null;
    for (const a of water) {
      if (x < a.bounds.minX || x > a.bounds.maxX || z < a.bounds.minZ || z > a.bounds.maxZ) continue;
      if ((!best || a.depth > best.depth) && pointInRing(x, z, a.outer) && !a.holes.some((h) => pointInRing(x, z, h))) best = a;
    }
    return best;
  };
  const OFFSETS = [4, 8, 13, 19, 26];
  const step = 1.5;
  for (const r of bridges) {
    const samples = [];
    for (let i = 0; i + 1 < r.pts.length; i++) {
      const [ax, az] = r.pts[i], [bx, bz] = r.pts[i + 1];
      const len = Math.hypot(bx - ax, bz - az);
      if (len < 0.01) continue;
      const dx = (bx - ax) / len, dz = (bz - az) / len;
      for (let t = 0; t <= len; t += step) {
        const x = ax + dx * t, z = az + dz * t;
        const here = waterAt(x, z);
        const q = { x, z, dx, dz, depth: here ? here.depth : 0, gap: false, side: null };
        if (!here) {
          // 左右それぞれ、少しずつ離れながら水を探す（sg: 左 +1、右 -1）
          const side = [1, -1].map((sg) => {
            let prev = 0;
            for (const o of OFFSETS) {
              const off = r.width / 2 + o;
              const a = waterAt(x - dz * off * sg, z + dx * off * sg);
              if (a) return { a, sg, lo: prev, hi: off };
              prev = off;
            }
            return null;
          });
          if (side[0] && side[1]) {
            const ds = side.filter((s) => s.a.kind !== 'pond');
            q.depth = Math.min(...(ds.length ? ds : side).map((s) => s.a.depth));
            q.gap = true;
            q.side = side;
          }
        }
        samples.push(q);
      }
    }
    // 深い側の水の始まる所（橋の中心からの距離）を二分法で
    const edgeOf = (q, s) => {
      let { lo, hi } = s;
      for (let k = 0; k < 7; k++) {
        const m = (lo + hi) / 2;
        if (waterAt(q.x - q.dz * m * s.sg, q.z + q.dx * m * s.sg)) hi = m;
        else lo = m;
      }
      return hi + 0.2;
    };
    for (let i = 0; i < samples.length; i++) {
      if (!samples[i].gap) continue;
      let j = i;
      while (j < samples.length && samples[j].gap) j++;
      const run = samples.slice(i, j);
      const depth = Math.max(...run.map((q) => q.depth));
      // 左右それぞれの広がり: 浅い側（パッチと同じ深さ以下）は一律、深い側はサンプルごと
      const ext = [0, 1].map((k) => {
        const shallow = Math.max(...run.map((q) => (q.side[k].a.depth > depth + 0.01 ? 0 : q.side[k].hi))) + 2;
        return run.map((q) => (q.side[k].a.depth > depth + 0.01 ? edgeOf(q, q.side[k]) : shallow));
      });
      // 前後に 1 つずつ（水のある所まで）伸ばす。広がりは隣のサンプルと同じ
      const seg = [...(i > 0 ? [[samples[i - 1], 0]] : []), ...run.map((q, k) => [q, k]), ...(j < samples.length ? [[samples[j], run.length - 1]] : [])];
      const left = seg.map(([q, k]) => [q.x - q.dz * ext[0][k], q.z + q.dx * ext[0][k]]);
      const right = seg.map(([q, k]) => [q.x + q.dz * ext[1][k], q.z - q.dx * ext[1][k]]).reverse();
      const outer = left.concat(right);
      const patch = { id: -1 - areas.length, type: 'water', name: '', tags: {}, outer, holes: [], depth, kind: depth >= 6 ? 'river' : 'canal', patch: true };
      patch.bounds = ringBounds(outer);
      patch.area = Math.abs(signedArea(outer));
      areas.push(patch);
      i = j;
    }
  }
}

function assignBdHeights(buildings, bGrid, bdtopo, proj) {
  const bd = [];
  const grid = new Grid(40);
  for (const it of bdtopo) {
    if (!it.h) continue;
    const ring = it.ring.map(([lon, lat]) => proj.project(lat, lon));
    if (ring.length >= 3) {
      const r = ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1] ? ring.slice(0, -1) : ring;
      const item = { ring: r, h: it.h, levels: it.levels, area: Math.abs(signedArea(r)), inside: interiorPoint(r), bounds: ringBounds(r) };
      grid.insertBounds(item.bounds.minX, item.bounds.minZ, item.bounds.maxX, item.bounds.maxZ, bd.length);
      bd.push(item);
    }
  }
  // 1) OSM 建物の内部点を含む BD TOPO 建物（最小のもの）
  for (const b of buildings) {
    const [x, z] = b.inside;
    let best = null;
    grid.queryPoint(x, z, 0, (i) => {
      const it = bd[i];
      if ((!best || it.area < best.area) && pointInRing(x, z, it.ring)) best = it;
    });
    if (best) {
      b.bdHeight = best.h;
      b.bdLevels = best.levels;
      best.used = true;
    }
  }
  // 2) まだ高さのない OSM 建物には、その中にある BD TOPO 建物の面積加重平均
  const acc = new Map();
  for (const it of bd) {
    const [x, z] = it.inside;
    bGrid.queryPoint(x, z, 0, (i) => {
      const b = buildings[i];
      if (b.bdHeight == null && pointInRing(x, z, b.outer)) {
        const a = acc.get(i) || { sum: 0, w: 0, levels: 0 };
        a.sum += it.h * it.area;
        a.w += it.area;
        a.levels = Math.max(a.levels, it.levels || 0);
        acc.set(i, a);
      }
    });
  }
  for (const [i, a] of acc) {
    buildings[i].bdHeight = a.sum / a.w;
    if (a.levels) buildings[i].bdLevels = a.levels;
  }
}
