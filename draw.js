// 描画：映像への重ね描きと、ボール保持のタイムライン。

const BALL = '#FFD84A';
const EXCLUDED = 'rgba(255,255,255,0.35)';

function label(ctx, text, x, y, bg, lw) {
  const tw = ctx.measureText(text).width + lw * 3;
  ctx.fillStyle = bg;
  ctx.fillRect(x, y - lw * 8, tw, lw * 8);
  ctx.fillStyle = '#FFFFFF';
  ctx.strokeStyle = 'rgba(0,0,0,0.45)';
  ctx.lineWidth = lw * 0.8;
  ctx.strokeText(text, x + lw * 1.5, y - lw);
  ctx.fillText(text, x + lw * 1.5, y - lw);
}

// 解析中・再生中の枠。info が null のときは全員を白で描く（解析中のプレビュー）
// info(id) -> { team: 0|1|-1, text: '7' など }
export function drawDetections(ctx, frame, { info, colors, ownerKey, keyOf, showExcluded, focusIds }) {
  const lw = Math.max(2, ctx.canvas.width / 640);
  ctx.save();
  ctx.font = `700 ${Math.round(lw * 7)}px "Zen Kaku Gothic New", sans-serif`;
  ctx.textBaseline = 'bottom';
  for (const p of frame.players) {
    const [x1, y1, x2, y2] = p.box;
    const inf = info ? info(p.id) : { team: -2, text: '' };
    const focus = focusIds && focusIds.has(p.id);
    if (inf.team === -1 && !focus) {
      if (!showExcluded) continue;
      ctx.setLineDash([lw * 3, lw * 3]);
      ctx.strokeStyle = EXCLUDED;
      ctx.lineWidth = lw * 0.8;
      ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
      ctx.setLineDash([]);
      continue;
    }
    const col = inf.team >= 0 ? colors[inf.team] : 'rgba(255,255,255,0.8)';
    const own = ownerKey && keyOf && keyOf(p.id) === ownerKey;
    const w = focus ? lw * 3.2 : own ? lw * 2.2 : lw;
    ctx.strokeStyle = 'rgba(255,255,255,0.75)'; // どんな色のユニフォームでも見えるよう白い縁取り
    ctx.lineWidth = w + lw * 1.2;
    ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
    ctx.strokeStyle = focus || own ? BALL : col;
    ctx.lineWidth = w;
    ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
    if (inf.team >= 0 && inf.text) label(ctx, inf.text, x1, y1, col, lw);
  }
  if (frame.ball) {
    const [x1, y1, x2, y2] = frame.ball.box;
    ctx.beginPath();
    ctx.arc((x1 + x2) / 2, (y1 + y2) / 2, Math.max(10, (x2 - x1) * 1.2), 0, Math.PI * 2);
    ctx.strokeStyle = BALL;
    ctx.lineWidth = lw * 1.5;
    ctx.stroke();
  }
  ctx.restore();
}

// 色登録のときの枠（タップできる人を示す）
export function drawPickBoxes(ctx, boxes, picked) {
  const lw = Math.max(2, ctx.canvas.width / 640);
  ctx.save();
  for (const b of boxes) {
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.lineWidth = lw;
    ctx.strokeRect(b[0], b[1], b[2] - b[0], b[3] - b[1]);
  }
  if (picked) {
    const b = picked.box;
    ctx.strokeStyle = BALL;
    ctx.lineWidth = lw * 2.5;
    ctx.strokeRect(b[0], b[1], b[2] - b[0], b[3] - b[1]);
  }
  ctx.restore();
}

// ボール保持のタイムライン（一度だけ描いてキャッシュする）。
// 上段=チームA、下段=チームB の保持。印はシュート（▲）と奪取（●）
export function drawTimeline(canvas, { frames, result, colors, t0, t1, dpr, track, ink }) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  const pad = 8 * dpr;
  const mid = H / 2;
  const laneH = H * 0.24;
  const x = (t) => pad + ((t - t0) / Math.max(0.001, t1 - t0)) * (W - 2 * pad);

  ctx.fillStyle = track;
  ctx.fillRect(pad, mid - laneH, W - 2 * pad, laneH * 2);

  const own = result.ownerTeam;
  for (let i = 0; i < frames.length; i++) {
    const tm = own[i];
    if (tm < 0) continue;
    const xa = x(frames[i].t), xb = x(frames[i].t + 1 / result.fps);
    ctx.fillStyle = colors[tm];
    ctx.fillRect(xa, tm === 0 ? mid - laneH : mid, xb - xa + 0.5, laneH);
  }
  ctx.fillStyle = ink;
  ctx.fillRect(pad, mid - 0.5 * dpr, W - 2 * pad, 1 * dpr);

  for (const e of result.events) {
    if (e.type !== 'shot' && e.type !== 'steal') continue;
    const ex = x(e.t);
    const up = e.team === 0;
    ctx.fillStyle = colors[e.team];
    ctx.strokeStyle = ink;
    ctx.lineWidth = 1 * dpr;
    if (e.type === 'shot') {
      const s = 5 * dpr, y = up ? mid - laneH - 2 * dpr : mid + laneH + 2 * dpr;
      const k = up ? -1 : 1;
      ctx.beginPath();
      ctx.moveTo(ex, y);
      ctx.lineTo(ex - s, y + k * s * 1.7);
      ctx.lineTo(ex + s, y + k * s * 1.7);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    } else {
      const y = up ? mid - laneH - 6 * dpr : mid + laneH + 6 * dpr;
      ctx.beginPath();
      ctx.arc(ex, y, 2.6 * dpr, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  return { pad };
}
