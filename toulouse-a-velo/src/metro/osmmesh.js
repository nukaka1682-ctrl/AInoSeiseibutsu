// OpenStreetMap の屋内の地図から組み立てた駅（osmplan.js）のメッシュ。材質・看板・ホームドアは stationmesh.js と同じ部品:
// - 各階: 床（改札階は花崗岩、ホームはタイル）、天井（穴あきの金属）と照明の帯、床の縁の壁（駅の帯の色のタイル）
// - 階段・エスカレーター: 上の階では吹き抜けのまわりに腰壁（A 線はタイル張り、B 線はガラス）、吹き抜けの壁、下の階では囲いの壁
// - 改札（回転式の三脚の改札とガラスの仕切り）、出入口の吹き抜けの囲い（扉の口）、扉の先の数段の階段
// - ホーム: 相対式は奥の壁に駅名の板・広告・路線図、島式は線路の向こうの壁に。ベンチ・方面の吊り看板・次の電車の LED 表示
import * as THREE from 'three';
import { Builder } from './geom.js';
import { LAYOUT } from './network.js';
import { MID_LANDING, PLAT_H, TREAD, escalatorHeight, escalatorRun, flightHeight, stairRun } from './stationplan.js';
import { floorEdges, inMulti, osmGateLanes } from './osmplan.js';
import {
  POSTERS, STATION_COLORS as C, Signs, bakeStationLight, bench, buildPSD, directionDraw, exitDraw, hangSign, hashId, ledDisplay, muralDraw, nameDraw,
  networkMapDraw, stationMaterials, stationStyle, ticketDraw,
} from './stationmesh.js';
import { stripedTileTexture } from './textures.js';
import { fitText } from './textures.js';

const open = (r) => r.slice(0, -1); // 閉じた輪の最後の点（最初と同じ）を除く
const TRACK_W = 2.6; // 島式のホームの、ホームドアの線から線路の向こうの壁まで

// 線分 a→b の、多角形 mp の内側を向く法線
function inwardNormal(mp, a, b) {
  const dx = b[0] - a[0], dz = b[1] - a[1], l = Math.hypot(dx, dz) || 1;
  let n = [-dz / l, dx / l];
  const m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  if (!inMulti(mp, m[0] + n[0] * 0.15, m[1] + n[1] * 0.15)) n = [-n[0], -n[1]];
  return n;
}

// 多角形（穴あき）を、原点 o・向き u の直線 o + u s + v t（t は一定）で切った内側の区間 [s0, s1]
function scan(pg, o, u, t) {
  const v = [-u[1], u[0]], P = (q) => [(q[0] - o[0]) * u[0] + (q[1] - o[1]) * u[1], (q[0] - o[0]) * v[0] + (q[1] - o[1]) * v[1]];
  const xs = [];
  for (const r of pg) {
    for (let i = 0; i + 1 < r.length; i++) {
      const [sa, ta] = P(r[i]), [sb, tb] = P(r[i + 1]);
      if ((ta > t) === (tb > t)) continue;
      xs.push(sa + ((t - ta) / (tb - ta)) * (sb - sa));
    }
  }
  xs.sort((a, b) => a - b);
  const out = [];
  for (let i = 0; i + 1 < xs.length; i += 2) out.push([xs[i], xs[i + 1]]);
  return out;
}

// 天井の照明の帯: かたまりごとに、いちばん長い辺の向きに 3.6 m おき（縁から 0.8 m あける）
function ceilingLights(B, mp, yc, avoid = () => false) {
  for (const pg of mp) {
    const r = pg[0];
    let best = null;
    for (let i = 0; i + 1 < r.length; i++) {
      const l = Math.hypot(r[i + 1][0] - r[i][0], r[i + 1][1] - r[i][1]);
      if (!best || l > best.l) best = { l, a: r[i], b: r[i + 1] };
    }
    if (!best) continue;
    const u = [(best.b[0] - best.a[0]) / best.l, (best.b[1] - best.a[1]) / best.l], v = [-u[1], u[0]], o = best.a;
    const ts = r.map((q) => (q[0] - o[0]) * v[0] + (q[1] - o[1]) * v[1]);
    const t0 = Math.min(...ts), t1 = Math.max(...ts), nT = Math.max(1, Math.round((t1 - t0) / 3.6));
    for (let k = 0; k < nT; k++) {
      const t = t0 + ((k + 0.5) * (t1 - t0)) / nT;
      for (const [s0, s1] of scan(pg, o, u, t)) {
        // 区間を、避ける所（吹き抜けの上）で切る
        let a = null;
        const flush = (b) => {
          if (a != null && b - a > 1) {
            const c = (a + b) / 2, x = o[0] + u[0] * c + v[0] * t, z = o[1] + u[1] * c + v[1] * t;
            B.box('light', x, z, yc - 0.07, yc - 0.005, u[0], u[1], b - a, 0.14);
          }
          a = null;
        };
        for (let s = s0 + 0.8; s <= s1 - 0.8 + 1e-6; s += 0.4) {
          const x = o[0] + u[0] * s + v[0] * t, z = o[1] + u[1] * s + v[1] * t;
          if (avoid(x, z)) flush(s - 0.4);
          else if (a == null) a = s;
        }
        flush(s1 - 0.8);
      }
    }
  }
}

const inRect4 = (foot, x, z, m = 0) => {
  // 長方形（4 隅）の中か（m m 広げて）
  const [p0, p1, , p3] = foot;
  const ux = p1[0] - p0[0], uz = p1[1] - p0[1], vx = p3[0] - p0[0], vz = p3[1] - p0[1];
  const lu = Math.hypot(ux, uz), lv = Math.hypot(vx, vz);
  const s = ((x - p0[0]) * ux + (z - p0[1]) * uz) / lu, t = ((x - p0[0]) * vx + (z - p0[1]) * vz) / lv;
  return s > -m && s < lu + m && t > -m && t < lv + m;
};

