import { CONFIG } from './config.js';
import { Detector } from './detector.js';
import { ByteTracker } from './tracker.js';
import { MotionEstimator } from './motion.js';
import { ColorBook, torsoColor, CAT_A, CAT_B } from './teams.js';
import { analyzeMatch } from './analysis.js';
import { buildTrackInfo, Identity } from './identity.js';
import { LabelingUI } from './labeling.js';
import { buildReport, fmtTime } from './report.js';
import { saveSession, listSessions, loadSession, deleteSession, packFrames, unpackFrames } from './store.js';
import { drawDetections, drawPickBoxes, drawTimeline } from './draw.js';

const $ = (s) => document.querySelector(s);
const video = $('#video');
const overlay = $('#overlay');
const octx = overlay.getContext('2d');
const timeline = $('#timeline');
const tctx = timeline.getContext('2d');

const CAT_LABEL = ['チームA', 'チームB', '除外'];
const IDENT_OPT = { maxGap: CONFIG.labeling.maxGap, maxSpeed: CONFIG.labeling.maxSpeed, playerHeight: CONFIG.analysis.playerHeight };

const state = {
  book: new ColorBook(CONFIG.color),
  pickCat: null, tap: null, picked: null,
  running: false, cancel: false, detector: null,
  session: null, frames: null, tracks: null, identity: null,
  result: null, keyMap: new Map(), reportText: '',
  colors: ['rgb(232,115,44)', 'rgb(47,107,208)'],
  preview: null, tlCache: null, focus: null, wakeLock: null,
  file: null,
};

const work = document.createElement('canvas');
const wctx = work.getContext('2d', { willReadFrequently: true });
const thumbCanvas = document.createElement('canvas');
const thumbCtx = thumbCanvas.getContext('2d');

// ---------- 共通 ----------
function parseTime(str, fallback) {
  const v = String(str || '').trim().replace('：', ':');
  if (!v) return fallback;
  const parts = v.split(':').map(Number);
  if (parts.some((x) => !isFinite(x))) return fallback;
  return parts.reduce((a, x) => a * 60 + x, 0);
}
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function setStep(n) {
  document.querySelectorAll('.step').forEach((el) => el.classList.toggle('is-locked', Number(el.dataset.step) > n));
}
function setStatus(text, isError = false) {
  const el = $('#status');
  el.textContent = text;
  el.classList.toggle('is-error', isError);
}
function setHint(text, isError = false) {
  const el = $('#pickHint');
  el.textContent = text;
  el.classList.toggle('is-error', isError);
}
function seekTo(t) {
  return new Promise((resolve) => {
    const done = () => { video.removeEventListener('seeked', done); resolve(); };
    video.addEventListener('seeked', done);
    video.currentTime = t;
  });
}
function teamNames() {
  return [$('#nameA').value.trim() || 'チームA', $('#nameB').value.trim() || 'チームB'];
}
function attackSel() {
  const v = $('#attackDir').value;
  return v === 'right' ? 1 : v === 'left' ? -1 : null;
}
async function ensureModel() {
  if (state.detector) return;
  const prev = $('#pickHint').textContent;
  setHint('AIモデルを読み込んでいます…');
  const d = new Detector();
  await d.load(CONFIG.modelUrl);
  state.detector = d;
  setHint(prev);
}
function drawWork() {
  if (work.width !== video.videoWidth || work.height !== video.videoHeight) {
    work.width = video.videoWidth;
    work.height = video.videoHeight;
  }
  wctx.drawImage(video, 0, 0, work.width, work.height);
}
function videoMatchesSession() {
  const s = state.session;
  return !!(s && state.file && video.videoWidth && s.video.name === state.file.name && s.video.size === state.file.size);
}
function refreshStep() {
  if (state.identity) { setStep(5); return; }
  if (!video.src || !video.videoWidth) { setStep(1); return; }
  if (!state.book.ready()) { setStep(2); return; }
  setStep(3);
}

