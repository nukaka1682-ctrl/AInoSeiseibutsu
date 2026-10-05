// 広いエリア（トゥールーズ全体・半径 5 km）のデータをタイルに分けて読み込む。
// - 基本データ: 道路・水域・緑地・名所などはエリア全体を最初に 1 回だけ取得（ナビ・地図・通りの名前に使う）
// - 建物: 500 m 四方のタイルごと。public/data/<エリア>-tiles/<i>_<j>.json（scripts/fetch-data.mjs で作成）を
//   優先し、なければ IGN の WFS から取得する
// - LiDAR: タイルごと。エリア全体に共通の格子（1 m / 2 m）の一部を切り出すので、隣のタイルと高さがぴったり合う
// - 粗い高さ（10 m 格子）: エリア全体。遠景の街並みと、タイルを読み込む前の地面の高さに使う
import { fetchWfsLayer, normalizeCoords } from './bdtopo.js';
import { IGN_LAYERS, fetchIgnArea, ignToOsm } from './ign.js';
import { LIDAR_LAYERS, fetchElevation } from './lidar.js';
import { cacheGet, cachePut } from './cache.js';
import { DATA_VERSION } from '../config.js';

export const TILE_SIZE = 500; // m
export const DSM_RES = 1; // タイルの表面モデルの格子（m）
export const DTM_RES = 2;
export const COARSE_RES = 10;

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

export async function loadTileBuildings({ presetId, areaBbox, layout, i, j }) {
  const key = `tile-b:v${DATA_VERSION}:${presetId}:${areaBbox.s},${areaBbox.w}:${i}_${j}`;
  let features = null;
  const baked = await loadBakedJson(`${presetId}-tiles/${i}_${j}.json`);
  if (baked?.version === DATA_VERSION) features = baked.features;
  if (!features) {
    const cached = await cacheGet(key);
    if (cached) features = cached;
  }
  if (!features) {
    const bbox = boundsToBbox(areaBbox, layout.rect, tileBounds(layout, i, j));
    const all = await fetchWfsLayer('batiment', bbox, { propertyNames: IGN_LAYERS.batiment });
    features = all.filter((f) => {
      const t = featureTile(f, layout, areaBbox);
      return t && t[0] === i && t[1] === j;
    });
    cachePut(key, features);
  }
  return ignToOsm({ batiment: features }, areaBbox);
}

// ---- LiDAR（エリア共通の格子の一部を切り出す）----
// res m の格子でエリア全体を覆ったとき、範囲 b を含む画素の窓を取得する。戻り値の rect はその窓のローカル座標
export async function fetchElevationWindow(layer, areaBbox, rect, b, res) {
  const cols = Math.round((rect.maxX - rect.minX) / res), rows = Math.round((rect.maxZ - rect.minZ) / res);
  const dx = (rect.maxX - rect.minX) / cols, dz = (rect.maxZ - rect.minZ) / rows;
  const c0 = Math.max(0, Math.floor((b.minX - rect.minX) / dx)), c1 = Math.min(cols, Math.ceil((b.maxX - rect.minX) / dx));
  const r0 = Math.max(0, Math.floor((b.minZ - rect.minZ) / dz)), r1 = Math.min(rows, Math.ceil((b.maxZ - rect.minZ) / dz));
  const win = { minX: rect.minX + c0 * dx, maxX: rect.minX + c1 * dx, minZ: rect.minZ + r0 * dz, maxZ: rect.minZ + r1 * dz };
  const grid = await fetchElevation(layer, boundsToBbox(areaBbox, rect, win), c1 - c0, r1 - r0);
  return { ...grid, rect: win };
}

export async function loadTileLidar({ areaBbox, rect, bounds, key }) {
  const cacheKey = `lidar-tile:v1:${areaBbox.s},${areaBbox.w}:${key}`;
  const cached = await cacheGet(cacheKey);
  if (cached) return cached;
  const [dsm, dtm] = await Promise.all([
    fetchElevationWindow(LIDAR_LAYERS.dsm, areaBbox, rect, bounds, DSM_RES),
    fetchElevationWindow(LIDAR_LAYERS.dtm, areaBbox, rect, bounds, DTM_RES),
  ]);
  const lidar = { dsm, dtm };
  cachePut(cacheKey, lidar);
  return lidar;
}

// エリア全体の粗い表面・地形モデル（10 m 格子）
export async function loadCoarseElevation({ areaBbox, rect, onStatus }) {
  const cacheKey = `coarse:v1:${areaBbox.s},${areaBbox.w},${areaBbox.n},${areaBbox.e}`;
  const cached = await cacheGet(cacheKey);
  if (cached) return cached;
  const cols = Math.round((rect.maxX - rect.minX) / COARSE_RES), rows = Math.round((rect.maxZ - rect.minZ) / COARSE_RES);
  let done = 0;
  const step = () => onStatus?.(++done / 2);
  const [dsm, dtm] = await Promise.all([
    fetchElevation(LIDAR_LAYERS.dsm, areaBbox, cols, rows).then((g) => (step(), g)),
    fetchElevation(LIDAR_LAYERS.dtm, areaBbox, cols, rows).then((g) => (step(), g)),
  ]);
  const coarse = { dsm: { ...dsm, rect }, dtm: { ...dtm, rect } };
  cachePut(cacheKey, coarse);
  return coarse;
}
