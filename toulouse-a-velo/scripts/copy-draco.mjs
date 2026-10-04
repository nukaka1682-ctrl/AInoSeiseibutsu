// three.js 付属の Draco デコーダー（実写 3D タイルの圧縮を展開する）を public/draco/ にコピーする。
// npm run dev / build の前に自動で実行される。
import { copyFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'node_modules', 'three', 'examples', 'jsm', 'libs', 'draco', 'gltf');
const dst = join(root, 'public', 'draco');
await mkdir(dst, { recursive: true });
for (const f of ['draco_decoder.js', 'draco_decoder.wasm', 'draco_wasm_wrapper.js']) await copyFile(join(src, f), join(dst, f));
