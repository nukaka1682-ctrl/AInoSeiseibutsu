// 歩く人（プレイヤー）。形は簡単な人形（頭・胴・腕・脚）で、歩くと腕と脚を振る。
// 動き: 歩く 1.4 m/s・走る 3.2 m/s。床は Nav（nav.js）で決める（段差 0.6 m まで上り下り、床のない所へは進めない）。
// 動く床（電車・エスカレーター）に乗っていれば一緒に運ばれる
import * as THREE from 'three';
import { HIP_X, HIP_Y, SHOULDER_X, SHOULDER_Y, armGeometry, bagGeometry, hairGeometry, handGeometry, headGeometry, legGeometry, torsoGeometry } from './people.js';
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

// 人形（高さ 1.75 m。people.js のなめらかな体）。紺のジャケット・灰色のズボン・リュック
function makeFigure() {
  const root = new THREE.Group();
  root.name = 'walker';
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.75 });
  const tint = (g, hex) => {
    const c = new THREE.Color(hex), a = g.attributes.color.array;
    for (let i = 0; i < a.length; i += 3) {
      a[i] *= c.r;
      a[i + 1] *= c.g;
      a[i + 2] *= c.b;
    }
    return g;
  };
  const body = new THREE.Group();
  root.add(body);
  const add = (geo, parent = body) => {
    const o = new THREE.Mesh(geo, mat);
    o.castShadow = true;
    parent.add(o);
    return o;
  };
  const torso = torsoGeometry({ kind: 'm' });
  torso.setAttribute('color', new THREE.BufferAttribute(new Float32Array(torso.attributes.position.count * 3).fill(1), 3));
  add(tint(torso, '#2a3a5e'));
  add(tint(headGeometry(), '#d9a888'));
  add(tint(hairGeometry(0), '#3a2a20'));
  add(tint(bagGeometry(0), '#7a2b23'));
  const limb = (x, y, geos, z = 0) => {
    const g = new THREE.Group();
    g.position.set(x, y, 0);
    if (z) g.rotation.z = z;
    body.add(g);
    for (const geo of geos) add(geo, g);
    return g;
  };
  const leg = () => [tint(legGeometry({ knee: 0.06 }), '#4b4f57')];
  const arm = () => [tint(armGeometry({ elbow: 0.18 }), '#2a3a5e'), tint(handGeometry({ elbow: 0.18 }), '#d9a888')];
  root.userData = {
    body,
    legL: limb(-HIP_X, HIP_Y, leg()),
    legR: limb(HIP_X, HIP_Y, leg()),
    armL: limb(-SHOULDER_X, SHOULDER_Y, arm(), -0.07),
    armR: limb(SHOULDER_X, SHOULDER_Y, arm(), 0.07),
  };
  return root;
}
