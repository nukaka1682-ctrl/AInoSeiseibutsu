// IGN BD TOPO だけで街全体を組み立てる（Overpass API が使えないときの代替データ）。
// WFS で取得した各レイヤーを、OSM（Overpass JSON）と同じ形の nodes / ways / relations に変換するので、
// それ以降の処理（world/parse.js など）は OSM のときと共通。
//
// BD TOPO の建物は「軒の高さ（hauteur）」「屋根の最高点・最低点」「壁と屋根の材料」まで持っているため、
// 高さと屋根の再現度は OSM より高い。一方、街路樹や細かな歩道は含まれない。
import { fetchWfsLayer, normalizeCoords, polygonsOf } from './bdtopo.js';

export const IGN_LAYERS = {
  batiment: ['geometrie', 'hauteur', 'nombre_d_etages', 'nature', 'usage_1', 'materiaux_des_murs', 'materiaux_de_la_toiture', 'altitude_minimale_toit', 'altitude_maximale_toit'],
  troncon_de_route: ['geometrie', 'nature', 'importance', 'largeur_de_chaussee', 'nombre_de_voies', 'position_par_rapport_au_sol', 'sens_de_circulation', 'acces_vehicule_leger', 'nom_voie_ban_gauche', 'nom_voie_ban_droite', 'nom_collaboratif_gauche', 'fictif'],
  surface_hydrographique: ['geometrie', 'nature', 'position_par_rapport_au_sol'],
  troncon_hydrographique: ['geometrie', 'nature', 'cpx_toponyme_de_cours_d_eau', 'position_par_rapport_au_sol'],
  zone_d_activite_ou_d_interet: ['geometrie', 'categorie', 'nature', 'nature_detaillee', 'toponyme'],
  equipement_de_transport: ['geometrie', 'nature', 'nature_detaillee', 'toponyme'],
  zone_de_vegetation: ['geometrie', 'nature'],
  troncon_de_voie_ferree: ['geometrie', 'nature', 'position_par_rapport_au_sol'],
  terrain_de_sport: ['geometrie', 'nature'],
  cimetiere: ['geometrie', 'toponyme'],
};

// 道路名の略語（BAN の名前がない区間で使う IGN 独自の名前は大文字の略記）
const ABBR = {
  R: 'Rue', AV: 'Avenue', BD: 'Boulevard', PL: 'Place', PLE: 'Placette', CHE: 'Chemin', ALL: 'Allée', ALLS: 'Allées',
  IMP: 'Impasse', PASS: 'Passage', QU: 'Quai', QUAI: 'Quai', JARD: 'Jardin', SQ: 'Square', CRS: 'Cours', RTE: 'Route',
  ESP: 'Esplanade', PRV: 'Parvis', PROM: 'Promenade', PONT: 'Pont', PORT: 'Port', RPT: 'Rond-Point', VOIE: 'Voie',
};
const PARTICLES = new Set(['de', 'des', 'du', 'la', 'le', 'les', 'et', 'aux', 'au', 'sur', 'en']);

