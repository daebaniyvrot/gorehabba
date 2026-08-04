// Интеграционные тесты сервера Гарехаббы (server/server.js).
// Сервер поднимается КАК ОТДЕЛЬНЫЙ ПРОЦЕСС (node server/server.js) со случайным
// портом и tmp-файлом очков; готовность ждём поллингом /healthz.
// Запуск сам по себе: node --test tests/integration/server.test.js

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// Публичная метка игрока — как в server.js: первые 8 hex sha256(id).
function tagOf(id) {
  return crypto.createHash('sha256').update(String(id)).digest('hex').slice(0, 8);
}

// Случайный свободный порт в 20000..40000 (проверяем биндом).
async function getFreePort() {
  for (let attempt = 0; attempt < 25; attempt++) {
    const port = 20000 + Math.floor(Math.random() * 20001);
    const free = await new Promise((resolve) => {
      const probe = net.createServer();
      probe.once('error', () => resolve(false));
      // пробуем на всех интерфейсах — сервер слушает без host, сужаем TOCTOU-окно
      probe.listen(port, '0.0.0.0', () => probe.close(() => resolve(true)));
    });
    if (free) return port;
  }
  throw new Error('не нашли свободный порт за 25 попыток');
}

// Запуск сервера отдельным процессом + ожидание готовности по /healthz (до 5с).
async function startServer(extraEnv = {}) {
  const port = await getFreePort();
  const scoresFile = extraEnv.SCORES_FILE
    || path.join(os.tmpdir(), `garehabba-test-scores-${crypto.randomUUID()}.json`);
  const child = spawn(process.execPath, ['server/server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      SCORES_FILE: scoresFile,
      TRUST_PROXY: '', // не наследуем случайный TRUST_PROXY из окружения
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout.on('data', (d) => { logs += d; });
  child.stderr.on('data', (d) => { logs += d; });

  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 5000;
  for (;;) {
    if (child.exitCode !== null) {
      throw new Error(`сервер умер при старте (код ${child.exitCode}):\n${logs}`);
    }
    try {
      const res = await fetch(`${base}/healthz`);
      await res.text();
      if (res.status === 200) break;
    } catch { /* ещё поднимается */ }
    if (Date.now() > deadline) {
      try { child.kill('SIGKILL'); } catch {}
      throw new Error(`сервер не ответил на /healthz за 5с:\n${logs}`);
    }
    await delay(50);
  }
  return { child, port, base, scoresFile };
}

// SIGTERM + ожидание выхода (страховка SIGKILL), подчистка tmp-файлов очков.
async function stopServer(srv, { keepScores = false } = {}) {
  if (!srv) return;
  const { child, scoresFile } = srv;
  if (child.exitCode === null && child.signalCode === null) {
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    const killer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 4000);
    await exited;
    clearTimeout(killer);
  }
  if (!keepScores) {
    fs.rmSync(scoresFile, { force: true });
    fs.rmSync(scoresFile + '.tmp', { force: true });
  }
}

// Сырой GET через TCP-сокет: fetch/URL нормализуют «..», а нам нужен путь как есть.
// Возвращает HTTP-код (0 — соединение закрыто вообще без ответа).
function rawGet(port, target) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1');
    let buf = '';
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error(`rawGet ${target}: таймаут`));
    }, 3000);
    sock.on('connect', () => {
      sock.write(`GET ${target} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`);
    });
    sock.on('data', (d) => { buf += d.toString('latin1'); });
    sock.on('error', () => { /* close придёт следом */ });
    sock.on('close', () => {
      clearTimeout(timer);
      const m = /^HTTP\/1\.[01] (\d{3})/.exec(buf);
      resolve(m ? Number(m[1]) : 0);
    });
  });
}

// POST /api/score; тело — объект или готовая строка. Тело ответа всегда дочитываем.
async function postScore(base, bodyObj, headers = {}) {
  const body = typeof bodyObj === 'string' ? bodyObj : JSON.stringify(bodyObj);
  const res = await fetch(`${base}/api/score`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body,
  });
  const text = await res.text();
  return { status: res.status, text };
}

async function getScores(base) {
  const res = await fetch(`${base}/api/scores`);
  assert.equal(res.status, 200, 'GET /api/scores должен отвечать 200');
  const data = await res.json();
  assert.ok(Array.isArray(data.scores), 'в ответе должен быть массив scores');
  return data.scores;
}

