// 街を走るもの: ① ほかの自転車乗り（車道・自転車道の右側を走る）② トラム（T1 / T2。線路・芝の軌道・架線は ground.js が描いている）。
// 走る自動車は作らない（信号・交差点の決まりが要るので）。計算のうち three.js に依らない所は trafficlogic.js（単体テスト）。
// 自転車（プレーヤー）の x / z / speed を書き換えるのは、ほかの自転車乗りに横から重なったとき（横へ 0.3 m 押す）と、
// トラムの車体に重なったとき（車体の横へ押し出す）だけ。
// 描画コール: 自転車乗り 5（車体・車輪・上半身・腿・すね。影は車体と上半身の 2）、トラム 4（中間車体・先頭車体・パンタグラフ・灯火）
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { mulberry32 } from '../geo.js';
import { oldTownTest } from '../config.js';
import { CAR_ROADS } from '../world/parse.js';
import { HIP_Y, PALETTE, armGeometry, handGeometry, headGeometry, torsoGeometry } from '../metro/people.js';
import { respawnPoint } from './lifelogic.js';
import { chainRails, laneOffset, legIK, LEG, makePath, nearOnPath, nextSegment, pointAlong, slopeFactor, stopsAlong, tramSpeed } from './trafficlogic.js';

const FAR = 260; // 自転車乗り: これより遠くなったら置き直す（m）
const PLACE_IN = 120, PLACE_OUT = 220; // 置き直す輪（m）
const CAM_CLEAR = 100; // カメラからこれより近くには置き直さない（m）
const BLEND = 4; // 区間の変わり目をなめらかに曲がる長さ（m）
const WHEEL_R = 0.34;
const TRAM_LEN = 32, CAR_GAP = 6.4, CARS = 5; // Citadis 302: 全長 32 m、5 車体
const TRAM_HALF = 1.2 + 0.3; // 車体の半分の幅 + 余裕（プレーヤーを押し出す）
const MAX_TRAMS = 4;
const TRAM_DRAW = 500; // 自転車からこれより遠いトラムは描かない（m）
const isCyclable = (s) => s.bike && (CAR_ROADS.has(s.road.type) || s.road.type === 'cycleway');

// 使い回す行列・ベクトル（毎フレーム new しない）
const _M = new THREE.Matrix4(), _L = new THREE.Matrix4(), _R = new THREE.Matrix4(), _S = new THREE.Matrix4();
const _Q = new THREE.Quaternion(), _E = new THREE.Euler(), _V = new THREE.Vector3(), _ONE = new THREE.Vector3(1, 1, 1), _W = new THREE.Vector3();
const _P = {}, _P2 = {};
const _LEG = { hip: [0, 0, 0], knee: [0, 0, 0], foot: [0, 0, 0] };

export class Traffic {
  // world: assembleWorld / assembleStreamWorld の結果
  constructor(world, { cyclists = 6, seed = 41 } = {}) {
    this.world = world;
    this.rnd = mulberry32(seed);
    this.events = [];
    this.night = false;
    this.clock = 0;
    this.started = false;
    this.group = new THREE.Group();
    this.group.name = 'traffic';
    this.inOld = oldTownTest(world.proj);
    this.uNight = { value: 0 };

    // ① 自転車乗り: 人ごとの見た目（自転車の色・服の色）は固定。置き直すときは場所だけ変える
    const rnd = this.rnd;
    const FRAMES = ['#1b1b1d', '#f0f0ee', '#2a4f9c', '#2f7a3d', '#e0661b', '#c8102e'];
    this.riders = Array.from({ length: cyclists }, (_, i) => ({
      i, active: false, seg: null, dir: 1, L: 1, u: 0, next: null, x: 0, z: 0, y: 0, yaw: 0, pitch: 0, lean: 0, v: 0, base: 4.2 + rnd() * 1.8,
      jx: 0, jz: 0, jl: 0, crank: rnd() * 6, wheel: 0, follow: 0, lastBell: -Infinity, grade: 0,
      frame: rnd() < 0.3 ? '#c8102e' : FRAMES[Math.floor(rnd() * FRAMES.length)], // VélôToulouse 風の赤い貸し自転車を 3 割
      shirt: PALETTE.tops[Math.floor(rnd() * PALETTE.tops.length)], trousers: PALETTE.bottoms[Math.floor(rnd() * PALETTE.bottoms.length)],
    }));
    const n = cyclists;
    const bikeMat = trafficMaterial(this.uNight, 'traffic-bike', { roughness: 0.45, metalness: 0.3 });
    const bodyMat = trafficMaterial(this.uNight, 'traffic-body', { roughness: 0.8, metalness: 0 });
    const mk = (geo, mat, count, name, shadow) => {
      const m = new THREE.InstancedMesh(geo, mat, count);
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.frustumCulled = false;
      m.castShadow = shadow;
      m.receiveShadow = true;
      m.count = 0;
      m.visible = false;
      m.name = name;
      this.group.add(m);
      return m;
    };
    this.frameMesh = mk(bikeGeometry(), bikeMat, n, 'traffic-bike', true);
    this.wheelMesh = mk(wheelGeometry(), bikeMat, n * 2, 'traffic-wheel', false);
    this.upperMesh = mk(upperGeometry(), bodyMat, n, 'traffic-rider', true);
    this.thighMesh = mk(thighGeometry(), bodyMat, n * 2, 'traffic-thigh', false);
    this.shinMesh = mk(shinGeometry(), bodyMat, n * 2, 'traffic-shin', false);
    const c = new THREE.Color();
    this.riders.forEach((r, i) => {
      this.frameMesh.setColorAt(i, c.set(r.frame));
      this.upperMesh.setColorAt(i, c.set(r.shirt));
      for (let k = 0; k < 2; k++) {
        this.thighMesh.setColorAt(i * 2 + k, c.set(r.trousers));
        this.shinMesh.setColorAt(i * 2 + k, c.set(r.trousers));
      }
    });

    // ② トラム: 線路をつないだ長い線（400 m 以上）。線ごとに 1 編成（長い線から 4 編成まで）
    const rails = (world.parsed?.rails || []).filter((r) => r.type === 'tram');
    this.paths = chainRails(rails)
      .map((ch) => Object.assign(makePath(ch.pts), { segBridge: ch.segBridge }))
      .filter((p) => p.length >= 400);
    const trnd = mulberry32(seed + 7);
    this.trams = this.paths.slice(0, MAX_TRAMS).map((path, i) => {
      const dir = trnd() < 0.5 ? 1 : -1, s0 = TRAM_LEN + trnd() * (path.length - 2 * TRAM_LEN);
      return {
        i, path, dir, s: dir > 0 ? s0 : s0 - TRAM_LEN, v: 0, wait: 0, flip: false, served: -1, stops: stopsAlong(path.length),
        lastBell: -Infinity, passed: false, blocked: false, visible: false, cx: 0, cz: 0,
        jx: new Float64Array(CARS + 1), jz: new Float64Array(CARS + 1), jy: new Float64Array(CARS + 1),
      };
    });
    const tramMat = trafficMaterial(this.uNight, 'traffic-tram', { roughness: 0.35, metalness: 0.35 });
    const T = this.trams.length || 1;
    this.midMesh = mk(tramCarGeometry(false), tramMat, T * (CARS - 2), 'traffic-tram', true);
    this.endMesh = mk(tramCarGeometry(true), tramMat, T * 2, 'traffic-tram-cab', true);
    this.pantoMesh = mk(pantographGeometry(), tramMat, T, 'traffic-tram-pantograph', true);
    this.lampMesh = mk(new THREE.SphereGeometry(0.1, 8, 6), new THREE.MeshBasicMaterial({ color: '#ffffff' }), T * 4, 'traffic-tram-lamps', false);
    this.lampMesh.receiveShadow = false;
    for (let k = 0; k < T * 4; k++) this.lampMesh.setColorAt(k, c.set(k % 4 < 2 ? '#fff6e0' : '#e0181e')); // 前照灯（進む向きの先頭）は白、後ろは赤
  }

