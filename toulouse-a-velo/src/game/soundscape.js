// 街の音の層（WebAudio で合成。音声ファイルは使わない）。
// 続く音（ざわめき・水・堰・人の声・トラム）は始めに 1 回だけ節点を作り、強さだけを変える。
// 間をおいて鳴る音（鳥・虫・遠くの車・食器）と単発の音（play）は、鳴るたびに作って鳴り終わったら切り離す。
import { mulberry32 } from '../geo.js';

// 層の最大の大きさ（止まって聞いたときに、自転車の音〔風・路面〕より小さくなるように 0.05〜0.12）
export const LAYER_MAX = { city: 0.08, birds: 0.1, crickets: 0.05, water: 0.12, weir: 0.1, crowd: 0.09, tram: 0.12 };
const FADE = 0.33; // 層の強さの移り（setTargetAtTime の時定数。約 1 秒でほぼ移り終わる）

// ノイズ（2 秒・モノラル）。種を決めて作る（同じ音になるように）
export function makeNoise(ctx, seed = 7) {
  const rnd = mulberry32(seed);
  const len = Math.floor(ctx.sampleRate * 2);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = rnd() * 2 - 1;
  return buf;
}

export class Soundscape {
  // ctx: BaseAudioContext、destination: つなぐ先（AudioFx の master）、noise: ノイズの AudioBuffer（無ければ作る）
  constructor(ctx, destination, noise = null) {
    this.ctx = ctx;
    this.dest = destination;
    this.noise = noise || makeNoise(ctx);
    this.rnd = mulberry32(41);
    this.mix = { city: 0, birds: 0, crickets: 0, water: 0, weir: 0, crowd: 0, tram: 0 };
    this.started = false;
    // 間をおいて鳴る音のタイマー（秒）
    this.timers = { car: 4, birds: 1, crickets: 0.3, clink: 2, crowd: 0 };
    this.layers = {};
    const loop = (offset) => {
      const s = ctx.createBufferSource();
      s.buffer = this.noise;
      s.loop = true;
      s.start(0, offset);
      return s;
    };
    const filter = (type, freq, q = 0.7) => {
      const f = ctx.createBiquadFilter();
      f.type = type;
      f.frequency.value = freq;
      f.Q.value = q;
      return f;
    };
    const layer = (name) => {
      const g = ctx.createGain();
      g.gain.value = 0;
      g.connect(destination);
      this.layers[name] = g;
      return g;
    };
    // 街のざわめき: ごく低いノイズ（ローパス 160 Hz）
    loop(0.1).connect(filter('lowpass', 160)).connect(layer('city'));
    // 水: やわらかい広い帯のノイズ（バンドパス 700 Hz・Q 0.4）に、ゆっくりした揺れ（0.13 Hz・0.31 Hz）
    const waterMod = ctx.createGain();
    waterMod.gain.value = 0.75;
    for (const [f, a] of [[0.13, 0.15], [0.31, 0.1]]) {
      const o = ctx.createOscillator();
      o.frequency.value = f;
      const g = ctx.createGain();
      g.gain.value = a;
      o.connect(g).connect(waterMod.gain);
      o.start();
    }
    loop(0.7).connect(filter('bandpass', 700, 0.4)).connect(waterMod).connect(layer('water'));
    // 堰の低い轟き（バザクル）
    loop(1.3).connect(filter('lowpass', 110)).connect(layer('weir'));
    // 人の声: 300〜900 Hz のバンドパス 3 本。それぞれ別のゆっくりした不規則な揺れ（update で揺らす）
    const crowd = layer('crowd');
    this.voices = [300, 520, 880].map((f, i) => {
      const g = ctx.createGain();
      g.gain.value = 0.5;
      loop(0.37 * (i + 1)).connect(filter('bandpass', f, 1.6)).connect(g).connect(crowd);
      return g;
    });
    // 近くのトラムの走行音: 低いノイズ + 低いうなり（70 Hz）。トラムの向きへ左右に寄せる
    this.tramPan = this.panner(0);
    const tram = ctx.createGain();
    tram.gain.value = 0;
    this.layers.tram = tram;
    if (this.tramPan) tram.connect(this.tramPan).connect(destination);
    else tram.connect(destination);
    loop(0.9).connect(filter('lowpass', 180)).connect(tram);
    const hum = ctx.createOscillator();
    hum.type = 'sawtooth';
    hum.frequency.value = 70;
    const humG = ctx.createGain();
    humG.gain.value = 0.25;
    hum.connect(filter('lowpass', 200)).connect(humG).connect(tram);
    hum.start();
  }

