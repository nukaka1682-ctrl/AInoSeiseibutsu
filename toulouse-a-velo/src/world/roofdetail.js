// 屋根の細部: 軒の génoise（漆喰の中に丸瓦の端を 2〜3 段、段ごとに外へ迫り出して並べた南仏の軒）と小さな軒の出、
// 煙突、棟・隅棟の棟瓦。トゥールーズの旧市街・フォーブールのレンガ・漆喰の家（roofs-*.jpg, residential-*.jpg）を手本にする。
// 置き場所の計算（純粋な関数: テストできる）と、MeshWriter への書き込みを分ける。three.js には依存しない
import { hash01, mulberry32 } from '../geo.js';

// génoise の寸法（m）: 1 段の高さ、1 段ごとの迫り出し、いちばん外の段から先の瓦の出
export const GENOISE = { rowH: 0.09, step: 0.08, lip: 0.06 };

// ---------------------------------------------------------------- 置き場所（純粋な関数）

// 2 つの外向きの法線の留め継ぎ: それぞれの辺から 1 m 離れた線の交点へのずれ [x, z, c]。鋭い角では交点が遠くへ飛ぶので、
// ずれを同じ二等分線の上で長さ maxLen までに縮める（どちらの辺からも c m だけ離れた点になる: c = ずれ・法線 ≤ 1）。
// 縮めた点も、どちらの辺の屋根面を延ばした面にものる（高さ = −c × 距離 × 勾配）。ほぼ折り返す角は null
export function miterShift(o1, o2, maxLen = 2) {
  const sx = o1[0] + o2[0], sz = o1[1] + o2[1];
  const sl = Math.hypot(sx, sz);
  if (sl < 1e-3) return null;
  const k = 1 + o1[0] * o2[0] + o1[1] * o2[1];
  const len = Math.min(sl / k, maxLen);
  const mx = (sx / sl) * len, mz = (sz / sl) * len;
  return [mx, mz, mx * o1[0] + mz * o1[1]];
}

// 軒の génoise を並べる区間。ring: 外形 [[x, z]]、sign: 外向きの符号（buildings.js の outwardSign）、
// spans[i]: 辺 i（頂点 i → i+1）の軒を出せる区間 [[t0, t1]]（辺の始点からの距離。軒でない辺は null）。
// 隣どうしの辺がどちらも角まで軒なら、角で留め継ぎ（ずれの向き = 2 つの外向きの法線の二等分）にする。
// 返り値: [{ a, b, edge, u, o, ma, mb, s0, capA, capB }]
//   a, b: 区間の両端 [x, z]、edge: 辺の番号、u: 辺の向き、o: 外向きの法線、ma, mb: 両端を外へ 1 m 出したときのずれ [x, z]、
//   s0: 辺の始点からの距離（テクスチャの位置）、capA, capB: 端を小口でふさぐか（外形の角で留め継ぎでない端）。
//   ma, mb は [x, z, c]（c: 辺から外へ出る割合。鋭い角で縮めた留め継ぎは 1 未満）
export function eaveRuns(ring, sign, spans, minLen = 1.2) {
  const n = ring.length;
  const edge = (i) => {
    const a = ring[i], b = ring[(i + 1) % n];
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    const u = [(b[0] - a[0]) / L, (b[1] - a[1]) / L];
    return { a, L, u, o: [u[1] * sign, -u[0] * sign] };
  };
  // 辺 i の端（start: 始点側）が角まで軒か
  const reaches = (i, start) => {
    const s = spans[i];
    if (!s || !s.length) return false;
    const L = edge(i).L;
    return start ? s[0][0] < 0.05 && s[0][1] - s[0][0] >= minLen : s[s.length - 1][1] > L - 0.05 && s[s.length - 1][1] - s[s.length - 1][0] >= minLen;
  };
  // 2 つの外向きの法線の留め継ぎ（鋭い角は縮めた留め継ぎ: 軒の出の屋根の角と同じ）
  const miter = miterShift;
  const runs = [];
  for (let i = 0; i < n; i++) {
    const s = spans[i];
    if (!s) continue;
    const e = edge(i);
    for (let j = 0; j < s.length; j++) {
      const [t0, t1] = s[j];
      if (t1 - t0 < minLen) continue;
      let ma = null, mb = null;
      if (j === 0 && t0 < 0.05 && reaches((i - 1 + n) % n, false)) ma = miter(edge((i - 1 + n) % n).o, e.o);
      if (j === s.length - 1 && t1 > e.L - 0.05 && reaches((i + 1) % n, true)) mb = miter(e.o, edge((i + 1) % n).o);
      // 小口は外形の角（切妻の端・境の壁の角）だけ。隣の家で途中で切れた端は、隣の屋根の陰でほとんど見えないので省く
      runs.push({
        a: [e.a[0] + e.u[0] * t0, e.a[1] + e.u[1] * t0],
        b: [e.a[0] + e.u[0] * t1, e.a[1] + e.u[1] * t1],
        edge: i, u: e.u, o: e.o, ma: ma || [e.o[0], e.o[1], 1], mb: mb || [e.o[0], e.o[1], 1], s0: t0,
        capA: !ma && t0 < 0.05, capB: !mb && t1 > e.L - 0.05,
      });
    }
  }
  return runs;
}

