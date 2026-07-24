// Kill-switch service worker for the periopdigital.uk apex (landing page).
//
// The apex previously hosted the LASTCalc app, whose cache-first service worker
// stayed registered on visitors' browsers and kept serving the old cached app
// instead of this landing page — offline-first, never hitting the network.
//
// This worker replaces that stale one: it clears every cache, unregisters
// itself, and reloads open pages so the current landing page loads fresh. The
// landing page registers NO service worker, so once this has run on a client it
// simply ceases to exist. Keep this file here so stale clients can still fetch a
// valid JS worker at /sw.js (a real file beats the SPA fallback that otherwise
// returns index.html and breaks the update).
self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      await caches.delete(key);
    }
    await self.registration.unregister();
    const clients = await self.clients.matchAll({ type: 'window' });
    for (const client of clients) {
      client.navigate(client.url);
    }
  })());
});
