// ミニマップ（進行方向が上に回転）と全体地図。地図は一度だけオフスクリーンに描いておき、毎フレーム切り出す。
import { CAR_ROADS } from '../world/parse.js';

const COLORS = {
  bg: '#e9e2d4',
  green: '#b8d29a',
  water: '#8db7c8',
  plaza: '#e5dccb',
  parking: '#d6d3cf',
  building: '#d2b5a3',
  buildingStroke: '#b9927d',
  road: '#ffffff',
  roadCase: '#bdb5a6',
  footway: '#f6f1e6',
  cycleway: '#7bb08a',
  rail: '#8a8a8a',
};

export class MapRenderer {
  constructor(parsed, rect) {
    this.rect = rect;
    const w = rect.maxX - rect.minX, h = rect.maxZ - rect.minZ;
    this.scale = Math.min(1.0, 2600 / Math.max(w, h)); // px / m
    const c = document.createElement('canvas');
    c.width = Math.ceil(w * this.scale);
    c.height = Math.ceil(h * this.scale);
    this.canvas = c;
    this.draw(parsed);
  }

  px(x) {
    return (x - this.rect.minX) * this.scale;
  }

  pz(z) {
    return (z - this.rect.minZ) * this.scale;
  }

  draw(parsed) {
    const ctx = this.canvas.getContext('2d');
    ctx.fillStyle = COLORS.bg;
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    const poly = (p) => {
      ctx.beginPath();
      for (const ring of [p.outer, ...(p.holes || [])]) {
        ring.forEach(([x, z], i) => (i ? ctx.lineTo(this.px(x), this.pz(z)) : ctx.moveTo(this.px(x), this.pz(z))));
        ctx.closePath();
      }
    };
    for (const a of parsed.areas) {
      if (a.type === 'water') continue;
      ctx.fillStyle = a.type === 'plaza' ? COLORS.plaza : a.type === 'parking' ? COLORS.parking : COLORS.green;
      poly(a);
      ctx.fill('evenodd');
    }
    ctx.fillStyle = COLORS.water;
    for (const a of parsed.areas) {
      if (a.type !== 'water') continue;
      poly(a);
      ctx.fill('evenodd');
    }
    ctx.fillStyle = COLORS.building;
    ctx.strokeStyle = COLORS.buildingStroke;
    ctx.lineWidth = 0.5;
    for (const b of parsed.buildings) {
      poly(b);
      ctx.fill('evenodd');
      ctx.stroke();
    }
    const line = (pts) => {
      ctx.beginPath();
      pts.forEach(([x, z], i) => (i ? ctx.lineTo(this.px(x), this.pz(z)) : ctx.moveTo(this.px(x), this.pz(z))));
    };
    ctx.lineCap = ctx.lineJoin = 'round';
    const roads = parsed.roads.filter((r) => !r.tunnel);
    // 車道は縁取り → 中身の順に描く
    for (const pass of [0, 1]) {
      for (const r of roads) {
        const car = CAR_ROADS.has(r.type) || r.type === 'pedestrian' || r.type === 'living_street' || r.type === 'service';
        if (!car) continue;
        ctx.strokeStyle = pass ? (r.type === 'pedestrian' || r.type === 'living_street' ? COLORS.plaza : COLORS.road) : COLORS.roadCase;
        ctx.lineWidth = Math.max(1.2, r.width * this.scale) + (pass ? 0 : 1.6);
        line(r.pts);
        ctx.stroke();
      }
    }
    for (const r of roads) {
      if (r.type === 'cycleway') ctx.strokeStyle = COLORS.cycleway;
      else if (r.type === 'footway' || r.type === 'path' || r.type === 'steps' || r.type === 'track') ctx.strokeStyle = COLORS.footway;
      else continue;
      ctx.lineWidth = Math.max(1, r.width * this.scale);
      line(r.pts);
      ctx.stroke();
    }
    ctx.strokeStyle = COLORS.rail;
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 3]);
    for (const r of parsed.rails) {
      line(r.pts);
      ctx.stroke();
    }
    ctx.setLineDash([]);
  }
}

