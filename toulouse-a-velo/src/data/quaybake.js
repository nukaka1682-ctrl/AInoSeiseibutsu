// 岸壁（河岸の垂直の壁）の線を、LiDAR HD の地形モデル（0.5 m）から見つける（地図データの事前取得のときに使う）。
// 5 m の地形の格子では垂直の壁がなまった斜面になり、格子の辺に沿って立て直した壁（terraincond.js の sharpenQuays）は
// 階段状・点線状になる。0.5 m の地形モデルなら壁の面がそのまま 1〜2 マスの崖として写っているので、崖の線をなぞって
// まっすぐな折れ線にし、壁の上と下の高さと一緒に地形のファイルに入れる（world/quays.js が読んで壁を立てる）。
//
// - traceCliffs: 高さの格子から崖の線（上の段を左に見る向きの折れ線）を取り出す。three.js・通信なし（単体テストできる）
// - bakeQuays:   水辺のまわりの地形モデルを取得して、岸壁の線 [{ pts: [[緯度, 経度, 上の高さ, 下の高さ]…] }] を返す
import { LIDAR_LAYERS, fetchElevation } from './lidar.js';
import { pointInPolygon } from '../geo.js';

// 窓（±k マス）の最小・最大（行 → 列の 2 回）。NaN は飛ばす
function windowMinMax(H, cols, rows, k) {
  const lo1 = new Float32Array(cols * rows), hi1 = new Float32Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      let lo = Infinity, hi = -Infinity;
      for (let j = Math.max(0, c - k); j <= Math.min(cols - 1, c + k); j++) {
        const v = H[r * cols + j];
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      lo1[r * cols + c] = lo;
      hi1[r * cols + c] = hi;
    }
  }
  const lo2 = new Float32Array(cols * rows), hi2 = new Float32Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      let lo = Infinity, hi = -Infinity;
      for (let j = Math.max(0, r - k); j <= Math.min(rows - 1, r + k); j++) {
        if (lo1[j * cols + c] < lo) lo = lo1[j * cols + c];
        if (hi1[j * cols + c] > hi) hi = hi1[j * cols + c];
      }
      lo2[r * cols + c] = lo;
      hi2[r * cols + c] = hi;
    }
  }
  return { lo: lo2, hi: hi2 };
}

