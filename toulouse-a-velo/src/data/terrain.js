// 地形の読み込み（ブラウザ）: 同梱の public/data/<エリア>-terrain.bin（事前取得 scripts/fetch-data.mjs が作る）。
// なければ IGN LiDAR HD の地形モデルを 10 m で直接取得して作る（遅い。橋の縦断面は両端の地面を結ぶ線）。それもだめなら平ら
import { FLAT_TERRAIN, Terrain, decodeTerrain } from '../world/terrain.js';
import { bakeTerrain } from './terrainbake.js';
import { parseOsm } from '../world/parse.js';
import { areaFrame } from '../world/assemble.js';

// 同梱の地形ファイル（デコード済みのデータ。なければ null）
export async function fetchTerrainFile(presetId) {
  if (!presetId) return null;
  try {
    const metro = fetchMetroFile(presetId); // メトロの出入口（並行して。なくてもよい）
    const res = await fetch(`${import.meta.env.BASE_URL}data/${presetId}-terrain.bin`);
    if (!res.ok || /html/.test(res.headers.get('content-type') || '')) return null;
    const data = await decodeTerrain(await res.arrayBuffer());
    data.metro = await metro;
    return data;
  } catch (err) {
    console.warn('地形のファイルを読めませんでした', err);
    return null;
  }
}

// 同梱のメトロの出入口（public/data/<エリア>-metro.json の entrances。なければ空）
async function fetchMetroFile(presetId) {
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}data/${presetId}-metro.json`);
    if (!res.ok || /html/.test(res.headers.get('content-type') || '')) return [];
    return (await res.json()).entrances || [];
  } catch {
    return [];
  }
}

// filePromise: fetchTerrainFile の結果、osm: エリアの地図（直接取得するとき、川・運河の範囲に使う）
export async function loadTerrain({ filePromise, bbox, osm, onStatus = () => {} }) {
  const { proj, rect } = areaFrame(bbox);
  const file = await filePromise;
  if (file) return { terrain: new Terrain(file, proj), source: 'file' };
  try {
    onStatus('地形（IGN LiDAR HD の地形モデル）を取得中…');
    const parsed = parseOsm(osm, proj, rect, []);
    const data = await bakeTerrain({ bbox, parsed, proj, step: 10, sub: 1, margin: 300, withDsm: false, onStatus });
    return { terrain: new Terrain(data, proj), source: 'network' };
  } catch (err) {
    console.warn('地形を取得できませんでした（平らな地面にします）', err);
    return { terrain: FLAT_TERRAIN, source: 'flat', error: err };
  }
}
