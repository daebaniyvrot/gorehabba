// Юнит-тесты баллистики лепёшек: src/physics.js (createProjectiles).
// Всё детерминированно: шагаем update(1/60) в цикле, без реальных таймеров.
import '../helpers/stubs.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createProjectiles } from '../../src/physics.js';
import { state, bus } from '../../src/state.js';

const DT = 1 / 60;
const EPS = 1e-9;

// Константы из src/physics.js (перепроверены по исходнику):
// G=14, RESTITUTION=0.3, PROJ_POOL=40, PROJ_R=0.13, ARM_TIME=0.05, MAX_AGE=12.
// Скорость броска: 8 + 14*power (м/с). Радиус поражения цели: (radius||0.4)+0.25.
const PROJ_POOL = 40;
const HIT_R = 0.4 + 0.25;

function makeScene() {
  return {
    added: [],
    add(obj) { this.added.push(obj); },
    remove() {},
  };
}

function makeWorld() {
  return {
    colliders: [],
    groundY: () => 0,
    bounds: { minX: -56, maxX: 56, minZ: -56, maxZ: 56 },
  };
}

function makeTarget(id, pos, opts = {}) {
  return {
    id,
    radius: opts.radius, // undefined → физика подставит 0.4
    height: opts.height, // undefined → физика подставит 1.6
    hits: [],
    getPosition() { return pos; },
    onHit(info) { this.hits.push(info); },
  };
}

function simulate(proj, seconds) {
  const frames = Math.round(seconds / DT);
  for (let i = 0; i < frames; i++) proj.update(DT);
}

// update() глотает исключения через console.warn('[physics] ...') —
// перехватываем warn, чтобы убедиться, что внутри ничего не упало.
function withWarnCapture(fn) {
  const warns = [];
  const orig = console.warn;
  console.warn = (...args) => { warns.push(args.map(String).join(' ')); };
  try { fn(); } finally { console.warn = orig; }
  return warns;
}

