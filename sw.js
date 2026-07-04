// STAC · Service worker "red primero": siempre intenta traer la versión más
// reciente del sitio (para que las actualizaciones se vean al instante) y solo
// usa el caché como respaldo cuando no hay internet.
const CACHE = 'stac-v1';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(clients.claim()));

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  // Solo cachear recursos del propio sitio (no Supabase ni terceros)
  const sameOrigin = new URL(e.request.url).origin === location.origin;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (sameOrigin && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});
