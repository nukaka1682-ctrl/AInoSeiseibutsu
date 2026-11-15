import { loadWorld } from './node-world.mjs';
import { closestOnSegment } from '../../src/geo.js';
const w = await loadWorld('centre'), T = w.terrain;
const [x, z, R = 25] = process.argv[2].split(',').map(Number);
for (const r of w.parsed.roads) {
  const near = r.pts.map((p, i) => [i, p]).filter(([, p]) => Math.hypot(p[0] - x, p[1] - z) < R);
  if (near.length && (r.type === 'cycleway' || r.type === 'path' || r.type === 'footway')) console.log(r.type, r.name || '', 'w', r.width, near.map(([i, p]) => `${i}:(${p[0].toFixed(1)},${p[1].toFixed(1)} h${T.top(p[0], p[1]).toFixed(1)})`).join(' '));
}
const ws = T.quayWalls.filter((q) => closestOnSegment(x, z, q.ax, q.az, q.bx, q.bz).d2 < R * R);
console.log('壁', ws.length);
for (const q of ws) console.log(`  (${q.ax.toFixed(1)},${q.az.toFixed(1)})-(${q.bx.toFixed(1)},${q.bz.toFixed(1)}) 上${q.at.toFixed(1)} 下${q.ab.toFixed(1)} n(${q.nx.toFixed(2)},${q.nz.toFixed(2)})`);
