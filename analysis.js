// 追跡結果（コマごとの選手・ボール位置）から、走行距離・保持・パス・シュートなどを算出する。
// frames: [{ t, players:[{id, box, pos:[x,y]}], ball:{box, pos, score}|null }]

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

export function analyzeMatch(frames, o) {
  const n = frames.length;
  const fps = o.fps;
  const dt0 = 1 / fps;
  const { L, W, goalWidth } = o;
  const T = (i) => frames[i].t;

  // ---------- ボール：誤検出の除去と補間 ----------
  const raw = frames.map((f) => (f.ball ? f.ball.pos : null));
  const ball = raw.slice();
  const valid = [];
  raw.forEach((p, i) => { if (p) valid.push(i); });
  for (let k = 0; k < valid.length; k++) {
    const i = valid[k];
    const sp = (j) => (j === undefined ? null : dist(raw[i], raw[j]) / Math.max(dt0, Math.abs(T(i) - T(j))));
    const a = sp(valid[k - 1]), b = sp(valid[k + 1]);
    if (a === null && b === null) continue;
    const badA = a === null || a > o.maxBallSpeed;
    const badB = b === null || b > o.maxBallSpeed;
    if (badA && badB) ball[i] = null;
  }
  const maxGap = Math.round(fps * o.ballMaxGap);
  let prev = -1;
  for (let i = 0; i < n; i++) {
    if (!ball[i]) continue;
    if (prev >= 0 && i - prev > 1 && i - prev <= maxGap) {
      for (let j = prev + 1; j < i; j++) {
        const r = (j - prev) / (i - prev);
        ball[j] = [
          ball[prev][0] + (ball[i][0] - ball[prev][0]) * r,
          ball[prev][1] + (ball[i][1] - ball[prev][1]) * r,
        ];
      }
    }
    prev = i;
  }
  const ballVel = (i) => {
    if (i < 1 || !ball[i] || !ball[i - 1]) return null;
    const dt = T(i) - T(i - 1);
    return [(ball[i][0] - ball[i - 1][0]) / dt, (ball[i][1] - ball[i - 1][1]) / dt];
  };

  // ---------- 選手ごとの移動 ----------
  const tracks = new Map();
  frames.forEach((f, i) => {
    for (const pl of f.players) {
      let tr = tracks.get(pl.id);
      if (!tr) { tr = { id: pl.id, idx: [], pos: [] }; tracks.set(pl.id, tr); }
      tr.idx.push(i);
      tr.pos.push(pl.pos);
    }
  });

  const players = [];
  const winK = Math.max(1, Math.round(fps * 0.5));
  for (const tr of tracks.values()) {
    const m = tr.pos.length;
    const sm = tr.pos.map((_, k) => {
      let sx = 0, sy = 0, c = 0;
      for (let d = -2; d <= 2; d++) {
        const q = k + d;
        if (q < 0 || q >= m || Math.abs(tr.idx[q] - tr.idx[k]) > Math.abs(d) + 2) continue;
        sx += tr.pos[q][0]; sy += tr.pos[q][1]; c++;
      }
      return [sx / c, sy / c];
    });
    let distance = 0, time = 0;
    for (let k = 1; k < m; k++) {
      const dt = T(tr.idx[k]) - T(tr.idx[k - 1]);
      if (dt > 0.6) continue;
      time += dt;
      const d = dist(sm[k], sm[k - 1]);
      if (d / dt <= o.maxPlayerSpeed) distance += d;
    }
    let top = 0, sprints = 0, run = 0;
    const minRun = Math.max(1, Math.round(fps * 0.5));
    for (let k = winK; k < m; k++) {
      const dt = T(tr.idx[k]) - T(tr.idx[k - winK]);
      if (dt <= 0 || dt > 0.8) { run = 0; continue; }
      const v = dist(sm[k], sm[k - winK]) / dt;
      if (v > o.maxPlayerSpeed) { run = 0; continue; }
      top = Math.max(top, v);
      if (v >= o.sprintSpeed) { run++; if (run === minRun) sprints++; } else run = 0;
    }
    players.push({
      id: tr.id, team: o.teamOf(tr.id), time, distance, topSpeed: top * 3.6, sprints,
      touches: 0, passes: 0, passAttempts: 0, shots: 0, goals: 0, steals: 0,
    });
  }
  const pmap = new Map(players.map((p) => [p.id, p]));

  // ---------- ボール保持 ----------
  const near = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    if (!ball[i]) continue;
    const v = ballVel(i);
    if (v && Math.hypot(v[0], v[1]) > o.controlSpeed) continue; // 速く転がるボールのそばを通っただけでは保持としない
    let best = null, bd = o.possessionRadius;
    for (const pl of frames[i].players) {
      const d = dist(pl.pos, ball[i]);
      if (d < bd) { bd = d; best = pl.id; }
    }
    near[i] = best;
  }
  const segs = [];
  let cur = null;
  const holdGap = Math.round(fps * 0.5);
  for (let i = 0; i < n; i++) {
    const id = near[i];
    if (id === null) continue;
    if (cur && cur.id === id && i - cur.e <= holdGap) { cur.e = i; continue; }
    if (cur) segs.push(cur);
    cur = { id, s: i, e: i };
  }
  if (cur) segs.push(cur);
  const P = [];
  for (const s of segs) {
    if (s.e - s.s + 1 < o.minPossessionFrames) continue;
    const last = P[P.length - 1];
    if (last && last.id === s.id && T(s.s) - T(last.e) < 1.5) last.e = s.e;
    else P.push({ ...s, team: o.teamOf(s.id) });
  }
  for (const s of P) { const p = pmap.get(s.id); if (p) p.touches++; }

  // ---------- 攻撃方向（最初の1分の平均位置から推定） ----------
  const sumX = [0, 0], cnt = [0, 0];
  const lim = Math.min(n, Math.round(fps * 60));
  for (let i = 0; i < lim; i++) {
    for (const pl of frames[i].players) {
      const tm = o.teamOf(pl.id);
      if (tm >= 0) { sumX[tm] += pl.pos[0]; cnt[tm]++; }
    }
  }
  const meanX = [sumX[0] / (cnt[0] || 1), sumX[1] / (cnt[1] || 1)];
  const attackDir = meanX[0] <= meanX[1] ? [1, -1] : [-1, 1];
  const goalX = (team) => (attackDir[team] === 1 ? L : 0);

  // ---------- イベント ----------
  const events = [];
  const cosLim = Math.cos((o.shotAngleDeg * Math.PI) / 180);
  for (let k = 0; k < P.length; k++) {
    const a = P[k], b = P[k + 1];
    const pa = pmap.get(a.id);

    if (ball[a.s] && ball[a.e]) {
      const disp = dist(ball[a.s], ball[a.e]);
      if (disp >= o.dribbleMin) events.push({ type: 'dribble', t: T(a.s), by: a.id, team: a.team, distance: disp });
    }

    const fEnd = b ? b.s : Math.min(n - 1, a.e + Math.round(fps * 3));
    let shot = null;
    if (a.team >= 0 && ball[a.e]) {
      const gx = goalX(a.team), gy = W / 2;
      let vmax = 0, toward = false;
      const lim2 = Math.min(fEnd, a.e + Math.round(fps * 1.5));
      for (let i = a.e + 1; i <= lim2; i++) {
        const v = ballVel(i);
        if (!v) continue;
        const sp = Math.hypot(v[0], v[1]);
        if (sp > vmax) {
          vmax = sp;
          const tg = [gx - ball[i - 1][0], gy - ball[i - 1][1]];
          toward = (v[0] * tg[0] + v[1] * tg[1]) / (sp * Math.hypot(tg[0], tg[1]) + 1e-9) > cosLim;
        }
      }
      let goal = false;
      for (let i = a.e + 1; i <= fEnd; i++) {
        const q = ball[i];
        if (!q) continue;
        const crossed = gx === L ? q[0] >= L - 0.2 : q[0] <= 0.2;
        if (crossed && Math.abs(q[1] - gy) <= goalWidth / 2 + 0.75) { goal = true; break; }
      }
      const inRange = Math.abs(ball[a.e][0] - gx) <= o.shotMaxDist;
      if (goal || (inRange && vmax >= o.shotSpeed && toward)) {
        shot = { type: 'shot', t: T(a.e), by: a.id, team: a.team, goal, speed: vmax * 3.6 };
        events.push(shot);
        if (pa) { pa.shots++; if (goal) pa.goals++; }
      }
    }
    if (!b || shot) continue;

    const gap = T(b.s) - T(a.e);
    const len = ball[a.e] && ball[b.s] ? dist(ball[a.e], ball[b.s]) : 0;
    if (b.team === a.team && a.team >= 0 && b.id !== a.id) {
      if (len >= o.minPassLength && gap <= o.maxPassTime) {
        events.push({ type: 'pass', t: T(a.e), t2: T(b.s), from: a.id, to: b.id, team: a.team, length: len });
        if (pa) { pa.passes++; pa.passAttempts++; }
      }
    } else if (b.team !== a.team && a.team >= 0 && b.team >= 0) {
      if (pa && len >= o.minPassLength && gap > 0.3) pa.passAttempts++; // 相手に渡ったパス
      events.push({ type: 'steal', t: T(b.s), by: b.id, team: b.team, from: a.id });
      const pb = pmap.get(b.id);
      if (pb) pb.steals++;
    }
  }
  events.sort((x, y) => x.t - y.t);

  // ---------- コマごとの保持者 ----------
  const ownerId = new Array(n).fill(null);
  const ownerTeam = new Array(n).fill(-1);
  for (let k = 0; k < P.length; k++) {
    const s = P[k], nx = P[k + 1];
    for (let i = s.s; i <= s.e; i++) { ownerId[i] = s.id; ownerTeam[i] = s.team; }
    const until = nx ? nx.s - 1 : Math.min(n - 1, s.e + fps * 2);
    for (let i = s.e + 1; i <= until; i++) ownerTeam[i] = s.team;
  }

  // ---------- 陣形（横幅・縦幅・選手間隔） ----------
  const shape = [0, 1].map(() => ({ w: 0, d: 0, sp: 0, c: 0, def: 0, defC: 0 }));
  for (let i = 0; i < n; i++) {
    for (const team of [0, 1]) {
      const pts = frames[i].players.filter((pl) => o.teamOf(pl.id) === team).map((pl) => pl.pos);
      if (pts.length < 4) continue;
      const own = goalX(team) === L ? 0 : L;
      let gi = -1, gd = Infinity;
      pts.forEach((p, j) => { const d = Math.abs(p[0] - own); if (d < gd) { gd = d; gi = j; } });
      const field = gd < 16 ? pts.filter((_, j) => j !== gi) : pts; // GKらしき選手を除外
      if (field.length < 3) continue;
      const xs = field.map((p) => p[0]), ys = field.map((p) => p[1]);
      let nn = 0;
      for (const p of field) {
        let m = Infinity;
        for (const q of field) if (q !== p) m = Math.min(m, dist(p, q));
        nn += m;
      }
      nn /= field.length;
      const s = shape[team];
      s.w += Math.max(...ys) - Math.min(...ys);
      s.d += Math.max(...xs) - Math.min(...xs);
      s.sp += nn; s.c++;
      if (ownerTeam[i] === 1 - team) { s.def += nn; s.defC++; }
    }
  }

  // ---------- チーム集計 ----------
  const possTime = [0, 0];
  for (const s of P) if (s.team >= 0) possTime[s.team] += T(s.e) - T(s.s) + dt0;
  const possSum = possTime[0] + possTime[1] || 1;
  const teams = [0, 1].map((t) => {
    const ps = players.filter((p) => p.team === t);
    const sum = (key) => ps.reduce((a, p) => a + p[key], 0);
    const s = shape[t];
    return {
      possession: possTime[t] / possSum,
      passes: sum('passes'),
      passAttempts: sum('passAttempts'),
      shots: sum('shots'),
      goals: sum('goals'),
      steals: sum('steals'),
      width: s.c ? s.w / s.c : null,
      depth: s.c ? s.d / s.c : null,
      spacing: s.c ? s.sp / s.c : null,
      defSpacing: s.defC ? s.def / s.defC : null,
      attackDir: attackDir[t],
    };
  });

  // ---------- ヒートマップ（2mメッシュ） ----------
  const cell = 2;
  const cols = Math.ceil(L / cell), rows = Math.ceil(W / cell);
  const heat = [new Float32Array(cols * rows), new Float32Array(cols * rows)];
  for (const f of frames) {
    for (const pl of f.players) {
      const tm = o.teamOf(pl.id);
      if (tm < 0) continue;
      const cx = Math.min(cols - 1, Math.max(0, Math.floor(pl.pos[0] / cell)));
      const cy = Math.min(rows - 1, Math.max(0, Math.floor(pl.pos[1] / cell)));
      heat[tm][cy * cols + cx]++;
    }
  }

  players.sort((a, b) => b.distance - a.distance);
  return { L, W, goalWidth, fps, players, teams, events, heat, cols, rows, ball, ownerId, attackDir };
}
