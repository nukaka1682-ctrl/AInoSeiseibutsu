// 地上の街のにぎわい（メトロのゲーム）: 歩道を歩く人、出入口のそばの駐輪の柵（アーチ形の鉄の柵）と自転車・電動キックボード、空の雲。
// - 歩く人: 道路（車道）の外・建物の外の歩道を、近い通りの向きに沿って歩く（駅のまわり R m の中）。脚を振って歩く。
//   形は部品ごとに InstancedMesh（脚・胴・頭・髪。描く回数は 4 回）。服・肌・髪の色は人ごと
// - 自転車: 出入口の吹き抜けの横の歩道に、吹き抜けに沿って並べた柵と、柵につないだ自転車（フレームの色はいろいろ）。
//   ときどき電動キックボード（スタンドで少し傾いて立つ）
// - 雲: カメラの上 1500 m の大きな円盤に、シェーダーで fbm の雲（ゆっくり流れる。地平線に向かって薄く）
import * as THREE from 'three';
import { Builder } from './geom.js';
import { mulberry32 } from '../geo.js';
import { entranceFrame, inEntrance, rimAt } from '../world/metro.js';

const TOPS = ['#2a3a5e', '#7a2b23', '#2f5d3a', '#d8d4cc', '#1c1c1e', '#8c6a3f', '#4d6f9c', '#b84c66', '#e3b23c', '#5b5b63', '#f2efe8', '#3f6f6a'];
const BOTTOMS = ['#2b2f3a', '#3c3f46', '#1e2433', '#6b5a48', '#20232a', '#5d6470', '#c8b896', '#283a5a'];
const SKINS = ['#e8c4a8', '#d9a888', '#b98563', '#8a5a3c', '#f0d2bc', '#6b4228'];
const HAIRS = ['#2a1d14', '#4a3222', '#1a1a1a', '#8a6a42', '#c9b38a', '#6e6e6e', '#b0aaa0'];
const FRAMES = ['#c0392b', '#1d1d1f', '#e8e6e0', '#2e5e8c', '#3c6e47', '#8a8d91', '#d4a017', '#5b3a6e'];
const HIP = 0.86, TORSO = 0.6;

let personMat = null;
function material() {
  return (personMat ||= new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8 }));
}

// 人の部品（局所: 足もとが原点、-z が前。脚は腰の高さが原点）
function partGeometries() {
  const leg = new Builder(), torso = new Builder(), head = new Builder(), hair = new Builder();
  leg.box('g', 0, 0, -HIP + 0.06, 0, 0, 1, 0.15, 0.14);
  leg.box('g', 0, -0.05, -HIP, -HIP + 0.07, 0, 1, 0.27, 0.12, { color: [0.09, 0.09, 0.1] }); // 靴
  const t0 = HIP, t1 = HIP + TORSO;
  torso.box('g', 0, 0, t0 - 0.04, t1, 1, 0, 0.4, 0.24);
  for (const x of [-0.25, 0.25]) torso.box('g', x, 0, t1 - 0.6, t1 - 0.02, 1, 0, 0.1, 0.11);
  head.cyl('g', 0, 0, t1, t1 + 0.08, 0.06, { seg: 8 });
  head.cyl('g', 0, 0, t1 + 0.08, t1 + 0.26, 0.105, { seg: 10 });
  hair.box('g', 0, 0, t1 + 0.26, t1 + 0.3, 1, 0, 0.19, 0.2);
  hair.box('g', 0, 0.03, t1 + 0.14, t1 + 0.28, 1, 0, 0.2, 0.17);
  const g = (b) => b.writers.get('g').toGeometry();
  return { leg: g(leg), torso: g(torso), head: g(head), hair: g(hair) };
}

