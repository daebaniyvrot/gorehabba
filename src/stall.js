// Гарехабба — «НАВОЗ СААРА»: собственный ларёк игрока.
// Деревянная будка, прилавок с кучками, вывеска (CanvasTexture),
// цикл покупателей с торгом и ТОРГОВАЯ БИТВА с конкурентом (мини-игра на тайминг).
// Контракт: createStall(scene, world, player, npcs) -> { update(dt), tryInteract() -> bool }

import * as THREE from 'three';
import { state, bus, setMode, addMoney } from './state.js';
import { audio } from './audio.js';

const INTERACT_R2 = 3.5 * 3.5;
const ROAD_LINES = [-28, 0, 28];
const BATTLE_ROUNDS = 5;

function sfx(name, ...args) { try { if (audio && typeof audio[name] === 'function') audio[name](...args); } catch {} }
function toast(text, ms = 2000, cls) { bus.emit('toast', { text, ms, cls }); }
function nowMs() { return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now(); }
function randInt(a, b) { return a + Math.floor(Math.random() * (b - a + 1)); }
function plural(n) { return n === 1 ? 'лепёшку' : 'лепёшки'; }

function makeSignTexture(text, bg, fg, w = 640, h = 150, fontPx = 60) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d');
  g.fillStyle = bg; g.fillRect(0, 0, w, h);
  g.strokeStyle = fg; g.lineWidth = 10; g.strokeRect(6, 6, w - 12, h - 12);
  g.fillStyle = fg;
  g.font = `900 ${fontPx}px "Trebuchet MS", "Segoe UI", sans-serif`;
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(text, w / 2, h / 2 + 4);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// ближайшая точка на решётке дорог (полосы x/z = -28, 0, 28)
function nearestRoadPoint(x, z) {
  let best = { x: ROAD_LINES[0], z };
  let bestD = Math.abs(x - ROAD_LINES[0]);
  for (const rx of ROAD_LINES) {
    const d = Math.abs(x - rx);
    if (d < bestD) { bestD = d; best = { x: rx, z }; }
  }
  for (const rz of ROAD_LINES) {
    const d = Math.abs(z - rz);
    if (d < bestD) { bestD = d; best = { x, z: rz }; }
  }
  return best;
}

const _dir = new THREE.Vector3(); // временный вектор для горячих циклов