export function buildOsmStationMesh(plan, { streetAt = () => '', network = null } = {}) {
  const mats = stationMaterials();
  const style = stationStyle(plan.station);
  const tileKey = `tile:${style.accent}`;
  const mtl = { ...mats, [tileKey]: Object.assign(mats.tile.clone(), { map: stripedTileTexture(style.accent) }) };
  const B = new Builder({ tess: 1.6 }), signs = new Signs();
  const st = plan.station, lineA = plan.lines.some((L) => L.line === 'A') && plan.lines.length === 1;
  const doorsMeshes = [], displays = [], extra = new THREE.Group();
  const blockFeet = plan.blocks.map((b) => b.foot), pitFeet = plan.pitInfo.map((p) => p.foot);
  const nameKey = signs.material('name', 2.4, 0.6, nameDraw(st.name, style.accent));
  const lvOf = (l) => plan.levels.get(l);

  // ---------------------------------------------------------------- 各階の床・天井・壁・照明
  for (const [, lv] of plan.levels) {
    const y = lv.y, yc = y + lv.H;
    const fk = lv.platform ? 'floor' : style.hallFloor;
    for (const pg of lv.floor) B.floorPoly(fk, open(pg[0]), pg.slice(1).map(open), y);
    const tint = lv.platform ? [1, 1, 1] : style.ceilingTint || [1, 1, 1];
    for (const pg of lv.ceiling) B.floorPoly('ceiling', open(pg[0]), pg.slice(1).map(open), yc, { up: false, color: tint });
    for (const [a, b] of floorEdges(lv.floor, blockFeet, pitFeet)) {
      if (lv.platform && psdEdge(plan, lv.level, a, b)) continue;
      B.wall(tileKey, a, b, y, yc, { n: inwardNormal(lv.raw, a, b) });
    }
    if (!lv.platform) {
      const holes = [...plan.blocks.filter((b) => b.hi != null && b.lo <= lv.level && lv.level < b.hi).map((b) => b.foot), ...plan.pitInfo.filter((p) => plan.Y(p.level) <= y + 0.01).map((p) => p.foot)];
      ceilingLights(B, lv.ceiling, yc, (x, z) => holes.some((f) => inRect4(f, x, z, 0.5)));
    }
  }

  // ---------------------------------------------------------------- ホーム
  for (const L of plan.lines) platformMesh(B, signs, plan, L, style, tileKey, mats, nameKey, network, doorsMeshes, displays, extra);

  // ---------------------------------------------------------------- 階段・エスカレーター
  for (const b of plan.blocks) blockMesh(B, plan, b, tileKey, lineA);

  // ---------------------------------------------------------------- 出入口の吹き抜けの囲い（駅の中の階を通る所）
  for (const p of plan.pitInfo) pitWalls(B, plan, p, tileKey);

  // ---------------------------------------------------------------- 改札と案内
  const ticketLv = plan.ticket != null ? lvOf(plan.ticket) : null;
  for (const g of plan.gates) gateMesh(B, signs, g, plan);
  // 階段の上の方面の吊り看板（ホームへ下りる階段と、改札の階から下りる階段）
  for (const b of plan.blocks) {
    if (b.doorStep) continue;
    const lvTop = lvOf(b.hi);
    if (!lvTop) continue;
    const target = b.toPlatform ? b : null;
    const L = target ? plan.lines.find((q) => q.line === target.line) : plan.lines[0];
    const side = target?.side || 0;
    const term = side ? L.dirs.find((d) => d.side === side).terminus?.name || '' : '';
    const key = signs.material(`blk-${L.line}-${side}`, 3.0, 0.42, side ? directionDraw(L.line, term, { arrow: '↓' }) : directionDraw(L.line, `Ligne ${L.line}`, { arrow: '↓' }));
    const c = b.frame.at(-0.6, 0);
    hangSign(B, signs, key, c, lvTop.y + lvTop.H - 0.62, [b.frame.nx, b.frame.nz], 3.0, 0.42, lvTop.y + lvTop.H);
  }
  // 出口の吊り看板（出入口の扉の前。通りの名前）
  plan.pitInfo.forEach((p, i) => {
    const d = p.d, lv = lvOf(p.level);
    if (!lv) return;
    const street = streetAt(p.e.x, p.e.z) || '';
    const key = signs.material(`exit-pit-${i}`, 2.0, 0.5, exitDraw(street));
    const far = p.step ? p.step.len + 1.4 : 1.4;
    hangSign(B, signs, key, [d.x + d.dx * far, d.z + d.dz * far], lv.y + lv.H - 0.6, [d.sx, d.sz], 2.0, 0.5, lv.y + lv.H);
  });
  if (ticketLv) hallFurniture(B, signs, plan, ticketLv, style, nameKey);

  const floorYs = [...plan.levels.values()].map((lv) => lv.y);
  const group = B.build(mtl, { light: bakeStationLight(B.lights, floorYs), name: `station-${st.id}` });
  group.add(signs.build());
  for (const d of doorsMeshes) group.add(d.group);
  group.add(extra);
  return { group, doors: doorsMeshes, style, displays };
}

// 床の縁の線分が、ホームドアの線の上か
function psdEdge(plan, l, a, b) {
  for (const L of plan.lines) {
    if (L.level !== l) continue;
    const [sa, ta] = L.frame.local(...a), [sb, tb] = L.frame.local(...b);
    if (Math.abs(Math.abs(ta) - L.P) < 0.05 && Math.abs(Math.abs(tb) - L.P) < 0.05 && Math.sign(ta) === Math.sign(tb) && Math.max(Math.abs(sa), Math.abs(sb)) <= L.Lb + 0.05) return true;
  }
  return false;
}

