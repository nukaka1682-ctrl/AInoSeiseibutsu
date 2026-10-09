// 地面の覆い（土地被覆）: 建物と道路のあいだの地面が、石畳の広場か、中庭か、芝生か、木の下かを 1 m ごとに決める。
// - 公道・広場: 地籍（Parcellaire Express）のどの敷地にも入らない所（フランスの公道は地籍に載らない）
// - 敷地の中の地面: 中庭・車寄せ・駐車場など（敷地の中で、植物がない所）
// - 芝生・低い植物: IGN の赤外線航空写真（ORTHOIMAGERY.ORTHOPHOTOS.IRC。帯は近赤外・赤・緑）の
//   植生指数 NDVI = (近赤外 − 赤) / (近赤外 + 赤) が高く、LiDAR の地面からの高さが低い所
// - 木の下: 植物で、地面からの高さが高い所（樹冠）。下の地面は見えないので、周りの地面から推定する
// 結果は 1 m 格子の種類の配列で、ランレングス符号化して base64 の文字列にし、タイルのデータに入れる（encodeCover）。
import { ELEVATION_WMS } from './lidar.js';

export const COVER = { public: 0, private: 1, lawn: 2, trees: 3 };
// 読み込むときだけ使う種類: 並木道の灰色のコンクリートの舗石（焼き込んだデータには入らない。4 はランレングスの記号）
export const PAVED = 5;
export const COVER_RES = 1; // m
export const IRC_LAYER = 'ORTHOIMAGERY.ORTHOPHOTOS.IRC';
const NDVI_MIN = 0.12; // これより高ければ植物（赤外線写真の 8 bit 値から計算した NDVI）
const LOW_H = 1.5; // 地面からこれより低い植物は芝生・草（m）
const FILL = 4; // 樹冠の下は、これ以内（m）の周りの地面と同じ種類にする。それより奥は木の下の地面
const SAME = 4; // 符号: 「上の行と同じ」の連なり

// ---------------------------------------------------------------- ランレングス符号
// 行ごとに左から、(長さ, 記号) の連なりを可変長整数（LEB128）にして base64 にする。
// 記号は種類 0〜3 と「上の行と同じ」(4)。境界がほぼ同じ形で続く行は数個の連なりになる
export function encodeCover(data, cols, rows) {
  const bytes = [];
  const put = (v) => {
    while (v >= 128) {
      bytes.push((v & 127) | 128);
      v = Math.floor(v / 128);
    }
    bytes.push(v);
  };
  let sym = -1, len = 0;
  const flush = () => {
    if (len) put((len - 1) * 8 + sym);
  };
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      const s = r > 0 && data[i] === data[i - cols] ? SAME : data[i];
      if (s === sym) len++;
      else {
        flush();
        sym = s;
        len = 1;
      }
    }
  }
  flush();
  let bin = '';
  for (let i = 0; i < bytes.length; i += 8192) bin += String.fromCharCode(...bytes.slice(i, i + 8192));
  return { cols, rows, rle: btoa(bin) };
}

export function decodeCover({ cols, rows, rle }) {
  const bin = atob(rle);
  const data = new Uint8Array(cols * rows);
  let i = 0, p = 0;
  while (p < bin.length && i < data.length) {
    let v = 0, mul = 1, b;
    do {
      b = bin.charCodeAt(p++);
      v += (b & 127) * mul;
      mul *= 128;
    } while (b & 128);
    const sym = v % 8, len = Math.floor(v / 8) + 1;
    const end = Math.min(data.length, i + len);
    if (sym === SAME) for (; i < end; i++) data[i] = data[i - cols];
    else data.fill(sym, i, (i = end));
  }
  return { cols, rows, data };
}

