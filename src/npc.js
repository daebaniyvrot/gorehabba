// npc.js — жители фестиваля Гарехабба: бродят по улицам, кидаются лепёшками,
// уворачиваются, пачкаются и добродушно смеются. Тон — тёплый, «саар»-колорит.
import * as THREE from 'three';
import { state, bus } from './state.js';
import { audio } from './audio.js';

// ---------- Общие ресурсы (геометрии/материалы переиспользуются) ----------
const GEO = {
  torso: new THREE.CylinderGeometry(0.19, 0.27, 0.62, 6),
  head: new THREE.SphereGeometry(0.155, 6, 5),
  arm: new THREE.BoxGeometry(0.1, 0.48, 0.1),
  leg: new THREE.BoxGeometry(0.15, 0.6, 0.15),
  turban: new THREE.SphereGeometry(0.175, 6, 4),
  topi: new THREE.ConeGeometry(0.13, 0.2, 6),
  stain: new THREE.SphereGeometry(0.055, 5, 4),
};
GEO.arm.translate(0, -0.19, 0); // пивот у плеча
GEO.leg.translate(0, -0.3, 0);  // пивот у бедра

const CLOTH_COLORS = [0xff6b9d, 0x4ecdc4, 0xffe66d, 0xff9f43, 0x54a0ff,
  0x9b59b6, 0xe74c3c, 0x2ecc71, 0xf368e0, 0x1abc9c, 0xe67e22];
const SKIN_MATS = [0x8d5524, 0xa0673d, 0x6f451f, 0xc68642]
  .map((c) => new THREE.MeshLambertMaterial({ color: c, flatShading: true }));
const PANTS_MATS = [0xfff2dc, 0xe8d9b8, 0xd9c9a6, 0x8a6a4f]
  .map((c) => new THREE.MeshLambertMaterial({ color: c, flatShading: true }));
const HAT_MATS = [0xffe66d, 0xff9f43, 0xff6b9d, 0x54a0ff, 0xffffff, 0xe74c3c]
  .map((c) => new THREE.MeshLambertMaterial({ color: c, flatShading: true }));
const STAIN_MAT = new THREE.MeshLambertMaterial({ color: 0x4a2f14 });
const DIRT_COLOR = new THREE.Color(0x4a2f14);

// ---------- Реплики (дружелюбно, без злобы) ----------
const HIT_PHRASES = ['Вах!', 'Ай-яй!', 'Ох!', 'Вах-вах!', 'Эй, саар!'];
const HIT_BY_PLAYER = ['Вах! Метко, саар!', 'Эй, саар!', 'Ай-яй, саар!', 'Вах!', 'С праздником, саар!'];
const LAUGHS = ['Ха-ха!', 'Ха-ха-ха!'];
const SHOUT_REPLIES = ['Саар!', 'Халло саар!', 'С праздником, саар!'];
const THROW_LINES = ['Лови, саар!', 'С праздником!', 'Хей, саар!'];

function pick(arr) { return arr[(Math.random() * arr.length) | 0]; }
function sfx(name) {
  try { if (audio && typeof audio[name] === 'function') audio[name](); } catch (e) { /* тихо */ }
}

// ---------- Временные векторы (никаких аллокаций в горячем цикле) ----------
const _step = new THREE.Vector3();
const _probe = new THREE.Vector3();
const _perp = new THREE.Vector3();
const _from = new THREE.Vector3();
const _aim = new THREE.Vector3();
const _delta = new THREE.Vector3();
const _vel3 = new THREE.Vector3();
const _pv = new THREE.Vector3();
const _playerPos = new THREE.Vector3();
const _prevPlayer = new THREE.Vector3();
const _playerVel = new THREE.Vector3();

const GRAVITY = 14;      // как в physics.js
const AVG_PROJ_SPEED = 13;
const NPC_COUNT = 22;

