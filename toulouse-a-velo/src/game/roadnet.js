// 道路ネットワーク: 「今いる通りの名前」「道路の上か」「目的地までのルート（A*）」を扱う。
import { Grid, closestOnSegment } from '../geo.js';
import { segIntersect } from './collision.js';

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
    this.maxHalfWidth = 0;
    for (const road of roads) {
      if (road.tunnel) continue;
      const bike = !NO_BIKE.has(road.type);
      this.maxHalfWidth = Math.max(this.maxHalfWidth, road.width / 2);
      for (let i = 0; i + 1 < road.pts.length; i++) {
        const a = road.pts[i], b = road.pts[i + 1];
        const s = { ax: a[0], az: a[1], bx: b[0], bz: b[1], road, bike, ia: -1, ib: -1 };
        this.segGrid.insertSegment(a[0], a[1], b[0], b[1], this.segs.length);
        this.segs.push(s);
        if (bike) {
          const ia = this.node(road.nodeIds[i], a), ib = this.node(road.nodeIds[i + 1], b);
          const cost = Math.hypot(b[0] - a[0], b[1] - a[1]) * (COST[road.type] || 1.1);
          this.adj[ia].push(ib, cost);
          this.adj[ib].push(ia, cost);
          s.ia = ia;
          s.ib = ib;
        }
      }
    }
    this.maxHalfWidth = Math.min(this.maxHalfWidth, 20);
    this.labelComponents();
  }

  // つながっている道のまとまり（連結成分）を調べ、一番大きいものを「本線網」とする。
  // OSM には孤立した短い道（橋の歩道だけ、敷地内の通路など）があり、そこからはルートが引けないため
  labelComponents() {
    const n = this.nx.length;
    this.comp = new Int32Array(n).fill(-1);
    const sizes = [];
    for (let i = 0; i < n; i++) {
      if (this.comp[i] >= 0) continue;
      const c = sizes.length;
      let size = 0;
      const stack = [i];
      this.comp[i] = c;
      while (stack.length) {
        const u = stack.pop();
        size++;
        const a = this.adj[u];
        for (let k = 0; k < a.length; k += 2) {
          if (this.comp[a[k]] < 0) {
            this.comp[a[k]] = c;
            stack.push(a[k]);
          }
        }
      }
      sizes.push(size);
    }
    this.mainComp = sizes.length ? sizes.indexOf(Math.max(...sizes)) : -1;
  }

  node(id, p) {
    let i = this.nodeIdx.get(id);
    if (i === undefined) {
      i = this.nx.length;
      this.nodeIdx.set(id, i);
      this.nx.push(p[0]);
      this.nz.push(p[1]);
      this.adj.push([]);
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

  // (x,z) に一番近い、本線網（最大の連結成分）の自転車で走れる線分上の点
  snap(x, z) {
    for (const r of [30, 100, 300, 900]) {
      const s = this.nearestSegment(x, z, r, (q) => q.bike && this.comp[q.ia] === this.mainComp);
      if (s) return s;
    }
    return null;
  }

  // A* で (ax,az) → (bx,bz) のルートを求める。戻り値: [[x,z], ...] または null
  // 出発点・目的地は道路の線分上に吸着させ、線分の両端どちらからでも出入りできるようにする
  // （近い方の端だけを使うと、ルートが一度後ろへ戻る形になることがある）
  route(ax, az, bx, bz) {
    const s = this.snap(ax, az), t = this.snap(bx, bz);
    if (!s || !t) return null;
    if (s.seg === t.seg) return [[ax, az], [s.x, s.z], [t.x, t.z], [bx, bz]];
    const nd = (i, x, z) => Math.hypot(this.nx[i] - x, this.nz[i] - z);
    const goals = new Map([[t.seg.ia, nd(t.seg.ia, t.x, t.z)], [t.seg.ib, nd(t.seg.ib, t.x, t.z)]]);
    const h = (i) => nd(i, t.x, t.z) * 0.75;
    const g = new Map();
    const prev = new Map();
    const closed = new Set();
    const heap = new MinHeap();
    for (const i of [s.seg.ia, s.seg.ib]) {
      const g0 = nd(i, s.x, s.z);
      if (g0 < (g.get(i) ?? Infinity)) {
        g.set(i, g0);
        heap.push(g0 + h(i), i);
      }
    }
    let best = Infinity, bestNode = -1, iter = 0;
    while (heap.size && iter++ < 300000) {
      const key = heap.k[0];
      if (key >= best) break;
      const u = heap.pop();
      if (closed.has(u)) continue;
      closed.add(u);
      const gu = g.get(u);
      if (goals.has(u) && gu + goals.get(u) < best) {
        best = gu + goals.get(u);
        bestNode = u;
      }
      const a = this.adj[u];
      for (let k = 0; k < a.length; k += 2) {
        const v = a[k];
        const d = gu + a[k + 1];
        if (d < (g.get(v) ?? Infinity)) {
          g.set(v, d);
          prev.set(v, u);
          heap.push(d + h(v), v);
        }
      }
    }
    if (bestNode < 0) return null;
    const path = [];
    for (let v = bestNode; v !== undefined; v = prev.get(v)) path.push([this.nx[v], this.nz[v]]);
    path.reverse();
    return [[ax, az], [s.x, s.z], ...path, [t.x, t.z], [bx, bz]];
  }

  // 線分 a→b が、自転車で走れる道の中心線と交差するか（建物の壁を道が横切っている = 通路）
  crossesRoad(ax, az, bx, bz) {
    let hit = false;
    this.segGrid.query(Math.min(ax, bx), Math.min(az, bz), Math.max(ax, bx), Math.max(az, bz), (i) => {
      if (hit) return;
      const s = this.segs[i];
      if (s.bike && segIntersect(ax, az, bx, bz, s.ax, s.az, s.bx, s.bz) !== null) hit = true;
    });
    return hit;
  }

  // 名所に近づくための地点: 近くの道のうち、行き止まりや私道っぽい道より、開けた公道を優先する
  approachPoint(x, z, maxDist = 200) {
    let best = null;
    const seen = new Set();
    const deg = (n) => this.adj[n].length / 2;
    this.segGrid.queryPoint(x, z, maxDist, (i) => {
      if (seen.has(i)) return;
      seen.add(i);
      const s = this.segs[i];
      if (!s.bike || this.comp[s.ia] !== this.mainComp) return;
      const c = closestOnSegment(x, z, s.ax, s.az, s.bx, s.bz);
      const d = Math.sqrt(c.d2);
      if (d > maxDist) return;
      let score = d;
      if (s.road.type === 'living_street' || s.road.type === 'service' || s.road.type === 'track') score += 25;
      if (deg(s.ia) === 1 || deg(s.ib) === 1) score += 30; // 行き止まり
      if (!best || score < best.score) best = { x: c.x, z: c.z, score, seg: s };
    });
    return best;
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
