// 光の較正: 空のシェーダー（Sky）から作る環境マップの明るさを測り、影を落とす太陽・半球光・環境マップの
// 強さの割合をそろえる。霧の色も、画面に映る空の地平線の色に合わせる。
// Sky の放射輝度は正規化されていない（太陽の円盤は数千）ので、強さを決め打ちすると環境マップが太陽より強くなり、
// 影が消えてしまう。環境マップは太陽の円盤を抜いた空と地面だけにし、測った明るさから強さを決める。
// 数式の部分は DOM にも three.js にも依存しないので Node のテストからも使える。

// three.js の NeutralToneMapping（Khronos PBR Neutral）と同じ式。c: 線形の RGB。
// toe = false にすると、暗い所の黒の差し引き（最小の成分から最大 0.04 を引く）をしない（toneMap を参照）
export function neutralToneMap(c, exposure = 1, toe = true) {
  let [r, g, b] = c.map((v) => v * exposure);
  const x = Math.min(r, g, b);
  const offset = !toe ? 0 : x < 0.08 ? x - 6.25 * x * x : 0.04;
  r -= offset;
  g -= offset;
  b -= offset;
  const peak = Math.max(r, g, b);
  const start = 0.8 - 0.04;
  if (peak < start) return [r, g, b];
  const d = 1 - start;
  const newPeak = 1 - (d * d) / (peak + d - start);
  const k = newPeak / peak;
  const desat = 1 - 1 / (0.15 * (peak - newPeak) + 1);
  return [r, g, b].map((v) => v * k * (1 - desat) + newPeak * desat);
}

// ゲームのトーンマッピング: PBR Neutral の明るい所の圧縮だけを使う。Neutral の黒の差し引きは、日陰のレンガ
// （線形で 0.1 前後）の青と緑の成分を大きく削り、写真より暗く赤すぎる色にしてしまうので使わない
export const toneMap = (c, exposure = 1) => neutralToneMap(c, exposure, false);

// three.js の CustomToneMapping として使う GLSL（toneMap と同じ式）
export const TONE_MAPPING_GLSL = `vec3 CustomToneMapping( vec3 color ) {
  const float StartCompression = 0.8 - 0.04;
  const float Desaturation = 0.15;
  color *= toneMappingExposure;
  float peak = max( color.r, max( color.g, color.b ) );
  if ( peak < StartCompression ) return color;
  float d = 1. - StartCompression;
  float newPeak = 1. - d * d / ( peak + d - StartCompression );
  color *= newPeak / peak;
  float g = 1. - 1. / ( Desaturation * ( peak - newPeak ) + 1. );
  return mix( color, vec3( newPeak ), g );
}`;

export function linearToSrgb(v) {
  v = Math.min(1, Math.max(0, v));
  return v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
}

export const luminance = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

// 立方体の 6 面に描いた環境（各面 size×size、RGBA の線形の放射輝度。行は下から上）から:
//   up: 上向きの面が受ける光（余弦の重みを付けた平均の放射輝度。一様な空 L なら L）
//   side: 鉛直な壁が受ける光（4 方位の平均）
//   horizon: 地平線のすぐ上（仰角 0〜4°）の空の平均の色
// faces: [{ data, size, right, up, forward }]（right/up/forward は面の向きの単位ベクトル）
export function probeEnvironment(faces) {
  const up = [0, 0, 0], side = [0, 0, 0], hor = [0, 0, 0];
  let wHor = 0;
  const walls = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  for (const f of faces) {
    const S = f.size;
    for (let j = 0; j < S; j++) {
      for (let i = 0; i < S; i++) {
        const u = (2 * (i + 0.5)) / S - 1, v = (2 * (j + 0.5)) / S - 1;
        let dx = f.forward[0] + u * f.right[0] + v * f.up[0];
        let dy = f.forward[1] + u * f.right[1] + v * f.up[1];
        let dz = f.forward[2] + u * f.right[2] + v * f.up[2];
        const l = Math.hypot(dx, dy, dz);
        dx /= l;
        dy /= l;
        dz /= l;
        const dw = (4 / (S * S)) / Math.pow(1 + u * u + v * v, 1.5); // 画素の立体角
        const k = (j * S + i) * 4;
        const L = [f.data[k], f.data[k + 1], f.data[k + 2]];
        const cu = Math.max(0, dy) * dw;
        let cs = 0;
        for (const [wx, wz] of walls) cs += Math.max(0, dx * wx + dz * wz) * dw;
        for (let c = 0; c < 3; c++) {
          up[c] += (L[c] * cu) / Math.PI;
          side[c] += (L[c] * cs) / (4 * Math.PI);
        }
        if (dy >= 0 && dy < 0.07) {
          for (let c = 0; c < 3; c++) hor[c] += L[c] * dw;
          wHor += dw;
        }
      }
    }
  }
  return { up, side, horizon: hor.map((c) => c / (wHor || 1)) };
}