// 屋根の三角形（[x, y, z] × 3 を並べたもの。複数の配列を渡せる）の、点 (x, z) の真上の高さ。屋根の外なら null
export function roofHeightAt(arrays, x, z) {
  let best = null;
  for (const T of arrays) {
    for (let i = 0; i < T.length; i += 9) {
      const ax = T[i], az = T[i + 2], bx = T[i + 3], bz = T[i + 5], cx = T[i + 6], cz = T[i + 8];
      const d = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
      if (Math.abs(d) < 1e-12) continue;
      const l1 = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / d;
      const l2 = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / d;
      const l3 = 1 - l1 - l2;
      if (l1 < -1e-6 || l2 < -1e-6 || l3 < -1e-6) continue;
      const y = l1 * T[i + 1] + l2 * T[i + 4] + l3 * T[i + 7];
      if (best === null || y > best) best = y;
    }
  }
  return best;
}

// 煙突の数: 床面積に応じて 1〜3 本（旧市街の家はほとんどが 1〜3 本の四角いレンガの煙突を持つ。roofs-1.jpg）。
// 小さな離れには付けず、5 % ほどの家は煙突なし。80 m² の家は 4 割、120 m² の家は 7 割が 2 本、大きな家は 3 本も
export function chimneyCount(area, id) {
  if (area < 25 || hash01(id, 41) < 0.05) return 0;
  return Math.min(3, 1 + Math.floor(area / 160 + hash01(id, 42) * 0.85));
}

