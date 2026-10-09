// Toulouse à vélo — エントリーポイント。
// タイトル → 地図データ読み込み → 3D 都市の構築 → ゲームループ。
import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import { AREA_PRESETS, DEFAULT_AREA, TOUR_ROUTE } from './config.js';
import { bboxAround } from './geo.js';
import { PROVIDER_LABEL, loadAreaData } from './data/load.js';
import { makeTextures } from './world/textures.js';
import { createBuildingMaterials } from './world/buildings.js';
import { ORDER, createGroundMaterials } from './world/ground.js';
import { assembleWorld } from './world/assemble.js';
import { assembleStreamWorld } from './world/stream.js';
import { loadBaseData } from './data/tiles.js';
import { Bike } from './game/bike.js';
import { CAMERA_LABELS, CameraRig } from './game/camera.js';
import { Input } from './game/input.js';
import { AudioFx } from './game/audio.js';
import { animateBeacon, createBeacon, distanceToLandmark } from './game/landmarks.js';
import { MapRenderer, drawFullMap, drawMinimap } from './ui/minimap.js';
import { TONE_MAPPING_GLSL, displayColor, environmentIntensity, probeEnvironment } from './world/light.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));
const store = {
  get(k, d) {
    try {
      const v = localStorage.getItem(k);
      return v == null ? d : JSON.parse(v);
    } catch {
      return d;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(k, JSON.stringify(v));
    } catch {
      // 保存できなくても遊べる
    }
  },
};

// ---------------------------------------------------------------- レンダラーとシーン
const renderer = new THREE.WebGLRenderer({ antialias: true, stencil: true, powerPreference: 'high-performance' });
renderer.setSize(innerWidth, innerHeight);
// Neutral（Khronos PBR Neutral）は材料の色をそのまま出す（日なたのレンガの壁が白っぽく飛ばない）。
// ただし暗い所の黒の差し引きは使わない（日陰のレンガが写真より暗く赤くなる。light.js）
THREE.ShaderChunk.tonemapping_pars_fragment = THREE.ShaderChunk.tonemapping_pars_fragment
  .replace('vec3 CustomToneMapping( vec3 color ) { return color; }', TONE_MAPPING_GLSL);
renderer.toneMapping = THREE.CustomToneMapping;
renderer.toneMappingExposure = 1.1;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
$('app').appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(62, innerWidth / innerHeight, 0.5, 5000);
camera.position.set(0, 40, 80);

// 午後のトゥールーズ: 南西の空に太陽
const SUN_ELEVATION = 38, SUN_AZIMUTH = 225;
const sunDir = new THREE.Vector3().setFromSphericalCoords(
  1, THREE.MathUtils.degToRad(90 - SUN_ELEVATION), THREE.MathUtils.degToRad(180 - SUN_AZIMUTH),
);
const sky = new Sky();
sky.scale.setScalar(4000);
sky.material.uniforms.turbidity.value = 3.5;
sky.material.uniforms.rayleigh.value = 1.4;
sky.material.uniforms.mieCoefficient.value = 0.004;
sky.material.uniforms.mieDirectionalG.value = 0.82;
sky.material.uniforms.sunPosition.value.copy(sunDir);
scene.add(sky);

// ---- 光の強さの割合（写真の日なたと日陰のレンガの色に合わせた） ----
// 太陽（暖色、影を落とす）: 日なたのレンガは #bc7c55 前後。半球光: 日陰のレンガは #644337 前後で、道の片側は深い日陰になる
// （太陽と半球光の比は 2 倍あまり）。写真の日陰は空の青さより、日の当たった向かいの壁や地面からの照り返し（暖色）が効いて
// ほぼ無彩色なので、半球光の地面の色はばら色のレンガの照り返しにする。環境マップ（青い空）は弱く、空の光の一部と映り込み
const LIGHT = { sun: 2.8, hemi: 1.3, envShare: 0.4, envFallback: 0.06 };
const hemi = new THREE.HemisphereLight('#cfdcef', '#a48a76', LIGHT.hemi);
scene.add(hemi);
const sun = new THREE.DirectionalLight('#fff0d8', LIGHT.sun);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -100, right: 100, top: 100, bottom: -100, near: 1, far: 1200 });
sun.shadow.bias = -0.0003;
sun.shadow.normalBias = 0.25;
scene.add(sun, sun.target);

