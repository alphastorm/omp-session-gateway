# Test plan

## 1. Unit tests

### Registry

- valid hello/upsert/heartbeat/remove;
- invalid token and constant-time comparison wrapper;
- unknown protocol version/op;
- oversized/invalid UTF-8 frame;
- instance ID mismatch;
- older generation ignored;
- old-generation remove cannot delete new generation;
- monotonic TTL behavior independent of publisher wall clock;
- socket close and TTL cleanup;
- duplicate/reconnect upsert idempotence;
- bounded record/connection counts.
- same-generation false-to-true-to-false response-required mutations and stale-generation rejection;

### HTTP/auth

- missing Tailscale identity denied in production mode;
- disallowed login denied;
- allowed login accepted;
- localhost dev mode refuses non-loopback source;
- exact Origin enforcement;
- content-type/body-size enforcement;
- list/SSE browser-metadata schema;
- gateway-created attention identity is stable across repeated true updates and replaced on clear/re-arm or generation replacement;
- list/SSE contain only bounded labels, boolean attention, opaque request ID, and daemon receipt time—never a capability, transcript, answer, or tool output;
- launch generation mismatch returns 409;
- expired/missing returns non-enumerating 404;
- view/control availability enforcement;
- all API responses no-store;
- CSP and security headers.
- strict push v2 config/subscription/unsubscribe schemas, exact-origin mutation enforcement, private persistence, detail-level migration, subscription bounds, and stale-endpoint removal;
- ordered attention/clear delivery, per-instance deduplication, exact-request clearing, pending-count badges, and generation-safe replacement;

### PWA local triage

- exact-ask Hold persistence, FIFO partitioning, explicit requeue, and garbage collection when the
  authoritative ask changes or clears;
- Hold leaves authoritative pending counts and badges unchanged and closes only the notification
  whose instance tag and request ID match;
- generation-scoped Hide, immediate local hiding, five-second Undo, persistent Show all, and
  zero network mutation when the Undo window expires;
- session removal, generation replacement, and later attention restore a dismissed row
  immediately, while transport failure preserves local routing choices;
- malformed, oversized, excess, or non-canonical local records fail closed within the documented
  bounds, and allowed records contain identifiers and timestamps only.

### Collaboration photo composer

- JPEG, PNG, and WebP inputs at or below an 8,192px edge and 20 megapixels normalize to JPEG no
  larger than a 2,048px edge or 1 MiB;
- unsupported, empty, over-24-MiB, over-dimension, undecodable, and over-detailed inputs fail
  visibly before decode or relay send;
- at most four volatile previews are retained; remove, host-confirmed send, and unmount drop
  preview data URLs and base64 references;
- text-only, photo-plus-note, and photo-only prompts produce the existing v3 frame shape, with the
  documented neutral text used only when the note is empty;
- an unacknowledged photo prompt retains its exact preview and note, disables editing, and offers
  retry after five seconds only when relay health is current; a matching `collab-prompt` entry
  clears it;
- read-only, disconnected, and preparing states cannot open or submit the photo path;
- a moving status row cannot cancel a pointer-captured Send, Stop, remove, or camera action.

### OMP patch

- see `docs/OMP_INTEGRATION.md` section 8.

## 2. Secret-leak test harness

Use distinctive fixture strings for publisher token, view capability, and control capability. After each test, scan:

- daemon stdout/stderr and structured logs;
- temporary/config/data directories;
- browser Local Storage, Session Storage, IndexedDB, cookies, Cache Storage;
- service-worker request cache;
- HTTP access logs/test recorder;
- generated diagnostics bundle;
- unhandled exception and snapshot output.

Fail on any exact fixture or meaningful substring outside its designated source/sink. The publisher authentication key is permitted only in the private token fixture and live HMAC key buffers; it must never appear in captured IPC frames. View/control capabilities are permitted only in authenticated publisher/API response memory and the collab client's in-memory parsed value.

