// node test/probes/around.mjs x,z [x,z …]  → その点のまわりの道・岸壁の壁・高さ
import { loadWorld } from './node-world.mjs';
import { closestOnSegment } from '../../src/geo.js';
const w = await loadWorld(process.env.AREA || 'centre');
const T = w.terrain;
for (const a of process.argv.slice(2)) {
  const [x, z] = a.split(',').map(Number);
  console.log(`\n== (${x}, ${z}) ${w.proj.unproject(x, z).map((v) => v.toFixed(6)).join(', ')}  h=${T.h(x, z).toFixed(2)} top=${T.top(x, z).toFixed(2)}`);
  for (const r of w.parsed.roads) {
    let best = Infinity;
    for (let i = 0; i + 1 < r.pts.length; i++) best = Math.min(best, closestOnSegment(x, z, ...r.pts[i], ...r.pts[i + 1]).d2);
    if (best < 144) console.log(`  道 ${Math.sqrt(best).toFixed(1)} m  ${r.type} ${r.name || ''} w=${r.width} ${r.bridge ? '橋' : ''}${r.tunnel ? 'tun' : ''} layer=${r.layer || 0} 点 ${r.pts.length}`);
  }
  for (const q of T.quayWalls) {
    const c = closestOnSegment(x, z, q.ax, q.az, q.bx, q.bz);
    if (c.d2 < 64) console.log(`  壁 ${Math.sqrt(c.d2).toFixed(1)} m  (${q.ax.toFixed(1)},${q.az.toFixed(1)})-(${q.bx.toFixed(1)},${q.bz.toFixed(1)}) 上 ${q.at.toFixed(1)} 下 ${q.ab.toFixed(1)} ${q.cliff ? 'cliff' : 'manual'}`);
  }
}
// 当たり判定（円 = 木の幹・小物、線分 = 壁）と水
for (const a of process.argv.slice(2)) {
  const [x, z] = a.split(',').map(Number), C = w.collision;
  console.log(`\n== 当たり (${x}, ${z}) 水 ${C.inWater(x, z)} 道 ${C.onRoad(x, z)}`);
  for (const [cx, cz, r] of C.circles) if (Math.hypot(cx - x, cz - z) < 5) console.log(`  円 ${Math.hypot(cx - x, cz - z).toFixed(1)} m (${cx.toFixed(1)}, ${cz.toFixed(1)}) r=${r}`);
  for (const [ax, az, bx, bz] of C.segs) { const c = closestOnSegment(x, z, ax, az, bx, bz); if (c.d2 < 16) console.log(`  線 ${Math.sqrt(c.d2).toFixed(1)} m (${ax.toFixed(1)},${az.toFixed(1)})-(${bx.toFixed(1)},${bz.toFixed(1)})`); }
  for (let d = -6; d <= 6; d += 2) console.log('  h', [-6, -4, -2, 0, 2, 4, 6].map((e) => T.top(x + e, z + d).toFixed(1)).join(' '));
}
