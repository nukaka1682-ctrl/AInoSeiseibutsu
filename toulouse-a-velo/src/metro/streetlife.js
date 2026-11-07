// 地上の街のにぎわい（メトロのゲーム）: 歩道を歩く人、出入口のそばの駐輪の柵（アーチ形の鉄の柵）と自転車・電動キックボード、空の雲。
// - 歩く人: 道路（車道）の外・建物の外の歩道を、近い通りの向きに沿って歩く（駅のまわり R m の中）。脚と腕を振って歩く。
//   なめらかな体（people.js）を部品ごとに InstancedMesh で（胴 2 種・頭・髪 2 種・脚・腕・手・リュック）。服・肌・髪の色は人ごと
// - 自転車: 出入口の吹き抜けの横の歩道に、吹き抜けに沿って並べた柵と、柵につないだ自転車（フレームの色はいろいろ）。
//   ときどき電動キックボード（スタンドで少し傾いて立つ）
// - 通りに面した店: カフェのテラス（縞の日よけ・丸いテーブルと籐の椅子）、薬局の緑の十字、たばこ屋の赤い「carotte」
// - 雲: カメラの上 1500 m の大きな円盤に、シェーダーで fbm の雲（ゆっくり流れる。地平線に向かって薄く）
import * as THREE from 'three';
import { Builder } from './geom.js';
import { mulberry32 } from '../geo.js';
import { entranceFrame, inEntrance, rimAt } from '../world/metro.js';
import { CAR_ROADS } from '../world/parse.js';
import { CollisionWorld } from '../game/collision.js';
import { HIP_X, HIP_Y, SHOULDER_X, SHOULDER_Y, armGeometry, bagGeometry, hairGeometry, handGeometry, headGeometry, legGeometry, personLook, skirtGeometry, torsoGeometry } from './people.js';

const FRAMES = ['#c0392b', '#1d1d1f', '#e8e6e0', '#2e5e8c', '#3c6e47', '#8a8d91', '#d4a017', '#5b3a6e'];

let personMat = null;
function material() {
  return (personMat ||= new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.78 }));
}

