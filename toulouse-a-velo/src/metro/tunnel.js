// 駅と駅のあいだのトンネル（写真: Wikimedia Commons の「Métro Minimes - tunnel」）。
// 1 本の丸いトンネルに 2 本の線路（コンクリートの走行路と鋼の案内軌条）、真ん中に格子の避難通路、
// 壁に 12 m ごとの照明とケーブルの棚。照明は焼き込み（明かりのない所は暗い。光らない材質）
import * as THREE from 'three';
import { LAYOUT, boxHalf, kindAt, pathAt } from './network.js';
import { metroTextures } from './textures.js';

const R = 3.55; // 断面の半径（線路の床から 4.6 m の天井）
const STEP = 2;
const LAMP = 12;

let mats = null;
function tunnelMaterials() {
  if (mats) return mats;
  const t = metroTextures();
  mats = {
    concrete: new THREE.MeshBasicMaterial({ map: t.concrete, vertexColors: true }),
    plain: new THREE.MeshBasicMaterial({ vertexColors: true }),
    lamp: new THREE.MeshBasicMaterial({ color: '#fff1d6' }),
    // 地上・高架の区間（太陽の光と影を受ける）
    concreteLit: new THREE.MeshStandardMaterial({ map: t.concrete, vertexColors: true, roughness: 0.92 }),
    plainLit: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85 }),
  };
  mats.concreteLit.shadowSide = THREE.DoubleSide;
  return mats;
}

// 断面の点（線路の軸からの横 t、床の上の高さ h）。w: 2 本の線路の間が広がる分（島式のホームの駅の前後。左右に w ずつ
// 広げ、天井の真ん中は平ら）。点の数は w によらない
function section(w = 0) {
  const pts = [];
  // 床（線路の床）から壁、円弧の天井
  pts.push([-R + 0.15 - w, -1.3], [-R - w, -0.6]);
  const n = 14;
  for (let k = 0; k <= n; k++) {
    const a = Math.PI + (k / n) * Math.PI; // 左の壁から天井を通って右へ
    const t = Math.cos(a) * R, h = 0.9 - Math.sin(a) * (R - 0.35);
    if (Math.abs(t) < 1e-6) pts.push([-w, h], [w, h]);
    else pts.push([t + Math.sign(t) * w, h]);
  }
  pts.push([R + w, -0.6], [R - 0.15 + w, -1.3]);
  return pts;
}

// 覆いのある所（掘割のふた・橋の覆い）の断面: 角の丸い箱（点の数は丸いトンネルと同じ）
function boxSection(w = 0) {
  const pts = [];
  pts.push([-R + 0.15 - w, -1.3], [-R - w, -0.6]);
  const n = 14, e = 0.22;
  for (let k = 0; k <= n; k++) {
    const a = Math.PI + (k / n) * Math.PI, c = Math.cos(a), sn = Math.max(0, -Math.sin(a));
    const t = Math.sign(c) * Math.abs(c) ** e * R, h = 0.9 + sn ** e * (R - 0.75);
    if (Math.abs(c) < 1e-6) pts.push([-w, h], [w, h]);
    else pts.push([t + Math.sign(t) * w, h]);
  }
  pts.push([R + w, -0.6], [R - 0.15 + w, -1.3]);
  return pts;
}

const OPEN = (k) => k === 'o' || k === 'b';
const DECK_W = R + 0.35; // 高架橋・地上の線路の床の半分の幅
const PARAPET_H = 0.35; // 側壁の上（ホームの床の高さから。走行路から 1.35 m）
const PIER = 28; // 橋脚の間隔（m）

