// 駅の中を OpenStreetMap の屋内の地図から組み立てる（three.js を使わない。単体テストできる）。
// - 階: ホームの階（OSM の level。-1〜-4）から地下 1 階まで。地下 1 階の床 ym から 5 m ごと、ホームの階の上だけ 5.5 m。
//   ホームが地下 1 階の駅（切符売り場が地上の駅舎の中: Bellefontaine・Argoulets など）は、ホームを地面の 6.2 m 下に
// - 階段・エスカレーター（block）: OSM の階段の線（level="-2;-1" など）。並んだ階段とエスカレーターは 1 つの吹き抜けにまとめる。
//   ホームへ下りるものは下の端（ホームの上の位置）を、ほかは上の端を OSM の位置に合わせ、高さの差に合う長さにする
// - 各階の床: OSM の通路（幅 3.2 m）・広間（indoor の形）・階段の上と下の踊り場・出入口の扉の前を合わせた形から、
//   その階を通る階段と出入口の吹き抜けの形を除く。壁は床の縁（階段・出入口の吹き抜けの縁は、それぞれの壁）。
//   踊り場や扉の前を含まない離れたかたまりは捨て、残ったかたまりどうしが離れていれば通路でつなぐ（地図の通路が途切れている所）
// - ホームの階: 相対式のホーム（奥の壁までの幅は、ホームの階段の位置から）か、島式のホーム（network.js の island）
// - 改札: 出入口が着く階（切符売り場の階）から下りる階段の手前 3.5 m に、床の幅いっぱいに
// 座標はゲームのローカル座標（x 東・z 南）
import polygonClipping from 'polygon-clipping';
import { Earcut } from 'three/src/extras/Earcut.js';
import { LAYOUT, TRAIN_CARS, boxHalf, doorOffsets, islandOf, stationFrame, terminusOf, wallT } from './network.js';
import { NavLayer, rectPoly } from './nav.js';
import { ESC_SPEED, PLAT_H, addPitNav, escalatorHeight, escalatorRun, flightHeight, hallLevel, stairRun } from './stationplan.js';
import { entranceDoor, entranceFrame, entranceMaxDepth, rimAt } from '../world/metro.js';

export const OSM_HALL_H = 3.4; // 地下の階の天井の高さ
const LEVEL_STEP = 5.0, PLATFORM_DROP = 5.5, SHALLOW = 6.2;
const PATH_HALF = 1.6; // 通路の幅の半分
const STAIRS_W = 1.8, ESC_W = 1.05, LANE_GAP = 0.25;
const PAD = 3.0; // 階段の上と下の踊り場の奥行き
const MAX_R = 95; // 駅の中心からこれより遠いものは使わない（鉄道の駅の地下道など）
const GATE_BEFORE = 3.5; // 改札から階段の上の端まで

const ring = (pts) => [...pts, pts[0]];
const poly = (pts) => [ring(pts)];
// polygon-clipping は、ほとんど重なる辺で失敗することがある: 座標を 1 cm・5 cm の格子に丸めてやり直す
const snap = (g, q) => (typeof g[0] === 'number' ? [Math.round(g[0] / q) * q, Math.round(g[1] / q) * q] : g.map((x) => snap(x, q)));
function clip(op, a, ...rest) {
  try {
    return polygonClipping[op](a, ...rest);
  } catch {
    for (const q of [0.01, 0.05, 0.2]) {
      try {
        return polygonClipping[op](snap(a, q), ...rest.map((r) => snap(r, q)));
      } catch {
        /* 次の格子で */
      }
    }
    // それでも失敗: 1 つずつ（失敗するものは除く）
    let acc = snap(a, 0.05);
    for (const r of rest) {
      try {
        acc = polygonClipping[op](acc, snap(r, 0.05));
      } catch {
        /* 除く */
      }
    }
    return acc;
  }
}
function unionAll(list) {
  if (!list.length) return [];
  let acc = clip('union', list[0]);
  for (let i = 1; i < list.length; i += 48) acc = clip('union', acc, ...list.slice(i, i + 48));
  return acc;
}
const minus = (a, list) => (a.length && list.length ? clip('difference', a, ...list) : a);

// 線分 a→b を幅 2h の長方形に（両端を h だけ延ばす）
function segRect(a, b, h) {
  const dx = b[0] - a[0], dz = b[1] - a[1], l = Math.hypot(dx, dz) || 1, ux = dx / l, uz = dz / l, nx = -uz * h, nz = ux * h;
  const A = [a[0] - ux * h, a[1] - uz * h], B = [b[0] + ux * h, b[1] + uz * h];
  return [[A[0] + nx, A[1] + nz], [B[0] + nx, B[1] + nz], [B[0] - nx, B[1] - nz], [A[0] - nx, A[1] - nz]];
}

// 向き u（単位）・横 v の長方形: 原点 o から u の向きに [u0, u1]、横に [v0, v1]
export function orientedRect(o, u, u0, u1, v0, v1) {
  const v = [-u[1], u[0]];
  const P = (a, b) => [o[0] + u[0] * a + v[0] * b, o[1] + u[1] * a + v[1] * b];
  return [P(u0, v0), P(u1, v0), P(u1, v1), P(u0, v1)];
}

// 局所の座標（原点 o、向き u。横 v は u の左回り 90°）
function localFrame(o, u) {
  const [ux, uz] = u, vx = -uz, vz = ux, [ox, oz] = o;
  return {
    ax: ux, az: uz, nx: vx, nz: vz, x: ox, z: oz,
    at: (s, t) => [ox + ux * s + vx * t, oz + uz * s + vz * t],
    local: (x, z) => [(x - ox) * ux + (z - oz) * uz, (x - ox) * vx + (z - oz) * vz],
  };
}

// 点が多角形（polygon-clipping の MultiPolygon）の中か
export function inMulti(mp, x, z) {
  for (const pg of mp) {
    if (!inRing(pg[0], x, z)) continue;
    if (pg.slice(1).some((h) => inRing(h, x, z))) continue;
    return true;
  }
  return false;
}
function inRing(r, x, z) {
  let c = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [xi, zi] = r[i], [xj, zj] = r[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) c = !c;
  }
  return c;
}
function onRingEdge(r, x, z, eps) {
  for (let i = 0; i + 1 < r.length; i++) {
    const [ax, az] = r[i], [bx, bz] = r[i + 1], dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz || 1;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2));
    if (Math.hypot(ax + dx * t - x, az + dz * t - z) < eps) return true;
  }
  return false;
}
// 凸包（反時計回り）
function convexHull(pts) {
  const p = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [], upper = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop();
    lower.push(q);
  }
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop();
    upper.push(q);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

function areaOf(pts) {
  let a = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += pts[j][0] * pts[i][1] - pts[i][0] * pts[j][1];
  return Math.abs(a / 2);
}

// 駅の OSM の地図をローカル座標に
export function projectStationOsm(st, proj) {
  const P = (q) => proj.project(q[0], q[1]);
  return {
    steps: st.steps.map((s) => ({ ...s, pts: s.pts.map(P) })),
    paths: st.paths.map((p) => ({ ...p, pts: p.pts.map(P) })),
    areas: st.areas.map((a) => ({ ...a, poly: a.poly.map(P) })),
    elevators: st.elevators.map((e) => ({ ...e, p: P(e.p) })),
    entrances: st.entrances.map((e) => ({ ...e, p: P(e.p) })),
  };
}

