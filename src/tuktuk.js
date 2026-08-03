// Гарехабба — tuktuk.js: тук-туки. Три фоновых ездят по кольцу дорог,
// рабочий стоит у стоянки и возит игрока к ориентирам — безумно, но с любовью.
import * as THREE from 'three';
import { state, bus, setMode, addMoney } from './state.js';
import { audio } from './audio.js';

// ---------- общие материалы/геометрии (переиспользуются всеми тук-туками) ----------

const MAT = {
  green: new THREE.MeshLambertMaterial({ color: 0x2f9e63 }),
  yellow: new THREE.MeshLambertMaterial({ color: 0xffe66d }),
  black: new THREE.MeshLambertMaterial({ color: 0x2b2b2b }),
  hub: new THREE.MeshLambertMaterial({ color: 0xd9d9d9 }),
  seat: new THREE.MeshLambertMaterial({ color: 0x8b4a2e }),
  skin: new THREE.MeshLambertMaterial({ color: 0xc68642 }),
  turban: new THREE.MeshLambertMaterial({ color: 0xfff3e0 }),
  light: new THREE.MeshBasicMaterial({ color: 0xfff2b0 }),
  shirtPink: new THREE.MeshLambertMaterial({ color: 0xff6b9d }),
  shirtOrange: new THREE.MeshLambertMaterial({ color: 0xff9f43 }),
  shirtBlue: new THREE.MeshLambertMaterial({ color: 0x54a0ff }),
};

const GEO = {
  lower: new THREE.BoxGeometry(1.3, 0.7, 2.0),
  nose: new THREE.BoxGeometry(1.0, 0.55, 0.5),
  roof: new THREE.BoxGeometry(1.4, 0.1, 2.1),
  post: new THREE.BoxGeometry(0.07, 0.85, 0.07),
  wheel: new THREE.CylinderGeometry(0.3, 0.3, 0.16, 10).rotateZ(Math.PI / 2),
  hub: new THREE.CylinderGeometry(0.13, 0.13, 0.18, 8).rotateZ(Math.PI / 2),
  seat: new THREE.BoxGeometry(1.1, 0.14, 0.5),
  barColumn: new THREE.BoxGeometry(0.07, 0.45, 0.07),
  bar: new THREE.BoxGeometry(0.6, 0.06, 0.06),
  headlight: new THREE.BoxGeometry(0.18, 0.18, 0.08),
  torso: new THREE.BoxGeometry(0.5, 0.55, 0.3),
  head: new THREE.BoxGeometry(0.28, 0.28, 0.26),
  turban: new THREE.BoxGeometry(0.32, 0.1, 0.3),
  arm: new THREE.BoxGeometry(0.1, 0.4, 0.1),
};

// npcs этому модулю недоступен — простой весёлый человечек из боксов.
function makeDriver(shirtMat) {
  const g = new THREE.Group();
  const torso = new THREE.Mesh(GEO.torso, shirtMat);
  torso.position.y = 0.22;
  g.add(torso);
  const head = new THREE.Mesh(GEO.head, MAT.skin);
  head.position.y = 0.58;
  g.add(head);
  const turban = new THREE.Mesh(GEO.turban, MAT.turban);
  turban.position.y = 0.76;
  g.add(turban);
  const armL = new THREE.Mesh(GEO.arm, shirtMat);
  armL.position.set(-0.24, 0.34, 0.18);
  armL.rotation.x = -1.15;
  g.add(armL);
  const armR = new THREE.Mesh(GEO.arm, shirtMat);
  armR.position.set(0.24, 0.34, 0.18);
  armR.rotation.x = -1.15;
  g.add(armR);
  return g;
}

