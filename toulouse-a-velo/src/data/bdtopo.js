// IGN（フランス国土地理院）BD TOPO の建物データから「実測の建物の高さ」を取得する。
// Géoplateforme の WFS（Licence Ouverte / Etalab 2.0）を使う。
// OSM には高さが入っていない建物が多いので、これで高さの精度を上げる。取得できなくてもゲームは動く。

export const BDTOPO_WFS = 'https://data.geopf.fr/wfs/ows';
const PAGE = 5000;
const MAX_PAGES = 20;

function buildUrl(bbox, startIndex, withPropertyNames) {
  const p = new URLSearchParams({
    SERVICE: 'WFS',
    VERSION: '2.0.0',
    REQUEST: 'GetFeature',
    TYPENAMES: 'BDTOPO_V3:batiment',
    OUTPUTFORMAT: 'application/json',
    SRSNAME: 'urn:ogc:def:crs:EPSG::4326',
    BBOX: `${bbox.s},${bbox.w},${bbox.n},${bbox.e},urn:ogc:def:crs:EPSG::4326`,
    COUNT: String(PAGE),
    STARTINDEX: String(startIndex),
  });
  if (withPropertyNames) p.set('PROPERTYNAME', 'geometrie,hauteur,nombre_d_etages');
  return `${BDTOPO_WFS}?${p}`;
}

// GeoJSON の座標が [lon, lat] か [lat, lon] かを bbox から判定して [lon, lat] にそろえる
function normalizeRing(ring, bbox) {
  if (!ring.length) return ring;
  const [a, b] = ring[0];
  const fitsLonLat = a >= bbox.w - 0.05 && a <= bbox.e + 0.05 && b >= bbox.s - 0.05 && b <= bbox.n + 0.05;
  const r = (v) => Math.round(v * 1e7) / 1e7;
  return ring.map((c) => (fitsLonLat ? [r(c[0]), r(c[1])] : [r(c[1]), r(c[0])]));
}

function toBuildings(fc, bbox) {
  const out = [];
  for (const f of fc.features || []) {
    const props = f.properties || {};
    const h = Number(props.hauteur);
    const levels = Number(props.nombre_d_etages);
    const g = f.geometry;
    if (!g) continue;
    const polys = g.type === 'MultiPolygon' ? g.coordinates : g.type === 'Polygon' ? [g.coordinates] : [];
    for (const poly of polys) {
      if (!poly[0] || poly[0].length < 4) continue;
      out.push({
        ring: normalizeRing(poly[0].map((c) => [c[0], c[1]]), bbox),
        h: Number.isFinite(h) && h > 0 ? Math.round(h * 10) / 10 : null,
        levels: Number.isFinite(levels) && levels > 0 ? levels : null,
      });
    }
  }
  return out;
}

export async function fetchBdTopo(bbox, { onStatus, timeoutMs = 90000 } = {}) {
  let withProps = true;
  const all = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let fc;
    try {
      const res = await fetch(buildUrl(bbox, page * PAGE, withProps), { signal: ctrl.signal });
      if (!res.ok) {
        // PROPERTYNAME が受け付けられなかった場合は全属性で取り直す
        if (withProps && page === 0) {
          withProps = false;
          page--;
          continue;
        }
        throw new Error(`HTTP ${res.status}`);
      }
      fc = await res.json();
    } finally {
      clearTimeout(timer);
    }
    const items = toBuildings(fc, bbox);
    all.push(...items);
    onStatus?.({ count: all.length });
    if ((fc.features || []).length < PAGE) break;
  }
  return all;
}
