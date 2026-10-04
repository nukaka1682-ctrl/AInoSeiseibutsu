// Toulouse à vélo — エントリーポイント。
// タイトル → 地図データ読み込み → 3D 都市の構築 → ゲームループ。
import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import { AREA_PRESETS, DEFAULT_AREA, TOUR_ROUTE } from './config.js';
import { Grid, LocalProjection, bboxAround, pointInPolygon, pointInRing } from './geo.js';
import { loadAreaData } from './data/load.js';
import { parseOsm } from './world/parse.js';
import { makeTextures } from './world/textures.js';
import { buildBuildings, createBuildingMaterials } from './world/buildings.js';
import { ORDER, buildGround, createGroundMaterials } from './world/ground.js';
import { buildTrees, fillParkTrees } from './world/trees.js';
import { CollisionWorld } from './game/collision.js';
import { RoadNetwork } from './game/roadnet.js';
import { Bike } from './game/bike.js';
import { CAMERA_LABELS, CameraRig } from './game/camera.js';
import { Input } from './game/input.js';
import { AudioFx } from './game/audio.js';
import { animateBeacon, createBeacon, distanceToLandmark, resolveLandmarks } from './game/landmarks.js';
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
};
window.__tav = state; // デバッグ・テスト用
state.rig = rig;
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
      onStatus: (t) => setLoading(t, 0.1),
    });
    setLoading(`地図データ: ${data.source}（OSM ${data.osm.elements.length.toLocaleString()} 要素 / IGN 建物 ${data.bdtopo.length.toLocaleString()} 棟）\n地図を解析中…`, 0.3);
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

