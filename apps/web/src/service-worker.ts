declare const __SHELL_ASSETS__: readonly string[];
declare const __CACHE_NAME__: string;

const shellAssets = new Set(__SHELL_ASSETS__);
const worker = globalThis as unknown as ServiceWorkerGlobalScope;

worker.addEventListener("install", event => {
  event.waitUntil(caches.open(__CACHE_NAME__).then(cache => cache.addAll(__SHELL_ASSETS__)));
});

worker.addEventListener("activate", event => {
  event.waitUntil(
    caches
      .keys()
      .then(names => Promise.all(names.filter(name => name.startsWith("omp-sessions-shell-") && name !== __CACHE_NAME__).map(name => caches.delete(name)))),
  );
});

worker.addEventListener("fetch", event => {
  const { request } = event;
  const url = new URL(request.url);
  if (
    request.method !== "GET" ||
    request.mode === "navigate" ||
    url.origin !== worker.location.origin ||
    url.search !== "" ||
    url.pathname.startsWith("/api/") ||
    url.pathname.startsWith("/client/") ||
    url.pathname.startsWith("/internal/") ||
    !shellAssets.has(url.pathname)
  ) {
    return;
  }
  event.respondWith(
    caches.open(__CACHE_NAME__).then(async cache => {
      const cached = await cache.match(request);
      if (cached !== undefined) return cached;
      const response = await fetch(request);
      if (response.ok) await cache.put(request, response.clone());
      return response;
    }),
  );
});
