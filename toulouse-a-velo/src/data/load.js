// 地図データの読み込み順:
//   1. public/data/<area>.json（scripts/fetch-data.mjs で事前に焼き込んだもの）
//   2. IndexedDB キャッシュ
//   3. ネットワーク
//      - auto: OpenStreetMap（Overpass API）＋ IGN の建物の高さ。Overpass が使えなければ IGN BD TOPO だけで組み立てる
//      - ign : IGN BD TOPO だけで組み立てる
import { fetchOverpass } from './overpass.js';
import { fetchBdTopo } from './bdtopo.js';
import { fetchIgnArea } from './ign.js';
import { cacheGet, cachePut } from './cache.js';
import { fetchLidar, lidarResolution } from './lidar.js';
import { DATA_VERSION } from '../config.js';

export const PROVIDER_LABEL = { osm: 'OpenStreetMap + IGN（建物の高さ）', ign: 'IGN BD TOPO' };

export function areaKey(bbox, provider = 'auto') {
  return `v${DATA_VERSION}:${provider}:${bbox.s},${bbox.w},${bbox.n},${bbox.e}`;
}

async function loadBaked(presetId, bbox, provider) {
  if (!presetId) return null;
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}data/${presetId}.json`);
    if (!res.ok) return null;
    const data = await res.json();
    if (data.version !== DATA_VERSION) return null;
    if (provider === 'ign' && data.provider !== 'ign') return null;
    const b = data.bbox;
    if (!b || b.s !== bbox.s || b.w !== bbox.w || b.n !== bbox.n || b.e !== bbox.e) return null;
    return data;
  } catch {
    return null;
  }
}

const mb = (bytes) => (bytes / 1048576).toFixed(1);

// Node（scripts/fetch-data.mjs）からも使う、ネットワークからの取得
export async function fetchAreaData(bbox, { provider = 'auto', onStatus, overpassOptions = {} } = {}) {
  const fetchedAt = new Date().toISOString();
  if (provider === 'ign') {
    onStatus?.('IGN BD TOPO から地図を取得中…');
    const osm = await fetchIgnArea(bbox, { onStatus: ({ count }) => onStatus?.(`IGN BD TOPO から地図を取得中… ${count.toLocaleString()} 件`) });
    return { version: DATA_VERSION, bbox, fetchedAt, provider: 'ign', osm, bdtopo: [] };
  }

  // OSM と IGN の建物の高さを並行して取得
  let osmBytes = 0, osmHost = '', bdCount = 0, bdState = '取得中';
  const report = () =>
    onStatus?.(`OpenStreetMap から地図を取得中… ${mb(osmBytes)} MB${osmHost ? `（${osmHost}）` : ''}\nIGN BD TOPO（建物の高さ）: ${bdState}${bdCount ? ` ${bdCount.toLocaleString()} 棟` : ''}`);
  report();
  const bdPromise = fetchBdTopo(bbox, {
    onStatus: ({ count }) => {
      bdCount = count;
      report();
    },
  })
    .then((r) => {
      bdState = '完了';
      report();
      return r;
    })
    .catch((err) => {
      console.warn('BD TOPO の取得に失敗（OSM の高さ情報だけで続行）:', err);
      bdState = '取得できず（OSM の情報で代用）';
      report();
      return [];
    });

  let osm;
  try {
    osm = await fetchOverpass(bbox, {
      attempts: 1,
      deadlineMs: 100000, // ブラウザでは 100 秒つながらなければ IGN に切り替える
      ...overpassOptions,
      onStatus: ({ host, bytes }) => {
        osmBytes = bytes;
        osmHost = host;
        report();
      },
    });
  } catch (err) {
    // Overpass が混雑・接続不可 → IGN BD TOPO だけで組み立てる
    console.warn(err);
    onStatus?.('OpenStreetMap に接続できなかったため、IGN BD TOPO の地図に切り替えます…');
    const ign = await fetchAreaData(bbox, { provider: 'ign', onStatus });
    return { ...ign, fallbackReason: String(err.message || err).split('\n')[0] };
  }
  const bdtopo = await bdPromise;
  return { version: DATA_VERSION, bbox, fetchedAt, provider: 'osm', osm, bdtopo };
}

export async function loadAreaData({ bbox, presetId, onStatus, forceNetwork = false, provider = 'auto' }) {
  if (!forceNetwork) {
    onStatus?.('事前に用意された地図データを確認中…');
    const baked = await loadBaked(presetId, bbox, provider);
    if (baked) return { ...baked, provider: baked.provider || 'osm', source: '同梱データ' };

    onStatus?.('キャッシュを確認中…');
    const cached = await cacheGet(areaKey(bbox, provider));
    if (cached) return { ...cached, source: 'キャッシュ' };
  }
  const data = await fetchAreaData(bbox, { provider, onStatus });
  cachePut(areaKey(bbox, provider), data);
  return { ...data, source: 'ダウンロード' };
}

// LiDAR HD（表面・地形モデル）。IndexedDB にキャッシュする
export async function loadLidar(bbox, rect, { onStatus, forceNetwork = false } = {}) {
  const res = lidarResolution(rect);
  const key = `lidar:v1:${res.dsm}:${bbox.s},${bbox.w},${bbox.n},${bbox.e}`;
  if (!forceNetwork) {
    const cached = await cacheGet(key);
    if (cached) return cached;
  }
  const lidar = await fetchLidar(bbox, rect, { onStatus });
  cachePut(key, lidar);
  return lidar;
}
