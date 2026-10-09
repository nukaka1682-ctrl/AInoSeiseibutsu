import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { COVER, PAVED, classifyCover, coverStamps, decodeCover, decodePng, encodeCover, ndviFromIrc, paveAllees, stampCover } from '../../src/data/cover.js';
import { freeRects, mulberry32 } from '../../src/geo.js';

test('地面の覆い: ランレングス符号の往復（乱数・一様・縦じま・長い連なり）', () => {
  const rnd = mulberry32(7);
  const cases = [];
  // 乱数（ほとんど連なりにならない）
  cases.push([Uint8Array.from({ length: 37 * 23 }, () => Math.floor(rnd() * 4)), 37, 23]);
  // 一様（1 つの連なり。長さが可変長整数の 2 バイト以上になる）
  cases.push([new Uint8Array(500 * 497).fill(COVER.private), 500, 497]);
  // 縦じま（2 行目からは「上の行と同じ」になる）と、ゆがんだ境界
  const s = new Uint8Array(200 * 150);
  for (let r = 0; r < 150; r++) for (let c = 0; c < 200; c++) s[r * 200 + c] = c < 60 + (r >> 4) ? COVER.public : c < 140 ? COVER.lawn : COVER.trees;
  cases.push([s, 200, 150]);
  for (const [data, cols, rows] of cases) {
    const enc = encodeCover(data, cols, rows);
    assert.equal(typeof enc.rle, 'string');
    assert.deepEqual([enc.cols, enc.rows], [cols, rows]);
    const dec = decodeCover(JSON.parse(JSON.stringify(enc)));
    assert.deepEqual(dec.data, data);
  }
  // 縦じまは行ごとに数バイト（上の行と同じ所が多い）
  assert.ok(encodeCover(s, 200, 150).rle.length < 150 * 8, `${encodeCover(s, 200, 150).rle.length}`);
  assert.ok(encodeCover(new Uint8Array(500 * 497), 500, 497).rle.length <= 8);
});

test('地面の覆い: 公道・敷地の中・芝生・木の下に分け、建物の中は外と同じ種類で埋める', () => {
  const cols = 30, rows = 20, n = cols * rows;
  const inParcel = new Uint8Array(n), inBuilding = new Uint8Array(n);
  const ndvi = new Float32Array(n).fill(-0.2), hag = new Float32Array(n);
  const at = (c, r) => r * cols + c;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (c >= 10) inParcel[at(c, r)] = 1; // 左の 10 列は公道
      if (c >= 12 && c < 18 && r >= 2 && r < 8) inBuilding[at(c, r)] = 1; // 建物
      if (c >= 20 && c < 26 && r >= 2 && r < 8) ndvi[at(c, r)] = 0.5; // 芝生
      if (c >= 20 && c < 28 && r >= 11 && r < 19) {
        ndvi[at(c, r)] = 0.5; // 庭の木
        hag[at(c, r)] = 8;
      }
      if (c >= 1 && c < 4 && r >= 11 && r < 14) {
        ndvi[at(c, r)] = 0.5; // 街路樹（公道の上、小さい）
        hag[at(c, r)] = 10;
      }
    }
  }
  ndvi[at(5, 5)] = 0.5; // 1 マスだけの斑点は消える
  const out = classifyCover({ cols, rows, inParcel, inBuilding, ndvi, hag });
  assert.equal(out[at(0, 0)], COVER.public);
  assert.equal(out[at(5, 5)], COVER.public);
  assert.equal(out[at(11, 15)], COVER.private);
  assert.equal(out[at(22, 4)], COVER.lawn);
  assert.equal(out[at(23, 15)], COVER.trees);
  assert.equal(out[at(2, 12)], COVER.public); // 街路樹の下は歩道・広場
  // 建物の中は外の地面（ここでは敷地の中）と同じ。すべて 0〜3 に収まる
  assert.equal(out[at(15, 5)], COVER.private);
  assert.ok(out.every((v) => v <= 3));
});

test('地面の覆い: 公道の広い林の奥は木の下の地面になる', () => {
  const cols = 30, rows = 30, n = cols * rows;
  const ndvi = new Float32Array(n).fill(0.6), hag = new Float32Array(n).fill(12);
  for (let c = 0; c < cols; c++) {
    ndvi[c] = -0.2; // 北の端だけ道
    hag[c] = 0;
  }
  const out = classifyCover({ cols, rows, inParcel: new Uint8Array(n), inBuilding: new Uint8Array(n), ndvi, hag });
  assert.equal(out[2 * cols + 15], COVER.public); // 道のそばの街路樹の下
  assert.equal(out[20 * cols + 15], COVER.trees); // 林の奥
});

