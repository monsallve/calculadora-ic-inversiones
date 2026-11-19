/* Monsallve Financiero SW v11 — red primero, así los arreglos llegan a la PWA */
const CACHE_NAME = 'monsallve-v11';

const ASSETS = [
  './',
  './index.html',
  './css/styles.css',
  './js/app.js',
  './js/i18n.js',
  './js/firebase-client.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-192.png',
  './icons/icon-maskable-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await Promise.all(ASSETS.map(async (url) => {
      try {
        const res = await fetch(url, { cache: 'reload' });
        if (res.ok) await cache.put(url, res.clone());
      } catch (e) {}
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  event.respondWith((async () => {
    let sameOrigin = false;
    try { sameOrigin = new URL(req.url).origin === self.location.origin; } catch (e) { /* ignore */ }

    if (req.mode === 'navigate' || sameOrigin) {
      try {
        const net = await fetch(req);
        if (net && (net.ok || req.mode === 'navigate')) {
          try {
            const cache = await caches.open(CACHE_NAME);
            const key = req.mode === 'navigate' ? './index.html' : req;
            await cache.put(key, net.clone());
          } catch (e) { /* ignore */ }
        }
        return net;
      } catch (e) {
        if (req.mode === 'navigate') {
          return (await caches.match('./index.html'))
            || (await caches.match('./'))
            || (await caches.match(req))
            || new Response('Sin conexión', { status: 503, statusText: 'Offline' });
        }
        return (await caches.match(req)) || Response.error();
      }
    }

    try {
      return await fetch(req);
    } catch (e) {
      return (await caches.match(req)) || Response.error();
    }
  })());
});