// Зелёно-жёлтый тук-тук: корпус-боксы, навес, руль, 3 колеса, водитель.
function makeTuktukMesh(shirtMat) {
  const g = new THREE.Group();
  g.rotation.order = 'YXZ'; // yaw → тангаж → крен

  const lower = new THREE.Mesh(GEO.lower, MAT.green);
  lower.position.set(0, 0.62, -0.1);
  g.add(lower);
  const nose = new THREE.Mesh(GEO.nose, MAT.green);
  nose.position.set(0, 0.58, 1.05);
  g.add(nose);
  const roof = new THREE.Mesh(GEO.roof, MAT.yellow);
  roof.position.set(0, 1.72, -0.05);
  g.add(roof);
  const postPos = [[-0.6, 0.85], [0.6, 0.85], [-0.6, -0.95], [0.6, -0.95]];
  for (let i = 0; i < postPos.length; i++) {
    const p = new THREE.Mesh(GEO.post, MAT.yellow);
    p.position.set(postPos[i][0], 1.25, postPos[i][1]);
    g.add(p);
  }
  const seat = new THREE.Mesh(GEO.seat, MAT.seat);
  seat.position.set(0, 1.0, -0.55);
  g.add(seat);
  const column = new THREE.Mesh(GEO.barColumn, MAT.black);
  column.position.set(0, 1.1, 0.75);
  column.rotation.x = 0.35;
  g.add(column);
  const bar = new THREE.Mesh(GEO.bar, MAT.black);
  bar.position.set(0, 1.3, 0.68);
  g.add(bar);
  const headlight = new THREE.Mesh(GEO.headlight, MAT.light);
  headlight.position.set(0, 0.66, 1.32);
  g.add(headlight);

  const wheels = [];
  const wheelPos = [[0, 1.15], [-0.62, -0.75], [0.62, -0.75]];
  for (let i = 0; i < wheelPos.length; i++) {
    const w = new THREE.Mesh(GEO.wheel, MAT.black);
    w.position.set(wheelPos[i][0], 0.3, wheelPos[i][1]);
    const hub = new THREE.Mesh(GEO.hub, MAT.hub);
    w.add(hub);
    g.add(w);
    wheels.push(w);
  }

  const driver = makeDriver(shirtMat);
  driver.position.set(0, 0.9, 0.35);
  g.add(driver);

  g.traverse((o) => { if (o.isMesh) o.castShadow = true; });
  return { group: g, wheels };
}

// ---------- маршруты по решётке дорог (x/z ∈ {-28, 0, 28}) ----------

const STAND_FALLBACK = { x: 34, z: 2 };
const LOOP = [[28, 28], [-28, 28], [-28, -28], [28, -28]];
const PHRASES = ['Саар, держись!', 'Дорогу, саар!', 'Хорошая цена, да?', 'Саар, держись крепче!'];

// Манхэттен-путь от стоянки; drop — куда высадить игрока, face — куда он смотрит.
const DESTS = {
  temple: {
    label: '🛕 Храм', price: 15,
    route: [[28, 2], [28, -28], [0, -28], [0, -41]],
    drop: { x: 2, z: -41 }, face: { x: 0, z: -48 },
  },
  square: {
    label: '🎪 Площадь', price: 10,
    route: [[28, 2], [28, 0], [10, 0]],
    drop: { x: 8.5, z: 2 }, face: { x: 0, z: 0 },
  },
  shop: {
    label: '🛍️ Магазин', price: 12,
    route: [[28, 2], [28, 14]],
    drop: { x: 25, z: 14 }, face: { x: 20, z: 14 },
  },
  stall: {
    label: '💩 Ларёк', price: 12,
    route: [[28, 2], [28, 28], [-28, 28], [-28, 14]],
    drop: { x: -25, z: 14 }, face: { x: -20, z: 14 },
  },
};

// временные векторы — не аллоцируем в горячем цикле
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();

