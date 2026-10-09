/* Service worker: makes the site load fast, work as an installed app, and show a friendly
   offline page. It never touches Firebase, fonts or any other site's requests — only this site's files. */
const VERSION = 'fk-v2';
const PRECACHE = [
  'offline.html', 'index.html', 'services.html', 'skills.html', 'projects.html',
  'certs.html', 'about.html', 'contact.html', 'members.html',
  'manifest.webmanifest', 'favicon.svg', 'icon-192.png', 'app.js?v=2'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(VERSION).then((cache) =>
      // Tolerant: one missing file must not stop the worker from installing.
      Promise.all(PRECACHE.map((u) => cache.add(new Request(u, { cache: 'reload' })).catch(() => {})))
    )
  );
  // No automatic skipWaiting: the page offers "Reload" when an update is ready.
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

// Pages: always try the network first so visitors get the newest version. If the network is
// slow (3s) or down, fall back to the saved copy, then to the offline page.
async function pageRequest(req) {
  const cache = await caches.open(VERSION);
  const cached = await cache.match(req, { ignoreSearch: true });
  const network = fetch(req).then((res) => {
    if (res && res.ok) cache.put(req, res.clone());
    return res;
  });
  try {
    if (!cached) return await network;
    return await Promise.race([network, new Promise((_, reject) => setTimeout(reject, 3000))]);
  } catch (e) {
    return cached || (await caches.match('offline.html')) || Response.error();
  }
}

// Files whose address changes with every release (?v=…) never change, so cache-first is safe.
async function versionedFile(req) {
  const cache = await caches.open(VERSION);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res && res.ok) cache.put(req, res.clone());
  return res;
}

// Everything else (icons, manifest, photos): show the saved copy now, refresh it in the background.
async function staleWhileRevalidate(req) {
  const cache = await caches.open(VERSION);
  const hit = await cache.match(req);
  const refresh = fetch(req).then((res) => {
    if (res && res.ok) cache.put(req, res.clone());
    return res;
  }).catch(() => hit);
  return hit || refresh;
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;       // Firebase, fonts, Cloudinary… untouched
  if (url.pathname.endsWith('/sw.js')) return;
  if (req.mode === 'navigate') { event.respondWith(pageRequest(req)); return; }
  if (/[?&]v=/.test(url.search)) { event.respondWith(versionedFile(req)); return; }
  event.respondWith(staleWhileRevalidate(req));
});