// OSM の間取りで組み立てられる駅か（どの線もホームの階が地下）
export function osmCapable(station) {
  return station.lines.every((l) => station.osmLevel?.[l] != null && station.osmLevel[l] < 0);
}

// 階の高さ: 地下 1 階 ym から下へ。platformLevels: ホームの階（その上の段差は 5.5 m）
export function levelHeights(ym, ground, platformLevels) {
  const cache = new Map();
  const y = (l) => {
    if (cache.has(l)) return cache.get(l);
    let v;
    if (l >= 0) v = ground + l * 5.5;
    else if (l > -1) v = ground + (ym - ground) * -l;
    else if (l === -1) v = ym;
    else if (Math.ceil(l) !== l) v = y(Math.floor(l)) + (y(Math.ceil(l)) - y(Math.floor(l))) * (l - Math.floor(l));
    else v = y(l + 1) - (platformLevels.has(l) ? PLATFORM_DROP : LEVEL_STEP);
    cache.set(l, v);
    return v;
  };
  return y;
}

const platformLevelsOf = (station) => new Set(station.lines.map((l) => station.osmLevel[l]));

// 駅の地下 1 階の床（station.hallY）と、出入口の吹き抜けの深さ（下の端を、その階段の着く階の床にそろえる。e.H）。
// world/ground.js の T.metroAdjust から、地形の手直しの前に 1 回。pits: この駅の出入口（rim のあるもの。e.level: 着く階）
export function osmStationDepth(station, pits, groundAt) {
  if (!osmCapable(station)) return null;
  const own = pits.filter((e) => e.kind === 'metro' && e.rim != null);
  const plat = platformLevelsOf(station);
  let ym;
  if (plat.has(-1)) {
    // ホームが地下 1 階: 地面の 6.2 m 下（まわりの低い地面から 5.6 m）
    const f = stationFrame(station, station.lines[0]);
    ym = groundAt(station.x, station.z) - SHALLOW;
    for (let s = -30; s <= 30; s += 10) for (const t of [-8, 0, 8]) ym = Math.min(ym, groundAt(...f.at(s, t)) - SHALLOW + 0.6);
    ym = Math.round(ym * 100) / 100;
  } else ym = hallLevel(station, own, groundAt);
  station.hallY = ym;
  const Y = levelHeights(ym, groundAt(station.x, station.z), plat);
  for (const e of own) {
    const want = rimAt(e, e.len / 2, 0) - Y(e.level ?? -1) + 0.03; // 踊り場は床の 3 cm 下（床と重ならない）
    e.H = Math.max(2.8, Math.min(want, entranceMaxDepth(e)));
  }
  return Y;
}

// OSM の間取りの駅の高さ: 地下 1 階 ym（station.hallY。osmStationDepth で決める）と、線ごとのホームの床 yp
export function osmStationLevels(station, ground) {
  const Y = levelHeights(station.hallY, ground, platformLevelsOf(station));
  return { ym: station.hallY, yp: Object.fromEntries(station.lines.map((l) => [l, Y(station.osmLevel[l])])) };
}

// ホームが地下 1 階の駅の、OSM に階段の地図のない出入口（osm-guess）: ホームの奥の壁ぎわに、ホームの向きに下りる吹き抜け
// （上の端は出入口の印の近く、下の端はホームの中）
export function alignShallowPits(station, pits) {
  if (!osmCapable(station) || !platformLevelsOf(station).has(-1)) return;
  const line = station.lines[0], f = stationFrame(station, line), Lb = boxHalf(line, station);
  for (const e of pits) {
    if (e.src !== 'osm-guess') {
      // 地図のある吹き抜け: 上の端はそのままで、ホームの深さまで階段で下りられる長さに（下の端を延ばす）
      if (e.len < 13) {
        const fe = entranceFrame(e), [x, z] = fe.at((13 - e.len) / 2, 0);
        Object.assign(e, { x, z, len: 13 });
      }
      continue;
    }
    const fe = entranceFrame(e), [tx, tz] = fe.at(-e.len / 2, 0), [sTop, tTop] = f.local(tx, tz);
    const len = Math.max(e.len, 13), side = Math.sign(tTop) || 1;
    const s0 = Math.max(-Lb + 1, Math.min(Lb - 1, sTop)), dS = s0 > 0 ? -1 : 1;
    const sc = Math.max(-Lb + 1 + len / 2, Math.min(Lb - 1 - len / 2, s0 + (dS * len) / 2));
    const [x, z] = f.at(sc, side * (LAYOUT.psd + 2.6 + e.wid / 2));
    Object.assign(e, { x, z, len, ang: Math.atan2(f.az * dS, f.ax * dS), down: 1 });
  }
  // 長くして重なった吹き抜けは、ホームの軸から外へずらして並べる
  const tOf = (e) => f.local(e.x, e.z)[1];
  const overlap = (a, b) => {
    const [sa] = f.local(a.x, a.z), [sb] = f.local(b.x, b.z);
    const ha = Math.abs(Math.cos(a.ang) * f.ax + Math.sin(a.ang) * f.az) > 0.7, hb = Math.abs(Math.cos(b.ang) * f.ax + Math.sin(b.ang) * f.az) > 0.7;
    const ea = ha ? [a.len / 2, a.wid / 2] : [a.wid / 2, a.len / 2], eb = hb ? [b.len / 2, b.wid / 2] : [b.wid / 2, b.len / 2];
    return Math.abs(sa - sb) < ea[0] + eb[0] + 0.3 && Math.abs(tOf(a) - tOf(b)) < ea[1] + eb[1] + 0.4 ? ea[1] + eb[1] + 0.4 : 0;
  };
  for (let i = 0; i < pits.length; i++) {
    for (let j = 0; j < i; j++) {
      const need = overlap(pits[j], pits[i]);
      if (!need) continue;
      const e = pits[i], t = tOf(e), side = Math.sign(t) || 1, [sx] = f.local(e.x, e.z);
      [e.x, e.z] = f.at(sx, tOf(pits[j]) + side * need);
    }
  }
}

// ホームが地下 1 階の駅で、出入口の吹き抜けが片側のホームにしか着かないとき、反対側にも同じ形の吹き抜けを足す
// （地上の駅舎から両側のホームへ下りる。OSM に片側しか描かれていない駅）。pits: ローカル座標の出入口（projectEntrances）
export function completeShallowPits(station, pits) {
  if (!osmCapable(station) || !platformLevelsOf(station).has(-1)) return [];
  const f = stationFrame(station, station.lines[0]);
  const sideOf = (e) => Math.sign(f.local(e.x, e.z)[1]) || 1;
  const sides = new Set(pits.map(sideOf));
  if (!pits.length || sides.size > 1) return [];
  // 鏡に映した吹き抜け（軸について反対側。向きも映す）
  return pits.map((e) => {
    const [s, t] = f.local(e.x, e.z), [x, z] = f.at(s, -t);
    const d = [Math.cos(e.ang) * e.down, Math.sin(e.ang) * e.down];
    const ds = d[0] * f.ax + d[1] * f.az, dt = d[0] * f.nx + d[1] * f.nz;
    const dx = f.ax * ds - f.nx * dt, dz = f.az * ds - f.nz * dt;
    return { ...e, x, z, ang: Math.atan2(dz, dx), down: 1, mirrored: true };
  });
}

