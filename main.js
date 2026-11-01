import { CONFIG } from './config.js';
import { Detector } from './detector.js';
import { ByteTracker } from './tracker.js';
import { TeamClassifier } from './teams.js';
import { computeHomography, applyH, inPitch } from './pitch.js';
import { analyzeMatch } from './analysis.js';
import { buildCommentary, Commentator, teamName } from './commentary.js';
import {
  makePitchView, drawTurf, drawLines, drawHeat, drawRadar,
  drawProjectedPitch, drawCornerPoints, drawDetections,
} from './draw.js';

const $ = (s) => document.querySelector(s);
const video = $('#video');
const overlay = $('#overlay');
const octx = overlay.getContext('2d');
const radar = $('#radar');
const rctx = radar.getContext('2d');

const CORNERS = ['左奥', '右奥', '右手前', '左手前'];

const state = {
  points: [], H: null, Hinv: null, picking: false,
  running: false, cancel: false, detector: null,
  frames: null, result: null, commentary: [],
  teamOf: () => -1, colors: ['#E8732C', '#2F6BD0'],
  preview: null, radarMode: 'live', radarView: null, radarCache: {},
};
const commentator = new Commentator();

// ---------- 共通 ----------
function fmtTime(sec) {
  if (!isFinite(sec)) return '0:00';
  const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}
function parseTime(str, fallback) {
  const v = String(str || '').trim();
  if (!v) return fallback;
  const parts = v.split(':').map(Number);
  if (parts.some((x) => !isFinite(x))) return fallback;
  return parts.reduce((a, x) => a * 60 + x, 0);
}
function setStep(n) {
  document.querySelectorAll('.step').forEach((el) => {
    el.classList.toggle('is-locked', Number(el.dataset.step) > n);
  });
}
function setStatus(text, isError = false) {
  const el = $('#status');
  el.textContent = text;
  el.classList.toggle('is-error', isError);
}
function pitchSize() {
  return {
    L: parseFloat($('#pitchL').value) || CONFIG.pitch.length,
    W: parseFloat($('#pitchW').value) || CONFIG.pitch.width,
    goalWidth: CONFIG.pitch.goalWidth,
  };
}
function seekTo(t) {
  return new Promise((resolve) => {
    const done = () => { video.removeEventListener('seeked', done); resolve(); };
    video.addEventListener('seeked', done);
    video.currentTime = t;
  });
}

// ---------- 1. 動画を選ぶ ----------
function loadVideo(file) {
  if (state.running || !file) return;
  if (video.src) URL.revokeObjectURL(video.src);
  video.src = URL.createObjectURL(file);
  $('#fileName').textContent = file.name;
  state.points = []; state.H = null; state.Hinv = null;
  state.result = null; state.frames = null; state.preview = null;
  $('#results').hidden = true;
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
  $('#rangeStart').value = '0:00';
  $('#rangeEnd').value = fmtTime(video.duration);
  setStep(2);
  updatePickHint();
});

// ---------- 2. ピッチの四隅 ----------
function updatePickHint() {
  const el = $('#pickHint');
  if (state.picking) {
    el.textContent = `映像の「${CORNERS[state.points.length]}」の角をタップしてください（${state.points.length + 1}/4）`;
  } else if (state.H) {
    el.textContent = '指定しました。点線がピッチのラインと重なっていれば正確です。';
  } else {
    el.textContent = 'ピッチ全体が映った場面で一時停止してから指定してください。サイドから撮った映像を想定しています。';
  }
}
function finishCalibration() {
  const { L, W } = pitchSize();
  const dst = [[0, 0], [L, 0], [L, W], [0, W]];
  try {
    state.H = computeHomography(state.points, dst);
    state.Hinv = computeHomography(dst, state.points);
  } catch (err) {
    state.points = [];
    setStatus(err.message, true);
    return;
  }
  state.picking = false;
  overlay.classList.remove('is-picking');
  $('#pickBtn').textContent = '四隅を指定し直す';
  setStep(state.result ? 4 : 3);
}
$('#pickBtn').addEventListener('click', () => {
  if (!video.src || state.running) return;
  video.pause();
  state.points = []; state.H = null; state.Hinv = null; state.picking = true;
  overlay.classList.add('is-picking');
  setStep(2);
  updatePickHint();
});
overlay.addEventListener('pointerdown', (e) => {
  if (!state.picking) return;
  const r = overlay.getBoundingClientRect();
  state.points.push([
    ((e.clientX - r.left) / r.width) * overlay.width,
    ((e.clientY - r.top) / r.height) * overlay.height,
  ]);
  if (state.points.length === 4) finishCalibration();
  updatePickHint();
});
for (const id of ['#pitchL', '#pitchW']) {
  $(id).addEventListener('change', () => { if (state.points.length === 4) finishCalibration(); });
}

