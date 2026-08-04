// HUD, тосты, prompt, плавающие тексты, шкала замаха, квест-панель, «Сохранено ✓».
import * as THREE from 'three';
import { state, bus } from './state.js';

// Временный вектор для проекции мировых позиций — один на модуль.
const _v = new THREE.Vector3();

const FLOAT_LIFE = 1.4;   // сек жизни плавающего текста
const FLOAT_RISE = 40;    // px подъёма за жизнь
const FLOAT_POOL = 30;    // максимум одновременно
const PROMPT_FRESH_MS = 150;
const CHARGE_FRESH_MS = 200;
const MONEY_FLASH_MS = 500;

export function createUI() {
  const $ = (id) => document.getElementById(id);
  const uiRoot = $('ui-root') || document.body;
  const moneyEl = $('hud-money');
  const ammoEl = $('hud-ammo');
  const dirtFill = $('hud-dirt') ? $('hud-dirt').querySelector('.fill') : null;
  const stinkFill = $('hud-stink') ? $('hud-stink').querySelector('.fill') : null;
  const itemsEl = $('hud-items');
  const hudQuestEl = $('hud-quest');
  const promptEl = $('prompt');
  const toastsEl = $('toasts');
  const floatingsEl = $('floatings');
  const stinkOverlay = $('stink-overlay');
  const chargeEl = $('charge');
  const chargeFill = chargeEl ? chargeEl.querySelector('.fill') : null;
  const questPanel = $('quest-panel');

  // ---------- Кэш последних значений (не трогаем DOM без нужды) ----------
  let lastMoney = null;
  let lastAmmo = null;
  let lastDirt = -1;
  let lastStink = -1;
  let lastItemsKey = null;
  let lastStinkOp = -1;
  let lastPromptShown = '';
  let chargeVisible = false;

  // Подсветка денег.
  let moneyFlashUntil = 0;
  let moneyFlashOn = false;
  bus.on('moneyChanged', (d) => {
    if (!d || !d.delta) return;
    if (moneyEl) {
      moneyEl.style.color = d.delta > 0 ? '#7dff9a' : '#ff8a7a';
      moneyFlashOn = true;
      moneyFlashUntil = performance.now() + MONEY_FLASH_MS;
    }
  });

  // ---------- Тосты ----------
  bus.on('toast', (d) => {
    if (!toastsEl || !d || !d.text) return;
    while (toastsEl.children.length >= 4) toastsEl.removeChild(toastsEl.firstChild);
    const el = document.createElement('div');
    el.className = 'toast' + (d.cls ? ' ' + d.cls : '');
    el.textContent = d.text;
    toastsEl.appendChild(el);
    const ms = typeof d.ms === 'number' ? d.ms : 2200;
    setTimeout(() => el.classList.add('out'), ms);
    setTimeout(() => el.remove(), ms + 420);
  });

  // ---------- Prompt (показываем, пока источник шлёт каждый кадр) ----------
  let promptText = '';
  let promptAt = 0;
  bus.on('prompt', (d) => {
    promptText = (d && d.text) || '';
    promptAt = performance.now();
  });

  // ---------- Шкала замаха ----------
  let chargeP = 0;
  let chargeAt = 0;
  bus.on('charge', (d) => {
    chargeP = d && typeof d.p === 'number' ? Math.max(0, Math.min(1, d.p)) : 0;
    chargeAt = performance.now();
  });

  // ---------- Плавающие тексты (пул) ----------
  const floatPool = []; // {el, x, y, z, age, active, visible}
  function spawnFloating(d) {
    if (!floatingsEl || !d || !d.pos || !d.text) return;
    let slot = null;
    let oldest = null;
    for (let i = 0; i < floatPool.length; i++) {
      const f = floatPool[i];
      if (!f.active) { slot = f; break; }
      if (!oldest || f.age > oldest.age) oldest = f;
    }
    if (!slot) {
      if (floatPool.length < FLOAT_POOL) {
        const el = document.createElement('div');
        el.style.display = 'none';
        floatingsEl.appendChild(el);
        slot = { el, x: 0, y: 0, z: 0, age: 0, active: false, visible: false };
        floatPool.push(slot);
      } else {
        slot = oldest; // пул забит — перезапускаем самый старый
      }
    }
    slot.el.className = 'floating' + (d.size === 'big' ? ' big' : '');
    slot.el.style.color = d.color || '#fff';
    slot.el.textContent = d.text;
    slot.el.style.display = 'none';
    slot.visible = false;
    slot.x = d.pos.x || 0;
    slot.y = d.pos.y || 0;
    slot.z = d.pos.z || 0;
    slot.age = 0;
    slot.active = true;
  }
  bus.on('floating', spawnFloating);

  // ---------- «Сохранено ✓» ----------
  let saveBadge = null;
  let saveTimer = 0;
  bus.on('saved', () => {
    if (!saveBadge) {
      saveBadge = document.createElement('div');
      saveBadge.className = 'save-badge';
      saveBadge.textContent = 'Сохранено ✓';
      uiRoot.appendChild(saveBadge);
    }
    saveBadge.classList.add('show');
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => saveBadge.classList.remove('show'), 1200);
  });

  // ---------- Квест-трекер в HUD ----------
  let hudQuestId = null;
  let hudQuestProg = -1;
  let hudQuestAllDone = false;
  let hudQuestRendered = false;

  function firstUndone() {
    const lines = state.questLines;
    if (!Array.isArray(lines)) return null;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i] && !lines[i].done) return lines[i];
    }
    return null;
  }

  function updateHudQuest() {
    if (!hudQuestEl) return false;
    const lines = state.questLines;
    if (!Array.isArray(lines) || lines.length === 0) return false;
    const q = firstUndone();
    if (!q) {
      if (hudQuestAllDone && hudQuestRendered) return false;
      hudQuestAllDone = true;
      hudQuestRendered = true;
      hudQuestId = null;
      hudQuestEl.innerHTML = '<div class="qtitle">Все квесты выполнены, саар! 🏆</div>';
      return true;
    }
    if (hudQuestRendered && q.id === hudQuestId && q.progress === hudQuestProg) return false;
    hudQuestAllDone = false;
    hudQuestRendered = true;
    hudQuestId = q.id;
    hudQuestProg = q.progress;
    const title = document.createElement('div');
    title.className = 'qtitle';
    title.textContent = `🎯 ${q.title} — ${q.progress}/${q.target}`;
    const hint = document.createElement('div');
    hint.className = 'qhint';
    hint.textContent = q.desc || '';
    hudQuestEl.replaceChildren(title, hint);
    return true;
  }

  // ---------- Квест-панель ----------
  let panelRerenderIn = 0;

  function renderQuestPanel() {
    if (!questPanel) return;
    questPanel.replaceChildren();
    const h2 = document.createElement('h2');
    h2.textContent = 'Квесты фестиваля';
    questPanel.appendChild(h2);

    const lines = Array.isArray(state.questLines) ? state.questLines : [];
    if (lines.length === 0) {
      const p = document.createElement('div');
      p.textContent = 'Квесты подъезжают, саар, минуточку…';
      questPanel.appendChild(p);
    }
    for (let i = 0; i < lines.length; i++) {
      const q = lines[i];
      if (!q) continue;
      const item = document.createElement('div');
      item.className = 'quest-item' + (q.done ? ' done' : '');
      const prog = document.createElement('span');
      prog.className = 'qprog';
      prog.textContent = `${q.progress}/${q.target} ₹${q.reward}`;
      const name = document.createElement('div');
      name.className = 'qname';
      name.textContent = q.title;
      const desc = document.createElement('div');
      desc.className = 'desc';
      desc.style.fontSize = '13px';
      desc.style.opacity = '.8';
      desc.textContent = q.desc || '';
      item.append(prog, name, desc);
      questPanel.appendChild(item);
    }

    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:10px;margin-top:14px;flex-wrap:wrap;';

    const share = document.createElement('button');
    share.className = 'btn primary';
    share.textContent = '📣 Поделиться результатами';
    share.addEventListener('click', () => shareResults(share));
    row.appendChild(share);

    const btn = document.createElement('button');
    btn.className = 'btn';
    btn.textContent = 'Закрыть (Tab)';
    btn.addEventListener('click', toggleQuests);
    row.appendChild(btn);
    questPanel.appendChild(row);
  }

  function shareResults(btnEl) {
    try {
      const lines = Array.isArray(state.questLines) ? state.questLines : [];
      const done = lines.filter((q) => q && q.done).length;
      const s = state.stats || {};
      const url = location.origin + location.pathname;
      const text =
        `Гарехабба 💩 — мой фестиваль: квесты ${done}/${lines.length || 8}, ` +
        `₹${state.money}, попаданий ${s.hits || 0}, побед в торговых битвах ${s.battlesWon || 0}, ` +
        `фото ${s.photos || 0}${done === (lines.length || 8) ? '. Все квесты выполнены, саар! 🏆' : ''} ` +
        `Играть: ${url}`;
      const okUi = () => {
        if (!btnEl) return;
        btnEl.textContent = '📣 Готово!';
        setTimeout(() => { btnEl.textContent = '📣 Поделиться результатами'; }, 1500);
      };
      const legacyCopy = () => {
        // insecure-контекст (http без TLS): share/clipboard недоступны — textarea+execCommand
        try {
          const ta = document.createElement('textarea');
          ta.value = text;
          ta.style.cssText = 'position:fixed;opacity:0;pointer-events:none;';
          document.body.appendChild(ta);
          ta.select();
          const ok = document.execCommand('copy');
          ta.remove();
          if (ok) {
            bus.emit('toast', { text: '📋 Скопировано — хвастайся, саар!', ms: 2200 });
            okUi();
          } else {
            bus.emit('toast', { text: 'Не вышло скопировать, саар. Вот текст в консоли.', ms: 2600, cls: 'error' });
            console.log(text);
          }
        } catch (e) { console.log(text); }
      };
      if (navigator.share) {
        navigator.share({ text }).then(okUi).catch((e) => {
          if (e && e.name === 'AbortError') return; // человек передумал — это не сбой
          legacyCopy();
        });
      } else if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(() => {
          bus.emit('toast', { text: '📋 Скопировано — хвастайся, саар!', ms: 2200 });
          okUi();
        }).catch(legacyCopy);
      } else {
        legacyCopy();
      }
    } catch (e) { /* не критично */ }
  }

  function toggleQuests() {
    if (!questPanel) return;
    if (questPanel.classList.contains('hidden')) {
      // открывать только на прогулке — не поверх магазина/ларька/битвы
      if (state.mode !== 'walk') return;
      renderQuestPanel();
      questPanel.classList.remove('hidden');
    } else {
      questPanel.classList.add('hidden');
    }
  }
  // если началась битва/сменился режим — журнал не должен закрывать экран
  bus.on('modeChanged', (d) => {
    if (d && d.mode !== 'walk' && questPanel) questPanel.classList.add('hidden');
  });

  // ---------- update: каждый кадр ----------
  function update(dt, camera) {
    try {
      const now = performance.now();

      // Деньги.
      if (moneyEl) {
        if (state.money !== lastMoney) {
          lastMoney = state.money;
          moneyEl.textContent = `₹${state.money}`;
        }
        if (moneyFlashOn && now > moneyFlashUntil) {
          moneyFlashOn = false;
          moneyEl.style.color = '';
        }
      }

      // Лепёшки.
      if (ammoEl && state.ammo !== lastAmmo) {
        lastAmmo = state.ammo;
        ammoEl.textContent = `💩 ${state.ammo}`;
      }

      // Грязь / запах.
      if (dirtFill) {
        const d = Math.round(Math.max(0, Math.min(100, state.dirtiness || 0)));
        if (d !== lastDirt) { lastDirt = d; dirtFill.style.width = d + '%'; }
      }
      if (stinkFill) {
        const s = Math.round(Math.max(0, Math.min(100, state.stink || 0)));
        if (s !== lastStink) { lastStink = s; stinkFill.style.width = s + '%'; }
      }

      // Предметы.
      if (itemsEl) {
        const it = state.items || {};
        const key = (it.slippers ? 's' : '') + (it.umbrella ? (state.umbrellaUp ? 'U' : 'u') : '') + (it.mask ? 'm' : '');
        if (key !== lastItemsKey) {
          lastItemsKey = key;
          itemsEl.replaceChildren();
          if (it.slippers) {
            const sp = document.createElement('span');
            sp.textContent = '🩴';
            itemsEl.appendChild(sp);
          }
          if (it.umbrella) {
            const sp = document.createElement('span');
            sp.textContent = '☂️';
            sp.style.opacity = state.umbrellaUp ? '1' : '.45';
            if (state.umbrellaUp) sp.style.filter = 'drop-shadow(0 0 4px #ffe66d)';
            itemsEl.appendChild(sp);
          }
          if (it.mask) {
            const sp = document.createElement('span');
            sp.textContent = '😷';
            itemsEl.appendChild(sp);
          }
          itemsEl.style.display = key === '' ? 'none' : '';
        }
      }

      // Квест-трекер + перерисовка открытой панели при изменениях.
      const questChanged = updateHudQuest();
      if (questPanel && !questPanel.classList.contains('hidden')) {
        if (questChanged) panelRerenderIn = 0.05; // чуть подождать пачку изменений
        if (panelRerenderIn > 0) {
          panelRerenderIn -= dt;
          if (panelRerenderIn <= 0) renderQuestPanel();
        }
      }

      // Prompt: показываем только «свежие» эмиты.
      if (promptEl) {
        const want = now - promptAt < PROMPT_FRESH_MS ? promptText : '';
        if (want !== lastPromptShown) {
          lastPromptShown = want;
          promptEl.textContent = want;
        }
      }

      // Шкала замаха.
      if (chargeEl && chargeFill) {
        const fresh = now - chargeAt < CHARGE_FRESH_MS;
        if (fresh) {
          if (!chargeVisible) { chargeVisible = true; chargeEl.classList.remove('hidden'); }
          chargeFill.style.width = (chargeP * 100).toFixed(1) + '%';
        } else if (chargeVisible) {
          chargeVisible = false;
          chargeEl.classList.add('hidden');
        }
      }

      // Зелёная дымка запаха.
      if (stinkOverlay) {
        const op = Math.max(0, Math.min(100, state.stink || 0)) / 100 * 0.85;
        if (Math.abs(op - lastStinkOp) > 0.005) {
          lastStinkOp = op;
          stinkOverlay.style.opacity = op.toFixed(3);
        }
      }

      // Плавающие тексты.
      if (camera) {
        const w = window.innerWidth;
        const h = window.innerHeight;
        for (let i = 0; i < floatPool.length; i++) {
          const f = floatPool[i];
          if (!f.active) continue;
          f.age += dt;
          if (f.age >= FLOAT_LIFE) {
            f.active = false;
            f.visible = false;
            f.el.style.display = 'none';
            continue;
          }
          _v.set(f.x, f.y, f.z).project(camera);
          if (_v.z > 1) { // позади камеры
            if (f.visible) { f.visible = false; f.el.style.display = 'none'; }
            continue;
          }
          if (!f.visible) { f.visible = true; f.el.style.display = ''; }
          const t = f.age / FLOAT_LIFE;
          const sx = (_v.x * 0.5 + 0.5) * w;
          const sy = (-_v.y * 0.5 + 0.5) * h - t * FLOAT_RISE;
          f.el.style.left = sx.toFixed(1) + 'px';
          f.el.style.top = sy.toFixed(1) + 'px';
          const fade = (FLOAT_LIFE - f.age) / 0.35;
          f.el.style.opacity = fade >= 1 ? '1' : Math.max(0, fade).toFixed(2);
        }
      }
    } catch (e) {
      console.warn('[ui] update', e);
    }
  }

  return { update, toggleQuests };
}
