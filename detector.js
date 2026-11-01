// YOLO (ONNX) をブラウザで実行する検出器。WebGPU が使えればGPU、なければWASM(CPU)。
import { CONFIG } from './config.js';

export class Detector {
  constructor() {
    this.session = null;
    this.backend = '';
    this.S = CONFIG.inputSize;
    this.canvas = document.createElement('canvas');
    this.canvas.width = this.S;
    this.canvas.height = this.S;
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    this.buf = new Float32Array(3 * this.S * this.S);
  }

  async load(url) {
    if (typeof ort === 'undefined') {
      throw new Error('ONNX Runtime を読み込めませんでした。ネットワーク接続を確認してください。');
    }
    ort.env.wasm.wasmPaths = CONFIG.ortWasmPath;
    ort.env.wasm.numThreads = self.crossOriginIsolated
      ? Math.min(4, navigator.hardwareConcurrency || 2)
      : 1;

    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`モデルが見つかりません（${url}）。README の手順で yolov8n.onnx を index.html と同じ場所に置いてください。`);
    }
    const bytes = new Uint8Array(await res.arrayBuffer());

    const attempts = 'gpu' in navigator ? [['webgpu'], ['wasm']] : [['wasm']];
    let lastErr = null;
    for (const eps of attempts) {
      try {
        this.session = await ort.InferenceSession.create(bytes.slice(), {
          executionProviders: eps,
          graphOptimizationLevel: 'all',
        });
        this.backend = eps[0];
        break;
      } catch (e) {
        lastErr = e;
      }
    }
    if (!this.session) throw lastErr;
    this.inName = this.session.inputNames[0];
    this.outName = this.session.outputNames[0];
  }

  // src: 映像1コマを描いたcanvas。戻り値 { persons:[{box,score}], balls:[{box,score}] }
  async detect(src) {
    const W = src.width, H = src.height;
    const nx = Math.max(1, CONFIG.tilesX);
    const ov = CONFIG.tileOverlap;
    const tw = nx === 1 ? W : W / (nx - (nx - 1) * ov);
    const all = [];
    for (let k = 0; k < nx; k++) {
      const x0 = nx === 1 ? 0 : Math.min(W - tw, k * tw * (1 - ov));
      const dets = await this.runRegion(src, x0, 0, tw, H);
      for (const d of dets) all.push(d);
    }
    return {
      persons: nms(all.filter((d) => d.cls === 'person'), CONFIG.nmsIou),
      balls: nms(all.filter((d) => d.cls === 'ball'), CONFIG.nmsIou),
    };
  }

  async runRegion(src, sx, sy, sw, sh) {
    const S = this.S;
    const r = Math.min(S / sw, S / sh);
    const nw = Math.round(sw * r), nh = Math.round(sh * r);
    const dx = Math.floor((S - nw) / 2), dy = Math.floor((S - nh) / 2);
    const c = this.ctx;
    c.fillStyle = 'rgb(114,114,114)';
    c.fillRect(0, 0, S, S);
    c.drawImage(src, sx, sy, sw, sh, dx, dy, nw, nh);

    const px = c.getImageData(0, 0, S, S).data;
    const buf = this.buf, plane = S * S;
    for (let i = 0, j = 0; i < plane; i++, j += 4) {
      buf[i] = px[j] / 255;
      buf[i + plane] = px[j + 1] / 255;
      buf[i + 2 * plane] = px[j + 2] / 255;
    }
    const tensor = new ort.Tensor('float32', buf, [1, 3, S, S]);
    const out = (await this.session.run({ [this.inName]: tensor }))[this.outName];

    // YOLOv8 の出力は [1, 4+クラス数, N]。転置版 [1, N, 4+クラス数] にも対応。
    const [, a, b] = out.dims;
    const data = out.data;
    const transposed = a > b;
    const C = transposed ? b : a;
    const N = transposed ? a : b;
    const get = transposed ? (ch, i) => data[i * C + ch] : (ch, i) => data[ch * N + i];
    const pc = 4 + CONFIG.classes.person;
    const bc = 4 + CONFIG.classes.ball;

    const dets = [];
    for (let i = 0; i < N; i++) {
      const ps = pc < C ? get(pc, i) : 0;
      const bs = bc < C ? get(bc, i) : 0;
      let cls = null, score = 0;
      if (ps >= CONFIG.personConf && ps >= bs) { cls = 'person'; score = ps; }
      else if (bs >= CONFIG.ballConf) { cls = 'ball'; score = bs; }
      else if (ps >= CONFIG.personConf) { cls = 'person'; score = ps; }
      if (!cls) continue;
      const cx = get(0, i), cy = get(1, i), w = get(2, i), h = get(3, i);
      dets.push({
        cls,
        score,
        box: [
          (cx - w / 2 - dx) / r + sx,
          (cy - h / 2 - dy) / r + sy,
          (cx + w / 2 - dx) / r + sx,
          (cy + h / 2 - dy) / r + sy,
        ],
      });
    }
    return dets;
  }
}

function overlap(a, b) {
  const ix = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
  const iy = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  const inter = ix * iy;
  const aa = (a[2] - a[0]) * (a[3] - a[1]);
  const ab = (b[2] - b[0]) * (b[3] - b[1]);
  const iou = inter / (aa + ab - inter + 1e-9);
  const iom = inter / (Math.min(aa, ab) + 1e-9); // 分割境界で切れた重複箱をまとめる
  return Math.max(iou, iom > 0.85 ? iom : 0);
}

function nms(dets, thr) {
  dets.sort((p, q) => q.score - p.score);
  const keep = [];
  for (const d of dets) {
    if (keep.every((k) => overlap(k.box, d.box) < thr)) keep.push(d);
  }
  return keep;
}
