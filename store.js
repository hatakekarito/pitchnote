// 解析結果をこの端末のブラウザ（IndexedDB）に保存する。外部には送信しない。

const DB = 'pitchnote';
const VER = 1;

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, VER);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('data')) db.createObjectStore('data', { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function run(stores, mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(stores, mode);
    const out = fn(tx);
    tx.oncomplete = () => { db.close(); resolve(out && 'result' in out ? out.result : out); };
    tx.onerror = () => { db.close(); reject(tx.error); };
    tx.onabort = () => { db.close(); reject(tx.error); };
  });
}

export function metaOf(s) {
  return { id: s.id, createdAt: s.createdAt, updatedAt: Date.now(), video: s.video, range: s.range, memo: s.memo, teamNames: s.teamNames };
}

export async function saveSession(s) {
  await run(['meta', 'data'], 'readwrite', (tx) => {
    tx.objectStore('meta').put(metaOf(s));
    tx.objectStore('data').put(s);
  });
}

export async function listSessions() {
  const all = await run(['meta'], 'readonly', (tx) => tx.objectStore('meta').getAll());
  return (all || []).sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function loadSession(id) {
  return run(['data'], 'readonly', (tx) => tx.objectStore('data').get(id));
}

export async function deleteSession(id) {
  await run(['meta', 'data'], 'readwrite', (tx) => {
    tx.objectStore('meta').delete(id);
    tx.objectStore('data').delete(id);
  });
}

// ---- コマごとのデータを詰めて保存（サイズを小さくするため） ----
const PW = 8; // id, x1, y1, x2, y2, wx, wy, wh
const BW = 7; // x1, y1, x2, y2, wx, wy, score

export function packFrames(frames) {
  const n = frames.length;
  let total = 0;
  for (const f of frames) total += f.players.length;
  const t = new Float64Array(n);
  const count = new Uint16Array(n);
  const p = new Float32Array(total * PW);
  const b = new Float32Array(n * BW).fill(NaN);
  let k = 0;
  frames.forEach((f, i) => {
    t[i] = f.t;
    count[i] = f.players.length;
    for (const pl of f.players) {
      p.set([pl.id, ...pl.box, pl.w[0], pl.w[1], pl.wh], k);
      k += PW;
    }
    if (f.ball) b.set([...f.ball.box, f.ball.w[0], f.ball.w[1], f.ball.score], i * BW);
  });
  return { t, count, p, b };
}

export function unpackFrames({ t, count, p, b }) {
  const frames = [];
  let k = 0;
  for (let i = 0; i < t.length; i++) {
    const players = [];
    for (let j = 0; j < count[i]; j++, k += PW) {
      players.push({
        id: Math.round(p[k]),
        box: [p[k + 1], p[k + 2], p[k + 3], p[k + 4]],
        w: [p[k + 5], p[k + 6]],
        wh: p[k + 7],
      });
    }
    const o = i * BW;
    const ball = Number.isNaN(b[o]) ? null
      : { box: [b[o], b[o + 1], b[o + 2], b[o + 3]], w: [b[o + 4], b[o + 5]], score: b[o + 6] };
    frames.push({ t: t[i], players, ball });
  }
  return frames;
}
