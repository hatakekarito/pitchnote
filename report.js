// 解析結果から、時系列の試合レポート（画面表示・印刷用HTML と コピー用テキスト）を作る。

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function fmtTime(sec) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

// 攻撃のまとまり（同じチームが続けてボールを持っていた区間）を作る
function buildPhases(result, joinGap) {
  const phases = [];
  for (const sg of result.segments) {
    const last = phases[phases.length - 1];
    if (last && last.team === sg.team && sg.t0 - last.t1 < joinGap) {
      last.segs.push(sg); last.t1 = sg.t1;
    } else {
      phases.push({ team: sg.team, segs: [sg], t0: sg.t0, t1: sg.t1 });
    }
  }
  const evs = result.events;
  phases.forEach((ph, k) => {
    const next = phases[k + 1];
    const until = next ? next.t0 : ph.t1 + 3;
    ph.events = evs.filter((e) => e.team === ph.team && e.t >= ph.t0 - 0.01 && e.t < until && e.type !== 'steal');
    ph.shot = ph.events.find((e) => e.type === 'shot') || null;
    ph.passes = ph.events.filter((e) => e.type === 'pass').length;
    ph.dribble = ph.events.filter((e) => e.type === 'dribble').sort((a, b) => b.distance - a.distance)[0] || null;
    const steal = next && evs.find((e) => e.type === 'steal' && e.team === next.team && Math.abs(e.t - next.t0) < 0.01);
    if (ph.shot) ph.end = { type: 'shot' };
    else if (!next || next.t0 - ph.t1 > 4) ph.end = { type: 'stop' };
    else if (steal) ph.end = { type: 'steal', by: steal.by };
    else ph.end = { type: 'lost' };
    ph.startSteal = k > 0 && phases[k - 1].end.type === 'steal' ? phases[k - 1].end.by : null;
    // ボールに触った選手の順番（同じ選手が続く場合は1回に）
    ph.chain = [];
    for (const sg of ph.segs) if (ph.chain[ph.chain.length - 1] !== sg.id) ph.chain.push(sg.id);
  });
  return phases;
}

function phaseSentence(ph, name, oppName) {
  const parts = [];
  const first = ph.startSteal ? `${name(ph.startSteal)}がボールを奪い、` : '';
  if (ph.chain.length > 1) {
    parts.push(`${first}${ph.chain.map(name).join('→')}とつなぐ${ph.passes ? `（パス${ph.passes}本）` : ''}`);
  } else {
    parts.push(`${first}${name(ph.chain[0])}がボールを持つ`);
  }
  if (ph.dribble) parts.push(`${name(ph.dribble.by)}が約${Math.round(ph.dribble.distance)}mドリブルで運ぶ`);
  if (ph.end.type === 'shot') parts.push(`${name(ph.shot.by)}がシュート`);
  else if (ph.end.type === 'steal') parts.push(`${oppName(ph.end.by)}にボールを奪われる`);
  else if (ph.end.type === 'stop') parts.push('ここでプレーが途切れる（ボールが外に出たか、映像で見失った可能性）');
  else parts.push('相手ボールになる');
  return parts.join('。') + '。';
}

function pickBucket(len) {
  for (const m of [1, 2, 3, 5, 10, 15]) if (len / (m * 60) <= 8) return m * 60;
  return 900;
}