// 歩く人の部品: geo（局所の形）、color（人の見た目からの色）、who（その部品を持つ人）、limb（'leg' | 'arm' なら左右 2 つ、関節で回す）
function partList() {
  const fill = (g) => {
    if (!g.attributes.color) {
      const c = new Float32Array(g.attributes.position.count * 3).fill(1);
      g.setAttribute('color', new THREE.BufferAttribute(c, 3));
    }
    return g;
  };
  return [
    { geo: fill(torsoGeometry({ kind: 'm' })), color: (l) => l.top, who: (l) => l.kind === 'm' && !l.coat },
    { geo: fill(torsoGeometry({ kind: 'm', coat: true })), color: (l) => l.top, who: (l) => l.kind === 'm' && l.coat },
    { geo: fill(torsoGeometry({ kind: 'f' })), color: (l) => l.top, who: (l) => l.kind === 'f' && !l.coat },
    { geo: fill(torsoGeometry({ kind: 'f', coat: true })), color: (l) => l.top, who: (l) => l.kind === 'f' && l.coat },
    { geo: skirtGeometry(), color: (l) => l.bottom, who: (l) => l.skirt },
    { geo: headGeometry(), color: (l) => l.skin, who: () => true },
    { geo: hairGeometry(0), color: (l) => l.hairColor, who: (l) => l.hair === 0 },
    { geo: hairGeometry(1), color: (l) => l.hairColor, who: (l) => l.hair === 1 },
    { geo: hairGeometry(2), color: (l) => l.hairColor, who: (l) => l.hair === 2 },
    { geo: bagGeometry(0), color: (l) => l.bagColor, who: (l) => l.bag === 0 },
    { geo: bagGeometry(1), color: (l) => l.bagColor, who: (l) => l.bag === 1 },
    { geo: legGeometry({ knee: 0.08 }), color: (l) => (l.skirt ? l.skin : l.bottom), who: () => true, limb: 'leg' },
    { geo: armGeometry({ elbow: 0.18 }), color: (l) => l.top, who: (l) => !l.short, limb: 'arm' },
    { geo: armGeometry({ elbow: 0.18, short: true }), color: (l) => l.top, who: (l) => l.short, limb: 'arm' },
    { geo: handGeometry({ elbow: 0.18 }), color: (l) => l.skin, who: (l) => !l.short, limb: 'arm' },
    { geo: handGeometry({ elbow: 0.18, short: true }), color: (l) => l.skin, who: (l) => l.short, limb: 'arm' },
  ];
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
    const mat = material();
    this.parts = partList().map((pt) => {
      const m = new THREE.InstancedMesh(pt.geo, mat, count * (pt.limb ? 2 : 1));
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.castShadow = true;
      m.frustumCulled = false;
      m.count = 0;
      this.group.add(m);
      return { ...pt, mesh: m, members: [] };
    });
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
    for (const g of [this.parked, this.shops]) {
      if (!g) continue;
      this.group.remove(g);
      g.traverse((o) => o.geometry?.dispose());
    }
    this.parked = this.shops = null;
    if (this.solid) this.world.collision.remove(this.solid);
    this.solid = null;
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
      const look = personLook(rnd);
      const p = {
        x, z, y: w.groundAt(x, z, 999), yaw: rnd() * Math.PI * 2, speed: (look.kind === 'f' ? 1.15 : 1.25) + rnd() * 0.35, tx: x, tz: z, wait: rnd() * 2, phase: rnd() * 10,
        h: look.h, stand: rnd() < 0.12, look,
      };
      this.people.push(p);
    }
    const c = new THREE.Color();
    for (const pt of this.parts) {
      pt.members = this.people.filter((p) => pt.who(p.look));
      pt.members.forEach((p, i) => {
        c.set(pt.color(p.look));
        for (let k = 0; k < (pt.limb ? 2 : 1); k++) pt.mesh.setColorAt(pt.limb ? i * 2 + k : i, c);
      });
      if (pt.mesh.instanceColor) pt.mesh.instanceColor.needsUpdate = true;
      pt.mesh.count = pt.members.length * (pt.limb ? 2 : 1);
    }
    this.parked = parkedVehicles(this, s, this.pits, rnd);
    if (this.parked) this.group.add(this.parked);
    const shops = shopFronts(this, s, rnd);
    if (shops) {
      this.shops = shops.group;
      this.group.add(this.shops);
      this.solid = shops.solid;
      this.world.collision.add(this.solid);
    }
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
    const R = new THREE.Matrix4(), R2 = new THREE.Matrix4();
    this.people.forEach((p) => {
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
      // 脚と腕を振る（歩いていなければ止める）
      const swing = moving ? Math.sin(p.phase * Math.PI) * 0.4 : (p.swing || 0) * 0.8;
      p.swing = swing;
      const bob = moving ? Math.abs(Math.cos(p.phase * Math.PI)) * 0.022 : 0;
      Q.setFromAxisAngle(up, p.yaw);
      p.M ||= new THREE.Matrix4();
      p.M.compose(V.set(p.x, p.y + bob, p.z), Q, S.setScalar(p.h));
    });
    for (const pt of this.parts) {
      pt.members.forEach((p, i) => {
        if (!pt.limb) {
          pt.mesh.setMatrixAt(i, p.M);
          return;
        }
        for (const [k, sg] of [[0, -1], [1, 1]]) {
          if (pt.limb === 'leg') L.makeTranslation(sg * HIP_X, HIP_Y, 0).multiply(R.makeRotationX(p.swing * sg));
          else L.makeTranslation(sg * SHOULDER_X, SHOULDER_Y, 0).multiply(R.makeRotationZ(sg * 0.07)).multiply(R2.makeRotationX(-p.swing * sg * 0.75));
          pt.mesh.setMatrixAt(i * 2 + k, L.premultiply(p.M));
        }
      });
      pt.mesh.instanceMatrix.needsUpdate = true;
    }
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

