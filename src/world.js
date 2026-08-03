// world.js — мир Гарехаббы: площадка 112×112, решётка дорог, кварталы с
// пастельными домиками, храм-гопурам на севере, периметровая стена с воротами
// на востоке, центральная площадь с праздничной кучей навоза, гирлянды
// флажков, баннеры «ГАРЕХАББА», четыре священные коровы и кучки-пикапы.
// Владелец файла: агент «world». Контракт: initWorld(scene) из INTERFACES.md.

import * as THREE from 'three';
import { state } from './state.js';

/* ================= утилиты ================= */

// Детерминированный рандом — деревня всегда одинаковая, саар.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function wrapAngle(a) {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

// Временные объекты — никаких аллокаций в горячем цикле.
const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const _s = new THREE.Vector3(1, 1, 1);
const X_AXIS = new THREE.Vector3(1, 0, 0);
const Y_AXIS = new THREE.Vector3(0, 1, 0);
const Z_AXIS = new THREE.Vector3(0, 0, 1);

/* ================= общие геометрии/материалы ================= */

const boxGeo = new THREE.BoxGeometry(1, 1, 1);
const cone4Geo = new THREE.ConeGeometry(1, 1, 4);
const cone8Geo = new THREE.ConeGeometry(1, 1, 8);
const sphereGeo = new THREE.SphereGeometry(1, 8, 6);
const cylGeo = new THREE.CylinderGeometry(1, 1, 1, 8);
const planeGeo = new THREE.PlaneGeometry(1, 1);
const neckRingGeo = new THREE.TorusGeometry(0.34, 0.07, 6, 10);
const pileRingGeo = new THREE.TorusGeometry(2.35, 0.18, 6, 16);

const flagGeo = (() => {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(
    [-0.2, 0, 0, 0.2, 0, 0, 0, -0.38, 0], 3));
  geo.computeVertexNormals();
  return geo;
})();

const PASTELS = [0x4ecdc4, 0xff6b9d, 0xffe66d, 0xff9f43, 0x54a0ff, 0x9b59b6];
const ROOF_COLORS = [0xc0563a, 0xe07040, 0xb6452e, 0xd35400];
const FLAG_COLORS = [0xff6b9d, 0xffe66d, 0x4ecdc4, 0xff9f43, 0x54a0ff, 0xffffff, 0x2ecc71];

const _matCache = new Map();
function mat(color, flat = false, side = THREE.FrontSide) {
  const key = color + '|' + (flat ? 1 : 0) + '|' + side;
  let m = _matCache.get(key);
  if (!m) {
    m = new THREE.MeshLambertMaterial({ color, flatShading: flat, side });
    _matCache.set(key, m);
  }
  return m;
}

/* ================= канвас-текстуры ================= */

function makeGroundTexture() {
  const S = 1024, PPM = S / 112;
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const g = cv.getContext('2d');
  const rnd = mulberry32(0xC0FFEE);

  // тёплый песок + шероховатость
  g.fillStyle = '#d9a066';
  g.fillRect(0, 0, S, S);
  for (let i = 0; i < 4200; i++) {
    g.fillStyle = i % 2 ? 'rgba(140,95,50,0.16)' : 'rgba(255,226,170,0.14)';
    g.fillRect(rnd() * S, rnd() * S, 1 + rnd() * 2.5, 1 + rnd() * 2.5);
  }

  // дороги-решётка (полосы ширины 6 по x/z = -28, 0, 28)
  g.fillStyle = '#b98a55';
  for (const c of [-28, 0, 28]) {
    const p = (c + 56) * PPM, hw = 3 * PPM;
    g.fillRect(p - hw, 0, hw * 2, S);
    g.fillRect(0, p - hw, S, hw * 2);
  }
  // пыль и колеи на дорогах
  for (const c of [-28, 0, 28]) {
    const p = (c + 56) * PPM, hw = 3 * PPM;
    for (let i = 0; i < 340; i++) {
      g.fillStyle = 'rgba(120,80,42,0.22)';
      g.fillRect(p - hw + rnd() * hw * 2, rnd() * S, 1.5, 3 + rnd() * 6);
      g.fillRect(rnd() * S, p - hw + rnd() * hw * 2, 3 + rnd() * 6, 1.5);
    }
  }

  // центральная площадь 24×24 — светлый праздничный настил
  const c0 = 56 * PPM, half = 12 * PPM;
  g.fillStyle = '#e0ad70';
  g.fillRect(c0 - half, c0 - half, half * 2, half * 2);
  g.strokeStyle = '#b98a55';
  g.lineWidth = 5;
  g.strokeRect(c0 - half + 4, c0 - half + 4, half * 2 - 8, half * 2 - 8);

  // ранголи вокруг центральной кучи
  const rings = [['#e74c3c', 6.0], ['#ffe66d', 4.9], ['#ffffff', 3.9], ['#ff9f43', 3.0]];
  g.lineWidth = 9;
  for (const [col, r] of rings) {
    g.strokeStyle = col;
    g.beginPath();
    g.arc(c0, c0, r * PPM, 0, Math.PI * 2);
    g.stroke();
  }
  g.fillStyle = '#e74c3c';
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2;
    g.beginPath();
    g.arc(c0 + Math.cos(a) * 7.2 * PPM, c0 + Math.sin(a) * 7.2 * PPM, 0.4 * PPM, 0, Math.PI * 2);
    g.fill();
  }

  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

