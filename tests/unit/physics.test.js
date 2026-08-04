// Юнит-тесты баллистики лепёшек: src/physics.js (createProjectiles).
// Всё детерминированно: шагаем update(1/60) в цикле, без реальных таймеров.
import '../helpers/stubs.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
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

function makeWorld(overrides = {}) {
  return {
    colliders: [],
    groundY: () => 0,
    bounds: { minX: -56, maxX: 56, minZ: -56, maxZ: 56 },
    ...overrides,
  };
}

// Меши в группе физики: снаряды отбрасывают тень (castShadow=true),
// декали — нет; Points частиц — не isMesh. Так их и различаем.
function visibleProjectiles(scene) {
  return scene.added[0].children.filter((c) => c.isMesh && c.visible && c.castShadow);
}

function visibleDecals(scene) {
  return scene.added[0].children.filter((c) => c.isMesh && c.visible && !c.castShadow);
}

const V = (x, y, z) => new THREE.Vector3(x, y, z);

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

describe('physics.js — коллайдеры (THREE.Box3)', () => {
  it('шлепок о стену: снаряд лопается с декалью на грани, цель за стеной цела', () => {
    const scene = makeScene();
    const wall = new THREE.Box3(V(-8, 0, -5.5), V(8, 4, -5));
    const proj = createProjectiles(scene, makeWorld({ colliders: [wall] }));
    const behind = makeTarget('behind', { x: 0, y: 0, z: -8 });
    proj.registerTarget(behind);
    proj.throwDung({ from: { x: 0, y: 1, z: 0 }, dir: { x: 0, y: 0, z: -1 }, owner: 't', power: 1 });
    simulate(proj, 1);

    assert.equal(behind.hits.length, 0, 'цель за стеной не поражена');
    assert.equal(visibleProjectiles(scene).length, 0, 'снаряд деактивирован');
    const decals = visibleDecals(scene);
    assert.equal(decals.length, 1, 'ровно одна декаль-шлепок');
    const dp = decals[0].position;
    assert.ok(dp.z > -5.01 && dp.z < -4.9, `декаль на передней грани стены, z=${dp.z}`);
    assert.ok(Math.abs(dp.x) < 1 && dp.y > 0 && dp.y < 1.5, 'декаль в месте удара');
    // лопнувший снаряд больше не угроза
    assert.equal(proj.threats({ x: 0, y: 0, z: -8 }, 1.2).length, 0);
  });

  it('нормаль по ближайшей грани: удар о каждую из шести граней даёт декаль', () => {
    const cases = [
      { name: '+z', box: new THREE.Box3(V(-8, 0, -5.5), V(8, 4, -5)), from: { x: 0, y: 1, z: 0 }, dir: { x: 0, y: 0, z: -1 } },
      { name: '-z', box: new THREE.Box3(V(-8, 0, 5), V(8, 4, 5.5)), from: { x: 0, y: 1, z: 0 }, dir: { x: 0, y: 0, z: 1 } },
      { name: '-x', box: new THREE.Box3(V(2, 0, -1), V(3, 2, 1)), from: { x: 0, y: 1, z: 0 }, dir: { x: 1, y: 0, z: 0 } },
      { name: '+x', box: new THREE.Box3(V(-3, 0, -1), V(-2, 2, 1)), from: { x: 0, y: 1, z: 0 }, dir: { x: -1, y: 0, z: 0 } },
      { name: '+y', box: new THREE.Box3(V(-1, 0, -1), V(1, 1, 1)), from: { x: 0, y: 3, z: 0 }, dir: { x: 0, y: -1, z: 0 } },
      { name: '-y', box: new THREE.Box3(V(-1, 2, -1), V(1, 3, 1)), from: { x: 0, y: 0.5, z: 0 }, dir: { x: 0, y: 1, z: 0 } },
    ];
    for (const c of cases) {
      const scene = makeScene();
      const proj = createProjectiles(scene, makeWorld({ colliders: [c.box] }));
      proj.throwDung({ from: c.from, dir: c.dir, owner: 't', power: 1 });
      simulate(proj, 0.5);
      assert.equal(visibleProjectiles(scene).length, 0, `грань ${c.name}: снаряд лопнул`);
      assert.equal(visibleDecals(scene).length, 1, `грань ${c.name}: ровно одна декаль`);
    }
  });

  it('кривые коллайдеры (null, {}, без max) молча пропускаются', () => {
    const scene = makeScene();
    const junk = [null, {}, { min: { x: -1, y: 0, z: -1 } }];
    const proj = createProjectiles(scene, makeWorld({ colliders: junk }));
    proj.throwDung({ from: { x: 0, y: 1, z: 0 }, dir: { x: 0, y: 0, z: -1 }, owner: 't', power: 0.5 });
    const warns = withWarnCapture(() => simulate(proj, 3));
    assert.equal(warns.filter((w) => w.includes('[physics]')).length, 0, 'мусор в colliders не роняет физику');
    assert.equal(visibleProjectiles(scene).length, 0, 'снаряд пролетел мимо мусора и лопнул о землю');
  });

  it('пул декалей: 85 шлепков подряд переиспользуют самые старые из 80', () => {
    const scene = makeScene();
    const wall = new THREE.Box3(V(-30, 0, -5.5), V(30, 5, -5));
    const proj = createProjectiles(scene, makeWorld({ colliders: [wall] }));
    const throwAt = (x) => proj.throwDung({ from: { x, y: 1, z: 0 }, dir: { x: 0, y: 0, z: -1 }, owner: 't', power: 1 });
    const warns = withWarnCapture(() => {
      for (let i = 0; i < 40; i++) throwAt(i - 20);
      simulate(proj, 1); // все 40 шлёпнулись
      for (let i = 0; i < 40; i++) throwAt(i - 20);
      simulate(proj, 1); // пул декалей ровно полон (80)
      for (let i = 0; i < 5; i++) throwAt(i - 2);
      simulate(proj, 1); // 81-я и далее — переиспользование самых старых
    });
    assert.equal(warns.filter((w) => w.includes('[physics]')).length, 0);
    assert.equal(visibleDecals(scene).length, 80, 'видимых декалей ровно с пул — старые переиспользованы');
    assert.equal(visibleProjectiles(scene).length, 0, 'все снаряды лопнули');
  });

  it('декаль стареет: растворяется в последние секунды и исчезает после DECAL_LIFE', () => {
    const scene = makeScene();
    const wall = new THREE.Box3(V(-8, 0, -5.5), V(8, 4, -5));
    const proj = createProjectiles(scene, makeWorld({ colliders: [wall] }));
    proj.throwDung({ from: { x: 0, y: 1, z: 0 }, dir: { x: 0, y: 0, z: -1 }, owner: 't', power: 1 });
    simulate(proj, 1); // удар на ~0.25 c, декали ~0.75 c
    const decals = visibleDecals(scene);
    assert.equal(decals.length, 1);
    const mesh = decals[0];
    const fullOpacity = mesh.material.opacity;

    simulate(proj, 16.5); // возраст ~17.25 c — фаза растворения (DECAL_LIFE=20, FADE=4)
    assert.equal(mesh.visible, true, 'декаль ещё видна в фазе растворения');
    assert.ok(mesh.material.opacity < fullOpacity,
      `прозрачность падает: ${mesh.material.opacity} < ${fullOpacity}`);

    simulate(proj, 3.5); // возраст ~20.75 c ≥ DECAL_LIFE
    assert.equal(mesh.visible, false, 'декаль исчезла после DECAL_LIFE');
    assert.equal(visibleDecals(scene).length, 0);
  });

  it('исключение внутри шага (коллайдер без getCenter) ловится update-ом с предупреждением', () => {
    const scene = makeScene();
    // проходит guard (есть min/max), но box.getCenter не функция → TypeError внутри try
    const evil = { min: { x: -5, y: -5, z: -5 }, max: { x: 5, y: 5, z: 5 } };
    const proj = createProjectiles(scene, makeWorld({ colliders: [evil] }));
    proj.throwDung({ from: { x: 0, y: 1, z: 0 }, dir: { x: 0, y: 0, z: -1 }, owner: 't', power: 0.5 });
    const warns = withWarnCapture(() => proj.update(DT));
    assert.ok(warns.some((w) => w.includes('[physics] update')), 'исключение поймано и залогировано');
  });
});

