// 逆向きの一方通行（IGN の sens_de_circulation = 'Sens inverse'。車は頂点の順と逆に進む）の補い。
// 古い形式で保存した地図データ（public/data/<エリア>.json）は 'Sens direct' と区別せず oneway=yes にしていたので、
// 逆向きの道の両端の点の一覧（public/data/<エリア>-oneway.json、scripts/fetch-data.mjs で作成）を読んで oneway=-1 に直す。
// ファイルがなければ何もしない（線や矢印が逆向きになる道があるだけ）
import { fetchWfsLayer } from './bdtopo.js';
import { IGN_LAYERS, ignToOsm } from './ign.js';

// 道の両端の点の鍵（ignToOsm の点の座標そのまま）
const keyOf = (a, b) => `${a.lat},${a.lon},${b.lat},${b.lon}`;

// OSM 形式の elements から oneway=-1 の道の両端の鍵の一覧
export function reverseKeys(elements) {
  const nodes = new Map();
  for (const e of elements) if (e.type === 'node') nodes.set(e.id, e);
  const out = [];
  for (const e of elements) {
    if (e.type !== 'way' || e.tags?.oneway !== '-1' || !e.nodes?.length) continue;
    const a = nodes.get(e.nodes[0]), b = nodes.get(e.nodes[e.nodes.length - 1]);
    if (a && b) out.push(keyOf(a, b));
  }
  return out;
}

// 一覧 keys に両端が一致する oneway=yes の道を oneway=-1 にする（elements を書き換える）。戻り値: 直した数
export function applyReverseKeys(elements, keys) {
  const set = new Set(keys);
  if (!set.size) return 0;
  const nodes = new Map();
  for (const e of elements) if (e.type === 'node') nodes.set(e.id, e);
  let n = 0;
  for (const e of elements) {
    if (e.type !== 'way' || e.tags?.oneway !== 'yes' || !e.nodes?.length) continue;
    const a = nodes.get(e.nodes[0]), b = nodes.get(e.nodes[e.nodes.length - 1]);
    if (a && b && set.has(keyOf(a, b))) {
      e.tags.oneway = '-1';
      n++;
    }
  }
  return n;
}

// ブラウザ: 同梱の一覧を読んで data.osm に当てる（なければそのまま）
export async function fixReverseOneway(data, presetId) {
  if (!presetId || !data?.osm?.elements) return data;
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}data/${presetId}-oneway.json`);
    if (res.ok) applyReverseKeys(data.osm.elements, (await res.json()).keys || []);
    else console.warn(`${presetId}-oneway.json がない: 「Sens inverse」の一方通行の向きが逆のまま（npm run fetch-data -- all --oneway で作る）`);
  } catch (e) {
    // 一覧がなくても遊べる（矢印・レーン・路上駐車の向きが逆の道が残る）
    console.warn(`${presetId}-oneway.json を読めない: 「Sens inverse」の一方通行の向きが逆のまま`, e);
  }
  return data;
}

// データ作成（scripts/fetch-data.mjs）: 範囲 bbox の道路を IGN から取得し、逆向きの一方通行の両端の鍵の一覧を作る
export async function fetchReverseKeys(bbox, { onPage } = {}) {
  const troncon_de_route = await fetchWfsLayer('troncon_de_route', bbox, { propertyNames: IGN_LAYERS.troncon_de_route, onPage });
  return reverseKeys(ignToOsm({ troncon_de_route }, bbox).elements);
}