export class StreetLife {
  // world: assembleStreamWorld の結果、pitsOf(station): 駅の出入口
  constructor(world, pitsOf, { count = 80, radius = 85 } = {}) {
    this.world = world;
    this.pitsOf = pitsOf;
    this.count = count;
    this.radius = radius;
    this.group = new THREE.Group();
    this.group.name = 'street-life';
    const parts = partGeometries(), mat = material();
    const mk = (geo, n) => {
      const m = new THREE.InstancedMesh(geo, mat, n);
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.castShadow = true;
      m.frustumCulled = false;
      m.count = 0;
      this.group.add(m);
      return m;
    };
    this.legs = mk(parts.leg, count * 2);
    this.torsos = mk(parts.torso, count);
    this.heads = mk(parts.head, count);
    this.hairs = mk(parts.hair, count);
    this.people = [];
    this.station = null;
    this.parked = null;
    this.pending = 0;
    this.rnd = mulberry32(17);
  }

  // 歩道の点か（車道・建物・水・出入口の吹き抜けの外、駅のまわり）
  ok(x, z, cx = this.station.x, cz = this.station.z) {
    const w = this.world;
    if (Math.hypot(x - cx, z - cz) > this.radius) return false;
    if (w.roadnet.onRoad(x, z, 0.35)) return false;
    if (w.collision.blockedByWater(x, z)) return false;
    if (inEntrance(this.pits, x, z, 1.0)) return false;
    return !w.collision.resolve(x, z, 0.45).hit;
  }

  // 駅が変わったら、人と自転車を置き直す
  setStation(station) {
    if (this.station === station) return;
    this.station = station;
    this.pits = this.pitsOf(station);
    this.people = [];
    if (this.parked) {
      this.group.remove(this.parked);
      this.parked.traverse((o) => o.geometry?.dispose());
      this.parked = null;
    }
    this.pending = 0.01;
  }

  // 街並みが読み込めてから置く
  populate() {
    const s = this.station, w = this.world, rnd = this.rnd;
    if (!w.stream.readyAt(s.x, s.z)) return false;
    for (let tries = 0; this.people.length < this.count && tries < this.count * 40; tries++) {
      // 駅（出入口）の近くほど多く
      const a = rnd() * Math.PI * 2, r = 4 + rnd() ** 1.6 * (this.radius - 8);
      const x = s.x + Math.cos(a) * r, z = s.z + Math.sin(a) * r;
      if (!w.stream.readyAt(x, z) || !this.ok(x, z)) continue;
      const p = {
        x, z, y: w.groundAt(x, z, 999), yaw: rnd() * Math.PI * 2, speed: 1.1 + rnd() * 0.45, tx: x, tz: z, wait: rnd() * 2, phase: rnd() * 10,
        h: 0.9 + rnd() * 0.18, stand: rnd() < 0.12,
      };
      const pick = (list) => new THREE.Color(list[Math.floor(rnd() * list.length)]);
      p.colors = { top: pick(TOPS), bottom: pick(BOTTOMS), skin: pick(SKINS), hair: pick(HAIRS) };
      this.people.push(p);
    }
    this.people.forEach((p, i) => {
      this.torsos.setColorAt(i, p.colors.top);
      this.heads.setColorAt(i, p.colors.skin);
      this.hairs.setColorAt(i, p.colors.hair);
      this.legs.setColorAt(i * 2, p.colors.bottom);
      this.legs.setColorAt(i * 2 + 1, p.colors.bottom);
    });
    for (const m of [this.torsos, this.heads, this.hairs, this.legs]) if (m.instanceColor) m.instanceColor.needsUpdate = true;
    this.torsos.count = this.heads.count = this.hairs.count = this.people.length;
    this.legs.count = this.people.length * 2;
    this.parked = parkedVehicles(this, s, this.pits, rnd);
    if (this.parked) this.group.add(this.parked);
    return true;
  }

