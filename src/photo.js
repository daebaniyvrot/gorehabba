// Фоторежим (P): видоискатель, ЛКМ — снимок, оценка кадра 0..100 + комментарий.
import * as THREE from 'three';
import { state, bus, setMode } from './state.js';
import { audio } from './audio.js';

// Временные объекты уровня модуля — не аллоцируем в горячих путях.
const _mat4 = new THREE.Matrix4();
const _frustum = new THREE.Frustum();
const _point = new THREE.Vector3();
const _camPos = new THREE.Vector3();

const FOV_WALK = 70;
const FOV_PHOTO = 50;

function commentFor(score) {
  if (score >= 80) return 'Шедевр, саар! 📸';
  if (score >= 50) return 'Хороший кадр, саар!';
  if (score >= 25) return 'Неплохо, но где корова?';
  return 'Ну такое, саар…';
}

export function createPhotoMode(scene, camera, renderer, refs) {
  let active = false;
  let lastShotAt = 0;

  // ---------- DOM ----------
  const photoUi = document.getElementById('photo-ui');
  const uiRoot = document.getElementById('ui-root') || document.body;

  if (photoUi && !photoUi.querySelector('.frame')) {
    const frame = document.createElement('div');
    frame.className = 'frame';
    photoUi.appendChild(frame);
    const hint = document.createElement('div');
    hint.className = 'hint';
    hint.textContent = 'ЛКМ — снимок · P — выйти';
    photoUi.appendChild(hint);
  }

  // Миниатюры живут ВНЕ #photo-ui — чтобы оставались видны после выхода из режима.
  let thumbs = uiRoot.querySelector(':scope > .photo-thumbs');
  if (!thumbs) {
    thumbs = document.createElement('div');
    thumbs.className = 'photo-thumbs';
    uiRoot.appendChild(thumbs);
  }

  // ---------- Вход/выход ----------
  function enter() {
    active = true;
    if (photoUi) photoUi.classList.remove('hidden');
    camera.fov = FOV_PHOTO;
    camera.updateProjectionMatrix();
    setMode('photo');
  }

  function exit() {
    active = false;
    if (photoUi) photoUi.classList.add('hidden');
    camera.fov = FOV_WALK;
    camera.updateProjectionMatrix();
    if (state.mode === 'photo') setMode('walk');
  }

  function toggle() {
    if (state.mode === 'photo') exit();
    else if (state.mode === 'walk') enter();
    // из других режимов фотоаппарат не достаём
  }

  // Если режим сменили извне (сейв/панель/что угодно) — прибираем за собой.
  bus.on('modeChanged', (d) => {
    if (active && d && d.mode !== 'photo') exit();
  });

  // ---------- Оценка кадра ----------
  function scoreShot() {
    let score = 0;
    let nearest = Infinity;
    try {
      camera.updateMatrixWorld();
      _mat4.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      _frustum.setFromProjectionMatrix(_mat4);
      camera.getWorldPosition(_camPos);

      // Жители в кадре и в 3–25 м: +8 каждый (максимум 40), грязный (>30) — ещё +4.
      const list = (refs && refs.npcs && refs.npcs.list) || [];
      let npcPts = 0;
      for (let i = 0; i < list.length; i++) {
        const npc = list[i];
        const pos = npc && npc.getPosition ? npc.getPosition() : null;
        if (!pos) continue;
        _point.set(pos.x, pos.y + 1.0, pos.z);
        if (!_frustum.containsPoint(_point)) continue;
        const d = _camPos.distanceTo(_point);
        if (d < 3 || d > 25) continue;
        npcPts += 8;
        if ((npc.dirty || 0) > 30) score += 4;
        if (d < nearest) nearest = d;
      }
      score += Math.min(npcPts, 40);

      // Коровы в кадре: +20 каждая.
      const cows = (refs && refs.world && refs.world.cows) || [];
      for (let i = 0; i < cows.length; i++) {
        const cow = cows[i];
        const pos = cow && cow.getPosition ? cow.getPosition() : null;
        if (!pos) continue;
        _point.set(pos.x, pos.y + 0.7, pos.z);
        if (!_frustum.containsPoint(_point)) continue;
        const d = _camPos.distanceTo(_point);
        if (d > 30) continue;
        score += 20;
        if (d < nearest) nearest = d;
      }

      // Праздничная куча (центр площади) — звезда фестиваля: +12.
      const square = refs && refs.world && refs.world.landmarks && refs.world.landmarks.square;
      if (square) {
        _point.set(square.x, square.y + 2, square.z);
        if (_frustum.containsPoint(_point)) {
          const d = _camPos.distanceTo(_point);
          if (d < 30) {
            score += 12;
            if (d < nearest) nearest = d;
          }
        }
      }

      // Храм в кадре и ближе 60 м: +15.
      const temple = refs && refs.world && refs.world.landmarks && refs.world.landmarks.temple;
      if (temple) {
        for (const h of [2.5, 6]) { // низ и башня — достаточно поймать любую
          _point.set(temple.x, temple.y + h, temple.z);
          if (!_frustum.containsPoint(_point)) continue;
          const d = _camPos.distanceTo(_point);
          if (d < 60) {
            score += 15;
            if (d < nearest) nearest = d;
          }
          break;
        }
      }

      // Бонус за композицию: ближайший объект в 4–22 м.
      if (nearest >= 4 && nearest <= 22) score += 12;

      // Случайность ±5.
      score += Math.random() * 10 - 5;
    } catch (e) {
      console.warn('[photo] score', e);
    }
    return Math.max(0, Math.min(100, Math.round(score)));
  }

  // ---------- Снимок ----------
  function takeShot() {
    const now = performance.now();
    if (now - lastShotAt < 350) return; // не чаще вспышки
    lastShotAt = now;

    // Вспышка.
    if (photoUi) {
      const flash = document.createElement('div');
      flash.className = 'photo-flash';
      photoUi.appendChild(flash);
      setTimeout(() => flash.remove(), 380);
    }
    try { audio.camera(); } catch (e) { /* тихо */ }

    const score = scoreShot();
    const comment = commentFor(score);

    // Миниатюра (стек до 3, старые удаляем).
    try {
      const url = renderer.domElement.toDataURL('image/jpeg', 0.7);
      const img = document.createElement('img');
      img.src = url;
      img.alt = `Фото ${score}/100`;
      thumbs.appendChild(img);
      while (thumbs.children.length > 3) thumbs.removeChild(thumbs.firstChild);
    } catch (e) {
      console.warn('[photo] toDataURL', e);
    }

    state.stats.photos++;
    if (score >= 50) state.stats.goodPhotos++;
    bus.emit('photoTaken', { score, comment });
    bus.emit('toast', { text: `📸 ${score}/100 — ${comment}`, ms: 2600 });
  }

  window.addEventListener('mousedown', (e) => {
    if (!active || state.mode !== 'photo') return;
    if (e.button !== 0) return;
    // снимок только кликом по канвасу (или в pointer lock) — не по кнопкам UI
    const cv = renderer && renderer.domElement;
    if (cv && e.target !== cv && document.pointerLockElement !== cv) return;
    takeShot();
  });

  function update(dt) {
    // Покачивание рамки не обязательно — оставляем пустым (guard на всякий случай).
  }

  return {
    get active() { return active; },
    toggle,
    update,
  };
}
