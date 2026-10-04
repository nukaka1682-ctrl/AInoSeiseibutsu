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
import { PhotorealCity } from './world/photoreal.js';
import { Bike } from './game/bike.js';
import { CAMERA_LABELS, CameraRig } from './game/camera.js';
import { Input } from './game/input.js';
import { AudioFx } from './game/audio.js';
import { animateBeacon, createBeacon, distanceToLandmark } from './game/landmarks.js';
import { MapRenderer, drawFullMap, drawMinimap } from './ui/minimap.js';

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
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.8;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
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
{
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envScene = new THREE.Scene();
  const skyClone = new Sky();
  skyClone.scale.setScalar(100);
  skyClone.material.uniforms.sunPosition.value.copy(sunDir);
  skyClone.material.uniforms.rayleigh.value = 1.4;
  envScene.add(skyClone);
  scene.environment = pmrem.fromScene(envScene).texture;
  scene.environmentIntensity = 0.3;
}
scene.fog = new THREE.Fog('#c9d6df', 280, 1500);

const hemi = new THREE.HemisphereLight('#d4e1f2', '#7d6e5e', 0.6);
scene.add(hemi);
const sun = new THREE.DirectionalLight('#fff1dc', 1.9);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -90, right: 90, top: 90, bottom: -90, near: 1, far: 1200 });
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.35;
scene.add(sun, sun.target);

// 実写 3D のときの自転車の足元の影（実写のタイルは影を受けないので、丸い影を置く）
const blobShadow = (() => {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(32, 32, 2, 32, 32, 32);
  g.addColorStop(0, 'rgba(0,0,0,0.55)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  const m = new THREE.Mesh(new THREE.PlaneGeometry(1.1, 2.2), new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(c), transparent: true, depthWrite: false }));
  m.rotation.x = -Math.PI / 2;
  m.visible = false;
  return m;
})();
scene.add(blobShadow);

const textures = makeTextures();
const buildingMats = createBuildingMaterials(textures);
const groundMats = createGroundMaterials(textures);

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
  photo: null, // 実写 3D の街並み（PhotorealCity）
  photoOn: false,
};
window.__tav = state; // デバッグ・テスト用
state.rig = rig;
window.__tavDebug = { THREE, scene, camera, renderer };
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
  // 実写 3D のトークン: このブラウザに保存したもの → ビルド時に埋め込んだもの（VITE_CESIUM_ION_TOKEN）
  const token = store.get('tav-ion-token', '') || import.meta.env.VITE_CESIUM_ION_TOKEN || '';
  $('ion-token').value = token;
  document.querySelector(`input[name=look][value=${token ? 'photo' : 'model'}]`).checked = true;
  $('ion-token').addEventListener('input', () => {
    if ($('ion-token').value.trim()) document.querySelector('input[name=look][value=photo]').checked = true;
  });
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

  show('title-screen', false);
  show('error-screen', false);
  show('loading-screen');
  setLoading('準備中…', 0.02);
  disposeWorld();
  try {
    const bbox = bboxAround(area.lat, area.lon, area.radius);
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
    const token = $('ion-token').value.trim();
    if (document.querySelector('input[name=look]:checked')?.value === 'photo') {
      if (token) {
        store.set('tav-ion-token', token);
        await preparePhotoreal(state.world, token);
      } else {
        state.photoNote = '実写 3D にはトークンが必要なため、地図から生成した街で始めます';
      }
    }
    beginPlay();
  } catch (err) {
    console.error(err);
    show('loading-screen', false);
    show('error-screen');
    $('error-text').textContent = String(err.message || err);
  }
}

// ---------------------------------------------------------------- 3D 都市の構築
async function buildWorld(data, bbox, progress) {
  const world = await assembleWorld(data, bbox, { buildingMats, groundMats, progress, pause: nextFrame });
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
  if (state.photo) state.photo.dispose();
  state.photo = null;
  state.photoOn = false;
  state.world = null;
}

// ---------------------------------------------------------------- 実写 3D
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

// 実写 3D のタイルを読み込み、地面の高さを合わせる。失敗したら地図から生成した街のまま続ける
async function preparePhotoreal(w, token) {
  const photo = new PhotorealCity({
    token, lat: w.proj.lat0, lon: w.proj.lon0, camera, renderer, errorTarget: $('opt-hires').checked ? 8 : 12,
  });
  scene.add(photo.root);
  const sp = spawnPoint(w);
  // スタート地点の上空から見下ろして、周りのタイルを先に読み込む
  camera.position.set(sp.x, 90, sp.z + 60);
  camera.lookAt(sp.x, 0, sp.z);
  const t0 = performance.now();
  let reason = '';
  for (;;) {
    photo.update();
    renderer.render(scene, camera);
    await nextFrame();
    const sec = (performance.now() - t0) / 1000;
    setLoading(`実写 3D の街並みを読み込み中…（${photo.loadedModels} タイル）`, 0.95 + Math.min(1, photo.progress) * 0.05);
    if (photo.errors.length && photo.loadedModels === 0) {
      reason = photo.errors[0];
      break;
    }
    if (photo.loadedModels > 20 && photo.progress >= 1 && sec > 2) break;
    if (sec > 60) {
      if (photo.loadedModels === 0) reason = '60 秒待ってもタイルが届きませんでした';
      break;
    }
  }
  if (!reason && !photo.calibrate(sp.x, sp.z)) reason = '地面の高さを測れませんでした';
  if (reason) {
    console.warn('実写 3D を使えません:', reason);
    photo.dispose();
    state.photoNote = `実写 3D を読み込めなかったため、地図から生成した街で始めます（${/401|403|Unauthorized|Forbidden/i.test(reason) ? 'トークンが正しいか確認してください' : reason}）`;
    return;
  }
  state.photo = photo;
  setPhotoMode(true);
}