// ---------------------------------------------------------------- ホーム
function platformMesh(B, signs, plan, L, style, tileKey, mats, nameKey, network, doorsMeshes, displays, extra) {
  const f = L.frame, at = f.at, yp = L.yp, Lb = L.Lb, yc = yp + PLAT_H, ybed = yp - 1.3;
  const lv = plan.levels.get(L.level);
  const blocked = (x, z, m) => plan.blocks.some((b) => inRect4(b.foot, x, z, m)) || plan.pitInfo.some((p) => inRect4(p.foot, x, z, m) || (p.step && inRect4(p.step.foot, x, z, m)));
  const onFloor = (x, z) => lv && inMulti(lv.floor, x, z);
  for (const side of [1, -1]) {
    const term = L.dirs.find((d) => d.side === side).terminus?.name || '';
    const inward = L.island ? -side : side; // ホームドアからホームの側
    const tP = L.P * side;
    // ホームドアの前の花崗岩の帯
    B.floor('granite', [at(-Lb, tP), at(Lb, tP), at(Lb, tP + 0.9 * inward), at(-Lb, tP + 0.9 * inward)], yp + 0.004);
    doorsMeshes.push(buildPSD(B, signs, L, side, term, mats));
    // 照明の帯（ホームドアの上の天井。相対式は奥の壁ぎわにも）
    for (const tl of L.island ? [L.P - 1.0] : [L.P + 1.0, L.WT - 1.3]) {
      const t = tl * (L.island ? side : side);
      let a = null;
      const flush = (bS) => {
        if (a != null && bS - a > 1) {
          const [cx, cz] = at((a + bS) / 2, t);
          B.box('light', cx, cz, yc - 0.07, yc - 0.005, f.ax, f.az, bS - a, 0.14);
        }
        a = null;
      };
      for (let s = -Lb + 1; s <= Lb - 1 + 1e-6; s += 0.5) {
        const [x, z] = at(s, t);
        if (blocked(x, z, 0.5) || !inMulti(lv.ceiling, x, z)) flush(s - 0.5);
        else if (a == null) a = s;
      }
      flush(Lb - 1);
    }
    // 壁の部品（相対式は奥の壁、島式は線路の向こうの壁）: 駅名の板・広告・路線図
    const tWall = L.island ? (L.island + TRACK_W) * side : L.WT * side;
    const nWall = [-f.nx * side, -f.nz * side]; // 壁からホームの側
    const wallFree = (s0, s1) => {
      for (let s = s0; s <= s1; s += 0.5) {
        const [x, z] = at(s, tWall - 0.4 * side);
        if (L.island ? false : blocked(x, z, 0.6) || !onFloor(x, z)) return false;
      }
      return s0 > -Lb + 1 && s1 < Lb - 1;
    };
    let k = 0;
    for (let s = -Lb + 4; s < Lb - 3; s += 11) {
      // 駅名の板
      if (wallFree(s - 1.4, s + 1.4)) {
        const [x, z] = at(s, tWall - 0.02 * side);
        signs.panel(nameKey, x, yp + 2.15, z, -f.ax * side, -f.az * side, 2.4, 0.6, nWall[0], nWall[1]);
      }
      // 広告と路線図
      const sp = s + 5.5;
      if (wallFree(sp - 1.0, sp + 1.0)) {
        const [px, pz] = at(sp, tWall - 0.03 * side);
        const isMap = k === 1 && network;
        const w = isMap ? 1.8 : 1.2, h = isMap ? 1.2 : 1.76;
        const pk = (k + hashId(plan.station.id) + side + 2) % POSTERS.length;
        const key = isMap ? signs.material(`plan-${plan.station.id}`, w, h, networkMapDraw(network, plan.station), { ppm: 560 }) : signs.material(`poster-${pk}`, w, h, POSTERS[pk]);
        B.box('steel', px, pz, yp + 0.55 - 0.04, yp + 0.55 + h + 0.04, f.ax, f.az, w + 0.08, 0.04);
        signs.panel(key, px + nWall[0] * 0.025, yp + 0.55 + h / 2, pz + nWall[1] * 0.025, -f.ax * side, -f.az * side, w, h, nWall[0], nWall[1], 0);
        k++;
      }
    }
    // ベンチ（相対式は奥の壁ぎわ、島式は真ん中に背中合わせ）
    for (let s = -Lb + 6; s < Lb - 4; s += 11) {
      const t = L.island ? 0.5 * side : (L.WT - 0.35) * side;
      const [bx, bz] = at(s, t);
      if (blocked(bx, bz, 1.0) || !onFloor(bx, bz)) continue;
      bench(B, bx, bz, yp, f.ax * (L.island ? -side : 1), f.az * (L.island ? -side : 1));
      plan.nav?.addWall(...at(s - 0.9, t - 0.25 * side), ...at(s + 0.9, t - 0.25 * side), yp - 0.2, yp + 0.9);
    }
    // 方面の吊り看板と、次の電車の表示（ホームの真ん中の上）
    const tSign = L.island ? (L.P - 1.6) * side : ((L.P + L.WT) / 2) * side;
    const dirKey = signs.material(`dir-${L.line}-${side}`, 3.2, 0.42, directionDraw(L.line, term));
    const sDir = [-14, 14, 0, -24, 24, -7, 7].find((q) => Math.abs(q) < Lb - 3 && !blocked(...at(q, tSign), 2.5)) ?? 0;
    hangSign(B, signs, dirKey, at(sDir, tSign), yc - 0.9, [f.nx, f.nz], 3.2, 0.42, yc);
    const sLed = sDir + (sDir + 5 < Lb - 2 ? 5 : -5);
    if (typeof document !== 'undefined') displays.push(ledDisplay(B, extra, L, side, at(sLed, tSign), yc - 0.85, [f.nx, f.nz], yc, term));
    // 出口の看板（ホームから上がる階段の下の前）
    for (const b of plan.blocks.filter((q) => q.toPlatform && q.line === L.line && (L.island || q.side === side))) {
      const [x, z] = b.frame.at(b.len + 1.5, 0);
      const exitKey = signs.material('exit-plat', 1.6, 0.4, exitDraw(''));
      hangSign(B, signs, exitKey, [x, z], yc - 0.9, [b.frame.nx, b.frame.nz], 1.6, 0.4, yc);
    }
  }
  trackZone(B, L, style, ybed, yc);
}