  // ---------------------------------------------------------------- ① 自転車乗り
  // 区間 seg を dir の向きに u m 進んだ所の、右側の走る位置
  lanePoint(seg, dir, u, out) {
    const ax = dir > 0 ? seg.ax : seg.bx, az = dir > 0 ? seg.az : seg.bz, bx = dir > 0 ? seg.bx : seg.ax, bz = dir > 0 ? seg.bz : seg.az;
    const L = Math.hypot(bx - ax, bz - az) || 1, fx = (bx - ax) / L, fz = (bz - az) / L, off = laneOffset(seg.road);
    out.x = ax + fx * u - fz * off;
    out.z = az + fz * u + fx * off;
    out.fx = fx;
    out.fz = fz;
    return out;
  }

  groundY(x, z, y) {
    const w = this.world;
    if (y != null && Number.isFinite(y) && w.groundAt) {
      const g = w.groundAt(x, z, y + 0.6);
      if (Number.isFinite(g)) return g;
    }
    const g = w.spawnY ? w.spawnY(x, z) : w.heightAt ? w.heightAt(x, z) : 0;
    return Number.isFinite(g) ? g : 0;
  }

  // 自転車乗りを置く: 自転車から inner〜outer m の輪（7 割は前側）に近い、自転車が走れる道の上。
  // 歩行者専用の道・階段・橋でない水の上・読み込み前のタイル・カメラから clear m 以内には置かない
  place(r, bike, inner, outer, cam, clear) {
    const w = this.world, rnd = this.rnd;
    const q = respawnPoint(rnd, bike, outer, inner);
    const near = w.roadnet.nearestSegment(q.x, q.z, 40, isCyclable);
    if (!near) return false;
    const seg = near.seg, dir = rnd() < 0.5 ? 1 : -1, L = Math.hypot(seg.bx - seg.ax, seg.bz - seg.az);
    if (L < 0.5) return false;
    const u = (dir > 0 ? near.t : 1 - near.t) * L;
    const p = this.lanePoint(seg, dir, u, _P);
    if (Math.hypot(p.x - bike.x, p.z - bike.z) < inner * 0.8) return false;
    if (cam && Math.hypot(p.x - cam.x, p.z - cam.z) < clear) return false;
    if (this.riders.some((o) => o !== r && o.active && Math.hypot(o.x - p.x, o.z - p.z) < 8)) return false; // 2 人を同じ所に重ねない
    if (w.collision.outOfBounds(p.x, p.z) || w.collision.blockedByWater(p.x, p.z)) return false;
    if (w.stream && !w.stream.readyAt(p.x, p.z)) return false;
    if (w.collision.resolve(p.x, p.z, 0.4).hit) return false;
    const y0 = w.spawnY ? w.spawnY(p.x, p.z, !!seg.road.bridge) : this.groundY(p.x, p.z);
    Object.assign(r, {
      active: true, seg, dir, L, u, x: p.x, z: p.z, y: Number.isFinite(y0) ? y0 : 0, yaw: Math.atan2(-p.fx, -p.fz), pitch: 0, lean: 0, v: r.base,
      jx: 0, jz: 0, jl: 0, follow: 0, grade: 0,
    });
    r.next = nextSegment(w.roadnet, seg, dir, rnd, isCyclable);
    return true;
  }