// 環境マップ: 太陽の円盤を抜いた空と、地平線より下の地面（街の色）。太陽の円盤は平行光が受け持つ
// （環境マップに入れると、影の中まで太陽の光が回り込んで影が消える）
const { envMap, waterEnv } = (() => {
  const envScene = new THREE.Scene();
  const skyClone = new Sky();
  skyClone.scale.setScalar(100);
  for (const k of Object.keys(sky.material.uniforms)) {
    const v = sky.material.uniforms[k].value;
    skyClone.material.uniforms[k].value = v?.clone ? v.clone() : v;
  }
  skyClone.material.uniforms.showSunDisc.value = 0;
  envScene.add(skyClone);
  // 地面: 日なたと日陰が混ざった街の平均の明るさ（反射率 0.22 前後）
  const lit = ((LIGHT.sun * Math.sin(THREE.MathUtils.degToRad(SUN_ELEVATION)) + LIGHT.hemi) * 0.85) / Math.PI;
  const ground = new THREE.Mesh(new THREE.CircleGeometry(48, 32), new THREE.MeshBasicMaterial({ color: '#8f7a6a' }));
  ground.material.color.multiplyScalar(lit);
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.4;
  envScene.add(ground);
  const probe = measureEnvironment(envScene);
  const pmrem = new THREE.PMREMGenerator(renderer);
  const tex = pmrem.fromScene(envScene, 0.02).texture;
  // 水面に映す環境: 低い角度には空でなく対岸の街並みと並木（暗い帯、仰角 0〜7°）が映る
  const skyline = new THREE.Mesh(
    new THREE.CylinderGeometry(46, 46, 46 * Math.tan(THREE.MathUtils.degToRad(7)) + 0.4, 48, 1, true),
    new THREE.MeshBasicMaterial({ color: '#6a5d50', side: THREE.BackSide }),
  );
  skyline.material.color.multiplyScalar(lit * 0.8);
  skyline.position.y = (46 * Math.tan(THREE.MathUtils.degToRad(7)) - 0.4) / 2;
  envScene.add(skyline);
  const water = pmrem.fromScene(envScene, 0.04).texture;
  pmrem.dispose();
  const k = probe && environmentIntensity(probe.up, hemi.color.toArray(), hemi.intensity, LIGHT.envShare);
  scene.environmentIntensity = k || LIGHT.envFallback;
  // 霧の色 = 画面に映る地平線の空の色（遠くの街並みが空に溶ける）。写真のように少し灰色がかったばら色に寄せる
  const fog = new THREE.Color('#c9d3da');
  if (probe) fog.setRGB(...displayColor(probe.horizon, renderer.toneMappingExposure), THREE.SRGBColorSpace);
  fog.lerp(new THREE.Color('#bdb5b2'), 0.35);
  scene.fog = new THREE.Fog(fog, 280, 1500);
  window.__tavLight = { probe, environmentIntensity: scene.environmentIntensity, fog: fog.getHexString() }; // デバッグ用
  return { envMap: tex, waterEnv: water };
})();
scene.environment = envMap;

// 地平線のもや: 空の地平線の近くを霧の色に寄せる（霧で溶けた遠くの街並みと、その向こうの空の色がそろう）。
// 空のシェーダーの最後（sRGB にした後）で混ぜるので、霧と同じく画面の色で指定する
{
  const haze = scene.fog.color.clone().convertLinearToSRGB();
  sky.material.uniforms.hazeColor = { value: new THREE.Vector3(haze.r, haze.g, haze.b) };
  sky.material.fragmentShader = sky.material.fragmentShader
    .replace('uniform float showSunDisc;', 'uniform float showSunDisc;\nuniform vec3 hazeColor;')
    .replace('#include <colorspace_fragment>', `#include <colorspace_fragment>
      float hazeK = 1.0 - smoothstep(0.0, 0.2, direction.y);
      gl_FragColor.rgb = mix(gl_FragColor.rgb, hazeColor, hazeK * hazeK);`);
  sky.material.needsUpdate = true;
}

// 環境の明るさを測る: 小さな浮動小数点の画像に 6 方向を描いて読み戻す（読み戻せない環境では null）
function measureEnvironment(envScene) {
  const S = 16;
  const rt = new THREE.WebGLRenderTarget(S, S, { type: THREE.HalfFloatType, depthBuffer: true });
  const cam = new THREE.PerspectiveCamera(90, 1, 0.05, 200);
  const buf = new Uint16Array(S * S * 4);
  const faces = [];
  const views = [[0, 1, 0, 0, 0, -1], [0, -1, 0, 0, 0, 1], [1, 0, 0, 0, 1, 0], [-1, 0, 0, 0, 1, 0], [0, 0, 1, 0, 1, 0], [0, 0, -1, 0, 1, 0]];
  const prev = renderer.getRenderTarget();
  try {
    for (const [x, y, z, ux, uy, uz] of views) {
      cam.up.set(ux, uy, uz);
      cam.lookAt(x, y, z);
      cam.updateMatrixWorld();
      renderer.setRenderTarget(rt);
      renderer.render(envScene, cam);
      buf.fill(0);
      renderer.readRenderTargetPixels(rt, 0, 0, S, S, buf);
      const e = cam.matrixWorld.elements;
      faces.push({
        data: Float32Array.from(buf, (h) => THREE.DataUtils.fromHalfFloat(h)), size: S,
        right: [e[0], e[1], e[2]], up: [e[4], e[5], e[6]], forward: [-e[8], -e[9], -e[10]],
      });
    }
    const p = probeEnvironment(faces);
    return p.up.every((v) => Number.isFinite(v)) && p.up[1] > 1e-4 ? p : null;
  } catch (err) {
    console.warn('環境の明るさを測れませんでした', err);
    return null;
  } finally {
    renderer.setRenderTarget(prev);
    rt.dispose();
  }
}

