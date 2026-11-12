// 自転車のゲームの街のにぎわい: ① 歩道を歩く人 ② カフェのテラスに座る客 ③ 広場のハト。
// 人形はメトロのゲームの歩く人（metro/streetlife.js の StreetLife・metro/people.js）と同じ。中心は自転車で、
// 遠くなった人は自転車の前の方へ置き直す。計算のうち three.js に依らない所は lifelogic.js（単体テスト）。
// 自転車の x / z / y / heading / speed を読み、人に当たったときだけ speed を下げる（ほかは書かない）。
// 描画コール: 歩く人の部品 16（影は胴・スカート・脚の 6）、客 6、ハト 2
import * as THREE from 'three';
import { mulberry32, pointInPolygon } from '../geo.js';
import { historicCoreTest, oldTownTest } from '../config.js';
import { CAR_ROADS } from '../world/parse.js';
import { material, partList } from '../metro/streetlife.js';
import { HIP_X, HIP_Y, SHOULDER_X, SHOULDER_Y, personGeometry, personLook } from '../metro/people.js';
import { dodge, inBellCone, newPigeon, pigeonStep, respawnPoint, seatHash, terraceSeats } from './lifelogic.js';

const SEAT_TYPES = 6; // 座る客の人形の種類
const MAX_SEATED = 160;
const SEAT_FAR = 160; // 自転車からこれより遠いテラスには座らせない（m）
const REBUILD = 40; // 自転車がこれだけ動いたら、客・ハトの場所を選び直す（m）
const FLOCK_FAR = 130;
const MAX_FLOCKS = 5;
const MAX_PIGEONS = 60;
const SHADOW_PARTS = 6; // partList の最初の 5 つ（胴 4・スカート）と脚

const isCar = (s) => CAR_ROADS.has(s.road.type);

// 使い回す行列・ベクトル（毎フレーム new しない）
const _M = new THREE.Matrix4(), _L = new THREE.Matrix4(), _R = new THREE.Matrix4(), _R2 = new THREE.Matrix4();
const _Q = new THREE.Quaternion(), _E = new THREE.Euler(), _V = new THREE.Vector3(), _S = new THREE.Vector3(), _UP = new THREE.Vector3(0, 1, 0);
const ZERO = new THREE.Matrix4().makeScale(0, 0, 0);

