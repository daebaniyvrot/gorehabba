// Гарехабба — «Магазин дяди Раджеша»: навес на столбах, прилавок,
// товары-декорации, покачивающийся продавец и DOM-панель покупок.
// Контракт: createShop(scene, world, player) -> { update(dt), tryInteract() -> bool }

import * as THREE from 'three';
import { state, bus, setMode, addMoney, addAmmo } from './state.js';
import { audio } from './audio.js';

const INTERACT_R2 = 3.5 * 3.5; // радиус взаимодействия (в квадрате)
const GREET_R2 = 14 * 14;      // радиус, в котором продавец зазывает

const GOODS = [
  { id: 'slippers', icon: '🩴', name: 'Шлёпанцы', desc: '+45% к скорости — летай по базару, саар', price: 99, once: true, verb: 'Купить', toast: '🩴 Шлёпанцы твои! Беги как ветер, саар!' },
  { id: 'umbrella', icon: '☂️', name: 'Зонтик', desc: 'ПКМ — раскрыть: щит от лепёшек спереди', price: 149, once: true, verb: 'Купить', toast: '☂️ Зонтик твой! Лепёшки спереди не страшны!' },
  { id: 'mask', icon: '😷', name: 'Маска', desc: 'Больше не воняет — дыши спокойно', price: 79, once: true, verb: 'Купить', toast: '😷 Маска твоя! Свежий воздух, саар!' },
  { id: 'bag', icon: '💩', name: 'Мешок лепёшек', desc: '+10 лепёшек в запас (можно брать снова)', price: 25, once: false, verb: 'Купить', toast: '💩 +10 лепёшек! Метких бросков, саар!' },
  { id: 'wash', icon: '🧺', name: 'Стирка', desc: 'Одежда снова как новая', price: 40, once: false, verb: 'Постирать', toast: '🧺 Красота! Чистый как на свадьбу, саар!' },
];

const PHRASES = [
  'Халло саар! Лучшие шлёпанцы на весь базар!',
  'Заходи, саар! Всё свежее, всё для тебя!',
  'Зонтик, маска, шлёпанцы — праздник без забот, саар!',
  'Такие цены — только сегодня, саар!',
];

function sfx(name, ...args) { try { if (audio && typeof audio[name] === 'function') audio[name](...args); } catch {} }
function toast(text, ms = 2000, cls) { bus.emit('toast', { text, ms, cls }); }
function nowMs() { return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now(); }

function makeTextTexture(text, bg, fg, w = 640, h = 128, fontPx = 54) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d');
  g.fillStyle = bg; g.fillRect(0, 0, w, h);
  g.strokeStyle = fg; g.lineWidth = 8; g.strokeRect(5, 5, w - 10, h - 10);
  g.fillStyle = fg;
  g.font = `900 ${fontPx}px "Trebuchet MS", "Segoe UI", sans-serif`;
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(text, w / 2, h / 2 + 3);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function makeStripesTexture(c1, c2) {
  const c = document.createElement('canvas');
  c.width = 64; c.height = 64;
  const g = c.getContext('2d');
  for (let i = 0; i < 8; i++) { g.fillStyle = (i % 2) ? c1 : c2; g.fillRect(i * 8, 0, 8, 64); }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(3, 1);
  return tex;
}

