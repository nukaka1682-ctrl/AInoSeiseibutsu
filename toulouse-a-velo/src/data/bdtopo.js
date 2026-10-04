// IGN（フランス国土地理院）BD TOPO を Géoplateforme の WFS から取得する（Licence Ouverte / Etalab 2.0）。
// - fetchBdTopo: OSM の建物に割り当てる「実測の建物の高さ」
// - fetchWfsLayer: 任意のレイヤー（ign.js で街全体を組み立てるときに使う）

export const BDTOPO_WFS = 'https://data.geopf.fr/wfs/ows';
const PAGE = 5000;
const MAX_PAGES = 20;

function buildUrl(layer, bbox, startIndex, propertyNames) {
  const p = new URLSearchParams({
    SERVICE: 'WFS',
    VERSION: '2.0.0',
    REQUEST: 'GetFeature',
    TYPENAMES: `BDTOPO_V3:${layer}`,
    OUTPUTFORMAT: 'application/json',
    SRSNAME: 'urn:ogc:def:crs:EPSG::4326',
    BBOX: `${bbox.s},${bbox.w},${bbox.n},${bbox.e},urn:ogc:def:crs:EPSG::4326`,
    COUNT: String(PAGE),
    STARTINDEX: String(startIndex),
  });
  if (propertyNames) p.set('PROPERTYNAME', propertyNames.join(','));
  return `${BDTOPO_WFS}?${p}`;
}

// 座標列を [lon, lat]（7 桁）にそろえる。GeoJSON が [lat, lon] 順で返ってきた場合も bbox から判定して直す
export function normalizeCoords(coords, bbox) {
  if (!coords.length) return coords;
  const [a, b] = coords[0];
  const fitsLonLat = a >= bbox.w - 0.5 && a <= bbox.e + 0.5 && b >= bbox.s - 0.5 && b <= bbox.n + 0.5;
  const r = (v) => Math.round(v * 1e7) / 1e7;
  return coords.map((c) => (fitsLonLat ? [r(c[0]), r(c[1])] : [r(c[1]), r(c[0])]));
}

// レイヤーの地物をページングしながらすべて取得する
export async function fetchWfsLayer(layer, bbox, { propertyNames = null, onPage, timeoutMs = 90000 } = {}) {
  let props = propertyNames;
  const all = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    let fc;
    for (let attempt = 0; ; attempt++) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const res = await fetch(buildUrl(layer, bbox, page * PAGE, props), { signal: ctrl.signal });
        if (res.ok) {
          fc = await res.json();
          break;
        }
        // PROPERTYNAME が受け付けられなかった場合は全属性で取り直す
        if (props && page === 0 && res.status === 400) {
          props = null;
          continue;
        }
        throw new Error(`${layer}: HTTP ${res.status}`);
      } catch (err) {
        // 一時的な通信エラーは少し待って 3 回まで再試行
        if (attempt >= 2) throw err;
        await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
      } finally {
        clearTimeout(timer);
      }
    }
    const features = fc.features || [];
    all.push(...features);
    onPage?.(all.length);
    if (features.length < PAGE) break;
  }
  return all;
}

function polygonsOf(geometry) {
  if (!geometry) return [];
  if (geometry.type === 'MultiPolygon') return geometry.coordinates;
  if (geometry.type === 'Polygon') return [geometry.coordinates];
  return [];
}

export async function fetchBdTopo(bbox, { onStatus, timeoutMs } = {}) {
  const features = await fetchWfsLayer('batiment', bbox, {
    propertyNames: ['geometrie', 'hauteur', 'nombre_d_etages'],
    onPage: (count) => onStatus?.({ count }),
    timeoutMs,
  });
  const out = [];
  for (const f of features) {
    const props = f.properties || {};
    const h = Number(props.hauteur);
    const levels = Number(props.nombre_d_etages);
    for (const poly of polygonsOf(f.geometry)) {
      if (!poly[0] || poly[0].length < 4) continue;
      out.push({
        ring: normalizeCoords(poly[0], bbox),
        h: Number.isFinite(h) && h > 0 ? Math.round(h * 10) / 10 : null,
        levels: Number.isFinite(levels) && levels > 0 ? levels : null,
      });
    }
  }
  return out;
}

export { polygonsOf };