export function buildReport(o) {
  const { result, times, range, teamNames, colors, memo, videoName, labelOf, cfg } = o;
  const [r0, r1] = range;
  const tn = (t) => esc(teamNames[t] || (t === 0 ? 'チームA' : 'チームB'));
  // labelOf(key) -> { team, num }
  const short = (key) => { const l = labelOf(key); return l && l.num ? `${l.num}番` : '番号なし'; };
  const full = (key) => { const l = labelOf(key); return l ? `${teamNames[l.team]}の${l.num ? `${l.num}番` : '番号なしの選手'}` : '不明'; };

  const phases = buildPhases(result, cfg.joinGap);
  const shown = phases.filter((ph) => ph.segs.length >= cfg.minPhaseTouches || ph.shot || ph.dribble || ph.t1 - ph.t0 >= cfg.minPhaseSec);
  const hidden = phases.length - shown.length;

  const T = result.teams;
  const pct = (v) => Math.round(v * 100);

  // ---- 時間帯ごと ----
  const bucket = pickBucket(r1 - r0);
  const bands = [];
  for (let s = r0; s < r1 - 0.5; s += bucket) bands.push({ s, e: Math.min(r1, s + bucket), own: [0, 0], shots: [0, 0], passes: [0, 0] });
  times.forEach((t, i) => {
    const tm = result.ownerTeam[i];
    if (tm < 0) return;
    const b = bands[Math.min(bands.length - 1, Math.floor((t - r0) / bucket))];
    if (b) b.own[tm]++;
  });
  for (const e of result.events) {
    const b = bands[Math.min(bands.length - 1, Math.floor((e.t - r0) / bucket))];
    if (!b) continue;
    if (e.type === 'shot') b.shots[e.team]++;
    if (e.type === 'pass') b.passes[e.team]++;
  }
  for (const b of bands) { const s = b.own[0] + b.own[1]; b.pa = s ? b.own[0] / s : null; }

  // ---- まとめの文章 ----
  const lines = [];
  const hasPoss = result.segments.length > 0;
  if (hasPoss) lines.push(`ボール保持率は${tn(0)} ${pct(T[0].possession)}%、${tn(1)} ${pct(T[1].possession)}%。`);
  else lines.push('ボールがほとんど見つからなかったため、ボール保持率は出せませんでした。');
  lines.push(`パスは${tn(0)}が${T[0].passes}本（試行${T[0].passAttempts}）、${tn(1)}が${T[1].passes}本（試行${T[1].passAttempts}）。`);
  lines.push(`シュートは${tn(0)} ${T[0].shots}本、${tn(1)} ${T[1].shots}本。ボール奪取は${tn(0)} ${T[0].steals}回、${tn(1)} ${T[1].steals}回。`);
  const valid = bands.filter((b) => b.pa !== null && b.own[0] + b.own[1] >= 20);
  if (valid.length >= 2) {
    const hi = valid.reduce((a, b) => (b.pa > a.pa ? b : a));
    const lo = valid.reduce((a, b) => (b.pa < a.pa ? b : a));
    if (hi.pa >= 0.6) lines.push(`${fmtTime(hi.s)}〜${fmtTime(hi.e)}は${tn(0)}が保持率${pct(hi.pa)}%で押し込んだ時間帯。`);
    if (lo.pa <= 0.4) lines.push(`${fmtTime(lo.s)}〜${fmtTime(lo.e)}は${tn(1)}が保持率${pct(1 - lo.pa)}%で押し込んだ時間帯。`);
  }
  const longest = shown.filter((p) => p.passes > 0).sort((a, b) => b.passes - a.passes)[0];
  if (longest && longest.passes >= 3) {
    lines.push(`一番長くつながった攻撃は${fmtTime(longest.t0)}の${tn(longest.team)}（パス${longest.passes}本）。`);
  }

  // ---- 選手ごと ----
  const byTeam = [0, 1].map((t) => {
    const ps = result.players.filter((p) => p.team === t);
    const named = ps.filter((p) => labelOf(p.id)?.num).sort((a, b) => Number(labelOf(a.id).num) - Number(labelOf(b.id).num));
    const unnamed = ps.filter((p) => !labelOf(p.id)?.num);
    const sum = (arr, k) => arr.reduce((acc, p) => acc + p[k], 0);
    const rest = unnamed.length ? {
      label: '番号なし（合計）', time: sum(unnamed, 'time'), touches: sum(unnamed, 'touches'), passes: sum(unnamed, 'passes'),
      passAttempts: sum(unnamed, 'passAttempts'), shots: sum(unnamed, 'shots'), steals: sum(unnamed, 'steals'), dribbles: sum(unnamed, 'dribbles'),
    } : null;
    return { named, rest };
  });
  const playerRow = (p, label) => `
    <tr><td>${esc(label)}</td><td>${fmtTime(p.time)}</td><td>${p.touches}</td><td>${p.passes} / ${p.passAttempts}</td>
    <td>${p.shots}</td><td>${p.steals}</td><td>${p.dribbles}</td></tr>`;

  // ---- 主な場面 ----
  const keyEvents = result.events.filter((e) => e.type === 'shot' || e.type === 'steal');

  // ---- HTML ----
  const title = `試合レポート${memo ? `（${esc(memo)}）` : ''}`;
  const bandRows = bands.map((b) => {
    const a = b.pa === null ? null : pct(b.pa);
    return `
      <div class="band">
        <span class="band-time">${fmtTime(b.s)}〜${fmtTime(b.e)}</span>
        <span class="band-bar" role="img" aria-label="${tn(0)} ${a ?? '-'}%、${tn(1)} ${a === null ? '-' : 100 - a}%">
          ${a === null ? '<span class="band-none">保持データなし</span>' : `
          <span style="width:${a}%;background:${colors[0]}"></span><span style="width:${100 - a}%;background:${colors[1]}"></span>`}
        </span>
        <span class="band-num">${a === null ? '—' : `${a} : ${100 - a}`}</span>
        <span class="band-shots">シュート ${b.shots[0]} : ${b.shots[1]}</span>
      </div>`;
  }).join('');

  const phaseRows = shown.map((ph) => `
    <li class="ph ph-end-${ph.end.type}">
      <button type="button" data-t="${ph.t0}">
        <time>${fmtTime(ph.t0)}</time>
        <span class="ph-team"><span class="swatch" style="--c:${colors[ph.team]}"></span>${tn(ph.team)}</span>
        <span class="ph-text">${esc(phaseSentence(ph, short, full))}</span>
      </button>
    </li>`).join('');

  const html = `
    <header class="rp-head">
      <h2>${title}</h2>
      <p class="muted small">${esc(videoName || '')}　解析範囲 ${fmtTime(r0)}〜${fmtTime(r1)}　作成 ${new Date().toLocaleDateString('ja-JP')}</p>
      <p class="rp-teams">
        <span><span class="swatch" style="--c:${colors[0]}"></span>${tn(0)}（画面の${T[0].attackDir === 1 ? '右' : '左'}へ攻撃）</span>
        <span><span class="swatch" style="--c:${colors[1]}"></span>${tn(1)}（画面の${T[1].attackDir === 1 ? '右' : '左'}へ攻撃）</span>
      </p>
    </header>

    <section class="rp-sec">
      <h3>まとめ</h3>
      ${lines.map((l) => `<p>${l}</p>`).join('')}
    </section>

    <section class="rp-sec">
      <h3>時間帯ごとのボール保持（${tn(0)} : ${tn(1)}）</h3>
      <div class="bands">${bandRows}</div>
    </section>

    <section class="rp-sec">
      <h3>試合の流れ</h3>
      <p class="muted small">時刻をタップすると、その場面から動画を再生します。${hidden ? `短い競り合い・すぐに相手に渡った場面（${hidden}回）は省略しています。` : ''}</p>
      <ol class="phases">${phaseRows || '<li class="ev-empty">攻撃の流れは検出されませんでした。</li>'}</ol>
    </section>

    <section class="rp-sec">
      <h3>主な場面</h3>
      <ol class="keys">
        ${keyEvents.length ? keyEvents.map((e) => `
          <li><button type="button" data-t="${e.t}"><time>${fmtTime(e.t)}</time>
            <span>${esc(e.type === 'shot' ? `${full(e.by)}がシュート` : `${full(e.by)}がボールを奪う`)}</span></button></li>`).join('')
        : '<li class="ev-empty">シュート・ボール奪取は検出されませんでした。</li>'}
      </ol>
    </section>

    <section class="rp-sec">
      <h3>選手ごとの記録</h3>
      <div class="rp-players">
        ${[0, 1].map((t) => `
          <div>
            <h4><span class="swatch" style="--c:${colors[t]}"></span>${tn(t)}</h4>
            <div class="table-scroll"><table>
              <thead><tr><th>番号</th><th>出場</th><th>タッチ</th><th>パス</th><th>シュート</th><th>奪取</th><th>ドリブル</th></tr></thead>
              <tbody>
                ${byTeam[t].named.map((p) => playerRow(p, `${labelOf(p.id).num}番`)).join('')}
                ${byTeam[t].rest ? playerRow(byTeam[t].rest, byTeam[t].rest.label) : ''}
              </tbody>
            </table></div>
          </div>`).join('')}
      </div>
      <p class="muted small">出場時間は映像に映っていた時間の目安です。パスは「成功 / 試行」。</p>
    </section>

    <p class="rp-note muted small">このレポートは映像からAIが推定したもので、判定の誤りや見落としを含みます。振り返りの参考としてお使いください。</p>`;

  // ---- コピー用テキスト ----
  const plain = (s) => String(s).replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  const txt = [];
  txt.push(plain(title));
  txt.push(`解析範囲 ${fmtTime(r0)}〜${fmtTime(r1)}`);
  txt.push('');
  txt.push('■まとめ');
  for (const l of lines) txt.push(plain(l));
  txt.push('');
  txt.push('■試合の流れ');
  for (const ph of shown) txt.push(`${fmtTime(ph.t0)} [${plain(tn(ph.team))}] ${phaseSentence(ph, short, full)}`);
  txt.push('');
  txt.push('■選手ごとの記録（タッチ / パス成功 / シュート / 奪取）');
  for (const t of [0, 1]) {
    txt.push(`[${plain(tn(t))}]`);
    for (const p of byTeam[t].named) txt.push(`${labelOf(p.id).num}番：${p.touches} / ${p.passes} / ${p.shots} / ${p.steals}`);
    if (byTeam[t].rest) { const r = byTeam[t].rest; txt.push(`番号なし（合計）：${r.touches} / ${r.passes} / ${r.shots} / ${r.steals}`); }
  }
  txt.push('');
  txt.push('※映像からAIが推定した内容で、誤りを含みます。');

  return { html, text: txt.join('\n'), phases: shown.length };
}
