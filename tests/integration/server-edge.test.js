// Крайние случаи сервера Гарехаббы (server/server.js): env-лимиты скорборда,
// TRUST_PROXY/XFF, глобальный предохранитель POST, битые файлы очков, ошибки ФС,
// HTTP-мелочи (405/413/400/HEAD/MIME) и WS-мусор с рейт-лимитами.
// Сервер поднимается отдельным процессом; готовность ждём поллингом /healthz.
// Запуск сам по себе: node --test tests/integration/server-edge.test.js
//
// Сознательно НЕ покрыто (и почему):
//  - pruneRateMap изнутри: порог 2000 записей зашит в код, а глобальный
//    предохранитель пропускает максимум 20 POST/с — честное переполнение
//    заняло бы ~100 секунд;
//  - catch в http-обёртке (ответ 500) и catch в onMessage: недостижимы снаружи
//    без порчи самого кода;
//  - колбэк ping-таймера: интервал 30 с зашит в код.

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
    || path.join(os.tmpdir(), `garehabba-edge-scores-${crypto.randomUUID()}.json`);
  const child = spawn(process.execPath, ['server/server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      SCORES_FILE: scoresFile,
      TRUST_PROXY: '', // не наследуем случайные значения из окружения
      SCORE_POST_MIN_MS: '',
      SCORES_MAX_IDS: '',
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
  return { child, port, base, scoresFile, logs: () => logs };
}

// Останов сигналом (по умолчанию SIGTERM) + ожидание выхода, подчистка tmp-файлов.
async function stopServer(srv, { keepScores = false, signal = 'SIGTERM' } = {}) {
  if (!srv) return;
  const { child, scoresFile } = srv;
  if (child.exitCode === null && child.signalCode === null) {
    const exited = once(child, 'exit');
    child.kill(signal);
    // Второй сигнал бьёт в ветку «уже завершаемся» (если успеет — не страшно).
    try { child.kill(signal); } catch {}
    const killer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 4000);
    await exited;
    clearTimeout(killer);
  }
  if (!keepScores) {
    fs.rmSync(scoresFile, { force: true });
    fs.rmSync(scoresFile + '.tmp', { force: true });
  }
}

// Сырой HTTP-запрос одним куском: полный контроль над заголовками (пустой XFF,
// upgrade-мусор и т.п.). Возвращает {status, raw}; status 0 — ответа не было.
function rawRequest(port, requestText, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1');
    let buf = '';
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error('rawRequest: таймаут'));
    }, timeoutMs);
    sock.on('connect', () => { sock.write(requestText); });
    sock.on('data', (d) => { buf += d.toString('latin1'); });
    sock.on('error', () => { /* close придёт следом */ });
    sock.on('close', () => {
      clearTimeout(timer);
      const m = /^HTTP\/1\.[01] (\d{3})/.exec(buf);
      resolve({ status: m ? Number(m[1]) : 0, raw: buf });
    });
  });
}

// Сырой POST /api/score с точными заголовками (для пустых/пробельных XFF).
function rawPostScore(port, headers, bodyObj) {
  const body = JSON.stringify(bodyObj);
  const head = Object.entries(headers).map(([k, v]) => `${k}: ${v}\r\n`).join('');
  return rawRequest(port,
    'POST /api/score HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\n'
    + `Content-Length: ${Buffer.byteLength(body)}\r\n${head}Connection: close\r\n\r\n${body}`);
}

// POST /api/score через fetch; тело — объект или готовая строка.
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

