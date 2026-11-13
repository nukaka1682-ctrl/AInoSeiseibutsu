// 効果音（WebAudio で合成）: 自転車のベル、風切り音、ラチェット音、衝突音、
// 路面の音・ブレーキ・チェーン（① 自転車の音）と、街の音の層・鐘・出来事の音（soundscape.js）、音量。
import { BELL_OFFSET, BELL_PERIOD, ambientMix, bellDistance, bellTimes, panFor, surfaceSound } from './audiologic.js';
import { Soundscape } from './soundscape.js';

// 鐘を鳴らす教会の名所（並びの番号で鳴る時刻を 20 秒ずつずらす）と基音（Hz。教会ごとに違う）
export const CHURCHES = [['saint-sernin', 220], ['jacobins', 262], ['saint-etienne', 247], ['daurade', 330]];
const BELL_RANGE = 400; // この距離（m）より近いときだけ鳴らす
const SURFACES = ['road', 'paving', 'gravel', 'grass'];
const MEDAL_NOTES = { gold: 4, silver: 3, bronze: 2 };
// 路面ごとのフィルターの帯域の補い（ノイズはフィルターの帯域が狭いほど小さくなる。ローパス 220 Hz の石畳は
// そのままだと広い帯のアスファルトより小さく聞こえるので、surfaceSound の gain が同じなら同じくらいの大きさになるように）。
// 帯域 B Hz のとき およそ 0.5 × √(22050 / B)
const SURFACE_MAKEUP = { road: 1.9, paving: 4.5, gravel: 0.55, grass: 2.6 };

export class AudioFx {
  constructor() {
    this.ctx = null;
    this.muted = false;
    this.volume = 0.7; // 音量（0〜1。ポーズ画面のスライダー）
    this.tickTimer = 0;
    this.lastCrank = null;
    this.bellIdx = null;
    this.bellFor = null;
    this._times = [];
  }

