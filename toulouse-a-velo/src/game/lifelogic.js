// 街のにぎわい（歩く人・カフェの客・ハト）の計算のうち、three.js にも DOM にも依らない部分。
// Node の単体テストから使う。描画と街のデータを見る部分は citylife.js。
// 向き: 自転車の heading はコンパス方位（0 = 北 = -z、時計回りが正）。前の向きは (sin h, -cos h)。
// 人・ハトの yaw は Y 軸まわりの回転（模型の前は -z）。進む向き (dx, dz) なら yaw = atan2(-dx, -dz)

const TAU = Math.PI * 2;

// 自転車をよける点。自転車が 7 m 以内にいて、近づいていて（1 m/s 以上）、このまま進むと 1.3 m 以内を通るとき、
// 自転車の進む線から離れる側へ 1.6 m よけた点 { x, z }。よけなくてよければ null。
// force: 距離・近づく速さ・線からの距離の条件なしで、よける向きだけを決める（ベル）
export function dodge({ px, pz, bx, bz, heading, speed, force = false }) {
  const fx = Math.sin(heading), fz = -Math.cos(heading);
  const rx = px - bx, rz = pz - bz, d = Math.hypot(rx, rz);
  const lateral = fx * rz - fz * rx; // 自転車の線から人までの横の距離（右が正）
  if (!force) {
    if (d > 7 || d < 1e-6) return null;
    const closing = (speed * (fx * rx + fz * rz)) / d; // 人へ近づく速さ
    if (closing < 1) return null;
    if (Math.abs(lateral) >= 1.3) return null;
  }
  const side = lateral >= 0 ? 1 : -1; // 線の真上なら右へ
  const nx = -fz * side, nz = fx * side;
  return { x: px + nx * 1.6, z: pz + nz * 1.6 };
}

// ベルが届く扇形: 自転車の前 range m・左右 half ラジアンの中か
export function inBellCone({ px, pz, bx, bz, heading, range = 20, half = Math.PI / 3 }) {
  const rx = px - bx, rz = pz - bz, d = Math.hypot(rx, rz);
  if (d > range) return false;
  if (d < 1e-6) return true;
  const fx = Math.sin(heading), fz = -Math.cos(heading);
  return (fx * rx + fz * rz) / d >= Math.cos(half);
}

// カフェのテラス（furniture.js の terraceGeometry）の 4 つの椅子: テラスの局所座標で (±0.75, 0.46, ±0.62)、
// 椅子はテーブル（z = 0）の方を向く。テラスの向き a は FurnitureSet.add と同じ Y 軸まわりの回転。
// 戻り値の y は座面の高さ、yaw は座る人の向き
const SEATS = [[-0.75, -0.62], [-0.75, 0.62], [0.75, -0.62], [0.75, 0.62]];
export function terraceSeats(t) {
  const a = t.a || 0, c = Math.cos(a), s = Math.sin(a), y = (t.y || 0) + 0.46;
  return SEATS.map(([lx, lz]) => ({
    x: t.x + lx * c + lz * s,
    z: t.z - lx * s + lz * c,
    y,
    yaw: a + (lz > 0 ? 0 : Math.PI), // +z の椅子は -z（テーブル）を向く
  }));
}