// ---------------------------------------------------------------- 通りに面した店
// 通りに面した壁の候補: 道路の縁から外へ光線を飛ばして当たった所 { x, z（壁の点）, nx, nz（道路から壁へ）, ux, uz（通りの向き）, walk（歩道の幅） }
function facadeSpots(life, s, reach = 65) {
  const w = life.world, rn = w.roadnet, out = [], seen = new Set();
  rn.segGrid.query(s.x - reach, s.z - reach, s.x + reach, s.z + reach, (i) => {
    if (seen.has(i)) return;
    seen.add(i);
    const g = rn.segs[i], road = g.road;
    if (!CAR_ROADS.has(road.type) && road.type !== 'pedestrian' && road.type !== 'living_street') return;
    const L = Math.hypot(g.bx - g.ax, g.bz - g.az);
    if (L < 4) return;
    const ux = (g.bx - g.ax) / L, uz = (g.bz - g.az) / L;
    for (let t = 2; t < L - 2; t += 3) {
      const cx = g.ax + ux * t, cz = g.az + uz * t;
      if (Math.hypot(cx - s.x, cz - s.z) > reach) continue;
      for (const sd of [1, -1]) {
        const nx = -uz * sd, nz = ux * sd, e0 = road.width / 2 + 0.3;
        const ax = cx + nx * e0, az = cz + nz * e0;
        const f = w.collision.raycast(ax, az, ax + nx * 10, az + nz * 10);
        if (f >= 1 || f * 10 < 1.4) continue;
        const d = f * 10, x = ax + nx * d, z = az + nz * d;
        // 歩道（壁の手前 0.6 m と、歩道の真ん中）が歩ける所
        if (!life.ok(x - nx * 0.6, z - nz * 0.6, s.x, s.z) || !life.ok(ax + nx * d * 0.5, az + nz * d * 0.5, s.x, s.z)) continue;
        out.push({ x, z, nx, nz, ux, uz, walk: d, ax, az });
      }
    }
  });
  return out;
}

// 同じ壁が span m 続くか（両端から同じように光線を飛ばして、歩道の幅が近い）
function facadeRun(life, p, span) {
  const w = life.world;
  for (const k of [-span / 2, span / 2]) {
    const ax = p.ax + p.ux * k, az = p.az + p.uz * k;
    const f = w.collision.raycast(ax, az, ax + p.nx * 10, az + p.nz * 10);
    if (f >= 1 || Math.abs(f * 10 - p.walk) > 0.5) return false;
  }
  return true;
}

let stripeTex = null, carotteTex = null, pharmaTex = null;
function canvasTex(w, h, draw, repeat = false) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

function shopMaterials() {
  stripeTex ||= canvasTex(64, 8, (x, W, H) => {
    x.fillStyle = '#b3221d';
    x.fillRect(0, 0, W, H);
    x.fillStyle = '#f3ede2';
    x.fillRect(W / 2, 0, W / 2, H);
  }, true);
  carotteTex ||= canvasTex(128, 256, (x, W, H) => {
    x.clearRect(0, 0, W, H);
    x.fillStyle = '#d4161c';
    x.beginPath();
    x.moveTo(W / 2, 4);
    x.lineTo(W - 6, H / 2);
    x.lineTo(W / 2, H - 4);
    x.lineTo(6, H / 2);
    x.closePath();
    x.fill();
    x.fillStyle = '#ffffff';
    x.font = 'bold 26px Arial';
    x.textAlign = 'center';
    x.textBaseline = 'middle';
    x.fillText('TABAC', W / 2, H / 2);
  });
  pharmaTex ||= canvasTex(512, 96, (x, W, H) => {
    x.fillStyle = '#f4f6f2';
    x.fillRect(0, 0, W, H);
    x.fillStyle = '#138a3e';
    x.font = 'bold 58px Arial';
    x.textAlign = 'center';
    x.textBaseline = 'middle';
    x.fillText('PHARMACIE', W / 2, H / 2 + 3);
  });
  return {
    paint: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, metalness: 0.2 }),
    awning: new THREE.MeshStandardMaterial({ map: stripeTex, roughness: 0.8, side: THREE.DoubleSide }),
    green: new THREE.MeshBasicMaterial({ color: '#1fc35a' }),
    carotte: new THREE.MeshBasicMaterial({ map: carotteTex, alphaTest: 0.5, side: THREE.DoubleSide }),
    pharma: new THREE.MeshBasicMaterial({ map: pharmaTex }),
  };
}

