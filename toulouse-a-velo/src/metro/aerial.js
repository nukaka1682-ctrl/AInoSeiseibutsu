// 高架の駅（A 線の Basso Cambo と Jolimont。線路が橋の上にある駅。写真: Wikimedia Commons）。
// - 上の階: 橋の上の 2 つの相対式ホーム（全面ガラスのホームドア・外の壁は横長の窓・白い壁と平らな天井）
// - 下の階: 地面の高さの切符売り場（salle des billets。券売機・回転式の改札・丸い柱）。街へはガラスの扉から直接出る
// - 改札の中から、外の壁ぎわの階段と上りのエスカレーターでそれぞれのホームへ上がる
// - 外: 白い建物。Basso Cambo はホームごとのかまぼこ形の金属の屋根と白い丸い柱、Jolimont は青い印のある白いタイルと平らな屋根
// 駅の局所座標は s（ホームの向き）・t（その右）。切符売り場は s = hallS を中心に、階段は dir の向きへ上がる（u = (s − hallS) × dir）
import * as THREE from 'three';
import { Builder } from './geom.js';
import { LAYOUT, TRAIN_CARS, boxHalf, doorOffsets, stationFrame, terminusOf, wallT } from './network.js';
import { NavLayer } from './nav.js';
import { PLAT_H } from './stationplan.js';
import { STATION_COLORS as C, Signs, bakeStationLight, bench, buildPSD, directionDraw, exitDraw, hangSign, ledDisplay, nameDraw, networkMapDraw, stationMaterials, ticketDraw } from './stationmesh.js';
import { stripedTileTexture } from './textures.js';

// 駅ごとの形（切符売り場の位置と階段の上がる向き、見た目）
const AERIAL = {
  'basso-cambo': { hallS: 0, dir: 1, accent: '#2f7d4f', vault: true },
  jolimont: { hallS: 13, dir: -1, accent: '#1f6fb5', vault: false },
};
const U0 = -16, U1 = 18; // 切符売り場の範囲（u）
const GATE_U = -5; // 改札の線
const STAIR_U = 1; // 階段の下の端
const SHAFT_W = 3.0; // 階段とエスカレーターの吹き抜けの幅（外の壁から）
const SLOPE = 0.55; // 階段の勾配（16.5 cm の段・30 cm の踏み面）
const ESC_SPEED = 0.65;
const DOOR_W = 3.6;
const APRON = 3.5; // 扉の外のスロープの長さ

export const isAerial = (station) => !!station.aerial && !!AERIAL[station.id];

// 高さ: ホームの床は線路の標高から、切符売り場の床は地面（Jolimont は斜面なので、ホームの 1 階下）
export function aerialLevels(station, railToFloor, groundAt) {
  const line = station.lines[0], cfg = AERIAL[station.id], f = stationFrame(station, line);
  const yp = station.aerial[line] + railToFloor;
  // 切符売り場の両側の扉の外の地面（低い方）に床を合わせる。ホームから 4.8〜7.6 m 下
  const WT = wallT();
  const g = [1, -1].map((k) => groundAt(...f.at(cfg.hallS + cfg.dir * -11, k * (WT + APRON + 0.3))));
  const ym = Math.max(yp - 7.6, Math.min(Math.min(...g) + 0.15, yp - 4.8));
  return { ym, yp: { [line]: yp } };
}

// 地面を描かない範囲（駅の建物の中。world/ground.js のステンシルの穴）と、建物・木を置かない範囲
export function aerialFootprints(station, groundAt) {
  const line = station.lines[0], cfg = AERIAL[station.id], f = stationFrame(station, line), WT = wallT(), L = boxHalf(line, station);
  const yp = station.yp?.[line];
  const rects = [];
  const s0 = cfg.hallS + Math.min(U0 * cfg.dir, U1 * cfg.dir), s1 = cfg.hallS + Math.max(U0 * cfg.dir, U1 * cfg.dir);
  rects.push([s0, s1]);
  // ホームの階が地面にもぐる所（Jolimont の丘の側）
  if (yp != null) {
    let a = null, b = null;
    for (let s = -L; s <= L; s += 2) {
      const high = [-WT, 0, WT].some((t) => groundAt(...f.at(s, t)) > yp - 2.2);
      if (high) {
        a ??= s - 2;
        b = s + 2;
      }
    }
    if (a != null) rects.push([Math.max(-L - 1, a), Math.min(L + 1, b)]);
  }
  const ang = Math.atan2(f.az, f.ax);
  return rects.map(([a, b]) => {
    const [x, z] = f.at((a + b) / 2, 0);
    return { kind: 'void', x, z, ang, down: 1, len: b - a + 0.6, wid: 2 * WT + 0.9, rim: -1e9, s0: a, s1: b };
  });
}

