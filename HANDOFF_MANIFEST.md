# Implementation handoff

**Updated:** 2026-07-20
**Repository:** `omp-session-gateway`
**Status:** implemented pre-alpha; production acceptance remains blocked

## Implemented

- strict protocol contracts and runtime validation for publisher, metadata, SSE, and launch messages;
- mutually authenticated, size- and deadline-bounded local IPC with fresh nonces, no raw key on the wire, generation-aware in-memory storage, and monotonic TTL expiry;
- loopback HTTP, fail-closed Tailscale identity allowlisting, exact-Origin mutation checks, SSE, and no-store launch;
- Android-sized installable PWA with ordered metadata-only snapshot/SSE states, stale-state clearing, and a queryless shell-only service-worker cache;
- OMP `collab-web` pinned to commit `39c95e5e29b1c8b082059f57421ce445c3dffdd4` and patched for one-time in-memory `MessageChannel` bootstrap plus mobile foreground/online transport replacement;
- apply-ready cross-platform OMP controller/auto-start/publisher patch with mutual HMAC authentication, named-pipe squatter resistance, pre-mutation revocation, and post-mutation republish tests;
- `serve`, content-addressed `install`, rollback-safe `uninstall`, authenticated `status`/`doctor`, redacted `doctor --bundle`, Serve guidance, and fail-closed token rotation;
- systemd-user, LaunchAgent, and current-user Windows task definitions;
- deterministic Bun-runtime release archive with the exact dependency lock digest, SPDX 2.3 runtime and distributed-patch inventory, reviewed licenses, and SHA-256 checksums; and
- protocol, registry, IPC, HTTP, configuration, installation, diagnostics, service, browser build, and capability-leak checks.

## Security posture

Capabilities remain structurally separate from metadata, are returned only by explicit generation-bound launch
requests, and are transferred directly to the pinned client in volatile memory. Production config requires
tailnet HTTPS, the daemon binds loopback, identity logins use an exact normalized allowlist, and diagnostics
contain boolean results only. Tailscale Funnel remains unsupported.
Managed startup requires a publisher-token HMAC over a fresh challenge and one-time service-instance
nonce rather than trusting an unauthenticated loopback health body or an older same-token daemon.
Runtime manifests record the readiness protocol; payload digests, prior config, service state, and
current pointers are verified or restored across version upgrades.
Registry publication uses independent client/server nonces and domain-separated HMAC proofs. The
gateway accepts no publisher record until the client proof is valid, and the OMP publisher sends
neither its proof nor any capability until the gateway proof is valid. Mutable authentication-key
and pre-authentication frame buffers are scrubbed when their lifetimes end.

## Exact upstream handoff

- OMP source: `can1357/oh-my-pi@39c95e5e29b1c8b082059f57421ce445c3dffdd4`
- nearest release/package baseline: v17.0.5
- collab-web package baseline: 16.3.6
- patch: `patches/oh-my-pi/0001-collab-controller-autostart-registry.patch`
- client provenance: `packages/collab-client/upstream/UPSTREAM.json`

## Validation performed

