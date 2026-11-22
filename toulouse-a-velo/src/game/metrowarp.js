// メトロの駅へのワープ（全体地図の「メトロの駅へワープ」）。three.js を使わない（単体テストできる）。
// 行き先は、駅の地上の出入口（world/metro.js の出入口。地形の手直しのあとの T.metro）のうち駅の中心にいちばん近いものの、
// 上の端（下りる側の反対）から WARP_BACK m 手前。向きは出入口の方。出入口がエリアにない駅は駅の中心（OSM・BD TOPO の駅の位置）
import { LINES, stationList } from '../metro/network.js';
import { entranceFrame } from '../world/metro.js';

const WARP_BACK = 4;

// stations: network.js の stationList()、entrances: T.metro（x, z, ang, down, len, station）、proj: エリアの投影、
// inside(x, z): エリアの中か。戻り値: 線ごとの駅の並び { A: [{ id, name, ja, x, z, look: [x, z] }…], B: […] }（エリアの外の駅は除く）
export function metroWarpTargets(entrances, proj, inside = () => true, stations = stationList()) {
  const byId = new Map(stations.map((s) => [s.id, s]));
  const out = {};
  for (const [line, ids] of Object.entries(LINES)) {
    out[line] = [];
    for (const id of ids) {
      const s = byId.get(id);
      if (!s) continue;
      const [cx, cz] = proj.project(s.lat, s.lon);
      const own = (entrances || []).filter((e) => e.kind === 'metro' && e.station === s.bd && !e.synthetic);
      let t = null;
      if (own.length) {
        const e = own.reduce((a, b) => (Math.hypot(b.x - cx, b.z - cz) < Math.hypot(a.x - cx, a.z - cz) ? b : a));
        const f = entranceFrame(e);
        const [x, z] = f.at(-e.len / 2 - WARP_BACK, 0);
        t = { x, z, look: [e.x, e.z] };
      } else t = { x: cx, z: cz, look: null };
      if (!inside(t.x, t.z)) continue;
      out[line].push({ id, name: s.name, ja: s.ja, ...t });
    }
  }
  return out;
}

// 向き（bike.place の heading: +z が南、0 が北向き）。from → to
export const headingTo = (from, to) => Math.atan2(to[0] - from[0], -(to[1] - from[1]));