// カフェのテラス・薬局・たばこ屋を、駅のまわりの通りに面した壁に 1 つずつ
function shopFronts(life, s, rnd) {
  if (typeof document === 'undefined') return null;
  const w = life.world, spots = facadeSpots(life, s);
  for (let i = spots.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [spots[i], spots[j]] = [spots[j], spots[i]];
  }
  const B = new Builder(), solid = new CollisionWorld({ minX: s.x - 90, minZ: s.z - 90, maxX: s.x + 90, maxZ: s.z + 90 });
  solid.rect = { minX: s.x - 90, minZ: s.z - 90, maxX: s.x + 90, maxZ: s.z + 90 };
  const used = [];
  const far = (p, m) => used.every((q) => Math.hypot(p.x - q.x, p.z - q.z) > m) && !inEntrance(life.pits, p.x - p.nx * 2, p.z - p.nz * 2, 3);
  const yAt = (x, z) => {
    const y = w.groundAt(x, z, w.terrain.h(x, z) + 1.5);
    return Number.isFinite(y) ? y : w.terrain.h(x, z);
  };
  // カフェのテラス（歩道の広い所）
  const cafe = spots.find((p) => p.walk >= 3.8 && far(p, 0) && facadeRun(life, p, 7));
  if (cafe) {
    used.push(cafe);
    terrace(B, solid, cafe, yAt(cafe.x - cafe.nx, cafe.z - cafe.nz), rnd);
  }
  // 薬局（緑の十字）とたばこ屋
  const ph = spots.find((p) => p.walk >= 2 && far(p, 14) && facadeRun(life, p, 3));
  if (ph) {
    used.push(ph);
    const y = yAt(ph.x - ph.nx, ph.z - ph.nz);
    const ox = ph.x - ph.nx * 0.55, oz = ph.z - ph.nz * 0.55, cy = y + 3.4;
    B.box('paint', ph.x - ph.nx * 0.25, ph.z - ph.nz * 0.25, cy - 0.03, cy + 0.03, ph.nx, ph.nz, 0.5, 0.04, { color: [0.3, 0.32, 0.34] });
    B.box('green', ox, oz, cy - 0.11, cy + 0.11, ph.nx, ph.nz, 0.62, 0.12);
    B.box('green', ox, oz, cy - 0.31, cy + 0.31, ph.nx, ph.nz, 0.22, 0.12);
    // 店の上の「PHARMACIE」
    const tx = ph.x - ph.nx * 0.03 + ph.ux * 1.6, tz = ph.z - ph.nz * 0.03 + ph.uz * 1.6;
    const nn = [-ph.nx, -ph.nz], uu = [nn[1], -nn[0]]; // 見る人の右
    const P = (a, b) => [tx + uu[0] * a, y + b, tz + uu[1] * a];
    B.quad('pharma', P(-1.3, 2.75), P(1.3, 2.75), P(1.3, 3.2), P(-1.3, 3.2), [nn[0], 0, nn[1]], { uvs: [[0, 0], [1, 0], [1, 1], [0, 1]] });
  }
  const tb = spots.find((p) => p.walk >= 1.8 && far(p, 14));
  if (tb) {
    used.push(tb);
    const y = yAt(tb.x - tb.nx, tb.z - tb.nz), cy = y + 3.3;
    const ox = tb.x - tb.nx * 0.5, oz = tb.z - tb.nz * 0.5;
    B.box('paint', tb.x - tb.nx * 0.2, tb.z - tb.nz * 0.2, cy + 0.42, cy + 0.46, tb.nx, tb.nz, 0.45, 0.04, { color: [0.3, 0.32, 0.34] });
    const P = (a, b) => [ox + tb.nx * a, cy + b, oz + tb.nz * a];
    B.quad('carotte', P(-0.22, -0.45), P(0.22, -0.45), P(0.22, 0.45), P(-0.22, 0.45), [tb.ux, 0, tb.uz], { uvs: [[0, 0], [1, 0], [1, 1], [0, 1]] });
  }
  if (!used.length) return null;
  const group = B.build(shopMaterials(), { shadows: true, name: 'shops' });
  life.shopSpots = { cafe, pharmacie: ph, tabac: tb }; // 撮影・確認用
  return { group, solid };
}