// WS-клиент с очередью сообщений: expect() ждёт КОНКРЕТНОЕ сообщение по предикату
// и резолвится сразу по приходу — никаких «поспим и посмотрим».
function wsConnect(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const queue = [];
  let waiter = null;

  const closed = new Promise((resolve) => ws.on('close', resolve));
  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data.toString('utf8')); } catch { return; }
    queue.push(msg);
    poke();
  });

  function poke() {
    if (!waiter) return;
    const i = queue.findIndex(waiter.pred);
    if (i === -1) return;
    const [msg] = queue.splice(i, 1);
    clearTimeout(waiter.timer);
    const { resolve } = waiter;
    waiter = null;
    resolve(msg);
  }

  const client = {
    ws,
    closed,
    id: null,
    send(obj) { ws.send(JSON.stringify(obj)); },
    expect(label, pred, timeoutMs = 3000) {
      return new Promise((resolve, reject) => {
        waiter = {
          pred,
          resolve,
          timer: setTimeout(() => {
            waiter = null;
            reject(new Error(`не дождались сообщения: ${label}`));
          }, timeoutMs),
        };
        poke();
      });
    },
    close() { try { ws.close(); } catch {} return closed; },
    terminate() { try { ws.terminate(); } catch {} },
  };
  client.opened = new Promise((resolve, reject) => {
    ws.on('open', () => resolve(client));
    ws.on('error', reject);
  });
  return client;
}

// ---------------------------------------------------------------------------

describe('HTTP: статика и приватные пути', () => {
  let srv;
  before(async () => { srv = await startServer(); });
  after(async () => { await stopServer(srv); });

  it('GET / → 200 text/html с «ГАРЕХАББА»', async () => {
    const res = await fetch(`${srv.base}/`);
    assert.equal(res.status, 200);
    assert.ok((res.headers.get('content-type') || '').startsWith('text/html'),
      `ожидали text/html, получили ${res.headers.get('content-type')}`);
    const body = await res.text();
    assert.ok(body.includes('ГАРЕХАББА'), 'на главной должна быть «ГАРЕХАББА»');
  });

  it('GET /src/main.js → 200 text/javascript', async () => {
    const res = await fetch(`${srv.base}/src/main.js`);
    assert.equal(res.status, 200);
    assert.ok((res.headers.get('content-type') || '').startsWith('text/javascript'),
      `ожидали text/javascript, получили ${res.headers.get('content-type')}`);
    await res.text();
  });

  it('GET /nope → 404', async () => {
    const res = await fetch(`${srv.base}/nope`);
    assert.equal(res.status, 404);
    await res.text();
  });

  it('POST / → 405', async () => {
    const res = await fetch(`${srv.base}/`, { method: 'POST', body: 'привет' });
    assert.equal(res.status, 405);
    await res.text();
  });

  it('приватность: /data/scores.json → 404, /.git/config → 404', async () => {
    for (const p of ['/data/scores.json', '/.git/config']) {
      const res = await fetch(`${srv.base}${p}`);
      assert.equal(res.status, 404, `путь ${p} должен отдавать 404`);
      await res.text();
    }
  });

  it('path traversal: /../etc/passwd и %2e%2e-варианты не отдают 200', async () => {
    const targets = [
      '/../etc/passwd',
      '/%2e%2e/%2e%2e/etc/passwd',
      '/..%2f..%2fetc%2fpasswd',
      '/data%2fscores.json',
    ];
    for (const target of targets) {
      const status = await rawGet(srv.port, target);
      assert.notEqual(status, 200, `путь ${target} не должен отдаваться (код ${status})`);
    }
  });
});

