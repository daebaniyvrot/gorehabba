// Прод-репетиция «Гарехаббы»: ВСЕ проверки идут через nginx-прокси — реплику
// боевого v1nce.conf (префикс /fest), см. tests/prod/nginx.conf.
// Стек поднимает tests/prod/run.sh; здесь только проверки (+ restart контейнера
// для теста персистентности). База — env PROD_BASE, default http://localhost:8180/fest.
// Запуск: bash tests/prod/run.sh (или npm run test:prod)

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import WebSocket from 'ws';

const execFileP = promisify(execFile);

const BASE = (process.env.PROD_BASE || 'http://localhost:8180/fest').replace(/\/+$/, '');
const BASE_PATH = new URL(BASE).pathname;                 // «/fest»
const WS_URL = `${BASE.replace(/^http/, 'ws')}/ws`;       // ws://…/fest/ws
const COMPOSE_FILE = path.join(
  path.dirname(fileURLToPath(import.meta.url)), 'docker-compose.prod-test.yml');

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// Уникальный id игрока на прогон: повторные запуски не зависят от прошлых записей.
const PLAYER_ID = `прод-репетиция-${crypto.randomUUID()}`;

// Публичная метка игрока — как в server.js: первые 8 hex sha256(id).
function tagOf(id) {
  return crypto.createHash('sha256').update(String(id)).digest('hex').slice(0, 8);
}

// POST /fest/api/score через прокси; тело ответа всегда дочитываем.
async function postScore(bodyObj, headers = {}) {
  const res = await fetch(`${BASE}/api/score`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(bodyObj),
  });
  const text = await res.text();
  return { status: res.status, text };
}

async function getScores() {
  const res = await fetch(`${BASE}/api/scores`);
  assert.equal(res.status, 200, 'GET /api/scores через прокси должен отвечать 200');
  const data = await res.json();
  assert.ok(Array.isArray(data.scores), 'в ответе должен быть массив scores');
  return data.scores;
}

// Ожидание готовности через прокси: пока бэкенд перезапускается, nginx отдаёт 502.
async function waitHealthz(timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(`${BASE}/healthz`);
      const text = await res.text();
      if (res.status === 200 && text === 'ok') return;
    } catch { /* прокси или бэкенд ещё не готовы */ }
    if (Date.now() > deadline) {
      throw new Error(`/healthz через прокси не ожил за ${timeoutMs} мс`);
    }
    await delay(300);
  }
}

// WS-клиент с очередью сообщений (стиль tests/integration/server.test.js):
// expect() ждёт КОНКРЕТНОЕ сообщение по предикату и резолвится по приходу.
function wsConnect(url = WS_URL) {
  const ws = new WebSocket(url);
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
    expect(label, pred, timeoutMs = 5000) {
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

describe('HTTP через прокси: редирект, статика, приватные пути', () => {
  it(`GET ${BASE_PATH} без слэша → 301 на ${BASE_PATH}/`, async () => {
    const res = await fetch(BASE, { redirect: 'manual' });
    assert.equal(res.status, 301);
    const loc = res.headers.get('location');
    assert.ok(loc, 'в 301 должен быть заголовок Location');
    assert.equal(new URL(loc, BASE).pathname, `${BASE_PATH}/`,
      `Location должен вести на ${BASE_PATH}/ (получили ${loc})`);
    await res.text();
  });

  it(`GET ${BASE_PATH}/ → 200 text/html с «ГАРЕХАББА»`, async () => {
    const res = await fetch(`${BASE}/`);
    assert.equal(res.status, 200);
    assert.ok((res.headers.get('content-type') || '').startsWith('text/html'),
      `ожидали text/html, получили ${res.headers.get('content-type')}`);
    const body = await res.text();
    assert.ok(body.includes('ГАРЕХАББА'), 'на главной должна быть «ГАРЕХАББА»');
  });

  it(`GET ${BASE_PATH}/src/main.js → 200 (сабпуть за прокси работает)`, async () => {
    const res = await fetch(`${BASE}/src/main.js`);
    assert.equal(res.status, 200);
    assert.ok((res.headers.get('content-type') || '').startsWith('text/javascript'),
      `ожидали text/javascript, получили ${res.headers.get('content-type')}`);
    await res.text();
  });

  it(`GET ${BASE_PATH}/healthz → ok`, async () => {
    const res = await fetch(`${BASE}/healthz`);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), 'ok');
  });

  it(`приватность: ${BASE_PATH}/data/scores.json и ${BASE_PATH}/.git/config → 404`, async () => {
    for (const p of ['/data/scores.json', '/.git/config']) {
      const res = await fetch(`${BASE}${p}`);
      assert.equal(res.status, 404, `путь ${BASE_PATH}${p} должен отдавать 404`);
      await res.text();
    }
  });
});