// ---------- 1. 動画を選ぶ ----------
function loadVideo(file) {
  if (state.running || !file) return;
  if (video.src) URL.revokeObjectURL(video.src);
  state.file = file;
  video.src = URL.createObjectURL(file);
  $('#fileName').textContent = file.name;
  state.tap = null;
  setStatus('');
}
$('#file').addEventListener('change', (e) => loadVideo(e.target.files[0]));
const screen = $('#screen');
screen.addEventListener('dragover', (e) => { e.preventDefault(); screen.classList.add('is-dragging'); });
screen.addEventListener('dragleave', () => screen.classList.remove('is-dragging'));
screen.addEventListener('drop', (e) => {
  e.preventDefault();
  screen.classList.remove('is-dragging');
  const f = [...e.dataTransfer.files].find((x) => x.type.startsWith('video/'));
  if (f) loadVideo(f);
});
video.addEventListener('loadedmetadata', () => {
  overlay.width = video.videoWidth;
  overlay.height = video.videoHeight;
  screen.style.aspectRatio = `${video.videoWidth} / ${video.videoHeight}`;
  screen.classList.add('has-video');
  if (state.session && videoMatchesSession()) {
    setStatus('保存した解析と同じ動画です。場面の確認ができます。');
  } else {
    if (state.session) setStatus('開いている解析とは別の動画です。新しく解析するには、色を登録して「解析を開始」を押してください。');
    $('#rangeStart').value = '0:00';
    $('#rangeEnd').value = fmtTime(video.duration);
  }
  updateEstimate();
  refreshStep();
  setHint('選手がはっきり映った場面で一時停止し、ボタンを押してからその人をタップします。');
});
function updateEstimate() {
  if (!video.duration) return;
  const s = parseTime($('#rangeStart').value, 0), e = parseTime($('#rangeEnd').value, video.duration);
  const len = Math.max(0, Math.min(video.duration, e) - s);
  $('#rangeNote').textContent = `解析する長さ：${fmtTime(len)}。スマホでは5〜10分ずつに区切るのがおすすめです。前半・後半は分けて解析してください。`;
}
$('#rangeStart').addEventListener('input', updateEstimate);
$('#rangeEnd').addEventListener('input', updateEstimate);

// 保存した解析
async function renderSaved() {
  const box = $('#saved');
  try {
    const list = await listSessions();
    if (!list.length) { box.hidden = true; return; }
    box.hidden = false;
    $('#savedList').innerHTML = list.map((s) => `
      <li data-id="${escapeHtml(s.id)}">
        <span class="saved-name">${escapeHtml(s.memo || s.video?.name || '解析')}</span>
        <span class="muted small">${escapeHtml(s.video?.name || '')}　${fmtTime(s.range?.[0])}〜${fmtTime(s.range?.[1])}　${new Date(s.updatedAt).toLocaleDateString('ja-JP')}</span>
        <span class="saved-actions">
          <button type="button" class="linkish" data-open>開く</button>
          <button type="button" class="linkish danger" data-del>削除</button>
        </span>
      </li>`).join('');
  } catch {
    box.hidden = true;
  }
}
$('#savedList').addEventListener('click', async (e) => {
  const li = e.target.closest('[data-id]');
  if (!li || state.running) return;
  const id = li.dataset.id;
  if (e.target.closest('[data-del]')) {
    if (!confirm('この解析結果を削除しますか？番号付けの内容も消えます。')) return;
    await deleteSession(id);
    if (state.session?.id === id) location.reload();
    renderSaved();
  } else if (e.target.closest('[data-open]')) {
    const s = await loadSession(id);
    if (s) openSession(s);
  }
});