// ---------- 3. 解析 ----------
$('#runBtn').addEventListener('click', async () => {
  if (state.running) { state.cancel = true; return; }
  if (!state.H) return;
  state.running = true;
  state.cancel = false;
  $('#runBtn').textContent = '解析を中止';
  commentator.stop();
  try {
    await runAnalysis();
  } catch (err) {
    console.error(err);
    setStatus(`エラー：${err.message || err}`, true);
  } finally {
    state.running = false;
    state.preview = null;
    $('#runBtn').textContent = '解析を開始';
  }
});

async function runAnalysis() {
  if (!state.detector) {
    setStatus('AIモデルを読み込んでいます…');
    state.detector = new Detector();
    await state.detector.load(CONFIG.modelUrl);
  }
  const backend = state.detector.backend === 'webgpu' ? 'GPU' : 'CPU';
  const { L, W, goalWidth } = pitchSize();
  const start = Math.max(0, parseTime($('#rangeStart').value, 0));
  const end = Math.min(video.duration, parseTime($('#rangeEnd').value, video.duration));
  if (end - start < 2) throw new Error('解析範囲が短すぎます。開始と終了を確認してください。');

  video.pause();
  const vw = video.videoWidth, vh = video.videoHeight;
  const work = document.createElement('canvas');
  work.width = vw; work.height = vh;
  const wctx = work.getContext('2d', { willReadFrequently: true });

  const tracker = new ByteTracker(CONFIG.tracker);
  const teams = new TeamClassifier();
  const step = 1 / CONFIG.sampleFps;
  const total = Math.floor((end - start) / step) + 1;
  const frames = [];
  const t0 = performance.now();
  const bar = $('#progress');

  for (let i = 0; i < total; i++) {
    if (state.cancel) throw new Error('解析を中止しました。');
    const t = start + i * step;
    await seekTo(t);
    wctx.drawImage(video, 0, 0, vw, vh);
    const det = await state.detector.detect(work);

    const persons = [];
    for (const d of det.persons) {
      const pos = applyH(state.H, [(d.box[0] + d.box[2]) / 2, d.box[3]]);
      if (inPitch(pos, L, W, 2)) persons.push(d); // ピッチ外（観客・保護者）を除外
    }
    const tracks = tracker.update(persons, i);
    const players = tracks.map((tr) => ({
      id: tr.id,
      box: tr.box,
      pos: applyH(state.H, [(tr.box[0] + tr.box[2]) / 2, tr.box[3]]),
    }));
    if (i % 3 === 0) for (const p of players) teams.observe(p.id, wctx, p.box);

    let ball = null;
    for (const b of det.balls) {
      const pos = applyH(state.H, [(b.box[0] + b.box[2]) / 2, b.box[3]]);
      if (!inPitch(pos, L, W, 3)) continue;
      if (!ball || b.score > ball.score) ball = { box: b.box, pos, score: b.score };
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

  teams.fit();
  state.teamOf = (id) => teams.teamOf(id);
  state.colors = teams.colors();
  state.frames = frames;
  state.result = analyzeMatch(frames, {
    ...CONFIG.analysis, L, W, goalWidth, fps: CONFIG.sampleFps, teamOf: state.teamOf,
  });
  state.commentary = buildCommentary(state.result);
  setStatus(`解析が完了しました。イベント${state.result.events.length}件を検出。`);
  setStep(4);
  renderResults();
  await seekTo(start);
}

// ---------- 4. 結果表示 ----------
function renderResults() {
  const r = state.result;
  $('#results').hidden = false;

  const pct = (v) => `${Math.round(v * 100)}%`;
  const m = (v) => (v == null ? '—' : `${v.toFixed(1)} m`);
  $('#teams').innerHTML = r.teams.map((t, k) => `
    <article class="team">
      <h3><span class="swatch" style="--c:${state.colors[k]}"></span>${teamName(k)}</h3>
      <p class="team-dir">ピッチ図の${t.attackDir === 1 ? '右' : '左'}へ攻撃</p>
      <dl>
        <div><dt>ボール保持率</dt><dd>${pct(t.possession)}</dd></div>
        <div><dt>パス成功 / 試行</dt><dd>${t.passes} / ${t.passAttempts}</dd></div>
        <div><dt>シュート</dt><dd>${t.shots}</dd></div>
        <div><dt>ゴール（参考）</dt><dd>${t.goals}</dd></div>
        <div><dt>ボール奪取</dt><dd>${t.steals}</dd></div>
        <div><dt>守備時の選手間隔</dt><dd>${m(t.defSpacing)}</dd></div>
        <div><dt>陣形の横幅 / 縦幅</dt><dd>${m(t.width)} / ${m(t.depth)}</dd></div>
      </dl>
    </article>`).join('');

  $('#heatA').textContent = `${teamName(0)}の位置`;
  $('#heatB').textContent = `${teamName(1)}の位置`;

  const list = $('#events');
  list.innerHTML = state.commentary.length
    ? state.commentary.map((c, k) => `
      <li class="ev ev-${c.type}" data-k="${k}">
        <button type="button" data-t="${c.t}"><time>${fmtTime(c.t)}</time><span>${c.text}</span></button>
      </li>`).join('')
    : '<li class="ev-empty">イベントは検出されませんでした。ボールが映りにくい場合は README の「精度を上げるには」を参照してください。</li>';

  const rows = r.players.filter((p) => p.time >= CONFIG.minPlayerTime);
  $('#playersBody').innerHTML = rows.map((p) => `
    <tr>
      <td><span class="swatch" style="--c:${p.team >= 0 ? state.colors[p.team] : '#A3ADA6'}"></span>${p.id}</td>
      <td>${teamName(p.team)}</td>
      <td>${fmtTime(p.time)}</td>
      <td>${Math.round(p.distance)}</td>
      <td>${p.topSpeed.toFixed(1)}</td>
      <td>${p.sprints}</td>
      <td>${p.touches}</td>
      <td>${p.passes} / ${p.passAttempts}</td>
      <td>${p.shots}</td>
      <td>${p.steals}</td>
    </tr>`).join('');

  state.radarCache = {};
  sizeRadar();
}

$('#events').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-t]');
  if (!b) return;
  video.currentTime = Math.max(0, Number(b.dataset.t) - 3);
  video.play();
});

