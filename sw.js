const CACHE_NAME = 'dnd-shiet-fish-finder-v41';
const TILE_CACHE = 'dnd-tiles-v2';
const MAX_TILES = 1500;
let tileWriteCount = 0;
const STATIC_ASSETS = [
  './',
  './index.html',
  './css/style.css',
  './js/app.js',
  './js/api.js',
  './js/cache.js',
  './js/map.js',
  './js/supabase.js',
  './js/fishing.js',
  './js/tripPlan.js',
  './js/arsenal.js',
  './js/community.js',
  './js/utils/fetch.js',
  './js/utils/html.js',
  './js/utils/geo.js',
  './js/utils/upload.js',
  './manifest.json',
  './icons/favicon.svg',
];

// Install: cache static assets, then activate
// Note: CDN scripts are NOT cached here — SRI hashes on the HTML tags ensure
// integrity on every load, and the browser's HTTP cache handles CDN assets.
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(STATIC_ASSETS))
      .then(() => self.skipWaiting())
  );
});

// Activate: clean old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k !== CACHE_NAME && k !== TILE_CACHE)
          .map((k) => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

// Fetch: network-first for API calls, cache-first for static assets
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // API calls + CDN scripts — network first, no caching at SW level
  if (
    url.hostname === 'waterservices.usgs.gov' ||
    url.hostname === 'overpass-api.de' ||
    url.hostname === 'overpass.kumi.systems' ||
    url.hostname === 'maps.mail.ru' ||
    url.hostname.includes('supabase.co') ||
    url.hostname === 'api.open-meteo.com' ||
    url.hostname === 'api.tidesandcurrents.noaa.gov' ||
    url.hostname.includes('arcgis.com') ||
    url.hostname === 'unpkg.com' ||
    url.hostname === 'cdn.jsdelivr.net' ||
    url.hostname === 'upload.wikimedia.org'
  ) {
    event.respondWith(
      fetch(event.request).catch(() => {
        return new Response(JSON.stringify({ error: 'offline' }), {
          headers: { 'Content-Type': 'application/json' },
        });
      })
    );
    return;
  }

  // Map tiles — cache with network fallback, LRU eviction at 500 entries
  if (url.hostname.includes('basemaps.cartocdn.com') ||
      url.hostname.includes('arcgisonline.com') ||
      url.hostname.includes('opentopomap.org')) {
    event.respondWith(
      caches.open(TILE_CACHE).then((cache) =>
        cache.match(event.request).then((cached) => {
          const fetched = fetch(event.request).then(async (response) => {
            if (response.ok) {
              cache.put(event.request, response.clone());
              // LRU eviction: check every 50th write to reduce overhead
              if (++tileWriteCount % 50 === 0) {
                const keys = await cache.keys();
                if (keys.length > MAX_TILES) {
                  await cache.delete(keys[0]);
                }
              }
            }
            return response;
          }).catch(() => cached);
          return cached || fetched;
        })
      )
    );
    return;
  }

  // Static assets — cache first
  event.respondWith(
    caches.match(event.request).then((cached) => {
      return cached || fetch(event.request).then((response) => {
        if (response.ok && event.request.method === 'GET') {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      });
    })
  );
});

// Allow the app to trigger skipWaiting for update prompts
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
