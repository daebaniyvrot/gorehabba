# INTERFACES — контракт модулей (при конфликте со SPEC.md главнее этот файл)

Все модули — ES modules в `src/`. `import * as THREE from 'three'` (import map).
`src/state.js` и `src/main.js` уже написаны — их НЕ менять. main.js вызывает
ровно те API, что описаны ниже; реализуйте сигнатуры буквально.

## Владение файлами

| Агент     | Файлы                                     |
|-----------|-------------------------------------------|
| world     | src/world.js                              |
| player    | src/player.js                             |
| physics   | src/physics.js                            |
| npc       | src/npc.js                                |
| commerce  | src/shop.js, src/stall.js                 |
| ride      | src/tuktuk.js, src/audio.js               |
| meta      | src/quests.js, src/photo.js, src/ui.js    |

Проверка синтаксиса обязательна: `node --check src/<file>.js` (package.json
имеет `"type":"module"`, поэтому ESM парсится).

## state.js (готов)

```js
export const state = {
  money, dirtiness /*0..100*/, stink /*0..100*/, ammo, maxAmmo /*20*/,
  items: { slippers, umbrella, mask }, umbrellaUp,
  mode, // 'menu'|'walk'|'shop'|'stall'|'tuktuk'|'photo'|'battle'
  stats: { thrown, hits, timesHit, sold, photos, goodPhotos, battlesWon, rides, cowsHit },
  quests: {},        // id -> {progress, done} — пишет только quests.js
  questLines: [],    // [{id,title,desc,progress,target,done,reward}] — пишет quests.js, читает ui.js
  playerPos,
};
export const bus = { on(ev,fn)->unsub, emit(ev,data) };
export function setMode(m); addMoney(n); addAmmo(n);
export function save(); load()->bool; hasSave()->bool; resetSave();
```

## События шины (канонический список — не выдумывать другие имена)

| Событие         | payload                                | кто эмитит → кто слушает |
|-----------------|----------------------------------------|--------------------------|
| toast           | {text, ms?, cls?}                      | все → ui |
| prompt          | {text}                                 | shop/stall/tuktuk во время update при близости → ui (показывает кадр, сам гасит) |
| floating        | {pos:{x,y,z}, text, color?, size?('big')} | все → ui (3D-текст) |
| charge          | {p:0..1}                               | player → ui (шкала замаха) |
| throw           | {owner}                                | physics при броске → quests |
| playerHit       | {owner}                                | player.onHit → npc (смех), quests, ui |
| npcHit          | {owner, npc}                           | npc.onHit → quests |
| cowHit          | {owner}                                | main (регистрирует коров) → main же (штраф только при owner==='player') |
| playerShout     | {pos:{x,y,z}}                          | player → npc (реакция) |
| battleTap       | {}                                     | player (Q в mode battle) → stall |
| itemBought      | {id}                                   | shop → quests |
| saleMade        | {price, qty}                           | stall → quests |
| battleStart     | {}                                     | stall → (ui опц.) |
| battleEnd       | {won}                                  | stall → quests |
| photoTaken      | {score, comment}                       | photo → quests |
| rideStart       | {dest}                                 | tuktuk |
| rideEnd         | {dest}                                 | tuktuk → quests |
| questCompleted  | {id, title, reward}                    | quests → ui (тост делает quests сам через toast) |
| moneyChanged    | {delta}                                | state.addMoney |
| ammoChanged     | {}                                     | state.addAmmo |
| modeChanged     | {mode}                                 | state.setMode |
| saved           | {}                                     | state.save → ui («Сохранено ✓») |

Кто инкрементит статистику: physics → stats.thrown (owner==='player');
player.onHit → stats.timesHit; npc.onHit(owner==='player') → stats.hits;
stall → stats.sold, stats.battlesWon; photo → stats.photos, stats.goodPhotos;
tuktuk → stats.rides; main → stats.cowsHit.

## Сигнатуры модулей

### world.js
```js
export function initWorld(scene) -> {
  colliders: THREE.Box3[],          // AABB зданий/крупных препятствий (НЕ коровы)
  bounds: {minX:-56, maxX:56, minZ:-56, maxZ:56},
  groundY(x, z) -> 0,
  landmarks: {square, temple, shop, stall, tuktukStand, gate}, // THREE.Vector3
  cows: [{object3d, getPosition()->Vector3, radius:0.7, height:1.4}], // 4 шт, бродят
  collectPickup(pos:Vector3, radius:number) -> number, // собрать кучки рядом, вернуть кол-во
  update(dt, t),
}
```
Кучки-пикапы: ~25 на старте, респавн у центральной кучи (до 30 всего).
Дороги/кварталы/ориентиры — строго по SPEC.md (тук-тук ездит по решётке дорог).