describe('physics.js — границы мира и время жизни', () => {
  it('вылет за kill-границы деактивирует снаряд без шлепка', () => {
    const scene = makeScene();
    // земли нет (groundY очень низко), границы узкие → kill на ±13
    const proj = createProjectiles(scene, makeWorld({
      groundY: () => -1000,
      bounds: { minX: -1, maxX: 1, minZ: -1, maxZ: 1 },
    }));
    proj.throwDung({ from: { x: 0, y: 1, z: 0 }, dir: { x: 0, y: 0, z: 1 }, owner: 't', power: 1 });
    simulate(proj, 2); // 22 м/с → за границей через ~0.6 c
    assert.equal(visibleProjectiles(scene).length, 0, 'снаряд погашен за границей мира');
    assert.equal(visibleDecals(scene).length, 0, 'шлепка нет — земли он не коснулся');
  });

  it('MAX_AGE: снаряд в вечном падении гаснет после 12 с', () => {
    const scene = makeScene();
    const proj = createProjectiles(scene, makeWorld({
      groundY: () => -1e9,
      bounds: { minX: -1e6, maxX: 1e6, minZ: -1e6, maxZ: 1e6 },
    }));
    proj.throwDung({ from: { x: 0, y: 1, z: 0 }, dir: { x: 0, y: 0, z: -1 }, owner: 't', power: 0 });
    const warns = withWarnCapture(() => simulate(proj, 12.5));
    assert.equal(warns.filter((w) => w.includes('[physics]')).length, 0);
    assert.equal(visibleProjectiles(scene).length, 0, 'снаряд умер от старости');
  });

  it('мир не передан: дефолтные границы и земля y=0, снаряд отскакивает и шлёпается', () => {
    const scene = makeScene();
    const proj = createProjectiles(scene, undefined);
    proj.throwDung({ from: { x: 0, y: 1, z: 0 }, dir: { x: 0, y: 0.2, z: -1 }, owner: 't', power: 0.5 });
    const warns = withWarnCapture(() => simulate(proj, 4));
    assert.equal(warns.filter((w) => w.includes('[physics]')).length, 0);
    assert.equal(visibleProjectiles(scene).length, 0, 'снаряд отлетал своё');
    assert.equal(visibleDecals(scene).length, 1, 'шлепок о дефолтную землю');
  });

  it('bounds без полей и groundY не-функция: работают дефолты (?? -56 и т.п.)', () => {
    const scene = makeScene();
    const proj = createProjectiles(scene, { bounds: {}, groundY: 42, colliders: [] });
    proj.throwDung({ from: { x: 0, y: 1, z: 0 }, dir: { x: 0, y: 0, z: -1 }, owner: 't', power: 0.5 });
    const warns = withWarnCapture(() => simulate(proj, 4));
    assert.equal(warns.filter((w) => w.includes('[physics]')).length, 0);
    assert.equal(visibleProjectiles(scene).length, 0, 'снаряд лопнул о землю y=0');
  });

  it('низкий горизонтальный бросок у земли: лопается сразу (vel.y ≥ −1.2 — без отскока)', () => {
    const scene = makeScene();
    const proj = createProjectiles(scene, makeWorld());
    proj.throwDung({ from: { x: 0, y: 0.14, z: 0 }, dir: { x: 0, y: 0, z: -1 }, owner: 't', power: 0 });
    simulate(proj, 0.5);
    assert.equal(visibleProjectiles(scene).length, 0, 'снаряд лопнул');
    assert.equal(visibleDecals(scene).length, 1, 'один шлепок о землю');
  });
});

