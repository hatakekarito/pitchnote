// 追跡結果から、ボール保持・パス・ボール奪取・ドリブル・シュートを判定する。
// 座標は「カメラの動きを打ち消した画面座標（world）」。メートルへの換算は、
// 近くにいる選手の画面上の身長を基準にしたおおよその値。
//
// frames: [{ t, players:[{id, box, w:[x,y], wh}], ball:{box, w:[x,y], score}|null }]

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const median = (arr) => {
  if (!arr.length) return null;
  const s = arr.slice().sort((p, q) => p - q);
  return s[s.length >> 1];
};

export function analyzeMatch(frames, o) {
  const n = frames.length;
  const fps = o.fps;
  const dt0 = 1 / fps;
  const T = (i) => frames[i].t;
  const teamOf = o.teamOf;
  const teamPlayers = (i) => frames[i].players.filter((p) => teamOf(p.id) >= 0);

  // ---------- 1mあたりの画面距離 ----------
  const frameScale = frames.map((f, i) => {
    const h = median(teamPlayers(i).map((p) => p.wh));
    return h ? h / o.playerHeight : null;
  });
  // 欠けているコマは前後で埋める
  let lastS = frameScale.find((v) => v) || 50;
  for (let i = 0; i < n; i++) { if (frameScale[i]) lastS = frameScale[i]; else frameScale[i] = lastS; }
  const localScale = (i, pos) => {
    const ps = teamPlayers(i)
      .map((p) => [dist(p.w, pos), p.wh])
      .sort((a, b) => a[0] - b[0])
      .slice(0, 3)
      .map((x) => x[1]);
    const h = median(ps);
    return h ? h / o.playerHeight : frameScale[i];
  };

  // ---------- ボール：誤検出の除去と補間 ----------
  const raw = frames.map((f) => (f.ball ? f.ball.w : null));
  const ball = raw.slice();
  const valid = [];
  raw.forEach((p, i) => { if (p) valid.push(i); });
  for (let k = 0; k < valid.length; k++) {
    const i = valid[k];
    const sp = (j) => (j === undefined ? null
      : dist(raw[i], raw[j]) / frameScale[i] / Math.max(dt0, Math.abs(T(i) - T(j))));
    const a = sp(valid[k - 1]), b = sp(valid[k + 1]);
    if (a === null && b === null) continue;
    if ((a === null || a > o.maxBallSpeed) && (b === null || b > o.maxBallSpeed)) ball[i] = null;
  }
  const maxGap = Math.round(fps * o.ballMaxGap);
  let prev = -1;
  for (let i = 0; i < n; i++) {
    if (!ball[i]) continue;
    if (prev >= 0 && i - prev > 1 && i - prev <= maxGap) {
      for (let j = prev + 1; j < i; j++) {
        const r = (j - prev) / (i - prev);
        ball[j] = [ball[prev][0] + (ball[i][0] - ball[prev][0]) * r, ball[prev][1] + (ball[i][1] - ball[prev][1]) * r];
      }
    }
    prev = i;
  }
  // ボール速度（m/s の目安）とその向き（画面上）
  const ballVel = (i) => {
    if (i < 1 || !ball[i] || !ball[i - 1]) return null;
    const dt = T(i) - T(i - 1);
    const sc = localScale(i, ball[i]);
    return [(ball[i][0] - ball[i - 1][0]) / sc / dt, (ball[i][1] - ball[i - 1][1]) / sc / dt];
  };

  // ---------- 選手 ----------
  const pinfo = new Map();
  frames.forEach((f, i) => {
    for (const pl of f.players) {
      const team = teamOf(pl.id);
      if (team < 0) continue;
      let p = pinfo.get(pl.id);
      if (!p) {
        p = { id: pl.id, team, time: 0, last: null, touches: 0, passes: 0, passAttempts: 0, shots: 0, steals: 0, dribbles: 0 };
        pinfo.set(pl.id, p);
      }
      if (p.last !== null && i - p.last <= 3) p.time += T(i) - T(p.last);
      p.last = i;
    }
  });

  // ---------- ボール保持 ----------
  const near = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    if (!ball[i]) continue;
    const v = ballVel(i);
    if (v && Math.hypot(v[0], v[1]) > o.controlSpeed) continue; // 速いボールのそばを通っただけでは保持としない
    let best = null, bd = Infinity;
    for (const pl of teamPlayers(i)) {
      const d = dist(pl.w, ball[i]) / (pl.wh / o.playerHeight); // その選手の身長を基準にした距離(m)
      if (d < o.possessionRadius && d < bd) { bd = d; best = pl.id; }
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
    else P.push({ ...s, team: teamOf(s.id) });
  }
  for (const s of P) pinfo.get(s.id).touches++;

  // ---------- 攻撃方向（画面の右=+1 / 左=-1） ----------
  let dirA = o.attackDirA;
  if (dirA !== 1 && dirA !== -1) {
    const sum = [0, 0], cnt = [0, 0];
    const lim = Math.min(n, Math.round(fps * 60));
    for (let i = 0; i < lim; i++) {
      for (const pl of teamPlayers(i)) { const t = teamOf(pl.id); sum[t] += pl.w[0]; cnt[t]++; }
    }
    // 自陣側に多くいるチームは、反対側へ攻める
    dirA = (sum[0] / (cnt[0] || 1)) <= (sum[1] / (cnt[1] || 1)) ? 1 : -1;
  }
  const attackDir = [dirA, -dirA];

  // 前後90秒に選手がいた範囲を「ピッチの長さ」の代わりにする
  const zoneAt = (i) => {
    const xs = [];
    const w = Math.round(fps * 90);
    for (let j = Math.max(0, i - w); j <= Math.min(n - 1, i + w); j += 4) {
      for (const pl of teamPlayers(j)) xs.push(pl.w[0]);
    }
    if (xs.length < 20) return null;
    xs.sort((a, b) => a - b);
    return [xs[Math.floor(xs.length * 0.03)], xs[Math.floor(xs.length * 0.97)]];
  };

  // ---------- イベント ----------
  const events = [];
  for (let k = 0; k < P.length; k++) {
    const a = P[k], b = P[k + 1];
    const pa = pinfo.get(a.id);

    if (ball[a.s] && ball[a.e]) {
      const disp = dist(ball[a.s], ball[a.e]) / localScale(a.e, ball[a.e]);
      if (disp >= o.dribbleMin) {
        events.push({ type: 'dribble', t: T(a.s), by: a.id, team: a.team, distance: disp });
        pa.dribbles++;
      }
    }

    // シュート：保持のあと、攻める向きに速いボールが出た
    const fEnd = b ? b.s : Math.min(n - 1, a.e + Math.round(fps * 3));
    let shot = null;
    if (ball[a.e]) {
      const dir = attackDir[a.team];
      // 蹴った直後 0.4秒・0.8秒 の正味の移動から速さと向きを求める（1コマのぶれに強い）
      let vmax = 0, vx = 0;
      for (const sec of [0.4, 0.8]) {
        const k = Math.min(fEnd, a.e + Math.max(1, Math.round(fps * sec)));
        if (k <= a.e || !ball[k]) continue;
        const sc = localScale(a.e, ball[a.e]);
        const dt = T(k) - T(a.e);
        const v = [(ball[k][0] - ball[a.e][0]) / sc / dt, (ball[k][1] - ball[a.e][1]) / sc / dt];
        const sp = Math.hypot(v[0], v[1]);
        if (sp > vmax) { vmax = sp; vx = v[0]; }
      }
      const zone = zoneAt(a.e);
      let inZone = false;
      if (zone && zone[1] > zone[0]) {
        const f = (ball[a.e][0] - zone[0]) / (zone[1] - zone[0]);
        inZone = dir === 1 ? f >= o.attackZone : f <= 1 - o.attackZone;
      }
      if (inZone && vmax >= o.shotSpeed && vx * dir > 0 && Math.abs(vx) >= 0.6 * vmax) {
        shot = { type: 'shot', t: T(a.e), by: a.id, team: a.team, speed: vmax * 3.6 };
        events.push(shot);
        pa.shots++;
      }
    }
    if (!b || shot) continue;

    const gap = T(b.s) - T(a.e);
    const len = ball[a.e] && ball[b.s] ? dist(ball[a.e], ball[b.s]) / localScale(b.s, ball[b.s]) : 0;
    if (b.team === a.team && b.id !== a.id) {
      if (len >= o.minPassLength && gap <= o.maxPassTime) {
        events.push({ type: 'pass', t: T(a.e), t2: T(b.s), from: a.id, to: b.id, team: a.team, length: len });
        pa.passes++; pa.passAttempts++;
      }
    } else if (b.team !== a.team) {
      if (len >= o.minPassLength && gap > 0.3) pa.passAttempts++;
      events.push({ type: 'steal', t: T(b.s), by: b.id, team: b.team, from: a.id });
      pinfo.get(b.id).steals++;
    }
  }
  events.sort((x, y) => x.t - y.t);

  // ---------- コマごとの保持チーム ----------
  const ownerId = new Array(n).fill(null);
  const ownerTeam = new Array(n).fill(-1);
  for (let k = 0; k < P.length; k++) {
    const s = P[k], nx = P[k + 1];
    for (let i = s.s; i <= s.e; i++) { ownerId[i] = s.id; ownerTeam[i] = s.team; }
    const until = nx ? nx.s - 1 : Math.min(n - 1, s.e + fps * 2);
    for (let i = s.e + 1; i <= until; i++) ownerTeam[i] = s.team;
  }

  // ---------- 集計 ----------
  const players = [...pinfo.values()].map(({ last, ...p }) => p);
  const possTime = [0, 0];
  for (const s of P) possTime[s.team] += T(s.e) - T(s.s) + dt0;
  const possSum = possTime[0] + possTime[1] || 1;
  const teams = [0, 1].map((t) => {
    const ps = players.filter((p) => p.team === t);
    const sum = (key) => ps.reduce((acc, p) => acc + p[key], 0);
    return {
      possession: possTime[t] / possSum,
      passes: sum('passes'),
      passAttempts: sum('passAttempts'),
      shots: sum('shots'),
      steals: sum('steals'),
      dribbles: sum('dribbles'),
      attackDir: attackDir[t],
    };
  });
  players.sort((a, b) => b.touches - a.touches || b.time - a.time);

  const segments = P.map((sg) => ({ id: sg.id, team: sg.team, s: sg.s, e: sg.e, t0: T(sg.s), t1: T(sg.e) }));
  return { fps, players, teams, events, segments, ownerId, ownerTeam, attackDir, ballDetected: valid.length / (n || 1) };
}