// 煙突を置く。roof: buildRoof の結果（y は軒から）、id: 建物の番号、area: 床面積（m²）。
// 候補は、隣の家との境の切妻の壁の頂（壁から 0.35 m 内側）とその 1.5 m 隣（境の壁に煙突が 2 本並ぶ家が多い）、
// 水平な棟の上（棟をまたぐ）。境の壁の頂を先に選びやすくし、互いに 3 m 以上（同じ境の壁の上なら 1.2 m 以上）離す。四隅の屋根の高さを測り、いちばん低い所から立ち上げ、いちばん高い所から 0.8〜1.5 m 突き出す。
// 返り値: [{ x, z, ux, uz, w, d, group, y0, y1, render, tileCap }]（u: 長い辺の向き、w × d: 断面、
// group: 境の壁の番号 + 1（棟の上は 0）、y0〜y1: 軒からの高さ）
export function placeChimneys(roof, id, area) {
  const count = chimneyCount(area, id);
  if (!count) return [];
  const tris = [roof.roof, roof.top];
  const cands = [];
  for (const [gi, g] of roof.gables.entries()) {
    let top = g.pts[0];
    for (const p of g.pts) if (p[1] > top[1]) top = p;
    const dx = g.b[0] - g.a[0], dz = g.b[1] - g.a[1];
    const L = Math.hypot(dx, dz);
    if (L < 2 || top[1] < 0.5) continue;
    const ux = dx / L, uz = dz / L;
    const s = Math.min(L - 0.5, Math.max(0.5, top[0]));
    // 頂と、広い側へ 1.5 m ずらした 2 本目
    const s2 = s > L / 2 ? s - 1.5 : s + 1.5;
    for (const [t, weight] of s2 >= 0.5 && s2 <= L - 0.5 ? [[s, 2], [s2, 1]] : [[s, 2]]) {
      const px = g.a[0] + ux * t, pz = g.a[1] + uz * t;
      // 壁のどちら側が屋根か（屋根のある側へ 0.35 m）
      for (const k of [1, -1]) {
        const x = px - uz * 0.35 * k, z = pz + ux * 0.35 * k;
        if (roofHeightAt(tris, x, z) !== null) {
          cands.push({ x, z, ux, uz, weight, group: gi + 1 });
          break;
        }
      }
    }
  }
  const R = roof.ridges;
  for (let i = 0; i < R.length; i += 6) {
    const dx = R[i + 3] - R[i], dz = R[i + 5] - R[i + 2];
    const L = Math.hypot(dx, dz);
    if (L < 1.5 || Math.abs(R[i + 4] - R[i + 1]) > 0.1 * L) continue; // 隅棟（傾いた線）には置かない
    for (const f of L > 6 ? [0.2, 0.5, 0.8] : [0.5]) cands.push({ x: R[i] + dx * f, z: R[i + 2] + dz * f, ux: dx / L, uz: dz / L, weight: 1, group: 0 });
  }
  const rnd = mulberry32(((id | 0) * 2654435761 + 977) >>> 0);
  const out = [];
  while (out.length < count && cands.length) {
    let total = 0;
    for (const c of cands) total += c.weight;
    let r = rnd() * total, k = 0;
    while (k < cands.length - 1 && (r -= cands[k].weight) > 0) k++;
    const c = cands.splice(k, 1)[0];
    if (out.some((o) => Math.hypot(o.x - c.x, o.z - c.z) < (o.group && o.group === c.group ? 1.2 : 3))) continue;
    const w = 0.5 + rnd() * 0.2, d = 0.4 + rnd() * 0.1;
    // 四隅の屋根の高さ（どれかが屋根の外なら置かない）
    let lo = Infinity, hi = -Infinity, inside = true;
    for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      const x = c.x + c.ux * (w / 2) * a - c.uz * (d / 2) * b, z = c.z + c.uz * (w / 2) * a + c.ux * (d / 2) * b;
      const y = roofHeightAt(tris, x, z);
      if (y === null) {
        inside = false;
        break;
      }
      lo = Math.min(lo, y);
      hi = Math.max(hi, y);
    }
    if (!inside) continue;
    const yc = roofHeightAt(tris, c.x, c.z) ?? hi;
    out.push({
      x: c.x, z: c.z, ux: c.ux, uz: c.uz, w, d, group: c.group,
      y0: lo - 0.1, y1: Math.max(hi, yc) + 0.8 + rnd() * 0.7,
      render: rnd() < 0.4, tileCap: rnd() < 0.45,
    });
  }
  return out;
}

// ---------------------------------------------------------------- 書き込み