// ---------- Модель жителя (переиспользуют tuktuk и stall) ----------
export function makeVillagerMesh() {
  const g = new THREE.Group();
  const clothMat = new THREE.MeshLambertMaterial({
    color: CLOTH_COLORS[(Math.random() * CLOTH_COLORS.length) | 0],
    flatShading: true,
  });
  const skinMat = SKIN_MATS[(Math.random() * SKIN_MATS.length) | 0];
  const pantsMat = PANTS_MATS[(Math.random() * PANTS_MATS.length) | 0];

  const torso = new THREE.Mesh(GEO.torso, clothMat);
  torso.position.y = 0.93;
  const head = new THREE.Mesh(GEO.head, skinMat);
  head.position.y = 1.42;
  const legL = new THREE.Mesh(GEO.leg, pantsMat);
  legL.position.set(0.1, 0.62, 0);
  const legR = new THREE.Mesh(GEO.leg, pantsMat);
  legR.position.set(-0.1, 0.62, 0);
  const armL = new THREE.Mesh(GEO.arm, clothMat);
  armL.position.set(0.3, 1.16, 0);
  const armR = new THREE.Mesh(GEO.arm, clothMat);
  armR.position.set(-0.3, 1.16, 0);
  g.add(torso, head, legL, legR, armL, armR);

  // головной убор у части жителей
  if (Math.random() < 0.6) {
    const hatMat = HAT_MATS[(Math.random() * HAT_MATS.length) | 0];
    let hat;
    if (Math.random() < 0.5) {
      hat = new THREE.Mesh(GEO.turban, hatMat);
      hat.position.y = 1.53;
      hat.scale.set(1.05, 0.6, 1.05);
    } else {
      hat = new THREE.Mesh(GEO.topi, hatMat);
      hat.position.y = 1.62;
    }
    g.add(hat);
  }

  g.scale.setScalar(0.92 + Math.random() * 0.16); // рост ~1.7
  g.traverse((o) => { if (o.isMesh) o.castShadow = true; });

  const ud = g.userData;
  ud.clothMat = clothMat;
  ud.baseColor = clothMat.color.clone();
  ud.torso = torso;
  ud.stainCount = 0;
  ud.armRaise = 0; // 0..1 — замах правой руки
  ud.phase = Math.random() * Math.PI * 2;
  ud.tick = (dt, move) => {
    ud.phase += dt * (1.5 + 8 * move);
    const sw = Math.sin(ud.phase) * 0.55 * Math.min(1, move);
    legL.rotation.x = sw;
    legR.rotation.x = -sw;
    armL.rotation.x = -sw * 0.7;
    armR.rotation.x = ud.armRaise > 0.01 ? 2.6 * ud.armRaise : sw * 0.7;
  };
  return g;
}

// ---------- Грязь на одежде ----------
function applyDirtVisual(rec) {
  const ud = rec.object3d.userData;
  if (ud && ud.clothMat && ud.baseColor) {
    ud.clothMat.color.copy(ud.baseColor)
      .lerp(DIRT_COLOR, Math.min(1, rec.dirty / 100) * 0.65);
  }
}

function addStain(rec) {
  const ud = rec.object3d.userData;
  if (!ud || !ud.torso || ud.stainCount >= 6) return;
  const m = new THREE.Mesh(GEO.stain, STAIN_MAT);
  const a = Math.random() * Math.PI * 2;
  m.position.set(Math.cos(a) * 0.23, (Math.random() - 0.5) * 0.42, Math.sin(a) * 0.23);
  m.scale.set(1, 1.4, 1);
  ud.torso.add(m);
  ud.stainCount++;
}

function faceToward(obj, tx, tz, dt) {
  const dx = tx - obj.position.x;
  const dz = tz - obj.position.z;
  if (dx * dx + dz * dz < 1e-6) return;
  const want = Math.atan2(dx, dz);
  let dA = want - obj.rotation.y;
  dA = Math.atan2(Math.sin(dA), Math.cos(dA));
  obj.rotation.y += dA * Math.min(1, dt * 8);
}

function floatOver(rec, text, color) {
  const p = rec.object3d.position;
  bus.emit('floating', { pos: { x: p.x, y: p.y + 2.0, z: p.z }, text, color });
}

