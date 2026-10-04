// LiDAR の「表面の高さ − 地面の高さ」（樹冠の高さ）から、本物の木の位置・高さ・枝の広がりを見つける。
// 建物の上・橋の上・水の上は除く。街灯などの細い物は、周りの高さが続かないので除く。
// 建物は先に格子から消しておく（隣の高い屋根に負けて木が見つからないことがないように）。中庭の木は残る。
import { Grid } from '../geo.js';

export function detectTrees({ dsm, dtm, buildings, isExcluded = () => false, minHeight = 4 }) {
  const { cols, rows, dx, dz, minX, minZ } = dsm;
  const mnh = new Float32Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    const z = minZ + (r + 0.5) * dz;
    for (let c = 0; c < cols; c++) {
      const x = minX + (c + 0.5) * dx;
      mnh[r * cols + c] = dsm.data[r * cols + c] - dsm.base - dtm.sample(x, z);
    }
  }
  const mask = buildingMask(buildings, dsm);
  for (let i = 0; i < mnh.length; i++) if (mask[i]) mnh[i] = 0;
  const W = Math.max(2, Math.round(2.5 / dx)); // 極大を探す窓（±2.5 m）
  const cand = [];
  for (let r = W; r < rows - W; r++) {
    for (let c = W; c < cols - W; c++) {
      const h = mnh[r * cols + c];
      if (!(h > minHeight && h < 45)) continue;
      let isMax = true;
      for (let rr = r - W; rr <= r + W && isMax; rr++) {
        for (let cc = c - W; cc <= c + W; cc++) {
          if (mnh[rr * cols + cc] > h) {
            isMax = false;
            break;
          }
        }
      }
      if (isMax) cand.push([h, r, c]);
    }
  }
  cand.sort((a, b) => b[0] - a[0]);
  const out = [];
  const taken = new Grid(10);
  for (const [h, r, c] of cand) {
    const x = minX + (c + 0.5) * dx, z = minZ + (r + 0.5) * dz;
    // 枝の広がり: 8 方向に、高さが頂点の半分を切るまでの距離
    let sum = 0;
    const ds = [];
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2;
      let d = dx;
      while (d < 9) {
        const cc = Math.round(c + (Math.cos(a) * d) / dx), rr = Math.round(r + (Math.sin(a) * d) / dz);
        if (cc < 0 || rr < 0 || cc >= cols || rr >= rows || mnh[rr * cols + cc] < h * 0.5) break;
        d += dx;
      }
      sum += d;
      ds.push(d);
    }
    const radius = sum / 8;
    if (radius < 1.6) continue; // 街灯・標識など細い物
    // どの向きにも 3 m 以上の幅がある（建物の軒・塀などの細長い物を除く）
    if (Math.min(ds[0] + ds[4], ds[1] + ds[5], ds[2] + ds[6], ds[3] + ds[7]) < 3) continue;
    let near = false;
    taken.queryPoint(x, z, radius, (t) => {
      if (!near && Math.hypot(t.x - x, t.z - z) < Math.max(t.r, radius) * 0.75) near = true;
    });
    if (near || isExcluded(x, z)) continue;
    const tree = { x, z, y: dtm.sample(x, z), h, r: Math.min(radius, 9) };
    taken.insertPoint(x, z, tree);
    out.push(tree);
  }
  return out;
}

// 多角形（外形と穴）の内側にある格子のマスの番号ごとに fn を呼ぶ（走査線で塗る）
export function forEachCellIn(poly, { cols, rows, dx, dz, minX, minZ }, fn) {
  const rings = [poly.outer, ...(poly.holes || [])];
  const r0 = Math.max(0, Math.floor((poly.bounds.minZ - minZ) / dz)), r1 = Math.min(rows - 1, Math.ceil((poly.bounds.maxZ - minZ) / dz));
  for (let r = r0; r <= r1; r++) {
    const z = minZ + (r + 0.5) * dz;
    const xs = [];
    for (const ring of rings) {
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, zi] = ring[i], [xj, zj] = ring[j];
        if (zi > z !== zj > z) xs.push(xi + ((z - zi) / (zj - zi)) * (xj - xi));
      }
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const c0 = Math.max(0, Math.ceil((xs[k] - minX) / dx - 0.5)), c1 = Math.min(cols - 1, Math.floor((xs[k + 1] - minX) / dx - 0.5));
      for (let c = c0; c <= c1; c++) fn(r * cols + c);
    }
  }
}

// 建物の外形の内側（中庭は除く）の格子のマスを 1 にする。壁際も少し含める
export function buildingMask(buildings, grid) {
  const { cols, rows, dx } = grid;
  const mask = new Uint8Array(cols * rows);
  for (const b of buildings) forEachCellIn(b, grid, (i) => (mask[i] = 1));
  // 軒の出・外形と表面モデルのずれの分（約 1.5 m）広げる
  let cur = mask;
  for (let pass = 0; pass < Math.max(1, Math.round(1.5 / dx)); pass++) {
    const out = cur.slice();
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (!cur[r * cols + c]) continue;
        if (c > 0) out[r * cols + c - 1] = 1;
        if (c < cols - 1) out[r * cols + c + 1] = 1;
        if (r > 0) out[(r - 1) * cols + c] = 1;
        if (r < rows - 1) out[(r + 1) * cols + c] = 1;
      }
    }
    cur = out;
  }
  return cur;
}