// ---------------------------------------------------------------- 分類
// inParcel / inBuilding: 敷地・建物の格子（1 = 中）、ndvi: 植生指数、hag: 地面からの高さ（m）。どれも cols × rows（行 0 = 北）
export function classifyCover({ cols, rows, inParcel, inBuilding, ndvi, hag }) {
  const n = cols * rows;
  const out = new Uint8Array(n);
  const UNKNOWN = 255, CANOPY = 254;
  for (let i = 0; i < n; i++) {
    if (inBuilding[i]) out[i] = UNKNOWN;
    else if (ndvi[i] > NDVI_MIN) out[i] = hag[i] < LOW_H ? COVER.lawn : CANOPY;
    else out[i] = inParcel[i] ? COVER.private : COVER.public;
  }
  // 小さな斑点を消す（建物の外で、周り 8 マスの多数決。2 回）
  for (let pass = 0; pass < 2; pass++) majority(out, cols, rows);
  // 樹冠の下: 敷地の中は庭の地面（木の下の地面）。公道では周り FILL m 以内の地面から広げる（街路樹の下は歩道・広場、
  // 芝生の中の木の下は木の下の地面）。それより奥（河岸・運河沿いの林など）は木の下の地面
  for (let i = 0; i < n; i++) if (out[i] === CANOPY && inParcel[i]) out[i] = COVER.trees;
  spread(out, cols, rows, CANOPY, FILL, (v) => (v === COVER.lawn || v === COVER.trees ? COVER.trees : COVER.public));
  for (let i = 0; i < n; i++) if (out[i] === CANOPY) out[i] = COVER.trees;
  // 建物の中は見えない。壁の際で外の地面と同じ種類になるよう、外から広げて埋める
  spread(out, cols, rows, UNKNOWN, Infinity, (v) => v);
  for (let i = 0; i < n; i++) if (out[i] === UNKNOWN) out[i] = COVER.public;
  return out;
}

// 並木道（allées）: 公道の広い樹冠の下（焼くときは FILL m より奥を木の下の地面にする）は、実際は舗装のことが多い。
// 名前のわかる並木道は stampCover で舗石にする。残りは、木の下の地面のつながった塊のうち、周りのほとんどが公道で
// （芝生・敷地の中の地面に接していない）、細長い（境目から MAX_DEPTH m 以内に収まる）ものを舗石（PAVED）に変える。
// 芝生に囲まれた公園の木立・敷地の中の庭・広い林はそのまま。格子の端に接する塊は、隣のタイルの側が見えず、
// タイルの境目で片側だけ舗石になるので変えない。data を書き換えて返す
const ALLEE_MIN = 300, ALLEE_PUBLIC = 0.8, ALLEE_MAX_DEPTH = 25;
export function paveAllees({ cols, rows, data }) {
  const n = cols * rows, T = COVER.trees;
  // 木の下の地面のマスの、木の下でないマスからの距離（4 近傍のマス数）
  const depth = new Int32Array(n).fill(-1);
  let queue = [];
  for (let i = 0; i < n; i++) if (data[i] !== T) depth[i] = 0;
  const nb = (i, f) => {
    const c = i % cols;
    if (c > 0) f(i - 1);
    if (c < cols - 1) f(i + 1);
    if (i >= cols) f(i - cols);
    if (i < n - cols) f(i + cols);
  };
  for (let i = 0; i < n; i++) {
    if (data[i] !== T) continue;
    let edge = false;
    nb(i, (j) => {
      if (data[j] !== T) edge = true;
    });
    if (!edge) continue;
    depth[i] = 1;
    queue.push(i);
  }
  while (queue.length) {
    const next = [];
    for (const i of queue) {
      nb(i, (j) => {
        if (depth[j] >= 0) return;
        depth[j] = depth[i] + 1;
        next.push(j);
      });
    }
    queue = next;
  }
  // つながった塊ごとに、大きさ・周りの種類・いちばん奥の深さ・格子の端に接するかを数える
  const seen = new Uint8Array(n);
  for (let s = 0; s < n; s++) {
    if (data[s] !== T || seen[s]) continue;
    const cells = [s];
    seen[s] = 1;
    let pub = 0, other = 0, deep = 0, border = false;
    for (let k = 0; k < cells.length; k++) {
      const i = cells[k], c = i % cols;
      deep = Math.max(deep, depth[i]);
      if (c === 0 || c === cols - 1 || i < cols || i >= n - cols) border = true;
      nb(i, (j) => {
        if (data[j] === COVER.public || data[j] === PAVED) pub++;
        else if (data[j] !== T) other++;
        else if (!seen[j]) {
          seen[j] = 1;
          cells.push(j);
        }
      });
    }
    if (!border && cells.length >= ALLEE_MIN && pub >= ALLEE_PUBLIC * (pub + other) && deep <= ALLEE_MAX_DEPTH) for (const i of cells) data[i] = PAVED;
  }
  return { cols, rows, data };
}