// カフェのテラス: 壁に縞の日よけ、その下に丸いテーブルと籐の椅子（椅子は通りの方を向く）
function terrace(B, solid, p, y, rnd) {
  const out = [-p.nx, -p.nz]; // 壁から通りへ
  const W = 3.2, D = 2.1;
  const P = (a, d, h) => [p.x + p.ux * a + out[0] * d, y + h, p.z + p.uz * a + out[1] * d];
  // 日よけ（壁の 3.1 m から、2.1 m 先で 2.45 m）と前の垂れ
  const nn = [out[0] * 0.3, 0.95, out[1] * 0.3];
  B.quad('awning', P(-W, 0.02, 3.1), P(W, 0.02, 3.1), P(W, D, 2.45), P(-W, D, 2.45), nn, { uvs: [[0, 0], [2 * W / 0.5, 0], [2 * W / 0.5, 1], [0, 1]] });
  B.quad('awning', P(-W, D, 2.45), P(W, D, 2.45), P(W, D, 2.2), P(-W, D, 2.2), [out[0], 0, out[1]], { uvs: [[0, 0], [2 * W / 0.5, 0], [2 * W / 0.5, 0.3], [0, 0.3]] });
  for (const a of [-W, W]) B.quad('awning', P(a, 0.02, 3.1), P(a, D, 2.45), P(a, D, 2.2), P(a, 0.02, 2.2 + 0.0), [p.ux, 0, p.uz], { uvs: [[0, 0], [1, 0], [1, 0.3], [0, 0.3]] });
  // テーブルと椅子
  const wood = [0.55, 0.38, 0.22], rattan = [[0.72, 0.6, 0.38], [0.2, 0.32, 0.5], [0.62, 0.2, 0.18]][Math.floor(rnd() * 3)], metal = [0.12, 0.12, 0.13];
  for (const a of [-2.3, -0.8, 0.8, 2.3]) {
    const [tx, , tz] = P(a, 1.25, 0);
    B.cyl('paint', tx, tz, y + 0.72, y + 0.75, 0.33, { seg: 16, color: [0.92, 0.91, 0.88] });
    B.cyl('paint', tx, tz, y + 0.02, y + 0.72, 0.035, { seg: 6, color: metal });
    B.cyl('paint', tx, tz, y, y + 0.03, 0.22, { seg: 10, color: metal });
    solid.addCircle(tx, tz, 0.42);
    for (const k of [-0.42, 0.42]) {
      if (rnd() < 0.15) continue;
      const [cx, , cz] = P(a + k, 0.75, 0);
      // 座面・背もたれ（壁の側）・脚
      B.box('paint', cx, cz, y + 0.44, y + 0.48, p.ux, p.uz, 0.4, 0.4, { color: rattan });
      const [bx, , bz] = P(a + k, 0.57, 0);
      B.box('paint', bx, bz, y + 0.48, y + 0.86, p.ux, p.uz, 0.4, 0.04, { color: rattan });
      for (const [da, dd] of [[-0.17, -0.17], [0.17, -0.17], [-0.17, 0.17], [0.17, 0.17]]) {
        const [lx, , lz] = P(a + k + da, 0.75 + dd, 0);
        B.box('paint', lx, lz, y, y + 0.45, p.ux, p.uz, 0.025, 0.025, { color: wood });
      }
    }
  }
  // 黒板の立て看板（メニュー）
  const [mx, , mz] = P(W + 0.4, 1.6, 0);
  B.box('paint', mx, mz, y, y + 0.95, p.ux, p.uz, 0.5, 0.06, { color: [0.08, 0.09, 0.09] });
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