// ---------------------------------------------------------------- 間取り
// station: 路線網の駅（cx・axis・osmLevel・hallY）、osm: projectStationOsm の結果、pits: この駅の出入口の吹き抜け
// （world/metro.js。rim・H の付いたもの）、ground: 駅の地面の高さ
export function planOsmStation(station, osm, pits, { ground, network = null } = {}) {
  if (!osmCapable(station) || station.hallY == null) return null;
  const ym = station.hallY;
  const platformLevels = platformLevelsOf(station);
  const Y = levelHeights(ym, ground, platformLevels);
  const center = [station.x, station.z];
  const near = (p) => Math.hypot(p[0] - center[0], p[1] - center[1]) < MAX_R;
  const lines = station.lines.map((line) => {
    const f = stationFrame(station, line), Lp = station.osmLevel[line], island = islandOf(station, line), n = TRAIN_CARS[line];
    return {
      line, frame: f, level: Lp, yp: Y(Lp), Lb: boxHalf(line, station), doorsS: doorOffsets(n), psdHalf: (n * LAYOUT.carPitch) / 2 + 0.6,
      island, P: island || LAYOUT.psd, WT: island || wallT(),
      dirs: [1, -1].map((side) => ({ side, dir: side, terminus: network ? terminusOf(network, line, side) : null })),
    };
  });
  const lineAt = (lv) => lines.find((L) => L.level === lv);
  const minLevel = Math.min(...platformLevels);

  // ---------------------------------------------------------------- 階段・エスカレーター
  const items = [];
  for (const s of osm.steps) {
    if (s.levels.length < 2 || s.pts.length < 2) continue;
    const lo = Math.min(...s.levels), hi = Math.max(...s.levels);
    if (lo < minLevel || hi >= 0) continue; // 地上へ出る階段は出入口（osmentrances.js）
    const a = s.pts[0], b = s.pts[s.pts.length - 1];
    if (!near(a) && !near(b)) continue;
    let U, D;
    if (s.incline === 'up') [U, D] = [b, a];
    else if (s.incline === 'down') [U, D] = [a, b];
    else {
      // 下の端: ホームの階へ下りるならホームの真ん中に近い方、ほかは駅の中心に近い方
      const L = lineAt(lo);
      const score = (p) => (L ? Math.abs(L.frame.local(...p)[0]) : Math.hypot(p[0] - center[0], p[1] - center[1]));
      [U, D] = score(a) < score(b) ? [b, a] : [a, b];
    }
    const len = Math.hypot(D[0] - U[0], D[1] - U[1]);
    if (len < 1) continue;
    const esc = !!s.conveying && s.conveying !== 'no';
    items.push({ lo, hi, U, D, dir: [(D[0] - U[0]) / len, (D[1] - U[1]) / len], esc, w: esc ? ESC_W : Math.max(1.4, Math.min(3.2, s.width || STAIRS_W)) });
  }
  // 並んだもの（同じ階どうし、ほぼ平行、横に 3.2 m 以内）をまとめる
  const groups = [];
  for (const it of items) {
    const g = groups.find((q) => {
      const a = q[0];
      if (a.lo !== it.lo || a.hi !== it.hi) return false;
      if (a.dir[0] * it.dir[0] + a.dir[1] * it.dir[1] < 0.94) return false;
      const m = [(it.U[0] + it.D[0]) / 2 - (a.U[0] + a.D[0]) / 2, (it.U[1] + it.D[1]) / 2 - (a.U[1] + a.D[1]) / 2];
      return Math.abs(-a.dir[1] * m[0] + a.dir[0] * m[1]) < 3.2 && Math.abs(a.dir[0] * m[0] + a.dir[1] * m[1]) < 8;
    });
    if (g) g.push(it);
    else groups.push([it]);
  }
  const blocks = [];
  // 車線: エスカレーターはそれぞれ、階段は 1 つにまとめる（並んだ階段の線は同じ階段の両端のことが多い）。横の順に
  const lanesOf = (g) => {
    const st = g.filter((it) => !it.esc), es = g.filter((it) => it.esc);
    const out = es.map((it) => ({ kind: 'escalator', w: ESC_W, v: it.v }));
    if (st.length) out.push({ kind: 'stairs', w: Math.min(3.6, Math.max(...st.map((it) => it.w)) + (st.length > 1 ? 0.6 : 0)), v: st.reduce((a, it) => a + it.v, 0) / st.length });
    return out.sort((p, q) => p.v - q.v);
  };
  for (const g of groups) {
    const lo = g[0].lo, hi = g[0].hi, y0 = Y(hi), y1 = Y(lo), drop = y0 - y1;
    let dir = [g.reduce((a, it) => a + it.dir[0], 0), g.reduce((a, it) => a + it.dir[1], 0)];
    const dl = Math.hypot(...dir) || 1;
    dir = [dir[0] / dl, dir[1] / dl];
    const side = [-dir[1], dir[0]], o = g[0].U;
    for (const it of g) it.v = (it.U[0] - o[0]) * side[0] + (it.U[1] - o[1]) * side[1];
    const lanes = lanesOf(g);
    const W = lanes.reduce((a, ln) => a + ln.w, 0) + LANE_GAP * (lanes.length - 1) + 0.3;
    const run = Math.max(...lanes.map((ln) => (ln.kind === 'escalator' ? escalatorRun(drop) : stairRun(drop).run)));
    const len = run + 0.6;
    const vc = g.reduce((a, it) => a + it.v, 0) / g.length;
    const Um = [o[0] + side[0] * vc, o[1] + side[1] * vc];
    const Dm = [g.reduce((a, it) => a + it.D[0], 0) / g.length, g.reduce((a, it) => a + it.D[1], 0) / g.length];
    const b = { lo, hi, y0, y1, dir, W, len, run, lanes, top: Um, Dm, toPlatform: false };
    const L = lineAt(lo);
    if (L) {
      // ホームへ下りる: 向きは駅の軸にそろえ、上の端を OSM の位置に（下の端がホームの端を越えるなら、ホームの端まで戻す）
      const f = L.frame, [sU] = f.local(...Um), [, tD] = f.local(...Dm);
      const dS = Math.sign(dir[0] * f.ax + dir[1] * f.az) || 1;
      const sBot = Math.max(-L.Lb + 1, Math.min(L.Lb - 1, sU + dS * len));
      Object.assign(b, { dir: [f.ax * dS, f.az * dS], dS, line: L.line, toPlatform: true, sBot, tOsm: tD });
      if (!L.island) {
        b.side = tD >= 0 ? 1 : -1;
        // 相対式: 奥の壁までの幅を OSM の階段の位置から（8.15〜13 m）
        L.WT = Math.max(L.WT, Math.min(13, Math.abs(tD) + W / 2 + 0.3));
      } else b.side = 0;
    }
    blocks.push(b);
  }
  // ホームへの階段の位置。相対式: 奥の壁ぎわに、s の範囲が重なるものは壁から内へ並べる（OSM で壁に近い方から）。
  // 島式: 真ん中か OSM の位置に、重なるものは s の向きに離す
  const span = (b) => [Math.min(b.sBot, b.sBot - b.dS * b.len), Math.max(b.sBot, b.sBot - b.dS * b.len)];
  const overlapS = (a, b, m) => {
    const [a0, a1] = span(a), [b0, b1] = span(b);
    return a0 < b1 + m && b0 < a1 + m;
  };
  for (const L of lines) {
    const f = L.frame;
    if (L.island) {
      // s の範囲が重なるものは横に並べ（OSM の横の順に。両側に 1.6 m の通り道が残るなら）、ホームの真ん中にそろえる
      const list = blocks.filter((b) => b.toPlatform && b.line === L.line).sort((a, b) => span(a)[0] - span(b)[0]);
      const clusters = [];
      for (const b of list) {
        const c = clusters.find((q) => q.some((a) => overlapS(a, b, 1.5)));
        if (c) c.push(b);
        else clusters.push([b]);
      }
      for (const c of clusters) {
        const width = c.reduce((a, b) => a + b.W, 0) + 0.3 * (c.length - 1);
        if (c.length > 1 && width > 2 * (L.island - 1.6)) {
          // 並べられない: s の向きに離す
          for (let i = 1; i < c.length; i++) {
            if (!overlapS(c[i - 1], c[i], 1.5)) continue;
            const need = span(c[i - 1])[1] + 1.5 - span(c[i])[0];
            c[i - 1].sBot -= need / 2;
            c[i].sBot += need / 2;
          }
          for (const b of c) b.tc = 0;
          continue;
        }
        c.sort((a, b) => a.tOsm - b.tOsm);
        let t = -width / 2;
        for (const b of c) {
          b.tc = t + b.W / 2;
          t += b.W + 0.3;
        }
        if (c.length === 1) {
          const lim = Math.max(0, L.island - c[0].W / 2 - 1.6);
          c[0].tc = Math.abs(c[0].tOsm) < 2.5 ? 0 : Math.max(-lim, Math.min(lim, c[0].tOsm));
        }
      }
      continue;
    }
    for (const side of [1, -1]) {
      const list = blocks.filter((b) => b.toPlatform && b.line === L.line && b.side === side).sort((a, b) => Math.abs(b.tOsm) - Math.abs(a.tOsm));
      const placed = [];
      for (const b of list) {
        let off = 0, moved = true;
        while (moved) {
          moved = false;
          for (const p of placed) {
            if (overlapS(p, b, 1.0) && off < p.off + p.W + 0.3 && p.off < off + b.W + 0.3) {
              off = p.off + p.W + 0.3;
              moved = true;
            }
          }
        }
        b.off = off;
        placed.push(b);
      }
      // 奥の壁: ホームドアからいちばん内側の階段まで 2.6 m の通り道
      const need = Math.max(0, ...placed.map((b) => b.off + b.W)) + LAYOUT.psd + 2.6;
      L.WT = Math.max(L.WT, Math.min(14, need));
    }
    for (const b of blocks.filter((q) => q.toPlatform && q.line === L.line)) b.tc = b.side * (L.WT - b.off - b.W / 2 - 0.05);
    void f;
  }
  for (const b of blocks) if (b.toPlatform) b.top = lines.find((q) => q.line === b.line).frame.at(b.sBot - b.dS * b.len, b.tc);
  // 同じ吹き抜けの重なり（OSM で 1 つの階段を 2 回描いたもの）は 1 つに
  for (let i = blocks.length - 1; i >= 0; i--) {
    const a = blocks[i];
    if (blocks.some((b, j) => j < i && b.lo === a.lo && b.hi === a.hi && b.dir[0] * a.dir[0] + b.dir[1] * a.dir[1] > 0.9 && Math.hypot(b.top[0] - a.top[0], b.top[1] - a.top[1]) < Math.max(a.W, b.W) / 2)) blocks.splice(i, 1);
  }
  // 平行に並んで重なる階段（ホームへ下りるもの以外。OSM で折り返しの階段を近くに描いたもの）は、横へ離す（壁を共有）
  for (let iter = 0; iter < 4; iter++) {
    let moved = false;
    for (let i = 0; i < blocks.length; i++) {
      for (let j = 0; j < i; j++) {
        const a = blocks[j], b = blocks[i];
        if (a.toPlatform && b.toPlatform) continue;
        if (Math.abs(a.dir[0] * b.dir[0] + a.dir[1] * b.dir[1]) < 0.9) continue;
        const v = [-a.dir[1], a.dir[0]], u = a.dir;
        const rel = [b.top[0] - a.top[0], b.top[1] - a.top[1]];
        const lat = rel[0] * v[0] + rel[1] * v[1];
        const need = (a.W + b.W) / 2 + 0.05 - Math.abs(lat);
        if (need <= 0) continue;
        // s の範囲が重なるか（a の局所の s で）
        const sb0 = rel[0] * u[0] + rel[1] * u[1], sb1 = sb0 + (b.dir[0] * u[0] + b.dir[1] * u[1]) * b.len;
        if (Math.max(sb0, sb1) < -0.5 || Math.min(sb0, sb1) > a.len + 0.5) continue;
        const sg = lat >= 0 ? 1 : -1, wa = a.toPlatform ? 0 : b.toPlatform ? 1 : 0.5, wb = 1 - wa;
        a.top = [a.top[0] - v[0] * sg * need * wa, a.top[1] - v[1] * sg * need * wa];
        b.top = [b.top[0] + v[0] * sg * need * wb, b.top[1] + v[1] * sg * need * wb];
        moved = true;
      }
    }
    if (!moved) break;
  }
  const finishBlock = (b) => {
    b.frame = localFrame(b.top, b.dir);
    b.foot = orientedRect(b.top, b.dir, -0.05, b.len, -b.W / 2, b.W / 2);
    b.bottom = b.frame.at(b.len, 0);
    let t = -b.W / 2 + 0.15;
    for (const ln of b.lanes) {
      ln.t0 = t;
      ln.t1 = t + ln.w;
      t = ln.t1 + LANE_GAP;
    }
  };
  blocks.forEach(finishBlock);

  // ---------------------------------------------------------------- 出入口
  const levelSet = [...new Set([-1, ...platformLevels, ...blocks.flatMap((b) => [b.lo, b.hi])])];
  const pitInfo = pits.map((e) => {
    // 吹き抜けの形（扉の側は扉の線まで: 扉の外の床と、吹き抜けの下の踊り場がすき間なくつながる）
    const d = entranceDoor(e), fe = entranceFrame(e), L2 = e.len / 2 + 0.05, W2 = e.wid / 2 + 0.05;
    const foot = [fe.at(-L2, -W2), fe.at(e.len / 2, -W2), fe.at(e.len / 2, W2), fe.at(-L2, W2)];
    // 着く階: 吹き抜けの e.level（なければ扉の床に近い階）
    let lv = e.level;
    if (lv == null || !levelSet.includes(lv)) {
      lv = levelSet[0];
      for (const l of levelSet) if (Math.abs(Y(l) - d.yb) < Math.abs(Y(lv) - d.yb)) lv = l;
    }
    const pad = orientedRect([d.x, d.z], [d.dx, d.dz], 0, PAD + 0.5, -d.dw - 0.6, d.dw + 0.6);
    return { e, d, foot, level: lv, pad };
  });
  // 扉が階の床より高い出入口（吹き抜けの階段で届かない深さ）: 扉の先に階段（block）
  for (const p of pitInfo) {
    const drop = p.d.yb - Y(p.level);
    if (drop < 0.08) continue;
    const st = stairRun(drop), W = Math.min(2 * p.d.dw + 0.3, 3.6), dir = [p.d.dx, p.d.dz];
    const b = { lo: p.level, hi: null, y0: p.d.yb, y1: Y(p.level), dir, W, len: st.run + 0.6, run: st.run, lanes: [{ kind: 'stairs', w: W - 0.3 }], top: [p.d.x, p.d.z], toPlatform: false, doorStep: p };
    finishBlock(b);
    blocks.push(b);
    p.step = b;
  }
  // ホームが地下 1 階の駅: 相対式のホームの幅を、吹き抜けと扉の先の階段まで広げる
  for (const p of pitInfo) {
    const L = lineAt(p.level);
    if (!L || L.island) continue;
    const pts = [...p.foot, ...(p.step ? p.step.foot : [])].map((q) => Math.abs(L.frame.local(...q)[1]));
    L.WT = Math.max(L.WT, Math.min(13, Math.max(...pts) + 0.3));
  }

  // ---------------------------------------------------------------- 各階の床
  const pitLevels = pitInfo.map((p) => p.level);
  const allLevels = [...new Set([...blocks.flatMap((b) => [b.lo, b.hi]).filter((l) => l != null), ...pitLevels, ...platformLevels])].filter((l) => l < 0).sort((a, b) => b - a);
  const spans = (b, l) => l >= b.lo && (b.hi == null ? l === b.lo : l <= b.hi);
  const pitThrough = (p, l) => Y(p.level) <= Y(l) + 0.01; // 出入口の吹き抜けがその階に着くか、通り抜ける
  const buildLevels = () => {
  const levels = new Map();
  for (const l of allLevels) {
    const parts = [], needed = [];
    const isPlat = platformLevels.has(l);
    const trackCuts = [];
    for (const L of lines.filter((q) => q.level === l)) {
      const f = L.frame;
      if (L.island) {
        parts.push(poly(rectPoly(f.at, -L.Lb, L.Lb, -L.island, L.island)));
        for (const sg of [1, -1]) trackCuts.push(poly(rectPoly(f.at, -L.Lb - 60, L.Lb + 60, L.island * sg, (L.island + 2.6) * sg)));
        needed.push(f.at(0, 0));
      } else {
        for (const sg of [1, -1]) {
          parts.push(poly(rectPoly(f.at, -L.Lb, L.Lb, L.P * sg, L.WT * sg)));
          needed.push(f.at(0, ((L.P + L.WT) / 2) * sg));
        }
        trackCuts.push(poly(rectPoly(f.at, -L.Lb - 60, L.Lb + 60, -L.P, L.P)));
      }
    }
    for (const p of osm.paths) {
      if (p.level !== l || !p.pts.some(near)) continue;
      for (let i = 0; i + 1 < p.pts.length; i++) parts.push(poly(segRect(p.pts[i], p.pts[i + 1], PATH_HALF)));
    }
    for (const a of osm.areas) {
      if (a.levels.length !== 1 || a.levels[0] !== l || (a.conveying && a.conveying !== 'no')) continue;
      if (!a.poly.some(near) || areaOf(a.poly) > 2500) continue;
      parts.push(poly(a.poly.slice(0, -1)));
    }
    // 階段の上と下の踊り場、出入口の扉の前（このかたまりは残す）
    for (const b of blocks) {
      if (b.hi === l && !b.doorStep) {
        parts.push(poly(orientedRect(b.top, b.dir, -PAD, 0.1, -b.W / 2 - 0.4, b.W / 2 + 0.4)));
        // 吹き抜けのまわりの通り道（吹き抜けが通路を横切っても、まわりを歩ける）
        if (!isPlat) parts.push(poly(orientedRect(b.top, b.dir, -PAD, b.len + 1.6, -b.W / 2 - 1.6, b.W / 2 + 1.6)));
        needed.push(b.frame.at(-PAD / 2, 0));
      }
      if (b.lo === l) {
        parts.push(poly(orientedRect(b.bottom, b.dir, -0.1, PAD, -b.W / 2 - 0.4, b.W / 2 + 0.4)));
        needed.push(b.frame.at(b.len + PAD / 2, 0));
      }
    }
    for (const p of pitInfo) {
      if (p.level !== l || p.step) continue;
      parts.push(poly(p.pad));
      needed.push([p.d.x + p.d.dx * 1.5, p.d.z + p.d.dz * 1.5]);
    }
    // 折り返しの踊り場: この階に下りてくる階段の下の踊り場と、この階から下りる階段の上の踊り場が近ければ、まとめて 1 つの広い踊り場に
    for (const a of blocks) {
      if (a.lo !== l || a.doorStep) continue;
      for (const b of blocks) {
        if (b === a || b.hi !== l || b.doorStep) continue;
        const pa = orientedRect(a.bottom, a.dir, -0.1, PAD, -a.W / 2 - 0.4, a.W / 2 + 0.4), pb = orientedRect(b.top, b.dir, -PAD, 0.1, -b.W / 2 - 0.4, b.W / 2 + 0.4);
        const ca = a.frame.at(a.len + PAD / 2, 0), cb = b.frame.at(-PAD / 2, 0);
        if (Math.hypot(ca[0] - cb[0], ca[1] - cb[1]) > 9) continue;
        parts.push(poly(convexHull([...pa, ...pb])));
      }
    }
    let raw = minus(unionAll(parts), trackCuts);
    // 踊り場・扉の前・ホームのないかたまりは捨てる
    raw = raw.filter((pg) => needed.some((q) => inMulti([pg], ...q)));
    const cuts = [...blocks.filter((b) => spans(b, l)).map((b) => poly(b.foot)), ...pitInfo.filter((p) => pitThrough(p, l)).map((p) => poly(p.foot))];
    const ceilCuts = [...blocks.filter((b) => b.hi != null && b.lo <= l && l < b.hi).map((b) => poly(b.foot)), ...pitInfo.filter((p) => pitThrough(p, l)).map((p) => poly(p.foot))];
    const lv = { level: l, y: Y(l), platform: isPlat, raw, needed, H: isPlat ? PLAT_H : OSM_HALL_H, links: 0 };
    lv.floor = minus(lv.raw, cuts);
    connectPieces(lv, trackCuts, cuts);
    widenNecks(lv, trackCuts, cuts);
    lv.ceiling = minus(lv.raw, ceilCuts);
    levels.set(l, lv);
  }
  return levels;
  };
  // 踊り場が床にない階段（ほかの階段・吹き抜けに重なって消えたもの）は除いて、組み立て直す
  // 車線ごとに、端のすぐ先（0.3 m と 1 m）が床の中か
  const padIn = (lv, b, top) => lv && b.lanes.every((ln) => {
    const t = (ln.t0 + ln.t1) / 2;
    return (top ? [-0.3, -1.0] : [b.len + 0.3, b.len + 1.0]).every((sv) => inMulti(lv.floor, ...b.frame.at(sv, t)));
  });
  let levels;
  const inFoot = (foot, q) => inMulti([[ring(foot)]], ...q);
  for (let iter = 0; iter < 10; iter++) {
    levels = buildLevels();
    let bad = blocks.find((b) => !b.doorStep && (!padIn(levels.get(b.hi), b, true) || !padIn(levels.get(b.lo), b, false)));
    if (!bad) {
      // 出入口の扉の前（扉の先の階段の下）を、階段の吹き抜けがふさいでいれば、その階段を除く（出入口の方が大事）
      for (const p of pitInfo) {
        const lv = levels.get(p.level);
        const pts = p.step ? [0.3, 1.0, 1.8].map((u) => p.step.frame.at(p.step.len + u, 0)) : [0.3, 1.0, 1.8].map((u) => [p.d.x + p.d.dx * u, p.d.z + p.d.dz * u]);
        if (lv && pts.every((q) => inMulti(lv.floor, ...q))) continue;
        bad = blocks.find((b) => !b.doorStep && pts.some((q) => inFoot(b.foot, q)));
        if (bad) break;
      }
    }
    if (!bad) break;
    blocks.splice(blocks.indexOf(bad), 1);
  }

  // ---------------------------------------------------------------- 改札（切符売り場の階から下りる階段の手前）
  const count = new Map();
  for (const l of pitLevels) count.set(l, (count.get(l) || 0) + 1);
  const ticket = [...count.entries()].filter(([l]) => !platformLevels.has(l)).sort((a, b) => b[1] - a[1] || b[0] - a[0])[0]?.[0] ?? (platformLevels.has(-1) ? null : -1);
  const gates = [];
  if (ticket != null && levels.has(ticket)) {
    const lv = levels.get(ticket);
    for (const b of blocks) {
      if (b.hi !== ticket || b.doorStep) continue;
      const c = b.frame.at(-GATE_BEFORE, 0), v = [b.frame.nx, b.frame.nz];
      if (!inMulti(lv.floor, ...c)) continue;
      const reach = (sg) => {
        let t = 0;
        while (t < 9 && inMulti(lv.floor, c[0] + v[0] * sg * (t + 0.15), c[1] + v[1] * sg * (t + 0.15))) t += 0.15;
        return t;
      };
      const tL = reach(-1), tR = reach(1);
      if (tL + tR < 2.4) continue;
      // 近くの改札（並んだ階段）とは 1 つに
      if (gates.some((g) => Math.hypot(g.c[0] - c[0], g.c[1] - c[1]) < 4 && g.frame.ax * b.dir[0] + g.frame.az * b.dir[1] > 0.9)) continue;
      const target = b.toPlatform ? b : blocks.find((q) => q.toPlatform);
      const Lt = target ? lines.find((q) => q.line === target.line) : lines[0];
      const side = target && target.side ? target.side : 1;
      gates.push({ c, frame: localFrame(c, b.dir), s: 0, t0: -tL, t1: tR, side: -1, line: Lt.line, dir: Lt.dirs.find((d) => d.side === side), block: b, lanes: Math.max(1, Math.min(6, Math.floor((tL + tR - 0.5) / 1.05))) });
    }
  }
  const hallY = ticket != null ? Y(ticket) : ym;
  return {
    layout: 'osm', station, ym: hallY, ground, Y, lines, blocks, pits: pits.slice(), pitInfo, levels, gates, ticket,
    closed: [], direct: [], corridors: [], openings: [], wells: [], stairs: [], rects: [], doorSteps: [], frame: lines[0].frame,
  };
}

