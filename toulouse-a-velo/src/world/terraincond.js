// 地形の格子の手直し（読み込んだあと、地面・道路・橋を作る前に 1 回だけ）と、橋の縦断面の整理。three.js を使わない（単体テストできる）。
// - conditionRoads: 車道の縦断面で格子をならす（5 m の格子のなまりで岸壁・切り通しの斜面に車道が載ってうねったり、
//   川側へ傾いたりしないように。水の上の区間は両岸の高さを結ぶ）
// - sharpenQuays: 旧市街のまわりの岸壁（上の河岸と下の遊歩道の段差）を、なまった斜面から 1 マスの段差に戻し、
//   垂直のレンガの壁を立てる線（walls）を返す（水辺から near m 以内、低い側が水面 + lowAbove m 以下、車道の上は触らない。
//   遊歩道へ下りる歩道・自転車道の坂と階段は残し、車道でない道を横切る壁は作らない。斜面に沿って走る遊歩道は下の段にする）
// - extendHeights: 測った範囲の外（遠くの地面の格子の NaN）を、縁の高さから地方の平均へゆるやかに移る丘で埋める
// - despike: 格子の 1 点だけの穴・とげ（測りの外れ）を近くの中央値に戻す
// - cleanProfile / fitDeckEnds: 測った橋の縦断面の外れ値を捨て、両端を取り付ける道路の高さに合わせる
import { CAR_ROADS } from './parse.js';
import { closestOnSegment, hash01 } from '../geo.js';

const smooth01 = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

// 格子点 (c, r) のローカル座標
const nodeX = (g, c) => (c - g.bx) / g.ax;
const nodeZ = (g, r) => (r - g.bz) / g.az;

// 道の中心線を step m 以下ごとに区切った点 [{ x, z, s }]
function samplePolyline(pts, step) {
  const out = [{ x: pts[0][0], z: pts[0][1], s: 0 }];
  let s = 0;
  for (let i = 0; i + 1 < pts.length; i++) {
    const [ax, az] = pts[i], [bx, bz] = pts[i + 1];
    const L = Math.hypot(bx - ax, bz - az);
    if (L < 1e-6) continue;
    const n = Math.max(1, Math.ceil(L / step));
    for (let k = 1; k <= n; k++) out.push({ x: ax + ((bx - ax) * k) / n, z: az + ((bz - az) * k) / n, s: s + (L * k) / n });
    s += L;
  }
  return out;
}