export class CityLife {
  // world: assembleWorld / assembleStreamWorld の結果
  constructor(world, { people = 70, radius = 110, seed = 23 } = {}) {
    this.world = world;
    this.radius = radius;
    this.rnd = mulberry32(seed);
    this.events = [];
    this.group = new THREE.Group();
    this.group.name = 'city-life';
    this.inCore = historicCoreTest(world.proj);
    this.inOld = oldTownTest(world.proj);
    this.plazas = (world.parsed?.areas || []).filter((a) => a.type === 'plaza');
    this.clock = 0;
    this.lastBump = -Infinity;
    this.started = false;

    // ① 歩く人: 人ごとの席（見た目は固定。置き直すときは場所だけ変える）
    const rnd = this.rnd;
    this.people = Array.from({ length: people }, (_, i) => {
      const look = personLook(rnd);
      return {
        i, look, h: look.h, active: false, x: 0, z: 0, y: 0, yaw: 0, tx: 0, tz: 0, otx: 0, otz: 0, wait: 0, phase: rnd() * 10,
        speed: (look.kind === 'f' ? 1.15 : 1.25) + rnd() * 0.35, stand: false, mate: null, lead: false, hold: 0, face: 0, swing: 0, M: new THREE.Matrix4(),
      };
    });
    const mat = material();
    this.parts = partList().map((pt, k) => {
      const m = new THREE.InstancedMesh(pt.geo, mat, people * (pt.limb ? 2 : 1));
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      // 影は胴・脚だけ（頭・髪・腕・手・鞄は影なし。影の描画コールを減らす）
      m.castShadow = k < SHADOW_PARTS - 1 || pt.limb === 'leg';
      m.receiveShadow = true;
      m.frustumCulled = false;
      m.name = 'life-walker';
      const members = this.people.filter((p) => pt.who(p.look));
      const c = new THREE.Color();
      members.forEach((p, i) => {
        c.set(pt.color(p.look));
        for (let j = 0; j < (pt.limb ? 2 : 1); j++) m.setColorAt(pt.limb ? i * 2 + j : i, c);
        for (let j = 0; j < (pt.limb ? 2 : 1); j++) m.setMatrixAt(pt.limb ? i * 2 + j : i, ZERO);
      });
      m.count = members.length * (pt.limb ? 2 : 1);
      this.group.add(m);
      return { ...pt, mesh: m, members };
    });

    // ② テラスの客: 座った人形 6 種類（種は固定）。種類ごとに 1 つの InstancedMesh
    const srnd = mulberry32(seed + 101);
    this.seatMeshes = Array.from({ length: SEAT_TYPES }, () => {
      const look = personLook(srnd);
      const m = new THREE.InstancedMesh(personGeometry(srnd, 'sit', look), mat, MAX_SEATED);
      m.h = look.h;
      m.count = 0;
      m.frustumCulled = false;
      m.receiveShadow = true;
      m.name = 'life-seated';
      this.group.add(m);
      return m;
    });
    this.seated = 0;
    this.builtAt = null;
    this.builtTiles = -1;

    // ③ ハト: 胴と翼（左右で 2 インスタンス）
    this.body = new THREE.InstancedMesh(pigeonBody(), mat, MAX_PIGEONS);
    this.wings = new THREE.InstancedMesh(pigeonWing(), new THREE.MeshStandardMaterial({ color: '#80858e', roughness: 0.85, side: THREE.DoubleSide }), MAX_PIGEONS * 2);
    for (const m of [this.body, this.wings]) {
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.count = 0;
      m.frustumCulled = false;
      m.name = 'life-pigeons';
      this.group.add(m);
    }
    this.sites = new Map(); // 群れの場所（key → { x, z, n, seed }）
    this.flocks = new Map(); // 生きている群れ（key → flock）
    this.bellAt = null;
  }

  // ---------------------------------------------------------------- 歩ける所
  // 水・エリアの外・建物や小物・読み込み前のタイル・車道の上でなく、道か広場のそば
  walkable(x, z) {
    const w = this.world;
    if (w.collision.outOfBounds(x, z) || w.collision.blockedByWater(x, z)) return false;
    if (w.stream && !w.stream.readyAt(x, z)) return false;
    if (w.roadnet.onRoad(x, z, -0.3, isCar)) return false;
    if (w.collision.resolve(x, z, 0.4).hit) return false;
    const n = w.roadnet.nearestSegment(x, z, 30);
    if (n && Math.sqrt(n.d2) <= n.seg.road.width / 2 + 7) return true;
    return this.inPlaza(x, z);
  }

  inPlaza(x, z) {
    for (const a of this.plazas) {
      const b = a.bounds;
      if (x < b.minX || x > b.maxX || z < b.minZ || z > b.maxZ) continue;
      if (pointInPolygon(x, z, a)) return true;
    }
    return false;
  }

  // 人の多さ: 右岸の歴史的な中心は全部、旧市街のそれ以外は 0.7、外は 0.35 の割合で採る
  dense(x, z) {
    const k = this.inCore(x, z) ? 1 : this.inOld(x, z) ? 0.7 : 0.35;
    return k >= 1 || this.rnd() < k;
  }

  groundY(x, z, y) {
    const w = this.world;
    if (y != null && w.groundAt) {
      const g = w.groundAt(x, z, y + 0.6);
      if (Number.isFinite(g)) return g;
    }
    const g = w.spawnY ? w.spawnY(x, z) : w.heightAt ? w.heightAt(x, z) : 0;
    return Number.isFinite(g) ? g : 0;
  }

