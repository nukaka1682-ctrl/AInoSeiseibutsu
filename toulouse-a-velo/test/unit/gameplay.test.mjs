// 遊びと UI の DOM に依らない部分: コースとメダル・記録・スミレの置き場所・手帳の方角・設定の保存
import test from 'node:test';
import assert from 'node:assert/strict';
import { TOURS, availableTours, loadRecord, medalFor, medalTimes, nextMedal, pickTour, saveRecord, splitDelta, tourLength } from '../../src/game/tours.js';
import { beamFade, planViolets } from '../../src/game/violets.js';
import { TravelStats, bearingLabel, stampDiscovery } from '../../src/ui/carnet.js';
import { photoFileName } from '../../src/game/photomode.js';
import { applySettings, collectSettings, urlSkips } from '../../src/game/settings.js';
import { CameraRig } from '../../src/game/camera.js';
import * as THREE from 'three';

// localStorage の代わり（JSON で出し入れする）
function memoryStore(init = {}) {
  const m = new Map(Object.entries(init).map(([k, v]) => [k, JSON.stringify(v)]));
  return {
    get: (k, d) => (m.has(k) ? JSON.parse(m.get(k)) : d),
    set: (k, v) => m.set(k, JSON.stringify(v)),
    raw: m,
  };
}

const lmAt = (id, x, z) => ({ id, x, z, approach: { x, z } });
const allLandmarks = () => [...new Set(TOURS.flatMap((t) => t.route))].map((id, i) => lmAt(id, i * 100, 0));

test('availableTours: 名所が欠けたコースは出ない', () => {
  const all = allLandmarks();
  assert.deepEqual(availableTours(all).map((t) => t.id), TOURS.map((t) => t.id));
  const noBazacle = all.filter((l) => l.id !== 'bazacle');
  const ids = availableTours(noBazacle).map((t) => t.id);
  assert.ok(!ids.includes('grand'));
  assert.ok(ids.includes('classique') && ids.includes('garonne'));
});

test('pickTour: 走れないコースは classique に、classique が欠けていればあるものだけ（3 か所以上）', () => {
  const all = allLandmarks();
  const a = pickTour(all, 'garonne');
  assert.equal(a.tour.id, 'garonne');
  assert.equal(a.fellBack, false);
  assert.equal(a.list[0].id, 'saint-pierre');
  const noBazacle = all.filter((l) => l.id !== 'bazacle');
  const b = pickTour(noBazacle, 'grand');
  assert.equal(b.tour.id, 'classique');
  assert.equal(b.fellBack, true);
  // 旧版と同じ: classique の名所が一部しかなくても 3 か所以上あれば走れる
  const few = all.filter((l) => ['place-capitole', 'saint-sernin', 'jacobins'].includes(l.id));
  const c = pickTour(few, 'classique');
  assert.equal(c.tour.id, 'classique');
  assert.equal(c.fellBack, false);
  assert.deepEqual(c.list.map((l) => l.id), ['place-capitole', 'saint-sernin', 'jacobins', 'place-capitole']);
  assert.equal(pickTour(few.slice(0, 1), 'classique').tour, null);
});

test('tourLength: ルートの長さの合計、引けない区間は直線の 1.3 倍', () => {
  const list = [lmAt('a', 0, 0), lmAt('b', 100, 0), lmAt('c', 100, 100)];
  const route = (ax, az, bx, bz) => (bx === 100 && bz === 0 ? [[ax, az], [50, 50], [bx, bz]] : null);
  const len = tourLength(list, route);
  assert.ok(Math.abs(len - (2 * Math.hypot(50, 50) + 130)) < 1e-9, `len=${len}`);
});

test('medalTimes・medalFor・nextMedal の境目', () => {
  const t = medalTimes(7500);
  assert.equal(t.gold, 1000);
  assert.ok(Math.abs(t.silver - 7500 / 6.2) < 1e-9);
  assert.equal(t.bronze, 7500 / 4.8);
  assert.equal(medalFor(1000, t), 'gold');
  assert.equal(medalFor(1000.01, t), 'silver');
  assert.equal(medalFor(t.silver, t), 'silver');
  assert.equal(medalFor(t.bronze, t), 'bronze');
  assert.equal(medalFor(t.bronze + 0.01, t), null);
  assert.equal(nextMedal(900, t), null);
  assert.deepEqual(nextMedal(1100, t), { medal: 'gold', seconds: 100 });
  assert.equal(nextMedal(t.bronze + 10, t).medal, 'bronze');
});

test('loadRecord: classique は旧版の鍵（数値だけ）も読む', () => {
  const s = memoryStore({ 'tav-best-centre': 321.5 });
  assert.deepEqual(loadRecord(s, 'centre', 'classique'), { best: 321.5, splits: null, medal: null });
  assert.equal(loadRecord(s, 'centre', 'garonne'), null);
  assert.equal(loadRecord(s, 'toulouse', 'classique'), null);
});