// 太陽の影の箱をカメラに合わせる: 低い視点は手前 ±100 m、上空ほど広く（最大 ±320 m）、見ている方へずらす。
// 箱の中心は影の地図の 1 画素単位にそろえ、動いても影の縁がちらつかないようにする
const shadowFit = { half: 0, fwd: new THREE.Vector3(), c: new THREE.Vector3(), x: new THREE.Vector3(), y: new THREE.Vector3() };
function fitSunShadow() {
  const f = shadowFit;
  if (f.lock) return; // デバッグ用: 影の箱を固定する
  const h = Math.max(1.5, camera.position.y);
  const half = Math.min(320, Math.round((95 + h * 2.2) / 10) * 10);
  camera.getWorldDirection(f.fwd);
  const down = -f.fwd.y;
  f.fwd.y = 0;
  const fl = f.fwd.length();
  if (fl < 1e-4) f.fwd.set(0, 0, -1);
  else f.fwd.divideScalar(fl);
  const look = down > 0.02 ? (h / down) * fl : Infinity; // 見ている点までの水平距離
  const ahead = Math.min(Math.max(look, half * 0.45), half * 0.7);
  const c = f.c.set(camera.position.x, 0, camera.position.z).addScaledVector(f.fwd, ahead);
  f.x.crossVectors(sun.up, sunDir).normalize(); // 影のカメラの x・y 軸（lookAt と同じ向き）
  f.y.crossVectors(sunDir, f.x);
  const texel = (2 * half) / sun.shadow.mapSize.x;
  const px = c.dot(f.x), py = c.dot(f.y);
  c.addScaledVector(f.x, Math.round(px / texel) * texel - px).addScaledVector(f.y, Math.round(py / texel) * texel - py);
  sun.target.position.copy(c);
  sun.position.copy(c).addScaledVector(sunDir, 600);
  if (half !== f.half) {
    f.half = half;
    Object.assign(sun.shadow.camera, { left: -half, right: half, top: half, bottom: -half });
    sun.shadow.camera.updateProjectionMatrix();
    sun.shadow.normalBias = Math.max(0.12, texel * 2.2);
  }
}

const textures = makeTextures();
const buildingMats = createBuildingMaterials(textures);
const groundMats = createGroundMaterials(textures);
// 水面の映り込み（環境マップを水だけ別にする。斜めから見るほど強く映る）。空のシェーダーの明るさは
// 日なたの壁の 5〜10 倍あるので、そのまま映すと水が白く光る。写真の川（空の 1/4 ほどの明るさ）に合わせて弱める
groundMats.water.envMap = waterEnv;
groundMats.water.envMapIntensity = 0.16;

const input = new Input();
const audio = new AudioFx();
const rig = new CameraRig(camera);

// ---------------------------------------------------------------- ゲームの状態
const state = {
  phase: 'title',
  presetId: DEFAULT_AREA,
  mode: 'free',
  world: null,
  bike: null,
  target: null,
  route: null,
  routeTimer: 0,
  streetTimer: 0,
  playTime: 0,
  tour: null,
  toastTimer: 0,
  lastWarn: 0,
  discovered: new Set(store.get('tav-discovered', [])),
};
window.__tav = state; // デバッグ・テスト用
state.rig = rig;
window.__tavDebug = { THREE, scene, camera, renderer, sun, hemi, shadowFit };
state.setTarget = (lm) => setTarget(lm);
// テスト用: 描画とは独立に物理を seconds 秒ぶん進める（遅い環境でも結果が変わらないように）
window.__tavSimulate = (seconds, ctl) => {
  const c = { throttle: 0, brake: 0, steer: 0, sprint: false, ...ctl };
  for (let t = 0; t < seconds; t += 1 / 60) update(1 / 60, c);
};

// ---------------------------------------------------------------- タイトル画面
const customArea = params.has('lat') && params.has('lon')
  ? { label: 'URL で指定したエリア', description: `${params.get('lat')}, ${params.get('lon')}`, lat: +params.get('lat'), lon: +params.get('lon'), radius: Math.min(2500, +(params.get('r') || 1000)), custom: true }
  : null;
const areas = { ...(customArea ? { custom: customArea } : {}), ...AREA_PRESETS };
{
  const list = $('area-list');
  const initial = customArea ? 'custom' : AREA_PRESETS[params.get('area')] ? params.get('area') : DEFAULT_AREA;
  for (const [id, a] of Object.entries(areas)) {
    const label = document.createElement('label');
    label.className = 'choice';
    label.innerHTML = `<input type="radio" name="area" value="${id}" ${id === initial ? 'checked' : ''}/><span><b></b><small></small></span>`;
    label.querySelector('b').textContent = a.label;
    label.querySelector('small').textContent = a.description;
    list.appendChild(label);
  }
  if (params.get('mode') === 'tour') document.querySelector('input[name=mode][value=tour]').checked = true;
  if (params.get('refresh') === '1') $('opt-refresh').checked = true; // 同梱データ・キャッシュを使わずに取得する
}

function show(id, on = true) {
  $(id).classList.toggle('hidden', !on);
}

$('start-btn').addEventListener('click', () => startGame());
$('retry-btn').addEventListener('click', () => startGame());

function setLoading(text, progress) {
  $('loading-text').textContent = text;
  if (progress != null) $('loading-bar').style.width = `${Math.round(progress * 100)}%`;
}

