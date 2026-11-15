// 本物の地図データでゲームの世界を Node で組み立てる（描画なし。test/autopilot.mjs と同じ）。調べ物のスクリプトから使う:
//   import { loadWorld } from './node-world.mjs'; const w = await loadWorld('centre');
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { areaFrame, assembleWorld } from '../../src/world/assemble.js';
import { Terrain, decodeTerrain } from '../../src/world/terrain.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export async function loadWorld(area = 'centre') {
  const data = JSON.parse(await readFile(join(root, 'public', 'data', `${area}.json`), 'utf8'));
  const noTex = new Proxy({}, { get: () => null });
  const { createBuildingMaterials } = await import('../../src/world/buildings.js');
  const { createGroundMaterials } = await import('../../src/world/ground.js');
  const terrain = new Terrain(await decodeTerrain(await readFile(join(root, 'public', 'data', `${area}-terrain.bin`))), areaFrame(data.bbox).proj);
  const w = await assembleWorld({ ...data, source: 'test' }, data.bbox, { buildingMats: createBuildingMaterials(noTex), groundMats: createGroundMaterials(noTex), terrain });
  w.terrain ||= terrain;
  return w;
}
