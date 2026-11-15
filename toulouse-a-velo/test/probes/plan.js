// 平面図: 地形の格子の高さ（色）・岸壁の線（赤、短い線は下の段の向き）・道（車道は黒、ほかは種類ごとの色）・橋（紫）・木（緑の点）
// 使い方: (ARGS = { lat, lon, r: 半径 m, px: 画像の大きさ }) を前に付けて評価する
(() => {
  const s = window.__tav, W = s.world, T = W.terrain, P = W.proj;
  const [cx, cz] = P.project(ARGS.lat, ARGS.lon), R = ARGS.r || 80, N = ARGS.px || 1200, k = N / (2 * R);
  const cv = document.createElement('canvas');
  cv.width = cv.height = N;
  const c = cv.getContext('2d');
  const X = (x) => (x - cx + R) * k, Z = (z) => (z - cz + R) * k;
  // 高さ
  let lo = Infinity, hi = -Infinity;
  const step = Math.max(0.5, (2 * R) / 400);
  const hs = [];
  for (let z = cz - R; z < cz + R; z += step) for (let x = cx - R; x < cx + R; x += step) { const h = T.h(x, z); hs.push(h); if (h < lo) lo = h; if (h > hi) hi = h; }
  let i = 0;
  for (let z = cz - R; z < cz + R; z += step) for (let x = cx - R; x < cx + R; x += step) {
    const t = (hs[i++] - lo) / Math.max(0.01, hi - lo);
    c.fillStyle = `hsl(${220 - 220 * t}, 60%, ${45 + 25 * Math.abs(Math.sin(hs[i - 1] * Math.PI))}%)`;
    c.fillRect(X(x), Z(z), step * k + 1, step * k + 1);
  }
  // 水
  const inW = W.collision.inWater;
  c.fillStyle = 'rgba(40,70,160,0.55)';
  for (let z = cz - R; z < cz + R; z += step * 2) for (let x = cx - R; x < cx + R; x += step * 2) if (inW(x, z)) c.fillRect(X(x), Z(z), step * 2 * k + 1, step * 2 * k + 1);
  // 格子点
  const g = T.near;
  if (k > 2) {
    c.fillStyle = 'rgba(0,0,0,0.5)';
    for (let r = Math.ceil(g.az * (cz - R) + g.bz); r <= g.az * (cz + R) + g.bz; r++) for (let cc = Math.ceil(g.ax * (cx - R) + g.bx); cc <= g.ax * (cx + R) + g.bx; cc++) {
      const x = (cc - g.bx) / g.ax, z = (r - g.bz) / g.az;
      c.fillRect(X(x) - 1, Z(z) - 1, 2, 2);
      if (k > 7) { c.font = '9px sans-serif'; c.fillText((g.data[r * g.cols + cc] - 145).toFixed(1), X(x) + 2, Z(z) - 2); }
    }
  }
  const COL = { footway: '#fff', path: '#ff0', cycleway: '#0f0', steps: '#f0f', pedestrian: '#fa0', service: '#888', living_street: '#444' };
  for (const r of W.parsed.roads) {
    if (!r.pts.some(([x, z]) => Math.abs(x - cx) < R + 30 && Math.abs(z - cz) < R + 30)) continue;
    c.strokeStyle = r.bridge ? '#a0f' : COL[r.type] || '#000';
    c.lineWidth = Math.max(1, (r.width || 2) * k * (r.bridge || !COL[r.type] ? 1 : 0.25));
    c.globalAlpha = r.bridge || !COL[r.type] ? 0.35 : 0.9;
    c.beginPath();
    r.pts.forEach(([x, z], j) => (j ? c.lineTo(X(x), Z(z)) : c.moveTo(X(x), Z(z))));
    c.stroke();
    c.globalAlpha = 1;
    if (ARGS.names && r.name) { const m = r.pts[r.pts.length >> 1]; c.fillStyle = '#000'; c.font = '11px sans-serif'; c.fillText(r.name + ' ' + r.type, X(m[0]), Z(m[1])); }
  }
  for (const q of T.quayWalls || []) {
    c.strokeStyle = q.fixed ? '#f80' : '#f00';
    c.lineWidth = 2.5;
    c.beginPath(); c.moveTo(X(q.ax), Z(q.az)); c.lineTo(X(q.bx), Z(q.bz)); c.stroke();
    const mx = (q.ax + q.bx) / 2, mz = (q.az + q.bz) / 2;
    c.lineWidth = 1;
    c.beginPath(); c.moveTo(X(mx), Z(mz)); c.lineTo(X(mx + q.nx * 2), Z(mz + q.nz * 2)); c.stroke();
    c.strokeStyle = 'rgba(255,0,0,0.35)';
    c.beginPath(); c.moveTo(X(q.ax - q.nx * (q.wa || 0)), Z(q.az - q.nz * (q.wa || 0))); c.lineTo(X(q.bx - q.nx * (q.wb || 0)), Z(q.bz - q.nz * (q.wb || 0))); c.stroke();
  }
  c.fillStyle = '#063';
  for (const [x, z] of W.trees?.userData.trunks || []) c.fillRect(X(x) - 2, Z(z) - 2, 4, 4);
  c.fillStyle = '#000'; c.font = '14px sans-serif';
  c.fillText(`y ${lo.toFixed(1)}…${hi.toFixed(1)}  1 px = ${(1 / k).toFixed(2)} m  N↑`, 8, 16);
  return cv.toDataURL('image/png');
})()
