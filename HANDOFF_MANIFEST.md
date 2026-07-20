# Implementation handoff

**Updated:** 2026-07-20
**Repository:** `omp-session-gateway`
**Status:** implemented pre-alpha; production acceptance remains blocked

## Implemented

- strict protocol contracts and runtime validation for publisher, metadata, SSE, and launch messages;
- authenticated size-bounded local IPC with generation-aware in-memory storage and monotonic TTL expiry;
- loopback HTTP, fail-closed Tailscale identity allowlisting, exact-Origin mutation checks, SSE, and no-store launch;
- Android-sized installable PWA with metadata-only states and a shell-only service-worker cache;
- OMP `collab-web` pinned to commit `39c95e5e29b1c8b082059f57421ce445c3dffdd4` and patched for one-time in-memory `MessageChannel` bootstrap plus mobile foreground/online transport replacement;
- apply-ready OMP controller/auto-start/publisher patch with pre-mutation revocation and post-mutation republish tests;
- `serve`, `install`, `uninstall`, `status`, `doctor`, redacted `doctor --bundle`, Serve guidance, and token rotation;
- systemd-user, LaunchAgent, and current-user Windows task definitions;
- deterministic Bun-runtime release archive and SPDX 2.3 dependency inventory generation with SHA-256 checksums; and
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

- `bun run check`: handoff validation, all four workspace typechecks, production web/client build, 39 tests across nine files, and the capability-leak scan passed.
- `bun audit`: no vulnerabilities found.
- `git apply --check patches/oh-my-pi/0001-collab-controller-autostart-registry.patch` against the pinned fixture: passed.
- OMP patch lifecycle fixtures: 20 controller/publisher/settings/session-ordering tests passed; the full coding-agent package typecheck passed.
- Full-checkout OMP qualification: `bun run ci:check:full` passed. Every official TypeScript test bucket passed after temporarily excluding 32 upstream-baseline-sensitive tests: two Python completion bridge cases and one Python shortcut case that return cancelled results in an untouched worktree, one UTC/local-date logger case that fails in the untouched worktree during the UTC date boundary, and the 28-test auto-compaction suite whose timing failure reproduced 4/140 times in an untouched worktree. The exclusions were restored after the run; no qualification-only changes are in the patch.
- `bun scripts/build-release.ts` run twice: byte-identical archive checksum.
- Extracted release smoke: repeated `install --no-start` was idempotent with two normalized allowlist entries; diagnostics bundle creation and `uninstall --no-stop` behaved as documented.
- Chromium at 412 × 915: three synthetic sessions rendered without visual overflow; SSE remained ready across a 26-second keepalive observation; stale launch returned `409`; valid launch was `no-store`; the client scrubbed its handoff URL; Local Storage, Session Storage, IndexedDB, history state, and service-worker cache contained no capability; publisher socket close removed all cards promptly.
- macOS 26.5.2 arm64 development-checkout qualification: live LaunchAgent install/reinstall, private permissions, atomic token rotation, doctor/bundle, Tailscale Serve allow/deny/spoof checks, loopback/LAN isolation, and uninstall passed.
- Debian 13 arm64 systemd-container qualification: live user-service install/autostart, active PID replacement, private permissions, token rotation, and uninstall passed; this is not a bare-metal support claim.
- Hosted Windows lifecycle qualification: GitHub Actions run `29715302992` passed config/token ACL checks, UTF-16 scheduled-task install/start, active health/status, atomic token rotation, authenticated exact-Origin graceful PID replacement, active reinstall, and process-clean uninstall.
- Real desktop relay/browser acceptance: three patched interactive OMP processes auto-published; View was read-only, Control prompted and interrupted, `/new` advanced the live generation only after session replacement and the prior generation returned `409`; exited/crashed processes disappeared, secret-free leave navigation passed, and foreground/online events created fresh relay sockets.
- Provenance-test release `provenance-test-v0.1.0.6` (GitHub Actions run `29715568204`) published the archive, SPDX inventory, checksum manifest, and three Sigstore bundles. Downloaded checksums, GitHub attestations, and all Cosign bundles verified independently against the tag and workflow identity. Private vulnerability reporting and immutable releases remain enabled.

## Remaining release blockers

- qualify signed candidate artifacts, upgrade/rollback, reboot/login persistence, and native Linux;
- complete the running eight-hour default-relay soak;
- run physical Android install, lock/resume, radio/network-change, back-navigation, reconnect, View, Control, interrupt, and leak acceptance.

No operating system or Android release is advertised in `docs/COMPATIBILITY.md` until those gates pass.