  // ctx: テストで OfflineAudioContext などを渡す。無ければ new AudioContext()
  init(ctx = null) {
    if (this.ctx) return;
    if (!ctx) {
      const AC = typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext);
      if (!AC) return;
      try {
        ctx = new AC();
      } catch {
        return; // 音を出せない環境でも遊べる
      }
    }
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : this.volume;
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
    this.initBike(ctx);
    this.scape = new Soundscape(ctx, this.master);
  }

  // ① 自転車の音（路面・ブレーキ・チェーン）の節点を 1 回だけ作る。強さだけを update で変える
  initBike(ctx) {
    const loop = (offset) => {
      const s = ctx.createBufferSource();
      s.buffer = this.noise;
      s.loop = true;
      s.start(0, offset);
      return s;
    };
    // 不規則な粒の揺れ（ノイズ → ローパス 30 Hz）。砂利・芝の振幅を揺らす
    const grainF = ctx.createBiquadFilter();
    grainF.type = 'lowpass';
    grainF.frequency.value = 30;
    loop(1.1).connect(grainF);
    // 路面ごとに ノイズ → フィルター → 揺れ（am）→ 強さ（gain）→ master
    this.surf = {};
    for (const kind of SURFACES) {
      const p = surfaceSound(kind, 8);
      const f = ctx.createBiquadFilter();
      f.type = p.filter;
      f.frequency.value = p.freq;
      f.Q.value = p.q;
      const am = ctx.createGain();
      am.gain.value = 1;
      const makeup = ctx.createGain();
      makeup.gain.value = SURFACE_MAKEUP[kind];
      const g = ctx.createGain();
      g.gain.value = 0;
      loop(0.2 + SURFACES.indexOf(kind) * 0.4).connect(f).connect(makeup).connect(am).connect(g).connect(this.master);
      const s = { filter: f, am, gain: g, last: -1, lastFreq: -1, lastRumble: -1 };
      if (kind === 'paving') {
        // 石の継ぎ目の周期の振幅の揺れ（0.1〜1.0）
        am.gain.value = 0.55;
        s.lfo = ctx.createOscillator();
        s.lfo.frequency.value = 10;
        const depth = ctx.createGain();
        depth.gain.value = 0.45;
        s.lfo.connect(depth).connect(am.gain);
        s.lfo.start();
      } else if (p.grain > 0) {
        am.gain.value = 0.6;
        const depth = ctx.createGain();
        depth.gain.value = 18 * p.grain;
        grainF.connect(depth).connect(am.gain);
      }
      this.surf[kind] = s;
    }
    // ブレーキ: かすかな「キー」（2050 Hz と 2110 Hz の正弦波）
    this.brakeGain = ctx.createGain();
    this.brakeGain.gain.value = 0;
    this.brakeGain.connect(this.master);
    for (const f of [2050, 2110]) {
      const o = ctx.createOscillator();
      o.frequency.value = f;
      o.connect(this.brakeGain);
      o.start();
    }
    this.brakeLast = 0;
    // チェーン: こいでいるとき、クランクの回転に合わせたごく小さな周期音（ノイズ → ハイパス に のこぎり波の振幅）
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 3000;
    this.chainAm = ctx.createGain();
    this.chainAm.gain.value = 0;
    loop(1.7).connect(hp).connect(this.chainAm).connect(this.master);
    this.chainOsc = ctx.createOscillator();
    this.chainOsc.type = 'sawtooth';
    this.chainOsc.frequency.value = 4;
    this.chainDepth = ctx.createGain();
    this.chainDepth.gain.value = 0;
    this.chainOsc.connect(this.chainDepth).connect(this.chainAm.gain);
    this.chainOsc.start();
    this.chainLast = 0;
  }

  resume() {
    try {
      this.ctx?.resume?.()?.catch?.(() => {});
    } catch {
      // 自動再生の制限で始められなくても続ける
    }
  }

  setMuted(m) {
    this.muted = m;
    if (this.master) this.master.gain.value = m ? 0 : this.volume;
  }

  // 音量（0〜1）
  setVolume(v) {
    this.volume = Math.max(0, Math.min(1, +v || 0));
    if (this.master && !this.muted) this.master.gain.value = this.volume;
  }

  // 音量と消音を保存・復元する（store: { get(k, d), set(k, v) }。キーは tav-audio、音量は 0〜100）
  restorePrefs(store) {
    const p = store.get('tav-audio', null) || {};
    this.setVolume(Number.isFinite(+p.volume) && p.volume != null ? +p.volume / 100 : 0.7);
    this.setMuted(!!p.muted);
  }

  savePrefs(store) {
    store.set('tav-audio', { volume: Math.round(this.volume * 100), muted: this.muted });
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

  // スミレを集めた: 高い澄んだ 2 音（1320 Hz → 1760 Hz、0.25 秒）
  collect() {
    const ctx = this.ctx;
    if (!ctx) return;
    [1320, 1760].forEach((f, i) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      const t = ctx.currentTime + i * 0.09;
      o.type = 'sine';
      o.frequency.value = f;
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.16, t + 0.005);
      g.gain.exponentialRampToValueAtTime(0.0001, t + (i ? 0.16 : 0.12));
      o.connect(g).connect(this.master);
      o.start(t);
      o.stop(t + 0.2);
    });
  }

  // タイムアタックのゴール: メダルに応じた短いファンファーレ（メダルなしは今のチャイム）
  fanfare(medal) {
    if (!this.ctx) return;
    if (!MEDAL_NOTES[medal]) return this.chime();
    this.scape.play('fanfare', { notes: MEDAL_NOTES[medal] });
  }

  // 画面のボタン・地図・手帳・ポーズを開く / 閉じる: ごく小さな「コッ」
  ui() {
    this.scape?.play('ui', { gain: 0.06 });
  }

  // 写真モードの保存: シャッター音
  shutter() {
    this.scape?.play('shutter', { gain: 0.25 });
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

  // info: { speed, coasting, braking, pedaling, surface, crank }。古い呼び方 update(dt, speed, coasting) も受ける
  update(dt, info, coasting) {
    if (!this.ctx) return;
    const o = typeof info === 'object' && info ? info : { speed: info, coasting };
    const s = Math.abs(o.speed || 0);
    const now = this.ctx.currentTime;
    this.windGain.gain.setTargetAtTime(Math.min(0.35, (s / 12) ** 2 * 0.35), now, 0.1);
    this.windFilter.frequency.setTargetAtTime(300 + s * 60, now, 0.1);
    // こがずに走っているときのラチェット音
    const coast = o.coasting ?? (o.pedaling === undefined ? false : !o.pedaling);
    if (coast && s > 0.8) {
      this.tickTimer -= dt;
      if (this.tickTimer <= 0) {
        this.tick();
        this.tickTimer = 0.9 / (s * 3);
      }
    }
    if (!this.surf) return;
    // 路面の音（路面が変わるときは 0.15 秒で入れ替える。変わったときだけ自動化の点を足す）
    const kind = o.surface && this.surf[o.surface] ? o.surface : 'road';
    for (const k of SURFACES) {
      const sv = this.surf[k];
      const p = k === kind ? surfaceSound(k, s) : null;
      const g = p ? p.gain : 0;
      if (Math.abs(g - sv.last) > 0.002) {
        sv.gain.gain.setTargetAtTime(g, now, 0.05);
        sv.last = g;
      }
      if (!p) continue;
      if (Math.abs(p.freq - sv.lastFreq) > 20) {
        sv.filter.frequency.setTargetAtTime(p.freq, now, 0.1);
        sv.lastFreq = p.freq;
      }
      if (sv.lfo && p.rumble > 0 && Math.abs(p.rumble - sv.lastRumble) > 0.5) {
        sv.lfo.frequency.setTargetAtTime(p.rumble, now, 0.1);
        sv.lastRumble = p.rumble;
      }
    }
    // ブレーキの「キー」: ブレーキ中で 3 m/s 以上。強さは速さに比例（最大 0.035）。0.1 秒で立ち上がり・消える
    const bk = o.braking && s >= 3 ? Math.min(0.035, (s / 10) * 0.035) : 0;
    if (Math.abs(bk - this.brakeLast) > 0.001) {
      this.brakeGain.gain.setTargetAtTime(bk, now, 0.033);
      this.brakeLast = bk;
    }
    // チェーン: クランクの回転の速さ（回/秒）× 4 の周期
    let rate = 0;
    if (Number.isFinite(o.crank)) {
      if (this.lastCrank != null && dt > 0) rate = Math.max(0, o.crank - this.lastCrank) / dt / (2 * Math.PI);
      this.lastCrank = o.crank;
    }
    const ch = o.pedaling && rate > 0.1 ? 0.004 : 0;
    if (Math.abs(ch - this.chainLast) > 0.0005) {
      this.chainAm.gain.setTargetAtTime(ch, now, 0.05);
      this.chainDepth.gain.setTargetAtTime(-ch, now, 0.05);
      this.chainLast = ch;
    }
    if (ch) this.chainOsc.frequency.setTargetAtTime(Math.min(40, rate * 4), now, 0.1);
    this.scape.update(dt);
  }

  // 街の音の層の強さ（0.5 秒ごと。info は ambientinfo.js の ambientInfo の返り値）
  setAmbient(info, immediate = false) {
    if (!this.scape) return;
    this.scape.setMix(ambientMix(info), immediate);
    const tr = info?.tram;
    if (tr && Number.isFinite(tr.dx)) this.scape.setTramPan(panFor(tr.dx, tr.dz, info.heading || 0));
  }

  // 出来事の音（world.life.events・world.traffic.events）。ev.x / ev.z があればその向きから
  event(ev, bike = null) {
    if (!this.scape || !ev) return;
    let pan = 0, near = 1;
    if (bike && Number.isFinite(ev.x) && Number.isFinite(ev.z)) {
      const dx = ev.x - bike.x, dz = ev.z - bike.z;
      pan = panFor(dx, dz, bike.heading || 0);
      near = 1 / (1 + Math.hypot(dx, dz) / 30);
    }
    if (ev.type === 'person') this.scape.play('thud', { gain: 0.3 });
    else if (ev.type === 'pigeons') this.scape.play('pigeons', { gain: 0.12, pan });
    else if (ev.type === 'tram-bell') this.scape.play('tram-bell', { gain: 0.16 * near, pan });
    else if (ev.type === 'bike-bell') this.scape.play('bike-bell', { gain: 0.18 * near, pan });
    // tram-pass: 近くのトラムの走行音は setAmbient（world.traffic.nearestTram）で鳴らす。無ければ鳴らさない
  }

  // 教会の鐘: 400 m 以内の教会が、遊んだ時間で 75 秒ごとに 3 回（1.8 秒おき）鳴る
  bells(landmarks, bike, playTime, dt) {
    if (!this.scape || !landmarks || !bike) return;
    if (this.bellFor !== landmarks) {
      this.bellFor = landmarks;
      this.bellIdx = CHURCHES.map(([id, freq], i) => ({ i, freq, lm: landmarks.find((l) => l.id === id) })).filter((c) => c.lm);
    }
    for (const c of this.bellIdx) {
      const dx = c.lm.x - bike.x, dz = c.lm.z - bike.z;
      const d = Math.hypot(dx, dz);
      if (d > BELL_RANGE) continue;
      const times = bellTimes(c.i, playTime - dt, playTime, this._times);
      if (!times.length) continue;
      const { gain, lowpass } = bellDistance(d);
      const pan = panFor(dx, dz, bike.heading || 0);
      for (const t of times) this.scape.play('church-bell', { freq: c.freq, gain: 0.35 * gain, lowpass, pan, when: this.ctx.currentTime + (t - playTime) });
    }
  }
}

