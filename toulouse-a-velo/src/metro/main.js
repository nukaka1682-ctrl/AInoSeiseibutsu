// Toulouse en métro — エントリーポイント。
// タイトル（駅を選ぶ）→ 地図データ（自転車のゲームと同じトゥールーズ全体のタイル）・地形・メトロの出入口を読み込む →
// 駅のまわりの街並み・地下の駅・トンネル・電車を組み立てる → 歩く（一人称・三人称）・電車に乗る
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { AREA_PRESETS } from '../config.js';
import { bboxAround, closestOnSegment } from '../geo.js';
import { loadBaseData } from '../data/tiles.js';
import { fetchTerrainFile, loadTerrain } from '../data/terrain.js';
import { makeTextures } from '../world/textures.js';
import { createBuildingMaterials } from '../world/buildings.js';
import { createGroundMaterials } from '../world/ground.js';
import { assembleStreamWorld } from '../world/stream.js';
import { areaFrame } from '../world/assemble.js';
import { setupScene } from '../world/scene.js';
import { entranceFrame, inEntrance } from '../world/metro.js';
import { MapRenderer, drawMinimap } from '../ui/minimap.js';
import { LINES, LINE_COLORS, TRAIN_CARS, buildNetwork, runTime, stationFrame, stationList, terminusOf } from './network.js';
import { buildStationNav, planStation, stationLevelsFor } from './stationplan.js';
import { buildStationMesh } from './stationmesh.js';
import { Nav } from './nav.js';
import { Walker } from './walker.js';
import { Train } from './train.js';
import { tunnelBetween, tunnelBeyond } from './tunnel.js';
import { MetroAudio } from './audio.js';
import { disposeGroup } from './geom.js';
import { stationCrowd } from './crowd.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const PRESET = 'toulouse';
const WALK_LIMIT = 100; // 駅のまわりを歩ける範囲（m）
const WALK_HARD = 115;
const VMAX = 19, ACC = 1.1, DEC = 1.2; // VAL の最高速度（約 70 km/h）と加速・減速（m/s²）

// ---------------------------------------------------------------- レンダラー・シーン・光
const { renderer, scene, camera, sky, sun, hemi, waterEnv, fitSunShadow, LIGHT } = setupScene($('app'));
camera.near = 0.05;
camera.fov = 70;
camera.updateProjectionMatrix();
const surfaceEnv = scene.environment, surfaceEnvK = scene.environmentIntensity, surfaceFog = scene.fog;
const interiorEnv = (() => {
  const pm = new THREE.PMREMGenerator(renderer);
  const t = pm.fromScene(new RoomEnvironment(), 0.04).texture;
  pm.dispose();
  return t;
})();
// 地上と地下の光（地下は太陽なし、蛍光灯の白い光）
const LIGHTS = {
  surface: { hemiSky: new THREE.Color('#cfdcef'), hemiGround: new THREE.Color('#a48a76'), hemi: LIGHT.hemi, sun: LIGHT.sun },
  interior: { hemiSky: new THREE.Color('#fff8ec'), hemiGround: new THREE.Color('#c4bcae'), hemi: 1.45, sun: 0 },
};

const textures = makeTextures();
const buildingMats = createBuildingMaterials(textures);
const groundMats = createGroundMaterials(textures);
groundMats.water.envMap = waterEnv;
groundMats.water.envMapIntensity = 0.16;

const audio = new MetroAudio();
const walker = new Walker();
const nav = new Nav();

// ---------------------------------------------------------------- 状態
const state = {
  phase: 'title',
  world: null,
  network: null,
  stations: new Map(), // id → { station, plan, group, doors, layer }
  tunnels: new Map(),
  trains: [],
  station: null, // 歩いている所の駅（散歩の範囲の中心）
  camMode: params.get('cam') === 'tps' ? 'tps' : 'fps',
  viewYaw: 0,
  viewPitch: 0,
  time: 0,
  toastTimer: 0,
  lightMode: 'surface',
  lightK: 0, // 0 = 地上、1 = 地下
  spawnTimers: new Map(),
  ff: false,
  playerTrain: null,
  lastLimitWarn: 0,
};
window.__metro = state; // デバッグ・テスト用
window.__metroDebug = { THREE, scene, camera, renderer, walker, nav, sun, hemi };

// ---------------------------------------------------------------- タイトル
const allStations = stationList();
function fillStations() {
  const line = document.querySelector('input[name=line]:checked').value;
  const sel = $('station-select');
  const prev = sel.value;
  sel.innerHTML = '';
  for (const id of LINES[line]) {
    const s = allStations.find((q) => q.id === id);
    const o = document.createElement('option');
    o.value = id;
    o.textContent = `${s.name}（${s.ja}）${s.lines.length > 1 ? ' ⇄ A・B' : ''}`;
    sel.appendChild(o);
  }
  sel.value = LINES[line].includes(prev) ? prev : line === 'A' ? 'capitole' : 'jean-jaures';
}
for (const r of document.querySelectorAll('input[name=line]')) r.addEventListener('change', fillStations);
// URL で駅を指定したら、その駅の線を選ぶ
const wantStation = params.get('station');
const wantLine = params.get('line') || (wantStation && !LINES.A.includes(wantStation) && LINES.B.includes(wantStation) ? 'B' : null);
if (wantLine === 'B') document.querySelector('input[name=line][value=B]').checked = true;
fillStations();
if (wantStation && [...$('station-select').options].some((o) => o.value === wantStation)) $('station-select').value = wantStation;
if (params.get('start')) {
  const r = document.querySelector(`input[name=start][value=${params.get('start')}]`);
  if (r) r.checked = true;
}

const show = (id, on = true) => $(id).classList.toggle('hidden', !on);
function setLoading(text, p) {
  $('loading-text').textContent = text;
  if (p != null) $('loading-bar').style.width = `${Math.round(p * 100)}%`;
}