  // ---------------------------------------------------------------- ① 歩く人
  // (x, z) に人を置く（25 % は 2 人連れ）。bike から 9 m 以内には置かない
  place(p, x, z, bike) {
    if (Math.hypot(x - bike.x, z - bike.z) < 9) return false;
    const rnd = this.rnd;
    Object.assign(p, { active: true, x, z, tx: x, tz: z, y: this.groundY(x, z), yaw: rnd() * Math.PI * 2, wait: rnd() * 2, stand: rnd() < 0.12, mate: null, lead: false, hold: 0, face: 0 });
    if (!p.stand && rnd() < 0.25) {
      const q = this.people.find((o) => !o.active);
      if (q) {
        // 2 人目は 1 人目の横 0.7 m を同じ速さ・同じ向きで
        const sx = Math.cos(p.yaw), sz = -Math.sin(p.yaw), mx = x + sx * 0.7, mz = z + sz * 0.7;
        if (this.walkable(mx, mz)) {
          Object.assign(q, { active: true, x: mx, z: mz, tx: mx, tz: mz, y: this.groundY(mx, mz), yaw: p.yaw, wait: p.wait, stand: false, mate: p, lead: false, hold: 0, face: 0, speed: p.speed });
          p.mate = q;
          p.lead = true;
        }
      }
    }
    return true;
  }

  release(p) {
    p.active = false;
    if (p.mate) p.mate.mate = null;
    p.mate = null;
    p.lead = false;
  }

  // 始めは自転車から 9〜radius m に散らす
  populate(bike) {
    const rnd = this.rnd, R = this.radius;
    for (let tries = 0; tries < this.people.length * 30; tries++) {
      const p = this.people.find((o) => !o.active);
      if (!p) break;
      const a = rnd() * Math.PI * 2, r = Math.sqrt(81 + rnd() * (R * R - 81));
      const x = bike.x + Math.cos(a) * r, z = bike.z + Math.sin(a) * r;
      if (this.dense(x, z) && this.walkable(x, z)) this.place(p, x, z, bike);
    }
  }

  // 遠くなった人・読み込み前のタイルにいる人を、自転車の前の方へ置き直す（1 フレームの試行は合計 12 回まで）
  recycle(bike) {
    const far = this.radius + 25, st = this.world.stream;
    for (const p of this.people) {
      if (p.active && (Math.hypot(p.x - bike.x, p.z - bike.z) > far || (st && !st.readyAt(p.x, p.z)))) this.release(p);
    }
    let budget = 12;
    for (const p of this.people) {
      if (p.active) continue;
      while (budget > 0 && !p.active) {
        budget--;
        const q = respawnPoint(this.rnd, bike, this.radius);
        if (this.dense(q.x, q.z) && this.walkable(q.x, q.z)) this.place(p, q.x, q.z, bike);
      }
      if (budget <= 0) break;
    }
  }

