// Единый uid игрока для скорборда (POST /api/score) и мультиплеера ('hi').
// localStorage с памятью-фолбэком: в private mode оба канала всё равно ходят
// с ОДНИМ id — иначе сервер копит игровое время не тому, кто постит очки.
const KEY = 'garehabba-uid';
let cached = '';

export function getUid() {
  if (cached) return cached;
  try {
    const saved = localStorage.getItem(KEY);
    if (saved) {
      cached = String(saved).slice(0, 64);
      return cached;
    }
  } catch (e) { /* private mode — живём в памяти */ }
  let uid = '';
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      uid = crypto.randomUUID();
    }
  } catch (e) { /* fallback ниже */ }
  if (!uid) uid = 'saar-' + Math.random().toString(36).slice(2) + '-' + Date.now().toString(36);
  cached = uid.slice(0, 64);
  try { localStorage.setItem(KEY, cached); } catch (e) { /* ок, in-memory */ }
  return cached;
}
