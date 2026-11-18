// 点のまわりの物を数える: 街の小物（種類ごと）・木の幹・名所のモデル・建物。ARGS = { lat, lon, r }
(() => {
  const s = window.__tav, W = s.world, P = W.proj, [cx, cz] = P.project(ARGS.lat, ARGS.lon), R = ARGS.r || 15;
  const out = { furniture: {}, trunks: 0, groups: [] };
  const sets = [W.furniture, ...[...(W.stream?.tiles.values() || [])].map((t) => t.furniture)].filter(Boolean);
  for (const f of sets) {
    for (const [k, list] of Object.entries(f.items || {})) {
      for (const it of list) {
        const d = Math.hypot(it.x - cx, it.z - cz);
        if (d > R) continue;
        (out.furniture[k] ||= []).push([+((it.x - cx).toFixed(1)), +((it.z - cz).toFixed(1)), +(it.y || 0).toFixed(1), +(it.sy || 1).toFixed(2)]);
      }
    }
  }
  // 描画されている物の中で、点の近くにある大きな物（メッシュの名前と、点の近くの頂点の高さの範囲）
  const v = new window.__tavDebug.THREE.Vector3();
  window.__tavDebug.scene.traverse((o) => {
    if (!o.isMesh || !o.geometry?.attributes?.position || o.isInstancedMesh) return;
    const p = o.geometry.attributes.position;
    let n = 0, y0 = Infinity, y1 = -Infinity;
    for (let i = 0; i < p.count; i += 3) {
      v.fromBufferAttribute(p, i).applyMatrix4(o.matrixWorld);
      if (Math.abs(v.x - cx) < R && Math.abs(v.z - cz) < R) {
        n++;
        y0 = Math.min(y0, v.y);
        y1 = Math.max(y1, v.y);
      }
    }
    if (n) out.groups.push([o.name || o.parent?.name || '?', n, +y0.toFixed(1), +y1.toFixed(1)]);
  });
  out.groups.sort((a, b) => b[1] - a[1]);
  out.groups = out.groups.slice(0, 25);
  return out;
})()