  // 次に向かう点: 近い通りの向きに沿って 6〜24 m 先（StreetLife.pickTarget と同じ）
  pickTarget(p) {
    const w = this.world, rnd = this.rnd;
    const near = w.roadnet.nearestSegment(p.x, p.z, 25);
    const dirs = [];
    if (near) {
      const s = near.seg, L = Math.hypot(s.bx - s.ax, s.bz - s.az) || 1, ux = (s.bx - s.ax) / L, uz = (s.bz - s.az) / L;
      const fwd = -Math.sin(p.yaw) * ux - Math.cos(p.yaw) * uz >= 0 ? 1 : -1;
      dirs.push([ux * fwd, uz * fwd], [-ux * fwd, -uz * fwd]);
    }
    for (let k = 0; k < 6; k++) {
      const a = rnd() * Math.PI * 2;
      dirs.push([Math.cos(a), Math.sin(a)]);
    }
    for (const [dx, dz] of dirs) {
      for (const len of [6 + rnd() * 18, 4 + rnd() * 4]) {
        const tx = p.x + dx * len, tz = p.z + dz * len;
        let good = this.walkable(tx, tz);
        for (let u = 0.8; good && u < len; u += 0.8) good = this.walkable(p.x + dx * u, p.z + dz * u);
        if (good && w.collision.raycast(p.x, p.z, tx, tz) >= 1) {
          p.tx = tx;
          p.tz = tz;
          // 2 人連れ: 2 人目の目標は横 0.7 m（歩けなければ 1 人ずつに）
          const q = p.mate;
          if (q && p.lead) {
            const sx = -dz, sz = dx, side = (q.x - p.x) * sx + (q.z - p.z) * sz >= 0 ? 1 : -1;
            const mx = tx + sx * side * 0.7, mz = tz + sz * side * 0.7;
            if (q.hold <= 0 && this.walkable(mx, mz)) {
              q.tx = mx;
              q.tz = mz;
              q.wait = 0;
            } else this.release2(p);
          }
          return true;
        }
      }
    }
    return false;
  }

  release2(p) {
    if (p.mate) p.mate.mate = null;
    p.mate = null;
    p.lead = false;
  }

  // よける（よけた点が歩けなければその場で止まる）。よけたあと 1.5 秒は元の目標に戻らない
  sidestep(p, at) {
    if (p.hold <= 0) {
      p.otx = p.tx;
      p.otz = p.tz;
    }
    p.hold = 1.5;
    if (at && this.walkable(at.x, at.z) && this.world.collision.raycast(p.x, p.z, at.x, at.z) >= 1) {
      p.tx = at.x;
      p.tz = at.z;
      p.wait = 0;
    } else {
      p.tx = p.x;
      p.tz = p.z;
      p.wait = 1.5;
    }
  }

