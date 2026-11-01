// 追跡ID（途切れるたびに新しくなる）を、背番号の付いた「選手」にまとめる。
// - 同じチームで同じ番号を付けたIDは自動で1人にまとめる
// - 番号が読めないIDも「同じ子」として手動でつなげられる
// - 時間・位置がつながりそうなIDの組み合わせを候補として出す
import { labDist, rgbToLab } from './teams.js';

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

// frames から追跡IDごとの情報をまとめる
export function buildTrackInfo(frames, fps, autoTeam, extras = {}) {
  const map = new Map();
  frames.forEach((f, i) => {
    for (const p of f.players) {
      let tr = map.get(p.id);
      if (!tr) {
        tr = { id: p.id, i0: i, i1: i, t0: f.t, t1: f.t, p0: p.w, p1: p.w, wh0: p.wh, wh1: p.wh, n: 0 };
        map.set(p.id, tr);
      }
      tr.i1 = i; tr.t1 = f.t; tr.p1 = p.w; tr.wh1 = p.wh; tr.n++;
    }
  });
  for (const tr of map.values()) {
    tr.time = tr.n / fps;
    tr.autoTeam = autoTeam(tr.id);
    tr.rgb = extras.rgb?.get(tr.id) || null;
    tr.thumbs = extras.thumbs?.get(tr.id) || [];
  }
  return map;
}

export class Identity {
  constructor(tracks, saved = null, opt = {}) {
    this.tracks = tracks; // Map id -> info
    this.opt = opt;
    this.parent = new Map();
    this.labels = new Map(); // root -> { num, team }
    this.dismissed = new Set();
    if (saved) {
      for (const [a, b] of saved.parent || []) this.parent.set(a, b);
      for (const [a, l] of saved.labels || []) this.labels.set(a, l);
      for (const k of saved.dismissed || []) this.dismissed.add(k);
    }
    this.version = 0;
    this._groups = null;
  }

  serialize() {
    return { parent: [...this.parent], labels: [...this.labels], dismissed: [...this.dismissed] };
  }

  touch() { this.version++; this._groups = null; }

  find(id) {
    let r = id;
    while (this.parent.has(r) && this.parent.get(r) !== r) r = this.parent.get(r);
    let c = id;
    while (c !== r) { const nx = this.parent.get(c); this.parent.set(c, r); c = nx; }
    return r;
  }

  union(a, b) {
    const ra = this.find(a), rb = this.find(b);
    if (ra === rb) return ra;
    const ga = this.groupMap().get(ra), gb = this.groupMap().get(rb);
    const [keep, drop] = (ga?.time || 0) >= (gb?.time || 0) ? [ra, rb] : [rb, ra];
    const lk = this.labels.get(keep) || {}, ld = this.labels.get(drop) || {};
    this.parent.set(drop, keep);
    this.labels.set(keep, { num: lk.num || ld.num || '', team: lk.team ?? ld.team ?? null });
    this.labels.delete(drop);
    this.touch();
    return keep;
  }

