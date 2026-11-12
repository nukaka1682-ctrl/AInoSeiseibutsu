// 写真モード（F キー）: ゲームを止めて HUD を隠し、自転車のまわりでカメラを自由に動かして PNG を保存する。
// 操作の説明とボタンは開いたときだけ作る。描画は main.js の renderFrame を通す（後処理つきの描画に差し替えられても同じ絵を保存する）。
const DEG = Math.PI / 180;
const PITCH_MIN = -5 * DEG, PITCH_MAX = 85 * DEG;
const DIST_MIN = 2, DIST_MAX = 150;
const FOV_MIN = 20, FOV_MAX = 90;
const MAX_OFFSET = 80; // 中心を自転車から動かせる距離（m）

// 保存するファイルの名前（toulouse-a-velo-YYYYMMDD-HHMMSS.png）
export function photoFileName(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `toulouse-a-velo-${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}.png`;
}

export class PhotoMode {
  // ctx: { camera, canvas, keys（押されているキーの Set）, getWorld(), getBike(), render()（1 回描く）, onOpen(), onClose() }
  constructor(ctx) {
    this.ctx = ctx;
    this.active = false;
    this.ui = null;
    this.pointers = new Map();
    this.pinch = 0;
    this.yaw = 0;
    this.pitch = 0;
    this.dist = 8;
    this.ox = 0;
    this.oz = 0;
    this.hideBike = false;
    this.savedFov = 60;
    this.onKey = (e) => this.key(e);
    this.onDown = (e) => this.pointerDown(e);
    this.onMove = (e) => this.pointerMove(e);
    this.onUp = (e) => this.pointers.delete(e.pointerId);
    this.onWheel = (e) => {
      e.preventDefault();
      this.zoom(Math.exp(e.deltaY * 0.0015));
    };
  }

  open() {
    if (this.active) return;
    const { camera } = this.ctx;
    const bike = this.ctx.getBike();
    this.active = true;
    this.savedFov = camera.fov;
    this.zoomFov = camera.fov;
    this.ox = this.oz = 0;
    this.hideBike = false;
    // 今のカメラの位置から始める
    const dx = camera.position.x - bike.x, dy = camera.position.y - (bike.y + 1.2), dz = camera.position.z - bike.z;
    const d = Math.hypot(dx, dy, dz) || 6;
    this.dist = Math.min(DIST_MAX, Math.max(DIST_MIN, d));
    this.yaw = Math.atan2(dx, dz);
    this.pitch = Math.min(PITCH_MAX, Math.max(PITCH_MIN, Math.asin(Math.max(-1, Math.min(1, dy / d)))));
    if (d < 3) {
      // 一人称カメラ（頭の位置）から入ったときは、真上から見下ろさないように自転車の斜め後ろから
      this.dist = 6;
      this.yaw = Math.atan2(-Math.sin(bike.heading), Math.cos(bike.heading));
      this.pitch = 15 * DEG;
    }
    this.buildUi();
    const c = this.ctx.canvas;
    c.addEventListener('pointerdown', this.onDown);
    addEventListener('pointermove', this.onMove);
    addEventListener('pointerup', this.onUp);
    addEventListener('pointercancel', this.onUp);
    c.addEventListener('wheel', this.onWheel, { passive: false });
    addEventListener('keydown', this.onKey);
    this.ctx.onOpen?.();
    this.update(0);
  }

  close() {
    if (!this.active) return;
    this.active = false;
    const c = this.ctx.canvas;
    c.removeEventListener('pointerdown', this.onDown);
    removeEventListener('pointermove', this.onMove);
    removeEventListener('pointerup', this.onUp);
    removeEventListener('pointercancel', this.onUp);
    c.removeEventListener('wheel', this.onWheel);
    removeEventListener('keydown', this.onKey);
    this.pointers.clear();
    this.ui?.remove();
    this.ui = null;
    const { camera } = this.ctx;
    camera.fov = this.savedFov;
    camera.updateProjectionMatrix();
    const bike = this.ctx.getBike();
    if (bike) bike.root.visible = true;
    this.ctx.onClose?.();
  }

  buildUi() {
    const ui = document.createElement('div');
    ui.id = 'photo-ui';
    ui.innerHTML = `<div class="photo-help">ドラッグ: 向き　ホイール/ピンチ: 距離　<kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd>: 移動　<kbd>Q</kbd><kbd>E</kbd>: 画角　<kbd>H</kbd>: 自転車を隠す　<kbd>Enter</kbd>: 保存</div>
      <div class="photo-msg"></div>
      <div class="photo-buttons"><button class="primary" data-photo="save">📷 保存</button><button data-photo="close">閉じる（F）</button></div>`;
    ui.querySelector('[data-photo=save]').addEventListener('click', (e) => {
      e.currentTarget.blur();
      this.save();
    });
    ui.querySelector('[data-photo=close]').addEventListener('click', () => this.close());
    document.body.appendChild(ui);
    this.ui = ui;
  }

