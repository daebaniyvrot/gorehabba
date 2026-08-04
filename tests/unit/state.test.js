// Юнит-тесты src/state.js: шина событий, setMode/addMoney/addAmmo, save/load.
// Работаем с ЕДИНСТВЕННЫМ каноническим экземпляром модуля, чтобы покрытие
// V8 записывалось в src/state.js, а не в копии с ?bust=N.
// Изоляция между тестами: localStorage.clear() + resetSave() + возврат mode,
// подписки на bus каждый тест снимает сам через возвращённый off().
// Стабы браузерного окружения импортируем ПЕРВЫМИ.
import '../helpers/stubs.js';
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  state, bus, setMode, addMoney, addAmmo,
  save, hasSave, load, resetSave,
} from '../../src/state.js';

// Ключ сейва достаём из стаба localStorage (единственный ключ после save()),
// чтобы не дублировать константу из исходника.
function savedKey() {
  return [...localStorage.map.keys()][0];
}

// Глушим console.warn/error на время fn (save/load логируют предупреждения).
function withMuted(name, fn) {
  const orig = console[name];
  console[name] = () => {};
  try { return fn(); } finally { console[name] = orig; }
}

// Подменяем localStorage «сломанным» стабом: все методы бросают.
function withBrokenLocalStorage(fn) {
  const real = globalThis.localStorage;
  const boom = () => { throw new Error('нет доступа, саар'); };
  globalThis.localStorage = { getItem: boom, setItem: boom, removeItem: boom, clear: boom };
  try { return fn(); } finally { globalThis.localStorage = real; }
}

beforeEach(() => {
  localStorage.clear();
  resetSave();          // все поля — в дефолты (mode он не трогает)
  state.mode = 'menu';  // поэтому mode возвращаем руками
});

describe('state.js: шина событий (bus)', () => {
  it('on/emit: слушатель получает данные события', () => {
    const got = [];
    const off = bus.on('ping', (d) => got.push(d));
    try {
      bus.emit('ping', { a: 1 });
      bus.emit('ping', { a: 2 });
      assert.deepEqual(got, [{ a: 1 }, { a: 2 }]);
    } finally { off(); }
  });

  it('emit события без слушателей не падает', () => {
    assert.doesNotThrow(() => bus.emit('nobody-listens', { x: 1 }));
  });

  it('отписка через возвращённую функцию прекращает вызовы', () => {
    let calls = 0;
    const off = bus.on('ping', () => calls++);
    bus.emit('ping', {});
    off();
    bus.emit('ping', {});
    assert.equal(calls, 1);
    assert.doesNotThrow(off); // повторная отписка безопасна
  });

  it('бросающий слушатель не мешает остальным', () => {
    const got = [];
    const offBad = bus.on('boom', () => { throw new Error('я плохой слушатель'); });
    const offGood = bus.on('boom', (d) => got.push(d));
    try {
      withMuted('error', () => { // шина логирует ошибку — глушим
        assert.doesNotThrow(() => bus.emit('boom', { ok: true }));
      });
      assert.deepEqual(got, [{ ok: true }]);
    } finally {
      offBad();
      offGood();
    }
  });
});

describe('state.js: setMode', () => {
  it('меняет режим и эмитит modeChanged только при реальной смене', () => {
    const events = [];
    const off = bus.on('modeChanged', (d) => events.push(d.mode));
    try {
      setMode('walk');
      setMode('walk'); // тот же режим — эмита быть не должно
      setMode('shop');
      assert.equal(state.mode, 'shop');
      assert.deepEqual(events, ['walk', 'shop']);
    } finally { off(); }
  });
});

describe('state.js: addMoney', () => {
  it('прибавляет с округлением до целого', () => {
    state.money = 100;
    addMoney(10.6);
    assert.equal(state.money, 111); // Math.round(110.6)
    addMoney(0.4);
    assert.equal(state.money, 111); // Math.round(111.4)
  });

  it('не уводит деньги ниже нуля', () => {
    addMoney(-100000);
    assert.equal(state.money, 0);
  });

  it('эмитит moneyChanged с дельтой', () => {
    const got = [];
    const off = bus.on('moneyChanged', (d) => got.push(d.delta));
    try {
      addMoney(25);
      addMoney(-5);
      assert.deepEqual(got, [25, -5]);
    } finally { off(); }
  });
});

describe('state.js: addAmmo', () => {
  it('прибавляет в пределах нормы и эмитит ammoChanged', () => {
    let emits = 0;
    const off = bus.on('ammoChanged', () => emits++);
    try {
      state.ammo = 5;
      addAmmo(3);
      assert.equal(state.ammo, 8);
      assert.equal(emits, 1);
    } finally { off(); }
  });

  it('клампит сверху по maxAmmo', () => {
    addAmmo(9999);
    assert.equal(state.ammo, state.maxAmmo);
  });

  it('клампит снизу нулём', () => {
    addAmmo(-9999);
    assert.equal(state.ammo, 0);
  });
});

