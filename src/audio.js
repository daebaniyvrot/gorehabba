// Гарехабба — audio.js: весь звук — синтез WebAudio, никаких файлов и сети.
// До init() каждый метод — тихий no-op. Мастер-громкость 0.6.

let ctx = null;      // AudioContext (создаётся в init() по клику пользователя)
let master = null;   // мастер-гейн 0.6 → компрессор → выход
let noiseBuf = null; // общий буфер белого шума (переиспользуется всеми звуками)

let crowdState = null; // { gain, src, lfo, timer }
let musicState = null; // { gain, timer, nextT, step }

// ---------- служебное ----------

function ready() {
  if (!ctx || !master) return false;
  if (ctx.state === 'suspended') {
    try { ctx.resume().catch(() => {}); } catch {}
  }
  return ctx.state !== 'closed';
}

function makeNoiseBuffer() {
  const n = Math.floor(ctx.sampleRate * 1.2);
  const buf = ctx.createBuffer(1, n, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
  return buf;
}

function noiseSrc() {
  const s = ctx.createBufferSource();
  s.buffer = noiseBuf;
  s.loop = true;
  return s;
}

function osc(type, freq, t0) {
  const o = ctx.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(freq, t0);
  return o;
}

// Огибающая: атака → экспоненциальный спад. Возвращает gain-ноду.
function env(t0, peak, attack, decay, dest) {
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.linearRampToValueAtTime(Math.max(0.0002, peak), t0 + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + attack + decay);
  g.connect(dest || master);
  return g;
}

// ---------- фоновый гул рынка ----------

function crowdBlip(out) {
  // короткий «голос» в толпе
  const t0 = ctx.currentTime + Math.random() * 0.4;
  const f0 = 160 + Math.random() * 320;
  const o = osc(Math.random() < 0.5 ? 'triangle' : 'sawtooth', f0, t0);
  o.frequency.linearRampToValueAtTime(f0 * (0.8 + Math.random() * 0.5), t0 + 0.12);
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass'; bp.frequency.value = 750; bp.Q.value = 1.4;
  const e = env(t0, 0.35 + Math.random() * 0.25, 0.03, 0.16, out);
  o.connect(bp); bp.connect(e);
  o.start(t0); o.stop(t0 + 0.3);
}

function startCrowd() {
  const t0 = ctx.currentTime;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.linearRampToValueAtTime(0.11, t0 + 1.2);
  g.connect(master);

  const src = noiseSrc();
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass'; bp.frequency.value = 420; bp.Q.value = 0.5;
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass'; lp.frequency.value = 1500;
  src.connect(bp); bp.connect(lp); lp.connect(g);
  src.start(t0);

  // медленное «дыхание» толпы
  const lfo = osc('sine', 0.14, t0);
  const lg = ctx.createGain();
  lg.gain.value = 0.03;
  lfo.connect(lg); lg.connect(g.gain);
  lfo.start(t0);

  const timer = setInterval(() => {
    try {
      if (!ctx || ctx.state === 'closed') return;
      if (Math.random() < 0.6) crowdBlip(g);
    } catch {}
  }, 900);

  crowdState = { gain: g, src, lfo, timer };
}

function stopCrowd() {
  const c = crowdState;
  crowdState = null;
  if (!c) return;
  clearInterval(c.timer);
  const t0 = ctx.currentTime;
  try {
    c.gain.gain.cancelScheduledValues(t0);
    c.gain.gain.setValueAtTime(c.gain.gain.value, t0);
    c.gain.gain.linearRampToValueAtTime(0.0001, t0 + 0.5);
  } catch {}
  setTimeout(() => {
    try { c.src.stop(); } catch {}
    try { c.lfo.stop(); } catch {}
    try { c.gain.disconnect(); } catch {}
  }, 700);
}

// ---------- тук-тук-музыка (громкая, энергичная) ----------

const MUSIC_STEP = 0.165; // восьмые, ~182 BPM
const MUSIC_BASS = [0, 0, 7, 0, 5, 5, 7, 0, 0, 0, 10, 7, 5, 3, 0, 12];
const MUSIC_MELODY = [
  0, -1, 3, -1, 5, -1, 7, -1, 10, -1, 7, 5, -1, 3, 0, -1,
  12, -1, 10, -1, 7, -1, 12, -1, 10, 7, 5, -1, -2, -1, 0, -1,
];
const PENTA = [0, 3, 5, 7, 10];
const hzOf = (base, semi) => base * Math.pow(2, semi / 12);

function mKick(t0, out) {
  const o = osc('sine', 130, t0);
  o.frequency.exponentialRampToValueAtTime(42, t0 + 0.12);
  const e = env(t0, 0.9, 0.002, 0.16, out);
  o.connect(e);
  o.start(t0); o.stop(t0 + 0.2);
}

function mHat(t0, accent, out) {
  const s = noiseSrc();
  const f = ctx.createBiquadFilter();
  f.type = 'highpass'; f.frequency.value = 6500;
  const e = env(t0, accent ? 0.22 : 0.12, 0.001, 0.05, out);
  s.connect(f); f.connect(e);
  s.start(t0); s.stop(t0 + 0.08);
}

function mBass(t0, freq, out) {
  const o = osc('square', freq, t0);
  const f = ctx.createBiquadFilter();
  f.type = 'lowpass'; f.frequency.value = 480;
  const e = env(t0, 0.5, 0.005, 0.14, out);
  o.connect(f); f.connect(e);
  o.start(t0); o.stop(t0 + 0.2);
}

function mMelody(t0, freq, out) {
  const o = osc('sawtooth', freq, t0);
  const v = osc('sine', 7, t0);            // вибрато
  const vg = ctx.createGain();
  vg.gain.value = freq * 0.022;
  v.connect(vg); vg.connect(o.frequency);
  const f = ctx.createBiquadFilter();
  f.type = 'lowpass'; f.frequency.value = 5200;
  const e = env(t0, 0.34, 0.01, 0.16, out);
  o.connect(f); f.connect(e);
  o.start(t0); o.stop(t0 + 0.22);
  v.start(t0); v.stop(t0 + 0.22);
}

function scheduleMusic(m) {
  try {
    if (!ctx || ctx.state === 'closed' || musicState !== m) return;
    while (m.nextT < ctx.currentTime + 0.28) {
      const t0 = m.nextT;
      const s = m.step % 16;
      const ms = m.step % 32;
      if (s % 4 === 0 || s === 14) mKick(t0, m.gain);
      mHat(t0, s % 2 === 1, m.gain);
      mBass(t0, hzOf(110, MUSIC_BASS[s]), m.gain);
      const deg = MUSIC_MELODY[ms];
      if (deg >= 0) mMelody(t0, hzOf(880, deg), m.gain);
      else if (deg === -2) {
        // случайная писклявая нота из пентатоники — импровизация, саар!
        const semi = PENTA[(Math.random() * PENTA.length) | 0] + (Math.random() < 0.35 ? 12 : 0);
        mMelody(t0, hzOf(880, semi), m.gain);
      }
      m.step++;
      m.nextT += MUSIC_STEP;
    }
  } catch {}
}

function startMusic() {
  const t0 = ctx.currentTime;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.linearRampToValueAtTime(0.5, t0 + 0.25); // заметно громче остального
  g.connect(master);
  const m = { gain: g, step: 0, nextT: t0 + 0.05, timer: 0 };
  m.timer = setInterval(() => scheduleMusic(m), 60);
  musicState = m;
  scheduleMusic(m);
}

function stopMusic() {
  const m = musicState;
  musicState = null;
  if (!m) return;
  clearInterval(m.timer);
  const t0 = ctx.currentTime;
  try {
    m.gain.gain.cancelScheduledValues(t0);
    m.gain.gain.setValueAtTime(m.gain.gain.value, t0);
    m.gain.gain.linearRampToValueAtTime(0.0001, t0 + 0.3); // плавный fade 0.3 c
  } catch {}
  setTimeout(() => { try { m.gain.disconnect(); } catch {} }, 600);
}

// ---------- публичный интерфейс ----------

export const audio = {
  init() {
    if (ctx) { ready(); return; }
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = 0.6;
      const comp = ctx.createDynamicsCompressor();
      master.connect(comp);
      comp.connect(ctx.destination);
      noiseBuf = makeNoiseBuffer();
      if (ctx.state === 'suspended') { try { ctx.resume().catch(() => {}); } catch {} }
    } catch (e) {
      console.warn('audio init failed', e);
      ctx = null; master = null;
    }
  },

  // Двухтональный клаксон тук-тука. gain 0..1 — затухание по дистанции.
  honk(gain = 1) {
    if (!ready()) return;
    try {
      const g = Math.min(1, Math.max(0, gain));
      if (g <= 0.02) return;
      const t0 = ctx.currentTime;
      const o1 = osc('square', 405, t0);
      const o2 = osc('sawtooth', 522, t0);
      const e = env(t0, 0.17 * g, 0.008, 0.16);
      o1.connect(e); o2.connect(e);
      o1.start(t0); o1.stop(t0 + 0.18);
      o2.start(t0 + 0.02); o2.stop(t0 + 0.18);
    } catch {}
  },

  // Смачный шлепок лепёшки.
  splat() {
    if (!ready()) return;
    try {
      const t0 = ctx.currentTime;
      const s = noiseSrc();
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.setValueAtTime(800, t0);
      f.frequency.exponentialRampToValueAtTime(140, t0 + 0.22);
      const e = env(t0, 0.5, 0.004, 0.26);
      s.connect(f); f.connect(e);
      s.start(t0); s.stop(t0 + 0.35);
      // низкий «плюх» тела
      const o = osc('sine', 110, t0);
      o.frequency.exponentialRampToValueAtTime(45, t0 + 0.1);
      const e2 = env(t0, 0.25, 0.003, 0.12);
      o.connect(e2);
      o.start(t0); o.stop(t0 + 0.15);
    } catch {}
  },

  // 3–4 быстрых «ха-ха» жителей.
  laugh() {
    if (!ready()) return;
    try {
      const t0 = ctx.currentTime;
      const n = 3 + (Math.random() < 0.5 ? 1 : 0);
      const base = 280 + Math.random() * 120;
      for (let i = 0; i < n; i++) {
        const ts = t0 + i * 0.13;
        const o = osc('sawtooth', base * (1 - i * 0.05), ts);
        o.frequency.exponentialRampToValueAtTime(base * 0.78, ts + 0.09);
        const v = osc('sine', 22, ts);
        const vg = ctx.createGain();
        vg.gain.value = 18;
        v.connect(vg); vg.connect(o.frequency);
        const f = ctx.createBiquadFilter();
        f.type = 'bandpass'; f.frequency.value = 900; f.Q.value = 1.2;
        const e = env(ts, 0.17, 0.015, 0.1);
        o.connect(f); f.connect(e);
        o.start(ts); o.stop(ts + 0.12);
        v.start(ts); v.stop(ts + 0.12);
      }
    } catch {}
  },

  // Короткий выкрик «СААР!» — формантный. big — громче и ниже.
  shout(big = false) {
    if (!ready()) return;
    try {
      const t0 = ctx.currentTime;
      const f0 = big ? 140 : 190;
      const o = osc('sawtooth', f0, t0);
      o.frequency.linearRampToValueAtTime(f0 * 1.35, t0 + 0.06);
      o.frequency.linearRampToValueAtTime(f0 * 0.85, t0 + (big ? 0.4 : 0.3));
      const e = env(t0, big ? 0.5 : 0.32, 0.02, big ? 0.42 : 0.3);
      const formants = [[650, 4, 1], [1100, 6, 0.6]];
      for (let i = 0; i < formants.length; i++) {
        const bp = ctx.createBiquadFilter();
        bp.type = 'bandpass';
        bp.frequency.value = big ? formants[i][0] * 0.85 : formants[i][0];
        bp.Q.value = formants[i][1];
        const bg = ctx.createGain();
        bg.gain.value = formants[i][2];
        o.connect(bp); bp.connect(bg); bg.connect(e);
      }
      o.start(t0); o.stop(t0 + (big ? 0.5 : 0.38));
    } catch {}
  },

  // Два колокольных удара — деньги, саар!
  chaChing() {
    if (!ready()) return;
    try {
      const t0 = ctx.currentTime;
      const strikes = [[0, 1200], [0.12, 1800]];
      for (let i = 0; i < strikes.length; i++) {
        const ts = t0 + strikes[i][0];
        const f = strikes[i][1];
        const o = osc('sine', f, ts);
        const o2 = osc('sine', f * 2.01, ts);
        const e = env(ts, 0.3, 0.002, 0.35);
        const e2 = env(ts, 0.08, 0.002, 0.2);
        o.connect(e); o2.connect(e2);
        o.start(ts); o.stop(ts + 0.42);
        o2.start(ts); o2.stop(ts + 0.25);
      }
    } catch {}
  },

  // Глухой удар.
  thud() {
    if (!ready()) return;
    try {
      const t0 = ctx.currentTime;
      const o = osc('sine', 95, t0);
      o.frequency.exponentialRampToValueAtTime(38, t0 + 0.12);
      const e = env(t0, 0.55, 0.003, 0.16);
      o.connect(e);
      o.start(t0); o.stop(t0 + 0.2);
      const s = noiseSrc();
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass'; f.frequency.value = 300;
      const e2 = env(t0, 0.18, 0.001, 0.05);
      s.connect(f); f.connect(e2);
      s.start(t0); s.stop(t0 + 0.08);
    } catch {}
  },

  // Короткий тик (UI, подбор).
  click() {
    if (!ready()) return;
    try {
      const t0 = ctx.currentTime;
      const o = osc('square', 1900, t0);
      const e = env(t0, 0.12, 0.001, 0.03);
      o.connect(e);
      o.start(t0); o.stop(t0 + 0.05);
    } catch {}
  },

  // Щелчок затвора — два клика.
  camera() {
    if (!ready()) return;
    try {
      const t0 = ctx.currentTime;
      const ticks = [[0, 2200, 0.1], [0.07, 1200, 0.14]];
      for (let i = 0; i < ticks.length; i++) {
        const ts = t0 + ticks[i][0];
        const o = osc('square', ticks[i][1], ts);
        const e = env(ts, ticks[i][2], 0.001, 0.025);
        o.connect(e);
        o.start(ts); o.stop(ts + 0.04);
      }
    } catch {}
  },

  // Низкое осуждающее «му-у».
  moo() {
    if (!ready()) return;
    try {
      const t0 = ctx.currentTime;
      const o = osc('sawtooth', 90, t0);
      o.frequency.linearRampToValueAtTime(96, t0 + 0.15);
      o.frequency.linearRampToValueAtTime(70, t0 + 0.6);
      const v = osc('sine', 5.5, t0);
      const vg = ctx.createGain();
      vg.gain.value = 3;
      v.connect(vg); vg.connect(o.frequency);
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass'; f.frequency.value = 260;
      const e = env(t0, 0.42, 0.06, 0.55);
      o.connect(f); f.connect(e);
      o.start(t0); o.stop(t0 + 0.68);
      v.start(t0); v.stop(t0 + 0.68);
    } catch {}
  },

  // Свист броска.
  whoosh() {
    if (!ready()) return;
    try {
      const t0 = ctx.currentTime;
      const s = noiseSrc();
      const f = ctx.createBiquadFilter();
      f.type = 'bandpass'; f.Q.value = 1.4;
      f.frequency.setValueAtTime(350, t0);
      f.frequency.exponentialRampToValueAtTime(2600, t0 + 0.22);
      const e = env(t0, 0.28, 0.03, 0.2);
      s.connect(f); f.connect(e);
      s.start(t0); s.stop(t0 + 0.3);
    } catch {}
  },

  // Фоновый гул рынка (луп): фильтрованный шум + редкие «голоса».
  crowd(on) {
    if (!ready()) return;
    try {
      if (on && !crowdState) startCrowd();
      else if (!on && crowdState) stopCrowd();
    } catch {}
  },

  // ГРОМКАЯ тук-тук-музыка: бочка, хэты, бас-остинато, писклявая мелодия.
  music(on) {
    if (!ready()) return;
    try {
      if (on && !musicState) startMusic();
      else if (!on && musicState) stopMusic();
    } catch {}
  },
};