Add distinct prompt, option, prefill, answer, request, title, project, and capability canaries. Prompt,
option, prefill, answer, transcript, and capability canaries must remain absent from IPC logs/errors,
list/SSE, URLs/history, browser storage/caches, screenshots/traces, diagnostics, and repository
artifacts. Opaque synthetic request IDs are allowed only in list/SSE, encrypted push, request routes,
volatile DOM/history routing state, and bounded device-local held-ask records. Bounded instance IDs,
generations, and canonical timestamps are also allowed in the device-local Hold/Dismiss records.
Bounded title/project canaries are allowed in encrypted push and visible notification text only for
`session`/`preview`, never in persisted push or local triage state.
- generate photo-flow fixtures in the browser rather than checking real user media into the
  repository; scan gateway requests, browser storage/caches, diagnostics, logs, and retained test
  artifacts for the synthetic pixel/base64 canary. Its only permitted live sinks are volatile
  collab-client memory, the encrypted relay frame, and the receiving OMP test session;
- scan private push state, intercepted encrypted-payload plaintext, visible notification title/body/data, notification tags, app badges, and request-route history against the selected detail contract;

## 3. Integration tests

- synthetic publisher -> registry -> PWA card -> launch fixture;
- two publishers with same PID but different instance IDs;
- three simultaneous publishers and rapid updates;
- daemon restart followed by reconnect/repopulation;
- publisher starts before daemon;
- token rotation and reconnect;
- mutual publisher/gateway proof-vector agreement, stale-proof replay rejection, and fake named-pipe server capability withholding;
- session generation replacement while phone card is open;
- launch race with process exit;
- SSE reconnect and full snapshot;
- Tailscale identity-header proxy fixture with direct backend spoof attempt;
- collab-web parse/connect against mock relay;
- view client write attempt is rejected;
- control prompt/interrupt against mock/real OMP host.
- system camera/photo selection -> metadata-free bounded JPEG preview -> encrypted `prompt.images`
  frame -> real OMP host image prompt, with no gateway HTTP or service-worker media request;
- a pending response operation before any writer exists -> metadata attention -> later Control replay -> exactly one settlement -> authoritative clear;
- concurrent response operations and multiple Control writers preserve one boolean and settle each request once;
- generation replacement clears attention before removal and cannot be mutated by a stale lease;

- browser subscription -> gateway private state -> false-to-true registry transition -> selected-detail push -> service-worker notification;
- true-to-false/removal closes the per-instance notification, updates the badge, and cannot clear a re-armed request; `404`/`410` removes the endpoint;
- notification route revalidates exact current request identity and Control availability before the ordinary generation-bound launch;
## 4. End-to-end acceptance scenarios

### A. Automatic discovery

1. Start gateway and open PWA on Android.
2. Start three OMP processes in different repositories.
3. Do not type `/collab`.
4. All three cards appear within 5 seconds of each host becoming ready.

### B. View and control

1. Open View for process A; transcript streams and write controls are unavailable/rejected.
2. Open Control for process B; submit a benign prompt and interrupt it.
3. Host tools continue to execute on the desktop process, not the phone.
4. From the Pixel Control composer, choose the camera, take a photo, add a note, preview it, and send.
   Repeat without a note. The host receives one bounded JPEG each time and the active model can
   inspect it; View exposes no enabled photo action.
5. Drop one send before host acknowledgement and verify the exact draft remains until Retry is
   acknowledged. Remove a prepared photo, choose an unsupported/over-dimension file, and exceed
   the attachment bound. No rejected media reaches the relay, gateway, OMP transcript, browser
   storage, or test artifacts.

### C. Lifecycle correctness

1. Switch process A to a different OMP session.
2. Old generation becomes unlaunchable before new generation appears.
3. Exit process B normally; card disappears promptly.
4. Kill process C; card disappears no later than TTL.

### D. Phone/background behavior

1. Open a live session.
2. Lock phone briefly, unlock, and resume.
3. Client reconnects automatically without leaving or reopening the session.
4. Switch Wi-Fi/mobile network while Tailscale remains connected. If the browser process remains responsive, the dashboard and active Control/View recover without Refresh or another user action.
   - If Android has a healthy route but Chrome simultaneously fails the gateway, an unrelated origin, and browser-control probes, record the run as a browser-environment failure rather than a PWA pass. The visible directory must keep retrying, name the unreachable path, and open help already carried by the loaded shell only after 45–60 uninterrupted visible failure seconds; offline or hidden time does not count, and no page-level workaround may be claimed to repair the browser process.