- `bun run check`: handoff validation, all four workspace typechecks, production web/client build, 83 tests with 336 assertions across 16 files, and the capability-leak scan passed. The IPC suite now regression-tests three concurrent same-PID publishers, a capacity-rejected fourth connection, rapid heartbeat/generation activity, per-owner isolation, and socket-close cleanup.
- `bun audit`: no vulnerabilities found.
- `git apply --check patches/oh-my-pi/0001-collab-controller-autostart-registry.patch` against the pinned fixture: passed.
- OMP patch lifecycle fixtures: 34 controller/publisher/settings/session-ordering/slash-command tests passed in isolation-safe invocations, including the pinned mutual-HMAC vector, fake-server capability-withholding, and legitimate-server exchange; the full coding-agent package typecheck passed.
- Isolated local mutual-authentication smoke: a real gateway process and synthetic publisher completed the challenge exchange, exposed one metadata-only session at `/api/v1/sessions`, logged only the authentication event, and removed the session immediately when the publisher stopped.
- Current mutual-authentication OMP patch: `bun run ci:check:full` completed cleanly across the full pinned checkout. The preceding lifecycle-hardened revision also passed every official TypeScript test bucket with the native `/tmp` root after temporary exclusion of 32 upstream-baseline-sensitive tests reproduced without the patch; all exclusions were restored. The mutual-authentication delta is covered by the focused fixtures and full coding-agent typecheck above.
- `bun scripts/build-release.ts` plus its release-builder suite: repeated clean-checkout builds were byte-identical; the archive preserved unrelated output and contained the exact lockfile/digest, embedded SPDX inventory, reviewed licenses, and OMP patch component.
- Managed runtime tests proved content-addressed staging, digest verification, atomic pointer activation, and loading a verified runtime created by an older gateway version.
- Chromium at 412 × 915: three synthetic sessions rendered without visual overflow; SSE remained ready across a 26-second keepalive observation; stale launch returned `409`; valid launch was `no-store`; the client scrubbed its handoff URL; Local Storage, Session Storage, IndexedDB, history state, and service-worker cache contained no capability; publisher socket close removed all cards promptly.
- Chromium at 390 × 844: overlapping refresh/online snapshots retained the newest revision after a delayed older response; a lower-revision SSE snapshot could not replace a newer event; transport loss removed all cards; and a query-bearing hashed asset bypassed Cache Storage.
- macOS 26.5.2 arm64 development-checkout qualification: live LaunchAgent install/reinstall, private permissions, atomic token rotation, doctor/bundle, Tailscale Serve allow/deny checks, loopback/LAN isolation, and uninstall passed.
- Debian 13 arm64 systemd-container qualification: live user-service install/autostart, active PID replacement, private permissions, token rotation, and uninstall passed; this is not a bare-metal support claim.
- Hosted Windows source-checkout qualification: [GitHub Actions run `29749928494`](https://github.com/alphastorm/omp-session-gateway/actions/runs/29749928494) applied the pinned OMP patch, passed its real publisher mutual-authentication/fake-server tests and coding-agent typecheck, then passed gateway IPC/config/token ACL checks, current-user publisher access plus cross-user publisher-write denial, UTF-16 scheduled-task install/start, active health/status, atomic token rotation with graceful PID replacement, idempotent active reinstall, and process-clean uninstall.
- Real desktop relay/browser acceptance: three patched interactive OMP processes auto-published; View was read-only, Control prompted and interrupted, `/new` advanced the live generation only after session replacement and the prior generation returned `409`; exited/crashed processes disappeared, secret-free leave navigation passed, and foreground/online events created fresh relay sockets.
- Default-relay endurance qualification: a read-only `GuestClient` against gateway checkout HEAD `6e32bd98386a1ac2c04987bed3476c492a2b2e51` and the pinned OMP baseline plus repository patch remained live for 28,804 seconds, completed with three expected phase transitions, and reported `finalPhase: "live"`; final gateway RSS was 44,384 KiB. The checked-in `bun run qualify:relay-soak` harness reproduced the final-live path in a one-second smoke run.
- Final provenance-test release [`provenance-test-v0.1.0.8`](https://github.com/alphastorm/omp-session-gateway/releases/tag/provenance-test-v0.1.0.8) at post-soak commit `100bebc84f72d61a980c06b094f17909a4856add` ([GitHub Actions run `29737239983`](https://github.com/alphastorm/omp-session-gateway/actions/runs/29737239983)) published the current hardened archive, SPDX inventory, checksum manifest, and three Sigstore bundles. All six immutable-release assets, downloaded checksums, all three GitHub attestations, and all three Cosign bundles verified independently; a clean exact-tag rebuild matched the published archive (`40eccc3dd12d5c25adc8621f1df21907d36c6b8e589456e69b114b32df8a1415`), SBOM (`275d1d4fcd21d3117abe60d2bc6cd9f466b0842cc582e8e380655a73dccaa69f`), and checksum-manifest (`d2750e7569d55c4a0e75e7fc4e54d3957d4ae45a581ec730e02ce78e9dfb63e2`) digests. The archive records its exact source commit and lock digest and contains the reviewed license and OMP patch inventories.

## Remaining release blockers

- qualify the signed candidate artifact on at least one native host with real Serve authorization/isolation, reboot/login persistence, install/doctor/uninstall, diagnostics, upgrade, rollback, token rotation, and complete capability-leak acceptance;
- run physical Android install, lock/resume, radio/network-change, back-navigation, reconnect, View, Control, interrupt, generation replacement, crash-by-TTL, and leak acceptance.

No operating system or Android release is advertised in `docs/COMPATIBILITY.md` until those gates pass.
