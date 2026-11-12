// スミレ集め: トゥールーズは「スミレの街」（la Violette de Toulouse）。自由走行のとき、名所のまわりの道に
// スミレの花が浮いていて、走って集める。置き場所は名所の id から決まる（撮影・遊ぶたびに同じ所）。
import * as THREE from 'three';
import { mulberry32 } from '../geo.js';

export const VIOLETS_PER_LANDMARK = 3;
const MIN_FROM_LANDMARK = 35; // 名所の approach から（名所の発見と重ならないように）
const MIN_BETWEEN = 25; // ほかのスミレから
const TRIES = 8;
const DRAW_RANGE = 220; // 自転車からこの距離までの花を描く
const PICK_RADIUS = 2.4; // 集める距離（水平）
const PICK_DY = 3; // 高さの差（橋の上と下を取り違えない）
const FLOAT_Y = 1.0;

// 文字列 → 32 bit の種（FNV-1a）
function hashString(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// 置き場所を決める（純粋な関数）。nearestRideable(x, z) は道の上の点 { x, z } か null。
// 名所ごとに 3 つ: 名所 id と番号 k から決めた乱数で向き（0〜2π）と距離（70〜230 m）を決め、approach からずらした点を道の上に移す。
// 名所の approach から 35 m 以内・ほかのスミレから 25 m 以内なら、乱数を進めてやり直す（8 回まで。だめならその花は無し）
export function planViolets(landmarks, nearestRideable) {
  const out = [];
  for (const lm of landmarks) {
    const a = lm.approach || lm;
    for (let k = 0; k < VIOLETS_PER_LANDMARK; k++) {
      const rnd = mulberry32(hashString(lm.id) ^ Math.imul(k + 1, 0x9e3779b1));
      for (let t = 0; t < TRIES; t++) {
        const ang = rnd() * Math.PI * 2;
        const dist = 70 + rnd() * 160;
        const p = nearestRideable(a.x + Math.sin(ang) * dist, a.z + Math.cos(ang) * dist);
        if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.z)) continue;
        if (Math.hypot(p.x - a.x, p.z - a.z) <= MIN_FROM_LANDMARK) continue;
        if (out.some((o) => Math.hypot(o.x - p.x, o.z - p.z) <= MIN_BETWEEN)) continue;
        out.push({ id: `${lm.id}:${k}`, lm: lm.id, x: p.x, z: p.z });
        break;
      }
    }
  }
  return out;
}

