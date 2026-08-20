/**
 * Real-device forbidden-sink acceptance sweep.
 *
 * `docs/SECURITY.md` forbids capability material from reaching any browser persistence sink. This
 * proves that on a physical Android device against a live gateway, rather than in an emulated
 * viewport.
 *
 * Every run is self-verifying. A positive control plants a synthetic secret in all seven sinks and
 * requires the detector to find each one; only then does the real sweep run. A sweep whose detector
 * has never detected anything cannot distinguish "clean" from "broken", so the control is a gate,
 * not an option.
 *
 * The capability is never printed, logged, or written. It is fetched inside the page, reduced to a
 * length and a short digest for the evidence record, and used only as a search needle in that same
 * JavaScript context.
 *
 * Usage: `bun scripts/android-leak-sweep.ts <origin> <session-cwd-label>`
 */
import { withAndroidChrome, type AndroidChromeDriver } from "./android-device.ts";

/** Sinks the sweep inspects. The control must be able to plant and detect every one. */
const SINKS = [
  "localStorage",
  "sessionStorage",
  "cookie",
  "cacheBody",
  "indexedDB",
  "locationHash",
  "historyState",
] as const;

interface ControlResult {
  readonly plantedUnique: readonly string[];
  readonly detectedUnique: readonly string[];
  readonly residual: Record<string, unknown>;
}

interface SweepResult {
  readonly target?: Record<string, unknown>;
  readonly launchStatus?: number;
  readonly launchCacheControl?: string | null;
  readonly launchKeys?: readonly string[];
  readonly capabilityLength?: number;
  readonly capabilityDigest?: string;
  readonly needleCount?: number;
  readonly cacheNames?: readonly string[];
  readonly indexedDbNames?: readonly string[];
  readonly locationHref?: string;
  readonly locationHashLength?: number;
  readonly findings?: readonly string[];
  readonly error?: string;
  readonly seen?: readonly string[];
}

/** Shared page-side helpers, injected into both the control and the sweep. */
const PAGE_PRELUDE = `
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
      const cache = await caches.open(cacheName);
      for (const request of await cache.keys()) {
        if (hit(request.url)) note("cacheKey", cacheName);
        const cached = await cache.match(request);
        if (cached && hit(await cached.clone().text())) note("cacheBody", cacheName);
      }
    }
    for (const meta of (await indexedDB.databases?.()) ?? []) {
      if (!meta.name) continue;
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
  };
`;

/** Plants a synthetic secret in every sink, requires detection, then removes each plant. */
async function runControl(driver: AndroidChromeDriver): Promise<ControlResult> {
  const script = `(async () => {
    ${PAGE_PRELUDE}
    const NEEDLE = "SYNTHETIC-CAPABILITY-CONTROL-b7f3a91c2d8e4056";
    const CONTROL_KEY = "__leak_control__";
    const hit = value => typeof value === "string" && value.includes(NEEDLE);
    const planted = [];
    const detected = [];

    localStorage.setItem(CONTROL_KEY, NEEDLE); planted.push("localStorage");
    sessionStorage.setItem(CONTROL_KEY, NEEDLE); planted.push("sessionStorage");
    document.cookie = CONTROL_KEY + "=" + NEEDLE + "; path=/"; planted.push("cookie");
    const controlCache = await caches.open(CONTROL_KEY);
    await controlCache.put(new Request("/" + CONTROL_KEY), new Response(NEEDLE));
    planted.push("cacheBody");
    const db = await openDb(CONTROL_KEY, 1, handle => handle.createObjectStore("s"));
    const writing = Promise.withResolvers();
    const tx = db.transaction("s", "readwrite");
    tx.objectStore("s").put(NEEDLE, "k");
    tx.oncomplete = () => writing.resolve(undefined);
    tx.onerror = () => writing.reject(tx.error);
    await writing.promise;
    planted.push("indexedDB");
    history.replaceState({ control: NEEDLE }, "", location.pathname + "#" + NEEDLE);
    planted.push("locationHash", "historyState");

    await scanSinks(hit, sink => detected.push(sink));

    localStorage.removeItem(CONTROL_KEY);
    sessionStorage.removeItem(CONTROL_KEY);
    document.cookie = CONTROL_KEY + "=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT";
    await caches.delete(CONTROL_KEY);
    db.close();
    indexedDB.deleteDatabase(CONTROL_KEY);
    history.replaceState(null, "", location.pathname);

    return {
      plantedUnique: [...new Set(planted)].sort(),
      detectedUnique: [...new Set(detected)].sort(),
      residual: {
        localStorage: localStorage.getItem(CONTROL_KEY),
        sessionStorage: sessionStorage.getItem(CONTROL_KEY),
        cookie: document.cookie.includes(CONTROL_KEY),
        hash: location.hash,
        caches: await caches.keys(),
      },
    };
  })()`;
  const evaluation = await driver.send("Runtime.evaluate", {
    expression: script,
    awaitPromise: true,
    returnByValue: true,
  });
  return extract<ControlResult>(evaluation);
}

