const CACHE_NAME = "travel-app-subprojects-v9";
const APP_SHELL = [
  "./06-用户与PWA/",
  "./06-用户与PWA/index.html",
  "./06-用户与PWA/manifest.webmanifest",
  "./06-用户与PWA/src/app.js",
  "./06-用户与PWA/src/supabase-client.js",
  "./06-用户与PWA/src/styles.css",
  "./06-用户与PWA/assets/icon-192.png",
  "./06-用户与PWA/assets/icon-512.png",
  "./06-用户与PWA/assets/apple-touch-icon.png",
  "./04-旅程规划/planner.html",
  "./04-旅程规划/planner-data.js",
  "./05-当前行程导览/guide.html",
  "./05-当前行程导览/src/guide.js",
  "./05-当前行程导览/src/repository.js",
  "./05-当前行程导览/src/styles.css"
];

function navigationFallback(url) {
  if (url.pathname.includes("/04-旅程规划/")) return "./04-旅程规划/planner.html";
  if (url.pathname.includes("/05-当前行程导览/")) return "./05-当前行程导览/guide.html";
  return "./06-用户与PWA/index.html";
}

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(
    keys.filter((key) => key.startsWith("travel-app-subprojects-") && key !== CACHE_NAME).map((key) => caches.delete(key))
  )).then(() => self.clients.claim()));
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  if (url.pathname.endsWith("/config/runtime-config.js")) {
    event.respondWith(fetch(event.request, { cache: "no-store" }).then((response) => {
      if (response.ok) {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
      }
      return response;
    }).catch(() => caches.match(event.request)));
    return;
  }

  if (event.request.mode === "navigate") {
    event.respondWith(fetch(event.request).then((response) => {
      if (response.ok) {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
      }
      return response;
    }).catch(() => caches.match(event.request).then((cached) => cached || caches.match(navigationFallback(url)))));
    return;
  }

  event.respondWith(caches.match(event.request).then((cached) => cached || fetch(event.request).then((response) => {
    if (response.ok) {
      const copy = response.clone();
      caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
    }
    return response;
  })));
});