// génoise の 1 区間（三角形 2 つ。留め継ぎでない端は小口の三角形でふさぐ）。段を、壁際の base からいちばん外の段の上端（壁から rows × step、base + rows × rowH）まで
// 外へ迫り出していく斜めの面にまとめ、テクスチャを段の数だけ縦に繰り返して「漆喰の帯・瓦の端の列」を並べる
// （下から見上げると段の下面と瓦の端が交互に見え、遠くからは屋根の下の白い帯に見える）。外の縁は軒の出の先の屋根の縁と接する。
// w: génoise の MeshWriter、run: eaveRuns の 1 つ、rows: 段数、color: 頂点カラー
export function writeGenoise(w, run, base, rows, color) {
  const { rowH, step } = GENOISE;
  const { a, b, u, o, ma, mb, s0 } = run;
  const P = (p, m, dist, y) => [p[0] + m[0] * dist, y, p[1] + m[1] * dist];
  // 辺に沿った距離（テクスチャの u。1 m に瓦 6 枚）
  const S = (p, m, dist) => s0 + (p[0] - a[0] + m[0] * dist) * u[0] + (p[1] - a[1] + m[1] * dist) * u[1];
  const dMax = rows * step, yTop = base + rows * rowH;
  const nl = Math.hypot(rows * rowH, dMax);
  const n = [(o[0] * rows * rowH) / nl, -dMax / nl, (o[1] * rows * rowH) / nl]; // 外・下向き
  w.quad(P(a, ma, 0, base), P(b, mb, 0, base), P(b, mb, dMax, yTop), P(a, ma, dMax, yTop), n,
    [S(a, ma, 0), 0], [S(b, mb, 0), 0], [S(b, mb, dMax), rows], [S(a, ma, dMax), rows], color);
  // 小口（壁際の下端・外の上端・壁際の上端の縦の三角形。テクスチャは目地の漆喰の所）
  const cap = (p, m, s) => w.tri(P(p, m, 0, base), P(p, m, dMax, yTop), P(p, m, 0, yTop), [u[0] * s, 0, u[1] * s], [0.1, 0.05], [0.3, 0.15], [0.1, 0.15], color);
  if (run.capA) cap(a, ma, -1);
  if (run.capB) cap(b, mb, 1);
}

// 軒の出のための、外形の頂点ごとのずれ [x, z, c]（1 m あたり。軒でない頂点は null）。屋根の三角形の軒の頂点（高さ 0）を
// この向きへ dist だけ動かし、高さを c × dist × 勾配 下げると、屋根面が同じ勾配のまま外へ延びる（三角形は増えない）。
// 頂点の両側の辺がどちらも軒なら留め継ぎ（eaveRuns と同じ。鋭い角は縮める）、片側だけなら軒の辺の法線の向き（c = 1）
export function eaveShifts(ring, sign, isEave) {
  const n = ring.length;
  const normal = (i) => {
    const a = ring[i], b = ring[(i + 1) % n];
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    return [((b[1] - a[1]) / L) * sign, (-(b[0] - a[0]) / L) * sign];
  };
  return ring.map((_, i) => {
    const prev = (i - 1 + n) % n;
    const e1 = isEave[prev], e2 = isEave[i];
    if (e1 && e2) return miterShift(normal(prev), normal(i));
    const o = e1 ? normal(prev) : e2 ? normal(i) : null;
    return o && [o[0], o[1], 1];
  });
}

// 棟瓦: 棟・隅棟の線に沿って、少し盛り上がった細い帯（断面は山形）を載せる。w: 屋根の MeshWriter、ridges: buildRoof の ridges、
// top: 軒の高さ、corner(x, z): 軒の出で動かした外形の頂点の位置 [x, y, z]（動かさない頂点は null。関数なしでもよい）、
// color: 頂点カラー、minLen: これより短い棟・隅棟は省く（m）
export function writeRidgeTiles(w, ridges, top, corner, color, minLen = 3) {
  const half = 0.12, rise = 0.05;
  for (let i = 0; i < ridges.length; i += 6) {
    let p = [ridges[i], top + ridges[i + 1], ridges[i + 2]], q = [ridges[i + 3], top + ridges[i + 4], ridges[i + 5]];
    if (p[1] > q[1]) [p, q] = [q, p];
    const hx = q[0] - p[0], hz = q[2] - p[2], hl = Math.hypot(hx, hz);
    if (hl < minLen) continue; // 短い隅棟（外形の小さな折れ）は省く
    // 軒まで下りる隅棟: 下の端が軒の出で動かした屋根の角なら、その角まで延ばす（動かさない角では延ばさない）
    if (corner && p[1] - top < 0.02 && q[1] - p[1] > 0.05) p = corner(p[0], p[2]) || p;
    const nx = -hz / hl, nz = hx / hl; // 水平で線に直角な向き
    // 棟の線より少し上に、線に直角な向きには水平な細い帯（三角形 2 つ）。縁は屋根面より少し浮く
    const S = (r, s) => [r[0] + nx * half * s, r[1] + rise, r[2] + nz * half * s];
    const L3 = Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]);
    // 面の法線（線の向き × 横の向き）
    const tx = (q[0] - p[0]) / L3, ty = (q[1] - p[1]) / L3, tz = (q[2] - p[2]) / L3;
    let n = [ty * nz, tz * nx - tx * nz, -ty * nx];
    if (n[1] < 0) n = [-n[0], -n[1], -n[2]];
    // 瓦の向き: テクスチャの縦（瓦の流れ）を線に沿わせ、帯の幅を上瓦 1 列に合わせる
    w.quad(S(p, 1), S(q, 1), S(q, -1), S(p, -1), n, [0.035, 0], [0.035, L3 / 2], [0.09, L3 / 2], [0.09, 0], color);
  }
}

