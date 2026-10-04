// カメラ: 追従（三人称）・一人称・上空の3モード。建物にめり込まないよう 2D レイで手前に寄せる。
import * as THREE from 'three';

export const CAMERA_MODES = ['chase', 'fpv', 'high', 'drone'];
export const CAMERA_LABELS = { chase: '追従カメラ', fpv: '一人称カメラ', high: '上空カメラ', drone: '空撮カメラ' };
// 追従系カメラの位置: 自転車の後ろ dist m・上 height m から、前方 ahead m・高さ lookY m の点を見る
const VIEW = {
  high: { dist: 12, height: 34, ahead: 4, lookY: 0, follow: 4 },
  drone: { dist: 85, height: 60, ahead: 0, lookY: 0, follow: 2.5 },
};

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

  update(dt, bike, collision, heightAt = null) {
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
      const v = VIEW[this.mode] || { dist: 5.2 + Math.min(sp, 12) * 0.12, height: 2.3 + Math.min(sp, 12) * 0.03, ahead: 2.2, lookY: 1.25, follow: 10 };
      const { dist, height } = v;
      let tx = bike.x - cx * dist, tz = bike.z - cz * dist;
      let ty = bike.y + height;
      let pulled = false;
      if (!VIEW[this.mode]) {
        const t = collision.raycast(bike.x, bike.z, tx, tz);
        if (t < 1) {
          const k = Math.max(0.12, t - 0.12);
          tx = bike.x + (tx - bike.x) * k;
          tz = bike.z + (tz - bike.z) * k;
          ty = bike.y + height + (1 - k) * 0.8;
          pulled = true;
        }
      }
      // 坂の下などでカメラが地面に潜らないように
      if (heightAt) ty = Math.max(ty, heightAt(tx, tz) + 1.2);
      this.tmp.set(tx, ty, tz);
      if (!this.initialized) {
        this.pos.copy(this.tmp);
      } else {
        const a = 1 - Math.exp(-dt * v.follow);
        this.pos.lerp(this.tmp, a);
        if (pulled) {
          // 壁の内側に入らないよう、水平方向は即座に合わせる
          this.pos.x = tx;
          this.pos.z = tz;
        }
      }
      cam.position.copy(this.pos);
      this.look.set(bike.x + fx * v.ahead, bike.y + v.lookY, bike.z + fz * v.ahead);
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
