// 地図データの読み込み順:
//   1. public/data/<area>.json（scripts/fetch-data.mjs で事前に焼き込んだもの）
//   2. IndexedDB キャッシュ
//   3. ネットワーク（Overpass API + IGN WFS）
import { fetchOverpass } from './overpass.js';
import { fetchBdTopo } from './bdtopo.js';
import { cacheGet, cachePut } from './cache.js';
import { DATA_VERSION } from '../config.js';

export function areaKey(bbox) {
  return `v${DATA_VERSION}:${bbox.s},${bbox.w},${bbox.n},${bbox.e}`;
}

async function loadBaked(presetId, bbox) {
  if (!presetId) return null;
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}data/${presetId}.json`);
    if (!res.ok) return null;
    const data = await res.json();
    if (data.version !== DATA_VERSION) return null;
    const b = data.bbox;
    if (!b || b.s !== bbox.s || b.w !== bbox.w || b.n !== bbox.n || b.e !== bbox.e) return null;
    return data;
  } catch {
    return null;
  }
}

const mb = (bytes) => (bytes / 1048576).toFixed(1);

export async function loadAreaData({ bbox, presetId, onStatus, forceNetwork = false }) {
  if (!forceNetwork) {
    onStatus?.('事前に用意された地図データを確認中…');
    const baked = await loadBaked(presetId, bbox);
    if (baked) return { ...baked, source: '同梱データ' };

    onStatus?.('キャッシュを確認中…');
    const cached = await cacheGet(areaKey(bbox));
    if (cached) return { ...cached, source: 'キャッシュ' };
  }

  // OSM と BD TOPO を並行して取得
  let osmBytes = 0;
  let bdCount = 0;
  let bdState = '取得中';
  const report = () =>
    onStatus?.(`OpenStreetMap から地図を取得中… ${mb(osmBytes)} MB\nIGN BD TOPO（建物の高さ）: ${bdState}${bdCount ? ` ${bdCount} 棟` : ''}`);
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

  const osm = await fetchOverpass(bbox, {
    onStatus: ({ bytes }) => {
      osmBytes = bytes;
      report();
    },
  });
  const bdtopo = await bdPromise;

  const data = { version: DATA_VERSION, bbox, fetchedAt: new Date().toISOString(), osm, bdtopo };
  cachePut(areaKey(bbox), data);
  return { ...data, source: 'ダウンロード' };
}