function openSession(s) {
  state.session = s;
  state.frames = unpackFrames(s.packed);
  state.tracks = new Map(s.tracks.map((t) => [t.id, t]));
  state.identity = new Identity(state.tracks, s.identity, IDENT_OPT);
  state.book.restore(s.book);
  state.colors = s.colors;
  $('#nameA').value = s.teamNames?.[0] || '';
  $('#nameB').value = s.teamNames?.[1] || '';
  $('#memo').value = s.memo || '';
  $('#attackDir').value = s.attackDir || 'auto';
  $('#rangeStart').value = fmtTime(s.range[0]);
  $('#rangeEnd').value = fmtTime(s.range[1]);
  renderChips();
  setStatus(videoMatchesSession()
    ? '保存した解析を開きました。'
    : `保存した解析を開きました。場面を確認するには、ステップ1で動画「${s.video.name}」を選んでください。`);
  $('#results').hidden = false;
  recompute();
  refreshStep();
  $('#results').scrollIntoView({ behavior: 'smooth' });
}

// ---------- 2. チームの色を登録 ----------
document.querySelectorAll('[data-cat]').forEach((btn) => {
  btn.addEventListener('click', async () => {
    if (!video.src || state.running) return;
    video.pause();
    const cat = Number(btn.dataset.cat);
    try {
      await ensureModel();
      const t = video.currentTime;
      if (!state.tap || Math.abs(state.tap.t - t) > 0.001) {
        drawWork();
        const det = await state.detector.detect(work);
        state.tap = { t, boxes: det.persons.filter((d) => d.score >= 0.3).map((d) => d.box) };
      }
    } catch (err) {
      console.error(err);
      setHint(`エラー：${err.message || err}`, true);
      return;
    }
    state.pickCat = cat;
    state.picked = null;
    overlay.classList.add('is-picking');
    document.querySelectorAll('[data-cat]').forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
    setHint(state.tap.boxes.length
      ? `映像の中の「${CAT_LABEL[cat]}」の人をタップしてください。`
      : 'この場面では人が見つかりませんでした。別の場面で一時停止してからもう一度押してください。', !state.tap.boxes.length);
  });
});

overlay.addEventListener('pointerdown', (e) => {
  if (state.pickCat === null || !state.tap) return;
  const r = overlay.getBoundingClientRect();
  const x = ((e.clientX - r.left) / r.width) * overlay.width;
  const y = ((e.clientY - r.top) / r.height) * overlay.height;
  let hit = null, bestArea = Infinity, bestD = Infinity, nearest = null;
  for (const b of state.tap.boxes) {
    const inside = x >= b[0] && x <= b[2] && y >= b[1] && y <= b[3];
    const area = (b[2] - b[0]) * (b[3] - b[1]);
    if (inside && area < bestArea) { hit = b; bestArea = area; }
    const d = Math.hypot((b[0] + b[2]) / 2 - x, (b[1] + b[3]) / 2 - y) / (b[3] - b[1]);
    if (d < bestD) { bestD = d; nearest = b; }
  }
  if (!hit && bestD < 0.8) hit = nearest;
  if (!hit) { setHint('人が見つかりませんでした。白い枠の中をタップしてください。', true); return; }
  const rgb = torsoColor(wctx, hit);
  if (!rgb) { setHint('この人は小さすぎて色が取れません。大きく映っている人をタップしてください。', true); return; }
  const cat = state.pickCat;
  state.book.add(cat, rgb);
  state.picked = { box: hit, until: performance.now() + 900 };
  state.pickCat = null;
  overlay.classList.remove('is-picking');
  document.querySelectorAll('[data-cat]').forEach((b) => b.setAttribute('aria-pressed', 'false'));
  renderChips();
  const need = [CAT_A, CAT_B].filter((c) => state.book.count(c) === 0).map((c) => CAT_LABEL[c]);
  setHint(need.length
    ? `「${CAT_LABEL[cat]}」の色を登録しました。続けて${need.join('と')}を登録してください。`
    : `「${CAT_LABEL[cat]}」の色を登録しました。ゴールキーパーや審判、ビブスの控えなども登録しておくと精度が上がります。`);
  refreshStep();
});

function renderChips() {
  $('#chips').innerHTML = state.book.samples.map((s, i) => `
    <li class="chip">
      <span class="swatch" style="--c:rgb(${s.rgb.map(Math.round).join(',')})"></span>${CAT_LABEL[s.cat]}
      <button type="button" data-remove="${i}" aria-label="${CAT_LABEL[s.cat]}の色を削除">×</button>
    </li>`).join('');
}
$('#chips').addEventListener('click', (e) => {
  const b = e.target.closest('[data-remove]');
  if (!b) return;
  state.book.remove(Number(b.dataset.remove));
  renderChips();
  refreshStep();
});

