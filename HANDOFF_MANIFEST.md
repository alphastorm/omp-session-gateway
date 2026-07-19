# Implementation handoff

**Updated:** 2026-07-19
**Repository:** `omp-session-gateway`
**Status:** implemented pre-alpha; production acceptance remains blocked

## Implemented

- strict protocol contracts and runtime validation for publisher, metadata, SSE, and launch messages;
- authenticated size-bounded local IPC with generation-aware in-memory storage and monotonic TTL expiry;
- loopback HTTP, fail-closed Tailscale identity allowlisting, exact-Origin mutation checks, SSE, and no-store launch;
- Android-sized installable PWA with metadata-only states and a shell-only service-worker cache;
- OMP `collab-web` pinned to commit `39c95e5e29b1c8b082059f57421ce445c3dffdd4` and patched for one-time in-memory `MessageChannel` bootstrap;
- apply-ready OMP controller/auto-start/publisher patch with lifecycle tests;
- `serve`, `install`, `uninstall`, `status`, `doctor`, redacted `doctor --bundle`, Serve guidance, and token rotation;
- systemd-user, LaunchAgent, and current-user Windows task definitions;
- deterministic Bun-runtime release archive generation with SHA-256 checksums; and
- protocol, registry, IPC, HTTP, configuration, diagnostics, service, browser build, and capability-leak checks.

## Security posture

Capabilities remain structurally separate from metadata, are returned only by explicit generation-bound launch
requests, and are transferred directly to the pinned client in volatile memory. Production config requires
tailnet HTTPS, the daemon binds loopback, identity logins use an exact normalized allowlist, and diagnostics
contain boolean results only. Tailscale Funnel remains unsupported.

## Exact upstream handoff

- OMP source: `can1357/oh-my-pi@39c95e5e29b1c8b082059f57421ce445c3dffdd4`
- nearest release/package baseline: v17.0.5
- collab-web package baseline: 16.3.6
- patch: `patches/oh-my-pi/0001-collab-controller-autostart-registry.patch`
- client provenance: `packages/collab-client/upstream/UPSTREAM.json`

## Validation performed

- `bun run check`: handoff validation, all four workspace typechecks, production web/client build, 36 tests across eight files, and the capability-leak scan passed.
- `bun audit`: no vulnerabilities found.
- `git apply --check patches/oh-my-pi/0001-collab-controller-autostart-registry.patch` against the pinned fixture: passed.
- OMP patch lifecycle fixtures: nine controller/publisher tests passed; all six touched OMP entry points syntax-compiled.
- `bun scripts/build-release.ts` run twice: byte-identical archive checksum.
- Extracted release smoke: repeated `install --no-start` was idempotent with two normalized allowlist entries; diagnostics bundle creation and `uninstall --no-stop` behaved as documented.
- Chromium at 412 × 915: three synthetic sessions rendered without visual overflow; SSE remained ready across a 26-second keepalive observation; stale launch returned `409`; valid launch was `no-store`; the client scrubbed its handoff URL; Local Storage, Session Storage, IndexedDB, history state, and service-worker cache contained no capability; publisher socket close removed all cards promptly.

## Remaining release blockers

- run the complete patch in a full upstream OMP checkout;
- qualify install, permissions, autostart, diagnostics, token rotation, upgrade, and uninstall on Linux, macOS, and Windows;
- run real Tailscale Serve allow/deny tests, LAN/public reachability tests, and relay connectivity/soak tests;
- run Android install, lock/resume, network-change, back-navigation, reconnect, View, Control, and interrupt acceptance;
- configure release signing/provenance credentials before publishing an alpha artifact.

No operating system or Android release is advertised in `docs/COMPATIBILITY.md` until those gates pass.