export function planAerialStation(station, groundAt, network = null) {
  const line = station.lines[0], cfg = AERIAL[station.id], f = stationFrame(station, line);
  const WT = wallT(), P = LAYOUT.psd, Lb = boxHalf(line, station), yp = station.yp[line], ym = station.ym;
  const n = TRAIN_CARS[line];
  const dirs = [1, -1].map((side) => ({ side, dir: side, terminus: network ? terminusOf(network, line, side) : null }));
  const L = { line, frame: f, yp, Lb, doorsS: doorOffsets(n), psdHalf: (n * LAYOUT.carPitch) / 2 + 0.6, dirs, P, WT };
  const rise = yp - ym, run = rise / SLOPE;
  const U = (u, t) => f.at(cfg.hallS + cfg.dir * u, t);
  const hallH = Math.min(4.4, rise - 1.9);
  // 街への扉: 切符売り場の両側と端で、外の地面が床に近い所
  const cands = [
    ...[1, -1].map((k) => ({ u: -11, t: k * WT, nu: 0, nt: k })),
    { u: U0, t: 0, nu: -1, nt: 0 },
  ].map((d) => {
    const [x, z] = U(d.u + d.nu * (APRON + 0.3), d.t + d.nt * (APRON + 0.3));
    return { ...d, gy: groundAt(x, z) };
  });
  let doors = cands.filter((d) => Math.abs(d.gy - ym) < 1.3);
  if (!doors.length) doors = [cands.reduce((a, b) => (Math.abs(b.gy - ym) < Math.abs(a.gy - ym) ? b : a))];
  for (const d of doors) {
    const ux = f.ax * cfg.dir, uz = f.az * cfg.dir;
    d.nx = ux * d.nu + f.nx * d.nt;
    d.nz = uz * d.nu + f.nz * d.nt;
    [d.x, d.z] = U(d.u, d.t);
    d.out = [d.x + d.nx * (APRON + 1.5), d.z + d.nz * (APRON + 1.5)];
  }
  return {
    layout: 'aerial', station, ym, cfg, frame: f, lines: [L], pits: [], closed: [], doors, U, rise, run, hallH,
    uTop: STAIR_U + run, psdWalls: [],
  };
}

const rectU = (U, u0, u1, t0, t1) => [U(u0, t0), U(u1, t0), U(u1, t1), U(u0, t1)];

export function buildAerialNav(plan) {
  const nav = new NavLayer(`station-${plan.station.id}`);
  const { U, ym, cfg, uTop } = plan, L = plan.lines[0], f = L.frame, at = f.at, yp = L.yp, WT = L.WT, P = L.P, Lb = L.Lb;
  const wall = (a, b, y0, y1) => nav.addWall(a[0], a[1], b[0], b[1], y0, y1);
  const yH = ym + plan.hallH + 2;
  // 切符売り場（外の壁から階段の吹き抜けを除く）
  nav.addRegion(rectU(U, U0, U1, -WT, WT), ym, { kind: 'hall', holes: [1, -1].map((k) => rectU(U, STAIR_U, U1 + 0.1, (WT - SHAFT_W) * k, WT * k * 1.01)) }); // 階段の所は階段の床だけ
  // 外の壁（扉の所はあける）
  const edges = [[U0, -WT, U1, -WT, 0, -1], [U0, WT, U1, WT, 0, 1], [U0, -WT, U0, WT, -1, 0], [U1, -WT, U1, WT, 1, 0]];
  for (const [u0, t0, u1, t1, nu, nt] of edges) {
    const cuts = plan.doors.filter((d) => d.nu === nu && d.nt === nt).map((d) => (nu ? d.t : d.u)).sort((a, b) => a - b);
    let a = nu ? t0 : u0;
    const end = nu ? t1 : u1, pt = (v) => (nu ? U(u0, v) : U(v, t0));
    for (const c of cuts) {
      wall(pt(a), pt(c - DOOR_W / 2), ym - 0.5, yH);
      a = c + DOOR_W / 2;
    }
    wall(pt(a), pt(end), ym - 0.5, yH);
  }
  // 扉の外のスロープ（床から外の地面へ）
  for (const d of plan.doors) {
    const sx = -d.nz, sz = d.nx, h = DOOR_W / 2;
    const p = (o, v) => [d.x + d.nx * o + sx * v, d.z + d.nz * o + sz * v];
    nav.addRegion([p(0, -h), p(APRON, -h), p(APRON, h), p(0, h)], (x, z) => ym + (d.gy - ym) * Math.max(0, Math.min(1, ((x - d.x) * d.nx + (z - d.z) * d.nz) / APRON)), { kind: 'hall' });
  }
  // 改札（箱とあいだの柵。通路は通れる）
  for (const [a, b] of gateBlocks(WT)) wall(U(GATE_U, a), U(GATE_U, b), ym - 0.2, ym + 1.1);
  for (const side of [1, -1]) {
    const tA = (WT - SHAFT_W) * side, tM = (WT - 1.4) * side, tB = (WT - 0.1) * side;
    const uOf = (x, z) => ((x - f.x) * f.ax + (z - f.z) * f.az - cfg.hallS) * cfg.dir;
    const yS = (x, z) => ym + (yp - ym) * Math.max(0, Math.min(1, (uOf(x, z) - STAIR_U) / plan.run));
    // 階段と、上りのエスカレーター（外の壁の側）
    nav.addRegion(rectU(U, STAIR_U, uTop, tA, tM), yS, { kind: 'stairs' });
    const esc = nav.addRegion(rectU(U, STAIR_U, uTop, tM, tB), yS, { kind: 'escalator' });
    esc.conveyor = [f.ax * cfg.dir * ESC_SPEED, f.az * cfg.dir * ESC_SPEED];
    // 吹き抜けの内側の壁（切符売り場からホームの手すりまで）と、階段とエスカレーターのあいだ
    wall(U(STAIR_U, tA), U(uTop, tA), ym - 0.2, yp + 1.1);
    wall(U(STAIR_U + 0.6, tM), U(uTop - 0.6, tM), ym - 0.2, yp + 1.1);
    wall(U(uTop + 0.05, tA), U(U1, tA), ym - 0.2, yH); // 階段の先（上の端の下）は囲う
    // ホーム（吹き抜けの穴をあける。下の端の側は手すり）
    const hole = rectU(U, STAIR_U - 0.05, uTop, tA, WT * side * 1.01);
    nav.addRegion([at(-Lb, P * side), at(Lb, P * side), at(Lb, WT * side), at(-Lb, WT * side)], yp, { kind: 'platform', line: L.line, side, holes: [hole] });
    wall(U(STAIR_U - 0.05, tA), U(STAIR_U - 0.05, WT * side), yp - 0.2, yp + 1.1);
    const pw = (s0, t0, s1, t1) => wall(at(s0, t0), at(s1, t1), yp - 0.2, yp + PLAT_H);
    pw(-Lb, WT * side, Lb, WT * side);
    pw(-Lb, P * side, -Lb, WT * side);
    pw(Lb, P * side, Lb, WT * side);
    // ホームドア（扉の所は開け閉めする）
    let s = -Lb;
    for (const sd of L.doorsS) {
      pw(s, P * side, sd - 0.8, P * side);
      plan.psdWalls.push({ line: L.line, side, s: sd, wall: pw(sd - 0.8, P * side, sd + 0.8, P * side) });
      s = sd + 0.8;
    }
    pw(s, P * side, Lb, P * side);
  }
  return nav;
}