// 線路（走行路・案内軌条）。相対式は 2 本の線路のあいだに丸い柱、島式はホームの両側に線路と向こうの壁
function trackZone(B, L, style, ybed, yc) {
  const f = L.frame, at = f.at, yp = L.yp, Lb = L.Lb;
  const rect = (s0, s1, t0, t1) => [at(s0, t0), at(s1, t0), at(s1, t1), at(s0, t1)];
  const tracks = L.island ? [1, -1].map((sg) => ({ sg, tc: (L.P + LAYOUT.psd - LAYOUT.trackOff) * sg, z0: L.P * sg, z1: (L.P + TRACK_W) * sg })) : [1, -1].map((sg) => ({ sg, tc: LAYOUT.trackOff * sg, z0: 0, z1: L.P * sg }));
  for (const tr of tracks) {
    const t0 = Math.min(tr.z0, tr.z1), t1 = Math.max(tr.z0, tr.z1);
    B.floor('concrete', rect(-Lb, Lb, t0, t1), ybed, { color: [0.6, 0.6, 0.6] });
    B.floor('darkCeiling', rect(-Lb, Lb, t0, t1), yc, { up: false });
    for (const o of [-0.86, 0.86]) {
      const [x, z] = at(0, tr.tc + o);
      B.box('paint', x, z, ybed, yp - 1.0, f.ax, f.az, 2 * Lb, 0.36, { color: C.pad });
    }
    for (const o of [-1.22, 1.22]) {
      const [x, z] = at(0, tr.tc + o);
      B.box('steel', x, z, yp - 0.95, yp - 0.78, f.ax, f.az, 2 * Lb, 0.08, { color: [0.55, 0.56, 0.58] });
    }
    // ホームの縁の側面
    const tEdge = L.P * tr.sg, nEdge = L.island ? [f.nx * tr.sg, f.nz * tr.sg] : [-f.nx * tr.sg, -f.nz * tr.sg];
    B.wall('concrete', at(-Lb, tEdge), at(Lb, tEdge), ybed, yp, { n: nEdge });
    if (L.island) {
      // 線路の向こうの壁（タイル。ホームの側を向く）と、両端のトンネルの口の上
      const tw = (L.P + TRACK_W) * tr.sg;
      B.wall('tile', at(-Lb, tw), at(Lb, tw), ybed, yc, { n: [-f.nx * tr.sg, -f.nz * tr.sg] });
      for (const se of [-Lb, Lb]) B.wall('concrete', at(se, tEdge), at(se, tw), yp + 3.6, yc, { n: [-f.ax * Math.sign(se), -f.az * Math.sign(se)] });
    }
  }
  if (!L.island) {
    for (let s = -Lb + 3; s <= Lb - 3; s += 6) {
      const [x, z] = at(s, 0);
      B.cyl('concrete', x, z, ybed, yc, 0.28, { color: [0.85, 0.85, 0.83] });
    }
    for (const se of [-Lb, Lb]) B.wall('concrete', at(se, -L.P), at(se, L.P), yp + 3.6, yc, { n: [-f.ax * Math.sign(se), -f.az * Math.sign(se)] });
  }
  void style;
}

