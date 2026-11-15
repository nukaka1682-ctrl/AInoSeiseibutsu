import { loadWorld } from './node-world.mjs';
const w = await loadWorld('centre');
const [x, z] = process.argv[2].split(',').map(Number);
const C = w.collision, T = w.terrain;
console.log('resolve', JSON.stringify(C.resolve(x, z, 0.35)), 'water', C.blockedByWater(x, z, T.top(x, z)), 'oob', C.outOfBounds(x, z));
for (let a = 0; a < 8; a++) {
  const ux = Math.cos(a * Math.PI / 4), uz = Math.sin(a * Math.PI / 4);
  const S = w.rideY(x, z, T.top(x, z)), Sa = w.rideY(x + ux, z + uz, S);
  console.log(a * 45, 'ΔS', (Sa - S).toFixed(2), 'onRoad', w.roadnet.onRoad(x + ux * 0.1, z + uz * 0.1, 0.5), 'deck', T.deck(x, z, S), T.deck(x + ux, z + uz, S), 'cliffCell', T.inCliffCell?.(x + ux, z + uz), 'res', C.resolve(x + ux * 0.1, z + uz * 0.1, 0.35).hit);
}