// 車道の縦断面で地面の格子をならす。roads: 道路（parse.js）、inWater(x, z): 水の上か。
// 中心線を 5 m ごとに測り、水の上の点は両岸の点の高さを結び、前後 ±window m の三角の重みでならす。
// 車道の幅の半分 + 1 m までの格子点はその高さに、そこから fringe m かけて元の地面に戻す（重なる道は重みで平均）
export function conditionRoads(terrain, roads, inWater = () => false, { window = 15, fringe = 6 } = {}) {
  if (!terrain || terrain.flat) return 0;
  const g = terrain.near, D = g.data, cols = g.cols, rows = g.rows;
  const DAT = terrain.datum;
  const sumW = new Float32Array(cols * rows), sumY = new Float32Array(cols * rows), maxW = new Float32Array(cols * rows);
  terrain.roadW = maxW; // 車道の重み（1: 車道の上、0: 関係なし）。sharpenQuays・despike が車道を避けるのに使う
  let used = 0;
  for (const r of roads) {
    if (!CAR_ROADS.has(r.type) || r.bridge || r.tunnel || (r.layer || 0) < 0) continue;
    const S = samplePolyline(r.pts, 5);
    if (S.length < 2) continue;
    for (const p of S) {
      p.wet = inWater(p.x, p.z);
      p.h = terrain.h(p.x, p.z);
    }
    // 水の上の点: 前後の陸の点の高さを結ぶ（片側しかなければその高さ）
    if (S.some((p) => p.wet)) {
      if (S.every((p) => p.wet)) continue;
      for (let i = 0; i < S.length; i++) {
        if (!S[i].wet) continue;
        let a = i, b = i;
        while (a >= 0 && S[a].wet) a--;
        while (b < S.length && S[b].wet) b++;
        const A = a >= 0 ? S[a] : null, B = b < S.length ? S[b] : null;
        S[i].h = A && B ? A.h + ((B.h - A.h) * (S[i].s - A.s)) / Math.max(1e-6, B.s - A.s) : (A || B).h;
      }
    }
    // 前後 ±window m の三角の重みの平均（道の端では窓が片側だけになる）
    const ys = S.map((p, i) => {
      let sw = 0, sy = 0;
      for (let j = i; j >= 0 && p.s - S[j].s < window; j--) {
        const w = 1 - (p.s - S[j].s) / window;
        sw += w;
        sy += w * S[j].h;
      }
      for (let j = i + 1; j < S.length && S[j].s - p.s < window; j++) {
        const w = 1 - (S[j].s - p.s) / window;
        sw += w;
        sy += w * S[j].h;
      }
      return sy / sw;
    });
    const inner = (r.width || 6) / 2 + 1, outer = inner + fringe, wid2 = (r.width || 6) ** 2;
    for (let i = 0; i + 1 < S.length; i++) {
      const a = S[i], b = S[i + 1];
      const c0 = Math.max(0, Math.ceil(g.ax * (Math.min(a.x, b.x) - outer) + g.bx)), c1 = Math.min(cols - 1, Math.floor(g.ax * (Math.max(a.x, b.x) + outer) + g.bx));
      const r0 = Math.max(0, Math.ceil(g.az * (Math.min(a.z, b.z) - outer) + g.bz)), r1 = Math.min(rows - 1, Math.floor(g.az * (Math.max(a.z, b.z) + outer) + g.bz));
      for (let rr = r0; rr <= r1; rr++) {
        const z = nodeZ(g, rr);
        for (let cc = c0; cc <= c1; cc++) {
          const c = closestOnSegment(nodeX(g, cc), z, a.x, a.z, b.x, b.z);
          const d = Math.sqrt(c.d2);
          if (d >= outer) continue;
          const w = d <= inner ? 1 : 1 - smooth01((d - inner) / fringe);
          const k = rr * cols + cc;
          // 重なる道（交差点・並ぶ道）は、幅の広い道と中心に近い道を強く（平均で横に急なうねりができないように）
          const pw = w * w * wid2;
          sumW[k] += pw;
          sumY[k] += pw * (ys[i] + (ys[i + 1] - ys[i]) * c.t);
          if (w > maxW[k]) maxW[k] = w;
        }
      }
    }
    used++;
  }
  for (let k = 0; k < D.length; k++) {
    if (maxW[k] <= 0 || Number.isNaN(D[k])) continue;
    D[k] += (sumY[k] / sumW[k] + DAT - D[k]) * maxW[k];
  }
  return used;
}