test('赤外線写真: PNG の展開（行ごとのフィルター 0〜4・RGB / RGBA / グレー / パレット）と NDVI', async () => {
  const png = (w, h, ch, px, type = ch === 4 ? 6 : 2, plte = null) => {
    // 行ごとにフィルターの種類を変えて符号化する
    const stride = w * ch, raw = new Uint8Array((stride + 1) * h);
    for (let r = 0; r < h; r++) {
      const f = r % 5;
      raw[r * (stride + 1)] = f;
      for (let x = 0; x < stride; x++) {
        const v = px[r * stride + x], a = x >= ch ? px[r * stride + x - ch] : 0, b = r > 0 ? px[(r - 1) * stride + x] : 0;
        const c = x >= ch && r > 0 ? px[(r - 1) * stride + x - ch] : 0;
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        const pred = [0, a, b, (a + b) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? b : c][f];
        raw[r * (stride + 1) + 1 + x] = (v - pred) & 255;
      }
    }
    const chunk = (t, d) => {
      const b = Buffer.alloc(12 + d.length);
      b.writeUInt32BE(d.length, 0);
      b.write(t, 4);
      Buffer.from(d).copy(b, 8);
      return b; // CRC は読まない
    };
    const ih = Buffer.alloc(13);
    ih.writeUInt32BE(w, 0);
    ih.writeUInt32BE(h, 4);
    ih[8] = 8;
    ih[9] = type;
    const pl = plte ? [chunk('PLTE', plte)] : [];
    return new Uint8Array(Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ih), ...pl, chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
  };
  const rnd = mulberry32(3);
  for (const ch of [3, 4]) {
    const w = 13, h = 11;
    const px = Uint8Array.from({ length: w * h * ch }, () => Math.floor(rnd() * 256));
    const img = await decodePng(png(w, h, ch, px));
    assert.deepEqual([img.width, img.height], [w, h]);
    for (let i = 0; i < w * h; i++) for (let k = 0; k < 3; k++) assert.equal(img.rgb[i * 3 + k], px[i * ch + k]);
  }
  {
    // グレー（3 色とも同じ値）とパレット（番号 → 色）
    const w = 9, h = 7;
    const px = Uint8Array.from({ length: w * h }, () => Math.floor(rnd() * 16));
    const grey = await decodePng(png(w, h, 1, px, 0));
    for (let i = 0; i < w * h; i++) assert.deepEqual([...grey.rgb.subarray(i * 3, i * 3 + 3)], [px[i], px[i], px[i]]);
    const plte = Uint8Array.from({ length: 16 * 3 }, (_, k) => (k * 37) & 255);
    const pal = await decodePng(png(w, h, 1, px, 3, plte));
    for (let i = 0; i < w * h; i++) assert.deepEqual([...pal.rgb.subarray(i * 3, i * 3 + 3)], [...plte.subarray(px[i] * 3, px[i] * 3 + 3)]);
  }
  // 近赤外が強い（植物）ほど高い
  const nd = ndviFromIrc(Uint8Array.from([200, 50, 80, 60, 120, 120]), 2);
  assert.ok(nd[0] > 0.5 && nd[1] < 0);
});

test('地面の覆い: 公道に囲まれた細長い樹冠の下（並木道）は舗装、芝生の中の木立・広い林はそのまま', () => {
  const cols = 120, rows = 120, n = cols * rows;
  const data = new Uint8Array(n).fill(COVER.public);
  const fill = (c0, r0, c1, r1, v) => {
    for (let r = r0; r < r1; r++) for (let c = c0; c < c1; c++) data[r * cols + c] = v;
  };
  fill(5, 5, 35, 115, COVER.trees); // 並木道: 幅 30 m・長さ 110 m、周りは公道
  fill(45, 5, 85, 45, COVER.lawn); // 公園: 芝生の中の木立
  fill(55, 15, 75, 35, COVER.trees);
  fill(45, 55, 115, 115, COVER.trees); // 広い林（奥が深い）
  fill(90, 0, 110, 50, COVER.trees); // 格子の端に接する細長い樹冠（隣のタイルが見えないので変えない）
  const out = paveAllees({ cols, rows, data: Uint8Array.from(data) }).data;
  assert.equal(out[60 * cols + 20], PAVED);
  assert.equal(out[25 * cols + 65], COVER.trees);
  assert.equal(out[85 * cols + 80], COVER.trees);
  assert.equal(out[20 * cols + 100], COVER.trees);
  assert.equal(out[2 * cols + 2], COVER.public);
});

