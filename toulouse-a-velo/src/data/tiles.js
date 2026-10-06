// 広いエリア（トゥールーズ全体・半径 5 km）のデータをタイルに分けて読み込む。
// - 基本データ: 道路・水域・緑地・名所などはエリア全体を最初に 1 回だけ取得（ナビ・地図・通りの名前に使う）
// - 建物: 500 m 四方のタイルごと。public/data/<エリア>-tiles/<i>_<j>.json（scripts/fetch-data.mjs で作成）を
//   優先し、なければ IGN の WFS から取得する
// - 塀と木: タイルごと。地籍の敷地の境界と LiDAR から見つけたもの（data/walls.js）を同じファイルに入れておく
// - 隣のタイルの、境から CONTEXT m 以内の建物（ctx）: 隣と接する壁（窓のない境界の壁）を見分けるのに使う
import { fetchWfsLayer, normalizeCoords } from './bdtopo.js';
import { IGN_LAYERS, fetchIgnArea, ignToOsm } from './ign.js';
import { fetchSiteFeatures, grow } from './walls.js';
import { cacheGet, cachePut } from './cache.js';
import { DATA_VERSION } from '../config.js';

export const TILE_SIZE = 500; // m
export const CONTEXT = 30; // 隣のタイルの建物を含める幅（m）

export function tileLayout(rect) {
  return {
    rect,
    size: TILE_SIZE,
    cols: Math.ceil((rect.maxX - rect.minX) / TILE_SIZE),
    rows: Math.ceil((rect.maxZ - rect.minZ) / TILE_SIZE),
  };
}

export function tileBounds(layout, i, j) {
  const r = layout.rect, s = layout.size;
  return {
    minX: r.minX + i * s, maxX: Math.min(r.maxX, r.minX + (i + 1) * s),
    minZ: r.minZ + j * s, maxZ: Math.min(r.maxZ, r.minZ + (j + 1) * s),
  };
}

export function tileAt(layout, x, z) {
  const i = Math.floor((x - layout.rect.minX) / layout.size), j = Math.floor((z - layout.rect.minZ) / layout.size);
  return i >= 0 && j >= 0 && i < layout.cols && j < layout.rows ? [i, j] : null;
}

// ローカル座標の範囲 → 緯度経度の bbox（エリアの rect と bbox は線形に対応する）
export function boundsToBbox(areaBbox, rect, b) {
  const lon = (x) => areaBbox.w + ((x - rect.minX) / (rect.maxX - rect.minX)) * (areaBbox.e - areaBbox.w);
  const lat = (z) => areaBbox.n - ((z - rect.minZ) / (rect.maxZ - rect.minZ)) * (areaBbox.n - areaBbox.s);
  return { s: lat(b.maxZ), n: lat(b.minZ), w: lon(b.minX), e: lon(b.maxX) };
}

// ---- 基本データ（建物以外のすべて）----
const BASE_LAYERS = Object.keys(IGN_LAYERS).filter((l) => l !== 'batiment');

