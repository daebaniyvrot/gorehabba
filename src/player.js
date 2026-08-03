// player.js — игрок-турист «Гарехаббы»: low-poly модель, бег/прыжки,
// камера от 3-го лица, замах и бросок лепёшек, зонтик, грязь на одежде и запах.
import * as THREE from 'three';
import { state, bus } from './state.js';
import { audio } from './audio.js';

const RADIUS = 0.35;
const HEIGHT = 1.7;
const CAM_DIST = 3.2;
const CAM_HEIGHT = 1.9;
const SENS = 0.0026;
const CHARGE_TIME = 0.9;   // секунд до полного замаха
const SHOUT_CD = 1.2;      // кулдаун крика «СААР!»
const MAX_SPOTS = 12;      // пятен грязи на теле
const MAX_UMB_SPOTS = 5;   // «декалей» на зонте

const MOVE_CODES = {
  KeyW: 1, KeyA: 1, KeyS: 1, KeyD: 1,
  ArrowUp: 1, ArrowDown: 1, ArrowLeft: 1, ArrowRight: 1, Space: 1,
};

// временные объекты уровня модуля — ничего не создаём в горячем цикле
const _pos = new THREE.Vector3();
const _tgt = new THREE.Vector3();
const _v1 = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _desired = new THREE.Vector3();
const _look = new THREE.Vector3();
const _camPos = new THREE.Vector3();
const _chargeMsg = { p: 0 };

const SHIRT_BASE = new THREE.Color(0xff6b9d); // яркая туристическая рубашка
const PANTS_BASE = new THREE.Color(0xffe66d); // весёлые штаны
const DIRT_COLOR = new THREE.Color(0x503214); // бурый цвет навозной грязи

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

