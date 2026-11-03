// 歩く人（プレイヤー）。形は簡単な人形（頭・胴・腕・脚）で、歩くと腕と脚を振る。
// 動き: 歩く 1.4 m/s・走る 3.2 m/s。床は Nav（nav.js）で決める（段差 0.6 m まで上り下り、床のない所へは進めない）。
// 動く床（電車・エスカレーター）に乗っていれば一緒に運ばれる
import * as THREE from 'three';
import { STEP_DOWN, STEP_UP } from './nav.js';

export const EYE = 1.62;
const RADIUS = 0.24;

export class Walker {
  constructor() {
    this.x = 0;
    this.y = 0;
    this.z = 0;
    this.yaw = 0; // 向き（0 で北 = -z、時計回り）
    this.pitch = 0;
    this.speed = 0;
    this.phase = 0;
    this.region = null; // 立っている床
    this.smoothY = 0;
    this.root = makeFigure();
    this.events = [];
    this.lastStep = 0;
  }

  place(x, y, z, yaw = this.yaw) {
    Object.assign(this, { x, y, z, yaw, smoothY: y, speed: 0 });
    this.region = null;
    this.sync();
  }

  get layer() {
    return this.region?.layer?.pose ? this.region.layer : null;
  }

  // 乗っている動く床に運ばれる（毎フレーム、物理の前に）
  carry(dt) {
    this.carried = 0;
    const L = this.layer;
    if (L) {
      const [x, y, z, da] = L.carry(this.x, this.y, this.z);
      this.smoothY += y - this.y;
      this.x = x;
      this.z = z;
      this.y = y;
      this.yaw += da;
      this.carried = da;
    }
    const c = this.region?.conveyor;
    if (c) {
      this.x += c[0] * dt;
      this.z += c[1] * dt;
    }
  }

  // ctl: { fwd, side, run }（-1..1）。dir: 歩く向きの基準（カメラの向き）
  update(dt, ctl, nav, viewYaw) {
    this.carry(dt);
    const want = Math.hypot(ctl.fwd, ctl.side);
    const target = want > 0.05 ? (ctl.run ? 3.2 : 1.45) * Math.min(1, want) : 0;
    this.speed += (target - this.speed) * Math.min(1, dt * (target > this.speed ? 6 : 9));
    let mx = 0, mz = 0;
    if (want > 0.05) {
      // 進む向き: カメラの向きに対する入力の向き
      const a = viewYaw + Math.atan2(ctl.side, ctl.fwd);
      mx = Math.sin(a);
      mz = -Math.cos(a);
      // 体の向きは進む向きへなめらかに
      let d = a - this.yaw;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      this.yaw += d * Math.min(1, dt * 10);
    }
    const step = this.speed * dt;
    if (step > 1e-5) this.move(mx * step, mz * step, nav);
    else {
      // 止まっていても床の高さは追う（動く床・エスカレーター）
      const f = nav.floorAt(this.x, this.z, this.y);
      if (f) {
        this.y = f.y;
        this.region = f.region;
      } else this.unstick(nav);
    }
    // 歩く動き
    this.phase += this.speed * dt * 1.15;
    const k = Math.min(1, dt * 12);
    this.smoothY += (this.y - this.smoothY) * k;
    if (Math.abs(this.y - this.smoothY) > 1) this.smoothY = this.y;
    // 足音
    const ph = Math.floor(this.phase / Math.PI);
    if (ph !== this.lastStep && this.speed > 0.4) this.events.push({ type: 'step', surface: this.region?.kind || 'street', run: this.speed > 2.2 });
    this.lastStep = ph;
    this.sync();
  }

  // 壁を避けて (dx, dz) 進む。進めなければ x・z の片方だけ（壁に沿って滑る）
  move(dx, dz, nav) {
    const tries = [[dx, dz], [dx, 0], [0, dz]];
    for (const [ax, az] of tries) {
      if (Math.abs(ax) + Math.abs(az) < 1e-7) continue;
      let nx = this.x + ax, nz = this.z + az;
      const r = nav.resolve(nx, nz, RADIUS, this.y);
      nx = r.x;
      nz = r.z;
      const f = nav.floorAt(nx, nz, this.y, STEP_UP, STEP_DOWN);
      if (!f) continue;
      // 足の下だけでなく、体の前の縁にも床がある（ホームの縁で半分はみ出さない）
      const l = Math.hypot(ax, az);
      const fx = nx + (ax / l) * RADIUS * 0.6, fz = nz + (az / l) * RADIUS * 0.6;
      if (!nav.floorAt(fx, fz, f.y, STEP_UP, STEP_DOWN)) continue;
      this.x = nx;
      this.z = nz;
      this.y = f.y;
      this.region = f.region;
      return true;
    }
    const f = nav.floorAt(this.x, this.z, this.y);
    if (f) {
      this.y = f.y;
      this.region = f.region;
    } else this.unstick(nav);
    return false;
  }