// 名前・メモ・攻撃方向は解析後に変えてもレポートに反映
for (const sel of ['#nameA', '#nameB', '#memo']) {
  $(sel).addEventListener('input', () => {
    if (!state.identity) return;
    labeling.render();
    renderAfterChange();
    scheduleSave();
  });
}
$('#attackDir').addEventListener('change', () => { if (state.identity) { recompute(); scheduleSave(); } });

// ---------- 3. 解析 ----------
$('#runBtn').addEventListener('click', async () => {
  if (state.running) { state.cancel = true; return; }
  if (!state.book.ready()) return;
  if (state.identity && !confirm('今開いている解析結果は保存されています。新しく解析を始めますか？')) return;
  state.running = true;
  state.cancel = false;
  state.pickCat = null;
  overlay.classList.remove('is-picking');
  $('#runBtn').textContent = '解析を中止';
  try {
    if ('wakeLock' in navigator) state.wakeLock = await navigator.wakeLock.request('screen');
  } catch { /* 画面スリープ防止に非対応でも続行 */ }
  try {
    await runAnalysis();
  } catch (err) {
    console.error(err);
    setStatus(`${err.message || err}`, true);
  } finally {
    state.running = false;
    state.preview = null;
    $('#runBtn').textContent = '解析を開始';
    if (state.wakeLock) { state.wakeLock.release().catch(() => {}); state.wakeLock = null; }
  }
});
document.addEventListener('visibilitychange', async () => {
  if (state.running && document.visibilityState === 'visible' && 'wakeLock' in navigator) {
    try { state.wakeLock = await navigator.wakeLock.request('screen'); } catch { /* 無視 */ }
  }
});

function isolated(box, boxes) {
  const area = (box[2] - box[0]) * (box[3] - box[1]);
  for (const b of boxes) {
    if (b === box) continue;
    const ix = Math.max(0, Math.min(box[2], b[2]) - Math.max(box[0], b[0]));
    const iy = Math.max(0, Math.min(box[3], b[3]) - Math.max(box[1], b[1]));
    if (ix * iy > area * 0.12) return false;
  }
  return true;
}
function cropThumb(box) {
  const [x1, y1, x2, y2] = box;
  const w = x2 - x1, h = y2 - y1;
  const sx = Math.max(0, x1 - w * 0.15), sy = Math.max(0, y1 - h * 0.06);
  const sw = Math.min(work.width - sx, w * 1.3), sh = Math.min(work.height - sy, h * 1.12);
  const H = CONFIG.labeling.thumbHeight;
  const W = Math.max(1, Math.round((sw / sh) * H));
  thumbCanvas.width = W; thumbCanvas.height = H;
  thumbCtx.imageSmoothingQuality = 'high';
  thumbCtx.drawImage(work, sx, sy, sw, sh, 0, 0, W, H);
  return thumbCanvas.toDataURL('image/jpeg', 0.78);
}