// 線形の S0..S1 のトンネル（局所: 横 t は線形の右、y はホームの床の高さ + h）。線形の点の種類 k（network.js）で作り分ける:
// t 丸いトンネル、c 覆いのある箱、b 高架橋（床版と側壁・橋脚）、o 地上の線路（床と側壁）。groundAt(x, z): 地面の高さ（橋脚の足もと）
export function buildTunnel(path, S0, S1, { name = '', groundAt = null, kind = null } = {}) {
  const m = tunnelMaterials();
  const mk = () => ({ p: [], n: [], uv: [], c: [] });
  const geo = { concrete: mk(), plain: mk(), lamp: mk(), concreteLit: mk(), plainLit: mk() };
  const sec = section(), bsec = boxSection();
  const N = Math.max(2, Math.ceil((S1 - S0) / STEP));
  const frames = [];
  for (let i = 0; i <= N; i++) {
    const S = S0 + ((S1 - S0) * i) / N, p = pathAt(path, S), off = p.off ?? LAYOUT.trackOff, w = Math.max(0, off - LAYOUT.trackOff);
    const k = kind || kindAt(path, S);
    frames.push({ S, x: p.x, y: p.y, z: p.z, rx: -p.hz, rz: p.hx, hx: p.hx, hz: p.hz, off, w, k, sec: k === 'c' ? (w > 1e-3 ? boxSection(w) : bsec) : w > 1e-3 ? section(w) : sec });
  }
  // 照明の当たり: 12 m ごとの灯具（右・左の壁を交互に 6 m ずらす）の近くが明るい
  const lampLight = (S, t) => {
    const ph = ((S % LAMP) + LAMP) % LAMP, d = Math.min(ph, LAMP - ph);
    const side = t >= 0 ? 0 : LAMP / 2;
    const ph2 = (((S + side) % LAMP) + LAMP) % LAMP, d2 = Math.min(ph2, LAMP - ph2);
    return 0.16 + 0.55 * Math.exp(-(d2 * d2) / 10) * (Math.abs(t) > 2 ? 1 : 0.55) + 0.05 * Math.exp(-(d * d) / 30);
  };
  const P = (f, t, h) => [f.x + f.rx * t, f.y + h, f.z + f.rz * t];
  const push = (g, a, b, c, d, nrm, uvs, cols) => {
    for (const [pt, uv, col] of [[a, uvs[0], cols[0]], [b, uvs[1], cols[1]], [c, uvs[2], cols[2]], [a, uvs[0], cols[0]], [c, uvs[2], cols[2]], [d, uvs[3], cols[3]]]) {
      g.p.push(...pt);
      g.n.push(...nrm);
      g.uv.push(...uv);
      g.c.push(...col);
    }
  };
  // 断面の弧の長さ（uv）
  const arc = [0];
  for (let k = 1; k < sec.length; k++) arc.push(arc[k - 1] + Math.hypot(sec[k][0] - sec[k - 1][0], sec[k][1] - sec[k - 1][1]));
  const lit = [0.8, 0.79, 0.76];
  // 地上・高架の区間: 床版（上面は線路の床）と側壁。高架橋は箱桁の下面と橋脚、地上は地面の下までの側面
  const q4 = (g, a, b, c, d, nrm, col = lit, u0 = 0, u1 = 1) => push(g, a, b, c, d, nrm, [[u0, 0], [u1, 0], [u1, 1], [u0, 1]], [col, col, col, col]);
  function writeOpen(f0, f1) {
    const g = geo.concreteLit, W0 = DECK_W + f0.w, W1 = DECK_W + f1.w, u0 = f0.S / 4, u1 = f1.S / 4;
    const bridge = f0.k === 'b';
    const bot = bridge ? -2.9 : -4.5; // 床版の下面（地上は地面の下まで）
    for (const sg of [1, -1]) {
      const a0 = W0 * sg, a1 = W1 * sg, i0 = (W0 - 0.28) * sg, i1 = (W1 - 0.28) * sg, n = [f0.rx * sg, 0, f0.rz * sg], ni = [-n[0], 0, -n[2]];
      // 側壁: 内側の面・上面・外側の面
      q4(g, P(f0, i0, -1.3), P(f1, i1, -1.3), P(f1, i1, PARAPET_H), P(f0, i0, PARAPET_H), ni, lit, u0, u1);
      q4(g, P(f0, i0, PARAPET_H), P(f1, i1, PARAPET_H), P(f1, a1, PARAPET_H), P(f0, a0, PARAPET_H), [0, 1, 0], lit, u0, u1);
      q4(g, P(f0, a0, bridge ? -1.9 : bot), P(f1, a1, bridge ? -1.9 : bot), P(f1, a1, PARAPET_H), P(f0, a0, PARAPET_H), n, lit, u0, u1);
      if (bridge) {
        // 箱桁: 張り出しの下面と、内へ絞った腹板
        const b0 = (W0 - 1.5) * sg, b1 = (W1 - 1.5) * sg, dark = [0.58, 0.57, 0.55];
        q4(g, P(f0, b0, -2.15), P(f1, b1, -2.15), P(f1, a1, -1.9), P(f0, a0, -1.9), [0, -1, 0], dark, u0, u1);
        q4(g, P(f0, b0, bot), P(f1, b1, bot), P(f1, b1, -2.15), P(f0, b0, -2.15), n, dark, u0, u1);
      }
      // 手すり（側壁の上の鋼の管）
      const r0 = (W0 - 0.14) * sg, r1 = (W1 - 0.14) * sg, steel = [0.42, 0.44, 0.46];
      q4(geo.plainLit, P(f0, r0, PARAPET_H + 0.42), P(f1, r1, PARAPET_H + 0.42), P(f1, r1, PARAPET_H + 0.5), P(f0, r0, PARAPET_H + 0.5), n, steel);
    }
    if (bridge) {
      const b0 = W0 - 1.5, b1 = W1 - 1.5;
      q4(g, P(f0, -b0, bot), P(f1, -b1, bot), P(f1, b1, bot), P(f0, b0, bot), [0, -1, 0], [0.5, 0.49, 0.47], u0, u1);
    }
  }
  // トンネル・覆いの口: 断面のまわりの壁（外から見える面）
  function writePortal(f, dir) {
    const g = geo.concreteLit, n = [f.hx * dir, 0, f.hz * dir], H = 4.9, W = R + f.w + 1.1, col = [0.74, 0.73, 0.7];
    const s = f.sec;
    for (let k = 1; k + 2 < s.length; k++) {
      const [ta, ha] = s[k], [tb, hb] = s[k + 1];
      if (Math.abs(tb - ta) < 1e-6) continue;
      q4(g, P(f, ta, ha), P(f, tb, hb), P(f, tb, H), P(f, ta, H), n, col);
    }
    for (const sg of [1, -1]) q4(g, P(f, (R + f.w) * sg, -4.5), P(f, W * sg, -4.5), P(f, W * sg, H), P(f, (R + f.w) * sg, H), n, col);
  }
  // 橋脚（高架橋の下。丸い柱と、上で広がる頭）
  if (groundAt) {
    for (let S = Math.ceil((S0 + 6) / PIER) * PIER; S < S1 - 6; S += PIER) {
      if ((kind || kindAt(path, S)) !== 'b') continue;
      const p = pathAt(path, S), f = { x: p.x, y: p.y, z: p.z, rx: -p.hz, rz: p.hx, hx: p.hx, hz: p.hz };
      const top = p.y - 2.9, gy = groundAt(p.x, p.z) - 0.6;
      if (top - gy < 1.2) continue;
      const g = geo.concreteLit, seg = 12, col = [0.7, 0.69, 0.66];
      const ring = (r, rs, y) => Array.from({ length: seg + 1 }, (_, i) => {
        const a = (i / seg) * Math.PI * 2;
        return [f.x + f.rx * Math.cos(a) * r + f.hx * Math.sin(a) * rs, y, f.z + f.rz * Math.cos(a) * r + f.hz * Math.sin(a) * rs];
      });
      const head = Math.min(1.6, (top - gy) * 0.4);
      const rings = [ring(0.95, 0.95, gy), ring(0.95, 0.95, top - head), ring(2.1, 1.05, top)];
      for (let j = 0; j + 1 < rings.length; j++) {
        for (let i = 0; i < seg; i++) {
          const a = ((i + 0.5) / seg) * Math.PI * 2, nx = f.rx * Math.cos(a) + f.hx * Math.sin(a), nz = f.rz * Math.cos(a) + f.hz * Math.sin(a);
          q4(g, rings[j][i], rings[j][i + 1], rings[j + 1][i + 1], rings[j + 1][i], [nx, 0, nz], col, i / 3, (i + 1) / 3);
        }
      }
    }
  }
  for (let i = 0; i < N; i++) {
    const f0 = frames[i], f1 = frames[i + 1];
    const open = OPEN(f0.k);
    const gp = open ? geo.plainLit : geo.plain;
    if (open) writeOpen(f0, f1);
    else if (OPEN(f1.k) || (i > 0 && OPEN(frames[i - 1].k))) writePortal(OPEN(f1.k) ? f1 : f0, OPEN(f1.k) ? 1 : -1);
    // 壁と天井（内側を向く）
    for (let k = 0; !open && k + 1 < sec.length; k++) {
      const [ta, ha] = f0.sec[k], [tb, hb] = f0.sec[k + 1], [ta1, ha1] = f1.sec[k], [tb1, hb1] = f1.sec[k + 1];
      if (Math.abs(tb - ta) + Math.abs(hb - ha) < 1e-6 && Math.abs(tb1 - ta1) + Math.abs(hb1 - ha1) < 1e-6) continue; // 広がらない所の天井の真ん中
      const nt = -(hb - ha), nh = tb - ta, nl = Math.hypot(nt, nh) || 1; // 内向き
      const nrm = nl > 1e-6 ? [(f0.rx * nt) / nl, nh / nl, (f0.rz * nt) / nl] : [0, -1, 0];
      const c = (f, t) => {
        const k2 = lampLight(f.S, t);
        return [k2, k2, k2 * 0.97];
      };
      push(geo.concrete, P(f0, ta, ha), P(f1, ta1, ha1), P(f1, tb1, hb1), P(f0, tb, hb), nrm,
        [[f0.S / 4, arc[k] / 4], [f1.S / 4, arc[k] / 4], [f1.S / 4, arc[k + 1] / 4], [f0.S / 4, arc[k + 1] / 4]], [c(f0, ta), c(f1, ta1), c(f1, tb1), c(f0, tb)]);
    }
    // 線路の床
    const cl = (f, t, base) => {
      const k2 = open ? 0.25 + base * 0.6 : lampLight(f.S, t) * base;
      return [k2, k2, k2];
    };
    const w0 = f0.w, w1 = f1.w;
    push(gp, P(f0, -R + 0.15 - w0, -1.3), P(f1, -R + 0.15 - w1, -1.3), P(f1, R - 0.15 + w1, -1.3), P(f0, R - 0.15 + w0, -1.3), [0, 1, 0], [[0, 0], [1, 0], [1, 1], [0, 1]],
      [cl(f0, -2, 0.5), cl(f1, -2, 0.5), cl(f1, 2, 0.5), cl(f0, 2, 0.5)]);
    // 走行路（コンクリートの帯、上面）と案内軌条（鋼、側面）。線路の中心は f.off（島式のホームの駅の前後で広がる）
    for (const sg of [1, -1]) {
      const tc0 = f0.off * sg, tc1 = f1.off * sg;
      for (const o of [-0.86, 0.86]) {
        const a0 = tc0 + o - 0.18, b0 = tc0 + o + 0.18, a1 = tc1 + o - 0.18, b1 = tc1 + o + 0.18;
        push(gp, P(f0, a0, -1.0), P(f1, a1, -1.0), P(f1, b1, -1.0), P(f0, b0, -1.0), [0, 1, 0], [[0, 0], [1, 0], [1, 1], [0, 1]], [cl(f0, tc0, 0.95), cl(f1, tc1, 0.95), cl(f1, tc1, 0.95), cl(f0, tc0, 0.95)]);
        for (const [s0, s1, k] of [[a0, a1, -1], [b0, b1, 1]]) push(gp, P(f0, s0, -1.3), P(f1, s1, -1.3), P(f1, s1, -1.0), P(f0, s0, -1.0), [f0.rx * k, 0, f0.rz * k], [[0, 0], [1, 0], [1, 1], [0, 1]], [cl(f0, tc0, 0.7), cl(f1, tc1, 0.7), cl(f1, tc1, 0.7), cl(f0, tc0, 0.7)]);
      }
      for (const o of [-1.22, 1.22]) {
        const t0 = tc0 + o, t1 = tc1 + o;
        push(gp, P(f0, t0, -0.95), P(f1, t1, -0.95), P(f1, t1, -0.78), P(f0, t0, -0.78), [-f0.rx * Math.sign(o), 0, -f0.rz * Math.sign(o)], [[0, 0], [1, 0], [1, 1], [0, 1]], [cl(f0, t0, 0.85), cl(f1, t1, 0.85), cl(f1, t1, 0.85), cl(f0, t0, 0.85)]);
      }
    }
    // 真ん中の避難通路（格子の床、高さ −0.55。線路の間が広がる所にはない）
    if (w0 < 0.3 && w1 < 0.3) {
      push(gp, P(f0, -0.45, -0.55), P(f1, -0.45, -0.55), P(f1, 0.45, -0.55), P(f0, 0.45, -0.55), [0, 1, 0], [[0, 0], [1, 0], [1, 1], [0, 1]], [cl(f0, 0, 0.42), cl(f1, 0, 0.42), cl(f1, 0, 0.42), cl(f0, 0, 0.42)]);
      for (const s of [-0.45, 0.45]) push(gp, P(f0, s, -1.3), P(f1, s, -1.3), P(f1, s, -0.55), P(f0, s, -0.55), [f0.rx * Math.sign(s), 0, f0.rz * Math.sign(s)], [[0, 0], [1, 0], [1, 1], [0, 1]], [cl(f0, 0, 0.35), cl(f1, 0, 0.35), cl(f1, 0, 0.35), cl(f0, 0, 0.35)]);
    }
    // ケーブルの棚（両側の壁、高さ 1.6 m）
    for (const sg of open ? [] : [1, -1]) {
      const t0 = (R - 0.25 + w0) * sg, t1 = (R - 0.25 + w1) * sg;
      push(gp, P(f0, t0, 1.55), P(f1, t1, 1.55), P(f1, t1, 1.7), P(f0, t0, 1.7), [-f0.rx * sg, 0, -f0.rz * sg], [[0, 0], [1, 0], [1, 1], [0, 1]], [cl(f0, t0, 0.45), cl(f1, t1, 0.45), cl(f1, t1, 0.45), cl(f0, t0, 0.45)]);
    }
  }
  // 灯具（光る箱）
  for (let S = Math.ceil(S0 / LAMP) * LAMP; S < S1; S += LAMP) {
    for (const [sg, off] of [[1, 0], [-1, LAMP / 2]]) {
      const SS = S + off;
      if (SS >= S1) continue;
      if (OPEN(kind || kindAt(path, SS))) continue;
      const p = pathAt(path, SS), f = { x: p.x, y: p.y, z: p.z, rx: -p.hz, rz: p.hx };
      const t = (R - 0.32 + Math.max(0, (p.off ?? LAYOUT.trackOff) - LAYOUT.trackOff)) * sg, h = 2.3;
      const a = P(f, t, h), hx = p.hx * 0.6, hz = p.hz * 0.6;
      const q = [[a[0] - hx, a[1] - 0.06, a[2] - hz], [a[0] + hx, a[1] - 0.06, a[2] + hz], [a[0] + hx, a[1] + 0.06, a[2] + hz], [a[0] - hx, a[1] + 0.06, a[2] - hz]];
      push(geo.lamp, ...q, [-f.rx * sg, 0, -f.rz * sg], [[0, 0], [1, 0], [1, 1], [0, 1]], [[1, 1, 1], [1, 1, 1], [1, 1, 1], [1, 1, 1]]);
    }
  }
  const group = new THREE.Group();
  group.name = `tunnel-${name}`;
  for (const [k, g] of Object.entries(geo)) {
    if (!g.p.length) continue;
    const bg = new THREE.BufferGeometry();
    bg.setAttribute('position', new THREE.Float32BufferAttribute(g.p, 3));
    bg.setAttribute('normal', new THREE.Float32BufferAttribute(g.n, 3));
    bg.setAttribute('uv', new THREE.Float32BufferAttribute(g.uv, 2));
    bg.setAttribute('color', new THREE.Float32BufferAttribute(g.c, 3));
    bg.computeBoundingSphere();
    const mesh = new THREE.Mesh(bg, m[k]);
    mesh.material.side = THREE.DoubleSide;
    if (k === 'concreteLit' || k === 'plainLit') mesh.castShadow = mesh.receiveShadow = true;
    group.add(mesh);
  }
  return group;
}