// 岸壁を立て直す。centre, radius: レンガの岸壁がある範囲（旧市街のまわりのガロンヌ川・ブリエンヌ運河）。
// inWater(x, z): 水の上か（水の上の格子点は使わない。水辺から near m より遠い点も使わない）。
// roadW: 格子点ごとの車道の重み（conditionRoads。roadMax より大きい点＝車道の上は触らない＝車道を横切る壁は作らない。
// 車道の脇のならした帯は触る: 河岸の道は岸壁のすぐ上を走るので、帯を避けると岸壁が途切れて斜面が残る）。
// ±win m の中で高さの差が drop m より大きく、低い側が水面 + lowAbove m 以下（水辺の遊歩道）の格子点を、上の段か下の段に
// 分け（真ん中の高さより上か下か）、上の段の点は近くの最大へ、下の段の点は近くの最小へ寄せて、なまった斜面を 1 マスの段差にする。
// paths: 車道でない道（歩道・小道・自転車道・階段・サービス道路など。parse.js の道路）。遊歩道へ下りる坂・階段（中心線の ±rampSpan m で
// 高さが rampMin m 以上違う所）のまわりの格子点は触らず（元の坂のまま）、残った壁の線も道を横切るものは捨てる（自転車で通れるように）。
// 斜面に沿って走る遊歩道（道に沿った勾配が地面の勾配の半分未満）のまわりは下の段にする（岸壁の下の船着き場。上の段の縁の近くは除く）。
// 下の段は水面 + lowMin m より下げない。
// 返り値: 壁の線分 [{ ax, az, at, ab, bx, bz, bt, bb, nx, nz }]（at/ab: 壁の上端・下端の y。n: 下の段に向く水平の向き）
export function sharpenQuays(terrain, centre, radius, { win = 15, drop = 3, lowAbove = 4, near = 45, level = 0.12, inWater = () => false, roadW = terrain?.roadW, roadMax = 0.99, paths = [], rampSpan = 8, rampMin = 0.6, terraceGrad = 0.12, edgeKeep = 0.6, lowMin = 0.9 } = {}) {
  if (!terrain || terrain.flat || !centre) return [];
  const g = terrain.near, D = g.data, cols = g.cols, rows = g.rows, DAT = terrain.datum;
  const c0 = Math.max(0, Math.floor(g.ax * (centre[0] - radius) + g.bx)), c1 = Math.min(cols - 1, Math.ceil(g.ax * (centre[0] + radius) + g.bx));
  const r0 = Math.max(0, Math.floor(g.az * (centre[1] - radius) + g.bz)), r1 = Math.min(rows - 1, Math.ceil(g.az * (centre[1] + radius) + g.bz));
  if (c1 - c0 < 2 || r1 - r0 < 2) return [];
  const W = c1 - c0 + 1, Hn = r1 - r0 + 1;
  const orig = new Float32Array(W * Hn);
  for (let r = 0; r < Hn; r++) for (let c = 0; c < W; c++) orig[r * W + c] = D[(r + r0) * cols + c + c0];
  // 水の上の点（岸から延ばした面。橋の脇などに台地が残る）と、水辺からの距離（マス。8 近傍の 2 回の走査）
  const wet = new Uint8Array(W * Hn), dist = new Float32Array(W * Hn).fill(1e9);
  for (let r = 0; r < Hn; r++) {
    for (let c = 0; c < W; c++) {
      if (!inWater(nodeX(g, c + c0), nodeZ(g, r + r0))) continue;
      wet[r * W + c] = 1;
      dist[r * W + c] = 0;
    }
  }
  const relax = (r, c, dr, dc, w) => {
    const rr = r + dr, cc = c + dc;
    if (rr < 0 || cc < 0 || rr >= Hn || cc >= W) return;
    const v = dist[rr * W + cc] + w;
    if (v < dist[r * W + c]) dist[r * W + c] = v;
  };
  for (let r = 0; r < Hn; r++) for (let c = 0; c < W; c++) for (const [dr, dc, w] of CHAMFER_A) relax(r, c, dr, dc, w);
  for (let r = Hn - 1; r >= 0; r--) for (let c = W - 1; c >= 0; c--) for (const [dr, dc, w] of CHAMFER_A) relax(r, c, -dr, -dc, w);
  const nearCells = near * g.ax;
  // 車道でない道の坂・階段のまわり（道の幅の半分 + 1 m、少なくとも 3/4 マス: 道が通るマスの角のどれかは必ず入る）
  const ramp = new Uint8Array(W * Hn), lowPath = new Uint8Array(W * Hn);
  const lines = [];
  const bx0 = centre[0] - radius - 50, bx1 = centre[0] + radius + 50, bz0 = centre[1] - radius - 50, bz1 = centre[1] + radius + 50;
  for (const p of paths) {
    if (CAR_ROADS.has(p.type) || p.bridge || p.tunnel || (p.layer || 0) < 0 || !p.pts || p.pts.length < 2) continue;
    if (!p.pts.some(([x, z]) => x > bx0 && x < bx1 && z > bz0 && z < bz1)) continue;
    for (let i = 0; i + 1 < p.pts.length; i++) lines.push(p.pts[i][0], p.pts[i][1], p.pts[i + 1][0], p.pts[i + 1][1]);
    const S = samplePolyline(p.pts, 2);
    for (const q of S) q.h = terrain.h(q.x, q.z);
    const rr = Math.max((p.width || 2.5) / 2 + 1, 0.75 * Math.max(1 / g.ax, 1 / g.az));
    // 斜面に沿う遊歩道は、道の両側の格子点が必ず下の段に入る幅（1 マス + α。壁が道を横切らないように）
    const rrLow = Math.max(rr, 1.15 * Math.max(1 / g.ax, 1 / g.az));
    for (let i = 0, a = 0, b = 0; i < S.length; i++) {
      while (S[i].s - S[a].s > rampSpan) a++;
      while (b + 1 < S.length && S[b + 1].s - S[i].s <= rampSpan) b++;
      let lo = Infinity, hi = -Infinity;
      for (let j = a; j <= b; j++) {
        lo = Math.min(lo, S[j].h);
        hi = Math.max(hi, S[j].h);
      }
      const q = S[i];
      // 道に沿った勾配（窓の中の高さの回帰の傾き）が地面の勾配の半分より小さい斜面の上の道は、斜面に沿って走る遊歩道
      // （なまった斜面に載っているだけ）: 坂ではなく下の段の道として扱う（岸壁の下の船着き場の遊歩道が斜面に貼り付いて傾かないように）
      let ms = 0, mh = 0;
      for (let j = a; j <= b; j++) {
        ms += S[j].s;
        mh += S[j].h;
      }
      ms /= b - a + 1;
      mh /= b - a + 1;
      let sxy = 0, sxx = 0;
      for (let j = a; j <= b; j++) {
        sxy += (S[j].s - ms) * (S[j].h - mh);
        sxx += (S[j].s - ms) ** 2;
      }
      const along = sxx > 0 ? Math.abs(sxy / sxx) : 0;
      const grad = Math.hypot(terrain.h(q.x + 2.5, q.z) - terrain.h(q.x - 2.5, q.z), terrain.h(q.x, q.z + 2.5) - terrain.h(q.x, q.z - 2.5)) / 5;
      const terraceRun = grad > terraceGrad && along < 0.5 * grad;
      if (!terraceRun && !(hi - lo >= rampMin)) continue;
      const R = terraceRun ? rrLow : rr;
      const cc0 = Math.max(0, Math.ceil(g.ax * (q.x - R) + g.bx) - c0), cc1 = Math.min(W - 1, Math.floor(g.ax * (q.x + R) + g.bx) - c0);
      const rw0 = Math.max(0, Math.ceil(g.az * (q.z - R) + g.bz) - r0), rw1 = Math.min(Hn - 1, Math.floor(g.az * (q.z + R) + g.bz) - r0);
      for (let r = rw0; r <= rw1; r++) {
        for (let c = cc0; c <= cc1; c++) {
          const dn = Math.hypot(nodeX(g, c + c0) - q.x, nodeZ(g, r + r0) - q.z);
          if (terraceRun) {
            if (dn <= rrLow) lowPath[r * W + c] = 1;
          } else if (dn <= rr) ramp[r * W + c] = 1;
        }
      }
    }
  }
  const used = (k, r, c) => !wet[k] && !ramp[k] && dist[k] <= nearCells && !(roadW && roadW[(r + r0) * cols + c + c0] > roadMax);
  const wc = Math.max(1, Math.round(win * g.ax)), wr = Math.max(1, Math.round(win * g.az));
  // 窓の最小・最大（行ごと → 列ごとの 2 回）
  const rowMin = new Float32Array(W * Hn), rowMax = new Float32Array(W * Hn);
  for (let r = 0; r < Hn; r++) {
    for (let c = 0; c < W; c++) {
      let lo = Infinity, hi = -Infinity;
      for (let k = Math.max(0, c - wc); k <= Math.min(W - 1, c + wc); k++) {
        const v = orig[r * W + k];
        if (Number.isNaN(v) || wet[r * W + k]) continue;
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      rowMin[r * W + c] = lo;
      rowMax[r * W + c] = hi;
    }
  }
  const cls = new Int8Array(W * Hn).fill(-1); // 1: 上の段、0: 下の段、-1: 岸壁の近くではない
  const inside = (c, r) => Math.hypot(nodeX(g, c + c0) - centre[0], nodeZ(g, r + r0) - centre[1]) < radius;
  for (let r = 0; r < Hn; r++) {
    for (let c = 0; c < W; c++) {
      const v = orig[r * W + c];
      if (Number.isNaN(v) || !used(r * W + c, r, c) || !inside(c, r)) continue;
      let lo = Infinity, hi = -Infinity;
      for (let k = Math.max(0, r - wr); k <= Math.min(Hn - 1, r + wr); k++) {
        lo = Math.min(lo, rowMin[k * W + c]);
        hi = Math.max(hi, rowMax[k * W + c]);
      }
      if (hi - lo < drop || lo - DAT > terrain.waterLevel(nodeX(g, c + c0), nodeZ(g, r + r0)) + lowAbove) continue;
      // 斜面に沿う遊歩道の上は下の段（坂の印が付いた所と、上の段の縁の近く（上の段の歩道）は除く）
      const low = lowPath[r * W + c] && !ramp[r * W + c] && v < hi - edgeKeep;
      cls[r * W + c] = v > (hi + lo) / 2 && !low ? 1 : 0;
    }
  }
  // 上の段は 8 近傍の最大へ、下の段は最小へ（3 回。斜面が 1 マスの段差になる）。分けた段の中だけを見る
  const cur = orig.slice();
  for (let it = 0; it < 3; it++) {
    const prev = cur.slice();
    for (let r = 0; r < Hn; r++) {
      for (let c = 0; c < W; c++) {
        const k = r * W + c, cl = cls[k];
        if (cl < 0) continue;
        let v = prev[k];
        for (let dr = -1; dr <= 1; dr++) {
          for (let dc = -1; dc <= 1; dc++) {
            const rr = r + dr, cc = c + dc;
            if (rr < 0 || cc < 0 || rr >= Hn || cc >= W) continue;
            const j = rr * W + cc;
            if (cls[j] !== cl || Number.isNaN(prev[j])) continue;
            v = cl ? Math.max(v, prev[j]) : Math.min(v, prev[j]);
          }
        }
        cur[k] = v;
      }
    }
  }
  // 下の段は水面 + lowMin m より下げない（最小へ寄せると水辺の点の高さまで下がり、遊歩道が水面すれすれになる）。
  // 水面の格子がないときは水面の高さが分からないので何もしない
  for (let r = 0; r < (terrain.level ? Hn : 0); r++) {
    for (let c = 0; c < W; c++) {
      const k = r * W + c;
      if (cls[k] !== 0) continue;
      const floor = terrain.waterLevel(nodeX(g, c + c0), nodeZ(g, r + r0)) + DAT + lowMin;
      if (orig[k] >= floor) cur[k] = Math.max(cur[k], floor);
    }
  }
  if (!terrain.quayMask) terrain.quayMask = new Uint8Array(cols * rows);
  for (let r = 0; r < Hn; r++) {
    for (let c = 0; c < W; c++) {
      if (cls[r * W + c] < 0) continue;
      D[(r + r0) * cols + c + c0] = cur[r * W + c];
      terrain.quayMask[(r + r0) * cols + c + c0] = 1;
    }
  }
  // 壁の線: 上の段と下の段の境（マス目の辺のうち、片方が上・片方が下）を、下の段寄り（差の level の高さ）で結ぶ（マーチングスクエア）。
  // 辺の上の点は辺ごとに 1 回だけ決めるので、隣のマスの壁とすき間なくつながる
  const at = (c, r) => cur[r * W + c];
  const edgePt = (c, r, dc, dr) => {
    const hiN = cls[r * W + c] === 1 ? [c, r] : [c + dc, r + dr], loN = cls[r * W + c] === 1 ? [c + dc, r + dr] : [c, r];
    const top = at(...hiN), bot = at(...loN);
    const t = 1 - level; // 上の点から下の点へ（下の段寄り）
    const x = nodeX(g, hiN[0] + c0 + (loN[0] - hiN[0]) * t), z = nodeZ(g, hiN[1] + r0 + (loN[1] - hiN[1]) * t);
    return { x, z, top: top - DAT, bot: bot - DAT };
  };
  const walls = [];
  for (let r = 0; r + 1 < Hn; r++) {
    for (let c = 0; c + 1 < W; c++) {
      const q = [cls[r * W + c], cls[r * W + c + 1], cls[(r + 1) * W + c + 1], cls[(r + 1) * W + c]];
      if (q.some((v) => v < 0)) continue;
      // 辺: 0 上（c,r → c+1,r）、1 右（c+1,r → c+1,r+1）、2 下（c,r+1 → c+1,r+1）、3 左（c,r → c,r+1）
      const E = [];
      if (q[0] !== q[1]) E.push(edgePt(c, r, 1, 0));
      if (q[1] !== q[2]) E.push(edgePt(c + 1, r, 0, 1));
      if (q[3] !== q[2]) E.push(edgePt(c, r + 1, 1, 0));
      if (q[0] !== q[3]) E.push(edgePt(c, r, 0, 1));
      if (E.length !== 2 && E.length !== 4) continue;
      const pairs = E.length === 2 ? [[E[0], E[1]]] : [[E[0], E[3]], [E[1], E[2]]];
      // 下の段に向く向き: マスの中の下の段の点の平均の方へ
      let lx = 0, lz = 0, n = 0;
      [[c, r], [c + 1, r], [c + 1, r + 1], [c, r + 1]].forEach(([cc, rr], i) => {
        if (q[i] === 0) {
          lx += nodeX(g, cc + c0);
          lz += nodeZ(g, rr + r0);
          n++;
        }
      });
      lx /= n;
      lz /= n;
      for (const [A, B] of pairs) {
        let nx = -(B.z - A.z), nz = B.x - A.x;
        const l = Math.hypot(nx, nz);
        if (l < 1e-3) continue;
        nx /= l;
        nz /= l;
        if ((lx - (A.x + B.x) / 2) * nx + (lz - (A.z + B.z) / 2) * nz < 0) {
          nx = -nx;
          nz = -nz;
        }
        walls.push({ ax: A.x, az: A.z, at: A.top, ab: A.bot, bx: B.x, bz: B.z, bt: B.top, bb: B.bot, nx, nz });
      }
    }
  }
  // 車道でない道を横切る壁は捨てる（壁にはぶつかる判定があるので、坂の判定から漏れた道もふさがない）
  if (!lines.length) return walls;
  return walls.filter((w) => {
    for (let i = 0; i < lines.length; i += 4) if (segmentsCross(w.ax, w.az, w.bx, w.bz, lines[i], lines[i + 1], lines[i + 2], lines[i + 3])) return false;
    return true;
  });
}

// 線分 AB と CD が交わるか（端が触れるだけも交わるとみなす）
export function segmentsCross(ax, az, bx, bz, cx, cz, dx, dz) {
  if (Math.max(ax, bx) < Math.min(cx, dx) || Math.max(cx, dx) < Math.min(ax, bx) || Math.max(az, bz) < Math.min(cz, dz) || Math.max(cz, dz) < Math.min(az, bz)) return false;
  const o = (px, pz, qx, qz, rx, rz) => Math.sign((qx - px) * (rz - pz) - (qz - pz) * (rx - px));
  const o1 = o(ax, az, bx, bz, cx, cz), o2 = o(ax, az, bx, bz, dx, dz), o3 = o(cx, cz, dx, dz, ax, az), o4 = o(cx, cz, dx, dz, bx, bz);
  return o1 !== o2 && o3 !== o4;
}

// 距離の走査（前向き）の近傍 [dr, dc, 重み]。後ろ向きは符号を反対に
const CHAMFER_A = [[0, -1, 1], [-1, -1, Math.SQRT2], [-1, 0, 1], [-1, 1, Math.SQRT2]];

// 1 点だけの穴・とげ: 4 近傍のどれよりも min m 以上低い（高い）格子点を 8 近傍の中央値に戻す。車道（roadW）と岸壁（quayMask）は触らない。
// 戻り値: 直した点の数
export function despike(terrain, { min = 1, roadMax = 0.3 } = {}) {
  if (!terrain || terrain.flat) return 0;
  const g = terrain.near, D = g.data, cols = g.cols, rows = g.rows, R = terrain.roadW, Q = terrain.quayMask;
  const src = D.slice();
  let n = 0;
  for (let r = 1; r + 1 < rows; r++) {
    for (let c = 1; c + 1 < cols; c++) {
      const k = r * cols + c, v = src[k];
      if (Number.isNaN(v) || (R && R[k] > roadMax) || (Q && Q[k])) continue;
      const n4 = [src[k - 1], src[k + 1], src[k - cols], src[k + cols]];
      if (n4.some(Number.isNaN)) continue;
      if (!(n4.every((u) => u - v > min) || n4.every((u) => v - u > min))) continue;
      const n8 = [...n4, src[k - cols - 1], src[k - cols + 1], src[k + cols - 1], src[k + cols + 1]].filter((u) => !Number.isNaN(u)).sort((a, b) => a - b);
      D[k] = (n8[(n8.length - 1) >> 1] + n8[n8.length >> 1]) / 2;
      n++;
    }
  }
  return n;
}

// 3 元の連立一次方程式（ガウスの消去法）
function solve3(M, v) {
  const a = M.map((row, i) => [...row, v[i]]);
  for (let i = 0; i < 3; i++) {
    let p = i;
    for (let k = i + 1; k < 3; k++) if (Math.abs(a[k][i]) > Math.abs(a[p][i])) p = k;
    [a[i], a[p]] = [a[p], a[i]];
    if (Math.abs(a[i][i]) < 1e-9) return null;
    for (let k = 0; k < 3; k++) {
      if (k === i) continue;
      const f = a[k][i] / a[i][i];
      for (let j = i; j < 4; j++) a[k][j] -= f * a[i][j];
    }
  }
  return [a[0][3] / a[0][0], a[1][3] / a[1][1], a[2][3] / a[2][2]];
}

// 測った橋の縦断面 ys（等間隔）を「両端を結ぶ直線 + 放物線のアーチ」に当てはめ（最小二乗）、tol m 以上外れた点を捨てて
// 当てはめ直す（3 回。アーチは上向きだけ、下へ外れた点は 0.5 m で捨てる）。捨てた点は当てはめの値に置き換え、当てはめより下のくぼみは持ち上げ、[1 2 1] で軽くならす。捨てた点が半分を超えたら null（測り直しは
// 信用しない。呼び出し側は両端の地面を結ぶ縦断面を使う）
export function cleanProfile(ys, tol = 1.5) {
  const n = ys.length;
  if (n < 4) return ys.slice();
  const basis = (k) => {
    const t = k / (n - 1);
    return [1, t, 4 * t * (1 - t)];
  };
  let keep = ys.map((v) => Number.isFinite(v));
  let coef = null;
  for (let it = 0; it < 3; it++) {
    const M = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], v = [0, 0, 0];
    for (let k = 0; k < n; k++) {
      if (!keep[k]) continue;
      const b = basis(k);
      for (let i = 0; i < 3; i++) {
        v[i] += b[i] * ys[k];
        for (let j = 0; j < 3; j++) M[i][j] += b[i] * b[j];
      }
    }
    coef = solve3(M, v);
    if (!coef) return null;
    // 橋は下にたわまない: アーチが下向きなら直線だけで当てはめる（水面・切り通しが透けて見えた測りのくぼみ）
    if (coef[2] < 0) {
      const d = M[0][0] * M[1][1] - M[0][1] * M[1][0];
      if (Math.abs(d) < 1e-9) return null;
      coef = [(v[0] * M[1][1] - v[1] * M[0][1]) / d, (M[0][0] * v[1] - M[1][0] * v[0]) / d, 0];
    }
    // 上へは tol m（車・街灯・木）、下へは 0.5 m（水面・切り通しが透けた所）まで
    keep = ys.map((y, k) => {
      const r = y - basis(k).reduce((s, b, i) => s + b * coef[i], 0);
      return Number.isFinite(y) && r < tol && r > -0.5;
    });
  }
  if (keep.filter(Boolean).length < n * 0.5) return null;
  const fit = (k) => basis(k).reduce((s, b, i) => s + b * coef[i], 0);
  // 当てはめより 0.3 m 以上低い所は持ち上げる（たわみを残さない）
  const y = ys.map((v, k) => Math.max(keep[k] ? v : fit(k), fit(k) - 0.3));
  return y.map((v, k) => (k === 0 || k === n - 1 ? v : (y[k - 1] + 2 * v + y[k + 1]) / 4));
}