  walk(dt, bike) {
    const w = this.world, rnd = this.rnd;
    const bspeed = bike.speed || 0;
    for (const p of this.people) {
      if (!p.active) continue;
      // 自転車をよける
      if (p.hold <= 0 && Math.abs(bspeed) >= 1) {
        const at = dodge({ px: p.x, pz: p.z, bx: bike.x, bz: bike.z, heading: bike.heading, speed: bspeed });
        if (at) this.sidestep(p, at);
      }
      let moving = false;
      if (p.hold > 0) {
        p.hold -= dt;
        if (p.hold <= 0 && !p.stand) {
          p.tx = p.otx;
          p.tz = p.otz;
        }
      }
      if (p.face > 0) p.face -= dt;
      const dodging = p.hold > 0;
      if (p.face > 0 && !dodging) {
        // ベル: 自転車の方を向く
        const want = Math.atan2(-(bike.x - p.x), -(bike.z - p.z));
        let da = want - p.yaw;
        da = Math.atan2(Math.sin(da), Math.cos(da));
        p.yaw += da * Math.min(1, dt * 6);
      } else if (!p.stand || dodging) {
        if (p.wait > 0) p.wait -= dt;
        else {
          const dx = p.tx - p.x, dz = p.tz - p.z, d = Math.hypot(dx, dz);
          if (d < 0.3) {
            if (dodging || p.stand) {
              // よけた所で待つ
            } else if (p.mate && !p.lead) {
              // 2 人目は 1 人目が次の目標を決めるのを待つ
            } else if (!this.pickTarget(p)) p.wait = 1 + rnd() * 2;
            else if (rnd() < 0.15) {
              p.wait = 0.5 + rnd() * 2.5;
              if (p.mate) p.mate.wait = p.wait;
            }
          } else {
            const step = Math.min(d, p.speed * (dodging ? 1.6 : 1) * dt);
            p.x += (dx / d) * step;
            p.z += (dz / d) * step;
            const want = Math.atan2(-dx, -dz);
            let da = want - p.yaw;
            da = Math.atan2(Math.sin(da), Math.cos(da));
            p.yaw += da * Math.min(1, dt * 8);
            p.phase += step / (0.72 * p.h);
            moving = true;
            p.y = this.groundY(p.x, p.z, p.y);
          }
        }
      }
      // 自転車に当たった: 人を押し出し、自転車を遅くする
      const rx = p.x - bike.x, rz = p.z - bike.z, rd = Math.hypot(rx, rz);
      if (rd < 0.55 && Math.abs(p.y - (bike.y ?? p.y)) < 2) {
        const ux = rd > 1e-4 ? rx / rd : Math.cos(bike.heading), uz = rd > 1e-4 ? rz / rd : Math.sin(bike.heading);
        const nx = p.x + ux * 0.6, nz = p.z + uz * 0.6;
        if (this.walkable(nx, nz)) {
          p.x = p.tx = nx;
          p.z = p.tz = nz;
        }
        if (bike.speed > 2.2) bike.speed = 2.2; // 後退中は触らない
        if (this.clock - this.lastBump >= 2) {
          this.lastBump = this.clock;
          this.events.push({ type: 'person' });
        }
      }
      const swing = moving ? Math.sin(p.phase * Math.PI) * 0.4 : p.swing * 0.8;
      p.swing = swing;
      const bob = moving ? Math.abs(Math.cos(p.phase * Math.PI)) * 0.022 : 0;
      _Q.setFromAxisAngle(_UP, p.yaw);
      p.M.compose(_V.set(p.x, p.y + bob, p.z), _Q, _S.setScalar(p.h));
    }
    for (const pt of this.parts) {
      const mesh = pt.mesh;
      pt.members.forEach((p, i) => {
        if (!pt.limb) {
          mesh.setMatrixAt(i, p.active ? p.M : ZERO);
          return;
        }
        for (let k = 0; k < 2; k++) {
          if (!p.active) {
            mesh.setMatrixAt(i * 2 + k, ZERO);
            continue;
          }
          const sg = k === 0 ? -1 : 1;
          if (pt.limb === 'leg') _L.makeTranslation(sg * HIP_X, HIP_Y, 0).multiply(_R.makeRotationX(p.swing * sg));
          else _L.makeTranslation(sg * SHOULDER_X, SHOULDER_Y, 0).multiply(_R.makeRotationZ(sg * 0.07)).multiply(_R2.makeRotationX(-p.swing * sg * 0.75));
          mesh.setMatrixAt(i * 2 + k, _L.premultiply(p.M));
        }
      });
      mesh.instanceMatrix.needsUpdate = true;
    }
  }

  // ベルを鳴らした: 前 20 m・左右 60° の人はすぐよけ、30 m 以内の人は 1.2 秒自転車の方を向く。25 m 以内のハトは飛び立つ
  bell(bike) {
    for (const p of this.people) {
      if (!p.active) continue;
      const d = Math.hypot(p.x - bike.x, p.z - bike.z);
      if (inBellCone({ px: p.x, pz: p.z, bx: bike.x, bz: bike.z, heading: bike.heading })) {
        this.sidestep(p, dodge({ px: p.x, pz: p.z, bx: bike.x, bz: bike.z, heading: bike.heading, speed: bike.speed || 0, force: true }));
      } else if (d <= 30) p.face = 1.2;
    }
    this.bellAt = { x: bike.x, z: bike.z };
  }

  // ---------------------------------------------------------------- ② テラスの客・③ ハトの場所
  // 読み込み済みの街の小物のテラス
  terraces() {
    const w = this.world, out = [];
    const add = (list) => list && out.push(...list);
    add(w.furniture?.items?.terraces);
    if (w.stream) for (const t of w.stream.tiles.values()) if (t.state === 'ready') add(t.furniture?.items?.terraces);
    return out;
  }

