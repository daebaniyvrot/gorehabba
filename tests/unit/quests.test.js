// Юнит-тесты src/quests.js: 8 квестов фестиваля по таблице SPEC.md.
// Стабы браузерного окружения импортируем ПЕРВЫМИ.
import '../helpers/stubs.js';
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
// quests.js импортирует state.js напрямую, поэтому работаем с одним
// экземпляром state и сбрасываем его вручную перед каждым тестом.
import { state, bus } from '../../src/state.js';
import { createQuests } from '../../src/quests.js';

let quests; // { update }
let offs = []; // отписки слушателей текущего экземпляра квестов

beforeEach(() => {
  // Чистое состояние: квесты заново, деньги — известная база, режим — walk.
  state.quests = {};
  state.questLines = [];
  state.money = 1000;
  state.mode = 'walk';
  // createQuests подписывается на шину и не отдаёт отписки — перехватываем
  // bus.on на время вызова, чтобы после теста снять слушателей и не задваивать
  // бампы между тестами.
  const origOn = bus.on;
  bus.on = (ev, fn) => {
    const off = origOn(ev, fn);
    offs.push(off);
    return off;
  };
  try {
    quests = createQuests();
  } finally {
    bus.on = origOn;
  }
});

afterEach(() => {
  for (const off of offs) off();
  offs = [];
});

describe('quests.js: «Первый бросок» (first)', () => {
  it("'throw' от игрока завершает квест и даёт награду ₹30", () => {
    bus.emit('throw', { owner: 'npc' }); // чужой бросок не считается
    assert.equal(state.quests.first.done, false);
    const before = state.money;
    bus.emit('throw', { owner: 'player' });
    assert.equal(state.quests.first.done, true);
    assert.equal(state.quests.first.progress, 1);
    assert.equal(state.money, before + 30);
  });
});

describe('quests.js: «Меткий саар» (marksman)', () => {
  it("5 попаданий 'npcHit' от игрока завершают квест, чужие не считаются", () => {
    for (let i = 0; i < 4; i++) bus.emit('npcHit', { owner: 'player' });
    bus.emit('npcHit', { owner: 'npc' }); // не игрок — мимо кассы
    bus.emit('npcHit', undefined); // мусор — тоже мимо
    assert.equal(state.quests.marksman.progress, 4);
    assert.equal(state.quests.marksman.done, false);
    const before = state.money;
    bus.emit('npcHit', { owner: 'player' });
    assert.equal(state.quests.marksman.done, true);
    assert.equal(state.money, before + 100);
  });
});

describe('quests.js: «Неуловимый» (untouched)', () => {
  it('update(dt) копит прогресс только в режимах walk и photo', () => {
    state.mode = 'walk';
    quests.update(10);
    assert.equal(state.quests.untouched.progress, 10);
    state.mode = 'photo';
    quests.update(5);
    assert.equal(state.quests.untouched.progress, 15);
    state.mode = 'shop';
    quests.update(20); // в магазине таймер стоит
    assert.equal(state.quests.untouched.progress, 15);
    state.mode = 'battle';
    quests.update(20); // и в битве тоже
    assert.equal(state.quests.untouched.progress, 15);
  });

  it('playerHit в walk сбрасывает прогресс', () => {
    state.mode = 'walk';
    quests.update(30);
    bus.emit('playerHit', {});
    assert.equal(state.quests.untouched.progress, 0);
  });

  it('playerHit в shop НЕ сбрасывает прогресс', () => {
    state.mode = 'walk';
    quests.update(30);
    state.mode = 'shop';
    bus.emit('playerHit', {});
    assert.equal(state.quests.untouched.progress, 30);
  });

  it('60 секунд подряд без попаданий — квест выполнен, награда ₹120', () => {
    state.mode = 'walk';
    const before = state.money;
    for (let i = 0; i < 59; i++) quests.update(1);
    assert.equal(state.quests.untouched.done, false);
    quests.update(1);
    assert.equal(state.quests.untouched.done, true);
    assert.equal(state.money, before + 120);
    quests.update(10); // после done таймер больше ничего не делает
    assert.equal(state.quests.untouched.progress, 60);
  });
});

describe('quests.js: «Бизнесмен» (biznes)', () => {
  it("3 события 'saleMade' завершают квест с наградой ₹150", () => {
    const before = state.money;
    bus.emit('saleMade', {});
    bus.emit('saleMade', {});
    assert.equal(state.quests.biznes.progress, 2);
    assert.equal(state.quests.biznes.done, false);
    bus.emit('saleMade', {});
    assert.equal(state.quests.biznes.done, true);
    assert.equal(state.money, before + 150);
  });
});

