const CACHE_NAME = "lumyn-v1";
const ASSETS = [
  "/",
  "/index.html",
  "/manifest.json"
];

// Install
self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS).catch(() => {
        console.log("[SW] Alguns assets não foram cacheados (API pode estar offline)");
      });
    })
  );
  self.skipWaiting();
});

// Activate
self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((names) => {
      return Promise.all(
        names.map((name) => {
          if (name !== CACHE_NAME) return caches.delete(name);
        })
      );
    })
  );
  self.clients.claim();
});

// Fetch
self.addEventListener("fetch", (e) => {
  // API calls — sempre tenta network primeiro
  if (e.request.url.includes("/api/")) {
    e.respondWith(
      fetch(e.request)
        .then((res) => {
          if (res.ok) {
            const cache = caches.open(CACHE_NAME);
            cache.then((c) => c.put(e.request, res.clone()));
          }
          return res;
        })
        .catch(() => caches.match(e.request))
    );
    return;
  }

  // Assets — cache first, fallback to network
  e.respondWith(
    caches.match(e.request).then((cached) => {
      return cached || fetch(e.request).catch(() => new Response("Offline"));
    })
  );
});