  // 遠くなった人・読み込み前のタイルにいる人を、自転車から 120〜220 m の道へ置き直す（1 フレームの試行は 6 回まで）
  recycle(bike, cam) {
    const st = this.world.stream;
    for (const r of this.riders) {
      if (r.active && (Math.hypot(r.x - bike.x, r.z - bike.z) > FAR || (st && !st.readyAt(r.x, r.z)))) r.active = false;
    }
    let budget = 6;
    for (const r of this.riders) {
      while (!r.active && budget > 0) {
        budget--;
        this.place(r, bike, PLACE_IN, PLACE_OUT, cam, CAM_CLEAR);
      }
    }
  }

  // 始め（とワープのあと）は、自転車から 30〜220 m に散らす（画面が一度に出るので、近くにいてよい）
  populate(bike) {
    for (const r of this.riders) {
      for (let k = 0; k < 30 && !r.active; k++) this.place(r, bike, 30, PLACE_OUT, null, 0);
    }
  }

  ride(r, dt, bike) {
    const w = this.world;
    // 速さ: 人ごとの速さ × 坂 × 曲がり角の手前 6 m は 0.6 倍
    let target = r.base * slopeFactor(r.grade);
    if (r.next && r.next.turn > 0.5 && r.L - r.u < 6) target *= 0.6;
    // プレーヤーとの関係（高さが 2 m 以上違えば別の面: 橋の上と下）
    const p = this.lanePoint(r.seg, r.dir, r.u, _P);
    const fx = p.fx, fz = p.fz;
    const rx = bike.x - r.x, rz = bike.z - r.z;
    const along = rx * fx + rz * fz, lat = -rx * fz + rz * fx; // lat: 右が正
    const same = Math.abs((bike.y ?? r.y) - r.y) < 2;
    if (same && along > 0 && along < 8 && Math.abs(lat) < 1.2) {
      // 前にプレーヤー: その速さ + 0.5 m/s まで落として後ろに付く（2.2 m より近づかない）
      const pv = (bike.speed || 0) * (Math.sin(bike.heading) * fx - Math.cos(bike.heading) * fz);
      // （3 m/s² で 2.2 m 手前に止まれる速さも超えない）
      target = Math.min(target, Math.max(0, pv + 0.5), Math.sqrt(6 * Math.max(0, along - 2.2)));
      r.follow += dt;
      if (r.follow >= 3 && this.clock - r.lastBell >= 20) {
        r.lastBell = this.clock;
        this.events.push({ type: 'bike-bell', x: r.x, z: r.z });
      }
    } else r.follow = 0;
    // 真横に重なった: プレーヤーを横へ 0.3 m 押して遅くする（押した先が壁なら押さない）
    if (same && Math.abs(along) < 0.9 && Math.abs(lat) < 0.8) {
      const side = lat >= 0 ? 1 : -1, nx = bike.x - fz * side * 0.3, nz = bike.z + fx * side * 0.3;
      if (!w.collision.resolve(nx, nz, 0.42).hit) {
        bike.x = nx;
        bike.z = nz;
      }
      bike.speed *= 0.9;
    }
    r.v += Math.max(-3 * dt, Math.min(1.2 * dt, target - r.v));
    const step = r.v * dt;
    r.u += step;
    // 区間の端（交差点）: 次の区間へ。位置の折れは BLEND m かけて戻す
    for (let k = 0; k < 8 && r.u >= r.L; k++) {
      const a = this.lanePoint(r.seg, r.dir, r.L, _P2), ox = a.x, oz = a.z;
      const f = r.jl / BLEND;
      r.u -= r.L;
      const nx = r.next || { seg: r.seg, dir: -r.dir };
      r.seg = nx.seg;
      r.dir = nx.dir;
      r.L = Math.max(0.01, Math.hypot(r.seg.bx - r.seg.ax, r.seg.bz - r.seg.az));
      const b = this.lanePoint(r.seg, r.dir, 0, _P2);
      r.jx = r.jx * f + ox - b.x;
      r.jz = r.jz * f + oz - b.z;
      r.jl = BLEND;
      r.next = nextSegment(w.roadnet, r.seg, r.dir, this.rnd, isCyclable);
    }
    const q = this.lanePoint(r.seg, r.dir, r.u, _P);
    r.jl = Math.max(0, r.jl - step);
    const f = r.jl / BLEND;
    const x = q.x + r.jx * f, z = q.z + r.jz * f;
    // 向き: 動いた向きへなめらかに（傾きは曲がる速さから）
    const dx = x - r.x, dz = z - r.z, moved = Math.hypot(dx, dz);
    if (moved > 1e-4) {
      let da = Math.atan2(-dx, -dz) - r.yaw;
      da = Math.atan2(Math.sin(da), Math.cos(da));
      const turn = da * Math.min(1, dt * 10);
      r.yaw += turn;
      // 傾きは bike.js と同じ向き（heading の回る速さから。yaw = -heading）
      const lean = Math.max(-0.4, Math.min(0.4, Math.atan((r.v * -turn) / Math.max(dt, 1e-4) / 9.81)));
      r.lean += (lean - r.lean) * Math.min(1, dt * 5);
    }
    r.x = x;
    r.z = z;
    // 高さ（前の高さから追う: 橋の上と下を取り違えない）と坂（前後 2 m の差）
    r.y = this.groundY(x, z, r.y);
    const hx = -Math.sin(r.yaw), hz = -Math.cos(r.yaw); // 前の向き（yaw から）
    const ya = this.groundY(x + hx * 2, z + hz * 2, r.y), yb = this.groundY(x - hx * 2, z - hz * 2, r.y);
    const grade = Math.max(-0.2, Math.min(0.2, (ya - yb) / 4));
    r.grade += (grade - r.grade) * Math.min(1, dt * 3);
    r.pitch = Math.atan(r.grade);
    r.crank += (Math.max(r.v, 0.6) / WHEEL_R / 2.6) * dt * (r.v > 0.2 ? 1 : 0);
    r.wheel += (r.v / WHEEL_R) * dt;
  }

