# Implementation-agent instructions

This file is the authoritative handoff for implementing **OMP Session Gateway**. It applies to the entire repository unless a more specific `AGENTS.md` is added below a subdirectory.

## Mission

Build a secure, local-first gateway that gives an Android phone zero-touch access to the browser collaboration page for every currently running interactive Oh My Pi (OMP) process on one computer.

The final work has two deliverables:

1. This standalone repository: daemon, dashboard PWA, protocol package, pinned collab-web integration, installers, tests, documentation, and releases.
2. A narrowly scoped OMP patch or upstream PR series: reusable collaboration controller, automatic startup, lifecycle-safe registry publication, and tests.

The dashboard must remain a session directory and capability broker. Do not turn it into a second agent UI.

## Before writing production code

1. Read, in order:
   - `README.md`
   - `docs/DECISIONS.md`
   - `docs/ARCHITECTURE.md`
   - `docs/SECURITY.md`
   - `docs/PROTOCOL.md`
   - `docs/OMP_INTEGRATION.md`
   - `docs/IMPLEMENTATION_PLAN.md`
   - `docs/TEST_PLAN.md`
   - `docs/COMPATIBILITY.md`
2. Inspect current `can1357/oh-my-pi` rather than assuming this handoff is still exact.
3. Pin an exact upstream commit and update `UPSTREAM.lock.json` with the tag, commit SHA, OMP package versions, Bun version, relevant source paths, and observation date.
4. Record any design-changing upstream differences in `docs/DECISIONS.md` before coding around them.
5. Run `bun run check` and keep it green while replacing the handoff-only checks with production lint, typecheck, unit, integration, E2E, and secret-leak tests.

The implementation baseline is OMP v17.0.6 at `89d6a8f6d14286f32f09ec9c8aa8af7b3451d2d6`, observed on 2026-07-21. It is not a permanent compatibility promise.

## Product naming

Use these names consistently:

- Product and repository: **OMP Session Gateway** / `omp-session-gateway`
- Management CLI: `omp-gateway`
- Daemon executable/process: `omp-gatewayd`
- Optional foreground/development alias: `omp-gateway serve`
- OS service identifier: `omp-session-gateway` (Linux unit: `omp-session-gateway.service`)
- PWA home-screen name: **OMP Sessions**
- Default tailnet tag in examples: `tag:omp-session-gateway`

Do not claim affiliation with or endorsement by OMP. Do not reuse OMP artwork without explicit permission.

## Non-negotiable architecture

- Reuse OMP's existing `packages/collab-web` client and wire protocol.
- The PWA lists sessions and launches the existing client; it does not render or mutate session transcripts itself.
- The gateway's production HTTP listener binds to `127.0.0.1` and optionally `::1` only.
- The supported default remote path is Tailscale Serve over tailnet HTTPS.
- Never configure or document Tailscale Funnel as a normal deployment path.
- OMP publication uses a Unix-domain socket on POSIX and a current-user named pipe on Windows.
- IPC also requires a random per-install token with at least 256 bits of entropy and user-only file permissions/ACLs.
- Store the registry only in memory. A daemon restart begins empty.
- Separate metadata records from capability-bearing records in types and storage.
- Session-list and SSE responses contain metadata only.
- Fetch a view/control capability only after an explicit user action.
- Keep the current OMP relay for v1. Treat a self-hosted relay as an optional, separately qualified mode.
- No terminal keystroke injection, pseudo-terminal scraping, QR decoding, clipboard monitoring, process-memory inspection, or saved-session-file scraping.

## Capability handling rules

Both view and control links are bearer secrets. They may appear only in:

- the live OMP process;
- authenticated local IPC request memory;
- the gateway's in-memory secret store;
- a single no-store launch response; and
- the collab client's volatile JavaScript memory.

A URL fragment is permitted only as a temporary compatibility fallback that is synchronously removed and exhaustively tested for non-persistence.

They must never appear in:

