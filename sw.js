// Service worker : rend l'appli installable et la garde utilisable hors ligne.
// - Fichiers du site : réseau d'abord (on a toujours la dernière version en ligne), copie en
//   cache pour le hors ligne.
// - Moteur, SDK Firebase et polices : cache d'abord. Leurs adresses changent à chaque version,
//   une copie ne devient donc jamais fausse, et le moteur (7 Mo) ne se retélécharge pas.
// - chess.com, Lichess et Firestore ne passent pas par ici : toujours en direct.
const CACHE = 'salle-analyse-v1';
const SHELL = ['./', 'index.html', 'style.css', 'app.js', 'core.js', 'chess.js', 'sources.js', 'partage.js',
  'firebase-config.js', 'gazette.js', 'ouvertures.json', 'manifest.json', 'icones/icon-192.png'];
const FOREVER = [/\/moteur\//, /^https:\/\/www\.gstatic\.com\/firebasejs\//, /^https:\/\/fonts\.(googleapis|gstatic)\.com\//];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

async function cacheFirst(req) {
  const hit = await caches.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok || res.type === 'opaque') (await caches.open(CACHE)).put(req, res.clone());
  return res;
}
async function networkFirst(req) {
  try {
    const res = await fetch(req);
    if (res.ok) (await caches.open(CACHE)).put(req, res.clone());
    return res;
  } catch (err) {
    // Hors ligne : la copie du même fichier, quelle que soit sa version (?v=…) ou le code de groupe.
    const hit = await caches.match(req, { ignoreSearch: true }) || (req.mode === 'navigate' && await caches.match('index.html'));
    if (hit) return hit;
    throw err;
  }
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = req.url;
  if (FOREVER.some((r) => r.test(url))) { e.respondWith(cacheFirst(req)); return; }
  if (new URL(url).origin === self.location.origin) e.respondWith(networkFirst(req));
});
