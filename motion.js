// カメラのパン・ズームを、背景（選手以外）の模様のずれから推定する。
// 結果は「前のコマの座標 → 今のコマの座標」の変換 x' = s*x + tx, y' = s*y + ty。

const IDENTITY = { s: 1, tx: 0, ty: 0, ok: false };

function toGray(rgba, n) {
  const g = new Float32Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) g[i] = rgba[j] * 0.299 + rgba[j + 1] * 0.587 + rgba[j + 2] * 0.114;
  return g;
}

function half(g, W, H) {
  const w = W >> 1, h = H >> 1, o = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = 2 * y * W + 2 * x;
      o[y * w + x] = (g[i] + g[i + 1] + g[i + W] + g[i + W + 1]) / 4;
    }
  }
  return { g: o, W: w, H: h };
}

function sad(a, b, W, ax, ay, bx, by, r) {
  let s = 0;
  for (let dy = -r; dy <= r; dy++) {
    const ia = (ay + dy) * W + ax, ib = (by + dy) * W + bx;
    for (let dx = -r; dx <= r; dx++) s += Math.abs(a[ia + dx] - b[ib + dx]);
  }
  return s;
}

// 特徴点（模様のはっきりした点）を格子ごとに1つずつ選ぶ
function pickFeatures(g, W, H, masked, cols = 16, rows = 9) {
  const gx2 = new Float64Array((W + 1) * (H + 1)), gy2 = new Float64Array((W + 1) * (H + 1));
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const i = y * W + x;
      const dx = g[i + 1] - g[i - 1], dy = g[i + W] - g[i - W];
      gx2[(y + 1) * (W + 1) + x + 1] = dx * dx;
      gy2[(y + 1) * (W + 1) + x + 1] = dy * dy;
    }
  }
  for (const a of [gx2, gy2]) {
    for (let y = 1; y <= H; y++) {
      for (let x = 1; x <= W; x++) {
        const i = y * (W + 1) + x;
        a[i] += a[i - 1] + a[i - W - 1] - a[i - W - 2];
      }
    }
  }
  const box = (a, x, y, r) => {
    const x0 = x - r, y0 = y - r, x1 = x + r + 1, y1 = y + r + 1, S = W + 1;
    return a[y1 * S + x1] - a[y0 * S + x1] - a[y1 * S + x0] + a[y0 * S + x0];
  };
  const feats = [];
  const margin = 26;
  const cw = (W - 2 * margin) / cols, ch = (H - 2 * margin) / rows;
  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      let best = 0, bx = -1, by = -1;
      const x0 = Math.floor(margin + cx * cw), y0 = Math.floor(margin + cy * ch);
      for (let y = y0; y < y0 + ch; y += 2) {
        for (let x = x0; x < x0 + cw; x += 2) {
          if (masked(x, y)) continue;
          const sc = Math.min(box(gx2, x, y, 2), box(gy2, x, y, 2));
          if (sc > best) { best = sc; bx = x; by = y; }
        }
      }
      if (best > 2500) feats.push([bx, by]);
    }
  }
  return feats;
}

function fitSimilarity(P, Q, maxScale) {
  const n = P.length;
  if (n < 6) return null;
  let best = null, bestIn = [];
  for (let it = 0; it < 120; it++) {
    const i = Math.floor(Math.random() * n), j = Math.floor(Math.random() * n);
    if (i === j) continue;
    const dp = Math.hypot(P[i][0] - P[j][0], P[i][1] - P[j][1]);
    if (dp < 20) continue;
    let s = Math.hypot(Q[i][0] - Q[j][0], Q[i][1] - Q[j][1]) / dp;
    if (Math.abs(s - 1) > maxScale) continue;
    const tx = (Q[i][0] + Q[j][0] - s * (P[i][0] + P[j][0])) / 2;
    const ty = (Q[i][1] + Q[j][1] - s * (P[i][1] + P[j][1])) / 2;
    const inl = [];
    for (let k = 0; k < n; k++) {
      if (Math.hypot(s * P[k][0] + tx - Q[k][0], s * P[k][1] + ty - Q[k][1]) < 1.5) inl.push(k);
    }
    if (inl.length > bestIn.length) { bestIn = inl; best = { s, tx, ty }; }
  }
  if (!best || bestIn.length < Math.max(6, n * 0.3)) return null;
  // 外れ値を除いた点で最小二乗
  let mpx = 0, mpy = 0, mqx = 0, mqy = 0;
  for (const k of bestIn) { mpx += P[k][0]; mpy += P[k][1]; mqx += Q[k][0]; mqy += Q[k][1]; }
  const m = bestIn.length;
  mpx /= m; mpy /= m; mqx /= m; mqy /= m;
  let num = 0, den = 0;
  for (const k of bestIn) {
    const px = P[k][0] - mpx, py = P[k][1] - mpy;
    num += px * (Q[k][0] - mqx) + py * (Q[k][1] - mqy);
    den += px * px + py * py;
  }
  let s = den > 0 ? num / den : 1;
  if (Math.abs(s - 1) > maxScale) s = best.s;
  return { s, tx: mqx - s * mpx, ty: mqy - s * mpy, inliers: m };
}