  // 行列: 体（位置・向き・坂・傾き）、車輪 2、上半身、腿 2・すね 2（クランクの角度から逆運動学）
  drawRiders() {
    let n = 0;
    for (const r of this.riders) {
      if (!r.active) continue;
      _Q.setFromEuler(_E.set(r.pitch, r.yaw, -r.lean, 'YXZ'));
      _M.compose(_V.set(r.x, r.y, r.z), _Q, _ONE);
      this.frameMesh.setMatrixAt(n, _M);
      this.upperMesh.setMatrixAt(n, _M);
      // 色は描く順（n）に入れ直す（置き直しで描く順が変わる）
      this.frameMesh.setColorAt(n, _C.set(r.frame));
      this.upperMesh.setColorAt(n, _C.set(r.shirt));
      for (let k = 0; k < 2; k++) {
        _L.makeTranslation(0, WHEEL_R, k === 0 ? -0.53 : 0.52).multiply(_R.makeRotationX(-r.wheel));
        this.wheelMesh.setMatrixAt(n * 2 + k, _L.premultiply(_M));
        const side = k === 0 ? 1 : -1;
        const leg = legIK(r.crank, side, _LEG);
        // 腿: 股関節から膝へ（-y を膝の向きへ回す）
        const [hx, hy, hz] = leg.hip, [kx, ky, kz] = leg.knee, [fx, fy, fz] = leg.foot;
        _L.makeTranslation(hx, hy, hz).multiply(_R.makeRotationX(Math.atan2(-(kz - hz), -(ky - hy)))).multiply(_S.makeScale(1, LEG.thigh / 0.45, 1));
        this.thighMesh.setMatrixAt(n * 2 + k, _L.premultiply(_M));
        const sl = Math.hypot(fy - ky, fz - kz);
        _L.makeTranslation(kx, ky, kz).multiply(_R.makeRotationX(Math.atan2(-(fz - kz), -(fy - ky)))).multiply(_S.makeScale(1, sl / 0.4, 1));
        this.shinMesh.setMatrixAt(n * 2 + k, _L.premultiply(_M));
        this.thighMesh.setColorAt(n * 2 + k, _C.set(r.trousers));
        this.shinMesh.setColorAt(n * 2 + k, _C.set(r.trousers));
      }
      n++;
    }
    for (const [m, per] of [[this.frameMesh, 1], [this.upperMesh, 1], [this.wheelMesh, 2], [this.thighMesh, 2], [this.shinMesh, 2]]) {
      m.count = n * per;
      m.visible = n > 0;
      m.instanceMatrix.needsUpdate = true;
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
    }
  }

  // ---------------------------------------------------------------- ② トラム
  stepTram(t, dt, bike) {
    const P = t.path, L = P.length;
    // 止まっている（停留所・終点）
    if (t.wait > 0) {
      t.wait -= dt;
      if (t.wait <= 0 && t.flip) {
        // 終点で折り返す（両運転台）: 反対の端が先頭になる
        t.s -= t.dir * TRAM_LEN;
        t.dir = -t.dir;
        t.flip = false;
        t.served = -1;
      }
    }
    const c = t.s - t.dir * (TRAM_LEN / 2); // 編成の真ん中
    const head = pointAlong(P, t.s, _P);
    const hx = head.x, hz = head.z;
    // 前 18 m・線路から 1.8 m 以内にプレーヤーがいれば止まる（ベルは 3 秒に 1 回まで）
    t.blocked = false;
    let distBlock = Infinity;
    if (Math.hypot(bike.x - hx, bike.z - hz) < 25 && Math.abs((bike.y ?? t.jy[0]) - t.jy[0]) < 3) {
      const ahead = nearOnPath(P, t.s, t.s + t.dir * 18, bike.x, bike.z);
      if (ahead.d <= 1.8) {
        t.blocked = true;
        distBlock = Math.max(0, Math.abs(ahead.s - t.s) - 4);
        if (this.clock - t.lastBell >= 3) {
          t.lastBell = this.clock;
          this.events.push({ type: 'tram-bell', x: hx, z: hz });
        }
      }
    }
    if (t.wait > 0) {
      t.v = 0;
      return;
    }
    // 次に止まる所: 終点か、まだ止まっていない停留所（停留所は編成の真ん中を合わせる）
    const distEnd = t.dir > 0 ? L - t.s : t.s;
    let distStop = Infinity, stopIdx = -1;
    t.stops.forEach((st, k) => {
      const d = (st - c) * t.dir;
      if (k !== t.served && d > -0.2 && d < distStop) {
        distStop = Math.max(0, d);
        stopIdx = k;
      }
    });
    const dist = Math.min(distEnd, distStop);
    const vmax = this.inOld(head.x, head.z) ? 7 : 11; // 旧市街の中は 7 m/s、ほかは 40 km/h
    t.v = tramSpeed(t.v, Math.min(dist, distBlock), vmax, dt);
    const move = Math.min(t.v * dt, Math.max(0, dist));
    t.s += t.dir * move;
    if (dist - move < 0.1 && t.v < 0.6) {
      t.v = 0;
      if (distEnd <= distStop) {
        t.wait = 20;
        t.flip = true;
      } else {
        t.wait = 14;
        t.served = stopIdx;
      }
    }
  }

