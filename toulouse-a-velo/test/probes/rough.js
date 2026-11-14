// 道路の凸凹を数える: 走れる道（橋・トンネルを除く）の中心線を 2 m ごとに測り、
// 縦断面の折れ（3 点の 2 階差分 → 勾配の変化 %）と、横断方向の傾き（左右の端の高さの差 / 幅）の大きい所を返す
(() => {
  const s = window.__tav, W = s.world, T = W.terrain, P = W.proj;
  const top = (x, z) => (T.top ? T.top(x, z) : T.h(x, z));
  const CAR = new Set(['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'unclassified', 'residential', 'living_street', 'service', 'pedestrian', 'road', 'motorway_link', 'trunk_link', 'primary_link', 'secondary_link', 'tertiary_link', 'cycleway']);
  const kinks = [], tilts = [];
  let n = 0, sumK = 0, sumT = 0, bigK = 0, bigT = 0, km = 0;
  for (const r of W.parsed.roads) {
    if (r.bridge || r.tunnel || !CAR.has(r.type)) continue;
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
    for (let i = 1; i + 1 < S.length; i++) {
      const [x, z, ux, uz, d] = S[i];
      if (T.deck(x, z, Infinity) != null) continue; // 橋の下・上
      const k = Math.abs(H[i - 1] - 2 * H[i] + H[i + 1]) / d * 100; // 勾配の変化（%）
      const t = Math.abs(top(x - uz * half, z + ux * half) - top(x + uz * half, z - ux * half)) / (2 * half) * 100; // 横の傾き（%）
      n++; sumK += k; sumT += t; km += d / 1000;
      if (k > 4) { bigK++; kinks.push([+k.toFixed(1), r.name || r.type, ...P.unproject(x, z).map((v) => +v.toFixed(6)), r.type]); }
      if (t > 8) { bigT++; tilts.push([+t.toFixed(1), r.name || r.type, ...P.unproject(x, z).map((v) => +v.toFixed(6)), r.type]); }
    }
  }
  kinks.sort((a, b) => b[0] - a[0]);
  tilts.sort((a, b) => b[0] - a[0]);
  const uniq = (L) => { const seen = new Set(), o = []; for (const e of L) { const k = e[1] + Math.round(e[2] * 2000) + Math.round(e[3] * 2000); if (!seen.has(k)) { seen.add(k); o.push(e); } } return o; };
  return { km: +km.toFixed(1), n, meanKink: +(sumK / n).toFixed(3), meanTilt: +(sumT / n).toFixed(3), bigK, bigT, kinks: uniq(kinks).slice(0, 40), tilts: uniq(tilts).slice(0, 40) };
})()