document.querySelectorAll('[data-radar]').forEach((btn) => {
  btn.addEventListener('click', () => {
    state.radarMode = btn.dataset.radar;
    document.querySelectorAll('[data-radar]').forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
  });
});

$('#voice').addEventListener('change', (e) => {
  commentator.enabled = e.target.checked;
  if (!e.target.checked) commentator.stop();
});
if (!commentator.supported) {
  $('#voice').disabled = true;
  $('#voiceNote').textContent = 'このブラウザは音声読み上げに対応していません。実況はログで確認できます。';
}
$('#playBtn').addEventListener('click', () => {
  if (state.frames) video.currentTime = state.frames[0].t;
  video.play();
});

// ---------- 俯瞰ピッチ ----------
function sizeRadar() {
  const r = state.result;
  if (!r) return;
  const cssW = radar.clientWidth || 600;
  const cssH = (cssW * (r.W + 6)) / (r.L + 6);
  const dpr = window.devicePixelRatio || 1;
  radar.style.height = `${cssH}px`;
  radar.width = Math.round(cssW * dpr);
  radar.height = Math.round(cssH * dpr);
  state.radarView = makePitchView(radar.width, radar.height, r.L, r.W, 3);
  state.radarCache = {};
}
window.addEventListener('resize', sizeRadar);