async function runAnalysis() {
  if (!state.detector) {
    setStatus('AIモデルを読み込んでいます…');
    state.detector = new Detector();
    await state.detector.load(CONFIG.modelUrl);
  }
  const backend = state.detector.backend === 'webgpu' ? 'GPU' : 'CPU';
  const start = Math.max(0, parseTime($('#rangeStart').value, 0));
  const end = Math.min(video.duration, parseTime($('#rangeEnd').value, video.duration));
  if (end - start < 3) throw new Error('解析範囲が短すぎます。開始と終了を確認してください。');

  video.pause();
  const fps = CONFIG.sampleFps;
  const book = state.book;
  book.resetVotes();
  const tracker = new ByteTracker(CONFIG.tracker);
  const motion = new MotionEstimator(CONFIG.motion.width, CONFIG.motion.maxScale);
  let A = { S: 1, Tx: 0, Ty: 0 }; // 今のコマ → 基準（カメラの動きを打ち消した座標）
  const toWorld = ([x, y]) => [A.S * x + A.Tx, A.S * y + A.Ty];
  const toFrame = ([x, y]) => [(x - A.Tx) / A.S, (y - A.Ty) / A.S];
  const foot = (b) => [(b[0] + b[2]) / 2, b[3]];

  const step = 1 / fps;
  const total = Math.floor((end - start) / step) + 1;
  const frames = [];
  const thumbs = new Map(); // id -> [{t, h, url}]
  const lastThumbAt = new Map();
  let lastBall = null;
  const t0 = performance.now();
  const bar = $('#progress');
  const L = CONFIG.labeling;

  for (let i = 0; i < total; i++) {
    if (state.cancel) throw new Error('解析を中止しました。');
    const t = start + i * step;
    await seekTo(t);
    drawWork();
    const det = await state.detector.detect(work);

    const cam = motion.estimate(work, det.persons.map((d) => d.box));
    if (i > 0 && cam.ok) {
      A = { S: A.S / cam.s, Tx: A.Tx - (A.S * cam.tx) / cam.s, Ty: A.Ty - (A.S * cam.ty) / cam.s };
    }
    const tracks = tracker.update(det.persons, i, i > 0 ? cam : null);
    if (i % 2 === 0) for (const tr of tracks) book.vote(tr.id, torsoColor(wctx, tr.box));
    const players = tracks.map((tr) => ({
      id: tr.id, box: tr.box, w: toWorld(foot(tr.box)), wh: (tr.box[3] - tr.box[1]) * A.S,
    }));

    // 番号付け用の写真：大きく・ほかの人と重ならずに映ったときを残す
    const boxes = tracks.map((tr) => tr.box);
    for (const tr of tracks) {
      const h = tr.box[3] - tr.box[1];
      if (h < L.thumbMinPx || !book.maybePlayer(tr.id) || !isolated(tr.box, boxes)) continue;
      if (t - (lastThumbAt.get(tr.id) ?? -99) < L.thumbInterval) continue;
      const list = thumbs.get(tr.id) || [];
      const worst = list.reduce((m, x) => (!m || x.h < m.h ? x : m), null);
      if (list.length < L.thumbsPerTrack && list.every((x) => Math.abs(x.t - t) >= L.thumbSpacing)) {
        list.push({ t, h, url: cropThumb(tr.box) });
      } else if (worst && h > worst.h * 1.15
        && list.filter((x) => x !== worst).every((x) => Math.abs(x.t - t) >= L.thumbSpacing)) {
        list[list.indexOf(worst)] = { t, h, url: cropThumb(tr.box) };
      } else continue;
      thumbs.set(tr.id, list);
      lastThumbAt.set(tr.id, t);
    }

    // 試合球を選ぶ：前のボール位置からの予測に近く、選手の近くにあるもの
    const live = tracks.filter((tr) => book.maybePlayer(tr.id));
    const hs = live.map((tr) => tr.box[3] - tr.box[1]).sort((a, b) => a - b);
    const hRef = hs.length ? hs[hs.length >> 1] : video.videoHeight / 8;
    const pred = lastBall && i - lastBall.i <= fps
      ? toFrame([lastBall.w[0] + lastBall.v[0] * (i - lastBall.i), lastBall.w[1] + lastBall.v[1] * (i - lastBall.i)])
      : null;
    let best = null, bestCost = Infinity;
    for (const b of det.balls) {
      const f = foot(b.box);
      let nearP = Infinity;
      for (const tr of live) {
        const h = tr.box[3] - tr.box[1];
        const ft = foot(tr.box);
        nearP = Math.min(nearP, Math.hypot(f[0] - ft[0], f[1] - ft[1]) / h);
      }
      let cost;
      if (pred) {
        const d = Math.hypot(f[0] - pred[0], f[1] - pred[1]) / hRef;
        if (d > 4 && nearP > 1.5) continue;
        cost = d * 0.7 + Math.min(nearP, 5) * 0.3 - b.score * 2;
      } else {
        if (nearP > 2) continue;
        cost = nearP - b.score * 2;
      }
      if (cost < bestCost) { bestCost = cost; best = b; }
    }
    let ball = null;
    if (best) {
      const w = toWorld(foot(best.box));
      if (lastBall && i - lastBall.i <= fps) {
        const g = i - lastBall.i;
        const v = [(w[0] - lastBall.w[0]) / g, (w[1] - lastBall.w[1]) / g];
        lastBall = { w, i, v: [0.5 * lastBall.v[0] + 0.5 * v[0], 0.5 * lastBall.v[1] + 0.5 * v[1]] };
      } else {
        lastBall = { w, i, v: [0, 0] };
      }
      ball = { box: best.box, w, score: best.score };
    }

    const frame = { t, players, ball };
    frames.push(frame);
    state.preview = frame;

    const done = (i + 1) / total;
    bar.value = done;
    const elapsed = (performance.now() - t0) / 1000;
    const remain = (elapsed / (i + 1)) * (total - i - 1);
    setStatus(`解析中（${backend}）… ${Math.round(done * 100)}%　残り約${fmtTime(remain)}`);
  }

  // 追跡IDごとの情報（除外された人の写真は捨てる）
  const autoTeam = (id) => book.teamOf(id);
  const info = buildTrackInfo(frames, fps, autoTeam, { rgb: book.meanRgb(), thumbs });
  for (const tr of info.values()) {
    if (tr.autoTeam < 0 && tr.time < 6) tr.thumbs = [];
  }

  state.colors = book.colors();
  state.frames = frames;
  state.tracks = info;
  state.identity = new Identity(info, null, IDENT_OPT);
  state.session = {
    id: (crypto.randomUUID ? crypto.randomUUID() : String(Date.now())),
    createdAt: Date.now(),
    video: { name: state.file?.name || '', size: state.file?.size || 0, duration: video.duration },
    range: [start, end], fps,
    colors: state.colors,
    book: book.serialize(),
    packed: packFrames(frames),
    tracks: [...info.values()],
  };
  $('#results').hidden = false;
  recompute();
  const ballPct = Math.round(state.result.ballDetected * 100);
  setStatus(`解析が完了しました。ボールが見つかったコマは${ballPct}%でした。続けて選手に番号を付けてください。`);
  refreshStep();
  await saveNow();
  renderSaved();
  await seekTo(start);
  $('#labeling').scrollIntoView({ behavior: 'smooth' });
}

