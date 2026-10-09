// 地面の覆い（data/cover.js で 1 m ごとに分類したもの）を描く。タイル（またはブロック）ごとに 1 枚の板で、
// 種類の格子を「種類ごとの重み」の RGBA テクスチャ（R = 公道・広場、G = 敷地の中の地面、B = 芝生、A = 木の下）にして、
// シェーダーで種類ごとの繰り返しテクスチャを混ぜる。境目は 1 m の格子が見えないよう、ノイズでずらして柔らかくぼかす。
// - 公道・広場: 旧市街はばら色がかった花崗岩・石灰岩の石畳、外は明るい灰色の舗装
// - 敷地の中の地面（中庭・車寄せ・駐車場・新しい街区の道・工場の敷地・墓地）: ほとんどは灰色のアスファルトとコンクリートで、
//   ところどころ（2 割ほど）ベージュの砂利。旧市街の中庭は石畳が多い
// - 芝生: 緑〜夏に乾いた黄緑
// - 木の下: 暗い草と土
// - 舗石（読み込むときに足す種類 PAVED: 並木道の下・並木道の広場。data/cover.js の stampCover・paveAllees）:
//   灰色のコンクリートの舗石（20 × 10 cm、互い違い）。テクスチャでは R だけ半分の値にして、4 つの合計の不足分から割合を戻す
// 地面の板（ground.js）の上、緑地・道路の下に、地面の板と同じステンシル（川の穴）で描く。
import * as THREE from 'three';
import { PAVED, coverStamps, decodeCover, paveAllees, stampCover } from '../data/cover.js';

const SEG = 20; // 板の分割数（頂点ごとの「旧市街か」を補間するため）

// 掛け合わせる色（テクスチャの色に掛ける）。写真: キャピトル広場のばら色の花崗岩 #a39283〜#b18e71（石畳のテクスチャは
// 目地が暗いので、旧市街では白に 25 % 寄せてから掛ける）、歩道の灰色の舗装、中庭・駐車場の灰色のアスファルト（歩道の
// テクスチャを暗くしたもの）とコンクリート、並木道の灰色のコンクリートの舗石。old は覆いのない所の旧市街の広場（ground.js）にも使う
export const COVER_COLORS = {
  old: '#f2dcc6', public: '#c6c0b8', asphalt: '#a4a4a6', gravel: '#d6d0c6', concrete: '#f2f3f5',
  lawn: '#c9d6a6', dry: '#e6dba0', shade: '#7f8a62', earth: '#a08d78', pavers: '#d8d5cf',
};
// 舗石のマスの R の値（他の 3 つは 0）。合計が 1 に足りない分 ×1/(1 − 値) が舗石の割合（線形補間・ミップマップでも成り立つ）
export const PAVED_LEVEL = 128;

// 共有のテクスチャと色（main.js の textures から）。order: 描く順番（ground.js の ORDER.cover）
export function createCoverShared(tex, order) {
  const u = {
    tPaving: { value: tex.paving }, tSidewalk: { value: tex.sidewalk }, tGravel: { value: tex.gravel },
    tGround: { value: tex.ground }, tGrass: { value: tex.grass },
  };
  for (const [k, hex] of Object.entries(COVER_COLORS)) u[`c_${k}`] = { value: new THREE.Color(hex) };
  return { uniforms: u, order };
}

