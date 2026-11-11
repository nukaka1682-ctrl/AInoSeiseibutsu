// 駅と駅のあいだのトンネル（写真: Wikimedia Commons の「Métro Minimes - tunnel」）。
// 1 本の丸いトンネルに 2 本の線路（コンクリートの走行路と鋼の案内軌条）、真ん中に格子の避難通路、
// 壁に 12 m ごとの照明とケーブルの棚。照明は焼き込み（明かりのない所は暗い。光らない材質）
import * as THREE from 'three';
import { LAYOUT, boxHalf, pathAt } from './network.js';
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
  };
  return mats;
}

// 断面の点（線路の軸からの横 t、床の上の高さ h）と、その点の色（明るさは S で決める）
function section() {
  const pts = [];
  // 床（線路の床）から壁、円弧の天井
  pts.push([-R + 0.15, -1.3], [-R, -0.6]);
  const n = 14;
  for (let k = 0; k <= n; k++) {
    const a = Math.PI + (k / n) * Math.PI; // 左の壁から天井を通って右へ
    pts.push([Math.cos(a) * R, 0.9 - Math.sin(a) * (R - 0.35)]);
  }
  pts.push([R, -0.6], [R - 0.15, -1.3]);
  return pts;
}

// 線形の S0..S1 のトンネル（局所: 横 t は線形の右、y はホームの床の高さ + h）
export function buildTunnel(path, S0, S1, { name = '' } = {}) {
  const m = tunnelMaterials();
  const geo = { concrete: { p: [], n: [], uv: [], c: [] }, plain: { p: [], n: [], uv: [], c: [] }, lamp: { p: [], n: [], uv: [], c: [] } };
  const sec = section();
  const N = Math.max(2, Math.ceil((S1 - S0) / STEP));
  const frames = [];
  for (let i = 0; i <= N; i++) {
    const S = S0 + ((S1 - S0) * i) / N, p = pathAt(path, S);
    frames.push({ S, x: p.x, y: p.y, z: p.z, rx: -p.hz, rz: p.hx, hx: p.hx, hz: p.hz });
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
  for (let i = 0; i < N; i++) {
    const f0 = frames[i], f1 = frames[i + 1];
    // 壁と天井（内側を向く）
    for (let k = 0; k + 1 < sec.length; k++) {
      const [ta, ha] = sec[k], [tb, hb] = sec[k + 1];
      const nt = -(hb - ha), nh = tb - ta, nl = Math.hypot(nt, nh) || 1; // 内向き
      const nrm = [(f0.rx * nt) / nl, nh / nl, (f0.rz * nt) / nl];
      const c = (f, t) => {
        const k2 = lampLight(f.S, t);
        return [k2, k2, k2 * 0.97];
      };
      push(geo.concrete, P(f0, ta, ha), P(f1, ta, ha), P(f1, tb, hb), P(f0, tb, hb), nrm,
        [[f0.S / 4, arc[k] / 4], [f1.S / 4, arc[k] / 4], [f1.S / 4, arc[k + 1] / 4], [f0.S / 4, arc[k + 1] / 4]], [c(f0, ta), c(f1, ta), c(f1, tb), c(f0, tb)]);
    }
    // 線路の床
    const cl = (f, t, base) => {
      const k2 = lampLight(f.S, t) * base;
      return [k2, k2, k2];
    };
    push(geo.plain, P(f0, -R + 0.15, -1.3), P(f1, -R + 0.15, -1.3), P(f1, R - 0.15, -1.3), P(f0, R - 0.15, -1.3), [0, 1, 0], [[0, 0], [1, 0], [1, 1], [0, 1]],
      [cl(f0, -2, 0.5), cl(f1, -2, 0.5), cl(f1, 2, 0.5), cl(f0, 2, 0.5)]);
    // 走行路（コンクリートの帯、上面）と案内軌条（鋼、側面）
    for (const tc of [LAYOUT.trackOff, -LAYOUT.trackOff]) {
      for (const o of [-0.86, 0.86]) {
        const a = tc + o - 0.18, b = tc + o + 0.18;
        push(geo.plain, P(f0, a, -1.0), P(f1, a, -1.0), P(f1, b, -1.0), P(f0, b, -1.0), [0, 1, 0], [[0, 0], [1, 0], [1, 1], [0, 1]], [cl(f0, tc, 0.95), cl(f1, tc, 0.95), cl(f1, tc, 0.95), cl(f0, tc, 0.95)]);
        for (const s of [a, b]) push(geo.plain, P(f0, s, -1.3), P(f1, s, -1.3), P(f1, s, -1.0), P(f0, s, -1.0), [f0.rx * Math.sign(s - tc - o), 0, f0.rz * Math.sign(s - tc - o)], [[0, 0], [1, 0], [1, 1], [0, 1]], [cl(f0, tc, 0.7), cl(f1, tc, 0.7), cl(f1, tc, 0.7), cl(f0, tc, 0.7)]);
      }
      for (const o of [-1.22, 1.22]) {
        const t = tc + o;
        push(geo.plain, P(f0, t, -0.95), P(f1, t, -0.95), P(f1, t, -0.78), P(f0, t, -0.78), [-f0.rx * Math.sign(o), 0, -f0.rz * Math.sign(o)], [[0, 0], [1, 0], [1, 1], [0, 1]], [cl(f0, t, 0.85), cl(f1, t, 0.85), cl(f1, t, 0.85), cl(f0, t, 0.85)]);
      }
    }
    // 真ん中の避難通路（格子の床、高さ −0.55）
    push(geo.plain, P(f0, -0.45, -0.55), P(f1, -0.45, -0.55), P(f1, 0.45, -0.55), P(f0, 0.45, -0.55), [0, 1, 0], [[0, 0], [1, 0], [1, 1], [0, 1]], [cl(f0, 0, 0.42), cl(f1, 0, 0.42), cl(f1, 0, 0.42), cl(f0, 0, 0.42)]);
    for (const s of [-0.45, 0.45]) push(geo.plain, P(f0, s, -1.3), P(f1, s, -1.3), P(f1, s, -0.55), P(f0, s, -0.55), [f0.rx * Math.sign(s), 0, f0.rz * Math.sign(s)], [[0, 0], [1, 0], [1, 1], [0, 1]], [cl(f0, 0, 0.35), cl(f1, 0, 0.35), cl(f1, 0, 0.35), cl(f0, 0, 0.35)]);
    // ケーブルの棚（両側の壁、高さ 1.6 m）
    for (const sg of [1, -1]) {
      const t = (R - 0.25) * sg;
      push(geo.plain, P(f0, t, 1.55), P(f1, t, 1.55), P(f1, t, 1.7), P(f0, t, 1.7), [-f0.rx * sg, 0, -f0.rz * sg], [[0, 0], [1, 0], [1, 1], [0, 1]], [cl(f0, t, 0.45), cl(f1, t, 0.45), cl(f1, t, 0.45), cl(f0, t, 0.45)]);
    }
  }
  // 灯具（光る箱）
  for (let S = Math.ceil(S0 / LAMP) * LAMP; S < S1; S += LAMP) {
    for (const [sg, off] of [[1, 0], [-1, LAMP / 2]]) {
      const SS = S + off;
      if (SS >= S1) continue;
      const p = pathAt(path, SS), f = { x: p.x, y: p.y, z: p.z, rx: -p.hz, rz: p.hx };
      const t = (R - 0.32) * sg, h = 2.3;
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
    group.add(mesh);
  }
  return group;
}

// 駅 i と i + 1 のあいだのトンネル（駅の箱の端から端まで）
export function tunnelBetween(network, line, i) {
  const path = network.lines[line], a = path.stations[i], b = path.stations[i + 1];
  if (!a || !b) return null;
  const S0 = a.S[line] + boxHalf(line, a), S1 = b.S[line] - boxHalf(line, b);
  return buildTunnel(path, S0, S1, { name: `${line}-${a.id}-${b.id}` });
}

// 終点の先の引き上げ線（電車が消えていく先。100 m）
export function tunnelBeyond(network, line, end) {
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
  return buildTunnel(ext, 0, 120, { name: `${line}-end${end}` });
}