  // 足の下に床がなくなった（扉が閉まった・動く床から外れた）: 近くの床へ
  unstick(nav) {
    for (let r = 0.2; r <= 1.6; r += 0.2) {
      for (let k = 0; k < 12; k++) {
        const a = (k / 12) * Math.PI * 2;
        const f = nav.floorAt(this.x + Math.cos(a) * r, this.z + Math.sin(a) * r, this.y, 1.0, 1.5);
        if (f) {
          this.x += Math.cos(a) * r;
          this.z += Math.sin(a) * r;
          this.y = f.y;
          this.region = f.region;
          return;
        }
      }
    }
  }

  // 人形の位置と手足
  sync() {
    const r = this.root;
    r.position.set(this.x, this.smoothY, this.z);
    r.rotation.y = -this.yaw;
    const s = Math.sin(this.phase), amp = Math.min(1, this.speed / 1.4) * (this.speed > 2.2 ? 0.75 : 0.5);
    const u = r.userData;
    u.legL.rotation.x = s * amp;
    u.legR.rotation.x = -s * amp;
    u.armL.rotation.x = -s * amp * 0.8;
    u.armR.rotation.x = s * amp * 0.8;
    u.body.position.y = Math.abs(Math.cos(this.phase)) * 0.03 * Math.min(1, this.speed);
  }

  // 目の位置（一人称のカメラ）
  eye(out) {
    const bob = Math.abs(Math.sin(this.phase)) * 0.035 * Math.min(1, this.speed / 1.4);
    return out.set(this.x, this.smoothY + EYE + bob, this.z);
  }
}

// 人形（高さ 1.75 m）。紺のジャケット・灰色のズボン・リュック
function makeFigure() {
  const root = new THREE.Group();
  root.name = 'walker';
  const mat = (c, r = 0.8) => new THREE.MeshStandardMaterial({ color: c, roughness: r });
  const skin = mat('#d9a888', 0.6), jacket = mat('#2a3a5e'), trousers = mat('#4b4f57'), shoe = mat('#1d1d1f', 0.5), bag = mat('#7a2b23'), hair = mat('#3a2a20', 0.9);
  const body = new THREE.Group();
  root.add(body);
  const add = (geo, m, x, y, z, parent = body) => {
    const o = new THREE.Mesh(geo, m);
    o.position.set(x, y, z);
    o.castShadow = true;
    parent.add(o);
    return o;
  };
  // 胴（局所: -z が前）
  add(new THREE.BoxGeometry(0.4, 0.58, 0.24), jacket, 0, 1.2, 0);
  add(new THREE.BoxGeometry(0.34, 0.12, 0.22), trousers, 0, 0.88, 0);
  add(new THREE.BoxGeometry(0.3, 0.38, 0.14), bag, 0, 1.2, 0.18);
  add(new THREE.CylinderGeometry(0.06, 0.07, 0.1, 10), skin, 0, 1.53, 0);
  const head = add(new THREE.SphereGeometry(0.115, 18, 14), skin, 0, 1.66, 0);
  head.scale.set(0.92, 1.06, 1);
  add(new THREE.SphereGeometry(0.118, 18, 10, 0, Math.PI * 2, 0, Math.PI / 2), hair, 0, 1.68, 0.01);
  const limb = (x, y, len, w, m, footM) => {
    const g = new THREE.Group();
    g.position.set(x, y, 0);
    body.add(g);
    add(new THREE.BoxGeometry(w, len, w), m, 0, -len / 2, 0, g);
    if (footM) add(new THREE.BoxGeometry(w + 0.02, 0.07, 0.26), footM, 0, -len - 0.01, -0.05, g);
    else add(new THREE.SphereGeometry(w * 0.55, 10, 8), skin, 0, -len - 0.03, 0, g);
    return g;
  };
  root.userData = {
    body,
    legL: limb(-0.1, 0.84, 0.8, 0.14, trousers, shoe),
    legR: limb(0.1, 0.84, 0.8, 0.14, trousers, shoe),
    armL: limb(-0.26, 1.46, 0.62, 0.11, jacket, null),
    armR: limb(0.26, 1.46, 0.62, 0.11, jacket, null),
  };
  return root;
}