// ---------------------------------------------------------------- 地図からの補正（読み込むとき）
// 地籍・写真ではわからないことを、OpenStreetMap の広場と道の名前から足す（coverStamps → stampCover）:
// - 広場（plaza の多角形）の中の敷地の地面は公道・広場にする（Place Saint-Sernin のように教会の敷地が広場にかかる所）。
//   芝生と木の下はそのまま残す（覆いのあるタイルでは広場の多角形を描かないので、広場の芝生と木の下が見える）。
//   ただし芝生と木の下が PLAZA_GREEN_MIN に足りない広場（キャピトル広場など）は、写真の斑点なので全部を公道にする
// - 並木道（名前が「Allées …」の道。Allées Jean Jaurès・François Verdier・Jules Guesde・Paul Sabatier など）の
//   中心線から 道幅の半分 + ALLEE_REACH m 以内の木の下と公道は舗石（利用者の写真: 灰色のコンクリートの舗石を全面に
//   敷いたプラタナスの並木道。樹冠の縁の下は焼くときに公道になっているので、そこも同じ舗石に）。芝生の帯・敷地と、
//   公園・林・墓地の多角形の中（Jardin des Plantes など並木道に面した公園の木立）はそのまま
// - 並木道の広場（PAVED_PLAZAS: François Verdier の並木道の、戦没者記念碑の前の広場）は、芝生のほかは全部舗石
// 種類の付け替えの表（元の種類 → 新しい種類。添字 0〜3 と PAVED）
const ALLEE_NAME = /^All[ée]es\s/i;
const ALLEE_REACH = 24; // 両側の車道の中心線から（Allées Jules Guesde は車道のあいだが約 50 m）
export const PAVED_PLAZAS = /^Esplanade (du 19 Août 1944|des Parachutistes)$/i;
const remap = (m) => Uint8Array.from([0, 1, 2, 3, 4, PAVED], (v) => (v in m ? m[v] : v));
const PLAZA_GREEN_MIN = 0.06;
const MAP_PLAZA = remap({ [COVER.private]: COVER.public });
const MAP_PLAZA_MINERAL = remap({ [COVER.private]: COVER.public, [COVER.lawn]: COVER.public, [COVER.trees]: COVER.public });
const MAP_PAVED_PLAZA = remap({ [COVER.public]: PAVED, [COVER.private]: PAVED, [COVER.trees]: PAVED });
const MAP_ALLEE = remap({ [COVER.public]: PAVED, [COVER.trees]: PAVED });

// parsed（world/parse.js の結果）から、覆いに描き込む多角形と線を集める（parsed ごとに 1 回）
const stampCache = new WeakMap();
export function coverStamps(parsed) {
  let s = stampCache.get(parsed);
  if (s) return s;
  s = [];
  for (const a of parsed.areas || []) {
    if (a.type !== 'plaza') continue;
    const paved = PAVED_PLAZAS.test(a.name || '');
    s.push({ rings: [a.outer, ...(a.holes || [])], bounds: ringBounds(a.outer, 0), map: paved ? MAP_PAVED_PLAZA : MAP_PLAZA, mineral: paved ? null : MAP_PLAZA_MINERAL, plaza: true });
  }
  for (const a of parsed.areas || []) {
    if (a.type === 'grass' || a.type === 'forest' || a.type === 'cemetery') s.push({ rings: [a.outer, ...(a.holes || [])], bounds: ringBounds(a.outer, 0), keepOut: true });
  }
  for (const r of parsed.roads || []) {
    if (r.tunnel || r.bridge || !ALLEE_NAME.test(r.name || '')) continue;
    const half = r.width / 2 + ALLEE_REACH;
    s.push({ line: r.pts, half, bounds: ringBounds(r.pts, half), map: MAP_ALLEE });
  }
  stampCache.set(parsed, s);
  return s;
}

function ringBounds(pts, pad) {
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
  for (const [x, z] of pts) {
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minZ = Math.min(minZ, z);
    maxZ = Math.max(maxZ, z);
  }
  return { minX: minX - pad, minZ: minZ - pad, maxX: maxX + pad, maxZ: maxZ + pad };
}

