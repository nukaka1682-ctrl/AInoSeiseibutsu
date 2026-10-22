// 閘門（monuments.js の writeLock）の閘室の場所。
// 地形モデルでは閘室が浅い窪み（水面より 2〜3 m 高い）。地形の格子は 5 m なので掘り下げず、閘室の上の面のステンシルで
// 地面を切り抜き、中を壁と水で描く

// a → b: 閘室の芯線（川の側 → 運河の側）。width: 閘室の幅、from: a から閘室の下流の端までの距離（道路の橋の下を除く）
export const LOCKS = [
  // サン・ピエールの閘門（Écluse Saint-Pierre。利用者の写真 NCM_0185）: ブリエンヌ運河がガロンヌ川に出る所
  { id: 'ecluse-saint-pierre', kind: 'lock', a: [43.603883, 1.434135], b: [43.604107, 1.434265], width: 6.4, from: 6 },
];

// 閘室の局所の枠: at(u, v)、uv(x, z)、長さ L、u（芯線の向き）・v（横）
export function lockFrame(a, b) {
  const L = Math.hypot(b[0] - a[0], b[1] - a[1]), u = [(b[0] - a[0]) / L, (b[1] - a[1]) / L], v = [-u[1], u[0]];
  return {
    L, u, v,
    at: (du, dv) => [a[0] + u[0] * du + v[0] * dv, a[1] + u[1] * du + v[1] * dv],
    uv: (x, z) => [(x - a[0]) * u[0] + (z - a[1]) * u[1], (x - a[0]) * v[0] + (z - a[1]) * v[1]],
  };
}