  // 自転車が 40 m 動いたとき・読み込み済みのタイルの数が変わったときに、客とハトの場所を選び直す
  rebuild(bike) {
    const tiles = this.world.stream ? this.world.stream.readyCount : 0;
    if (this.builtAt && Math.hypot(bike.x - this.builtAt[0], bike.z - this.builtAt[1]) < REBUILD && tiles === this.builtTiles) return;
    this.builtAt = [bike.x, bike.z];
    this.builtTiles = tiles;
    const terraces = this.terraces();
    this.seatPeople(bike, terraces);
    this.findSites(bike, terraces);
  }

  seatPeople(bike, terraces) {
    const near = terraces.map((t) => ({ t, d: Math.hypot(t.x - bike.x, t.z - bike.z) })).filter((o) => o.d <= SEAT_FAR).sort((a, b) => a.d - b.d);
    const counts = new Array(SEAT_TYPES).fill(0);
    let n = 0;
    for (const { t } of near) {
      const seats = terraceSeats(t);
      for (let k = 0; k < 4 && n < MAX_SEATED; k++) {
        if (seatHash(t.x, t.z, k) >= 0.55) continue;
        const s = seats[k], m = this.seatMeshes[Math.floor(seatHash(t.x, t.z, k + 11) * SEAT_TYPES)];
        _Q.setFromAxisAngle(_UP, s.yaw);
        _M.compose(_V.set(s.x, s.y - 0.46 * m.h, s.z), _Q, _S.setScalar(1));
        m.setMatrixAt(counts[this.seatMeshes.indexOf(m)]++, _M);
        n++;
      }
      if (n >= MAX_SEATED) break;
    }
    this.seatMeshes.forEach((m, i) => {
      m.count = counts[i];
      m.instanceMatrix.needsUpdate = true;
    });
    this.seated = n;
  }

  // ハトの群れの場所: 広場の中の点と、テラスのそば（3〜6 m）。場所は広場・テラスの位置から決めた乱数で
  findSites(bike, terraces) {
    const reach = FLOCK_FAR + 40;
    for (const a of this.plazas) {
      const b = a.bounds, key = `p${a.id}`;
      if (this.sites.has(key) || b.maxX < bike.x - reach || b.minX > bike.x + reach || b.maxZ < bike.z - reach || b.minZ > bike.z + reach) continue;
      if (this.world.stream && !this.world.stream.readyAt((b.minX + b.maxX) / 2, (b.minZ + b.maxZ) / 2)) continue; // 読み込んでから決める
      const rnd = mulberry32(Math.abs(a.id | 0) + 7);
      let site = null;
      for (let k = 0; k < 16 && !site; k++) {
        const x = b.minX + rnd() * (b.maxX - b.minX), z = b.minZ + rnd() * (b.maxZ - b.minZ);
        if (pointInPolygon(x, z, a) && this.walkable(x, z)) site = { x, z, n: 6 + Math.floor(rnd() * 7), seed: Math.floor(rnd() * 1e9) };
      }
      this.sites.set(key, site);
    }
    for (const t of terraces) {
      const key = `t${Math.round(t.x * 10)},${Math.round(t.z * 10)}`;
      if (this.sites.has(key) || Math.hypot(t.x - bike.x, t.z - bike.z) > reach) continue;
      let site = null;
      if (seatHash(t.x, t.z, 31) < 0.35) {
        const rnd = mulberry32(Math.floor(seatHash(t.x, t.z, 32) * 1e9));
        for (let k = 0; k < 8 && !site; k++) {
          const a = rnd() * Math.PI * 2, r = 3 + rnd() * 3, x = t.x + Math.cos(a) * r, z = t.z + Math.sin(a) * r;
          if (this.walkable(x, z)) site = { x, z, n: 6 + Math.floor(rnd() * 7), seed: Math.floor(rnd() * 1e9) };
        }
      }
      this.sites.set(key, site);
    }
  }