// 間取りがつながっているか（床のかたまり・階段・出入口のつながり。どの出入口からも、どのホームにも行けるか）。
// 歩ける所を作らずに、かたまりの中の点で調べる（読み込みのときに全部の駅で調べられるくらい速い）
export function osmConnected(plan) {
  const parent = new Map();
  const find = (k) => {
    if (!parent.has(k)) parent.set(k, k);
    while (parent.get(k) !== k) k = parent.get(k);
    return k;
  };
  const join = (a, b) => {
    if (a != null && b != null) parent.set(find(a), find(b));
  };
  // 点の並びのうち、床のかたまりの中にある最初の点のかたまり
  const pieceAt = (l, list) => {
    const lv = plan.levels.get(l);
    if (!lv) return null;
    for (const q of list) {
      const i = lv.floor.findIndex((pg) => inMulti([pg], ...q));
      if (i >= 0) return `${l}:${i}`;
    }
    return null;
  };
  const along = (f, s0, s1) => [0, -0.6, 0.6].flatMap((t) => [s0, (s0 + s1) / 2, s1].map((s) => f.at(s, t)));
  for (const b of plan.blocks) {
    const bottom = pieceAt(b.lo, along(b.frame, b.len + 0.6, b.len + 2.4));
    if (bottom == null) return false;
    if (b.doorStep) join(`pit:${plan.pitInfo.indexOf(b.doorStep)}`, bottom);
    else {
      const top = pieceAt(b.hi, along(b.frame, -0.6, -2.4));
      if (top == null) return false;
      join(top, bottom);
    }
  }
  plan.pitInfo.forEach((p, i) => {
    if (p.step) return;
    const d = p.d, pts = [0.6, 1.5, 2.5].flatMap((u) => [0, -0.8, 0.8].map((v) => [d.x + d.dx * u + d.sx * v, d.z + d.dz * u + d.sz * v]));
    join(`pit:${i}`, pieceAt(p.level, pts) ?? `lost:${i}`);
  });
  if (!plan.pitInfo.length) return false;
  // どのホームの床も、どれかの出入口とつながる。どの出入口も、どれかのホームとつながる（出入口どうしは地上でつながる）
  const pitRoots = new Set(plan.pitInfo.map((p, i) => find(`pit:${i}`)));
  const platRoots = new Set();
  for (const L of plan.lines) {
    for (const t of L.island ? [0, L.island - 1, 1 - L.island] : [1, -1].map((sg) => ((L.P + L.WT) / 2) * sg)) {
      const seen = new Set();
      for (let s = -L.Lb + 2; s <= L.Lb - 2; s += 4) {
        const k = pieceAt(L.level, [L.frame.at(s, t)]);
        if (k != null) seen.add(find(k));
      }
      if (!seen.size || [...seen].some((r) => !pitRoots.has(r))) return false;
      for (const r of seen) platRoots.add(r);
    }
  }
  if ([...pitRoots].some((r) => !platRoots.has(r))) return false;
  return true;
}

