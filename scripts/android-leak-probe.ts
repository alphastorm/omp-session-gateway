/** Shared page-side helpers, injected into both the control and the sweep. */
export const PAGE_PRELUDE = `
  const openDb = async (name, version, upgrade) => {
    const opening = Promise.withResolvers();
    const request = version === undefined ? indexedDB.open(name) : indexedDB.open(name, version);
    if (upgrade) request.onupgradeneeded = () => upgrade(request.result);
    request.onsuccess = () => opening.resolve(request.result);
    request.onerror = () => opening.reject(request.error);
    return await opening.promise;
  };
  const readAll = async (db, storeName) => {
    const reading = Promise.withResolvers();
    const request = db.transaction(storeName, "readonly").objectStore(storeName).getAll();
    request.onsuccess = () => reading.resolve(request.result);
    request.onerror = () => reading.reject(request.error);
    return await reading.promise;
  };
  const scanSinks = async (hit, note) => {
    for (const [name, store] of [["localStorage", localStorage], ["sessionStorage", sessionStorage]]) {
      for (let i = 0; i < store.length; i++) {
        const key = store.key(i);
        if (hit(key) || hit(store.getItem(key))) note(name, key);
      }
    }
    if (hit(document.cookie)) note("cookie");
    for (const cacheName of await caches.keys()) {
      if (hit(cacheName)) note("cacheName");
      const cache = await caches.open(cacheName);
      for (const request of await cache.keys()) {
        if (hit(request.url)) note("cacheKey", cacheName);
        const cached = await cache.match(request);
        if (cached && hit(await cached.clone().text())) note("cacheBody", cacheName);
      }
    }
    for (const meta of (await indexedDB.databases?.()) ?? []) {
      if (!meta.name) continue;
      if (hit(meta.name)) note("indexedDbName");
      const db = await openDb(meta.name);
      for (const storeName of [...db.objectStoreNames]) {
        if (hit(JSON.stringify(await readAll(db, storeName)))) note("indexedDB", meta.name + "/" + storeName);
      }
      db.close();
    }
    if (hit(location.href) || hit(location.hash) || hit(location.search)) note("locationHash");
    if (hit(JSON.stringify(history.state))) note("historyState");
    if (hit(document.referrer)) note("referrer");
    for (const entry of performance.getEntriesByType("resource")) {
      if (hit(entry.name)) note("performanceResource", entry.name.slice(0, 60));
    }
    if (hit(document.documentElement.outerHTML)) note("domMarkup");
    const registration = await navigator.serviceWorker.getRegistration();
    // iOS Safari tabs expose ServiceWorkerRegistration without getNotifications.
    for (const notification of await registration?.getNotifications?.() ?? []) {
      if (hit(notification.title)) note("notificationTitle");
      if (hit(notification.body)) note("notificationBody");
      if (hit(JSON.stringify(notification.data))) note("notificationData");
    }
  };
`;