  // 車体のつなぎ目 6 点（先頭から 6.4 m ごと）の位置と高さ。橋の way の上は橋面、ほかは地面
  tramJoints(t) {
    const w = this.world, P = t.path;
    for (let k = 0; k <= CARS; k++) {
      const p = pointAlong(P, t.s - t.dir * k * CAR_GAP, _P);
      t.jx[k] = p.x;
      t.jz[k] = p.z;
      const onBridge = !!P.segBridge?.[p.i];
      const y = w.spawnY ? w.spawnY(p.x, p.z, onBridge) : w.groundAt ? w.groundAt(p.x, p.z) : 0;
      t.jy[k] = Number.isFinite(y) ? y : 0;
    }
  }

  // プレーヤーがトラムの車体（各車両の長方形）に重なったら、車体の横へ押し出して速さを 0.3 倍に
  pushOut(t, bike) {
    for (let k = 0; k < CARS; k++) {
      const ax = t.jx[k], az = t.jz[k], bx = t.jx[k + 1], bz = t.jz[k + 1];
      const L = Math.hypot(ax - bx, az - bz) || 1, ux = (ax - bx) / L, uz = (az - bz) / L;
      const mx = (ax + bx) / 2, mz = (az + bz) / 2, ry = (t.jy[k] + t.jy[k + 1]) / 2;
      if (Math.abs((bike.y ?? ry) - ry) > 3) continue;
      const rx = bike.x - mx, rz = bike.z - mz, a = rx * ux + rz * uz, l = -rx * uz + rz * ux;
      if (Math.abs(a) > CAR_GAP / 2 || Math.abs(l) > TRAM_HALF) continue;
      const side = l >= 0 ? 1 : -1, d = side * (TRAM_HALF + 0.05) - l;
      bike.x += -uz * d;
      bike.z += ux * d;
      bike.speed *= 0.3;
      return;
    }
  }

  drawTrams(bike) {
    const st = this.world.stream;
    let nm = 0, ne = 0, np = 0, nl = 0;
    for (const t of this.trams) {
      const mid = pointAlong(t.path, t.s - t.dir * (TRAM_LEN / 2), _P);
      t.cx = mid.x;
      t.cz = mid.z;
      const d = Math.hypot(mid.x - bike.x, mid.z - bike.z);
      // 近づいてきたトラム（あとで音を付ける）: 30 m に入ったとき 1 回。60 m 離れたらまた
      if (d < 30 && t.v > 3 && !t.passed) {
        t.passed = true;
        this.events.push({ type: 'tram-pass', x: mid.x, z: mid.z });
      } else if (d > 60) t.passed = false;
      t.visible = d < TRAM_DRAW && (!st || st.readyAt(mid.x, mid.z));
      if (!t.visible) continue;
      this.tramJoints(t);
      if (d < 60) this.pushOut(t, bike);
      for (let k = 0; k < CARS; k++) {
        // 車体の向き: 先頭側の点 a から後ろ側の点 b へ。最後の車体は運転台を後ろへ向ける
        const back = k === CARS - 1;
        const a = back ? k + 1 : k, b = back ? k : k + 1;
        const dx = t.jx[a] - t.jx[b], dz = t.jz[a] - t.jz[b], h = Math.hypot(dx, dz) || 1;
        _Q.setFromEuler(_E.set(Math.atan2(t.jy[a] - t.jy[b], h), Math.atan2(-dx, -dz), 0, 'YXZ'));
        _M.compose(_V.set((t.jx[a] + t.jx[b]) / 2, (t.jy[a] + t.jy[b]) / 2, (t.jz[a] + t.jz[b]) / 2), _Q, _ONE);
        if (k === 0 || back) {
          this.endMesh.setMatrixAt(ne++, _M);
          // 灯火: 先頭は白、後ろは赤（色は 4 つずつ 白 2・赤 2 の順に入れてある）
          for (const sx of [-0.62, 0.62]) {
            _W.set(sx, 0.85, -3.14).applyMatrix4(_M);
            _L.makeTranslation(_W.x, _W.y, _W.z);
            this.lampMesh.setMatrixAt(nl + (back ? 2 : 0) + (sx < 0 ? 0 : 1), _L);
          }
          if (back) nl += 4;
        } else {
          this.midMesh.setMatrixAt(nm++, _M);
          if (k === 2) this.pantoMesh.setMatrixAt(np++, _L.makeTranslation(0, 3.3, 0).premultiply(_M)); // 真ん中の車体の屋根
        }
      }
    }
    for (const [m, n] of [[this.midMesh, nm], [this.endMesh, ne], [this.pantoMesh, np], [this.lampMesh, nl]]) {
      m.count = n;
      m.visible = n > 0;
      m.instanceMatrix.needsUpdate = true;
    }
  }

  // ---------------------------------------------------------------- 毎フレーム
  // camera: 置き直すときに、カメラから 100 m 以内を避ける（無くても動く。描画なしの __tavSimulate でも呼ばれる）
  update(dt, bike, camera) {
    const st = this.world.stream;
    if (st && !st.readyAt(bike.x, bike.z)) return; // いるタイルを読み込むまで待つ
    this.clock += dt;
    this.uNight.value = this.night ? 1 : 0;
    // ワープ・リスポーン（1 フレームで 30 m 以上動いた）は、始めと同じに自転車のまわりへ散らし直す
    if (this.started && Math.hypot(bike.x - this.lastX, bike.z - this.lastZ) > 30) {
      for (const r of this.riders) r.active = false;
      this.started = false;
    }
    this.lastX = bike.x;
    this.lastZ = bike.z;
    if (!this.started) {
      this.started = true;
      this.populate(bike);
    } else this.recycle(bike, camera?.position);
    for (const r of this.riders) if (r.active) this.ride(r, dt, bike);
    this.drawRiders();
    for (const t of this.trams) this.stepTram(t, dt, bike);
    this.drawTrams(bike);
  }

