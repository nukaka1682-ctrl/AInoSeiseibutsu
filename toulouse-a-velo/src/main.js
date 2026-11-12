// Toulouse à vélo — エントリーポイント。
// タイトル → 地図データ読み込み → 3D 都市の構築 → ゲームループ。
import * as THREE from 'three';
import { AREA_PRESETS, DEFAULT_AREA, TOUR_ROUTE } from './config.js';
import { bboxAround } from './geo.js';
import { PROVIDER_LABEL, loadAreaData } from './data/load.js';
import { makeTextures } from './world/textures.js';
import { createBuildingMaterials } from './world/buildings.js';
import { ORDER, createGroundMaterials } from './world/ground.js';
import { assembleWorld } from './world/assemble.js';
import { assembleStreamWorld } from './world/stream.js';
import { loadBaseData } from './data/tiles.js';
import { fetchTerrainFile, loadTerrain } from './data/terrain.js';
import { Bike } from './game/bike.js';
import { CAMERA_LABELS, CameraRig } from './game/camera.js';
import { Input } from './game/input.js';
import { AudioFx } from './game/audio.js';
import { CityLife } from './game/citylife.js';
import { animateBeacon, createBeacon, distanceToLandmark } from './game/landmarks.js';
import { MapRenderer, drawFullMap, drawMinimap } from './ui/minimap.js';
import { setupScene } from './world/scene.js';
import { MEDAL_ICON, TOURS, fmtDelta, medalFor, medalTimes, nextMedal, loadRecord, pickTour, saveRecord, splitDelta, tourLength } from './game/tours.js';
import { Violets, planViolets } from './game/violets.js';
import { TravelStats, renderCarnet, stampDiscovery } from './ui/carnet.js';
import { PhotoMode } from './game/photomode.js';
import { restoreTitleSettings, saveTitleSettings } from './game/settings.js';

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

