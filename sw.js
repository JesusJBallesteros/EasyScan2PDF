/* Offline support. Caches the app's own files only; documents are opened in the
 * page and never pass through here. */
importScripts('src/version.js');

const CACHE = 'easyscan2pdf-' + self.APP_VERSION.number;
const ASSETS = [
  './', 'index.html', 'manifest.webmanifest',
  'src/version.js', 'src/style.css', 'src/i18n.js', 'src/detect.js', 'src/clean.js', 'src/app.js',
  'vendor/pdf.min.js', 'vendor/pdf.worker.min.js', 'vendor/pdf-lib.min.js',
  'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png',
];

/* Downloads every app file again, past the browser's own cache. */
function refresh() {
  return caches.open(CACHE).then((cache) => Promise.all(ASSETS.map((url) =>
    fetch(url, { cache: 'reload' }).then((res) => { if (res.ok) return cache.put(url, res); }))));
}

self.addEventListener('install', (event) => {
  event.waitUntil(refresh().then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Network first, always checking with the server, so a published update shows
// up on the next load; the cache serves when offline.
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  event.respondWith(
    fetch(req, { cache: 'no-cache' })
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

// The page's "Update" button asks for a fresh copy of everything.
self.addEventListener('message', (event) => {
  if (!event.data || event.data.type !== 'refresh') return;
  const reply = (text) => { if (event.ports[0]) event.ports[0].postMessage(text); };
  event.waitUntil(refresh().then(() => reply('done'), () => reply('failed')));
});