describe('physics.js — guard-ы кривых аргументов', () => {
  it('registerTarget: null и объекты без getPosition молча игнорируются', () => {
    const scene = makeScene();
    const proj = createProjectiles(scene, makeWorld());
    assert.doesNotThrow(() => {
      proj.registerTarget(null);
      proj.registerTarget(undefined);
      proj.registerTarget({ id: 'no-getpos' });
      proj.registerTarget({ id: 'bad', getPosition: 'не функция' });
    });
    proj.throwDung({ from: { x: 0, y: 1, z: 0 }, dir: { x: 0, y: 0, z: -1 }, owner: 't', power: 0.5 });
    const warns = withWarnCapture(() => simulate(proj, 3));
    assert.equal(warns.filter((w) => w.includes('[physics]')).length, 0, 'полёт сквозь мусорные цели не падает');
    assert.equal(visibleProjectiles(scene).length, 0, 'снаряд спокойно долетел до земли');
  });

  it('цель с бросающим getPosition и цель с null-позицией пропускаются, честная — поражается', () => {
    const proj = createProjectiles(makeScene(), makeWorld());
    const evil = { id: 'evil', getPosition() { throw new Error('нет позиции, саар'); }, onHit() { assert.fail('evil не должен ловить'); } };
    const ghost = { id: 'ghost', getPosition: () => null, onHit() { assert.fail('ghost не должен ловить'); } };
    const honest = makeTarget('honest', { x: 0, y: 0, z: -5 });
    proj.registerTarget(evil);
    proj.registerTarget(ghost);
    proj.registerTarget(honest);
    proj.throwDung({ from: { x: 0, y: 1, z: 0 }, dir: { x: 0, y: 0, z: -1 }, owner: 't', power: 1 });
    simulate(proj, 1);
    assert.equal(honest.hits.length, 1, 'честная цель за кривыми — поражена');
  });

  it('цель без onHit просто лопает снаряд (без декали)', () => {
    const scene = makeScene();
    const proj = createProjectiles(scene, makeWorld());
    proj.registerTarget({ id: 'mute', getPosition: () => ({ x: 0, y: 0, z: -5 }) });
    proj.throwDung({ from: { x: 0, y: 1, z: 0 }, dir: { x: 0, y: 0, z: -1 }, owner: 't', power: 1 });
    simulate(proj, 1);
    assert.equal(visibleProjectiles(scene).length, 0, 'снаряд лопнул о цель');
    assert.equal(visibleDecals(scene).length, 0, 'попадание в цель — без декали');
  });

  it('onHit, бросающий исключение, логируется и не роняет физику', () => {
    const scene = makeScene();
    const proj = createProjectiles(scene, makeWorld());
    const angry = { id: 'angry', getPosition: () => ({ x: 0, y: 0, z: -5 }), onHit() { throw new Error('ай, саар'); } };
    proj.registerTarget(angry);
    proj.throwDung({ from: { x: 0, y: 1, z: 0 }, dir: { x: 0, y: 0, z: -1 }, owner: 't', power: 1 });
    const warns = withWarnCapture(() => simulate(proj, 1));
    assert.ok(warns.some((w) => w.includes('target.onHit')), 'исключение цели залогировано');
    assert.equal(visibleProjectiles(scene).length, 0, 'снаряд всё равно лопнул');
  });

  it('снаряд пролетает НАД низкой целью (height) без попадания', () => {
    const proj = createProjectiles(makeScene(), makeWorld());
    const shorty = makeTarget('shorty', { x: 0, y: 0, z: -3 }, { height: 0.4 });
    proj.registerTarget(shorty);
    proj.throwDung({ from: { x: 0, y: 2, z: 0 }, dir: { x: 0, y: 0, z: -1 }, owner: 't', power: 1 });
    simulate(proj, 2);
    assert.equal(shorty.hits.length, 0, 'снаряд выше роста цели — мимо');
  });

  it('throwDung без opts/from/dir — тихий no-op без событий', () => {
    const proj = createProjectiles(makeScene(), makeWorld());
    const events = [];
    const off = bus.on('throw', (d) => events.push(d));
    try {
      assert.doesNotThrow(() => {
        proj.throwDung();
        proj.throwDung(null);
        proj.throwDung({ from: { x: 0, y: 1, z: 0 } });
        proj.throwDung({ dir: { x: 0, y: 0, z: -1 } });
      });
      assert.equal(events.length, 0, 'кривые броски не эмитят throw');
    } finally { off(); }
  });

  it('throwDung: нулевой dir → запасное направление, дефолтные owner "?" и power', () => {
    const scene = makeScene();
    const proj = createProjectiles(scene, makeWorld());
    const events = [];
    const off = bus.on('throw', (d) => events.push(d));
    try {
      proj.throwDung({ from: { x: 0, y: 1, z: 0 }, dir: { x: 0, y: 0, z: 0 } }); // без power и owner
      assert.deepEqual(events, [{ owner: '?' }]);
      assert.equal(visibleProjectiles(scene).length, 1, 'снаряд полетел с запасным направлением');

      proj.throwDung({ from: { x: 0, y: 1, z: 0 }, dir: { y: 1 }, owner: 'up' }); // x/z отсутствуют → 0
      assert.deepEqual(events[1], { owner: 'up' });
    } finally { off(); }
  });

  it('state.stats отсутствует — бросок игрока не падает', () => {
    const proj = createProjectiles(makeScene(), makeWorld());
    const realStats = state.stats;
    state.stats = null;
    try {
      assert.doesNotThrow(() =>
        proj.throwDung({ from: { x: 0, y: 1, z: 0 }, dir: { x: 0, y: 0, z: -1 }, owner: 'player', power: 0.5 }));
    } finally { state.stats = realStats; }
  });

  it('threats: null-позиция, отсутствующий y и кривой горизонт обрабатываются', () => {
    const proj = createProjectiles(makeScene(), makeWorld());
    assert.equal(proj.threats(null).length, 0, 'без позиции угроз нет');
    proj.throwDung({ from: { x: 0, y: 1.2, z: 6 }, dir: { x: 0, y: 0, z: -1 }, owner: 'a', power: 1 });
    assert.equal(proj.threats({ x: 0, z: 0 }).length, 1, 'горизонт по умолчанию, y точки → 0');
    assert.equal(proj.threats({ x: 0, y: 0, z: 0 }, -5).length, 1, 'отрицательный горизонт → дефолтный');
  });

  it('threats: два снаряда в одну точку — две угрозы', () => {
    const proj = createProjectiles(makeScene(), makeWorld());
    proj.throwDung({ from: { x: 0, y: 1.2, z: 6 }, dir: { x: 0, y: 0, z: -1 }, owner: 'a', power: 1 });
    proj.throwDung({ from: { x: 0, y: 1.2, z: -6 }, dir: { x: 0, y: 0, z: 1 }, owner: 'b', power: 1 });
    assert.equal(proj.threats({ x: 0, y: 0, z: 0 }, 1.2).length, 2);
  });

  it('threats: снаряд упадёт раньше, чем долетит — не угроза', () => {
    const proj = createProjectiles(makeScene(), makeWorld());
    // 8 м/с с высоты 0.5 — упадёт через ~0.3 c метрах в двух от старта
    proj.throwDung({ from: { x: 0, y: 0.5, z: 20 }, dir: { x: 0, y: 0, z: -1 }, owner: 'a', power: 0 });
    assert.equal(proj.threats({ x: 0, y: 0, z: 0 }, 1.2).length, 0);
  });

  it('update с неположительным dt — no-op', () => {
    const scene = makeScene();
    const proj = createProjectiles(scene, makeWorld());
    proj.throwDung({ from: { x: 0, y: 1, z: 0 }, dir: { x: 0, y: 0, z: -1 }, owner: 't', power: 1 });
    const mesh = visibleProjectiles(scene)[0];
    const z0 = mesh.position.z;
    proj.update(0);
    proj.update(-1);
    proj.update(NaN);
    assert.equal(mesh.position.z, z0, 'снаряд не сдвинулся');
    assert.equal(mesh.visible, true, 'и не погашен');
  });
});