// 画面右上の円形ミニマップ
export function drawMinimap(canvas, map, view) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  const cx = W / 2, cy = H / 2;
  const zoom = view.zoom; // px / m（画面上）
  ctx.save();
  ctx.clearRect(0, 0, W, H);
  ctx.beginPath();
  ctx.arc(cx, cy, W / 2 - 2, 0, Math.PI * 2);
  ctx.clip();
  ctx.fillStyle = '#d9d2c4';
  ctx.fillRect(0, 0, W, H);
  ctx.translate(cx, cy);
  ctx.rotate(-view.heading);
  ctx.scale(zoom / map.scale, zoom / map.scale);
  ctx.translate(-map.px(view.x), -map.pz(view.z));
  ctx.drawImage(map.canvas, 0, 0);
  // ルート
  if (view.route && view.route.length > 1) {
    ctx.strokeStyle = 'rgba(37,110,230,0.85)';
    ctx.lineWidth = (5 * map.scale) / zoom;
    ctx.lineJoin = ctx.lineCap = 'round';
    ctx.beginPath();
    view.route.forEach(([x, z], i) => (i ? ctx.lineTo(map.px(x), map.pz(z)) : ctx.moveTo(map.px(x), map.pz(z))));
    ctx.stroke();
  }
  // 名所
  const s = map.scale / zoom;
  for (const lm of view.landmarks) {
    const isTarget = view.target === lm;
    ctx.fillStyle = isTarget ? '#f5a623' : lm.discovered ? '#6b3fa0' : '#ffffff';
    ctx.strokeStyle = '#333';
    ctx.lineWidth = 1.5 * s;
    ctx.beginPath();
    ctx.arc(map.px(lm.x), map.pz(lm.z), (isTarget ? 7 : 4.5) * s, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
  ctx.restore();
  // 自分（常に中央・上向き）
  ctx.save();
  ctx.translate(cx, cy);
  ctx.fillStyle = '#d0021b';
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(0, -10);
  ctx.lineTo(7, 8);
  ctx.lineTo(0, 4);
  ctx.lineTo(-7, 8);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.restore();
  // 北の印
  const r = W / 2 - 12;
  const nx = cx + Math.sin(-view.heading) * r, ny = cy - Math.cos(-view.heading) * r;
  ctx.fillStyle = '#fff';
  ctx.strokeStyle = '#333';
  ctx.lineWidth = 3;
  ctx.font = 'bold 13px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.strokeText('N', nx, ny);
  ctx.fillText('N', nx, ny);
  // 外枠
  ctx.beginPath();
  ctx.arc(cx, cy, W / 2 - 2, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(255,255,255,0.9)';
  ctx.lineWidth = 3;
  ctx.stroke();
}

// 全体地図（M キー）。戻り値: 画面座標 → ワールド座標の変換関数
export function drawFullMap(canvas, map, view) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  const k = Math.min(W / map.canvas.width, H / map.canvas.height);
  const ox = (W - map.canvas.width * k) / 2, oy = (H - map.canvas.height * k) / 2;
  ctx.fillStyle = '#20242a';
  ctx.fillRect(0, 0, W, H);
  ctx.drawImage(map.canvas, ox, oy, map.canvas.width * k, map.canvas.height * k);
  const sx = (x) => ox + map.px(x) * k, sz = (z) => oy + map.pz(z) * k;
  if (view.route && view.route.length > 1) {
    ctx.strokeStyle = 'rgba(37,110,230,0.85)';
    ctx.lineWidth = 4;
    ctx.beginPath();
    view.route.forEach(([x, z], i) => (i ? ctx.lineTo(sx(x), sz(z)) : ctx.moveTo(sx(x), sz(z))));
    ctx.stroke();
  }
  ctx.font = '600 13px system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  for (const lm of view.landmarks) {
    const x = sx(lm.x), y = sz(lm.z);
    const isTarget = view.target === lm;
    ctx.fillStyle = isTarget ? '#f5a623' : lm.discovered ? '#6b3fa0' : '#ffffff';
    ctx.strokeStyle = '#222';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(x, y, isTarget ? 8 : 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.strokeText(lm.ja, x + 10, y);
    ctx.fillStyle = '#222';
    ctx.fillText(lm.ja, x + 10, y);
  }
  // 自分
  ctx.save();
  ctx.translate(sx(view.x), sz(view.z));
  ctx.rotate(view.heading);
  ctx.fillStyle = '#d0021b';
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(0, -12);
  ctx.lineTo(8, 9);
  ctx.lineTo(0, 5);
  ctx.lineTo(-8, 9);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.restore();
  return {
    toWorld: (px, py) => [map.rect.minX + (px - ox) / k / map.scale, map.rect.minZ + (py - oy) / k / map.scale],
    toScreen: (x, z) => [sx(x), sz(z)],
  };
}