// 場所 (x, z) と番号 k から決まる 0〜1 の値（作り直しても同じ席に同じ客）
export function seatHash(x, z, k = 0) {
  let h = Math.imul(Math.round(x * 10) | 0, 0x9e3779b1) ^ Math.imul(Math.round(z * 10) | 0, 0x85ebca6b) ^ Math.imul(k + 1, 0xc2b2ae35);
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

// 人を置き直す点: 自転車から inner〜radius m の輪の中（面積で一様）。7 割は進む向きの前側（前 ±100° の中）、残りは後ろ側
export function respawnPoint(rnd, bike, radius, inner = 45) {
  const FRONT = (100 * Math.PI) / 180;
  const ahead = rnd() < 0.7;
  const off = ahead ? (rnd() * 2 - 1) * FRONT : FRONT + rnd() * (TAU - 2 * FRONT);
  const h = bike.heading + off;
  const r = Math.sqrt(inner * inner + rnd() * (radius * radius - inner * inner));
  return { x: bike.x + Math.sin(h) * r, z: bike.z - Math.cos(h) * r, ahead };
}

// ---------------------------------------------------------------- ハト
// bird: { x, z, h（地面からの高さ）, yaw, pitch（前へ傾ける角度）, wing（羽ばたきの角度）, fold（翼をたたむ）, state }
// flock: { x, z（地面の群れの中心）, cx, cz（飛ぶときに回る中心）, R（回る半径）, dir（回る向き ±1）, rnd（mulberry32）}
// threat: { scare（この瞬間に脅かされた）, near（自転車が下りる所の 8 m 以内）}
export const PIGEON = { walk: 0.35, roam: 3.5, peck: (25 * Math.PI) / 180, up: 1.2, speed: 9, flap: 9, glide: 0.8 };

export function newPigeon(flock, rnd = flock.rnd) {
  const a = rnd() * TAU, r = Math.sqrt(rnd()) * 2.2;
  return {
    x: flock.x + Math.cos(a) * r, z: flock.z + Math.sin(a) * r, h: 0, yaw: rnd() * TAU, pitch: 0, wing: 0, fold: true,
    state: 'ground', walk: false, t: rnd() * 2, tx: 0, tz: 0, clock: rnd() * 10, peck: 2.5 + rnd() * 2.5,
  };
}

const ease = (s) => s * s * (3 - 2 * s);

function face(b, dx, dz) {
  if (dx * dx + dz * dz > 1e-8) b.yaw = Math.atan2(-dx, -dz);
}

// 1 羽の状態を dt 秒進める
export function pigeonStep(b, f, dt, threat = {}) {
  const rnd = f.rnd, P = PIGEON;
  b.clock += dt;
  if (b.state === 'ground') {
    b.h = 0;
    b.wing = 0;
    b.fold = true;
    if (threat.scare) {
      // 群れ全部が 0〜0.4 秒ずらして飛び立つ
      b.state = 'alert';
      b.t = rnd() * 0.4;
      b.pitch = 0;
      return b;
    }
    if (b.walk) {
      // ちょこちょこ歩く
      const dx = b.tx - b.x, dz = b.tz - b.z, d = Math.hypot(dx, dz), step = P.walk * dt;
      face(b, dx, dz);
      if (d <= step) {
        b.x = b.tx;
        b.z = b.tz;
        b.walk = false;
        b.t = 0.5 + rnd() * 2.5;
      } else {
        b.x += (dx / d) * step;
        b.z += (dz / d) * step;
      }
      b.pitch = 0;
    } else {
      // 止まっている間はついばむ（胴を前に傾ける。周期は鳥ごと）
      b.pitch = P.peck * Math.max(0, Math.sin(b.clock * b.peck));
      b.t -= dt;
      if (b.t <= 0) {
        let a = rnd() * TAU;
        const len = 0.3 + rnd() * 0.7;
        if (Math.hypot(b.x - f.x, b.z - f.z) > P.roam - 1) a = Math.atan2(f.z - b.z, f.x - b.x) + (rnd() - 0.5); // 群れの外へ出ない
        b.tx = b.x + Math.cos(a) * len;
        b.tz = b.z + Math.sin(a) * len;
        b.walk = true;
      }
    }
    return b;
  }
  if (b.state === 'alert') {
    b.t -= dt;
    if (b.t > 0) return b;
    // 飛び立つ: 1.2 秒で高さ 5〜9 m の円へ上がる
    const dx = b.x - (f.cx ?? f.x), dz = b.z - (f.cz ?? f.z);
    Object.assign(b, {
      state: 'fly', t: 0, x0: b.x, z0: b.z, R: (f.R || 15) + (rnd() - 0.5) * 2, alt: 5 + rnd() * 4, dur: 5 + rnd() * 3,
      ang0: dx || dz ? Math.atan2(dz, dx) : rnd() * TAU, fold: false, pitch: 0,
    });
    return b;
  }
  if (b.state === 'fly') {
    b.t += dt;
    const cx = f.cx ?? f.x, cz = f.cz ?? f.z, dir = f.dir || 1;
    const w = P.speed / b.R, ang = b.ang0 + dir * w * Math.max(0, b.t - P.up * 0.5);
    const ox = cx + Math.cos(ang) * b.R, oz = cz + Math.sin(ang) * b.R;
    const px = b.x, pz = b.z;
    if (b.t < P.up) {
      const s = ease(b.t / P.up);
      b.x = b.x0 + (ox - b.x0) * s;
      b.z = b.z0 + (oz - b.z0) * s;
      b.h = b.alt * s;
    } else {
      b.x = ox;
      b.z = oz;
      b.h = b.alt + Math.sin(b.clock * 1.3) * 0.3;
    }
    face(b, b.x - px, b.z - pz);
    b.wing = Math.sin(b.clock * TAU * P.flap) * 0.9;
    if (b.t >= P.up + b.dur) {
      // 自転車がまだ近ければ、もう 1 周
      if (threat.near) b.dur += (TAU * b.R) / P.speed;
      else {
        const a = rnd() * TAU, r = Math.sqrt(rnd()) * 1.5;
        const lx = f.x + Math.cos(a) * r, lz = f.z + Math.sin(a) * r;
        const d = Math.hypot(lx - b.x, lz - b.z);
        Object.assign(b, { state: 'land', t: 0, x0: b.x, z0: b.z, h0: b.h, lx, lz, dl: Math.max(1.5, d / 6) });
      }
    }
    return b;
  }
  if (b.state === 'land') {
    // 下りる所へ滑空（最後の 0.8 秒は翼を広げて滑る）
    b.t += dt;
    const s = Math.min(1, b.t / b.dl), e = ease(s), px = b.x, pz = b.z;
    b.x = b.x0 + (b.lx - b.x0) * s;
    b.z = b.z0 + (b.lz - b.z0) * s;
    b.h = b.h0 * (1 - e);
    face(b, b.x - px, b.z - pz);
    b.wing = b.dl - b.t < P.glide ? 0.12 : Math.sin(b.clock * TAU * P.flap) * 0.9;
    if (s >= 1) Object.assign(b, { state: 'ground', h: 0, wing: 0, fold: true, walk: false, t: 0.5 + rnd() * 2 });
  }
  return b;
}