// ---------- 番号付け・再計算 ----------
const labeling = new LabelingUI({
  tabs: $('#lbTabs'), onlyEmpty: $('#lbOnlyEmpty'), suggest: $('#lbSuggest'),
  cards: $('#lbCards'), more: $('#lbMore'), progress: $('#lbProgress'),
}, {
  getIdentity: () => state.identity,
  getTeamNames: teamNames,
  getColors: () => state.colors,
  minTime: CONFIG.labeling.minTime,
  onChange: () => { recompute(false); scheduleSave(); },
  onShow: (g) => showGroup(g),
});

function teamOfKey(key) {
  if (key.startsWith('G')) return state.identity.groupMap().get(Number(key.slice(1)))?.team ?? -1;
  return Number(key.split(':')[0]);
}
function labelOfKey(key) {
  if (!key) return null;
  if (key.startsWith('G')) return { team: teamOfKey(key), num: '' };
  const [t, n] = key.split(':');
  return { team: Number(t), num: n };
}

function recompute(renderLabels = true) {
  const id = state.identity;
  state.keyMap = new Map();
  for (const trId of state.tracks.keys()) state.keyMap.set(trId, id.keyOfTrack(trId));
  const keyed = state.frames.map((f) => ({
    t: f.t, ball: f.ball,
    players: f.players.map((p) => { const k = state.keyMap.get(p.id); return k ? { ...p, id: k } : null; }).filter(Boolean),
  }));
  state.result = analyzeMatch(keyed, {
    ...CONFIG.analysis, fps: state.session.fps, teamOf: teamOfKey, attackDirA: attackSel(),
  });
  if (renderLabels) labeling.render();
  renderAfterChange();
}