// 駅 i と i + 1 のあいだのトンネル（駅の箱の端から端まで）
export function tunnelBetween(network, line, i, opts = {}) {
  const path = network.lines[line], a = path.stations[i], b = path.stations[i + 1];
  if (!a || !b) return null;
  const S0 = a.S[line] + boxHalf(line, a), S1 = b.S[line] - boxHalf(line, b);
  return buildTunnel(path, S0, S1, { ...opts, name: `${line}-${a.id}-${b.id}` });
}

// 終点の先の引き上げ線（電車が消えていく先。100 m）
export function tunnelBeyond(network, line, end, opts = {}) {
  const path = network.lines[line];
  const st = end > 0 ? path.stations[path.stations.length - 1] : path.stations[0];
  const L = boxHalf(line, st);
  // 線形の外は直線で延ばす（pathAt は端で止まるので、ここでは端の向きでずらした線形を作る）
  const p = pathAt(path, st.S[line] + end * L);
  const ext = { pts: [], length: 0 };
  for (let k = 0; k <= 60; k++) {
    const u = k * 2;
    ext.pts.push({ S: u, x: p.x + p.hx * end * u, z: p.z + p.hz * end * u, y: p.y, hx: p.hx * end, hz: p.hz * end });
  }
  ext.length = 120;
  return buildTunnel(ext, 0, 120, { ...opts, name: `${line}-end${end}`, kind: kindAt(path, st.S[line] + end * L) });
}