// 環境マップの強さ: 環境マップの拡散光（上向きの面）が、半球光の空の光の share 倍になるように。
// 半球光の拡散光は 色 × 強さ / π、環境マップは 強さ × 余弦平均の放射輝度（three.js の物理的な単位）
export function environmentIntensity(probeUp, hemiSkyColor, hemiIntensity, share) {
  const env = luminance(probeUp);
  if (!(env > 1e-4)) return null;
  return (share * luminance(hemiSkyColor) * hemiIntensity) / Math.PI / env;
}

// 画面に映る色（sRGB の 0〜1）: 線形の放射輝度をトーンマッピングしてから sRGB にする
export function displayColor(linear, exposure = 1) {
  return toneMap(linear, exposure).map(linearToSrgb);
}

// ---- 時間帯（朝・午後・夕暮れ・夜）の光のプリセット ----
// 午後（標準）は写真に合わせて較正した値（太陽 38°・南西、LIGHT、空、霧、露出 1.1）。ほかの時間帯はそこからの出発点。
//   sun: 太陽（夜は月）の高さ・方位（度。方位は北から時計回り）と色・強さ、hemi: 半球光（空 / 地面 / 強さ）、
//   sky: 空のシェーダー（Sky）の uniform、exposure: 露出、fogTint / fogMix: 霧の色を地平線の空の色からこの色へ寄せる割合、
//   night: 夜の割合（0〜1。空の星・窓と街灯の明かり）、water: 水面の映り込みの強さ、bloom: 光のにじみの閾値と強さ（フォトリアル）
const DAY_SKY = { turbidity: 3.5, rayleigh: 1.4, mieCoefficient: 0.004, mieDirectionalG: 0.82 };
const DAY_BLOOM = { threshold: 2.2, strength: 0.08 }; // メトロのゲームの地上（render.js の under = 0）と同じ
export const TIME_OF_DAY = {
  morning: {
    name: '朝', sun: { elevation: 22, azimuth: 105, color: '#ffeccf', intensity: 2.5 },
    hemi: { sky: '#cfdcf2', ground: '#a08c7c', intensity: 1.25 },
    sky: { ...DAY_SKY, turbidity: 3.0, rayleigh: 1.2 }, exposure: 1.1, fogTint: '#c2bcc0', fogMix: 0.35, night: 0, water: 0.16, bloom: DAY_BLOOM,
  },
  afternoon: {
    name: '午後', sun: { elevation: 38, azimuth: 225, color: '#fff0d8', intensity: 2.8 },
    hemi: { sky: '#cfdcef', ground: '#a48a76', intensity: 1.3 },
    sky: DAY_SKY, exposure: 1.1, fogTint: '#bdb5b2', fogMix: 0.35, night: 0, water: 0.16, bloom: DAY_BLOOM,
  },
  golden: {
    name: '夕暮れ', sun: { elevation: 8, azimuth: 278, color: '#ffb070', intensity: 2.6 },
    hemi: { sky: '#b6c0e0', ground: '#b48a6c', intensity: 0.9 },
    sky: { ...DAY_SKY, turbidity: 6, rayleigh: 2.4, mieCoefficient: 0.006 }, exposure: 1.15, fogTint: '#d8a890', fogMix: 0.45, night: 0, water: 0.9, bloom: DAY_BLOOM,
  },
  night: {
    name: '夜', sun: { elevation: 48, azimuth: 150, color: '#a9bde8', intensity: 0.45 },
    hemi: { sky: '#2c3a66', ground: '#6a4a34', intensity: 0.85 },
    sky: DAY_SKY, exposure: 1.0, fogTint: '#1c2440', fogMix: 0.8, night: 1, water: 0.16, bloom: { threshold: 0.9, strength: 0.3 },
  },
};
export const TIME_ORDER = ['morning', 'afternoon', 'golden', 'night'];

// 太陽の高さ・方位（度）→ 太陽の方を向く単位ベクトル [x 東, y 上, z 南]。
// three.js の Vector3.setFromSphericalCoords(1, 90° − 高さ, 180° − 方位) と同じ式・同じ順の計算（午後の向きが今と 1 ビットも変わらないように）
export function sunDirection(elevation, azimuth) {
  const D = Math.PI / 180;
  const phi = (90 - elevation) * D, theta = (180 - azimuth) * D;
  const s = Math.sin(phi);
  return [s * Math.sin(theta), Math.cos(phi), s * Math.cos(theta)];
}

// 太陽の影の箱: 低い太陽（夕暮れ）は光の向きの奥行きが長く、地面にかすめる角度で当たるので影の縞が出やすい。
// 太陽の位置までの距離（箱の中心から）と、法線方向のずらしの倍率を太陽の高さで決める（30° 以上は午後と同じ 600 m・1 倍）
export function shadowLook(elevation) {
  if (elevation >= 30) return { dist: 600, normalBias: 1 };
  // 影の箱の縦（±half）は地面では ±half / sin(高さ) に伸び、光の向きの奥行きは ±half / tan(高さ)（8° で half の 7 倍）。
  // 奥行きを倍の ±1200 m にする（それより遠い所は霧の中）。ずらしは、地面にかすめる角度の分だけ大きく（最大 3 倍）
  const s = Math.sin((Math.max(elevation, 4) * Math.PI) / 180);
  return { dist: 1200, normalBias: Math.min(3, Math.sin((38 * Math.PI) / 180) / s) };
}