// 縦断面 y（step m ごと、長さ L）の両端を目標の高さ t0, t1（null なら合わせない）に合わせる。端からの坂の長さは
// 差 |e| / grade（最短 minLen m）で、両端の坂が橋の 9 割を超えるなら縮める。坂の区間は、目標から坂の終わりの高さまで
// なめらか（smoothstep）に単調に変える（端の近くの測りのでこぼこも消える）
export function fitDeckEnds(y, step, L, t0, t1, { grade = 0.045, minLen = 20 } = {}) {
  const n = y.length, out = y.slice();
  if (n < 2) return out;
  const at = (s) => {
    const f = Math.min(Math.max(s / step, 0), n - 1), i = Math.min(Math.floor(f), n - 2);
    return y[i] + (y[i + 1] - y[i]) * (f - i);
  };
  let R0 = t0 == null ? 0 : Math.max(minLen, Math.abs(t0 - y[0]) / grade);
  let R1 = t1 == null ? 0 : Math.max(minLen, Math.abs(t1 - y[n - 1]) / grade);
  if (R0 + R1 > L * 0.9) {
    const f = (L * 0.9) / (R0 + R1);
    R0 *= f;
    R1 *= f;
  }
  const y0 = at(R0), y1 = at(L - R1);
  for (let k = 0; k < n; k++) {
    const s = Math.min(L, k * step);
    if (t0 != null && s < R0) out[k] = t0 + (y0 - t0) * smooth01(s / R0);
    if (t1 != null && L - s < R1) out[k] = t1 + (y1 - t1) * smooth01((L - s) / R1);
  }
  if (t0 != null) out[0] = t0;
  if (t1 != null) out[n - 1] = t1;
  return out;
}

