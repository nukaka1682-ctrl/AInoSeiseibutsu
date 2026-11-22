// 点のまわりの建物の情報（高さ・屋根・種類・面積・名前）。ARGS = { lat, lon, r }
(() => {
  const W = window.__tav.world, P = W.proj, [cx, cz] = P.project(ARGS.lat, ARGS.lon), R = ARGS.r || 30;
  const blds = W.parsed.buildings?.length ? W.parsed.buildings : [...(W.stream?.tiles.values() || [])].flatMap((t) => t.buildingList || []);
  return blds.filter((b) => Math.hypot(b.inside[0] - cx, b.inside[1] - cz) < R).map((b) => ({
    d: +Math.hypot(b.inside[0] - cx, b.inside[1] - cz).toFixed(1), id: b.id, at: P.unproject(...b.inside).map((v) => +v.toFixed(6)),
    area: Math.round(b.info.area), h: +b.info.height.toFixed(1), minH: b.info.minHeight, roofH: b.info.roofHeight, roof: b.info.roofShape, kind: b.info.kind, church: b.info.isChurch, levels: b.info.levels,
    style: b.style, tags: Object.fromEntries(Object.entries(b.tags || {}).filter(([k]) => !/^source|^ref/.test(k))), n: b.outer.length,
  })).sort((a, b) => a.d - b.d);
})()
