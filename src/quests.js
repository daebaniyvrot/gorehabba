// Квесты фестиваля Гарехабба — 8 штук строго по таблице SPEC.md.
// Ведёт state.quests (id -> {progress, done}) и state.questLines (для ui.js).
import { state, bus, addMoney } from './state.js';
import { audio } from './audio.js';

// Порядок — как в таблице SPEC.md.
const DEFS = [
  { id: 'first',     title: 'Первый бросок',    desc: 'Брось свою первую лепёшку — с почином, саар!',            target: 1,  reward: 30 },
  { id: 'marksman',  title: 'Меткий саар',      desc: 'Попади лепёшкой в 5 жителей',                             target: 5,  reward: 100 },
  { id: 'untouched', title: 'Неуловимый',       desc: 'Продержись 60 секунд подряд без попаданий по тебе',       target: 60, reward: 120 },
  { id: 'shopping',  title: 'Шопинг',           desc: 'Купи любой предмет в магазине',                           target: 1,  reward: 50 },
  { id: 'biznes',    title: 'Бизнесмен',        desc: 'Продай товар 3 покупателям у своего ларька',              target: 3,  reward: 150 },
  { id: 'battle',    title: 'Торговая битва',   desc: 'Выиграй торговую битву с конкурентом',                    target: 1,  reward: 200 },
  { id: 'tourist',   title: 'Турист',           desc: 'Сделай 3 фото с оценкой не ниже 50',                      target: 3,  reward: 100 },
  { id: 'ride',      title: 'Тук-тук до храма', desc: 'Доедь на тук-туке до храма',                              target: 1,  reward: 80 },
];

const BY_ID = {};
for (const def of DEFS) BY_ID[def.id] = def;

export function createQuests() {
  // Ссылка на текущий объект state.quests — load() из сейва может заменить его
  // целиком уже ПОСЛЕ createQuests (кнопка «Продолжить»), тогда пере-мёрджим.
  let known = null;

  // Достаёт запись квеста, создавая её при отсутствии.
  // Существующий прогресс/done из сейва НЕ перезаписывается.
  function entry(id) {
    if (!state.quests || typeof state.quests !== 'object') state.quests = {};
    let q = state.quests[id];
    if (!q || typeof q !== 'object') {
      q = { progress: 0, done: false };
      state.quests[id] = q;
    } else {
      if (typeof q.progress !== 'number' || !isFinite(q.progress) || q.progress < 0) q.progress = 0;
      q.done = !!q.done;
    }
    return q;
  }

  function ensureInit() {
    for (const def of DEFS) entry(def.id);
    known = state.quests;
  }

  // Полностью пересобирает state.questLines (в порядке таблицы).
  function syncLines() {
    const lines = [];
    for (const def of DEFS) {
      const q = entry(def.id);
      lines.push({
        id: def.id,
        title: def.title,
        desc: def.desc,
        progress: q.done ? def.target : Math.min(def.target, Math.floor(q.progress)),
        target: def.target,
        done: q.done,
        reward: def.reward,
      });
    }
    state.questLines = lines;
  }

  function complete(def) {
    const q = entry(def.id);
    if (q.done) return;
    q.done = true;
    q.progress = def.target;
    addMoney(def.reward);
    try { audio.chaChing(); } catch (e) { /* звук — не повод падать */ }
    bus.emit('toast', { text: `✅ Квест «${def.title}» выполнен! +₹${def.reward}`, ms: 3200 });
    bus.emit('questCompleted', { id: def.id, title: def.title, reward: def.reward });
    syncLines();
  }

  function bump(id, amount = 1) {
    const def = BY_ID[id];
    if (!def) return;
    const q = entry(id);
    if (q.done) return;
    q.progress += amount;
    if (q.progress >= def.target) complete(def);
    else syncLines();
  }

  ensureInit();
  syncLines();

  // ---------- Подписки на шину ----------
  bus.on('throw', (d) => { if (d && d.owner === 'player') bump('first'); });
  bus.on('npcHit', (d) => { if (d && d.owner === 'player') bump('marksman'); });
  bus.on('playerHit', () => {
    // сброс только там, где таймер идёт и игрок может уворачиваться
    if (state.mode !== 'walk' && state.mode !== 'photo') return;
    const q = entry('untouched');
    if (!q.done && q.progress > 0) { q.progress = 0; syncLines(); }
  });
  bus.on('itemBought', () => bump('shopping'));
  bus.on('saleMade', () => bump('biznes'));
  bus.on('battleEnd', (d) => { if (d && d.won) bump('battle'); });
  bus.on('photoTaken', (d) => { if (d && typeof d.score === 'number' && d.score >= 50) bump('tourist'); });
  bus.on('rideEnd', (d) => { if (d && d.dest === 'temple') bump('ride'); });

  // ---------- update: таймер «Неуловимого» ----------
  function update(dt) {
    try {
      if (state.quests !== known) { ensureInit(); syncLines(); } // load() подменил объект
      if (!(dt > 0)) return;
      const def = BY_ID.untouched;
      const q = entry('untouched');
      if (q.done) return;
      if (state.mode !== 'walk' && state.mode !== 'photo') return; // таймер идёт только тут
      const before = Math.floor(q.progress);
      q.progress += dt;
      if (q.progress >= def.target) complete(def);
      else if (Math.floor(q.progress) !== before) syncLines(); // не чаще раза в секунду
    } catch (e) {
      console.warn('[quests] update', e);
    }
  }

  return { update };
}