// 改札の箱と柵（t の範囲）。真ん中に 5 つの通路（幅 0.62 m）
function gateBlocks(WT) {
  const out = [], lane = 0.62, box = 0.3, n = 5, w = n * lane + (n + 1) * box;
  let t = -w / 2;
  out.push([-WT + SHAFT_W * 0, t]);
  for (let i = 0; i <= n; i++) {
    out.push([t, t + box]);
    t += box + lane;
  }
  out.push([w / 2, WT]);
  return out;
}

export function buildAerialMesh(plan, { network = null, groundAt = () => plan.ym } = {}) {
  const mats = stationMaterials();
  const { U, ym, cfg, uTop, station: st } = plan, L = plan.lines[0], f = L.frame, at = f.at, yp = L.yp, WT = L.WT, P = L.P, Lb = L.Lb;
  const tileKey = `tile:${cfg.accent}`;
  const mtl = { ...mats, [tileKey]: Object.assign(mats.tile.clone(), { map: stripedTileTexture(cfg.accent) }) };
  const B = new Builder({ tess: 1.6 }), X = new Builder(), signs = new Signs(); // X: 外の面（太陽の光と影）
  const doors = [], displays = [], extra = new THREE.Group();
  const yc = yp + PLAT_H, yH = ym + plan.hallH, ybed = yp - 1.3;
  const ud = [f.ax * cfg.dir, f.az * cfg.dir], td = [f.nx, f.nz];
  const N = (nu, nt) => [ud[0] * nu + td[0] * nt, ud[1] * nu + td[1] * nt];
  const white = [0.95, 0.95, 0.93], grey = [0.62, 0.64, 0.66];
  const nameKey = signs.material('name', 2.4, 0.6, nameDraw(st.name, cfg.accent));
  const rectS = (s0, s1, t0, t1) => [at(s0, t0), at(s1, t0), at(s1, t1), at(s0, t1)];
  const sOf = (u) => cfg.hallS + cfg.dir * u;
  const hs0 = Math.min(sOf(STAIR_U), sOf(uTop)), hs1 = Math.max(sOf(STAIR_U), sOf(uTop)); // 吹き抜けの s の範囲

  // ---------------------------------------------------------------- ホームの階
  // 線路の所: 床・走行路・案内軌条・天井
  B.floor('concrete', rectS(-Lb, Lb, -P, P), ybed, { color: [0.6, 0.6, 0.6] });
  B.floor('ceiling', rectS(-Lb, Lb, -P, P), yc, { up: false });
  for (const side of [1, -1]) {
    B.wall('concrete', at(-Lb, P * side), at(Lb, P * side), ybed, yp, { n: [-f.nx * side, -f.nz * side] });
    const tc = LAYOUT.trackOff * side;
    for (const o of [-0.86, 0.86]) B.box('paint', ...at(0, tc + o), ybed, yp - 1.0, f.ax, f.az, 2 * Lb, 0.36, { color: C.pad });
    for (const o of [-1.22, 1.22]) B.box('steel', ...at(0, tc + o), yp - 0.95, yp - 0.78, f.ax, f.az, 2 * Lb, 0.08, { color: [0.55, 0.56, 0.58] });
  }
  for (const se of [-Lb, Lb]) B.wall('paint', at(se, -P), at(se, P), yp + 3.6, yc, { n: [-f.ax * Math.sign(se), -f.az * Math.sign(se)], color: white });
  for (const side of [1, -1]) {
    const n = [-f.nx * side, -f.nz * side], tW = WT * side, tP = P * side, tA = (WT - SHAFT_W) * side;
    const term = L.dirs.find((d) => d.side === side).terminus?.name || '';
    // 床（吹き抜けを除く。ホームドアの前は花崗岩の帯）
    for (const [a, b, t1] of [[-Lb, hs0, tW], [hs1, Lb, tW], [hs0, hs1, tA]]) if (b - a > 0.01) B.floor('floor', rectS(a, b, tP + 0.9 * side, t1), yp);
    B.floor('granite', rectS(-Lb, Lb, tP, tP + 0.9 * side), yp + 0.002);
    B.floor('ceiling', rectS(-Lb, Lb, tP, tW), yc, { up: false });
    // 外の壁: 腰壁・横長の窓（地面にもぐる所は壁）・上の壁
    for (let s = -Lb; s < Lb - 0.01; s += 3.15) {
      const s1 = Math.min(Lb, s + 3.15), buried = groundAt(...at((s + s1) / 2, tW + side)) > yp + 0.6;
      B.wall(tileKey, at(s, tW), at(s1, tW), yp, yp + 1.0, { n });
      if (buried) B.wall(tileKey, at(s, tW), at(s1, tW), yp + 1.0, yp + 2.7, { n });
      else {
        B.box('glass', ...at((s + s1) / 2, tW), yp + 1.0, yp + 2.7, f.ax, f.az, s1 - s, 0.03);
        B.box('paint', ...at(s, tW), yp + 1.0, yp + 2.7, f.ax, f.az, 0.09, 0.12, { color: white });
      }
      B.wall('paint', at(s, tW), at(s1, tW), yp + 2.7, yc, { n, color: white });
    }
    for (const se of [-Lb, Lb]) B.wall(tileKey, at(se, tP), at(se, tW), yp, yc, { n: [-f.ax * Math.sign(se), -f.az * Math.sign(se)] });
    for (const tl of [P + 1.0, WT - 1.2]) B.box('light', ...at(0, tl * side), yc - 0.07, yc - 0.005, f.ax, f.az, 2 * Lb - 2, 0.14);
    doors.push(buildPSD(B, signs, L, side, term, mats));
    // 吹き抜けの手すり（ガラスとステンレス）: 内側と、下の端の側
    const rail = (a, b) => {
      B.box('glass', (a[0] + b[0]) / 2, (a[1] + b[1]) / 2, yp + 0.08, yp + 1.05, (b[0] - a[0]) / Math.hypot(b[0] - a[0], b[1] - a[1]), (b[1] - a[1]) / Math.hypot(b[0] - a[0], b[1] - a[1]), Math.hypot(b[0] - a[0], b[1] - a[1]), 0.02);
      B.bar('steel', [a[0], yp + 1.08, a[1]], [b[0], yp + 1.08, b[1]], 0.05);
      for (const p of [a, b]) B.bar('steel', [p[0], yp, p[1]], [p[0], yp + 1.08, p[1]], 0.05);
    };
    rail(U(STAIR_U, tA), U(uTop, tA));
    rail(U(STAIR_U, tA), U(STAIR_U, tW));
    // ベンチ・駅名の板・看板・次の電車の表示
    for (const s of [-Lb + 5, Lb - 6]) {
      if (s > hs0 - 2.5 && s < hs1 + 2.5) continue;
      bench(B, ...at(s, (WT - 0.35) * side), yp, f.ax * side, f.az * side);
    }
    for (const s of [-Lb + 9, 0, Lb - 9]) {
      const [x, z] = at(s, (WT - 0.02) * side);
      signs.panel(nameKey, x, yp + 3.15, z, -f.ax * side, -f.az * side, 2.4, 0.6, n[0], n[1]);
    }
    const tMid = ((P + WT - SHAFT_W) / 2) * side;
    const exitKey = signs.material('exit-plat', 1.6, 0.4, exitDraw(''));
    hangSign(B, signs, exitKey, U(uTop + 2.2, ((P + WT) / 2) * side), yc - 0.9, [f.nx, f.nz], 1.6, 0.4, yc);
    const dirKey = signs.material(`dir-${L.line}-${side}`, 3.2, 0.42, directionDraw(L.line, term));
    const sDir = hs0 > -8 ? hs0 - 8 : hs1 + 8;
    hangSign(B, signs, dirKey, at(sDir, ((P + WT) / 2) * side), yc - 0.9, [f.nx, f.nz], 3.2, 0.42, yc);
    if (typeof document !== 'undefined') displays.push(ledDisplay(B, extra, L, side, at(sDir + (sDir < 0 ? -5 : 5), tMid), yc - 0.85, [f.nx, f.nz], yc, term));
    if (network && side > 0) {
      const sm = hs0 > -8 ? hs0 - 14 : hs1 + 14, [x, z] = at(sm, (WT - 0.03) * side);
      const key = signs.material(`plan-${st.id}`, 1.8, 1.2, networkMapDraw(network, st), { ppm: 560 });
      B.box('steel', x, z, yp + 1.05, yp + 2.33, f.ax, f.az, 1.88, 0.04);
      signs.panel(key, x + n[0] * 0.03, yp + 1.69, z + n[1] * 0.03, -f.ax * side, -f.az * side, 1.8, 1.2, n[0], n[1], 0);
    }

    // ---------------------------------------------------------------- 階段とエスカレーター
    const tM = (WT - 1.4) * side, tB = (WT - 0.1) * side, steps = Math.round(plan.rise / 0.165), tr = plan.run / steps;
    for (let i = 0; i < steps; i++) {
      const y1 = ym + (plan.rise * (i + 1)) / steps, u0 = STAIR_U + i * tr;
      B.floor('darkGranite', rectU(U, u0, u0 + tr, tA, tM), y1);
      B.wall('darkGranite', U(u0, tA), U(u0, tM), y1 - plan.rise / steps, y1, { n: N(-1, 0) });
      B.floor('paint', rectU(U, u0, u0 + 0.045, tA, tM), y1 + 0.003, { color: [0.85, 0.7, 0.12] }); // 段鼻の黄色い線
    }
    const yAt = (u) => ym + plan.rise * Math.max(0, Math.min(1, (u - STAIR_U) / plan.run));
    for (let u = STAIR_U; u < uTop - 1e-6; u += 0.5) {
      const u1 = Math.min(uTop, u + 0.5), k = Math.round(u * 2) % 2 ? 0.09 : 0.13;
      B.quad('paint', [...p3(U(u, tM + 0.12 * side), yAt(u))], [...p3(U(u1, tM + 0.12 * side), yAt(u1))], [...p3(U(u1, tB - 0.12 * side), yAt(u1))], [...p3(U(u, tB - 0.12 * side), yAt(u))], [0, 1, 0], { color: [k, k, k] });
    }
    // 欄干（階段とエスカレーターのあいだ・外の壁の側）と手すり
    for (const tt of [tM, tB]) {
      const a = U(STAIR_U, tt), b = U(uTop, tt);
      B.quad('steel', [...p3(a, ym + 0.05)], [...p3(b, yp + 0.05)], [...p3(b, yp + 0.95)], [...p3(a, ym + 0.95)], [-td[0] * side, 0, -td[1] * side]);
      if (tt === tM) B.quad('steel', [...p3(b, yp + 0.05)], [...p3(a, ym + 0.05)], [...p3(a, ym + 0.95)], [...p3(b, yp + 0.95)], [td[0] * side, 0, td[1] * side]);
      B.bar('paint', [a[0], ym + 1.0, a[1]], [b[0], yp + 1.0, b[1]], 0.07, { color: C.black });
    }
    B.bar('steel', [...p3(U(STAIR_U, tA + 0.08 * side), ym + 0.95)], [...p3(U(uTop, tA + 0.08 * side), yp + 0.95)], 0.045);
    // 吹き抜けの壁: 内側（切符売り場の床からホームの床まで）・階段の上の端の下・外の壁
    B.wall(tileKey, U(STAIR_U, tA), U(uTop, tA), ym, yp, { n: [td[0] * side, td[1] * side] });
    B.wall(tileKey, U(STAIR_U, tA), U(U1, tA), ym, yH, { n: [-td[0] * side, -td[1] * side] });
    B.wall(tileKey, U(STAIR_U, tW), U(uTop, tW), ym, yp, { n });
    B.wall(tileKey, U(uTop, tA), U(uTop, tW), ym, yp, { n: N(-1, 0) });
    // 階段の口の上の方面の看板
    const upKey = signs.material(`up-${L.line}-${side}`, 2.6, 0.42, directionDraw(L.line, term, { arrow: '↑' }));
    const [sx, sz] = U(STAIR_U - 0.3, (tA + tW) / 2);
    signs.panel(upKey, sx, ym + 2.75, sz, td[0] * cfg.dir, td[1] * cfg.dir, 2.6, 0.42, ...N(-1, 0), 0.01);
    B.wall(tileKey, U(STAIR_U, tA), U(STAIR_U, tW), ym + 2.5, yH, { n: N(-1, 0) });
  }

  // ---------------------------------------------------------------- 切符売り場
  B.floor('granite', rectU(U, U0, U1, -WT, WT), ym);
  // 天井（階段の吹き抜けを除く）と照明
  B.floor('ceiling', rectU(U, U0, STAIR_U, -WT, WT), yH, { up: false });
  B.floor('ceiling', rectU(U, STAIR_U, U1, -(WT - SHAFT_W), WT - SHAFT_W), yH, { up: false });
  for (const side of [1, -1]) B.floor('ceiling', rectU(U, uTop, U1, (WT - SHAFT_W) * side, WT * side), yH, { up: false });
  for (const t of [-5.4, -1.8, 1.8, 5.4]) {
    const far = Math.abs(t) > WT - SHAFT_W - 0.3 ? STAIR_U - 1 : U1 - 1;
    B.box('light', ...U((U0 + 1 + far) / 2, t), yH - 0.07, yH - 0.005, ud[0], ud[1], far - U0 - 1, 0.14);
  }
  // 壁: 白い小さなタイル。扉の所はガラスの扉（開いたまま）と上の欄間、両側は腰壁の上に窓
  const edges = [[U0, -WT, U1, -WT, 0, -1], [U0, WT, U1, WT, 0, 1], [U0, -WT, U0, WT, -1, 0], [U1, -WT, U1, WT, 1, 0]];
  for (const [u0, t0, u1, t1, nu, nt] of edges) {
    const cuts = plan.doors.filter((d) => d.nu === nu && d.nt === nt).map((d) => (nu ? d.t : d.u)).sort((a, b) => a - b);
    const pt = (v) => (nu ? U(u0, v) : U(v, t0)), n = N(-nu, -nt);
    let a = nu ? t0 : u0;
    const end = nu ? t1 : u1;
    const seg = (v0, v1) => {
      if (v1 - v0 < 0.01) return;
      B.wall(tileKey, pt(v0), pt(v1), ym, yH, { n });
    };
    for (const c of cuts) {
      seg(a, c - DOOR_W / 2);
      B.wall(tileKey, pt(c - DOOR_W / 2), pt(c + DOOR_W / 2), ym + 2.5, yH, { n });
      // 扉の枠と、開いたガラスの扉
      for (const k of [-1, 1]) {
        const e = pt(c + (k * DOOR_W) / 2);
        B.box('steel', e[0], e[1], ym, ym + 2.5, n[0], n[1], 0.3, 0.1);
        const o = N(nu, nt);
        B.box('glass', e[0] + o[0] * 0.5, e[1] + o[1] * 0.5, ym + 0.05, ym + 2.4, o[0], o[1], 0.95, 0.03);
      }
      a = c + DOOR_W / 2;
    }
    seg(a, end);
  }
  // 丸い柱（タイル張り。線路の下の両側）
  for (const u of [-12, -1, 6, 13]) for (const t of [-P, P]) B.cyl(tileKey, ...U(u, t), ym, yH, 0.42, { seg: 14 });
  // 改札: ステンレスの箱と三脚の棒、両側のガラスの柵、上の方面の看板
  const blocks = gateBlocks(WT);
  blocks.forEach(([a, b], i) => {
    const [x, z] = U(GATE_U, (a + b) / 2);
    if (i === 0 || i === blocks.length - 1) {
      B.box('glass', x, z, ym + 0.1, ym + 1.1, td[0], td[1], b - a, 0.02);
      B.bar('steel', [...p3(U(GATE_U, a), ym + 1.12)], [...p3(U(GATE_U, b), ym + 1.12)], 0.05);
      return;
    }
    B.box('steel', x, z, ym, ym + 0.98, ud[0], ud[1], 1.5, b - a);
    B.box('paint', x, z, ym + 0.98, ym + 1.0, ud[0], ud[1], 1.5, b - a, { color: C.black });
    if (i < blocks.length - 2) {
      for (const [dy, dt] of [[0, 0.3], [-0.2, 0.22], [-0.2, 0.36]]) B.bar('steel', [...p3(U(GATE_U, b), ym + 0.85)], [...p3(U(GATE_U + (dt - 0.3) * 2, b + dt), ym + 0.85 + dy)], 0.035);
    }
  });
  const termA = L.dirs.find((d) => d.side === 1).terminus?.name || '', termB = L.dirs.find((d) => d.side === -1).terminus?.name || '';
  const gateKey = signs.material('gate-sign', 5.2, 0.5, directionDraw(L.line, termA === termB ? termA : `${termB} · ${termA}`));
  hangSign(B, signs, gateKey, U(GATE_U, 0), yH - 0.6, [td[0] * cfg.dir, td[1] * cfg.dir], 5.2, 0.5, yH, true);
  // 券売機（赤）と、上の案内の画面。端の壁に扉があれば両脇へ
  const endDoor = plan.doors.some((d) => d.nu === -1);
  const tk = signs.material('ticket', 0.7, 1.0, ticketDraw());
  for (const t of endDoor ? [-6.2, -4.9, 4.9, 6.2] : [-1.95, -0.65, 0.65, 1.95]) {
    const [x, z] = U(U0 + 0.4, t);
    B.box('paint', x, z, ym, ym + 1.9, td[0], td[1], 1.1, 0.7, { color: C.ticketRed });
    signs.panel(tk, x + ud[0] * 0.36, ym + 1.2, z + ud[1] * 0.36, -td[0] * cfg.dir, -td[1] * cfg.dir, 0.7, 1.0, ud[0], ud[1], 0);
  }
  // 駅名と出口の看板
  for (const d of plan.doors) {
    const ek = signs.material('exit-hall', 1.6, 0.4, exitDraw(''));
    hangSign(B, signs, ek, [d.x - d.nx * 1.6, d.z - d.nz * 1.6], yH - 0.6, [-d.nz, d.nx], 1.6, 0.4, yH);
  }
  for (const k of [1, -1]) {
    const [x, z] = U((U0 + GATE_U) / 2 - 2.5 * (plan.doors.some((d) => d.nt === k) ? -1.6 : 0), (WT - 0.02) * k);
    signs.panel(nameKey, x, ym + 2.9, z, -f.ax * k, -f.az * k, 2.4, 0.6, -td[0] * k, -td[1] * k);
  }

  // ---------------------------------------------------------------- 外（白い建物・屋根・柱・橋の床版）
  const o = 0.28; // 壁の厚さ
  const blue = [0.2, 0.47, 0.75];
  const ext = (a, b, y0, y1, n, color = white) => X.wall('ext', a, b, y0, y1, { n, color });
  // ホームの階の外の壁（窓の帯の上下）と端の壁
  for (const side of [1, -1]) {
    const t = (WT + o) * side, n = [td[0] * side, td[1] * side];
    ext(at(-Lb - o, t), at(Lb + o, t), yp - 1.9, yp + 1.0, n);
    ext(at(-Lb - o, t), at(Lb + o, t), yp + 2.7, yc + 0.5, n);
    for (let s = -Lb; s <= Lb + 0.01; s += 6.3) X.box('ext', ...at(s, t), yp + 1.0, yp + 2.7, f.ax, f.az, 0.3, 0.12, { color: white });
    if (!cfg.vault) for (let s = -Lb + 2; s < Lb; s += 4.2) X.box('ext', ...at(s, t + 0.02 * side), yp + 3.2, yp + 3.75, f.ax, f.az, 0.16, 0.04, { color: blue });
    for (const se of [-Lb - o, Lb + o]) ext(at(se, P * side), at(se, t), yp - 1.9, yc + 0.5, [f.ax * Math.sign(se), f.az * Math.sign(se)]);
  }
  for (const se of [-Lb - o, Lb + o]) ext(at(se, -P), at(se, P), yp + 3.6, yc + 0.5, [f.ax * Math.sign(se), f.az * Math.sign(se)]);
  // 橋の床版の下面（切符売り場の外）と柱
  X.floor('ext', rectS(-Lb - o, Lb + o, -WT - o, WT + o), yp - 1.9, { up: false, color: grey });
  for (let s = -Lb + 1.5; s <= Lb - 1.4; s += 9.5) {
    for (const side of [1, -1]) {
      const [x, z] = at(s, (WT + o + 0.35) * side), gy = groundAt(x, z) - 0.4, top = cfg.vault ? yc + 0.5 : yp - 1.9;
      if (top - gy > 1) X.cyl('ext', x, z, gy, top, 0.38, { seg: 12, color: white });
    }
  }
  // 屋根: Basso Cambo はホームごとのかまぼこ形の金属の屋根、Jolimont は平らな屋根
  const yR = yc + 0.5, W = WT + o + 0.5;
  if (cfg.vault) {
    for (const side of [1, -1]) {
      const segs = 10;
      for (let k = 0; k < segs; k++) {
        const a0 = (k / segs) * Math.PI, a1 = ((k + 1) / segs) * Math.PI, am = (a0 + a1) / 2;
        const tt = (a) => ((W / 2) * (1 - Math.cos(a))) * side, yy = (a) => yR + 1.7 * Math.sin(a);
        const a = at(-Lb - 1, tt(a0)), b = at(Lb + 1, tt(a0)), c = at(Lb + 1, tt(a1)), d = at(-Lb - 1, tt(a1));
        const nn = [-Math.cos(am) * 0.6 * side, 0.8];
        X.quad('roof', [a[0], yy(a0), a[1]], [b[0], yy(a0), b[1]], [c[0], yy(a1), c[1]], [d[0], yy(a1), d[1]], [td[0] * nn[0], nn[1], td[1] * nn[0]], { color: [0.72, 0.74, 0.76] });
        // 妻（屋根の端の半月形の壁）
        for (const [p, q, sg] of [[a, d, -1], [b, c, 1]]) X.quad('ext', [p[0], yR, p[1]], [q[0], yR, q[1]], [q[0], yy(a1), q[1]], [p[0], yy(a0), p[1]], [f.ax * sg, 0, f.az * sg], { color: white });
      }
    }
  } else X.floor('roof', rectS(-Lb - 1, Lb + 1, -W, W), yR, { color: [0.7, 0.71, 0.72] });
  for (const side of [1, -1]) X.box('ext', ...at(0, W * side), yR - 0.35, yR + 0.05, f.ax, f.az, 2 * Lb + 2, 0.3, { color: white });
  // 切符売り場の外の壁（扉の所をあける）と、扉の上のひさし・M の看板、扉の外のスロープ
  const mKey = signs.material('m-sign', 0.9, 0.9, (x, Wp, Hp) => {
    x.fillStyle = '#f2b61c';
    x.fillRect(0, 0, Wp, Hp);
    x.fillStyle = '#1b2a57';
    x.beginPath();
    x.arc(Wp / 2, Hp / 2, Wp * 0.36, 0, Math.PI * 2);
    x.fill();
    x.fillStyle = '#f2b61c';
    x.font = `800 ${Math.round(Hp * 0.5)}px Arial`;
    x.textAlign = 'center';
    x.textBaseline = 'middle';
    x.fillText('M', Wp / 2, Hp * 0.54);
  });
  const gLow = (u0, t0, u1, t1) => Math.min(groundAt(...U(u0, t0)), groundAt(...U(u1, t1)), ym) - 0.6;
  for (const [u0, t0, u1, t1, nu, nt] of edges) {
    const cuts = plan.doors.filter((d) => d.nu === nu && d.nt === nt).map((d) => (nu ? d.t : d.u)).sort((a, b) => a - b);
    const pt = (v) => (nu ? U(u0 + nu * o, v) : U(v, t0 + nt * o)), n = N(nu, nt);
    let a = (nu ? t0 : u0) - o;
    const end = (nu ? t1 : u1) + o, top = yp - 1.9;
    for (const c of cuts) {
      ext(pt(a), pt(c - DOOR_W / 2), gLow(u0, t0, u1, t1), top, n);
      ext(pt(c - DOOR_W / 2), pt(c + DOOR_W / 2), ym + 2.5, top, n);
      const m = pt(c);
      X.box('ext', m[0] + n[0] * 0.9, m[1] + n[1] * 0.9, ym + 2.6, ym + 2.75, -n[1], n[0], DOOR_W + 1.2, 1.8, { color: grey, bottom: true });
      signs.panel(mKey, m[0] + n[0] * 0.02, ym + 3.5, m[1] + n[1] * 0.02, n[1], -n[0], 0.9, 0.9, n[0], n[1], 0.02);
      a = c + DOOR_W / 2;
    }
    ext(pt(a), pt(end), gLow(u0, t0, u1, t1), top, n);
  }
  for (const d of plan.doors) {
    const sx = -d.nz, sz = d.nx, h = DOOR_W / 2 + 0.3;
    const p = (q, v, y) => [d.x + d.nx * q + sx * v, y, d.z + d.nz * q + sz * v];
    X.quad('ext', p(0, -h, ym), p(APRON, -h, d.gy + 0.03), p(APRON, h, d.gy + 0.03), p(0, h, ym), [0, 1, 0], { color: [0.7, 0.69, 0.66] });
    for (const v of [-h, h]) X.quad('ext', p(0, v, ym), p(APRON, v, d.gy), p(APRON, v, d.gy - 1.5), p(0, v, ym - 1.5), [sx * Math.sign(v), 0, sz * Math.sign(v)], { color: grey });
  }

  const group = B.build(mtl, { light: bakeStationLight(B.lights, [ym, yp], { ambient: 0.74, gain: 0.9 }), name: `station-${st.id}` });
  const extMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, side: THREE.DoubleSide });
  const roofMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.45, metalness: 0.55, side: THREE.DoubleSide });
  group.add(X.build({ ext: extMat, roof: roofMat }, { shadows: true, name: 'exterior' }));
  group.add(signs.build());
  for (const d of doors) group.add(d.group);
  group.add(extra);
  return { group, doors, displays, style: { accent: cfg.accent } };
}

function p3([x, z], y) {
  return [x, y, z];
}