function makeBannerTexture() {
  const cv = document.createElement('canvas');
  cv.width = 1024; cv.height = 160;
  const g = cv.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 0, 160);
  grad.addColorStop(0, '#e67e22');
  grad.addColorStop(1, '#c0392b');
  g.fillStyle = grad;
  g.fillRect(0, 0, 1024, 160);
  g.strokeStyle = '#ffe66d';
  g.lineWidth = 8;
  g.strokeRect(8, 8, 1008, 144);
  g.fillStyle = '#ffffff';
  g.font = '900 92px "Trebuchet MS", "Segoe UI", sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.shadowColor = 'rgba(60,10,0,0.5)';
  g.shadowOffsetY = 6;
  g.fillText('🎉 ГАРЕХАББА 🎉', 512, 84);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

let _awnMats = null;
function awningMats() {
  if (_awnMats) return _awnMats;
  _awnMats = ['#e74c3c', '#2ecc71', '#54a0ff'].map((col) => {
    const cv = document.createElement('canvas');
    cv.width = 64; cv.height = 16;
    const g = cv.getContext('2d');
    g.fillStyle = '#fff6e8';
    g.fillRect(0, 0, 64, 16);
    g.fillStyle = col;
    for (let x = 0; x < 64; x += 16) g.fillRect(x, 0, 8, 16);
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = THREE.RepeatWrapping;
    tex.repeat.set(2, 1);
    return new THREE.MeshLambertMaterial({ map: tex });
  });
  return _awnMats;
}

/* ================= главный вход ================= */

