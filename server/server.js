// Гарехабба — сервер мультиплеера: статика + WebSocket-релей (/ws).
// Node >= 20, ESM. Единственная зависимость — ws.
// Протокол и требования — NETWORK.md (контракт, исполняется буквально).

import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

// ---------- Конфигурация ----------
const PORT = Number(process.env.PORT) || 8137;
const MAX_PLAYERS = 16;             // cap комнаты
const PING_INTERVAL_MS = 30_000;    // чистка мёртвых сокетов
const MAX_MESSAGE_BYTES = 4096;     // максимум на одно WS-сообщение
const RL_SNAPSHOTS_PER_SEC = 22;    // ~20/с + небольшой запас на джиттер
const RL_THROWS_PER_SEC = 5;        // ~4/с + запас
const RL_TOTAL_PER_SEC = 60;        // общий потолок сообщений на клиента

// Корень статики — на уровень выше server/ (вычисляем от import.meta.url).
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ---------- Утилиты валидации (никакого доверия полям) ----------
function num(v, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null; // NaN/Infinity/мусор → сообщение отбрасывается
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

function vec3(v, lim = 1000) {
  if (!Array.isArray(v) || v.length < 3) return null;
  const out = [];
  for (let i = 0; i < 3; i++) {
    const n = Number(v[i]);
    if (!Number.isFinite(n)) return null;
    out.push(Math.max(-lim, Math.min(lim, n)));
  }
  return out;
}

function cleanName(raw, id) {
  let name = typeof raw === 'string' ? raw : '';
  name = name.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 16).trim();
  return name || `Саар-${id}`;
}

// ---------- Скорборд: хранилище очков + персистентность ----------
const SCORES_FILE = process.env.SCORES_FILE || path.join(ROOT, 'data', 'scores.json');
const SCORES_MAX_IDS = 500;               // максимум разных id (новые вытесняют худших)
const SCORES_TOP = 20;                    // сколько отдаём в GET /api/scores
const SCORE_POST_MIN_MS = 5000;           // ≥5 с между POST с одного id и с одного IP
const SCORE_MAX_BODY = 2048;              // Content-Length ≤ 2КБ
const SCORES_SAVE_DEBOUNCE_MS = 2000;     // дебаунс записи файла

const scores = new Map(); // id -> { name, money, quests, hits, battles, photos, ts }

// Целое с клампом; NaN/мусор → 0 (контракт скорборда).
function clampInt(v, min, max) {
  let n = Number(v);
  if (!Number.isFinite(n)) n = 0;
  n = Math.round(n);
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

function cleanScoreName(raw) {
  let name = typeof raw === 'string' ? raw : '';
  name = name.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 16).trim();
  return name || 'Саар';
}

function sanitizeScore(rec) {
  return {
    name: cleanScoreName(rec.name),
    money: clampInt(rec.money, 0, 9_999_999),
    quests: clampInt(rec.quests, 0, 8),
    hits: clampInt(rec.hits, 0, 999_999),
    battles: clampInt(rec.battles, 0, 999_999),
    photos: clampInt(rec.photos, 0, 999_999),
    ts: clampInt(rec.ts ?? Date.now(), 0, 8_640_000_000_000_000),
  };
}

// Худшая запись — с минимальным money (при равенстве — самая старая).
function evictWorstScore() {
  let worstId = null, worst = null;
  for (const [id, r] of scores) {
    if (!worst || r.money < worst.money || (r.money === worst.money && r.ts < worst.ts)) {
      worst = r; worstId = id;
    }
  }
  if (worstId !== null) scores.delete(worstId);
}

