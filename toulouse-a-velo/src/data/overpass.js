// OpenStreetMap データを Overpass API から取得する。ブラウザと Node（scripts/fetch-data.mjs）の両方で動く。

export const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

export function buildOverpassQuery({ s, w, n, e }) {
  const b = `(${s},${w},${n},${e})`;
  return `[out:json][timeout:180];
(
  way["building"]${b};
  way["building:part"]${b};
  relation["type"="multipolygon"]["building"]${b};
  relation["type"="multipolygon"]["building:part"]${b};
  way["highway"]${b};
  way["railway"~"^(rail|tram|light_rail|narrow_gauge)$"]${b};
  way["natural"="water"]${b};
  relation["natural"="water"]${b};
  way["waterway"="riverbank"]${b};
  relation["waterway"="riverbank"]${b};
  way["waterway"~"^(river|canal)$"]${b};
  way["leisure"~"^(park|garden|pitch|playground|dog_park)$"]${b};
  relation["type"="multipolygon"]["leisure"~"^(park|garden)$"]${b};
  way["landuse"~"^(grass|recreation_ground|cemetery|village_green|meadow|forest|flowerbed)$"]${b};
  way["natural"~"^(wood|scrub|grassland)$"]${b};
  way["amenity"="parking"]${b};
  node["natural"="tree"]${b};
  way["natural"="tree_row"]${b};
  node["name"]["tourism"]${b};
  node["name"]["historic"]${b};
  node["name"]["amenity"~"^(place_of_worship|theatre|townhall)$"]${b};
);
out body;
>;
out skel qt;`;
}

// 描画やゲームに使うタグだけ残してデータを小さくする
const KEEP_TAG = /^(building|building:part|building:levels|building:min_level|building:colour|building:material|height|min_height|roof:shape|roof:height|roof:levels|roof:colour|roof:material|name|highway|width|lanes|oneway|oneway:bicycle|bridge|layer|tunnel|covered|area|surface|sidewalk|natural|water|waterway|leisure|landuse|amenity|parking|railway|man_made|tourism|historic|type|service|cycleway|footway|location|level|denotation)$/;

export function compactOsm(osm) {
  const elements = [];
  for (const el of osm.elements || []) {
    const out = { type: el.type, id: el.id };
    if (el.type === 'node') {
      out.lat = Math.round(el.lat * 1e7) / 1e7;
      out.lon = Math.round(el.lon * 1e7) / 1e7;
    }
    if (el.nodes) out.nodes = el.nodes;
    if (el.members) out.members = el.members.map((m) => ({ type: m.type, ref: m.ref, role: m.role }));
    if (el.tags) {
      const tags = {};
      let any = false;
      for (const k in el.tags) {
        if (KEEP_TAG.test(k)) {
          tags[k] = el.tags[k];
          any = true;
        }
      }
      if (any) out.tags = tags;
    }
    elements.push(out);
  }
  return { elements };
}

// レスポンスを読みながら受信バイト数を通知する
async function readJsonWithProgress(res, onBytes) {
  if (!res.body || !res.body.getReader) return res.json();
  const reader = res.body.getReader();
  const chunks = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    onBytes?.(received);
  }
  const all = new Uint8Array(received);
  let off = 0;
  for (const c of chunks) {
    all.set(c, off);
    off += c.length;
  }
  return JSON.parse(new TextDecoder('utf-8').decode(all));
}

export async function fetchOverpass(bbox, { onStatus, headers = {}, timeoutMs = 240000, endpoints = OVERPASS_ENDPOINTS } = {}) {
  const query = buildOverpassQuery(bbox);
  const errors = [];
  for (const url of endpoints) {
    const host = new URL(url).host;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      onStatus?.({ host, bytes: 0 });
      const res = await fetch(url, {
        method: 'POST',
        body: new URLSearchParams({ data: query }),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', ...headers },
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await readJsonWithProgress(res, (bytes) => onStatus?.({ host, bytes }));
      if (!json.elements) throw new Error('elements がありません');
      if (json.remark && /runtime error|timed out|out of memory/i.test(json.remark)) throw new Error(json.remark);
      return compactOsm(json);
    } catch (err) {
      errors.push(`${host}: ${err.name === 'AbortError' ? 'タイムアウト' : err.message}`);
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(`OpenStreetMap データを取得できませんでした\n${errors.join('\n')}`);
}