// ---------------------------------------------------------------- 音の確認（test/audio-check.mjs から）
// scene の音を OfflineAudioContext（2 ch・44.1 kHz）で duration 秒描き、左右の RMS・最大の振幅・NaN の有無を返す。
// scene: { duration, bike: { speed, surface, braking, pedaling }, ambient: ambientInfo の形, bells: { id, d },
//          shots: [{ at, name: 'bell'|'chime'|'collect'|'ui'|'shutter'|'fanfare'|'event', arg }] }
export async function audioTest(scene = {}) {
  const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  const rate = 44100, dur = scene.duration || 3;
  const ctx = new OAC(2, Math.round(rate * dur), rate);
  const fx = new AudioFx();
  fx.init(ctx);
  const bk = { x: 0, z: 0, heading: 0, crank: 0, ...(scene.bike || {}) };
  if (scene.ambient) fx.setAmbient({ heading: 0, ...scene.ambient }, true);
  const lms = scene.bells ? [{ id: scene.bells.id, x: scene.bells.d ?? 100, z: 0 }] : null;
  const step = (128 * 12) / rate; // 更新の間隔（描く単位 128 サンプルの倍数）
  // 鐘の場面は、その教会の 1 回目の鳴り始めの 0.5 秒前から描く
  const ci = scene.bells ? Math.max(0, CHURCHES.findIndex(([id]) => id === scene.bells.id)) : 0;
  let playTime = scene.bells ? ((ci * BELL_OFFSET) % BELL_PERIOD) + BELL_PERIOD - 0.5 : 0;
  const shots = (scene.shots || []).slice().sort((a, b) => (a.at || 0) - (b.at || 0));
  const tick = (t) => {
    const dt = step;
    playTime += dt;
    if (bk.pedaling) bk.crank += (Math.max(bk.speed || 0, 1.2) / 0.34 / 2.6) * dt;
    fx.update(dt, { speed: bk.speed || 0, coasting: !bk.pedaling, braking: !!bk.braking, pedaling: !!bk.pedaling, surface: bk.surface || 'road', crank: bk.crank });
    if (lms) fx.bells(lms, bk, playTime, dt);
    while (shots.length && (shots[0].at || 0) <= t) {
      const s = shots.shift();
      if (s.name === 'event') fx.event(s.arg, bk);
      else fx[s.name]?.(s.arg);
    }
  };
  for (let t = step; t < dur - step; t += step) {
    ctx.suspend(t).then(() => {
      tick(t);
      ctx.resume();
    });
  }
  tick(0);
  const buf = await ctx.startRendering();
  const rms = [], peakCh = [];
  let nan = false;
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    let sum = 0, pk = 0;
    for (let i = 0; i < d.length; i++) {
      const v = d[i];
      if (!Number.isFinite(v)) {
        nan = true;
        continue;
      }
      sum += v * v;
      if (Math.abs(v) > pk) pk = Math.abs(v);
    }
    rms.push(Math.sqrt(sum / d.length));
    peakCh.push(pk);
  }
  return { rms, peak: Math.max(...peakCh), nan };
}