// 種類の格子 grid（rect: ローカル座標の範囲、行 0 = minZ）に stamps を描き込む。マスの中心が多角形の中（偶奇規則、
// 穴あり）・線から half 以内なら、種類を map で付け替える（多角形の中の芝生と木の下が PLAZA_GREEN_MIN に足りなければ
// mineral で）。keepOut の多角形の中は線では変えない。data を書き換えて返す。plazaMask（cols × rows）があれば広場の中を 255 にする
export function stampCover(grid, rect, stamps, plazaMask = null) {
  const { cols, rows, data } = grid;
  const sx = (rect.maxX - rect.minX) / cols, sz = (rect.maxZ - rect.minZ) / rows;
  const xs = [];
  // 多角形の中のマスごとに f(i)。行ごとに、マスの中心の高さで辺と交わる x を求め、組のあいだを塗る
  const eachInRings = (rings, r0, r1, f) => {
    for (let r = r0; r <= r1; r++) {
      const z = rect.minZ + (r + 0.5) * sz;
      xs.length = 0;
      for (const ring of rings) {
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
          const [ax, az] = ring[j], [bx, bz] = ring[i];
          if (az > z !== bz > z) xs.push(ax + ((z - az) / (bz - az)) * (bx - ax));
        }
      }
      xs.sort((p, q) => p - q);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const c0 = Math.max(0, Math.ceil((xs[k] - rect.minX) / sx - 0.5)), c1 = Math.min(cols - 1, Math.floor((xs[k + 1] - rect.minX) / sx - 0.5));
        for (let i = r * cols + c0; i <= r * cols + c1; i++) f(i);
      }
    }
  };
  const rowsOf = (b) => [Math.max(0, Math.floor((b.minZ - rect.minZ) / sz)), Math.min(rows - 1, Math.floor((b.maxZ - rect.minZ) / sz))];
  const hits = (b) => b.maxX > rect.minX && b.minX < rect.maxX && b.maxZ > rect.minZ && b.minZ < rect.maxZ;
  let keep = null;
  for (const st of stamps) {
    if (!st.keepOut || !hits(st.bounds)) continue;
    keep = keep || new Uint8Array(cols * rows);
    eachInRings(st.rings, ...rowsOf(st.bounds), (i) => (keep[i] = 1));
  }
  for (const st of stamps) {
    if (st.keepOut || !hits(st.bounds)) continue;
    const [r0, r1] = rowsOf(st.bounds);
    if (st.rings) {
      let map = st.map;
      if (st.mineral) {
        let all = 0, green = 0;
        eachInRings(st.rings, r0, r1, (i) => {
          all++;
          if (data[i] === COVER.lawn || data[i] === COVER.trees) green++;
        });
        if (green < PLAZA_GREEN_MIN * all) map = st.mineral;
      }
      eachInRings(st.rings, r0, r1, (i) => (data[i] = map[data[i]]));
      if (plazaMask && st.plaza) eachInRings(st.rings, r0, r1, (i) => (plazaMask[i] = 255));
    } else {
      const pts = st.line, h2 = st.half * st.half;
      for (let k = 0; k + 1 < pts.length; k++) {
        const [ax, az] = pts[k], [bx, bz] = pts[k + 1];
        const dx = bx - ax, dz = bz - az, L2 = dx * dx + dz * dz || 1;
        const ca = Math.max(0, Math.floor((Math.min(ax, bx) - st.half - rect.minX) / sx)), cb = Math.min(cols - 1, Math.floor((Math.max(ax, bx) + st.half - rect.minX) / sx));
        const ra = Math.max(r0, Math.floor((Math.min(az, bz) - st.half - rect.minZ) / sz)), rb = Math.min(r1, Math.floor((Math.max(az, bz) + st.half - rect.minZ) / sz));
        for (let r = ra; r <= rb; r++) {
          const z = rect.minZ + (r + 0.5) * sz;
          for (let c = ca; c <= cb; c++) {
            const x = rect.minX + (c + 0.5) * sx;
            const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / L2));
            const ex = ax + dx * t - x, ez = az + dz * t - z;
            const i = r * cols + c;
            if (ex * ex + ez * ez <= h2 && !(keep && keep[i])) data[i] = st.map[data[i]];
          }
        }
      }
    }
  }
  return grid;
}

// target のマスを、決まっているマス（0〜3）から 4 近傍で 1 マスずつ、最大 maxDist マスまで広げて埋める。
// 広げる値は as(元の値)
function spread(a, cols, rows, target, maxDist, as) {
  let front = [];
  for (let i = 0; i < a.length; i++) if (a[i] < 4) front.push(i);
  for (let d = 1; d <= maxDist && front.length; d++) {
    const next = [];
    for (const i of front) {
      const r = (i / cols) | 0, c = i - r * cols, v = as(a[i]);
      if (c > 0 && a[i - 1] === target) next.push(i - 1, v);
      if (c + 1 < cols && a[i + 1] === target) next.push(i + 1, v);
      if (r > 0 && a[i - cols] === target) next.push(i - cols, v);
      if (r + 1 < rows && a[i + cols] === target) next.push(i + cols, v);
    }
    // 同じ回の中では書き換えない（先に見つかった値が勝つ）
    front = [];
    for (let k = 0; k < next.length; k += 2) {
      if (a[next[k]] !== target) continue;
      a[next[k]] = next[k + 1];
      front.push(next[k]);
    }
  }
}

