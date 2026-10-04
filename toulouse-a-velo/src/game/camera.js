// カメラ: 追従（三人称）・一人称・上空の3モード。建物にめり込まないよう 2D レイで手前に寄せる。
import * as THREE from 'three';

export const CAMERA_MODES = ['chase', 'fpv', 'high'];
export const CAMERA_LABELS = { chase: '追従カメラ', fpv: '一人称カメラ', high: '上空カメラ' };

export class CameraRig {
  constructor(camera) {
    this.camera = camera;
    this.mode = 'chase';
    this.yaw = 0;
    this.shake = 0;
    this.pos = new THREE.Vector3();
    this.look = new THREE.Vector3();
    this.tmp = new THREE.Vector3();
    this.initialized = false;
  }

  cycle() {
    this.mode = CAMERA_MODES[(CAMERA_MODES.indexOf(this.mode) + 1) % CAMERA_MODES.length];
    this.initialized = false;
    return this.mode;
  }

  bump(strength) {
    this.shake = Math.max(this.shake, 0.25 * strength);
  }

  update(dt, bike, collision) {
    const cam = this.camera;
    const sp = Math.abs(bike.speed);
    let d = this.yaw - bike.heading;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    this.yaw = bike.heading + d * Math.exp(-dt * 3.2);
    if (!this.initialized) this.yaw = bike.heading;

    const fx = Math.sin(bike.heading), fz = -Math.cos(bike.heading);
    const cx = Math.sin(this.yaw), cz = -Math.cos(this.yaw);

    if (this.mode === 'fpv') {
      bike.headWorld(this.pos);
      this.pos.x += fx * 0.15;
      this.pos.z += fz * 0.15;
      this.pos.y += 0.02;
      cam.position.copy(this.pos);
      this.look.set(this.pos.x + fx * 10, this.pos.y - 0.9, this.pos.z + fz * 10);
      cam.up.set(Math.cos(bike.heading) * Math.sin(bike.lean) * 0.6, 1, Math.sin(bike.heading) * Math.sin(bike.lean) * 0.6).normalize();
      cam.lookAt(this.look);
    } else {
      cam.up.set(0, 1, 0);
      const high = this.mode === 'high';
      const dist = high ? 20 : 5.2 + Math.min(sp, 12) * 0.12;
      const height = high ? 58 : 2.3 + Math.min(sp, 12) * 0.03;
      let tx = bike.x - cx * dist, tz = bike.z - cz * dist;
      let ty = height;
      let pulled = false;
      if (!high) {
        const t = collision.raycast(bike.x, bike.z, tx, tz);
        if (t < 1) {
          const k = Math.max(0.12, t - 0.12);
          tx = bike.x + (tx - bike.x) * k;
          tz = bike.z + (tz - bike.z) * k;
          ty = height + (1 - k) * 0.8;
          pulled = true;
        }
      }
      this.tmp.set(tx, ty, tz);
      if (!this.initialized) {
        this.pos.copy(this.tmp);
      } else {
        const a = 1 - Math.exp(-dt * (high ? 4 : 10));
        this.pos.lerp(this.tmp, a);
        if (pulled) {
          // 壁の内側に入らないよう、水平方向は即座に合わせる
          this.pos.x = tx;
          this.pos.z = tz;
        }
      }
      cam.position.copy(this.pos);
      this.look.set(bike.x + fx * (high ? 4 : 2.2), high ? 0 : 1.25, bike.z + fz * (high ? 4 : 2.2));
      cam.lookAt(this.look);
    }
    if (this.shake > 0.001) {
      cam.position.x += (Math.random() - 0.5) * this.shake;
      cam.position.y += (Math.random() - 0.5) * this.shake;
      this.shake *= Math.exp(-dt * 6);
    }
    const fov = this.mode === 'fpv' ? 75 + sp * 0.6 : 60 + Math.min(sp, 14) * 0.7;
    if (Math.abs(cam.fov - fov) > 0.05) {
      cam.fov += (fov - cam.fov) * Math.min(1, dt * 3);
      cam.updateProjectionMatrix();
    }
    this.initialized = true;
  }
}