// 種類の格子 → 重みの RGBA テクスチャ（ミップマップで遠くは平均の色になる）。舗石（PAVED）は R = PAVED_LEVEL だけ
export function coverTexture({ cols, rows, data }) {
  const px = new Uint8Array(cols * rows * 4);
  for (let i = 0; i < data.length; i++) {
    if (data[i] === PAVED) px[i * 4] = PAVED_LEVEL;
    else px[i * 4 + Math.min(3, data[i])] = 255;
  }
  const t = new THREE.DataTexture(px, cols, rows, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.anisotropy = 4;
  t.needsUpdate = true;
  return t;
}

const NOISE = /* glsl */ `
varying vec2 vCoverPos;
varying float vOldTown;
uniform sampler2D coverMap, tPaving, tSidewalk, tGravel, tGround, tGrass;
uniform vec4 coverRect;
uniform vec3 c_old, c_public, c_asphalt, c_gravel, c_concrete, c_lawn, c_dry, c_shade, c_earth, c_pavers;
float cvHash(vec2 p) {
  // sin を使わない格子点のハッシュ（大きな座標でも GPU ごとの差が出にくい）
  p = 50.0 * fract(p * 0.3183099 + vec2(0.71, 0.113));
  return fract(p.x * p.y * (p.x + p.y));
}
float cvNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(cvHash(i), cvHash(i + vec2(1.0, 0.0)), f.x), mix(cvHash(i + vec2(0.0, 1.0)), cvHash(i + vec2(1.0, 1.0)), f.x), f.y);
}
`;

const FRAGMENT = /* glsl */ `
{
  vec2 cp = vCoverPos;
  // 境目をずらす（1 m の格子の角を消す）
  vec2 wv = vec2(cvNoise(cp * 0.6), cvNoise(cp * 0.6 + 31.7)) - 0.5;
  vec4 w = texture2D(coverMap, (cp + wv * 1.5 - coverRect.xy) * coverRect.zw);
  // 舗石の割合: 4 つの合計の不足分から（PAVED_LEVEL = 128）
  float pav = clamp((1.0 - dot(w, vec4(1.0))) * (255.0 / 127.0), 0.0, 1.0);
  w.r = max(w.r - pav * (128.0 / 255.0), 0.0);
  w = smoothstep(0.2, 0.8, w);
  pav = smoothstep(0.2, 0.8, pav);
  float wsum = max(dot(w, vec4(1.0)) + pav, 1e-3);
  w /= wsum;
  pav /= wsum;
  float big = cvNoise(cp * 0.07 + 5.3);
  float mid = cvNoise(cp * 0.23 + 11.1);
  vec3 grass = texture2D(tGrass, cp / 6.0).rgb;
  vec3 gravel = texture2D(tGravel, cp / 3.0).rgb;
  vec3 paving = mix(texture2D(tPaving, cp / 4.0).rgb, vec3(1.0), 0.25) * c_old;
  vec3 sidewalk = texture2D(tSidewalk, cp / 4.0).rgb;
  vec3 pub = mix(sidewalk * c_public, paving, vOldTown);
  // 敷地の中: アスファルト → コンクリート → ところどころ砂利（big の大きい所）
  vec3 priv = mix(sidewalk * c_asphalt, texture2D(tGround, cp / 6.0).rgb * c_concrete, smoothstep(0.42, 0.52, big));
  priv = mix(priv, gravel * c_gravel, smoothstep(0.64, 0.7, big));
  priv = mix(priv, paving * 0.92, vOldTown * smoothstep(0.25, 0.45, mid));
  vec3 lawn = grass * mix(c_lawn, c_dry, smoothstep(0.35, 0.9, cvNoise(cp * 0.05 + 7.0)) * 0.7 + mid * 0.2);
  vec3 under = mix(grass * c_shade, gravel * c_earth, smoothstep(0.3, 0.75, mid));
  // 並木道の舗石: 20 × 10 cm の互い違い。目地は遠くでは消す（細かい線のちらつきを防ぐ）、舗石ごとに少し明るさを変える
  vec2 pb = cp * vec2(5.0, 10.0);
  pb.x += 0.5 * mod(floor(pb.y), 2.0);
  vec2 pf = abs(fract(pb) - 0.5), pw = fwidth(pb);
  float jt = max(smoothstep(0.44 - pw.x, 0.44 + pw.x, pf.x), smoothstep(0.42 - pw.y, 0.42 + pw.y, pf.y));
  jt *= 1.0 - smoothstep(0.15, 0.45, max(pw.x, pw.y));
  vec3 pavers = sidewalk * c_pavers * (0.93 + 0.14 * cvHash(floor(pb))) * (1.0 - 0.35 * jt);
  diffuseColor.rgb *= pub * w.r + priv * w.g + lawn * w.b + under * w.a + pavers * pav;
}
`;

function onBeforeCompile(uniforms) {
  return (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float oldTown;\nvarying vec2 vCoverPos;\nvarying float vOldTown;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvCoverPos = (modelMatrix * vec4(transformed, 1.0)).xz;\nvOldTown = oldTown;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${NOISE}`)
      .replace('#include <map_fragment>', FRAGMENT);
  };
}

// 1 枚の板: bounds（ローカル座標の範囲）を覆う。cover: { cols, rows, rle }、inOldTown(x, z): 旧市街か、
// parsed: 地図（広場と並木道の名前で覆いを補正する。data/cover.js の coverStamps）
export function buildCoverMesh(cover, bounds, shared, inOldTown = () => false, parsed = null) {
  const grid = decodeCover(cover);
  if (parsed) stampCover(grid, bounds, coverStamps(parsed));
  paveAllees(grid);
  const w = bounds.maxX - bounds.minX, h = bounds.maxZ - bounds.minZ;
  const g = new THREE.PlaneGeometry(w, h, SEG, SEG);
  g.rotateX(-Math.PI / 2);
  g.deleteAttribute('uv');
  const cx = (bounds.minX + bounds.maxX) / 2, cz = (bounds.minZ + bounds.maxZ) / 2;
  const pos = g.attributes.position;
  const old = new Float32Array(pos.count);
  for (let i = 0; i < pos.count; i++) old[i] = inOldTown(cx + pos.getX(i), cz + pos.getZ(i)) ? 1 : 0;
  g.setAttribute('oldTown', new THREE.BufferAttribute(old, 1));
  const map = coverTexture(grid);
  const uniforms = {
    ...shared.uniforms,
    coverMap: { value: map },
    coverRect: { value: new THREE.Vector4(bounds.minX, bounds.minZ, 1 / w, 1 / h) },
  };
  const mat = new THREE.MeshLambertMaterial({
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -4,
    stencilWrite: true,
    stencilRef: 1,
    stencilFunc: THREE.NotEqualStencilFunc,
    stencilFail: THREE.KeepStencilOp,
    stencilZFail: THREE.KeepStencilOp,
    stencilZPass: THREE.KeepStencilOp,
  });
  mat.onBeforeCompile = onBeforeCompile(uniforms);
  mat.customProgramCacheKey = () => 'ground-cover';
  const m = new THREE.Mesh(g, mat);
  m.position.set(cx, 0, cz);
  m.updateMatrix();
  m.matrixAutoUpdate = false;
  m.renderOrder = shared.order;
  m.receiveShadow = true;
  m.name = 'ground-cover';
  m.userData.dispose = () => {
    map.dispose();
    mat.dispose();
  };
  return m;
}