### physics.js
```js
export function createProjectiles(scene, world) -> {
  throwDung({from:Vector3, dir:Vector3/*норм.*/, power:0..1, owner:string}),
  registerTarget({id, getPosition()->Vector3, radius, height,
                  onHit({owner, velocity:Vector3, point:Vector3})}),
  threats(pos:Vector3, horizonSec) -> [{pos, vel, timeToImpact}], // для уворотов NPC
  update(dt),
}
```
owner id: 'player', 'npc:<i>', 'rival'. Снаряд не бьёт своего владельца.
Скорость 8–22 м/с от power, гравитация ~14, один отскок (restitution 0.3),
затем шлепок-декаль (живёт ~20 с) + бурые частицы. Пулы: ≤40 снарядов, ≤80 декалей.
Попадание в target с id 'player'/'npc:*'/'cow:*' → target.onHit(...), снаряд лопается.
Также эмитит bus 'throw' {owner} на каждый бросок.

### player.js
```js
export function createPlayer(scene, world, camera, projectiles) -> {
  object3d, radius:0.35, height:1.7,
  getPosition() -> Vector3,
  update(dt),
  addDirt(amount, point?), cleanUp(),
  teleport(pos:{x,y,z}, yaw?),
  setVisible(v),        // тук-тук прячет игрока на время поездки
}
```
Сам регистрирует себя в projectiles (id 'player'). onHit: если зонт раскрыт и
снаряд летит спереди (velocity·forward < -0.2) → блок (звук, декаль на зонте,
без грязи); иначе addDirt(15) + emit 'playerHit' + тряска камеры.
Движение только в mode 'walk'|'photo'. Скорость 4.2 (×1.45 шлёпанцы, ×0.8 зонт),
прыжок 6.5, гравитация 18, коллизии с world.colliders (вытолкнуть по XZ) и bounds.
Камера от 3-го лица (yaw/pitch мышью, pointer lock по клику на canvas, fallback
drag). ЛКМ: замах (emit 'charge' каждый кадр), отпустить → projectiles.throwDung,
state.ammo--; если ammo 0 → toast «Кончились лепёшки, саар!». ПКМ — зонт
(state.umbrellaUp, видимая модель). Q: mode 'battle' → emit 'battleTap';
иначе крик — audio.shout(), floating «СААР!» size big, emit 'playerShout'.
Владеет state.stink: растёт от ammo>0 и dirtiness, маска ограничивает ≤20.
Грязь: пятна-спрайты на теле (≤12) + потемнение одежды от dirtiness.

### npc.js
```js
export function createNPCs(scene, world, projectiles, player) -> {
  list, // [{object3d, getPosition(), dirty:0..100}]
  update(dt),
  spawnCustomer(pos:{x,y,z}) -> {object3d, getPosition(), walkTo(pos, cb), leave(), remove()},
  makeVillagerMesh() -> THREE.Group, // переиспользуют tuktuk (водитель) и stall (конкурент)
}
```
~22 жителя: бродят по улицам (обходят коллайдеры), кидаются в игрока и друг
в друга (каденция 2.5–6 c, упреждение), уворачиваются от projectiles.threats
(шаг вбок), пачкаются (dirty + пятна). На 'playerHit' ближайшие (< 12 м)
поворачиваются, подпрыгивают, floating «Ха-ха!»/«Вах!», audio.laugh().
На 'playerShout' рядом стоящие иногда отвечают floating «Саар!».
Каждый регистрируется как target (id 'npc:<i>'); onHit: dirty+=20, если
owner==='player' → stats.hits++, emit 'npcHit'.