$('start-btn').addEventListener('click', () => startGame());
$('retry-btn').addEventListener('click', () => startGame());

// ---------------------------------------------------------------- 読み込み
let base = null; // 地図データ・地形・路線網（2 回目からは使い回す）

async function loadAll() {
  if (base) return base;
  const preset = AREA_PRESETS[PRESET];
  const bbox = bboxAround(preset.lat, preset.lon, preset.radius);
  const terrainFile = fetchTerrainFile(PRESET);
  const metroFile = fetch(`${import.meta.env.BASE_URL}data/${PRESET}-metro.json`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  const data = await loadBaseData({ bbox, presetId: PRESET, onStatus: (t) => setLoading(t, 0.08) });
  const { terrain } = await loadTerrain({ filePromise: terrainFile, bbox, osm: data.osm, onStatus: (t) => setLoading(t, 0.15) });
  terrain.metroWalk = true; // 出入口の吹き抜けの下の扉を開け、階段を下りられるように（world/ground.js・stream.js）
  const metro = await metroFile;
  const world = await assembleStreamWorld({
    base: data, bbox, presetId: PRESET, buildingMats, groundMats, terrain, near: 380, far: 650,
    progress: (t, p) => setLoading(`地図データ: IGN BD TOPO（${data.source}）\n${t}`, 0.2 + p * 0.25),
  });
  scene.add(world.group);
  // 路線網（駅の高さは地形と出入口から）
  const { proj } = areaFrame(bbox);
  const entrancesOf = (s) => (terrain.metro || []).filter((e) => e.kind === 'metro' && e.station === s.bd);
  const network = buildNetwork(proj, {
    bdStations: metro?.stations || null,
    levelOf: (s) => {
      const lv = stationLevelsFor(s, entrancesOf(s), terrain.h(s.x, s.z));
      return { ym: lv.ym, yp: lv.yp };
    },
  });
  const map = new MapRenderer(world.parsed, world.rect);
  base = { world, network, terrain, entrancesOf, map };
  setupSurfaceNav(world, terrain);
  return base;
}

// 地上を歩く: 街の地面（歩道の段・橋）と建物などの当たり判定。出入口の吹き抜けの中は地面がない（階段を下りる）。
// 駅から WALK_HARD m より遠くへは行けない
function setupSurfaceNav(world, terrain) {
  const pits = terrain.metro || [];
  nav.surface = {
    floorAt(x, z, y) {
      if (inEntrance(pits, x, z, 0)) return null;
      if (y < terrain.h(x, z) - 3) return null; // 地下（地上の床は届かない）
      if (state.station && Math.hypot(x - state.station.x, z - state.station.z) > WALK_HARD) {
        if (state.time - state.lastLimitWarn > 4) {
          state.lastLimitWarn = state.time;
          toast(`駅のまわり ${WALK_LIMIT} m ほどを散歩できます。<br>${state.station.name} 駅へ戻ろう`, 3, true);
        }
        return null;
      }
      if (world.collision.blockedByWater(x, z, y)) return null;
      return world.groundAt(x, z, y + 1);
    },
    near(x, z, y) {
      return y > terrain.h(x, z) - 2.5;
    },
    resolve(x, z, r) {
      return world.collision.resolve(x, z, r);
    },
    raycast(ax, az, bx, bz) {
      return world.collision.raycast(ax, az, bx, bz);
    },
  };
}

// ---------------------------------------------------------------- 駅・トンネルを組み立てる・捨てる
function ensureStation(id) {
  const b = base;
  if (state.stations.has(id)) return state.stations.get(id);
  const s = b.network.byId.get(id);
  const t0 = performance.now();
  const plan = planStation(s, b.entrancesOf(s), b.terrain.h(s.x, s.z), b.network);
  const layer = buildStationNav(plan);
  const streetAt = (x, z) => b.world.roadnet.streetNameAt(x, z)?.name || '';
  const mesh = buildStationMesh(plan, { streetAt });
  const crowd = stationCrowd(plan, layer, (s.id.length * 7919 + s.id.charCodeAt(0) * 31 + Math.floor(Math.random() * 1000)) | 0);
  if (crowd) mesh.group.add(crowd);
  scene.add(mesh.group);
  nav.add(layer);
  const rec = { station: s, plan, group: mesh.group, doors: mesh.doors, layer };
  state.stations.set(id, rec);
  console.info(`駅 ${s.name}: ${(performance.now() - t0).toFixed(0)} ms（通路 ${plan.corridors.length}、閉じた出入口 ${plan.closed.length}）`);
  for (const line of s.lines) {
    const i = LINES[line].indexOf(id);
    for (const j of [i - 1, i]) {
      if (j < 0 || j + 1 >= LINES[line].length) continue;
      const key = `${line}:${j}`;
      if (!state.tunnels.has(key)) {
        const g = tunnelBetween(b.network, line, j);
        scene.add(g);
        state.tunnels.set(key, g);
      }
    }
    for (const end of [-1, 1]) {
      if ((end < 0 && i === 0) || (end > 0 && i === LINES[line].length - 1)) {
        const key = `${line}:end${end}`;
        if (!state.tunnels.has(key)) {
          const g = tunnelBeyond(b.network, line, end);
          scene.add(g);
          state.tunnels.set(key, g);
        }
      }
    }
  }
  return rec;
}

// 今いる駅と、乗っている電車の次の駅のほかは捨てる
function releaseStations() {
  const keep = new Set();
  if (state.station) keep.add(state.station.id);
  for (const t of state.trains) {
    if (t.at) keep.add(t.at.id);
    if (t.player && t.stops[0]) keep.add(t.stops[0].id);
  }
  for (const [id, rec] of state.stations) {
    if (keep.has(id)) continue;
    scene.remove(rec.group);
    disposeGroup(rec.group);
    nav.remove(rec.layer);
    state.stations.delete(id);
  }
  // トンネル: 残した駅のとなりだけ
  const want = new Set();
  for (const id of keep) {
    const s = base.network.byId.get(id);
    for (const line of s.lines) {
      const i = LINES[line].indexOf(id);
      want.add(`${line}:${i - 1}`).add(`${line}:${i}`).add(`${line}:end-1`).add(`${line}:end1`);
    }
  }
  for (const [key, g] of state.tunnels) {
    if (want.has(key)) continue;
    scene.remove(g);
    disposeGroup(g);
    state.tunnels.delete(key);
  }
}

// ---------------------------------------------------------------- 電車の運行
// 歩いている駅の両方のホームに、電車がときどき着く。乗った電車は終点まで駅ごとに止まる
function stopsAfter(line, dir, S) {
  const st = base.network.lines[line].stations.filter((s) => (s.S[line] - S) * dir > 0.5);
  return dir > 0 ? st : st.reverse();
}

function spawnTrain(line, dir, station, { atStation = false } = {}) {
  const path = base.network.lines[line];
  const n = TRAIN_CARS[line];
  const t = new Train(line, n, dir, { id: `${line}${dir > 0 ? '+' : '-'}${Math.round(state.time)}` });
  t.path = path;
  // 1 つ前の駅とのあいだから（途中の駅に止まらない）
  const ids = LINES[line], i = ids.indexOf(station.id), prev = base.network.byId.get(ids[i - dir]);
  const back = prev ? Math.min(520, Math.abs(station.S[line] - prev.S[line]) - 75) : 520;
  const S0 = atStation ? station.S[line] : Math.max(0, Math.min(path.length, station.S[line] - dir * back));
  t.stops = stopsAfter(line, dir, S0 - dir * 1);
  t.state = 'run';
  t.speed = atStation ? 0 : VMAX;
  t.timer = 0;
  t.at = null;
  t.place(path, S0);
  t.layersOn = false;
  scene.add(t.group);
  state.trains.push(t);
  return t;
}

function removeTrain(t) {
  scene.remove(t.group);
  for (const c of t.cars) nav.remove(c.nav);
  t.dispose();
  state.trains.splice(state.trains.indexOf(t), 1);
  if (state.playerTrain === t) state.playerTrain = null;
}

// ホームドアとホームの壁の扉の所を、電車の扉と一緒に開け閉めする
function setPSD(station, line, side, open) {
  const rec = state.stations.get(station.id);
  if (!rec) return;
  for (const d of rec.doors) if (d.line === line && d.side === side) d.set(open);
  for (const w of rec.plan.psdWalls) if (w.line === line && w.side === side) w.wall.active = open < 0.85;
}

const DWELL = { open0: 0.8, open1: 2.3, chime: 17.5, close0: 19.5, close1: 21, go: 21.8 };

function updateTrains(dt) {
  const W = walker;
  for (const t of [...state.trains]) {
    const tdt = t.player && state.ff && t.state === 'run' ? dt * 5 : dt;
    if (t.state === 'run') {
      // 乗っている人のいない電車は、歩いている駅を出たら次の駅には止まらない（遠ざかって消える）
      const stop = t.player || !t.departed ? t.stops[0] : null;
      const target = stop ? stop.S[t.line] : t.S + t.dir * 400;
      const d = (target - t.S) * t.dir;
      let vt = Math.min(VMAX, Math.sqrt(2 * DEC * Math.max(0, d)));
      if (d > 0.05) vt = Math.max(vt, 0.5);
      t.speed = t.speed < vt ? Math.min(vt, t.speed + ACC * tdt) : Math.max(vt, t.speed - DEC * 1.6 * tdt);
      t.S += t.speed * t.dir * tdt;
      if (stop && d - t.speed * tdt <= 0.02 && t.speed < 0.6) {
        t.S = target;
        t.speed = 0;
        t.state = 'dwell';
        t.timer = 0;
        t.at = stop;
        t.stops.shift();
        ensureStation(stop.id);
        onArrive(t);
      }
      if (!stop && (t.S < -150 || t.S > t.path.length + 150 || d < 0)) {
        removeTrain(t);
        continue;
      }
      t.place(t.path, Math.max(-150, Math.min(t.path.length + 150, t.S)));
    } else if (t.state === 'dwell') {
      t.timer += dt;
      const T = t.timer, side = t.dir;
      let open = 0;
      if (T >= DWELL.open0 && T < DWELL.open1) open = (T - DWELL.open0) / (DWELL.open1 - DWELL.open0);
      else if (T >= DWELL.open1 && T < DWELL.close0) open = 1;
      else if (T >= DWELL.close0 && T < DWELL.close1) open = 1 - (T - DWELL.close0) / (DWELL.close1 - DWELL.close0);
      const terminus = !t.stops.length;
      // 終点: 乗っている人がいれば扉を開けたまま
      if (terminus && T >= DWELL.chime - 0.1 && t.player) {
        t.timer = DWELL.open1 + 1;
        open = 1;
      }
      if (open !== t.doorOpen) {
        if (t.doorOpen === 0 && open > 0) near(t) && audio.doors();
        if (t.doorOpen === 1 && open < 1) near(t) && audio.doors();
        t.setDoors(open);
        setPSD(t.at, t.line, side, open);
      }
      if (T >= DWELL.chime && T - dt < DWELL.chime && near(t)) audio.chime();
      if (T >= DWELL.go) {
        t.state = 'run';
        t.speed = 0;
        const from = t.at;
        t.at = null;
        t.departed = true;
        onDepart(t, from);
        releaseStations();
      }
    }
    // 近くの電車の車両は歩ける所に
    const close = Math.hypot(t.cars[0].group.position.x - W.x, t.cars[0].group.position.z - W.z) < 160 || t.player;
    if (close !== t.layersOn) {
      for (const c of t.cars) (close ? nav.add(c.nav) : nav.remove(c.nav));
      t.layersOn = close;
    }
    if (!t.player && Math.hypot(t.cars[0].group.position.x - W.x, t.cars[0].group.position.z - W.z) > 700) removeTrain(t);
  }
  // 歩いている駅のホームに電車を呼ぶ
  const st = state.station;
  if (st && state.stations.has(st.id) && placeKind() !== 'surface') {
    for (const line of st.lines) {
      for (const dir of [1, -1]) {
        const key = `${st.id}:${line}:${dir}`;
        if (!state.spawnTimers.has(key)) state.spawnTimers.set(key, state.time + 8 + Math.random() * 22);
        const coming = state.trains.some((t) => t.line === line && t.dir === dir && ((t.at === st) || (t.stops[0] === st)));
        if (coming || state.time < state.spawnTimers.get(key)) continue;
        const ids = LINES[line], i = ids.indexOf(st.id);
        // 終点の出発のホームには引き上げ線から（駅で待つ）。終点に着くホームにも電車は来る
        const startTerminus = (dir > 0 && i === 0) || (dir < 0 && i === ids.length - 1);
        const arriveTerminus = (dir > 0 && i === ids.length - 1) || (dir < 0 && i === 0);
        const t = spawnTrain(line, dir, st, { atStation: startTerminus });
        if (startTerminus) {
          t.stops = stopsAfter(line, dir, st.S[line]);
          t.state = 'dwell';
          t.timer = 0;
          t.at = st;
          ensureStation(st.id);
        } else t.stops = stopsAfter(line, dir, t.S - dir);
        void arriveTerminus;
        state.spawnTimers.set(key, state.time + 1e9); // 出発したら次を決める（onDepart）
      }
    }
  }
}

function near(t) {
  const c = t.cars[Math.floor(t.n / 2)].group.position;
  return t.player || Math.hypot(c.x - walker.x, c.z - walker.z) < 90;
}

function onArrive(t) {
  const st = t.at;
  if (t.player || (state.station === st && placeKind() === 'platform')) {
    audio.ding();
    const terminus = !t.stops.length;
    audio.announce(terminus ? `${st.name}. Terminus. Tout le monde descend.` : `${st.name}.`);
    if (t.player) toast(`<b>${st.name}</b>（${st.ja}）${terminus ? '<br>終点です。電車を降りよう' : ''}`, 4, true);
  }
}

function onDepart(t, from) {
  // 次の電車（2〜4 分の間隔をゲームでは 50〜110 秒に縮める）
  const key = `${from.id}:${t.line}:${t.dir}`;
  state.spawnTimers.set(key, state.time + 50 + Math.random() * 60);
  if (!t.stops.length) {
    // 終点から引き上げ線へ（乗っている人はいない）
    t.stops = [];
    return;
  }
  const next = t.stops[0];
  if (t.player) {
    ensureStation(next.id);
    base.world.stream.update(next.x, next.z); // 着く前に地上の街並みを読み込んでおく
    audio.announce(`Prochaine station : ${next.name}.`);
    toast(`次は <b>${next.name}</b>（${next.ja}）`, 3);
  }
}

// ---------------------------------------------------------------- 歩いている場所
function placeKind() {
  const r = walker.region;
  if (!r) return 'surface';
  if (r.layer?.pose) return 'train';
  if (r.pit) return 'pit';
  if (r.kind === 'platform' || (r.kind === 'escalator' && !r.pit) || (r.kind === 'stairs' && !r.pit && !r.corridor)) {
    return r.kind === 'platform' ? 'platform' : 'stairs';
  }
  if (r.kind === 'hall') return 'hall';
  return 'corridor';
}

// 歩いている所の駅（散歩の範囲の中心）
function updateCurrentStation() {
  const r = walker.region;
  let st = null;
  if (r?.layer?.pose) {
    // 電車の中: 停車中の駅か、次の駅
    const t = state.playerTrain;
    st = t ? t.at || t.stops[0] || state.station : state.station;
  } else if (r) {
    for (const rec of state.stations.values()) if (rec.layer === r.layer) st = rec.station;
  } else if (!r) {
    // 地上: 近い駅（いまの駅から離れすぎていなければそのまま）
    st = state.station;
  }
  if (st && st !== state.station) {
    state.station = st;
    for (const k of [...state.spawnTimers.keys()]) if (!k.startsWith(`${st.id}:`)) state.spawnTimers.delete(k);
    releaseStations();
  }
}

// ---------------------------------------------------------------- 光（地上 ⇄ 地下）
function updateLighting(dt) {
  const kind = placeKind();
  const camBelow = camera.position.y < base.terrain.h(camera.position.x, camera.position.z) - 1.2;
  const under = (kind !== 'surface' && kind !== 'pit') || (kind === 'pit' && camBelow && walker.y < base.terrain.h(walker.x, walker.z) - 2.6);
  const target = under ? 1 : 0;
  state.lightK += (target - state.lightK) * Math.min(1, dt * 3);
  if (Math.abs(target - state.lightK) < 0.002) state.lightK = target;
  const k = state.lightK, S = LIGHTS.surface, I = LIGHTS.interior;
  hemi.color.copy(S.hemiSky).lerp(I.hemiSky, k);
  hemi.groundColor.copy(S.hemiGround).lerp(I.hemiGround, k);
  hemi.intensity = S.hemi + (I.hemi - S.hemi) * k;
  sun.intensity = S.sun * (1 - k);
  const wantShadow = $('opt-shadows').checked && k < 0.5;
  if (sun.castShadow !== wantShadow) sun.castShadow = wantShadow;
  scene.environment = k > 0.5 ? interiorEnv : surfaceEnv;
  scene.environmentIntensity = k > 0.5 ? 0.3 : surfaceEnvK;
  // 地上の街は、地下の深い所（ホーム・改札階・電車）では描かない
  const deep = (kind === 'platform' || kind === 'train' || kind === 'hall' || kind === 'stairs') && !state.freeCam;
  base.world.group.visible = !deep && !state.hideCity;
  sky.visible = !deep;
  scene.fog = deep ? null : surfaceFog;
}

// ---------------------------------------------------------------- カメラ
const camTmp = new THREE.Vector3(), lookTmp = new THREE.Vector3();
function updateCamera(dt) {
  state.viewYaw += walker.carried || 0;
  if (state.freeCam) {
    // デバッグ用: 好きな位置から見る（{ pos: [x, y, z], look: [x, y, z] }）
    camera.position.set(...state.freeCam.pos);
    camera.lookAt(...state.freeCam.look);
    walker.root.visible = true;
    return;
  }
  const yaw = state.viewYaw, pitch = state.viewPitch;
  const fx = Math.sin(yaw) * Math.cos(pitch), fy = Math.sin(pitch), fz = -Math.cos(yaw) * Math.cos(pitch);
  walker.eye(camTmp);
  walker.root.visible = state.camMode === 'tps';
  $('crosshair').style.display = state.camMode === 'fps' ? '' : 'none';
  if (state.camMode === 'fps') {
    camera.position.copy(camTmp);
    lookTmp.set(camTmp.x + fx, camTmp.y + fy, camTmp.z + fz);
    camera.lookAt(lookTmp);
    return;
  }
  // 三人称: 後ろ上から。中（駅・電車）は近く低く、壁の手前に寄せる
  const kind = placeKind();
  const indoor = kind !== 'surface';
  const inCar = kind === 'train';
  let dist = inCar ? 1.7 : indoor ? 2.6 : 3.6;
  const head = camTmp.clone();
  head.y -= 0.12;
  const hx = -Math.sin(yaw), hz = Math.cos(yaw);
  const cy = Math.min(head.y + 0.35 - pitch * dist * 0.9, walker.smoothY + (inCar ? 1.95 : indoor ? 2.35 : 6));
  const t = nav.raycast(head.x, head.z, head.x + hx * (dist + 0.3), head.z + hz * (dist + 0.3), (cy + head.y) / 2);
  dist = Math.max(0.35, Math.min(dist, (dist + 0.3) * t - 0.3));
  const target = new THREE.Vector3(head.x + hx * dist, cy, head.z + hz * dist);
  if (!state.camInit) {
    camera.position.copy(target);
    state.camInit = true;
  } else camera.position.lerp(target, Math.min(1, dt * 12));
  lookTmp.set(head.x + fx * 4, head.y + fy * 4 - 0.1, head.z + fz * 4);
  camera.lookAt(lookTmp);
}

// ---------------------------------------------------------------- 入力（キーボード・マウス・ゲームパッド・タッチ）
const keys = new Set();
const touch = { fwd: false, back: false, left: false, right: false };
addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
  keys.add(e.code);
  if (!e.repeat) onKey(e.code);
  if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space', 'Tab'].includes(e.code)) e.preventDefault();
  audio.resume();
});
addEventListener('keyup', (e) => keys.delete(e.code));
addEventListener('blur', () => keys.clear());
const canvas = renderer.domElement;
canvas.addEventListener('click', () => {
  if (state.phase === 'play' && document.pointerLockElement !== canvas) canvas.requestPointerLock?.();
});
addEventListener('mousemove', (e) => {
  if (state.phase !== 'play' || document.pointerLockElement !== canvas) return;
  state.viewYaw += e.movementX * 0.0025;
  state.viewPitch = Math.max(-1.3, Math.min(1.2, state.viewPitch - e.movementY * 0.0025));
});
// タッチ: 右半分をなぞると見回す
let lastTouch = null;
canvas.addEventListener('touchstart', (e) => {
  const t = e.changedTouches[0];
  lastTouch = { id: t.identifier, x: t.clientX, y: t.clientY };
}, { passive: true });
canvas.addEventListener('touchmove', (e) => {
  for (const t of e.changedTouches) {
    if (!lastTouch || t.identifier !== lastTouch.id) continue;
    state.viewYaw += (t.clientX - lastTouch.x) * 0.006;
    state.viewPitch = Math.max(-1.3, Math.min(1.2, state.viewPitch - (t.clientY - lastTouch.y) * 0.006));
    lastTouch.x = t.clientX;
    lastTouch.y = t.clientY;
  }
}, { passive: true });
for (const btn of document.querySelectorAll('#touch-controls [data-touch]')) {
  const k = btn.dataset.touch;
  const set = (v) => (e) => {
    e.preventDefault();
    touch[k] = v;
  };
  btn.addEventListener('pointerdown', set(true));
  btn.addEventListener('pointerup', set(false));
  btn.addEventListener('pointerleave', set(false));
}
if (matchMedia('(pointer: coarse)').matches) $('touch-controls').style.display = 'flex';

