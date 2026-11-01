// ByteTrack の考え方（高スコア→低スコアの2段階対応付け）を軽量に実装した追跡器。
// 動き予測は等速モデル、対応付けは IoU と中心距離を組み合わせた類似度の貪欲法。

class Track {
  constructor(id, box, score, frame) {
    this.id = id;
    this.box = box.slice();
    this.vel = [0, 0, 0, 0];
    this.score = score;
    this.hits = 1;
    this.lastFrame = frame;
    this.confirmed = false;
  }
  predicted(frame) {
    const dt = Math.min(10, frame - this.lastFrame);
    return this.box.map((v, k) => v + this.vel[k] * dt);
  }
  update(box, score, frame, minHits) {
    const dt = Math.max(1, frame - this.lastFrame);
    for (let k = 0; k < 4; k++) {
      const inst = (box[k] - this.box[k]) / dt;
      this.vel[k] = this.hits > 1 ? 0.6 * this.vel[k] + 0.4 * inst : inst;
    }
    this.box = box.slice();
    this.score = score;
    this.lastFrame = frame;
    this.hits++;
    if (this.hits >= minHits) this.confirmed = true;
  }
}

function iou(a, b) {
  const ix = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
  const iy = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  const inter = ix * iy;
  const u = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter;
  return u > 0 ? inter / u : 0;
}

function similarity(a, b) {
  const ah = Math.max(1, a[3] - a[1]);
  const bh = Math.max(1, b[3] - b[1]);
  if (Math.max(ah, bh) / Math.min(ah, bh) > 1.7) return 0; // 大きさが違いすぎる（子どもと大人など）
  const d = Math.hypot((a[0] + a[2] - b[0] - b[2]) / 2, (a[1] + a[3] - b[1] - b[3]) / 2);
  const prox = Math.max(0, 1 - d / ah);
  return 0.6 * iou(a, b) + 0.4 * prox;
}

function greedyMatch(tracks, dets, frame, thresh) {
  const pairs = [];
  for (let i = 0; i < tracks.length; i++) {
    const p = tracks[i].predicted(frame);
    for (let j = 0; j < dets.length; j++) {
      const s = similarity(p, dets[j].box);
      if (s >= thresh) pairs.push([s, i, j]);
    }
  }
  pairs.sort((x, y) => y[0] - x[0]);
  const usedT = new Set(), usedD = new Set(), matches = [];
  for (const [, i, j] of pairs) {
    if (usedT.has(i) || usedD.has(j)) continue;
    usedT.add(i); usedD.add(j);
    matches.push([i, j]);
  }
  return {
    matches,
    unT: tracks.map((_, i) => i).filter((i) => !usedT.has(i)),
    unD: dets.map((_, j) => j).filter((j) => !usedD.has(j)),
  };
}

export class ByteTracker {
  constructor(opt) {
    this.opt = opt;
    this.tracks = [];
    this.nextId = 1;
  }

  // dets: [{box, score}] / frame: 通し番号。今コマで確認できた確定トラックを返す。
  update(dets, frame) {
    const { highThresh, matchThresh, lowMatchThresh, maxMissed, minHits } = this.opt;
    const high = dets.filter((d) => d.score >= highThresh);
    const low = dets.filter((d) => d.score < highThresh);

    // 1段目：全トラック × 高スコア検出
    const m1 = greedyMatch(this.tracks, high, frame, matchThresh);
    for (const [i, j] of m1.matches) this.tracks[i].update(high[j].box, high[j].score, frame, minHits);

    // 2段目：残ったトラック × 低スコア検出（隠れかけの選手を拾う）
    const rest = m1.unT.map((i) => this.tracks[i]);
    const m2 = greedyMatch(rest, low, frame, lowMatchThresh);
    for (const [i, j] of m2.matches) rest[i].update(low[j].box, low[j].score, frame, minHits);

    // 新規トラック（高スコアのみ）
    for (const j of m1.unD) {
      this.tracks.push(new Track(this.nextId++, high[j].box, high[j].score, frame));
    }

    // 古いトラックを削除（未確定は早めに消す）
    this.tracks = this.tracks.filter((t) => {
      const missed = frame - t.lastFrame;
      return t.confirmed ? missed <= maxMissed : missed <= 2;
    });

    return this.tracks
      .filter((t) => t.confirmed && t.lastFrame === frame)
      .map((t) => ({ id: t.id, box: t.box.slice(), score: t.score }));
  }
}
