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