function radarBase(mode) {
  if (state.radarCache[mode]) return state.radarCache[mode];
  const r = state.result, v = state.radarView;
  const c = document.createElement('canvas');
  c.width = radar.width; c.height = radar.height;
  const ctx = c.getContext('2d');
  drawTurf(ctx, v);
  if (mode !== 'live') {
    const k = Number(mode);
    drawHeat(ctx, v, r.heat[k], r.cols, r.rows, state.colors[k]);
  }
  drawLines(ctx, v, r.goalWidth);
  state.radarCache[mode] = c;
  return c;
}

// ---------- 再生同期ループ ----------
function frameIndexAt(t) {
  const fr = state.frames;
  if (!fr || !fr.length) return -1;
  let lo = 0, hi = fr.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (fr[mid].t <= t) lo = mid; else hi = mid - 1;
  }
  const tol = 1.5 / CONFIG.sampleFps;
  if (Math.abs(fr[lo].t - t) <= tol) return lo;
  if (lo + 1 < fr.length && Math.abs(fr[lo + 1].t - t) <= tol) return lo + 1;
  return -1;
}

let lastT = 0;
let activeEv = null;
function speakBetween(a, b) {
  state.commentary.forEach((c, k) => {
    if (c.t > a && c.t <= b) {
      commentator.say(c);
      const li = document.querySelector(`.ev[data-k="${k}"]`);
      if (li) {
        if (activeEv) activeEv.classList.remove('is-now');
        li.classList.add('is-now');
        activeEv = li;
        const box = $('#events');
        box.scrollTop = li.offsetTop - box.clientHeight / 2;
      }
    }
  });
}

function tick() {
  if (overlay.width) {
    octx.clearRect(0, 0, overlay.width, overlay.height);
    const { L, W, goalWidth } = pitchSize();
    if (state.Hinv && !state.result) drawProjectedPitch(octx, state.Hinv, L, W, goalWidth);
    if (state.points.length && (state.picking || !state.result)) drawCornerPoints(octx, state.points, CORNERS);

    if (state.running && state.preview) {
      drawDetections(octx, state.preview, { teamOf: null, colors: state.colors, ownerId: null });
    } else if (state.result) {
      const i = frameIndexAt(video.currentTime);
      if (i >= 0 && $('#showBoxes').checked) {
        drawDetections(octx, state.frames[i], {
          teamOf: state.teamOf, colors: state.colors, ownerId: state.result.ownerId[i],
        });
      }
      if (state.radarView) {
        rctx.drawImage(radarBase(state.radarMode), 0, 0);
        if (state.radarMode === 'live' && i >= 0) {
          drawRadar(rctx, state.radarView, state.frames[i], state.result.ball[i], {
            teamOf: state.teamOf, colors: state.colors, ownerId: state.result.ownerId[i],
          });
        }
      }
      const t = video.currentTime;
      if (!video.paused && t > lastT && t - lastT < 1) speakBetween(lastT, t);
    }
  }
  lastT = video.currentTime;
  requestAnimationFrame(tick);
}
video.addEventListener('seeked', () => { lastT = video.currentTime; });
video.addEventListener('pause', () => commentator.stop());
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
  const head = ['追跡ID', 'チーム', '出場秒', '走行距離m', '最高速度kmh', 'スプリント', 'ボールタッチ', 'パス成功', 'パス試行', 'シュート', 'ゴール', 'ボール奪取'];
  const lines = r.players.map((p) => [
    p.id, teamName(p.team), p.time.toFixed(1), p.distance.toFixed(1), p.topSpeed.toFixed(1),
    p.sprints, p.touches, p.passes, p.passAttempts, p.shots, p.goals, p.steals,
  ].join(','));
  download('players.csv', '\uFEFF' + [head.join(','), ...lines].join('\n'), 'text/csv');
});
$('#exportJson').addEventListener('click', () => {
  const r = state.result;
  if (!r) return;
  const out = {
    pitch: { length: r.L, width: r.W }, teamColors: state.colors,
    teams: r.teams, players: r.players, events: r.events, commentary: state.commentary,
  };
  download('analysis.json', JSON.stringify(out, null, 2), 'application/json');
});
$('#exportText').addEventListener('click', () => {
  download('commentary.txt', state.commentary.map((c) => `${fmtTime(c.t)}  ${c.text}`).join('\n'), 'text/plain');
});

setStep(1);
updatePickHint();