export function createStall(scene, world, player, npcs) {
  const lm = world && world.landmarks && world.landmarks.stall;
  const anchor = { x: lm ? lm.x : -20, z: lm ? lm.z : 14 };

  // ---------- переиспользуемые геометрии/материалы ----------
  const BOXG = new THREE.BoxGeometry(1, 1, 1);
  const CONEG = new THREE.ConeGeometry(1, 1, 7);
  const SPHEREG = new THREE.SphereGeometry(1, 8, 6);
  const mats = new Map();
  const mat = (color) => {
    if (!mats.has(color)) mats.set(color, new THREE.MeshLambertMaterial({ color, flatShading: true }));
    return mats.get(color);
  };
  function box(parent, w, h, d, color, x, y, z) {
    const m = new THREE.Mesh(BOXG, mat(color));
    m.scale.set(w, h, d); m.position.set(x, y, z);
    m.castShadow = true; m.receiveShadow = true;
    parent.add(m); return m;
  }
  function cone(parent, r, h, color, x, y, z) {
    const m = new THREE.Mesh(CONEG, mat(color));
    m.scale.set(r, h, r); m.position.set(x, y, z);
    m.castShadow = true;
    parent.add(m); return m;
  }

  // ---------- будка ----------
  const group = new THREE.Group();
  group.position.set(anchor.x, 0, anchor.z);
  group.rotation.y = Math.atan2(-anchor.x, -anchor.z); // лицом к площади
  scene.add(group);

  box(group, 3.4, 0.16, 2.6, '#8a5a2b', 0, 0.08, -0.1);            // помост
  const back = box(group, 3.2, 2.1, 0.14, '#9b6a3a', 0, 1.15, -1.15); // задняя стенка
  box(group, 0.14, 1.3, 2.0, '#9b6a3a', -1.55, 0.75, -0.25);       // бока
  box(group, 0.14, 1.3, 2.0, '#9b6a3a', 1.55, 0.75, -0.25);
  box(group, 0.13, 2.4, 0.13, '#8a5a2b', -1.55, 1.2, 0.95);        // передние столбы
  box(group, 0.13, 2.4, 0.13, '#8a5a2b', 1.55, 1.2, 0.95);
  const roof = box(group, 3.8, 0.13, 3.0, '#c0392b', 0, 2.52, -0.05); // крыша
  roof.rotation.x = 0.1;
  const counter = box(group, 3.2, 0.9, 0.75, '#a06a33', 0, 0.45, 0.95); // прилавок
  box(group, 3.4, 0.09, 0.95, '#c98d3e', 0, 0.94, 0.95);           // столешница

  // товар: кучки на прилавке + запасы сбоку
  cone(group, 0.24, 0.34, '#6b4423', -0.9, 1.16, 0.95);
  cone(group, 0.3, 0.42, '#6b4423', 0, 1.2, 0.9);
  cone(group, 0.22, 0.3, '#6b4423', 0.85, 1.14, 1.0);
  cone(group, 0.62, 0.8, '#5c3a17', 2.35, 0.4, 0.2);
  const fly = new THREE.Mesh(SPHEREG, mat('#2d2d2d'));              // муха над товаром
  fly.scale.setScalar(0.035);
  group.add(fly);

  // вывеска «НАВОЗ СААРА»
  const sign = new THREE.Mesh(
    new THREE.PlaneGeometry(2.9, 0.68),
    new THREE.MeshBasicMaterial({ map: makeSignTexture('💩 НАВОЗ СААРА 💩', '#ffe66d', '#5c3a17'), side: THREE.DoubleSide })
  );
  sign.position.set(0, 2.98, 0.3);
  group.add(sign);

  group.updateMatrixWorld(true);
  const counterFront = new THREE.Vector3(0, 0, 2.3).applyMatrix4(group.matrixWorld); counterFront.y = 0;
  const rivalSpot = new THREE.Vector3(1.9, 0, 2.2).applyMatrix4(group.matrixWorld); rivalSpot.y = 0;
  const exitPoint = nearestRoadPoint(anchor.x, anchor.z);

  // Повёрнутый бокс нельзя брать одним AABB — он раздувается и накрывает
  // точку покупателя. Режем на 4 сегмента вдоль длинной (локальной X) оси.
  function pushSegmentedCollider(mesh, segs = 4) {
    const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
    mesh.updateWorldMatrix(true, false);
    mesh.matrixWorld.decompose(p, q, s);
    const e = new THREE.Euler().setFromQuaternion(q, 'YXZ');
    const cos = Math.abs(Math.cos(e.y)), sin = Math.abs(Math.sin(e.y));
    const ax = new THREE.Vector3(1, 0, 0).applyQuaternion(q);
    for (let i = 0; i < segs; i++) {
      const off = ((i + 0.5) / segs - 0.5) * s.x;
      const cx = p.x + ax.x * off, cz = p.z + ax.z * off;
      const hx = (s.x / (2 * segs)) * cos + (s.z / 2) * sin;
      const hz = (s.x / (2 * segs)) * sin + (s.z / 2) * cos;
      world.colliders.push(new THREE.Box3(
        new THREE.Vector3(cx - hx, Math.max(0, p.y - s.y / 2), cz - hz),
        new THREE.Vector3(cx + hx, p.y + s.y / 2, cz + hz)
      ));
    }
  }
  try {
    if (world && Array.isArray(world.colliders)) {
      pushSegmentedCollider(counter);
      pushSegmentedCollider(back);
    }
  } catch {}

  // запасной болванчик, если npcs.makeVillagerMesh недоступен
  function makeFallbackVillager() {
    const g = new THREE.Group();
    box(g, 0.5, 0.75, 0.28, '#9b59b6', 0, 0.85, 0);
    const h = new THREE.Mesh(SPHEREG, mat('#c68642'));
    h.scale.setScalar(0.17); h.position.set(0, 1.45, 0); h.castShadow = true;
    g.add(h);
    return g;
  }

  // ---------- состояние сессии ----------
  let panel = null;
  let statusEl = null, stockEl = null, logEl = null, noteEl = null;
  let btnSell = null, btnHaggle = null, btnRefuse = null, btnRow = null;
  let battleBox = null, roundEl = null, zoneEl = null, markerEl = null;
  let closedAt = -1e9;

  let customer = null;      // handle от npcs.spawnCustomer
  let deal = null;          // { qty, price, patience, maxPatience, haggles, battled }
  let waitTimer = 0;        // отсчёт до следующего покупателя
  let walkWatch = 0;        // страховка, если walkTo не вызовет колбэк
  let hawkTimer = 8;        // периодическое «Саар, халлоу саар!»
  let rival = null;         // { mesh, phase:'approach'|'fight'|'leaving', tx, tz, bob, speed }
  let battle = null;        // { round, score, pos, dir, speed, zoneL, zoneW, roundTimer, running, endDelay, won }

  // ---------- мелкие помощники ----------
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
  function playerFloat(text, big) {
    const p = playerPos();
    if (!p) return;
    const msg = { pos: { x: p.x, y: p.y + 2.1, z: p.z }, text, color: '#ffe66d' };
    if (big) msg.size = 'big';
    bus.emit('floating', msg);
  }
  function floatCustomer(text) {
    if (!customer) return;
    try {
      const p = customer.getPosition ? customer.getPosition() : null;
      if (p) bus.emit('floating', { pos: { x: p.x, y: p.y + 1.9, z: p.z }, text, color: '#ffe9c7' });
    } catch {}
  }
  function floatRival(text, big) {
    if (!rival || !rival.mesh) return;
    const m = rival.mesh;
    const msg = { pos: { x: m.position.x, y: m.position.y + 2.0, z: m.position.z }, text, color: '#ff8a7a' };
    if (big) msg.size = 'big';
    bus.emit('floating', msg);
  }
  function log(text) {
    if (!logEl) return;
    const line = document.createElement('div');
    line.textContent = text;
    logEl.appendChild(line);
    while (logEl.children.length > 8) logEl.removeChild(logEl.firstChild);
    logEl.scrollTop = logEl.scrollHeight;
  }
  function setStatus(text) { if (statusEl) statusEl.textContent = text; }

  function refreshStock() {
    if (stockEl) stockEl.textContent = `Товар на прилавке: 💩 × ${state.ammo}`;
  }
  function refreshStatus() {
    if (!statusEl || battle) return;
    if (deal) {
      const bars = '▮'.repeat(Math.max(0, deal.patience)) + '▯'.repeat(Math.max(0, deal.maxPatience - deal.patience));
      setStatus(`Хочет ${deal.qty} ${plural(deal.qty)} · даёт ₹${deal.price}/шт · терпение ${bars}`);
    } else if (customer) {
      setStatus('Покупатель идёт к прилавку...');
    } else {
      setStatus('Ждём покупателей, саар...');
    }
  }
  function refreshButtons() {
    if (!panel) return;
    const busy = !!battle || (rival && rival.phase === 'approach');
    const canDeal = !!deal && !busy;
    if (btnSell) {
      btnSell.textContent = deal ? `Продать за ₹${deal.qty * deal.price}` : 'Продать';
      btnSell.disabled = !canDeal || (deal && state.ammo < deal.qty);
    }
    if (noteEl) noteEl.textContent = (deal && state.ammo < deal.qty) ? 'нет товара' : '';
    if (btnHaggle) btnHaggle.disabled = !canDeal;
    if (btnRefuse) btnRefuse.disabled = !canDeal;
  }

  function scheduleNext() {
    waitTimer = 1.5 + Math.random() * 2.5;
    refreshStatus();
  }

  // ---------- сделки ----------
  function startDeal() {
    if (!panel || deal) return;
    deal = {
      qty: randInt(1, 3),
      price: randInt(15, 25),
      patience: randInt(3, 5),
      haggles: 0,
      battled: false,
    };
    deal.maxPatience = deal.patience;
    floatCustomer(`Саар! ${deal.qty} ${plural(deal.qty)} по ₹${deal.price}?`);
    log(`Покупатель хочет ${deal.qty} ${plural(deal.qty)} по ₹${deal.price} за штуку.`);
    refreshButtons(); refreshStatus();
  }

  function finishDeal() {
    if (customer) {
      try { if (typeof customer.leave === 'function') customer.leave(); } catch {}
      customer = null;
    }
    deal = null;
    walkWatch = 0;
    scheduleNext();
    refreshButtons(); refreshStatus();
  }

  function doSell(unitPrice) {
    if (!deal || state.ammo < deal.qty) return;
    const qty = deal.qty;
    state.ammo -= qty;
    bus.emit('ammoChanged', {});
    const total = qty * unitPrice;
    addMoney(total);
    state.stats.sold++;
    bus.emit('saleMade', { price: unitPrice, qty });
    sfx('chaChing');
    log(`Продано ${qty} × ₹${unitPrice} = +₹${total}. Хорошая сделка, саар!`);
    floatCustomer('Спасибо, саар!');
    finishDeal();
  }

  function onSell() {
    if (!deal || battle || (rival && rival.phase === 'approach')) return;
    doSell(deal.price);
  }

  function onHaggle() {
    if (!deal || battle || (rival && rival.phase === 'approach')) return;
    deal.price += randInt(3, 6);
    deal.haggles++;
    deal.patience--;
    floatCustomer('Ай, дорого, саар!');
    if (deal.patience <= 0) {
      floatCustomer('Ну нет, саар, ухожу!');
      log('Терпение покупателя кончилось — он ушёл.');
      finishDeal();
      return;
    }
    log(`Торг! Теперь цена ₹${deal.price}/шт.`);
    refreshButtons(); refreshStatus();
    if (deal.haggles >= 3 && !deal.battled && Math.random() < 0.5) startBattleIntro();
  }

  function onRefuse() {
    if (!deal || battle || (rival && rival.phase === 'approach')) return;
    floatCustomer('Эх, саар...');
    log('Ты вежливо отказал покупателю.');
    finishDeal();
  }

  // ---------- покупатели ----------
  function spawnCustomerNow() {
    if (!panel || customer || battle || rival) return;
    let c = null;
    try {
      if (npcs && typeof npcs.spawnCustomer === 'function') {
        c = npcs.spawnCustomer({ x: exitPoint.x, y: 0, z: exitPoint.z });
      }
    } catch {}
    if (!c || typeof c.walkTo !== 'function') {
      try { if (c && typeof c.remove === 'function') c.remove(); } catch {}
      setStatus('Покупателей пока не видно... Подождём, саар.');
      waitTimer = 4;
      return;
    }
    customer = c;
    walkWatch = 12; // страховка на случай молчащего walkTo
    refreshStatus();
    try {
      c.walkTo({ x: counterFront.x, y: 0, z: counterFront.z }, () => {
        if (panel && customer === c && !deal && !battle) startDeal();
      });
    } catch {
      if (panel && customer === c) startDeal();
    }
  }

  // ---------- торговая битва ----------
  function startBattleIntro() {
    if (!deal || rival || battle) return;
    deal.battled = true;
    let mesh = null;
    try {
      if (npcs && typeof npcs.makeVillagerMesh === 'function') mesh = npcs.makeVillagerMesh();
    } catch {}
    if (!mesh) mesh = makeFallbackVillager();
    mesh.position.set(exitPoint.x, 0, exitPoint.z);
    scene.add(mesh);
    rival = { mesh, phase: 'approach', tx: rivalSpot.x, tz: rivalSpot.z, bob: 0, speed: 5.5 };
    setStatus('Погоди-ка... сюда бежит конкурент!');
    log('⚔️ К прилавку бежит торговец-конкурент!');
    refreshButtons();
  }

  function rivalArrived() {
    rival.phase = 'fight';
    floatRival('СААР! У меня дешевле, саар!', true);
    sfx('shout', true);
    setMode('battle');
    bus.emit('battleStart', {});
    buildBattleUI();
    // на таче целиться пальцем труднее — зона шире, маркер спокойнее
    const touchy = document.body.classList.contains('touch-device');
    battle = {
      round: 1, score: 0,
      pos: 0, dir: 1, speed: touchy ? 1.25 : 1.6,
      zoneL: 0.4, zoneW: touchy ? 0.3 : 0.2,
      zoneWBase: touchy ? 0.26 : 0.16, // newZone() строит ширину от этой базы
      roundTimer: 6, running: true,
      endDelay: 0, won: false,
    };
    newZone();
    updateRoundEl();
    setStatus(touchy
      ? 'ТОРГОВАЯ БИТВА! Маркер в зелёной зоне — тапай «СААР!» или экран!'
      : 'ТОРГОВАЯ БИТВА! Маркер в зелёной зоне — жми Q!');
    log('Кто громче крикнет «СААР!» — тот и продаёт.');
    refreshButtons();
  }

  function buildBattleUI() {
    if (!panel || battleBox) return;
    battleBox = document.createElement('div');
    battleBox.style.cssText = 'margin:10px 0;padding:10px 12px;border:1px dashed rgba(255,210,140,.45);border-radius:12px;';
    const title = document.createElement('div');
    title.style.fontWeight = '900';
    title.textContent = '⚔️ ТОРГОВАЯ БИТВА: перекричи конкурента!';
    roundEl = document.createElement('div');
    roundEl.className = 'desc';
    const track = document.createElement('div');
    track.className = 'bar-track';
    zoneEl = document.createElement('div');
    zoneEl.className = 'zone';
    markerEl = document.createElement('div');
    markerEl.className = 'bar-marker';
    track.appendChild(zoneEl);
    track.appendChild(markerEl);
    track.addEventListener('click', onBattleTap);
    const hint = document.createElement('div');
    hint.className = 'desc';
    hint.textContent = 'Q или клик по шкале, когда маркер в зелёной зоне';
    battleBox.appendChild(title);
    battleBox.appendChild(roundEl);
    battleBox.appendChild(track);
    battleBox.appendChild(hint);
    if (btnRow && btnRow.parentNode === panel) panel.insertBefore(battleBox, btnRow);
    else panel.appendChild(battleBox);
  }

  function removeBattleUI() {
    if (battleBox) { try { battleBox.remove(); } catch {} }
    battleBox = null; roundEl = null; zoneEl = null; markerEl = null;
  }

  function newZone() {
    if (!battle) return;
    // база зависит от устройства (на таче шире), случайный разброс поверх
    const base = battle.zoneWBase || 0.16;
    battle.zoneW = base + Math.random() * 0.08;
    battle.zoneL = Math.random() * (1 - battle.zoneW);
    if (zoneEl) {
      zoneEl.style.left = (battle.zoneL * 100).toFixed(1) + '%';
      zoneEl.style.width = (battle.zoneW * 100).toFixed(1) + '%';
    }
  }

  function updateRoundEl() {
    if (roundEl && battle) {
      roundEl.textContent = `Раунд ${Math.min(battle.round, BATTLE_ROUNDS)}/${BATTLE_ROUNDS} · твои крики: ${battle.score}`;
    }
  }

  function onBattleTap() {
    if (!battle || !battle.running) return;
    resolveRound(battle.pos >= battle.zoneL && battle.pos <= battle.zoneL + battle.zoneW);
  }

  function resolveRound(hit) {
    if (!battle || !battle.running) return;
    if (hit) {
      battle.score++;
      playerFloat('СААР!', true);
      sfx('shout', true);
      log(`Раунд ${battle.round}: попал! Твой «СААР!» гремит на весь базар!`);
    } else {
      floatRival('СААААР!!', true);
      sfx('shout', true);
      log(`Раунд ${battle.round}: мимо — конкурент кричит громче...`);
    }
    if (battle.round >= BATTLE_ROUNDS) {
      battle.running = false;
      battle.won = battle.score >= 3;
      battle.endDelay = 0.8;
      updateRoundEl();
      setStatus(battle.won ? 'Базар слышал только тебя, саар!' : 'Конкурент горланит как паровоз...');
      return;
    }
    battle.round++;
    battle.speed *= 1.18; // с каждым раундом быстрее
    battle.roundTimer = 6;
    newZone();
    updateRoundEl();
  }

  function endBattle(won) {
    const wasDeal = deal;
    battle = null;
    removeBattleUI();
    if (won) {
      state.stats.battlesWon++;
      toast('🏆 Победа! Ты перекричал конкурента, саар!', 2600);
      if (wasDeal && state.ammo >= wasDeal.qty) {
        doSell(wasDeal.price + 10); // впечатлённый покупатель платит больше
      } else {
        addMoney(30);
        sfx('chaChing');
        log('Товара нет, но покупатель дал ₹30 «за харизму», саар!');
        finishDeal();
      }
    } else {
      toast('Конкурент оказался громче... В другой раз, саар!', 2600, 'error');
      log('Покупатель ушёл к конкуренту.');
      finishDeal();
    }
    bus.emit('battleEnd', { won });
    if (rival) {
      rival.phase = 'leaving';
      rival.tx = exitPoint.x;
      rival.tz = exitPoint.z;
      rival.speed = 4;
    }
    if (panel) setMode('stall');
    refreshButtons(); refreshStatus();
  }

  function removeRival() {
    if (!rival) return;
    try { scene.remove(rival.mesh); } catch {}
    rival = null;
  }

  // ---------- панель ----------
  function buildPanel() {
    const root = document.getElementById('panels');
    if (!root) return false;

    panel = document.createElement('div');
    panel.className = 'panel';

    const h2 = document.createElement('h2');
    h2.textContent = '💩 Ларёк «НАВОЗ СААРА»';
    panel.appendChild(h2);

    const sub = document.createElement('div');
    sub.className = 'desc';
    sub.textContent = 'Твой бизнес, саар! Свежайший товар с самой праздничной кучи.';
    sub.style.marginBottom = '8px';
    panel.appendChild(sub);

    statusEl = document.createElement('div');
    statusEl.style.cssText = 'font-weight:800;margin:8px 0;min-height:20px;';
    panel.appendChild(statusEl);

    stockEl = document.createElement('div');
    stockEl.className = 'desc';
    panel.appendChild(stockEl);

    logEl = document.createElement('div');
    logEl.style.cssText = 'font-size:13px;opacity:.85;max-height:120px;overflow-y:auto;margin:8px 0;line-height:1.45;border-top:1px dashed rgba(255,210,140,.2);padding-top:6px;';
    panel.appendChild(logEl);

    btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:10px 0;';
    btnSell = document.createElement('button');
    btnSell.className = 'btn primary';
    btnSell.addEventListener('click', onSell);
    btnHaggle = document.createElement('button');
    btnHaggle.className = 'btn';
    btnHaggle.textContent = 'Поторговаться';
    btnHaggle.addEventListener('click', onHaggle);
    btnRefuse = document.createElement('button');
    btnRefuse.className = 'btn';
    btnRefuse.textContent = 'Отказать';
    btnRefuse.addEventListener('click', onRefuse);
    noteEl = document.createElement('span');
    noteEl.className = 'desc';
    noteEl.style.color = '#ff8a7a';
    btnRow.appendChild(btnSell);
    btnRow.appendChild(btnHaggle);
    btnRow.appendChild(btnRefuse);
    btnRow.appendChild(noteEl);
    panel.appendChild(btnRow);

    const footer = document.createElement('div');
    footer.style.cssText = 'display:flex;justify-content:flex-end;margin-top:6px;';
    const closeBtn = document.createElement('button');
    closeBtn.className = 'btn';
    closeBtn.textContent = 'Закрыть ларёк';
    closeBtn.addEventListener('click', () => closeStall());
    footer.appendChild(closeBtn);
    panel.appendChild(footer);

    root.appendChild(panel);
    return true;
  }

  function closeStall(backToWalk = true) {
    if (!panel) return;
    const el = panel;
    panel = null;
    if (battle) {
      if (!battle.running) endBattle(battle.won); // исход уже решён — не отбираем победу
      else { battle = null; bus.emit('battleEnd', { won: false }); }
    }
    removeBattleUI();
    removeRival();
    if (customer) {
      try { if (typeof customer.leave === 'function') customer.leave(); } catch {}
      customer = null;
    }
    deal = null;
    waitTimer = 0;
    walkWatch = 0;
    statusEl = stockEl = logEl = noteEl = null;
    btnSell = btnHaggle = btnRefuse = btnRow = null;
    try { el.remove(); } catch {}
    closedAt = nowMs();
    sfx('click');
    if (backToWalk) setMode('walk');
  }

  // постоянные подписки (guard'ы внутри)
  bus.on('battleTap', () => { try { onBattleTap(); } catch {} });
  bus.on('ammoChanged', () => { if (panel) { refreshButtons(); refreshStock(); } });
  bus.on('modeChanged', (d) => {
    // режим сменили извне (не наши 'stall'/'battle') — молча прибираемся
    if (panel && d && d.mode !== 'stall' && d.mode !== 'battle') closeStall(false);
  });
  window.addEventListener('keydown', (e) => {
    if (!panel) return;
    if (e.code === 'Escape') { e.preventDefault(); closeStall(); }
    else if (e.code === 'KeyE' && state.mode === 'stall') { e.preventDefault(); closeStall(); }
  });

  // ---------- API ----------
  function tryInteract() {
    if (panel || state.mode !== 'walk') return false;
    if (nowMs() - closedAt < 250) return false; // то же нажатие E, что закрыло панель
    if (distSqToAnchor() > INTERACT_R2) return false;
    if (!buildPanel()) { panel = null; return false; }
    setMode('stall');
    playerFloat('Саар, халлоу саар!', true);
    sfx('shout');
    log('Ларёк открыт! Зазываем покупателей...');
    refreshButtons(); refreshStatus(); refreshStock();
    scheduleNext();
    hawkTimer = 8;
    return true;
  }

  function updateRival(dt) {
    const m = rival.mesh;
    if (rival.phase === 'fight') {
      rival.bob += dt * 3;
      m.position.y = Math.abs(Math.sin(rival.bob)) * 0.04;
      return;
    }
    _dir.set(rival.tx - m.position.x, 0, rival.tz - m.position.z);
    const d = Math.sqrt(_dir.x * _dir.x + _dir.z * _dir.z);
    if (d < 0.2) {
      if (rival.phase === 'approach') rivalArrived();
      else removeRival(); // ушёл
      return;
    }
    const step = Math.min(d, rival.speed * dt);
    m.position.x += (_dir.x / d) * step;
    m.position.z += (_dir.z / d) * step;
    m.rotation.y = Math.atan2(_dir.x, _dir.z);
    rival.bob += dt * 11;
    m.position.y = Math.abs(Math.sin(rival.bob)) * 0.12;
  }

  function updateBattle(dt) {
    if (battle.running) {
      battle.pos += battle.dir * battle.speed * dt;
      if (battle.pos > 1) { battle.pos = 2 - battle.pos; battle.dir = -1; }
      if (battle.pos < 0) { battle.pos = -battle.pos; battle.dir = 1; }
      if (markerEl) markerEl.style.left = `calc(${(battle.pos * 100).toFixed(1)}% - 3px)`;
      battle.roundTimer -= dt;
      if (battle.roundTimer <= 0) resolveRound(false); // прозевал раунд — промах
    } else if (battle.endDelay > 0) {
      battle.endDelay -= dt;
      if (battle.endDelay <= 0) endBattle(battle.won);
    }
  }

  function sessionUpdate(dt) {
    // очередь покупателей
    if (waitTimer > 0 && !customer && !battle && !rival) {
      waitTimer -= dt;
      if (waitTimer <= 0) spawnCustomerNow();
    }
    // страховка: покупатель идёт слишком долго — начинаем сделку
    if (customer && !deal && !battle) {
      walkWatch -= dt;
      if (walkWatch <= 0) { walkWatch = 0; startDeal(); }
    }
    // зазывание, пока пусто
    if (!customer && !battle && !rival) {
      hawkTimer -= dt;
      if (hawkTimer <= 0) {
        hawkTimer = 7 + Math.random() * 4;
        playerFloat('Саар, халлоу саар!');
        sfx('shout');
      }
    }
    if (rival) updateRival(dt);
    if (battle) updateBattle(dt);
  }

  let t = Math.random() * 10;

  function update(dt) {
    try {
      t += dt;
      sign.rotation.z = Math.sin(t * 1.3) * 0.03; // вывеска покачивается
      fly.position.set(0.15 + Math.sin(t * 5.1) * 0.35, 1.55 + Math.sin(t * 7.3) * 0.12, 0.9 + Math.cos(t * 4.2) * 0.3);

      if (!panel) {
        if (state.mode === 'walk' && distSqToAnchor() < INTERACT_R2) {
          bus.emit('prompt', { text: 'E — твой ларёк' });
        }
        if (rival) removeRival(); // страховка: панели нет — конкуренту тут нечего делать
        return;
      }
      sessionUpdate(dt);
    } catch (e) { /* update не должен ронять кадр */ }
  }

  return { update, tryInteract };
}