  // 次に向かう点: 近い通りの向きに沿って 6〜24 m 先（通れる直線）。なければほかの向き
  pickTarget(p) {
    const w = this.world, rnd = this.rnd;
    const near = w.roadnet.nearestSegment(p.x, p.z, 25);
    const dirs = [];
    if (near) {
      const s = near.seg, L = Math.hypot(s.bx - s.ax, s.bz - s.az) || 1, ux = (s.bx - s.ax) / L, uz = (s.bz - s.az) / L;
      const fwd = -Math.sin(p.yaw) * ux - Math.cos(p.yaw) * uz >= 0 ? 1 : -1; // いまの向きに近い方
      dirs.push([ux * fwd, uz * fwd], [-ux * fwd, -uz * fwd]);
    }
    for (let k = 0; k < 6; k++) {
      const a = rnd() * Math.PI * 2;
      dirs.push([Math.cos(a), Math.sin(a)]);
    }
    for (const [dx, dz] of dirs) {
      for (const len of [6 + rnd() * 18, 4 + rnd() * 4]) {
        const tx = p.x + dx * len, tz = p.z + dz * len;
        let good = this.ok(tx, tz);
        for (let u = 0.8; good && u < len; u += 0.8) good = this.ok(p.x + dx * u, p.z + dz * u);
        if (good && w.collision.raycast(p.x, p.z, tx, tz) >= 1) {
          p.tx = tx;
          p.tz = tz;
          return true;
        }
      }
    }
    return false;
  }

  update(dt, player) {
    if (!this.station) return;
    if (this.pending > 0) {
      this.pending -= dt;
      if (this.pending <= 0 && !this.populate()) this.pending = 1;
      return;
    }
    const w = this.world, M = new THREE.Matrix4(), L = new THREE.Matrix4(), Q = new THREE.Quaternion(), S = new THREE.Vector3(), V = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
    const R = new THREE.Matrix4();
    this.people.forEach((p, i) => {
      let moving = false;
      if (!p.stand) {
        if (p.wait > 0) p.wait -= dt;
        else {
          const dx = p.tx - p.x, dz = p.tz - p.z, d = Math.hypot(dx, dz);
          // 歩く人（プレーヤー）の前では止まる
          const pd = Math.hypot(player.x - p.x, player.z - p.z);
          const blocked = pd < 1.3 && (player.x - p.x) * dx + (player.z - p.z) * dz > 0 && Math.abs(player.y - p.y) < 2;
          if (d < 0.3) {
            if (!this.pickTarget(p)) p.wait = 1 + this.rnd() * 2;
            else if (this.rnd() < 0.15) p.wait = 0.5 + this.rnd() * 2.5;
          } else if (!blocked) {
            const step = Math.min(d, p.speed * dt);
            p.x += (dx / d) * step;
            p.z += (dz / d) * step;
            const want = Math.atan2(-dx, -dz);
            let da = want - p.yaw;
            da = Math.atan2(Math.sin(da), Math.cos(da));
            p.yaw += da * Math.min(1, dt * 8);
            p.phase += step / (0.72 * p.h);
            moving = true;
            const gy = w.groundAt(p.x, p.z, p.y + 0.6);
            if (Number.isFinite(gy)) p.y = gy;
          }
        }
      }
      // 脚を振る（歩いていなければ止める）
      const swing = moving ? Math.sin(p.phase * Math.PI) * 0.42 : (p.swing || 0) * 0.8;
      p.swing = swing;
      const bob = moving ? Math.abs(Math.cos(p.phase * Math.PI)) * 0.025 : 0;
      Q.setFromAxisAngle(up, p.yaw);
      M.compose(V.set(p.x, p.y + bob, p.z), Q, S.setScalar(p.h));
      this.torsos.setMatrixAt(i, M);
      this.heads.setMatrixAt(i, M);
      this.hairs.setMatrixAt(i, M);
      for (const [k, sx, sg] of [[0, -0.1, 1], [1, 0.1, -1]]) {
        L.makeTranslation(sx, HIP, 0).multiply(R.makeRotationX(swing * sg));
        this.legs.setMatrixAt(i * 2 + k, L.premultiply(M));
      }
    });
    for (const m of [this.torsos, this.heads, this.hairs, this.legs]) m.instanceMatrix.needsUpdate = true;
  }
}