  // 1人分のまとまりを外す（番号を消す）
  setNum(root, raw) {
    const num = String(raw || '').replace(/[^0-9０-９]/g, '').replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xFEE0)).slice(0, 3);
    const l = this.labels.get(root) || { num: '', team: null };
    this.labels.set(root, { ...l, num });
    this.touch();
    if (!num) return root;
    const team = this.groupMap().get(root)?.team;
    for (const g of this.groupMap().values()) {
      if (g.root !== root && g.num === num && g.team === team) return this.union(root, g.root);
    }
    return root;
  }

  setTeam(root, team) {
    const l = this.labels.get(root) || { num: '', team: null };
    this.labels.set(root, { ...l, team });
    this.touch();
    const g = this.groupMap().get(root);
    if (g?.num) return this.setNum(root, g.num); // 移った先に同じ番号がいればまとめる
    return root;
  }

  // まとめを解除して、追跡IDごとに戻す（番号は一番長く映っていたIDにだけ残す）
  split(root) {
    const g = this.groupMap().get(this.find(root));
    if (!g || g.ids.length < 2) return;
    const label = this.labels.get(g.root);
    const main = g.tracks.reduce((a, b) => (b.time > a.time ? b : a)).id;
    for (const id of g.ids) { this.parent.delete(id); this.labels.delete(id); }
    if (label) this.labels.set(main, label);
    // 解除した組み合わせは候補に出さない
    for (const a of g.ids) for (const b of g.ids) if (a < b) this.dismissed.add(`${a}-${b}`);
    this.touch();
  }

  dismiss(a, b) {
    const ra = this.find(a), rb = this.find(b);
    this.dismissed.add(ra < rb ? `${ra}-${rb}` : `${rb}-${ra}`);
    this.touch();
  }

  groupMap() {
    if (this._groups) return this._groups;
    const gm = new Map();
    for (const tr of this.tracks.values()) {
      const root = this.find(tr.id);
      let g = gm.get(root);
      if (!g) { g = { root, ids: [], tracks: [], time: 0, n: 0, teamVotes: [0, 0, 0], t0: Infinity, t1: -Infinity }; gm.set(root, g); }
      g.ids.push(tr.id);
      g.tracks.push(tr);
      g.time += tr.time;
      g.n += tr.n;
      g.t0 = Math.min(g.t0, tr.t0);
      g.t1 = Math.max(g.t1, tr.t1);
      g.teamVotes[tr.autoTeam >= 0 ? tr.autoTeam : 2] += tr.n;
    }
    for (const g of gm.values()) {
      const l = this.labels.get(g.root) || {};
      const v = g.teamVotes;
      const auto = v[0] >= v[1] ? (v[0] >= v[2] ? 0 : -1) : (v[1] >= v[2] ? 1 : -1);
      g.team = l.team === 0 || l.team === 1 || l.team === -1 ? l.team : auto;
      g.num = l.num || '';
      const th = g.tracks.flatMap((t) => t.thumbs).sort((a, b) => b.h - a.h);
      g.thumbs = [];
      for (const x of th) {
        if (g.thumbs.length >= 4) break;
        if (g.thumbs.every((y) => Math.abs(y.t - x.t) > 3)) g.thumbs.push(x);
      }
    }
    this._groups = gm;
    return gm;
  }

  groups() { return [...this.groupMap().values()]; }

  keyOfTrack(id) {
    const g = this.groupMap().get(this.find(id));
    if (!g || g.team < 0) return null;
    return g.num ? `${g.team}:${g.num}` : `G${g.root}`;
  }

  infoOfTrack(id) {
    const g = this.groupMap().get(this.find(id));
    if (!g) return { team: -1, text: '' };
    return { team: g.team, text: g.num || '' };
  }

  // 「同じ子かもしれない」組み合わせ
  suggestions(limit = 8, team = null) {
    const o = this.opt;
    const gm = this.groupMap();
    const list = [...this.tracks.values()].filter((t) => t.n >= 3).sort((a, b) => a.t0 - b.t0);
    const overlap = (ga, gb) => {
      let s = 0;
      for (const x of ga.tracks) for (const y of gb.tracks) s += Math.max(0, Math.min(x.t1, y.t1) - Math.max(x.t0, y.t0));
      return s;
    };
    const best = new Map();
    const firstFrom = (t) => {
      let lo = 0, hi = list.length;
      while (lo < hi) { const m = (lo + hi) >> 1; if (list[m].t0 < t) lo = m + 1; else hi = m; }
      return lo;
    };
    for (const x of list) {
      const gx = gm.get(this.find(x.id));
      if (!gx || gx.team < 0 || (team !== null && gx.team !== team)) continue;
      for (let yi = firstFrom(x.t1 - 0.3); yi < list.length; yi++) {
        const y = list[yi];
        const gap = y.t0 - x.t1;
        if (gap > o.maxGap) break;
        const gy = gm.get(this.find(y.id));
        if (!gy || gy === gx || gy.team !== gx.team) continue;
        if (gx.num && gy.num) continue;
        const key = gx.root < gy.root ? `${gx.root}-${gy.root}` : `${gy.root}-${gx.root}`;
        if (this.dismissed.has(key)) continue;
        const sc = ((x.wh1 + y.wh0) / 2) / o.playerHeight;
        const meters = dist(x.p1, y.p0) / sc;
        const allowed = 2 + o.maxSpeed * Math.max(0, gap);
        if (meters > allowed) continue;
        const cd = x.rgb && y.rgb ? labDist(rgbToLab(x.rgb), rgbToLab(y.rgb)) : 20;
        const score = (meters / allowed) * 0.5 + (Math.max(0, gap) / o.maxGap) * 0.3 + (Math.min(cd, 40) / 40) * 0.2;
        const prev = best.get(key);
        if (!prev || score < prev.score) best.set(key, { a: gx, b: gy, score, gap, at: x.t1, from: x.id, to: y.id });
      }
    }
    const cands = [...best.values()].filter((c) => overlap(c.a, c.b) <= 0.5);
    cands.sort((p, q) => ((q.a.num || q.b.num ? 1 : 0) - (p.a.num || p.b.num ? 1 : 0)) || p.score - q.score);
    const used = new Set(), out = [];
    for (const c of cands) {
      if (used.has(c.a.root) || used.has(c.b.root)) continue;
      used.add(c.a.root); used.add(c.b.root);
      out.push(c);
      if (out.length >= limit) break;
    }
    return { items: out, total: cands.length };
  }
}