5. Android back returns safely without a reusable secret-bearing history entry.
6. Explicitly enable background alerts; page load never prompts. Choose each detail level and verify the gateway builds exactly the permitted title/body while the private state stores no session text.
7. Tap the notification; `/collab/:instanceId?request=:requestId` contains routing metadata only, exact current attention is revalidated, and one tap opens Control only for that request.
8. Exercise offline, tailnet-unreachable, desktop-unreachable, gateway-unavailable, and relay-unavailable states. Verify brief loss uses only `Reconnecting…`, a three-second loss names the path and next retry, recovery briefly confirms `Connected`, and the last authenticated list remains visibly timestamped and reconciles automatically without Refresh.
9. Resolve, replace, expire, and false-to-true re-arm before tapping delayed notifications; each stale request stays on the directory without a capability request for a newer attention.
10. Verify one notification per instance, silent duplicate updates, authoritative clear, and `setAppBadge`/`clearAppBadge` pending counts.
11. Force-stop/disable Chrome notifications and exercise Android battery policy; record best-effort failure behavior without claiming guaranteed delivery.
12. Install a changed shell while the directory is idle; the new worker activates and loads it without Refresh. Repeat during pending/active collaboration; the capability-bearing client remains mounted until ordinary Back/Leave, then the updated directory loads automatically.
13. Hold the oldest request from the dashboard and from an active collaboration shell. Verify the
    next unheld ask opens in FIFO order, the held ask remains in the authoritative pending/badge
    total, only its matching notification closes, and explicit requeue restores it.
14. Hold every waiting request. Verify the device reports a clear couch queue without claiming the
    gateway is all clear, then replace one exact request and verify only that stale hold disappears.
15. Hide a non-attention row, exercise Undo, let a second dismissal expire, and use Show all.
    Verify no network mutation occurs; a new generation or later attention restores visibility
    immediately; live/working totals still include the hidden row; and the UI says OMP keeps
    running rather than claiming Close, Exit, or completion.

### E. Authorization

1. Intended Android identity can access.
2. Public Internet and LAN-only clients cannot reach the service.
3. An unauthorized tailnet identity/device is denied by policy and by app allowlist.
4. Direct access to loopback is impossible remotely; a forged identity header does not bypass the tailnet path.

### F. Persistence

1. Launch and close both view and control sessions.
2. Restart browser and daemon.
3. No previous capability is recoverable from disk/browser history/storage/cache/logs.
4. Live OMP processes republish fresh in-memory records.
5. Device-local Hold/Dismiss state contains only the bounded identifier, generation, and timestamp
   fields; no title, path, model, prompt, transcript, or capability survives there.
6. A prepared-but-unsent photo disappears after remove, Back, reload, or client disposal and is
   absent from gateway/browser persistence and service-worker caches. A sent normalized photo may
   remain only through ordinary OMP transcript and model-provider retention; the original file,
   filename, and EXIF/location metadata do not.

## 5. Relay soak test

For any self-hosted/proxied relay mode:

- run at least a 30-minute continuous transcript stream;
- send periodic bidirectional messages;
- cover Android screen lock/resume;
- record close codes/reconnects without recording payloads or links;
- test path and query preservation required by the relay;
- fail deployment qualification on unexplained periodic disconnects.

## 6. Performance targets

Initial targets, to revise with measurements:

- 50 local OMP publishers without material CPU usage;
- metadata update visible on phone p95 < 2 seconds on a healthy tailnet;
- launch API p95 < 250 ms excluding relay connection;
- daemon idle memory < 100 MiB including embedded static assets;
- no unbounded event/listener/history growth during 8-hour soak.

## 7. Release checklist

- all security acceptance gates pass;
- dependency audit and lockfile review;
- source maps do not contain secrets (they should not) and are not remotely uploaded;
- binaries are reproducible or provenance documented;
- version compatibility matrix recorded;
- install/uninstall tested on every advertised OS;
- no public-listener or Funnel configuration in defaults/examples;
- after stable publication, run `bun run smoke:release` against the published digest on the configured
  local Darwin-arm64 Mac and physical Android client; require exact asset/provenance binding,
  config/token preservation, unrelated Serve preservation, View/Control, forbidden-sink,
  same-page recovery, installed-WebAPK, revocation, and owned-fixture cleanup evidence;
- documentation tells users how to revoke a lost phone and rotate the local token.
