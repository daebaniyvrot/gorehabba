// touch.js — мобильное управление «Гарехаббы»: виртуальный джойстик движения,
// обзор свайпом по правой части экрана и дуга кнопок действий (правый низ).
// Самодостаточный модуль: на не-тач устройствах ничего не создаёт.
import { state, bus } from './state.js';

const JOY_R = 52;          // максимальный ход стика от центра, px
const BASE_R = 60;         // половина диаметра базы джойстика (~120px)
const PROMPT_FRESH = 300;  // мс: сколько «E» считается актуальной после bus 'prompt'

export function createTouch({ player } = {}) {
  // Только устройства, где ОСНОВНОЙ указатель — палец (телефоны/планшеты).
  // На гибридных тач-ноутбуках зоны перехватывали бы всю мышь — там их не строим.
  const isTouch = (window.matchMedia && matchMedia('(pointer: coarse)').matches)
    || location.search.includes('touch=1'); // ?touch=1 — для тестов на десктопе
  if (!isTouch) return {};
  // идемпотентность: повторный вызов не плодит слушателей и DOM
  const stale = document.getElementById('touch-root');
  if (stale) stale.remove();

  // guard: без touchControls кнопки-клавиши всё равно работают, остальное — no-op
  const tc = (player && player.touchControls) || null;

  // обёртка: ни один тач-обработчик не должен ронять игру
  const safe = (fn) => function (e) {
    try { fn(e); } catch (err) { /* тач-контролы не критичны */ }
  };

  document.body.classList.add('touch-device');
  const host = document.getElementById('ui-root') || document.body;

  const root = document.createElement('div');
  root.id = 'touch-root';
  host.appendChild(root);
  root.addEventListener('contextmenu', (e) => e.preventDefault());

  // Тапы по непокрытой полосе канваса (левый верх) не должны рождать
  // compatibility mouse events → холостой бросок/случайный снимок.
  const gameEl = document.getElementById('game');
  if (gameEl) {
    gameEl.addEventListener('touchstart', safe((e) => e.preventDefault()), { passive: false });
  }
  // iOS: пинч-зум страницы жестом
  document.addEventListener('gesturestart', safe((e) => e.preventDefault()), { passive: false });

  // ================= ЗОНЫ =================
  // левая 45%-зона (ниже 30% сверху — не трогаем HUD) — динамический джойстик;
  // правая 55%-зона — обзор камеры свайпом. Кнопки лежат поверх зон.
  const zoneMove = document.createElement('div');
  zoneMove.id = 'tz-move';
  zoneMove.className = 'touch-zone';
  root.appendChild(zoneMove);

  const zoneLook = document.createElement('div');
  zoneLook.id = 'tz-look';
  zoneLook.className = 'touch-zone';
  root.appendChild(zoneLook);

  // ================= ВИЗУАЛ ДЖОЙСТИКА =================
  const joyBase = document.createElement('div');
  joyBase.id = 'tj-base';
  const joyStick = document.createElement('div');
  joyStick.id = 'tj-stick';
  joyBase.appendChild(joyStick);
  root.appendChild(joyBase);

  // ================= КНОПКИ =================
  function makeBtn(id, label, title) {
    const b = document.createElement('button');
    b.type = 'button';
    b.id = id;
    b.className = 'touch-btn';
    b.textContent = label;
    if (title) b.title = title;
    root.appendChild(b);
    return b;
  }
  const btnThrow = makeBtn('tb-throw', '💩', 'Замах и бросок (в фоторежиме — затвор)');
  const btnJump = makeBtn('tb-jump', '⬆️', 'Прыжок');
  const btnSaar = makeBtn('tb-saar', 'СААР!', 'Крикнуть (и торговая битва)');
  const btnUmb = makeBtn('tb-umb', '☂️', 'Зонтик — держать');
  const btnPhoto = makeBtn('tb-photo', '📸', 'Фоторежим');
  const btnE = makeBtn('tb-e', 'E', 'Взаимодействие');
  const btnQuest = makeBtn('tb-quest', '📜', 'Квесты');
  btnUmb.classList.add('tc-off'); // покажем, когда зонт куплен
  btnE.classList.add('tc-off');   // покажем возле интерактива (bus 'prompt')

  // синтетические клавиши — главный цикл и player их понимают
  function key(type, code, k) {
    try {
      window.dispatchEvent(new KeyboardEvent(type, {
        code, key: k || code, bubbles: true, cancelable: true,
      }));
    } catch (e) { /* не критично */ }
  }

  // затвор фоторежима: photo.js ловит mousedown по канвасу
  function shutter(type) {
    const cv = document.querySelector('#game canvas');
    if (!cv) return;
    cv.dispatchEvent(new MouseEvent(type, { button: 0, bubbles: true, cancelable: true }));
  }

  // кнопка-«удержание»: touchstart → onDown, touchend/touchcancel → onUp.
  // stopPropagation — чтобы кнопки не крали касания у зон.
  function bindHold(btn, onDown, onUp) {
    btn.addEventListener('touchstart', safe((e) => {
      e.preventDefault();
      e.stopPropagation();
      btn.classList.add('pressed');
      if (onDown) onDown();
    }), { passive: false });
    const up = safe((e) => {
      e.preventDefault();
      e.stopPropagation();
      btn.classList.remove('pressed');
      if (onUp) onUp();
    });
    btn.addEventListener('touchend', up, { passive: false });
    btn.addEventListener('touchcancel', up, { passive: false });
  }

  bindHold(btnThrow, () => {
    if (state.mode === 'photo') { shutter('mousedown'); return; }
    if (tc) tc.chargeStart();
  }, () => {
    if (state.mode === 'photo') { shutter('mouseup'); return; }
    if (tc) tc.chargeRelease();
  });
  bindHold(btnJump, () => key('keydown', 'Space', ' '), () => key('keyup', 'Space', ' '));
  bindHold(btnSaar, () => key('keydown', 'KeyQ', 'q'), () => key('keyup', 'KeyQ', 'q'));
  bindHold(btnUmb, () => { if (tc) tc.setUmbrella(true); }, () => { if (tc) tc.setUmbrella(false); });
  bindHold(btnPhoto, () => { key('keydown', 'KeyP', 'p'); key('keyup', 'KeyP', 'p'); }, null);
  bindHold(btnE, () => { key('keydown', 'KeyE', 'e'); key('keyup', 'KeyE', 'e'); }, null);
  bindHold(btnQuest, () => { key('keydown', 'Tab', 'Tab'); key('keyup', 'Tab', 'Tab'); }, null);

  // ================= ДЖОЙСТИК (левая зона) =================
  let joyId = null, joyX = 0, joyY = 0;

  function resetJoy() {
    joyId = null;
    joyBase.classList.remove('on');
    joyStick.style.transform = 'translate(0px, 0px)';
    if (tc) tc.move(0, 0);
  }

  zoneMove.addEventListener('touchstart', safe((e) => {
    e.preventDefault();
    if (joyId !== null) return; // джойстиком рулит один палец
    const t = e.changedTouches[0];
    if (!t) return;
    joyId = t.identifier;
    joyX = t.clientX;
    joyY = t.clientY;
    joyBase.style.left = (joyX - BASE_R) + 'px';
    joyBase.style.top = (joyY - BASE_R) + 'px';
    joyStick.style.transform = 'translate(0px, 0px)';
    joyBase.classList.add('on');
  }), { passive: false });

  zoneMove.addEventListener('touchmove', safe((e) => {
    e.preventDefault();
    if (joyId === null) return;
    for (let i = 0; i < e.changedTouches.length; i++) {
      const t = e.changedTouches[i];
      if (t.identifier !== joyId) continue;
      let dx = t.clientX - joyX;
      let dy = t.clientY - joyY;
      const len = Math.hypot(dx, dy);
      if (len > JOY_R) { dx = (dx / len) * JOY_R; dy = (dy / len) * JOY_R; }
      joyStick.style.transform = 'translate(' + dx + 'px, ' + dy + 'px)';
      if (tc) tc.move(dx / JOY_R, -dy / JOY_R); // вверх экрана = вперёд (+z)
    }
  }), { passive: false });

  const joyEnd = safe((e) => {
    e.preventDefault();
    for (let i = 0; i < e.changedTouches.length; i++) {
      if (e.changedTouches[i].identifier === joyId) { resetJoy(); break; }
    }
  });
  zoneMove.addEventListener('touchend', joyEnd, { passive: false });
  zoneMove.addEventListener('touchcancel', joyEnd, { passive: false });

  // ================= КАМЕРА (правая зона) =================
  let camId = null, camX = 0, camY = 0;

  zoneLook.addEventListener('touchstart', safe((e) => {
    e.preventDefault();
    if (camId !== null) return;
    const t = e.changedTouches[0];
    if (!t) return;
    camId = t.identifier;
    camX = t.clientX;
    camY = t.clientY;
  }), { passive: false });

  zoneLook.addEventListener('touchmove', safe((e) => {
    e.preventDefault();
    if (camId === null) return;
    for (let i = 0; i < e.changedTouches.length; i++) {
      const t = e.changedTouches[i];
      if (t.identifier !== camId) continue;
      const dx = t.clientX - camX;
      const dy = t.clientY - camY;
      camX = t.clientX;
      camY = t.clientY;
      if (tc) tc.look(dx, dy);
    }
  }), { passive: false });

  const camEnd = safe((e) => {
    e.preventDefault();
    for (let i = 0; i < e.changedTouches.length; i++) {
      if (e.changedTouches[i].identifier === camId) { camId = null; break; }
    }
  });
  zoneLook.addEventListener('touchend', camEnd, { passive: false });
  zoneLook.addEventListener('touchcancel', camEnd, { passive: false });

  // потеря фокуса — отпускаем всё
  window.addEventListener('blur', safe(() => {
    resetJoy();
    camId = null;
    if (tc) tc.setUmbrella(false);
  }));

  // ================= КОНТЕКСТНАЯ ВИДИМОСТЬ =================
  let lastPrompt = -1e9;
  bus.on('prompt', () => { lastPrompt = performance.now(); refresh(); });
  bus.on('itemBought', () => refresh());

  function refresh() {
    try {
      btnUmb.classList.toggle('tc-off', !(state.items && state.items.umbrella));
      const freshE = state.mode === 'walk' && (performance.now() - lastPrompt) < PROMPT_FRESH;
      btnE.classList.toggle('tc-off', !freshE);
    } catch (e) { /* не критично */ }
  }
  setInterval(refresh, 150); // лёгкий тик: зонт куплен? «E» ещё актуальна?

  // menu/shop/stall/tuktuk — всё скрыто; battle — только большая «СААР!»
  function applyMode(m) {
    root.classList.toggle('tc-battle', m === 'battle');
    root.classList.toggle('tc-hidden',
      m === 'menu' || m === 'shop' || m === 'stall' || m === 'tuktuk');
    if (m !== 'walk' && m !== 'photo') {
      resetJoy();
      camId = null;
      if (tc) tc.setUmbrella(false);
    }
    refresh();
  }
  bus.on('modeChanged', (d) => { try { applyMode(d && d.mode); } catch (e) {} });
  applyMode(state.mode);

  return {};
}