// ВНИМАНИЕ: тесты этого describe — строго последовательный сценарий (429 и
// «рекорд не затирается» опираются на записи из предыдущих тестов блока).
describe('Скорборд: валидация, клампы, рейт-лимит и рекорды', () => {
  let srv;
  const ID = 'интеграционный-игрок-1';
  before(async () => { srv = await startServer(); });
  after(async () => { await stopServer(srv); });

  it('битый JSON → 400', async () => {
    const r = await postScore(srv.base, '{саар, ты чего');
    assert.equal(r.status, 400);
  });

  it('POST без id → 400', async () => {
    const r = await postScore(srv.base, { name: 'Безымянный', money: 5 });
    assert.equal(r.status, 400);
  });

  it('тело больше 2КБ → 413', async () => {
    const fat = JSON.stringify({ id: 'толстяк', pad: 'х'.repeat(3000) });
    const r = await postScore(srv.base, fat);
    assert.equal(r.status, 413);
  });

  it('валидный POST → {ok:true}; клампы, tag = sha256(id)[:8], без поля id', async () => {
    const r = await postScore(srv.base, {
      id: ID, name: 'Хаббавед',
      money: 99999999,   // кламп до 9999999
      quests: 99,        // кламп до 8
      hits: 'мусор',     // мусор → 0
      battles: 3, photos: 2,
    });
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(r.text), { ok: true });

    const scores = await getScores(srv.base);
    assert.equal(scores.length, 1);
    const rec = scores[0];
    assert.equal(rec.tag, tagOf(ID), 'tag — первые 8 hex sha256(id)');
    assert.ok(!('id' in rec), 'секретный id не должен утекать в выдачу');
    assert.equal(rec.name, 'Хаббавед');
    assert.equal(rec.money, 9999999);
    assert.equal(rec.quests, 8);
    assert.equal(rec.hits, 0);
    assert.equal(rec.battles, 3);
    assert.equal(rec.photos, 2);
    assert.equal(typeof rec.ts, 'number');
  });

  it('/data/scores.json → 404 даже после записи очков', async () => {
    const res = await fetch(`${srv.base}/data/scores.json`);
    assert.equal(res.status, 404);
    await res.text();
  });

  it('немедленный повторный POST с того же id → 429', async () => {
    const r = await postScore(srv.base, { id: ID, name: 'Спамер', money: 1 });
    assert.equal(r.status, 429);
  });

  it('через 5.2с POST принят; меньший money не затирает рекорд, имя обновляется', async () => {
    await delay(5200); // окно рейт-лимита 5с + запас
    const r = await postScore(srv.base, { id: ID, name: 'НовоеИмя', money: 5 });
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(r.text), { ok: true });

    const scores = await getScores(srv.base);
    const rec = scores.find((s) => s.tag === tagOf(ID));
    assert.ok(rec, 'запись игрока должна остаться в топе');
    assert.equal(rec.money, 9999999, 'меньший money не должен затереть рекорд');
    assert.equal(rec.name, 'НовоеИмя', 'имя обновляется последним присланным');
  });
});

describe('Скорборд: сортировка и персистентность между перезапусками', () => {
  const scoresFile = path.join(os.tmpdir(), `garehabba-test-persist-${crypto.randomUUID()}.json`);
  let srv;

  before(async () => {
    // Предзасеваем файл очков — так проверяем и загрузку, и сортировку без
    // ожиданий рейт-лимита между несколькими POST.
    fs.writeFileSync(scoresFile, JSON.stringify([
      { id: 'alpha', name: 'Альфа', money: 100, quests: 1, hits: 5, battles: 0, photos: 0, ts: 1000 },
      { id: 'beta', name: 'Бета', money: 300, quests: 2, hits: 6, battles: 1, photos: 1, ts: 2000 },
      { id: 'gamma', name: 'Гамма', money: 200, quests: 3, hits: 7, battles: 2, photos: 2, ts: 3000 },
    ]));
    srv = await startServer({ SCORES_FILE: scoresFile });
  });
  after(async () => {
    await stopServer(srv); // подчистит и tmp-файл
  });

  it('GET /api/scores отдаёт топ, отсортированный по money по убыванию', async () => {
    const scores = await getScores(srv.base);
    assert.deepEqual(scores.map((s) => s.money), [300, 200, 100]);
    assert.deepEqual(scores.map((s) => s.name), ['Бета', 'Гамма', 'Альфа']);
    assert.deepEqual(scores.map((s) => s.tag), [tagOf('beta'), tagOf('gamma'), tagOf('alpha')]);
    for (const s of scores) assert.ok(!('id' in s), 'поля id быть не должно');
  });

  it('POST переживает SIGTERM: новый процесс с тем же SCORES_FILE отдаёт сохранённое', async () => {
    const r = await postScore(srv.base, { id: 'phoenix', name: 'Феникс', money: 250 });
    assert.equal(r.status, 200);

    // SIGTERM: сервер обязан сбросить очки на диск до выхода.
    await stopServer(srv, { keepScores: true });

    srv = await startServer({ SCORES_FILE: scoresFile });
    const scores = await getScores(srv.base);
    assert.deepEqual(scores.map((s) => s.money), [300, 250, 200, 100],
      'после перезапуска топ содержит и старые записи, и новую');
    const phoenix = scores.find((s) => s.tag === tagOf('phoenix'));
    assert.ok(phoenix, 'запись «Феникс» должна пережить перезапуск');
    assert.equal(phoenix.name, 'Феникс');
    assert.equal(phoenix.money, 250);
  });
});

