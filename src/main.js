// Гарехабба — точка входа: рендерер, сцена, сборка модулей, игровой цикл.
import * as THREE from 'three';
import { state, bus, setMode, save, load, hasSave, resetSave, addMoney, addAmmo } from './state.js';
import { audio } from './audio.js';
import { initWorld } from './world.js';
import { createProjectiles } from './physics.js';
import { createPlayer } from './player.js';
import { createNPCs } from './npc.js';
import { createShop } from './shop.js';
import { createStall } from './stall.js';
import { createTuktuks } from './tuktuk.js';
import { createQuests } from './quests.js';
import { createPhotoMode } from './photo.js';
import { createUI } from './ui.js';
import { createNet } from './net.js';
import { createTouch } from './touch.js';

// ---------- Рендерер / сцена / камера ----------
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
document.getElementById('game').appendChild(renderer.domElement);
renderer.domElement.addEventListener('contextmenu', (e) => e.preventDefault());

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xffd9a8);
scene.fog = new THREE.Fog(0xf2c78d, 60, 220);

const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.1, 400);
camera.position.set(0, 8, 20);

const hemi = new THREE.HemisphereLight(0xfff3e0, 0x8a6a4f, 1.1);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xffe0b0, 2.0);
sun.position.set(40, 60, 20);
sun.castShadow = true;
// на телефонах экономим: тени поменьше, pixelRatio пониже
const coarse = (window.matchMedia && matchMedia('(pointer: coarse)').matches) || navigator.maxTouchPoints > 0;
sun.shadow.mapSize.set(coarse ? 1024 : 2048, coarse ? 1024 : 2048);
if (coarse) renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
sun.shadow.camera.left = -60; sun.shadow.camera.right = 60;
sun.shadow.camera.top = 60; sun.shadow.camera.bottom = -60;
sun.shadow.camera.far = 200;
sun.shadow.bias = -0.0005;
scene.add(sun);
scene.add(sun.target);

// ---------- Модули ----------
const world = initWorld(scene);
const projectiles = createProjectiles(scene, world);
const player = createPlayer(scene, world, camera, projectiles);
const npcs = createNPCs(scene, world, projectiles, player);
const shop = createShop(scene, world, player);
const stall = createStall(scene, world, player, npcs);
const tuktuks = createTuktuks(scene, world, player);
const quests = createQuests();
const photo = createPhotoMode(scene, camera, renderer, { world, player, npcs });
const ui = createUI();
const net = createNet({ scene, player, projectiles });
const touch = createTouch({ player });

// Коровы священны: регистрируем как цели, попадание — штраф.
(world.cows || []).forEach((cow, i) => {
  projectiles.registerTarget({
    id: `cow:${i}`,
    getPosition: () => cow.getPosition(),
    radius: cow.radius, height: cow.height,
    onHit: (info) => bus.emit('cowHit', { owner: info && info.owner }),
  });
});
bus.on('cowHit', (d) => {
  if (!d || d.owner !== 'player') return; // штраф только за бросок игрока
  state.stats.cowsHit++;
  addMoney(-20);
  audio.moo();
  bus.emit('toast', { text: '🐄 Корову нельзя, саар! Штраф ₹20', ms: 2500, cls: 'error' });
});

// ---------- Клавиши main: E / P / Tab ----------
window.addEventListener('keydown', (e) => {
  if (state.mode === 'menu') return;
  if (e.code === 'KeyE') {
    if (state.mode === 'walk') {
      // порядок: тук-тук → магазин → ларёк
      if (!tuktuks.tryInteract()) { if (!shop.tryInteract()) stall.tryInteract(); }
    }
  } else if (e.code === 'KeyP') {
    if (state.mode === 'walk' || state.mode === 'photo') photo.toggle();
  } else if (e.code === 'Tab') {
    e.preventDefault();
    ui.toggleQuests();
  }
});

// ---------- Стартовый экран ----------
const startScreen = document.getElementById('start-screen');
const btnNew = document.getElementById('btn-new');
const btnContinue = document.getElementById('btn-continue');
if (!hasSave()) btnContinue.style.display = 'none';

function begin(continueGame) {
  audio.init();
  if (continueGame) {
    load();
    if (state.playerPos) player.teleport(state.playerPos);
  } else {
    resetSave();
  }
  startScreen.classList.add('hidden');
  document.getElementById('hud').classList.remove('hidden');
  document.getElementById('hud-quest').classList.remove('hidden');
  setMode('walk');
  audio.crowd(true);
  bus.emit('toast', { text: '🎉 ФЕСТИВАЛЬ ГАРЕХАББА НАЧАЛСЯ!', ms: 3200, cls: 'big' });
  setTimeout(() => bus.emit('toast', { text: 'Берегись летающих лепёшек, саар! 💩', ms: 3000 }), 1200);
}
btnNew.addEventListener('click', () => begin(false));
btnContinue.addEventListener('click', () => begin(true));

// ---------- Автосейв ----------
function doSave() {
  if (state.mode === 'menu') return;
  const p = player.getPosition();
  state.playerPos = { x: p.x, y: p.y, z: p.z };
  save();
}
setInterval(doSave, 20000);
window.addEventListener('beforeunload', doSave);

// ---------- Ошибки — в тост (и это не «индийский вайб», чиним) ----------
window.addEventListener('error', (e) => {
  bus.emit('toast', { text: '⚠️ ' + (e.message || 'ошибка'), ms: 6000, cls: 'error' });
});

// ---------- Ресайз ----------
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ---------- Цикл ----------
const clock = new THREE.Clock();
const menuTarget = new THREE.Vector3(0, 2, 0);
let simT = 0;

function frame(dt) {
  simT += dt;
  const t = simT;

  world.update(dt, t);
  projectiles.update(dt);
  npcs.update(dt);
  tuktuks.update(dt);
  net.update(dt);

  if (state.mode !== 'menu') {
    player.update(dt);
    shop.update(dt);
    stall.update(dt);
    photo.update(dt);
    quests.update(dt);

    // подбор кучек под ногами
    const got = world.collectPickup(player.getPosition(), 1.0);
    if (got > 0) {
      addAmmo(got);
      audio.click();
      bus.emit('toast', { text: `+${got} 💩`, ms: 800 });
    }
  } else {
    // камера-карусель над площадью в меню
    const a = t * 0.12;
    camera.position.set(Math.sin(a) * 26, 11, Math.cos(a) * 26);
    camera.lookAt(menuTarget);
  }

  // солнце следует за игроком, чтобы тени не убегали
  const pp = player.getPosition();
  sun.position.set(pp.x + 40, 60, pp.z + 20);
  sun.target.position.set(pp.x, 0, pp.z);

  ui.update(dt, camera);
  renderer.render(scene, camera);
}

renderer.setAnimationLoop(() => frame(Math.min(clock.getDelta(), 0.05)));

// отладочный доступ из консоли + ручная прокрутка кадров для тестов
window.__dbg = {
  camera, state, bus, player, world, npcs, setMode,
  projectiles, shop, stall, tuktuks, photo, ui, quests, net, touch,
  tick(dt = 1 / 60, n = 1) { for (let i = 0; i < n; i++) frame(dt); },
};