export function prettifyName(raw) {
  if (!raw) return '';
  const s = String(raw).trim();
  if (s !== s.toUpperCase()) return s; // すでに大文字小文字が整っている
  return s.split(/\s+/).map((w, i) => {
    if (i === 0 && ABBR[w]) return ABBR[w];
    const lw = w.toLowerCase();
    if (i > 0 && PARTICLES.has(lw)) return lw;
    if (/^[ld]'/.test(lw)) return `${lw.slice(0, 2)}${lw.charAt(2).toUpperCase()}${lw.slice(3)}`;
    return lw.charAt(0).toUpperCase() + lw.slice(1);
  }).join(' ');
}

// 壁・屋根の材料コード（ファイル・フォンシエ由来の 2 桁: 1 桁目が主な材料）
const WALL_MATERIAL = { 1: 'stone', 2: 'stone', 3: 'concrete', 4: 'brick', 5: 'concrete', 6: 'wood' };
const firstDigit = (code) => {
  const m = String(code || '').match(/[1-9]/);
  return m ? Number(m[0]) : 0;
};

function buildingTags(p) {
  const tags = { building: 'yes' };
  const nature = p.nature || '';
  if (nature === 'Eglise') tags.building = 'church';
  else if (nature === 'Chapelle') tags.building = 'chapel';
  else if (nature === 'Tour, donjon') tags.building = 'tower';
  else if (nature === 'Industriel, agricole ou commercial') tags.building = 'commercial';
  else if (nature === 'Serre') tags.building = 'greenhouse';
  else if (p.usage_1 === 'Religieux') tags.building = 'religious';
  else if (p.usage_1 === 'Annexe') tags.building = 'shed';
  else if (p.usage_1 === 'Commercial et services') tags.building = 'commercial';

  const wall = WALL_MATERIAL[firstDigit(p.materiaux_des_murs)];
  if (wall) tags['building:material'] = wall;
  const roof = firstDigit(p.materiaux_de_la_toiture);
  const h = Number(p.hauteur);
  const t0 = Number(p.altitude_minimale_toit), t1 = Number(p.altitude_maximale_toit);
  let roofH = Number.isFinite(t0) && Number.isFinite(t1) ? Math.max(0, t1 - t0) : 0;
  if (roof === 4) roofH = 0; // コンクリートの屋根 = 陸屋根
  if (Number.isFinite(t1) && t1 > 0) tags['roof:max_ele'] = String(t1); // 屋根の最高点の標高（LiDAR に写った木を除くのに使う）
  if (roof === 2) tags['roof:colour'] = '#5f646b'; // スレート
  if (roof === 3) tags['roof:colour'] = '#8d949b'; // 亜鉛・アルミ
  if (Number.isFinite(h) && h > 0) {
    tags['height:source'] = 'IGN';
    if (roofH > 0.5 && roofH < Math.max(12, h)) {
      tags['roof:height'] = String(Math.round(roofH * 10) / 10);
      tags.height = String(Math.round((h + roofH) * 10) / 10);
    } else {
      tags['roof:shape'] = 'flat';
      tags.height = String(Math.round(h * 10) / 10);
    }
  }
  const levels = Number(p.nombre_d_etages);
  if (levels > 0) tags['building:levels'] = String(levels);
  return tags;
}

function roadTags(p) {
  const nature = p.nature || '';
  let highway;
  if (nature === 'Sentier') highway = 'footway';
  else if (nature === 'Escalier') highway = 'steps';
  else if (nature === 'Piste cyclable') highway = 'cycleway';
  else if (nature === 'Chemin' || nature === 'Route empierrée') highway = 'track';
  else if (nature === 'Type autoroutier') highway = 'motorway';
  else if (nature === 'Quasi-autoroute') highway = 'trunk';
  else if (nature === 'Bretelle') highway = 'primary_link';
  else if (/^Bac/.test(nature)) return null;
  else if (p.acces_vehicule_leger === 'Physiquement impossible') highway = 'pedestrian'; // 歩行者専用の通り
  else if (p.acces_vehicule_leger === 'Restreint aux ayants droit') highway = 'living_street';
  else highway = { 1: 'trunk', 2: 'primary', 3: 'secondary', 4: 'tertiary', 5: 'residential', 6: 'service' }[p.importance] || 'residential';
  const tags = { highway };
  const name = p.nom_voie_ban_gauche || p.nom_voie_ban_droite || prettifyName(p.nom_collaboratif_gauche);
  if (name) tags.name = name.trim();
  const w = Number(p.largeur_de_chaussee);
  if (w > 0) tags.width = String(w);
  const lanes = Number(p.nombre_de_voies);
  if (lanes > 0 && highway !== 'pedestrian') tags.lanes = String(lanes);
  const pos = Number(p.position_par_rapport_au_sol) || 0;
  if (pos > 0) {
    tags.bridge = 'yes';
    tags.layer = String(pos);
  } else if (pos < 0) {
    tags.tunnel = 'yes';
    tags.layer = String(pos);
  }
  if (p.sens_de_circulation === 'Sens direct' || p.sens_de_circulation === 'Sens inverse') tags.oneway = 'yes';
  return tags;
}

const WATER = { Canal: 'canal', 'Ecoulement naturel': 'river', Retenue: 'reservoir', 'Réservoir-bassin': 'basin' };

function poiAreaTags(p) {
  const name = (p.toponyme || '').trim();
  const det = p.nature_detaillee || '';
  if (p.nature === 'Espace public') {
    if (/^(Place|Esplanade|Parvis)$/.test(det)) return { highway: 'pedestrian', area: 'yes', name };
    if (/^(Square|Parc|Jardin|Promenade)/.test(det) || /^(Jardin|Square|Prairie|Parc)/.test(name)) return { leisure: 'park', name };
  }
  return null;
}

// GeoJSON 地物の配列 → OSM 風の要素
class OsmBuilder {
  constructor(bbox) {
    this.bbox = bbox;
    this.elements = [];
    this.nodeIds = new Map();
    this.next = 1;
  }

  node([lon, lat], tags) {
    if (tags) {
      const id = this.next++;
      this.elements.push({ type: 'node', id, lat, lon, tags });
      return id;
    }
    const key = `${lon},${lat}`;
    let id = this.nodeIds.get(key);
    if (id === undefined) {
      id = this.next++;
      this.nodeIds.set(key, id);
      this.elements.push({ type: 'node', id, lat, lon });
    }
    return id;
  }

  way(coords, tags) {
    const nodes = normalizeCoords(coords, this.bbox).map((c) => this.node(c));
    const clean = nodes.filter((n, i) => i === 0 || n !== nodes[i - 1]);
    if (clean.length < 2) return null;
    const id = this.next++;
    this.elements.push({ type: 'way', id, nodes: clean, ...(tags ? { tags } : {}) });
    return id;
  }

  polygon(rings, tags) {
    if (!rings[0] || rings[0].length < 4) return;
    if (rings.length === 1) {
      this.way(rings[0], tags);
      return;
    }
    const members = rings.map((r, i) => ({ type: 'way', ref: this.way(r), role: i === 0 ? 'outer' : 'inner' })).filter((m) => m.ref);
    this.elements.push({ type: 'relation', id: this.next++, members, tags: { type: 'multipolygon', ...tags } });
  }

  // 面の地物の名前だけを点として登録する（名所の位置合わせ用）
  namedPoint(geometry, tags) {
    const polys = polygonsOf(geometry);
    const ring = polys[0]?.[0];
    if (!ring) return;
    const c = normalizeCoords(ring, this.bbox);
    let sx = 0, sy = 0;
    for (const [x, y] of c) {
      sx += x;
      sy += y;
    }
    this.node([Math.round((sx / c.length) * 1e7) / 1e7, Math.round((sy / c.length) * 1e7) / 1e7], tags);
  }
}

const linesOf = (g) => (!g ? [] : g.type === 'MultiLineString' ? g.coordinates : g.type === 'LineString' ? [g.coordinates] : []);

export function ignToOsm(layers, bbox) {
  const b = new OsmBuilder(bbox);
  for (const f of layers.batiment || []) {
    const tags = buildingTags(f.properties || {});
    for (const poly of polygonsOf(f.geometry)) b.polygon(poly, tags);
  }
  for (const f of layers.troncon_de_route || []) {
    const p = f.properties || {};
    if (p.fictif === true || p.fictif === 'true') continue;
    const tags = roadTags(p);
    if (!tags) continue;
    for (const line of linesOf(f.geometry)) b.way(line, tags);
  }
  for (const f of layers.surface_hydrographique || []) {
    const p = f.properties || {};
    if (Number(p.position_par_rapport_au_sol) < 0) continue;
    const tags = { natural: 'water', water: WATER[p.nature] || 'pond' };
    for (const poly of polygonsOf(f.geometry)) b.polygon(poly, tags);
  }
  for (const f of layers.troncon_hydrographique || []) {
    const p = f.properties || {};
    const name = prettifyName(p.cpx_toponyme_de_cours_d_eau || '').replace(/^la /, 'La ');
    if (!name || Number(p.position_par_rapport_au_sol) < 0) continue;
    for (const line of linesOf(f.geometry)) b.way(line, { waterway: p.nature === 'Canal' ? 'canal' : 'river', name });
  }
  for (const f of layers.zone_d_activite_ou_d_interet || []) {
    const p = f.properties || {};
    const area = poiAreaTags(p);
    if (area) {
      for (const poly of polygonsOf(f.geometry)) b.polygon(poly, area);
    } else if (p.toponyme) {
      b.namedPoint(f.geometry, { name: p.toponyme.trim(), tourism: 'attraction' });
    }
  }
  for (const f of layers.equipement_de_transport || []) {
    const p = f.properties || {};
    if (p.nature === 'Parking' && !/souterrain/i.test(p.nature_detaillee || '')) {
      for (const poly of polygonsOf(f.geometry)) b.polygon(poly, { amenity: 'parking' });
    } else if (p.toponyme && !/Parking|métro|Station|Arrêt/i.test(`${p.nature} ${p.nature_detaillee || ''}`)) {
      b.namedPoint(f.geometry, { name: p.toponyme.trim(), tourism: 'attraction' });
    }
  }
  for (const f of layers.zone_de_vegetation || []) {
    const n = f.properties?.nature || '';
    if (n === 'Haie') continue; // 生け垣は細すぎるので描かない
    const tags = /Bois|Forêt|Peupleraie/.test(n) ? { natural: 'wood' } : { landuse: 'grass' };
    for (const poly of polygonsOf(f.geometry)) b.polygon(poly, tags);
  }
  for (const f of layers.troncon_de_voie_ferree || []) {
    const p = f.properties || {};
    const pos = Number(p.position_par_rapport_au_sol) || 0;
    if (pos < 0 || /Métro/.test(p.nature || '')) continue;
    const tags = { railway: p.nature === 'Tramway' ? 'tram' : 'rail' };
    if (pos > 0) tags.bridge = 'yes';
    for (const line of linesOf(f.geometry)) b.way(line, tags);
  }
  for (const f of layers.terrain_de_sport || []) for (const poly of polygonsOf(f.geometry)) b.polygon(poly, { leisure: 'pitch' });
  for (const f of layers.cimetiere || []) for (const poly of polygonsOf(f.geometry)) b.polygon(poly, { landuse: 'cemetery' });
  return { elements: b.elements };
}

// layers: 取得するレイヤー（省略時はすべて）
export async function fetchIgnArea(bbox, { onStatus, layers: only = null } = {}) {
  const names = only || Object.keys(IGN_LAYERS);
  const counts = {};
  const report = () => onStatus?.({ count: Object.values(counts).reduce((a, n) => a + n, 0) });
  const layers = {};
  // 同時に 3 レイヤーずつ取得
  const queue = names.slice();
  const worker = async () => {
    while (queue.length) {
      const name = queue.shift();
      layers[name] = await fetchWfsLayer(name, bbox, {
        propertyNames: IGN_LAYERS[name],
        onPage: (n) => {
          counts[name] = n;
          report();
        },
      });
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  if (!layers.batiment?.length && !layers.troncon_de_route?.length) throw new Error('IGN BD TOPO: この範囲にデータがありません');
  return ignToOsm(layers, bbox);
}
