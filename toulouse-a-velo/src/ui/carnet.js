// 旅の手帳（J キー）: 通算の記録・見つけた名所のカード・コースごとの自己ベストとメダル。
// 画面は開いたときだけ組み立てる。通算の記録（TravelStats）と発見の日付もここで保存する。

const DIRS = ['北', '北東', '東', '南東', '南', '南西', '西', '北西'];

// 今の場所から見た方角と距離（dx: 東、dz: 南。m）→「北東へ 約 1.2 km」
export function bearingLabel(dx, dz) {
  const d = Math.hypot(dx, dz);
  if (d < 1) return 'すぐ近く';
  const a = Math.atan2(dx, -dz); // 北から時計回り
  const i = ((Math.round(a / (Math.PI / 4)) % 8) + 8) % 8;
  const dist = d >= 1000 ? `${(d / 1000).toFixed(1)} km` : `${Math.max(10, Math.round(d / 10) * 10)} m`;
  return `${DIRS[i]}へ 約 ${dist}`;
}

// 通算の記録 { distance（m）, time（走った秒）, topSpeed（km/h）}。tav-stats に 5 秒ごと・ポーズ・タイトルに戻るときに保存
export class TravelStats {
  constructor(store) {
    this.store = store;
    const s = store.get('tav-stats', null) || {};
    this.data = { distance: +s.distance || 0, time: +s.time || 0, topSpeed: +s.topSpeed || 0 };
    this.lastOdo = 0;
    this.timer = 0;
  }

  // 走り始め（自転車の odometer を 0 にしたとき）
  reset(bike) {
    this.lastOdo = bike ? bike.odometer : 0;
  }

  tick(dt, bike) {
    const d = bike.odometer - this.lastOdo;
    if (d > 0 && d < 1000) this.data.distance += d; // ワープでは odometer は増えないが、念のため大きな跳びは数えない
    this.lastOdo = bike.odometer;
    if (Math.abs(bike.speed) > 0.3) this.data.time += dt;
    if (bike.topSpeed > this.data.topSpeed) this.data.topSpeed = bike.topSpeed;
    this.timer += dt;
    if (this.timer >= 5) this.flush();
  }

  flush() {
    this.timer = 0;
    this.store.set('tav-stats', this.data);
  }
}

// 名所を見つけた日（tav-discovered-at に { id: ISO の日付 }。古い発見には日付なし）
export function stampDiscovery(store, id, date = new Date()) {
  const at = store.get('tav-discovered-at', null) || {};
  if (!at[id]) {
    at[id] = date.toISOString();
    store.set('tav-discovered-at', at);
  }
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function fmtDuration(s) {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h ? `${h} 時間 ${m} 分` : `${m} 分`;
}

// 手帳の中身を root に組み立てる。
// d: { landmarks, bike, stats, violets（Violets か null）, discoveredAt, tours: [{ ja, fr, available, record, icon }],
//      canGo（タイムアタック中は false）, fmtTime }
// onGo(lm): 「ここへ行く」
export function renderCarnet(root, d, onGo) {
  const lms = d.landmarks;
  const found = lms.filter((l) => l.discovered).length;
  const v = d.violets;
  const medals = d.tours.filter((t) => t.record?.medal).map((t) => t.icon).join(' ') || '—';
  const s = d.stats;
  root.innerHTML = `
    <h2>📖 旅の手帳 <small class="muted">Carnet de voyage</small></h2>
    <div class="carnet-stats">
      <div><small>走った距離</small><b>${(s.distance / 1000).toFixed(1)} km</b></div>
      <div><small>走った時間</small><b>${fmtDuration(s.time)}</b></div>
      <div><small>最高速度</small><b>${Math.round(s.topSpeed)} km/h</b></div>
      <div><small>見つけた名所</small><b>${found}/${lms.length}</b></div>
      <div><small>スミレ</small><b>💜 ${v ? `${v.collected.size}/${v.total}` : '—'}</b></div>
      <div><small>メダル</small><b>${medals}</b></div>
    </div>
    <h3>名所</h3>
    <div class="carnet-grid"></div>
    <h3>コース</h3>
    <ul class="carnet-tours"></ul>`;
  const grid = root.querySelector('.carnet-grid');
  for (const lm of lms) {
    const card = document.createElement('div');
    card.className = `carnet-card${lm.discovered ? ' found' : ''}`;
    if (lm.discovered) {
      const at = d.discoveredAt[lm.id];
      const bouquet = v && v.bouquetDone(lm.id) ? ' <span title="スミレの花束">💐</span>' : '';
      card.innerHTML = `<b>${esc(lm.ja)}${bouquet}</b><i>${esc(lm.name)}</i><p>${esc(lm.text)}</p>
        <div class="carnet-foot"><small class="muted">${at ? `${new Date(at).toLocaleDateString('ja-JP')} に発見` : ''}</small><button>ここへ行く</button></div>`;
      const btn = card.querySelector('button');
      btn.disabled = !d.canGo;
      if (!d.canGo) btn.title = 'タイムアタック中は目的地を変えられません';
      btn.addEventListener('click', () => onGo(lm));
    } else {
      card.innerHTML = `<b>？？？</b><p class="muted">${esc(bearingLabel(lm.x - d.bike.x, lm.z - d.bike.z))}</p>`;
    }
    grid.appendChild(card);
  }
  const ul = root.querySelector('.carnet-tours');
  for (const t of d.tours) {
    const li = document.createElement('li');
    const best = t.record ? `${t.record.medal ? `${t.icon} ` : ''}${d.fmtTime(t.record.best)}` : t.available ? 'まだ記録なし' : 'このエリアでは走れません';
    li.innerHTML = `<span><b>${esc(t.ja)}</b> <i class="muted">${esc(t.fr)}</i></span><span>${best}</span>`;
    ul.appendChild(li);
  }
}