test('saveRecord: 遅い時間では best を上書きしない・classique は旧版の鍵にも書く', () => {
  const s = memoryStore();
  const r1 = saveRecord(s, 'centre', 'classique', 300, [100, 200, 300], 'silver');
  assert.equal(r1.isBest, true);
  assert.equal(s.get('tav-best-centre'), 300);
  const r2 = saveRecord(s, 'centre', 'classique', 350, [90, 210, 350], 'bronze');
  assert.equal(r2.isBest, false);
  assert.deepEqual(loadRecord(s, 'centre', 'classique'), { best: 300, splits: [100, 200, 300], medal: 'silver' });
  assert.equal(s.get('tav-best-centre'), 300);
  const r3 = saveRecord(s, 'centre', 'garonne', 500, [250, 500], null);
  assert.equal(r3.isBest, true);
  assert.equal(s.get('tav-tour-centre-garonne').best, 500);
  assert.equal(s.get('tav-best-centre'), 300); // 別のコースは旧版の鍵に書かない
});

test('splitDelta: 自己ベストの同じチェックポイントとの差', () => {
  const rec = { best: 300, splits: [100, 200, 300] };
  assert.equal(splitDelta(rec, 1, 195), -5);
  assert.equal(splitDelta(rec, 0, 103.5), 3.5);
  assert.equal(splitDelta(rec, 5, 10), null);
  assert.equal(splitDelta(null, 0, 10), null);
  assert.equal(splitDelta({ best: 300, splits: null }, 0, 10), null);
});

// 格子状の道（50 m ごと）の上の最も近い点。川（x < -400）の点は null
const gridRoad = (x, z) => {
  if (x < -400) return null;
  const gx = Math.round(x / 50) * 50, gz = Math.round(z / 50) * 50;
  return Math.abs(x - gx) < Math.abs(z - gz) ? { x: gx, z } : { x, z: gz };
};
const lms = [lmAt('capitole', 0, 0), lmAt('saint-sernin', 0, -500), lmAt('daurade', -380, 0)];

test('planViolets: 同じ入力で同じ結果・名所から 35 m より遠い・花どうし 25 m より遠い', () => {
  const a = planViolets(lms, gridRoad);
  const b = planViolets(lms, gridRoad);
  assert.deepEqual(a, b);
  assert.ok(a.length >= 6, `花 ${a.length}`);
  assert.ok(a.length <= 9);
  for (const v of a) {
    const lm = lms.find((l) => l.id === v.lm);
    assert.ok(Math.hypot(v.x - lm.approach.x, v.z - lm.approach.z) > 35, v.id);
    assert.ok(v.id.startsWith(`${v.lm}:`));
    for (const w of a) if (w !== v) assert.ok(Math.hypot(v.x - w.x, v.z - w.z) > 25, `${v.id} と ${w.id}`);
  }
  assert.equal(new Set(a.map((v) => v.id)).size, a.length);
});

test('planViolets: nearestRideable が null を返す点は使わない', () => {
  const calls = [];
  const out = planViolets(lms, (x, z) => {
    calls.push([x, z]);
    return x < -400 ? null : gridRoad(x, z);
  });
  assert.ok(calls.some(([x]) => x < -400), '川の上の点も試した');
  for (const v of out) assert.ok(v.x >= -400, v.id);
  assert.deepEqual(planViolets(lms, () => null), []);
});

test('bearingLabel: 8 方位（x = 東、z = 南）と距離', () => {
  const cases = [[0, -1, '北'], [1, -1, '北東'], [1, 0, '東'], [1, 1, '南東'], [0, 1, '南'], [-1, 1, '南西'], [-1, 0, '西'], [-1, -1, '北西']];
  for (const [dx, dz, dir] of cases) assert.equal(bearingLabel(dx * 1200, dz * 1200).split('へ')[0], dir, `${dx}, ${dz}`);
  assert.equal(bearingLabel(848.5, -848.5), '北東へ 約 1.2 km');
  assert.equal(bearingLabel(0, 347), '南へ 約 350 m');
  assert.equal(bearingLabel(-20, -400), '北へ 約 400 m'); // 北から 3° ずれても北
});

test('TravelStats: odometer の差を足し、5 秒ごとに保存する・発見の日付', () => {
  const s = memoryStore({ 'tav-stats': { distance: 1000, time: 60, topSpeed: 30 } });
  const ts = new TravelStats(s);
  const bike = { odometer: 0, speed: 5, topSpeed: 20 };
  ts.reset(bike);
  for (let i = 0; i < 60; i++) {
    bike.odometer += 5 / 60;
    ts.tick(1 / 60, bike);
  }
  assert.ok(Math.abs(ts.data.distance - 1005) < 1e-6);
  assert.ok(Math.abs(ts.data.time - 61) < 1e-6);
  assert.equal(s.get('tav-stats').distance, 1000); // まだ 5 秒たっていない
  bike.topSpeed = 35;
  for (let i = 0; i < 300; i++) ts.tick(1 / 60, bike);
  assert.equal(s.get('tav-stats').topSpeed, 35);
  stampDiscovery(s, 'capitole', new Date('2026-05-01T10:00:00Z'));
  stampDiscovery(s, 'capitole', new Date('2026-06-01T10:00:00Z')); // 2 回目は上書きしない
  assert.equal(s.get('tav-discovered-at').capitole, '2026-05-01T10:00:00.000Z');
});

