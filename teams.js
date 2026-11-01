// タップで登録したユニフォームの色をもとに、人をチームA / チームB / 除外 に分ける。

export const CAT_A = 0, CAT_B = 1, CAT_X = 2; // X = 審判・控え・保護者など

function srgbToLinear(c) {
  c /= 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}
export function rgbToLab([r, g, b]) {
  const R = srgbToLinear(r), G = srgbToLinear(g), B = srgbToLinear(b);
  let x = (R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047;
  let y = R * 0.2126 + G * 0.7152 + B * 0.0722;
  let z = (R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883;
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  x = f(x); y = f(y); z = f(z);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}
// 明るさの差（日なた・日かげ）の影響を弱めた色の距離
export function labDist(a, b) {
  return Math.hypot((a[0] - b[0]) * 0.5, a[1] - b[1], a[2] - b[2]);
}

// 人物枠の胴体あたりの平均色（芝生っぽい緑は除く）
export function torsoColor(ctx, box) {
  const [x1, y1, x2, y2] = box;
  const w = x2 - x1, h = y2 - y1;
  if (h < 14 || w < 5) return null;
  const sx = Math.round(x1 + w * 0.28), sy = Math.round(y1 + h * 0.2);
  const sw = Math.max(1, Math.round(w * 0.44)), sh = Math.max(1, Math.round(h * 0.26));
  let px;
  try { px = ctx.getImageData(sx, sy, sw, sh).data; } catch { return null; }
  let r = 0, g = 0, b = 0, n = 0;
  for (let i = 0; i < px.length; i += 4) {
    const R = px[i], G = px[i + 1], B = px[i + 2];
    if (G > R + 12 && G > B + 12) continue;
    r += R; g += G; b += B; n++;
  }
  return n < 4 ? null : [r / n, g / n, b / n];
}

export class ColorBook {
  constructor(opt) {
    this.opt = opt;
    this.samples = []; // {cat, rgb, lab}
    this.votes = new Map(); // id -> [a, b, x, none]
  }

  add(cat, rgb) {
    this.samples.push({ cat, rgb, lab: rgbToLab(rgb) });
  }
  remove(index) { this.samples.splice(index, 1); }
  count(cat) { return this.samples.filter((s) => s.cat === cat).length; }
  ready() { return this.count(CAT_A) > 0 && this.count(CAT_B) > 0; }

  // 1回分の色を判定：0=A, 1=B, 2=除外, -1=どれでもない/あいまい
  classify(rgb) {
    if (!rgb) return -1;
    const lab = rgbToLab(rgb);
    const best = [Infinity, Infinity, Infinity];
    for (const s of this.samples) best[s.cat] = Math.min(best[s.cat], labDist(lab, s.lab));
    const order = [0, 1, 2].sort((p, q) => best[p] - best[q]);
    const d1 = best[order[0]], d2 = best[order[1]];
    if (d1 > this.opt.maxDist) return -1;
    if (d2 < Infinity && d1 > d2 * this.opt.ratio) return -1;
    return order[0];
  }

  resetVotes() { this.votes.clear(); this.rgbSum = new Map(); }

  vote(id, rgb) {
    if (rgb) {
      if (!this.rgbSum) this.rgbSum = new Map();
      const s = this.rgbSum.get(id) || [0, 0, 0, 0];
      s[0] += rgb[0]; s[1] += rgb[1]; s[2] += rgb[2]; s[3]++;
      this.rgbSum.set(id, s);
    }
    const c = this.classify(rgb);
    const v = this.votes.get(id) || [0, 0, 0, 0];
    v[c >= 0 ? c : 3]++;
    this.votes.set(id, v);
  }

  // 追跡IDのチーム：0=A, 1=B, -1=除外または不明
  teamOf(id) {
    const v = this.votes.get(id);
    if (!v) return -1;
    const total = v[0] + v[1] + v[2] + v[3];
    const k = v[0] >= v[1] ? 0 : 1;
    if (v[k] < this.opt.minVotes) return -1;
    if (v[k] < total * 0.45 || v[k] <= v[2]) return -1;
    return k;
  }

  // 解析途中の仮判定（ボール選びに使う）。除外が濃厚なら false
  maybePlayer(id) {
    const v = this.votes.get(id);
    if (!v) return true;
    return !(v[2] >= 2 && v[2] > v[0] + v[1]) && !(v[3] >= 4 && v[3] > 2 * (v[0] + v[1]));
  }

  // 追跡IDごとの平均の胴体色
  meanRgb() {
    const m = new Map();
    for (const [id, s] of this.rgbSum || []) m.set(id, [s[0] / s[3], s[1] / s[3], s[2] / s[3]]);
    return m;
  }

  // 保存用
  serialize() { return { samples: this.samples.map((s) => ({ cat: s.cat, rgb: s.rgb })), votes: [...this.votes] }; }
  restore(d) {
    this.samples = [];
    for (const s of d.samples || []) this.add(s.cat, s.rgb);
    this.votes = new Map(d.votes || []);
  }

  // チームの代表色（表示用）
  colors() {
    return [CAT_A, CAT_B].map((cat) => {
      const ss = this.samples.filter((s) => s.cat === cat);
      if (!ss.length) return cat === CAT_A ? 'rgb(232,115,44)' : 'rgb(47,107,208)';
      const m = [0, 1, 2].map((k) => Math.round(ss.reduce((a, s) => a + s.rgb[k], 0) / ss.length));
      return `rgb(${m.join(',')})`;
    });
  }
}