// 折れ線を許容差 tol で間引く（Douglas–Peucker）
export function simplifyLine(pts, tol) {
  if (pts.length < 3) return pts.slice();
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const [ax, ay] = pts[a], [bx, by] = pts[b], dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
    let worst = -1, wd = tol * tol;
    for (let i = a + 1; i < b; i++) {
      const t = L2 > 0 ? Math.max(0, Math.min(1, ((pts[i][0] - ax) * dx + (pts[i][1] - ay) * dy) / L2)) : 0;
      const d2 = (pts[i][0] - ax - dx * t) ** 2 + (pts[i][1] - ay - dy * t) ** 2;
      if (d2 > wd) {
        wd = d2;
        worst = i;
      }
    }
    if (worst >= 0) {
      keep[worst] = 1;
      stack.push([a, worst], [worst, b]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

// 高さの格子 H（cols × rows、行 0 が北、1 マス cell m）から崖の線を取り出す。
// 崖: ±win m の窓の中の高さの差が minDrop m 以上のマス（窓が狭いので、垂直に近い壁だけ。草の土手の斜面は入らない）。崖のマスを、窓の中ほどの高さより上（上の段）か下（下の段）に分け、
// 隣り合う上の段と下の段のマスの境の辺をつないで折れ線にする（上の段を進む向きの左に見る）。tol m で間引いて階段状の
// ぎざぎざを取り、minLen m より短い線は捨てる。
// 返り値: [{ pts: [[x, y]…]（マスの角の座標。x は列、y は行。小数にはならない）, closed }]
export function traceCliffs(H, cols, rows, cell, { minDrop = 2.2, win = 1.0, minLen = 6, tol = 2.0, sharp = 0 } = {}) {
  const k = Math.max(1, Math.round(win / cell));
  const { lo, hi } = windowMinMax(H, cols, rows, k);
  // 1: 上の段、0: 下の段、-1: 崖でない
  const cls = new Int8Array(cols * rows).fill(-1);
  for (let i = 0; i < H.length; i++) {
    if (Number.isNaN(H[i]) || !(hi[i] - lo[i] >= minDrop)) continue;
    cls[i] = H[i] > (hi[i] + lo[i]) / 2 ? 1 : 0;
  }
  // 分け方のむら（上の段の中の下の段の 1〜2 マスの島など）を、まわり 8 マスの多数決で 2 回ならす（線のひげを減らす）
  for (let pass = 0; pass < 2; pass++) {
    const prev = cls.slice();
    for (let r = 1; r < rows - 1; r++) {
      for (let c = 1; c < cols - 1; c++) {
        const i = r * cols + c;
        if (prev[i] < 0) continue;
        let up = 0, dn = 0;
        for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
          const v = prev[i + dr * cols + dc];
          if (v === 1) up++;
          else if (v === 0) dn++;
        }
        cls[i] = up > dn ? 1 : up < dn ? 0 : prev[i];
      }
    }
  }
  // 境の辺（マスの角から角へ。上の段が左）。角の番号 = y * (cols + 1) + x
  const CW = cols + 1;
  const next = new Map(); // 始点の角 → 終点の角の一覧
  const add = (x0, y0, x1, y1) => {
    const a = y0 * CW + x0, b = y1 * CW + x1;
    const l = next.get(a);
    if (l) l.push(b);
    else next.set(a, [b]);
  };
  // 垂直に近い壁だけ（草の土手の斜面は除く）: 境の辺をはさむ 4 マス（1.5 m）の両端の高さの差が minDrop の sharp 倍以上
  const steep = (i, j) => Math.abs(H[i] - H[j]) >= minDrop * sharp;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const a = cls[r * cols + c];
      if (a < 0) continue;
      // 東の隣との境（縦の辺 x = c + 1）: 上の段が西（左）なら北向き… 進む向きの左が上の段になるように
      if (c + 1 < cols) {
        const b = cls[r * cols + c + 1];
        if (b >= 0 && a !== b && steep(r * cols + Math.max(0, c - 1), r * cols + Math.min(cols - 1, c + 2))) {
          if (a === 1) add(c + 1, r + 1, c + 1, r); // 上の段が西: 北へ進むと左が西
          else add(c + 1, r, c + 1, r + 1);
        }
      }
      // 南の隣との境（横の辺 y = r + 1）
      if (r + 1 < rows) {
        const b = cls[(r + 1) * cols + c];
        if (b >= 0 && a !== b && steep(Math.max(0, r - 1) * cols + c, Math.min(rows - 1, r + 2) * cols + c)) {
          if (a === 1) add(c, r + 1, c + 1, r + 1); // 上の段が北: 東へ進むと左が北
          else add(c + 1, r + 1, c, r + 1);
        }
      }
    }
  }
  // 始点（入る辺のない角）から順につなぐ。残りは輪
  const indeg = new Map();
  for (const l of next.values()) for (const b of l) indeg.set(b, (indeg.get(b) || 0) + 1);
  const chains = [];
  const walk = (start) => {
    const pts = [start];
    let cur = start;
    for (;;) {
      const l = next.get(cur);
      if (!l || !l.length) break;
      // 分かれ道では、まっすぐ進む辺を先に
      let pick = l.length - 1;
      if (l.length > 1 && pts.length > 1) {
        const prev = pts[pts.length - 2], d = cur - prev;
        const j = l.indexOf(cur + d);
        if (j >= 0) pick = j;
      }
      const nx = l.splice(pick, 1)[0];
      pts.push(nx);
      cur = nx;
      if (cur === start) break;
    }
    return pts;
  };
  for (const a of [...next.keys()]) if (!indeg.get(a)) while (next.get(a)?.length) chains.push(walk(a));
  for (const a of [...next.keys()]) while (next.get(a)?.length) chains.push(walk(a));
  const out = [];
  for (const ch of chains) {
    if ((ch.length - 1) * cell < minLen) continue;
    const closed = ch.length > 3 && ch[0] === ch[ch.length - 1];
    const pts = simplifyLine(ch.map((i) => [i % CW, Math.floor(i / CW)]), tol / cell);
    let len = 0;
    for (let i = 0; i + 1 < pts.length; i++) len += Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]);
    if (len * cell < minLen) continue;
    out.push({ pts, closed });
  }
  return out;
}

