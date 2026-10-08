// 傾斜屋根の形を作る。重み付きストレートスケルトン（straight skeleton）で、どんな形の建物
// （凹んだ形・L 字・T 字・中庭の穴あり）にも寄棟・切妻の瓦屋根をかける。three.js の描画には依存しない（Node のテストから使える）。
//
// しくみ: 外形の各辺を、辺ごとの重みに比例した速さで内側へ平行移動させる（波面）。辺どうしがぶつかった所が
// 棟・隅棟・谷になり、各辺が掃いた領域がその辺の屋根面になる。
//   重み 1: 辺から屋根面が上る（軒）
//   重み 0: 辺は動かない → 屋根面は垂直になる（切妻の三角の壁）。隣の建物と接する壁に使うと、
//           細長い町家の棟が通りと平行に通り、両隣との境に切妻の壁が立つ
// 屋根の高さ = 勾配 × 進んだ距離（時刻）。上限（IGN の屋根の高さ）に達したら、そこから上は平ら（terrasson）にする。
//
// 地籍由来の外形には、細いとげ・ほぼ一直線の頂点・接する頂点などの乱れがあるので、先に整え（cleanRing）、
// 計算の結果を確かめ（面ごとの平面性・面積の合計）、おかしければ null を返す（呼び出し側で陸屋根にする）。
import { Earcut } from 'three/src/extras/Earcut.js';

// Math.hypot は遅いので 2 次元の長さはこれで
const len2 = (x, z) => Math.sqrt(x * x + z * z);

const EPS_T = 1e-9; // 時刻の誤差
const EPS_D = 1e-7; // 距離の誤差（m）

// ---------------------------------------------------------------- 外形を整える
// 近すぎる頂点（minLen m 未満）、ほぼ一直線の頂点（線からのずれ 1 cm 未満）、細いとげ（折り返しの角度 spikeDeg 度未満）を除く。
// 頂点を間引くだけで動かさないので、壁の外形にもそのまま使える。3 頂点未満・面積 0.5 m² 未満になれば null
export function cleanRing(ring, { minLen = 0.05, spikeDeg = 4 } = {}) {
  let pts = [];
  for (const p of ring) {
    const q = pts[pts.length - 1];
    if (!q || len2(p[0] - q[0], p[1] - q[1]) >= minLen) pts.push(p);
  }
  while (pts.length > 1 && len2(pts[0][0] - pts[pts.length - 1][0], pts[0][1] - pts[pts.length - 1][1]) < minLen) pts.pop();
  const cosSpike = Math.cos((spikeDeg * Math.PI) / 180);
  let changed = true;
  while (changed && pts.length >= 3) {
    changed = false;
    for (let i = 0; i < pts.length && pts.length >= 3; i++) {
      const a = pts[(i - 1 + pts.length) % pts.length], b = pts[i], c = pts[(i + 1) % pts.length];
      const ux = a[0] - b[0], uz = a[1] - b[1], vx = c[0] - b[0], vz = c[1] - b[1];
      const lu = len2(ux, uz), lv = len2(vx, vz);
      let drop = lu < minLen || lv < minLen;
      if (!drop) {
        const cos = (ux * vx + uz * vz) / (lu * lv);
        const acx = c[0] - a[0], acz = c[1] - a[1], lac = len2(acx, acz);
        const dev = lac > 1e-9 ? Math.abs(acx * (b[1] - a[1]) - acz * (b[0] - a[0])) / lac : lu;
        drop = cos > cosSpike || (cos < 0 && dev < 0.01); // とげ、または一直線
      }
      if (drop) {
        pts.splice(i, 1);
        changed = true;
        i--;
      }
    }
  }
  if (pts.length < 3 || Math.abs(ringArea(pts)) < 0.5) return null;
  return pts;
}

export function ringArea(ring) {
  let a = 0;
  for (let i = 0, n = ring.length, j = n - 1; i < n; j = i++) a += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  return a / 2;
}

