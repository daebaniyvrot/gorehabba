// Юнит-тесты WebAudio-синтеза: src/audio.js.
// Реального звука нет: весь WebAudio подменён фейком из tests/helpers/audio-mock.js,
// время контекста (currentTime) и таймеры (setInterval/setTimeout) тикаются вручную,
// Math.random замокан — всё детерминированно.
//
// Модуль audio.js — синглтон, поэтому тесты идут строго по порядку жизни:
// до init() → неудачные init() → успешный init() → звуки → фоновые лупы → деградации.
import '../helpers/stubs.js';
import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { FakeAudioContext, snapshot, delta } from '../helpers/audio-mock.js';

// Детерминированный Math.random: значение задаётся перед каждым чувствительным вызовом.
let rnd = 0.5;
mock.method(Math, 'random', () => rnd);

// audio.js крутит фоновые лупы на setInterval/setTimeout — глушим их мок-таймерами.
mock.timers.enable({ apis: ['setInterval', 'setTimeout'], now: 0 });

// Фейковый WebAudio ставим ДО импорта audio.js.
globalThis.AudioContext = FakeAudioContext;
globalThis.webkitAudioContext = FakeAudioContext;

const { audio } = await import('../../src/audio.js');

const fake = () => FakeAudioContext.instances[0];

function callAllOneShots() {
  audio.honk();
  audio.honk(1);
  audio.splat();
  audio.laugh();
  audio.shout();
  audio.shout(false);
  audio.shout(true);
  audio.chaChing();
  audio.thud();
  audio.click();
  audio.camera();
  audio.moo();
  audio.whoosh();
}