// 煙突（placeChimneys の 1 つ）。stack: 筒の MeshWriter（漆喰・レンガの窓のない壁の材料）、tri: 屋根の材料の三角形を書く関数、
// top: 軒の高さ、color: 筒の色、capColor: コンクリートの笠の色（丸瓦の笠は tri で屋根の色）
export function writeChimney(stack, tri, c, top, color, capColor) {
  const { x, z, ux, uz, w, d } = c;
  const y0 = top + c.y0, y1 = top + c.y1;
  const corner = (a, b, dw = 0, y = y0) => [x + ux * (w / 2 + dw) * a - uz * (d / 2 + dw) * b, y, z + uz * (w / 2 + dw) * a + ux * (d / 2 + dw) * b];
  const box = (dw, ya, yb, col, sides = true, topFace = true) => {
    const cs = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
    if (sides) {
      for (let k = 0; k < 4; k++) {
        const [a1, b1] = cs[k], [a2, b2] = cs[(k + 1) % 4];
        const p = corner(a1, b1, dw, ya), q = corner(a2, b2, dw, ya);
        // 面の外向き: 2 つの角の中点の向き
        const mx = (p[0] + q[0]) / 2 - x, mz = (p[2] + q[2]) / 2 - z, ml = Math.hypot(mx, mz) || 1;
        const sl = Math.hypot(q[0] - p[0], q[2] - p[2]);
        stack.quad(p, q, [q[0], yb, q[2]], [p[0], yb, p[2]], [mx / ml, 0, mz / ml], [0, ya / 4], [sl / 4, ya / 4], [sl / 4, yb / 4], [0, yb / 4], col);
      }
    }
    if (topFace) stack.quad(corner(-1, -1, dw, yb), corner(1, -1, dw, yb), corner(1, 1, dw, yb), corner(-1, 1, dw, yb), [0, 1, 0], [0, 0], [0.1, 0], [0.1, 0.1], [0, 0.1], col);
  };
  box(0, y0, y1, color, true, false); // 筒の上面は笠に隠れるので省く
  if (c.tileCap) {
    // 丸瓦の笠: 筒の上に、長い辺の向きに 2 枚を山形に立てかける（両端は開いて煙が抜ける）
    const ridgeY = y1 + 0.22;
    const e = 0.06;
    const r1 = [x - ux * (w / 2 + e), ridgeY, z - uz * (w / 2 + e)], r2 = [x + ux * (w / 2 + e), ridgeY, z + uz * (w / 2 + e)];
    for (const s of [1, -1]) {
      const p1 = corner(-1, s, e, y1 + 0.04), p2 = corner(1, s, e, y1 + 0.04);
      tri(p1, p2, r2);
      tri(p1, r2, r1);
    }
  } else {
    // コンクリートの薄い笠（少し張り出す。上面だけ）
    box(0.05, y1 + 0.05, y1 + 0.05, capColor, false);
  }
}