export function createTuktuks(scene, world, player) {
  const lm = (world && world.landmarks) || {};
  const STAND = lm.tuktukStand
    ? { x: lm.tuktukStand.x, z: lm.tuktukStand.z }
    : STAND_FALLBACK;
  // точки face уточняем по реальным ориентирам, если они есть
  for (const key of Object.keys(DESTS)) {
    if (lm[key]) { DESTS[key].face = { x: lm[key].x, z: lm[key].z }; }
  }

  // камеру main нам не передаёт — ловим её через onBeforeRender крошечного
  // невидимого меша (frustumCulled=false → вызывается каждый кадр).
  let cameraRef = null;
  const camSpy = new THREE.Mesh(
    new THREE.PlaneGeometry(0.01, 0.01),
    new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false })
  );
  camSpy.position.set(0, -60, 0);
  camSpy.frustumCulled = false;
  camSpy.onBeforeRender = (renderer, sc, cam) => { cameraRef = cam; };
  scene.add(camSpy);

  // ---------- фабрика состояния тук-тука ----------
  function makeTuk(shirtMat) {
    const { group, wheels } = makeTuktukMesh(shirtMat);
    scene.add(group);
    return {
      group, wheels,
      route: null, seg: 0, loop: false,
      pos: { x: 0, z: 0 }, dirX: 0, dirZ: 1,
      speed: 7, baseSpeed: 7, phase: 0,
      lat: 0, latTarget: 0, latTimer: 0, baseLat: 0, latAmp: 0.4, latRate: 4,
      yaw: 0, roll: 0,
      hopY: 0, hopV: 0, hopTimer: 2 + Math.random() * 3,
      honkT: 1 + Math.random(), sayT: 2,
      state: 'idle', dest: null,
    };
  }

  // продвижение вдоль маршрута; true — конец не-лупового маршрута
  function advance(tt, dt) {
    const route = tt.route;
    if (!route || route.length < 2) return true;
    let remaining = tt.speed * dt;
    let guard = 4;
    while (remaining > 0 && guard-- > 0) {
      const nextIdx = tt.loop ? (tt.seg + 1) % route.length : tt.seg + 1;
      if (!tt.loop && nextIdx >= route.length) return true;
      const b = route[nextIdx];
      const dx = b[0] - tt.pos.x;
      const dz = b[1] - tt.pos.z;
      const d = Math.hypot(dx, dz);
      if (d < 1e-4) {
        tt.seg = nextIdx;
        if (!tt.loop && tt.seg >= route.length - 1) return true;
        continue;
      }
      tt.dirX = dx / d; tt.dirZ = dz / d;
      if (d <= remaining) {
        tt.pos.x = b[0]; tt.pos.z = b[1];
        remaining -= d;
        tt.seg = nextIdx;
        if (!tt.loop && tt.seg >= route.length - 1) return true;
      } else {
        tt.pos.x += tt.dirX * remaining;
        tt.pos.z += tt.dirZ * remaining;
        remaining = 0;
      }
    }
    return false;
  }

  // виляния, крен, подпрыгивания, поворот колёс — и постановка меша
  function place(tt, dt) {
    tt.latTimer -= dt;
    if (tt.latTimer <= 0) {
      // безумный рабочий виляет резко и часто, фоновые — лениво
      tt.latTimer = tt.latAmp > 1 ? 0.35 + Math.random() * 0.5 : 1.2 + Math.random() * 1.6;
      tt.latTarget = tt.baseLat + (Math.random() * 2 - 1) * tt.latAmp;
    }
    const prevLat = tt.lat;
    tt.lat += (tt.latTarget - tt.lat) * Math.min(1, dt * tt.latRate);

    const targetYaw = Math.atan2(tt.dirX, tt.dirZ);
    let dy = targetYaw - tt.yaw;
    while (dy > Math.PI) dy -= Math.PI * 2;
    while (dy < -Math.PI) dy += Math.PI * 2;
    tt.yaw += dy * Math.min(1, dt * 6);

    if (tt.hopY > 0 || tt.hopV !== 0) {
      tt.hopY += tt.hopV * dt;
      tt.hopV -= 22 * dt;
      if (tt.hopY <= 0) { tt.hopY = 0; tt.hopV = 0; }
    }

    const latVel = dt > 0 ? (tt.lat - prevLat) / dt : 0;
    const rollTarget = THREE.MathUtils.clamp(-dy * 0.9 - latVel * 0.06, -0.3, 0.3);
    tt.roll += (rollTarget - tt.roll) * Math.min(1, dt * 7);

    tt.group.position.set(
      tt.pos.x + tt.dirZ * tt.lat,
      tt.hopY,
      tt.pos.z - tt.dirX * tt.lat
    );
    tt.group.rotation.y = tt.yaw;
    tt.group.rotation.z = tt.roll;
    tt.group.rotation.x = tt.hopV > 0 ? -0.05 : 0;

    const spin = (tt.speed * dt) / 0.3;
    for (let i = 0; i < tt.wheels.length; i++) tt.wheels[i].rotation.x += spin;
  }

  // ---------- фоновые тук-туки: кольцо по периметру дорог ----------
  const shirts = [MAT.shirtPink, MAT.shirtBlue, MAT.shirtOrange];
  const bgs = [];
  for (let i = 0; i < 3; i++) {
    const b = makeTuk(shirts[i]);
    b.loop = true;
    b.route = LOOP;
    b.seg = i;
    const a = LOOP[b.seg];
    const c = LOOP[(b.seg + 1) % LOOP.length];
    b.pos.x = (a[0] + c[0]) / 2;
    b.pos.z = (a[1] + c[1]) / 2;
    const dd = Math.hypot(c[0] - a[0], c[1] - a[1]);
    b.dirX = (c[0] - a[0]) / dd;
    b.dirZ = (c[1] - a[1]) / dd;
    b.yaw = Math.atan2(b.dirX, b.dirZ);
    b.baseSpeed = 6.5 + i * 0.5;
    b.phase = i * 2.1;
    b.baseLat = 1.2;
    b.lat = 1.2; b.latTarget = 1.2;
    b.latAmp = 0.35; b.latRate = 3;
    b.group.position.set(b.pos.x, 0, b.pos.z);
    b.group.rotation.y = b.yaw;
    bgs.push(b);
  }

  // ---------- рабочий тук-тук ----------
  const work = makeTuk(MAT.shirtOrange);

  function parkAtStand() {
    work.state = 'idle';
    work.route = null;
    work.dest = null;
    work.pos.x = STAND.x; work.pos.z = STAND.z;
    work.lat = 0; work.latTarget = 0;
    work.roll = 0; work.hopY = 0; work.hopV = 0;
    work.yaw = -Math.PI / 2; // мордой к дороге (на запад)
    work.dirX = -1; work.dirZ = 0;
    work.group.position.set(STAND.x, 0, STAND.z);
    work.group.rotation.set(0, work.yaw, 0);
  }
  parkAtStand();

  // ---------- панель выбора маршрута ----------
  let panel = null;
  let panelKeyHandler = null;

  function closePanel(goWalk) {
    if (!panel) return;
    panel.remove();
    panel = null;
    if (panelKeyHandler) {
      window.removeEventListener('keydown', panelKeyHandler);
      panelKeyHandler = null;
    }
    if (goWalk && state.mode === 'tuktuk') setMode('walk');
  }

  function openPanel() {
    if (panel) return;
    const root = document.getElementById('panels');
    if (!root) return;
    setMode('tuktuk');
    try { if (document.exitPointerLock) document.exitPointerLock(); } catch {}

    panel = document.createElement('div');
    panel.className = 'panel';
    let rows = '';
    for (const key of Object.keys(DESTS)) {
      const d = DESTS[key];
      const can = state.money >= d.price;
      rows += `<div class="row"><span>${d.label}</span>` +
        `<button class="btn primary" data-dest="${key}"${can ? '' : ' disabled'}>₹${d.price}</button></div>`;
    }
    panel.innerHTML =
      `<h2>🛺 Куда едем, саар?</h2>` +
      `<p class="desc">Самый быстрый тук-тук на весь базар! Ремней нет — держитесь за удачу. У вас ₹${state.money}.</p>` +
      rows +
      `<div class="row"><span class="desc">Передумали? Ничего страшного, саар.</span>` +
      `<button class="btn" data-walk="1">Пешком</button></div>`;
    panel.addEventListener('click', (e) => {
      const b = e.target && e.target.closest ? e.target.closest('button') : null;
      if (!b || b.disabled) return;
      audio.click();
      if (b.dataset.walk) { closePanel(true); return; }
      if (b.dataset.dest) startRide(b.dataset.dest);
    });
    root.appendChild(panel);

    panelKeyHandler = (e) => {
      if (e.repeat) return;
      if (e.code === 'Escape' || e.code === 'KeyE') {
        e.preventDefault();
        closePanel(true);
      }
    };
    window.addEventListener('keydown', panelKeyHandler);
    audio.click();
  }

  // ---------- поездка ----------
  function startRide(key) {
    const d = DESTS[key];
    if (!d || state.money < d.price || work.state !== 'idle') return;
    closePanel(false); // режим остаётся 'tuktuk'
    addMoney(-d.price);
    setMode('tuktuk'); // no-op, если уже — для буквального следования контракту
    if (player && player.setVisible) player.setVisible(false);
    bus.emit('rideStart', { dest: key });
    audio.music(true);
    audio.honk(1);

    work.state = 'riding';
    work.dest = key;
    work.route = [[STAND.x, STAND.z]];
    for (let i = 0; i < d.route.length; i++) work.route.push([d.route[i][0], d.route[i][1]]);
    work.seg = 0;
    work.pos.x = STAND.x; work.pos.z = STAND.z;
    work.lat = 0; work.latTarget = 0;
    work.baseLat = 0; work.latAmp = 1.5; work.latRate = 9;
    work.honkT = 0.6; work.sayT = 1.1; work.hopTimer = 1.4;

    _v1.set(0, 1.9, 0.4).applyQuaternion(work.group.quaternion).add(work.group.position);
    bus.emit('floating', {
      pos: { x: _v1.x, y: _v1.y, z: _v1.z },
      text: 'Поехали, саар!', color: '#ffe66d',
    });
  }

  function buildReturnRoute(key) {
    const d = DESTS[key];
    const r = [];
    if (d) for (let i = d.route.length - 1; i >= 0; i--) r.push([d.route[i][0], d.route[i][1]]);
    r.push([STAND.x, STAND.z]);
    return r;
  }

  function arrive() {
    const key = work.dest || 'square';
    const d = DESTS[key] || DESTS.square;
    audio.music(false);
    audio.honk(0.9);
    if (player && player.teleport) {
      const yaw = Math.atan2(d.face.x - d.drop.x, d.face.z - d.drop.z);
      player.teleport({ x: d.drop.x, y: 0, z: d.drop.z }, yaw);
    }
    if (player && player.setVisible) player.setVisible(true);
    setMode('walk');
    state.stats.rides++;
    bus.emit('rideEnd', { dest: key });
    bus.emit('toast', { text: '🛺 Приехали, саар! Ваш отзыв — пять звёзд?', ms: 3200 });

    // водитель, довольный, уезжает обратно на стоянку
    work.state = 'returning';
    work.dest = null;
    work.route = buildReturnRoute(key);
    work.seg = 0;
    work.baseLat = 0; work.latAmp = 0.5; work.latRate = 4;
  }

  // режим сменили извне (сейв-лоад, меню…) — корректно прервать поездку
  function abortRide() {
    audio.music(false);
    if (player) {
      if (player.teleport) {
        player.teleport({
          x: work.group.position.x + 2, y: 0, z: work.group.position.z + 2,
        });
      }
      if (player.setVisible) player.setVisible(true);
    }
    parkAtStand();
  }

  function placeRideCamera() {
    if (!cameraRef) return;
    // чейз-камера: позади и выше тук-тука, видно дорогу и виляние + тряска
    _v1.set(0, 2.7, -3.8).applyQuaternion(work.group.quaternion).add(work.group.position);
    _v1.x += (Math.random() - 0.5) * 0.1;
    _v1.y += (Math.random() - 0.5) * 0.1;
    _v1.z += (Math.random() - 0.5) * 0.1;
    cameraRef.position.copy(_v1);
    _v2.set(0, 1.0, 7).applyQuaternion(work.group.quaternion).add(work.group.position);
    cameraRef.lookAt(_v2);
  }

  // ---------- update ----------
  let tGlobal = 0;
  let warned = false;

  function realUpdate(dt) {
    tGlobal += dt;
    const pp = player && player.getPosition ? player.getPosition() : null;

    // фоновые
    for (let i = 0; i < bgs.length; i++) {
      const b = bgs[i];
      b.speed = b.baseSpeed + Math.sin(tGlobal * 1.7 + b.phase) * 0.8;
      advance(b, dt);
      b.hopTimer -= dt;
      if (b.hopTimer <= 0 && b.hopY === 0) {
        b.hopTimer = 3 + Math.random() * 4;
        b.hopV = 1.6;
      }
      place(b, dt);
      b.honkT -= dt;
      if (b.honkT <= 0) {
        b.honkT = 1 + Math.random(); // сигналит каждые 1–2 с
        if (pp) {
          const dx = b.group.position.x - pp.x;
          const dz = b.group.position.z - pp.z;
          const d = Math.hypot(dx, dz);
          if (d < 35) audio.honk((1 - d / 35) * 0.85);
        }
      }
    }

    // если панель открыта, а режим сменили извне — закрыть без последствий
    if (panel && state.mode !== 'tuktuk') closePanel(false);

    if (work.state === 'idle') {
      if (pp && state.mode === 'walk') {
        const dx = work.group.position.x - pp.x;
        const dz = work.group.position.z - pp.z;
        if (dx * dx + dz * dz < 3.5 * 3.5) {
          bus.emit('prompt', { text: 'E — тук-тук' });
        }
      }
    } else if (work.state === 'riding') {
      if (state.mode !== 'tuktuk') { abortRide(); return; }
      // БЕЗУМНАЯ езда: рывки скорости, виляния, кочки
      work.speed = 9 + Math.sin(tGlobal * 3.4) * 4;
      const done = advance(work, dt);
      work.hopTimer -= dt;
      if (work.hopTimer <= 0 && work.hopY === 0) {
        work.hopTimer = 1.2 + Math.random() * 2.4;
        work.hopV = 2.3;
      }
      place(work, dt);
      work.honkT -= dt;
      if (work.honkT <= 0) {
        work.honkT = 0.8 + Math.random() * 0.5; // сигналит каждую секунду, громко
        audio.honk(1);
      }
      work.sayT -= dt;
      if (work.sayT <= 0) {
        work.sayT = 2.2 + Math.random() * 0.9;
        _v1.set(0, 1.9, 0.4).applyQuaternion(work.group.quaternion).add(work.group.position);
        bus.emit('floating', {
          pos: { x: _v1.x, y: _v1.y, z: _v1.z },
          text: PHRASES[(Math.random() * PHRASES.length) | 0],
          color: '#ffe66d',
        });
      }
      placeRideCamera();
      if (done) arrive();
    } else if (work.state === 'returning') {
      work.speed = 7.5 + Math.sin(tGlobal * 2.6) * 1.5;
      const done = advance(work, dt);
      place(work, dt);
      work.honkT -= dt;
      if (work.honkT <= 0) {
        work.honkT = 1.2 + Math.random();
        if (pp) {
          const dx = work.group.position.x - pp.x;
          const dz = work.group.position.z - pp.z;
          const d = Math.hypot(dx, dz);
          if (d < 35) audio.honk((1 - d / 35) * 0.8);
        }
      }
      if (done) parkAtStand();
    }
  }

  function update(dt) {
    try {
      realUpdate(dt);
    } catch (e) {
      if (!warned) { warned = true; console.warn('tuktuk update error', e); }
    }
  }

  function tryInteract() {
    if (state.mode !== 'walk' || work.state !== 'idle') return false;
    if (!player || !player.getPosition) return false;
    const pp = player.getPosition();
    const dx = work.group.position.x - pp.x;
    const dz = work.group.position.z - pp.z;
    if (dx * dx + dz * dz > 3.5 * 3.5) return false;
    openPanel();
    return true;
  }

  return { update, tryInteract };
}