// ---------- Главная фабрика ----------
export function createNPCs(scene, world, projectiles, player) {
  const list = [];       // публично: {object3d, getPosition(), dirty}
  const customers = [];  // покупатели ларька — отдельно, не кидаются
  let tNow = 0;
  let warned = false;
  let playerPosOk = false;
  let havePrev = false;

  const bounds = (world && world.bounds) || { minX: -56, maxX: 56, minZ: -56, maxZ: 56 };
  const CLAMP_X0 = bounds.minX + 1.5, CLAMP_X1 = bounds.maxX - 1.5;
  const CLAMP_Z0 = bounds.minZ + 1.5, CLAMP_Z1 = bounds.maxZ - 1.5;

  function groundY(x, z) {
    try {
      if (world && typeof world.groundY === 'function') return world.groundY(x, z) || 0;
    } catch (e) { /* земля плоская */ }
    return 0;
  }

  function pointBlocked(p) {
    const cols = world && world.colliders;
    if (!cols) return false;
    for (let i = 0; i < cols.length; i++) {
      const b = cols[i];
      if (b && typeof b.containsPoint === 'function' && b.containsPoint(p)) return true;
    }
    return false;
  }

  // случайная точка на дорогах (решётка x/z = -28,0,28) или на площади
  function randomRoadPoint(out) {
    if (Math.random() < 0.35) {
      out.set((Math.random() - 0.5) * 21, 0, (Math.random() - 0.5) * 21); // площадь
      return out;
    }
    const lines = [-28, 0, 28];
    const line = lines[(Math.random() * 3) | 0];
    const along = (Math.random() * 2 - 1) * 50;
    const across = (Math.random() * 2 - 1) * 2.4;
    if (Math.random() < 0.5) out.set(line + across, 0, along);
    else out.set(along, 0, line + across);
    return out;
  }

  function newWanderTarget(n) {
    for (let k = 0; k < 8; k++) {
      randomRoadPoint(_probe);
      _probe.y = 0.6;
      if (!pointBlocked(_probe)) { n.target.set(_probe.x, 0, _probe.z); return; }
    }
    n.target.set((Math.random() - 0.5) * 20, 0, (Math.random() - 0.5) * 20);
  }

  // шаг агента к цели с простым обходом коллайдеров; true — пришли
  function stepToward(a, dt, arriveDist) {
    const pos = a.object3d.position;
    _step.subVectors(a.target, pos);
    _step.y = 0;
    const d = _step.length();
    if (d <= arriveDist) { a.vel.set(0, 0, 0); return true; }
    _step.divideScalar(d);
    _probe.copy(pos).addScaledVector(_step, 0.9);
    _probe.y = 0.6;
    if (pointBlocked(_probe)) {
      if (!a.avoidSign) a.avoidSign = Math.random() < 0.5 ? 1 : -1;
      a.blockedT += dt;
      const ang = a.avoidSign * 1.1;
      const c = Math.cos(ang), s = Math.sin(ang);
      const rx = _step.x * c + _step.z * s;
      const rz = -_step.x * s + _step.z * c;
      _step.set(rx, 0, rz);
      _probe.copy(pos).addScaledVector(_step, 0.9);
      _probe.y = 0.6;
      if (pointBlocked(_probe)) { a.blockedT += 0.4; a.vel.set(0, 0, 0); return false; }
    } else {
      a.blockedT = 0;
      a.avoidSign = 0;
    }
    pos.addScaledVector(_step, a.speed * dt);
    pos.x = THREE.MathUtils.clamp(pos.x, CLAMP_X0, CLAMP_X1);
    pos.z = THREE.MathUtils.clamp(pos.z, CLAMP_Z0, CLAMP_Z1);
    a.vel.copy(_step).multiplyScalar(a.speed);
    faceToward(a.object3d, pos.x + _step.x, pos.z + _step.z, dt);
    return false;
  }

  function updatePlayerVel(dt) {
    playerPosOk = false;
    if (!player || typeof player.getPosition !== 'function') return;
    let p = null;
    try { p = player.getPosition(); } catch (e) { return; }
    if (!p) return;
    _playerPos.copy(p);
    playerPosOk = true;
    if (havePrev && dt > 0.0001) {
      _pv.subVectors(_playerPos, _prevPlayer).divideScalar(dt);
      if (_pv.lengthSq() < 400) _playerVel.lerp(_pv, 0.4); // телепорты не считаем
      else _playerVel.set(0, 0, 0);
    }
    _prevPlayer.copy(_playerPos);
    havePrev = true;
  }

  // ---------- Броски ----------
  function chooseThrowTarget(n) {
    const pos = n.object3d.position;
    const canPlayer = playerPosOk && (state.mode === 'walk' || state.mode === 'photo');
    if (canPlayer) {
      const d2 = pos.distanceToSquared(_playerPos);
      if (d2 < 18 * 18 && d2 > 9 && Math.random() < 0.6) {
        n.aimPlayer = true;
        n.aimNpc = null;
        return true;
      }
    }
    // иначе — случайный сосед-NPC (резервуарная выборка, без аллокаций)
    let found = null, count = 0;
    for (let i = 0; i < list.length; i++) {
      const o = list[i];
      if (o === n) continue;
      const d2 = pos.distanceToSquared(o.object3d.position);
      if (d2 < 400 && d2 > 4) {
        count++;
        if (Math.random() < 1 / count) found = o;
      }
    }
    if (found) { n.aimPlayer = false; n.aimNpc = found; return true; }
    return false;
  }

  function releaseThrow(n) {
    if (!projectiles || typeof projectiles.throwDung !== 'function') return;
    let tp = null, tv = null;
    if (n.aimPlayer) {
      if (!playerPosOk || !(state.mode === 'walk' || state.mode === 'photo')) return;
      tp = _playerPos;
      tv = _playerVel;
    } else if (n.aimNpc && n.aimNpc.object3d.parent) {
      tp = n.aimNpc.object3d.position;
      tv = n.aimNpc.vel;
    }
    if (!tp) return;

    _from.copy(n.object3d.position);
    _from.y += 1.4;
    _aim.set(tp.x, tp.y + 0.9, tp.z);
    const dh0 = Math.hypot(_aim.x - _from.x, _aim.z - _from.z);
    const tf = THREE.MathUtils.clamp(dh0 / AVG_PROJ_SPEED, 0.3, 1.3);
    if (tv) _aim.addScaledVector(tv, tf * 0.9); // упреждение
    _aim.x += (Math.random() - 0.5) * 1.2;      // лёгкий разброс — фестиваль же
    _aim.z += (Math.random() - 0.5) * 1.2;

    _delta.subVectors(_aim, _from);
    const dy = _delta.y;
    _delta.y = 0;
    const dh = _delta.length();
    if (dh < 0.5) return;
    const vy = (dy + 0.5 * GRAVITY * tf * tf) / tf;
    const vh = dh / tf;
    _delta.divideScalar(dh);
    _vel3.set(_delta.x * vh, vy, _delta.z * vh);
    const spd = _vel3.length();
    if (spd < 0.001) return;
    const power = THREE.MathUtils.clamp((spd - 8) / 14, 0.12, 1);
    _vel3.divideScalar(spd);
    try {
      projectiles.throwDung({ from: _from.clone(), dir: _vel3.clone(), power, owner: n.id });
    } catch (e) { /* physics ещё не готов — не страшно */ }
    if (n.aimPlayer && Math.random() < 0.25) floatOver(n, pick(THROW_LINES), '#ffe9c7');
  }

  // ---------- Попадание по жителю ----------
  function hitVillager(n, info) {
    const owner = info && info.owner;
    n.dirty = Math.min(100, n.dirty + 20);
    applyDirtVisual(n);
    addStain(n);
    n.hopV = 3.2;         // подпрыгнуть/пошатнуться
    n.staggerT = 0.4;
    if (n.state === 'windup') {
      n.object3d.userData.armRaise = 0;
      n.state = 'wander';
    }
    floatOver(n, owner === 'player' ? pick(HIT_BY_PLAYER) : pick(HIT_PHRASES), '#ffe9c7');
    if (owner === 'player') state.stats.hits++;
    bus.emit('npcHit', { owner, npc: n });
  }

  function registerVillager(n) {
    if (!projectiles || typeof projectiles.registerTarget !== 'function') return;
    try {
      projectiles.registerTarget({
        id: n.id,
        getPosition: n.getPosition,
        radius: 0.35,
        height: 1.7,
        onHit: (info) => hitVillager(n, info),
      });
    } catch (e) { console.warn('[npc] registerTarget', e); }
  }

  // ---------- Создание жителей ----------
  for (let i = 0; i < NPC_COUNT; i++) {
    const g = makeVillagerMesh();
    // спавн на улицах/площади, не внутри зданий
    for (let k = 0; k < 10; k++) {
      randomRoadPoint(_probe);
      _probe.y = 0.6;
      if (!pointBlocked(_probe)) break;
    }
    g.position.set(_probe.x, 0, _probe.z);
    g.rotation.y = Math.random() * Math.PI * 2;
    scene.add(g);

    const n = {
      id: 'npc:' + i,
      object3d: g,
      getPosition: () => g.position,
      dirty: 0,
      // внутреннее
      vel: new THREE.Vector3(),
      target: new THREE.Vector3(g.position.x, 0, g.position.z),
      speed: 1.2 + Math.random() * 0.8,
      state: 'wander',
      throwTimer: 2.5 + Math.random() * 3.5,
      threatTimer: Math.random() * 0.15,
      dodgeT: 0,
      dodgeDelay: 0,
      dodgeDist: 2.5,
      dodgeDir: new THREE.Vector3(),
      dodgeCd: 0,
      windupT: 0,
      aimPlayer: false,
      aimNpc: null,
      laughT: 0,
      laughPhase: 0,
      hopY: 0,
      hopV: 0,
      staggerT: 0,
      blockedT: 0,
      avoidSign: 0,
    };
    newWanderTarget(n);
    list.push(n);
    registerVillager(n);
  }

  // ---------- Реакции на шину ----------
  bus.on('playerHit', () => {
    if (state.mode === 'menu' || !playerPosOk) return;
    let any = false, texts = 0;
    for (let i = 0; i < list.length; i++) {
      const n = list[i];
      if (n.object3d.position.distanceToSquared(_playerPos) > 144) continue; // 12 м
      if (n.state === 'windup') n.object3d.userData.armRaise = 0;
      n.state = 'laugh';
      n.laughT = 1 + Math.random();
      n.laughPhase = Math.random() * Math.PI;
      any = true;
      if (texts < 2 && Math.random() < 0.8) {
        texts++;
        floatOver(n, pick(LAUGHS), '#ffe66d');
      }
    }
    if (any) sfx('laugh'); // один раз на событие, не хором
  });

  bus.on('playerShout', (d) => {
    const px = d && d.pos ? d.pos.x : (playerPosOk ? _playerPos.x : null);
    const pz = d && d.pos ? d.pos.z : (playerPosOk ? _playerPos.z : null);
    if (px === null || pz === null || px === undefined) return;
    let replies = 0;
    for (let i = 0; i < list.length; i++) {
      if (replies >= 3) break;
      const n = list[i];
      const dx = n.object3d.position.x - px;
      const dz = n.object3d.position.z - pz;
      if (dx * dx + dz * dz > 100) continue; // 10 м
      if (Math.random() > 0.45) continue;
      replies++;
      setTimeout(() => {
        if (!n.object3d.parent) return;
        floatOver(n, pick(SHOUT_REPLIES), '#ffd27a');
      }, 150 + Math.random() * 500);
    }
  });

  // ---------- Обновление жителя ----------
  function updateVillager(n, dt) {
    const ud = n.object3d.userData;

    // вертикальный подскок (после попадания / смех)
    if (n.hopV !== 0 || n.hopY > 0) {
      n.hopY += n.hopV * dt;
      n.hopV -= 20 * dt;
      if (n.hopY <= 0) { n.hopY = 0; n.hopV = 0; }
    }
    // пошатывание
    if (n.staggerT > 0) {
      n.staggerT -= dt;
      n.object3d.rotation.z = Math.sin(tNow * 24) * 0.12 * Math.max(0, n.staggerT / 0.4);
      if (n.staggerT <= 0) n.object3d.rotation.z = 0;
    }
    if (n.dodgeCd > 0) n.dodgeCd -= dt;

    // проверка угроз каждые ~0.15 c
    n.threatTimer -= dt;
    if (n.threatTimer <= 0) {
      n.threatTimer = 0.15;
      if (n.dodgeCd <= 0 && n.state !== 'dodge'
          && projectiles && typeof projectiles.threats === 'function') {
        let th = null;
        try { th = projectiles.threats(n.object3d.position, 0.8); } catch (e) { th = null; }
        if (th && th.length) {
          let best = null;
          for (let i = 0; i < th.length; i++) {
            const t = th[i];
            if (t && t.vel && t.timeToImpact < 0.8
                && (!best || t.timeToImpact < best.timeToImpact)) best = t;
          }
          // не каждый успевает среагировать: фестиваль, все заняты
          if (best && Math.random() < 0.45) {
            _perp.set(-best.vel.z, 0, best.vel.x); // вбок перпендикулярно угрозе
            if (_perp.lengthSq() < 1e-4) _perp.set(1, 0, 0);
            _perp.normalize();
            if (Math.random() < 0.5) _perp.multiplyScalar(-1);
            n.dodgeDir.copy(_perp);
            n.dodgeDelay = 0.15 + Math.random() * 0.25; // время реакции
            n.dodgeT = 0.3;
            n.dodgeDist = 1.1 + Math.random() * 0.9; // 1.1–2 м
            n.state = 'dodge';
            n.dodgeCd = 2.0;
            n.windupT = 0;
            ud.armRaise = 0;
          }
        }
      }
    }

    let laughBounce = 0;

    if (n.state === 'dodge') {
      if (n.dodgeDelay > 0) { // реакция не мгновенная
        n.dodgeDelay -= dt;
        n.vel.set(0, 0, 0);
        ud.tick(dt, 0.5);
        // Y всё равно обновляем — вдруг NPC в подскоке после попадания
        n.object3d.position.y = groundY(n.object3d.position.x, n.object3d.position.z) + n.hopY;
        return;
      }
      n.dodgeT -= dt;
      const spd = n.dodgeDist / 0.3;
      const pos = n.object3d.position;
      // рывок не должен туннелировать сквозь стены
      _probe.copy(pos).addScaledVector(n.dodgeDir, spd * dt + 0.4);
      _probe.y = 0.6;
      if (pointBlocked(_probe)) {
        n.dodgeT = 0;
        n.state = 'wander';
        newWanderTarget(n);
      } else {
        pos.addScaledVector(n.dodgeDir, spd * dt);
        pos.x = THREE.MathUtils.clamp(pos.x, CLAMP_X0, CLAMP_X1);
        pos.z = THREE.MathUtils.clamp(pos.z, CLAMP_Z0, CLAMP_Z1);
        n.vel.copy(n.dodgeDir).multiplyScalar(spd);
        ud.tick(dt, 2);
        if (n.dodgeT <= 0) { n.state = 'wander'; newWanderTarget(n); }
      }
    } else if (n.state === 'laugh') {
      n.laughT -= dt;
      n.laughPhase += dt * 11;
      laughBounce = Math.abs(Math.sin(n.laughPhase)) * 0.22;
      if (playerPosOk) faceToward(n.object3d, _playerPos.x, _playerPos.z, dt * 1.5);
      n.vel.set(0, 0, 0);
      ud.tick(dt, 0.3);
      if (n.laughT <= 0) n.state = 'wander';
    } else if (n.state === 'windup') {
      n.windupT -= dt;
      ud.armRaise = THREE.MathUtils.clamp(1 - n.windupT / 0.35, 0, 1);
      const tp = n.aimPlayer
        ? (playerPosOk ? _playerPos : null)
        : (n.aimNpc ? n.aimNpc.object3d.position : null);
      if (tp) faceToward(n.object3d, tp.x, tp.z, dt * 2);
      n.vel.set(0, 0, 0);
      ud.tick(dt, 0);
      if (n.windupT <= 0) {
        releaseThrow(n);
        ud.armRaise = 0;
        n.state = 'wander';
      }
    } else { // wander
      if (ud.armRaise > 0) ud.armRaise = Math.max(0, ud.armRaise - dt * 5);
      const arrived = stepToward(n, dt, 0.6);
      if (arrived || n.blockedT > 1.4) { newWanderTarget(n); n.blockedT = 0; }
      ud.tick(dt, n.vel.lengthSq() > 0.01 ? 1 : 0);
      // фестивальный бросок каждые 2.5–6 c
      n.throwTimer -= dt;
      if (n.throwTimer <= 0) {
        n.throwTimer = 2.5 + Math.random() * 3.5;
        if (chooseThrowTarget(n)) {
          n.state = 'windup';
          n.windupT = 0.35;
        }
      }
    }

    const pos = n.object3d.position;
    pos.y = groundY(pos.x, pos.z) + n.hopY + laughBounce;
  }

  // ---------- Покупатели ларька ----------
  function removeCustomer(c) {
    if (c.dead) return;
    c.dead = true;
    const idx = customers.indexOf(c);
    if (idx >= 0) customers.splice(idx, 1);
    if (c.object3d.parent) c.object3d.parent.remove(c.object3d);
    const m = c.object3d.userData && c.object3d.userData.clothMat;
    if (m && typeof m.dispose === 'function') m.dispose();
  }

  function updateCustomer(c, dt) {
    if (c.dead) return;
    const ud = c.object3d.userData;
    if (c.target) {
      const arrived = stepToward(c, dt, 0.55);
      ud.tick(dt, arrived ? 0 : 1);
      if (arrived || c.blockedT > 2.5) {
        c.target = null;
        c.blockedT = 0;
        if (c.leaving) { removeCustomer(c); return; }
        const cb = c.cb;
        c.cb = null;
        if (cb) {
          try { cb(); } catch (e) { console.warn('[npc] customer cb', e); }
        }
      }
    } else {
      ud.tick(dt, 0);
    }
    const pos = c.object3d.position;
    pos.y = groundY(pos.x, pos.z);
  }

  function spawnCustomer(pos) {
    const p = pos || { x: 0, z: 0 };
    const g = makeVillagerMesh();
    g.position.set(p.x || 0, 0, p.z || 0);
    g.rotation.y = Math.random() * Math.PI * 2;
    scene.add(g);
    const c = {
      object3d: g,
      target: null,
      cb: null,
      leaving: false,
      dead: false,
      speed: 1.5 + Math.random() * 0.4,
      vel: new THREE.Vector3(),
      blockedT: 0,
      avoidSign: 0,
    };
    customers.push(c);
    return {
      object3d: g,
      getPosition: () => g.position,
      walkTo(target, cb) {
        if (c.dead || !target) return;
        c.leaving = false;
        c.cb = typeof cb === 'function' ? cb : null;
        c.target = new THREE.Vector3(target.x || 0, 0, target.z || 0);
        c.blockedT = 0;
      },
      leave() {
        if (c.dead) return;
        c.cb = null;
        c.leaving = true;
        // к ближайшему краю площадки — и там исчезнуть
        const gp = g.position;
        const dx = 53 - Math.abs(gp.x);
        const dz = 53 - Math.abs(gp.z);
        if (dx < dz) c.target = new THREE.Vector3(53 * (Math.sign(gp.x) || 1), 0, gp.z);
        else c.target = new THREE.Vector3(gp.x, 0, 53 * (Math.sign(gp.z) || 1));
        c.blockedT = 0;
      },
      remove() { removeCustomer(c); },
    };
  }

  // ---------- Главный update ----------
  function update(dt) {
    if (!(dt > 0)) return;
    try {
      tNow += dt;
      updatePlayerVel(dt);
      for (let i = 0; i < list.length; i++) updateVillager(list[i], dt);
      for (let i = customers.length - 1; i >= 0; i--) updateCustomer(customers[i], dt);
    } catch (e) {
      if (!warned) { warned = true; console.warn('[npc] update error', e); }
    }
  }

  return { list, update, spawnCustomer, makeVillagerMesh };
}
