// Keeps the scanner page on the phone so it opens without Wi-Fi. Calls to the web app (another origin) are never cached.
// The cache name carries the scanner build (BUILD in app.js). Files are fetched with cache: 'no-cache', because GitHub Pages
// sends max-age=600 and a phone could otherwise run an old app.js for 10 minutes after a deploy; if the network gives no answer
// within 3 seconds (a hall with jammed Wi-Fi), the saved copy is used.
const CACHE = 'scanner-v9';
const FILES = ['./', 'index.html', 'styles.css?v=9', 'queue.js?v=9', 'route.js?v=9', 'app.js?v=9', 'manifest.webmanifest', 'vendor/barcode-detector-3.2.3.js',
  'vendor/zxing_reader.wasm', 'icons/icon-192.png', 'icons/icon-512.png'];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES.map(f => new Request(f, { cache: 'reload' })))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin) return;
  const saved = () => caches.match(e.request).then(r => r || caches.match(e.request, { ignoreSearch: true }));
  const net = fetch(e.request, { cache: 'no-cache' }).then(r => { if (r.ok) { const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); } return r; });
  const slow = new Promise(res => setTimeout(() => saved().then(r => { if (r) res(r); }), 3000));
  e.respondWith(Promise.race([net.catch(() => saved().then(r => r || Promise.reject(new Error('offline')))), slow]));
});