// 縮小済みグレー画像2枚から変換を求める（テストしやすいよう canvas に依存しない）
export function estimateFromGray(prev, cur, W, H, prevBoxes = [], maxScale = 0.15) {
  const masked = (x, y) => prevBoxes.some((b) => x >= b[0] - 4 && x <= b[2] + 4 && y >= b[1] - 4 && y <= b[3] + 4);
  const feats = pickFeatures(prev, W, H, masked);
  const p0 = half(prev, W, H), c0 = half(cur, W, H);
  const R0 = 10, r0 = 2, r1 = 3;
  const P = [], Q = [];
  for (const [x, y] of feats) {
    // 粗い探索（1/2解像度）
    const hx = x >> 1, hy = y >> 1;
    let best = Infinity, bdx = 0, bdy = 0;
    for (let dy = -R0; dy <= R0; dy++) {
      const ny = hy + dy;
      if (ny - r0 < 0 || ny + r0 >= c0.H) continue;
      for (let dx = -R0; dx <= R0; dx++) {
        const nx = hx + dx;
        if (nx - r0 < 0 || nx + r0 >= c0.W) continue;
        const v = sad(p0.g, c0.g, p0.W, hx, hy, nx, ny, r0);
        if (v < best) { best = v; bdx = dx; bdy = dy; }
      }
    }
    // 細かい探索（元の解像度）
    let best1 = Infinity, fx = 0, fy = 0;
    for (let dy = -2; dy <= 2; dy++) {
      const ny = y + 2 * bdy + dy;
      if (ny - r1 < 0 || ny + r1 >= H) continue;
      for (let dx = -2; dx <= 2; dx++) {
        const nx = x + 2 * bdx + dx;
        if (nx - r1 < 0 || nx + r1 >= W) continue;
        const v = sad(prev, cur, W, x, y, nx, ny, r1);
        if (v < best1) { best1 = v; fx = nx; fy = ny; }
      }
    }
    if (best1 === Infinity || best1 / 49 > 18) continue; // 一致が悪い点は使わない
    P.push([x, y]);
    Q.push([fx, fy]);
  }
  const fit = fitSimilarity(P, Q, maxScale);
  return fit ? { ...fit, ok: true } : { ...IDENTITY };
}

export class MotionEstimator {
  constructor(width = 320, maxScale = 0.15) {
    this.W = width;
    this.maxScale = maxScale;
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    this.prev = null;
    this.prevBoxes = [];
  }

  reset() { this.prev = null; this.prevBoxes = []; }

  // src: 今のコマのcanvas / boxes: 今のコマの人物枠（元の解像度）
  // 戻り値：前のコマ→今のコマ の変換（元の解像度の座標）
  estimate(src, boxes) {
    const k = src.width / this.W;
    const W = this.W, H = Math.round(src.height / k);
    if (this.canvas.width !== W || this.canvas.height !== H) { this.canvas.width = W; this.canvas.height = H; }
    this.ctx.drawImage(src, 0, 0, W, H);
    const cur = toGray(this.ctx.getImageData(0, 0, W, H).data, W * H);
    const small = boxes.map((b) => b.map((v) => v / k));
    let out = { ...IDENTITY };
    if (this.prev) {
      const m = estimateFromGray(this.prev, cur, W, H, this.prevBoxes, this.maxScale);
      out = { s: m.s, tx: m.tx * k, ty: m.ty * k, ok: m.ok };
    }
    this.prev = cur;
    this.prevBoxes = small;
    return out;
  }
}
