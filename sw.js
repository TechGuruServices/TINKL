// TINKL. service worker
// Handles: offline app-shell caching + notification tap routing back to the app.

const VERSION = 'tinkl-v3';
const STATIC_CACHE = `${VERSION}-static`;
const RUNTIME_CACHE = `${VERSION}-runtime`;

// Chart.js is pinned to an exact version, so once it's been fetched
// successfully it will never change — a pure cache-first strategy is safe
// and avoids a redundant network round-trip every time stats/health load.
const CHART_JS_URL = 'https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js';

// Core files needed for the app to load with no network connection.
// These paths must match real files that are deployed to the site root.
const APP_SHELL = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/favicon.ico',
  '/tinkl-logo-paw3-192.png',
  '/tinkl-logo-paw3.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE)
      .then((cache) => Promise.all(
        // cache.addAll() fails atomically — a single missing/404 asset
        // (e.g. an icon that hasn't been deployed yet) would silently
        // abort install and the SW would never activate, breaking
        // notification-tap routing and offline support entirely.
        // Cache each file independently so one failure can't sink the rest.
        APP_SHELL.map((url) => cache.add(url).catch((err) => {
          console.warn('[TINKL SW] Failed to precache', url, err);
        }))
      ))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys
          .filter((key) => key.startsWith('tinkl-') && key !== STATIC_CACHE && key !== RUNTIME_CACHE)
          .map((key) => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  // The Cache API only accepts http(s) requests. Browser extensions can
  // inject chrome-extension:// (and similar) requests into a page's
  // network activity; if one of those reaches our cache.put() calls below
  // it throws "Request scheme 'chrome-extension' is unsupported" and takes
  // down the fetch handler for that request. Bail out before any caching
  // logic runs so those requests just pass through untouched.
  if (!request.url.startsWith('http')) return;

  const url = new URL(request.url);

  // Cloud sync API calls (Cloudflare Worker) must always hit the network —
  // never intercept or cache these, or backup/restore will read stale data
  // or fail while "offline-first" caching gets in the way.
  if (url.pathname.startsWith('/api/backup/')) return;

  // Navigations: network first, fall back to cached shell when offline.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(STATIC_CACHE).then((cache) => cache.put('/index.html', copy));
          return response;
        })
        .catch(() => caches.match('/index.html'))
    );
    return;
  }

  // Same-origin static assets: cache first, refresh in background.
  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.match(request).then((cached) => {
        const fetchPromise = fetch(request)
          .then((response) => {
            const copy = response.clone();
            caches.open(STATIC_CACHE).then((cache) => cache.put(request, copy));
            return response;
          })
          .catch(() => cached);
        return cached || fetchPromise;
      })
    );
    return;
  }

  // Chart.js CDN: cache-first. Pinned version means "cached" == "current" —
  // once it loads successfully one time, serve it from cache from then on
  // (including offline) instead of hitting the network on every visit.
  if (request.url === CHART_JS_URL) {
    event.respondWith(
      caches.match(request).then((cached) => {
        if (cached) return cached;
        return fetch(request).then((response) => {
          // Only cache once it's actually loaded — a failed/opaque error
          // response shouldn't get locked in as if it were the real file.
          const copy = response.clone();
          caches.open(RUNTIME_CACHE).then((cache) => cache.put(request, copy));
          return response;
        });
        // No .catch here: if there's no cached copy and the network fetch
        // fails, let it fail — the page's onerror handler shows a fallback
        // message instead of silently serving nothing.
      })
    );
    return;
  }

  // Cross-origin (fonts, etc.): stale-while-revalidate so the app still
  // works offline once these have been fetched once.
  event.respondWith(
    caches.match(request).then((cached) => {
      const fetchPromise = fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(RUNTIME_CACHE).then((cache) => cache.put(request, copy));
          return response;
        })
        .catch(() => cached);
      return cached || fetchPromise;
    })
  );
});

// Route a tap on a reminder notification back into the app.
// index.html listens for { type: 'notif-action', tag } on the
// serviceWorker 'message' event to re-open the alarm dialog.
self.addEventListener('notificationclick', (event) => {
  const notification = event.notification;
  const tag = notification.tag;
  notification.close();

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      const payload = { type: 'notif-action', tag };

      const existing = clients.find((c) => 'focus' in c);
      if (existing) {
        existing.postMessage(payload);
        return existing.focus();
      }
      return self.clients.openWindow('/').then((client) => {
        if (client) {
          // Give the page a moment to attach its message listener.
          setTimeout(() => client.postMessage(payload), 1000);
        }
      });
    })
  );
});