// ---------------------------------------------------------------- 階段・エスカレーター
function blockMesh(B, plan, b, tileKey, tiled) {
  const f = b.frame, at = f.at, drop = b.y0 - b.y1, st = stairRun(drop);
  const lvTop = b.hi != null ? plan.levels.get(b.hi) : null, lvBot = plan.levels.get(b.lo);
  const W2 = b.W / 2;
  // 車線
  for (const ln of b.lanes) {
    if (ln.kind === 'escalator') escalatorLane(B, b, ln, escalatorRun(drop));
    else stairLane(B, b, ln, st);
  }
  // 車線のあいだの手すり（ステンレスの低い仕切り）
  b.lanes.slice(1).forEach((ln, i) => {
    const t = (b.lanes[i].t1 + ln.t0) / 2, run = Math.max(...b.lanes.map((q) => (q.kind === 'escalator' ? escalatorRun(drop) : st.run)));
    const yAt = (u) => (u <= 0.3 ? b.y0 : u >= 0.3 + run ? b.y1 : b.y0 + ((b.y1 - b.y0) * (u - 0.3)) / run);
    for (let u = 0; u < b.len - 1e-6; u += 1) {
      const u1 = Math.min(b.len, u + 1), [ax, az] = at(u, t), [bx, bz] = at(u1, t);
      B.bar('steel', [ax, yAt(u) + 0.95, az], [bx, yAt(u1) + 0.95, bz], 0.05);
    }
  });
  if (b.doorStep) {
    // 扉の先の数段の階段: 両側の花崗岩の側壁（段の高さまで）
    for (const sg of [-1, 1]) {
      let u = 0;
      for (let k = 0; k < st.n; k++) {
        const yy = b.y0 + ((b.y1 - b.y0) * (k + 0.5)) / st.n;
        B.wall('granite', at(u + 0.3, sg * W2), at(u + 0.3 + TREAD, sg * W2), b.y1, yy, { n: [-f.nx * sg, -f.nz * sg] });
        u += TREAD;
      }
    }
    return;
  }
  const yTop = b.y0, yBotCeil = lvBot ? lvBot.y + lvBot.H : b.y1 + 3.4;
  const n = (sg) => [f.nx * sg, f.nz * sg];
  // 吹き抜けの壁（下の階の天井から上の階の床まで。吹き抜けの中を向く）
  if (yTop > yBotCeil + 0.05) {
    for (const sg of [-1, 1]) B.wall(tileKey, at(-0.05, sg * W2), at(b.len, sg * W2), yBotCeil, yTop, { n: n(-sg) });
    B.wall(tileKey, at(b.len, -W2), at(b.len, W2), yBotCeil, yTop, { n: [-f.ax, -f.az] });
    B.wall(tileKey, at(-0.05, -W2), at(-0.05, W2), yBotCeil, yTop, { n: [f.ax, f.az] });
  }
  // 下の階の囲い（両側と上の端。外側と内側）
  for (const sg of [-1, 1]) {
    B.wall(tileKey, at(-0.05, sg * W2), at(b.len, sg * W2), b.y1, Math.min(yBotCeil, yTop), { n: n(sg) });
    B.wall(tileKey, at(-0.05, sg * W2), at(b.len, sg * W2), b.y1, Math.min(yBotCeil, yTop), { n: n(-sg) });
  }
  B.wall(tileKey, at(-0.05, -W2), at(-0.05, W2), b.y1, Math.min(yBotCeil, yTop), { n: [-f.ax, -f.az] });
  // 通り抜ける階（両端の階のあいだ）の囲い
  for (const [l, lv] of plan.levels) {
    if (!(l > b.lo && l < b.hi)) continue;
    const F = [...b.foot, b.foot[0]];
    for (let i = 0; i < 4; i++) B.wall(tileKey, F[i], F[i + 1], lv.y, lv.y + lv.H, { n: inwardNormal(lv.raw, F[i], F[i + 1]) });
  }
  // 上の階の吹き抜けのまわり: 腰壁（両側と下りた先の端）
  if (lvTop) {
    const y = lvTop.y, H = 1.05, T = 0.16;
    const sides = [[at(0, -W2 - T / 2), at(b.len + T, -W2 - T / 2), f.ax, f.az, b.len + T], [at(0, W2 + T / 2), at(b.len + T, W2 + T / 2), f.ax, f.az, b.len + T], [at(b.len + T / 2, -W2 - T), at(b.len + T / 2, W2 + T), f.nx, f.nz, b.W + 2 * T]];
    for (const [p, q, ux, uz, len] of sides) {
      const cx = (p[0] + q[0]) / 2, cz = (p[1] + q[1]) / 2;
      if (!inMulti(lvTop.floor, cx + (cx - at(b.len / 2, 0)[0]) * 0.02, cz + (cz - at(b.len / 2, 0)[1]) * 0.02) && !inMulti(lvTop.raw, cx, cz)) continue;
      if (tiled) {
        B.box(tileKey, cx, cz, y, y + H, ux, uz, len, T);
        B.box('steel', cx, cz, y + H, y + H + 0.05, ux, uz, len + 0.04, T + 0.04);
      } else {
        B.box('glass', cx, cz, y + 0.05, y + 1.0, ux, uz, len, 0.02);
        B.box('steel', cx, cz, y + 1.0, y + 1.06, ux, uz, len, 0.06);
        B.box('steel', cx, cz, y, y + 0.08, ux, uz, len, 0.06);
      }
    }
  }
}

function stairLane(B, b, ln, st) {
  const f = b.frame, at = f.at, s0 = 0.3;
  const y = (k) => b.y0 + ((b.y1 - b.y0) * k) / st.n;
  const tread = (u0, u1, yy) => B.floor('darkGranite', [at(u0, ln.t0), at(u1, ln.t0), at(u1, ln.t1), at(u0, ln.t1)], yy);
  tread(-0.05, s0, b.y0);
  const per = Math.ceil(st.n / st.flights);
  let u = s0, k = 0;
  for (let fl = 0; fl < st.flights; fl++) {
    const steps = Math.min(per, st.n - k);
    for (let i = 0; i < steps; i++) {
      const yy = y(k + i + 1);
      tread(u, u + TREAD, yy);
      B.wall('granite', at(u, ln.t0), at(u, ln.t1), yy, y(k + i), { n: [f.ax, f.az] }); // 蹴上げ（下から見える向き）
      const [x, z] = at(u + 0.03, (ln.t0 + ln.t1) / 2);
      B.box('paint', x, z, yy, yy + 0.006, f.ax, f.az, 0.05, ln.t1 - ln.t0, { color: C.black });
      u += TREAD;
    }
    k += steps;
    if (fl + 1 < st.flights) {
      tread(u, u + MID_LANDING, y(k));
      u += MID_LANDING;
    }
  }
  if (b.len > u + 0.01) tread(u, b.len, b.y1);
  // 手すり（両側。段の上 0.9 m）
  for (const t of [ln.t0 + 0.05, ln.t1 - 0.05]) {
    let prev = null;
    for (let uu = 0; uu <= st.run + 0.01; uu += 1) {
      const yy = flightHeight(Math.min(uu, st.run), st.run, b.y0, b.y1, st.n, st.flights) + 0.9;
      const [x, z] = at(s0 + Math.min(uu, st.run), t);
      if (prev) B.bar('steel', prev, [x, yy, z], 0.045);
      prev = [x, yy, z];
    }
  }
}

