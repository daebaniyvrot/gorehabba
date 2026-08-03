// net.js — сетевой слой «Гарехаббы»: лёгкий co-presence мультиплеер.
// Подключается к ws(s)://<host>/ws, шлёт снапшоты ~10 Гц, рисует удалённых
// игроков (низкополигональные саары из боксов) и их броски лепёшек.
// Сеть может рваться, JSON — быть битым, поля — мусорными: ни одно
// сообщение не должно уронить кадр, всё проверяется и завёрнуто в try/catch.
import * as THREE from 'three';
import { state, bus } from './state.js';
import { audio } from './audio.js';

// WS-путь строится относительно страницы: / → /ws, /fest/ → /fest/ws (реверс-прокси)
const SNAP_INTERVAL = 0.1;   // 10 Гц
const INTERP_DELAY = 0.12;   // рендер удалённых с задержкой 120 мс
const BACKOFF_MIN = 1000;    // реконнект: 1 с → …
const BACKOFF_MAX = 15000;   // … → максимум 15 с
const MAX_SPEED = 6.2;       // ~максимум скорости игрока (шлёпанцы), для mv 0..1
const HIT_TOAST_CD = 1.0;    // кулдаун тоста «Попал по …»
const LAUGH_DIST = 25;       // смех слышен, если игрока стукнули в 25 м
const MAX_REMOTES = 24;      // страховка от мусорных id
const NAME_KEY = 'garehabba-name';

const TWO_PI = Math.PI * 2;
const DIRT_COLOR = new THREE.Color(0x503214); // бурая навозная грязь (как у игрока)

// ---------- мелкие помощники ----------
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const num = (v, def = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
};
const round2 = (v) => Math.round(v * 100) / 100;
const round3 = (v) => Math.round(v * 1000) / 1000;
const nowSec = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now()) / 1000;

function cleanName(v) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, 16);
}

// читает [x,y,z] из массива в out; вернёт false, если данные мусорные
function readVec(a, out) {
  if (!Array.isArray(a) || a.length < 3) return false;
  const x = Number(a[0]), y = Number(a[1]), z = Number(a[2]);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return false;
  out.x = x; out.y = y; out.z = z;
  return true;
}
const _vA = { x: 0, y: 0, z: 0 };
const _vB = { x: 0, y: 0, z: 0 };

// стабильный хэш id → оттенок рубашки 0..1
function hashHue(str) {
  let h = 2166136261;
  const s = String(str);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 360) / 360;
}

function roundRectPath(c, x, y, w, h, r) {
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}

// ---------- общая геометрия/материалы удалённых сааров ----------
const GEO = {
  leg: (() => { const g = new THREE.BoxGeometry(0.17, 0.78, 0.19); g.translate(0, -0.39, 0); return g; })(),
  arm: (() => { const g = new THREE.BoxGeometry(0.14, 0.62, 0.16); g.translate(0, -0.27, 0); return g; })(),
  torso: new THREE.BoxGeometry(0.56, 0.6, 0.32),
  head: new THREE.SphereGeometry(0.17, 8, 6),
  cap: new THREE.CylinderGeometry(0.19, 0.19, 0.1, 8),
  pole: new THREE.CylinderGeometry(0.025, 0.025, 1.3, 6),
  dome: new THREE.ConeGeometry(0.9, 0.38, 8),
};
const MAT = {
  skin: new THREE.MeshLambertMaterial({ color: 0xc98a54, flatShading: true }),
  pants: new THREE.MeshLambertMaterial({ color: 0xf1e6c8, flatShading: true }),
  pole: new THREE.MeshLambertMaterial({ color: 0x6b4a2b, flatShading: true }),
  umb: new THREE.MeshLambertMaterial({ color: 0x2ecc71, flatShading: true }),
};

function addMesh(geo, mat, parent) {
  const m = new THREE.Mesh(geo, mat);
  m.castShadow = true;
  parent.add(m);
  return m;
}

