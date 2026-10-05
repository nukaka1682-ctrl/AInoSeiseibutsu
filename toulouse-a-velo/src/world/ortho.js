// IGN の航空写真（BD ORTHO 高解像度）を地面と屋根に貼る。
// エリアを区画に分け、区画ごとに WMS で写真を取得する。最初は全体を 1 枚にした低解像度の写真を使い、
// 近くの区画から順に高解像度の写真に差し替える（遠ざかったら低解像度に戻してメモリを節約）。
import * as THREE from 'three';

export const ORTHO_WMS = 'https://data.geopf.fr/wms-r/wms';
export const ORTHO_LAYER = 'HR.ORTHOIMAGERY.ORTHOPHOTOS';
// 解像度の段階ごとの写真の幅（ピクセル）。区画は約 250 m なので 3 段目で約 15 cm/ピクセル（元の写真は 20 cm）
const ORTHO_SIZES = [0, 384, 1024, 1600];

export function orthoUrl(proj, b, size) {
  const [n, w] = proj.unproject(b.minX, b.minZ);
  const [s, e] = proj.unproject(b.maxX, b.maxZ);
  const wpx = size, hpx = Math.max(16, Math.round((size * (b.maxZ - b.minZ)) / (b.maxX - b.minX)));
  const p = new URLSearchParams({
    SERVICE: 'WMS', VERSION: '1.3.0', REQUEST: 'GetMap', LAYERS: ORTHO_LAYER, STYLES: '', CRS: 'EPSG:4326',
    BBOX: `${s},${w},${n},${e}`, WIDTH: String(wpx), HEIGHT: String(hpx), FORMAT: 'image/jpeg',
  });
  return `${ORTHO_WMS}?${p}`;
}

// 区画: bounds = 区画の正方形、image = 写真の範囲（区画に属する建物・橋がはみ出す分を含む）
// 広いエリアでは、タイルの読み込み・破棄に合わせて区画を足し引きする（addChunks / removeChunks）
export class OrthoManager {
  constructor(proj, rect, chunks = [], { maxAnisotropy = 8 } = {}) {
    this.proj = proj;
    this.rect = rect;
    this.chunks = [];
    this.loader = new THREE.TextureLoader();
    this.loader.setCrossOrigin('anonymous');
    this.anisotropy = maxAnisotropy;
    this.overview = null;
    this.active = 0;
    this.timer = 0;
    this.failures = 0;
    this.detail = typeof document !== 'undefined' ? detailTexture() : null; // Node（テスト）では作らない
    this.addChunks(chunks);
  }

  addChunks(chunks) {
    for (const c of chunks) {
      c.material = new THREE.MeshBasicMaterial({ color: '#9a9488', toneMapped: false });
      if (this.detail) addDetail(c.material, this.detail);
      c.level = 0;
      c.want = 0;
      if (this.overview) this.applyOverview(c);
      this.chunks.push(c);
    }
  }

  removeChunks(chunks) {
    const gone = new Set(chunks);
    this.chunks = this.chunks.filter((c) => !gone.has(c));
    for (const c of chunks) {
      c.removed = true;
      c.material.map?.dispose();
      c.material.dispose();
    }
  }

  // 全体の低解像度写真（1 枚）を読み込む
  async loadOverview(size = 2048) {
    const r = this.rect;
    const tex = await this.loader.loadAsync(orthoUrl(this.proj, r, size));
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = this.anisotropy;
    this.overview = tex;
    for (const c of this.chunks) this.applyOverview(c);
    return tex;
  }

  // 区画の UV（区画の写真範囲で 0〜1）を全体写真の範囲に変換して貼る
  applyOverview(c) {
    const r = this.rect, im = c.image;
    const t = this.overview.clone();
    t.repeat.set((im.maxX - im.minX) / (r.maxX - r.minX), (im.maxZ - im.minZ) / (r.maxZ - r.minZ));
    t.offset.set((im.minX - r.minX) / (r.maxX - r.minX), 1 - (im.maxZ - r.minZ) / (r.maxZ - r.minZ));
    t.needsUpdate = true;
    this.setMap(c, t, 0);
  }

  setMap(c, tex, level) {
    const old = c.material.map;
    c.material.map = tex;
    c.material.color.set('#ffffff');
    c.material.needsUpdate = true;
    if (old && old !== this.overview && c.level > 0) old.dispose();
    c.level = level;
  }

