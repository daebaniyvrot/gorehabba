// Фейковый WebAudio для юнит-тестов src/audio.js (Node, без браузера).
// Повторяет ровно тот срез API, который реально зовёт audio.js:
//   AudioContext: sampleRate, currentTime, state, destination, resume(),
//     createGain, createOscillator, createBiquadFilter, createBufferSource,
//     createBuffer, createDynamicsCompressor
//   Узлы: connect/disconnect/start/stop, параметры frequency/gain/Q со
//     value, setValueAtTime, linearRampToValueAtTime,
//     exponentialRampToValueAtTime, setTargetAtTime, cancelScheduledValues.
// Всё детерминированно: currentTime тикается вручную (поле _now),
// каждый созданный узел попадает в реестр ctx.nodes.<вид> для счётчиков.

export class FakeParam {
  constructor(value = 0) {
    this.value = value;
    this.events = [];        // [метод, значение, время]
    this.throwOnCancel = false;
  }
  setValueAtTime(v, t) { this.events.push(['set', v, t]); this.value = v; return this; }
  linearRampToValueAtTime(v, t) { this.events.push(['lin', v, t]); return this; }
  exponentialRampToValueAtTime(v, t) { this.events.push(['exp', v, t]); return this; }
  setTargetAtTime(v, t, tau) { this.events.push(['target', v, t, tau]); return this; }
  cancelScheduledValues(t) {
    if (this.throwOnCancel) throw new Error('cancelScheduledValues boom');
    this.events.push(['cancel', t]);
    return this;
  }
}

class FakeNode {
  constructor(ctx, kind) {
    this.ctx = ctx;
    this.kind = kind;
    this.connections = [];   // узлы и AudioParam-ы, куда подключались
    this.disconnected = false;
    this.throwOnDisconnect = false;
  }
  connect(target) { this.connections.push(target); return target; }
  disconnect() {
    if (this.throwOnDisconnect) throw new Error('disconnect boom');
    this.disconnected = true;
  }
}

class FakeSourceNode extends FakeNode {
  constructor(ctx, kind) {
    super(ctx, kind);
    this.started = false;
    this.stopped = false;
    this.startTime = null;
    this.stopTime = null;
    this.throwOnStop = false;
  }
  start(t) { this.started = true; this.startTime = t; this.ctx.startCalls++; }
  stop(t) {
    if (this.throwOnStop) throw new Error('stop boom');
    this.stopped = true;
    this.stopTime = t;
    this.ctx.stopCalls++;
  }
}

class FakeOscillator extends FakeSourceNode {
  constructor(ctx) {
    super(ctx, 'oscillator');
    this.type = 'sine';
    this.frequency = new FakeParam(440);
    this.detune = new FakeParam(0);
  }
}

class FakeGain extends FakeNode {
  constructor(ctx) {
    super(ctx, 'gain');
    this.gain = new FakeParam(1);
  }
}

class FakeBiquadFilter extends FakeNode {
  constructor(ctx) {
    super(ctx, 'filter');
    this.type = 'lowpass';
    this.frequency = new FakeParam(350);
    this.Q = new FakeParam(1);
    this.detune = new FakeParam(0);
  }
}

class FakeBufferSource extends FakeSourceNode {
  constructor(ctx) {
    super(ctx, 'bufferSource');
    this.buffer = null;
    this.loop = false;
  }
}

class FakeCompressor extends FakeNode {
  constructor(ctx) {
    super(ctx, 'compressor');
    this.threshold = new FakeParam(-24);
    this.ratio = new FakeParam(12);
  }
}

export class FakeAudioContext {
  static instances = [];
  // Начальное state новых контекстов ('running' | 'suspended') — для теста resume в init().
  static initialState = 'running';

  constructor() {
    FakeAudioContext.instances.push(this);
    this.sampleRate = 8000;   // маленький, чтобы шумовой буфер был дешёвым
    this._now = 0;            // currentTime тикается руками в тестах
    this.state = FakeAudioContext.initialState;
    this.destination = new FakeNode(this, 'destination');
    this.nodes = { oscillator: [], gain: [], filter: [], bufferSource: [], compressor: [] };
    this.buffers = [];
    this.startCalls = 0;
    this.stopCalls = 0;
    this.resumeCalls = 0;
    this.resumeCatchHooked = 0; // сколько раз промис resume().catch(fn) реально вызвал fn
    this.throwOnCurrentTime = false;
    this.throwOnResume = false;
  }

  get currentTime() {
    if (this.throwOnCurrentTime) throw new Error('currentTime boom');
    return this._now;
  }

  resume() {
    this.resumeCalls++;
    if (this.throwOnResume) throw new Error('resume boom');
    // Синхронный «промис», который сразу реджектится: колбэк .catch(() => {})
    // из audio.js вызывается детерминированно, без реального event loop.
    return {
      catch: (fn) => {
        this.resumeCatchHooked++;
        fn(new Error('rejected'));
      },
    };
  }

  createGain() { const n = new FakeGain(this); this.nodes.gain.push(n); return n; }
  createOscillator() { const n = new FakeOscillator(this); this.nodes.oscillator.push(n); return n; }
  createBiquadFilter() { const n = new FakeBiquadFilter(this); this.nodes.filter.push(n); return n; }
  createBufferSource() { const n = new FakeBufferSource(this); this.nodes.bufferSource.push(n); return n; }
  createDynamicsCompressor() { const n = new FakeCompressor(this); this.nodes.compressor.push(n); return n; }

  createBuffer(channels, length, sampleRate) {
    const data = new Float32Array(length);
    const buf = { channels, length, sampleRate, data, getChannelData: () => data };
    this.buffers.push(buf);
    return buf;
  }
}

// Снимок счётчиков создания узлов — для проверки «метод реально построил граф».
export function snapshot(ctx) {
  return {
    osc: ctx.nodes.oscillator.length,
    gain: ctx.nodes.gain.length,
    filter: ctx.nodes.filter.length,
    buf: ctx.nodes.bufferSource.length,
    comp: ctx.nodes.compressor.length,
    starts: ctx.startCalls,
    stops: ctx.stopCalls,
  };
}

export function delta(before, ctx) {
  const now = snapshot(ctx);
  const d = {};
  for (const k of Object.keys(now)) d[k] = now[k] - before[k];
  return d;
}
