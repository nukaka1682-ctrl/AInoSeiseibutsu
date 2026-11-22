// 点のまわり（ARGS = { lat, lon, r }）の物理的におかしな所を数える:
// - float: 街の小物（車・車止め・街灯など）で、その場所の面（歩道を含む）から 0.5 m 以上浮いた・沈んだ物
// - trunkIn: 建物の外形の中に立つ木の幹
// - thinBld: 高さに比べて極端に細い建物（幅 1.5 m 未満で 6 m 以上）
(() => {
  const W = window.__tav.world, P = W.proj, [cx, cz] = P.project(ARGS.lat, ARGS.lon), R = ARGS.r || 150;
  const H = (x, z) => (W.heightAt ? W.heightAt(x, z) : 0);
  const ll = (x, z) => P.unproject(x, z).map((v) => +v.toFixed(6));
  const out = { float: [], trunkIn: [], thinBld: [], counts: {} };
  const tiles = [...(W.stream?.tiles.values() || [])];
  const sets = [W.furniture, ...tiles.map((t) => t.furniture)].filter(Boolean);
  for (const f of sets) {
    for (const [k, list] of Object.entries(f.items || {})) {
      for (const it of list) {
        if (Math.hypot(it.x - cx, it.z - cz) > R) continue;
        out.counts[k] = (out.counts[k] || 0) + 1;
        if (k === 'wallLamps' || k === 'terraces' || k === 'swan-lights') continue;
        const d = (it.y || 0) - H(it.x, it.z);
        if (Math.abs(d) > 0.5) out.float.push([k, +d.toFixed(2), ...ll(it.x, it.z)]);
      }
    }
  }
  const blds = tiles.flatMap((t) => t.buildingList || []).filter((b) => Math.hypot(b.inside[0] - cx, b.inside[1] - cz) < R + 50);
  const inRing = (x, z, r) => {
    let c = false;
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) if (r[i][1] > z !== r[j][1] > z && x < ((r[j][0] - r[i][0]) * (z - r[i][1])) / (r[j][1] - r[i][1]) + r[i][0]) c = !c;
    return c;
  };
  // 建物の中（中庭の穴は除く）
  const inside = (x, z) => blds.find((b) => x > b.bounds.minX && x < b.bounds.maxX && z > b.bounds.minZ && z < b.bounds.maxZ && inRing(x, z, b.outer) && !(b.holes || []).some((h) => inRing(x, z, h)));
  const trunks = [W.trees?.userData?.trunks || [], ...tiles.map((t) => t.group?.getObjectByName?.('trees')?.userData?.trunks || [])].flat();
  for (const [x, z] of trunks) {
    if (Math.hypot(x - cx, z - cz) > R) continue;
    const b = inside(x, z);
    if (b) out.trunkIn.push([...ll(x, z), Math.round(b.info.height)]);
  }
  for (const b of blds) {
    if (b.info.height < 6) continue;
    let minW = Infinity;
    // 外形の向きの付いた箱の短い辺（大まかに: 外接する箱の短い辺）
    minW = Math.min(b.bounds.maxX - b.bounds.minX, b.bounds.maxZ - b.bounds.minZ);
    if (minW < 1.5 && b.info.area < 30) out.thinBld.push([...ll(...b.inside), +minW.toFixed(2), Math.round(b.info.height)]);
  }
  out.float = out.float.slice(0, 40);
  out.trunkIn = out.trunkIn.slice(0, 40);
  return out;
})()
