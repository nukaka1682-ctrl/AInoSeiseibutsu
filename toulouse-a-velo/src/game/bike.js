// 自転車とライダーの 3D モデル、そして物理（ペダル・ブレーキ・ハンドル・空気抵抗・衝突）。
// 向き heading はコンパス方位（0 = 北 = -z、時計回りが正）。
import * as THREE from 'three';

const WHEEL_R = 0.34;
const WHEELBASE = 1.05;
const MASS = 85; // 人 + 自転車
const G = 9.81;
const RADIUS = 0.42; // 当たり判定の半径

function tube(a, b, r, mat, seg = 6) {
  const geo = new THREE.CylinderGeometry(r, r, 1, seg);
  const m = new THREE.Mesh(geo, mat);
  setTube(m, a, b);
  m.castShadow = true;
  return m;
}

const _up = new THREE.Vector3(0, 1, 0);
const _d = new THREE.Vector3();
function setTube(m, a, b) {
  _d.subVectors(b, a);
  const len = _d.length();
  m.position.copy(a).addScaledVector(_d, 0.5);
  m.scale.set(1, Math.max(len, 1e-4), 1);
  m.quaternion.setFromUnitVectors(_up, _d.normalize());
}

function makeWheel(mats) {
  const g = new THREE.Group();
  const tire = new THREE.Mesh(new THREE.TorusGeometry(WHEEL_R - 0.02, 0.024, 8, 32), mats.tire);
  tire.rotation.y = Math.PI / 2;
  tire.castShadow = true;
  const rim = new THREE.Mesh(new THREE.TorusGeometry(WHEEL_R - 0.05, 0.012, 6, 32), mats.metal);
  rim.rotation.y = Math.PI / 2;
  const pts = [];
  for (let i = 0; i < 18; i++) {
    const a = (i / 18) * Math.PI * 2;
    const side = i % 2 ? 0.03 : -0.03;
    pts.push(new THREE.Vector3(side, 0, 0), new THREE.Vector3(0, Math.sin(a) * (WHEEL_R - 0.05), Math.cos(a) * (WHEEL_R - 0.05)));
  }
  const spokes = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: '#b8bcc0' }));
  const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.1, 8), mats.metal);
  hub.rotation.z = Math.PI / 2;
  g.add(tire, rim, spokes, hub);
  return g;
}

export class Bike {
  constructor() {
    this.x = 0;
    this.z = 0;
    this.heading = 0;
    this.speed = 0;
    this.steer = 0;
    this.lean = 0;
    this.crank = 0;
    this.wheelAngle = 0;
    this.odometer = 0;
    this.topSpeed = 0;
    this.contact = false;
    this.events = [];
    this.surface = 'road';
    this.surfaceTimer = 0;
    this.acc = 0;
    this.pedaling = 0;
    this.buildModel();
  }

