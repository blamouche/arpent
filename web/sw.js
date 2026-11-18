// Service worker : l'app s'ouvre hors ligne (capture sur le terrain sans réseau).
// Réseau d'abord pour toujours avoir la dernière version, cache en secours.
// Les appels à l'API Panoramax (autre origine) ne passent pas par ici.

// Version lue dans l'URL du service worker (sw.js?v=NN, enregistré par app.js) : un cache par
// version, les anciens sont supprimés à l'activation.
const VERSION = new URL(self.location).searchParams.get('v');
const CACHE = `arpent-${VERSION ? `v${VERSION}` : 'dev'}`;
const v = VERSION ? `?v=${VERSION}` : '';
const ASSETS = [
  './',
  './index.html',
  // Mêmes URL que celles demandées par index.html (version comprise), pour le hors-ligne.
  ...['style.css', 'app.js', 'db.js', 'exif.js', 'panoramax.js', 'sensors.js', 'demo-data.js'].map((f) => `./${f}${v}`),
  './vendor/maplibre/maplibre-gl.js',
  './vendor/keep-awake.mp4',
  './vendor/maplibre/maplibre-gl.css',
  './manifest.webmanifest',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
];

// Le cache HTTP du navigateur garde les fichiers quelques minutes (10 min sur GitHub Pages).
// Les fichiers versionnés y échappent par leur URL ; pour le reste (index.html surtout, qui fixe
// la version), on le contourne : `reload` à l'installation, `no-cache` (revalidation auprès du
// serveur, 304 si inchangé) à chaque requête.
const fresh = (request, cache) => (request.mode === 'navigate'
  ? new Request(request.url, { cache, credentials: request.credentials }) // une requête de navigation ne peut pas être recopiée avec des options
  : new Request(request, { cache }));

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(ASSETS.map((url) => new Request(url, { cache: 'reload' }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;
  event.respondWith(
    fetch(fresh(request, 'no-cache'))
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then((c) => c.put(request, copy));
        }
        return response;
      })
      .catch(() => caches.match(request, { ignoreSearch: true }).then((r) => r || caches.match('./index.html'))),
  );
});