// 外形と穴の辺が、隣どうし以外で交わったり接したりしていないか（自己交差のある外形はスケルトンが壊れる）
export function ringsSimple(rings) {
  const segs = [];
  rings.forEach((r, ri) => r.forEach((p, i) => segs.push({ ri, i, n: r.length, a: p, b: r[(i + 1) % r.length] })));
  const cross = (o, p, q) => (p[0] - o[0]) * (q[1] - o[1]) - (p[1] - o[1]) * (q[0] - o[0]);
  // 点 p が辺 q0–q1 の上にある（d: 辺の直線からのずれ × 長さ、e: 許容）
  const on = (p, q0, q1, d, e) => Math.abs(d) <= e && (p[0] - q0[0]) * (p[0] - q1[0]) + (p[1] - q0[1]) * (p[1] - q1[1]) <= 0;
  for (let s = 0; s < segs.length; s++) {
    const A = segs[s];
    const minX = Math.min(A.a[0], A.b[0]), maxX = Math.max(A.a[0], A.b[0]), minZ = Math.min(A.a[1], A.b[1]), maxZ = Math.max(A.a[1], A.b[1]);
    for (let t = s + 1; t < segs.length; t++) {
      const B = segs[t];
      if (Math.max(B.a[0], B.b[0]) < minX - 1e-6 || Math.min(B.a[0], B.b[0]) > maxX + 1e-6 ||
          Math.max(B.a[1], B.b[1]) < minZ - 1e-6 || Math.min(B.a[1], B.b[1]) > maxZ + 1e-6) continue;
      if (A.ri === B.ri && (B.i === (A.i + 1) % A.n || A.i === (B.i + 1) % B.n)) continue; // 隣の辺（頂点を共有）
      const d1 = cross(A.a, A.b, B.a), d2 = cross(A.a, A.b, B.b), d3 = cross(B.a, B.b, A.a), d4 = cross(B.a, B.b, A.b);
      const la = len2(A.b[0] - A.a[0], A.b[1] - A.a[1]), lb = len2(B.b[0] - B.a[0], B.b[1] - B.a[1]);
      const e1 = 1e-4 * la, e2 = 1e-4 * lb; // 1e-4 m 程度まで近づいたら「接している」とみなす
      if (((d1 > e1 && d2 < -e1) || (d1 < -e1 && d2 > e1)) && ((d3 > e2 && d4 < -e2) || (d3 < -e2 && d4 > e2))) return false;
      // 接触（端点が相手の辺の上）
      if (on(B.a, A.a, A.b, d1, e1) || on(B.b, A.a, A.b, d2, e1) || on(A.a, B.a, B.b, d3, e2) || on(A.b, B.a, B.b, d4, e2)) return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------- 重み付きストレートスケルトン（波面の模擬）
// rings: 内側が左になる向き（外周は反時計回り、穴は時計回り。x 右・z 上の数学の向き）にそろえた輪。
// weights: 輪ごと・辺ごとの重み。tStop: この時刻で止め、残った波面を平らな上面にする。
// 返り値: { nodes: [[x, z, t]], fseg: 面ごとの境界の線分, edges: 元の辺, tops: 平らな上面の節点の輪, maxT } または null（失敗）
function simulate(rings, weights, tStop) {
  const E = []; // 元の辺: { ax, az, dx, dz, nx, nz, c, w, s, e }（s, e: 始点・終点の節点）
  const nodes = [];
  // 面ごとの境界の線分 [a, b, a, b, ...]（面 = 辺の番号、平らな上面は E.length 以上）
  const fseg = [];
  const seg = (f, a, b) => {
    const l = fseg[f];
    if (l) l.push(a, b);
    else fseg[f] = [a, b];
  };
  // 頂点の軌跡など（節点 a–b）: 両側の面の境界になる。同じ辺の 2 つの部分の間の線は面の内側なので除く
  const arc = (a, b, f1, f2) => {
    if (f1 === f2) return;
    seg(f1, a, b);
    seg(f2, a, b);
  };
  const verts = [];
  const node = (x, z, t) => nodes.push([x, z, t]) - 1;
  let degenerate = false;

  const setVelocity = (v) => {
    const a = E[v.eL], b = E[v.eR];
    const det = a.nx * b.nz - a.nz * b.nx; // = 辺の向きの外積（負なら右折 = 内角 180° 超）
    const dot = a.nx * b.nx + a.nz * b.nz;
    v.anti = false;
    v.reflex = det < -1e-9;
    // 重みの違う辺がほぼ平行に並ぶと、間の頂点は無限に近い速さで動く（重み付きスケルトンの決まらない場合）。
    // 計算をやめ、呼び出し側で重みをそろえて作り直す
    if (dot > 0 && Math.abs(det) < 0.02 && a.w !== b.w) degenerate = true;
    if (Math.abs(det) < 1e-7) {
      if (dot > 0) {
        // 一直線（同じ向き）: 辺の法線方向へ
        const w = (a.w + b.w) / 2;
        const nx = a.nx + b.nx, nz = a.nz + b.nz, l = len2(nx, nz) || 1;
        v.vx = (nx / l) * w;
        v.vz = (nz / l) * w;
      } else {
        // 向かい合う辺が重なっている（幅 0）: settle() で閉じる
        v.vx = v.vz = 0;
        v.anti = true;
      }
      v.reflex = false;
      return;
    }
    v.vx = (a.w * b.nz - a.nz * b.w) / det;
    v.vz = (a.nx * b.w - a.w * b.nx) / det;
  };
  const vertex = (x, z, t, eL, eR, nd) => {
    // et: 辺 v → v.next が消える時刻（etN: そのときの v.next）、st: 凹んだ角がぶつかる時刻（su → sw の辺）
    const v = { x, z, t, eL, eR, node: nd, alive: true, prev: null, next: null, vx: 0, vz: 0, anti: false, reflex: false, et: Infinity, etN: null, st: Infinity, su: undefined, sw: null };
    setVelocity(v);
    verts.push(v);
    return v;
  };
  const px = (v, T) => v.x + v.vx * (T - v.t);
  const pz = (v, T) => v.z + v.vz * (T - v.t);
  const fresh = []; // 前回の出来事の後に変わった辺（a → a.next）
  const link = (a, b) => {
    a.next = b;
    b.prev = a;
    fresh.push(a);
  };
  const endAt = (v, nd) => {
    arc(v.node, nd, v.eL, v.eR);
    v.alive = false;
  };

  // 元の輪
  for (let r = 0; r < rings.length; r++) {
    const ring = rings[r], n = ring.length, base = E.length;
    const ids = ring.map(([x, z]) => node(x, z, 0));
    for (let i = 0; i < n; i++) {
      const a = ring[i], b = ring[(i + 1) % n];
      const L = len2(b[0] - a[0], b[1] - a[1]);
      const dx = (b[0] - a[0]) / L, dz = (b[1] - a[1]) / L;
      const nx = -dz, nz = dx; // 内向きの法線（左）
      E.push({ ax: a[0], az: a[1], dx, dz, nx, nz, c: nx * a[0] + nz * a[1], w: weights[r][i], s: ids[i], e: ids[(i + 1) % n] });
      seg(base + i, ids[i], ids[(i + 1) % n]);
    }
    const vs = ring.map(([x, z], i) => vertex(x, z, 0, base + ((i - 1 + n) % n), base + i, ids[i]));
    for (let i = 0; i < n; i++) link(vs[i], vs[(i + 1) % n]);
  }

  // 新しい頂点の後始末: 2 頂点以下の輪は線分に縮んで消え、向かい合う辺が重なる頂点は近い方の頂点まで一気に閉じる
  const settle = (x, t) => {
    for (let guard = 0; guard < 10000; guard++) {
      if (!x.alive) return;
      if (x.next === x) {
        x.alive = false;
        return;
      }
      if (x.next.next === x) {
        const y = x.next;
        const Q = node(px(y, t), pz(y, t), t);
        endAt(y, Q);
        arc(x.node, Q, x.eL, x.eR);
        x.alive = false;
        return;
      }
      if (!x.anti) return;
      const a = x.prev, b = x.next;
      const ax = px(a, t), az = pz(a, t), bx = px(b, t), bz = pz(b, t);
      const da = len2(ax - x.x, az - x.z), db = len2(bx - x.x, bz - x.z);
      let y;
      if (db <= da) {
        const Q = node(bx, bz, t);
        endAt(b, Q);
        arc(x.node, Q, x.eL, x.eR);
        x.alive = false;
        y = vertex(bx, bz, t, x.eL, b.eR, Q);
        link(a, y);
        link(y, b.next);
      } else {
        const Q = node(ax, az, t);
        endAt(a, Q);
        arc(x.node, Q, x.eL, x.eR);
        x.alive = false;
        y = vertex(ax, az, t, a.eL, x.eR, Q);
        link(a.prev, y);
        link(y, b);
      }
      x = y;
    }
  };
  for (const v of verts.slice()) settle(v, 0);

  // 凹んだ角 v が辺 u → u.next にぶつかる時刻（ぶつからなければ Infinity）
  const splitTime = (v, u, now) => {
    if (u === v || u === v.prev) return Infinity;
    const k = u.eR;
    if (k === v.eL || k === v.eR) return Infinity;
    const e = E[k];
    const vx0 = px(v, now), vz0 = pz(v, now);
    const f = e.nx * vx0 + e.nz * vz0 - e.c - e.w * now; // 辺の波面からの距離（内側が正）
    const closing = e.w - (e.nx * v.vx + e.nz * v.vz);
    if (closing <= 1e-12 || f < -1e-6) return Infinity;
    const t = now + Math.max(0, f) / closing;
    const w = u.next;
    const hx = vx0 + v.vx * (t - now), hz = vz0 + v.vz * (t - now);
    const ux = px(u, t), uz = pz(u, t);
    const L = e.dx * (px(w, t) - ux) + e.dz * (pz(w, t) - uz);
    if (L <= EPS_D) return Infinity; // 消えかけの辺（edge event に任せる）
    const s = e.dx * (hx - ux) + e.dz * (hz - uz);
    return s < -1e-6 || s > L + 1e-6 ? Infinity : t;
  };
  // 次に起きる出来事: 辺が長さ 0 になる（edge event）か、凹んだ角が向かいの辺にぶつかる（split event）。
  // 頂点は作ったあと動き方が変わらないので、頂点ごとに候補を覚えておき、変わった辺の分だけ調べ直す
  const nextEvent = (alive, now) => {
    for (const v of alive) {
      if (v.etN === v.next) continue;
      const n = v.next, e = E[v.eR];
      const len = e.dx * (px(n, now) - px(v, now)) + e.dz * (pz(n, now) - pz(v, now));
      const rate = e.dx * (n.vx - v.vx) + e.dz * (n.vz - v.vz);
      v.et = len <= EPS_D ? now : rate < -1e-12 ? now + len / -rate : Infinity;
      v.etN = n;
    }
    for (const v of alive) {
      if (!v.reflex) continue;
      const lost = v.su === undefined || (v.su && (!v.su.alive || !v.sw.alive || v.su.next !== v.sw));
      const cands = lost ? alive : fresh;
      if (lost) {
        v.st = Infinity;
        v.su = v.sw = null;
      }
      for (const u of cands) {
        if (!u.alive) continue;
        const t = splitTime(v, u, now);
        if (t < v.st) {
          v.st = t;
          v.su = u;
          v.sw = u.next;
        }
      }
    }
    fresh.length = 0;
    let best = null, bt = Infinity;
    for (const v of alive) {
      if (v.et < bt) {
        bt = v.et;
        best = v;
      }
    }
    let sv = null, st = Infinity;
    for (const v of alive) {
      if (v.reflex && v.st < st) {
        st = v.st;
        sv = v;
      }
    }
    if (sv && st < bt - EPS_T) return { type: 'split', v: sv, u: sv.su, t: st }; // 同時なら edge event を先に
    return best ? { type: 'edge', v: best, t: bt } : null;
  };

  let now = 0;
  const maxIter = 64 + verts.length * 12;
  let iter = 0;
  const alive = [];
  const refresh = () => {
    alive.length = 0;
    for (const v of verts) if (v.alive) alive.push(v);
  };
  refresh();
  let stopAt = null;
  while (alive.length) {
    if (++iter > maxIter || degenerate) return null;
    const ev = nextEvent(alive, now);
    if (!ev || ev.t > tStop) {
      stopAt = ev ? tStop : now; // 動かない輪（重み 0 の辺だけ）が残ったら、いまの高さで閉じる
      break;
    }
    now = Math.max(now, ev.t);
    if (ev.type === 'edge') {
      const v = ev.v, n = v.next;
      const P = node((px(v, now) + px(n, now)) / 2, (pz(v, now) + pz(n, now)) / 2, now);
      endAt(v, P);
      endAt(n, P);
      if (n.next !== v) {
        const [x, z] = nodes[P];
        const m = vertex(x, z, now, v.eL, n.eR, P);
        link(v.prev, m);
        link(m, n.next);
        settle(m, now);
      }
    } else {
      const { v, u } = ev, w = u.next, k = u.eR;
      const P = node(px(v, now), pz(v, now), now);
      const [x, z] = nodes[P];
      endAt(v, P);
      const v1 = vertex(x, z, now, v.eL, k, P), v2 = vertex(x, z, now, k, v.eR, P);
      const vp = v.prev, vn = v.next;
      link(vp, v1);
      link(v1, w);
      link(u, v2);
      link(v2, vn);
      settle(v1, now);
      settle(v2, now);
    }
    refresh();
  }

  if (degenerate) return null;
  // 残った波面 = 平らな上面
  const tops = [];
  if (stopAt != null) {
    const seen = new Set();
    for (const v of alive) {
      if (seen.has(v)) continue;
      const loop = [];
      let x = v;
      do {
        seen.add(x);
        loop.push(x);
        x = x.next;
      } while (x !== v && loop.length <= alive.length);
      if (x !== v) return null;
      const top = E.length + tops.length;
      const ids = loop.map((q) => node(px(q, stopAt), pz(q, stopAt), stopAt));
      loop.forEach((q, i) => {
        endAt(q, ids[i]);
        arc(ids[i], ids[(i + 1) % ids.length], q.eR, top);
      });
      tops.push(ids);
    }
  }
  let maxT = 0;
  for (const nd of nodes) maxT = Math.max(maxT, nd[2]);
  return { nodes, fseg, edges: E, tops, maxT };
}

// 面ごとの境界の線分をつないで多角形（節点の列）にする。各節点の次数が 2 でなければ失敗
// segs: [a0, b0, a1, b1, ...]（節点の番号の組）。start: 最初にたどる線分 [a, b]（元の辺。面が左にくる向き）
// nb: 節点ごとの隣の節点 2 つと印を入れる作業用の配列（建物・面ごとに使い回し、使った所だけ -1 に戻す）
let nbBuf = new Int32Array(3 * 256).fill(-1);
function faceCycles(segs, start, nb) {
  const touched = [];
  let ok = true;
  const add = (p, q) => {
    const o = p * 3;
    if (nb[o] < 0) {
      nb[o] = q;
      touched.push(p);
    } else if (nb[o + 1] < 0) nb[o + 1] = q;
    else ok = false; // 次数 3 以上
  };
  for (let i = 0; i < segs.length && ok; i += 2) {
    const a = segs[i], b = segs[i + 1];
    if (a === b) continue;
    add(a, b);
    add(b, a);
  }
  for (const p of touched) if (nb[p * 3 + 1] < 0) ok = false;
  const cycles = [];
  const walk = (a, b) => {
    const cyc = [a];
    nb[a * 3 + 2] = 1;
    let p = a, c = b;
    while (c !== a) {
      if (nb[c * 3 + 2] > 0) return null; // 8 の字（自分に接する境界）
      nb[c * 3 + 2] = 1;
      cyc.push(c);
      const nx = nb[c * 3] === p ? nb[c * 3 + 1] : nb[c * 3];
      p = c;
      c = nx;
    }
    return cyc;
  };
  if (ok) {
    const first = walk(start[0], start[1]);
    if (first) {
      cycles.push(first);
      for (const a of touched) {
        if (nb[a * 3 + 2] > 0) continue;
        const c = walk(a, nb[a * 3]);
        if (!c) {
          ok = false;
          break;
        }
        cycles.push(c);
      }
    } else ok = false;
  }
  for (const p of touched) nb.fill(-1, p * 3, p * 3 + 3);
  return ok ? cycles : null;
}

function polyArea2(pts) {
  let a = 0;
  for (let i = 0, n = pts.length, j = n - 1; i < n; j = i++) a += pts[j][0] * pts[i][1] - pts[i][0] * pts[j][1];
  return a / 2;
}

function earcutTris(pts2, holes2 = []) {
  const flat = [];
  const holeIdx = [];
  for (const p of pts2) flat.push(p[0], p[1]);
  for (const h of holes2) {
    holeIdx.push(flat.length / 2);
    for (const p of h) flat.push(p[0], p[1]);
  }
  return Earcut.triangulate(flat, holeIdx);
}

// 連続する同じ位置の節点を 1 つにまとめる
function dedupe(cyc, nodes) {
  const out = [];
  for (const id of cyc) {
    const q = out[out.length - 1];
    if (q != null && len2(nodes[q][0] - nodes[id][0], nodes[q][1] - nodes[id][1]) < 1e-7 && Math.abs(nodes[q][2] - nodes[id][2]) < 1e-7) continue;
    out.push(id);
  }
  while (out.length > 1) {
    const a = nodes[out[0]], b = nodes[out[out.length - 1]];
    if (len2(a[0] - b[0], a[1] - b[1]) < 1e-7 && Math.abs(a[2] - b[2]) < 1e-7) out.pop();
    else break;
  }
  return out;
}

/**
 * 屋根を作る。
 * @param {number[][]} outer 外周 [[x, z], ...]（向きは問わない。cleanRing 済みを推奨）
 * @param {number[][][]} holes 穴（中庭）
 * @param {object} opt
 *   weights: [[外周の辺の重み], [穴 1 の辺の重み], ...]（省略時はすべて 1 = 寄棟）。i 番目の辺は頂点 i → i+1
 *   height: 屋根の高さ（m、軒から）。分かっていれば、勾配 = height / 最も奥まで進んだ距離 を minSlope〜maxSlope に収める
 *   slope: height が分からないときの勾配、maxHeight: そのときの高さの上限
 * @returns {null | {
 *   slope, height,                       // 実際の勾配と、屋根の最も高い所（軒から m）
 *   reach,                               // 軒から最も奥（棟）までの水平距離（m）。height / reach が屋根全体を覆う勾配
 *   roof: number[],                      // 傾いた屋根面の三角形 [x, y, z] × 3 を並べたもの（y は軒からの高さ）
 *   top: number[],                       // 上限で平らになった上面の三角形（同じ並び）
 *   gables: { ring, edge, a, b, pts: [[s, y]] }[], // 重み 0 の辺の垂直な壁（辺 a→b に沿った距離 s と高さ y の多角形）
 *   unweighted?: true                    // 重み付きでは作れず、すべて寄棟にした
 * }}
 */
export function buildRoof(outer, holes = [], opt = {}) {
  const roof = buildRoofWith(outer, holes, opt);
  // 切妻（重み 0）があると決まらない形（重みの違う辺が平行に並ぶなど）では、すべて寄棟にして作り直す
  if (!roof && opt.weights?.some((w) => w.some((x) => !(x > 0)))) {
    const hipped = buildRoofWith(outer, holes, { ...opt, weights: null });
    if (hipped) hipped.unweighted = true;
    return hipped;
  }
  return roof;
}

function buildRoofWith(outer, holes, opt) {
  const { minSlope = 0.25, maxSlope = 0.45, slope: defSlope = 0.36, maxHeight = 4 } = opt;
  // 原点を外周の最初の点に移す（大きな座標での桁落ちを防ぐ）
  const ox = outer[0][0], oz = outer[0][1];
  const rawRings = [outer, ...holes];
  const rawWeights = rawRings.map((r, ri) => r.map((_, i) => Math.max(0, opt.weights?.[ri]?.[i] ?? 1)));
  // 内側が左になる向きにそろえる（外周は面積が正、穴は負）
  const rings = [], weights = [], flips = [];
  for (let ri = 0; ri < rawRings.length; ri++) {
    const r = rawRings[ri].map(([x, z]) => [x - ox, z - oz]);
    const a = ringArea(r);
    if (Math.abs(a) < 1e-6 || r.length < 3) return null;
    const flip = ri === 0 ? a < 0 : a > 0;
    flips.push(flip);
    if (flip) {
      // 頂点を逆順にすると、辺 i（i → i+1）は辺 n-2-i になる
      const n = r.length;
      rings.push(r.slice().reverse());
      weights.push(r.map((_, i) => rawWeights[ri][(n - 2 - i + n) % n]));
    } else {
      rings.push(r);
      weights.push(rawWeights[ri].slice());
    }
  }
  // ほぼ一直線に続く辺どうしは重みをそろえる（重みの違う平行な辺の間の頂点は無限の速さになる）
  for (let ri = 0; ri < rings.length; ri++) {
    const r = rings[ri], w = weights[ri], n = r.length;
    for (let i = 0; i < n; i++) {
      const a = r[i], b = r[(i + 1) % n], c = r[(i + 2) % n];
      const l1 = len2(b[0] - a[0], b[1] - a[1]), l2 = len2(c[0] - b[0], c[1] - b[1]);
      const cr = ((b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0])) / (l1 * l2);
      const dt = ((b[0] - a[0]) * (c[0] - b[0]) + (b[1] - a[1]) * (c[1] - b[1])) / (l1 * l2);
      if (dt > 0 && Math.abs(cr) < 0.05 && w[i] !== w[(i + 1) % n]) {
        const keep = l1 >= l2 ? w[i] : w[(i + 1) % n];
        w[i] = w[(i + 1) % n] = keep;
      }
    }
  }
  // 重みがすべて 0（四方を高い建物に囲まれている）なら寄棟にする
  if (!weights.some((w) => w.some((x) => x > 0))) for (const w of weights) w.fill(1);

  let sk = simulate(rings, weights, Infinity);
  if (!sk || !(sk.maxT > 0)) return null;
  const reach = sk.maxT; // 軒から最も奥まで進んだ水平距離（m）
  let slope, cap;
  if (opt.height > 0) {
    slope = Math.min(maxSlope, Math.max(minSlope, opt.height / sk.maxT));
    cap = opt.height;
  } else {
    slope = defSlope;
    cap = maxHeight;
  }
  if (slope * sk.maxT > cap + 1e-6) {
    sk = simulate(rings, weights, cap / slope);
    if (!sk) return null;
  }
  const { nodes, fseg, edges: E, tops } = sk;

  // 三角形の頂点を [x, y, z, x, y, z, x, y, z, ...] に並べる（y は軒からの高さ）
  const roof = [], top = [], gables = [];
  const put = (id) => {
    const nd = nodes[id];
    roof.push(nd[0] + ox, nd[2] * slope, nd[1] + oz);
  };
  let area = 0;
  let footprint = 0;
  for (const r of rings) footprint += ringArea(r);
  const tolPlane = 0.02;
  if (nbBuf.length < nodes.length * 3) nbBuf = new Int32Array(nodes.length * 6).fill(-1);
  const nb = nbBuf;
  // 辺ごとの屋根面
  let ri = 0, ringStart = 0;
  for (let k = 0; k < E.length; k++) {
    while (k >= ringStart + rings[ri].length) ringStart += rings[ri++].length;
    const e = E[k];
    const cycles = faceCycles(fseg[k], [e.s, e.e], nb);
    if (!cycles) return null;
    for (const raw of cycles) {
      const cyc = dedupe(raw, nodes);
      if (cyc.length < 3) continue;
      // 平面にのっているか（辺の波面の上: n·p = c + w t）
      for (const id of cyc) {
        const nd = nodes[id];
        if (Math.abs(e.nx * nd[0] + e.nz * nd[1] - e.c - e.w * nd[2]) > tolPlane) return null;
      }
      if (e.w > 0) {
        // 面積（反時計回りなら正）と、凸かどうか
        const m = cyc.length;
        let a = 0, convex = true;
        for (let i = 0; i < m; i++) {
          const p = nodes[cyc[i]], q = nodes[cyc[(i + 1) % m]], r = nodes[cyc[(i + 2) % m]];
          a += p[0] * q[1] - q[0] * p[1];
          if ((q[0] - p[0]) * (r[1] - q[1]) - (q[1] - p[1]) * (r[0] - q[0]) < -1e-9) convex = false;
        }
        a /= 2;
        if (a < -1e-3) return null;
        area += a;
        if (convex) {
          // 凸な面は扇形に分ける（三角形・台形が大半）
          for (let i = 1; i + 1 < m; i++) {
            put(cyc[0]);
            put(cyc[i]);
            put(cyc[i + 1]);
          }
          continue;
        }
        for (const q of earcutTris(cyc.map((id) => nodes[id]))) put(cyc[q]);
      } else {
        // 垂直な切妻の壁: 辺に沿った距離 s と高さ y
        const pts = cyc.map((id) => [e.dx * (nodes[id][0] - e.ax) + e.dz * (nodes[id][1] - e.az), nodes[id][2] * slope]);
        if (Math.abs(polyArea2(pts)) < 1e-4) continue;
        // 元の向きの辺に戻す
        const i = k - ringStart, n = rings[ri].length;
        const edge = flips[ri] ? (n - 2 - i + n) % n : i;
        const raw2 = rawRings[ri];
        const a = raw2[edge], b = raw2[(edge + 1) % n];
        const L = len2(b[0] - a[0], b[1] - a[1]);
        gables.push({ ring: ri, edge, a, b, pts: flips[ri] ? pts.map(([s, y]) => [L - s, y]) : pts });
      }
    }
  }
  // 平らな上面（穴になる輪は、それを囲む輪の穴にする）
  const topH = tops.length ? Math.min(cap, sk.maxT * slope) : 0;
  const loops = tops.map((ids, ti) => {
    if ((fseg[E.length + ti]?.length || 0) !== ids.length * 2) return null;
    const cyc = dedupe(ids, nodes);
    return { cyc, pts: cyc.map((id) => [nodes[id][0], nodes[id][1]]) };
  });
  if (loops.some((l) => !l)) return null;
  const outers = loops.filter((l) => l.pts.length >= 3 && polyArea2(l.pts) > 1e-6);
  const inners = loops.filter((l) => l.pts.length >= 3 && polyArea2(l.pts) < -1e-6);
  const holesOf = outers.map(() => []);
  for (const h of inners) {
    const [x, z] = h.pts[0];
    const i = outers.findIndex((o) => pointIn(x, z, o.pts));
    if (i < 0) return null;
    holesOf[i].push(h);
  }
  outers.forEach((o, i) => {
    area += polyArea2(o.pts) + holesOf[i].reduce((s, h) => s + polyArea2(h.pts), 0);
    const all = o.pts.concat(...holesOf[i].map((h) => h.pts));
    const idx = earcutTris(o.pts, holesOf[i].map((h) => h.pts));
    for (const q of idx) top.push(all[q][0] + ox, topH, all[q][1] + oz);
  });
  // 面積の合計が外形の面積と合わなければ、面が重なったり欠けたりしている
  if (Math.abs(area - footprint) > 0.005 * footprint + 0.05) return null;
  let height = 0;
  for (let i = 1; i < roof.length; i += 3) height = Math.max(height, roof[i]);
  if (top.length) height = Math.max(height, topH);
  return { slope, height, reach, roof, top, gables };
}

function pointIn(x, z, ring) {
  let inside = false;
  for (let i = 0, n = ring.length, j = n - 1; i < n; j = i++) {
    const xi = ring[i][0], zi = ring[i][1], xj = ring[j][0], zj = ring[j][1];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

// 切妻の壁（辺に沿った距離 s・高さ y の多角形）のうち、s0〜s1 の範囲で高さ y0 より上の部分（Sutherland–Hodgman）
export function clipGable(pts, s0, s1, y0) {
  let out = pts;
  const clip = (inside, cut) => {
    const res = [];
    for (let i = 0; i < out.length; i++) {
      const p = out[i], q = out[(i + 1) % out.length];
      const ip = inside(p), iq = inside(q);
      if (ip) res.push(p);
      if (ip !== iq) res.push(cut(p, q));
    }
    out = res;
  };
  const lerp = (p, q, f) => [p[0] + (q[0] - p[0]) * f, p[1] + (q[1] - p[1]) * f];
  clip((p) => p[0] >= s0, (p, q) => lerp(p, q, (s0 - p[0]) / (q[0] - p[0])));
  if (out.length) clip((p) => p[0] <= s1, (p, q) => lerp(p, q, (s1 - p[0]) / (q[0] - p[0])));
  if (out.length) clip((p) => p[1] >= y0, (p, q) => lerp(p, q, (y0 - p[1]) / (q[1] - p[1])));
  return out.length >= 3 && Math.abs(polyArea2(out)) > 1e-3 ? out : null;
}

// 平面の多角形（[[u, v]]）を三角形の頂点番号に分ける
export function triangulate2(pts) {
  return earcutTris(pts);
}
