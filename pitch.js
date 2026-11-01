// 映像座標 ⇄ ピッチ座標(m) の変換と、ピッチのライン形状。
// ピッチ座標: x = ゴール間方向 (0〜L), y = タッチライン間方向 (0〜W)

function solve(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    const v = M[c][c];
    if (Math.abs(v) < 1e-12) throw new Error('四隅の位置が一直線に並んでいます。指定し直してください。');
    for (let k = c; k <= n; k++) M[c][k] /= v;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c];
      if (!f) continue;
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((r) => r[n]);
}

// 4点対応からホモグラフィ行列（3x3, 長さ9の配列）を求める
export function computeHomography(src, dst) {
  const A = [], b = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i], [u, v] = dst[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
  }
  return [...solve(A, b), 1];
}

export function applyH(H, [x, y]) {
  const w = H[6] * x + H[7] * y + H[8];
  return [(H[0] * x + H[1] * y + H[2]) / w, (H[3] * x + H[4] * y + H[5]) / w];
}

export function inPitch([x, y], L, W, margin = 0) {
  return x >= -margin && x <= L + margin && y >= -margin && y <= W + margin;
}

// 描画用のライン（m単位の折れ線の配列）
export function pitchLines(L, W) {
  const lines = [];
  lines.push([[0, 0], [L, 0], [L, W], [0, W], [0, 0]]);
  lines.push([[L / 2, 0], [L / 2, W]]);
  const r = Math.min(7, W * 0.14);
  const circle = [];
  for (let k = 0; k <= 48; k++) {
    const a = (k / 48) * Math.PI * 2;
    circle.push([L / 2 + r * Math.cos(a), W / 2 + r * Math.sin(a)]);
  }
  lines.push(circle);
  const pa = { d: Math.min(12, L * 0.18), w: Math.min(28, W * 0.56) };
  const ga = { d: Math.min(4, L * 0.06), w: Math.min(13, W * 0.26) };
  for (const [x0, s] of [[0, 1], [L, -1]]) {
    for (const a of [pa, ga]) {
      lines.push([
        [x0, (W - a.w) / 2], [x0 + s * a.d, (W - a.w) / 2],
        [x0 + s * a.d, (W + a.w) / 2], [x0, (W + a.w) / 2],
      ]);
    }
  }
  return lines;
}

export function goalLines(L, W, goalWidth) {
  const y0 = (W - goalWidth) / 2, y1 = (W + goalWidth) / 2;
  return [
    [[0, y0], [-1.2, y0], [-1.2, y1], [0, y1]],
    [[L, y0], [L + 1.2, y0], [L + 1.2, y1], [L, y1]],
  ];
}
