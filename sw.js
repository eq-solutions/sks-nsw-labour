/*! Property of EQ — all rights reserved. Unauthorised use prohibited. */
// EQ Solves — Field  ·  Service Worker  v3.10.52
const CACHE = 'eq-field-v3.10.52';

const PRECACHE = [
  '/',
  '/index.html',
  '/manifest.json',
  '/styles/base.css',
  '/styles/mobile.css',
  '/styles/print.css',
  '/scripts/app-state.js',
  '/scripts/utils.js',
  '/scripts/supabase.js',
  '/scripts/roster.js',
  '/scripts/people.js',
  '/scripts/teams.js',
  '/scripts/sites.js',
  '/scripts/managers.js',
  '/scripts/dashboard.js',
  '/scripts/batch.js',
  '/scripts/leave.js',
  '/scripts/tafe.js',
  '/scripts/timesheets.js',
  '/scripts/jobnumbers.js',
  '/scripts/import-export.js',
  '/scripts/calendar.js',
  '/scripts/audit.js',
  '/scripts/auth.js',
  '/scripts/trial-dashboard.js',
  '/scripts/apprentices.js',
  '/scripts/journal.js',
  '/scripts/digest-settings.js',
  '/scripts/analytics.js',
  '/scripts/whatsnew.js',
  '/scripts/presence.js',
  '/scripts/tender-parser.js',
  '/scripts/pipeline-import.js',
  '/scripts/pipeline.js',
  '/scripts/pipeline-resource.js',
  '/scripts/home.js',
  '/scripts/safety.js',
  '/styles/home.css',
];

// Static assets that rarely change — cache-first is safe
const CACHE_FIRST_PATHS = ['/manifest.json', '/icons/'];

self.addEventListener('install', event => {
  self.skipWaiting();
  // v3.4.58: surface PRECACHE failures via console.warn so deploy-time
  // issues (one of the script files 404s, network blip during install,
  // CDN issue) are observable. SW still installs even on partial failure
  // — partial cache is better than no cache.
  event.waitUntil(
    caches.open(CACHE)
      .then(cache => cache.addAll(PRECACHE))
      .catch(e => console.warn('EQ[sw] PRECACHE addAll failed:', e && e.message || e))
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
    .then(() => self.clients.matchAll({ type: 'window', includeUncontrolled: true }))
    .then(clients => {
      // Tell every open page to reload so it picks up the new JS immediately.
      // Without this, skipWaiting takes over the network but the old scripts
      // keep running in memory until the user manually closes and reopens the app.
      clients.forEach(c => c.postMessage({ type: 'SW_ACTIVATED', cache: CACHE }));
    })
  );
});

self.addEventListener('fetch', event => {
  // Only cache GET requests for same origin
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  const path = url.pathname;

  // Cache-first ONLY for truly static assets (icons, manifest)
  if (CACHE_FIRST_PATHS.some(p => path.startsWith(p))) {
    event.respondWith(
      caches.match(event.request).then(cached => {
        if (cached) return cached;
        return fetch(event.request).then(res => {
          // v3.4.58: only cache successful responses. Without this guard,
          // a 404/500/503 during a partial deploy gets persisted in the
          // SW cache and serves indefinitely until the next successful
          // fetch overwrites it — users get stuck on cached error pages.
          if (res.ok) {
            const c = res.clone();
            caches.open(CACHE).then(cache => cache.put(event.request, c));
          }
          return res;
        });
      })
    );
    return;
  }

  // Network-first for everything else (HTML, JS, CSS)
  // Ensures updates are picked up immediately, with cache fallback for offline
  event.respondWith(
    fetch(event.request)
      .then(res => {
        // v3.4.58: only cache successful responses. See cache-first branch.
        if (res.ok) {
          const c = res.clone();
          caches.open(CACHE).then(cache => cache.put(event.request, c));
        }
        return res;
      })
      .catch(() => caches.match(event.request))
  );
});

// ── Push Notifications ───────────────────────────────────────
// v3.10.4: show roster change alerts on staff devices.
self.addEventListener('push', event => {
  const data = event.data ? event.data.json() : {};
  event.waitUntil(
    self.registration.showNotification(data.title || 'EQ Solves — Field', {
      body:      data.body || 'Your roster has been updated for tomorrow',
      icon:      '/icons/icon-192.png',
      badge:     '/icons/icon-72.png',
      data:      { url: data.url || '/' },
      tag:       'roster-update',
      renotify:  true
    })
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then(clients => {
        const open = clients.find(c => c.url.includes(self.location.origin));
        if (open) return open.focus();
        return self.clients.openWindow(url);
      })
  );
});

// ── Background Sync — replay write queue ─────────────────────
// v3.4.74: pairs with the IDB-backed queue in scripts/supabase.js.
// When the device comes back online (even if the tab was killed) the
// browser fires this event, we wake any open client and have it call
// flushWriteQueue(). If no client is open, the page will pick up the
// queued writes via _idbRestoreQueue() on next launch.
self.addEventListener('sync', event => {
  if (event.tag === 'eq-write-queue') {
    event.waitUntil(
      self.clients.matchAll({ type: 'window', includeUncontrolled: true })
        .then(clients => {
          if (clients.length) clients[0].postMessage({ type: 'FLUSH_WRITE_QUEUE' });
        })
    );
  }
});