### shop.js
```js
export function createShop(scene, world, player) -> { update(dt), tryInteract() -> bool }
```
Стенд у landmarks.shop, продавец (можно простой), рядом → emit 'prompt'
«E — магазин». tryInteract: если рядом (<3.5 м) — открыть DOM-панель
(добавить в #panels), setMode('shop'), вернуть true. Товары и цены — SPEC.
Покупка: addMoney(-цена), items/эффекты, emit 'itemBought'; мешок → addAmmo(10);
стирка → player.cleanUp(). Закрытие: кнопка/Esc/E → setMode('walk').

### stall.js
```js
export function createStall(scene, world, player, npcs) -> { update(dt), tryInteract() -> bool }
```
Ларёк у landmarks.stall. E рядом → setMode('stall'), панель ларька, игрок
за прилавком (floating от игрока: «Саар, халлоу саар!»). Покупатели:
npcs.spawnCustomer, подходят, хотят 1–3 лепёшки, стартовое предложение
₹15–25/шт. Кнопки: [Продать] (нужно ammo ≥ qty; ammo-=qty, addMoney,
stats.sold++, emit 'saleMade'), [Поторговаться] (+₹3–6 к цене, терпение
3–5 → уходит), [Отказать]. Суммарно ≥3 торга за сделку → 50% шанс: приходит
конкурент (npcs.makeVillagerMesh, кричит «СААР! У меня дешевле, саар!») →
битва: setMode('battle'), emit 'battleStart'; мини-игра: бегущий маркер,
5 раундов, попадание в зелёную зону по 'battleTap' (Q) или клику;
≥3 успехов → победа (продажа по цене+₹10, stats.battlesWon++), иначе
покупатель уходит к конкуренту. emit 'battleEnd' {won}, вернуть mode 'stall'.
Выход из ларька → setMode('walk').

### tuktuk.js
```js
export function createTuktuks(scene, world, player) -> { update(dt), tryInteract() -> bool }
```
3 фоновых тук-тука ездят по решётке дорог (полосы x/z = -28,0,28), сигналят
раз в 1–2 c (audio.honk с затуханием по дистанции до игрока). Рабочий тук-тук
на landmarks.tuktukStand с водителем (npcs.makeVillagerMesh). E → панель
выбора: храм ₹15, площадь ₹10, магазин ₹12, ларёк ₹12. Поездка: setMode('tuktuk'),
player.setVisible(false), emit 'rideStart', чейз-камера позади тук-тука
(видно дорогу и виляние), маршрут по дорогам
(манхэттен по решётке), скорость 8–14 с рывками и вилянием (синус + случайные
дёрги), тряска камеры, honk каждые ~1 c, audio.music(true) громко, floating
водителя «Саар, держись!». Прибытие: высадить (teleport рядом с целью,
setVisible(true)), setMode('walk'), music(false), stats.rides++, emit 'rideEnd' {dest}.

### audio.js
```js
export const audio = {
  init(),                 // создать AudioContext (вызывает main по клику)
  honk(gain=1), splat(), laugh(), shout(big=false), chaChing(), thud(),
  click(), camera(), moo(), whoosh(),
  crowd(on),              // фоновый гул фестиваля
  music(on),              // громкая тук-тук-музыка (синтез-лупы)
};
```
Все звуки синтезированы (осцилляторы/шум), никаких файлов. До init() любые
вызовы — тихие no-op. Мастер-громкость ≤0.6, музыка «громкая» относительно.

### quests.js
```js
export function createQuests() -> { update(dt) }  // update нужен квесту untouched
```
Определения — таблица в SPEC.md. Подписки на события шины (см. таблицу выше).
Ведёт state.quests и state.questLines (обновлять при каждом изменении).
Завершение: addMoney(reward), audio.chaChing(), toast «✅ Квест „…“ +₹…»,
emit 'questCompleted'.

### photo.js
```js
export function createPhotoMode(scene, camera, renderer, refs /*{world, player, npcs}*/) -> {
  active, toggle(), update(dt)
}
```
toggle: показать/скрыть #photo-ui (видоискатель), fov 70→50 и обратно,
setMode('photo'|'walk'). В active: ЛКМ по канвасу (или в pointer lock) →
вспышка, audio.camera(), renderer.domElement.toDataURL (preserveDrawingBuffer
уже включён) → миниатюра (стек до 3 в углу). Оценка 0–100: NPC в кадре +8
(грязный +4), корова +20, праздничная куча (landmarks.square) +12 (<30 м),
храм +15 (проверка по двум высотам), композиция +12 при ближайшем объекте
в 4–22 м, случайность ±5. Комментарий по диапазону
(«Шедевр, саар!» / «Неплохо, саар» / «Ну такое…»). stats.photos++,
score≥50 → stats.goodPhotos++. emit 'photoTaken'.

### ui.js
```js
export function createUI() -> { update(dt, camera), toggleQuests() }
```
Обновляет HUD из state: #hud-money, #hud-ammo, #hud-dirt .fill, #hud-stink .fill,
#hud-items (🩴☂️😷 при наличии), #hud-quest (трекер: первый незавершённый из
state.questLines). Тосты (bus 'toast', cls 'error' — красный), prompt (показ
последнего emit'а кадра, сам очищает), floating-тексты (проекция через camera,
живут ~1.4 c, всплывают), шкала замаха (bus 'charge'), #stink-overlay
(opacity от state.stink, 0 при маске почти), квест-панель (#quest-panel,
Tab — toggleQuests, рендер из state.questLines), «Сохранено ✓» на 'saved'.

## DOM (index.html готов)

Есть: #game (канвас туда), #hud (+ готовые чипы, см. id выше), #prompt,
#toasts, #floatings, #stink-overlay, #panels (сюда модалки shop/stall/tuktuk),
#photo-ui, #quest-panel, #charge (шкала), #start-screen (main владеет).
CSS-классы: .panel, .panel h2, .btn, .btn.primary, .btn:disabled, .row,
.hidden, .toast, .toast.error, .floating, .floating.big, .meter, .meter .fill.

## Клавиши (владение)

player.js: WASD/стрелки, Space, ЛКМ/ПКМ, Q, мышь. main.js: E, P, Tab.
Панели могут слушать Escape и E для закрытия — при открытой панели main
не диспатчит E (mode !== 'walk').