// 花の形（頂点カラー）: 花びら 5 枚（上 2 枚は濃い紫、下 3 枚は明るい紫）・黄色の真ん中・短い緑の茎。直径 0.45 m
function flowerGeometry() {
  const pos = [], col = [];
  const dark = new THREE.Color('#5b2d91'), light = new THREE.Color('#8a5cc9'), yellow = new THREE.Color('#f2c230'), green = new THREE.Color('#4f8a3a');
  const disc = (cx, cy, rx, ry, rot, z, c, n = 12) => {
    const cr = Math.cos(rot), sr = Math.sin(rot);
    for (let i = 0; i < n; i++) {
      const a0 = (i / n) * Math.PI * 2, a1 = ((i + 1) / n) * Math.PI * 2;
      const p = (a) => {
        const ex = Math.cos(a) * rx, ey = Math.sin(a) * ry;
        return [cx + ex * cr - ey * sr, cy + ex * sr + ey * cr, z];
      };
      pos.push(cx, cy, z, ...p(a0), ...p(a1));
      for (let k = 0; k < 3; k++) col.push(c.r, c.g, c.b);
    }
  };
  // 花びら: 中心から外へ向いた楕円（長さ 0.13・幅 0.1）。下の 3 枚を手前に重ねる
  const R = 0.225, len = 0.065, wid = 0.05;
  const petal = (deg, z, c) => {
    const a = (deg * Math.PI) / 180;
    const d = R - len;
    disc(Math.cos(a) * d, Math.sin(a) * d, len, wid, a, z, c);
  };
  petal(55, -0.004, dark);
  petal(125, -0.004, dark);
  petal(205, 0.002, light);
  petal(270, 0.004, light);
  petal(335, 0.002, light);
  // 真ん中（両面から見えるように表と裏に）
  disc(0, 0, 0.035, 0.035, 0, 0.012, yellow, 10);
  disc(0, 0, 0.035, 0.035, 0, -0.012, yellow, 10);
  // 茎（十字に 2 枚の細い板）
  const stem = (ax, az) => {
    const w = 0.012, y0 = -0.36, y1 = -0.05;
    const q = [[-w * ax, y0, -w * az], [w * ax, y0, w * az], [w * ax, y1, w * az], [-w * ax, y0, -w * az], [w * ax, y1, w * az], [-w * ax, y1, -w * az]];
    for (const v of q) {
      pos.push(...v);
      col.push(green.r, green.g, green.b);
    }
  };
  stem(1, 0);
  stem(0, 1);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  return g;
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3(1, 1, 1);
const _up = new THREE.Vector3(0, 1, 0);

export class Violets {
  // world: groundAt・spawnY・heightAt・stream を使う。items: planViolets の戻り値。collectedIds: 集めた id
  constructor(world, items, collectedIds = []) {
    this.world = world;
    this.items = items;
    this.total = items.length;
    const valid = new Set(items.map((v) => v.id));
    this.collected = new Set([...collectedIds].filter((id) => valid.has(id)));
    this.pending = items.filter((v) => !this.collected.has(v.id)); // まだ集めていない花（地図にも描く）
    this.picked = []; // update の戻り値（使い回す）
    this.group = new THREE.Group();
    this.group.name = 'violets';
    const n = Math.max(1, items.length);
    // 日陰・夜でもはっきり見えるように光の影響を受けない材質
    this.flowers = new THREE.InstancedMesh(flowerGeometry(), new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide, fog: true }), n);
    const ring = new THREE.RingGeometry(0.42, 0.6, 32);
    ring.rotateX(-Math.PI / 2);
    this.rings = new THREE.InstancedMesh(ring, new THREE.MeshBasicMaterial({
      color: '#b48ce6', transparent: true, opacity: 0.45, depthWrite: false, side: THREE.DoubleSide, fog: true,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4,
    }), n);
    for (const m of [this.flowers, this.rings]) {
      m.frustumCulled = false; // 花は街じゅうに散らばるので、まとめた箱では切れない
      m.count = 0;
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.group.add(m);
    }
  }

  get remaining() {
    return this.pending.length;
  }

  // 地面の高さ（広いエリアではタイルが組み上がってから決める。決まるまで null）
  groundY(v) {
    if (v.y != null) return v.y;
    const w = this.world;
    if (w.stream && !w.stream.readyAt(v.x, v.z)) return null;
    // 橋の下の道で橋の上に置かないように、地面（spawnY）から届く面
    const base = w.spawnY ? w.spawnY(v.x, v.z, false) : w.heightAt ? w.heightAt(v.x, v.z) : 0;
    v.y = w.groundAt ? w.groundAt(v.x, v.z, base + 0.5) : base;
    if (!Number.isFinite(v.y)) v.y = base;
    return v.y;
  }

  // 毎フレーム: 近くの花を描き、自転車が触れた花を集める。戻り値は集めた花の配列（ふつうは空。次の呼び出しまで有効）
  update(dt, bike, time) {
    this.picked.length = 0;
    if (!this.group.visible) return this.picked;
    let n = 0;
    for (let i = 0; i < this.pending.length; i++) {
      const v = this.pending[i];
      const dx = v.x - bike.x, dz = v.z - bike.z;
      if (Math.abs(dx) > DRAW_RANGE || Math.abs(dz) > DRAW_RANGE || dx * dx + dz * dz > DRAW_RANGE * DRAW_RANGE) continue;
      const y = this.groundY(v);
      if (y == null) continue;
      if (dx * dx + dz * dz < PICK_RADIUS * PICK_RADIUS && Math.abs(bike.y - y) < PICK_DY) {
        this.collected.add(v.id);
        this.picked.push(v);
        this.pending.splice(i, 1);
        i--;
        continue;
      }
      // ゆっくり回り（0.8 rad/s）、±8 cm 上下する。花ごとに位相をずらす
      const ph = (v.x * 0.37 + v.z * 0.71) % (Math.PI * 2);
      _q.setFromAxisAngle(_up, time * 0.8 + ph);
      _p.set(v.x, y + FLOAT_Y + Math.sin(time * 2 + ph) * 0.08, v.z);
      this.flowers.setMatrixAt(n, _m.compose(_p, _q, _s));
      _q.identity();
      _p.set(v.x, y + 0.04, v.z);
      this.rings.setMatrixAt(n, _m.compose(_p, _q, _s));
      n++;
    }
    for (const m of [this.flowers, this.rings]) {
      m.count = n;
      m.instanceMatrix.needsUpdate = true;
    }
    return this.picked;
  }

  // 名所 lmId のスミレがそろったか（その名所に置いた花が 1 つ以上あり、全部集めた）
  bouquetDone(lmId) {
    const mine = this.items.filter((v) => v.lm === lmId);
    return mine.length > 0 && mine.every((v) => this.collected.has(v.id));
  }
}