function loadScores() {
  try {
    fs.mkdirSync(path.dirname(SCORES_FILE), { recursive: true });
  } catch (e) {
    console.warn('[scores] не удалось создать каталог для очков:', e && e.message ? e.message : e);
  }
  try {
    if (!fs.existsSync(SCORES_FILE)) return;
    const data = JSON.parse(fs.readFileSync(SCORES_FILE, 'utf8'));
    if (!Array.isArray(data)) throw new Error('ожидался массив записей');
    for (const rec of data) {
      if (!rec || typeof rec !== 'object' || typeof rec.id !== 'string' || !rec.id) continue;
      scores.set(rec.id.slice(0, 64), sanitizeScore(rec));
      if (scores.size >= SCORES_MAX_IDS) break;
    }
    console.log(`[scores] загружено записей: ${scores.size} (${SCORES_FILE})`);
  } catch (e) {
    console.warn('[scores] файл очков битый или нечитаемый — начинаем с пустого списка:',
      e && e.message ? e.message : e);
    scores.clear();
  }
}

let scoresDirty = false;
let scoresSaveTimer = null;

// Атомарная запись: tmp + rename, чтобы не оставить полфайла.
function saveScoresNow() {
  if (!scoresDirty) return;
  scoresDirty = false;
  try {
    const arr = [];
    for (const [id, r] of scores) arr.push({ id, ...r });
    const tmp = SCORES_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(arr));
    fs.renameSync(tmp, SCORES_FILE);
  } catch (e) {
    console.warn('[scores] не удалось сохранить очки:', e && e.message ? e.message : e);
  }
}

function scheduleScoresSave() {
  scoresDirty = true;
  if (scoresSaveTimer) return;
  scoresSaveTimer = setTimeout(() => {
    scoresSaveTimer = null;
    saveScoresNow();
  }, SCORES_SAVE_DEBOUNCE_MS);
  if (scoresSaveTimer.unref) scoresSaveTimer.unref();
}

loadScores();

// Rate-limit POST /api/score: и по id, и по IP (принятые POSTы).
const scoreLastById = new Map(); // id -> ts последнего принятого POST
const scoreLastByIp = new Map(); // ip -> ts
function pruneRateMap(map, now) {
  if (map.size < 2000) return;
  for (const [k, t] of map) {
    if (now - t >= SCORE_POST_MIN_MS) map.delete(k);
  }
}

// X-Forwarded-For спуфится клиентом, поэтому доверяем ему ТОЛЬКО когда админ
// явно сказал, что мы за прокси (TRUST_PROXY=1), и берём ПОСЛЕДНИЙ hop —
// его дописывает сам прокси, подделать его клиент не может.
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
function clientIp(req) {
  if (TRUST_PROXY) {
    const xff = req.headers['x-forwarded-for'];
    if (typeof xff === 'string' && xff.length) {
      const parts = xff.split(',');
      const last = parts[parts.length - 1].trim();
      if (last) return last.slice(0, 64);
    }
  }
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

// Глобальный предохранитель: не больше 20 принятых POST /api/score в секунду
// на процесс — даже армия спуферов не выселит живых игроков мгновенно.
let postWindowStart = 0;
let postWindowCount = 0;
function globalPostAllowed(now) {
  if (now - postWindowStart >= 1000) { postWindowStart = now; postWindowCount = 0; }
  if (postWindowCount >= 20) return false;
  postWindowCount++;
  return true;
}

// ---------- HTTP: статика + /healthz ----------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
};

function sendText(res, code, text) {
  try {
    res.writeHead(code, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
    res.end(text);
  } catch { /* сокет мог умереть — не падаем */ }
}

function sendJson(res, code, obj) {
  try {
    const body = JSON.stringify(obj);
    res.writeHead(code, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(body),
      'cache-control': 'no-store',
    });
    res.end(body);
  } catch { /* сокет мог умереть — не падаем */ }
}

// Читаем тело запроса с жёстким лимитом; null — слишком большое или сеть порвалась.
// Сокет не рвём сами: даём хендлеру ответить по-человечески (413), node закроет сам.
function readBody(req, limit) {
  return new Promise((resolve) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > limit) {
      resolve(null);
      return;
    }
    const chunks = [];
    let size = 0;
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    req.on('data', (chunk) => {
      if (done) return; // лишнее после переполнения просто игнорируем
      size += chunk.length;
      if (size > limit) { finish(null); return; }
      chunks.push(chunk);
    });
    req.on('end', () => finish(Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => finish(null));
  });
}