  stats() {
    return { cyclists: this.riders.filter((r) => r.active).length, trams: this.trams.length, tramPaths: this.paths.length };
  }
}

const _C = new THREE.Color();

// ---------------------------------------------------------------- 材料
// 頂点色 × インスタンスの色（tint = 1 の所だけ。furniture.js の furnitureMaterial と同じ）。
// glow: 夜に光る色（uNight = 1 のとき emissive に足す。自転車の灯火・トラムの窓）
function trafficMaterial(uNight, key, { roughness = 0.6, metalness = 0.1 } = {}) {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness, metalness });
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uNight = uNight;
    sh.vertexShader = 'attribute float tint;\nattribute vec3 glow;\nvarying vec3 vGlow;\n' + sh.vertexShader.replace('#include <color_vertex>', `
#if defined( USE_COLOR ) || defined( USE_INSTANCING_COLOR )
	vColor = vec4( 1.0 );
#endif
#ifdef USE_COLOR
	vColor.rgb *= color;
#endif
#ifdef USE_INSTANCING_COLOR
	vColor.rgb *= mix( vec3( 1.0 ), instanceColor.rgb, tint );
#endif
	vGlow = glow;`);
    sh.fragmentShader = 'uniform float uNight;\nvarying vec3 vGlow;\n' + sh.fragmentShader.replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n\ttotalEmissiveRadiance += vGlow * uNight;');
  };
  m.customProgramCacheKey = () => key;
  return m;
}

// ---------------------------------------------------------------- 形
// 部品: 頂点色（元の頂点色があれば掛ける）・tint・glow をそろえ、position・normal・color・tint・glow だけにする
function part(g, color, { tint = 0, glow = null } = {}) {
  g = g.index ? g.toNonIndexed() : g.clone();
  const n = g.attributes.position.count, c = new THREE.Color(color), col = new Float32Array(n * 3), old = g.attributes.color?.array;
  for (let i = 0; i < n; i++) {
    col[i * 3] = c.r * (old ? old[i * 3] : 1);
    col[i * 3 + 1] = c.g * (old ? old[i * 3 + 1] : 1);
    col[i * 3 + 2] = c.b * (old ? old[i * 3 + 2] : 1);
  }
  const gl = new Float32Array(n * 3);
  if (glow) for (let i = 0; i < n; i++) gl.set(glow, i * 3);
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', g.attributes.position);
  if (!g.attributes.normal) g.computeVertexNormals();
  out.setAttribute('normal', g.attributes.normal);
  out.setAttribute('color', new THREE.BufferAttribute(col, 3));
  out.setAttribute('tint', new THREE.BufferAttribute(new Float32Array(n).fill(tint), 1));
  out.setAttribute('glow', new THREE.BufferAttribute(gl, 3));
  return out;
}

const V3 = (x, y, z) => new THREE.Vector3(x, y, z);
const _UPV = new THREE.Vector3(0, 1, 0);
// a から b への円柱
function tubeGeo(a, b, r, seg = 6) {
  const d = b.clone().sub(a), len = d.length();
  const g = new THREE.CylinderGeometry(r, r, Math.max(len, 1e-4), seg, 1);
  g.applyMatrix4(new THREE.Matrix4().compose(a.clone().addScaledVector(d, 0.5), new THREE.Quaternion().setFromUnitVectors(_UPV, d.normalize()), _ONE));
  return g;
}
function boxGeo(w, h, d, x, y, z, segZ = 1) {
  const g = new THREE.BoxGeometry(w, h, d, 1, 1, segZ);
  g.translate(x, y, z);
  return g;
}