async function startGame() {
  audio.init();
  audio.resume();
  state.presetId = document.querySelector('input[name=area]:checked')?.value || DEFAULT_AREA;
  state.mode = document.querySelector('input[name=mode]:checked')?.value || 'free';
  const area = areas[state.presetId];
  const shadows = $('opt-shadows').checked;
  renderer.shadowMap.enabled = shadows;
  sun.castShadow = shadows;
  renderer.setPixelRatio(Math.min(devicePixelRatio, $('opt-hires').checked ? 2 : 1.25));
  // 高解像度では影の地図も細かく
  const shadowSize = $('opt-hires').checked ? 4096 : 2048;
  if (sun.shadow.mapSize.x !== shadowSize) {
    sun.shadow.mapSize.set(shadowSize, shadowSize);
    sun.shadow.map?.dispose();
    sun.shadow.map = null;
    shadowFit.half = 0;
  }

  show('title-screen', false);
  show('error-screen', false);
  show('loading-screen');
  setLoading('準備中…', 0.02);
  disposeWorld();
  // 広いエリアはタイルを作る範囲（約 1 km）の先が霧に溶けるように
  scene.fog.near = area.stream ? 250 : 280;
  scene.fog.far = area.stream ? 950 : 1500;
  try {
    const bbox = bboxAround(area.lat, area.lon, area.radius);
    if (area.stream) {
      await startStream(bbox);
      return;
    }
    const data = await loadAreaData({
      bbox,
      presetId: area.custom ? null : state.presetId,
      forceNetwork: $('opt-refresh').checked,
      provider: $('opt-ign').checked ? 'ign' : 'auto',
      onStatus: (t) => setLoading(t, 0.1),
    });
    setLoading(`地図データ: ${PROVIDER_LABEL[data.provider]}（${data.source}）\n地図を解析中…`, 0.3);
    await nextFrame();
    state.world = await buildWorld(data, bbox, (t, p) => setLoading(`地図データ: ${data.source}\n${t}`, 0.3 + p * 0.65));
    beginPlay();
  } catch (err) {
    console.error(err);
    show('loading-screen', false);
    show('error-screen');
    $('error-text').textContent = String(err.message || err);
  }
}

// 広いエリア（トゥールーズ全体）: 道路などの基本データと粗い高さを読み込み、スタート地点の周りのタイルを組み立ててから始める
async function startStream(bbox) {
  const forceNetwork = $('opt-refresh').checked;
  const base = await loadBaseData({ bbox, presetId: state.presetId, forceNetwork, onStatus: (t) => setLoading(t, 0.08) });
  const world = await assembleStreamWorld({
    base, bbox, presetId: state.presetId, buildingMats, groundMats,
    progress: (t, p) => setLoading(`地図データ: IGN BD TOPO（${base.source}）\n${t}`, 0.2 + p * 0.3),
  });
  state.world = finishWorld(world);
  world.stream.onTileReady = (t, buildings) => world.map.addBuildings(buildings); // 地図にも建物を描き足す
  const sp = spawnPoint(world);
  await world.stream.ensure(sp.x, sp.z, 320, (done, total) =>
    setLoading(`スタート地点の周りの街並みを組み立て中… ${done}/${total}\n（建物: IGN BD TOPO、塀と木: 地籍と LiDAR の実測）`, 0.5 + (0.5 * done) / Math.max(1, total)));
  beginPlay();
}

// ---------------------------------------------------------------- 3D 都市の構築
async function buildWorld(data, bbox, progress) {
  return finishWorld(await assembleWorld(data, bbox, { buildingMats, groundMats, progress, pause: nextFrame }));
}

// ミニマップ・目的地の光の柱・ルートの帯を加えて、シーンに置く
function finishWorld(world) {
  for (const lm of world.landmarks) lm.discovered = state.discovered.has(lm.id);
  world.map = new MapRenderer(world.parsed, world.rect);

  world.beacon = createBeacon();
  world.group.add(world.beacon);
  world.routeMesh = new THREE.Mesh(
    new THREE.BufferGeometry(),
    new THREE.MeshBasicMaterial({ color: '#2f7cf6', transparent: true, opacity: 0.55, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -8 }),
  );
  world.routeMesh.renderOrder = ORDER.route;
  world.routeMesh.frustumCulled = false;
  world.group.add(world.routeMesh);
  scene.add(world.group);
  return world;
}

function disposeWorld() {
  const w = state.world;
  if (!w) return;
  scene.remove(w.group);
  w.group.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    if (o.isInstancedMesh) o.dispose();
  });
  if (state.bike) scene.remove(state.bike.root);
  state.world = null;
}

// ---------------------------------------------------------------- スタート地点・地面の高さ
// スタート地点（タイムアタックは 1 つ目の名所、自由走行はキャピトル広場）
function spawnPoint(w) {
  let at = null;
  if (state.mode === 'tour') {
    const first = w.landmarks.find((l) => l.id === TOUR_ROUTE[0]);
    if (first) at = first.approach;
  }
  if (!at) at = (w.landmarks.find((l) => l.id === 'place-capitole') || w.landmarks.find((l) => l.id === 'capitole'))?.approach;
  return w.roadnet.nearestRideablePoint(at ? at.x : 0, at ? at.z : 0, (x, z) => !w.collision.blockedByWater(x, z)) || { x: 0, z: 0, heading: 0 };
}

// ワープした地点などの地面の高さ
function groundForTeleport(x, z) {
  return state.world?.heightAt ? state.world.heightAt(x, z) : 0;
}

function updateAttribution() {
  const w = state.world;
  if (!w) return;
  const base = w.stats.provider === 'ign' ? '地図 © IGN BD TOPO' : '© OpenStreetMap contributors · IGN BD TOPO';
  $('attribution').textContent = w.stream || w.stats.walls ? `${base} · 地籍・LiDAR HD © IGN（Licence Ouverte）` : base;
}

