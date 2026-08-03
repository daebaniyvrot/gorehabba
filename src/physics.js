// Гарехабба — честная баллистика лепёшек: полёт (полуявный Эйлер), один отскок,
// шлепки-декали, бурые частицы и прогноз угроз для уворотов NPC.
import * as THREE from 'three';
import { state, bus } from './state.js';
import { audio } from './audio.js';

// ---------- Константы ----------
const G = 14;                 // гравитация, м/с²
const RESTITUTION = 0.3;      // упругость отскока от земли
const PROJ_POOL = 40;         // пул снарядов
const DECAL_POOL = 80;        // пул шлепков-декалей
const PART_MAX = 128;         // пул частиц
const PROJ_R = 0.13;          // радиус снаряда для контактов
const ARM_TIME = 0.05;        // короткая «мёртвая зона» после броска (свой владелец неуязвим всегда)
const MAX_AGE = 12;           // максимальная жизнь снаряда, с
const DECAL_LIFE = 20;        // жизнь шлепка, с
const DECAL_FADE = 4;         // последние секунды — растворение
const THREAT_R = 1.25;        // радиус «опасно» по XZ для threats()
const SUBSTEP_LEN = 0.35;     // максимальный путь за подшаг, м

// ---------- Временные объекты уровня модуля (никаких аллокаций в кадре) ----------
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _q1 = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _Z = new THREE.Vector3(0, 0, 1);
const _simP = new THREE.Vector3();
const _simV = new THREE.Vector3();
const EMPTY_THREATS = Object.freeze([]);
const EMPTY_ARR = [];

// Безопасный вызов звука: аудио никогда не должно ломать физику.
function sfx(name) {
  try {
    if (audio && typeof audio[name] === 'function') audio[name]();
  } catch (e) { /* тихо, саар */ }
}

