// 実写の 3D 街並み（Google Photorealistic 3D Tiles を Cesium ion 経由で読み込む）。
// 航空写真から作られた本物の建物・木・道路の 3D モデルで、見た目はこれに置き換える。
// 当たり判定・ナビ・通りの名前は、これまでどおり地図データ（IGN / OSM）で行う。
//
// 座標: ReorientationPlugin で「エリアの中心」を原点に置く。プラグインの座標系は X = 西・Z = 北なので、
// 親グループを Y 軸まわりに 180° 回して、ゲームの座標系（X = 東・Z = 南）に合わせる。
// 高さ: 楕円体高のままだと地面が y ≈ 200 m になるので、開けた場所の地面を探して y = 0 にそろえる。
import * as THREE from 'three';
import { TilesRenderer } from '3d-tiles-renderer';
import {
  CesiumIonAuthPlugin, GLTFExtensionsPlugin, ReorientationPlugin, TileCompressionPlugin, TilesFadePlugin,
} from '3d-tiles-renderer/plugins';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';

export const GOOGLE_3D_TILES_ION_ASSET = 2275207;
const DEG = Math.PI / 180;

export class PhotorealCity {
  constructor({ token, lat, lon, camera, renderer, errorTarget = 12 }) {
    this.camera = camera;
    this.renderer = renderer;
    this.errorTarget = errorTarget;
    this.errors = [];
    this.loadedModels = 0;
    this.calibrated = false;

    const tiles = new TilesRenderer();
    tiles.registerPlugin(new CesiumIonAuthPlugin({ apiToken: token, assetId: GOOGLE_3D_TILES_ION_ASSET, autoRefreshToken: true }));
    const draco = new DRACOLoader().setDecoderPath(`${import.meta.env.BASE_URL}draco/`);
    tiles.registerPlugin(new GLTFExtensionsPlugin({ dracoLoader: draco }));
    tiles.registerPlugin(new TileCompressionPlugin());
    tiles.registerPlugin(new TilesFadePlugin());
    tiles.registerPlugin(new ReorientationPlugin({ lat: lat * DEG, lon: lon * DEG, height: 0 }));
    tiles.setCamera(camera);
    tiles.setResolutionFromRenderer(camera, renderer);
    // 写真の色をそのまま出す（光源の影響を受けない素材に置き換える）
    tiles.addEventListener('load-model', ({ scene }) => {
      this.loadedModels++;
      scene.traverse((o) => {
        if (!o.isMesh) return;
        const old = o.material;
        if (old && !old.isMeshBasicMaterial) {
          o.material = new THREE.MeshBasicMaterial({ map: old.map || null, color: old.map ? 0xffffff : old.color, side: old.side });
          old.dispose();
        }
        o.material.toneMapped = false;
        o.castShadow = false;
        o.receiveShadow = false;
      });
    });
    tiles.addEventListener('load-error', ({ error, url }) => {
      this.errors.push(`${error?.message || error}${url ? ` (${String(url).split('?')[0]})` : ''}`);
    });
    this.tiles = tiles;

    // 親グループ: 向きを合わせ（180° 回転）、地面の高さを 0 にそろえる
    this.root = new THREE.Group();
    this.root.name = 'photoreal';
    this.root.rotation.y = Math.PI;
    this.root.add(tiles.group);
    this.raycaster = new THREE.Raycaster();
    this.down = new THREE.Vector3(0, -1, 0);
    this.origin = new THREE.Vector3();
  }

  // 0〜1: 今見えている範囲のタイルの読み込み具合
  get progress() {
    return this.tiles.loadProgress;
  }

  update() {
    this.tiles.errorTarget = this.errorTarget;
    this.tiles.setResolutionFromRenderer(this.camera, this.renderer);
    this.camera.updateMatrixWorld();
    this.tiles.update();
  }

  // (x, z) の真上 fromY から真下へレイを飛ばし、toY までに当たった面の高さ（上から順）
  hitsAt(x, z, fromY, toY) {
    this.root.updateMatrixWorld();
    this.origin.set(x, fromY, z);
    this.raycaster.set(this.origin, this.down);
    this.raycaster.near = 0;
    this.raycaster.far = fromY - toY;
    return this.raycaster.intersectObject(this.tiles.group, true).map((h) => h.point.y);
  }

  // 開けた場所の周りの地面の高さを調べ、全体を上下に動かして地面を y = 0 にそろえる。
  // 木や車の上に当たることがあるので、周囲 9 点の低い方から 2 番目を地面とみなす
  calibrate(x, z) {
    const ys = [];
    for (const dx of [-6, 0, 6]) {
      for (const dz of [-6, 0, 6]) {
        const h = this.hitsAt(x + dx, z + dz, 5000, -5000);
        if (h.length) ys.push(Math.min(...h));
      }
    }
    if (ys.length < 3) return false;
    ys.sort((a, b) => a - b);
    this.root.position.y -= ys[1];
    this.root.updateMatrixWorld(true);
    this.calibrated = true;
    return true;
  }

  // 走行中: 今の高さ付近だけを探す（木の枝や車の屋根、橋の下の水面を拾わないように）
  groundAt(x, z, currentY) {
    const h = this.hitsAt(x, z, currentY + 0.8, currentY - 6);
    return h.length ? h[0] : null;
  }

  // ワープ直後など高さが分からないとき: 橋の上なら上の面、それ以外は一番低い面（木や車の下の地面）
  findGround(x, z, onBridge = false) {
    const h = this.hitsAt(x, z, 40, -30).filter((y) => y > -15 && y < 12);
    if (!h.length) return null;
    if (onBridge) {
      const deck = h.filter((y) => y > -4 && y < 4);
      return deck.length ? deck[0] : h[0];
    }
    return h[h.length - 1];
  }

  attributions() {
    const list = [];
    this.tiles.getAttributions(list);
    return list.filter((a) => a.type === 'string' && a.value).map((a) => a.value).join(' · ');
  }

  dispose() {
    this.root.removeFromParent();
    this.tiles.dispose();
  }
}
