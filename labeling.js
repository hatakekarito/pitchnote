// 「選手に番号を付ける」画面。写真一覧・番号入力・つながりの候補。
import { fmtTime } from './report.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const PAGE = 24;

export class LabelingUI {
  constructor(els, { getIdentity, getTeamNames, getColors, minTime, onChange, onShow }) {
    this.els = els;
    this.getIdentity = getIdentity;
    this.getTeamNames = getTeamNames;
    this.getColors = getColors;
    this.minTime = minTime;
    this.onChange = onChange;
    this.onShow = onShow;
    this.tab = 0;
    this.limit = PAGE;
    this.focusAfter = null;

    els.tabs.addEventListener('click', (e) => {
      const b = e.target.closest('[data-lbtab]');
      if (!b) return;
      this.tab = Number(b.dataset.lbtab);
      this.limit = PAGE;
      this.render();
    });
    els.onlyEmpty.addEventListener('change', () => { this.limit = PAGE; this.render(); });
    els.more.addEventListener('click', () => { this.limit += PAGE; this.render(); });

    els.cards.addEventListener('change', (e) => this.handleCardChange(e));
    els.cards.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.target.matches('[data-num]')) { e.preventDefault(); e.target.blur(); }
    });
    els.cards.addEventListener('click', (e) => {
      const card = e.target.closest('[data-root]');
      if (!card) return;
      const root = Number(card.dataset.root);
      if (e.target.closest('[data-split]')) {
        if (!confirm('まとめた写真を、元のばらばらの状態に戻しますか？')) return;
        this.getIdentity().split(root);
        this.changed();
        return;
      }
      if (!e.target.closest('[data-show]')) return;
      const g = this.getIdentity().groupMap().get(root);
      if (g) this.onShow(g);
    });
    els.suggest.addEventListener('click', (e) => {
      const item = e.target.closest('[data-a]');
      if (!item) return;
      const id = this.getIdentity();
      const a = Number(item.dataset.a), b = Number(item.dataset.b);
      if (e.target.closest('[data-same]')) { id.union(a, b); this.changed(); }
      else if (e.target.closest('[data-diff]')) { id.dismiss(a, b); this.changed(); }
      else if (e.target.closest('[data-sgshow]')) {
        const gm = id.groupMap();
        const ga = gm.get(id.find(a)), gb = gm.get(id.find(b));
        if (ga && gb) this.onShow({ ...gb, ids: [...ga.ids, ...gb.ids], showAt: Number(item.dataset.at) });
      }
    });
  }

  handleCardChange(e) {
    const card = e.target.closest('[data-root]');
    if (!card) return;
    const id = this.getIdentity();
    const root = Number(card.dataset.root);
    if (e.target.matches('[data-num]')) {
      const next = card.nextElementSibling?.dataset.root;
      const nr = id.setNum(root, e.target.value);
      this.focusAfter = next !== undefined ? Number(next) : null;
      if (nr !== root && this.focusAfter === root) this.focusAfter = null;
      this.changed();
    } else if (e.target.matches('[data-team]')) {
      id.setTeam(root, Number(e.target.value));
      this.changed();
    }
  }

  changed() {
    this.render();
    this.onChange();
  }

  thumbs(g, max = 4) {
    if (!g.thumbs.length) return '<span class="lb-nothumb">写真なし</span>';
    return g.thumbs.slice(0, max).map((th) => `<img src="${th.url}" alt="${fmtTime(th.t)}の姿" loading="lazy">`).join('');
  }

  render() {
    const id = this.getIdentity();
    if (!id) return;
    const names = this.getTeamNames();
    const colors = this.getColors();
    const all = id.groups().filter((g) => g.time >= this.minTime);

    // 進捗
    const players = all.filter((g) => g.team >= 0);
    const labeled = players.filter((g) => g.num);
    const tAll = players.reduce((a, g) => a + g.time, 0) || 1;
    const tLab = labeled.reduce((a, g) => a + g.time, 0);
    this.els.progress.textContent =
      `番号入力済み ${labeled.length} / ${players.length} 件（映っていた時間の ${Math.round((tLab / tAll) * 100)}% をカバー）`;

    // タブ
    const counts = [0, 1, -1].map((t) => all.filter((g) => g.team === t).length);
    this.els.tabs.innerHTML = [0, 1, 2].map((k) => {
      const label = k === 2 ? '除外した人' : esc(names[k]);
      const sw = k === 2 ? '' : `<span class="swatch" style="--c:${colors[k]}"></span>`;
      return `<button type="button" data-lbtab="${k}" aria-pressed="${this.tab === k}">${sw}${label}（${counts[k]}）</button>`;
    }).join('');

    // つながりの候補（チームのタブのときだけ）
    if (this.tab !== 2) {
      const { items: mine, total } = id.suggestions(6, this.tab);
      this.els.suggest.hidden = !mine.length;
      this.els.suggest.innerHTML = mine.length ? `
        <h3>同じ子かもしれない組み合わせ<span class="muted small">（候補 ${total} 件）</span></h3>
        <p class="muted small">ある選手を見失った直後に、近くに同じチームの選手が現れた組み合わせです。同じ子なら1人にまとめます。</p>
        <ul class="sg-list">${mine.map((c) => `
          <li class="sg-item" data-a="${c.a.root}" data-b="${c.b.root}" data-at="${c.at}">
            <div class="sg-pair">
              <div class="sg-side"><div class="lb-thumbs">${this.thumbs(c.a, 2)}</div><span>${c.a.num ? `${esc(c.a.num)}番` : '番号なし'}</span></div>
              <span class="sg-arrow" aria-hidden="true">→</span>
              <div class="sg-side"><div class="lb-thumbs">${this.thumbs(c.b, 2)}</div><span>${c.b.num ? `${esc(c.b.num)}番` : '番号なし'}</span></div>
            </div>
            <p class="small muted">${fmtTime(c.at)}ごろに入れ替わり</p>
            <div class="sg-actions">
              <button type="button" class="btn small-btn" data-same>同じ子</button>
              <button type="button" class="btn ghost small-btn" data-diff>違う</button>
              <button type="button" class="linkish" data-sgshow>動画で見る</button>
            </div>
          </li>`).join('')}</ul>` : '';
    } else {
      this.els.suggest.hidden = true;
      this.els.suggest.innerHTML = '';
    }

    // 写真一覧
    const teamOf = this.tab === 2 ? -1 : this.tab;
    let list = all.filter((g) => g.team === teamOf);
    if (this.els.onlyEmpty.checked && this.tab !== 2) list = list.filter((g) => !g.num);
    list.sort((a, b) => b.time - a.time);
    const shown = list.slice(0, this.limit);
    this.els.cards.innerHTML = shown.map((g) => `
      <li class="lb-card${g.num ? ' is-done' : ''}" data-root="${g.root}">
        <div class="lb-thumbs">${this.thumbs(g)}</div>
        <div class="lb-body">
          <label class="lb-num">番号<input type="text" inputmode="numeric" maxlength="3" value="${esc(g.num)}" data-num aria-label="背番号"></label>
          <select data-team aria-label="チーム">
            <option value="0"${g.team === 0 ? ' selected' : ''}>${esc(names[0])}</option>
            <option value="1"${g.team === 1 ? ' selected' : ''}>${esc(names[1])}</option>
            <option value="-1"${g.team === -1 ? ' selected' : ''}>除外</option>
          </select>
          <p class="muted small">映っていた時間 ${fmtTime(g.time)}（${fmtTime(g.t0)}〜${fmtTime(g.t1)}）${g.ids.length > 1 ? `・${g.ids.length}件をまとめ済み` : ''}</p>
          <span class="lb-links">
            <button type="button" class="linkish" data-show>動画で見る</button>
            ${g.ids.length > 1 ? '<button type="button" class="linkish" data-split>まとめを解除</button>' : ''}
          </span>
        </div>
      </li>`).join('') || `<li class="ev-empty">${this.tab === 2 ? '除外した人はいません。' : 'このチームで表示する選手はいません。'}</li>`;
    this.els.more.hidden = list.length <= this.limit;
    this.els.more.textContent = `もっと表示（残り ${Math.max(0, list.length - this.limit)} 件）`;

    if (this.focusAfter !== null) {
      const el = this.els.cards.querySelector(`[data-root="${this.focusAfter}"] [data-num]`);
      if (el) el.focus({ preventScroll: false });
      this.focusAfter = null;
    }
  }
}
