import type { Plugin } from 'vite';

/**
 * Emits sw.js with the full list of built files embedded, so every asset
 * (including the SQLite WASM binary) is precached on install and the app
 * works offline from the second launch onward — or the first, once installed.
 * A new build changes the file list, which changes sw.js, which triggers an update.
 */
export function serviceWorkerPlugin(): Plugin {
  return {
    name: 'focus-service-worker',
    apply: 'build',
    generateBundle(_opts, bundle) {
      const files = Object.keys(bundle).filter((f) => !f.endsWith('.map'));
      const version = files
        .join('|')
        .split('')
        .reduce((h, c) => (Math.imul(31, h) + c.charCodeAt(0)) | 0, 0)
        .toString(36);
      const precache = ['./', './index.html', ...files.map((f) => `./${f}`)];
      const source = `/* Focus service worker — generated at build time. */
const CACHE = 'focus-${version}';
const PRECACHE = ${JSON.stringify([...new Set(precache)])};
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith('focus-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  if (req.mode === 'navigate') {
    // Network first for the page so updates arrive; cached copy when offline.
    e.respondWith(fetch(req).catch(() => caches.match('./index.html')));
    return;
  }
  e.respondWith(caches.match(req).then((hit) => hit || fetch(req)));
});
`;
      this.emitFile({ type: 'asset', fileName: 'sw.js', source });
    },
  };
}