describe('WS: комната, hi/welcome, релеи, leave', () => {
  let srv;
  let c1;
  let c2;
  before(async () => { srv = await startServer(); });
  after(async () => {
    for (const c of [c1, c2]) if (c) c.terminate();
    await stopServer(srv);
  });

  it('первый клиент: hi → welcome с id и пустым списком players', async () => {
    c1 = wsConnect(srv.port);
    await c1.opened;
    c1.send({ t: 'hi', name: 'Первый' });
    const welcome = await c1.expect('welcome первого', (m) => m.t === 'welcome');
    assert.equal(typeof welcome.id, 'number');
    assert.deepEqual(welcome.players, []);
    c1.id = welcome.id;
  });

  it('второй клиент видит первого в welcome, первый получает join второго', async () => {
    c2 = wsConnect(srv.port);
    await c2.opened;
    c2.send({ t: 'hi', name: 'Второй' });
    const welcome = await c2.expect('welcome второго', (m) => m.t === 'welcome');
    c2.id = welcome.id;
    assert.equal(welcome.players.length, 1, 'второй должен увидеть одного игрока');
    assert.equal(welcome.players[0].id, c1.id);
    assert.equal(welcome.players[0].name, 'Первый');
    assert.deepEqual(welcome.players[0].p, [0, 0, 0], 'дефолтный снапшот до движения');

    const join = await c1.expect('join второго у первого', (m) => m.t === 'join');
    assert.equal(join.id, c2.id);
    assert.equal(join.name, 'Второй');
    const n = await c1.expect('счётчик n=2', (m) => m.t === 'n' && m.count === 2);
    assert.equal(n.count, 2);
  });

  it('снапшот {t:"s"} первого релеится второму с его id', async () => {
    c1.send({ t: 's', p: [1.5, 2, -3], ry: 0.5, mv: 1, d: 2.5, u: true });
    const s = await c2.expect('снапшот первого у второго', (m) => m.t === 's');
    assert.equal(s.id, c1.id);
    assert.deepEqual(s.p, [1.5, 2, -3]);
    assert.equal(s.ry, 0.5);
    assert.equal(s.d, 2.5);
    assert.equal(s.u, true);
  });

  it('закрытие первого → второй получает leave', async () => {
    const id1 = c1.id;
    c1.close();
    const leave = await c2.expect('leave первого', (m) => m.t === 'leave');
    assert.equal(leave.id, id1);
    const n = await c2.expect('счётчик n=1', (m) => m.t === 'n' && m.count === 1);
    assert.equal(n.count, 1);
  });
});

describe('WS: лимит комнаты в 16 подключений', () => {
  let srv;
  const socks = [];
  before(async () => { srv = await startServer(); });
  after(async () => {
    for (const c of socks) c.terminate();
    await stopServer(srv);
  });

  it('16 подключений заходят, 17-е получает {t:"full"} и закрывается сервером', async () => {
    for (let i = 0; i < 16; i++) {
      const c = wsConnect(srv.port);
      socks.push(c);
      await c.opened; // к моменту open сервер уже зарегистрировал подключение
    }
    const seventeenth = wsConnect(srv.port);
    socks.push(seventeenth);
    await seventeenth.opened;
    const full = await seventeenth.expect('t:"full" для 17-го', (m) => m.t === 'full');
    assert.equal(full.t, 'full');
    await seventeenth.closed; // сервер сам закрывает 17-го
  });
});

describe('Без TRUST_PROXY заголовок X-Forwarded-For игнорируется', () => {
  let srv;
  before(async () => { srv = await startServer(); }); // TRUST_PROXY не выставлен
  after(async () => { await stopServer(srv); });

  it('два POST с разными XFF с одного адреса → второй 429', async () => {
    const r1 = await postScore(srv.base, { id: 'xff-первый', name: 'Один', money: 10 },
      { 'x-forwarded-for': '1.2.3.4' });
    assert.equal(r1.status, 200, 'первый POST должен пройти');
    const r2 = await postScore(srv.base, { id: 'xff-второй', name: 'Два', money: 20 },
      { 'x-forwarded-for': '5.6.7.8' });
    assert.equal(r2.status, 429,
      'XFF не должен обходить IP-лимит: без TRUST_PROXY считается remoteAddr');
  });
});