// ばらばらの床のかたまり（吹き抜けで切れた所も）を、いちばん大きいかたまりに近いものから通路（幅 3.2 m）でつなぐ
// （地図の通路が途切れている所）。つないでも切れたままなら、次に近い組で
function connectPieces(lv, trackCuts, cuts) {
  const tried = new Set();
  for (let iter = 0; iter < 16 && lv.floor.length > 1; iter++) {
    const pieces = lv.floor, cands = [];
    for (let i = 0; i < pieces.length; i++) {
      for (let j = i + 1; j < pieces.length; j++) {
        const near = [];
        for (const a of pieces[i][0]) for (const b of pieces[j][0]) near.push({ d: Math.hypot(a[0] - b[0], a[1] - b[1]), a, b });
        near.sort((p, q) => p.d - q.d);
        cands.push(...near.slice(0, 3));
      }
    }
    cands.sort((p, q) => p.d - q.d);
    let done = false;
    for (const c of cands) {
      if (c.d > 40) break;
      const key = `${c.a}|${c.b}`;
      if (tried.has(key)) continue;
      tried.add(key);
      const raw = minus(clip('union', lv.raw, poly(segRect(c.a, c.b, PATH_HALF))), trackCuts), floor = minus(raw, cuts);
      if (floor.length < pieces.length) {
        lv.raw = raw;
        lv.floor = floor;
        lv.links++;
        done = true;
        break;
      }
    }
    if (!done) break;
  }
}