test('地面の覆い: 広場の中の敷地は公道（芝生・木の下は残す）、名前が「Allées」の道の近くの木の下・公道と並木道の広場は舗石', () => {
  const cols = 100, rows = 100, rect = { minX: -50, minZ: 200, maxX: 50, maxZ: 300 };
  const grid = { cols, rows, data: new Uint8Array(cols * rows).fill(COVER.private) };
  const at = (x, z) => grid.data[Math.floor(z - rect.minZ) * cols + Math.floor(x - rect.minX)];
  const set = (x0, z0, x1, z1, v) => {
    for (let z = z0; z < z1; z++) for (let x = x0; x < x1; x++) grid.data[(z - rect.minZ) * cols + (x - rect.minX)] = v;
  };
  set(-40, 210, -30, 220, COVER.lawn);
  set(-30, 210, -20, 220, COVER.trees);
  set(-50, 250, 50, 300, COVER.trees); // 並木道の樹冠
  set(-10, 250, 10, 256, COVER.private);
  set(-50, 280, 50, 284, COVER.lawn); // 真ん中の芝生の帯
  set(20, 270, 21, 271, COVER.public); // 樹冠の縁の下の公道
  set(20, 290, 21, 291, COVER.private);
  const sq = (x, z, s) => [[x, z], [x + s, z], [x + s, z + s], [x, z + s]];
  const parsed = {
    areas: [
      { type: 'plaza', name: 'Place X', outer: [[-45, 205], [25, 205], [25, 250], [-45, 250]], holes: [sq(5, 225, 10)] },
      { type: 'plaza', name: 'Esplanade du 19 Août 1944', outer: sq(30, 205, 15), holes: [] },
      { type: 'grass', name: '', outer: sq(30, 230, 15), holes: [] },
      { type: 'grass', name: 'Jardin', outer: sq(-50, 286, 10), holes: [] }, // 並木道に面した公園
      { type: 'plaza', name: 'Place du Capitole', outer: sq(-10, 255, 4), holes: [] },
    ],
    roads: [
      { type: 'secondary', name: 'Allées Forain François Verdier', width: 6, pts: [[-60, 282], [60, 282]] },
      { type: 'residential', name: 'Allée des Tilleuls', width: 4, pts: [[-60, 262], [60, 262]] },
    ],
  };
  const stamps = coverStamps(parsed);
  assert.equal(stamps, coverStamps(parsed)); // parsed ごとに 1 回
  assert.equal(stamps.length, 6);
  stampCover(grid, rect, stamps);
  assert.equal(at(0, 215), COVER.public); // 広場の中の敷地
  assert.equal(at(-35, 215), COVER.lawn);
  assert.equal(at(-25, 215), COVER.trees);
  assert.equal(at(10, 230), COVER.private); // 広場の穴
  assert.equal(at(-48, 215), COVER.private); // 広場の外
  assert.equal(at(40, 240), COVER.private); // 緑地は変えない
  assert.equal(at(40, 210), PAVED); // 並木道の広場
  assert.equal(at(0, 290), PAVED); // 中心線から 3 + 16 m 以内の木の下
  assert.equal(at(0, 282), COVER.lawn); // 芝生の帯はそのまま
  assert.equal(at(20, 270), PAVED);
  assert.equal(at(20, 290), COVER.private);
  assert.equal(at(-45, 290), COVER.trees); // 公園の中
  assert.equal(at(0, 255), COVER.private); // 並木道の近くでも敷地はそのまま
  assert.equal(at(0, 262), PAVED); // 中心線から 20 m（単数の「Allée」の道は並木道にしない）
  // 芝生と木の下の少ない広場は、斑点も公道に
  const g2 = { cols, rows, data: new Uint8Array(cols * rows).fill(COVER.public) };
  g2.data[25 * cols + 5] = COVER.lawn; // (-45, 225): Place X の中の 1 マス
  g2.data[56 * cols + 41] = COVER.lawn; // (-9, 256): 芝生だけの小さな広場の中（芝生が多いのでそのまま）
  stampCover(g2, rect, stamps);
  assert.equal(g2.data[25 * cols + 5], COVER.public);
  assert.equal(g2.data[56 * cols + 41], COVER.lawn);
});

