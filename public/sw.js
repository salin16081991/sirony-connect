/* Service worker for Connect.
 *
 * Privacy rule that shapes everything below: only static, non-personal assets
 * are ever written to the cache. API responses are network-only, so no user
 * data is left sitting in CacheStorage on a shared or lost device.
 */

const VERSION = 'v2';
const SHELL_CACHE = `connect-shell-${VERSION}`;

const SHELL_ASSETS = [
  '/',
  '/index.html',
  '/offline.html',
  '/styles.css',
  '/js/app.js',
  '/js/api.js',
  '/js/ui.js',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL_ASSETS)),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((k) => k !== SHELL_CACHE).map((k) => caches.delete(k)),
      );
      await self.clients.claim();
    })(),
  );
});

// Lets the page trigger an immediate update instead of waiting for all tabs
// to close.
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

/** Anything that may carry user data must never be cached. */
function isPrivatePath(url) {
  return (
    url.pathname.startsWith('/api/') ||
    url.pathname === '/healthz' ||
    url.pathname === '/readyz'
  );
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Never touch other origins, and never cache private paths.
  if (url.origin !== self.location.origin) return;
  if (isPrivatePath(url)) return;

  // Navigations: network-first so content stays fresh, with the cached shell
  // as the offline fallback.
  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          const fresh = await fetch(request);
          const cache = await caches.open(SHELL_CACHE);
          cache.put('/index.html', fresh.clone());
          return fresh;
        } catch {
          const cache = await caches.open(SHELL_CACHE);
          return (
            (await cache.match('/index.html')) ??
            (await cache.match('/offline.html')) ??
            Response.error()
          );
        }
      })(),
    );
    return;
  }

  // Static assets: cache-first, refreshed in the background.
  event.respondWith(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      const hit = await cache.match(request);
      if (hit) {
        event.waitUntil(
          fetch(request)
            .then((res) => (res.ok ? cache.put(request, res.clone()) : null))
            .catch(() => {}),
        );
        return hit;
      }
      try {
        const res = await fetch(request);
        if (res.ok) cache.put(request, res.clone());
        return res;
      } catch {
        return (await cache.match('/offline.html')) ?? Response.error();
      }
    })(),
  );
});