  // 自転車から 130 m 以内の場所のうち近い順に 5 つまでを生かす（合計 60 羽まで）
  chooseFlocks(bike) {
    const near = [];
    for (const [key, s] of this.sites) {
      if (!s) continue;
      const d = Math.hypot(s.x - bike.x, s.z - bike.z);
      if (d <= FLOCK_FAR) near.push({ key, s, d });
    }
    near.sort((a, b) => a.d - b.d);
    const keep = new Set();
    let total = 0;
    for (const { key, s } of near) {
      if (keep.size >= MAX_FLOCKS || total + s.n > MAX_PIGEONS) continue;
      keep.add(key);
      total += s.n;
      if (!this.flocks.has(key)) {
        const f = { key, home: s, x: s.x, z: s.z, R: 15, dir: 1, rnd: mulberry32(s.seed), flying: false };
        f.y = this.groundY(s.x, s.z);
        f.birds = Array.from({ length: s.n }, () => newPigeon(f));
        for (const b of f.birds) b.gy = f.y;
        this.flocks.set(key, f);
      }
    }
    for (const key of this.flocks.keys()) if (!keep.has(key)) this.flocks.delete(key);
  }

  // 群れを脅かす: 元の場所から 4〜10 m の歩ける点へ下りる
  scare(f) {
    const rnd = f.rnd;
    f.cx = f.x;
    f.cz = f.z;
    f.R = 12 + rnd() * 6;
    f.dir = rnd() < 0.5 ? 1 : -1;
    let lx = f.home.x, lz = f.home.z;
    for (let k = 0; k < 8; k++) {
      const a = rnd() * Math.PI * 2, r = 4 + rnd() * 6, x = f.home.x + Math.cos(a) * r, z = f.home.z + Math.sin(a) * r;
      if (this.walkable(x, z)) {
        lx = x;
        lz = z;
        break;
      }
    }
    f.x = lx;
    f.z = lz;
    f.flying = true;
    this.events.push({ type: 'pigeons', n: f.birds.length });
  }

  pigeons(dt, bike) {
    const bell = this.bellAt;
    this.bellAt = null;
    const fast = Math.abs(bike.speed || 0) >= 1.5;
    let n = 0;
    for (const f of this.flocks.values()) {
      let scare = false;
      if (!f.flying) {
        if (bell && Math.hypot(f.x - bell.x, f.z - bell.z) <= 25) scare = true;
        if (fast && !scare) scare = f.birds.some((b) => Math.hypot(b.x - bike.x, b.z - bike.z) <= 6);
        if (scare) this.scare(f);
      }
      const threat = { scare, near: Math.hypot(f.x - bike.x, f.z - bike.z) <= 8 };
      let flying = false;
      for (const b of f.birds) {
        const was = b.state;
        pigeonStep(b, f, dt, threat);
        if (b.state !== 'ground') flying = true;
        // 地面の高さ（歩いたときと、下りたとき）
        if (b.state === 'ground' && (b.walk || was !== 'ground')) b.gy = this.groundY(b.x, b.z, f.y);
        if (n >= MAX_PIGEONS) continue;
        const y = b.state === 'ground' ? b.gy : f.y + b.h;
        _Q.setFromEuler(_E.set(-b.pitch, b.yaw, 0, 'YXZ')); // ついばむ: 頭を下げる（前は -z）
        _M.compose(_V.set(b.x, y, b.z), _Q, _S.setScalar(1));
        this.body.setMatrixAt(n, _M);
        for (let k = 0; k < 2; k++) {
          if (b.fold) {
            this.wings.setMatrixAt(n * 2 + k, ZERO);
            continue;
          }
          const sg = k === 0 ? 1 : -1;
          // 翼の付け根（肩）で回す。右の翼は x を反転
          _L.makeTranslation(0, 0.16, -0.03).multiply(_R.makeRotationZ(sg * b.wing)).multiply(_R2.makeScale(sg, 1, 1));
          this.wings.setMatrixAt(n * 2 + k, _L.premultiply(_M));
        }
        n++;
      }
      if (f.flying && !flying) f.flying = false;
    }
    this.body.count = n;
    this.wings.count = n * 2;
    this.body.instanceMatrix.needsUpdate = true;
    this.wings.instanceMatrix.needsUpdate = true;
    this.birdCount = n;
  }