// 自転車の車体（bike.js の寸法 P を手本に。局所: 足もと、前は -z）。フレームは tint（人ごとの色）、ほかは頂点色。
// 前に白・後ろに赤の小さな灯火（夜に光る）
function bikeGeometry() {
  const P = { rear: V3(0, WHEEL_R, 0.52), front: V3(0, WHEEL_R, -0.53), bb: V3(0, 0.3, 0.04), seat: V3(0, 0.86, 0.2), htTop: V3(0, 0.88, -0.38), htBot: V3(0, 0.68, -0.43) };
  const frame = (a, b, r) => part(tubeGeo(a, b, r), '#ffffff', { tint: 1 });
  const parts = [
    frame(P.bb, P.htBot, 0.022), frame(P.seat, P.htTop, 0.019), frame(P.bb, P.seat, 0.02), frame(P.htBot, P.htTop, 0.025),
  ];
  for (const sx of [-0.06, 0.06]) {
    parts.push(frame(V3(sx * 0.4, P.bb.y, P.bb.z), V3(sx, P.rear.y, P.rear.z), 0.012));
    parts.push(frame(V3(sx * 0.4, P.seat.y - 0.04, P.seat.z + 0.02), V3(sx, P.rear.y, P.rear.z), 0.011));
    parts.push(frame(V3(sx * 0.5, P.htBot.y, P.htBot.z), V3(sx, P.front.y, P.front.z), 0.013)); // 前フォーク
  }
  const metal = '#b9bdc2', dark = '#2a2a2c';
  parts.push(part(tubeGeo(P.htTop, V3(0, 1.02, -0.36), 0.016), metal)); // ステム
  parts.push(part(tubeGeo(V3(-0.28, 1.04, -0.3), V3(0.28, 1.04, -0.3), 0.013), metal)); // ハンドル
  for (const sx of [-1, 1]) parts.push(part(tubeGeo(V3(sx * 0.22, 1.04, -0.3), V3(sx * 0.31, 1.04, -0.3), 0.018), dark)); // グリップ
  parts.push(part(tubeGeo(P.seat, V3(0, 0.96, 0.23), 0.014), metal)); // シートポスト
  parts.push(part(boxGeo(0.15, 0.05, 0.27, 0, 0.98, 0.22), '#3a2a1e')); // サドル
  parts.push(part(tubeGeo(V3(0, 0.73, 0.28), V3(0, 0.73, 0.78), 0.012), dark)); // 荷台
  for (const sx of [-0.08, 0.08]) parts.push(part(tubeGeo(V3(sx, 0.73, 0.7), V3(sx, P.rear.y, P.rear.z), 0.008), dark));
  const ring = new THREE.TorusGeometry(0.1, 0.012, 4, 14);
  ring.rotateY(Math.PI / 2);
  ring.translate(0.06, P.bb.y, P.bb.z);
  parts.push(part(ring, metal)); // チェーンリング
  const lamp = (y, z, color, glow) => {
    const g = new THREE.SphereGeometry(0.035, 6, 4);
    g.translate(0, y, z);
    return part(g, color, { glow });
  };
  parts.push(lamp(0.8, -0.55, '#fff6d8', [1.6, 1.5, 1.2]), lamp(0.75, 0.8, '#c0161b', [1.6, 0.12, 0.08]));
  return mergeGeometries(parts);
}

// 車輪 1 つ（ハブが原点、軸は x）。タイヤ・リム・スポーク 3 本（回っているのが見える）
function wheelGeometry() {
  const tire = new THREE.TorusGeometry(WHEEL_R - 0.02, 0.024, 6, 20);
  tire.rotateY(Math.PI / 2);
  const rim = new THREE.TorusGeometry(WHEEL_R - 0.05, 0.012, 4, 20);
  rim.rotateY(Math.PI / 2);
  const parts = [part(tire, '#1d1d1f'), part(rim, '#c9cdd2')];
  for (let k = 0; k < 3; k++) {
    const s = boxGeo(0.008, (WHEEL_R - 0.05) * 2, 0.008, 0, 0, 0);
    s.rotateX((k * Math.PI) / 3);
    parts.push(part(s, '#b8bcc0'));
  }
  const hub = new THREE.CylinderGeometry(0.03, 0.03, 0.1, 6);
  hub.rotateZ(Math.PI / 2);
  parts.push(part(hub, '#9a9ea3'));
  return mergeGeometries(parts);
}

// 上半身・頭・ヘルメット・腕（自転車の局所で。前かがみでハンドルを握る）。服は tint、肌・ヘルメットは頂点色。
// 胴・頭・腕は metro/people.js の形（身長 1.75 m の比率）
const HIP = V3(0, LEG.hipY, LEG.hipZ), SHOULDER = V3(0, 1.5, -0.08);
function upperGeometry() {
  const skin = '#d9a882';
  const lean = Math.atan2(SHOULDER.z - HIP.z, SHOULDER.y - HIP.y); // 胴の前への傾き（-x まわり）
  // 胴の局所（股関節が原点、上が y）→ 自転車の局所
  const torsoM = new THREE.Matrix4().makeTranslation(HIP.x, HIP.y, HIP.z).multiply(new THREE.Matrix4().makeRotationX(lean)).multiply(new THREE.Matrix4().makeTranslation(0, -HIP_Y, 0));
  // 頭は胴ほどは傾けず、前を見る（首の付け根で起こす）
  const headM = torsoM.clone().multiply(new THREE.Matrix4().makeTranslation(0, 1.5, 0)).multiply(new THREE.Matrix4().makeRotationX(-lean * 0.7)).multiply(new THREE.Matrix4().makeTranslation(0, -1.5, 0));
  const parts = [];
  const torso = torsoGeometry({ kind: 'm' });
  torso.applyMatrix4(torsoM);
  parts.push(part(torso, '#ffffff', { tint: 1 }));
  const head = headGeometry();
  head.applyMatrix4(headM);
  parts.push(part(head, skin));
  const helmet = new THREE.SphereGeometry(0.118, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2);
  helmet.scale(0.95, 1, 1.12);
  helmet.translate(0, 1.685, -0.01);
  helmet.applyMatrix4(headM);
  parts.push(part(helmet, '#3a3f45'));
  // 腕: 肩からハンドルのグリップへ（腕の形を伸ばして合わせる）
  for (const sx of [-1, 1]) {
    const sh = V3(sx * 0.19, 1.43, 0).applyMatrix4(torsoM);
    const grip = V3(sx * 0.27, 1.05, -0.3);
    const d = grip.clone().sub(sh), len = d.length();
    const m = new THREE.Matrix4().compose(sh, new THREE.Quaternion().setFromUnitVectors(V3(0, -1, 0), d.normalize()), V3(1, len / 0.6, 1));
    const arm = armGeometry({ elbow: 0.15 });
    arm.applyMatrix4(m);
    parts.push(part(arm, '#ffffff', { tint: 1 }));
    const hand = handGeometry({ elbow: 0.15 });
    hand.applyMatrix4(m);
    parts.push(part(hand, skin));
  }
  return mergeGeometries(parts);
}