  // 毎フレーム呼ぶ。カメラからの距離で各区画の解像度を決め、必要なものを読み込む
  update(dt, camera) {
    if (!this.overview) return;
    this.timer -= dt;
    if (this.timer > 0) return;
    this.timer = 0.5;
    const cx = camera.position.x, cz = camera.position.z;
    for (const c of this.chunks) {
      const b = c.bounds;
      const dx = Math.max(b.minX - cx, 0, cx - b.maxX), dz = Math.max(b.minZ - cz, 0, cz - b.maxZ);
      const d = Math.hypot(dx, dz);
      c.want = d < 90 ? 3 : d < 220 ? 2 : d < 600 ? 1 : 0;
      c.dist = d;
      if (c.want === 0 && c.level > 0) this.applyOverview(c);
    }
    // 近い区画から高解像度に。遠ざかった最高解像度の区画は 1 段下げてメモリを空ける
    const todo = this.chunks.filter((c) => c.want > c.level && !c.loading).sort((a, b) => a.dist - b.dist);
    const shrink = this.chunks.filter((c) => c.level === 3 && c.want > 0 && c.want < 2 && !c.loading);
    while (this.active < 4 && (todo.length || shrink.length) && this.failures < 30) this.load(todo.length ? todo.shift() : shrink.shift());
  }

  load(c) {
    const level = c.want;
    const size = ORTHO_SIZES[level];
    c.loading = true;
    this.active++;
    this.loader.load(
      orthoUrl(this.proj, c.image, size),
      (tex) => {
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.anisotropy = this.anisotropy;
        c.loading = false;
        this.active--;
        if (!c.removed && (c.want >= level || c.level > level)) this.setMap(c, tex, level);
        else tex.dispose();
      },
      undefined,
      () => {
        c.loading = false;
        this.active--;
        this.failures++;
      },
    );
  }
}

// 区画内の点の UV（区画の写真範囲で 0〜1、北が上）
export function orthoUV(image, x, z) {
  return [(x - image.minX) / (image.maxX - image.minX), 1 - (z - image.minZ) / (image.maxZ - image.minZ)];
}

// 近くで見たときの細かい凹凸（航空写真は 20 cm/ピクセルなので、目の高さではぼやける）。
// 世界座標で敷き詰めたノイズを、カメラから近い所ほど強く写真に掛ける
function detailTexture(size = 256) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(size, size);
  // 周期的な値ノイズ（4 オクターブ）
  const rnd = (i, j, o) => {
    const h = Math.sin(i * 127.1 + j * 311.7 + o * 74.7) * 43758.5453;
    return h - Math.floor(h);
  };
  const smooth = (t) => t * t * (3 - 2 * t);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let v = 0, amp = 0.5;
      for (let o = 0; o < 4; o++) {
        const cells = 8 << o;
        const fx = (x / size) * cells, fy = (y / size) * cells;
        const i = Math.floor(fx), j = Math.floor(fy);
        const tx = smooth(fx - i), ty = smooth(fy - j);
        const a = rnd(i % cells, j % cells, o), b = rnd((i + 1) % cells, j % cells, o);
        const c = rnd(i % cells, (j + 1) % cells, o), d = rnd((i + 1) % cells, (j + 1) % cells, o);
        v += amp * ((a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty);
        amp *= 0.5;
      }
      const k = (y * size + x) * 4;
      img.data[k] = img.data[k + 1] = img.data[k + 2] = Math.round(v / 0.9375 * 255);
      img.data[k + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

function addDetail(material, detail) {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.detailMap = { value: detail };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vDetailPos;')
      .replace('#include <project_vertex>', '#include <project_vertex>\nvDetailPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform sampler2D detailMap;\nvarying vec3 vDetailPos;')
      .replace('#include <map_fragment>', `#include <map_fragment>
        float detailFade = 1.0 - smoothstep(12.0, 70.0, distance(vDetailPos, cameraPosition));
        float detailN = texture2D(detailMap, vDetailPos.xz * 0.31).r * 0.6 + texture2D(detailMap, vDetailPos.xz * 0.073).r * 0.4;
        diffuseColor.rgb *= mix(1.0, 0.72 + detailN * 0.56, detailFade);`);
  };
  material.customProgramCacheKey = () => 'ortho-detail';
}