// Публичная метка игрока: усечённый sha256 от id. По ней клиент узнаёт «свою»
// строку в топе, но восстановить из неё секретный id нельзя.
function tagOf(id) {
  return crypto.createHash('sha256').update(String(id)).digest('hex').slice(0, 8);
}

// GET /api/scores → топ-20 по money (убыв.).
function handleGetScores(res) {
  const top = [...scores.entries()]
    .sort(([, a], [, b]) => (b.money - a.money) || (a.ts - b.ts))
    .slice(0, SCORES_TOP)
    .map(([id, r]) => ({
      tag: tagOf(id),
      name: r.name, money: r.money, quests: r.quests,
      hits: r.hits, battles: r.battles, photos: r.photos, ts: r.ts,
    }));
  sendJson(res, 200, { scores: top });
}

// POST /api/score → сохранить лучший результат игрока.
async function handlePostScore(req, res) {
  const body = await readBody(req, SCORE_MAX_BODY);
  if (body === null) {
    sendText(res, 413, 'слишком много букв, саар');
    return;
  }

  let msg;
  try { msg = JSON.parse(body); } catch { msg = null; }
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)
      || typeof msg.id !== 'string' || !msg.id.trim()) {
    sendText(res, 400, 'кривые данные, саар');
    return;
  }
  const id = msg.id.trim().slice(0, 64);

  // Rate-limit: ≥5 с между принятыми POST с одного id И с одного IP. Молча 429.
  const now = Date.now();
  if (!globalPostAllowed(now)) {
    sendText(res, 429, 'не так часто, саар');
    return;
  }
  const ip = clientIp(req);
  const lastById = scoreLastById.get(id) || 0;
  const lastByIp = scoreLastByIp.get(ip) || 0;
  if (now - lastById < SCORE_POST_MIN_MS || now - lastByIp < SCORE_POST_MIN_MS) {
    sendText(res, 429, 'не так часто, саар');
    return;
  }
  pruneRateMap(scoreLastById, now);
  pruneRateMap(scoreLastByIp, now);
  scoreLastById.set(id, now);
  scoreLastByIp.set(ip, now);

  const incoming = sanitizeScore({ ...msg, ts: now });
  const existing = scores.get(id);
  if (!existing) {
    if (scores.size >= SCORES_MAX_IDS) evictWorstScore();
    scores.set(id, incoming);
  } else if (incoming.money > existing.money) {
    scores.set(id, incoming);        // новый рекорд — заменяем целиком
  } else {
    existing.name = incoming.name;   // имя всегда обновляется последним присланным
  }
  scheduleScoresSave();
  sendJson(res, 200, { ok: true });
}

async function handleHttp(req, res) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url || '/', 'http://localhost').pathname);
  } catch {
    sendText(res, 400, 'кривой адрес, саар');
    return;
  }

  // API скорборда — до общего запрета не-GET методов.
  if (pathname === '/api/scores') {
    if (req.method === 'GET') handleGetScores(res);
    else sendText(res, 405, 'тут только GET, саар');
    return;
  }
  if (pathname === '/api/score') {
    if (req.method === 'POST') await handlePostScore(req, res);
    else sendText(res, 405, 'тут только POST, саар');
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendText(res, 405, 'только GET, саар');
    return;
  }

  if (pathname === '/healthz') {
    sendText(res, 200, 'ok');
    return;
  }

  if (pathname.includes('\0')) {
    sendText(res, 400, 'кривой адрес, саар');
    return;
  }
  // приватные пути не раздаём: файл очков (uid игроков!), dot-каталоги (.git и пр.)
  if (pathname === '/data' || pathname.startsWith('/data/')
      || pathname.split('/').some((seg) => seg.startsWith('.') && seg !== '.' && seg !== '..')) {
    sendText(res, 404, 'не нашлось, саар :(');
    return;
  }
  if (pathname === '/') pathname = '/index.html';

  // Защита от path traversal: резолвим и проверяем, что остались в корне.
  let filePath = path.resolve(ROOT, '.' + pathname);
  if (filePath !== ROOT && !filePath.startsWith(ROOT + path.sep)) {
    sendText(res, 403, 'туда нельзя, саар');
    return;
  }

  let stats;
  try {
    stats = await fs.promises.stat(filePath);
    if (stats.isDirectory()) {
      filePath = path.join(filePath, 'index.html');
      stats = await fs.promises.stat(filePath);
    }
    if (!stats.isFile()) throw new Error('not a file');
  } catch {
    sendText(res, 404, 'не нашлось, саар :(');
    return;
  }

  const type = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
  try {
    res.writeHead(200, {
      'content-type': type,
      'content-length': stats.size,
      'cache-control': 'no-store',
    });
    if (req.method === 'HEAD') { res.end(); return; }
    const stream = fs.createReadStream(filePath);
    stream.on('error', () => { try { res.destroy(); } catch {} });
    stream.pipe(res);
  } catch { try { res.destroy(); } catch {} }
}