// 腿（股関節が原点、-y へ 0.45 m。服の色は tint）
function thighGeometry() {
  const V = (r, y) => new THREE.Vector2(r, y);
  return part(new THREE.LatheGeometry([V(0.001, 0.03), V(0.08, 0.0), V(0.075, -0.12), V(0.064, -0.3), V(0.054, -0.43), V(0.001, -0.45)], 10), '#ffffff', { tint: 1 });
}

// すねと靴（膝が原点、-y へ 0.4 m）
function shinGeometry() {
  const V = (r, y) => new THREE.Vector2(r, y);
  const shin = new THREE.LatheGeometry([V(0.001, 0.02), V(0.055, -0.01), V(0.056, -0.1), V(0.045, -0.24), V(0.034, -0.36), V(0.001, -0.4)], 10);
  const shoe = new THREE.SphereGeometry(0.06, 8, 5);
  shoe.scale(0.85, 0.62, 1.9);
  shoe.translate(0, -0.41, -0.04);
  return mergeGeometries([part(shin, '#ffffff', { tint: 1 }), part(shoe, '#222224')]);
}

// トラムの車体 1 つ（Citadis 302 風。局所: レールの面が y = 0、前は -z、長さ 6.1 m・幅 2.4 m・高さ 3.3 m）。
// cab: 運転台（前の端が丸く絞られ、黒い大きな曲面ガラスと銀の鼻）。後ろの端（+z）には幌（つなぎ目 0.3 m の半分）。
// 中間の車体は両端に幌、真ん中に扉（少し明るい縦の線）
const SILVER = '#c8ccd0', GLASS = '#1c2228', UNDER = '#3b3e42', BELLOWS = '#2b2d30', DOORLINE = '#e8eaec';
const WINDOW_GLOW = [0.95, 0.85, 0.62];
function tramCarGeometry(cab) {
  const H = 3.05; // 車体の長さの半分
  const z0 = cab ? -H - 0.1 : -H, segs = cab ? 10 : 1;
  const parts = [];
  const band = (w, y0, y1, za, zb, color, opts) => parts.push({ g: boxGeo(w, y1 - y0, zb - za, 0, (y0 + y1) / 2, (za + zb) / 2, segs), color, opts });
  band(2.3, 0.1, 0.45, cab ? -H + 0.1 : -H, H, UNDER); // 床下
  band(2.4, 0.45, 1.05, z0, H, SILVER); // 腰板（運転台では銀の鼻）
  if (cab) {
    band(2.38, 1.05, 2.45, -1.8, H, GLASS, { glow: WINDOW_GLOW }); // 窓の帯
    band(2.4, 0.95, 2.8, -H, -1.8, '#0d1114'); // 前の大きな曲面ガラス
    band(2.4, 2.8, 3.05, -H + 0.25, H, SILVER);
    band(2.4, 2.45, 2.8, -1.8, H, SILVER);
  } else {
    band(2.38, 1.05, 2.45, -H, H, GLASS, { glow: WINDOW_GLOW });
    band(2.4, 2.45, 3.05, -H, H, SILVER);
  }
  band(2.2, 3.05, 3.25, cab ? -H + 0.6 : -H, H, '#d9dcdf'); // 屋根
  // 窓の柱（銀）と扉の縦の線
  const posts = cab ? [-1.8, -0.2, 1.4, 2.95] : [-2.95, -1.7, 1.7, 2.95];
  for (const z of posts) band(2.42, 1.05, 2.45, z - 0.06, z + 0.06, SILVER);
  const doors = cab ? [0.55, 1.25] : [-0.7, 0, 0.7];
  for (const z of doors) band(2.43, 0.45, 2.45, z - 0.03, z + 0.03, DOORLINE);
  // 幌（つなぎ目）
  parts.push({ g: boxGeo(2.15, 2.6, 0.17, 0, 0.3 + 1.3, H + 0.085), color: BELLOWS });
  if (!cab) parts.push({ g: boxGeo(2.15, 2.6, 0.17, 0, 0.3 + 1.3, -H - 0.085), color: BELLOWS });
  const out = parts.map(({ g, color, opts }) => {
    g = g.toNonIndexed();
    if (cab) {
      // 運転台: 前の 1.6 m を丸く絞り（幅を 72 % まで）、窓のあたりは前ほど後ろへ寝かせる
      const p = g.attributes.position;
      for (let i = 0; i < p.count; i++) {
        let x = p.getX(i), y = p.getY(i), z = p.getZ(i);
        if (z < -1.45) {
          const t = Math.min(1, (-1.45 - z) / (H + 0.1 - 1.45));
          x *= 1 - 0.28 * t * t;
          if (y > 1.0) z += (y - 1.0) * 0.22 * t;
          if (y > 2.8) x *= 0.95;
        }
        p.setXYZ(i, x, y, z);
      }
      g.computeVertexNormals();
    }
    return part(g, color, opts);
  });
  return mergeGeometries(out);
}

// パンタグラフ（屋根の上が原点。架線 5.8 m に届く: 屋根 3.3 m + 2.5 m）
function pantographGeometry() {
  const dark = '#2f3236';
  return mergeGeometries([
    part(boxGeo(1.1, 0.14, 0.9, 0, 0.07, 0), '#55595e'),
    part(tubeGeo(V3(0, 0.14, 0.45), V3(0, 1.3, -0.35), 0.035), dark),
    part(tubeGeo(V3(0, 1.3, -0.35), V3(0, 2.45, 0.25), 0.03), dark),
    part(boxGeo(1.5, 0.05, 0.12, 0, 2.48, 0.25), dark),
  ]);
}