function escalatorLane(B, b, ln, run) {
  const f = b.frame, at = f.at, s0 = 0.3;
  const yAt = (u) => escalatorHeight(u, run, b.y0, b.y1);
  B.floor('paint', [at(-0.05, ln.t0), at(s0, ln.t0), at(s0, ln.t1), at(-0.05, ln.t1)], b.y0, { color: [0.4, 0.4, 0.42] });
  for (let u = 0; u < run - 1e-6; u += 0.5) {
    const u1 = Math.min(run, u + 0.5);
    const p = (uu, t) => {
      const [x, z] = at(s0 + uu, t);
      return [x, yAt(uu), z];
    };
    B.quad('paint', p(u, ln.t0 + 0.1), p(u1, ln.t0 + 0.1), p(u1, ln.t1 - 0.1), p(u, ln.t1 - 0.1), [0, 1, 0], { color: [0.2, 0.21, 0.22] });
  }
  if (b.len > s0 + run + 0.01) B.floor('paint', [at(s0 + run, ln.t0), at(b.len, ln.t0), at(b.len, ln.t1), at(s0 + run, ln.t1)], b.y1, { color: [0.4, 0.4, 0.42] });
  for (const t of [ln.t0 + 0.04, ln.t1 - 0.04]) {
    for (let u = 0; u < run - 1e-6; u += 1) {
      const u1 = Math.min(run, u + 1);
      const a = at(s0 + u, t), c = at(s0 + u1, t);
      B.wall('steel', a, c, yAt(u), yAt(u) + 0.95, { n: [f.nx, f.nz], yb: [yAt(u1), yAt(u1) + 0.95] });
      B.bar('paint', [a[0], yAt(u) + 1.0, a[1]], [c[0], yAt(u1) + 1.0, c[1]], 0.08, { color: C.black });
    }
  }
}

// ---------------------------------------------------------------- 出入口の吹き抜けの囲い
// 吹き抜けが通る階では 4 辺の壁（駅の中を向く）、着く階では扉の口を開ける
function pitWalls(B, plan, p, tileKey) {
  const fe = { at: (u, v) => [p.e.x + p.d.dx * u + p.d.sx * v, p.e.z + p.d.dz * u + p.d.sz * v] };
  const L = p.e.len / 2 + 0.03, W = p.e.wid / 2 + 0.03, d = p.d;
  const Q = (u, v) => fe.at(u, v);
  for (const [l, lv] of plan.levels) {
    if (plan.Y(p.level) > lv.y + 0.01) continue; // 吹き抜けはこの階より上で終わる
    const y = lv.y, yH = y + lv.H;
    const out = (a, b) => inwardNormal(lv.raw, a, b);
    const wall = (a, b, y0, y1) => {
      const cx = (a[0] + b[0]) / 2, cz = (a[1] + b[1]) / 2, n = out(a, b);
      if (!inMulti(lv.raw, cx + n[0] * 0.3, cz + n[1] * 0.3)) return; // 駅の床に面しない辺（地下の土の中）
      B.wall(tileKey, a, b, y0, y1, { n });
    };
    wall(Q(-L, -W), Q(L, -W), y, yH);
    wall(Q(-L, W), Q(L, W), y, yH);
    wall(Q(-L, -W), Q(-L, W), y, yH);
    if (l !== p.level) {
      wall(Q(L, -W), Q(L, W), y, yH);
      continue;
    }
    const dw = d.dw + 0.08, top = Math.min(yH, d.yb + d.dh + 0.08);
    wall(Q(L, -W), Q(L, -dw), y, yH);
    wall(Q(L, dw), Q(L, W), y, yH);
    if (top < yH - 0.01) wall(Q(L, -dw), Q(L, dw), top, yH);
    if (d.yb > y + 0.02) B.wall('granite', Q(L, -dw), Q(L, dw), y, d.yb, { n: [d.dx, d.dz] });
    for (const v of [-dw, dw]) {
      const [x, z] = Q(L + 0.02, v);
      B.box('steel', x, z, d.yb, top, d.dx, d.dz, 0.06, 0.1);
    }
    const [x, z] = Q(L + 0.02, 0);
    B.box('steel', x, z, top - 0.08, top, d.sx, d.sz, 2 * dw + 0.1, 0.06);
  }
}

