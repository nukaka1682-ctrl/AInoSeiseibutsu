// 道路ネットワーク: 「今いる通りの名前」「道路の上か」「目的地までのルート（A*）」を扱う。
import { Grid, closestOnSegment } from '../geo.js';

const NO_BIKE = new Set(['motorway', 'motorway_link', 'trunk', 'trunk_link', 'steps', 'bridleway']);
const COST = {
  cycleway: 0.75, residential: 1.0, living_street: 0.95, pedestrian: 1.0, tertiary: 1.05, unclassified: 1.0,
  secondary: 1.15, primary: 1.25, service: 1.15, footway: 1.15, path: 1.1, track: 1.2,
};

class MinHeap {
  constructor() {
    this.k = [];
    this.v = [];
  }
  get size() {
    return this.k.length;
  }
  push(key, val) {
    const k = this.k, v = this.v;
    let i = k.length;
    k.push(key);
    v.push(val);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[p] <= key) break;
      k[i] = k[p]; v[i] = v[p];
      i = p;
    }
    k[i] = key; v[i] = val;
  }
  pop() {
    const k = this.k, v = this.v;
    const top = v[0];
    const lk = k.pop(), lv = v.pop();
    if (k.length) {
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        let mk = lk;
        if (l < k.length && k[l] < mk) { m = l; mk = k[l]; }
        if (r < k.length && k[r] < mk) { m = r; mk = k[r]; }
        if (m === i) break;
        k[i] = k[m]; v[i] = v[m];
        i = m;
      }
      k[i] = lk; v[i] = lv;
    }
    return top;
  }
}

export class RoadNetwork {
  constructor(roads) {
    this.segs = [];
    this.segGrid = new Grid(15);
    this.nodeIdx = new Map();
    this.nx = [];
    this.nz = [];
    this.adj = [];
    this.nodeGrid = new Grid(25);
    this.maxHalfWidth = 0;
    for (const road of roads) {
      if (road.tunnel) continue;
      const bike = !NO_BIKE.has(road.type);
      this.maxHalfWidth = Math.max(this.maxHalfWidth, road.width / 2);
      for (let i = 0; i + 1 < road.pts.length; i++) {
        const a = road.pts[i], b = road.pts[i + 1];
        const s = { ax: a[0], az: a[1], bx: b[0], bz: b[1], road, bike };
        this.segGrid.insertSegment(a[0], a[1], b[0], b[1], this.segs.length);
        this.segs.push(s);
        if (bike) {
          const ia = this.node(road.nodeIds[i], a), ib = this.node(road.nodeIds[i + 1], b);
          const cost = Math.hypot(b[0] - a[0], b[1] - a[1]) * (COST[road.type] || 1.1);
          this.adj[ia].push(ib, cost);
          this.adj[ib].push(ia, cost);
        }
      }
    }
    this.maxHalfWidth = Math.min(this.maxHalfWidth, 20);
  }

  node(id, p) {
    let i = this.nodeIdx.get(id);
    if (i === undefined) {
      i = this.nx.length;
      this.nodeIdx.set(id, i);
      this.nx.push(p[0]);
      this.nz.push(p[1]);
      this.adj.push([]);
      this.nodeGrid.insertPoint(p[0], p[1], i);
    }
    return i;
  }

  // (x,z) に最も近い道路の線分
  nearestSegment(x, z, maxDist = 30, filter = null) {
    let best = null;
    const seen = new Set();
    this.segGrid.queryPoint(x, z, maxDist, (i) => {
      if (seen.has(i)) return;
      seen.add(i);
      const s = this.segs[i];
      if (filter && !filter(s)) return;
      const c = closestOnSegment(x, z, s.ax, s.az, s.bx, s.bz);
      if (c.d2 <= maxDist * maxDist && (!best || c.d2 < best.d2)) best = { seg: s, ...c };
    });
    return best;
  }

  onRoad(x, z, margin = 0.8) {
    let on = false;
    const seen = new Set();
    this.segGrid.queryPoint(x, z, this.maxHalfWidth + margin, (i) => {
      if (on || seen.has(i)) return;
      seen.add(i);
      const s = this.segs[i];
      const lim = s.road.width / 2 + margin;
      if (closestOnSegment(x, z, s.ax, s.az, s.bx, s.bz).d2 < lim * lim) on = true;
    });
    return on;
  }

  // 今いる通りの名前（道路の幅 + 少しの余裕の範囲で、一番近い名前付きの道）
  streetNameAt(x, z) {
    let best = null, bestD = Infinity;
    const seen = new Set();
    this.segGrid.queryPoint(x, z, 25, (i) => {
      if (seen.has(i)) return;
      seen.add(i);
      const s = this.segs[i];
      if (!s.road.name) return;
      const c = closestOnSegment(x, z, s.ax, s.az, s.bx, s.bz);
      const d = Math.sqrt(c.d2) - s.road.width / 2;
      if (d < 6 && d < bestD) {
        bestD = d;
        best = s.road;
      }
    });
    return best;
  }

  nearestNode(x, z) {
    for (const r of [30, 80, 200, 600]) {
      let best = -1, bestD = Infinity;
      this.nodeGrid.queryPoint(x, z, r, (i) => {
        if (!this.adj[i].length) return;
        const d = (this.nx[i] - x) ** 2 + (this.nz[i] - z) ** 2;
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      });
      if (best >= 0) return best;
    }
    return -1;
  }

  // A* で (ax,az) → (bx,bz) のルートを求める。戻り値: [[x,z], ...] または null
  route(ax, az, bx, bz) {
    const s = this.nearestNode(ax, az), t = this.nearestNode(bx, bz);
    if (s < 0 || t < 0) return null;
    if (s === t) return [[ax, az], [bx, bz]];
    const tx = this.nx[t], tz = this.nz[t];
    const g = new Map([[s, 0]]);
    const prev = new Map();
    const closed = new Set();
    const heap = new MinHeap();
    heap.push(Math.hypot(this.nx[s] - tx, this.nz[s] - tz) * 0.75, s);
    let iter = 0;
    while (heap.size && iter++ < 200000) {
      const u = heap.pop();
      if (u === t) break;
      if (closed.has(u)) continue;
      closed.add(u);
      const gu = g.get(u);
      const a = this.adj[u];
      for (let k = 0; k < a.length; k += 2) {
        const v = a[k];
        const nd = gu + a[k + 1];
        if (nd < (g.get(v) ?? Infinity)) {
          g.set(v, nd);
          prev.set(v, u);
          heap.push(nd + Math.hypot(this.nx[v] - tx, this.nz[v] - tz) * 0.75, v);
        }
      }
    }
    if (!prev.has(t)) return null;
    const path = [];
    for (let v = t; v !== undefined; v = prev.get(v)) {
      path.push([this.nx[v], this.nz[v]]);
      if (v === s) break;
    }
    path.reverse();
    return [[ax, az], ...path, [bx, bz]];
  }

  // 自転車で走れる道の上で (x,z) に最も近い点（リスポーン用）
  nearestRideablePoint(x, z, isOk = () => true) {
    for (const r of [20, 60, 150, 400, 1200]) {
      const best = this.nearestSegment(x, z, r, (s) => s.bike && !s.road.bridge && s.road.type !== 'service');
      if (best && isOk(best.x, best.z)) {
        const s = best.seg;
        return { x: best.x, z: best.z, heading: Math.atan2(s.bx - s.ax, -(s.bz - s.az)) };
      }
    }
    return null;
  }
}