test('collectSettings: チェックボックス・選択・エリアとモードを集め、opt-refresh は保存しない', () => {
  const els = [
    { id: 'opt-shadows', type: 'checkbox', checked: false },
    { id: 'opt-refresh', type: 'checkbox', checked: true },
    { id: 'opt-time', type: 'select-one', value: 'soir' }, // 別の作業が足す項目も id で扱う
    { id: 'opt-tour', type: 'select-one', value: 'garonne' },
    { name: 'area', type: 'radio', value: 'toulouse', checked: false },
    { name: 'area', type: 'radio', value: 'centre', checked: true },
    { name: 'mode', type: 'radio', value: 'tour', checked: true },
    { id: 'other', type: 'checkbox', checked: true },
  ];
  assert.deepEqual(collectSettings(els), { 'opt-shadows': false, 'opt-time': 'soir', 'opt-tour': 'garonne', 'radio:area': 'centre', 'radio:mode': 'tour' });
});

test('applySettings: 保存した値を戻す・URL で指定した項目は URL を優先・opt-refresh は戻さない', () => {
  const els = () => [
    { id: 'opt-shadows', type: 'checkbox', checked: true },
    { id: 'opt-refresh', type: 'checkbox', checked: false },
    { id: 'opt-tour', type: 'select-one', value: 'classique', options: [{ value: 'classique' }, { value: 'garonne' }] },
    { name: 'area', type: 'radio', value: 'toulouse', checked: true },
    { name: 'area', type: 'radio', value: 'centre', checked: false },
    { name: 'mode', type: 'radio', value: 'free', checked: true },
    { name: 'mode', type: 'radio', value: 'tour', checked: false },
  ];
  const saved = { 'opt-shadows': false, 'opt-refresh': true, 'opt-tour': 'garonne', 'radio:area': 'centre', 'radio:mode': 'tour' };
  const a = els();
  applySettings(a, saved);
  assert.equal(a[0].checked, false);
  assert.equal(a[1].checked, false);
  assert.equal(a[2].value, 'garonne');
  assert.equal(a[4].checked, true);
  assert.equal(a[6].checked, true);
  // ?area=light&tour=jardins: エリアとコースは戻さない
  const b = els();
  applySettings(b, saved, urlSkips(new URLSearchParams('area=light&tour=jardins&autostart=1')));
  assert.equal(b[0].checked, false);
  assert.equal(b[2].value, 'classique');
  assert.equal(b[4].checked, false);
  assert.equal(b[6].checked, true);
  // 選択肢にない値は戻さない
  const c = els();
  applySettings(c, { 'opt-tour': 'nulle-part' });
  assert.equal(c[2].value, 'classique');
  assert.deepEqual(applySettings(els(), null), []);
});

test('CameraRig.applyLook: ±150° に収まり、離すと 0.6 秒でほぼ戻る', () => {
  const rig = new CameraRig(new THREE.PerspectiveCamera());
  rig.applyLook(1 / 60, { x: 0, y: 0, dx: -100000, dy: 0, held: true });
  assert.ok(Math.abs(rig.lookYaw - (150 * Math.PI) / 180) < 1e-9);
  for (let t = 0; t < 0.6; t += 1 / 60) rig.applyLook(1 / 60, { x: 0, y: 0, dx: 0, dy: 0, held: false });
  assert.ok(Math.abs(rig.lookYaw) < 0.03, `${rig.lookYaw}`);
  rig.applyLook(1 / 60, undefined); // テストのシミュレーション（look なし）でも動く
  rig.lookYaw = 0;
  rig.lookPitch = 0;
  // 見回していなければ、カメラは今までと同じ位置
  const bike = { x: 10, y: 0, z: 5, heading: 0.7, speed: 3, lean: 0 };
  const col = { raycast: () => 1 };
  rig.update(1 / 60, bike, col);
  const p = rig.camera.position.clone();
  const behind = [bike.x - Math.sin(0.7) * (5.2 + 0.36), bike.z + Math.cos(0.7) * (5.2 + 0.36)];
  assert.ok(Math.hypot(p.x - behind[0], p.z - behind[1]) < 1e-6);
});

test('写真モードのファイル名', () => {
  assert.equal(photoFileName(new Date(2026, 10, 2, 9, 5, 7)), 'toulouse-a-velo-20261102-090507.png');
});

test('beamFade: 光の柱は 12 m 以内では薄く、20 m から先は 1', () => {
  assert.equal(beamFade(0), 0.15);
  assert.equal(beamFade(12), 0.15);
  assert.ok(beamFade(16) > 0.15 && beamFade(16) < 1);
  assert.equal(beamFade(20), 1);
  assert.equal(beamFade(200), 1);
});
