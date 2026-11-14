// タイムアタックのコース・メダルの時間・記録の読み書き（DOM に依らない。保存先 store は { get(k, d), set(k, v) } を引数で渡す）。
import { TOUR_ROUTE } from '../config.js';

// コース（LANDMARKS の id の順番）。classique は今までの 1 コース（TOUR_ROUTE）そのまま
export const TOURS = [
  { id: 'classique', ja: '旧市街の名所めぐり', fr: 'Le grand classique', route: TOUR_ROUTE },
  { id: 'garonne', ja: 'ガロンヌ河岸と橋', fr: 'Les rives de Garonne', route: ['saint-pierre', 'daurade', 'pont-neuf', 'chateau-eau', 'hotel-dieu', 'prairie-filtres', 'saint-pierre'] },
  { id: 'jardins', ja: '庭園と運河', fr: 'Jardins et canal', route: ['grand-rond', 'jardin-plantes', 'halle-grains', 'saint-etienne', 'wilson', 'canal-midi', 'matabiau'] },
  { id: 'grand', ja: 'トゥールーズ大周遊', fr: 'Le grand tour', route: ['place-capitole', 'saint-sernin', 'jardin-japonais', 'ponts-jumeaux', 'bazacle', 'abattoirs', 'la-grave', 'pont-neuf', 'place-capitole'] },
];

export const MEDALS = ['gold', 'silver', 'bronze'];
export const MEDAL_ICON = { gold: '🥇', silver: '🥈', bronze: '🥉' };

// 名所が全部そろっているコースだけ（エリアによって名所が足りない）
export function availableTours(landmarks) {
  const ids = new Set(landmarks.map((l) => l.id));
  return TOURS.filter((t) => t.route.every((id) => ids.has(id)));
}

// 選んだコースを決める。戻り値 { tour, list, fellBack }（tour が null なら自由走行）
// 選んだコースが走れなければ classique にする。classique も名所が欠けていれば、今までどおり
// あるものだけ（3 か所以上）でコースにする（旧版の動き。軽量のエリアでは名所の一部が範囲の外）
export function pickTour(landmarks, id) {
  const byId = new Map(landmarks.map((l) => [l.id, l]));
  const avail = availableTours(landmarks);
  let tour = avail.find((t) => t.id === id) || null;
  const fellBack = !tour && id !== 'classique';
  if (!tour) tour = TOURS[0];
  const list = tour.route.map((r) => byId.get(r)).filter(Boolean);
  if (list.length < 3) return { tour: null, list: [], fellBack };
  return { tour, list, fellBack };
}

// コースの道のり（m）: 名所の approach の間を route(ax, az, bx, bz)（[[x, z], …] か null）で結んだ長さの合計。
// ルートが引けない区間は直線の 1.3 倍
export function tourLength(list, route) {
  let len = 0;
  for (let i = 1; i < list.length; i++) {
    const a = list[i - 1].approach, b = list[i].approach;
    const r = route(a.x, a.z, b.x, b.z);
    if (r && r.length > 1) {
      for (let k = 1; k < r.length; k++) len += Math.hypot(r[k][0] - r[k - 1][0], r[k][1] - r[k - 1][1]);
    } else len += Math.hypot(b.x - a.x, b.z - a.z) * 1.3;
  }
  return len;
}

// メダルの時間（秒）。金は平均 27 km/h、銀は 22 km/h、銅は 17 km/h ほど
export function medalTimes(length) {
  return { gold: length / 7.5, silver: length / 6.2, bronze: length / 4.8 };
}

// time 秒で取れるメダル（ちょうどその時間は取れる）
export function medalFor(time, times) {
  for (const m of MEDALS) if (time <= times[m]) return m;
  return null;
}

// 次に良いメダルと、それまでに縮める秒数（金を取っていれば null）
export function nextMedal(time, times) {
  const cur = medalFor(time, times);
  const i = cur ? MEDALS.indexOf(cur) - 1 : MEDALS.length - 1;
  if (i < 0) return null;
  return { medal: MEDALS[i], seconds: time - times[MEDALS[i]] };
}

const recordKey = (presetId, tourId) => `tav-tour-${presetId}-${tourId}`;
const oldKey = (presetId) => `tav-best-${presetId}`;

// 記録 { best, splits, medal } か null。classique は旧版の鍵 tav-best-<presetId>（数値だけ）も読む
export function loadRecord(store, presetId, tourId) {
  const rec = store.get(recordKey(presetId, tourId), null);
  if (rec && Number.isFinite(rec.best)) return { best: rec.best, splits: Array.isArray(rec.splits) ? rec.splits : null, medal: rec.medal || null };
  if (tourId === 'classique') {
    const old = store.get(oldKey(presetId), null);
    if (Number.isFinite(old)) return { best: old, splits: null, medal: null };
  }
  return null;
}

// 記録を保存する（より遅い時間では best を上書きしない）。splits はチェックポイントごとの通過時間（スタートからの秒）。
// classique は旧版の鍵にも best を書く（今までの記録を消さない）。戻り値 { isBest, record }
export function saveRecord(store, presetId, tourId, time, splits, medal) {
  const prev = loadRecord(store, presetId, tourId);
  if (prev && prev.best <= time) return { isBest: false, record: prev };
  const record = { best: time, splits: splits ? [...splits] : null, medal: medal || null };
  store.set(recordKey(presetId, tourId), record);
  if (tourId === 'classique') store.set(oldKey(presetId), time);
  return { isBest: true, record };
}

// 自己ベストの同じチェックポイント（スタートからの通過時間）との差（秒。記録がなければ null）
export function splitDelta(record, index, time) {
  const s = record?.splits?.[index];
  return Number.isFinite(s) ? time - s : null;
}

// 差の表示（+3.2 秒 / −1.5 秒）
export function fmtDelta(d) {
  return `${d < 0 ? '−' : '+'}${Math.abs(d).toFixed(1)} 秒`;
}
