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

### HTTP/auth

- missing Tailscale identity denied in production mode;
- disallowed login denied;
- allowed login accepted;
- localhost dev mode refuses non-loopback source;
- exact Origin enforcement;
- content-type/body-size enforcement;
- list/SSE metadata schema;
- launch generation mismatch returns 409;
- expired/missing returns non-enumerating 404;
- view/control availability enforcement;
- all API responses no-store;
- CSP and security headers.

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

Fail on any exact fixture or meaningful substring. The only permitted transient appearances are authenticated IPC/API response memory and the collab client's in-memory parsed value.

## 3. Integration tests

- synthetic publisher -> registry -> PWA card -> launch fixture;
- two publishers with same PID but different instance IDs;
- three simultaneous publishers and rapid updates;
- daemon restart followed by reconnect/repopulation;
- publisher starts before daemon;
- token rotation and reconnect;
- session generation replacement while phone card is open;
- launch race with process exit;
- SSE reconnect and full snapshot;
- Tailscale identity-header proxy fixture with direct backend spoof attempt;
- collab-web parse/connect against mock relay;
- view client write attempt is rejected;
- control prompt/interrupt against mock/real OMP host.

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
3. Client reconnects or gives a clear recovery path.
4. Switch Wi-Fi/mobile network while Tailscale remains connected.
5. Android back returns safely without a reusable secret-bearing history entry.

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