describe('quests.js: «Торговая битва» (battle)', () => {
  it("'battleEnd' с won:false не бампает, с won:true завершает", () => {
    bus.emit('battleEnd', { won: false });
    assert.equal(state.quests.battle.progress, 0);
    assert.equal(state.quests.battle.done, false);
    const before = state.money;
    bus.emit('battleEnd', { won: true });
    assert.equal(state.quests.battle.done, true);
    assert.equal(state.money, before + 200);
  });
});

describe('quests.js: «Турист» (tourist)', () => {
  it("фото с оценкой 49 не считается, три фото с оценкой ≥50 завершают", () => {
    bus.emit('photoTaken', { score: 49 });
    assert.equal(state.quests.tourist.progress, 0);
    const before = state.money;
    bus.emit('photoTaken', { score: 50 });
    bus.emit('photoTaken', { score: 50 });
    assert.equal(state.quests.tourist.progress, 2);
    assert.equal(state.quests.tourist.done, false);
    bus.emit('photoTaken', { score: 50 });
    assert.equal(state.quests.tourist.done, true);
    assert.equal(state.money, before + 100);
  });
});

describe('quests.js: «Тук-тук до храма» (ride)', () => {
  it("поездка до square не считается, до temple завершает", () => {
    bus.emit('rideEnd', { dest: 'square' });
    assert.equal(state.quests.ride.progress, 0);
    assert.equal(state.quests.ride.done, false);
    const before = state.money;
    bus.emit('rideEnd', { dest: 'temple' });
    assert.equal(state.quests.ride.done, true);
    assert.equal(state.money, before + 80);
  });
});

describe('quests.js: questLines', () => {
  it('следует порядку таблицы SPEC.md и содержит цели/награды', () => {
    const order = ['first', 'marksman', 'untouched', 'shopping', 'biznes', 'battle', 'tourist', 'ride'];
    assert.deepEqual(state.questLines.map((l) => l.id), order);
    const expected = {
      first:     { target: 1,  reward: 30 },
      marksman:  { target: 5,  reward: 100 },
      untouched: { target: 60, reward: 120 },
      shopping:  { target: 1,  reward: 50 },
      biznes:    { target: 3,  reward: 150 },
      battle:    { target: 1,  reward: 200 },
      tourist:   { target: 3,  reward: 100 },
      ride:      { target: 1,  reward: 80 },
    };
    for (const line of state.questLines) {
      assert.equal(line.target, expected[line.id].target, `target квеста ${line.id}`);
      assert.equal(line.reward, expected[line.id].reward, `reward квеста ${line.id}`);
      assert.equal(line.progress, 0);
      assert.equal(line.done, false);
      assert.ok(line.title.length > 0);
    }
  });

  it('обновляется после событий и сохраняет порядок таблицы', () => {
    bus.emit('npcHit', { owner: 'player' });
    bus.emit('saleMade', {});
    bus.emit('rideEnd', { dest: 'temple' });
    const order = ['first', 'marksman', 'untouched', 'shopping', 'biznes', 'battle', 'tourist', 'ride'];
    assert.deepEqual(state.questLines.map((l) => l.id), order);
    const byId = Object.fromEntries(state.questLines.map((l) => [l.id, l]));
    assert.equal(byId.marksman.progress, 1);
    assert.equal(byId.biznes.progress, 1);
    assert.equal(byId.ride.progress, 1);
    assert.equal(byId.ride.done, true);
  });
});

describe('quests.js: повторные события после done', () => {
  it('повторный bump выполненного квеста не даёт двойной награды', () => {
    bus.emit('rideEnd', { dest: 'temple' });
    const after = state.money;
    bus.emit('rideEnd', { dest: 'temple' });
    bus.emit('rideEnd', { dest: 'temple' });
    assert.equal(state.money, after);
    assert.equal(state.quests.ride.progress, 1); // прогресс не растёт
  });

  it('done-квест из сейва не даёт награду повторно после пере-мёрджа', () => {
    // Имитация load(): сейв целиком подменяет объект state.quests.
    state.quests = {
      first: { progress: 1, done: true },
      marksman: { progress: 3, done: false },
    };
    quests.update(0); // update замечает подмену и пере-мёрджит (dt=0 — таймер не идёт)
    assert.equal(state.quests.marksman.progress, 3); // прогресс из сейва сохранён
    assert.equal(state.quests.untouched.progress, 0); // недостающие созданы
    const byId = Object.fromEntries(state.questLines.map((l) => [l.id, l]));
    assert.equal(byId.marksman.progress, 3);
    assert.equal(byId.first.done, true);
    const before = state.money;
    bus.emit('throw', { owner: 'player' }); // квест уже done — без награды
    assert.equal(state.money, before);
  });
});
