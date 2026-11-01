// 描画まわり：俯瞰ピッチ（レーダー・ヒートマップ）と、映像上の重ね描き。
import { pitchLines, goalLines, applyH } from './pitch.js';

const TURF = ['#2F7046', '#29653F'];
const CHALK = 'rgba(255,255,255,0.9)';
const UNKNOWN = '#A3ADA6';
const BALL = '#FFD84A';

export function makePitchView(cw, ch, L, W, pad = 3) {
  const s = Math.min(cw / (L + 2 * pad), ch / (W + 2 * pad));
  const ox = (cw - L * s) / 2, oy = (ch - W * s) / 2;
  return { s, ox, oy, L, W, toCanvas: ([x, y]) => [ox + x * s, oy + y * s] };
}

export function drawTurf(ctx, view) {
  const { s, ox, L } = view;
  const { width, height } = ctx.canvas;
  ctx.fillStyle = TURF[1];
  ctx.fillRect(0, 0, width, height);
  const stripes = 12;
  const sw = (L * s) / stripes;
  for (let k = -2; k < stripes + 2; k++) {
    ctx.fillStyle = TURF[(k + 100) % 2];
    ctx.fillRect(ox + k * sw, 0, sw + 0.5, height);
  }
}

function strokePolyline(ctx, pts, map) {
  ctx.beginPath();
  pts.forEach((p, i) => {
    const [x, y] = map(p);
    if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
  });
  ctx.stroke();
}

export function drawLines(ctx, view, goalWidth) {
  ctx.save();
  ctx.strokeStyle = CHALK;
  ctx.lineWidth = Math.max(1.5, view.s * 0.14);
  ctx.lineJoin = 'round';
  for (const l of pitchLines(view.L, view.W)) strokePolyline(ctx, l, view.toCanvas);
  ctx.lineWidth = Math.max(2.5, view.s * 0.28);
  for (const g of goalLines(view.L, view.W, goalWidth)) strokePolyline(ctx, g, view.toCanvas);
  ctx.restore();
}

export function drawHeat(ctx, view, grid, cols, rows, rgb) {
  let max = 0;
  for (const v of grid) if (v > max) max = v;
  if (!max) return;
  const cw = (view.L / cols) * view.s, chh = (view.W / rows) * view.s;
  ctx.save();
  ctx.fillStyle = rgb;
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const v = grid[y * cols + x];
      if (!v) continue;
      ctx.globalAlpha = Math.sqrt(v / max) * 0.85;
      ctx.fillRect(view.ox + x * cw, view.oy + y * chh, cw + 0.5, chh + 0.5);
    }
  }
  ctx.restore();
}

export function drawRadar(ctx, view, frame, ballPos, { teamOf, colors, ownerId }) {
  const r = Math.max(4, view.s * 0.8);
  ctx.save();
  for (const p of frame.players) {
    const [x, y] = view.toCanvas(p.pos);
    const tm = teamOf(p.id);
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = tm >= 0 ? colors[tm] : UNKNOWN;
    ctx.fill();
    ctx.lineWidth = p.id === ownerId ? 3 : 1.5;
    ctx.strokeStyle = p.id === ownerId ? BALL : 'rgba(255,255,255,0.95)';
    ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.95)';
    ctx.font = `700 ${Math.round(r * 1.1)}px "Zen Kaku Gothic New", sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillText(String(p.id), x, y - r - 2);
  }
  if (ballPos) {
    const [x, y] = view.toCanvas(ballPos);
    ctx.beginPath();
    ctx.arc(x, y, r * 0.55, 0, Math.PI * 2);
    ctx.fillStyle = BALL;
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = '#1B1B1B';
    ctx.stroke();
  }
  ctx.restore();
}

// 指定した四隅から逆算したピッチのラインを映像に重ねる（指定が正しいかの確認用）
export function drawProjectedPitch(ctx, Hinv, L, W, goalWidth) {
  const map = (p) => applyH(Hinv, p);
  ctx.save();
  ctx.strokeStyle = 'rgba(255,255,255,0.8)';
  ctx.lineWidth = Math.max(1.5, ctx.canvas.width / 700);
  ctx.setLineDash([ctx.lineWidth * 4, ctx.lineWidth * 3]);
  for (const l of pitchLines(L, W)) strokePolyline(ctx, l, map);
  ctx.setLineDash([]);
  for (const g of goalLines(L, W, goalWidth)) strokePolyline(ctx, g, map);
  ctx.restore();
}

export function drawCornerPoints(ctx, points, labels) {
  const r = Math.max(6, ctx.canvas.width / 180);
  ctx.save();
  ctx.font = `700 ${Math.round(r * 2)}px "Zen Kaku Gothic New", sans-serif`;
  ctx.textBaseline = 'bottom';
  points.forEach(([x, y], i) => {
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = BALL;
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#1B1B1B';
    ctx.stroke();
    ctx.lineWidth = 4;
    ctx.strokeStyle = 'rgba(0,0,0,0.7)';
    ctx.strokeText(labels[i], x + r * 1.4, y - r * 0.6);
    ctx.fillStyle = '#FFFFFF';
    ctx.fillText(labels[i], x + r * 1.4, y - r * 0.6);
  });
  ctx.restore();
}

export function drawDetections(ctx, frame, { teamOf, colors, ownerId }) {
  const lw = Math.max(2, ctx.canvas.width / 640);
  ctx.save();
  ctx.lineWidth = lw;
  ctx.font = `700 ${Math.round(lw * 7)}px "Zen Kaku Gothic New", sans-serif`;
  ctx.textBaseline = 'bottom';
  for (const p of frame.players) {
    const [x1, y1, x2, y2] = p.box;
    const tm = teamOf ? teamOf(p.id) : -1;
    const col = tm >= 0 ? colors[tm] : 'rgba(255,255,255,0.85)';
    ctx.strokeStyle = p.id === ownerId ? BALL : col;
    ctx.lineWidth = p.id === ownerId ? lw * 2 : lw;
    ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
    const label = String(p.id);
    const tw = ctx.measureText(label).width + lw * 3;
    ctx.fillStyle = col;
    ctx.fillRect(x1, y1 - lw * 8, tw, lw * 8);
    ctx.fillStyle = '#FFFFFF';
    ctx.fillText(label, x1 + lw * 1.5, y1 - lw);
  }
  if (frame.ball) {
    const [x1, y1, x2, y2] = frame.ball.box;
    ctx.beginPath();
    ctx.arc((x1 + x2) / 2, (y1 + y2) / 2, Math.max(8, (x2 - x1)), 0, Math.PI * 2);
    ctx.strokeStyle = BALL;
    ctx.lineWidth = lw * 1.5;
    ctx.stroke();
  }
  ctx.restore();
}
