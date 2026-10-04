/* Offline support. Caches the app's own files only; documents are opened in the
 * page and never pass through here. */
const CACHE = 'easyscan2pdf-v2';
const ASSETS = [
  './', 'index.html', 'manifest.webmanifest',
  'src/style.css', 'src/i18n.js', 'src/detect.js', 'src/clean.js', 'src/app.js',
  'vendor/pdf.min.js', 'vendor/pdf.worker.min.js', 'vendor/pdf-lib.min.js',
  'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Network first, so a published update shows up at once; the cache serves when offline.
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req, { ignoreSearch: true })),
  );
});