const prevPad = [];
function readControls(dt) {
  const k = keys;
  let fwd = (k.has('KeyW') || k.has('ArrowUp') || touch.fwd ? 1 : 0) - (k.has('KeyS') || k.has('ArrowDown') || touch.back ? 1 : 0);
  let side = (k.has('KeyD') ? 1 : 0) - (k.has('KeyA') ? 1 : 0);
  const turn = (k.has('ArrowRight') || touch.right ? 1 : 0) - (k.has('ArrowLeft') || touch.left ? 1 : 0);
  state.viewYaw += turn * dt * 1.8;
  let run = k.has('ShiftLeft') || k.has('ShiftRight');
  const pad = navigator.getGamepads ? [...navigator.getGamepads()].find((p) => p && p.connected) : null;
  if (pad) {
    const dz = (v) => (Math.abs(v) > 0.15 ? v : 0);
    fwd -= dz(pad.axes[1] || 0);
    side += dz(pad.axes[0] || 0);
    state.viewYaw += dz(pad.axes[2] || 0) * dt * 2.4;
    state.viewPitch = Math.max(-1.3, Math.min(1.2, state.viewPitch - dz(pad.axes[3] || 0) * dt * 1.8));
    run = run || !!pad.buttons[10]?.pressed || !!pad.buttons[5]?.pressed;
    const map = { 3: 'KeyV', 8: 'KeyM', 9: 'Escape', 1: 'KeyT' };
    for (const [i, code] of Object.entries(map)) {
      const p = !!pad.buttons[i]?.pressed;
      if (p && !prevPad[i]) onKey(code);
      prevPad[i] = p;
    }
  }
  state.ff = (k.has('KeyT') || (pad && pad.buttons[1]?.pressed)) && !!state.playerTrain;
  return { fwd: Math.max(-1, Math.min(1, fwd)), side: Math.max(-1, Math.min(1, side)), run };
}