// ---------------------------------------------------------------- 3D 都市の構築
async function buildWorld(data, bbox, progress) {
  const lat0 = (bbox.s + bbox.n) / 2, lon0 = (bbox.w + bbox.e) / 2;
  const proj = new LocalProjection(lat0, lon0);
  const rect = {
    minX: proj.project(lat0, bbox.w)[0], maxX: proj.project(lat0, bbox.e)[0],
    minZ: proj.project(bbox.n, lon0)[1], maxZ: proj.project(bbox.s, lon0)[1],
  };
  progress('建物・道路・水辺を解析中…', 0);
  await nextFrame();
  const parsed = parseOsm(data.osm, proj, rect, data.bdtopo);
  const roadnet = new RoadNetwork(parsed.roads);

  progress('道路と川を作成中…', 0.15);
  await nextFrame();
  const group = new THREE.Group();
  const ground = buildGround(parsed, rect, groundMats);
  group.add(ground.group);

  const collision = new CollisionWorld(rect);
  for (const b of parsed.buildings) {
    if (!b.info.collide) continue;
    collision.addRing(b.outer);
    for (const h of b.holes) collision.addRing(h);
  }
  for (const p of parsed.parts) if (!p.hasParent && p.info.collide) collision.addRing(p.outer);
  collision.inWater = ground.inWater;
  collision.onRoad = (x, z) => roadnet.onRoad(x, z, 0.4);

  // 木
  progress('街路樹を植えています…', 0.25);
  await nextFrame();
  const bGrid = new Grid(30);
  parsed.buildings.forEach((b, i) => bGrid.insertBounds(b.bounds.minX, b.bounds.minZ, b.bounds.maxX, b.bounds.maxZ, i));
  const insideBuilding = (x, z) => {
    let hit = false;
    bGrid.queryPoint(x, z, 0, (i) => {
      if (!hit && pointInRing(x, z, parsed.buildings[i].outer)) hit = true;
    });
    return hit;
  };
  const m = 30;
  const inRect = ([x, z]) => x > rect.minX - m && x < rect.maxX + m && z > rect.minZ - m && z < rect.maxZ + m;
  const extra = fillParkTrees(parsed.areas, parsed.trees, (x, z) => !roadnet.onRoad(x, z, 1.5) && !ground.inWater(x, z) && !insideBuilding(x, z));
  const treePts = parsed.trees.filter(inRect).concat(extra);
  const trees = buildTrees(treePts);
  group.add(trees);
  for (const [x, z] of trees.userData.points || []) collision.addCircle(x, z, 0.3);

  // 建物
  const buildings = await buildBuildings(parsed, buildingMats, (p) => progress(`建物を建てています… ${Math.round(p * 100)}%`, 0.3 + p * 0.6));
  group.add(buildings.group);

  // 路面の種類（転がり抵抗用）
  const greenGrid = new Grid(40);
  const greens = parsed.areas.filter((a) => a.type === 'grass' || a.type === 'forest' || a.type === 'pitch');
  greens.forEach((a, i) => greenGrid.insertBounds(a.bounds.minX, a.bounds.minZ, a.bounds.maxX, a.bounds.maxZ, i));
  const surfaceAt = (x, z) => {
    const s = roadnet.nearestSegment(x, z, roadnet.maxHalfWidth + 0.5);
    if (s && Math.sqrt(s.d2) < s.seg.road.width / 2 + 0.3) {
      const r = s.seg.road;
      if (/^(gravel|fine_gravel|compacted|dirt|ground|earth|grass|sand|unpaved)$/.test(r.surface)) return 'gravel';
      if (r.type === 'pedestrian' || r.type === 'living_street' || /^(paving_stones|sett|cobblestone)$/.test(r.surface)) return 'paving';
      return 'road';
    }
    let g = false;
    greenGrid.queryPoint(x, z, 0, (i) => {
      if (!g && pointInPolygon(x, z, greens[i])) g = true;
    });
    return g ? 'grass' : 'paving';
  };

  progress('名所を探しています…', 0.93);
  await nextFrame();
  const landmarks = resolveLandmarks(parsed, proj, rect, roadnet);
  for (const lm of landmarks) lm.discovered = state.discovered.has(lm.id);
  const map = new MapRenderer(parsed, rect);

  const beacon = createBeacon();
  group.add(beacon);
  const routeMesh = new THREE.Mesh(
    new THREE.BufferGeometry(),
    new THREE.MeshBasicMaterial({ color: '#2f7cf6', transparent: true, opacity: 0.55, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -8 }),
  );
  routeMesh.renderOrder = ORDER.route;
  routeMesh.frustumCulled = false;
  group.add(routeMesh);

  scene.add(group);
  return {
    proj, rect, parsed, roadnet, ground, collision, buildings, trees, landmarks, map, beacon, routeMesh, group, surfaceAt,
    stats: {
      buildings: buildings.stats,
      roads: parsed.roads.length,
      trees: treePts.length,
      source: data.source,
      fetchedAt: data.fetchedAt,
    },
  };
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

  let spawn = null;
  const capitole = w.landmarks.find((l) => l.id === 'place-capitole') || w.landmarks.find((l) => l.id === 'capitole');
  if (state.mode === 'tour') {
    const list = TOUR_ROUTE.map((id) => w.landmarks.find((l) => l.id === id)).filter(Boolean);
    if (list.length >= 3) {
      state.tour = { list, index: 1, started: false, time: 0, splits: [] };
      spawn = list[0].approach;
      setTarget(list[1]);
    } else {
      state.mode = 'free';
      toast('このエリアにはタイムアタックの名所が足りないため、自由走行で始めます');
    }
  }
  if (!spawn && capitole) spawn = capitole.approach;
  const p = w.roadnet.nearestRideablePoint(spawn ? spawn.x : 0, spawn ? spawn.z : 0, (x, z) => !w.collision.blockedByWater(x, z))
    || { x: 0, z: 0, heading: 0 };
  bike.place(p.x, p.z, p.heading);
  rig.initialized = false;

  show('loading-screen', false);
  show('hud');
  state.phase = 'play';
  updateModeHud();
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
    w.beacon.position.set(lm.approach.x, 0, lm.approach.z);
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
    tmpV.set(lm.x, lm.height, lm.z).project(camera);
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
  bike.update(dt, ctl, { collision: w.collision, surfaceAt: w.surfaceAt });
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
    $('hud-stats').innerHTML = `走行距離 ${fmtDist(bike.odometer)} · 最高 ${Math.round(bike.topSpeed)} km/h<br>${CAMERA_LABELS[rig.mode]}`;
    updateModeHud();
  }
  tickToast(dt);
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
      データ: ${s.source}${s.fetchedAt ? `（${new Date(s.fetchedAt).toLocaleDateString('ja-JP')} 取得）` : ''}</p>`;
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
    state.bike.place(p.x, p.z, p.heading);
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
    b.place(p.x, p.z, p.heading);
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
  if (state.world && state.phase === 'play') update(dt);
  if (state.world) renderer.render(scene, camera);
}
requestAnimationFrame(frame);

if (params.get('autostart') === '1') startGame();