// 測った範囲の外の高さを埋める。ys: nx × nz の格子（step m 間隔、左上 (x0, z0)）の高さ（y。測っていない所は NaN）を書き換える。
// 一番近い測った点の高さから、ease m かけて地方の平均（縁の高さの平均を lo..hi に収めた値）へ移し、遠いほど大きいゆるやかな
// うねり（波長 1.6 km と 0.6 km、最大 amp m。hash01 で決まる）を足す: 測った範囲の縁で平らな台地が切れて、海辺のように見えないように
export function extendHeights(ys, nx, nz, step, x0 = 0, z0 = 0, { ease = 2500, lo = 15, hi = 55, amp = 12 } = {}) {
  const N = nx * nz, src = new Int32Array(N).fill(-1), dist = new Float32Array(N).fill(Infinity);
  let sum = 0, n = 0, any = false;
  for (let k = 0; k < N; k++) {
    if (!Number.isFinite(ys[k])) continue;
    any = true;
    src[k] = k;
    dist[k] = 0;
    const i = k % nx, j = (k - i) / nx;
    // 縁（隣に NaN がある測った点）の平均
    if ((i > 0 && !Number.isFinite(ys[k - 1])) || (i + 1 < nx && !Number.isFinite(ys[k + 1])) || (j > 0 && !Number.isFinite(ys[k - nx])) || (j + 1 < nz && !Number.isFinite(ys[k + nx]))) {
      sum += ys[k];
      n++;
    }
  }
  if (!any) {
    ys.fill(0);
    return ys;
  }
  const mean = Math.min(hi, Math.max(lo, n ? sum / n : 0));
  // 一番近い測った点（8 近傍の 2 回の走査。距離は本当の距離で比べる）
  const relax = (k, kk) => {
    const s = src[kk];
    if (s < 0) return;
    const dx = (k % nx) - (s % nx), dz = Math.floor(k / nx) - Math.floor(s / nx), d = Math.hypot(dx, dz);
    if (d < dist[k]) {
      dist[k] = d;
      src[k] = s;
    }
  };
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      if (i > 0) relax(k, k - 1);
      if (j > 0) {
        relax(k, k - nx);
        if (i > 0) relax(k, k - nx - 1);
        if (i + 1 < nx) relax(k, k - nx + 1);
      }
    }
  }
  for (let j = nz - 1; j >= 0; j--) {
    for (let i = nx - 1; i >= 0; i--) {
      const k = j * nx + i;
      if (i + 1 < nx) relax(k, k + 1);
      if (j + 1 < nz) {
        relax(k, k + nx);
        if (i + 1 < nx) relax(k, k + nx + 1);
        if (i > 0) relax(k, k + nx - 1);
      }
    }
  }
  // 値のノイズ（格子 L m の点ごとに hash01、間はなめらかに）
  const vnoise = (x, z, L, salt) => {
    const u = x / L, v = z / L, iu = Math.floor(u), iv = Math.floor(v), fu = smooth01(u - iu), fv = smooth01(v - iv);
    const at = (a, b) => hash01(Math.imul(a, 73856093) ^ Math.imul(b, 19349663), salt);
    const top = at(iu, iv) + (at(iu + 1, iv) - at(iu, iv)) * fu, bot = at(iu, iv + 1) + (at(iu + 1, iv + 1) - at(iu, iv + 1)) * fu;
    return top + (bot - top) * fv - 0.5;
  };
  for (let k = 0; k < N; k++) {
    if (dist[k] === 0) continue;
    const d = dist[k] * step, t = smooth01(d / ease);
    const x = x0 + (k % nx) * step, z = z0 + Math.floor(k / nx) * step;
    const wave = (vnoise(x, z, 1600, 31) * 1.4 + vnoise(x, z, 600, 32) * 0.6) * amp * Math.min(1, d / 1000);
    ys[k] = ys[src[k]] + (mean - ys[src[k]]) * t + wave;
  }
  return ys;
}