const server = http.createServer((req, res) => {
  handleHttp(req, res).catch((e) => {
    console.error('[http]', e);
    sendText(res, 500, 'внутренняя ошибка, саар');
  });
});
server.on('error', (e) => {
  console.error('[server] не удалось запуститься:', e && e.message ? e.message : e);
  process.exit(1);
});

// ---------- WebSocket: комната, релеи, лимиты ----------
const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });

server.on('upgrade', (req, socket, head) => {
  try {
    const pathname = new URL(req.url || '/', 'http://localhost').pathname;
    if (pathname !== '/ws') { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  } catch {
    try { socket.destroy(); } catch {}
  }
});

let nextId = 1;
const clients = new Map(); // ws -> { id, ws, name, joined, snap, rl }

function joinedCount() {
  let n = 0;
  for (const c of clients.values()) if (c.joined) n++;
  return n;
}

function safeSend(ws, obj) {
  try {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
  } catch { /* сеть рвётся — молча */ }
}

// Разослать всем присоединившимся, кроме except (если задан).
function broadcast(obj, except) {
  let payload;
  try { payload = JSON.stringify(obj); } catch { return; }
  for (const c of clients.values()) {
    if (!c.joined || c === except) continue;
    try {
      if (c.ws.readyState === c.ws.OPEN) c.ws.send(payload);
    } catch { /* не падаем */ }
  }
}

function handleHi(c, msg) {
  if (c.joined) return; // повторный hi игнорируем
  c.name = cleanName(msg.name, c.id);
  c.joined = true;

  const players = [];
  for (const other of clients.values()) {
    if (other === c || !other.joined) continue;
    players.push({
      id: other.id, name: other.name,
      p: other.snap.p, ry: other.snap.ry, d: other.snap.d, u: other.snap.u,
    });
  }
  safeSend(c.ws, { t: 'welcome', id: c.id, players });
  broadcast({ t: 'join', id: c.id, name: c.name }, c);
  broadcast({ t: 'n', count: joinedCount() });
  console.log(`[join] #${c.id} «${c.name}» — игроков: ${joinedCount()}`);
}

function handleSnapshot(c, msg) {
  if (!c.joined) return;
  if (++c.rl.s > RL_SNAPSHOTS_PER_SEC) return; // rate-limit: молча роняем лишнее

  const p = vec3(msg.p);
  const ry = num(msg.ry, -1000, 1000);
  const mv = num(msg.mv, 0, 1);
  const d = num(msg.d, 0, 100);
  if (p === null || ry === null || mv === null || d === null) return; // мусор → дроп
  const u = !!msg.u;

  c.snap = { p, ry, mv, d, u };
  broadcast({ t: 's', id: c.id, p, ry, mv, d, u }, c);
}

function handleThrow(c, msg) {
  if (!c.joined) return;
  if (++c.rl.throw > RL_THROWS_PER_SEC) return;

  const from = vec3(msg.from);
  const dir = vec3(msg.dir, 10);
  const power = num(msg.power, 0, 1);
  if (from === null || dir === null || power === null) return;

  broadcast({ t: 'throw', id: c.id, from, dir, power }, c);
}

function onMessage(c, data) {
  try {
    const text = typeof data === 'string' ? data : data.toString('utf8');
    if (text.length > MAX_MESSAGE_BYTES) return;

    let msg;
    try { msg = JSON.parse(text); } catch { return; } // битый JSON — не наша печаль
    if (!msg || typeof msg !== 'object' || typeof msg.t !== 'string') return;

    // Секундное окно rate-limit'ов.
    const now = Date.now();
    if (now - c.rl.winStart >= 1000) {
      c.rl.winStart = now; c.rl.s = 0; c.rl.throw = 0; c.rl.total = 0;
    }
    if (++c.rl.total > RL_TOTAL_PER_SEC) return;

    switch (msg.t) {
      case 'hi': handleHi(c, msg); break;
      case 's': handleSnapshot(c, msg); break;
      case 'throw': handleThrow(c, msg); break;
      case 'shout': if (c.joined) broadcast({ t: 'shout', id: c.id }, c); break;
      case 'hit': if (c.joined) broadcast({ t: 'hit', id: c.id }, c); break;
      default: break; // неизвестные типы игнорируем
    }
  } catch (e) {
    console.error('[ws:message]', e);
  }
}

function onClose(c) {
  clients.delete(c.ws);
  if (!c.joined) return;
  c.joined = false;
  broadcast({ t: 'leave', id: c.id });
  broadcast({ t: 'n', count: joinedCount() });
  console.log(`[leave] #${c.id} «${c.name}» — игроков: ${joinedCount()}`);
}

wss.on('connection', (ws) => {
  if (clients.size >= MAX_PLAYERS) {
    safeSend(ws, { t: 'full' });
    try { ws.close(1013, 'room full'); } catch {}
    return;
  }

  const c = {
    id: nextId++,
    ws,
    name: '',
    joined: false,
    snap: { p: [0, 0, 0], ry: 0, mv: 0, d: 0, u: false },
    rl: { winStart: Date.now(), s: 0, throw: 0, total: 0 },
  };
  clients.set(ws, c);

  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', (data) => onMessage(c, data));
  ws.on('close', () => onClose(c));
  ws.on('error', () => { /* без падений; close придёт следом */ });
});

wss.on('error', (e) => console.error('[wss]', e));

// Чистка мёртвых сокетов: ping/pong раз в 30 с.
const pingTimer = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      try { ws.terminate(); } catch {}
      continue;
    }
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  }
}, PING_INTERVAL_MS);

// ---------- Грейсфул-шатдаун (docker stop) ----------
let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[server] получен ${signal} — завершаемся, саар…`);
  clearInterval(pingTimer);
  // Финальная запись очков — до того, как нас убьют окончательно.
  try {
    if (scoresSaveTimer) { clearTimeout(scoresSaveTimer); scoresSaveTimer = null; }
    saveScoresNow();
  } catch { /* даже тут не падаем */ }
  for (const ws of wss.clients) {
    try { ws.close(1001, 'server shutdown'); } catch {}
  }
  try { wss.close(); } catch {}
  server.close(() => {
    console.log('[server] всё закрыто, до встречи на фестивале!');
    process.exit(0);
  });
  // Страховка: если кто-то держит соединение — выходим сами.
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Процесс не должен умирать от неожиданностей — логируем и живём дальше.
process.on('uncaughtException', (e) => console.error('[uncaught]', e));
process.on('unhandledRejection', (e) => console.error('[unhandled]', e));

// ---------- Запуск ----------
server.listen(PORT, () => {
  console.log(`[server] Гарехабба слушает http://0.0.0.0:${PORT} (WS: /ws, статика: ${ROOT})`);
});