export function createProjectiles(scene, world) {
  const group = new THREE.Group();
  group.name = 'projectiles';
  scene.add(group);

  const groundYFn = (world && typeof world.groundY === 'function') ? world.groundY : null;
  const b = (world && world.bounds) || { minX: -56, maxX: 56, minZ: -56, maxZ: 56 };
  const killMinX = (b.minX ?? -56) - 12;
  const killMaxX = (b.maxX ?? 56) + 12;
  const killMinZ = (b.minZ ?? -56) - 12;
  const killMaxZ = (b.maxZ ?? 56) + 12;

  // ---------- Снаряды: сплюснутые икосаэдры тёмно-бурого ----------
  const projGeo = new THREE.IcosahedronGeometry(0.17, 0);
  projGeo.scale(1, 0.62, 1);
  const projMat = new THREE.MeshLambertMaterial({ color: 0x4d321a, flatShading: true });

  const projPool = [];
  for (let i = 0; i < PROJ_POOL; i++) {
    const mesh = new THREE.Mesh(projGeo, projMat);
    mesh.castShadow = true;
    mesh.visible = false;
    group.add(mesh);
    projPool.push({
      mesh,
      vel: new THREE.Vector3(),
      spin: new THREE.Vector3(),
      owner: '',
      age: 0,
      bounced: false,
      active: false,
    });
  }

  function obtainProjectile() {
    let oldest = null;
    for (let i = 0; i < PROJ_POOL; i++) {
      const p = projPool[i];
      if (!p.active) return p;
      if (!oldest || p.age > oldest.age) oldest = p;
    }
    return oldest; // пул полон — тихо переиспользуем самый старый
  }

  function deactivate(p) {
    p.active = false;
    p.mesh.visible = false;
  }

  // ---------- Шлепки-декали: неровные тёмные кляксы ----------
  const decalGeos = [];
  for (let g = 0; g < 3; g++) {
    const geo = new THREE.CircleGeometry(0.5, 11);
    const posA = geo.attributes.position;
    for (let i = 1; i < posA.count; i++) {
      const k = 0.68 + Math.random() * 0.55;
      posA.setXY(i, posA.getX(i) * k, posA.getY(i) * k);
    }
    // замкнуть кольцо (последняя вершина совпадает с первой)
    posA.setXY(posA.count - 1, posA.getX(1), posA.getY(1));
    decalGeos.push(geo);
  }

  const decalPool = [];
  for (let i = 0; i < DECAL_POOL; i++) {
    const mat = new THREE.MeshBasicMaterial({
      color: 0x3a2413,
      transparent: true,
      opacity: 0.8,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    const mesh = new THREE.Mesh(decalGeos[i % decalGeos.length], mat);
    mesh.visible = false;
    group.add(mesh);
    decalPool.push({ mesh, mat, age: 0, baseOpacity: 0.8, active: false });
  }

  function obtainDecal() {
    let oldest = null;
    for (let i = 0; i < DECAL_POOL; i++) {
      const d = decalPool[i];
      if (!d.active) return d;
      if (!oldest || d.age > oldest.age) oldest = d;
    }
    return oldest;
  }

  function spawnDecal(x, y, z, nx, ny, nz) {
    const d = obtainDecal();
    if (!d) return;
    d.active = true;
    d.age = 0;
    d.baseOpacity = 0.72 + Math.random() * 0.18;
    d.mat.opacity = d.baseOpacity;
    d.mat.color.setHSL(0.075 + Math.random() * 0.02, 0.42, 0.08 + Math.random() * 0.05);
    const e = 0.02 + Math.random() * 0.015; // разный отступ против z-файтинга
    d.mesh.position.set(x + nx * e, y + ny * e, z + nz * e);
    _v1.set(nx, ny, nz).normalize();
    _q1.setFromUnitVectors(_Z, _v1);
    _q2.setFromAxisAngle(_Z, Math.random() * Math.PI * 2);
    d.mesh.quaternion.copy(_q1).multiply(_q2);
    const s = 0.55 + Math.random() * 0.6; // случайный масштаб + лёгкая эллиптичность
    d.mesh.scale.set(s, s * (0.8 + Math.random() * 0.4), 1);
    d.mesh.visible = true;
  }

  function updateDecals(dt) {
    for (let i = 0; i < DECAL_POOL; i++) {
      const d = decalPool[i];
      if (!d.active) continue;
      d.age += dt;
      if (d.age >= DECAL_LIFE) {
        d.active = false;
        d.mesh.visible = false;
      } else if (d.age > DECAL_LIFE - DECAL_FADE) {
        d.mat.opacity = d.baseOpacity * (DECAL_LIFE - d.age) / DECAL_FADE;
      }
    }
  }

  // ---------- Частицы: всплеск 6–10 бурых брызг на каждое лопание ----------
  const pPos = new Float32Array(PART_MAX * 3);
  const pVel = new Float32Array(PART_MAX * 3);
  const pLife = new Float32Array(PART_MAX);
  for (let i = 0; i < PART_MAX; i++) pPos[i * 3 + 1] = -999; // мёртвые — под землёй
  const pGeo = new THREE.BufferGeometry();
  const pAttr = new THREE.BufferAttribute(pPos, 3);
  pAttr.setUsage(THREE.DynamicDrawUsage);
  pGeo.setAttribute('position', pAttr);
  const pMat = new THREE.PointsMaterial({
    color: 0x6b4423,
    size: 0.13,
    sizeAttenuation: true,
    transparent: true,
    opacity: 0.95,
    depthWrite: false,
  });
  const points = new THREE.Points(pGeo, pMat);
  points.frustumCulled = false;
  group.add(points);
  let pCursor = 0;
  let pDirty = false;

  function burst(cx, cy, cz, vx, vz) {
    let n = 6 + ((Math.random() * 5) | 0); // 6..10
    for (; n > 0; n--) {
      for (let tries = 0; tries < PART_MAX; tries++) {
        pCursor = (pCursor + 1) % PART_MAX;
        if (pLife[pCursor] <= 0) break;
      }
      const j = pCursor * 3;
      pPos[j] = cx + (Math.random() - 0.5) * 0.16;
      pPos[j + 1] = cy + Math.random() * 0.12;
      pPos[j + 2] = cz + (Math.random() - 0.5) * 0.16;
      pVel[j] = vx * 0.18 + (Math.random() - 0.5) * 2.6;
      pVel[j + 1] = 1.4 + Math.random() * 2.4;
      pVel[j + 2] = vz * 0.18 + (Math.random() - 0.5) * 2.6;
      pLife[pCursor] = 0.45 + Math.random() * 0.25; // живут ~0.6 с
    }
    pDirty = true;
  }

  function updateParticles(dt) {
    let any = false;
    for (let i = 0; i < PART_MAX; i++) {
      if (pLife[i] <= 0) continue;
      any = true;
      pLife[i] -= dt;
      const j = i * 3;
      if (pLife[i] <= 0) { pPos[j + 1] = -999; continue; }
      pVel[j + 1] -= 12 * dt;
      pPos[j] += pVel[j] * dt;
      pPos[j + 1] += pVel[j + 1] * dt;
      pPos[j + 2] += pVel[j + 2] * dt;
      if (pPos[j + 1] < 0.03) {
        pPos[j + 1] = 0.03;
        pVel[j + 1] = 0;
        pVel[j] *= 0.6;
        pVel[j + 2] *= 0.6;
      }
    }
    if (any || pDirty) {
      pAttr.needsUpdate = true;
      pDirty = false;
    }
  }

  // ---------- Цели ----------
  const targets = [];

  function registerTarget(t) {
    if (!t || typeof t.getPosition !== 'function') return;
    targets.push(t);
  }

  // ---------- Лопание снаряда ----------
  function pop(p, withDecal, x, y, z, nx, ny, nz) {
    const mp = p.mesh.position;
    burst(mp.x, Math.max(mp.y, 0.06), mp.z, p.vel.x, p.vel.z);
    if (withDecal) spawnDecal(x, y, z, nx, ny, nz);
    sfx('splat');
    deactivate(p);
  }

  // ---------- Столкновения ----------
  function hitTargets(p, mp) {
    if (p.age < ARM_TIME) return false; // arm time для всех целей
    for (let i = 0; i < targets.length; i++) {
      const tg = targets[i];
      if (!tg || tg.id === p.owner) continue; // свой владелец неуязвим
      let tp = null;
      try { tp = tg.getPosition(); } catch (e) { continue; }
      if (!tp) continue;
      const rr = (tg.radius || 0.4) + 0.25;
      const dx = mp.x - tp.x;
      const dz = mp.z - tp.z;
      if (dx * dx + dz * dz > rr * rr) continue;
      const h = tg.height || 1.6;
      if (mp.y < tp.y || mp.y > tp.y + h) continue;
      try {
        if (typeof tg.onHit === 'function') {
          tg.onHit({ owner: p.owner, velocity: p.vel.clone(), point: mp.clone() });
        }
      } catch (e) { console.warn('[physics] target.onHit', e); }
      pop(p, false, 0, 0, 0, 0, 1, 0);
      return true;
    }
    return false;
  }

  function hitColliders(p, mp) {
    const cols = (world && world.colliders) || EMPTY_ARR;
    for (let i = 0; i < cols.length; i++) {
      const box = cols[i];
      if (!box || !box.min || !box.max) continue;
      if (mp.x < box.min.x - PROJ_R || mp.x > box.max.x + PROJ_R ||
          mp.y < box.min.y - PROJ_R || mp.y > box.max.y + PROJ_R ||
          mp.z < box.min.z - PROJ_R || mp.z > box.max.z + PROJ_R) continue;
      // нормаль ближайшей грани — по наибольшему нормированному смещению от центра
      box.getCenter(_v1);
      const hx = Math.max((box.max.x - box.min.x) * 0.5, 1e-4);
      const hy = Math.max((box.max.y - box.min.y) * 0.5, 1e-4);
      const hz = Math.max((box.max.z - box.min.z) * 0.5, 1e-4);
      const ox = (mp.x - _v1.x) / hx;
      const oy = (mp.y - _v1.y) / hy;
      const oz = (mp.z - _v1.z) / hz;
      const ax = Math.abs(ox), ay = Math.abs(oy), az = Math.abs(oz);
      let nx = 0, ny = 0, nz = 0;
      if (ax >= ay && ax >= az) nx = ox >= 0 ? 1 : -1;
      else if (ay >= az) ny = oy >= 0 ? 1 : -1;
      else nz = oz >= 0 ? 1 : -1;
      // точка контакта — проекция на бокс, декаль ориентируем по нормали грани
      _v2.copy(mp).clamp(box.min, box.max);
      pop(p, true, _v2.x, _v2.y, _v2.z, nx, ny, nz);
      return true;
    }
    return false;
  }

  function hitGround(p, mp) {
    let gy = 0;
    if (groundYFn) gy = groundYFn(mp.x, mp.z) || 0;
    if (mp.y - PROJ_R > gy) return false;
    if (!p.bounced && p.vel.y < -1.2) {
      // один отскок: restitution 0.3, −50% горизонтальной скорости
      mp.y = gy + PROJ_R;
      p.vel.y = -p.vel.y * RESTITUTION;
      p.vel.x *= 0.5;
      p.vel.z *= 0.5;
      p.spin.multiplyScalar(0.6);
      p.bounced = true;
      sfx('thud');
      return false;
    }
    pop(p, true, mp.x, gy, mp.z, 0, 1, 0); // второй контакт → шлепок
    return true;
  }

  function stepProjectile(p, dt) {
    p.age += dt;
    if (p.age > MAX_AGE) { deactivate(p); return; }
    const mp = p.mesh.position;

    // подшаги против туннелирования на скоростях до 22 м/с
    const travel = p.vel.length() * dt;
    let steps = 1 + Math.floor(travel / SUBSTEP_LEN);
    if (steps > 4) steps = 4;
    const h = dt / steps;

    for (let s = 0; s < steps; s++) {
      // полуявный Эйлер: сначала скорость, потом позиция
      p.vel.y -= G * h;
      mp.x += p.vel.x * h;
      mp.y += p.vel.y * h;
      mp.z += p.vel.z * h;
      if (hitTargets(p, mp)) return;
      if (hitColliders(p, mp)) return;
      if (hitGround(p, mp)) return;
    }

    // лёгкое вращение в полёте
    p.mesh.rotation.x += p.spin.x * dt;
    p.mesh.rotation.y += p.spin.y * dt;
    p.mesh.rotation.z += p.spin.z * dt;

    if (mp.x < killMinX || mp.x > killMaxX || mp.z < killMinZ || mp.z > killMaxZ || mp.y > 90) {
      deactivate(p);
    }
  }

  // ---------- Публичный API ----------
  function throwDung(opts) {
    if (!opts || !opts.from || !opts.dir) return;
    const power = Math.max(0, Math.min(1, typeof opts.power === 'number' ? opts.power : 0.5));
    const p = obtainProjectile();
    if (!p) return;
    p.active = true;
    p.owner = opts.owner || '?';
    p.age = 0;
    p.bounced = false;
    p.mesh.visible = true;
    p.mesh.position.set(opts.from.x, Math.max(opts.from.y, PROJ_R + 0.01), opts.from.z);
    _v1.set(opts.dir.x || 0, opts.dir.y || 0, opts.dir.z || 0);
    if (_v1.lengthSq() < 1e-8) _v1.set(0, 0.3, -1);
    _v1.normalize();
    p.vel.copy(_v1).multiplyScalar(8 + 14 * power); // 8–22 м/с
    p.spin.set((Math.random() - 0.5) * 10, (Math.random() - 0.5) * 10, (Math.random() - 0.5) * 10);
    p.mesh.rotation.set(Math.random() * 6.28, Math.random() * 6.28, Math.random() * 6.28);
    p.mesh.scale.setScalar(0.85 + Math.random() * 0.3);
    bus.emit('throw', { owner: p.owner });
    if (p.owner === 'player' && state.stats) state.stats.thrown++;
  }

  // Прогноз угроз для pos: простая экстраполяция с гравитацией шагом ~0.1 с.
  function threats(pos, horizonSec) {
    if (!pos) return EMPTY_THREATS;
    const horizon = (typeof horizonSec === 'number' && horizonSec > 0) ? horizonSec : 1.2;
    const py = pos.y || 0;
    let out = null;
    for (let i = 0; i < PROJ_POOL; i++) {
      const p = projPool[i];
      if (!p.active) continue;
      const mp = p.mesh.position;
      // летящие прочь не считаем (в т.ч. собственный только что брошенный)
      const dx0 = pos.x - mp.x, dy0 = py - mp.y, dz0 = pos.z - mp.z;
      if (p.vel.x * dx0 + p.vel.y * dy0 + p.vel.z * dz0 <= 0) continue;
      _simP.copy(mp);
      _simV.copy(p.vel);
      for (let t = 0.1; t <= horizon + 1e-6; t += 0.1) {
        _simV.y -= G * 0.1;
        _simP.x += _simV.x * 0.1;
        _simP.y += _simV.y * 0.1;
        _simP.z += _simV.z * 0.1;
        if (_simP.y < 0) break; // упадёт раньше
        const dx = _simP.x - pos.x;
        const dz = _simP.z - pos.z;
        if (dx * dx + dz * dz < THREAT_R * THREAT_R &&
            _simP.y > py - 0.3 && _simP.y < py + 2.2) {
          if (!out) out = [];
          out.push({ pos: mp.clone(), vel: p.vel.clone(), timeToImpact: t });
          break;
        }
      }
    }
    return out || EMPTY_THREATS;
  }

  function update(dt) {
    if (!(dt > 0)) return;
    try {
      for (let i = 0; i < PROJ_POOL; i++) {
        const p = projPool[i];
        if (p.active) stepProjectile(p, dt);
      }
      updateDecals(dt);
      updateParticles(dt);
    } catch (e) {
      console.warn('[physics] update', e);
    }
  }

  return { throwDung, registerTarget, threats, update };
}