// ---------------------------------------------------------------- 改札
function gateMesh(B, signs, g, plan) {
  const f = g.frame, at = f.at, lanes = osmGateLanes(g), ym = plan.ym;
  const lv = plan.levels.get(plan.ticket), yH = ym + (lv ? lv.H : 3.4);
  const housings = [];
  let t = lanes[0][0] - 0.3;
  for (const [a, b] of lanes) {
    housings.push([t, a]);
    t = b;
  }
  housings.push([t, t + 0.3]);
  for (const [a, b] of housings) {
    const [x, z] = at(0, (a + b) / 2);
    B.box('steel', x, z, ym, ym + 0.98, f.ax, f.az, 1.4, b - a);
    B.box('paint', x, z, ym + 0.98, ym + 1.02, f.ax, f.az, 1.4, b - a, { color: C.black });
  }
  for (const [a] of lanes) {
    for (const sg of [1, -1]) {
      const [lx, lz] = at(sg * 0.701, a - 0.15);
      B.box(sg < 0 ? 'green' : 'red', lx, lz, ym + 0.75, ym + 0.83, f.nx, f.nz, 0.1, 0.004);
    }
    const [x, z] = at(0, a + 0.02);
    for (let i = 0; i < 3; i++) {
      const ang = (i / 3) * Math.PI * 2, dir = [Math.cos(ang) * 0.3, Math.sin(ang) * 0.3];
      const tip = at(dir[0] * 0.4, a + 0.05 + 0.45);
      B.bar('steel', [x, ym + 0.88, z], [tip[0], ym + 0.88 + dir[1] * 0.5, tip[1]], 0.035);
    }
  }
  for (const [a, b] of [[g.t0, housings[0][0]], [housings[housings.length - 1][1], g.t1]]) {
    if (b - a < 0.05) continue;
    const [x, z] = at(0, (a + b) / 2);
    B.box('glass', x, z, ym, ym + 1.15, f.nx, f.nz, b - a, 0.02);
    B.box('steel', x, z, ym + 1.15, ym + 1.2, f.nx, f.nz, b - a, 0.05);
    B.box('steel', x, z, ym, ym + 0.06, f.nx, f.nz, b - a, 0.05);
  }
  // 改札の上: 外の側に方面、中の側に出口
  const L = plan.lines.find((q) => q.line === g.line) || plan.lines[0];
  const term = g.dir?.terminus?.name || '';
  const key = signs.material(`gate-${g.line}-${g.dir?.side ?? 0}`, 3.4, 0.45, directionDraw(L.line, term || `Ligne ${L.line}`, { arrow: '' }));
  hangSign(B, signs, key, at(-0.9, (g.t0 + g.t1) / 2), yH - 0.75, [f.nx, f.nz], 3.4, 0.45, yH);
  const exitKey = signs.material('exit-gate', 1.8, 0.45, exitDraw(''));
  hangSign(B, signs, exitKey, at(0.9, (g.t0 + g.t1) / 2), yH - 0.75, [f.nx, f.nz], 1.8, 0.45, yH);
}

