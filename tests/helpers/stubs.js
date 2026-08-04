// Стабы браузерного окружения для юнит-тестов игровых модулей в Node.
// Импортировать ПЕРВЫМ в каждом тест-файле, до импорта модулей игры.

class MemoryStorage {
  constructor() { this.map = new Map(); }
  getItem(k) { return this.map.has(k) ? this.map.get(k) : null; }
  setItem(k, v) { this.map.set(String(k), String(v)); }
  removeItem(k) { this.map.delete(k); }
  clear() { this.map.clear(); }
}

if (typeof globalThis.localStorage === 'undefined') {
  globalThis.localStorage = new MemoryStorage();
}

// Минимальный document для модулей, которые лениво трогают DOM в try/catch.
// Юнит-тестами покрываем только логику без DOM, но безопасный заглушечный
// document не даёт случайному обращению уронить импорт.
if (typeof globalThis.document === 'undefined') {
  const nullEl = () => ({
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    style: {}, addEventListener() {}, appendChild() {}, remove() {},
    querySelector: () => null, querySelectorAll: () => [],
    textContent: '', value: '',
  });
  globalThis.document = {
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: nullEl,
    body: nullEl(),
    addEventListener() {},
    visibilityState: 'visible',
  };
}

if (typeof globalThis.window === 'undefined') {
  globalThis.window = globalThis;
}
if (typeof globalThis.performance === 'undefined') {
  globalThis.performance = { now: () => Date.now() };
}

// Свежая копия модуля состояния между тестами: import с уникальным query.
let bust = 0;
export async function freshStateModule() {
  bust++;
  return import(new URL(`../../src/state.js?bust=${bust}`, import.meta.url).href);
}

export { MemoryStorage };