  buildModel() {
    const mats = {
      frame: new THREE.MeshStandardMaterial({ color: '#6b3fa0', roughness: 0.35, metalness: 0.4 }), // スミレ色（トゥールーズの花）
      tire: new THREE.MeshStandardMaterial({ color: '#1d1d1f', roughness: 0.9 }),
      metal: new THREE.MeshStandardMaterial({ color: '#c9cdd2', roughness: 0.3, metalness: 0.9 }),
      dark: new THREE.MeshStandardMaterial({ color: '#2a2a2c', roughness: 0.6 }),
      saddle: new THREE.MeshStandardMaterial({ color: '#4a3424', roughness: 0.7 }),
      jersey: new THREE.MeshStandardMaterial({ color: '#c8102e', roughness: 0.8 }),
      jersey2: new THREE.MeshStandardMaterial({ color: '#1b1b1b', roughness: 0.8 }),
      skin: new THREE.MeshStandardMaterial({ color: '#d9a882', roughness: 0.8 }),
      helmet: new THREE.MeshStandardMaterial({ color: '#f2f2f2', roughness: 0.4 }),
      shoe: new THREE.MeshStandardMaterial({ color: '#333338', roughness: 0.7 }),
    };
    this.mats = mats;
    const V = (x, y, z) => new THREE.Vector3(x, y, z);

    const root = new THREE.Group(); // 位置・向き
    const lean = new THREE.Group(); // 傾き（接地点まわり）
    root.add(lean);
    root.rotation.order = 'YXZ';
    this.root = root;
    this.leanGroup = lean;

    const P = {
      rear: V(0, WHEEL_R, 0.52),
      front: V(0, WHEEL_R, -0.53),
      bb: V(0, 0.3, 0.04),
      seat: V(0, 0.86, 0.2),
      htTop: V(0, 0.88, -0.38),
      htBot: V(0, 0.68, -0.43),
    };
    this.P = P;
    // フレーム
    const f = mats.frame;
    lean.add(tube(P.bb, P.htBot, 0.022, f));
    lean.add(tube(P.seat, P.htTop, 0.019, f));
    lean.add(tube(P.bb, P.seat, 0.02, f));
    lean.add(tube(P.htBot, P.htTop, 0.025, f));
    for (const sx of [-0.06, 0.06]) {
      lean.add(tube(V(sx * 0.4, P.bb.y, P.bb.z), V(sx, P.rear.y, P.rear.z), 0.012, f));
      lean.add(tube(V(sx * 0.4, P.seat.y - 0.04, P.seat.z + 0.02), V(sx, P.rear.y, P.rear.z), 0.011, f));
    }
    // 泥よけ・荷台
    const rack = mats.dark;
    lean.add(tube(V(0, 0.73, 0.28), V(0, 0.73, 0.78), 0.012, rack));
    for (const sx of [-0.08, 0.08]) lean.add(tube(V(sx, 0.73, 0.7), V(sx, P.rear.y, P.rear.z), 0.008, rack));
    // サドル
    const seatPost = tube(P.seat, V(0, 0.96, 0.23), 0.014, mats.metal);
    lean.add(seatPost);
    const saddle = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.05, 0.27), mats.saddle);
    saddle.position.set(0, 0.98, 0.22);
    saddle.castShadow = true;
    lean.add(saddle);
    // 後輪
    this.rearWheel = makeWheel(mats);
    this.rearWheel.position.copy(P.rear);
    lean.add(this.rearWheel);

    // ハンドル周り（ハンドルを切ると回る）
    const steer = new THREE.Group();
    steer.position.set(0, 0, -0.45);
    lean.add(steer);
    this.steerGroup = steer;
    const local = (v) => v.clone().sub(steer.position);
    for (const sx of [-0.05, 0.05]) steer.add(tube(local(V(sx * 0.5, P.htBot.y, P.htBot.z)), local(V(sx, P.front.y, P.front.z)), 0.013, f));
    steer.add(tube(local(P.htTop), local(V(0, 1.02, -0.36)), 0.016, mats.metal));
    this.gripL = local(V(-0.28, 1.04, -0.30));
    this.gripR = local(V(0.28, 1.04, -0.30));
    steer.add(tube(this.gripL, this.gripR, 0.013, mats.metal));
    steer.add(tube(this.gripL.clone().add(V(-0.06, 0, 0)), this.gripL, 0.018, mats.dark));
    steer.add(tube(this.gripR, this.gripR.clone().add(V(0.06, 0, 0)), 0.018, mats.dark));
    // 前かご
    const basket = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.22, 0.26), new THREE.MeshStandardMaterial({ color: '#8b6a45', roughness: 0.9 }));
    basket.position.copy(local(V(0, 0.86, -0.66)));
    basket.castShadow = true;
    steer.add(basket);
    this.frontWheel = makeWheel(mats);
    this.frontWheel.position.copy(local(P.front));
    steer.add(this.frontWheel);
    // ライト
    const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.035, 8, 6), new THREE.MeshBasicMaterial({ color: '#fff6d8' }));
    lamp.position.copy(local(V(0, 0.8, -0.54)));
    steer.add(lamp);

    // クランク
    const crank = new THREE.Group();
    crank.position.copy(P.bb);
    lean.add(crank);
    this.crankGroup = crank;
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.1, 0.012, 6, 24), mats.metal);
    ring.rotation.y = Math.PI / 2;
    ring.position.x = 0.06;
    crank.add(ring);
    this.pedals = [];
    for (const side of [1, -1]) {
      const arm = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.17, 0.03), mats.metal);
      arm.position.set(0.09 * side, -0.085 * side, 0);
      crank.add(arm);
      const pedal = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.02, 0.06), mats.dark);
      pedal.position.set(0.14 * side, -0.17 * side, 0);
      crank.add(pedal);
      this.pedals.push(pedal);
    }

    // ライダー
    const rider = new THREE.Group();
    lean.add(rider);
    this.rider = rider;
    this.hip = V(0, 1.03, 0.2);
    this.shoulder = V(0, 1.5, -0.08);
    const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.15, 0.32, 4, 10), mats.jersey);
    setTube(torso, this.hip, this.shoulder);
    torso.scale.set(1, 1, 0.8);
    torso.castShadow = true;
    rider.add(torso);
    const stripe = new THREE.Mesh(new THREE.CylinderGeometry(0.155, 0.155, 0.08, 10), mats.jersey2);
    setTube(stripe, this.hip.clone().lerp(this.shoulder, 0.45), this.hip.clone().lerp(this.shoulder, 0.6));
    stripe.scale.x = 1;
    stripe.scale.z = 0.82;
    rider.add(stripe);
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.1, 12, 10), mats.skin);
    head.position.set(0, 1.71, -0.14);
    head.castShadow = true;
    rider.add(head);
    const helmet = new THREE.Mesh(new THREE.SphereGeometry(0.118, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2), mats.helmet);
    helmet.position.set(0, 1.73, -0.13);
    helmet.rotation.x = -0.25;
    helmet.castShadow = true;
    rider.add(helmet);
    this.head = head;
    // 腕と脚（毎フレーム更新）
    this.arms = [tube(V(), V(0, 1, 0), 0.04, mats.skin), tube(V(), V(0, 1, 0), 0.04, mats.skin)];
    this.upperArms = [tube(V(), V(0, 1, 0), 0.05, mats.jersey), tube(V(), V(0, 1, 0), 0.05, mats.jersey)];
    this.thighs = [tube(V(), V(0, 1, 0), 0.07, mats.jersey2), tube(V(), V(0, 1, 0), 0.07, mats.jersey2)];
    this.shins = [tube(V(), V(0, 1, 0), 0.05, mats.skin), tube(V(), V(0, 1, 0), 0.05, mats.skin)];
    this.shoes = [0, 1].map(() => {
      const s = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.06, 0.2), mats.shoe);
      s.castShadow = true;
      return s;
    });
    rider.add(...this.arms, ...this.upperArms, ...this.thighs, ...this.shins, ...this.shoes);
    this.updatePose();
  }

  updatePose() {
    const V = (x, y, z) => new THREE.Vector3(x, y, z);
    // 腕: 肩 → ひじ → ハンドルのグリップ
    const sa = Math.sin(this.steerGroup.rotation.y), ca = Math.cos(this.steerGroup.rotation.y);
    const sp = this.steerGroup.position;
    [this.gripL, this.gripR].forEach((g, i) => {
      const hand = V(sp.x + g.x * ca + g.z * sa, sp.y + g.y, sp.z - g.x * sa + g.z * ca);
      const sh = V(i === 0 ? -0.19 : 0.19, this.shoulder.y - 0.04, this.shoulder.z);
      const elbow = sh.clone().lerp(hand, 0.5).add(V(i === 0 ? -0.06 : 0.06, -0.06, 0.05));
      setTube(this.upperArms[i], sh, elbow);
      setTube(this.arms[i], elbow, hand);
    });
    // 脚: 2 リンク IK（腿 0.46 m、すね 0.46 m）。ひざは前に出す
    const L1 = 0.46, L2 = 0.46;
    const c = this.crank;
    for (let i = 0; i < 2; i++) {
      const side = i === 0 ? 1 : -1;
      const a = c + (i === 0 ? 0 : Math.PI);
      const foot = V(0.14 * side, this.P.bb.y - Math.cos(a) * 0.17, this.P.bb.z + Math.sin(a) * 0.17);
      const hip = V(0.1 * side, this.hip.y, this.hip.z);
      const dy = foot.y - hip.y, dz = foot.z - hip.z;
      let D = Math.hypot(dy, dz);
      D = Math.min(D, L1 + L2 - 0.001);
      const base = Math.atan2(dz, dy);
      const alpha = Math.acos(Math.min(1, Math.max(-1, (L1 * L1 + D * D - L2 * L2) / (2 * L1 * D))));
      const k1 = V(hip.x, hip.y + L1 * Math.cos(base + alpha), hip.z + L1 * Math.sin(base + alpha));
      const k2 = V(hip.x, hip.y + L1 * Math.cos(base - alpha), hip.z + L1 * Math.sin(base - alpha));
      const knee = k1.z < k2.z ? k1 : k2;
      setTube(this.thighs[i], hip, knee);
      setTube(this.shins[i], knee, foot);
      this.shoes[i].position.copy(foot).add(V(0, 0.03, -0.03));
    }
  }

  place(x, z, heading) {
    this.x = x;
    this.z = z;
    this.heading = heading;
    this.speed = 0;
    this.steer = 0;
    this.lean = 0;
    this.syncModel();
  }

  get forward() {
    return [Math.sin(this.heading), -Math.cos(this.heading)];
  }

  // 固定ステップ（1/120 秒）で物理を進める
  update(dt, input, world) {
    this.acc += Math.min(dt, 0.1);
    const step = 1 / 120;
    while (this.acc >= step) {
      this.step(step, input, world);
      this.acc -= step;
    }
    this.surfaceTimer -= dt;
    if (this.surfaceTimer <= 0) {
      this.surfaceTimer = 0.15;
      this.surface = world.surfaceAt(this.x, this.z);
    }
    this.syncModel();
  }

  step(dt, input, world) {
    const v = this.speed;
    // ペダルの力は速度が上がるほど弱くなる（通常 ≈ 30 km/h、立ちこぎ ≈ 40 km/h で頭打ち）
    const [fMax, vMax] = input.sprint ? [300, 12.5] : [230, 9.5];
    let F = 0;
    if (input.throttle > 0 && v > -0.5) F += input.throttle * fMax * Math.max(0, 1 - v / vMax);
    else if (input.throttle > 0) F += input.throttle * fMax;
    const crr = this.surface === 'grass' ? 0.035 : this.surface === 'gravel' ? 0.018 : this.surface === 'paving' ? 0.009 : 0.006;
    F -= 0.5 * 1.2 * 0.55 * v * Math.abs(v);
    F -= crr * MASS * G * Math.sign(v);
    let a = F / MASS;
    if (input.brake > 0) {
      if (v > 0.25) a -= input.brake * 6.5;
      else if (input.throttle === 0) a = (-1.6 - v) * 2.5; // 止まっているときは後ろに押して下がる
    }
    let nv = v + a * dt;
    if (v > 0 && nv < 0 && input.brake > 0 && input.throttle === 0 && v > 0.25) nv = 0;
    if (Math.abs(nv) < 0.02 && input.throttle === 0 && input.brake === 0) nv = 0;
    this.speed = nv;
    this.pedaling = input.throttle;

    // ハンドル: 横方向の加速度が 5.5 m/s²（傾き約 30°）を超えないよう、速いほど切れ角を小さく
    const sp = Math.abs(this.speed);
    const maxSteer = Math.min(0.62, Math.atan((WHEELBASE * 5.5) / Math.max(0.01, sp * sp)));
    const target = input.steer * maxSteer;
    this.steer += (target - this.steer) * Math.min(1, dt * 9);
    const yawRate = (this.speed * Math.tan(this.steer)) / WHEELBASE;
    this.heading += yawRate * dt;

    // 移動と衝突
    const [fx, fz] = this.forward;
    let nx = this.x + fx * this.speed * dt;
    let nz = this.z + fz * this.speed * dt;
    const res = world.collision.resolve(nx, nz, RADIUS);
    nx = res.x;
    nz = res.z;
    if (res.hit) {
      const dir = Math.sign(this.speed) || 1;
      const impact = Math.max(0, -(fx * res.nx + fz * res.nz) * dir);
      if (!this.contact && impact > 0.55 && sp > 3.5) {
        this.events.push({ type: 'bump', strength: Math.min(1, sp / 8) });
        this.speed *= 0.25;
      } else {
        this.speed *= Math.exp(-impact * impact * 10 * dt);
      }
      // 壁に沿う向きへ少しずつ向きを変える（引っかかり防止）
      if (impact > 0.05 && impact < 0.95 && sp > 0.5) {
        const tx = -res.nz, tz = res.nx;
        const s = fx * tx + fz * tz >= 0 ? 1 : -1;
        const want = Math.atan2(tx * s, -tz * s);
        let d = want - this.heading;
        d = Math.atan2(Math.sin(d), Math.cos(d));
        this.heading += d * Math.min(1, dt * 2.5 * impact);
      }
    }
    this.contact = res.hit;
    if (world.collision.blockedByWater(nx, nz)) {
      if (sp > 1) this.events.push({ type: 'water' });
      nx = this.x;
      nz = this.z;
      this.speed *= 0.1;
    } else if (world.collision.outOfBounds(nx, nz)) {
      if (sp > 1) this.events.push({ type: 'edge' });
      nx = this.x;
      nz = this.z;
      this.speed *= 0.1;
    }
    const moved = Math.hypot(nx - this.x, nz - this.z);
    this.odometer += moved;
    this.x = nx;
    this.z = nz;

    // 見た目用: 傾き・クランク・車輪
    const targetLean = Math.max(-0.6, Math.min(0.6, Math.atan((this.speed * yawRate) / G)));
    this.lean += (targetLean - this.lean) * Math.min(1, dt * 7);
    this.wheelAngle += (this.speed / WHEEL_R) * dt;
    if (input.throttle > 0 && this.speed >= 0) this.crank += Math.max(this.speed, 1.2) / WHEEL_R / 2.6 * dt;
    if (this.speed * 3.6 > this.topSpeed) this.topSpeed = this.speed * 3.6;
  }

  syncModel() {
    this.root.position.set(this.x, 0, this.z);
    this.root.rotation.y = -this.heading;
    this.leanGroup.rotation.z = -this.lean;
    this.steerGroup.rotation.y = -this.steer;
    this.rearWheel.rotation.x = -this.wheelAngle;
    this.frontWheel.rotation.x = -this.wheelAngle;
    this.crankGroup.rotation.x = -this.crank;
    this.pedals.forEach((p) => (p.rotation.x = this.crank));
    // 立ちこぎ風に少し上体を揺らす
    this.rider.rotation.z = Math.sin(this.crank) * 0.03 * this.pedaling;
    this.updatePose();
  }

  // 頭の位置（一人称カメラ用、ワールド座標）
  headWorld(target) {
    return this.head.getWorldPosition(target);
  }
}
