// Скорборд «Саары фестиваля»: табло на стартовом экране + отправка результатов.
// Контракт: GET /api/scores (топ-20 по money), POST /api/score {id,name,money,...}.
// URL всегда ОТНОСИТЕЛЬНО страницы — игра живёт и на /, и на /fest/.
import { state, bus } from './state.js';

const POLL_MS = 30_000;        // обновление табло в меню
const SEND_DEBOUNCE_MS = 8_000; // trailing-дебаунс отправки результата
const EMPTY_TEXT = 'Пока никто не хвастался, саар. Будь первым!';

export function createScores() {
  try {
    init();
  } catch (e) {
    // Табло — украшение, не повод ронять игру.
    console.warn('[scores] не завёлся скорборд:', e && e.message ? e.message : e);
  }
  return {};
}

function init() {
  // Каталог страницы: '/fest/' для '/fest/index.html', '/' для '/'.
  const dir = location.pathname.endsWith('/')
    ? location.pathname
    : location.pathname.replace(/[^/]*$/, '');

  // ---------- localStorage с guard'ами (privacy mode и т.п.) ----------
  function lsGet(key) {
    try { return localStorage.getItem(key); } catch { return null; }
  }
  function lsSet(key, value) {
    try { localStorage.setItem(key, value); } catch { /* ну и ладно */ }
  }

  // ---------- Идентичность игрока ----------
  function makeUid() {
    const saved = lsGet('garehabba-uid');
    if (typeof saved === 'string' && saved) return saved.slice(0, 64);
    let uid = '';
    try {
      if (crypto && typeof crypto.randomUUID === 'function') uid = crypto.randomUUID();
    } catch { /* fallback ниже */ }
    if (!uid) uid = 'saar-' + Math.random().toString(36).slice(2) + '-' + Date.now().toString(36);
    uid = uid.slice(0, 64);
    lsSet('garehabba-uid', uid);
    return uid;
  }
  const uid = makeUid();

  // Своя строка в топе узнаётся по публичной метке — усечённому sha256(uid),
  // как отдаёт сервер. На insecure-контексте subtle нет — подсветки просто не будет.
  let myTag = '';
  (async () => {
    try {
      if (!(crypto && crypto.subtle && crypto.subtle.digest)) return;
      const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(uid));
      myTag = [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 8);
    } catch { /* не критично */ }
  })();

  function getName() {
    let name = '';
    try {
      const input = document.getElementById('player-name');
      if (input && typeof input.value === 'string') name = input.value.trim();
    } catch { /* DOM мог не завестись */ }
    if (!name) name = String(lsGet('garehabba-name') || '').trim();
    if (!name) name = 'Саар';
    return name.slice(0, 16);
  }

  // ---------- Табло на стартовом экране ----------
  const board = document.getElementById('scoreboard');
  const list = board ? board.querySelector('.sb-list') : null;
  let warnedFetch = false; // максимум одно предупреждение о недоступной сети

  function render(scores) {
    if (!board || !list) return;
    list.textContent = '';
    if (!scores.length) {
      const li = document.createElement('li');
      li.className = 'sb-empty';
      li.style.listStyle = 'none'; // без «1.» перед пустой репликой
      li.textContent = EMPTY_TEXT;
      list.appendChild(li);
    } else {
      for (const s of scores.slice(0, 10)) {
        if (!s || typeof s !== 'object') continue;
        const li = document.createElement('li');
        const mine = !!myTag && typeof s.tag === 'string' && s.tag === myTag;
        if (mine) li.className = 'sb-me';
        // Имена чужие — только textContent, никакого innerHTML.
        li.textContent = String(s.name ?? '???').slice(0, 16) + (mine ? ' (ты)' : '');
        const money = document.createElement('span');
        money.className = 'sb-money';
        money.textContent = '₹' + Math.max(0, Math.round(Number(s.money) || 0));
        li.appendChild(money);
        list.appendChild(li);
      }
    }
    board.classList.remove('hidden');
  }

  async function refreshBoard() {
    try {
      const res = await fetch(dir + 'api/scores');
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      const scores = data && Array.isArray(data.scores) ? data.scores : [];
      render(scores);
    } catch (e) {
      // Сеть лежит → табло остаётся спрятанным, ворчим один раз.
      if (!warnedFetch) {
        warnedFetch = true;
        console.warn('[scores] табло рекордов недоступно:', e && e.message ? e.message : e);
      }
    }
  }

  let pollTimer = null;
  function stopPolling() {
    if (pollTimer !== null) { clearInterval(pollTimer); pollTimer = null; }
  }
  function startPolling() {
    if (pollTimer !== null) return;
    refreshBoard();
    pollTimer = setInterval(() => {
      if (state.mode !== 'menu') { stopPolling(); return; }
      refreshBoard();
    }, POLL_MS);
  }
  if (state.mode === 'menu') startPolling();

  // ---------- Отправка результата ----------
  let dirty = false;
  let sendTimer = null;

  function clampInt(v, min, max) {
    const n = Math.round(Number(v));
    if (!Number.isFinite(n)) return min;
    return Math.max(min, Math.min(max, n));
  }

  function buildPayload() {
    let quests = 0;
    try {
      if (Array.isArray(state.questLines)) {
        quests = state.questLines.filter((q) => q && q.done).length;
      }
    } catch { /* quests остаётся 0 */ }
    const st = state.stats || {};
    return {
      id: uid,
      name: getName(),
      money: clampInt(state.money, 0, 9_999_999),
      quests: clampInt(quests, 0, 8),
      hits: clampInt(st.hits, 0, 999_999),
      battles: clampInt(st.battlesWon, 0, 999_999),
      photos: clampInt(st.photos, 0, 999_999),
    };
  }

  function sendNow(keepalive) {
    dirty = false;
    if (sendTimer !== null) { clearTimeout(sendTimer); sendTimer = null; }
    // при 429/сетевом сбое результат не теряем: помечаем dirty и пробуем позже
    const retryLater = () => {
      dirty = true;
      if (sendTimer === null) {
        sendTimer = setTimeout(() => {
          sendTimer = null;
          if (dirty) sendNow(false);
        }, SEND_DEBOUNCE_MS + 4000 + Math.random() * 3000); // > серверных 5 c
      }
    };
    try {
      fetch(dir + 'api/score', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(buildPayload()),
        keepalive: !!keepalive,
      }).then((res) => { if (!res.ok) retryLater(); })
        .catch(retryLater);
    } catch { /* даже сам fetch не должен ронять игру */ }
  }

  function scheduleSend() {
    dirty = true;
    if (sendTimer !== null) clearTimeout(sendTimer);
    sendTimer = setTimeout(() => {
      sendTimer = null;
      if (dirty) sendNow(false);
    }, SEND_DEBOUNCE_MS);
  }

  for (const ev of ['questCompleted', 'battleEnd', 'saleMade', 'photoTaken', 'itemBought']) {
    bus.on(ev, scheduleSend);
  }

  // Первый выход из меню — тоже повод похвастаться (и глушим/заводим опрос табло).
  let leftMenuOnce = false;
  bus.on('modeChanged', (d) => {
    const mode = d && typeof d.mode === 'string' ? d.mode : state.mode;
    if (mode === 'menu') {
      startPolling();
    } else {
      stopPolling();
      if (!leftMenuOnce) {
        leftMenuOnce = true;
        scheduleSend();
      }
    }
  });

  // Вкладка сворачивается → шлём сразу, keepalive довезёт запрос.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && dirty) sendNow(true);
  });
}