// ---------------------------------------------------------------- レンダラーとシーン（world/scene.js）
const { renderer, scene, camera, sky, sun, hemi, waterEnv, shadowFit, fitSunShadow: fitSunShadowAt } = setupScene($('app'));
const fitSunShadow = () => fitSunShadowAt(state.world?.terrain ? (x, z) => state.world.terrain.h(x, z) : null);

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
const travel = new TravelStats(store); // 旅の手帳の通算の記録

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
  tourId: 'classique', // タイムアタックのコース（game/tours.js の TOURS）
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
// タイムアタックのコースの選択（モードでタイムアタックを選んだときだけ見せる。?tour=garonne でも選べる）
for (const t of TOURS) $('opt-tour').add(new Option(`${t.ja}（${t.fr}）`, t.id));
if (TOURS.some((t) => t.id === params.get('tour'))) $('opt-tour').value = params.get('tour');
const showTourPick = () => show('tour-pick', document.querySelector('input[name=mode]:checked')?.value === 'tour');
for (const r of document.querySelectorAll('input[name=mode]')) r.addEventListener('change', showTourPick);
// タイトルの設定を前回のとおりに戻す（URL で指定した項目は URL を優先）。変えるたびに保存（opt-refresh は保存しない）
restoreTitleSettings($('title-screen'), store, params);
$('title-screen').addEventListener('change', () => saveTitleSettings($('title-screen'), store));
showTourPick();

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
  state.tourId = $('opt-tour').value || 'classique';
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
    const terrainFile = fetchTerrainFile(area.custom ? null : state.presetId); // 地図データと並行して
    const data = await loadAreaData({
      bbox,
      presetId: area.custom ? null : state.presetId,
      forceNetwork: $('opt-refresh').checked,
      provider: $('opt-ign').checked ? 'ign' : 'auto',
      onStatus: (t) => setLoading(t, 0.1),
    });
    setLoading(`地図データ: ${PROVIDER_LABEL[data.provider]}（${data.source}）\n地図を解析中…`, 0.3);
    await nextFrame();
    const { terrain } = await loadTerrain({ filePromise: terrainFile, bbox, osm: data.osm, onStatus: (t) => setLoading(t, 0.3) });
    state.world = await buildWorld(data, bbox, (t, p) => setLoading(`地図データ: ${data.source}\n${t}`, 0.3 + p * 0.65), terrain);
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
  const terrainFile = fetchTerrainFile(state.presetId); // 地図データと並行して
  const base = await loadBaseData({ bbox, presetId: state.presetId, forceNetwork, onStatus: (t) => setLoading(t, 0.08) });
  const { terrain } = await loadTerrain({ filePromise: terrainFile, bbox, osm: base.osm, onStatus: (t) => setLoading(t, 0.15) });
  const world = await assembleStreamWorld({
    base, bbox, presetId: state.presetId, buildingMats, groundMats, terrain,
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
async function buildWorld(data, bbox, progress, terrain) {
  return finishWorld(await assembleWorld(data, bbox, { buildingMats, groundMats, progress, pause: nextFrame, terrain }));
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
  // 街のにぎわい（歩く人・カフェの客・ハト）。設定で外したとき・?life=0 では出さない
  if ($('opt-life')?.checked !== false && params.get('life') !== '0') {
    world.life = new CityLife(world, { people: 70, radius: 110 });
    world.group.add(world.life.group);
  }
  // スミレ集め（自由走行のとき。集めた花はエリアごとに保存）
  const okPoint = (x, z) => !world.collision.blockedByWater(x, z) && !world.collision.outOfBounds(x, z);
  world.violets = new Violets(world, planViolets(world.landmarks, (x, z) => world.roadnet.nearestRideablePoint(x, z, okPoint)), store.get(`tav-violets-${state.presetId}`, []));
  world.group.add(world.violets.group);
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
    const first = pickTour(w.landmarks, state.tourId).list[0] || w.landmarks.find((l) => l.id === TOUR_ROUTE[0]);
    if (first) at = first.approach;
  }
  if (!at) at = (w.landmarks.find((l) => l.id === 'place-capitole') || w.landmarks.find((l) => l.id === 'capitole'))?.approach;
  return w.roadnet.nearestRideablePoint(at ? at.x : 0, at ? at.z : 0, (x, z) => !w.collision.blockedByWater(x, z)) || { x: 0, z: 0, heading: 0 };
}

// ワープした地点などの地面の高さ
function groundForTeleport(x, z, road = null) {
  // 橋の下の道路で橋の上に置かないように spawnY（地面の高さ。水の上だけ橋の面）。置く道そのものが橋なら橋の面
  const w = state.world;
  const onBridge = !!(road && (road.bridge || (road.layer || 0) > 0));
  return w?.spawnY ? w.spawnY(x, z, onBridge) : w?.heightAt ? w.heightAt(x, z) : 0;
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
  travel.reset(bike);
  state.playTime = 0;
  state.target = null;
  state.route = null;
  state.tour = null;
  toastQueue.length = 0;
  state.toastTimer = 0;

  if (state.mode === 'tour') {
    // 選んだコースが走れなければ classique（それも無理なら自由走行）
    const { tour: def, list, fellBack } = pickTour(w.landmarks, state.tourId);
    if (def) {
      const length = tourLength(list, (ax, az, bx, bz) => w.roadnet.route(ax, az, bx, bz));
      const times = medalTimes(length);
      state.tour = { list, index: 1, started: false, time: 0, splits: [], id: def.id, name: def.ja, length, times, record: loadRecord(store, state.presetId, def.id) };
      setTarget(list[1]);
      if (fellBack) toast(`このエリアには選んだコースの名所が足りないため、「${def.ja}」で走ります`, 4);
      toast(`🏁 <b>${def.ja}</b>（約 ${(length / 1000).toFixed(1)} km）<br>🥇 ${fmtClock(times.gold)}　🥈 ${fmtClock(times.silver)}　🥉 ${fmtClock(times.bronze)}`, 6);
    } else {
      state.mode = 'free';
      toast('このエリアにはタイムアタックの名所が足りないため、自由走行で始めます');
    }
  }
  if (w.violets) w.violets.group.visible = state.mode !== 'tour'; // タイムアタック中は集められない
  const p = spawnPoint(w);
  bike.place(p.x, p.z, p.heading, groundForTeleport(p.x, p.z, p.road));
  if (!w.stream) w.furniture?.cull(p.x, p.z, true); // 一度に作る街: 始まる前から近くの小物を描く（遊んでいる間は update で）
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

// メダルの時間（m:ss）
function fmtClock(s) {
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s - m * 60)).padStart(2, '0')}`;
}

function fmtDist(m) {
  return m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${Math.round(m)} m`;
}