function onKey(code) {
  if (code === 'Escape') {
    if (state.phase === 'map') return openMap(false);
    return togglePause();
  }
  if (state.phase === 'map' && code === 'KeyM') return openMap(false);
  if (state.phase !== 'play') return;
  if (code === 'KeyV' || code === 'KeyC') toggleCam();
  else if (code === 'KeyM') openMap(true);
  else if (code === 'KeyP') togglePause();
}

function toggleCam() {
  state.camMode = state.camMode === 'fps' ? 'tps' : 'fps';
  state.camInit = false;
  toast(state.camMode === 'fps' ? '一人称視点' : '三人称視点', 1.2, true);
}

for (const btn of document.querySelectorAll('#hud-buttons button')) {
  btn.addEventListener('click', () => {
    const a = btn.dataset.action;
    if (a === 'map') openMap(true);
    else if (a === 'camera') toggleCam();
    else if (a === 'pause') togglePause(true);
    btn.blur();
  });
}

// ---------------------------------------------------------------- HUD
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
  if (next) setTimeout(() => toast(...next), 300);
}

const badge = (line) => `<span class="badge ${line.toLowerCase()}">${line}</span>`;
let hudTimer = 0;
function updateHud(dt) {
  hudTimer -= dt;
  tickToast(dt);
  if (hudTimer > 0) return;
  hudTimer = 0.25;
  const st = state.station, kind = placeKind(), r = walker.region;
  const lines = st ? st.lines.map(badge).join('') : '';
  let where = '';
  if (kind === 'train') {
    const t = state.playerTrain;
    const car = t ? t.cars.findIndex((c) => c.nav === r.layer) + 1 : 0;
    where = `🚇 VAL 208 · ${t ? `${badge(t.line)}${terminusOf(base.network, t.line, t.dir).name} 方面 · ${car} 両目` : ''}`;
  } else if (kind === 'platform') {
    const term = terminusOf(base.network, r.line, r.side);
    where = `${badge(r.line)}ホーム（${term.name} 方面）`;
  } else if (kind === 'stairs') where = 'ホームへの階段';
  else if (kind === 'hall') where = '改札階（salle des billets）';
  else if (kind === 'corridor') where = '駅の通路';
  else if (kind === 'pit') where = '出入口の階段';
  else if (st) {
    const d = Math.hypot(walker.x - st.x, walker.z - st.z);
    const street = base.world.roadnet.streetNameAt(walker.x, walker.z)?.name || '';
    where = `地上 · 駅から ${Math.round(d)} m / ${WALK_LIMIT} m${street ? ` · ${street}` : ''}`;
  }
  $('hud-place').innerHTML = st ? `${lines}<b>${st.name}</b> <small>${st.ja}</small><br>${where}` : where;
  // 車内・ホームの案内表示
  const ride = $('hud-ride');
  const t = state.playerTrain;
  if (kind === 'train' && t) {
    const next = t.state === 'dwell' ? t.at : t.stops[0];
    ride.innerHTML = t.state === 'dwell' ? `${next?.name || ''}<small>${t.stops.length ? '扉が開いています' : 'Terminus · 終点'}</small>`
      : `Prochaine station : ${next?.name || '—'}<small>次は ${next?.ja || ''}${state.ff ? ' · ⏩ 早送り' : ' · T で早送り'}</small>`;
    show('hud-ride', true);
  } else if (kind === 'platform' && st) {
    const dir = r.side, line = r.line;
    const tr = state.trains.find((q) => q.line === line && q.dir === dir && (q.at === st || q.stops[0] === st));
    let eta = '';
    if (tr && tr.at === st) eta = 'À quai · 停車中';
    else if (tr) {
      const d = Math.abs(st.S[line] - tr.S);
      eta = `${Math.max(0, Math.round(runTime(d, Math.max(tr.speed, 4))))} s`;
    } else {
      const due = state.spawnTimers.get(`${st.id}:${line}:${dir}`);
      eta = due && due < 1e8 ? `${Math.max(1, Math.round((due - state.time + 30) / 60))} min` : '…';
    }
    ride.innerHTML = `${line} ▸ ${terminusOf(base.network, line, dir).name}  ${eta}<small>次の電車</small>`;
    show('hud-ride', true);
  } else show('hud-ride', false);
  $('hud-view').textContent = `${state.camMode === 'fps' ? '一人称' : '三人称'}（V で切替）`;
  // ミニマップ
  drawMinimap($('minimap'), base.map, { x: walker.x, z: walker.z, heading: state.viewYaw, zoom: 1.2, landmarks: [] });
  drawMinimapOverlay();
}