- files or databases;
- ordinary logs, debug serialization, tracing spans, metrics labels, crash reports, or diagnostics bundles;
- query strings, paths, cookies, Local Storage, Session Storage, IndexedDB, or Cache Storage;
- service-worker caches or precache manifests;
- analytics, error-reporting, remote fonts, third-party scripts, or CDNs;
- issue fixtures, screenshots, recordings, or CI artifacts.

Use synthetic distinctive secrets in tests and fail the suite if they leak into any forbidden sink.

JavaScript strings cannot be reliably zeroized. Minimize lifetime, references, and persistence rather than claiming memory zeroization.

## Required OMP integration

Refactor the existing `/collab` lifecycle behind one shared controller. Both manual commands and auto-start must delegate to it; do not duplicate `CollabHost` ownership.

Proposed settings, with upstream-safe defaults:

```jsonc
{
  "collab": {
    "autoStart": "off",       // "off" | "view" | "control"
    "registryEndpoint": "auto" // "auto" | "off" | explicit local IPC path
  }
}
```

Behavior:

- `off` preserves current OMP behavior.
- `view` starts collaboration but publishes only a view capability.
- `control` publishes both view and control capabilities.
- Network URLs are invalid for `registryEndpoint`; it is local IPC only.
- Start after interactive context and session initialization are complete.
- Register only after the collaboration host connects successfully.
- Revoke generation N before publishing generation N+1 on switch, branch, resume, tree navigation, relay replacement, or any lifecycle that replaces the active host/session.
- `/collab stop`, shutdown, and fatal host failure unregister immediately.
- A missing gateway never breaks normal OMP operation. Retry with bounded, jittered backoff and no repetitive UI noise.
- Preserve `/collab`, `/collab view`, `/collab status`, `/collab stop`, `/join`, and `/leave` behavior.

The current public extension API exposes lifecycle events and managed timers but does not document a supported operation for starting/owning the built-in `CollabHost`. Do not rely on unstable private imports. A later supported `ctx.collab` API may allow publication to move into an extension.

See `docs/OMP_INTEGRATION.md`.

## Workspace implementation targets

### `packages/protocol`

Own versioned TypeScript contracts, strict runtime validation, redacted fixtures, and protocol constants. Secret-bearing types must be structurally distinct from browser-facing metadata types.

### `apps/gateway`

Implement:

- secure config and publisher-token management;
- Unix socket / named-pipe registry server;
- strict size-limited NDJSON parser;
- generation-aware in-memory registry and TTL sweeper;
- loopback HTTP server;
- Tailscale Serve identity middleware and exact allowlist;
- metadata list, SSE, just-in-time launch, health, and diagnostics endpoints;
- static PWA/client asset serving;
- `serve`, `install`, `uninstall`, `status`, `doctor`, and token-rotation commands;
- privacy-safe structured logging.

Do not implement a relay in this package for v1.

### `apps/web`

Implement a mobile-first installable PWA with:

- live metadata-only session cards;
- empty, offline, expired, unauthorized, and generation-race states;
- explicit View and Control actions;
- safe Android back behavior;
- no third-party runtime assets;
- a service worker that caches only immutable application-shell files and always bypasses `/api/`, `/client/` bootstrap traffic, navigation, non-GET requests, and launch responses.

### `packages/collab-client`

Pin and build OMP's existing `collab-web`. Preferred integration order:

1. consume an official upstream artifact/package;
2. build a pinned upstream source subtree/submodule;
3. vendor reviewed static output with exact source SHA and reproducible build notes.

Implement or upstream an in-memory bootstrap API such as `startWithCapability(capability)`. For a separate same-origin client page, transfer the value through a one-time `MessageChannel`. Keep ephemeral-fragment parsing only as a temporary fallback: parse synchronously, remove the fragment immediately with `history.replaceState`, and prove it is absent from history, caches, screenshots, traces, and copied URLs. Reload returns to the gateway.

### `patches/oh-my-pi`

Store patch files, upstream PR links, commit SHAs, rebase notes, and compatibility findings. Keep generated assets and unrelated refactors out of the OMP patch.