function updateModeHud() {
  const t = state.tour;
  if (state.mode === 'tour' && t) {
    const m = t.times && medalFor(t.time, t.times); // 今ねらえるメダル
    $('hud-mode').innerHTML = `🏁 ${t.name || '名所めぐり'} ${t.index}/${t.list.length - 1}<br>⏱ ${fmtTime(t.time)}${m ? `　${MEDAL_ICON[m]} ${fmtClock(t.times[m])} まで` : ''}`;
  } else {
    const n = state.world?.landmarks.length || 0;
    const d = state.world?.landmarks.filter((l) => l.discovered).length || 0;
    const v = state.world?.violets;
    $('hud-mode').innerHTML = `🗺️ 発見した名所 ${d}/${n}${v?.total ? `<br>💜 ${v.collected.size}/${v.total}` : ''}`;
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
  // 坂・橋に沿うように 4 m ごとに区切り、自転車の高さから順にたどる（橋の下の道は橋の上に上げない）
  let prevY = state.bike?.y ?? 0;
  const yAt = (x, z) => {
    prevY = w.groundAt ? w.groundAt(x, z, prevY) : w.heightAt(x, z);
    return prevY + lift;
  };
  for (let i = 0; i + 1 < pts.length; i++) {
    const [px, pz] = pts[i], [qx, qz] = pts[i + 1];
    const l = Math.hypot(qx - px, qz - pz);
    if (l < 0.01) continue;
    const nx = (-(qz - pz) / l) * half, nz = ((qx - px) / l) * half;
    const steps = Math.max(1, Math.ceil(l / 4));
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
  } else w.furniture?.cull(bike.x, bike.z); // 街の小物は自転車の近くの物だけ描く
  if (holding) bike.speed = 0;
  else {
    bike.update(dt, ctl, {
      collision: w.collision,
      surfaceAt: w.surfaceAt,
      groundAt: w.groundAt || null,
      heightAt: w.heightAt || null,
      spawnY: w.spawnY || null,
      rideY: w.terrain && !w.terrain.flat ? w.rideY : null, // 地形の坂の勾配・崖
      roadnet: w.roadnet,
    });
  }
  state.playTime += dt;
  w.life?.update(dt, bike, camera);
  for (const ev of w.life?.events.splice(0) || []) if (ev.type === 'person') audio.bump(0.25);
  travel.tick(dt, bike);

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

  rig.applyLook(dt, ctl.look); // 右ドラッグ・右スティックで見回す
  rig.update(dt, bike, w.collision, w.groundAt ? (x, z) => w.groundAt(x, z, bike.y + 1) : null); // カメラが坂・河岸に潜らないように
  audio.update(dt, bike.speed, ctl.throttle === 0);

  // 名所の発見
  for (const lm of w.landmarks) {
    if (lm.discovered) continue;
    if (distanceToLandmark(lm, bike.x, bike.z) < 24) {
      lm.discovered = true;
      state.discovered.add(lm.id);
      store.set('tav-discovered', [...state.discovered]);
      stampDiscovery(store, lm.id); // 旅の手帳の「見つけた日」
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
        const delta = splitDelta(t.record, t.splits.length - 1, t.time); // 自己ベストとの差
        toast(`<b>✅ ${cur.ja}</b> ${fmtTime(t.time)}${delta == null ? '' : `（${fmtDelta(delta)}）`}<br>次は ${t.list[t.index].ja}`, 4, true);
        setTarget(t.list[t.index]);
      }
    }
  }

  // スミレ集め
  if (w.violets) for (const v of w.violets.update(dt, bike, state.playTime)) collectViolet(v);

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
    // 坂の表示（勾配が ±1.5 % 以上のとき）
    $('hud-grade').textContent = Math.abs(bike.grade) >= 0.015 ? `${bike.grade > 0 ? '▲' : '▼'} ${Math.round(Math.abs(bike.grade) * 100)}%` : '';
    $('hud-stats').innerHTML = `走行距離 ${fmtDist(bike.odometer)} · 最高 ${Math.round(bike.topSpeed)} km/h<br>${CAMERA_LABELS[rig.mode]}`;
    updateModeHud();
  }
  tickToast(dt);
}