  panner(pan) {
    if (!this.ctx.createStereoPanner) return null;
    const p = this.ctx.createStereoPanner();
    p.pan.value = Math.max(-1, Math.min(1, pan || 0));
    return p;
  }

  // 層の強さ（ambientMix の返り値）を決める。immediate なら移らずにすぐ
  setMix(mix, immediate = false) {
    const now = this.ctx.currentTime;
    for (const k of Object.keys(this.mix)) {
      const v = Math.max(0, Math.min(1, +mix?.[k] || 0));
      this.mix[k] = v;
      const g = this.layers[k];
      if (!g) continue; // 鳥・虫は間をおいて鳴らす音（強さは鳴らすときに掛ける）
      if (immediate || !this.started) g.gain.setValueAtTime(v * LAYER_MAX[k], now);
      else g.gain.setTargetAtTime(v * LAYER_MAX[k], now, FADE);
    }
    this.started = true;
  }

  setTramPan(pan) {
    if (this.tramPan) this.tramPan.pan.setTargetAtTime(Math.max(-1, Math.min(1, pan || 0)), this.ctx.currentTime, 0.2);
  }

  // dt 秒ぶん進める（mix を渡せば強さも変える）。間をおいて鳴る音を鳴らす
  update(dt, mix = null) {
    if (mix) this.setMix(mix);
    const m = this.mix, T = this.timers, r = this.rnd;
    // 人の声の揺れ（0.25 秒ごとに、3 本それぞれ別の強さへ）
    if ((T.crowd -= dt) <= 0) {
      T.crowd = 0.25;
      if (m.crowd > 0.01) for (const g of this.voices) g.gain.setTargetAtTime(0.2 + r() * 0.8, this.ctx.currentTime, 0.12);
    }
    // 遠くの車の通る音（8〜20 秒に 1 回）
    if ((T.car -= dt) <= 0) {
      T.car = 8 + r() * 12;
      if (m.city > 0.05) this.play('car', { gain: m.city * LAYER_MAX.city * 1.2, pan: r() < 0.5 ? -1 : 1 });
    }
    // 鳥のさえずり（1.5〜6 秒に 1 回、左右に散らす）
    if ((T.birds -= dt) <= 0) {
      T.birds = 1.5 + r() * 4.5;
      if (m.birds > 0.02) this.play('chirp', { gain: m.birds * LAYER_MAX.birds, pan: r() * 1.6 - 0.8 });
    }
    // 虫（0.9 秒ごと）
    if ((T.crickets -= dt) <= 0) {
      T.crickets = 0.9;
      if (m.crickets > 0.02) this.play('crickets', { gain: m.crickets * LAYER_MAX.crickets, pan: r() * 1.2 - 0.6 });
    }
    // テラスの食器の「カチン」（人が多いほどよく鳴る）
    if ((T.clink -= dt) <= 0) {
      T.clink = (1.2 + r() * 4) / Math.max(0.3, m.crowd);
      if (m.crowd > 0.2) this.play('clink', { gain: m.crowd * 0.05, pan: r() * 1.4 - 0.7 });
    }
  }

  // ---------------------------------------------------------------- 単発の音
  // name: 下の SOUNDS の名前。opts: { gain, pan（−1〜1）, when（ctx の時刻）, freq, lowpass, dest（つなぐ先。無ければ destination）} ほか
  play(name, opts = {}) {
    const fn = SOUNDS[name];
    if (!fn) return;
    const ctx = this.ctx;
    const when = Math.max(ctx.currentTime, opts.when ?? ctx.currentTime);
    const out = ctx.createGain();
    out.gain.value = opts.gain ?? 1;
    const pan = this.panner(opts.pan);
    const dest = opts.dest || this.dest;
    if (pan) out.connect(pan).connect(dest);
    else out.connect(dest);
    const end = fn(this, out, when, opts);
    // 鳴り終わったら切り離す（終わりの時刻に鳴らす無音の目印で知る）
    const mark = ctx.createConstantSource ? ctx.createConstantSource() : ctx.createOscillator();
    const z = ctx.createGain();
    z.gain.value = 0;
    mark.connect(z).connect(out);
    mark.onended = () => {
      z.disconnect();
      out.disconnect();
      pan?.disconnect();
    };
    mark.start(when);
    mark.stop(end + 0.05);
  }