describe('state.js: сохранение', () => {
  it('save/load-раундтрип: деньги, предметы, статы и квесты восстанавливаются', () => {
    state.money = 777;
    state.items.umbrella = true;
    state.stats.thrown = 12;
    state.stats.sold = 4;
    state.quests = { first: { progress: 1, done: true } };
    state.playerPos = { x: 1, y: 2, z: 3 };
    save();

    // возвращаем дефолты, но сам сейв сохраняем (resetSave его удаляет)
    const key = savedKey();
    const raw = localStorage.getItem(key);
    resetSave();
    assert.equal(state.money, 150); // до load — дефолты
    localStorage.setItem(key, raw);

    assert.equal(load(), true);
    assert.equal(state.money, 777);
    assert.equal(state.items.umbrella, true);
    assert.equal(state.items.slippers, false); // не тронутые — дефолт
    assert.equal(state.stats.thrown, 12);
    assert.equal(state.stats.sold, 4);
    assert.deepEqual(state.quests, { first: { progress: 1, done: true } });
    assert.deepEqual(state.playerPos, { x: 1, y: 2, z: 3 });
  });

  it('save эмитит saved', () => {
    let emits = 0;
    const off = bus.on('saved', () => emits++);
    try {
      save();
      assert.equal(emits, 1);
    } finally { off(); }
  });

  it('mode не пишется в сейв и не восстанавливается load-ом', () => {
    setMode('battle');
    save();
    const data = JSON.parse(localStorage.getItem(savedKey()));
    assert.ok(!('mode' in data), 'mode не должен попадать в сейв');

    setMode('walk');
    assert.equal(load(), true);
    assert.equal(state.mode, 'walk'); // load не трогает mode
  });

  it('load эмитит moneyChanged {delta:0} и ammoChanged', () => {
    save();
    const deltas = [];
    let ammoEmits = 0;
    const offM = bus.on('moneyChanged', (d) => deltas.push(d.delta));
    const offA = bus.on('ammoChanged', () => ammoEmits++);
    try {
      assert.equal(load(), true);
      assert.deepEqual(deltas, [0]);
      assert.equal(ammoEmits, 1);
    } finally {
      offM();
      offA();
    }
  });

  it('hasSave: false до сохранения, true после', () => {
    assert.equal(hasSave(), false);
    save();
    assert.equal(hasSave(), true);
  });

  it('load без сейва возвращает false', () => {
    assert.equal(load(), false);
  });

  it('load при битом JSON возвращает false и не падает', () => {
    save();
    localStorage.setItem(savedKey(), '{саар, это не JSON');
    state.money = 555;
    withMuted('warn', () => { // load логирует предупреждение — глушим
      assert.equal(load(), false);
    });
    assert.equal(state.money, 555); // состояние не изменилось
  });

  it('load с частичным сейвом: отсутствующие поля не трогает, items мержит', () => {
    save(); // чтобы узнать ключ
    localStorage.setItem(savedKey(), JSON.stringify({ money: 42, items: { mask: true } }));
    state.money = 1;
    state.ammo = 3;
    state.items.slippers = false;
    assert.equal(load(), true);
    assert.equal(state.money, 42);
    assert.equal(state.ammo, 3, 'отсутствующее в сейве поле не перетирается');
    assert.equal(state.items.mask, true, 'items мержатся через Object.assign');
    assert.equal(state.items.slippers, false, 'не упомянутые предметы — как были');
  });

  it('resetSave: возвращает дефолты, удаляет сейв, mode не трогает', () => {
    state.money = 9;
    state.items.mask = true;
    state.stats.hits = 5;
    state.quests = { first: { progress: 1, done: true } };
    setMode('walk');
    save();

    resetSave();
    assert.equal(hasSave(), false);
    assert.equal(state.money, 150);
    assert.equal(state.items.mask, false);
    assert.equal(state.stats.hits, 0);
    assert.deepEqual(state.quests, {});
    assert.equal(state.ammo, 8);
    assert.equal(state.mode, 'walk'); // mode остаётся как был
  });
});

describe('state.js: сломанный localStorage (catch-ветки)', () => {
  it('save не бросает, логирует и не эмитит saved', () => {
    let emits = 0;
    const off = bus.on('saved', () => emits++);
    const warns = [];
    const origWarn = console.warn;
    console.warn = (...args) => warns.push(args.map(String).join(' '));
    try {
      withBrokenLocalStorage(() => {
        assert.doesNotThrow(() => save());
      });
    } finally {
      console.warn = origWarn;
      off();
    }
    assert.ok(warns.some((w) => w.includes('save failed')), 'save логирует провал');
    assert.equal(emits, 0, 'saved при провале не эмитится');
    assert.equal(hasSave(), false, 'в настоящий storage ничего не записалось');
  });

  it('hasSave возвращает false', () => {
    save(); // в нормальном стабе сейв есть
    withBrokenLocalStorage(() => {
      assert.equal(hasSave(), false);
    });
    assert.equal(hasSave(), true); // а с целым storage — снова виден
  });

  it('load возвращает false и не меняет состояние', () => {
    save();
    state.money = 555;
    withMuted('warn', () => {
      withBrokenLocalStorage(() => {
        assert.equal(load(), false);
      });
    });
    assert.equal(state.money, 555);
  });

  it('resetSave всё равно сбрасывает поля', () => {
    state.money = 9;
    withBrokenLocalStorage(() => {
      assert.doesNotThrow(() => resetSave());
    });
    assert.equal(state.money, 150);
  });
});
