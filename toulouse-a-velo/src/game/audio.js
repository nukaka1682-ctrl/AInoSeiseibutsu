// 効果音（WebAudio で合成）: 自転車のベル、風切り音、ラチェット音、衝突音。
export class AudioFx {
  constructor() {
    this.ctx = null;
    this.muted = false;
    this.tickTimer = 0;
  }

  init() {
    if (this.ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = (this.ctx = new AC());
    this.master = ctx.createGain();
    this.master.gain.value = 0.7;
    this.master.connect(ctx.destination);
    // 風切り音: ホワイトノイズ → バンドパス
    const len = ctx.sampleRate * 2;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    this.noise = buf;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    this.windFilter = ctx.createBiquadFilter();
    this.windFilter.type = 'bandpass';
    this.windFilter.frequency.value = 500;
    this.windFilter.Q.value = 0.6;
    this.windGain = ctx.createGain();
    this.windGain.gain.value = 0;
    src.connect(this.windFilter).connect(this.windGain).connect(this.master);
    src.start();
  }

  resume() {
    this.ctx?.resume?.();
  }

  setMuted(m) {
    this.muted = m;
    if (this.master) this.master.gain.value = m ? 0 : 0.7;
  }

  bell() {
    const ctx = this.ctx;
    if (!ctx) return;
    const ring = (t0) => {
      for (const [f, a] of [[2200, 0.25], [3520, 0.12], [5100, 0.06]]) {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.type = 'sine';
        o.frequency.value = f;
        g.gain.setValueAtTime(0, t0);
        g.gain.linearRampToValueAtTime(a, t0 + 0.005);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.9);
        o.connect(g).connect(this.master);
        o.start(t0);
        o.stop(t0 + 1);
      }
    };
    ring(ctx.currentTime);
    ring(ctx.currentTime + 0.16);
  }

  bump(strength = 1) {
    const ctx = this.ctx;
    if (!ctx) return;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 400;
    const g = ctx.createGain();
    const t = ctx.currentTime;
    g.gain.setValueAtTime(0.6 * strength, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.25);
    src.connect(f).connect(g).connect(this.master);
    src.start(t, Math.random());
    src.stop(t + 0.3);
  }

  chime() {
    const ctx = this.ctx;
    if (!ctx) return;
    [660, 880, 1320].forEach((f, i) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      const t = ctx.currentTime + i * 0.11;
      o.type = 'triangle';
      o.frequency.value = f;
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.18, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.6);
      o.connect(g).connect(this.master);
      o.start(t);
      o.stop(t + 0.7);
    });
  }

  tick() {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    const t = ctx.currentTime;
    o.type = 'square';
    o.frequency.value = 3200;
    g.gain.setValueAtTime(0.02, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.012);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + 0.02);
  }

  update(dt, speed, coasting) {
    if (!this.ctx) return;
    const s = Math.abs(speed);
    this.windGain.gain.setTargetAtTime(Math.min(0.35, (s / 12) ** 2 * 0.35), this.ctx.currentTime, 0.1);
    this.windFilter.frequency.setTargetAtTime(300 + s * 60, this.ctx.currentTime, 0.1);
    // こがずに走っているときのラチェット音
    if (coasting && s > 0.8) {
      this.tickTimer -= dt;
      if (this.tickTimer <= 0) {
        this.tick();
        this.tickTimer = 0.9 / (s * 3);
      }
    }
  }
}
