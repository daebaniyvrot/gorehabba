// Общее состояние игры, шина событий, сохранение (localStorage).

const DEFAULTS = {
  money: 150,
  dirtiness: 0,     // 0..100 — насколько испачкана одежда
  stink: 0,         // 0..100 — запах (маска ограничивает)
  ammo: 8,          // лепёшек в руках
  maxAmmo: 20,
  items: { slippers: false, umbrella: false, mask: false },
  umbrellaUp: false,
  mode: 'menu',     // menu | walk | shop | stall | tuktuk | photo | battle
  stats: { thrown: 0, hits: 0, timesHit: 0, sold: 0, photos: 0, goodPhotos: 0, battlesWon: 0, rides: 0, cowsHit: 0 },
  quests: {},       // id -> { progress, done } — ведёт quests.js
  questLines: [],   // [{id,title,desc,progress,target,done,reward}] — ведёт quests.js
  playerPos: null,  // {x,y,z} — для сейва
};

export const state = structuredClone(DEFAULTS);

const listeners = new Map();
export const bus = {
  on(ev, fn) {
    if (!listeners.has(ev)) listeners.set(ev, new Set());
    listeners.get(ev).add(fn);
    return () => listeners.get(ev)?.delete(fn);
  },
  emit(ev, data) {
    const set = listeners.get(ev);
    if (!set) return;
    for (const fn of [...set]) {
      try { fn(data); } catch (e) { console.error(`[bus:${ev}]`, e); }
    }
  },
};

export function setMode(m) {
  if (state.mode === m) return;
  state.mode = m;
  bus.emit('modeChanged', { mode: m });
}

export function addMoney(n) {
  state.money = Math.max(0, Math.round(state.money + n));
  bus.emit('moneyChanged', { delta: n });
}

export function addAmmo(n) {
  state.ammo = Math.max(0, Math.min(state.maxAmmo, state.ammo + n));
  bus.emit('ammoChanged', {});
}

// ---------- Сохранение ----------
const SAVE_KEY = 'garehabba-save-v1';
const SAVE_FIELDS = ['money', 'dirtiness', 'stink', 'ammo', 'items', 'stats', 'quests', 'playerPos'];

export function save() {
  try {
    const data = {};
    for (const k of SAVE_FIELDS) data[k] = state[k];
    localStorage.setItem(SAVE_KEY, JSON.stringify(data));
    bus.emit('saved', {});
  } catch (e) { console.warn('save failed', e); }
}

export function hasSave() {
  try { return !!localStorage.getItem(SAVE_KEY); } catch { return false; }
}

export function load() {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return false;
    const data = JSON.parse(raw);
    for (const k of SAVE_FIELDS) {
      if (data[k] === undefined) continue;
      if (k === 'items' || k === 'stats') Object.assign(state[k], data[k]);
      else state[k] = data[k];
    }
    bus.emit('moneyChanged', { delta: 0 });
    bus.emit('ammoChanged', {});
    return true;
  } catch (e) { console.warn('load failed', e); return false; }
}

export function resetSave() {
  try { localStorage.removeItem(SAVE_KEY); } catch {}
  const fresh = structuredClone(DEFAULTS);
  for (const k of Object.keys(fresh)) {
    if (k === 'mode') continue;
    state[k] = fresh[k];
  }
}