// 実写 3D ⇔ 地図から生成 の切り替え
function setPhotoMode(on) {
  const w = state.world;
  state.photoOn = !!(on && state.photo);
  if (state.photo) state.photo.root.visible = state.photoOn;
  for (const g of [w.ground.group, w.buildings.group, w.trees]) g.visible = !state.photoOn;
  w.routeMesh.material.opacity = state.photoOn ? 0 : 0.55;
  sun.castShadow = !state.photoOn && $('opt-shadows').checked;
  scene.fog.near = state.photoOn ? 600 : 280;
  scene.fog.far = state.photoOn ? 3500 : 1500;
  const bike = state.bike;
  if (bike) {
    bike.y = state.photoOn ? groundForTeleport(bike.x, bike.z) : 0;
    bike.syncModel();
  }
  $('look-btn').classList.toggle('hidden', !state.photo);
  $('look-btn').textContent = `見た目: ${state.photoOn ? '実写 3D' : '地図から生成'}`;
  updateAttribution();
}

// ワープした地点の地面の高さ（実写 3D のときだけ）
function groundForTeleport(x, z) {
  if (!state.photoOn) return 0;
  const seg = state.world.roadnet.nearestSegment(x, z, 15);
  const onBridge = !!(seg && seg.seg.road.bridge && Math.sqrt(seg.d2) < seg.seg.road.width / 2 + 2);
  return state.photo.findGround(x, z, onBridge) ?? 0;
}

function updateAttribution() {
  const w = state.world;
  if (!w) return;
  const base = w.stats.provider === 'ign' ? '地図 © IGN BD TOPO（Licence Ouverte）' : '© OpenStreetMap contributors · IGN BD TOPO';
  $('attribution').textContent = state.photoOn ? `3D: Google · ${state.photo.attributions() || 'Google'} · Cesium ion ／ ${base}` : base;
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
  bike.place(p.x, p.z, p.heading, 0);
  setPhotoMode(state.photoOn);
  rig.initialized = false;

  show('loading-screen', false);
  show('hud');
  state.phase = 'play';
  updateModeHud();
  if (state.photoNote) {
    toast(state.photoNote, 6);
    state.photoNote = '';
  }
  if (w.stats.fallbackReason) toast('OpenStreetMap のサーバーにつながらなかったため、IGN（フランス国土地理院）の地図で街を作りました', 6);
  const st = w.stats.buildings;
  const pct = (n) => Math.round(((n || 0) / Math.max(1, st.total)) * 100);
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
    tmpV.set(lm.x, lm.height + bike.y, lm.z).project(camera);
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
  for (let i = 0; i + 1 < pts.length; i++) {
    const [ax, az] = pts[i], [bx, bz] = pts[i + 1];
    const l = Math.hypot(bx - ax, bz - az);
    if (l < 0.01) continue;
    const nx = (-(bz - az) / l) * half, nz = ((bx - ax) / l) * half;
    const y = 0.06;
    pos.push(ax + nx, y, az + nz, bx + nx, y, bz + nz, bx - nx, y, bz - nz, ax + nx, y, az + nz, bx - nx, y, bz - nz, ax - nx, y, az - nz);
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
  bike.update(dt, ctl, {
    collision: w.collision,
    surfaceAt: w.surfaceAt,
    groundAt: state.photoOn ? (x, z, y) => state.photo.groundAt(x, z, y) : null,
  });
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

  blobShadow.visible = state.photoOn;
  if (state.photoOn) {
    blobShadow.position.set(bike.x, bike.y + 0.05, bike.z);
    blobShadow.rotation.z = -bike.heading;
  }

  // 太陽の影をプレイヤーの周りに
  sun.target.position.set(bike.x, 0, bike.z);
  sun.position.set(bike.x + sunDir.x * 500, sunDir.y * 500, bike.z + sunDir.z * 500);
  groundMats.water.normalMap.offset.set(state.playTime * 0.012, state.playTime * 0.02);

  rig.update(dt, bike, w.collision);
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
    if (state.photoOn && Math.random() < 0.15) updateAttribution();
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
  if (pause) {
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
$('look-btn').addEventListener('click', () => setPhotoMode(!state.photoOn));
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
  if (state.photoOn) state.photo.update();
  if (state.world) renderer.render(scene, camera);
}
requestAnimationFrame(frame);

if (params.get('autostart') === '1') startGame();