test('矩形から矩形を除いた残り（地面の覆いのない所にだけ緑地を描く）', () => {
  const area = (rs) => rs.reduce((s, r) => s + (r.maxX - r.minX) * (r.maxZ - r.minZ), 0);
  const clip = { minX: -120, minZ: -120, maxX: 620, maxZ: 620 };
  assert.deepEqual(freeRects(clip, []), [clip]);
  // 覆いのブロック 2 つ（0..500 × 0..250 と 0..500 × 250..500）: 残りは周りの 120 m の帯
  const blocks = [{ minX: 0, minZ: 0, maxX: 500, maxZ: 250 }, { minX: 0, minZ: 250, maxX: 500, maxZ: 500 }];
  const free = freeRects(clip, blocks);
  assert.equal(area(free), 740 * 740 - 500 * 500);
  for (const r of free) for (const b of blocks) assert.ok(r.maxX <= b.minX || r.minX >= b.maxX || r.maxZ <= b.minZ || r.minZ >= b.maxZ);
  // 範囲全体が覆いの中なら何も残らない
  assert.deepEqual(freeRects({ minX: 10, minZ: 10, maxX: 400, maxZ: 200 }, blocks), []);
});

test('地面: 覆いのあるタイルでも運動場は緑に残し、旧市街の広場はばら色の石畳、Place Olivier は赤い黄土色', async () => {
  const THREE = await import('three');
  const { buildGroundDetail, createGroundMaterials, plazaSurface } = await import('../../src/world/ground.js');
  const tex = new Proxy({}, { get: () => new THREE.Texture() });
  const mats = createGroundMaterials(tex);
  const sq = (x, z, s) => [[x, z], [x + s, z], [x + s, z + s], [x, z + s]];
  const mk = (type, x, z, name = '') => ({ type, name, outer: sq(x, z, 40), holes: [], bounds: { minX: x, minZ: z, maxX: x + 40, maxZ: z + 40 }, tags: {} });
  const parsed = { areas: [mk('pitch', 10, 10), mk('grass', 100, 100), mk('park', 300, 300), mk('plaza', 200, 200), mk('plaza', 250, 300, 'Place Olivier')], roads: [], rails: [] };
  const clip = { minX: 0, minZ: 0, maxX: 500, maxZ: 500 };
  const tris = (g) => {
    let t = 0;
    g.traverse((o) => { if (o.isMesh) t += (o.geometry.index ? o.geometry.index.count : o.geometry.attributes.position.count) / 3; });
    return t;
  };
  const all = tris(buildGroundDetail(parsed, clip, mats, () => 0).group);
  const cov = tris(buildGroundDetail(parsed, clip, mats, () => 0, { covered: [clip] }).group);
  assert.ok(all >= 10 && cov === 4, `${all} ${cov}`); // 覆いの中は運動場と Place Olivier（2 枚ずつの三角形）だけ
  // 広場の舗装
  const old = (x) => x < 0;
  assert.notDeepEqual(plazaSurface(mk('plaza', -50, 0), old).color, plazaSurface(mk('plaza', 50, 0), old).color);
  const olivier = plazaSurface(mk('plaza', 50, 0, 'Place Olivier'), old);
  assert.equal(olivier.tex, 'gravel');
  assert.ok(olivier.color[0] > olivier.color[1] && olivier.color[1] > olivier.color[2]);
});

test('地面の覆い: 重みのテクスチャ（舗石は R だけ半分の値）と、混ざった値からの割合の戻し方', async () => {
  const { coverTexture, PAVED_LEVEL } = await import('../../src/world/cover.js');
  const t = coverTexture({ cols: 4, rows: 1, data: Uint8Array.from([COVER.public, COVER.lawn, COVER.trees, PAVED]) });
  assert.deepEqual([...t.image.data], [255, 0, 0, 0, 0, 0, 255, 0, 0, 0, 0, 255, PAVED_LEVEL, 0, 0, 0]);
  // 公道 1 : 舗石 2 : 木の下 1 の平均（線形補間・ミップマップと同じ）から、シェーダーと同じ式で割合を戻す
  const px = [0, 3, 3, 2].map((k) => [...t.image.data.slice(k * 4, k * 4 + 4)].map((v) => v / 255));
  const w = [0, 1, 2, 3].map((c) => px.reduce((s, p) => s + p[c], 0) / 4);
  const pav = (1 - w.reduce((s, v) => s + v, 0)) * (255 / 127);
  assert.ok(Math.abs(pav - 0.5) < 0.01 && Math.abs(w[0] - pav * (128 / 255) - 0.25) < 0.01 && Math.abs(w[3] - 0.25) < 0.01);
});
