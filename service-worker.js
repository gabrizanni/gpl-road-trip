const VERSION = "gpl-road-trip-v6";
const SHELL_CACHE = `${VERSION}-shell`;
const DATA_CACHE = `${VERSION}-data`;
const MAP_CACHE = `${VERSION}-map`;

const APP_SHELL = [
  "./",
  "./index.html",
  "./offline.html",
  "./styles.css",
  "./app.js",
  "./manifest.webmanifest",
  "./data/routes.json",
  "./data/latest.json",
  "./data/seed.json",
  "./assets/icon.svg",
  "./assets/leaflet-1.9.4.css",
  "./assets/icon-192.png",
  "./assets/icon-512.png",
  "./assets/apple-touch-icon.png",
  "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then(async (cache) => {
      const results = await Promise.allSettled(
        APP_SHELL.map((path) => cache.add(new Request(path, { cache: "reload" })))
      );
      const missingCore = results.some((result, index) =>
        result.status === "rejected" && !APP_SHELL[index].startsWith("http")
      );
      if (missingCore) throw new Error("Impossibile salvare i file essenziali offline");
    })
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key.startsWith("gpl-road-trip-") && ![SHELL_CACHE, DATA_CACHE, MAP_CACHE].includes(key))
          .map((key) => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);

  if (request.mode === "navigate") {
    event.respondWith(networkFirst(request, SHELL_CACHE, "./offline.html", 3000));
    return;
  }

  if (url.origin === self.location.origin && url.pathname.includes("/data/")) {
    event.respondWith(networkFirst(request, DATA_CACHE, request, 3000));
    return;
  }

  if (url.origin === self.location.origin) {
    event.respondWith(staleWhileRevalidate(request, SHELL_CACHE));
    return;
  }

  const isLeafletAsset = url.hostname === "unpkg.com" && url.pathname.includes("/leaflet@");
  const isMapTile = url.hostname.endsWith("tile.openstreetmap.org");
  if (isLeafletAsset || isMapTile) {
    event.respondWith(runtimeCache(request, isMapTile));
  }
});

async function networkFirst(request, cacheName, fallback, timeoutMs) {
  const cache = await caches.open(cacheName);
  try {
    const response = await fetchWithTimeout(request, timeoutMs);
    if (response.ok || response.type === "opaque") cache.put(request, response.clone());
    return response;
  } catch {
    const cached = await cache.match(request, { ignoreSearch: request.mode === "navigate" });
    if (cached) return cached;
    const shellFallback = await caches.match(fallback);
    return shellFallback || Response.error();
  }
}

async function fetchWithTimeout(request, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(new Request(request, { signal: controller.signal }));
  } finally {
    clearTimeout(timer);
  }
}

async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  const update = fetch(request)
    .then((response) => {
      if (response.ok || response.type === "opaque") cache.put(request, response.clone());
      return response;
    })
    .catch(() => cached || Response.error());
  return cached || update;
}

async function runtimeCache(request, trimTiles) {
  const cache = await caches.open(MAP_CACHE);
  const cached = await caches.match(request);
  const update = fetch(request).then((response) => {
    if (response.ok || response.type === "opaque") {
      cache.put(request, response.clone());
      if (trimTiles) trimCache(cache, 120);
    }
    return response;
  }).catch(() => cached);
  return cached || update;
}

async function trimCache(cache, maxEntries) {
  const keys = await cache.keys();
  if (keys.length <= maxEntries) return;
  await Promise.all(keys.slice(0, keys.length - maxEntries).map((key) => cache.delete(key)));
}
