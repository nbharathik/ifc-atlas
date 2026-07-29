// IFC Atlas service worker - pre-caches heavy WASM + worker files
// so IFC loading is instant after the first visit even with no network.
//
// Scope: / (serves all paths from the same origin)
// Cache strategy: cache-first for WASM/worker files; passthrough for all else.
//
// The cache namespace comes from the `?v=` build stamp the registration adds,
// never from a literal edited by hand. Cache-first plus a hand-bumped name is
// how a stale worker.mjs survives across releases: the classifier that decides
// which geometry is visible runs inside that worker, so a skew is not benign.
const BUILD_ID = new URL(self.location.href).searchParams.get('v') || 'dev';
const CACHE_NAME = `ifc-wasm-${BUILD_ID}`;

// web-ifc is forced to single-thread mode by the browser runtime patch, so the
// MT binary is never fetched and is not shipped.
const PRECACHE_URLS = ['/web-ifc.wasm', '/worker.mjs'];

// Install: fetch and cache WASM + worker files, then take control immediately.
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting())
  );
});

// Activate: delete any caches from prior SW versions, then claim all clients.
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

// Fetch: cache-first for the pre-cached set; everything else passes through.
self.addEventListener('fetch', (event) => {
  let pathname;
  try {
    pathname = new URL(event.request.url).pathname;
  } catch {
    return; // unparseable URL - don't intercept
  }
  if (!PRECACHE_URLS.includes(pathname)) return;

  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request).then(response => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      });
    })
  );
});