// бейдж с именем — Sprite с CanvasTexture (имя рисуется текстом, безопасно)
function makeBadge(name) {
  const cnv = document.createElement('canvas');
  cnv.width = 256; cnv.height = 64;
  const c = cnv.getContext('2d');
  if (c) {
    c.font = 'bold 30px "Trebuchet MS", system-ui, sans-serif';
    const w = clamp(c.measureText(name).width + 30, 64, 244);
    c.fillStyle = 'rgba(24, 14, 6, 0.62)';
    roundRectPath(c, (256 - w) / 2, 8, w, 48, 14);
    c.fill();
    c.fillStyle = '#ffe8c8';
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillText(name, 128, 33);
  }
  const tex = new THREE.CanvasTexture(cnv);
  if ('colorSpace' in tex) tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(1.7, 0.425, 1);
  sprite.position.y = 2.1;
  return { sprite, tex, mat };
}

// ================================================================
export function createNet(opts = {}) {
  const scene = opts.scene || null;
  const player = opts.player || null;
  const projectiles = opts.projectiles || null;

  // ---------- состояние соединения ----------
  let ws = null;
  let connected = false;
  let myId = null;
  let sentName = '';
  let backoff = BACKOFF_MIN;
  let reconnectTimer = null;
  let solo = false;            // среда без WebSocket / file:// — тихий одиночный режим
  let warned = false;          // не больше одного предупреждения в консоль
  let fastReconnect = false;   // мягкий реконнект ради имени
  let fullNotified = false;
  let welcomedOnce = false;
  let count = 0;               // игроков онлайн (включая меня)
  let now = nowSec();
  let lastHitToastT = -HIT_TOAST_CD;

  // удалённые игроки
  const remotes = new Map();   // id -> remote
  const remoteList = [];       // для горячего цикла без итераторов
  const proxies = new Map();   // 'net:<id>' -> {remote, pos} (цели physics живут вечно)

  let chipEl = null;
  let sendAcc = 0;
  const lastSent = { x: 0, z: 0, t: 0, has: false };

  function warnOnce(where, e) {
    if (warned) return;
    warned = true;
    console.warn('[net] мультиплеер прилёг, играем в одиночку, саар.', where || '', e || '');
  }

  // ---------- HUD-чип «👥 N» ----------
  function updateChip() {
    try {
      if (!chipEl || !chipEl.isConnected) {
        const hud = document.getElementById('hud');
        if (!hud) return;
        chipEl = document.createElement('div');
        chipEl.className = 'chip';
        chipEl.id = 'hud-net';
        chipEl.title = 'Саары онлайн';
        hud.appendChild(chipEl);
      }
      chipEl.textContent = (connected && myId != null) ? `👥 ${Math.max(1, count)}` : '👥 —';
    } catch (e) { /* HUD не критичен */ }
  }

  // ---------- удалённые игроки ----------
  function buildRemote(id, name) {
    const group = new THREE.Group();
    group.visible = false; // покажем после первой известной позиции

    const shirtBase = new THREE.Color().setHSL(hashHue(id), 0.72, 0.55);
    const shirtMat = new THREE.MeshLambertMaterial({ color: shirtBase.clone(), flatShading: true });

    // ноги (пивот в бедре)
    const legL = new THREE.Group(); legL.position.set(0.13, 0.78, 0); group.add(legL);
    const legR = new THREE.Group(); legR.position.set(-0.13, 0.78, 0); group.add(legR);
    addMesh(GEO.leg, MAT.pants, legL);
    addMesh(GEO.leg, MAT.pants, legR);

    // верх тела
    const lean = new THREE.Group(); lean.position.y = 0.78; group.add(lean);
    addMesh(GEO.torso, shirtMat, lean).position.y = 0.27;
    addMesh(GEO.head, MAT.skin, lean).position.y = 0.74;
    addMesh(GEO.cap, shirtMat, lean).position.y = 0.87;

    // руки (пивот в плече)
    const armL = new THREE.Group(); armL.position.set(0.35, 0.54, 0); lean.add(armL);
    const armR = new THREE.Group(); armR.position.set(-0.35, 0.54, 0); lean.add(armR);
    addMesh(GEO.arm, MAT.skin, armL);
    addMesh(GEO.arm, MAT.skin, armR);

    // упрощённый зонтик
    const umb = new THREE.Group();
    umb.visible = false;
    umb.rotation.x = 0.22;
    group.add(umb);
    addMesh(GEO.pole, MAT.pole, umb).position.y = 1.75;
    addMesh(GEO.dome, MAT.umb, umb).position.y = 2.3;

    // бейдж имени на высоте ~2.1
    const badge = makeBadge(name);
    group.add(badge.sprite);

    return {
      id, name, group, legL, legR, armL, armR, lean, umb,
      shirtMat, shirtBase, badge,
      buf: [],                       // буфер снапшотов {t,x,y,z,ry,mv}
      phase: Math.random() * TWO_PI, // фаза анимации ходьбы
      swing: 0,
      d: 0, u: false,
      lastSnapT: 0,
    };
  }

  function registerProxy(id, r) {
    const tid = 'net:' + id;
    const existing = proxies.get(tid);
    if (existing) { existing.remote = r; return; }
    const proxy = { remote: r, pos: new THREE.Vector3() };
    proxies.set(tid, proxy);
    if (!projectiles || typeof projectiles.registerTarget !== 'function') return;
    try {
      projectiles.registerTarget({
        id: tid,
        radius: 0.35,
        height: 1.7,
        getPosition() {
          const rr = proxy.remote;
          if (!rr || !rr.group.visible) return proxy.pos.set(0, -999, 0); // «мёртвая» цель
          return proxy.pos.copy(rr.group.position);
        },
        onHit(info) {
          try {
            const rr = proxy.remote;
            if (!rr) return;
            if (info && info.owner === 'player' && now - lastHitToastT >= HIT_TOAST_CD) {
              lastHitToastT = now;
              bus.emit('toast', { text: `Попал по ${rr.name}! 🎯`, ms: 1600 });
            }
          } catch (e) { /* не роняем physics */ }
        },
      });
    } catch (e) { warnOnce('registerTarget', e); }
  }

  function addRemote(id, rawName, init) {
    try {
      let r = remotes.get(id);
      if (r) return r;
      if (remoteList.length >= MAX_REMOTES) return null;
      const name = cleanName(rawName) || ('Саар-' + String(id).slice(0, 4));
      r = buildRemote(id, name);
      remotes.set(id, r);
      remoteList.push(r);
      if (scene) scene.add(r.group);
      registerProxy(id, r);
      if (init) {
        if (readVec(init.p, _vA)) pushSnap(r, _vA.x, _vA.y, _vA.z, num(init.ry, 0), 0);
        applyLook(r, clamp(num(init.d, 0), 0, 100), !!init.u);
      }
      return r;
    } catch (e) { warnOnce('addRemote', e); return null; }
  }

  function removeRemote(id) {
    const r = remotes.get(id);
    if (!r) return;
    remotes.delete(id);
    const i = remoteList.indexOf(r);
    if (i >= 0) remoteList.splice(i, 1);
    const proxy = proxies.get('net:' + id);
    if (proxy && proxy.remote === r) proxy.remote = null; // цель уходит в (0,-999,0)
    try {
      if (scene) scene.remove(r.group);
      r.shirtMat.dispose();
      r.badge.tex.dispose();
      r.badge.mat.dispose();
    } catch (e) { /* уборка не критична */ }
  }

  function clearRemotes() {
    const ids = [];
    remotes.forEach((_, id) => ids.push(id));
    for (let i = 0; i < ids.length; i++) removeRemote(ids[i]);
  }

  function pushSnap(r, x, y, z, ry, mv) {
    const t = nowSec();
    const b = r.buf;
    b.push({ t, x, y, z, ry, mv });
    if (b.length > 12) b.shift();
    r.lastSnapT = t;
    if (!r.group.visible) { // первое появление — без интерполяции
      r.group.position.set(x, y, z);
      r.group.rotation.y = ry;
      r.group.visible = true;
    }
  }

  function applyLook(r, d, u) {
    r.d = d;
    r.u = !!u;
    r.umb.visible = r.u;
    // грязь затемняет рубашку (и кепку — общий материал)
    r.shirtMat.color.copy(r.shirtBase).lerp(DIRT_COLOR, (d / 100) * 0.75);
  }

  // интерполяция + анимация; НИКАКИХ аллокаций Vector3 — только скаляры
  function animateRemote(r, rt, dt) {
    const b = r.buf;
    if (b.length === 0 || !r.group.visible) return;
    while (b.length > 2 && b[1].t <= rt) b.shift();
    const a0 = b[0];
    const a1 = b.length > 1 ? b[1] : a0;
    const span = a1.t - a0.t;
    const k = span > 1e-4 ? clamp((rt - a0.t) / span, 0, 1) : 1;

    const x = a0.x + (a1.x - a0.x) * k;
    const y = a0.y + (a1.y - a0.y) * k;
    const z = a0.z + (a1.z - a0.z) * k;
    let dyaw = a1.ry - a0.ry;
    dyaw = ((dyaw + Math.PI) % TWO_PI + TWO_PI) % TWO_PI - Math.PI; // кратчайшая дуга
    const ry = a0.ry + dyaw * k;
    const mv = a0.mv + (a1.mv - a0.mv) * k;

    // ходьба: качание рук/ног + лёгкое подпрыгивание
    r.phase += dt * (4 + 8 * mv);
    const target = mv > 0.1 ? clamp(mv * 1.6, 0, 1) : 0;
    r.swing += (target - r.swing) * Math.min(1, dt * 10);
    const s = Math.sin(r.phase) * 0.6 * r.swing;
    r.legL.rotation.x = s;
    r.legR.rotation.x = -s;
    r.armL.rotation.x = -s * 0.8;
    r.armR.rotation.x = r.u ? -2.4 : s * 0.8; // с зонтом рука поднята
    r.lean.rotation.x = 0.14 * r.swing;
    const bob = Math.abs(Math.sin(r.phase)) * 0.06 * r.swing;

    r.group.position.set(x, y + bob, z);
    r.group.rotation.y = ry;
  }

  // ---------- исходящие ----------
  function send(obj) {
    if (!ws || ws.readyState !== 1) return;
    try { ws.send(JSON.stringify(obj)); } catch (e) { /* сеть могла порваться между кадрами */ }
  }

  function resolveName() {
    let name = '';
    try {
      const el = document.getElementById('player-name');
      if (el && typeof el.value === 'string') name = el.value;
    } catch (e) { /* DOM не критичен */ }
    name = cleanName(name);
    if (!name) {
      try { name = cleanName(localStorage.getItem(NAME_KEY) || ''); } catch (e) { /* private mode */ }
    }
    return name;
  }

  function sendHi() {
    sentName = resolveName();
    if (sentName) {
      try { localStorage.setItem(NAME_KEY, sentName); } catch (e) { /* private mode */ }
    }
    send({ t: 'hi', name: sentName });
  }

  function maybeSendSnapshot(dt) {
    sendAcc += dt;
    if (sendAcc < SNAP_INTERVAL) return;
    sendAcc = 0;
    if (!connected || !ws || ws.readyState !== 1) return;
    if (!player || state.mode === 'menu') return;
    let px, py, pz;
    try {
      const p = player.getPosition(); // переиспользуемый Vector3 — копируем сразу
      px = p.x; py = p.y; pz = p.z;
    } catch (e) { return; }
    if (!Number.isFinite(px) || !Number.isFinite(py) || !Number.isFinite(pz)) return;

    let mv = 0;
    if (lastSent.has) {
      const el = Math.max(0.05, now - lastSent.t);
      const dx = px - lastSent.x, dz = pz - lastSent.z;
      mv = clamp(Math.sqrt(dx * dx + dz * dz) / el / MAX_SPEED, 0, 1);
    }
    lastSent.x = px; lastSent.z = pz; lastSent.t = now; lastSent.has = true;

    let ry = 0;
    try {
      if (player.object3d && player.object3d.rotation) ry = num(player.object3d.rotation.y, 0);
    } catch (e) { /* пусть будет 0 */ }

    send({
      t: 's',
      p: [round2(px), round2(py), round2(pz)],
      ry: round3(ry),
      mv: round2(mv),
      d: Math.round(clamp(num(state.dirtiness, 0), 0, 100)),
      u: !!state.umbrellaUp,
    });
  }

  // ---------- входящие ----------
  function handleMsg(m) {
    switch (m.t) {
      case 'welcome': {
        myId = String(m.id == null ? '' : m.id);
        clearRemotes();
        const arr = Array.isArray(m.players) ? m.players : [];
        for (let i = 0; i < arr.length; i++) {
          const p = arr[i];
          if (!p || p.id == null) continue;
          const id = String(p.id);
          if (id === myId) continue;
          addRemote(id, p.name, p);
        }
        count = remoteList.length + 1;
        updateChip();
        if (!welcomedOnce && remoteList.length > 0) {
          welcomedOnce = true;
          bus.emit('toast', { text: `🌐 Ты не один, саар! Игроков онлайн: ${count}`, ms: 2600 });
        }
        break;
      }
      case 'join': {
        const id = String(m.id == null ? '' : m.id);
        if (!id || id === myId) break;
        const r = addRemote(id, m.name, null);
        count = remoteList.length + 1;
        updateChip();
        if (r) bus.emit('toast', { text: `👋 ${r.name} заглянул на фестиваль, саар!`, ms: 2200 });
        break;
      }
      case 'leave': {
        const id = String(m.id == null ? '' : m.id);
        const r = remotes.get(id);
        if (r) {
          bus.emit('toast', { text: `${r.name} ушёл с фестиваля 🙏`, ms: 1800 });
          removeRemote(id);
        }
        count = remoteList.length + 1;
        updateChip();
        break;
      }
      case 's': {
        const id = String(m.id == null ? '' : m.id);
        if (!id || id === myId) break;
        if (!readVec(m.p, _vA)) break;
        if (Math.abs(_vA.x) > 400 || Math.abs(_vA.z) > 400 || _vA.y < -50 || _vA.y > 200) break;
        const r = remotes.get(id) || addRemote(id, null, null);
        if (!r) break;
        pushSnap(r, _vA.x, _vA.y, _vA.z, num(m.ry, 0), clamp(num(m.mv, 0), 0, 1));
        applyLook(r, clamp(num(m.d, r.d), 0, 100), !!m.u);
        break;
      }
      case 'throw': {
        const id = String(m.id == null ? '' : m.id);
        if (!id || id === myId) break;
        if (!projectiles || typeof projectiles.throwDung !== 'function') break;
        if (!readVec(m.from, _vA) || !readVec(m.dir, _vB)) break;
        if (Math.abs(_vA.x) > 400 || Math.abs(_vA.z) > 400 || Math.abs(_vA.y) > 200) break;
        projectiles.throwDung({
          from: new THREE.Vector3(_vA.x, _vA.y, _vA.z), // тут аллокация допустима
          dir: new THREE.Vector3(_vB.x, _vB.y, _vB.z),
          power: clamp(num(m.power, 0.5), 0, 1),
          owner: 'net:' + id, // может попасть и в МОЕГО игрока — так задумано
        });
        break;
      }
      case 'shout': {
        const r = remotes.get(String(m.id == null ? '' : m.id));
        if (!r || !r.group.visible) break;
        const gp = r.group.position;
        bus.emit('floating', { pos: { x: gp.x, y: gp.y + 2.4, z: gp.z }, text: 'СААР!', size: 'big' });
        try { audio.shout(); } catch (e) { /* звук не критичен */ }
        break;
      }
      case 'hit': {
        const r = remotes.get(String(m.id == null ? '' : m.id));
        if (!r || !r.group.visible || !player) break;
        let dx = 0, dy = 0, dz = 0;
        try {
          const pp = player.getPosition(); // переиспользуемый Vector3 — читаем сразу
          dx = r.group.position.x - pp.x;
          dy = r.group.position.y - pp.y;
          dz = r.group.position.z - pp.z;
        } catch (e) { break; }
        if (dx * dx + dy * dy + dz * dz <= LAUGH_DIST * LAUGH_DIST) {
          try { audio.laugh(); } catch (e) { /* звук не критичен */ }
        }
        break;
      }
      case 'n': {
        count = clamp(Math.round(num(m.count, count)), 0, 999);
        updateChip();
        break;
      }
      case 'full': {
        if (!fullNotified) {
          fullNotified = true;
          bus.emit('toast', { text: '😔 Фестиваль переполнен, саар! Попробуем зайти попозже.', ms: 3200 });
        }
        backoff = BACKOFF_MAX; // ждём терпеливо — вдруг место освободится
        break;
      }
      default:
        break; // незнакомые сообщения молча игнорируем
    }
  }

  function onMessage(ev) {
    let m = null;
    try {
      if (!ev || typeof ev.data !== 'string' || ev.data.length > 65536) return;
      m = JSON.parse(ev.data);
    } catch (e) { return; } // битый JSON — не наша печаль
    if (!m || typeof m.t !== 'string') return;
    try { handleMsg(m); } catch (e) { warnOnce('handleMsg:' + m.t, e); }
  }

  // ---------- жизненный цикл соединения ----------
  function scheduleReconnect(delayMs) {
    if (solo || reconnectTimer) return;
    const ms = typeof delayMs === 'number' ? delayMs : backoff;
    backoff = Math.min(BACKOFF_MAX, Math.round(backoff * 1.8));
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, ms);
  }

  function onOpen() {
    connected = true;
    backoff = BACKOFF_MIN;
    try { sendHi(); } catch (e) { warnOnce('hi', e); }
    updateChip();
  }

  function onClose() {
    const wasFast = fastReconnect;
    fastReconnect = false;
    connected = false;
    myId = null;
    ws = null;
    count = 0;
    try { clearRemotes(); } catch (e) { /* уборка не критична */ }
    updateChip();
    scheduleReconnect(wasFast ? 200 : undefined);
  }

  function connect() {
    if (solo) return;
    try {
      if (typeof WebSocket === 'undefined') { solo = true; warnOnce('нет WebSocket'); return; }
      const loc = window.location;
      if (!loc || !loc.host) { solo = true; warnOnce('нет host (file://?)'); return; }
      const dir = loc.pathname.endsWith('/')
        ? loc.pathname
        : loc.pathname.replace(/[^/]*$/, '');
      const url = (loc.protocol === 'https:' ? 'wss://' : 'ws://') + loc.host + dir + 'ws';
      ws = new WebSocket(url);
    } catch (e) {
      warnOnce('connect', e);
      ws = null;
      scheduleReconnect();
      return;
    }
    ws.onopen = onOpen;
    ws.onmessage = onMessage;
    ws.onclose = onClose;
    ws.onerror = () => { /* onclose придёт следом — там и реконнект */ };
  }

  // ---------- подписки на локальные события ----------
  bus.on('playerThrow', (d) => {
    try {
      if (!connected || !d || !d.from || !d.dir) return;
      const fx = num(d.from.x, NaN), fy = num(d.from.y, NaN), fz = num(d.from.z, NaN);
      const dx = num(d.dir.x, NaN), dy = num(d.dir.y, NaN), dz = num(d.dir.z, NaN);
      if (![fx, fy, fz, dx, dy, dz].every(Number.isFinite)) return;
      send({
        t: 'throw',
        from: [round2(fx), round2(fy), round2(fz)],
        dir: [round3(dx), round3(dy), round3(dz)],
        power: clamp(num(d.power, 0.5), 0, 1),
      });
    } catch (e) { /* сеть не должна ронять бросок */ }
  });

  bus.on('playerShout', () => {
    try { if (connected) send({ t: 'shout' }); } catch (e) { /* тихо */ }
  });

  bus.on('playerHit', () => {
    try { if (connected) send({ t: 'hit' }); } catch (e) { /* тихо */ }
  });

  // игра началась, а имя в 'hi' ушло пустым (игрок ещё не напечатал)?
  // Тихий быстрый реконнект — представимся по-настоящему.
  bus.on('modeChanged', (d) => {
    try {
      if (!d || d.mode === 'menu') return;
      const want = resolveName();
      if (want && want !== sentName && ws && ws.readyState === 1) {
        fastReconnect = true;
        backoff = BACKOFF_MIN;
        try { ws.close(); } catch (e) { /* уже закрыт */ }
      }
    } catch (e) { /* не критично */ }
  });

  // ---------- init ----------
  try {
    // дружелюбие: подставить сохранённое имя в пустое поле на стартовом экране
    const el = document.getElementById('player-name');
    if (el && typeof el.value === 'string' && !el.value) {
      const saved = cleanName(localStorage.getItem(NAME_KEY) || '');
      if (saved) el.value = saved;
    }
  } catch (e) { /* private mode / нет DOM */ }
  updateChip();
  connect();

  // ---------- кадр ----------
  function update(dt) {
    try {
      if (!(dt > 0)) dt = 0;
      now = nowSec();
      maybeSendSnapshot(dt);
      const rt = now - INTERP_DELAY;
      for (let i = 0; i < remoteList.length; i++) animateRemote(remoteList[i], rt, dt);
    } catch (e) { warnOnce('update', e); }
  }

  return { update };
}