  // ---------------------------------------------------------------- 毎フレーム
  // camera は使わない（無くても動く。描画なしの __tavSimulate でも呼ばれる）
  update(dt, bike) {
    const st = this.world.stream;
    if (st && !st.readyAt(bike.x, bike.z)) return; // いるタイルを読み込むまで待つ
    this.clock += dt;
    // ワープ・リスポーン（1 フレームで 30 m 以上動いた）は、始めと同じに自転車のまわりへ散らし直す
    // （輪の中へ少しずつ置き直すと、自転車のそばにしばらく誰もいない）
    if (this.started && Math.hypot(bike.x - this.lastX, bike.z - this.lastZ) > 30) {
      for (const p of this.people) this.release(p);
      this.started = false;
    }
    this.lastX = bike.x;
    this.lastZ = bike.z;
    if (!this.started) {
      this.started = true;
      this.populate(bike);
    } else this.recycle(bike);
    this.walk(dt, bike);
    this.rebuild(bike);
    this.chooseFlocks(bike);
    this.pigeons(dt, bike);
  }

  stats() {
    let birds = 0;
    for (const f of this.flocks.values()) birds += f.birds.length;
    return { people: this.people.filter((p) => p.active).length, seated: this.seated, pigeons: birds, flocks: this.flocks.size };
  }
}

// ---------------------------------------------------------------- ハトの形（体長 0.32 m。局所: 足もとが原点、前は -z）
function colored(g, hex) {
  g = g.index ? g.toNonIndexed() : g;
  const c = new THREE.Color(hex), n = g.attributes.position.count, a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) c.toArray(a, i * 3);
  g.setAttribute('color', new THREE.BufferAttribute(a, 3));
  g.deleteAttribute('uv');
  return g;
}

// 胴（灰色の楕円体）・頭と首（濃い色）・尾。三角形 60 以下
function pigeonBody() {
  const body = new THREE.SphereGeometry(0.075, 6, 4); // 36
  body.scale(1, 0.85, 1.65);
  body.rotateX(0.18); // 尾の側が少し上がる
  body.translate(0, 0.13, 0.01);
  const head = new THREE.SphereGeometry(0.04, 4, 3); // 16
  head.scale(0.9, 1.1, 1.1);
  head.translate(0, 0.21, -0.12);
  const tail = new THREE.BufferGeometry(); // 2
  tail.setAttribute('position', new THREE.Float32BufferAttribute([-0.04, 0.15, 0.1, 0.04, 0.15, 0.1, 0.035, 0.14, 0.2, -0.04, 0.15, 0.1, 0.035, 0.14, 0.2, -0.035, 0.14, 0.2], 3));
  tail.computeVertexNormals();
  const parts = [colored(body, '#8d9199'), colored(head, '#4d5361'), colored(tail, '#5a5e66')];
  return mergeSimple(parts);
}

// 翼 1 枚（左。付け根が原点、+x へ伸びる。薄い三角形 2 つ）
function pigeonWing() {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, -0.05, 0, 0, 0.08, 0.24, 0, 0.07, 0, 0, -0.05, 0.24, 0, 0.07, 0.25, 0, 0.0], 3));
  g.computeVertexNormals();
  return g;
}

// position・normal・color だけの形をつなぐ
function mergeSimple(list) {
  const out = new THREE.BufferGeometry();
  for (const name of ['position', 'normal', 'color']) {
    const arrs = list.map((g) => g.attributes[name].array);
    const all = new Float32Array(arrs.reduce((s, a) => s + a.length, 0));
    let o = 0;
    for (const a of arrs) {
      all.set(a, o);
      o += a.length;
    }
    out.setAttribute(name, new THREE.BufferAttribute(all, 3));
  }
  return out;
}