  // ノイズの一部を鳴らす（src → [filter] → env → out）。env を返す
  noiseBurst(out, t, dur, filterType, freq, q = 0.7) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = filterType;
    f.frequency.value = freq;
    f.Q.value = q;
    const env = ctx.createGain();
    env.gain.value = 0;
    src.connect(f).connect(env).connect(out);
    src.start(t, this.rnd() * 1.5);
    src.stop(t + dur + 0.02);
    src.onended = () => src.disconnect();
    return { env, filter: f, src };
  }

  // 正弦波などの音（打って減る）。osc → env → out
  tone(out, t, freq, peak, decay, type = 'sine', attack = 0.004) {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(peak, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
    o.connect(g).connect(out);
    o.start(t);
    o.stop(t + attack + decay + 0.02);
    o.onended = () => {
      o.disconnect();
      g.disconnect();
    };
    return o;
  }
}

// 単発の音の作り方。(soundscape, out, 始まりの時刻, opts) → 終わりの時刻
const SOUNDS = {
  // 鳥のさえずり: 2.5〜5 kHz の短い上がり下がりを 2〜5 個つなぐ
  chirp(s, out, t) {
    const r = s.rnd, n = 2 + Math.floor(r() * 4);
    let at = t;
    for (let i = 0; i < n; i++) {
      const f0 = 2500 + r() * 2500, dur = 0.05 + r() * 0.05;
      const o = s.tone(out, at, f0, 0.8, dur);
      o.frequency.setValueAtTime(f0, at);
      o.frequency.linearRampToValueAtTime(Math.min(5000, f0 * (1.15 + r() * 0.2)), at + dur * 0.5);
      o.frequency.linearRampToValueAtTime(f0 * 0.9, at + dur);
      at += dur + 0.03 + r() * 0.05;
    }
    return at;
  },
  // 虫: 4.3 kHz の短い音の連なり（周期 0.06 秒 × 4〜6 回）
  crickets(s, out, t) {
    const ctx = s.ctx, n = 4 + Math.floor(s.rnd() * 3);
    const o = ctx.createOscillator();
    o.frequency.value = 4300;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    for (let i = 0; i < n; i++) {
      const a = t + i * 0.06;
      g.gain.setValueAtTime(0, a);
      g.gain.linearRampToValueAtTime(0.8, a + 0.008);
      g.gain.linearRampToValueAtTime(0, a + 0.035);
    }
    o.connect(g).connect(out);
    o.start(t);
    o.stop(t + n * 0.06 + 0.02);
    o.onended = () => {
      o.disconnect();
      g.disconnect();
    };
    return t + n * 0.06;
  },
  // 遠くの車: ゆっくり上がって下がるバンドパスのノイズ（5 秒）。片側から反対側へ流れる
  car(s, out, t, opts) {
    const dur = 5;
    const { env, filter } = s.noiseBurst(out, t, dur, 'bandpass', 350, 1.2);
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(1, t + dur * 0.5);
    env.gain.linearRampToValueAtTime(0, t + dur);
    filter.frequency.setValueAtTime(350, t);
    filter.frequency.linearRampToValueAtTime(700, t + dur * 0.5);
    filter.frequency.linearRampToValueAtTime(380, t + dur);
    return t + dur;
  },
  // テラスの食器の「カチン」
  clink(s, out, t) {
    const f = 3000 + s.rnd() * 1500;
    s.tone(out, t, f, 0.7, 0.12);
    s.tone(out, t, f * 2.4, 0.25, 0.06);
    return t + 0.15;
  },
  // ハトの羽ばたき: 短いノイズの破裂を 12 Hz で 0.9 秒、だんだん小さく・高く
  pigeons(s, out, t) {
    const dur = 0.9;
    const { env, filter } = s.noiseBurst(out, t, dur, 'bandpass', 900, 1.1);
    const n = Math.floor(dur * 12);
    for (let i = 0; i < n; i++) {
      const a = t + i / 12, k = 1 - i / n;
      env.gain.setValueAtTime(0, a);
      env.gain.linearRampToValueAtTime(k, a + 0.012);
      env.gain.linearRampToValueAtTime(0, a + 0.05);
    }
    filter.frequency.setValueAtTime(900, t);
    filter.frequency.linearRampToValueAtTime(2200, t + dur);
    return t + dur;
  },
  // 人にぶつかった: やわらかい「トン」（低い短い音）
  thud(s, out, t) {
    const o = s.tone(out, t, 120, 1, 0.16);
    o.frequency.setValueAtTime(120, t);
    o.frequency.exponentialRampToValueAtTime(65, t + 0.15);
    return t + 0.18;
  },
  // トラムの鐘: 「カーン、カーン」。880 Hz と 1320 Hz（と少しの金属的な部分音）の 2 打、0.35 秒おき
  'tram-bell'(s, out, t) {
    for (const a of [t, t + 0.35]) {
      s.tone(out, a, 880, 0.55, 0.9, 'sine', 0.003);
      s.tone(out, a, 1320, 0.35, 0.7, 'sine', 0.003);
      s.tone(out, a, 2437, 0.12, 0.25, 'sine', 0.003);
    }
    return t + 1.3;
  },
  // ほかの自転車のベル: 自分のベル（2200 Hz）より少し低い「チリン」
  'bike-bell'(s, out, t) {
    for (const a of [t, t + 0.16]) {
      s.tone(out, a, 1850, 0.5, 0.7, 'sine', 0.005);
      s.tone(out, a, 2960, 0.24, 0.5, 'sine', 0.005);
      s.tone(out, a, 4290, 0.1, 0.3, 'sine', 0.005);
    }
    return t + 0.9;
  },
  // 教会の鐘（1 打）: 基音 freq に倍音でない部分音を重ねる。高い部分音ほど早く消える（打ってすぐは明るい）。
  // opts.lowpass: 遠いほどこもる
  'church-bell'(s, out, t, opts) {
    const ctx = s.ctx, f0 = opts.freq || 262;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = opts.lowpass || 8000;
    lp.connect(out);
    const parts = [[1, 0.5, 5.5], [2.0, 0.3, 4.5], [2.76, 0.22, 3], [3.2, 0.16, 2.2], [4.1, 0.12, 1.4], [5.4, 0.08, 0.9]];
    let end = t;
    for (const [m, a, d] of parts) {
      s.tone(lp, t, f0 * m, a, d, 'sine', 0.003);
      end = Math.max(end, t + d);
    }
    return end;
  },
  // メダルのファンファーレ（金: 4 音の上がるアルペジオ、銀: 3 音、銅: 2 音）
  fanfare(s, out, t, opts) {
    const notes = [523.25, 659.25, 783.99, 1046.5].slice(0, opts.notes || 4);
    notes.forEach((f, i) => {
      const last = i === notes.length - 1;
      s.tone(out, t + i * 0.13, f, 0.32, last ? 0.9 : 0.25, 'triangle', 0.01);
      if (last) s.tone(out, t + i * 0.13, f * 1.5, 0.12, 0.8, 'triangle', 0.01);
    });
    return t + notes.length * 0.13 + 0.9;
  },
  // 写真のシャッター: 短いノイズ 2 つ
  shutter(s, out, t) {
    for (const [a, k] of [[t, 1], [t + 0.07, 0.7]]) {
      const { env } = s.noiseBurst(out, a, 0.03, 'highpass', 2000);
      env.gain.setValueAtTime(k, a);
      env.gain.exponentialRampToValueAtTime(0.001, a + 0.025);
    }
    return t + 0.12;
  },
  // 画面を開く・閉じる: ごく小さな「コッ」
  ui(s, out, t) {
    const o = s.tone(out, t, 1100, 1, 0.045, 'sine', 0.002);
    o.frequency.setValueAtTime(1100, t);
    o.frequency.exponentialRampToValueAtTime(700, t + 0.04);
    return t + 0.06;
  },
};