// 出入口の横の駐輪の柵と自転車・電動キックボード（駅ごとに 1 つのメッシュ）
function parkedVehicles(life, station, pits, rnd) {
  const B = new Builder(), w = life.world;
  let racks = 0, scooters = 0;
  for (const e of pits) {
    if (e.kind !== 'metro' || e.rim == null) continue;
    const f = entranceFrame(e), L = e.len / 2, W = e.wid / 2;
    // 吹き抜けの横（両側）に、吹き抜けに沿った柵の列。上の端の手前から
    for (const side of rnd() < 0.5 ? [1, -1] : [-1, 1]) {
      const v = side * (W + 1.6 + rnd() * 0.8);
      const row = [];
      for (let u = -L - 1.5; u <= L - 0.5 && row.length < 6; u += 0.85) {
        const [x, z] = f.at(u, v);
        // 自転車の前後（吹き抜けと直角に ±0.9 m）が歩道の上
        const a = f.at(u, v - side * 0.2), b = f.at(u, v + side * 1.6);
        if (!life.ok(x, z, x, z) || !life.ok(...a, x, z) || !life.ok(...b, x, z)) {
          if (row.length) break;
          continue;
        }
        row.push([u, x, z]);
      }
      if (row.length < 3) continue;
      for (const [u, x, z] of row) {
        const y = w.groundAt(x, z, rimAt(e, u, v) + 1);
        if (!Number.isFinite(y)) continue;
        // 柵（逆 U 字の鉄の管）: 吹き抜けと直角の向きに 0.7 m
        const nx = f.sx * side, nz = f.sz * side;
        const p0 = [x + nx * 0.05, z + nz * 0.05], p1 = [x + nx * 0.75, z + nz * 0.75];
        const rc = [0.2, 0.22, 0.24];
        B.bar('rack', [p0[0], y, p0[1]], [p0[0], y + 0.72, p0[1]], 0.05, { color: rc });
        B.bar('rack', [p1[0], y, p1[1]], [p1[0], y + 0.72, p1[1]], 0.05, { color: rc });
        B.bar('rack', [p0[0], y + 0.72, p0[1]], [p1[0], y + 0.72, p1[1]], 0.05, { color: rc });
        racks++;
        if (rnd() < 0.7) {
          // 柵の横に自転車（柵と平行、前輪は通り側）
          const o = (rnd() < 0.5 ? -1 : 1) * 0.16;
          bike(B, x + nx * 0.4 + f.dx * o, z + nz * 0.4 + f.dz * o, y, nx, nz, FRAMES[Math.floor(rnd() * FRAMES.length)]);
        }
      }
      break; // 1 つの吹き抜けに 1 列
    }
    // 電動キックボード（上の端のそば）
    if (scooters < 2 && rnd() < 0.8) {
      const side = rnd() < 0.5 ? -1 : 1, [x, z] = f.at(-L - 1.2 - rnd() * 1.5, side * (W + 0.9));
      if (life.ok(x, z, x, z)) {
        const y = w.groundAt(x, z, rimAt(e, -L, 0) + 1);
        if (Number.isFinite(y)) {
          scooter(B, x, z, y, f.dx, f.dz, ['#3f9b4a', '#1aa39a', '#f2f0ea'][scooters % 3]);
          scooters++;
        }
      }
    }
  }
  if (!racks && !scooters) return null;
  const mats = {
    rack: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.45, metalness: 0.6 }),
    tire: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9 }),
    frame: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.35, metalness: 0.3 }),
  };
  const g = B.build(mats, { shadows: true, name: 'parked' });
  return g;
}

// 自転車（中心 (x, z)、前の向き (fx, fz)、地面 y）
function bike(B, x, z, y, fx, fz, color) {
  const c = new THREE.Color(color).toArray(), blk = [0.06, 0.06, 0.07], steel = [0.6, 0.62, 0.64];
  const P = (u, h, s = 0) => [x + fx * u - fz * s, y + h, z + fz * u + fx * s];
  const R = 0.34;
  for (const wu of [-0.52, 0.52]) {
    let prev = null;
    for (let k = 0; k <= 16; k++) {
      const a = (k / 16) * Math.PI * 2, q = P(wu + Math.cos(a) * R, R + Math.sin(a) * R);
      if (prev) B.bar('tire', prev, q, 0.045, { color: blk });
      prev = q;
    }
    B.bar('frame', P(wu, R + 0.02, -0.04), P(wu, R + 0.02, 0.04), 0.03, { color: steel });
  }
  const bb = P(0, 0.3), seat = P(-0.13, 0.82), head = P(0.38, 0.84);
  B.bar('frame', bb, seat, 0.035, { color: c });
  B.bar('frame', P(-0.11, 0.76), head, 0.035, { color: c });
  B.bar('frame', bb, head, 0.04, { color: c });
  B.bar('frame', bb, P(-0.52, R), 0.025, { color: c });
  B.bar('frame', P(-0.11, 0.76), P(-0.52, R), 0.025, { color: c });
  B.bar('frame', head, P(0.52, R), 0.03, { color: c });
  B.bar('frame', head, P(0.36, 1.0), 0.03, { color: steel });
  B.bar('tire', P(0.36, 1.0, -0.26), P(0.36, 1.0, 0.26), 0.03, { color: blk });
  B.box('tire', ...[seat[0], seat[2]], seat[1] + 0.02, seat[1] + 0.07, fx, fz, 0.26, 0.11, { color: blk });
}