describe('WS через nginx: Upgrade, hi/welcome, два клиента видят друг друга', () => {
  let c1;
  let c2;
  after(() => {
    for (const c of [c1, c2]) if (c) c.terminate();
  });

  it('первый клиент: hi → welcome (nginx пропустил Upgrade)', async () => {
    c1 = wsConnect();
    await c1.opened;
    c1.send({ t: 'hi', name: 'ПродПервый' });
    const welcome = await c1.expect('welcome первого', (m) => m.t === 'welcome');
    assert.equal(typeof welcome.id, 'number');
    assert.ok(Array.isArray(welcome.players), 'в welcome должен быть массив players');
    c1.id = welcome.id;
  });

  it('второй клиент видит первого в welcome, первый получает join второго', async () => {
    c2 = wsConnect();
    await c2.opened;
    c2.send({ t: 'hi', name: 'ПродВторой' });
    const welcome = await c2.expect('welcome второго', (m) => m.t === 'welcome');
    c2.id = welcome.id;
    const first = welcome.players.find((p) => p.id === c1.id);
    assert.ok(first, 'второй должен увидеть первого в списке players');
    assert.equal(first.name, 'ПродПервый');

    const join = await c1.expect('join второго у первого',
      (m) => m.t === 'join' && m.id === c2.id);
    assert.equal(join.name, 'ПродВторой');
  });
});

describe('Скорборд через прокси: POST/GET и IP-лимит по XFF', () => {
  it('POST /api/score → {ok:true}', async () => {
    const r = await postScore({
      id: PLAYER_ID, name: 'ПродСаар',
      money: 777, quests: 3, hits: 5, battles: 1, photos: 2,
    });
    assert.equal(r.status, 200, `ожидали 200, получили ${r.status}: ${r.text}`);
    assert.deepEqual(JSON.parse(r.text), { ok: true });
  });

  it('GET /api/scores содержит запись с tag = sha256(id)[:8], без поля id', async () => {
    const scores = await getScores();
    const rec = scores.find((s) => s.tag === tagOf(PLAYER_ID));
    assert.ok(rec, 'запись игрока должна быть в топе');
    assert.equal(rec.name, 'ПродСаар');
    assert.equal(rec.money, 777);
    assert.ok(!('id' in rec), 'секретный id не должен утекать в выдачу');
  });

  it('второй POST другого id с того же клиента → 429 (XFF дописывает nginx, IP один)', async () => {
    // Спуфим X-Forwarded-For: nginx всё равно допишет реальный адрес последним
    // hop'ом, и сервер (TRUST_PROXY=1) увидит тот же IP → 429 по IP-лимиту.
    const r = await postScore(
      { id: `${PLAYER_ID}-другой`, name: 'Спуфер', money: 1 },
      { 'x-forwarded-for': '203.0.113.77' });
    assert.equal(r.status, 429,
      'IP-лимит должен работать через прокси и не обходиться спуфом XFF');
  });
});

describe('Персистентность: restart контейнера не теряет очки (volume жив)', () => {
  it('после docker compose restart garehabba запись на месте', async () => {
    await execFileP('docker',
      ['compose', '-f', COMPOSE_FILE, 'restart', 'garehabba'],
      { timeout: 60_000 });
    await waitHealthz();

    const scores = await getScores();
    const rec = scores.find((s) => s.tag === tagOf(PLAYER_ID));
    assert.ok(rec, 'запись должна пережить перезапуск контейнера');
    assert.equal(rec.name, 'ПродСаар');
    assert.equal(rec.money, 777);
  });
});
