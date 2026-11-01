// 実況文の生成と、ブラウザ標準の音声合成（Web Speech API）による読み上げ。

const TEAM_NAMES = ['チームA', 'チームB'];
export const teamName = (t) => (t >= 0 ? TEAM_NAMES[t] : '不明');

const pick = (arr, k) => arr[k % arr.length];

function line(e, k) {
  const tn = teamName(e.team);
  switch (e.type) {
    case 'pass':
      return pick([
        `${tn}、選手${e.from}から選手${e.to}へパス。`,
        `選手${e.from}、${Math.round(e.length)}メートルのパスを選手${e.to}へ。`,
        `${tn}、つないでいきます。選手${e.to}が受けた。`,
        `選手${e.to}へ、きれいに通りました。`,
      ], k);
    case 'steal':
      return pick([
        `${tn}の選手${e.by}がボールを奪った！`,
        `カット！ 選手${e.by}、${tn}ボールに変わります。`,
        `選手${e.by}、うまく奪い取りました！`,
      ], k);
    case 'dribble':
      return pick([
        `選手${e.by}、ドリブルで${Math.round(e.distance)}メートル運びます。`,
        `${tn}の選手${e.by}、持ち上がる！`,
      ], k);
    case 'shot':
      if (e.goal) {
        return pick([
          `ゴール！ ${tn}、選手${e.by}が決めました！`,
          `入ったー！ 選手${e.by}のシュートがネットを揺らします！`,
        ], k);
      }
      return pick([
        `${tn}、選手${e.by}がシュート！`,
        `打った！ 選手${e.by}、ゴールを狙います！`,
      ], k);
    default:
      return '';
  }
}

export function buildCommentary(result) {
  return result.events.map((e, k) => ({ t: e.t, type: e.goal ? 'goal' : e.type, text: line(e, k) }));
}

const PRIORITY = { pass: 0, dribble: 1, steal: 1, shot: 2, goal: 3 };

export class Commentator {
  constructor() {
    this.enabled = true;
    this.voice = null;
    this.supported = 'speechSynthesis' in window;
    if (!this.supported) return;
    const choose = () => {
      const vs = speechSynthesis.getVoices();
      this.voice =
        vs.find((v) => v.lang === 'ja-JP' && /Google|Kyoko|Otoya|Nanami|Keita/.test(v.name)) ||
        vs.find((v) => v.lang && v.lang.startsWith('ja')) ||
        null;
    };
    choose();
    speechSynthesis.addEventListener('voiceschanged', choose);
  }

  say(item) {
    if (!this.enabled || !this.supported) return;
    const pr = PRIORITY[item.type] ?? 0;
    const busy = speechSynthesis.speaking || speechSynthesis.pending;
    if (busy) {
      if (pr >= 2) speechSynthesis.cancel(); // シュート・ゴールは割り込んで読む
      else return;                          // それ以外は話し中なら飛ばす
    }
    const u = new SpeechSynthesisUtterance(item.text);
    u.lang = 'ja-JP';
    if (this.voice) u.voice = this.voice;
    u.rate = pr >= 2 ? 1.25 : 1.1;
    u.pitch = pr >= 3 ? 1.25 : 1.0;
    speechSynthesis.speak(u);
  }

  stop() {
    if (this.supported) speechSynthesis.cancel();
  }
}