## HTTP and browser requirements

- Production auth mode rejects missing Tailscale identity headers.
- Normalize and compare `Tailscale-User-Login` to an exact configured allowlist.
- Trust identity headers only because the backend is loopback-only behind Tailscale Serve.
- A separate development mode may permit loopback clients without Tailscale; it must refuse non-loopback sources.
- Validate exact `Origin` on all state-changing requests; also evaluate `Sec-Fetch-Site` defensively.
- No wildcard CORS.
- Set strict CSP, `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`, frame protections, and narrow Permissions Policy.
- Every API and launch response is `no-store`.
- Launch requests include the expected `generation`; stale cards receive a conflict/expired response rather than a newer capability.
- Do not place capabilities in redirect `Location` headers or any URL component. Return JSON to same-origin JavaScript, which transfers the value directly into the pinned collab client in memory. Fragment navigation is a temporary compatibility fallback only.

## Reliability requirements

- Recommended heartbeat: 10 seconds; TTL: 35 seconds. Make both bounded configuration values.
- Use daemon receipt time from a monotonic clock for expiry.
- Socket close may remove immediately; TTL remains the crash safety net.
- Publisher reconnect is idempotent and generation-aware.
- Daemon restart begins empty and is repopulated only by live OMP processes.
- Bound publishers, records, frame sizes, request bodies, SSE queues, titles, paths, and reconnect rates.
- Do not let extension/background timer exceptions terminate OMP.

## Test and release gates

Before calling any release usable, all gates in `docs/TEST_PLAN.md` must pass, including:

1. Three independent OMP processes appear automatically on an Android-sized client.
2. View cannot write; Control can prompt and interrupt.
3. Old generations are unlaunchable before replacements become visible.
4. Normal exit removes promptly; crash removes by TTL.
5. Unauthorized public, LAN, and tailnet clients cannot reach session data or capabilities.
6. Known test capabilities do not appear in logs, files, browser storage, history, caches, diagnostics, or CI artifacts.
7. Install/doctor/uninstall work on every advertised OS.
8. Android lock/resume, network change, back navigation, and reconnect have explicit E2E coverage.
9. Any self-hosted/proxied relay mode passes a long-lived WebSocket soak test before documentation marks it supported.

## Implementation order

Follow `docs/IMPLEMENTATION_PLAN.md`. In summary:

- Milestone 0: repository, CI, contracts, and security test harness.
- Milestone 1: synthetic publisher, in-memory registry, metadata API, and PWA.
- Milestone 2: just-in-time launch and pinned collab-web.
- Milestone 3: OMP controller, auto-start, publisher, and lifecycle tests.
- Milestone 4: OS packaging, Tailscale operations, and Android E2E.
- Milestone 5: security review and first alpha.

Do not begin WebAuthn, a TWA wrapper, push notifications, multi-host federation, or a self-hosted relay before the v1 path passes its acceptance suite.

## Commit and PR discipline

- Keep each milestone reviewable and independently tested.
- Prefer conventional commit subjects (`feat:`, `fix:`, `docs:`, `test:`, `chore:`).
- Include threat-model impact in PR descriptions for auth, IPC, browser storage, launch, logging, and OMP lifecycle changes.
- Never include a real collaboration link in commits, tests, screenshots, or issue text.
- Add or update tests with every behavior change.
- Record accepted architectural changes in `docs/DECISIONS.md`.
- Update `CHANGELOG.md`, compatibility data, and operations docs before releases.

## Definition of done

The project is done for v1 when a user can perform one-time installation and tailnet setup, open **OMP Sessions** on Android, and securely view/control every active OMP process without typing `/collab` or copying links; lifecycle changes cannot expose stale control capabilities; and the full security/acceptance suite passes on all advertised platforms.

At implementation handoff, provide:

- a clean commit history;
- a concise architecture/security summary;
- exact OMP baseline and patch/PR references;
- commands and results for all validation suites;
- known limitations and deferred work; and
- no unsupported claims of production readiness.
