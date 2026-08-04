// Юнит-тесты src/state.js: шина событий, setMode/addMoney/addAmmo, save/load.
// Стабы браузерного окружения импортируем ПЕРВЫМИ.
import { freshStateModule } from '../helpers/stubs.js';
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

let mod; // свежая копия src/state.js для каждого теста

beforeEach(async () => {
  localStorage.clear();
  mod = await freshStateModule();
});

describe('state.js: шина событий (bus)', () => {
  it('on/emit: слушатель получает данные события', () => {
    const got = [];
    mod.bus.on('ping', (d) => got.push(d));
    mod.bus.emit('ping', { a: 1 });
    mod.bus.emit('ping', { a: 2 });
    assert.deepEqual(got, [{ a: 1 }, { a: 2 }]);
  });

  it('emit события без слушателей не падает', () => {
    assert.doesNotThrow(() => mod.bus.emit('nobody-listens', { x: 1 }));
  });

  it('отписка через возвращённую функцию прекращает вызовы', () => {
    let calls = 0;
    const off = mod.bus.on('ping', () => calls++);
    mod.bus.emit('ping', {});
    off();
    mod.bus.emit('ping', {});
    assert.equal(calls, 1);
    assert.doesNotThrow(off); // повторная отписка безопасна
  });

  it('бросающий слушатель не мешает остальным', () => {
    const origError = console.error;
    console.error = () => {}; // шина логирует ошибку — глушим для чистого вывода
    try {
      const got = [];
      mod.bus.on('boom', () => { throw new Error('я плохой слушатель'); });
      mod.bus.on('boom', (d) => got.push(d));
      assert.doesNotThrow(() => mod.bus.emit('boom', { ok: true }));
      assert.deepEqual(got, [{ ok: true }]);
    } finally {
      console.error = origError;
    }
  });
});

describe('state.js: setMode', () => {
  it('меняет режим и эмитит modeChanged только при реальной смене', () => {
    const events = [];
    mod.bus.on('modeChanged', (d) => events.push(d.mode));
    mod.setMode('walk');
    mod.setMode('walk'); // тот же режим — эмита быть не должно
    mod.setMode('shop');
    assert.equal(mod.state.mode, 'shop');
    assert.deepEqual(events, ['walk', 'shop']);
  });
});

describe('state.js: addMoney', () => {
  it('прибавляет с округлением до целого', () => {
    mod.state.money = 100;
    mod.addMoney(10.6);
    assert.equal(mod.state.money, 111); // Math.round(110.6)
    mod.addMoney(0.4);
    assert.equal(mod.state.money, 111); // Math.round(111.4)
  });

  it('не уводит деньги ниже нуля', () => {
    mod.addMoney(-100000);
    assert.equal(mod.state.money, 0);
  });

  it('эмитит moneyChanged с дельтой', () => {
    const got = [];
    mod.bus.on('moneyChanged', (d) => got.push(d.delta));
    mod.addMoney(25);
    mod.addMoney(-5);
    assert.deepEqual(got, [25, -5]);
  });
});

describe('state.js: addAmmo', () => {
  it('прибавляет в пределах нормы и эмитит ammoChanged', () => {
    let emits = 0;
    mod.bus.on('ammoChanged', () => emits++);
    mod.state.ammo = 5;
    mod.addAmmo(3);
    assert.equal(mod.state.ammo, 8);
    assert.equal(emits, 1);
  });

  it('клампит сверху по maxAmmo', () => {
    mod.addAmmo(9999);
    assert.equal(mod.state.ammo, mod.state.maxAmmo);
  });

  it('клампит снизу нулём', () => {
    mod.addAmmo(-9999);
    assert.equal(mod.state.ammo, 0);
  });
});

describe('state.js: сохранение', () => {
  it('save/load-раундтрип: деньги, предметы, статы и квесты восстанавливаются', async () => {
    mod.state.money = 777;
    mod.state.items.umbrella = true;
    mod.state.stats.thrown = 12;
    mod.state.stats.sold = 4;
    mod.state.quests = { first: { progress: 1, done: true } };
    mod.state.playerPos = { x: 1, y: 2, z: 3 };
    mod.save();

    const fresh = await freshStateModule();
    assert.equal(fresh.state.money, 150); // до load — дефолты
    assert.equal(fresh.load(), true);
    assert.equal(fresh.state.money, 777);
    assert.equal(fresh.state.items.umbrella, true);
    assert.equal(fresh.state.items.slippers, false); // не тронутые — дефолт
    assert.equal(fresh.state.stats.thrown, 12);
    assert.equal(fresh.state.stats.sold, 4);
    assert.deepEqual(fresh.state.quests, { first: { progress: 1, done: true } });
    assert.deepEqual(fresh.state.playerPos, { x: 1, y: 2, z: 3 });
  });

  it('mode не сохраняется и не восстанавливается', async () => {
    mod.setMode('battle');
    mod.save();

    const fresh = await freshStateModule();
    fresh.setMode('walk');
    assert.equal(fresh.load(), true);
    assert.equal(fresh.state.mode, 'walk'); // load не трогает mode
  });

  it('hasSave: false до сохранения, true после', () => {
    assert.equal(mod.hasSave(), false);
    mod.save();
    assert.equal(mod.hasSave(), true);
  });

  it('load без сейва возвращает false', () => {
    assert.equal(mod.load(), false);
  });

  it('load при битом JSON возвращает false и не падает', () => {
    mod.save();
    const key = [...localStorage.map.keys()][0]; // ключ сейва из стаба
    localStorage.setItem(key, '{саар, это не JSON');
    const origWarn = console.warn;
    console.warn = () => {}; // load логирует предупреждение — глушим
    try {
      mod.state.money = 555;
      assert.equal(mod.load(), false);
      assert.equal(mod.state.money, 555); // состояние не изменилось
    } finally {
      console.warn = origWarn;
    }
  });

  it('resetSave: возвращает дефолты, удаляет сейв, mode не трогает', () => {
    mod.state.money = 9;
    mod.state.items.mask = true;
    mod.state.stats.hits = 5;
    mod.state.quests = { first: { progress: 1, done: true } };
    mod.setMode('walk');
    mod.save();

    mod.resetSave();
    assert.equal(mod.hasSave(), false);
    assert.equal(mod.state.money, 150);
    assert.equal(mod.state.items.mask, false);
    assert.equal(mod.state.stats.hits, 0);
    assert.deepEqual(mod.state.quests, {});
    assert.equal(mod.state.ammo, 8);
    assert.equal(mod.state.mode, 'walk'); // mode остаётся как был
  });
});
