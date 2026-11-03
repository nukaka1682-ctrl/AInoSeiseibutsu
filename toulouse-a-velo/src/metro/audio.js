// メトロの音（WebAudio で合成）: VAL のゴムタイヤの走行音（低いうなりとモーターの高い音）、扉の閉まる合図、足音、
// 駅の空調のざわめき、街の音。車内放送はブラウザの音声合成（フランス語の声があれば）で「Prochaine station …」
export class MetroAudio {
  constructor() {
    this.ctx = null;
    this.muted = false;
    this.speechOk = typeof speechSynthesis !== 'undefined';
  }

  init() {
    if (this.ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = (this.ctx = new AC());
    this.master = ctx.createGain();
    this.master.gain.value = 0.8;
    this.master.connect(ctx.destination);
    const len = ctx.sampleRate * 2, buf = ctx.createBuffer(1, len, ctx.sampleRate), d = buf.getChannelData(0);
    let b = 0;
    for (let i = 0; i < len; i++) {
      // ピンクっぽいノイズ
      b = 0.97 * b + 0.03 * (Math.random() * 2 - 1);
      d[i] = b * 6;
    }
    this.noiseBuf = buf;
    const loop = (filterType, freq, q) => {
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      const f = ctx.createBiquadFilter();
      f.type = filterType;
      f.frequency.value = freq;
      f.Q.value = q;
      const g = ctx.createGain();
      g.gain.value = 0;
      src.connect(f).connect(g).connect(this.master);
      src.start();
      return { f, g };
    };
    // 走行音: ゴムタイヤのこもった音（低域のノイズ）とモーターの音（速さで音程が上がる）
    this.roll = loop('lowpass', 300, 0.7);
    this.motor = ctx.createOscillator();
    this.motor.type = 'sawtooth';
    this.motor.frequency.value = 80;
    const mf = ctx.createBiquadFilter();
    mf.type = 'bandpass';
    mf.frequency.value = 700;
    mf.Q.value = 3;
    this.motorGain = ctx.createGain();
    this.motorGain.gain.value = 0;
    this.motor.connect(mf).connect(this.motorGain).connect(this.master);
    this.motor.start();
    // 駅の空調のざわめき・街の音
    this.hum = loop('bandpass', 180, 0.8);
    this.city = loop('bandpass', 900, 0.4);
  }

  resume() {
    this.ctx?.resume?.();
  }

  setMuted(m) {
    this.muted = m;
    if (this.master) this.master.gain.value = m ? 0 : 0.8;
    if (m && this.speechOk) speechSynthesis.cancel();
  }

  // 毎フレーム: train（近くの電車の速さ m/s と距離 m、車内か）、place（'surface' | 'station' | 'train'）
  update(dt, { trainSpeed = 0, trainDist = 999, inTrain = false, place = 'surface' } = {}) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime, k = 0.25;
    const near = inTrain ? 1 : Math.max(0, 1 - trainDist / 70);
    const v = Math.min(1, trainSpeed / 19);
    this.roll.g.gain.setTargetAtTime((inTrain ? 0.22 : 0.35) * near * (0.15 + v), t, k);
    this.roll.f.frequency.setTargetAtTime(160 + 500 * v, t, k);
    this.motor.frequency.setTargetAtTime(60 + 520 * v * (v < 0.6 ? 1 : 0.8), t, k);
    this.motorGain.gain.setTargetAtTime(0.03 * near * Math.min(1, trainSpeed / 2), t, k);
    this.hum.g.gain.setTargetAtTime(place === 'station' ? 0.05 : place === 'train' ? 0.02 : 0, t, 0.6);
    this.city.g.gain.setTargetAtTime(place === 'surface' ? 0.035 : 0, t, 0.8);
  }

  // 扉の閉まる合図（短い音を 3 回）
  chime() {
    const ctx = this.ctx;
    if (!ctx) return;
    const t0 = ctx.currentTime + 0.02;
    for (let i = 0; i < 3; i++) {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'square';
      o.frequency.value = 1180;
      const a = t0 + i * 0.32;
      g.gain.setValueAtTime(0, a);
      g.gain.linearRampToValueAtTime(0.06, a + 0.01);
      g.gain.setValueAtTime(0.06, a + 0.18);
      g.gain.linearRampToValueAtTime(0, a + 0.2);
      o.connect(g).connect(this.master);
      o.start(a);
      o.stop(a + 0.22);
    }
  }

  // 到着の合図（やわらかい 2 音）
  ding() {
    const ctx = this.ctx;
    if (!ctx) return;
    const t0 = ctx.currentTime + 0.02;
    [[784, 0], [1047, 0.28]].forEach(([f, dt]) => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'sine';
      o.frequency.value = f;
      g.gain.setValueAtTime(0, t0 + dt);
      g.gain.linearRampToValueAtTime(0.12, t0 + dt + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dt + 1.2);
      o.connect(g).connect(this.master);
      o.start(t0 + dt);
      o.stop(t0 + dt + 1.3);
    });
  }

  // 扉の動く音
  doors() {
    const ctx = this.ctx;
    if (!ctx) return;
    const src = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain(), t0 = ctx.currentTime;
    src.buffer = this.noiseBuf;
    f.type = 'bandpass';
    f.frequency.value = 1400;
    f.Q.value = 1.2;
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(0.09, t0 + 0.1);
    g.gain.linearRampToValueAtTime(0.0, t0 + 1.2);
    src.connect(f).connect(g).connect(this.master);
    src.start(t0);
    src.stop(t0 + 1.3);
  }

  // 足音（タイルは硬い音、地上は柔らかい音）
  step(surface, run) {
    const ctx = this.ctx;
    if (!ctx) return;
    const src = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain(), t0 = ctx.currentTime;
    src.buffer = this.noiseBuf;
    src.playbackRate.value = 1.5 + Math.random() * 0.4;
    const hard = surface !== 'street';
    f.type = hard ? 'highpass' : 'lowpass';
    f.frequency.value = hard ? 1800 : 900;
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(hard ? 0.05 : 0.035, t0 + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + (run ? 0.07 : 0.09));
    src.connect(f).connect(g).connect(this.master);
    src.start(t0, Math.random());
    src.stop(t0 + 0.12);
  }

  // 改札を通る音
  beep() {
    const ctx = this.ctx;
    if (!ctx) return;
    const o = ctx.createOscillator(), g = ctx.createGain(), t0 = ctx.currentTime;
    o.type = 'sine';
    o.frequency.value = 1660;
    g.gain.setValueAtTime(0.08, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.25);
    o.connect(g).connect(this.master);
    o.start(t0);
    o.stop(t0 + 0.3);
  }

  // 車内・駅の放送（フランス語の声があれば）
  announce(text) {
    if (!this.speechOk || this.muted) return;
    try {
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'fr-FR';
      const fr = speechSynthesis.getVoices().find((v) => /^fr/i.test(v.lang));
      if (fr) u.voice = fr;
      u.rate = 0.95;
      u.volume = 0.8;
      speechSynthesis.cancel();
      speechSynthesis.speak(u);
    } catch {
      // 音声合成が使えなくても遊べる
    }
  }
}