// ---------------------------------------------------------------- プレイ開始
function beginPlay() {
  const w = state.world;
  if (!state.bike) state.bike = new Bike();
  const bike = state.bike;
  scene.add(bike.root);
  bike.odometer = 0;
  bike.topSpeed = 0;
  state.playTime = 0;
  state.target = null;
  state.route = null;
  state.tour = null;
  toastQueue.length = 0;
  state.toastTimer = 0;

  if (state.mode === 'tour') {
    const list = TOUR_ROUTE.map((id) => w.landmarks.find((l) => l.id === id)).filter(Boolean);
    if (list.length >= 3) {
      state.tour = { list, index: 1, started: false, time: 0, splits: [] };
      setTarget(list[1]);
    } else {
      state.mode = 'free';
      toast('このエリアにはタイムアタックの名所が足りないため、自由走行で始めます');
    }
  }
  const p = spawnPoint(w);
  bike.place(p.x, p.z, p.heading, groundForTeleport(p.x, p.z));
  updateAttribution();
  rig.initialized = false;

  show('loading-screen', false);
  show('hud');
  state.phase = 'play';
  updateModeHud();
  if (w.stats.fallbackReason) toast('OpenStreetMap のサーバーにつながらなかったため、IGN（フランス国土地理院）の地図で街を作りました', 6);
  const st = w.stats.buildings;
  const pct = (n) => Math.round(((n || 0) / Math.max(1, st.total)) * 100);
  if (w.stream) {
    toast(`<b>Bienvenue à Toulouse !</b><br>ポン・ヌフから半径 5 km（${w.landmarks.length} か所の名所）。走る先の街並みを組み立てながら進みます<br>W でこぎ出そう。M で地図、C でカメラ切替。`, 8);
    return;
  }
  toast(`<b>Bienvenue à Toulouse !</b><br>建物 ${st.total.toLocaleString()} 棟（高さ: IGN 実測 ${pct(st.IGN)}% / OSM ${pct(st.OSM) + pct(st['OSM（階数）'])}% / 推定 ${pct(st['推定'])}%）<br>W でこぎ出そう。M で地図、C でカメラ切替。`, 7);
}

function setTarget(lm) {
  state.target = lm;
  state.route = null;
  state.routeTimer = 0;
  const w = state.world;
  if (lm) {
    w.beacon.position.set(lm.approach.x, groundForTeleport(lm.approach.x, lm.approach.z), lm.approach.z);
    w.beacon.visible = true;
  } else {
    w.beacon.visible = false;
    w.routeMesh.visible = false;
  }
  $('hud-target').classList.toggle('hidden', !lm);
}

// ---------------------------------------------------------------- HUD
// 通知。表示中のものがあれば順番待ちにする（urgent は割り込み）
const toastQueue = [];
function toast(html, seconds = 4, urgent = false) {
  if (!urgent && state.toastTimer > 0.5) {
    toastQueue.push([html, seconds]);
    return;
  }
  const el = $('toast');
  el.innerHTML = html;
  el.classList.add('show');
  state.toastTimer = seconds;
}

function tickToast(dt) {
  if (state.toastTimer <= 0) return;
  state.toastTimer -= dt;
  if (state.toastTimer > 0) return;
  $('toast').classList.remove('show');
  const next = toastQueue.shift();
  if (next) setTimeout(() => toast(...next), 400);
}

function fmtTime(s) {
  const m = Math.floor(s / 60);
  const r = s - m * 60;
  return `${m}:${r.toFixed(1).padStart(4, '0')}`;
}

