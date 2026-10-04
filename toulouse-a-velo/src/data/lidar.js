// IGN LiDAR HD（航空機からのレーザー測量）の標高データを Géoplateforme の WMS から取得する（Licence Ouverte）。
// - MNS（表面モデル）: 屋根・塔・木・橋を含む表面の高さ → 屋根の形、木、橋の高さに使う
// - MNT（地形モデル）: 地面の高さ → 地形（川岸の高低差など）に使う
// 値は 32bit 浮動小数（BIL 形式）で、緯度経度の格子（北が上）。

export const ELEVATION_WMS = 'https://data.geopf.fr/wms-r/wms';
export const LIDAR_LAYERS = {
  dsm: 'IGNF_LIDAR-HD_MNS_ELEVATION.ELEVATIONGRIDCOVERAGE.WGS84G',
  dtm: 'IGNF_LIDAR-HD_MNT_ELEVATION.ELEVATIONGRIDCOVERAGE.WGS84G',
};
const TILE = 1200; // 1 回のリクエストの最大ピクセル数（サーバーの上限は 5010）

function tileUrl(layer, south, west, north, east, w, h) {
  const p = new URLSearchParams({
    SERVICE: 'WMS', VERSION: '1.3.0', REQUEST: 'GetMap', LAYERS: layer, STYLES: '', CRS: 'EPSG:4326',
    BBOX: `${south},${west},${north},${east}`, WIDTH: String(w), HEIGHT: String(h), FORMAT: 'image/x-bil;bits=32',
  });
  return `${ELEVATION_WMS}?${p}`;
}

async function fetchTile(url, count, attempts = 4) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = await res.arrayBuffer();
      if (buf.byteLength !== count * 4) throw new Error(`サイズが違います（${buf.byteLength} バイト）`);
      return new Float32Array(buf);
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 1000 * (i + 1)));
    }
  }
  throw lastErr;
}

// bbox を cols × rows の格子で取得する。戻り値の data は北西の角から行ごと（行 0 = 北）
export async function fetchElevation(layer, bbox, cols, rows, { onProgress, concurrency = 3 } = {}) {
  const data = new Float32Array(cols * rows);
  const dLon = (bbox.e - bbox.w) / cols, dLat = (bbox.n - bbox.s) / rows;
  const tasks = [];
  for (let r0 = 0; r0 < rows; r0 += TILE) {
    for (let c0 = 0; c0 < cols; c0 += TILE) tasks.push([r0, c0, Math.min(rows, r0 + TILE), Math.min(cols, c0 + TILE)]);
  }
  let done = 0;
  const queue = tasks.slice();
  const worker = async () => {
    while (queue.length) {
      const [r0, c0, r1, c1] = queue.shift();
      const w = c1 - c0, h = r1 - r0;
      const url = tileUrl(layer, bbox.n - r1 * dLat, bbox.w + c0 * dLon, bbox.n - r0 * dLat, bbox.w + c1 * dLon, w, h);
      const tile = await fetchTile(url, w * h);
      for (let r = 0; r < h; r++) data.set(tile.subarray(r * w, (r + 1) * w), (r0 + r) * cols + c0);
      onProgress?.(++done / tasks.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, worker));
  fillNoData(data, cols, rows);
  return { data, cols, rows };
}

// 欠測値（-99999 など）を周囲の値で埋める
export function fillNoData(data, cols, rows) {
  let missing = 0;
  for (let i = 0; i < data.length; i++) {
    if (!(data[i] > -1000 && data[i] < 9000)) {
      data[i] = NaN;
      missing++;
    }
  }
  for (let pass = 0; pass < 50 && missing > 0; pass++) {
    missing = 0;
    const src = data.slice();
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const i = r * cols + c;
        if (!Number.isNaN(src[i])) continue;
        let s = 0, n = 0;
        for (const [dr, dc] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
          const rr = r + dr, cc = c + dc;
          if (rr < 0 || rr >= rows || cc < 0 || cc >= cols) continue;
          const v = src[rr * cols + cc];
          if (!Number.isNaN(v)) {
            s += v;
            n++;
          }
        }
        if (n) data[i] = s / n;
        else missing++;
      }
    }
  }
}

// 格子の高さをローカル座標（x = 東, z = 南）で双線形補間して引く
export class HeightGrid {
  // rect: 格子全体のローカル座標の範囲（bbox と同じ）、base: この値を引いて返す（地面を y ≈ 0 にするため）
  constructor({ data, cols, rows }, rect, base = 0) {
    this.data = data;
    this.cols = cols;
    this.rows = rows;
    this.minX = rect.minX;
    this.minZ = rect.minZ;
    this.dx = (rect.maxX - rect.minX) / cols;
    this.dz = (rect.maxZ - rect.minZ) / rows;
    this.base = base;
  }

  // 格子点の値（範囲外は端の値）
  at(c, r) {
    c = c < 0 ? 0 : c >= this.cols ? this.cols - 1 : c;
    r = r < 0 ? 0 : r >= this.rows ? this.rows - 1 : r;
    return this.data[r * this.cols + c] - this.base;
  }

  sample(x, z) {
    const u = (x - this.minX) / this.dx - 0.5, v = (z - this.minZ) / this.dz - 0.5;
    const c = Math.floor(u), r = Math.floor(v);
    const fu = u - c, fv = v - r;
    const a = this.at(c, r), b = this.at(c + 1, r), d = this.at(c, r + 1), e = this.at(c + 1, r + 1);
    return (a * (1 - fu) + b * fu) * (1 - fv) + (d * (1 - fu) + e * fu) * fv;
  }

  // (x, z) の周り radius m の最大値（屋根の端で道路の高さを拾わないため等）
  max(x, z, radius) {
    const c0 = Math.floor((x - radius - this.minX) / this.dx), c1 = Math.floor((x + radius - this.minX) / this.dx);
    const r0 = Math.floor((z - radius - this.minZ) / this.dz), r1 = Math.floor((z + radius - this.minZ) / this.dz);
    let m = -Infinity;
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) m = Math.max(m, this.at(c, r));
    return m;
  }
}

// エリアの大きさから格子の細かさを決める（1 辺 2400 点まで。最も細かくて DSM 0.5 m）
export function lidarResolution(rect) {
  const size = Math.max(rect.maxX - rect.minX, rect.maxZ - rect.minZ);
  const dsm = Math.max(0.5, Math.ceil((size / 2400) * 10) / 10);
  return { dsm, dtm: Math.max(1, dsm * 2) };
}

export async function fetchLidar(bbox, rect, { onStatus } = {}) {
  const res = lidarResolution(rect);
  const w = rect.maxX - rect.minX, h = rect.maxZ - rect.minZ;
  const grid = (r) => [Math.round(w / r), Math.round(h / r)];
  const [dc, dr] = grid(res.dsm), [tc, tr] = grid(res.dtm);
  let p1 = 0, p2 = 0;
  const report = () => onStatus?.((p1 * 0.8 + p2 * 0.2));
  const [dsm, dtm] = await Promise.all([
    fetchElevation(LIDAR_LAYERS.dsm, bbox, dc, dr, { onProgress: (p) => { p1 = p; report(); } }),
    fetchElevation(LIDAR_LAYERS.dtm, bbox, tc, tr, { onProgress: (p) => { p2 = p; report(); }, concurrency: 1 }),
  ]);
  return { dsm, dtm, res };
}