// ---------------------------------------------------------------- 改札の階の備品: 券売機・駅名の板・壁画・作品
function hallFurniture(B, signs, plan, lv, style, nameKey) {
  const y = lv.y, yH = y + lv.H;
  const busy = (x, z, m = 0) => {
    for (const p of plan.pitInfo) {
      const d = p.d, u = (x - d.x) * d.dx + (z - d.z) * d.dz, v = (x - d.x) * d.sx + (z - d.z) * d.sz;
      if (inRect4(p.foot, x, z, 0.5 + m) || (u > -0.5 && u < 4.5 + m + (p.step ? p.step.len : 0) && Math.abs(v) < d.dw + 1.2 + m)) return true;
    }
    for (const b of plan.blocks) {
      if (inRect4(b.foot, x, z, 0.6 + m)) return true;
      const [s, t] = b.frame.local(x, z);
      if (b.hi === lv.level && s > -4.2 - m && s < 0 && Math.abs(t) < b.W / 2 + 1 + m) return true;
      if (b.lo === lv.level && s > b.len && s < b.len + 4 + m && Math.abs(t) < b.W / 2 + 1 + m) return true;
    }
    for (const g of plan.gates) {
      const [s, t] = g.frame.local(x, z);
      if (Math.abs(s) < 2.8 + m && t > g.t0 - 1 && t < g.t1 + 1) return true;
    }
    return false;
  };
  // 壁ぎわの置き場所
  const spots = [];
  floorEdges(lv.floor, plan.blocks.map((b) => b.foot), plan.pitInfo.map((p) => p.foot)).forEach(([a, b], wi) => {
    const dx = b[0] - a[0], dz = b[1] - a[1], l = Math.hypot(dx, dz);
    if (l < 1.2) return;
    const n = inwardNormal(lv.raw, a, b), u = [dx / l, dz / l];
    for (let k = 0.6; k <= l - 0.6 + 1e-6; k += 0.9) spots.push({ x: a[0] + u[0] * k, z: a[1] + u[1] * k, n, u, wall: wi, at: k, len: l });
  });
  const free = (sp, depth, m = 0) => {
    const x = sp.x + sp.n[0] * depth, z = sp.z + sp.n[1] * depth;
    return inMulti(lv.floor, x, z) && !busy(x, z, m);
  };
  const used = new Set();
  // 券売機（2〜3 台）: 改札に近い、改札の外の壁ぎわ
  const tk = signs.material('ticket', 0.75, 1.75, ticketDraw());
  for (const g of plan.gates.slice(0, 2)) {
    const gp = g.frame.at(-2.5, (g.t0 + g.t1) / 2);
    const cand = spots.filter((sp) => free(sp, 0.3, 0.3) && g.frame.local(sp.x, sp.z)[0] < -1.5).sort((p, q) => Math.hypot(p.x - gp[0], p.z - gp[1]) - Math.hypot(q.x - gp[0], q.z - gp[1]));
    let placed = 0, wall = null;
    for (const sp of cand) {
      if (placed >= 3) break;
      const key = `${sp.wall}:${sp.at.toFixed(1)}`;
      if (used.has(key) || (wall != null && sp.wall !== wall) || Math.hypot(sp.x - gp[0], sp.z - gp[1]) > 14) continue;
      used.add(key);
      wall = sp.wall;
      placed++;
      const x = sp.x + sp.n[0] * 0.27, z = sp.z + sp.n[1] * 0.27;
      B.box('paint', x, z, y, y + 1.8, sp.u[0], sp.u[1], 0.8, 0.5, { color: C.ticketRed });
      signs.panel(tk, x + sp.n[0] * 0.251, y + 0.95, z + sp.n[1] * 0.251, sp.n[1], -sp.n[0], 0.75, 1.7, sp.n[0], sp.n[1], 0);
      const P = (i, j) => [x + sp.u[0] * i + sp.n[0] * j, z + sp.u[1] * i + sp.n[1] * j];
      for (const [p, q] of [[[-0.42, -0.3], [0.42, -0.3]], [[0.42, -0.3], [0.42, 0.3]], [[0.42, 0.3], [-0.42, 0.3]], [[-0.42, 0.3], [-0.42, -0.3]]]) {
        const [A, Bq] = [P(...p), P(...q)];
        plan.nav?.addWall(A[0], A[1], Bq[0], Bq[1], y - 0.2, y + 1.8);
      }
    }
  }
  // 駅名の板と壁画（長い壁の空いている所）
  const walls = new Map();
  for (const sp of spots) if (!used.has(`${sp.wall}:${sp.at.toFixed(1)}`)) (walls.get(sp.wall) || walls.set(sp.wall, []).get(sp.wall)).push(sp);
  const muralKey = signs.material('mural', 3.0, 1.8, muralDraw(plan.station, style.accent));
  let names = 0, murals = 0, devise = style.art !== 'devise';
  for (const list of [...walls.values()].sort((p, q) => q.length - p.length)) {
    const ok = list.filter((sp) => free(sp, 0.4, 0.2));
    const pick = (w) => ok.find((sp) => ok.filter((q) => Math.abs(q.at - sp.at) <= w / 2 + 0.01).length >= Math.floor(w / 0.9));
    if (!devise) {
      const sp = pick(7.4);
      if (sp) {
        devise = true;
        const key = signs.material('devise', 7.2, 0.7, (x, W, H) => {
          x.fillStyle = '#f4f2ec';
          x.fillRect(0, 0, W, H);
          x.fillStyle = '#1b2a5c';
          x.textAlign = 'center';
          x.textBaseline = 'middle';
          fitText(x, 'LIBERTÉ · ÉGALITÉ · FRATERNITÉ', W * 0.94, H * 0.62, '700', 'Georgia, "Times New Roman", serif');
          x.fillText('LIBERTÉ · ÉGALITÉ · FRATERNITÉ', W / 2, H * 0.54);
        });
        signs.panel(key, sp.x + sp.n[0] * 0.02, y + 2.6, sp.z + sp.n[1] * 0.02, sp.n[1], -sp.n[0], 7.2, 0.7, sp.n[0], sp.n[1], 0);
        continue;
      }
    }
    if (style.art === 'mural' && murals < 1) {
      const sp = pick(3.4);
      if (sp) {
        murals++;
        signs.panel(muralKey, sp.x + sp.n[0] * 0.02, y + 1.65, sp.z + sp.n[1] * 0.02, sp.n[1], -sp.n[0], 3.0, 1.8, sp.n[0], sp.n[1], 0);
        continue;
      }
    }
    if (names < 2) {
      const sp = pick(2.6);
      if (sp) {
        names++;
        signs.panel(nameKey, sp.x + sp.n[0] * 0.02, Math.min(y + 2.55, yH - 0.45), sp.z + sp.n[1] * 0.02, sp.n[1], -sp.n[0], 2.4, 0.6, sp.n[0], sp.n[1], 0);
      }
    }
  }
  // 作品（いちばん大きいかたまりの、空いている真ん中）
  const big = lv.floor.reduce((a, pg) => (a && areaOf(a[0]) > areaOf(pg[0]) ? a : pg), null);
  if (!big) return;
  const cx = big[0].reduce((a, q) => a + q[0], 0) / big[0].length, cz = big[0].reduce((a, q) => a + q[1], 0) / big[0].length;
  const centre = [[0, 0], [2, 0], [-2, 0], [0, 2], [0, -2], [3, 3], [-3, -3]].map(([dx, dz]) => [cx + dx, cz + dz]).find(([x, z]) => inMulti(lv.floor, x, z) && !busy(x, z, 1.2));
  if (!centre) return;
  const [x, z] = centre;
  const ring = (r) => {
    for (let k = 0; k < 12; k++) {
      const a0 = (k / 12) * Math.PI * 2, a1 = ((k + 1) / 12) * Math.PI * 2;
      plan.nav?.addWall(x + Math.cos(a0) * r, z + Math.sin(a0) * r, x + Math.cos(a1) * r, z + Math.sin(a1) * r, y - 0.2, yH);
    }
  };
  if (style.art === 'cone') {
    // Esquirol の銅色の円錐の柱
    for (let k = 0; k < 6; k++) B.cyl('copper', x, z, y + (lv.H * k) / 6, y + (lv.H * (k + 1)) / 6, 0.85 - (0.45 * (k + 0.5)) / 6, { seg: 24, color: C.copper });
    ring(0.9);
  } else if (style.art === 'pink') {
    // Compans-Caffarelli のばら色に光る柱
    for (const [dx, dz] of [[-1.6, -1.6], [1.6, -1.6], [-1.6, 1.6], [1.6, 1.6]]) {
      if (!inMulti(lv.floor, x + dx, z + dz) || busy(x + dx, z + dz, 0.4)) continue;
      B.cyl('pink', x + dx, z + dz, y, yH, 0.22, { seg: 16 });
    }
  } else if (style.art === 'halo') {
    // Patte d'Oie の天井の丸い照明
    B.cyl('light', x, z, yH - 0.12, yH - 0.02, 1.6, { seg: 40 });
    B.cyl('paint', x, z, yH - 0.16, yH - 0.12, 1.75, { seg: 40, color: C.darkSteel });
    B.floor('light', Array.from({ length: 40 }, (_, k) => [x + Math.cos((k / 40) * Math.PI * 2) * 1.6, z + Math.sin((k / 40) * Math.PI * 2) * 1.6]), yH - 0.12, { up: false });
  } else if (style.art === 'columns') {
    B.cyl('concrete', x, z, y, yH, 0.45, { seg: 20, color: [0.86, 0.86, 0.84] });
    ring(0.5);
  }
}

function areaOf(pts) {
  let a = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += pts[j][0] * pts[i][1] - pts[i][0] * pts[j][1];
  return Math.abs(a / 2);
}