function fmtDist(m) {
  return m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${Math.round(m)} m`;
}

function updateModeHud() {
  const t = state.tour;
  if (state.mode === 'tour' && t) {
    $('hud-mode').innerHTML = `🏁 名所めぐり ${t.index}/${t.list.length - 1}<br>⏱ ${fmtTime(t.time)}`;
  } else {
    const n = state.world?.landmarks.length || 0;
    const d = state.world?.landmarks.filter((l) => l.discovered).length || 0;
    $('hud-mode').innerHTML = `🗺️ 発見した名所 ${d}/${n}`;
  }
}

const labelEls = new Map();
const tmpV = new THREE.Vector3();
function updateLabels() {
  const w = state.world;
  const bike = state.bike;
  const root = $('labels');
  const placed = [];
  // 近い名所から順に置き、重なるラベルは上にずらす
  const sorted = w.landmarks
    .map((lm) => ({ lm, d: Math.hypot(lm.x - bike.x, lm.z - bike.z) }))
    .sort((a, b) => a.d - b.d);
  for (const { lm, d } of sorted) {
    let el = labelEls.get(lm.id);
    const visible = d < 380 || lm === state.target;
    if (!visible) {
      if (el) el.style.display = 'none';
      continue;
    }
    if (!el) {
      el = document.createElement('div');
      el.className = 'label';
      root.appendChild(el);
      labelEls.set(lm.id, el);
    }
    tmpV.set(lm.x, lm.height + (lm.y || 0), lm.z).project(camera);
    if (tmpV.z > 1 || tmpV.x < -1.2 || tmpV.x > 1.2 || tmpV.y < -1.2 || tmpV.y > 1.2) {
      el.style.display = 'none';
      continue;
    }
    el.style.display = '';
    el.textContent = `${lm.ja}${d > 60 ? ` · ${fmtDist(d)}` : ''}`;
    el.className = `label${lm.discovered ? ' discovered' : ''}${lm === state.target ? ' target' : ''}`;
    const x = ((tmpV.x + 1) / 2) * innerWidth;
    let y = ((1 - tmpV.y) / 2) * innerHeight;
    const hw = el.offsetWidth / 2 + 4, h = el.offsetHeight + 4;
    for (let k = 0; k < 4 && placed.some((p) => Math.abs(p.x - x) < p.hw + hw && Math.abs(p.y - y) < h); k++) y -= h;
    placed.push({ x, y, hw });
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
    el.style.opacity = String(Math.max(0.35, 1 - d / 450));
  }
}

function clearLabels() {
  for (const el of labelEls.values()) el.remove();
  labelEls.clear();
}

function updateRouteMesh() {
  const w = state.world;
  const r = state.route;
  if (!r || r.length < 2) {
    w.routeMesh.visible = false;
    return;
  }
  // 自転車の位置から 300 m 先までを地面に表示
  const pts = [];
  let len = 0;
  for (let i = 0; i < r.length && len < 300; i++) {
    if (i > 0) len += Math.hypot(r[i][0] - r[i - 1][0], r[i][1] - r[i - 1][1]);
    pts.push(r[i]);
  }
  const pos = [];
  const half = 0.9;
  const lift = 0.06;
  const yAt = (x, z) => w.heightAt(x, z) + lift;
  for (let i = 0; i + 1 < pts.length; i++) {
    const [px, pz] = pts[i], [qx, qz] = pts[i + 1];
    const l = Math.hypot(qx - px, qz - pz);
    if (l < 0.01) continue;
    const nx = (-(qz - pz) / l) * half, nz = ((qx - px) / l) * half;
    const steps = 1;
    for (let k = 0; k < steps; k++) {
      const ax = px + ((qx - px) * k) / steps, az = pz + ((qz - pz) * k) / steps;
      const bx = px + ((qx - px) * (k + 1)) / steps, bz = pz + ((qz - pz) * (k + 1)) / steps;
      const ya = yAt(ax, az), yb = yAt(bx, bz);
      pos.push(ax + nx, ya, az + nz, bx + nx, yb, bz + nz, bx - nx, yb, bz - nz, ax + nx, ya, az + nz, bx - nx, yb, bz - nz, ax - nx, ya, az - nz);
    }
  }
  const g = w.routeMesh.geometry;
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeBoundingSphere();
  w.routeMesh.visible = true;
}

function routeLength(r) {
  let len = 0;
  for (let i = 1; i < r.length; i++) len += Math.hypot(r[i][0] - r[i - 1][0], r[i][1] - r[i - 1][1]);
  return len;
}

// ---------------------------------------------------------------- 毎フレームの更新
function update(dt, forced) {
  const w = state.world;
  const bike = state.bike;
  const ctl = forced || input.read(dt);
  // 広いエリア: 自転車の周りのタイルを読み込む。いるタイルがまだなら止めて待つ
  let holding = false;
  if (w.stream) {
    w.stream.update(bike.x, bike.z);
    holding = !w.stream.readyAt(bike.x, bike.z);
    if (holding && !state.holdNotice) toast('この先の街並みを読み込み中…', 2, true);
    state.holdNotice = holding;
  }
  if (holding) bike.speed = 0;
  else {
    bike.update(dt, ctl, {
      collision: w.collision,
      surfaceAt: w.surfaceAt,
      groundAt: w.groundAt || null,
    });
  }
  state.playTime += dt;

  for (const ev of bike.events.splice(0)) {
    if (ev.type === 'bump') {
      audio.bump(ev.strength);
      rig.bump(ev.strength);
    } else if (performance.now() - state.lastWarn > 4000) {
      state.lastWarn = performance.now();
      toast(ev.type === 'water' ? '🌊 この先は川です。橋を渡ろう！' : '🧭 ここが地図データのある範囲の端です。R で道路に戻れます', 3, true);
    }
  }

  groundMats.water.userData.time.value = state.playTime; // 水面の波を流す

  rig.update(dt, bike, w.collision, null);
  audio.update(dt, bike.speed, ctl.throttle === 0);

  // 名所の発見
  for (const lm of w.landmarks) {
    if (lm.discovered) continue;
    if (distanceToLandmark(lm, bike.x, bike.z) < 24) {
      lm.discovered = true;
      state.discovered.add(lm.id);
      store.set('tav-discovered', [...state.discovered]);
      audio.chime();
      toast(`<b>📍 ${lm.ja}</b>（${lm.name}）<br>${lm.text}`, 8);
      updateModeHud();
    }
  }

  // タイムアタック
  const t = state.tour;
  if (state.mode === 'tour' && t) {
    if (!t.started && Math.abs(bike.speed) > 0.5) t.started = true;
    if (t.started) t.time += dt;
    const cur = t.list[t.index];
    if (cur && distanceToLandmark(cur, bike.x, bike.z) < 22) {
      t.splits.push({ name: cur.ja, time: t.time });
      t.index++;
      audio.chime();
      if (t.index >= t.list.length) finishTour();
      else {
        toast(`<b>✅ ${cur.ja}</b> ${fmtTime(t.time)}<br>次は ${t.list[t.index].ja}`, 4, true);
        setTarget(t.list[t.index]);
      }
    }
  }

  // ナビ
  if (state.target) {
    state.routeTimer -= dt;
    if (state.routeTimer <= 0) {
      state.routeTimer = 1.0;
      state.route = w.roadnet.route(bike.x, bike.z, state.target.approach.x, state.target.approach.z);
      updateRouteMesh();
    }
    animateBeacon(w.beacon, state.playTime);
    const tx = state.target.approach.x, tz = state.target.approach.z;
    const ang = Math.atan2(tx - bike.x, -(tz - bike.z)) - bike.heading;
    $('target-arrow').style.transform = `rotate(${(ang * 180) / Math.PI - 90}deg)`;
    $('target-name').textContent = state.target.ja;
    const straight = Math.hypot(tx - bike.x, tz - bike.z);
    $('target-dist').textContent = state.route ? `ルート ${fmtDist(routeLength(state.route))}（直線 ${fmtDist(straight)}）` : `直線 ${fmtDist(straight)}`;
  }

  // HUD
  $('speed-value').textContent = Math.round(Math.abs(bike.speed) * 3.6);
  state.streetTimer -= dt;
  if (state.streetTimer <= 0) {
    state.streetTimer = 0.3;
    const road = w.roadnet.streetNameAt(bike.x, bike.z);
    $('hud-street').textContent = road ? road.name : '';
    $('hud-stats').innerHTML = `走行距離 ${fmtDist(bike.odometer)} · 最高 ${Math.round(bike.topSpeed)} km/h<br>${CAMERA_LABELS[rig.mode]}`;
    updateModeHud();
  }
  tickToast(dt);
}

// ミニマップと名所ラベル（描画フレームごと。テスト用のシミュレーションでは呼ばない）
function drawHud() {
  const w = state.world;
  const bike = state.bike;
  drawMinimap($('minimap'), w.map, {
    x: bike.x, z: bike.z, heading: bike.heading, zoom: 0.9, route: state.route, landmarks: w.landmarks, target: state.target,
  });
  updateLabels();
}

function finishTour() {
  const t = state.tour;
  const key = `tav-best-${state.presetId}`;
  const best = store.get(key, null);
  const isBest = best == null || t.time < best;
  if (isBest) store.set(key, t.time);
  state.phase = 'result';
  input.enabled = false;
  $('result-text').innerHTML = `<p style="font-size:32px;font-weight:800;margin:8px 0">${fmtTime(t.time)}</p>
    <p>${isBest ? '🎉 自己ベスト更新！' : `自己ベスト: ${fmtTime(best)}`}</p>
    <ol>${t.splits.map((s) => `<li>${s.name} — ${fmtTime(s.time)}</li>`).join('')}</ol>
    <p class="muted small">走行距離 ${fmtDist(state.bike.odometer)} · 最高速度 ${Math.round(state.bike.topSpeed)} km/h</p>`;
  show('result-screen');
}

// ---------------------------------------------------------------- 操作
function togglePause(force) {
  if (state.phase !== 'play' && state.phase !== 'paused') return;
  const pause = force ?? state.phase === 'play';
  state.phase = pause ? 'paused' : 'play';
  input.enabled = !pause;
  if (pause && state.world.stream) {
    const s = state.world.stats, t = state.world.stream.totals;
    $('pause-info').innerHTML = `<p>トゥールーズ全体（${s.tiles} タイル）のうち、自転車の周りの ${state.world.stream.readyCount} タイルを表示中<br>
      建物 ${t.buildings.toLocaleString()} 棟 · 塀 ${t.walls.toLocaleString()} か所 · 木 ${t.trees.toLocaleString()} 本 · 道 ${s.roads.toLocaleString()} 本<br>
      地図: IGN BD TOPO（${s.source}）· 塀と木: IGN 地籍・LiDAR HD</p>`;
  } else if (pause) {
    const s = state.world.stats;
    const b = s.buildings;
    $('pause-info').innerHTML = `<p>建物 ${b.total.toLocaleString()} 棟 · 道 ${s.roads.toLocaleString()} 本 · 木 ${s.trees.toLocaleString()} 本<br>
      建物の高さの出典: IGN 実測 ${(b.IGN || 0).toLocaleString()} / OSM ${((b.OSM || 0) + (b['OSM（階数）'] || 0)).toLocaleString()} / 推定 ${(b['推定'] || 0).toLocaleString()}<br>
      地図: ${PROVIDER_LABEL[s.provider] || s.provider}（${s.source}${s.fetchedAt ? `・${new Date(s.fetchedAt).toLocaleDateString('ja-JP')} 取得` : ''}）</p>`;
  }
  show('pause-screen', pause);
}

function openMap(open) {
  if (open && state.phase !== 'play') return;
  if (!open && state.phase !== 'map') return;
  state.phase = open ? 'map' : 'play';
  input.enabled = !open;
  show('map-screen', open);
  if (open) renderFullMap();
}

let mapXf = null;
function renderFullMap() {
  const c = $('fullmap');
  const r = c.getBoundingClientRect();
  c.width = Math.round(r.width * Math.min(devicePixelRatio, 2));
  c.height = Math.round(r.height * Math.min(devicePixelRatio, 2));
  const w = state.world;
  const b = state.bike;
  mapXf = drawFullMap(c, w.map, { x: b.x, z: b.z, heading: b.heading, route: state.route, landmarks: w.landmarks, target: state.target });
  const ul = $('landmark-list');
  ul.innerHTML = '';
  for (const lm of w.landmarks) {
    const li = document.createElement('li');
    li.className = `${lm.discovered ? 'discovered' : ''} ${lm === state.target ? 'target' : ''}`;
    li.innerHTML = '<span class="dot"></span><span></span>';
    li.lastChild.textContent = `${lm.ja}（${fmtDist(Math.hypot(lm.x - b.x, lm.z - b.z))}）`;
    li.addEventListener('click', () => {
      if (state.mode === 'tour') return toast('タイムアタック中は目的地を変えられません', 2, true);
      setTarget(lm);
      renderFullMap();
    });
    ul.appendChild(li);
  }
  $('discovered-count').textContent = `${w.landmarks.filter((l) => l.discovered).length}/${w.landmarks.length}`;
}

$('fullmap').addEventListener('click', (e) => {
  if (!mapXf || state.phase !== 'map') return;
  const c = $('fullmap');
  const r = c.getBoundingClientRect();
  const px = ((e.clientX - r.left) / r.width) * c.width, py = ((e.clientY - r.top) / r.height) * c.height;
  const w = state.world;
  // 名所の近くをクリック → 目的地に
  for (const lm of w.landmarks) {
    const [sx, sy] = mapXf.toScreen(lm.x, lm.z);
    if (Math.hypot(sx - px, sy - py) < 14) {
      if (state.mode !== 'tour') setTarget(lm);
      renderFullMap();
      return;
    }
  }
  if (state.mode === 'tour') return toast('タイムアタック中はワープできません', 2, true);
  const [x, z] = mapXf.toWorld(px, py);
  const p = w.roadnet.nearestRideablePoint(x, z, (qx, qz) => !w.collision.blockedByWater(qx, qz) && !w.collision.outOfBounds(qx, qz));
  if (p) {
    state.bike.place(p.x, p.z, p.heading, groundForTeleport(p.x, p.z));
    rig.initialized = false;
    state.routeTimer = 0;
    openMap(false);
    toast('ワープしました', 2, true);
  }
});

function respawn() {
  if (state.phase !== 'play') return;
  const w = state.world;
  const b = state.bike;
  const p = w.roadnet.nearestRideablePoint(b.x, b.z, (x, z) => !w.collision.blockedByWater(x, z) && !w.collision.outOfBounds(x, z));
  if (p) {
    b.place(p.x, p.z, p.heading, groundForTeleport(p.x, p.z));
    rig.initialized = false;
  }
}

function backToTitle() {
  state.phase = 'title';
  input.enabled = true;
  for (const id of ['pause-screen', 'result-screen', 'map-screen', 'hud']) show(id, false);
  clearLabels();
  disposeWorld();
  show('title-screen');
}

input.on('Escape', () => (state.phase === 'map' ? openMap(false) : togglePause()));
input.on('KeyP', () => togglePause());
input.on('KeyC', () => state.phase === 'play' && rig.cycle());
input.on('KeyV', () => state.phase === 'play' && rig.cycle());
input.on('KeyM', () => (state.phase === 'map' ? openMap(false) : openMap(true)));
input.on('Tab', (e) => {
  e.preventDefault?.();
  if (state.phase === 'map') openMap(false);
  else openMap(true);
});
input.on('KeyR', respawn);
input.on('Space', () => state.phase === 'play' && audio.bell());
input.bindTouch($('touch-controls'));

for (const btn of document.querySelectorAll('#hud-buttons button')) {
  btn.addEventListener('click', () => {
    const a = btn.dataset.action;
    if (a === 'map') openMap(true);
    else if (a === 'camera') rig.cycle();
    else if (a === 'bell') audio.bell();
    else if (a === 'pause') togglePause(true);
    btn.blur();
  });
}
$('close-map').addEventListener('click', () => openMap(false));
$('clear-target').addEventListener('click', () => {
  if (state.mode === 'tour') return;
  setTarget(null);
  renderFullMap();
});
$('resume-btn').addEventListener('click', () => togglePause(false));
$('title-btn').addEventListener('click', backToTitle);
$('mute-btn').addEventListener('click', () => {
  audio.setMuted(!audio.muted);
  $('mute-btn').textContent = `音: ${audio.muted ? 'オフ' : 'オン'}`;
});
$('again-btn').addEventListener('click', () => {
  show('result-screen', false);
  input.enabled = true;
  state.mode = 'tour';
  beginPlay();
});
$('free-btn').addEventListener('click', () => {
  show('result-screen', false);
  input.enabled = true;
  state.mode = 'free';
  state.tour = null;
  setTarget(null);
  state.phase = 'play';
  updateModeHud();
});

document.addEventListener('visibilitychange', () => {
  if (document.hidden && state.phase === 'play') togglePause(true);
});
addEventListener('keydown', () => audio.resume());

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  if (state.phase === 'map') renderFullMap();
});

// ---------------------------------------------------------------- ループ
let last = performance.now();
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (state.world && state.phase === 'play') {
    update(dt);
    drawHud();
  }
  if (state.world) {
    fitSunShadow();
    sky.position.copy(camera.position); // 空の箱はカメラと一緒に動かす（5 km のエリアの端でも空が切れないように）
    renderer.render(scene, camera);
  }
}
requestAnimationFrame(frame);

if (params.get('autostart') === '1') startGame();
