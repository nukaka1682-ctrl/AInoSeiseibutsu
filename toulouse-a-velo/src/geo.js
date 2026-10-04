// 緯度経度 <-> ローカル座標（メートル）の変換と、2D ポリゴン処理のユーティリティ。
// ローカル座標: x = 東, z = 南（北は -z）。three.js の Y 軸が上。
// DOM にも three.js にも依存しないので Node のテストからも使える。

const EARTH_RADIUS = 6378137;
const DEG = Math.PI / 180;

export class LocalProjection {
  constructor(lat0, lon0) {
    this.lat0 = lat0;
    this.lon0 = lon0;
    this.ky = EARTH_RADIUS * DEG;
    this.kx = Math.cos(lat0 * DEG) * EARTH_RADIUS * DEG;
  }

  project(lat, lon) {
    return [(lon - this.lon0) * this.kx, -(lat - this.lat0) * this.ky];
  }

  unproject(x, z) {
    return [this.lat0 - z / this.ky, this.lon0 + x / this.kx];
  }
}

export function bboxAround(lat, lon, radius) {
  const dLat = radius / (EARTH_RADIUS * DEG);
  const dLon = radius / (Math.cos(lat * DEG) * EARTH_RADIUS * DEG);
  const r = (v) => Math.round(v * 1e6) / 1e6;
  return { s: r(lat - dLat), w: r(lon - dLon), n: r(lat + dLat), e: r(lon + dLon) };
}

// 符号付き面積（x,z 平面）。
export function signedArea(ring) {
  let a = 0;
  for (let i = 0, n = ring.length, j = n - 1; i < n; j = i++) {
    a += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  }
  return a / 2;
}

export function centroid(ring) {
  let a = 0, cx = 0, cz = 0;
  for (let i = 0, n = ring.length, j = n - 1; i < n; j = i++) {
    const f = ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
    a += f;
    cx += (ring[j][0] + ring[i][0]) * f;
    cz += (ring[j][1] + ring[i][1]) * f;
  }
  if (Math.abs(a) < 1e-9) {
    let sx = 0, sz = 0;
    for (const p of ring) { sx += p[0]; sz += p[1]; }
    return [sx / ring.length, sz / ring.length];
  }
  return [cx / (3 * a), cz / (3 * a)];
}