// 周り 8 マス（自分を含め 9 マス）の多数決。建物（255）は数えず、変えない。樹冠（254）も 1 つの種類として数える
function majority(a, cols, rows) {
  const src = a.slice();
  const count = new Uint8Array(256);
  for (let r = 1; r < rows - 1; r++) {
    for (let c = 1; c < cols - 1; c++) {
      const i = r * cols + c;
      if (src[i] === 255) continue;
      let best = src[i], bn = 0;
      const seen = [];
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          const v = src[i + dr * cols + dc];
          if (v === 255) continue;
          if (!count[v]) seen.push(v);
          count[v]++;
        }
      }
      for (const v of seen) {
        if (count[v] > bn || (count[v] === bn && v === src[i])) [best, bn] = [v, count[v]];
        count[v] = 0;
      }
      if (bn >= 5) a[i] = best;
    }
  }
}

// 赤外線写真（近赤外・赤・緑の RGB）→ NDVI
export function ndviFromIrc(rgb, n) {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const nir = rgb[i * 3], red = rgb[i * 3 + 1];
    out[i] = (nir - red) / (nir + red + 1);
  }
  return out;
}

// ---------------------------------------------------------------- 赤外線写真の取得
// PNG で取得して自前で展開する（Node にも JPEG の展開器はないため。DecompressionStream はブラウザと Node の両方にある）
export async function fetchIrc(bbox, cols, rows, attempts = 5) {
  const p = new URLSearchParams({
    SERVICE: 'WMS', VERSION: '1.3.0', REQUEST: 'GetMap', LAYERS: IRC_LAYER, STYLES: '', CRS: 'EPSG:4326',
    BBOX: `${bbox.s},${bbox.w},${bbox.n},${bbox.e}`, WIDTH: String(cols), HEIGHT: String(rows), FORMAT: 'image/png',
  });
  const url = `${ELEVATION_WMS}?${p}`;
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const img = await decodePng(new Uint8Array(await res.arrayBuffer()));
      if (img.width !== cols || img.height !== rows) throw new Error(`大きさが違います（${img.width}×${img.height}）`);
      return img.rgb;
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
    }
  }
  throw lastErr;
}

// 8 bit の PNG（グレー・RGB・パレット・RGBA、インターレースなし）→ RGB
export async function decodePng(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dv.getUint32(0) !== 0x89504e47) throw new Error('PNG ではありません');
  let width = 0, height = 0, depth = 0, type = 0, interlace = 0, palette = null;
  const idat = [];
  for (let p = 8; p + 8 <= bytes.length;) {
    const len = dv.getUint32(p), tag = String.fromCharCode(...bytes.subarray(p + 4, p + 8));
    const body = bytes.subarray(p + 8, p + 8 + len);
    if (tag === 'IHDR') {
      width = dv.getUint32(p + 8);
      height = dv.getUint32(p + 12);
      [depth, type, , , interlace] = body.subarray(8, 13);
    } else if (tag === 'PLTE') palette = body;
    else if (tag === 'IDAT') idat.push(body);
    else if (tag === 'IEND') break;
    p += 12 + len;
  }
  const ch = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[type];
  if (depth !== 8 || !ch || interlace) throw new Error(`対応していない PNG（深さ ${depth}・種類 ${type}）`);
  const raw = new Uint8Array(await new Response(new Blob(idat).stream().pipeThrough(new DecompressionStream('deflate'))).arrayBuffer());
  const stride = width * ch;
  const px = new Uint8Array(stride * height);
  for (let r = 0; r < height; r++) {
    const f = raw[r * (stride + 1)], src = raw.subarray(r * (stride + 1) + 1, (r + 1) * (stride + 1));
    const o = r * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? px[o + x - ch] : 0, b = r > 0 ? px[o - stride + x] : 0, c = x >= ch && r > 0 ? px[o - stride + x - ch] : 0;
      let v = src[x];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      px[o + x] = v;
    }
  }
  const rgb = new Uint8Array(width * height * 3);
  for (let i = 0; i < width * height; i++) {
    if (type === 2 || type === 6) {
      rgb[i * 3] = px[i * ch];
      rgb[i * 3 + 1] = px[i * ch + 1];
      rgb[i * 3 + 2] = px[i * ch + 2];
    } else if (type === 3) {
      const k = px[i] * 3;
      rgb[i * 3] = palette[k];
      rgb[i * 3 + 1] = palette[k + 1];
      rgb[i * 3 + 2] = palette[k + 2];
    } else rgb[i * 3] = rgb[i * 3 + 1] = rgb[i * 3 + 2] = px[i * ch];
  }
  return { width, height, rgb };
}
