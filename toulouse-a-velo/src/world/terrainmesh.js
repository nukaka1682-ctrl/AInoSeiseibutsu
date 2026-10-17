// 地形のメッシュ: 500 m のタイル（ブロック）ごとの地面（5 m の格子の三角形そのもの）と、遠くの地面（エリアの外まで 1 枚）。
// 川・運河の穴: 地面を先に（ステンシルなしで）描いて深度を書き、そのあと水域の形（地面と同じ面）を深度テスト付きで描いて、
// 見えている水の所（手前の土手・岸壁・丘に隠れていない所）にステンシル 1 を書く。2 回目でその所の深度を一番奥に戻し、
// 水面・岸壁・橋脚が地面の色の上に描かれるようにする（地面の覆い・緑地・道路はステンシルで水の所に描かない）。
import * as THREE from 'three';
import { MeshWriter } from './meshwriter.js';
import { extendHeights } from './terraincond.js';

export const TERRAIN_ORDER = { far: -40.5, ground: -40, mask: -39.9, maskReset: -39.8 };
const KEEP = THREE.KeepStencilOp;
const stencil = (func) => ({ stencilWrite: true, stencilRef: 1, stencilFunc: func, stencilFail: KEEP, stencilZFail: KEEP, stencilZPass: KEEP });

// 岸壁や土手の急な斜面の色（地面のテクスチャに掛ける）。旧市街のまわりの川岸はレンガ、外はコンクリートと土
const STEEP = { brick: [0.95, 0.66, 0.5], grey: [0.78, 0.76, 0.72] };

export function createTerrainMaterials(groundMat) {
  const ground = groundMat.clone();
  ground.stencilWrite = false;
  const maskReset = new THREE.ShaderMaterial({
    vertexShader: 'void main() { gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: 'void main() { gl_FragDepth = 1.0; }',
    colorWrite: false,
    depthWrite: true,
    depthFunc: THREE.AlwaysDepth,
    ...stencil(THREE.EqualStencilFunc),
  });
  // 遠くの地面: 地面の材質に頂点カラー（丘の木々・街のくすんだ色）と、読み込んだタイルの中を描かないシェーダーを足す
  const tileMask = new THREE.DataTexture(new Uint8Array(1), 1, 1, THREE.RedFormat);
  tileMask.magFilter = THREE.NearestFilter;
  tileMask.minFilter = THREE.NearestFilter;
  tileMask.needsUpdate = true;
  const uniforms = { tileMask: { value: tileMask }, tileRect: { value: new THREE.Vector4(0, 0, 0, 0) }, tileMax: { value: new THREE.Vector2(0, 0) } };
  const patch = (m, key) => {
    m.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, uniforms);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec2 vFarPos;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvFarPos = (modelMatrix * vec4(transformed, 1.0)).xz;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying vec2 vFarPos;\nuniform sampler2D tileMask;\nuniform vec4 tileRect;\nuniform vec2 tileMax;')
        .replace('void main() {', 'void main() {\n  vec2 tmUv = (vFarPos - tileRect.xy) * tileRect.zw;\n  if (tmUv.x >= 0.0 && tmUv.y >= 0.0 && vFarPos.x < tileMax.x && vFarPos.y < tileMax.y && texture2D(tileMask, tmUv).r > 0.5) discard;');
    };
    m.customProgramCacheKey = () => key;
    return m;
  };
  const far = patch(ground.clone(), 'far-ground');
  // 遠くの地面だけの霧: 900 m（読み込んだタイルの縁）までは建物・タイルの地面と同じ。その先は霧の終わりを 2.5 km で 3.5 倍まで
  // 遠ざけ、少し青い霞の色に（平らな所は霞に沈み、ジョリモン・ペシュ・ダヴィッドの丘の稜線が浮かぶ）。
  // 4〜4.95 km で高さによらず霞に消す（遠くの地面の縁は街の範囲の外 5 km。カメラからは必ず 5 km より遠い）。
  // そこでは青い霞の色も霧の色（空の地平線の色）に戻し、地平線に青い帯が残らないように
  const farFog = far.onBeforeCompile;
  far.onBeforeCompile = (shader) => {
    farFog(shader);
    shader.fragmentShader = shader.fragmentShader.replace('#include <fog_fragment>', `#ifdef USE_FOG
  float farT = smoothstep( 900.0, 2500.0, vFogDepth );
  float edgeT = smoothstep( 4000.0, 4950.0, vFogDepth );
  float fogFactor = max( smoothstep( fogNear, fogFar * ( 1.0 + 2.5 * farT ), fogPath( vFogDepth ) ), edgeT );
  gl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor * mix( vec3( 1.0 ), vec3( 0.9, 0.94, 1.0 ), farT * ( 1.0 - edgeT ) ), fogFactor );
#endif`);
  };
  far.vertexColors = true;
  return { ground, maskReset, far, farUniforms: uniforms };
}

