// Cache-first for cover images only — a comic cover is immutable art (the
// mint's metadata image URI, effectively content-addressed on
// Arweave/IPFS/similar), so a cached copy never needs revalidating the way
// an API response would. Everything else (the HTML pages themselves, the
// Worker's /v2/* JSON) passes straight through untouched — this service
// worker exists purely to make repeat cover-image loads instant (same
// wallet reopened, or navigating between MyComics/Grid/Collections/
// Slideshow for the same wallet), not as a general offline cache.
const CACHE_NAME = 'zurcovers-covers-v1';

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if(req.method !== 'GET' || req.destination !== 'image') return;
  event.respondWith(
    caches.open(CACHE_NAME).then(async (cache) => {
      const cached = await cache.match(req);
      if(cached) return cached;
      try{
        const res = await fetch(req);
        // Cross-origin cover requests (Arweave/IPFS/whatever CDN the mint's
        // metadata points at) come back opaque under the default 'cors'
        // mode when the origin doesn't send CORS headers — still safe to
        // cache and replay into an <img> tag, just not inspectable here.
        if(res && (res.ok || res.type === 'opaque')) cache.put(req, res.clone());
        return res;
      }catch(e){
        return cached || Response.error();
      }
    })
  );
});