// 電動キックボード（スタンドで少し傾いて立つ）
function scooter(B, x, z, y, fx, fz, color) {
  const c = new THREE.Color(color).toArray(), blk = [0.07, 0.07, 0.08];
  const tilt = 0.12;
  const P = (u, h, s = 0) => [x + fx * u - fz * (s + h * tilt), y + h, z + fz * u + fx * (s + h * tilt)];
  B.bar('frame', P(-0.4, 0.12), P(0.38, 0.12), 0.14, { color: c });
  B.bar('frame', P(0.42, 0.12), P(0.36, 1.08), 0.045, { color: c });
  B.bar('tire', P(0.36, 1.08, -0.24), P(0.36, 1.08, 0.24), 0.035, { color: blk });
  for (const wu of [-0.45, 0.45]) {
    let prev = null;
    for (let k = 0; k <= 12; k++) {
      const a = (k / 12) * Math.PI * 2, q = P(wu + Math.cos(a) * 0.11, 0.11 + Math.sin(a) * 0.11);
      if (prev) B.bar('tire', prev, q, 0.05, { color: blk });
      prev = q;
    }
  }
}

// ---------------------------------------------------------------- 雲
export function makeClouds() {
  const R = 6000;
  const geo = new THREE.PlaneGeometry(2 * R, 2 * R, 1, 1);
  geo.rotateX(-Math.PI / 2);
  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    fog: false,
    uniforms: { uTime: { value: 0 }, uRadius: { value: R }, uSun: { value: new THREE.Vector3(0.4, 0.8, 0.3) } },
    vertexShader: `
      varying vec3 vWorld;
      void main() {
        vec4 w = modelMatrix * vec4(position, 1.0);
        vWorld = w.xyz;
        gl_Position = projectionMatrix * viewMatrix * w;
      }`,
    fragmentShader: `
      uniform float uTime, uRadius;
      uniform vec3 uSun;
      varying vec3 vWorld;
      float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float noise(vec2 p) {
        vec2 i = floor(p), f = fract(p);
        vec2 u = f * f * (3.0 - 2.0 * f);
        return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
      }
      float fbm(vec2 p) {
        float v = 0.0, a = 0.5;
        for (int k = 0; k < 5; k++) { v += a * noise(p); p = p * 2.03 + vec2(1.7, 9.2); a *= 0.5; }
        return v;
      }
      void main() {
        vec2 p = vWorld.xz * 0.0011 + vec2(uTime * 0.006, uTime * 0.002);
        float n = fbm(p);
        float n2 = fbm(p * 2.7 + 4.0);
        float cov = smoothstep(0.5, 0.74, n * 0.8 + n2 * 0.25);
        float r = length(vWorld.xz - cameraPosition.xz) / uRadius;
        float fade = 1.0 - smoothstep(0.35, 0.92, r);
        // 雲の底は少し灰色、厚い所ほど白く明るい
        vec3 col = mix(vec3(0.72, 0.75, 0.8), vec3(1.0, 0.99, 0.97), smoothstep(0.45, 0.85, n2 + 0.2));
        gl_FragColor = vec4(col * 1.25, cov * fade * 0.9);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'clouds';
  mesh.renderOrder = -999;
  mesh.frustumCulled = false;
  return mesh;
}