// 1 枚のタイル（範囲 b）の地面。geometry は地面の覆い（cover.js）と共有する
export function buildTerrainTile(terrain, b, mats, { quayCentre = null, quayRadius = 1250, skirt = 8, inWater = () => false } = {}) {
  const w = new MeshWriter({ drape: terrain, tol: 0 }); // 格子の三角形そのもの
  const uv = (x, z) => [x / 6, -z / 6];
  w.quad([b.minX, 0, b.minZ], [b.maxX, 0, b.minZ], [b.maxX, 0, b.maxZ], [b.minX, 0, b.maxZ], [0, 1, 0],
    uv(b.minX, b.minZ), uv(b.maxX, b.minZ), uv(b.maxX, b.maxZ), uv(b.minX, b.maxZ), [1, 1, 1]);
  // 急な斜面（岸壁・土手・切り通し）は石・レンガの色に
  for (let i = 0; i < w.nor.length; i += 3) {
    const ny = w.nor[i + 1];
    if (ny > 0.8) continue;
    const k = Math.min(1, (0.8 - ny) / 0.25);
    const x = w.pos[i], z = w.pos[i + 2];
    const c = quayCentre && Math.hypot(x - quayCentre[0], z - quayCentre[1]) < quayRadius ? STEEP.brick : STEEP.grey;
    for (let j = 0; j < 3; j++) w.col[i + j] = 1 + (c[j] - 1) * k;
  }
  // タイルの縁の垂れ幕（地面の縁から skirt m 下まで）: 読み込んでいない隣は 80 m の格子の遠くの地面なので、丘では高さが
  // 数 m 違い、縁にすき間が見える。地面と同じ材質・同じ形にまとめる（描画の回数は増えない）
  const sk = new MeshWriter({ map: (x, y, z) => terrain.h(x, z) + y, maxEdge: 5 });
  const C = [[b.minX, b.minZ], [b.maxX, b.minZ], [b.maxX, b.maxZ], [b.minX, b.maxZ]];
  for (let i = 0; i < 4; i++) {
    const [ax, az] = C[i], [bx, bz] = C[(i + 1) % 4], L = Math.hypot(bx - ax, bz - az);
    const n = [(bz - az) / L, 0, -(bx - ax) / L]; // 外向き（周回は z が南向きで時計回り）
    const m = Math.ceil(L / 5);
    for (let j = 0; j < m; j++) {
      const p = [ax + ((bx - ax) * j) / m, az + ((bz - az) * j) / m], q = [ax + ((bx - ax) * (j + 1)) / m, az + ((bz - az) * (j + 1)) / m];
      if (inWater((p[0] + q[0]) / 2, (p[1] + q[1]) / 2)) continue; // 川の上は垂らさない（水の穴の中に見えないように）
      sk.quad([p[0], 0, p[1]], [q[0], 0, q[1]], [q[0], -skirt, q[1]], [p[0], -skirt, p[1]], n, uv(...p), uv(...q), uv(...q), uv(...p), [0.85, 0.83, 0.8]);
    }
  }
  for (const k of ['pos', 'nor', 'uv', 'col']) for (const v of sk[k]) w[k].push(v);
  const geometry = w.toGeometry();
  const group = new THREE.Group();
  group.name = 'terrain';
  const m = new THREE.Mesh(geometry, mats.terrain.ground);
  m.renderOrder = TERRAIN_ORDER.ground;
  m.receiveShadow = true;
  m.name = 'terrain-ground';
  m.matrixAutoUpdate = false;
  group.add(m);
  return { group, geometry, mesh: m };
}

