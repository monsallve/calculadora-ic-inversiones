/* Vault service worker v13 */
const CACHE_NAME = 'vault-v13';
const ASSETS = [
  './',
  './index.html',
  './css/styles.css',
  './js/app.js',
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
    // Navegación: red primero, fallback a index cacheado
    if (req.mode === 'navigate') {
      try {
        const net = await fetch(req);
        const cache = await caches.open(CACHE_NAME);
        try { await cache.put('./index.html', net.clone()); } catch (e) {}
        return net;
      } catch {
        return (await caches.match('./index.html'))
          || (await caches.match('./'))
          || new Response('Sin conexión', { status: 503 });
      }
    }

    const cached = await caches.match(req);
    if (cached) return cached;

    try {
      const net = await fetch(req);
      if (net && net.ok) {
        try {
          const cache = await caches.open(CACHE_NAME);
          await cache.put(req, net.clone());
        } catch (e) {}
      }
      return net;
    } catch {
      return cached || Response.error();
    }
  })());
});