export function pointInRing(x, z, ring) {
  let inside = false;
  for (let i = 0, n = ring.length, j = n - 1; i < n; j = i++) {
    const xi = ring[i][0], zi = ring[i][1], xj = ring[j][0], zj = ring[j][1];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

export function pointInPolygon(x, z, poly) {
  if (!pointInRing(x, z, poly.outer)) return false;
  for (const h of poly.holes || []) if (pointInRing(x, z, h)) return false;
  return true;
}

export function ringBounds(ring) {
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
  for (const [x, z] of ring) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  return { minX, minZ, maxX, maxZ };
}

// 線分 ab 上で p に最も近い点までの距離の2乗と、その点のパラメータ t
export function closestOnSegment(px, pz, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az;
  const len2 = dx * dx + dz * dz;
  let t = len2 > 0 ? ((px - ax) * dx + (pz - az) * dz) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const cx = ax + dx * t, cz = az + dz * t;
  const ex = px - cx, ez = pz - cz;
  return { t, x: cx, z: cz, d2: ex * ex + ez * ez };
}

// 閉じたリングの終点重複を外す（[a,b,c,a] -> [a,b,c]）
export function openRing(ring) {
  const n = ring.length;
  if (n > 1 && ring[0][0] === ring[n - 1][0] && ring[0][1] === ring[n - 1][1]) return ring.slice(0, n - 1);
  return ring;
}

// ほぼ一直線の頂点・近すぎる頂点を取り除く。tol は線からのずれ（m）。
export function simplifyRing(ring, tol = 0.25) {
  let pts = openRing(ring).slice();
  // 近接点の除去
  const out = [];
  for (const p of pts) {
    const q = out[out.length - 1];
    if (!q || Math.hypot(p[0] - q[0], p[1] - q[1]) > 0.05) out.push(p);
  }
  if (out.length > 1) {
    const a = out[0], b = out[out.length - 1];
    if (Math.hypot(a[0] - b[0], a[1] - b[1]) <= 0.05) out.pop();
  }
  pts = out;
  let changed = true;
  while (changed && pts.length > 3) {
    changed = false;
    for (let i = 0; i < pts.length && pts.length > 3; i++) {
      const a = pts[(i - 1 + pts.length) % pts.length];
      const b = pts[i];
      const c = pts[(i + 1) % pts.length];
      const { d2 } = closestOnSegment(b[0], b[1], a[0], a[1], c[0], c[1]);
      if (d2 < tol * tol) {
        pts.splice(i, 1);
        changed = true;
        i--;
      }
    }
  }
  return pts;
}

export function isConvex(ring) {
  let sign = 0;
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    const a = ring[i], b = ring[(i + 1) % n], c = ring[(i + 2) % n];
    const cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
    if (Math.abs(cross) < 1e-9) continue;
    const s = Math.sign(cross);
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}

// Sutherland–Hodgman で矩形にクリップ（凹多角形でも描画用途なら十分）
export function clipRingToRect(ring, minX, minZ, maxX, maxZ) {
  const edges = [
    (p) => p[0] >= minX, (p) => p[0] <= maxX, (p) => p[1] >= minZ, (p) => p[1] <= maxZ,
  ];
  const intersect = [
    (a, b) => { const t = (minX - a[0]) / (b[0] - a[0]); return [minX, a[1] + t * (b[1] - a[1])]; },
    (a, b) => { const t = (maxX - a[0]) / (b[0] - a[0]); return [maxX, a[1] + t * (b[1] - a[1])]; },
    (a, b) => { const t = (minZ - a[1]) / (b[1] - a[1]); return [a[0] + t * (b[0] - a[0]), minZ]; },
    (a, b) => { const t = (maxZ - a[1]) / (b[1] - a[1]); return [a[0] + t * (b[0] - a[0]), maxZ]; },
  ];
  let output = openRing(ring);
  for (let k = 0; k < 4; k++) {
    const input = output;
    output = [];
    if (input.length === 0) break;
    for (let i = 0; i < input.length; i++) {
      const cur = input[i];
      const prev = input[(i - 1 + input.length) % input.length];
      const curIn = edges[k](cur), prevIn = edges[k](prev);
      if (curIn) {
        if (!prevIn) output.push(intersect[k](prev, cur));
        output.push(cur);
      } else if (prevIn) {
        output.push(intersect[k](prev, cur));
      }
    }
  }
  return output.length >= 3 ? output : [];
}

// 折れ線を矩形でクリップし、矩形内の部分折れ線の配列を返す
export function clipPolylineToRect(pts, minX, minZ, maxX, maxZ) {
  const inside = (p) => p[0] >= minX && p[0] <= maxX && p[1] >= minZ && p[1] <= maxZ;
  const parts = [];
  let cur = null;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    if (inside(p)) {
      if (!cur) {
        cur = [];
        if (i > 0) cur.push(segRectEntry(pts[i - 1], p, minX, minZ, maxX, maxZ));
      }
      cur.push(p);
    } else if (cur) {
      cur.push(segRectEntry(p, pts[i - 1], minX, minZ, maxX, maxZ));
      parts.push(cur);
      cur = null;
    }
  }
  if (cur && cur.length >= 2) parts.push(cur);
  return parts.filter((p) => p.length >= 2);
}

// out（矩形外）から inn（矩形内）へ向かう線分が矩形境界と交わる点
function segRectEntry(out, inn, minX, minZ, maxX, maxZ) {
  let t = 0;
  const dx = inn[0] - out[0], dz = inn[1] - out[1];
  if (out[0] < minX && dx !== 0) t = Math.max(t, (minX - out[0]) / dx);
  if (out[0] > maxX && dx !== 0) t = Math.max(t, (maxX - out[0]) / dx);
  if (out[1] < minZ && dz !== 0) t = Math.max(t, (minZ - out[1]) / dz);
  if (out[1] > maxZ && dz !== 0) t = Math.max(t, (maxZ - out[1]) / dz);
  return [out[0] + dx * t, out[1] + dz * t];
}

export function polylineLength(pts) {
  let len = 0;
  for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  return len;
}

// 決定的な疑似乱数（OSM id などから同じ見た目を再現するため）
export function hash01(n, salt = 0) {
  let h = (Math.imul((n | 0) ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(salt + 1, 0xc2b2ae35)) >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d) >>> 0;
  h ^= h >>> 15;
  h = Math.imul(h, 0x846ca68b) >>> 0;
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 空間ハッシュ（グリッド）。2D の点・線分・矩形をセル単位で登録して近傍検索する。
export class Grid {
  constructor(cellSize = 20) {
    this.size = cellSize;
    this.cells = new Map();
  }

  key(cx, cz) {
    return cx * 73856093 ^ cz * 19349663;
  }

  insertBounds(minX, minZ, maxX, maxZ, item) {
    const s = this.size;
    const x0 = Math.floor(minX / s), x1 = Math.floor(maxX / s);
    const z0 = Math.floor(minZ / s), z1 = Math.floor(maxZ / s);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cz = z0; cz <= z1; cz++) {
        const k = this.key(cx, cz);
        let cell = this.cells.get(k);
        if (!cell) this.cells.set(k, (cell = []));
        cell.push(item);
      }
    }
  }

  insertPoint(x, z, item) {
    this.insertBounds(x, z, x, z, item);
  }

  insertSegment(ax, az, bx, bz, item) {
    this.insertBounds(Math.min(ax, bx), Math.min(az, bz), Math.max(ax, bx), Math.max(az, bz), item);
  }

  // コールバックに近傍アイテムを渡す（重複あり得る）
  query(minX, minZ, maxX, maxZ, fn) {
    const s = this.size;
    const x0 = Math.floor(minX / s), x1 = Math.floor(maxX / s);
    const z0 = Math.floor(minZ / s), z1 = Math.floor(maxZ / s);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cz = z0; cz <= z1; cz++) {
        const cell = this.cells.get(this.key(cx, cz));
        if (cell) for (const it of cell) fn(it);
      }
    }
  }

  queryPoint(x, z, r, fn) {
    this.query(x - r, z - r, x + r, z + r, fn);
  }
}