export function initWorld(scene) {
  const rng = mulberry32(0x5AA9);
  const colliders = [];

  const landmarks = {
    square: new THREE.Vector3(0, 0, 0),
    temple: new THREE.Vector3(0, 0, -48),
    shop: new THREE.Vector3(20, 0, 14),
    stall: new THREE.Vector3(-20, 0, 14),
    tuktukStand: new THREE.Vector3(34, 0, 2),
    gate: new THREE.Vector3(54, 0, 0),
  };

  function addCollider(cx, cz, hw, hd, h) {
    colliders.push(new THREE.Box3(
      new THREE.Vector3(cx - hw, 0, cz - hd),
      new THREE.Vector3(cx + hw, h, cz + hd)));
  }

  // точка (x,z) внутри какого-нибудь коллайдера (с запасом pad)?
  function blocked(x, z, pad) {
    for (let i = 0; i < colliders.length; i++) {
      const b = colliders[i];
      if (x > b.min.x - pad && x < b.max.x + pad && z > b.min.z - pad && z < b.max.z + pad) return true;
    }
    return false;
  }

  const staticGroup = new THREE.Group();
  const dynamicGroup = new THREE.Group();

  function sBox(w, h, d, color, x, y, z, flat = false) {
    const m = new THREE.Mesh(boxGeo, mat(color, flat));
    m.scale.set(w, h, d);
    m.position.set(x, y, z);
    staticGroup.add(m);
    return m;
  }

  /* ---------- земля (дороги и площадь запечены в текстуру) ---------- */
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(112, 112),
    new THREE.MeshLambertMaterial({ map: makeGroundTexture() }));
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  staticGroup.add(ground);

  /* ---------- периметровая стена + ворота на востоке ---------- */
  const WALL_COL = 0xc0834f;
  const wallDefs = [
    // [x, z, w, d] — центр и размеры
    [0, -55.5, 112, 1],                  // север
    [0, 55.5, 112, 1],                   // юг
    [-55.5, 0, 1, 112],                  // запад
    [55.5, -30.3, 1, 51.4],              // восток (север от ворот)
    [55.5, 30.3, 1, 51.4],               // восток (юг от ворот)
  ];
  for (const [wx, wz, ww, wd] of wallDefs) {
    const w = sBox(ww, 2.2, wd, WALL_COL, wx, 1.1, wz);
    w.castShadow = w.receiveShadow = true;
    addCollider(wx, wz, ww / 2, wd / 2, 2.2);
  }
  // столбики на стене
  {
    const posts = [];
    for (let x = -49; x <= 49; x += 14) { posts.push([x, -55.5], [x, 55.5]); }
    for (let z = -42; z <= 42; z += 14) {
      posts.push([-55.5, z]);
      if (Math.abs(z) > 7) posts.push([55.5, z]);
    }
    const inst = new THREE.InstancedMesh(boxGeo, mat(0xb5763f), posts.length);
    _q.identity();
    for (let i = 0; i < posts.length; i++) {
      _v.set(posts[i][0], 1.5, posts[i][1]);
      _s.set(1.3, 3.0, 1.3);
      _m.compose(_v, _q, _s);
      inst.setMatrixAt(i, _m);
    }
    inst.castShadow = true;
    inst.frustumCulled = false;
    staticGroup.add(inst);
  }
  // ворота: два ярких столба и перекладина (без коллайдера у перекладины!)
  for (const gz of [-5.2, 5.2]) {
    const p = sBox(1.4, 5, 1.4, 0xff9f43, 55, 2.5, gz);
    p.castShadow = true;
    const top = new THREE.Mesh(cone4Geo, mat(0xe74c3c, true));
    top.scale.set(1.2, 1.1, 1.2);
    top.position.set(55, 5.55, gz);
    top.rotation.y = Math.PI / 4;
    staticGroup.add(top);
    addCollider(55, gz, 0.75, 0.75, 5);
  }
  sBox(1.4, 1.2, 11.6, 0xffe66d, 55, 5.4, 0).castShadow = true;

  /* ---------- храм-гопурам на севере (0, 0, -48) ---------- */
  {
    const tg = new THREE.Group();
    tg.position.set(0, 0, -48);
    const plat = new THREE.Mesh(boxGeo, mat(0xd8b078));
    plat.scale.set(14, 0.9, 13);
    plat.position.y = 0.45;
    plat.castShadow = plat.receiveShadow = true;
    tg.add(plat);

    const tierS = [11, 9.2, 7.5, 5.9, 4.4];
    const tierH = [2.5, 2.1, 1.8, 1.6, 1.4];
    let ty = 0.9;
    for (let i = 0; i < tierS.length; i++) {
      const s = tierS[i];
      const tier = new THREE.Mesh(boxGeo, mat(PASTELS[(i + 2) % PASTELS.length], true));
      tier.scale.set(s, tierH[i], s * 0.9);
      tier.position.y = ty + tierH[i] / 2;
      tier.castShadow = tier.receiveShadow = true;
      tg.add(tier);
      // угловые украшения ярусов
      const c = s / 2 - 0.35;
      for (const [ux, uz] of [[c, c * 0.9], [-c, c * 0.9], [c, -c * 0.9], [-c, -c * 0.9]]) {
        const dec = new THREE.Mesh(boxGeo, mat(0xffe66d));
        dec.scale.set(0.55, 0.5, 0.55);
        dec.position.set(ux, ty + tierH[i] + 0.25, uz);
        tg.add(dec);
      }
      ty += tierH[i];
    }
    // корона и золотой калаш
    const crown = new THREE.Mesh(boxGeo, mat(0xffe66d));
    crown.scale.set(2.4, 0.9, 2.0);
    crown.position.y = ty + 0.45;
    crown.castShadow = true;
    tg.add(crown);
    const kal = new THREE.Mesh(sphereGeo, mat(0xf1c40f, true));
    kal.scale.set(0.5, 0.4, 0.5);
    kal.position.y = ty + 1.15;
    tg.add(kal);
    const spike = new THREE.Mesh(cone8Geo, mat(0xf1c40f, true));
    spike.scale.set(0.3, 0.8, 0.3);
    spike.position.y = ty + 1.75;
    tg.add(spike);
    // тёмный вход, обращённый к площади
    const door = new THREE.Mesh(planeGeo, mat(0x3a2010));
    door.scale.set(1.8, 2.6, 1);
    door.position.set(0, 2.2, tierS[0] * 0.45 + 0.03);
    tg.add(door);
    // ступени к площади
    for (let i = 0; i < 3; i++) {
      const h = 0.66 - i * 0.22;
      const st = new THREE.Mesh(boxGeo, mat(0xd8b078));
      st.scale.set(4.6, h, 1.0);
      st.position.set(0, h / 2, 6.35 + i * 1.0);
      st.receiveShadow = true;
      tg.add(st);
    }
    // входные колонны
    for (const px of [-3.2, 3.2]) {
      const col = new THREE.Mesh(cylGeo, mat(0xff6b9d));
      col.scale.set(0.35, 2.4, 0.35);
      col.position.set(px, 1.2, 6.2);
      col.castShadow = true;
      tg.add(col);
      const cap = new THREE.Mesh(cone8Geo, mat(0x4ecdc4, true));
      cap.scale.set(0.5, 0.6, 0.5);
      cap.position.set(px, 2.7, 6.2);
      tg.add(cap);
    }
    staticGroup.add(tg);
    // ярусный коллайдер: снаряды лопаются у видимых стен, а не в воздухе
    addCollider(0, -48, 7.15, 6.65, 2.2); // платформа (и чтоб не запрыгнуть)
    {
      let cy = 0.9;
      for (let i = 0; i < tierS.length; i++) {
        addCollider(0, -48, tierS[i] / 2 + 0.1, tierS[i] * 0.45 + 0.1, cy + tierH[i]);
        cy += tierH[i];
      }
    }
  }

  /* ---------- праздничная куча навоза на площади ---------- */
  {
    const pile = new THREE.Mesh(cone8Geo, mat(0x6b4a2a, true));
    pile.scale.set(2.2, 2.6, 2.2);
    pile.position.set(0, 1.3, 0);
    pile.castShadow = pile.receiveShadow = true;
    staticGroup.add(pile);
    // мелкие комки у подножия
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2 + 0.4;
      const lump = new THREE.Mesh(sphereGeo, mat(0x5a3c22, true));
      lump.scale.set(0.5, 0.3, 0.5);
      lump.position.set(Math.cos(a) * (2.3 + (i % 2) * 0.4), 0.16, Math.sin(a) * (2.3 + (i % 2) * 0.4));
      staticGroup.add(lump);
    }
    // гирлянда из бархатцев вокруг кучи
    const ring = new THREE.Mesh(pileRingGeo, mat(0xff9f43));
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.35;
    staticGroup.add(ring);
    // шест с флажками на вершине — праздник же!
    const stick = new THREE.Mesh(cylGeo, mat(0x8c5a2e));
    stick.scale.set(0.05, 1.6, 0.05);
    stick.position.set(0, 3.2, 0);
    staticGroup.add(stick);
    const f1 = new THREE.Mesh(flagGeo, mat(0xe74c3c, false, THREE.DoubleSide));
    f1.scale.setScalar(1.8);
    f1.position.set(0.2, 3.95, 0);
    staticGroup.add(f1);
    const f2 = new THREE.Mesh(flagGeo, mat(0x4ecdc4, false, THREE.DoubleSide));
    f2.scale.setScalar(1.5);
    f2.position.set(-0.15, 3.6, 0.05);
    f2.rotation.y = Math.PI / 2;
    staticGroup.add(f2);
    // конус кучи: два яруса вместо одного широкого бокса
    addCollider(0, 0, 1.9, 1.9, 1.2);
    addCollider(0, 0, 1.0, 1.0, 2.4);
  }

  /* ---------- кварталы с домиками ---------- */
  // зоны, где строить нельзя (площадь, храм, магазин, ларёк, стоянка, ворота)
  const CLEAR = [
    [-15, 15, -15, 15],
    [-9, 9, -56, -38],
    [14, 26, 8, 20],
    [-26, -14, 8, 20],
    [29, 39, -4, 8],
    [45, 56, -9, 9],
  ];
  const placed = [];
  function rectHits(x, z, hw, hd) {
    for (let i = 0; i < CLEAR.length; i++) {
      const r = CLEAR[i];
      if (x + hw > r[0] && x - hw < r[1] && z + hd > r[2] && z - hd < r[3]) return true;
    }
    for (let i = 0; i < placed.length; i++) {
      const p = placed[i];
      if (Math.abs(x - p.x) < hw + p.hw + 1.4 && Math.abs(z - p.z) < hd + p.hd + 1.4) return true;
    }
    return false;
  }

  function buildHouse(x, z, w, d, h, ry) {
    const gp = new THREE.Group();
    gp.position.set(x, 0, z);
    gp.rotation.y = ry;
    const wallCol = PASTELS[Math.floor(rng() * PASTELS.length)];

    const walls = new THREE.Mesh(boxGeo, mat(wallCol));
    walls.scale.set(w, h, d);
    walls.position.y = h / 2;
    walls.castShadow = walls.receiveShadow = true;
    gp.add(walls);

    const skirt = new THREE.Mesh(boxGeo, mat(0xbd8752));
    skirt.scale.set(w + 0.25, 0.5, d + 0.25);
    skirt.position.y = 0.25;
    skirt.receiveShadow = true;
    gp.add(skirt);

    if (rng() < 0.55) {
      // скатная (пирамидальная) крыша
      const roof = new THREE.Mesh(cone4Geo, mat(ROOF_COLORS[Math.floor(rng() * ROOF_COLORS.length)], true));
      const sy = 1.1 + rng() * 0.9;
      roof.scale.set((w / 2 + 0.35) / Math.SQRT1_2, sy, (d / 2 + 0.35) / Math.SQRT1_2);
      roof.rotation.y = Math.PI / 4;
      roof.position.y = h + sy / 2;
      roof.castShadow = true;
      gp.add(roof);
    } else {
      // плоская крыша
      const slab = new THREE.Mesh(boxGeo, mat(0xe8d5ac));
      slab.scale.set(w + 0.5, 0.22, d + 0.5);
      slab.position.y = h + 0.11;
      slab.castShadow = true;
      gp.add(slab);
      if (rng() < 0.45) {
        const pot = new THREE.Mesh(sphereGeo, mat(0x54a0ff));
        pot.scale.set(0.45, 0.5, 0.45);
        pot.position.set((rng() - 0.5) * w * 0.5, h + 0.6, (rng() - 0.5) * d * 0.5);
        gp.add(pot);
      }
    }

    // дверь на местной «фасадной» стороне (+z)
    const dx = (rng() - 0.5) * w * 0.3;
    const door = new THREE.Mesh(planeGeo, mat(0x4a2f18));
    door.scale.set(1.05, 1.8, 1);
    door.position.set(dx, 0.9, d / 2 + 0.03);
    gp.add(door);

    // окна по бокам
    for (const sgn of [1, -1]) {
      const win = new THREE.Mesh(planeGeo, mat(0x3f5468));
      win.scale.set(0.8, 0.8, 1);
      win.position.set(sgn * (w / 2 + 0.03), h * 0.55, (rng() - 0.5) * d * 0.4);
      win.rotation.y = sgn * Math.PI / 2;
      gp.add(win);
    }

    // полосатый навес над дверью
    if (rng() < 0.5) {
      const mats = awningMats();
      const aw = new THREE.Mesh(boxGeo, mats[Math.floor(rng() * mats.length)]);
      aw.scale.set(2.1, 0.07, 1.25);
      aw.position.set(dx, Math.min(h - 0.3, 2.2), d / 2 + 0.55);
      aw.rotation.x = 0.3;
      gp.add(aw);
      for (const sgn of [1, -1]) {
        const pole = new THREE.Mesh(cylGeo, mat(0x8c5a2e));
        pole.scale.set(0.05, 1.9, 0.05);
        pole.position.set(dx + sgn * 0.9, 0.95, d / 2 + 1.0);
        gp.add(pole);
      }
    }
    staticGroup.add(gp);
  }

  const SPANS = [[-53, -33], [-23, -5], [5, 23], [33, 53]];
  for (const [bx0, bx1] of SPANS) {
    for (const [bz0, bz1] of SPANS) {
      const want = 2 + Math.floor(rng() * 3); // 2..4 здания на квартал
      let built = 0, tries = 0;
      while (built < want && tries++ < 30) {
        const w = 3.8 + rng() * 3, d = 3.8 + rng() * 3, h = 2.8 + rng() * 2.8;
        const rotSteps = Math.floor(rng() * 4);
        const ew = (rotSteps % 2) ? d : w, ed = (rotSteps % 2) ? w : d;
        const fx = (bx1 - bx0) - ew - 1.2, fz = (bz1 - bz0) - ed - 1.2;
        if (fx <= 0 || fz <= 0) continue;
        const x = bx0 + 0.6 + ew / 2 + rng() * fx;
        const z = bz0 + 0.6 + ed / 2 + rng() * fz;
        if (rectHits(x, z, ew / 2, ed / 2)) continue;
        buildHouse(x, z, w, d, h, rotSteps * Math.PI / 2);
        placed.push({ x, z, hw: ew / 2, hd: ed / 2 });
        addCollider(x, z, ew / 2 + 0.05, ed / 2 + 0.05, h + 0.5);
        built++;
      }
    }
  }

  /* ---------- пальмы ---------- */
  function buildPalm(x, z) {
    const gp = new THREE.Group();
    gp.position.set(x, 0, z);
    const t1 = new THREE.Mesh(cylGeo, mat(0x8d6a42));
    t1.scale.set(0.18, 1.7, 0.18);
    t1.position.y = 0.85;
    t1.rotation.z = 0.06;
    t1.castShadow = true;
    gp.add(t1);
    const t2 = new THREE.Mesh(cylGeo, mat(0x9a744a));
    t2.scale.set(0.14, 1.6, 0.14);
    t2.position.set(0.14, 2.3, 0);
    t2.rotation.z = 0.14;
    gp.add(t2);
    const topY = 3.1, topX = 0.24;
    for (let i = 0; i < 6; i++) {
      const leaf = new THREE.Mesh(planeGeo, mat(0x5da24e, false, THREE.DoubleSide));
      leaf.scale.set(0.6, 2.1, 1);
      leaf.position.set(topX, topY, 0);
      leaf.rotation.order = 'YXZ';
      leaf.rotation.y = (i / 6) * Math.PI * 2;
      leaf.rotation.x = -1.9;
      gp.add(leaf);
    }
    for (let i = 0; i < 2; i++) {
      const nut = new THREE.Mesh(sphereGeo, mat(0x6b4a2a));
      nut.scale.setScalar(0.16);
      nut.position.set(topX + (i ? 0.2 : -0.15), topY - 0.15, i ? 0.1 : -0.12);
      gp.add(nut);
    }
    staticGroup.add(gp);
    addCollider(x, z, 0.28, 0.28, 2.5); // только ствол пальмы
  }
  buildPalm(14, 14); buildPalm(-14, 14); buildPalm(14, -14); buildPalm(-14, -14);
  buildPalm(8, -39); buildPalm(-8, -39);

  /* ---------- гирлянды флажков над улицами ---------- */
  const flagData = [];
  const polePos = [];
  const stringPts = [];
  function addGarland(cx, cz, alongZ) {
    const half = 4, topY = 3.15, sag = 0.6, n = 9;
    if (alongZ) polePos.push([cx, cz - half], [cx, cz + half]);
    else polePos.push([cx - half, cz], [cx + half, cz]);
    // верёвка (ломаная с провисом)
    let px = alongZ ? cx : cx - half;
    let pz = alongZ ? cz - half : cz;
    let py = topY;
    const SEGS = 6;
    for (let k = 1; k <= SEGS; k++) {
      const s = k / SEGS;
      const nx = alongZ ? cx : cx - half + s * half * 2;
      const nz = alongZ ? cz - half + s * half * 2 : cz;
      const ny = topY - sag * Math.sin(Math.PI * s);
      stringPts.push(px, py, pz, nx, ny, nz);
      px = nx; py = ny; pz = nz;
    }
    for (let k = 0; k < n; k++) {
      const s = (k + 1) / (n + 1);
      flagData.push({
        x: alongZ ? cx : cx - half + s * half * 2,
        y: topY - sag * Math.sin(Math.PI * s) - 0.02,
        z: alongZ ? cz - half + s * half * 2 : cz,
        alongZ,
        phase: rng() * Math.PI * 2,
        scale: 0.9 + rng() * 0.35,
      });
    }
  }
  // поперёк «вертикальных» дорог (x = const): струна вдоль X
  addGarland(0, -38, false); addGarland(0, -16, false); addGarland(0, 16, false); addGarland(0, 38, false);
  for (const rx of [-28, 28]) for (const gz of [-44, -16, 16, 44]) addGarland(rx, gz, false);
  // поперёк «горизонтальных» дорог (z = const): струна вдоль Z
  for (const rz of [-28, 0, 28]) for (const gx of [-44, -16, 16, 44]) addGarland(gx, rz, true);

  // столбики гирлянд
  {
    const inst = new THREE.InstancedMesh(cylGeo, mat(0x8c5a2e), polePos.length);
    _q.identity();
    for (let i = 0; i < polePos.length; i++) {
      _v.set(polePos[i][0], 1.65, polePos[i][1]);
      _s.set(0.07, 3.3, 0.07);
      _m.compose(_v, _q, _s);
      inst.setMatrixAt(i, _m);
    }
    inst.frustumCulled = false;
    staticGroup.add(inst);
  }
  // верёвки одним LineSegments
  {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(stringPts, 3));
    staticGroup.add(new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: 0x8c4a3c })));
  }
  // сами флажки — один InstancedMesh, машут в update
  const flagMesh = new THREE.InstancedMesh(
    flagGeo,
    new THREE.MeshLambertMaterial({ color: 0xffffff, side: THREE.DoubleSide }),
    flagData.length);
  flagMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  flagMesh.frustumCulled = false;
  {
    const col = new THREE.Color();
    for (let i = 0; i < flagData.length; i++) {
      col.setHex(FLAG_COLORS[i % FLAG_COLORS.length]);
      flagMesh.setColorAt(i, col);
    }
    if (flagMesh.instanceColor) flagMesh.instanceColor.needsUpdate = true;
  }
  staticGroup.add(flagMesh);

  scene.add(staticGroup);
  // всё статичное — замораживаем матрицы (economия на 60 fps)
  staticGroup.updateMatrixWorld(true);
  staticGroup.traverse((o) => { o.matrixAutoUpdate = false; });

  /* ---------- баннеры «ГАРЕХАББА» (слегка покачиваются) ---------- */
  const bannerGroups = [];
  {
    const tex = makeBannerTexture();
    const bmat = new THREE.MeshBasicMaterial({ map: tex });
    function makeBanner(x, z, ry) {
      const gp = new THREE.Group();
      gp.position.set(x, 0, z);
      gp.rotation.y = ry;
      const p1 = new THREE.Mesh(planeGeo, bmat);
      p1.scale.set(16, 2.4, 1);
      p1.position.y = 3.9;
      gp.add(p1);
      const p2 = new THREE.Mesh(planeGeo, bmat);
      p2.scale.set(16, 2.4, 1);
      p2.position.set(0, 3.9, -0.02);
      p2.rotation.y = Math.PI;
      gp.add(p2);
      for (const sgn of [1, -1]) {
        const pole = new THREE.Mesh(cylGeo, mat(0x8c5a2e));
        pole.scale.set(0.09, 5.2, 0.09);
        pole.position.set(sgn * 8.3, 2.6, 0);
        gp.add(pole);
        const fin = new THREE.Mesh(sphereGeo, mat(0xffe66d));
        fin.scale.setScalar(0.16);
        fin.position.set(sgn * 8.3, 5.25, 0);
        gp.add(fin);
      }
      dynamicGroup.add(gp);
      bannerGroups.push(gp);
    }
    makeBanner(0, -13, 0);       // северный край площади, лицом к центру
    makeBanner(0, 13, Math.PI);  // южный край
  }

  /* ---------- коровы (4 шт, священные) ---------- */
  const cows = [];
  const cowStates = [];
  const LEG_PHASE = [0, Math.PI, Math.PI, 0];

  function buildCow(bodyCol, patchCol) {
    const g = new THREE.Group();
    const bodyMat = mat(bodyCol);
    const patchMat = mat(patchCol);

    const body = new THREE.Mesh(boxGeo, bodyMat);
    body.scale.set(0.8, 0.8, 1.5);
    body.position.y = 0.95;
    body.castShadow = body.receiveShadow = true;
    g.add(body);

    const patch1 = new THREE.Mesh(boxGeo, patchMat);
    patch1.scale.set(0.84, 0.34, 0.55);
    patch1.position.set(0, 1.08, -0.25);
    g.add(patch1);
    const patch2 = new THREE.Mesh(boxGeo, patchMat);
    patch2.scale.set(0.84, 0.3, 0.4);
    patch2.position.set(0, 0.8, 0.3);
    g.add(patch2);

    const legs = [];
    for (const [lx, lz] of [[0.26, 0.52], [-0.26, 0.52], [0.26, -0.52], [-0.26, -0.52]]) {
      const leg = new THREE.Mesh(boxGeo, bodyMat);
      leg.scale.set(0.2, 0.62, 0.2);
      leg.position.set(lx, 0.31, lz);
      g.add(leg);
      legs.push(leg);
    }

    const head = new THREE.Group();
    head.position.set(0, 1.18, 0.72);
    const skull = new THREE.Mesh(boxGeo, bodyMat);
    skull.scale.set(0.42, 0.46, 0.5);
    skull.position.set(0, 0.08, 0.28);
    skull.castShadow = true;
    head.add(skull);
    const muzzle = new THREE.Mesh(boxGeo, mat(0xd99a9a));
    muzzle.scale.set(0.3, 0.2, 0.14);
    muzzle.position.set(0, -0.05, 0.56);
    head.add(muzzle);
    for (const sgn of [1, -1]) {
      const ear = new THREE.Mesh(boxGeo, patchMat);
      ear.scale.set(0.2, 0.07, 0.12);
      ear.position.set(sgn * 0.3, 0.22, 0.15);
      head.add(ear);
      const horn = new THREE.Mesh(cone4Geo, mat(0xe8dcc0, true));
      horn.scale.set(0.07, 0.28, 0.07);
      horn.position.set(sgn * 0.15, 0.4, 0.12);
      horn.rotation.z = -sgn * 0.4;
      head.add(horn);
    }
    g.add(head);

    const tail = new THREE.Mesh(boxGeo, patchMat);
    tail.scale.set(0.08, 0.55, 0.08);
    tail.position.set(0, 0.82, -0.78);
    tail.rotation.x = 0.35;
    g.add(tail);

    // праздничная гирлянда на шее — фестиваль же, саар!
    const garland = new THREE.Mesh(neckRingGeo, mat(0xff9f43));
    garland.position.set(0, 1.12, 0.62);
    garland.rotation.x = 1.35;
    g.add(garland);

    return { group: g, head, legs, tail };
  }

  function freeSpot(x, z) {
    let cx = x, cz = z;
    for (let k = 0; k < 60; k++) {
      if (Math.abs(cx) < 50 && Math.abs(cz) < 50 && !blocked(cx, cz, 1.2)) return { x: cx, z: cz };
      cx = x + (rng() - 0.5) * (4 + k * 0.8);
      cz = z + (rng() - 0.5) * (4 + k * 0.8);
    }
    return { x: 0, z: 8 };
  }

  const COW_LOOKS = [
    [0xf2ead8, 0x7b4b2a],
    [0xe8dbc4, 0x4a3524],
    [0xcfc8bd, 0x6b6259],
    [0xa9714b, 0x6b4226],
  ];
  const COW_SPOTS = [[16, -20], [-16, -34], [-36, 18], [30, 36]];
  for (let i = 0; i < 4; i++) {
    const parts = buildCow(COW_LOOKS[i][0], COW_LOOKS[i][1]);
    const spot = freeSpot(COW_SPOTS[i][0], COW_SPOTS[i][1]);
    parts.group.position.set(spot.x, 0, spot.z);
    parts.group.rotation.y = rng() * Math.PI * 2;
    dynamicGroup.add(parts.group);
    cowStates.push({
      group: parts.group, head: parts.head, legs: parts.legs, tail: parts.tail,
      state: 'idle', timer: 1 + rng() * 4,
      heading: parts.group.rotation.y, speed: 0.7, walkPhase: rng() * 6,
    });
    cows.push({
      object3d: parts.group,
      getPosition: () => parts.group.position,
      radius: 0.7,
      height: 1.4,
    });
  }

  /* ---------- кучки-пикапы ---------- */
  const PICKUP_MAX = 30;
  const pickups = [];
  {
    const mats = [mat(0x5a3a20, true), mat(0x4e3018, true)];
    for (let i = 0; i < PICKUP_MAX; i++) {
      const isCone = i % 3 === 0;
      const mesh = new THREE.Mesh(isCone ? cone8Geo : sphereGeo, mats[i % 2]);
      const s = 0.8 + rng() * 0.5;
      if (isCone) mesh.scale.set(0.34 * s, 0.3 * s, 0.34 * s);
      else mesh.scale.set(0.36 * s, 0.18 * s, 0.36 * s);
      mesh.rotation.y = rng() * Math.PI * 2;
      mesh.visible = false;
      dynamicGroup.add(mesh);
      pickups.push({
        mesh, active: false,
        baseY: (isCone ? 0.15 : 0.1) * s + 0.03,
        phase: rng() * Math.PI * 2,
      });
    }
  }

  function landmarksClear(x, z) {
    for (const lm of [landmarks.shop, landmarks.stall, landmarks.tuktukStand]) {
      const dx = x - lm.x, dz = z - lm.z;
      if (dx * dx + dz * dz < 9) return false;
    }
    return true;
  }

  function activatePickup(p, x, z) {
    p.active = true;
    p.mesh.visible = true;
    p.mesh.position.set(x, p.baseY, z);
  }

  // стартовая россыпь: ~25 кучек (часть у площади, часть по деревне)
  {
    let placedCount = 0;
    for (let i = 0; i < 25; i++) {
      for (let k = 0; k < 40; k++) {
        let px, pz;
        if (i < 12) {
          const a = rng() * Math.PI * 2, r = 3 + rng() * 8;
          px = Math.cos(a) * r; pz = Math.sin(a) * r;
        } else {
          px = (rng() * 2 - 1) * 50; pz = (rng() * 2 - 1) * 50;
        }
        if (!blocked(px, pz, 0.7) && landmarksClear(px, pz)) {
          activatePickup(pickups[placedCount++], px, pz);
          break;
        }
      }
    }
  }

  function collectPickup(pos, radius) {
    if (!pos) return 0;
    // не пылесосим кучки, которые некуда класть — пусть лежат
    const free = Math.max(0, (state.maxAmmo || 20) - (state.ammo || 0));
    if (free <= 0) return 0;
    const r = (typeof radius === 'number' ? radius : 1) + 0.45;
    const r2 = r * r;
    let n = 0;
    for (let i = 0; i < pickups.length && n < free; i++) {
      const p = pickups[i];
      if (!p.active) continue;
      const dx = p.mesh.position.x - pos.x, dz = p.mesh.position.z - pos.z;
      if (dx * dx + dz * dz <= r2) {
        p.active = false;
        p.mesh.visible = false;
        n++;
      }
    }
    return n;
  }

  let respawnT = 8;
  function respawnPickup() {
    let free = null;
    for (let i = 0; i < pickups.length; i++) {
      if (!pickups[i].active) { free = pickups[i]; break; }
    }
    if (!free) return; // все 30 на месте — куда больше, саар
    for (let k = 0; k < 12; k++) {
      const a = rng() * Math.PI * 2, r = 2.8 + rng() * 4.5;
      const px = Math.cos(a) * r, pz = Math.sin(a) * r;
      if (!blocked(px, pz, 0.6)) {
        activatePickup(free, px, pz);
        return;
      }
    }
  }

  /* ---------- мухи над праздничной кучей ---------- */
  const flies = [];
  for (let i = 0; i < 5; i++) {
    const fly = new THREE.Mesh(sphereGeo, mat(0x2a1c10));
    fly.scale.setScalar(0.07);
    fly.position.set(0, 2.4, 0);
    dynamicGroup.add(fly);
    flies.push(fly);
  }

  scene.add(dynamicGroup);

  /* ---------- анимация ---------- */

  function updateCows(dt, t) {
    for (let i = 0; i < cowStates.length; i++) {
      const c = cowStates[i];
      const g = c.group;
      c.timer -= dt;
      c.tail.rotation.z = Math.sin(t * 2.1 + i * 1.7) * 0.25;

      if (c.state === 'idle') {
        // пасётся: голова к траве, ноги в покое
        c.head.rotation.x += (0.55 - c.head.rotation.x) * Math.min(1, dt * 2.5);
        for (let j = 0; j < 4; j++) c.legs[j].rotation.x *= Math.max(0, 1 - dt * 6);
        if (c.timer <= 0) {
          c.state = 'walk';
          c.timer = 3 + Math.random() * 4;
          c.speed = 0.5 + Math.random() * 0.4;
          c.heading = Math.random() * Math.PI * 2;
        }
      } else {
        c.head.rotation.x += (0.05 + Math.sin(c.walkPhase * 2) * 0.05 - c.head.rotation.x) * Math.min(1, dt * 3);
        const diff = wrapAngle(c.heading - g.rotation.y);
        const maxTurn = 2.2 * dt;
        g.rotation.y += Math.max(-maxTurn, Math.min(maxTurn, diff));

        const step = c.speed * dt;
        const nx = g.position.x + Math.sin(g.rotation.y) * step;
        const nz = g.position.z + Math.cos(g.rotation.y) * step;
        if (Math.abs(nx) > 50 || Math.abs(nz) > 50) {
          c.heading = Math.atan2(-g.position.x, -g.position.z) + (Math.random() - 0.5);
        } else if (blocked(nx, nz, 1.0)) {
          c.heading = g.rotation.y + Math.PI * (0.6 + Math.random() * 0.8);
        } else {
          g.position.x = nx;
          g.position.z = nz;
        }
        c.walkPhase += dt * (4 + c.speed * 3);
        for (let j = 0; j < 4; j++) {
          c.legs[j].rotation.x = Math.sin(c.walkPhase + LEG_PHASE[j]) * 0.45;
        }
        if (c.timer <= 0) {
          c.state = 'idle';
          c.timer = 2 + Math.random() * 4;
        }
      }
    }
  }

  function updatePickups(dt, t) {
    respawnT -= dt;
    if (respawnT <= 0) {
      respawnT = 7 + Math.random() * 3;
      respawnPickup();
    }
    for (let i = 0; i < pickups.length; i++) {
      const p = pickups[i];
      if (!p.active) continue;
      p.mesh.position.y = p.baseY + Math.sin(t * 2.2 + p.phase) * 0.045;
      p.mesh.rotation.y = t * 0.6 + p.phase;
    }
  }

  function updateFlags(t) {
    for (let i = 0; i < flagData.length; i++) {
      const f = flagData[i];
      const swing = Math.sin(t * 2.4 + f.phase) * 0.35 + Math.sin(t * 5.1 + f.phase * 1.7) * 0.08;
      if (f.alongZ) {
        _q.setFromAxisAngle(Z_AXIS, swing);
        _q2.setFromAxisAngle(Y_AXIS, Math.PI / 2);
        _q.multiply(_q2);
      } else {
        _q.setFromAxisAngle(X_AXIS, swing);
      }
      _v.set(f.x, f.y, f.z);
      _s.setScalar(f.scale);
      _m.compose(_v, _q, _s);
      flagMesh.setMatrixAt(i, _m);
    }
    flagMesh.instanceMatrix.needsUpdate = true;
  }

  function updateFlies(t) {
    for (let i = 0; i < flies.length; i++) {
      const a = t * 1.6 + i * 1.31;
      const r = 1.2 + Math.sin(t * 2.3 + i) * 0.4;
      flies[i].position.set(Math.cos(a) * r, 2.3 + Math.sin(t * 3.1 + i * 2) * 0.35, Math.sin(a) * r);
    }
  }

  let errLogged = 0;
  function update(dt, t) {
    try {
      if (!(dt >= 0)) dt = 0.016;
      if (dt > 0.1) dt = 0.1;
      if (!(t >= 0)) t = 0;
      updateCows(dt, t);
      updatePickups(dt, t);
      updateFlags(t);
      updateFlies(t);
      for (let i = 0; i < bannerGroups.length; i++) {
        bannerGroups[i].rotation.z = Math.sin(t * 0.8 + i * 2.1) * 0.025;
      }
    } catch (e) {
      if (errLogged++ < 3) console.error('[world.update]', e);
    }
  }

  return {
    colliders,
    bounds: { minX: -56, maxX: 56, minZ: -56, maxZ: 56 },
    groundY: () => 0,
    landmarks,
    cows,
    collectPickup,
    update,
  };
}