// WS-клиент: expect() ждёт сообщение по предикату; seen — журнал ВСЕХ входящих
// (никогда не чистится), по нему проверяем, что сервер не прислал лишнего.
function wsConnect(port, wsPath = '/ws') {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${wsPath}`);
  const queue = [];
  const seen = [];
  let waiter = null;

  const closed = new Promise((resolve) => ws.on('close', resolve));
  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data.toString('utf8')); } catch { return; }
    queue.push(msg);
    seen.push(msg);
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
    seen,
    closed,
    id: null,
    send(obj) { ws.send(JSON.stringify(obj)); },
    sendRaw(text) { ws.send(text); },
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
    async join(name) {
      await client.opened;
      client.send({ t: 'hi', name });
      const welcome = await client.expect('welcome', (m) => m.t === 'welcome');
      client.id = welcome.id;
      return welcome;
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

describe('env-лимиты: SCORES_MAX_IDS=5 — вытеснение худшего', () => {
  let srv;
  before(async () => {
    srv = await startServer({
      SCORES_MAX_IDS: '5', SCORE_POST_MIN_MS: '200', TRUST_PROXY: '1',
    });
  });
  after(async () => { await stopServer(srv); });

  it('пять игроков входят; клампы имени и денег по пути', async () => {
    const r1 = await postScore(srv.base, { id: 'иг-a', name: '', money: 10 },
      { 'x-forwarded-for': '10.0.0.1' });
    assert.equal(r1.status, 200);
    await delay(15); // разные ts у записей с равным money
    const posts = [
      [{ id: 'иг-b', name: 'Ы'.repeat(20), money: 10 }, '10.0.0.2'],
      [{ id: 'иг-c', name: 'Це', money: 30.49 }, '10.0.0.3'],
      [{ id: 'иг-d', name: 'Дэ', money: 40 }, '10.0.0.4'],
      [{ id: 'иг-e', name: 'Е', money: 50 }, '10.0.0.5'],
    ];
    for (const [body, ip] of posts) {
      const r = await postScore(srv.base, body, { 'x-forwarded-for': ip });
      assert.equal(r.status, 200, `POST ${body.id} должен пройти`);
    }
    const scores = await getScores(srv.base);
    assert.deepEqual(scores.map((s) => s.money), [50, 40, 30, 10, 10],
      'money округляется и сортируется по убыванию');
    assert.deepEqual(scores.map((s) => s.tag),
      [tagOf('иг-e'), tagOf('иг-d'), tagOf('иг-c'), tagOf('иг-a'), tagOf('иг-b')],
      'при равном money раньше идёт более старая запись');
    assert.equal(scores[3].name, 'Саар', 'пустое имя → дефолт «Саар»');
    assert.equal(scores[4].name, 'Ы'.repeat(16), 'имя усекается до 16 символов');
  });

  it('шестой игрок с бОльшим money вытесняет худшего (минимальный money, старейший)', async () => {
    const r = await postScore(srv.base, { id: 'иг-f', name: 'Эф', money: 60 },
      { 'x-forwarded-for': '10.0.0.6' });
    assert.equal(r.status, 200);
    const scores = await getScores(srv.base);
    assert.equal(scores.length, 5, 'записей по-прежнему не больше SCORES_MAX_IDS');
    assert.deepEqual(scores.map((s) => s.money), [60, 50, 40, 30, 10]);
    assert.ok(!scores.some((s) => s.tag === tagOf('иг-a')),
      'вытеснен «иг-a»: money минимальный и ts старее, чем у «иг-b»');
    assert.ok(scores.some((s) => s.tag === tagOf('иг-b')),
      '«иг-b» с тем же money, но новее — жив');
  });

  it('повторный POST того же id с бОльшим money заменяет запись целиком', async () => {
    const r1 = await postScore(srv.base, { id: 'иг-g', name: 'ДоАпгрейда', money: 5 },
      { 'x-forwarded-for': '10.0.0.7' });
    assert.equal(r1.status, 200);
    await delay(250); // SCORE_POST_MIN_MS=200 — пережидаем лимит по id
    const r2 = await postScore(srv.base, { id: 'иг-g', name: 'Апгрейд', money: 999 },
      { 'x-forwarded-for': '10.0.0.8' });
    assert.equal(r2.status, 200);
    const scores = await getScores(srv.base);
    const g = scores.find((s) => s.tag === tagOf('иг-g'));
    assert.ok(g, 'запись должна остаться');
    assert.equal(g.money, 999, 'новый рекорд заменяет money');
    assert.equal(g.name, 'Апгрейд', 'и имя из новой записи');
  });
});

describe('TRUST_PROXY=1: IP клиента — ПОСЛЕДНИЙ hop X-Forwarded-For', () => {
  let srv;
  before(async () => {
    // Окно 1с: все POST сьюта укладываются в него без sleep'ов — никаких гонок.
    srv = await startServer({ SCORE_POST_MIN_MS: '1000', TRUST_PROXY: '1' });
  });
  after(async () => { await stopServer(srv); });

  it('без XFF и с пустым/пробельным XFF считается remoteAddress', async () => {
    const r1 = await postScore(srv.base, { id: 'hop-a', money: 1 }); // XFF нет
    assert.equal(r1.status, 200, 'первый POST с remoteAddress проходит');
    const r2 = await rawPostScore(srv.port, { 'X-Forwarded-For': '' },
      { id: 'hop-b', money: 2 });
    assert.equal(r2.status, 429, 'пустой XFF → remoteAddress → лимит по IP');
    const r3 = await rawPostScore(srv.port, { 'X-Forwarded-For': ' , ' },
      { id: 'hop-c', money: 3 });
    assert.equal(r3.status, 429, 'XFF из пустых hop → remoteAddress → лимит по IP');
  });

  it('лимит держится по последнему hop, а не по первому', async () => {
    const r1 = await postScore(srv.base, { id: 'hop-d', money: 4 },
      { 'x-forwarded-for': '7.7.7.7, 8.8.8.8' });
    assert.equal(r1.status, 200);
    const r2 = await postScore(srv.base, { id: 'hop-e', money: 5 },
      { 'x-forwarded-for': '1.2.3.4, 8.8.8.8' });
    assert.equal(r2.status, 429, 'другой первый hop, тот же последний → 429');
    const r3 = await postScore(srv.base, { id: 'hop-f', money: 6 },
      { 'x-forwarded-for': '7.7.7.7, 6.6.6.6' });
    assert.equal(r3.status, 200, 'тот же первый hop, другой последний → проходит');
  });
});

describe('Глобальный предохранитель: не больше 20 принятых POST/с', () => {
  let srv;
  before(async () => {
    srv = await startServer({ SCORE_POST_MIN_MS: '200', TRUST_PROXY: '1' });
  });
  after(async () => { await stopServer(srv); });

  it('25 параллельных POST с разными id и XFF → ровно 20×200 и 5×429', async () => {
    const results = await Promise.all(Array.from({ length: 25 }, (_, i) =>
      postScore(srv.base, { id: `армия-${i}`, name: `Клон${i}`, money: 100 + i },
        { 'x-forwarded-for': `10.9.0.${i + 1}` })));
    const ok = results.filter((r) => r.status === 200).length;
    const limited = results.filter((r) => r.status === 429).length;
    assert.equal(ok + limited, 25, 'других статусов быть не должно');
    assert.equal(ok, 20, 'глобальное окно пропускает ровно 20 POST в секунду');
    assert.equal(limited, 5, 'остальные получают 429');
    const scores = await getScores(srv.base);
    assert.equal(scores.length, 20, 'в топе только принятые записи (и не больше SCORES_TOP)');
  });
});

describe('Загрузка очков: битые файлы и лимит записей', () => {
  it('файл с кривым JSON → старт с пустым списком', async () => {
    const file = path.join(os.tmpdir(), `garehabba-edge-broken-${crypto.randomUUID()}.json`);
    fs.writeFileSync(file, '{саар, это не JSON');
    const srv = await startServer({ SCORES_FILE: file });
    try {
      assert.deepEqual(await getScores(srv.base), []);
      assert.match(srv.logs(), /битый или нечитаемый/);
    } finally { await stopServer(srv); }
  });

  it('JSON-объект вместо массива → старт с пустым списком', async () => {
    const file = path.join(os.tmpdir(), `garehabba-edge-object-${crypto.randomUUID()}.json`);
    fs.writeFileSync(file, JSON.stringify({ id: 'один', money: 5 }));
    const srv = await startServer({ SCORES_FILE: file });
    try {
      assert.deepEqual(await getScores(srv.base), []);
    } finally { await stopServer(srv); }
  });

  it('мусорные записи пропускаются, поля чинятся, лишние за SCORES_MAX_IDS отбрасываются', async () => {
    const file = path.join(os.tmpdir(), `garehabba-edge-junk-${crypto.randomUUID()}.json`);
    fs.writeFileSync(file, JSON.stringify([
      null, 42, 'строка', { name: 'без id', money: 7 }, { id: 123 }, { id: '' },
      { id: 'v1', name: 777, money: -50 },                        // без ts, имя-число, money<0
      { id: 'v2', name: 'В2', money: 20, ts: 99999999999999999 }, // ts больше максимума
      { id: 'v3', name: 'В3', money: 30, ts: -5 },                // ts меньше нуля
      { id: 'v4', name: 'В4', money: 40, ts: 4000 },
      { id: 'v5', name: 'В5', money: 50, ts: 5000 },
      { id: 'v6', name: 'В6', money: 60, ts: 6000 },              // седьмая валидная — за лимитом
    ]));
    const srv = await startServer({ SCORES_FILE: file, SCORES_MAX_IDS: '5' });
    try {
      const scores = await getScores(srv.base);
      assert.equal(scores.length, 5, 'загружается не больше SCORES_MAX_IDS записей');
      assert.ok(!scores.some((s) => s.tag === tagOf('v6')), 'v6 за лимитом — не загружен');
      const v1 = scores.find((s) => s.tag === tagOf('v1'));
      assert.ok(v1, 'v1 должен загрузиться');
      assert.equal(v1.name, 'Саар', 'имя-число → дефолт');
      assert.equal(v1.money, 0, 'отрицательный money клампится в 0');
      assert.ok(v1.ts > 0, 'отсутствующий ts заменяется текущим временем');
      assert.equal(scores.find((s) => s.tag === tagOf('v2')).ts, 8_640_000_000_000_000,
        'ts клампится сверху');
      assert.equal(scores.find((s) => s.tag === tagOf('v3')).ts, 0, 'ts клампится снизу');
    } finally { await stopServer(srv); }
  });
});

describe('Катастрофы ФС: не создаётся каталог, не пишется файл', () => {
  it('SCORES_FILE внутри обычного файла: сервер живёт, POST работает, падение записи не роняет', async () => {
    const blocker = path.join(os.tmpdir(), `garehabba-edge-blocker-${crypto.randomUUID()}`);
    fs.writeFileSync(blocker, 'я файл, а не каталог');
    const srv = await startServer({ SCORES_FILE: path.join(blocker, 'scores.json') });
    try {
      assert.match(srv.logs(), /не удалось создать каталог/);
      assert.deepEqual(await getScores(srv.base), []);
      const r = await postScore(srv.base, { id: 'стойкий', name: 'Стойкий', money: 42 });
      assert.equal(r.status, 200, 'POST принимается даже без диска');
      await stopServer(srv, { keepScores: true }); // SIGTERM: попытка записи упадёт в catch
      assert.equal(srv.child.exitCode, 0, 'сервер обязан выйти с кодом 0');
      assert.match(srv.logs(), /не удалось сохранить очки/);
    } finally {
      await stopServer(srv, { keepScores: true });
      fs.rmSync(blocker, { force: true });
    }
  });
});

describe('HTTP: методы, HEAD, MIME, кривые адреса, потоковое тело', () => {
  let srv;
  before(async () => { srv = await startServer(); });
  after(async () => { await stopServer(srv); });

  it('POST /api/scores → 405, GET /api/score → 405', async () => {
    const r1 = await fetch(`${srv.base}/api/scores`, { method: 'POST', body: '{}' });
    assert.equal(r1.status, 405);
    await r1.text();
    const r2 = await fetch(`${srv.base}/api/score`);
    assert.equal(r2.status, 405);
    await r2.text();
  });

  it('невалидные тела POST /api/score → 400 (массив, id-число, id из пробелов, null)', async () => {
    for (const body of ['[1,2]', '{"id":5,"money":1}', '{"id":"   "}', 'null']) {
      const r = await postScore(srv.base, body);
      assert.equal(r.status, 400, `тело ${body} должно давать 400`);
    }
  });

  it('HEAD / → 200 с заголовками, но без тела', async () => {
    const res = await fetch(`${srv.base}/`, { method: 'HEAD' });
    assert.equal(res.status, 200);
    assert.ok((res.headers.get('content-type') || '').startsWith('text/html'));
    assert.ok(Number(res.headers.get('content-length')) > 0);
    assert.equal(await res.text(), '', 'тело HEAD-ответа пустое');
  });

  it('MIME: .css → text/css, .json → application/json, без расширения → octet-stream', async () => {
    const checks = [
      ['/css/style.css', 'text/css'],
      ['/package.json', 'application/json'],
      ['/LICENSE', 'application/octet-stream'],
    ];
    for (const [p, mime] of checks) {
      const res = await fetch(`${srv.base}${p}`);
      assert.equal(res.status, 200, `GET ${p}`);
      assert.ok((res.headers.get('content-type') || '').startsWith(mime),
        `${p}: ожидали ${mime}, получили ${res.headers.get('content-type')}`);
      await res.text();
    }
  });

  it('каталог без index.html (/src/) → 404, /data → 404', async () => {
    for (const p of ['/src/', '/data']) {
      const res = await fetch(`${srv.base}${p}`);
      assert.equal(res.status, 404, `GET ${p} должен давать 404`);
      await res.text();
    }
  });

  it('кривые адреса: «//» → 400, битые проценты → 400, NUL-байт → 400', async () => {
    for (const p of ['//', '/%zz', '/%00x']) {
      const res = await fetch(`${srv.base}${p}`);
      assert.equal(res.status, 400, `GET ${p} должен давать 400`);
      await res.text();
    }
  });

  it('chunked-тело больше 2КБ без Content-Length → 413', async () => {
    const { status } = await new Promise((resolve, reject) => {
      const sock = net.connect(srv.port, '127.0.0.1');
      let buf = '';
      const timer = setTimeout(() => { sock.destroy(); reject(new Error('chunked: таймаут')); }, 3000);
      const chunk = 'x'.repeat(800);
      const piece = `${(800).toString(16)}\r\n${chunk}\r\n`;
      sock.on('connect', async () => {
        sock.write('POST /api/score HTTP/1.1\r\nHost: 127.0.0.1\r\n'
          + 'Content-Type: application/json\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n');
        for (let i = 0; i < 4; i++) { // 3200 байт: лимит 2048 пробивается на 3-м куске
          try { sock.write(piece); } catch { break; }
          await delay(15); // отдельные data-события на сервере
        }
        try { sock.write('0\r\n\r\n'); } catch { /* сервер уже мог закрыть */ }
      });
      sock.on('data', (d) => { buf += d.toString('latin1'); });
      sock.on('error', () => { /* сервер мог ответить и закрыть раньше */ });
      sock.on('close', () => {
        clearTimeout(timer);
        const m = /^HTTP\/1\.[01] (\d{3})/.exec(buf);
        resolve({ status: m ? Number(m[1]) : 0 });
      });
    });
    assert.equal(status, 413);
  });

  it('обрыв соединения посреди тела POST не роняет сервер', async () => {
    await new Promise((resolve) => {
      const sock = net.connect(srv.port, '127.0.0.1');
      sock.on('connect', () => {
        sock.write('POST /api/score HTTP/1.1\r\nHost: 127.0.0.1\r\n'
          + 'Content-Type: application/json\r\nContent-Length: 100\r\n\r\n{"id":"обры');
        setTimeout(() => { sock.destroy(); resolve(); }, 50);
      });
      sock.on('error', () => {});
    });
    await delay(100);
    const res = await fetch(`${srv.base}/healthz`);
    assert.equal(res.status, 200, 'сервер должен пережить оборванное тело');
    await res.text();
  });

  it('upgrade с кривым url («//») → сокет просто закрывается', async () => {
    const { status, raw } = await rawRequest(srv.port,
      'GET // HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n'
      + 'Sec-WebSocket-Key: aGVsbG8gd29ybGQhIQ==\r\nSec-WebSocket-Version: 13\r\n\r\n');
    assert.equal(status, 0, `ответа быть не должно, получили: ${raw.slice(0, 60)}`);
  });
});

describe('WS: мусор, лимиты сообщений, ошибки протокола', () => {
  let srv;
  let b;      // «приёмник»: joined-клиент, по seen проверяем, что сервер не слал лишнего
  let lurker; // подключён раньше всех, но так и не пришлёт hi: broadcast обязан его обходить
  let a;      // «спамер»: живёт через несколько тестов подряд
  const trash = [];
  before(async () => {
    // пер-IP лимит WS отключаем: блок держит несколько сокетов с 127.0.0.1
    srv = await startServer({ WS_MAX_PER_IP: '100' });
    b = wsConnect(srv.port);
    await b.join('Приёмник');
    lurker = wsConnect(srv.port);
    trash.push(lurker);
    await lurker.opened; // к моменту open сервер уже зарегистрировал подключение
  });
  after(async () => {
    for (const c of trash) c.terminate();
    if (b) b.terminate();
    await stopServer(srv);
  });

  it('подключение на не-/ws путь рубится сервером', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/nope`);
    await new Promise((resolve) => { ws.on('error', resolve); ws.on('close', resolve); });
    assert.notEqual(ws.readyState, WebSocket.OPEN);
    try { ws.terminate(); } catch {}
  });

  it('сообщения до hi игнорируются', async () => {
    a = wsConnect(srv.port);
    trash.push(a);
    await a.opened;
    // Спам до hi — ни одно не должно долететь до приёмника.
    a.send({ t: 's', p: [1, 2, 3], ry: 0, mv: 0, d: 0 });
    a.send({ t: 'throw', from: [0, 0, 0], dir: [0, 1, 0], power: 1 });
    a.send({ t: 'shout' });
    a.send({ t: 'hit' });
    // Имя с control-символами (SOH, DEL) и пробелами по краям.
    a.send({ t: 'hi', name: ` ${String.fromCharCode(1)}Спамер${String.fromCharCode(127)} ` });
    const join = await b.expect('join спамера', (m) => m.t === 'join');
    assert.equal(join.name, 'Спамер', 'control-символы и пробелы вычищаются из имени');
    a.id = join.id;
    // Дожидаемся и счётчика n — иначе он «догонит» нас в следующем тесте.
    await b.expect('счётчик n=2', (m) => m.t === 'n' && m.count === 2);
    assert.ok(!b.seen.some((m) => ['s', 'throw', 'shout', 'hit'].includes(m.t)),
      'до hi ни один релей не должен дойти до приёмника');
  });

  it('повторный hi игнорируется, мусорные и неизвестные сообщения молча дропаются', async () => {
    const seenBefore = b.seen.length;
    a.send({ t: 'hi', name: 'Другой' });  // повторный hi
    a.sendRaw('{саар, это не JSON');      // битый JSON
    a.sendRaw('42');                      // не объект
    a.sendRaw('null');                    // null
    a.sendRaw('"строка"');                // строка
    a.send({ t: 5 });                     // t не строка
    a.send({ безПоляT: 'да' });           // без t
    a.send({ t: 'неизвестный-тип' });     // неизвестный t
    a.send({ t: 'shout' });               // маркер конца
    const shout = await b.expect('маркер-shout', (m) => m.t === 'shout' && m.id === a.id);
    assert.ok(shout);
    const since = b.seen.slice(seenBefore);
    assert.equal(since.length, 1, 'кроме маркера ничего прилететь не должно');
    assert.equal(b.seen.filter((m) => m.t === 'join' && m.id === a.id).length, 1,
      'второй join от повторного hi не рассылается');
  });

  it('снапшоты: мусор дропается, значения клампятся', async () => {
    const seenBefore = b.seen.length;
    a.send({ t: 's', p: 'не массив', ry: 0, mv: 0, d: 0 });
    a.send({ t: 's', p: [1, 2], ry: 0, mv: 0, d: 0 });           // короткий вектор
    a.send({ t: 's', p: [1, 'ы', 3], ry: 0, mv: 0, d: 0 });      // не-число в векторе
    a.send({ t: 's', p: [1, 2, 3], ry: 0, mv: 0 });              // нет d → NaN → дроп
    a.send({ t: 's', p: [1, 2, 3], ry: 0, mv: 'быстро', d: 0 }); // мусорный mv
    a.send({ t: 's', p: [5000, -5000, 7], ry: -4000, mv: 2, d: 900, u: 0 }); // клампы
    const s = await b.expect('клампованный снапшот', (m) => m.t === 's' && m.id === a.id);
    assert.deepEqual(s.p, [1000, -1000, 7], 'координаты клампятся в ±1000');
    assert.equal(s.ry, -1000);
    assert.equal(s.mv, 1);
    assert.equal(s.d, 100);
    assert.equal(s.u, false);
    assert.equal(b.seen.slice(seenBefore).filter((m) => m.t === 's').length, 1,
      'мусорные снапшоты не релеятся');
  });

  it('throw: мусор дропается, dir клампится в ±10, power в 0..1; hit релеится', async () => {
    const seenBefore = b.seen.length;
    a.send({ t: 'throw', from: 'откуда-то', dir: [0, 1, 0], power: 1 });
    a.send({ t: 'throw', from: [0, 0, 0], dir: [0, 1], power: 1 });
    a.send({ t: 'throw', from: [1, 2, 3], dir: [0, -20, 5], power: 7 });
    const thr = await b.expect('валидный throw', (m) => m.t === 'throw' && m.id === a.id);
    assert.deepEqual(thr.from, [1, 2, 3]);
    assert.deepEqual(thr.dir, [0, -10, 5], 'dir клампится в ±10');
    assert.equal(thr.power, 1, 'power клампится в 0..1');
    assert.equal(b.seen.slice(seenBefore).filter((m) => m.t === 'throw').length, 1);
    a.send({ t: 'hit' });
    const hit = await b.expect('hit', (m) => m.t === 'hit' && m.id === a.id);
    assert.ok(hit);
    a.ws.pong(); // незваный pong не должен ничего ломать
  });

  it('рейт-лимит бросков: из 8 подряд релеятся только 5', async () => {
    const t = wsConnect(srv.port);
    trash.push(t);
    await t.join('Метатель');
    const seenBefore = b.seen.length;
    for (let i = 0; i < 8; i++) t.send({ t: 'throw', from: [0, 0, 0], dir: [0, 1, 0], power: 0.5 });
    t.send({ t: 'shout' });
    await b.expect('маркер метателя', (m) => m.t === 'shout' && m.id === t.id);
    assert.equal(b.seen.slice(seenBefore).filter((m) => m.t === 'throw' && m.id === t.id).length, 5);
  });

  it('рейт-лимит снапшотов: из 30 подряд релеятся только 22', async () => {
    const s = wsConnect(srv.port);
    trash.push(s);
    await s.join('Бегун');
    const seenBefore = b.seen.length;
    for (let i = 0; i < 30; i++) s.send({ t: 's', p: [i, 0, 0], ry: 0, mv: 1, d: 0 });
    s.send({ t: 'shout' });
    await b.expect('маркер бегуна', (m) => m.t === 'shout' && m.id === s.id);
    assert.equal(b.seen.slice(seenBefore).filter((m) => m.t === 's' && m.id === s.id).length, 22);
  });

  it('общий потолок 60 сообщений/с; окно сбрасывается через секунду', async () => {
    const g = wsConnect(srv.port);
    trash.push(g);
    await g.join(12345); // имя-число → дефолт «Саар-<id>»
    const join = await b.expect('join героя', (m) => m.t === 'join' && m.id === g.id);
    assert.equal(join.name, `Саар-${g.id}`, 'нестроковое имя → «Саар-<id>»');
    const seenBefore = b.seen.length;
    for (let i = 0; i < 70; i++) g.send({ t: 'shout' }); // hi уже съел 1 из 60
    await delay(1100); // новое секундное окно
    g.send({ t: 'hit' }); // маркер: прошёл бы только после сброса окна
    await b.expect('hit после сброса окна', (m) => m.t === 'hit' && m.id === g.id);
    assert.equal(b.seen.slice(seenBefore).filter((m) => m.t === 'shout' && m.id === g.id).length, 59,
      '59 shout прошли (60-е место в окне занял hi), остальные упёрлись в общий потолок');
  });

  it('кадр больше 4КБ: сервер рубит соединение, остальные получают leave', async () => {
    const o = wsConnect(srv.port);
    trash.push(o);
    await o.join('Толстяк');
    await b.expect('join толстяка', (m) => m.t === 'join' && m.id === o.id);
    o.sendRaw('x'.repeat(5000));
    const leave = await b.expect('leave толстяка', (m) => m.t === 'leave' && m.id === o.id);
    assert.equal(leave.id, o.id);
    await o.closed;
  });

  it('SIGINT с живыми клиентами: все закрыты, выход с кодом 0, не-joined не получил ни байта', async () => {
    assert.deepEqual(lurker.seen, [],
      'за всю сьюту broadcast ни разу не должен был задеть не-joined клиента');
    const closingB = b.closed;
    const closingLurker = lurker.closed;
    await stopServer(srv, { signal: 'SIGINT' });
    assert.equal(srv.child.exitCode, 0, 'выход по SIGINT должен быть чистым');
    assert.match(srv.logs(), /получен SIGINT/);
    await closingB;     // сервер сам закрыл joined-клиента
    await closingLurker; // и не-joined тоже
    srv = null;
    b = null;
  });
});

describe('Занятый порт: сервер честно умирает с кодом 1', () => {
  it('EADDRINUSE → exit(1) и понятный лог', async () => {
    const port = await getFreePort();
    const blocker = net.createServer();
    await new Promise((resolve, reject) => {
      blocker.once('error', reject);
      blocker.listen(port, resolve);
    });
    try {
      const child = spawn(process.execPath, ['server/server.js'], {
        cwd: ROOT,
        env: {
          ...process.env,
          PORT: String(port),
          SCORES_FILE: path.join(os.tmpdir(), `garehabba-edge-busy-${crypto.randomUUID()}.json`),
          TRUST_PROXY: '',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let logs = '';
      child.stdout.on('data', (d) => { logs += d; });
      child.stderr.on('data', (d) => { logs += d; });
      const killer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 5000);
      const [code] = await once(child, 'exit');
      clearTimeout(killer);
      assert.equal(code, 1, `ожидали код 1, логи:\n${logs}`);
      assert.match(logs, /не удалось запуститься/);
    } finally {
      await new Promise((r) => blocker.close(r));
    }
  });
});
