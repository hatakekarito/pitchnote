// ユニフォームの色で選手を2チームに分ける（k-means, k=2）。
// 胴体あたりの画素を集め、芝生っぽい緑は除外して平均色をとる。

const d2 = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;

export class TeamClassifier {
  constructor() {
    this.samples = new Map(); // id -> {r,g,b,n}
    this.centers = [[230, 120, 40], [50, 100, 200]];
    this.assign = new Map();
  }

  observe(id, ctx, box) {
    const [x1, y1, x2, y2] = box;
    const w = x2 - x1, h = y2 - y1;
    if (h < 14 || w < 5) return;
    const sx = Math.round(x1 + w * 0.25);
    const sy = Math.round(y1 + h * 0.18);
    const sw = Math.max(1, Math.round(w * 0.5));
    const sh = Math.max(1, Math.round(h * 0.3));
    let px;
    try { px = ctx.getImageData(sx, sy, sw, sh).data; } catch { return; }
    let r = 0, g = 0, b = 0, n = 0;
    for (let i = 0; i < px.length; i += 4) {
      const R = px[i], G = px[i + 1], B = px[i + 2];
      if (G > R + 12 && G > B + 12) continue; // 芝
      r += R; g += G; b += B; n++;
    }
    if (n < 4) return;
    const s = this.samples.get(id) || { r: 0, g: 0, b: 0, n: 0 };
    s.r += r / n; s.g += g / n; s.b += b / n; s.n++;
    this.samples.set(id, s);
  }

  fit() {
    const pts = [];
    for (const [id, s] of this.samples) {
      if (s.n >= 2) pts.push({ id, c: [s.r / s.n, s.g / s.n, s.b / s.n], w: s.n });
    }
    if (pts.length >= 2) {
      const c0 = pts.reduce((a, b) => (b.w > a.w ? b : a)).c;
      const c1 = pts.reduce((a, b) => (d2(b.c, c0) > d2(a.c, c0) ? b : a)).c;
      let C = [c0.slice(), c1.slice()];
      for (let it = 0; it < 25; it++) {
        const acc = [[0, 0, 0, 0], [0, 0, 0, 0]];
        for (const p of pts) {
          const k = d2(p.c, C[0]) <= d2(p.c, C[1]) ? 0 : 1;
          acc[k][0] += p.c[0] * p.w; acc[k][1] += p.c[1] * p.w;
          acc[k][2] += p.c[2] * p.w; acc[k][3] += p.w;
        }
        C = acc.map((a, k) => (a[3] ? [a[0] / a[3], a[1] / a[3], a[2] / a[3]] : C[k]));
      }
      this.centers = C;
    }
    for (const [id, s] of this.samples) {
      const c = [s.r / s.n, s.g / s.n, s.b / s.n];
      this.assign.set(id, d2(c, this.centers[0]) <= d2(c, this.centers[1]) ? 0 : 1);
    }
  }

  teamOf(id) {
    return this.assign.has(id) ? this.assign.get(id) : -1;
  }

  colors() {
    return this.centers.map((c) => `rgb(${c.map(Math.round).join(',')})`);
  }
}