// 体の幅では通れない狭い所（床の形どうしのつなぎ目）: 床を 0.15 m の格子にして、壁から r より遠いマスのかたまりを数える。
// つながった床の中で、縮めたかたまりが分かれていれば、いちばん近い所を通路（幅 3.2 m）でつなぐ（多角形の演算はつなぐときだけ）
function widenNecks(lv, trackCuts, cuts, r = 0.32) {
  for (let iter = 0; iter < 6; iter++) {
    const g = rasterNecks(lv.floor, r);
    if (!g) return;
    const raw = minus(clip('union', lv.raw, poly(segRect(g.a, g.b, PATH_HALF))), trackCuts), floor = minus(raw, cuts);
    if (floor.length > lv.floor.length) return; // つなぐと切れる（吹き抜けを横切る）: やめる
    lv.raw = raw;
    lv.floor = floor;
    lv.links++;
  }
}

// 格子で、縮めると分かれる所の両側の点 { a, b }（なければ null）
function rasterNecks(mp, r, cell = 0.15) {
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (const pg of mp) for (const [x, z] of pg[0]) {
    x0 = Math.min(x0, x);
    z0 = Math.min(z0, z);
    x1 = Math.max(x1, x);
    z1 = Math.max(z1, z);
  }
  if (!Number.isFinite(x0)) return null;
  const nx = Math.ceil((x1 - x0) / cell) + 2, nz = Math.ceil((z1 - z0) / cell) + 2, N = nx * nz;
  if (N > 4e6) return null;
  const inside = new Uint8Array(N);
  const xs = [];
  for (let j = 0; j < nz; j++) {
    const zc = z0 + (j + 0.5) * cell;
    xs.length = 0;
    for (const pg of mp) {
      for (const rg of pg) {
        for (let i = 0; i + 1 < rg.length; i++) {
          const [ax, az] = rg[i], [bx, bz] = rg[i + 1];
          if ((az > zc) !== (bz > zc)) xs.push(ax + ((zc - az) / (bz - az)) * (bx - ax));
        }
      }
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const i0 = Math.max(0, Math.ceil((xs[k] - x0) / cell - 0.5)), i1 = Math.min(nx - 1, Math.floor((xs[k + 1] - x0) / cell - 0.5));
      for (let i = i0; i <= i1; i++) inside[j * nx + i] = 1;
    }
  }
  // 外のマスからの距離（チャンファー 3-4。単位はマス）
  const INF = 1e9, d = new Float32Array(N);
  for (let k = 0; k < N; k++) d[k] = inside[k] ? INF : 0;
  const a1 = 1, a2 = Math.SQRT2;
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
    const k = j * nx + i;
    if (!d[k]) continue;
    let v = d[k];
    if (i > 0) v = Math.min(v, d[k - 1] + a1);
    if (j > 0) {
      v = Math.min(v, d[k - nx] + a1);
      if (i > 0) v = Math.min(v, d[k - nx - 1] + a2);
      if (i + 1 < nx) v = Math.min(v, d[k - nx + 1] + a2);
    } else v = Math.min(v, a1);
    if (i === 0 || i + 1 === nx || j + 1 === nz) v = Math.min(v, a1);
    d[k] = v;
  }
  for (let j = nz - 1; j >= 0; j--) for (let i = nx - 1; i >= 0; i--) {
    const k = j * nx + i;
    if (!d[k]) continue;
    let v = d[k];
    if (i + 1 < nx) v = Math.min(v, d[k + 1] + a1);
    if (j + 1 < nz) {
      v = Math.min(v, d[k + nx] + a1);
      if (i + 1 < nx) v = Math.min(v, d[k + nx + 1] + a2);
      if (i > 0) v = Math.min(v, d[k + nx - 1] + a2);
    }
    d[k] = v;
  }
  const rc = r / cell;
  // かたまり: 床（inside）と、縮めた床（d >= rc）
  const label = (ok) => {
    const lab = new Int32Array(N).fill(-1), sizes = [];
    const stack = [];
    for (let k = 0; k < N; k++) {
      if (lab[k] >= 0 || !ok(k)) continue;
      const id = sizes.length;
      let n = 0;
      lab[k] = id;
      stack.push(k);
      while (stack.length) {
        const c = stack.pop();
        n++;
        const i = c % nx, j = (c - i) / nx;
        for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const ii = i + di, jj = j + dj;
          if (ii < 0 || jj < 0 || ii >= nx || jj >= nz) continue;
          const q = jj * nx + ii;
          if (lab[q] < 0 && ok(q)) {
            lab[q] = id;
            stack.push(q);
          }
        }
      }
      sizes.push(n);
    }
    return { lab, sizes };
  };
  const full = label((k) => inside[k] === 1), ero = label((k) => d[k] >= rc);
  const minCells = Math.ceil(0.4 / (cell * cell)); // 0.4 m² より小さい縮めたかたまりは数えない
  // 床のかたまりごとの、縮めたかたまり（大きいもの）
  const per = new Map();
  for (let k = 0; k < N; k++) {
    const e = ero.lab[k];
    if (e < 0 || ero.sizes[e] < minCells) continue;
    const f = full.lab[k];
    if (!per.has(f)) per.set(f, new Set());
    per.get(f).add(e);
  }
  for (const [f, set] of per) {
    if (set.size < 2) continue;
    // いちばん大きい縮めたかたまりから、床の中を幅優先で、ほかの縮めたかたまりに着くまで
    const main = [...set].reduce((a, b) => (ero.sizes[b] > ero.sizes[a] ? b : a));
    const from = new Int32Array(N).fill(-1), q = [];
    for (let k = 0; k < N; k++) if (ero.lab[k] === main) {
      from[k] = k;
      q.push(k);
    }
    for (let h = 0; h < q.length; h++) {
      const c = q[h], i = c % nx, j = (c - i) / nx;
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const ii = i + di, jj = j + dj;
        if (ii < 0 || jj < 0 || ii >= nx || jj >= nz) continue;
        const n2 = jj * nx + ii;
        if (from[n2] >= 0 || full.lab[n2] !== f) continue;
        from[n2] = from[c];
        const e = ero.lab[n2];
        if (e >= 0 && e !== main && set.has(e)) {
          const P = (k) => [x0 + ((k % nx) + 0.5) * cell, z0 + (Math.floor(k / nx) + 0.5) * cell];
          return { a: P(from[c]), b: P(n2) };
        }
        q.push(n2);
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------- 歩ける所
export function buildOsmStationNav(plan) {
  const nav = new NavLayer(plan.station.id, { cell: 6 });
  plan.psdWalls = [];
  const blockFeet = plan.blocks.map((b) => b.foot), pitFeet = plan.pitInfo.map((p) => p.foot);
  for (const [l, lv] of plan.levels) {
    for (const pg of lv.floor) {
      for (const tri of triangulate(pg)) {
        const c = [(tri[0][0] + tri[1][0] + tri[2][0]) / 3, (tri[0][1] + tri[1][1] + tri[2][1]) / 3];
        const pl = lv.platform ? platformAt(plan, l, c) : null;
        nav.addRegion(tri, lv.y, pl ? { kind: 'platform', level: l, line: pl.line, side: pl.side } : { kind: 'hall', level: l });
      }
    }
    // 壁: 床の縁（ホームの縁＝ホームドアの線と、階段・出入口の吹き抜けの縁を除く）
    for (const [a, b] of floorEdges(lv.floor, blockFeet, pitFeet)) {
      if (lv.platform && onPsd(plan, l, a, b)) continue;
      nav.addWall(a[0], a[1], b[0], b[1], lv.y - 0.2, lv.y + lv.H);
    }
    // 通り抜ける階段・吹き抜けのまわり（その階の高さだけ）
    for (const b of plan.blocks) {
      if (!(b.hi != null && l > b.lo && l < b.hi)) continue;
      const F = ring(b.foot);
      for (let i = 0; i + 1 < F.length; i++) nav.addWall(F[i][0], F[i][1], F[i + 1][0], F[i + 1][1], lv.y - 0.2, lv.y + lv.H);
    }
    for (const p of plan.pitInfo) {
      if (!(plan.Y(p.level) < lv.y - 0.01) || lv.y < p.d.yb + 2.0) continue; // 扉の所（扉が届かず、階の床に近い）は開ける
      const F = ring(p.foot);
      for (let i = 0; i + 1 < F.length; i++) nav.addWall(F[i][0], F[i][1], F[i + 1][0], F[i + 1][1], lv.y - 0.2, lv.y + lv.H);
    }
  }
  // ホームドア（扉の所は開け閉めする）
  for (const L of plan.lines) {
    const at = L.frame.at, yp = L.yp;
    for (const side of [1, -1]) {
      const tP = L.P * side;
      const wall = (s0, t0, s1, t1) => {
        const [a, b] = [at(s0, t0), at(s1, t1)];
        return nav.addWall(a[0], a[1], b[0], b[1], yp - 0.2, yp + PLAT_H);
      };
      let s = -L.Lb;
      for (const sd of L.doorsS) {
        const [a, b] = [sd - 0.8, sd + 0.8];
        wall(s, tP, a, tP);
        plan.psdWalls.push({ line: L.line, side, s: sd, wall: wall(a, tP, b, tP) });
        s = b;
      }
      wall(s, tP, L.Lb, tP);
    }
  }
  // 階段・エスカレーター
  for (const b of plan.blocks) addBlockNav(nav, b);
  // 改札
  for (const g of plan.gates) {
    const at = g.frame.at, lanes = osmGateLanes(g), y = plan.ym;
    let t = g.t0;
    for (const [a, b] of [...lanes, [g.t1, g.t1]]) {
      if (a - t > 0.02) {
        const [p, q] = [at(0, t), at(0, a)];
        nav.addWall(p[0], p[1], q[0], q[1], y - 0.2, y + 1.2, { gate: true });
      }
      t = b;
    }
    for (const [a, b] of lanes) {
      for (const tt of [a, b]) {
        const [p, q] = [at(-0.7, tt), at(0.7, tt)];
        nav.addWall(p[0], p[1], q[0], q[1], y - 0.2, y + 1.0, { gate: true });
      }
    }
  }
  // 地上の出入口の吹き抜け
  for (const e of plan.pits) addPitNav(nav, e, false);
  plan.nav = nav;
  return nav;
}

// ホームの階の点 c の線とホームの側（島式は近いホームドアの側）
function platformAt(plan, l, c) {
  let best = null;
  for (const L of plan.lines) {
    if (L.level !== l) continue;
    const [s, t] = L.frame.local(...c);
    const d = Math.max(0, Math.abs(s) - L.Lb) + Math.max(0, Math.abs(t) - (L.island || L.WT));
    if (!best || d < best.d) best = { d, L, t };
  }
  if (!best || best.d > 0.5) return null;
  return { line: best.L.line, side: best.t >= 0 ? 1 : -1 };
}

// 線分がホームドアの線の上か（ホームの縁。ホームドアの壁は別に作る）
function onPsd(plan, l, a, b) {
  for (const L of plan.lines) {
    if (L.level !== l) continue;
    const [sa, ta] = L.frame.local(...a), [sb, tb] = L.frame.local(...b);
    if (Math.abs(Math.abs(ta) - L.P) < 0.05 && Math.abs(Math.abs(tb) - L.P) < 0.05 && Math.sign(ta) === Math.sign(tb) && Math.max(Math.abs(sa), Math.abs(sb)) <= L.Lb + 0.05) return true;
  }
  return false;
}

// 改札の通路 [[t0, t1]...]（真ん中に n 本。幅 0.8 m・1.05 m おき）
export function osmGateLanes(g) {
  const n = g.lanes, pitch = 1.05, total = n * pitch + 0.25, start = (g.t0 + g.t1) / 2 - total / 2 + 0.25;
  return Array.from({ length: n }, (_, k) => [start + k * pitch, start + k * pitch + 0.8]);
}

// 多角形（穴あき）を三角形に
export function triangulate(pg) {
  const verts = [], holes = [];
  for (const p of pg[0].slice(0, -1)) verts.push(p[0], p[1]);
  for (const h of pg.slice(1)) {
    holes.push(verts.length / 2);
    for (const p of h.slice(0, -1)) verts.push(p[0], p[1]);
  }
  const idx = Earcut.triangulate(verts, holes, 2);
  const out = [];
  for (let i = 0; i < idx.length; i += 3) {
    const tri = [0, 1, 2].map((k) => [verts[idx[i + k] * 2], verts[idx[i + k] * 2 + 1]]);
    if (areaOf(tri) > 1e-4) out.push(tri);
  }
  return out;
}

// 床の縁の線分のうち、階段・出入口の吹き抜けの縁でないもの
export function floorEdges(mp, blockFeet, pitFeet) {
  const out = [];
  const feet = [...blockFeet, ...pitFeet].map(ring);
  const onFoot = (x, z) => feet.some((f) => onRingEdge(f, x, z, 0.06));
  for (const pg of mp) {
    for (const r of pg) {
      for (let i = 0; i + 1 < r.length; i++) {
        const a = r[i], b = r[i + 1];
        if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 0.02) continue;
        if (onFoot((a[0] + b[0]) / 2, (a[1] + b[1]) / 2)) continue;
        out.push([a, b]);
      }
    }
  }
  return out;
}

// 階段・エスカレーターの歩ける所と壁（横の壁は下の階の床から上の階の床 + 1.1 m、車線のあいだに手すり）
function addBlockNav(nav, b) {
  const at = b.frame.at, s0 = 0.3, drop = b.y0 - b.y1;
  const st = stairRun(drop);
  for (const ln of b.lanes) {
    const run = ln.kind === 'escalator' ? escalatorRun(drop) : st.run;
    const yf = ln.kind === 'escalator'
      ? (x, z) => escalatorHeight(b.frame.local(x, z)[0] - s0, run, b.y0, b.y1)
      : (x, z) => flightHeight(b.frame.local(x, z)[0] - s0, run, b.y0, b.y1, st.n, st.flights);
    const r = nav.addRegion(rectPoly(at, -0.05, b.len, ln.t0, ln.t1), yf, { kind: ln.kind, block: b, corridor: !!b.doorStep });
    if (ln.kind === 'escalator') r.conveyor = [-b.frame.ax * ESC_SPEED, -b.frame.az * ESC_SPEED]; // 上り
  }
  // 横の壁と車線のあいだの手すり
  const ts = [-b.W / 2, ...b.lanes.slice(1).map((ln, i) => (b.lanes[i].t1 + ln.t0) / 2), b.W / 2];
  ts.forEach((t, i) => {
    const edge = i === 0 || i === ts.length - 1;
    const [p, q] = [at(-0.05, t), at(b.len, t)];
    nav.addWall(p[0], p[1], q[0], q[1], b.y1 - 0.2, b.y0 + (edge ? 1.1 : 1.0));
  });
  // 上の階の、下りた先の端（吹き抜けの手すり。下の階の人の高さにかからない深い吹き抜けだけ）
  if (!b.doorStep && drop >= 2.2) {
    const [p, q] = [at(b.len, -b.W / 2), at(b.len, b.W / 2)];
    nav.addWall(p[0], p[1], q[0], q[1], b.y0 - 0.3, b.y0 + 1.1);
  }
}