// 遠くの地面（rect の外 margin m まで、step m の格子）。近くの格子の中はその高さ（川の上は岸から延ばした高さ）、外は遠くの格子。
// 読み込んだタイルの中は描かない（setTile）。丘の上（+20 m より上）と斜面は木々の暗い緑、平らな所は街のくすんだ色
// inWater(x, z): 水の上か（水の上の点は水面より下に下げて、遠くの川の穴を地面がふさがないように）
export function buildFarTerrain(terrain, rect, mats, layout, { margin = 5000, step = 80, inWater = () => false } = {}) {
  const minX = Math.floor((rect.minX - margin) / step) * step, maxX = Math.ceil((rect.maxX + margin) / step) * step;
  const minZ = Math.floor((rect.minZ - margin) / step) * step, maxZ = Math.ceil((rect.maxZ + margin) / step) * step;
  const nx = Math.round((maxX - minX) / step) + 1, nz = Math.round((maxZ - minZ) / step) + 1;
  const pos = new Float32Array(nx * nz * 3), col = new Float32Array(nx * nz * 3), uv = new Float32Array(nx * nz * 2);
  const ys = new Float32Array(nx * nz);
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const x = minX + i * step, z = minZ + j * step, k = j * nx + i;
      // 近くの格子の端から 300 m かけて遠くの格子に移る
      let y;
      if (terrain.inNear(x, z, 300)) y = terrain.h(x, z);
      else if (terrain.inNear(x, z, 0)) {
        let d = 300;
        while (d > 0 && !terrain.inNear(x, z, d)) d -= 50;
        const t = d / 300;
        y = terrain.h(x, z) * t + terrain.hFar(x, z) * (1 - t);
      } else y = terrain.hFar(x, z);
      ys[k] = y;
    }
  }
  // 測った範囲の外（NaN）は縁の高さから地方の平均へ移る丘で埋める（平らな 0 m の台地にしない）
  extendHeights(ys, nx, nz, step, minX, minZ);
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const x = minX + i * step, z = minZ + j * step, k = j * nx + i;
      if (inWater(x, z)) ys[k] = Math.min(ys[k], terrain.waterLevel(x, z) - 1.5);
      pos.set([x, ys[k], z], k * 3);
      uv.set([x / 6, -z / 6], k * 2);
    }
  }
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      const yx = ys[j * nx + Math.min(nx - 1, i + 1)] - ys[j * nx + Math.max(0, i - 1)];
      const yz = ys[Math.min(nz - 1, j + 1) * nx + i] - ys[Math.max(0, j - 1) * nx + i];
      const slope = Math.hypot(yx, yz) / (2 * step);
      const x = minX + i * step, z = minZ + j * step;
      const inside = x > rect.minX && x < rect.maxX && z > rect.minZ && z < rect.maxZ;
      // 木々の多さ（丘の上・斜面ほど多い。エリアの中の丘は住宅地なので半分）
      const wood = Math.min(1, Math.max(0, (ys[k] - 15) / 30) + slope * 6) * (inside ? 0.5 : 0.9);
      const c = [0.86 + (0.5 - 0.86) * wood, 0.84 + (0.6 - 0.84) * wood, 0.8 + (0.42 - 0.8) * wood];
      col.set(c, k * 3);
    }
  }
  const idx = [];
  for (let j = 0; j + 1 < nz; j++) {
    for (let i = 0; i + 1 < nx; i++) {
      const a = j * nx + i, b = a + 1, c = a + nx, d = c + 1;
      idx.push(a, c, d, a, d, b);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  g.computeBoundingSphere();
  const group = new THREE.Group();
  group.name = 'far-terrain';
  const m = new THREE.Mesh(g, mats.terrain.far);
  m.renderOrder = TERRAIN_ORDER.far;
  m.receiveShadow = true;
  m.name = 'far-ground';
  group.add(m);
  // 読み込んだタイルの印（タイル 1 枚 = 1 画素）
  const cols = layout.cols, rows = layout.rows;
  const data = new Uint8Array(cols * rows);
  const tex = new THREE.DataTexture(data, cols, rows, THREE.RedFormat);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.flipY = false;
  tex.needsUpdate = true;
  const u = mats.terrain.farUniforms;
  u.tileMask.value = tex;
  u.tileRect.value.set(layout.rect.minX, layout.rect.minZ, 1 / (cols * layout.size), 1 / (rows * layout.size));
  u.tileMax.value.set(layout.rect.maxX, layout.rect.maxZ);
  const setTile = (i, j, on) => {
    data[j * cols + i] = on ? 255 : 0;
    tex.needsUpdate = true;
  };
  return { group, setTile };
}

// 三角形の集まり（index なし）を、重心の入る size m 四方のマスごとに分ける（マスごとのメッシュは見えないとき描かない）
export function splitGeometry(geo, size) {
  const pos = geo.getAttribute('position').array;
  const names = Object.keys(geo.attributes);
  const cells = new Map();
  for (let t = 0; t < pos.length / 9; t++) {
    const cx = (pos[t * 9] + pos[t * 9 + 3] + pos[t * 9 + 6]) / 3, cz = (pos[t * 9 + 2] + pos[t * 9 + 5] + pos[t * 9 + 8]) / 3;
    const key = `${Math.floor(cx / size)},${Math.floor(cz / size)}`;
    let l = cells.get(key);
    if (!l) cells.set(key, (l = []));
    l.push(t);
  }
  if (cells.size <= 1) return [geo];
  const out = [];
  for (const tris of cells.values()) {
    const g = new THREE.BufferGeometry();
    for (const name of names) {
      const a = geo.getAttribute(name), n = a.itemSize, src = a.array;
      const dst = new Float32Array(tris.length * 3 * n);
      tris.forEach((t, i) => dst.set(src.subarray(t * 3 * n, (t + 1) * 3 * n), i * 3 * n));
      g.setAttribute(name, new THREE.BufferAttribute(dst, n));
    }
    g.computeBoundingSphere();
    g.computeBoundingBox();
    out.push(g);
  }
  geo.dispose();
  return out;
}