// 折れ線の点 i での、上の段（左）から下の段（右）へ向く向き（格子の座標。x = 列、y = 行）
function rightNormal(pts, i) {
  const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
  const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1;
  // 行は南へ増える（y が下向き）ので、進む向き (dx, dy) の左は (dy, -dx)、右は (-dy, dx)
  return [-dy / l, dx / l];
}

// 格子の座標 (x, y)（マスの角）の近くの高さ（いちばん近いマス）
const cellAt = (H, cols, rows, x, y) => {
  const c = Math.floor(x), r = Math.floor(y);
  return c >= 0 && r >= 0 && c < cols && r < rows ? H[r * cols + c] : NaN;
};

// 崖の線の点ごとに、上の段の高さ（線の左 from〜to m の最大に近い値）と下の段の高さ（右 from〜to m の最小に近い値）を測る。
// 手すり壁の分の高まり・壁の足元のなまりを避けて、少し離れた所の中央値を使う
export function cliffHeights(H, cols, rows, cell, pts, { from = 1.5, to = 3.5 } = {}) {
  return pts.map((p, i) => {
    const [nx, ny] = rightNormal(pts, i);
    const up = [], dn = [];
    for (let d = from; d <= to + 1e-6; d += cell) {
      const u = cellAt(H, cols, rows, p[0] - (nx * d) / cell, p[1] - (ny * d) / cell);
      const v = cellAt(H, cols, rows, p[0] + (nx * d) / cell, p[1] + (ny * d) / cell);
      if (!Number.isNaN(u)) up.push(u);
      if (!Number.isNaN(v)) dn.push(v);
    }
    up.sort((a, b) => a - b);
    dn.sort((a, b) => a - b);
    return { top: up.length ? up[up.length >> 1] : NaN, bottom: dn.length ? dn[dn.length >> 1] : NaN };
  });
}

// 折れ線を、keep(i) が true の点が続く部分に切り分ける（minPts 点以上の部分だけ）
function splitRuns(n, keep, minPts = 2) {
  const runs = [];
  let a = -1;
  for (let i = 0; i <= n; i++) {
    const k = i < n && keep(i);
    if (k && a < 0) a = i;
    if (!k && a >= 0) {
      if (i - a >= minPts) runs.push([a, i - 1]);
      a = -1;
    }
  }
  return runs;
}

