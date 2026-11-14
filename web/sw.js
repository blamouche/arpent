// Service worker : l'app s'ouvre hors ligne (capture sur le terrain sans réseau).
// Réseau d'abord pour toujours avoir la dernière version, cache en secours.
// Les appels à l'API Panoramax (autre origine) ne passent pas par ici.

const CACHE = 'arpent-v13';
const ASSETS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './db.js',
  './exif.js',
  './panoramax.js',
  './sensors.js',
  './demo-data.js',
  './vendor/maplibre/maplibre-gl.js',
  './vendor/maplibre/maplibre-gl.css',
  './manifest.webmanifest',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
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
    fetch(request)
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