function renderAfterChange() {
  const r = state.result;
  if (!r) return;
  const names = teamNames();
  $('#legendA').innerHTML = `<span class="swatch" style="--c:${state.colors[0]}"></span>${escapeHtml(names[0])}の保持`;
  $('#legendB').innerHTML = `<span class="swatch" style="--c:${state.colors[1]}"></span>${escapeHtml(names[1])}の保持`;
  $('#tlStart').textContent = fmtTime(state.session.range[0]);
  $('#tlEnd').textContent = fmtTime(state.session.range[1]);
  $('#ballWarn').hidden = r.ballDetected >= 0.3;
  buildTimeline();
  const rep = buildReport({
    result: r, times: state.frames.map((f) => f.t), range: state.session.range,
    teamNames: names, colors: state.colors, memo: $('#memo').value.trim(),
    videoName: state.session.video.name, labelOf: labelOfKey, cfg: CONFIG.report,
  });
  $('#report').innerHTML = rep.html;
  state.reportText = rep.text;
}

let saveTimer = null;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 800);
}
async function saveNow() {
  const s = state.session;
  if (!s) return;
  s.identity = state.identity.serialize();
  s.teamNames = teamNames();
  s.memo = $('#memo').value.trim();
  s.attackDir = $('#attackDir').value;
  try {
    await saveSession(s);
    $('#saveState').textContent = 'この端末に保存済み';
  } catch (err) {
    console.error(err);
    $('#saveState').textContent = '保存できませんでした（プライベートブラウズでは保存されません）';
  }
}

function showGroup(g) {
  if (!videoMatchesSession()) {
    alert(`場面を確認するには、ステップ1で動画「${state.session.video.name}」を選んでください。`);
    return;
  }
  const best = g.showAt ?? (g.thumbs[0]?.t ?? g.t0);
  video.pause();
  video.currentTime = Math.max(0, best);
  state.focus = { ids: new Set(g.ids), until: performance.now() + 8000 };
  screen.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ---------- タイムライン ----------
function buildTimeline() {
  if (!state.result) return;
  const dpr = window.devicePixelRatio || 1;
  const cssW = timeline.clientWidth || 600;
  const cssH = 72;
  timeline.style.height = `${cssH}px`;
  timeline.width = Math.round(cssW * dpr);
  timeline.height = Math.round(cssH * dpr);
  const cache = document.createElement('canvas');
  cache.width = timeline.width;
  cache.height = timeline.height;
  const css = getComputedStyle(timeline);
  const ink = css.getPropertyValue('--tl-ink').trim() || '#16241B';
  const geo = drawTimeline(cache, {
    frames: state.frames, result: state.result, colors: state.colors,
    t0: state.session.range[0], t1: state.session.range[1], dpr,
    track: css.getPropertyValue('--tl-track').trim() || '#DDE5DF', ink,
  });
  state.tlCache = { canvas: cache, pad: geo.pad, dpr, ink };
}
window.addEventListener('resize', buildTimeline);
window.matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', buildTimeline);
timeline.addEventListener('click', (e) => {
  if (!state.tlCache || !videoMatchesSession()) return;
  const r = timeline.getBoundingClientRect();
  const { pad, dpr } = state.tlCache;
  const f = ((e.clientX - r.left) * dpr - pad) / (timeline.width - 2 * pad);
  const [t0, t1] = state.session.range;
  video.currentTime = t0 + Math.min(1, Math.max(0, f)) * (t1 - t0);
});

// レポート内の時刻 → 再生
$('#report').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-t]');
  if (!b) return;
  if (!videoMatchesSession()) {
    alert(`場面を再生するには、ステップ1で動画「${state.session.video.name}」を選んでください。`);
    return;
  }
  video.currentTime = Math.max(0, Number(b.dataset.t) - 2);
  video.play();
  screen.scrollIntoView({ behavior: 'smooth', block: 'start' });
});