describe('audio.js — WebAudio-синтез фестиваля', () => {
  it('до init(): все методы — тихие no-op, контекст не создаётся', () => {
    assert.doesNotThrow(() => {
      callAllOneShots();
      audio.crowd(true);
      audio.crowd(false);
      audio.music(true);
      audio.music(false);
    });
    assert.equal(FakeAudioContext.instances.length, 0);
  });

  it('init() без AudioContext в window — молча ничего не делает', () => {
    delete globalThis.AudioContext;
    delete globalThis.webkitAudioContext;
    audio.init();
    assert.equal(FakeAudioContext.instances.length, 0);
    assert.doesNotThrow(() => audio.honk(1)); // по-прежнему no-op
    globalThis.AudioContext = FakeAudioContext;
    globalThis.webkitAudioContext = FakeAudioContext;
  });

  it('init(): падение конструктора — console.warn и откат в no-op', (t) => {
    class BoomContext { constructor() { throw new Error('ctor boom'); } }
    globalThis.AudioContext = BoomContext;
    const warn = t.mock.method(console, 'warn', () => {});
    audio.init();
    assert.equal(warn.mock.calls.length, 1);
    assert.match(String(warn.mock.calls[0].arguments[0]), /audio init failed/);
    assert.doesNotThrow(() => audio.click()); // контекст сброшен, снова no-op
    assert.equal(FakeAudioContext.instances.length, 0);
    globalThis.AudioContext = FakeAudioContext;
  });

  it('init() через webkitAudioContext: мастер 0.6 → компрессор, шумовой буфер, resume при suspended', () => {
    delete globalThis.AudioContext; // остаётся только префиксный вариант
    FakeAudioContext.initialState = 'suspended';
    rnd = 0.25; // сэмплы шума = 2*0.25-1 = -0.5: видно, что буфер реально заполнили
    audio.init();
    assert.equal(FakeAudioContext.instances.length, 1);
    const f = fake();
    // мастер-гейн 0.6 → компрессор → destination
    assert.equal(f.nodes.gain.length, 1);
    const master = f.nodes.gain[0];
    assert.equal(master.gain.value, 0.6);
    assert.equal(f.nodes.compressor.length, 1);
    const comp = f.nodes.compressor[0];
    assert.ok(master.connections.includes(comp));
    assert.ok(comp.connections.includes(f.destination));
    // общий буфер белого шума: 1.2 с, заполнен значениями из Math.random
    assert.equal(f.buffers.length, 1);
    assert.equal(f.buffers[0].length, Math.floor(f.sampleRate * 1.2));
    assert.equal(f.buffers[0].data[0], -0.5);
    // suspended → init дёрнул resume(), и .catch()-колбэк отработал
    assert.equal(f.resumeCalls, 1);
    assert.equal(f.resumeCatchHooked, 1);
    // рабочее состояние для следующих тестов
    f.state = 'running';
    FakeAudioContext.initialState = 'running';
    globalThis.AudioContext = FakeAudioContext;
    rnd = 0.5;
  });

  it('повторный init() — no-op: второй контекст не создаётся', () => {
    const f = fake();
    const resumes = f.resumeCalls;
    audio.init();
    audio.init();
    assert.equal(FakeAudioContext.instances.length, 1);
    assert.equal(f.resumeCalls, resumes); // running → resume не дёргается
  });

  it('каждый one-shot после init() строит ожидаемый граф узлов', () => {
    const f = fake();
    // [имя, вызов, дельта узлов {osc, gain, filter, buf}, Math.random]
    const cases = [
      ['honk()', () => audio.honk(), { osc: 2, gain: 1, filter: 0, buf: 0 }, 0.5],
      ['honk(0.5)', () => audio.honk(0.5), { osc: 2, gain: 1, filter: 0, buf: 0 }, 0.5],
      ['honk(2) клампится к 1', () => audio.honk(2), { osc: 2, gain: 1, filter: 0, buf: 0 }, 0.5],
      ['splat()', () => audio.splat(), { osc: 1, gain: 2, filter: 1, buf: 1 }, 0.5],
      ['laugh() n=3', () => audio.laugh(), { osc: 6, gain: 6, filter: 3, buf: 0 }, 0.5],
      ['laugh() n=4', () => audio.laugh(), { osc: 8, gain: 8, filter: 4, buf: 0 }, 0.3],
      ['shout(false)', () => audio.shout(false), { osc: 1, gain: 3, filter: 2, buf: 0 }, 0.5],
      ['shout(true)', () => audio.shout(true), { osc: 1, gain: 3, filter: 2, buf: 0 }, 0.5],
      ['shout() по умолчанию', () => audio.shout(), { osc: 1, gain: 3, filter: 2, buf: 0 }, 0.5],
      ['chaChing()', () => audio.chaChing(), { osc: 4, gain: 4, filter: 0, buf: 0 }, 0.5],
      ['thud()', () => audio.thud(), { osc: 1, gain: 2, filter: 1, buf: 1 }, 0.5],
      ['click()', () => audio.click(), { osc: 1, gain: 1, filter: 0, buf: 0 }, 0.5],
      ['camera()', () => audio.camera(), { osc: 2, gain: 2, filter: 0, buf: 0 }, 0.5],
      ['moo()', () => audio.moo(), { osc: 2, gain: 2, filter: 1, buf: 0 }, 0.5],
      ['whoosh()', () => audio.whoosh(), { osc: 0, gain: 1, filter: 1, buf: 1 }, 0.5],
    ];
    for (const [name, call, want, r] of cases) {
      rnd = r;
      const before = snapshot(f);
      assert.doesNotThrow(call, name);
      const d = delta(before, f);
      assert.deepEqual({ osc: d.osc, gain: d.gain, filter: d.filter, buf: d.buf }, want, name);
      assert.ok(d.starts > 0, `${name}: источники стартовали`);
    }
    rnd = 0.5;
  });

  it('honk: громкость масштабируется, ниже порога 0.02 звук не строится', () => {
    const f = fake();
    let b = snapshot(f);
    audio.honk(0.5);
    const e = f.nodes.gain[b.gain]; // огибающая этого клаксона
    const lin = e.gain.events.find((ev) => ev[0] === 'lin');
    assert.ok(Math.abs(lin[1] - 0.17 * 0.5) < 1e-12);
    b = snapshot(f);
    audio.honk(0);
    audio.honk(-1);   // клампится к 0
    audio.honk(0.02); // ровно порог — тоже тишина
    assert.deepEqual(snapshot(f), b);
  });

  it('shout(true) — форманты ниже, чем у shout(false)', () => {
    const f = fake();
    let b = snapshot(f);
    audio.shout(false);
    const bpSmall = f.nodes.filter[b.filter];
    b = snapshot(f);
    audio.shout(true);
    const bpBig = f.nodes.filter[b.filter];
    assert.equal(bpSmall.frequency.value, 650);
    assert.equal(bpBig.frequency.value, 650 * 0.85);
  });

  it('crowd(true/false): гул стартует, блипы по таймеру, стоп гасит и глушит источники', () => {
    const f = fake();
    f._now = 0;
    rnd = 0.5;
    const b0 = snapshot(f);
    audio.crowd(true);
    const d0 = delta(b0, f);
    // шум-луп + LFO «дыхания» + гейны (общий, глубина LFO) + bandpass/lowpass
    assert.deepEqual({ osc: d0.osc, gain: d0.gain, filter: d0.filter, buf: d0.buf },
      { osc: 1, gain: 2, filter: 2, buf: 1 });
    const g = f.nodes.gain[b0.gain];
    const src = f.nodes.bufferSource[b0.buf];
    const lfo = f.nodes.oscillator[b0.osc];
    assert.equal(src.loop, true);
    assert.ok(src.started && lfo.started);

    // повторный crowd(true) — уже играет, ничего не добавляет
    let b = snapshot(f);
    audio.crowd(true);
    assert.deepEqual(snapshot(f), b);

    // тик 900 мс: rnd 0.5 < 0.6 → «голос» толпы (sawtooth-ветка)
    b = snapshot(f);
    mock.timers.tick(900);
    let d = delta(b, f);
    assert.deepEqual({ osc: d.osc, gain: d.gain, filter: d.filter }, { osc: 1, gain: 1, filter: 1 });
    assert.equal(f.nodes.oscillator[b.osc].type, 'sawtooth');

    // rnd 0.3 → блип другой веткой (triangle)
    rnd = 0.3;
    b = snapshot(f);
    mock.timers.tick(900);
    d = delta(b, f);
    assert.equal(d.osc, 1);
    assert.equal(f.nodes.oscillator[b.osc].type, 'triangle');

    // rnd 0.7 ≥ 0.6 → в этот тик тишина
    rnd = 0.7;
    b = snapshot(f);
    mock.timers.tick(900);
    assert.deepEqual(snapshot(f), b);

    // закрытый контекст: интервал выходит рано, без блипов
    rnd = 0.5;
    f.state = 'closed';
    b = snapshot(f);
    mock.timers.tick(900);
    assert.deepEqual(snapshot(f), b);
    f.state = 'running';

    // упавший блип внутри интервала глотается
    f.throwOnCurrentTime = true;
    assert.doesNotThrow(() => mock.timers.tick(900));
    f.throwOnCurrentTime = false;

    // выключение: fade, источники стопаются отложенно (через ~700 мс)
    audio.crowd(false);
    assert.ok(g.gain.events.some((ev) => ev[0] === 'cancel'));
    assert.ok(!src.stopped && !lfo.stopped);
    mock.timers.tick(700);
    assert.ok(src.stopped);
    assert.ok(lfo.stopped);
    assert.ok(g.disconnected);

    // интервал снят — блипов больше нет
    b = snapshot(f);
    mock.timers.tick(2700);
    assert.deepEqual(snapshot(f), b);

    // crowd(false) без запущенного гула — no-op
    assert.doesNotThrow(() => audio.crowd(false));
  });

  it('crowd: остановка живуча к падениям узлов', () => {
    const f = fake();
    rnd = 0.5;
    const b = snapshot(f);
    audio.crowd(true);
    const g = f.nodes.gain[b.gain];
    const src = f.nodes.bufferSource[b.buf];
    const lfo = f.nodes.oscillator[b.osc];
    g.gain.throwOnCancel = true;
    g.throwOnDisconnect = true;
    src.throwOnStop = true;
    lfo.throwOnStop = true;
    assert.doesNotThrow(() => audio.crowd(false));
    assert.doesNotThrow(() => mock.timers.tick(700)); // отложенные stop/disconnect тоже глотаются
  });

  it('music(true/false): планировщик шагов, импровизация, fade при выключении', () => {
    const f = fake();
    f._now = 0;
    rnd = 0.5;
    const b0 = snapshot(f);
    audio.music(true);
    // сразу планируются шаги 0 и 1 (пока nextT < currentTime + 0.28):
    // шаг 0: бочка + хэт + бас + мелодия; шаг 1: хэт + бас; плюс общий гейн
    const d0 = delta(b0, f);
    assert.deepEqual({ osc: d0.osc, gain: d0.gain, filter: d0.filter, buf: d0.buf },
      { osc: 5, gain: 8, filter: 5, buf: 2 });
    const g = f.nodes.gain[b0.gain]; // общий гейн музыки

    // повторный music(true) — уже играет
    let b = snapshot(f);
    audio.music(true);
    assert.deepEqual(snapshot(f), b);

    // прокрутка вперёд: тик таймера дозаполняет шаги 2..35 —
    // покрывает бочку на s=14, паузы (deg=-1) и импровизацию deg=-2 без октавы (rnd 0.5 ≥ 0.35)
    f._now = 5.6;
    b = snapshot(f);
    mock.timers.tick(60);
    let d = delta(b, f);
    // 34 шага: 10 бочек, 34 хэта, 34 баса, 19 нот мелодии (вкл. импровизацию)
    assert.deepEqual({ osc: d.osc, gain: d.gain, filter: d.filter, buf: d.buf },
      { osc: 82, gain: 116, filter: 87, buf: 34 });

    // вторая импровизация — октавой выше (rnd 0.2 < 0.35), шаги 36..67
    rnd = 0.2;
    f._now = 10.9;
    b = snapshot(f);
    mock.timers.tick(60);
    assert.equal(delta(b, f).buf, 32); // хэт на каждом шаге — ровно 32 шага
    rnd = 0.5;

    // закрытый контекст: планировщик молчит
    f.state = 'closed';
    b = snapshot(f);
    mock.timers.tick(60);
    assert.deepEqual(snapshot(f), b);
    f.state = 'running';

    // упавший планировщик глотается
    f.throwOnCurrentTime = true;
    assert.doesNotThrow(() => mock.timers.tick(60));
    f.throwOnCurrentTime = false;

    // выключение: fade 0.3 c, гейн отключается отложенно (~600 мс)
    audio.music(false);
    assert.ok(g.gain.events.some((ev) => ev[0] === 'cancel'));
    assert.ok(!g.disconnected);
    mock.timers.tick(600);
    assert.ok(g.disconnected);

    // интервал снят: даже с уехавшим временем ничего не планируется
    f._now = 30;
    b = snapshot(f);
    mock.timers.tick(600);
    assert.deepEqual(snapshot(f), b);

    // music(false) повторно — no-op
    assert.doesNotThrow(() => audio.music(false));
  });

  it('music: остановка живуча к падениям узлов', () => {
    const f = fake();
    f._now = 0;
    rnd = 0.5;
    const b = snapshot(f);
    audio.music(true);
    const g = f.nodes.gain[b.gain];
    g.gain.throwOnCancel = true;
    g.throwOnDisconnect = true;
    assert.doesNotThrow(() => audio.music(false));
    assert.doesNotThrow(() => mock.timers.tick(600));
  });

  it('suspended-контекст: любой звук дёргает resume() и всё равно играет', () => {
    const f = fake();
    f.state = 'suspended';
    const resumes = f.resumeCalls;
    const b = snapshot(f);
    audio.click();
    assert.equal(f.resumeCalls, resumes + 1);
    assert.equal(delta(b, f).osc, 1); // звук всё равно построился
    // синхронно упавший resume() не роняет метод
    f.throwOnResume = true;
    assert.doesNotThrow(() => audio.click());
    assert.equal(f.resumeCalls, resumes + 2);
    f.throwOnResume = false;
    f.state = 'running';
  });

  it('closed-контекст: все методы снова no-op', () => {
    const f = fake();
    f.state = 'closed';
    const b = snapshot(f);
    assert.doesNotThrow(() => {
      callAllOneShots();
      audio.crowd(true);
      audio.music(true);
    });
    assert.deepEqual(snapshot(f), b); // ни одного нового узла
    f.state = 'running';
  });

  it('исключение внутри любого метода глотается (catch-ветки)', () => {
    const f = fake();
    f.throwOnCurrentTime = true;
    const b = snapshot(f);
    assert.doesNotThrow(() => {
      callAllOneShots();
      audio.crowd(true);
      audio.music(true);
    });
    assert.deepEqual(snapshot(f), b);
    f.throwOnCurrentTime = false;

    // после упавшего старта crowd/music не считаются запущенными — старт работает заново
    let b2 = snapshot(f);
    audio.crowd(true);
    assert.ok(delta(b2, f).buf === 1); // шумовой луп реально создан
    audio.crowd(false);
    mock.timers.tick(700);

    b2 = snapshot(f);
    audio.music(true);
    assert.ok(delta(b2, f).gain > 0);
    audio.music(false);
    mock.timers.tick(600);
  });
});