function collectViolet(v) {
  const vs = state.world.violets;
  store.set(`tav-violets-${state.presetId}`, [...vs.collected]);
  audio.collect();
  toast(`💜 スミレ ${vs.collected.size} / ${vs.total}`, 2.5, true);
  const lm = state.world.landmarks.find((l) => l.id === v.lm);
  if (lm && vs.bouquetDone(lm.id)) toast(`💐 <b>${lm.ja}</b> のスミレの花束がそろいました`, 4);
  if (vs.remaining === 0) toast('👑 <b>トゥールーズのスミレを全部集めました！</b>', 6);
  updateModeHud();
}

// ミニマップと名所ラベル（描画フレームごと。テスト用のシミュレーションでは呼ばない）
function drawHud() {
  const w = state.world;
  const bike = state.bike;
  drawMinimap($('minimap'), w.map, {
    x: bike.x, z: bike.z, heading: bike.heading, zoom: 0.9, route: state.route, landmarks: w.landmarks, target: state.target,
    violets: w.violets?.group.visible ? w.violets.pending : null,
  });
  updateLabels();
}

function finishTour() {
  const t = state.tour;
  const medal = medalFor(t.time, t.times);
  const next = nextMedal(t.time, t.times);
  const prev = t.record; // 走る前の自己ベスト（区間の差を比べる）
  const { isBest, record } = saveRecord(store, state.presetId, t.id, t.time, t.splits.map((s) => s.time), medal);
  state.phase = 'result';
  input.enabled = false;
  const rows = t.splits.map((s, i) => {
    const lap = s.time - (i ? t.splits[i - 1].time : 0);
    const d = splitDelta(prev, i, s.time);
    return `<tr><td>${s.name}</td><td>${fmtTime(lap)}</td><td>${fmtTime(s.time)}</td><td class="${d == null ? '' : d < 0 ? 'delta-good' : 'delta-bad'}">${d == null ? '' : fmtDelta(d)}</td></tr>`;
  }).join('');
  $('result-text').innerHTML = `<p class="result-medal">${medal ? `${MEDAL_ICON[medal]} ${{ gold: '金', silver: '銀', bronze: '銅' }[medal]}メダル` : '完走'}<small>${t.name}（約 ${(t.length / 1000).toFixed(1)} km）</small></p>
    <p style="font-size:32px;font-weight:800;margin:8px 0">${fmtTime(t.time)}</p>
    <p>${isBest ? '🎉 自己ベスト更新！' : `自己ベスト: ${fmtTime(record.best)}`}${next ? `　${MEDAL_ICON[next.medal]} まであと ${next.seconds.toFixed(1)} 秒` : ''}</p>
    <table class="result-splits"><thead><tr><th>チェックポイント</th><th>区間</th><th>通過</th><th>自己ベスト比</th></tr></thead><tbody>${rows}</tbody></table>
    <p class="muted small">走行距離 ${fmtDist(state.bike.odometer)} · 最高速度 ${Math.round(state.bike.topSpeed)} km/h</p>`;
  show('result-screen');
}

// ---------------------------------------------------------------- 操作
function togglePause(force) {
  if (state.phase !== 'play' && state.phase !== 'paused') return;
  const pause = force ?? state.phase === 'play';
  state.phase = pause ? 'paused' : 'play';
  input.enabled = !pause;
  if (pause) travel.flush();
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
  mapXf = drawFullMap(c, w.map, { x: b.x, z: b.z, heading: b.heading, route: state.route, landmarks: w.landmarks, target: state.target, violets: w.violets?.group.visible ? w.violets.pending : null });
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
    state.bike.place(p.x, p.z, p.heading, groundForTeleport(p.x, p.z, p.road));
    rig.initialized = false;
    state.routeTimer = 0;
    openMap(false);
    toast('ワープしました', 2, true);
  }
});

// ---------------------------------------------------------------- 旅の手帳（J）
// 地図の画面と同じ扱い: 開いている間は操作を止める。ポーズ中に開いたらポーズを解いてから
function openCarnet(open) {
  if (open && state.phase === 'paused') togglePause(false);
  if (open && state.phase !== 'play') return;
  if (!open && state.phase !== 'carnet') return;
  state.phase = open ? 'carnet' : 'play';
  input.enabled = !open;
  show('carnet-screen', open);
  if (open) renderCarnetScreen();
  else $('carnet-body').innerHTML = '';
}