export function createShop(scene, world, player) {
  const lm = world && world.landmarks && world.landmarks.shop;
  const anchor = { x: lm ? lm.x : 20, z: lm ? lm.z : 14 };

  // ---------- переиспользуемые геометрии/материалы ----------
  const BOXG = new THREE.BoxGeometry(1, 1, 1);
  const SPHEREG = new THREE.SphereGeometry(1, 8, 6);
  const CONEG = new THREE.ConeGeometry(1, 1, 7);
  const CYLG = new THREE.CylinderGeometry(1, 1, 1, 8);
  const mats = new Map();
  const mat = (color) => {
    if (!mats.has(color)) mats.set(color, new THREE.MeshLambertMaterial({ color, flatShading: true }));
    return mats.get(color);
  };
  function box(parent, w, h, d, color, x, y, z, ry = 0) {
    const m = new THREE.Mesh(BOXG, mat(color));
    m.scale.set(w, h, d); m.position.set(x, y, z); m.rotation.y = ry;
    m.castShadow = true; m.receiveShadow = true;
    parent.add(m); return m;
  }
  function sphere(parent, r, color, x, y, z) {
    const m = new THREE.Mesh(SPHEREG, mat(color));
    m.scale.setScalar(r); m.position.set(x, y, z); m.castShadow = true;
    parent.add(m); return m;
  }

  // ---------- стенд ----------
  const group = new THREE.Group();
  group.position.set(anchor.x, 0, anchor.z);
  group.rotation.y = Math.atan2(-anchor.x, -anchor.z); // лицом к площади (0,0)
  scene.add(group);

  // столбы
  box(group, 0.14, 2.6, 0.14, '#8a5a2b', -1.7, 1.3, -1.15);
  box(group, 0.14, 2.6, 0.14, '#8a5a2b', 1.7, 1.3, -1.15);
  box(group, 0.14, 2.6, 0.14, '#8a5a2b', -1.7, 1.3, 1.15);
  box(group, 0.14, 2.6, 0.14, '#8a5a2b', 1.7, 1.3, 1.15);

  // полосатый навес
  const canopy = new THREE.Mesh(BOXG, new THREE.MeshLambertMaterial({ map: makeStripesTexture('#ff9f43', '#fff3e0') }));
  canopy.scale.set(4.2, 0.1, 3.1);
  canopy.position.set(0, 2.68, 0.1);
  canopy.rotation.x = 0.1;
  canopy.castShadow = true;
  group.add(canopy);

  // прилавок + столешница
  const counter = box(group, 3.4, 0.92, 0.8, '#a06a33', 0, 0.46, 0.95);
  box(group, 3.6, 0.08, 1.0, '#c98d3e', 0, 0.96, 0.95);

  // товары-декорации на прилавке
  box(group, 0.3, 0.05, 0.13, '#ff6b9d', -1.15, 1.05, 0.85, 0.35); // шлёпанец
  box(group, 0.3, 0.05, 0.13, '#ff6b9d', -0.88, 1.05, 0.98, 0.12); // шлёпанец
  box(group, 0.34, 0.18, 0.24, '#54a0ff', 0.02, 1.1, 0.9);          // коробка с масками
  box(group, 0.55, 0.22, 0.4, '#8a5a2b', 0.78, 1.12, 0.85);         // ящик с лепёшками
  sphere(group, 0.09, '#6b4423', 0.66, 1.27, 0.8);
  sphere(group, 0.09, '#6b4423', 0.9, 1.27, 0.9);
  sphere(group, 0.08, '#6b4423', 0.78, 1.3, 0.94);
  const stick = new THREE.Mesh(CYLG, mat('#5c3a17'));                // зонтик у столба
  stick.scale.set(0.025, 1.1, 0.025); stick.position.set(1.42, 0.8, 0.95); stick.rotation.z = 0.18;
  stick.castShadow = true; group.add(stick);
  const umb = new THREE.Mesh(CONEG, mat('#4ecdc4'));
  umb.scale.set(0.42, 0.32, 0.42); umb.position.set(1.52, 1.45, 0.95); umb.rotation.z = 0.18;
  umb.castShadow = true; group.add(umb);

  // полка сзади с яркими коробками
  box(group, 3.0, 0.08, 0.45, '#8a5a2b', 0, 1.6, -1.02);
  box(group, 0.4, 0.3, 0.3, '#4ecdc4', -1.0, 1.8, -1.02);
  box(group, 0.35, 0.36, 0.3, '#ffe66d', -0.32, 1.82, -1.02);
  box(group, 0.4, 0.26, 0.3, '#9b59b6', 0.42, 1.77, -1.02);
  box(group, 0.3, 0.3, 0.3, '#ff6b9d', 1.08, 1.8, -1.02);

  // продавец — дядя Раджеш (покачивается)
  const vendor = new THREE.Group();
  vendor.position.set(0, 0, -0.45);
  group.add(vendor);
  box(vendor, 0.44, 0.55, 0.26, '#f5f6fa', 0, 0.28, 0);        // дхоти
  box(vendor, 0.56, 0.75, 0.3, '#ff9f43', 0, 0.93, 0);         // курта
  box(vendor, 0.14, 0.55, 0.14, '#ff9f43', -0.37, 0.98, 0);    // руки
  box(vendor, 0.14, 0.55, 0.14, '#ff9f43', 0.37, 0.98, 0);
  const head = sphere(vendor, 0.19, '#c68642', 0, 1.5, 0);     // голова
  const turban = sphere(vendor, 1, '#e74c3c', 0, 1.64, 0);     // тюрбан
  turban.scale.set(0.21, 0.13, 0.21);

  // вывеска
  const sign = new THREE.Mesh(
    new THREE.PlaneGeometry(3.0, 0.55),
    new THREE.MeshBasicMaterial({ map: makeTextTexture('ЛАВКА ДЯДИ РАДЖЕША', '#ffe66d', '#8a3a12'), side: THREE.DoubleSide })
  );
  sign.position.set(0, 2.28, 1.6);
  group.add(sign);

  group.updateMatrixWorld(true);
  const vendorHeadPos = new THREE.Vector3().setFromMatrixPosition(head.matrixWorld);

  // прилавок — препятствие; повёрнутый бокс режем на сегменты,
  // чтобы AABB не раздувался на пол-лавки
  try {
    if (world && Array.isArray(world.colliders)) {
      const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
      counter.updateWorldMatrix(true, false);
      counter.matrixWorld.decompose(p, q, s);
      const e = new THREE.Euler().setFromQuaternion(q, 'YXZ');
      const cos = Math.abs(Math.cos(e.y)), sin = Math.abs(Math.sin(e.y));
      const ax = new THREE.Vector3(1, 0, 0).applyQuaternion(q);
      const SEGS = 4;
      for (let i = 0; i < SEGS; i++) {
        const off = ((i + 0.5) / SEGS - 0.5) * s.x;
        const cx = p.x + ax.x * off, cz = p.z + ax.z * off;
        const hx = (s.x / (2 * SEGS)) * cos + (s.z / 2) * sin;
        const hz = (s.x / (2 * SEGS)) * sin + (s.z / 2) * cos;
        world.colliders.push(new THREE.Box3(
          new THREE.Vector3(cx - hx, Math.max(0, p.y - s.y / 2), cz - hz),
          new THREE.Vector3(cx + hx, p.y + s.y / 2, cz + hz)
        ));
      }
    }
  } catch {}

  // ---------- DOM-панель ----------
  let panel = null;
  let moneyEl = null;
  let rows = [];
  let closedAt = -1e9; // защита от повторного открытия тем же нажатием E

  function refresh() {
    if (!panel) return;
    if (moneyEl) moneyEl.textContent = `₹${state.money}`;
    for (const r of rows) {
      const owned = r.good.once && state.items && state.items[r.good.id];
      if (owned) { r.btn.textContent = 'Куплено'; r.btn.disabled = true; }
      else {
        r.btn.textContent = `${r.good.verb} ₹${r.good.price}`;
        r.btn.disabled = state.money < r.good.price;
      }
    }
  }

  function buy(good) {
    if (!panel) return;
    if (good.once && state.items && state.items[good.id]) return;
    if (state.money < good.price) { toast('Не хватает рупий, саар!', 1600, 'error'); return; }
    if (good.id === 'bag' && state.ammo >= state.maxAmmo) { toast('Карманы и так полны лепёшек, саар!', 1800); return; }
    if (good.id === 'wash' && state.dirtiness <= 0) { toast('Ты и так чистый, саар!', 1800); return; }
    addMoney(-good.price);
    if (good.id === 'bag') {
      addAmmo(10);
    } else if (good.id === 'wash') {
      try { if (player && typeof player.cleanUp === 'function') player.cleanUp(); } catch {}
      state.dirtiness = 0;
    } else if (state.items) {
      state.items[good.id] = true;
    }
    bus.emit('itemBought', { id: good.id });
    sfx('chaChing');
    toast(good.toast, 2200);
    refresh();
  }

  function buildPanel() {
    const root = document.getElementById('panels');
    if (!root) return false;

    panel = document.createElement('div');
    panel.className = 'panel';

    const h2 = document.createElement('h2');
    h2.textContent = '🛍️ Магазин дяди Раджеша';
    panel.appendChild(h2);

    const sub = document.createElement('div');
    sub.className = 'desc';
    sub.textContent = 'Всё лучшее для фестиваля, саар! Только сегодня, только для тебя!';
    sub.style.marginBottom = '8px';
    panel.appendChild(sub);

    const moneyRow = document.createElement('div');
    moneyRow.className = 'row';
    const mLabel = document.createElement('span');
    mLabel.textContent = 'Твои рупии:';
    moneyEl = document.createElement('b');
    moneyEl.style.color = '#ffd27a';
    moneyRow.appendChild(mLabel);
    moneyRow.appendChild(moneyEl);
    panel.appendChild(moneyRow);

    rows = [];
    for (const good of GOODS) {
      const row = document.createElement('div');
      row.className = 'row';
      const info = document.createElement('div');
      const nm = document.createElement('div');
      nm.style.fontWeight = '800';
      nm.textContent = `${good.icon} ${good.name} — ₹${good.price}`;
      const ds = document.createElement('div');
      ds.className = 'desc';
      ds.textContent = good.desc;
      info.appendChild(nm);
      info.appendChild(ds);
      const btn = document.createElement('button');
      btn.className = 'btn';
      btn.addEventListener('click', () => buy(good));
      row.appendChild(info);
      row.appendChild(btn);
      panel.appendChild(row);
      rows.push({ good, btn });
    }

    const footer = document.createElement('div');
    footer.style.cssText = 'display:flex;justify-content:flex-end;margin-top:14px;';
    const leave = document.createElement('button');
    leave.className = 'btn primary';
    leave.textContent = 'Уйти';
    leave.addEventListener('click', () => close());
    footer.appendChild(leave);
    panel.appendChild(footer);

    root.appendChild(panel);
    refresh();
    return true;
  }

  function close(backToWalk = true) {
    if (!panel) return;
    const el = panel;
    panel = null;
    rows = [];
    moneyEl = null;
    try { el.remove(); } catch {}
    closedAt = nowMs();
    sfx('click');
    if (backToWalk) setMode('walk');
  }

  // постоянные подписки (панель может отсутствовать — guard'ы внутри)
  bus.on('moneyChanged', () => { if (panel) refresh(); });
  bus.on('ammoChanged', () => { if (panel) refresh(); });
  bus.on('modeChanged', (d) => {
    // кто-то извне сменил режим — прибираем панель без повторного setMode
    if (panel && d && d.mode !== 'shop') close(false);
  });
  window.addEventListener('keydown', (e) => {
    if (!panel) return;
    if (e.code === 'Escape' || e.code === 'KeyE') { e.preventDefault(); close(); }
  });

  // ---------- API ----------
  function playerPos() {
    try { return player && typeof player.getPosition === 'function' ? player.getPosition() : null; }
    catch { return null; }
  }
  function distSqToAnchor() {
    const p = playerPos();
    if (!p) return Infinity;
    const dx = p.x - anchor.x, dz = p.z - anchor.z;
    return dx * dx + dz * dz;
  }

  function tryInteract() {
    if (panel || state.mode !== 'walk') return false;
    if (nowMs() - closedAt < 250) return false; // то же нажатие E, что закрыло панель
    if (distSqToAnchor() > INTERACT_R2) return false;
    if (!buildPanel()) { panel = null; return false; }
    setMode('shop');
    sfx('click');
    bus.emit('floating', { pos: { x: vendorHeadPos.x, y: vendorHeadPos.y + 0.5, z: vendorHeadPos.z }, text: 'Халло саар! Что берём?', color: '#ffd27a' });
    return true;
  }

  let swayT = Math.random() * 10;
  let phraseT = 3 + Math.random() * 4;
  let phraseIdx = (Math.random() * PHRASES.length) | 0;

  function update(dt) {
    try {
      swayT += dt;
      vendor.rotation.z = Math.sin(swayT * 1.7) * 0.055;
      vendor.position.y = Math.abs(Math.sin(swayT * 2.1)) * 0.02;

      const d2 = distSqToAnchor();
      if (state.mode === 'walk' && d2 < INTERACT_R2) {
        bus.emit('prompt', { text: 'E — магазин' });
      }

      phraseT -= dt;
      if (phraseT <= 0) {
        phraseT = 8 + Math.random() * 6;
        if (d2 < GREET_R2 && (state.mode === 'walk' || state.mode === 'shop')) {
          phraseIdx = (phraseIdx + 1) % PHRASES.length;
          bus.emit('floating', { pos: { x: vendorHeadPos.x, y: vendorHeadPos.y + 0.5, z: vendorHeadPos.z }, text: PHRASES[phraseIdx], color: '#ffd27a' });
        }
      }
    } catch (e) { /* update не должен ронять кадр */ }
  }

  return { update, tryInteract };
}
