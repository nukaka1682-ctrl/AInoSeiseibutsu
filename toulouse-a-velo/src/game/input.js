// 入力: キーボード・ゲームパッド・タッチ（スマホ用の画面ボタン）。
export class Input {
  constructor() {
    this.keys = new Set();
    this.handlers = new Map();
    this.steerAxis = 0;
    this.touch = { left: false, right: false, pedal: false, brake: false };
    this.enabled = true;
    this.prevPad = [];
    addEventListener('keydown', (e) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
      if (!e.repeat) this.handlers.get(e.code)?.(e);
      this.keys.add(e.code);
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) e.preventDefault();
    });
    addEventListener('keyup', (e) => this.keys.delete(e.code));
    addEventListener('blur', () => this.keys.clear());
  }

  on(code, fn) {
    for (const c of Array.isArray(code) ? code : [code]) this.handlers.set(c, fn);
  }

  bindTouch(root) {
    for (const btn of root.querySelectorAll('[data-touch]')) {
      const k = btn.dataset.touch;
      const set = (v) => (e) => {
        e.preventDefault();
        this.touch[k] = v;
        btn.classList.toggle('active', v);
      };
      btn.addEventListener('pointerdown', set(true));
      btn.addEventListener('pointerup', set(false));
      btn.addEventListener('pointercancel', set(false));
      btn.addEventListener('pointerleave', set(false));
    }
  }

  pad() {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    for (const p of pads) if (p && p.connected) return p;
    return null;
  }

  // 1 フレームごとに呼ぶ。戻り値は自転車の操作量
  read(dt) {
    const k = this.keys;
    let throttle = k.has('KeyW') || k.has('ArrowUp') || this.touch.pedal ? 1 : 0;
    let brake = k.has('KeyS') || k.has('ArrowDown') || this.touch.brake ? 1 : 0;
    let steerTarget = 0;
    if (k.has('KeyA') || k.has('ArrowLeft') || this.touch.left) steerTarget -= 1;
    if (k.has('KeyD') || k.has('ArrowRight') || this.touch.right) steerTarget += 1;
    let sprint = k.has('ShiftLeft') || k.has('ShiftRight');

    // キーボードのハンドルはなめらかに
    const rate = steerTarget === 0 ? 7 : Math.sign(steerTarget) !== Math.sign(this.steerAxis) ? 9 : 3.5;
    const diff = steerTarget - this.steerAxis;
    this.steerAxis += Math.sign(diff) * Math.min(Math.abs(diff), rate * dt);
    let steer = this.steerAxis;

    const p = this.pad();
    if (p) {
      const ax = p.axes[0] || 0;
      if (Math.abs(ax) > 0.12) steer = Math.sign(ax) * ((Math.abs(ax) - 0.12) / 0.88) ** 1.4;
      const rt = p.buttons[7]?.value || 0, lt = p.buttons[6]?.value || 0;
      const a = p.buttons[0]?.pressed ? 1 : 0;
      throttle = Math.max(throttle, rt, a);
      brake = Math.max(brake, lt, p.buttons[1]?.pressed ? 1 : 0);
      sprint = sprint || !!p.buttons[5]?.pressed || !!p.buttons[10]?.pressed;
      // 単発ボタン: Y=カメラ, X=ベル, Back=地図, Start=ポーズ
      const map = { 3: 'KeyC', 2: 'Space', 8: 'KeyM', 9: 'Escape' };
      for (const [i, code] of Object.entries(map)) {
        const pressed = !!p.buttons[i]?.pressed;
        if (pressed && !this.prevPad[i]) this.handlers.get(code)?.({ code });
        this.prevPad[i] = pressed;
      }
    }
    if (!this.enabled) return { throttle: 0, brake: 1, steer: 0, sprint: false };
    return { throttle, brake, steer, sprint };
  }
}