/** Launches a view capability exactly as the PWA does, then searches every sink for it. */
async function runSweep(driver: AndroidChromeDriver, label: string): Promise<SweepResult> {
  const script = `(async () => {
    ${PAGE_PRELUDE}
    const out = {};
    const list = await (await fetch("/api/v1/sessions", { cache: "no-store" })).json();
    const target = list.sessions.find(session => session.cwdLabel === ${JSON.stringify(label)});
    if (!target) return { error: "target session not published", seen: list.sessions.map(s => s.cwdLabel) };
    out.target = { generation: target.generation, canView: target.canView, canControl: target.canControl };

    const response = await fetch("/api/v1/sessions/" + target.instanceId + "/launch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      cache: "no-store",
      body: JSON.stringify({ generation: target.generation, mode: "view" }),
    });
    out.launchStatus = response.status;
    out.launchCacheControl = response.headers.get("cache-control");
    if (!response.ok) return { ...out, error: "launch rejected" };

    const payload = await response.json();
    out.launchKeys = Object.keys(payload).sort();
    const capability = payload.capability;
    if (typeof capability !== "string") return { ...out, error: "no capability string in launch payload" };

    out.capabilityLength = capability.length;
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(capability));
    out.capabilityDigest = [...new Uint8Array(digest)].slice(0, 8).map(b => b.toString(16).padStart(2, "0")).join("");

    // The whole value, plus every opaque segment long enough to be the secret itself.
    const needles = [capability];
    for (const part of capability.split(/[\\/?#&=]/)) if (part.length >= 16) needles.push(part);
    out.needleCount = needles.length;

    const findings = [];
    await scanSinks(
      value => typeof value === "string" && needles.some(needle => value.includes(needle)),
      (sink, detail) => findings.push(detail ? sink + ": " + detail : sink),
    );

    out.cacheNames = await caches.keys();
    out.indexedDbNames = ((await indexedDB.databases?.()) ?? []).map(entry => entry.name);
    out.locationHref = location.href;
    out.locationHashLength = location.hash.length;
    out.findings = findings;
    return out;
  })()`;
  const evaluation = await driver.send("Runtime.evaluate", {
    expression: script,
    awaitPromise: true,
    returnByValue: true,
  });
  return extract<SweepResult>(evaluation);
}

function extract<T>(evaluation: Record<string, unknown>): T {
  const result = evaluation.result as { value?: T; description?: string } | undefined;
  if (!result || result.value === undefined) {
    throw new Error(`page evaluation returned no value: ${result?.description ?? JSON.stringify(evaluation)}`);
  }
  return result.value;
}

const origin = process.argv[2];
const label = process.argv[3];
if (!origin || !label) {
  console.error("usage: bun scripts/android-leak-sweep.ts <origin> <session-cwd-label>");
  process.exit(2);
}

const { control, sweep, serial, version } = await withAndroidChrome(async driver => {
  await driver.openTab();
  await driver.navigate(`${origin}/`);
  const settle = Promise.withResolvers<void>();
  setTimeout(settle.resolve, 6000);
  await settle.promise;
  return {
    serial: driver.serial,
    version: (await driver.version()).product,
    control: await runControl(driver),
    sweep: await runSweep(driver, label),
  };
});

const missed = SINKS.filter(sink => !control.detectedUnique.includes(sink));
const residualPlants = Object.entries(control.residual).filter(
  ([key, value]) => (key === "cookie" && value === true) || (key === "hash" && value !== "") || (key !== "cookie" && key !== "hash" && key !== "caches" && value !== null),
);

console.log(`device        ${serial} (${version})`);
console.log(`origin        ${origin}`);
console.log(`control       planted ${control.plantedUnique.length}, detected ${control.detectedUnique.length}`);
if (missed.length > 0) {
  console.error(`DETECTOR UNPROVEN — planted but not detected: ${missed.join(", ")}`);
  process.exit(1);
}
if (residualPlants.length > 0) {
  console.error(`CONTROL LEFT RESIDUE: ${JSON.stringify(residualPlants)}`);
  process.exit(1);
}
console.log(`              all ${SINKS.length} sinks proven detectable, no residue`);

if (sweep.error !== undefined) {
  console.error(`SWEEP FAILED: ${sweep.error}${sweep.seen ? ` (published: ${sweep.seen.join(", ")})` : ""}`);
  process.exit(1);
}
console.log(`launch        ${sweep.launchStatus} cache-control="${sweep.launchCacheControl}" keys=${sweep.launchKeys?.join(",")}`);
console.log(`capability    ${sweep.capabilityLength} chars, sha256:${sweep.capabilityDigest}, ${sweep.needleCount} needles`);
console.log(`caches        ${sweep.cacheNames?.join(", ") || "none"}`);
console.log(`indexedDB     ${sweep.indexedDbNames?.length ? sweep.indexedDbNames.join(", ") : "none"}`);
console.log(`address       ${sweep.locationHref} (hash ${sweep.locationHashLength} chars)`);

if ((sweep.findings?.length ?? 0) > 0) {
  console.error(`CAPABILITY LEAKED INTO: ${sweep.findings?.join(", ")}`);
  process.exit(1);
}
console.log(`result        clean — capability absent from all ${SINKS.length} sinks, resource timings, and DOM`);
