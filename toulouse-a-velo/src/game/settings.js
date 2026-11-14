// タイトル画面の設定（チェックボックス・選択・エリア・モード）を tav-settings に保存し、次に開いたとき復元する。
// id で一般的に扱う（opt- で始まる input・select はあとから足しても自動で保存される）。opt-refresh（再ダウンロード）は保存しない。
const NEVER = new Set(['opt-refresh']);
const RADIOS = new Set(['area', 'mode']);

// 要素の保存の鍵: チェックボックス・選択は id、ラジオは「radio:<name>」
function keyOf(el) {
  if (el.type === 'radio') return RADIOS.has(el.name) ? `radio:${el.name}` : null;
  if (!el.id || !el.id.startsWith('opt-') || NEVER.has(el.id)) return null;
  return el.id;
}

// 要素（{ id, type, name, checked, value } の形）から保存する値を集める
export function collectSettings(elements) {
  const out = {};
  for (const el of elements) {
    const k = keyOf(el);
    if (!k) continue;
    if (el.type === 'radio') {
      if (el.checked) out[k] = el.value;
    } else if (el.type === 'checkbox') out[k] = !!el.checked;
    else out[k] = el.value;
  }
  return out;
}

// 保存した値を要素に戻す。skip: 戻さない鍵の Set（URL で指定された項目）。戻り値: 変えた鍵の配列
export function applySettings(elements, saved, skip = new Set()) {
  const changed = [];
  if (!saved || typeof saved !== 'object') return changed;
  for (const el of elements) {
    const k = keyOf(el);
    if (!k || skip.has(k) || !(k in saved)) continue;
    const v = saved[k];
    if (el.type === 'radio') {
      if (v === el.value && !el.checked) {
        el.checked = true;
        changed.push(k);
      }
    } else if (el.type === 'checkbox') {
      if (typeof v === 'boolean' && el.checked !== v) {
        el.checked = v;
        changed.push(k);
      }
    } else if (typeof v === 'string' && el.value !== v) {
      // 選択肢にない値（古い設定・別のエリア）は戻さない
      if (el.options && ![...el.options].some((o) => o.value === v)) continue;
      el.value = v;
      changed.push(k);
    }
  }
  return changed;
}

// URL のパラメータで決まる項目（URL を優先する）: ?area= → radio:area、?tour= → opt-tour など
export function urlSkips(params) {
  const skip = new Set();
  for (const p of params.keys()) {
    skip.add(`opt-${p}`);
    skip.add(`radio:${p}`);
  }
  if (params.has('lat') && params.has('lon')) skip.add('radio:area'); // URL で指定したエリア
  return skip;
}

const titleElements = (root) => root.querySelectorAll('input[id^="opt-"], select[id^="opt-"], input[name=area], input[name=mode]');

export function saveTitleSettings(root, store) {
  store.set('tav-settings', collectSettings(titleElements(root)));
}

export function restoreTitleSettings(root, store, params) {
  return applySettings(titleElements(root), store.get('tav-settings', null), urlSkips(params));
}