export function createPlayer(scene, world, camera, projectiles) {
  // ================= МОДЕЛЬ =================
  const group = new THREE.Group(); // корень; position.y = уровень ног
  const lean = new THREE.Group();  // верх тела — наклоняется при беге
  lean.position.y = 0.78;
  group.add(lean);

  const skinMat = new THREE.MeshLambertMaterial({ color: 0xd9975e, flatShading: true });
  const shirtMat = new THREE.MeshLambertMaterial({ color: SHIRT_BASE, flatShading: true });
  const pantsMat = new THREE.MeshLambertMaterial({ color: PANTS_BASE, flatShading: true });
  const capMat = new THREE.MeshLambertMaterial({ color: 0x4ecdc4, flatShading: true });
  const darkMat = new THREE.MeshLambertMaterial({ color: 0x2b2b2b, flatShading: true });
  const packMat = new THREE.MeshLambertMaterial({ color: 0x54a0ff, flatShading: true });
  const umbMat = new THREE.MeshLambertMaterial({ color: 0xff9f43, flatShading: true });
  const poleMat = new THREE.MeshLambertMaterial({ color: 0x6b4a2b, flatShading: true });
  const spotMat = new THREE.MeshBasicMaterial({ color: 0x4a2c12 });

  function mk(geo, mat, x, y, z, parent, shadow = true) {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.castShadow = shadow;
    parent.add(m);
    return m;
  }

  // ноги (пивот в бедре, качаются при беге)
  const legGeo = new THREE.BoxGeometry(0.17, 0.78, 0.19);
  legGeo.translate(0, -0.39, 0);
  const legL = new THREE.Group(); legL.position.set(0.13, 0.78, 0); group.add(legL);
  const legR = new THREE.Group(); legR.position.set(-0.13, 0.78, 0); group.add(legR);
  mk(legGeo, pantsMat, 0, 0, 0, legL);
  mk(legGeo, pantsMat, 0, 0, 0, legR);

  // туловище-«рубашка» + рюкзак туриста
  const torso = mk(new THREE.BoxGeometry(0.56, 0.6, 0.32), shirtMat, 0, 0.27, 0, lean);
  mk(new THREE.BoxGeometry(0.36, 0.42, 0.18), packMat, 0, 0, -0.26, torso);

  // голова, кепка, тёмные очки
  mk(new THREE.SphereGeometry(0.17, 8, 6), skinMat, 0, 0.74, 0, lean);
  mk(new THREE.CylinderGeometry(0.19, 0.19, 0.1, 8), capMat, 0, 0.87, 0, lean);
  mk(new THREE.BoxGeometry(0.3, 0.03, 0.16), capMat, 0, 0.84, 0.2, lean);
  mk(new THREE.BoxGeometry(0.26, 0.05, 0.04), darkMat, 0, 0.77, 0.15, lean, false);

  // руки (пивот в плече)
  const armGeo = new THREE.BoxGeometry(0.14, 0.62, 0.16);
  armGeo.translate(0, -0.27, 0);
  const armL = new THREE.Group(); armL.position.set(0.35, 0.54, 0); lean.add(armL);
  const armR = new THREE.Group(); armR.position.set(-0.35, 0.54, 0); lean.add(armR);
  mk(armGeo, skinMat, 0, 0, 0, armL);
  mk(armGeo, skinMat, 0, 0, 0, armR);

  // ---------- зонтик (ПКМ): купол + спицы ----------
  const umb = new THREE.Group();
  umb.visible = false;
  umb.rotation.x = 0.22; // чуть наклонён вперёд — прикрывает лицо
  group.add(umb);
  mk(new THREE.CylinderGeometry(0.025, 0.025, 1.3, 6), poleMat, 0, 1.75, 0, umb);
  mk(new THREE.ConeGeometry(0.95, 0.4, 8), umbMat, 0, 2.3, 0, umb);
  mk(new THREE.SphereGeometry(0.045, 6, 5), umbMat, 0, 2.56, 0, umb, false);
  const spokeGeo = new THREE.BoxGeometry(0.95, 0.018, 0.018);
  spokeGeo.translate(0.475, 0, 0);
  spokeGeo.rotateZ(-0.2);
  spokeGeo.translate(0, 2.28, 0);
  for (let i = 0; i < 8; i++) {
    const s = new THREE.Mesh(spokeGeo, poleMat);
    s.rotation.y = (i / 8) * Math.PI * 2;
    umb.add(s);
  }
  // «декали» блока на куполе
  const umbSpotGeo = new THREE.SphereGeometry(0.055, 6, 5);
  const umbSpots = [];
  for (let i = 0; i < MAX_UMB_SPOTS; i++) {
    const m = new THREE.Mesh(umbSpotGeo, spotMat);
    m.scale.set(1, 0.45, 1);
    m.visible = false;
    umb.add(m);
    umbSpots.push(m);
  }

  // ---------- пятна грязи на теле (пул, ≤12) ----------
  const spotGeo = new THREE.CircleGeometry(0.075, 10);
  const spots = [];
  for (let i = 0; i < MAX_SPOTS; i++) {
    const m = new THREE.Mesh(spotGeo, spotMat);
    m.visible = false;
    torso.add(m);
    spots.push(m);
  }

  group.position.set(4, 0, 10); // старт у центральной площади
  scene.add(group);

  // ================= СОСТОЯНИЕ =================
  let yaw = Math.PI;        // камера смотрит на храм
  let pitch = 0.15;
  let modelYaw = Math.PI;
  let vy = 0, onGround = true;
  let moveBlend = 0, phase = 0;
  let chargeActive = false, chargeP = 0, throwT = 0;
  let umbrellaHeld = false, dragLook = false;
  let shakeT = 0, snapCam = false, wasActive = false;
  let t = 0, lastShout = -SHOUT_CD;
  let lastDirt = -1, spotIdx = 0, umbSpotIdx = 0;
  let warned = false;
  let canvas = null;
  const keys = Object.create(null);
  const touchMove = { x: 0, z: 0 }; // вектор виртуального джойстика (-1..1)
  let jumpQueued = false, jumps = 0, flipT = 0; // двойной прыжок с флипом

  function getCanvas() {
    if (!canvas) canvas = document.querySelector('#game canvas');
    return canvas;
  }

  // ================= ВВОД =================
  function handleQ() {
    if (state.mode === 'battle') { bus.emit('battleTap', {}); return; }
    if (state.mode !== 'walk' && state.mode !== 'photo') return;
    if (t - lastShout < SHOUT_CD) return;
    lastShout = t;
    try { audio.shout(true); } catch (e) { /* звук не критичен */ }
    const x = group.position.x, y = group.position.y + 2.2, z = group.position.z;
    bus.emit('floating', { pos: { x, y, z }, text: 'СААР!', size: 'big' });
    bus.emit('playerShout', { pos: { x, y, z } });
  }

  function onKeyDown(e) {
    if (e.code === 'KeyQ') { if (!e.repeat) handleQ(); return; }
    if (e.code === 'Space' && !e.repeat) jumpQueued = true; // фронт нажатия — для двойного прыжка
    if (MOVE_CODES[e.code]) {
      keys[e.code] = true;
      if (state.mode === 'walk' || state.mode === 'photo') e.preventDefault();
    }
  }
  function onKeyUp(e) { if (MOVE_CODES[e.code]) keys[e.code] = false; }

  function tryPointerLock() {
    const cv = getCanvas();
    if (!cv || document.pointerLockElement === cv) return;
    try {
      const r = cv.requestPointerLock();
      if (r && typeof r.catch === 'function') r.catch(() => {});
    } catch (e) { /* fallback — drag-обзор */ }
  }

  function onMouseDown(e) {
    const mode = state.mode;
    if (mode !== 'walk' && mode !== 'photo') return;
    const cv = getCanvas();
    const onCanvas = (cv && e.target === cv) || document.pointerLockElement === cv;
    if (!onCanvas) return;
    tryPointerLock();
    dragLook = true;
    if (e.button === 0) {
      if (mode === 'walk' && !chargeActive) { chargeActive = true; chargeP = 0; }
    } else if (e.button === 2) {
      umbrellaHeld = true;
    }
  }

  function onMouseUp(e) {
    if (e.button === 0) releaseCharge();
    else if (e.button === 2) umbrellaHeld = false;
    if (e.buttons === 0) dragLook = false;
  }

  function onMouseMove(e) {
    const mode = state.mode;
    if (mode !== 'walk' && mode !== 'photo') return;
    const cv = getCanvas();
    const locked = cv && document.pointerLockElement === cv;
    if (!locked && !(dragLook && e.buttons > 0)) return;
    yaw -= (e.movementX || 0) * SENS;
    pitch = clamp(pitch + (e.movementY || 0) * SENS, -0.5, 1.15);
  }

  function onBlur() {
    for (const k in keys) keys[k] = false;
    umbrellaHeld = false;
    dragLook = false;
    cancelCharge();
  }

  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('mousedown', onMouseDown);
  window.addEventListener('mouseup', onMouseUp);
  window.addEventListener('mousemove', onMouseMove);
  window.addEventListener('blur', onBlur);

  bus.on('modeChanged', (d) => {
    const m = d && d.mode;
    if (m !== 'walk' && m !== 'photo') {
      cancelCharge();
      try { if (document.pointerLockElement) document.exitPointerLock(); } catch (e) {}
    }
  });

  // ================= ЗАМАХ / БРОСОК =================
  function cancelCharge() {
    if (!chargeActive) return;
    chargeActive = false;
    chargeP = 0;
    _chargeMsg.p = 0;
    bus.emit('charge', _chargeMsg);
  }

  function releaseCharge() {
    if (!chargeActive) return;
    chargeActive = false;
    const p = chargeP;
    chargeP = 0;
    _chargeMsg.p = 0;
    bus.emit('charge', _chargeMsg);
    if (state.mode !== 'walk') return;
    if (state.ammo > 0) doThrow(Math.max(0.12, p));
    else bus.emit('toast', { text: 'Кончились лепёшки, саар! Подбери 💩 на улице', ms: 2200 });
  }

  function doThrow(power) {
    const cp = Math.cos(pitch), sp = Math.sin(pitch);
    const fx = Math.sin(yaw), fz = Math.cos(yaw);
    // вперёд по камере + небольшой подъём дуги
    const dir = new THREE.Vector3(fx * cp, -sp + 0.18, fz * cp).normalize();
    // от плеча: чуть вперёд и вправо
    const from = new THREE.Vector3(
      group.position.x + fx * 0.3 - fz * 0.2,
      group.position.y + 1.45,
      group.position.z + fz * 0.3 + fx * 0.2
    );
    if (projectiles && typeof projectiles.throwDung === 'function') {
      projectiles.throwDung({ from, dir, power, owner: 'player' });
    }
    // для мультиплеера: полный вектор броска (bus 'throw' из physics его не несёт)
    bus.emit('playerThrow', {
      from: { x: from.x, y: from.y, z: from.z },
      dir: { x: dir.x, y: dir.y, z: dir.z },
      power,
    });
    state.ammo = Math.max(0, state.ammo - 1);
    bus.emit('ammoChanged', {});
    throwT = 0.22; // анимация руки вперёд
  }

  // ================= ПОПАДАНИЯ ПО ИГРОКУ =================
  function onHit(hit) {
    try {
      if (!group.visible || state.mode === 'tuktuk' || state.mode === 'menu') return;
      const vel = hit && hit.velocity;
      if (state.umbrellaUp && vel && typeof vel.x === 'number') {
        _v1.set(vel.x, vel.y || 0, vel.z || 0);
        if (_v1.lengthSq() > 1e-6) {
          _v1.normalize();
          _fwd.set(Math.sin(modelYaw), 0, Math.cos(modelYaw));
          if (_v1.dot(_fwd) < -0.2) {
            // блок зонтом: звук, «декаль» на куполе, без грязи
            try { audio.thud(); } catch (e) {}
            addUmbrellaSpot();
            bus.emit('floating', {
              pos: { x: group.position.x, y: group.position.y + 2.3, z: group.position.z },
              text: 'Блок!', color: '#ffe66d',
            });
            return;
          }
        }
      }
      addDirt(15, hit && hit.point);
      if (state.stats) state.stats.timesHit++;
      bus.emit('playerHit', { owner: hit && hit.owner });
      try { audio.splat(); } catch (e) {}
      shakeT = 0.35;
    } catch (e) { /* попадание не должно ронять кадр */ }
  }

  if (projectiles && typeof projectiles.registerTarget === 'function') {
    projectiles.registerTarget({
      id: 'player',
      getPosition: () => _tgt.copy(group.position),
      radius: RADIUS,
      height: HEIGHT,
      onHit,
    });
  }

  // ================= ГРЯЗЬ / ЧИСТОТА =================
  function applyTint() {
    const k = clamp((state.dirtiness || 0) / 100, 0, 1);
    shirtMat.color.copy(SHIRT_BASE).lerp(DIRT_COLOR, k * 0.75);
    pantsMat.color.copy(PANTS_BASE).lerp(DIRT_COLOR, k * 0.6);
  }

  function placeSpot(mesh, point) {
    const hx = 0.28, hy = 0.3, hz = 0.16, off = 0.015;
    let lx, ly, lz;
    if (point && typeof point.x === 'number') {
      _v1.set(point.x, point.y || 0, point.z || 0);
      torso.worldToLocal(_v1);
      lx = clamp(_v1.x, -hx, hx);
      ly = clamp(_v1.y, -hy, hy);
      lz = clamp(_v1.z, -hz, hz);
    } else {
      lx = (Math.random() * 2 - 1) * hx;
      ly = (Math.random() * 2 - 1) * hy * 0.9;
      lz = (Math.random() * 2 - 1) * hz;
    }
    // выносим пятно на ближайшую боковую грань туловища
    if (Math.abs(lx) / hx > Math.abs(lz) / hz) {
      lx = (lx >= 0 ? 1 : -1) * (hx + off);
      mesh.rotation.set(0, lx > 0 ? Math.PI / 2 : -Math.PI / 2, 0);
    } else {
      lz = (lz >= 0 ? 1 : -1) * (hz + off);
      mesh.rotation.set(0, lz > 0 ? 0 : Math.PI, 0);
    }
    mesh.position.set(lx, ly, lz);
    mesh.scale.setScalar(0.8 + Math.random() * 0.8);
    mesh.visible = true;
  }

  function addDirt(amount, point) {
    state.dirtiness = Math.min(100, (state.dirtiness || 0) + (amount || 0));
    lastDirt = state.dirtiness;
    applyTint();
    const spot = spots[spotIdx % spots.length];
    spotIdx++;
    placeSpot(spot, point);
  }

  function cleanUp() {
    state.dirtiness = 0;
    lastDirt = 0;
    for (let i = 0; i < spots.length; i++) spots[i].visible = false;
    for (let i = 0; i < umbSpots.length; i++) umbSpots[i].visible = false;
    spotIdx = 0;
    umbSpotIdx = 0;
    applyTint();
  }

  function addUmbrellaSpot() {
    const m = umbSpots[umbSpotIdx % umbSpots.length];
    umbSpotIdx++;
    const a = Math.random() * Math.PI * 2;
    const f = 0.2 + Math.random() * 0.55;      // доля высоты купола
    const r = 0.95 * (1 - f) * 0.92;
    m.position.set(Math.cos(a) * r, 2.1 + 0.4 * f, Math.sin(a) * r);
    m.visible = true;
  }

  // ================= ВОНЬ (state.stink) =================
  function updateStink(dt) {
    let s = state.stink || 0;
    let rise = 0;
    if (state.ammo > 0) rise += 1.2;                 // лепёшки в руках попахивают
    rise += (state.dirtiness || 0) * 0.05;           // грязная одежда — сильнее
    let fall = 0.8;
    if ((state.dirtiness || 0) < 1 && state.ammo === 0) fall = 7; // чистый — выветривается
    const mask = !!(state.items && state.items.mask);
    if (mask) fall += 10;                            // маска: быстрый спад
    s = clamp(s + (rise - fall) * dt, 0, 100);
    if (mask && s > 20) s = 20;                      // и потолок 20
    state.stink = s;
  }

  // ================= ФИЗИКА / КОЛЛИЗИИ =================
  function collide() {
    const cols = world && world.colliders;
    const p = group.position;
    if (Array.isArray(cols)) {
      for (let i = 0; i < cols.length; i++) {
        const b = cols[i];
        if (!b || !b.min || !b.max) continue;
        if (p.y > b.max.y || p.y + HEIGHT < b.min.y) continue;
        const cx = clamp(p.x, b.min.x, b.max.x);
        const cz = clamp(p.z, b.min.z, b.max.z);
        const dx = p.x - cx, dz = p.z - cz;
        const d2 = dx * dx + dz * dz;
        if (d2 >= RADIUS * RADIUS) continue;
        if (d2 > 1e-8) {
          const d = Math.sqrt(d2);
          const push = (RADIUS - d) / d;
          p.x += dx * push;
          p.z += dz * push;
        } else {
          // центр внутри AABB — выталкиваем по минимальному проникновению
          const px1 = p.x - b.min.x, px2 = b.max.x - p.x;
          const pz1 = p.z - b.min.z, pz2 = b.max.z - p.z;
          const m = Math.min(px1, px2, pz1, pz2);
          if (m === px1) p.x = b.min.x - RADIUS;
          else if (m === px2) p.x = b.max.x + RADIUS;
          else if (m === pz1) p.z = b.min.z - RADIUS;
          else p.z = b.max.z + RADIUS;
        }
      }
    }
    const bd = world && world.bounds;
    if (bd) {
      p.x = clamp(p.x, bd.minX + RADIUS, bd.maxX - RADIUS);
      p.z = clamp(p.z, bd.minZ + RADIUS, bd.maxZ - RADIUS);
    }
  }

  // ================= АНИМАЦИЯ =================
  function animate(dt, moving, mvx, mvz, speedMul) {
    const targetBlend = moving && onGround ? 1 : 0;
    moveBlend += (targetBlend - moveBlend) * Math.min(1, dt * 8);
    phase += dt * 9.5 * moveBlend * speedMul;
    const swing = Math.sin(phase) * 0.8 * moveBlend;

    if (onGround) {
      legL.rotation.x = swing;
      legR.rotation.x = -swing;
    } else {
      // в прыжке ноги поджаты
      legL.rotation.x += (0.5 - legL.rotation.x) * Math.min(1, dt * 10);
      legR.rotation.x += (-0.3 - legR.rotation.x) * Math.min(1, dt * 10);
    }
    armL.rotation.x = -swing * 0.9;

    // правая рука: замах → бросок → обычные махи
    let target, rate;
    if (chargeActive) { target = -1.6 - 0.9 * chargeP; rate = 10; }
    else if (throwT > 0) { throwT -= dt; target = 1.1; rate = 26; }
    else { target = swing * 0.9; rate = 12; }
    armR.rotation.x += (target - armR.rotation.x) * Math.min(1, dt * rate);

    // лёгкий наклон корпуса и подскок при беге + дыхание в покое (+ сальто двойного прыжка)
    let flip = 0;
    if (flipT > 0) {
      flipT = Math.max(0, flipT - dt);
      flip = (1 - flipT / 0.45) * -Math.PI * 2;
    }
    lean.rotation.x = 0.14 * moveBlend + (chargeActive ? 0.06 : 0) + flip;
    lean.rotation.z = Math.sin(t * 2) * 0.02 * (1 - moveBlend);
    lean.position.y = 0.78 + Math.abs(Math.sin(phase)) * 0.05 * moveBlend;

    // поворот модели: к движению; при замахе/зонте — по камере
    let yawT = modelYaw;
    if (chargeActive || throwT > 0 || state.umbrellaUp) yawT = yaw;
    else if (moving) yawT = Math.atan2(mvx, mvz);
    let d = yawT - modelYaw;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    modelYaw += d * Math.min(1, dt * 12);
    group.rotation.y = modelYaw;
  }

  // ================= КАМЕРА =================
  function updateCamera(dt) {
    const cp = Math.cos(pitch), sp = Math.sin(pitch);
    _desired.set(
      group.position.x - Math.sin(yaw) * cp * CAM_DIST,
      group.position.y + CAM_HEIGHT + sp * CAM_DIST,
      group.position.z - Math.cos(yaw) * cp * CAM_DIST
    );
    if (_desired.y < 0.4) _desired.y = 0.4;
    const k = snapCam ? 1 : 1 - Math.exp(-10 * dt);
    snapCam = false;
    _camPos.lerp(_desired, k);
    camera.position.copy(_camPos);
    if (shakeT > 0) {
      shakeT = Math.max(0, shakeT - dt);
      const a = 0.14 * (shakeT / 0.35);
      camera.position.x += (Math.random() - 0.5) * a;
      camera.position.y += (Math.random() - 0.5) * a;
      camera.position.z += (Math.random() - 0.5) * a;
    }
    _look.set(group.position.x, group.position.y + 1.4, group.position.z);
    camera.lookAt(_look);
  }

  // ================= UPDATE =================
  function updateInner(dt) {
    t += dt;
    const mode = state.mode;
    const active = mode === 'walk' || mode === 'photo';

    // зонт: только если куплен и мы на улице
    const wantUmb = umbrellaHeld && !!(state.items && state.items.umbrella) && active;
    state.umbrellaUp = wantUmb;
    umb.visible = wantUmb;

    // ввод движения относительно камеры (клавиатура + виртуальный джойстик)
    let ix = 0, iz = 0;
    if (active) {
      if (keys.KeyW || keys.ArrowUp) iz += 1;
      if (keys.KeyS || keys.ArrowDown) iz -= 1;
      if (keys.KeyD || keys.ArrowRight) ix += 1;
      if (keys.KeyA || keys.ArrowLeft) ix -= 1;
      ix += touchMove.x;
      iz += touchMove.z;
    }
    let mvx = 0, mvz = 0, moving = false;
    if (ix !== 0 || iz !== 0) {
      const fx = Math.sin(yaw), fz = Math.cos(yaw);
      mvx = fx * iz - fz * ix; // право = (-cos, 0, sin)
      mvz = fz * iz + fx * ix;
      const len = Math.hypot(mvx, mvz);
      if (len > 1) { mvx /= len; mvz /= len; } // аналоговый джойстик < 1 не форсируем
      moving = len > 0.05;
      if (!moving) { mvx = 0; mvz = 0; }
    }
    let speed = 4.2;
    if (state.items && state.items.slippers) speed *= 1.45;
    if (state.umbrellaUp) speed *= 0.8;
    if (moving) {
      group.position.x += mvx * speed * dt;
      group.position.z += mvz * speed * dt;
    }

    // прыжок и гравитация (гравитация работает во всех режимах)
    // фронт нажатия ИЛИ удержание — иначе тап (keydown+keyup в одном кадре) теряется
    if (active && (jumpQueued || keys.Space) && onGround) { vy = 6.5; onGround = false; jumps = 1; }
    else if (active && jumpQueued && !onGround && jumps > 0 && jumps < 2) {
      // двойной прыжок: второй толчок в воздухе + сальто
      vy = 6.2;
      jumps = 2;
      flipT = 0.45;
      try { audio.whoosh(); } catch (e) { /* звук не критичен */ }
    }
    jumpQueued = false;
    vy -= 18 * dt;
    group.position.y += vy * dt;
    let gy = 0;
    if (world && typeof world.groundY === 'function') {
      gy = world.groundY(group.position.x, group.position.z) || 0;
    }
    if (group.position.y <= gy) {
      group.position.y = gy;
      vy = 0;
      onGround = true;
      jumps = 0; // приземлились — прыжки восстановлены
    } else onGround = false;

    collide();

    // замах
    if (chargeActive) {
      if (mode !== 'walk') cancelCharge();
      else {
        chargeP = Math.min(1, chargeP + dt / CHARGE_TIME);
        _chargeMsg.p = chargeP;
        bus.emit('charge', _chargeMsg);
      }
    }

    if (mode !== 'menu') updateStink(dt);

    // потемнение одежды могло «приехать» из сейва — подтягиваем
    if (state.dirtiness !== lastDirt) { lastDirt = state.dirtiness; applyTint(); }

    animate(dt, moving, mvx, mvz, speed / 4.2);

    if (active) {
      if (!wasActive) _camPos.copy(camera.position);
      updateCamera(dt);
    }
    wasActive = active;
  }

  function update(dt) {
    try { updateInner(dt); }
    catch (e) { if (!warned) { warned = true; console.error('[player]', e); } }
  }

  // ================= ПУБЛИЧНЫЙ API =================
  function getPosition() { return _pos.copy(group.position); }

  function teleport(pos, yaw2) {
    if (!pos) return;
    group.position.set(pos.x || 0, Math.max(0, pos.y || 0), pos.z || 0);
    vy = 0;
    onGround = true;
    if (typeof yaw2 === 'number') {
      yaw = yaw2;
      modelYaw = yaw2;
      group.rotation.y = yaw2;
    }
    snapCam = true; // камера мгновенно встаёт за спину
  }

  function setVisible(v) { group.visible = !!v; }

  // ---------- тач-управление (виртуальный джойстик и кнопки, см. touch.js) ----------
  const touchControls = {
    move(x, z) { // -1..1 в координатах камеры (z = вперёд)
      touchMove.x = Math.max(-1, Math.min(1, Number(x) || 0));
      touchMove.z = Math.max(-1, Math.min(1, Number(z) || 0));
    },
    look(dx, dy) { // пиксельные дельты пальца по правой зоне экрана
      if (state.mode !== 'walk' && state.mode !== 'photo') return;
      yaw -= (Number(dx) || 0) * SENS * 1.6;
      pitch = clamp(pitch + (Number(dy) || 0) * SENS * 1.6, -0.5, 1.15);
    },
    chargeStart() {
      if (state.mode !== 'walk' || chargeActive) return;
      chargeActive = true;
      chargeP = 0;
    },
    chargeRelease() { releaseCharge(); },
    setUmbrella(held) { umbrellaHeld = !!held; },
  };

  return {
    object3d: group,
    radius: RADIUS,
    height: HEIGHT,
    getPosition,
    update,
    addDirt,
    cleanUp,
    teleport,
    setVisible,
    touchControls,
  };
}