// ---------- ステップ4・5のボタン ----------
$('#goLabel').addEventListener('click', () => $('#labeling').scrollIntoView({ behavior: 'smooth' }));
$('#goReport').addEventListener('click', () => $('#reportBox').scrollIntoView({ behavior: 'smooth' }));
$('#printBtn').addEventListener('click', () => window.print());
$('#copyBtn').addEventListener('click', async () => {
  const text = state.reportText;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  $('#copyState').textContent = 'コピーしました。LINEやメールに貼り付けられます。';
  setTimeout(() => { $('#copyState').textContent = ''; }, 4000);
});

// ---------- 再生中の重ね描き ----------
function frameIndexAt(t) {
  const fr = state.frames;
  if (!fr || !fr.length) return -1;
  let lo = 0, hi = fr.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (fr[mid].t <= t) lo = mid; else hi = mid - 1;
  }
  const tol = 1.5 / (state.session?.fps || CONFIG.sampleFps);
  if (Math.abs(fr[lo].t - t) <= tol) return lo;
  if (lo + 1 < fr.length && Math.abs(fr[lo + 1].t - t) <= tol) return lo + 1;
  return -1;
}

function tick() {
  if (overlay.width) {
    octx.clearRect(0, 0, overlay.width, overlay.height);
    const t = video.currentTime;
    if (state.running && state.preview) {
      drawDetections(octx, state.preview, { info: null, colors: state.colors });
    } else if (state.pickCat !== null || (state.picked && performance.now() < state.picked.until)) {
      if (state.tap) drawPickBoxes(octx, state.tap.boxes, state.picked);
    } else if (state.result && videoMatchesSession()) {
      const i = frameIndexAt(t);
      const focus = state.focus && performance.now() < state.focus.until ? state.focus.ids : null;
      if (i >= 0 && ($('#showBoxes').checked || focus)) {
        drawDetections(octx, state.frames[i], {
          info: (id) => state.identity.infoOfTrack(id),
          keyOf: (id) => state.keyMap.get(id),
          colors: state.colors,
          ownerKey: state.result.ownerId[i],
          showExcluded: $('#showExcluded').checked,
          focusIds: focus,
        });
      }
    }
    if (state.tlCache) {
      tctx.clearRect(0, 0, timeline.width, timeline.height);
      tctx.drawImage(state.tlCache.canvas, 0, 0);
      const [t0, t1] = state.session.range;
      if (videoMatchesSession() && t >= t0 && t <= t1) {
        const { pad, dpr, ink } = state.tlCache;
        const x = pad + ((t - t0) / (t1 - t0)) * (timeline.width - 2 * pad);
        tctx.fillStyle = ink;
        tctx.fillRect(x - dpr, 0, 2 * dpr, timeline.height);
      }
    }
  }
  requestAnimationFrame(tick);
}
video.addEventListener('play', () => { if (state.focus) state.focus.until = Math.min(state.focus.until, performance.now() + 3000); });
requestAnimationFrame(tick);

// ---------- 書き出し ----------
function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
$('#exportCsv').addEventListener('click', () => {
  const r = state.result;
  if (!r) return;
  const names = teamNames();
  const head = ['チーム', '番号', '出場秒', 'ボールタッチ', 'パス成功', 'パス試行', 'シュート', 'ボール奪取', 'ドリブル'];
  const lines = r.players.map((p) => {
    const l = labelOfKey(p.id);
    return [names[p.team], l?.num || '番号なし', p.time.toFixed(1), p.touches, p.passes, p.passAttempts, p.shots, p.steals, p.dribbles].join(',');
  });
  download('players.csv', '\uFEFF' + [head.join(','), ...lines].join('\n'), 'text/csv');
});
$('#exportJson').addEventListener('click', () => {
  const r = state.result;
  if (!r) return;
  download('analysis.json', JSON.stringify({
    range: state.session.range, teamNames: teamNames(), teamColors: state.colors,
    teams: r.teams, players: r.players, events: r.events, segments: r.segments,
  }, null, 2), 'application/json');
});

setStep(1);
renderSaved();
