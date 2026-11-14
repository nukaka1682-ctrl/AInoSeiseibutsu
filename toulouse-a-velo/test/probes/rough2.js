(() => {
  const s = window.__tav, W = s.world, T = W.terrain;
  const top = (x, z) => (T.top ? T.top(x, z) : T.h(x, z));
  const by = {};
  for (const r of W.parsed.roads) {
    if (r.bridge || r.tunnel || r.type === 'steps') continue;
    const S = [];
    for (let i = 0; i + 1 < r.pts.length; i++) {
      const [ax, az] = r.pts[i], [bx, bz] = r.pts[i + 1], L = Math.hypot(bx - ax, bz - az);
      if (L < 0.01) continue;
      const m = Math.max(1, Math.round(L / 2));
      for (let k = 0; k < m; k++) S.push([ax + ((bx - ax) * k) / m, az + ((bz - az) * k) / m, (bx - ax) / L, (bz - az) / L, L / m]);
    }
    if (S.length < 4) continue;
    const half = Math.max(1, (r.width || 4) / 2 - 0.3);
    const H = S.map(([x, z]) => top(x, z));
    const b = (by[r.type] ||= { n: 0, k2: 0, k4: 0, k8: 0, t4: 0, t8: 0, t15: 0, wall: 0 });
    for (let i = 1; i + 1 < S.length; i++) {
      const [x, z, ux, uz, d] = S[i];
      if (T.deck(x, z, Infinity) != null) continue;
      const k = Math.abs(H[i - 1] - 2 * H[i] + H[i + 1]) / d * 100;
      const t = Math.abs(top(x - uz * half, z + ux * half) - top(x + uz * half, z - ux * half)) / (2 * half) * 100;
      b.n++;
      if (k > 60 || t > 60) { b.wall++; continue; }
      if (k > 2) b.k2++; if (k > 4) b.k4++; if (k > 8) b.k8++;
      if (t > 4) b.t4++; if (t > 8) b.t8++; if (t > 15) b.t15++;
    }
  }
  return by;
})()