// 高さの格子（北西の角 nw = [緯度, 経度]、1 マス dLat × dLon 度、cell m）から岸壁の線を作る。
// wet(lat, lon): 水の上か。near: 水辺からこの距離（m）までの線だけ。lowAbove: 下の段が水面（いちばん近い水の高さ）+ これ以下。
// 壁の足元が水の中（水際から立つ護岸）の部分も残す（wet の印を付ける）。
// 返り値: [{ pts: [[緯度, 経度, 上, 下, 水際か 0/1]…] }]（上の段を左に見る向き。高さは標高 m）
// inZone(lat, lon): 水辺から遠くても崖の線を残す所（橋の取り付けの、擁壁で囲んだ盛り土の道など。EMBANKMENT_ZONES）
export function quayLines(H, cols, rows, { nw, dLat, dLon, cell, wet = () => false, near = 90, minDrop = 2.2, minLen = 16, step = 4, inZone = () => false }) {
  const lines = traceCliffs(H, cols, rows, cell, { minDrop, minLen: 4 });
  const ll = (x, y) => [nw[0] - y * dLat, nw[1] + x * dLon];
  const out = [];
  for (const { pts } of lines) {
    // step m ごとに点を足す（高さを細かく測り、水辺からの距離で切り分けられるように）
    const dense = [pts[0]];
    for (let i = 0; i + 1 < pts.length; i++) {
      const L = Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]) * cell, n = Math.max(1, Math.ceil(L / step));
      for (let j = 1; j <= n; j++) dense.push([pts[i][0] + ((pts[i + 1][0] - pts[i][0]) * j) / n, pts[i][1] + ((pts[i + 1][1] - pts[i][1]) * j) / n]);
    }
    const hs = cliffHeights(H, cols, rows, cell, dense);
    const info = dense.map((p, i) => {
      const [nx, ny] = rightNormal(dense, i);
      // 水辺の近くか（12 方位へ near m まで 3 m ごとに水を探す）。壁の足元（下の段の側 2 m 先まで）が水なら水際の壁
      let water = Infinity;
      for (let d = 1; d <= 2; d += 0.5) if (wet(...ll(p[0] + (nx * d) / cell, p[1] + (ny * d) / cell))) water = Math.min(water, d);
      for (let d = 3; d <= near && water > near; d += 3) {
        for (let k = 0; k < 12; k++) {
          const a = (k / 12) * Math.PI * 2;
          if (wet(...ll(p[0] + (Math.cos(a) * d) / cell, p[1] + (Math.sin(a) * d) / cell))) {
            water = d;
            break;
          }
        }
      }
      return { water, ok: (water <= near || inZone(...ll(p[0], p[1]))) && hs[i].top - hs[i].bottom >= minDrop * 0.8 };
    });
    for (const [a, b] of splitRuns(dense.length, (i) => info[i].ok)) {
      let len = 0;
      for (let i = a; i < b; i++) len += Math.hypot(dense[i + 1][0] - dense[i][0], dense[i + 1][1] - dense[i][1]) * cell;
      if (len < minLen) continue;
      const r2 = (v) => Math.round(v * 100) / 100, r7 = (v) => Math.round(v * 1e7) / 1e7;
      out.push({
        pts: dense.slice(a, b + 1).map((p, j) => {
          const [lat, lon] = ll(p[0], p[1]);
          return [r7(lat), r7(lon), r2(hs[a + j].top), r2(hs[a + j].bottom), info[a + j].water <= 2 ? 1 : 0];
        }),
      });
    }
  }
  return out;
}