function renderCarnetScreen() {
  const w = state.world;
  travel.flush();
  const tours = TOURS.map((t) => {
    const record = loadRecord(store, state.presetId, t.id);
    return { ja: t.ja, fr: t.fr, record, icon: record?.medal ? MEDAL_ICON[record.medal] : '', available: pickTour(w.landmarks, t.id).tour === t };
  });
  renderCarnet($('carnet-body'), {
    landmarks: w.landmarks, bike: state.bike, stats: travel.data, violets: w.violets, discoveredAt: store.get('tav-discovered-at', {}) || {},
    tours, canGo: state.mode !== 'tour', fmtTime,
  }, (lm) => {
    setTarget(lm);
    openCarnet(false);
  });
}

// ---------------------------------------------------------------- 写真モード（F）
const photo = new PhotoMode({
  camera, canvas: renderer.domElement, keys: input.keys,
  getWorld: () => state.world, getBike: () => state.bike,
  render: () => renderFrame(0),
  onOpen: () => {
    state.phase = 'photo';
    input.enabled = false;
    show('hud', false);
  },
  onClose: () => {
    state.phase = 'play';
    input.enabled = true;
    show('hud');
    rig.initialized = false; // カメラの追従を元に戻す
  },
});
function openPhoto(open) {
  if (open) {
    if (state.phase === 'paused') togglePause(false);
    if (state.phase === 'play') photo.open();
  } else if (state.phase === 'photo') photo.close();
}
// テスト用
state.photo = { open: () => openPhoto(true), close: () => openPhoto(false), capture: () => photo.capture() };

function respawn() {
  if (state.phase !== 'play') return;
  const w = state.world;
  const b = state.bike;
  const p = w.roadnet.nearestRideablePoint(b.x, b.z, (x, z) => !w.collision.blockedByWater(x, z) && !w.collision.outOfBounds(x, z));
  if (p) {
    b.place(p.x, p.z, p.heading, groundForTeleport(p.x, p.z, p.road));
    rig.initialized = false;
  }
}

function backToTitle() {
  travel.flush();
  state.phase = 'title';
  input.enabled = true;
  for (const id of ['pause-screen', 'result-screen', 'map-screen', 'hud']) show(id, false);
  clearLabels();
  disposeWorld();
  show('title-screen');
}

input.on('Escape', () => (state.phase === 'map' ? openMap(false) : state.phase === 'carnet' ? openCarnet(false) : state.phase === 'photo' ? openPhoto(false) : togglePause()));
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
input.on('Space', () => {
  if (state.phase !== 'play') return;
  audio.bell();
  state.world?.life?.bell(state.bike);
});
input.on('KeyJ', () => openCarnet(state.phase !== 'carnet'));
input.on('KeyF', () => openPhoto(state.phase !== 'photo'));
input.bindTouch($('touch-controls'));
input.bindLook(renderer.domElement);

for (const btn of document.querySelectorAll('#hud-buttons button')) {
  btn.addEventListener('click', () => {
    const a = btn.dataset.action;
    if (a === 'map') openMap(true);
    else if (a === 'camera') rig.cycle();
    else if (a === 'bell') {
      audio.bell();
      state.world?.life?.bell(state.bike);
    }
    else if (a === 'pause') togglePause(true);
    else if (a === 'carnet') openCarnet(true);
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
$('carnet-btn').addEventListener('click', () => openCarnet(true));
$('photo-btn').addEventListener('click', () => openPhoto(true));
$('close-carnet').addEventListener('click', () => openCarnet(false));
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
  if (state.world.violets) state.world.violets.group.visible = true;
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
  if (state.world && state.phase === 'photo') photo.update(dt);
  if (state.world) {
    fitSunShadow();
    sky.position.copy(camera.position); // 空の箱はカメラと一緒に動かす（5 km のエリアの端でも空が切れないように）
    renderFrame(dt);
  }
}

// 描画の入口（写真モードの保存もここを通す）
function renderFrame(dt) {
  renderer.render(scene, camera);
}
requestAnimationFrame(frame);

if (params.get('autostart') === '1') startGame();