  key(e) {
    if (e.repeat) return;
    if (e.code === 'Enter' || e.code === 'Space') {
      e.preventDefault();
      this.save();
    } else if (e.code === 'KeyH') {
      this.hideBike = !this.hideBike;
    }
  }

  pointerDown(e) {
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this.pointers.size === 2) this.pinch = this.pinchDist();
  }

  pinchDist() {
    const [a, b] = [...this.pointers.values()];
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  pointerMove(e) {
    const p = this.pointers.get(e.pointerId);
    if (!p) return;
    const dx = e.clientX - p.x, dy = e.clientY - p.y;
    p.x = e.clientX;
    p.y = e.clientY;
    if (this.pointers.size >= 2) {
      const d = this.pinchDist();
      if (this.pinch > 0 && d > 0) this.zoom(this.pinch / d);
      this.pinch = d;
      return;
    }
    this.yaw -= dx * 0.006;
    this.pitch = Math.min(PITCH_MAX, Math.max(PITCH_MIN, this.pitch + dy * 0.005));
  }

  zoom(k) {
    this.dist = Math.min(DIST_MAX, Math.max(DIST_MIN, this.dist * k));
  }

  // 描画フレームごと（ゲームの更新の代わり）
  update(dt) {
    if (!this.active) return;
    const { camera, keys } = this.ctx;
    const bike = this.ctx.getBike();
    const w = this.ctx.getWorld();
    // 中心を水平に動かす（カメラの向きに対して前後左右）
    const f = (keys.has('KeyW') || keys.has('ArrowUp') ? 1 : 0) - (keys.has('KeyS') || keys.has('ArrowDown') ? 1 : 0);
    const r = (keys.has('KeyD') || keys.has('ArrowRight') ? 1 : 0) - (keys.has('KeyA') || keys.has('ArrowLeft') ? 1 : 0);
    if (f || r) {
      const sp = Math.max(4, this.dist * 0.8) * dt;
      const fx = -Math.sin(this.yaw), fz = -Math.cos(this.yaw);
      this.ox += (fx * f - fz * r) * sp;
      this.oz += (fz * f + fx * r) * sp;
      const d = Math.hypot(this.ox, this.oz);
      if (d > MAX_OFFSET) {
        this.ox *= MAX_OFFSET / d;
        this.oz *= MAX_OFFSET / d;
      }
    }
    const zoomKey = (keys.has('KeyE') ? 1 : 0) - (keys.has('KeyQ') ? 1 : 0);
    let fov = this.zoomFov ?? camera.fov;
    if (zoomKey) fov = Math.min(FOV_MAX, Math.max(FOV_MIN, fov + zoomKey * 30 * dt));
    this.zoomFov = fov;
    if (Math.abs(camera.fov - fov) > 1e-3) {
      camera.fov = fov;
      camera.updateProjectionMatrix();
    }
    bike.root.visible = !this.hideBike;
    const cx = bike.x + this.ox, cz = bike.z + this.oz;
    const ground = (x, z, y) => (w?.groundAt ? w.groundAt(x, z, y) : w?.heightAt ? w.heightAt(x, z) : bike.y);
    let cy = bike.y + 1.2;
    if (this.ox || this.oz) cy = Math.max(cy, ground(cx, cz, cy + 2) + 1.2);
    const cp = Math.cos(this.pitch);
    const px = cx + Math.sin(this.yaw) * cp * this.dist;
    const pz = cz + Math.cos(this.yaw) * cp * this.dist;
    let py = cy + Math.sin(this.pitch) * this.dist;
    const g = ground(px, pz, py + 1);
    if (Number.isFinite(g)) py = Math.max(py, g + 0.4); // 地面の 0.4 m 上より下げない
    camera.up.set(0, 1, 0);
    camera.position.set(px, py, pz);
    camera.lookAt(cx, cy, cz);
  }

  // 説明とボタンを隠して 1 回描き、その直後に読む（preserveDrawingBuffer なしでも描いた絵が読める）
  grab(read) {
    if (this.ui) this.ui.style.visibility = 'hidden';
    this.ctx.render();
    const out = read(this.ctx.canvas);
    if (this.ui) this.ui.style.visibility = '';
    return out;
  }

  // 知らせ（HUD の toast は写真モードの間は隠れているので、写真モードの画面に出す）
  message(text) {
    const el = this.ui?.querySelector('.photo-msg');
    if (!el) return;
    el.textContent = text;
    el.classList.add('show');
    clearTimeout(this.msgTimer);
    this.msgTimer = setTimeout(() => el.classList.remove('show'), 2000);
  }

  // テスト用: dataURL（PNG）を返す
  capture() {
    return Promise.resolve(this.grab((c) => c.toDataURL('image/png')));
  }

  save() {
    if (!this.active) return;
    // toBlob は呼んだ時点の絵を写す（描いた直後に同じ呼び出しの中で呼ぶ）
    this.grab((c) => c.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = photoFileName();
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      this.message('📷 保存しました');
    }, 'image/png'));
  }
}
