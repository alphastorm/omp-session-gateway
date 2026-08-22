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
and volatile DOM/history routing state. Bounded title/project canaries are allowed in encrypted push
and visible notification text only for `session`/`preview`, never in persisted push state.
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
   - If Android has a healthy route but Chrome simultaneously fails the gateway, an unrelated origin, and browser-control probes, record the run as a browser-environment failure rather than a PWA pass. The visible directory must keep retrying, name the unreachable path, and offer local force-stop/reopen guidance after 45–60 seconds; no page-level workaround may be claimed to repair the browser process.
5. Android back returns safely without a reusable secret-bearing history entry.
6. Explicitly enable background alerts; page load never prompts. Choose each detail level and verify the gateway builds exactly the permitted title/body while the private state stores no session text.
7. Tap the notification; `/collab/:instanceId?request=:requestId` contains routing metadata only, exact current attention is revalidated, and one tap opens Control only for that request.
8. Exercise offline, tailnet-unreachable, desktop-unreachable, gateway-unavailable, and relay-unavailable states. Verify brief loss uses only `Reconnecting…`, a three-second loss names the path and next retry, recovery briefly confirms `Connected`, and the last authenticated list remains visibly timestamped and reconciles automatically without Refresh.
9. Resolve, replace, expire, and false-to-true re-arm before tapping delayed notifications; each stale request stays on the directory without a capability request for a newer attention.
10. Verify one notification per instance, silent duplicate updates, authoritative clear, and `setAppBadge`/`clearAppBadge` pending counts.
11. Force-stop/disable Chrome notifications and exercise Android battery policy; record best-effort failure behavior without claiming guaranteed delivery.
12. Install a changed shell while the directory is idle; the new worker activates and loads it without Refresh. Repeat during pending/active collaboration; the capability-bearing client remains mounted until ordinary Back/Leave, then the updated directory loads automatically.

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
- documentation tells users how to revoke a lost phone and rotate the local token.