// ミニマップに散歩の範囲（駅から 100 m）と出入口
function drawMinimapOverlay() {
  const st = state.station;
  if (!st) return;
  const c = $('minimap'), ctx = c.getContext('2d'), W = c.width, zoom = 1.2;
  ctx.save();
  ctx.beginPath();
  ctx.arc(W / 2, W / 2, W / 2 - 2, 0, Math.PI * 2);
  ctx.clip();
  ctx.translate(W / 2, W / 2);
  ctx.rotate(-state.viewYaw);
  ctx.scale(zoom, zoom);
  ctx.translate(-walker.x, -walker.z);
  ctx.strokeStyle = 'rgba(29,42,85,0.8)';
  ctx.setLineDash([6, 4]);
  ctx.lineWidth = 2 / zoom;
  ctx.beginPath();
  ctx.arc(st.x, st.z, WALK_LIMIT, 0, Math.PI * 2);
  ctx.stroke();
  ctx.setLineDash([]);
  for (const e of base.entrancesOf(st)) {
    ctx.fillStyle = '#f9b80d';
    ctx.strokeStyle = '#1d2a55';
    ctx.lineWidth = 1.5 / zoom;
    const f = entranceFrame(e), P = [f.at(-e.len / 2, -e.wid / 2), f.at(e.len / 2, -e.wid / 2), f.at(e.len / 2, e.wid / 2), f.at(-e.len / 2, e.wid / 2)];
    ctx.beginPath();
    P.forEach(([x, z], i) => (i ? ctx.lineTo(x, z) : ctx.moveTo(x, z)));
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }
  ctx.fillStyle = '#1d2a55';
  ctx.beginPath();
  ctx.arc(st.x, st.z, 5 / zoom, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

// ---------------------------------------------------------------- 路線図（M）
function openMap(open) {
  if (open && state.phase !== 'play') return;
  if (!open && state.phase !== 'map') return;
  state.phase = open ? 'map' : 'play';
  show('map-screen', open);
  if (open) {
    document.exitPointerLock?.();
    renderLineMap();
  }
}
$('close-map').addEventListener('click', () => openMap(false));

function renderLineMap() {
  const net = base.network;
  const pts = net.stations.map((s) => [s.x, s.z]);
  const minX = Math.min(...pts.map((p) => p[0])), maxX = Math.max(...pts.map((p) => p[0]));
  const minZ = Math.min(...pts.map((p) => p[1])), maxZ = Math.max(...pts.map((p) => p[1]));
  const W = 1000, H = 760, pad = 60, k = Math.min((W - 2 * pad) / (maxX - minX), (H - 2 * pad) / (maxZ - minZ));
  const X = (x) => pad + (x - minX) * k, Y = (z) => pad + (z - minZ) * k;
  let svg = `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg"><rect width="${W}" height="${H}" fill="#f6f3ee" rx="14"/>`;
  for (const [line, path] of Object.entries(net.lines)) {
    const d = path.pts.filter((_, i) => i % 6 === 0).map((p, i) => `${i ? 'L' : 'M'}${X(p.x).toFixed(1)},${Y(p.z).toFixed(1)}`).join('');
    svg += `<path d="${d}" fill="none" stroke="${LINE_COLORS[line]}" stroke-width="9" stroke-linecap="round" stroke-linejoin="round"/>`;
  }
  for (const s of net.stations) {
    const here = state.station === s;
    const lab = s.name.replace(' – ', '-');
    const right = s.x < (minX + maxX) / 2 ? -1 : 1;
    svg += `<g class="st${here ? ' here' : ''}" data-id="${s.id}"><circle cx="${X(s.x)}" cy="${Y(s.z)}" r="${s.lines.length > 1 ? 9 : 6}" fill="#fff" stroke="#222" stroke-width="2.5"/>`
      + `<text x="${X(s.x) + right * 12}" y="${Y(s.z) + 4}" text-anchor="${right > 0 ? 'start' : 'end'}">${lab}</text></g>`;
  }
  svg += '</svg>';
  $('line-map').innerHTML = svg;
  for (const g of $('line-map').querySelectorAll('.st')) {
    g.addEventListener('click', () => {
      const s = net.byId.get(g.dataset.id);
      openMap(false);
      teleportToPlatform(s, s.lines[0], 1);
    });
  }
}

// ---------------------------------------------------------------- はじめる・移動する
function teleportToPlatform(s, line, side) {
  const rec = ensureStation(s.id);
  state.station = s;
  releaseStations();
  const L = rec.plan.lines.find((q) => q.line === line);
  const f = L.frame, [x, z] = f.at(-6 * side, 4.8 * side);
  walker.place(x, L.yp, z);
  walker.region = nav.floorAt(x, z, L.yp)?.region || null;
  // ホームドアの方を向く
  state.viewYaw = Math.atan2(-f.nx * side, f.nz * side);
  state.viewPitch = 0;
  state.camInit = false;
  base.world.stream.update(s.x, s.z);
  for (const t of [...state.trains]) if (!t.player) removeTrain(t);
  state.spawnTimers.clear();
}

async function startGame() {
  audio.init();
  audio.resume();
  const id = $('station-select').value;
  const start = document.querySelector('input[name=start]:checked').value;
  renderer.setPixelRatio(Math.min(devicePixelRatio, $('opt-hires').checked ? 2 : 1.25));
  show('title-screen', false);
  show('error-screen', false);
  show('loading-screen');
  setLoading('準備中…', 0.02);
  try {
    const b = await loadAll();
    const s = b.network.byId.get(id);
    setLoading(`${s.name} 駅を組み立て中…`, 0.5);
    await new Promise((r) => setTimeout(r, 30));
    for (const t of [...state.trains]) removeTrain(t);
    state.station = s;
    const rec = ensureStation(s.id);
    releaseStations();
    // 地上の街並み（駅のまわり）
    b.world.stream.update(s.x, s.z);
    await b.world.stream.ensure(s.x, s.z, start === 'street' ? 260 : 140, (done, total) =>
      setLoading(`${s.name} 駅のまわりの街並みを組み立て中… ${done}/${total}\n（建物: IGN BD TOPO、塀と木: 地籍と LiDAR の実測）`, 0.55 + (0.4 * done) / Math.max(1, total)));
    // はじめる場所
    const line = s.lines[0];
    if (start === 'street') {
      const open = rec.plan.pits.filter((e) => !rec.plan.closed.includes(e));
      const e = open[0] || rec.plan.pits[0];
      const f = entranceFrame(e);
      const [x, z] = f.at(-e.len / 2 - 3.5, 0);
      walker.place(x, b.world.groundAt(x, z, 999), z);
      walker.region = null;
      state.viewYaw = Math.atan2(f.dx, -f.dz);
      state.viewPitch = -0.12;
    } else if (start === 'platform') {
      teleportToPlatform(s, line, 1);
    } else {
      // 電車で着く: 1 つ前の駅を出たところの電車の中（終点なら逆向き）
      const ids = LINES[line], i = ids.indexOf(s.id);
      const dir = i > 0 ? 1 : -1;
      const t = spawnTrain(line, dir, s);
      t.S = s.S[line] - dir * Math.min(420, Math.abs(s.S[line] - b.network.byId.get(ids[i - dir]).S[line]) - 60);
      t.speed = VMAX * 0.9;
      t.stops = stopsAfter(line, dir, t.S - dir);
      t.place(t.path, t.S);
      t.player = true;
      state.playerTrain = t;
      for (const c of t.cars) nav.add(c.nav);
      t.layersOn = true;
      const car = t.cars[Math.floor(t.n / 2)];
      const p = car.pose;
      walker.place(p.x + p.fx * 1.6, p.y, p.z + p.fz * 1.6);
      walker.region = nav.floorAt(walker.x, walker.z, walker.y)?.region || null;
      // 進む向きの右（ホームの側）の窓を向く
      state.viewYaw = Math.atan2(p.fx, -p.fz) + Math.PI / 2 * 0.6;
      state.viewPitch = -0.05;
      audio.announce(`Prochaine station : ${s.name}.`);
    }
    walker.yaw = state.viewYaw;
    if (!walker.root.parent) scene.add(walker.root);
    state.camInit = false;
    show('loading-screen', false);
    show('hud');
    state.phase = 'play';
    toast(`<b>Bienvenue dans le métro de Toulouse !</b><br>${s.name}（${s.ja}）駅。W A S D で歩く、マウスで見回す（画面をクリック）、V で一人称 ⇄ 三人称`, 7);
  } catch (err) {
    console.error(err, err?.stack);
    show('loading-screen', false);
    show('error-screen');
    $('error-text').textContent = String(err.message || err);
  }
}

function togglePause(force) {
  if (state.phase !== 'play' && state.phase !== 'paused') return;
  const pause = force ?? state.phase === 'play';
  state.phase = pause ? 'paused' : 'play';
  if (pause) {
    document.exitPointerLock?.();
    const st = state.station;
    $('pause-info').innerHTML = st ? `<p>${st.name}（${st.ja}）駅 · ${st.lines.map((l) => `${l} 線`).join('・')}<br>地上の街並み: ${base.world.stream.readyCount} タイル（500 m 四方）</p>` : '';
  }
  show('pause-screen', pause);
}
$('resume-btn').addEventListener('click', () => togglePause(false));
$('mute-btn').addEventListener('click', () => {
  audio.setMuted(!audio.muted);
  $('mute-btn').textContent = `音: ${audio.muted ? 'オフ' : 'オン'}`;
});
$('title-btn').addEventListener('click', () => {
  state.phase = 'title';
  show('pause-screen', false);
  show('hud', false);
  show('title-screen');
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden && state.phase === 'play') togglePause(true);
});
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// ---------------------------------------------------------------- 毎フレーム
function update(dt, ctl = null) {
  state.time += dt;
  updateTrains(dt);
  walker.update(dt, ctl || readControls(dt), nav, state.viewYaw);
  for (const ev of walker.events.splice(0)) if (ev.type === 'step') audio.step(ev.surface === 'street' || !walker.region ? 'street' : 'tile', ev.run);
  // 乗っている電車
  const lay = walker.region?.layer;
  const t = lay?.pose ? state.trains.find((q) => q.cars.some((c) => c.nav === lay)) : null;
  if (t !== state.playerTrain) {
    if (state.playerTrain) state.playerTrain.player = false;
    state.playerTrain = t || null;
    if (t) t.player = true;
  }
  updateCurrentStation();
  base.world.stream.update(state.station ? state.station.x : walker.x, state.station ? state.station.z : walker.z);
  // 音
  let near = null, nd = Infinity;
  for (const q of state.trains) {
    const c = q.cars[0].group.position, d = Math.hypot(c.x - walker.x, c.z - walker.z);
    if (d < nd) [near, nd] = [q, d];
  }
  const kind = placeKind();
  audio.update(dt, { trainSpeed: state.playerTrain ? state.playerTrain.speed : near ? near.speed : 0, trainDist: nd, inTrain: kind === 'train', place: kind === 'surface' || kind === 'pit' ? 'surface' : kind === 'train' ? 'train' : 'station' });
}

let last = performance.now();
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (!base || state.phase === 'title') {
    return;
  }
  if (state.phase === 'play') update(dt);
  updateLighting(dt);
  updateCamera(dt);
  if (state.phase === 'play') updateHud(dt);
  if (sun.castShadow) fitSunShadow((x, z) => base.terrain.h(x, z));
  sky.position.copy(camera.position);
  renderer.render(scene, camera);
}
requestAnimationFrame(frame);

// テスト用: 描画とは別に seconds 秒ぶん進める（ctl: { fwd, side, run }）
window.__metroSimulate = (seconds, ctl = { fwd: 0, side: 0, run: false }, step = 1 / 30) => {
  for (let t = 0; t < seconds; t += step) {
    update(step, ctl);
    updateLighting(step);
  }
};
window.__metroApi = { ensureStation, teleportToPlatform, toggleCam, spawnTrain, placeKind, closestOnSegment, stationFrame, runTime };

if (params.get('autostart') === '1') startGame();