// centre（[緯度, 経度]）から radius m の円と bbox の重なる範囲で、川・運河の水辺のまわりの地形モデル（cell m）を取得して
// 岸壁の線を返す。parsed/proj: そのエリアの地図（水域）。tile m 四方ずつ取得し、水辺から遠い区画は取得しない
// zones: [{ lat, lon, radius, minDrop?, minLen? }] 水辺から遠くても崖の線（擁壁）を残す円（inZone）。minDrop のある円の中は、
// そのしきい値（m）でなぞり直した線に置き換える（低くなっていく擁壁の先まで）
export async function bakeQuays({ bbox, centre, radius, parsed, proj, cell = 0.5, tile = 400, near = 90, zones = [], onStatus = () => {} }) {
  const ky = 111320, kx = 111320 * Math.cos((centre[0] * Math.PI) / 180);
  const box = {
    s: Math.max(bbox.s, centre[0] - radius / ky), n: Math.min(bbox.n, centre[0] + radius / ky),
    w: Math.max(bbox.w, centre[1] - radius / kx), e: Math.min(bbox.e, centre[1] + radius / kx),
  };
  if (!(box.n > box.s && box.e > box.w)) return [];
  const water = parsed.areas.filter((a) => a.type === 'water' && (a.kind === 'river' || a.kind === 'canal' || a.area > 4000));
  if (!water.length) return [];
  const wetXZ = (x, z) => water.some((a) => x >= a.bounds.minX && x <= a.bounds.maxX && z >= a.bounds.minZ && z <= a.bounds.maxZ && pointInPolygon(x, z, a));
  const wet = (lat, lon) => wetXZ(...proj.project(lat, lon));
  const inZone = (lat, lon) => zones.some((zn) => Math.hypot((lat - zn.lat) * ky, (lon - zn.lon) * kx) < zn.radius);
  const dLat = cell / ky, dLon = cell / kx;
  const cols = Math.ceil((box.e - box.w) / dLon), rows = Math.ceil((box.n - box.s) / dLat);
  const H = new Float32Array(cols * rows).fill(NaN);
  // 取得する区画: 中か縁から near + 20 m 以内に水がある区画（10 m ごとに調べる）
  const tn = Math.round(tile / cell), tiles = [];
  for (let r0 = 0; r0 < rows; r0 += tn) {
    for (let c0 = 0; c0 < cols; c0 += tn) {
      const r1 = Math.min(rows, r0 + tn), c1 = Math.min(cols, c0 + tn);
      let hit = false;
      const m = (near + 20) / cell, st = 10 / cell;
      for (let r = r0 - m; r <= r1 + m && !hit; r += st) for (let c = c0 - m; c <= c1 + m && !hit; c += st) hit = wet(box.n - r * dLat, box.w + c * dLon) || inZone(box.n - r * dLat, box.w + c * dLon);
      if (hit) tiles.push([r0, c0, r1, c1]);
    }
  }
  let done = 0;
  const queue = tiles.slice();
  const worker = async () => {
    while (queue.length) {
      const [r0, c0, r1, c1] = queue.shift();
      const bb = { n: box.n - r0 * dLat, s: box.n - r1 * dLat, w: box.w + c0 * dLon, e: box.w + c1 * dLon };
      const { data } = await fetchElevation(LIDAR_LAYERS.dtm, bb, c1 - c0, r1 - r0, { concurrency: 1 });
      for (let r = 0; r < r1 - r0; r++) H.set(data.subarray(r * (c1 - c0), (r + 1) * (c1 - c0)), (r0 + r) * cols + c0);
      onStatus(`岸壁の線: 地形モデル ${++done}/${tiles.length}`);
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  let lines = quayLines(H, cols, rows, { nw: [box.n, box.w], dLat, dLon, cell, wet, near, inZone });
  // minDrop のある円: 低い擁壁（斜路の下の方で 0.5〜2 m に低くなる壁）も、円の中だけ低いしきい値でなぞり直す
  for (const zn of zones) {
    if (!zn.minDrop) continue;
    const inside = ([lat, lon]) => Math.hypot((lat - zn.lat) * ky, (lon - zn.lon) * kx) < zn.radius;
    const c0 = Math.max(0, Math.floor((zn.lon - zn.radius / kx - box.w) / dLon)), c1 = Math.min(cols, Math.ceil((zn.lon + zn.radius / kx - box.w) / dLon));
    const r0 = Math.max(0, Math.floor((box.n - zn.lat - zn.radius / ky) / dLat)), r1 = Math.min(rows, Math.ceil((box.n - zn.lat + zn.radius / ky) / dLat));
    if (c1 - c0 < 8 || r1 - r0 < 8) continue;
    const sub = new Float32Array((c1 - c0) * (r1 - r0));
    for (let r = r0; r < r1; r++) sub.set(H.subarray(r * cols + c0, r * cols + c1), (r - r0) * (c1 - c0));
    const local = quayLines(sub, c1 - c0, r1 - r0, { nw: [box.n - r0 * dLat, box.w + c0 * dLon], dLat, dLon, cell, near: 0, minDrop: zn.minDrop, minLen: zn.minLen || 16, inZone: () => true });
    lines = clipLines(lines, (p) => !inside(p)).concat(clipLines(local, inside));
  }
  // 円の外の点で始まる・終わる線はそのまま（円の縁で切らない）。中心から遠い線は捨てる
  return lines.filter((l) => l.pts.some(([lat, lon]) => Math.hypot((lat - centre[0]) * ky, (lon - centre[1]) * kx) < radius));
}

// 線（[{ pts: [[緯度, 経度, …]…] }]）を、keep(点) が true の点の続く部分（2 点以上）に切り分ける
export function clipLines(lines, keep) {
  const out = [];
  for (const l of lines) for (const [a, b] of splitRuns(l.pts.length, (i) => keep(l.pts[i]))) out.push({ ...l, pts: l.pts.slice(a, b + 1) });
  return out;
}
