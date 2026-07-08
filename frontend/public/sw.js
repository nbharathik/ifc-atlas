// IFC Atlas service worker - pre-caches heavy WASM + worker files
// so IFC loading is instant after the first visit even with no network.
//
// Scope: / (serves all paths from the same origin)
// Cache strategy: cache-first for WASM/worker files; passthrough for all else.
// Versioning: bump CACHE_NAME when the WASM files are updated (npm upgrade).

const CACHE_NAME = 'ifc-wasm-v1';

// These three files account for ~4 MB but are loaded on every IFC parse.
// Pre-caching them means the first parse after a page refresh doesn't block
// on a network round-trip for the WASM binary.
const PRECACHE_URLS = ['/web-ifc.wasm', '/web-ifc-mt.wasm', '/worker.mjs'];

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
