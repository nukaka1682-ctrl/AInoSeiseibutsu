(() => {
  const s = window.__tav, W = s.world, T = W.terrain, P = W.proj;
  const top = (x, z) => (T.top ? T.top(x, z) : T.h(x, z));
  const out = [];
  for (const r of W.parsed.roads) {
    if (r.bridge || r.tunnel || r.type !== 'cycleway') continue;
    const S = [];
    for (let i = 0; i + 1 < r.pts.length; i++) {
      const [ax, az] = r.pts[i], [bx, bz] = r.pts[i + 1], L = Math.hypot(bx - ax, bz - az);
      if (L < 0.01) continue;
      const m = Math.max(1, Math.round(L / 2));
      for (let k = 0; k < m; k++) S.push([ax + ((bx - ax) * k) / m, az + ((bz - az) * k) / m, L / m]);
    }
    const H = S.map(([x, z]) => top(x, z));
    for (let i = 1; i + 1 < S.length; i++) {
      const [x, z, d] = S[i];
      if (T.deck(x, z, Infinity) != null) continue;
      const k = Math.abs(H[i - 1] - 2 * H[i] + H[i + 1]) / d * 100;
      if (k > 4 && k < 40) {
        // まわりの道
        const near = [];
        for (const o of W.parsed.roads) { if (o === r) continue; for (let j = 0; j + 1 < o.pts.length; j++) { const [ax, az] = o.pts[j], [bx, bz] = o.pts[j + 1]; const dx = bx - ax, dz = bz - az, L2 = dx * dx + dz * dz || 1, t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / L2)); const dd = Math.hypot(ax + dx * t - x, az + dz * t - z); if (dd < 8) { near.push(`${o.type}${o.bridge ? '(橋)' : ''}${o.tunnel ? '(tun)' : ''}:${dd.toFixed(0)}`); break; } } }
        out.push([+k.toFixed(0), r.name || '', ...P.unproject(x, z).map((v) => +v.toFixed(5)), [...new Set(near)].slice(0, 5).join(' '), T.inCliffCell?.(x, z) ? 'cliff' : '', H.slice(i - 1, i + 2).map((v) => v.toFixed(2)).join('/')]);
      }
    }
  }
  return { n: out.length, sample: out.filter((_, i) => i % Math.ceil(out.length / 30) === 0) };
})()