async function loadBakedJson(path) {
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}data/${path}`);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export async function fetchBaseData(bbox, { onStatus } = {}) {
  const osm = await fetchIgnArea(bbox, { layers: BASE_LAYERS, onStatus });
  return { version: DATA_VERSION, bbox, fetchedAt: new Date().toISOString(), provider: 'ign', osm, bdtopo: [] };
}

export async function loadBaseData({ bbox, presetId, onStatus, forceNetwork = false }) {
  const key = `base:v${DATA_VERSION}:${bbox.s},${bbox.w},${bbox.n},${bbox.e}`;
  if (!forceNetwork) {
    onStatus?.('事前に用意された地図データを確認中…');
    const baked = await loadBakedJson(`${presetId}.json`);
    const b = baked?.bbox;
    if (baked?.version === DATA_VERSION && b && b.s === bbox.s && b.w === bbox.w && b.n === bbox.n && b.e === bbox.e) {
      return { ...baked, source: '同梱データ' };
    }
    const cached = await cacheGet(key);
    if (cached) return { ...cached, source: 'キャッシュ' };
  }
  const data = await fetchBaseData(bbox, {
    onStatus: ({ count }) => onStatus?.(`IGN BD TOPO から道路・川・公園を取得中… ${count.toLocaleString()} 件`),
  });
  cachePut(key, data);
  return { ...data, source: 'ダウンロード' };
}

// ---- タイルの建物 ----
// 建物を、外形の最初の点が入るタイルに割り当てる（タイルの境をまたぐ建物を二重に作らないため）
export function featureTile(feature, layout, areaBbox) {
  const g = feature.geometry;
  const ring = g?.type === 'MultiPolygon' ? g.coordinates[0]?.[0] : g?.coordinates?.[0];
  if (!ring?.length) return null;
  const [lon, lat] = normalizeCoords([ring[0]], areaBbox)[0]; // [lat, lon] 順で返る場合もそろえる
  const x = layout.rect.minX + ((lon - areaBbox.w) / (areaBbox.e - areaBbox.w)) * (layout.rect.maxX - layout.rect.minX);
  const z = layout.rect.minZ + ((areaBbox.n - lat) / (areaBbox.n - areaBbox.s)) * (layout.rect.maxZ - layout.rect.minZ);
  return tileAt(layout, x, z);
}

// 建物の地物を、タイル自身のもの（own）と、隣のタイルのうち境から CONTEXT m 以内のもの（ctx）に分ける
export function splitTileFeatures(features, layout, areaBbox, i, j) {
  const own = [], ctx = [];
  const tb = boundsToBbox(areaBbox, layout.rect, tileBounds(layout, i, j));
  const near = grow(tb, CONTEXT);
  for (const f of features) {
    const t = featureTile(f, layout, areaBbox);
    if (t && t[0] === i && t[1] === j) {
      own.push(f);
      continue;
    }
    const g = f.geometry;
    const rings = g?.type === 'MultiPolygon' ? g.coordinates.flat() : g?.coordinates || [];
    const hit = rings.some((ring) => normalizeCoords(ring.map((c) => c.slice(0, 2)), areaBbox).some(([lon, lat]) => lon > near.w && lon < near.e && lat > near.s && lat < near.n));
    if (hit) ctx.push(f);
  }
  return { own, ctx };
}

// タイルのデータ: 建物（own・ctx）と塀・木。同梱ファイル → キャッシュ → IGN から取得して作る
export async function loadTileData({ presetId, areaBbox, layout, i, j }) {
  const key = `tile:v${DATA_VERSION}:${presetId}:${areaBbox.s},${areaBbox.w}:${i}_${j}`;
  let data = null;
  const baked = await loadBakedJson(`${presetId}-tiles/${i}_${j}.json`);
  if (baked?.version === DATA_VERSION) data = baked;
  if (!data) data = await cacheGet(key);
  if (!data) {
    const tb = boundsToBbox(areaBbox, layout.rect, tileBounds(layout, i, j));
    const all = await fetchWfsLayer('batiment', grow(tb, CONTEXT), { propertyNames: IGN_LAYERS.batiment });
    const { own, ctx } = splitTileFeatures(all, layout, areaBbox, i, j);
    let site = { walls: [], trees: [] };
    try {
      site = await fetchSiteFeatures(tb, all);
    } catch (err) {
      console.warn(`タイル ${i}_${j} の塀と木を見つけられませんでした`, err);
    }
    data = { version: DATA_VERSION, features: own, ctx, ...site };
    cachePut(key, data);
  }
  return {
    osm: ignToOsm({ batiment: data.features }, areaBbox),
    ctx: ignToOsm({ batiment: data.ctx || [] }, areaBbox),
    walls: data.walls || [],
    trees: data.trees || [],
  };
}
