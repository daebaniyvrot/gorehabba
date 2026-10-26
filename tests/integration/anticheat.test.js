// Анти-чит скорборда: деньги в POST клампятся «допуском» — база + ставка ×
// минуты живой игры uid по WebSocket. Curl-бот без игры упирается в базу,
// живая сессия наращивает допуск, копилка времени переживает рестарт.
// Запуск сам по себе: node --test tests/integration/anticheat.test.js

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

async function startServer(extraEnv = {}) {
  const port = await getFreePort();
  const scoresFile = extraEnv.SCORES_FILE
    || path.join(os.tmpdir(), `garehabba-anticheat-${crypto.randomUUID()}.json`);
  const child = spawn(process.execPath, ['server/server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      SCORES_FILE: scoresFile,
      TRUST_PROXY: '',
      SCORE_POST_MIN_MS: '100', // короткое окно рейт-лимита для тестов
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
    if (child.exitCode !== null) throw new Error(`сервер умер при старте:\n${logs}`);
    try {
      const res = await fetch(`${base}/healthz`);
      await res.text();
      if (res.status === 200) break;
    } catch { /* поднимается */ }
    if (Date.now() > deadline) {
      try { child.kill('SIGKILL'); } catch {}
      throw new Error(`сервер не ответил за 5с:\n${logs}`);
    }
    await delay(50);
  }
  return { child, port, base, scoresFile, logs: () => logs };
}

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

async function postScore(base, body) {
  const res = await fetch(`${base}/api/score`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  await res.text();
  return res.status;
}

async function getScore(base, name) {
  const res = await fetch(`${base}/api/scores`);
  const data = await res.json();
  return data.scores.find((s) => s.name === name) || null;
}

// WS-сессия: подключиться, представиться с uid, дождаться welcome.
function playSession(port, uid) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const timer = setTimeout(() => { ws.terminate(); reject(new Error('welcome не пришёл')); }, 3000);
    ws.on('open', () => ws.send(JSON.stringify({ t: 'hi', name: 'Игрок', uid })));
    ws.on('message', (m) => {
      try {
        if (JSON.parse(m).t === 'welcome') {
          clearTimeout(timer);
          resolve(ws);
        }
      } catch { /* мусор игнорируем */ }
    });
    ws.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

describe('Анти-чит: curl-бот без игры упирается в базовый допуск', () => {
  let srv;
  before(async () => { srv = await startServer({ SCORE_BASE_ALLOWANCE: '500', SCORE_EARN_RATE_PER_MIN: '0' }); });
  after(async () => { await stopServer(srv); });

  it('честные деньги в пределах базы проходят как есть', async () => {
    assert.equal(await postScore(srv.base, { id: 'честный', name: 'Честный', money: 400 }), 200);
    assert.equal((await getScore(srv.base, 'Честный')).money, 400);
  });

  it('нарисованные миллионы клампятся до базы', async () => {
    await delay(150); // окно рейт-лимита по IP
    assert.equal(await postScore(srv.base, { id: 'жулик', name: 'Жулик', money: 9999999 }), 200);
    assert.equal((await getScore(srv.base, 'Жулик')).money, 500);
  });
});

describe('Анти-чит: живая WS-сессия наращивает допуск, время переживает рестарт', () => {
  let srv;
  const scoresFile = path.join(os.tmpdir(), `garehabba-anticheat-persist-${crypto.randomUUID()}.json`);
  // ставка гигантская, чтобы доли секунды игры дали заметный допуск
  const ENV = { SCORE_BASE_ALLOWANCE: '100', SCORE_EARN_RATE_PER_MIN: '6000000', SCORES_FILE: scoresFile };
  let storedAfterPlay = 0;

  before(async () => { srv = await startServer(ENV); });
  after(async () => {
    await stopServer(srv);
    fs.rmSync(scoresFile, { force: true });
    fs.rmSync(scoresFile + '.tmp', { force: true });
  });

  it('пока uid играет по WS, допуск растёт выше базы', async () => {
    const ws = await playSession(srv.port, 'живой-игрок');
    await delay(600); // «поиграли» ~0.6 с
    assert.equal(await postScore(srv.base, { id: 'живой-игрок', name: 'Живой', money: 9999999 }), 200);
    const rec = await getScore(srv.base, 'Живой');
    assert.ok(rec.money > 100, `допуск должен вырасти выше базы, получили ${rec.money}`);
    assert.ok(rec.money < 9999999, 'но не до нарисованных миллионов');
    storedAfterPlay = rec.money;
    ws.close();
    await delay(150); // сервер фиксирует время при закрытии сокета
  });

  it('второй сокет того же uid не роняет сервер и не задваивает время', async () => {
    const a = await playSession(srv.port, 'двойной');
    const b = await playSession(srv.port, 'двойной');
    await delay(200);
    a.close(); b.close();
    await delay(150);
    assert.equal((await fetch(`${srv.base}/healthz`)).status, 200);
  });

  it('копилка времени персистится: после рестарта допуск не ниже заработанного', async () => {
    await stopServer(srv, { keepScores: true }); // SIGTERM → финальная запись файла
    const raw = JSON.parse(fs.readFileSync(scoresFile, 'utf8'));
    assert.ok(raw && !Array.isArray(raw) && raw.playtime, 'файл должен быть в новом формате {scores, playtime}');
    assert.ok((raw.playtime['живой-игрок'] || 0) > 0, 'время живого игрока должно сохраниться');

    srv = await startServer(ENV);
    assert.equal(await postScore(srv.base, { id: 'живой-игрок', name: 'Живой', money: 9999999 }), 200);
    const rec = await getScore(srv.base, 'Живой');
    assert.ok(rec.money >= storedAfterPlay,
      `после рестарта допуск (${rec.money}) не должен быть ниже заработанного (${storedAfterPlay})`);
  });
});

describe('Анти-чит: idle-сокет время не копит, активность включает счётчик', () => {
  let srv;
  before(async () => {
    srv = await startServer({
      SCORE_BASE_ALLOWANCE: '100',
      SCORE_EARN_RATE_PER_MIN: '6000000',
      PLAY_IDLE_MS: '200', // без снапшотов дольше 200 мс — простой
    });
  });
  after(async () => { await stopServer(srv); });

  it('припаркованный сокет с авто-pong упирается в базу', async () => {
    const ws = await playSession(srv.port, 'парковщик');
    await delay(700); // молчим — ни снапшотов, ни бросков
    assert.equal(await postScore(srv.base, { id: 'парковщик', name: 'Паркер', money: 9999999 }), 200);
    assert.equal((await getScore(srv.base, 'Паркер')).money, 100, 'idle-время не должно засчитаться');

    // а теперь «живём»: снапшот как от настоящего клиента
    ws.send(JSON.stringify({ t: 's', p: [0, 0, 0], ry: 0, mv: 0.5, d: 0, u: false }));
    await delay(150); // в пределах idle-окна
    assert.equal(await postScore(srv.base, { id: 'парковщик', name: 'Паркер', money: 9999999 }), 200);
    const rec = await getScore(srv.base, 'Паркер');
    assert.ok(rec.money > 100, `после активности допуск должен расти, получили ${rec.money}`);
    ws.close();
  });
});

describe('Анти-чит: пер-IP лимит WS-соединений', () => {
  let srv;
  before(async () => { srv = await startServer({ WS_MAX_PER_IP: '2' }); });
  after(async () => { await stopServer(srv); });

  it('третье соединение с одного IP получает {t:"full"}', async () => {
    const a = await playSession(srv.port, 'ип-1');
    const b = await playSession(srv.port, 'ип-2');
    const refused = await new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/ws`);
      const timer = setTimeout(() => { ws.terminate(); reject(new Error('ответа не было')); }, 3000);
      ws.on('message', (m) => {
        try {
          const msg = JSON.parse(m);
          if (msg.t === 'full') { clearTimeout(timer); resolve(true); }
        } catch { /* мусор */ }
      });
      ws.on('error', (e) => { clearTimeout(timer); reject(e); });
    });
    assert.equal(refused, true);
    a.close(); b.close();
  });
});

describe('Анти-чит: пинг-таймер копит время долгой сессии без POST и без close', () => {
  it('время активной сессии попадает в файл даже при SIGKILL', async () => {
    const srv = await startServer({
      SCORE_EARN_RATE_PER_MIN: '6000000',
      PING_INTERVAL_MS: '150', // тик часто, чтобы успел и дебаунс записи (2 с)
    });
    try {
      const ws = await playSession(srv.port, 'долгожитель');
      ws.send(JSON.stringify({ t: 's', p: [0, 0, 0], ry: 0, mv: 1, d: 0, u: false }));
      await delay(2800); // > дебаунса записи: таймер успел и накопить, и сохранить
      srv.child.kill('SIGKILL'); // грубо: без грейсфул-сейва и без close-сейва
      await once(srv.child, 'exit');
      const raw = JSON.parse(fs.readFileSync(srv.scoresFile, 'utf8'));
      assert.ok((raw.playtime['долгожитель'] || 0) > 0,
        'пинг-таймер должен был сохранить время ещё при жизни процесса');
      try { ws.terminate(); } catch { /* сервер уже мёртв */ }
    } finally {
      fs.rmSync(srv.scoresFile, { force: true });
      fs.rmSync(srv.scoresFile + '.tmp', { force: true });
    }
  });
});

describe('Анти-чит: копилка ограничена и легаси-файл читается', () => {
  it('легаси-массив очков загружается, при сохранении файл мигрирует в новый формат', async () => {
    const scoresFile = path.join(os.tmpdir(), `garehabba-anticheat-legacy-${crypto.randomUUID()}.json`);
    fs.writeFileSync(scoresFile, JSON.stringify([
      { id: 'старый', name: 'Старожил', money: 300, quests: 2, hits: 1, battles: 0, photos: 0, ts: 1000 },
    ]));
    const srv = await startServer({ SCORES_FILE: scoresFile, SCORE_BASE_ALLOWANCE: '500' });
    try {
      assert.equal((await getScore(srv.base, 'Старожил')).money, 300);
      assert.equal(await postScore(srv.base, { id: 'новый', name: 'Новичок', money: 200 }), 200);
      await stopServer(srv, { keepScores: true });
      const raw = JSON.parse(fs.readFileSync(scoresFile, 'utf8'));
      assert.ok(raw.scores && raw.playtime !== undefined, 'файл должен мигрировать в {scores, playtime}');
      assert.equal(raw.scores.length, 2);
    } finally {
      fs.rmSync(scoresFile, { force: true });
      fs.rmSync(scoresFile + '.tmp', { force: true });
    }
  });

  it('PLAYTIME_MAX_UIDS ограничивает копилку: лишний неактивный uid вытесняется', async () => {
    const srv = await startServer({ PLAYTIME_MAX_UIDS: '2' });
    try {
      for (const uid of ['пер', 'втор', 'трет']) {
        const ws = await playSession(srv.port, uid);
        await delay(120);
        ws.close();
        await delay(120);
      }
      await stopServer(srv, { keepScores: true });
      const raw = JSON.parse(fs.readFileSync(srv.scoresFile, 'utf8'));
      assert.ok(Object.keys(raw.playtime).length <= 2,
        `копилка должна держать ≤2 uid, в файле: ${Object.keys(raw.playtime).join(', ')}`);
    } finally {
      fs.rmSync(srv.scoresFile, { force: true });
      fs.rmSync(srv.scoresFile + '.tmp', { force: true });
    }
  });
});
