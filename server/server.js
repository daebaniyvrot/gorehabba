// Гарехабба — сервер мультиплеера: статика + WebSocket-релей (/ws).
// Node >= 20, ESM. Единственная зависимость — ws.
// Протокол и требования — NETWORK.md (контракт, исполняется буквально).

import http from 'node:http';
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

async function handleHttp(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendText(res, 405, 'только GET, саар');
    return;
  }

  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url || '/', 'http://localhost').pathname);
  } catch {
    sendText(res, 400, 'кривой адрес, саар');
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