describe('physics.js — баллистика лепёшек', () => {
  it('бросок эмитит bus "throw" {owner}; owner "player" инкрементит stats.thrown, чужой — нет', () => {
    const proj = createProjectiles(makeScene(), makeWorld());
    const events = [];
    const off = bus.on('throw', (d) => events.push(d));
    const before = state.stats.thrown;
    try {
      proj.throwDung({ from: { x: 0, y: 1, z: 0 }, dir: { x: 0, y: 0, z: -1 }, owner: 'player', power: 0.5 });
      assert.equal(events.length, 1, 'после броска должен прилететь ровно один throw');
      assert.deepEqual(events[0], { owner: 'player' });
      assert.equal(state.stats.thrown, before + 1, 'бросок игрока считается в stats.thrown');

      proj.throwDung({ from: { x: 0, y: 1, z: 0 }, dir: { x: 0, y: 0, z: -1 }, owner: 'npc-7', power: 0.5 });
      assert.equal(events.length, 2);
      assert.deepEqual(events[1], { owner: 'npc-7' });
      assert.equal(state.stats.thrown, before + 1, 'бросок NPC не трогает stats.thrown');
    } finally {
      off();
    }
  });

  it('снаряд по прямой попадает в цель: onHit получает {owner, velocity, point}, снаряд лопается', () => {
    const proj = createProjectiles(makeScene(), makeWorld());
    const target = makeTarget('npc-vasya', { x: 0, y: 0, z: -5 });
    proj.registerTarget(target);
    proj.throwDung({ from: { x: 0, y: 1, z: 0 }, dir: { x: 0, y: 0, z: -1 }, owner: 'thrower-1', power: 1 });

    simulate(proj, 2);
    assert.equal(target.hits.length, 1, 'ровно одно попадание');
    const hit = target.hits[0];
    assert.equal(hit.owner, 'thrower-1');
    assert.ok(hit.velocity && hit.velocity.isVector3, 'velocity — THREE.Vector3');
    assert.ok(hit.point && hit.point.isVector3, 'point — THREE.Vector3');
    assert.ok(hit.velocity.z < -8, 'скорость в момент удара направлена к цели (по -Z)');
    // точка попадания — внутри зоны поражения цели по XZ и по высоте
    const dx = hit.point.x - 0;
    const dz = hit.point.z - (-5);
    assert.ok(Math.hypot(dx, dz) <= HIT_R + EPS, `точка попадания в радиусе ${HIT_R} от цели по XZ`);
    assert.ok(hit.point.y >= -EPS && hit.point.y <= 1.6 + EPS, 'точка попадания в пределах роста цели');

    // снаряд лопнул — второй раз в ту же цель не прилетает
    simulate(proj, 2);
    assert.equal(target.hits.length, 1, 'повторного попадания тем же снарядом быть не должно');
  });

  it('владелец неуязвим для своего снаряда (target.id === owner)', () => {
    const proj = createProjectiles(makeScene(), makeWorld());
    const self = makeTarget('bagwan', { x: 0, y: 0, z: -5 });
    proj.registerTarget(self);
    // бросаем сквозь собственную зону поражения
    proj.throwDung({ from: { x: 0, y: 1, z: 0 }, dir: { x: 0, y: 0, z: -1 }, owner: 'bagwan', power: 1 });
    simulate(proj, 4);
    assert.equal(self.hits.length, 0, 'свой снаряд не должен поражать владельца');
  });

  it('ARM_TIME: цель в упор (< 0.05 c полёта) не поражается, дальняя — поражается', () => {
    const proj = createProjectiles(makeScene(), makeWorld());
    // при power=1 (22 м/с) снаряд за первые два кадра (age < ARM_TIME) проходит
    // сквозь зону ближней цели (radius 0.15 → зона 0.4 м), а к моменту взведения
    // (кадр 3, z ≈ -0.92) уже вылетел из неё; к дальней прилетает «взведённым»
    const near = makeTarget('near', { x: 0, y: 0, z: -0.3 }, { radius: 0.15 });
    const far = makeTarget('far', { x: 0, y: 0, z: -6 });
    proj.registerTarget(near);
    proj.registerTarget(far);
    proj.throwDung({ from: { x: 0, y: 1, z: 0 }, dir: { x: 0, y: 0, z: -1 }, owner: 'thrower', power: 1 });
    simulate(proj, 2);
    assert.equal(near.hits.length, 0, 'цель в упор не должна быть поражена (мёртвая зона)');
    assert.equal(far.hits.length, 1, 'дальняя цель поражается тем же броском');
  });

  it('гравитация тянет вниз: горизонтальный бросок падает, отскакивает и гаснет без попаданий и исключений', () => {
    const proj = createProjectiles(makeScene(), makeWorld());
    // цель стоит на прямой линии броска: без гравитации попадание было бы неизбежно
    const skyTarget = makeTarget('sky', { x: 0, y: 1.5, z: -20 });
    proj.registerTarget(skyTarget);
    proj.throwDung({ from: { x: 0, y: 2, z: 0 }, dir: { x: 0, y: 0, z: -1 }, owner: 'gravman', power: 0.5 });

    // 4 c с запасом: падение ~0.5 c, отскок и второй контакт ~1 c
    const warns = withWarnCapture(() => simulate(proj, 4));
    assert.equal(skyTarget.hits.length, 0, 'снаряд обязан упасть, не долетев по прямой');
    assert.equal(warns.filter((w) => w.includes('[physics]')).length, 0, 'update не ловил исключений');

    // после отскока и второго контакта снаряд деактивирован — угроз нет ни впереди, ни в зоне падения
    assert.equal(proj.threats({ x: 0, y: 0, z: -30 }, 1.2).length, 0);
    assert.equal(proj.threats({ x: 0, y: 0, z: -10 }, 1.2).length, 0);
  });

  it('threats: снаряд, летящий в точку, даёт угрозу с timeToImpact > 0', () => {
    const proj = createProjectiles(makeScene(), makeWorld());
    proj.throwDung({ from: { x: 0, y: 1.2, z: 6 }, dir: { x: 0, y: 0, z: -1 }, owner: 'npc-a', power: 1 });
    const th = proj.threats({ x: 0, y: 0, z: 0 }, 1.2);
    assert.equal(th.length, 1, 'ровно одна угроза для точки на траектории');
    assert.ok(th[0].timeToImpact > 0, 'timeToImpact положительный');
    assert.ok(th[0].timeToImpact <= 1.2 + 1e-6, 'timeToImpact в пределах горизонта');
    assert.ok(th[0].pos && th[0].pos.isVector3, 'у угрозы есть позиция снаряда');
    assert.ok(th[0].vel && th[0].vel.isVector3, 'у угрозы есть скорость снаряда');
  });

  it('threats: снаряд, летящий прочь от точки, угроз не даёт', () => {
    const proj = createProjectiles(makeScene(), makeWorld());
    proj.throwDung({ from: { x: 0, y: 1.2, z: 6 }, dir: { x: 0, y: 0, z: -1 }, owner: 'npc-a', power: 1 });
    const th = proj.threats({ x: 0, y: 0, z: 20 }, 1.2); // точка за спиной снаряда
    assert.equal(th.length, 0);
  });

  it('пул: 60 бросков подряд не роняют физику, живых снарядов не больше 40', () => {
    const scene = makeScene();
    const proj = createProjectiles(scene, makeWorld());
    const events = [];
    const off = bus.on('throw', (d) => events.push(d));
    try {
      for (let i = 0; i < 60; i++) {
        proj.throwDung({
          from: { x: 0, y: 1 + (i % 5) * 0.2, z: 0 },
          dir: { x: Math.sin(i), y: 0.25, z: -Math.cos(i) },
          owner: 'npc-' + i,
          power: (i % 10) / 10,
        });
      }
    } finally {
      off();
    }
    assert.equal(events.length, 60, 'каждый бросок эмитит throw, пул молча переиспользует старые');

    // группа снарядов — первое, что физика добавила в сцену;
    // видимые меши в ней — активные снаряды (декали до апдейтов невидимы)
    const root = scene.added[0];
    assert.ok(root, 'физика добавила свою группу в сцену');
    const alive = root.children.filter((c) => c.isMesh && c.visible).length;
    assert.ok(alive <= PROJ_POOL, `живых снарядов ${alive}, кап ${PROJ_POOL}`);
    assert.equal(alive, PROJ_POOL, 'при 60 бросках заняты все слоты пула');

    // и после этого симуляция не падает
    const warns = withWarnCapture(() => simulate(proj, 1));
    assert.equal(warns.filter((w) => w.includes('[physics]')).length, 0, 'update не ловил исключений');
  });
});
