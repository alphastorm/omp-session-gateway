# Implementation handoff

**Updated:** 2026-07-21
**Repository:** `omp-session-gateway`
**Status:** implemented pre-alpha; production acceptance remains blocked

## Implemented

- strict protocol contracts and runtime validation for publisher, metadata, SSE, and launch messages, including a boolean-only response-required field with no collaboration content;
- mutually authenticated, size- and deadline-bounded local IPC with fresh nonces, no raw key on the wire, generation-aware in-memory storage, monotonic TTL expiry, and same-generation attention updates;
- loopback HTTP, fail-closed Tailscale identity allowlisting, exact-Origin mutation checks, metadata-only SSE, and no-store launch;
- Android-sized installable PWA with attention-first cards, ordered metadata-only snapshot/SSE states, stale-state clearing, explicit foreground notification opt-in, and a queryless shell-only service-worker cache;
- OMP `collab-web` pinned to commit `89d6a8f6d14286f32f09ec9c8aa8af7b3451d2d6` and patched for an installed-PWA same-document in-memory bootstrap, a one-time `MessageChannel` browser fallback, and mobile foreground/online transport replacement;
- apply-ready four-commit OMP controller/auto-start/publisher patch with mutual HMAC authentication, pre-writer response-request retention, generation-scoped attention leases, collaboration-aware response races, startup-before-hooks ordering, named-pipe squatter resistance, daemon-restart/token-rotation and host-suspension reconnect, ambient child-tool configuration preservation, bounded same-generation metadata refresh, pre-mutation revocation, and post-mutation republish tests;
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

- OMP source: `can1357/oh-my-pi@89d6a8f6d14286f32f09ec9c8aa8af7b3451d2d6`
- nearest release/package baseline: v17.0.6
- collab-web package baseline: 16.3.6
- patch: `patches/oh-my-pi/0001-collab-controller-autostart-registry.patch`
- client provenance: `packages/collab-client/upstream/UPSTREAM.json`

## Validation performed

- `bun run check`: handoff validation, all four workspace typechecks, production web/client build, 97 tests with 446 assertions across 18 files, and the capability-leak scan passed. The IPC suite covers same-generation false-to-true-to-false attention transitions in addition to three concurrent same-PID publishers, capacity rejection, rapid heartbeat/generation activity, per-owner isolation, socket-close cleanup, silent authenticated idle close, and lost-heartbeat-state reconnect signaling; a separate real IPC case authenticates, upserts, heartbeats, and removes 50 concurrent same-PID publishers.
- `bun run test:browser`: four cases across two Android-sized Chromium projects passed same-document no-popup View/Control launch, Back navigation, attention ordering, explicit notification permission/dedupe, prompt-content canary exclusion, service-worker support handshake, and notification-click routing to `/`.
- `bun audit`: no vulnerabilities found.
- `git apply --check patches/oh-my-pi/0001-collab-controller-autostart-registry.patch` against the pristine v17.0.6 pin: passed.
- OMP attention-path fixtures: 114 controller, publisher, retained-request, read-only, response-UI, hook-editor, startup-ordering, settings, session-ordering, and slash-command tests with 531 assertions passed together. They cover same-generation label refresh and bounds, generation-scoped nested/concurrent attention leases, zero-writer retention, the 64-request admission cap, View exclusion, multi-writer exactly-once settlement, symmetric response-race cleanup, collaboration-before-hooks ordering, mutual HMAC authentication, reconnect/token reread, and explicit-token-path isolation.
- Isolated local mutual-authentication smoke: a real gateway process and synthetic publisher completed the challenge exchange, exposed one metadata-only session at `/api/v1/sessions`, logged only the authentication event, and removed the session immediately when the publisher stopped.
- Live metadata refresh smoke: one patched interactive OMP process published its initial `provider/model` label through the live candidate gateway; `/rename`, `/move`, and two model-cycle events advanced directory revisions 14 through 18 while retaining instance and generation 1, and shutdown removed the card at revision 19.
- Host-suspension recovery experiment: the exact patched OMP publisher and gateway were suspended beyond a five-second test TTL, then resumed gateway-first, publisher-first, and together. All three orders retained or republished the session within eight seconds; gateway-first and simultaneous resume exercised expiry, clean authenticated disconnect, mutual re-authentication, and full upsert. This finite missed-timer reproduction does not replace actual macOS sleep/wake qualification.
- The complete patched checkout passed `bun run ci:check:full`. Every official TypeScript test outside five upstream-baseline failures passed in its official bucket; the same two completion-runtime failures, two status-path failures, and one session-file timestamp-ordering failure reproduce unchanged on pristine `89d6a8f6d`. No patch-specific failure remained.
- `bun scripts/build-release.ts` plus its release-builder suite: repeated clean-checkout builds were byte-identical; the archive preserved unrelated output and contained the exact lockfile/digest, embedded SPDX inventory, reviewed licenses, and OMP patch component.
- Managed runtime tests proved content-addressed staging, digest verification, atomic pointer activation, and loading a verified runtime created by an older gateway version.
- Chromium at 412 × 915: three synthetic sessions rendered without visual overflow; SSE remained ready across a 26-second keepalive observation; stale launch returned `409`; valid launch was `no-store`; the client scrubbed its handoff URL; Local Storage, Session Storage, IndexedDB, history state, and service-worker cache contained no capability; publisher socket close removed all cards promptly.
- Chromium at 390 × 844: overlapping refresh/online snapshots retained the newest revision after a delayed older response; a lower-revision SSE snapshot could not replace a newer event; transport loss removed all cards; and a query-bearing hashed asset bypassed Cache Storage.
- Chromium at 412 × 915 and 390 × 844 rendered branded attention cards first, kept View primary and unavailable Control disabled, prompted for notifications only after the explicit action, emitted only the fixed title plus approved session label, deduplicated true-to-true snapshots, rearmed after false, and routed synthetic worker notification clicks to `/`. This is browser automation, not physical Android or lock-screen qualification.
- Isolated production-path attention smoke: a real dev-localhost gateway and mutually authenticated publisher drove same-generation false-to-true-to-false metadata through IPC, registry, SSE, and the built dashboard. Chromium observed the accessible attention description, authoritative clear, and removal at `/`; Local/Session Storage, cookies, history state, DOM, gateway logs, and cached shell state contained no synthetic capability marker.
- macOS 26.5.2 arm64 development-checkout qualification: live LaunchAgent install/reinstall, private permissions, atomic token rotation, doctor/bundle, Serve access as the allowlisted node identity, loopback-backend identity rejection, loopback/LAN isolation, and uninstall passed. Distinct-device allowlist isolation remains unqualified.
- Debian 13 arm64 systemd-container qualification: live user-service install/autostart, active PID replacement, private permissions, token rotation, and uninstall passed; this is not a bare-metal support claim.
- Hosted Windows source-checkout qualification: [GitHub Actions run `29791906104`](https://github.com/alphastorm/omp-session-gateway/actions/runs/29791906104) applied the exact candidate OMP patch, passed all eleven publisher fixtures—including mutual authentication, fake-server withholding, restart recovery, post-restart token reread, and explicit-token-path publication preserving ambient XDG configuration—and the coding-agent typecheck, then passed gateway IPC/config/token ACL checks, current-user publisher access plus cross-user publisher-write denial, UTF-16 scheduled-task install/start, active health/status, atomic token rotation with graceful PID replacement, idempotent active reinstall, and process-clean uninstall.
- Real desktop relay/browser acceptance: three patched interactive OMP processes auto-published; View was read-only, Control prompted and interrupted, `/new` advanced the live generation only after session replacement and the prior generation returned `409`; exited/crashed processes disappeared, secret-free leave navigation passed, and foreground/online events created fresh relay sockets.
- Default-relay endurance qualification: the original read-only `GuestClient` run remained live for 28,804 seconds through three expected phase transitions. After `v0.1.0-prealpha.1` exposed terminal handling of transient room replacement, deterministic recovery tests and a live smoke qualified the fix; the signed `v0.1.0-prealpha.2` rerun then completed 28,800 seconds through eight transitions with `finalPhase: "live"`, exit code 0, no restart, and gateway RSS moving from 45,776 KiB to 46,496 KiB (+720 KiB).
- Physical Android `v0.1.0-prealpha.4` qualification: Pixel 10 Pro, Android 17 build `CP2A.260705.006` (SDK 37), Chrome `150.0.7871.128` passed corrected same-document View/Control, read-only View, Android Back, retained prompt presentation, exactly-once response, attention clearing, metadata-only foreground and lock-screen notification, dashboard-only notification tap, lock/resume, Wi-Fi/cellular transition, automatic relay reconnect, generation replacement with stale `409`, and TTL removal/republication. Distinct-device denial, deep physical-browser sink inspection, physical interrupt, remaining switch/branch/saved-session resume cases, and signed native-host release qualification remain open.
- Corrected provenance-test release [`provenance-test-v0.1.0.10`](https://github.com/alphastorm/omp-session-gateway/releases/tag/provenance-test-v0.1.0.10) at protected-main merge commit `1c33c90252643d7d0f572fe57a0e560f00b72afb` ([GitHub Actions run `29792234310`](https://github.com/alphastorm/omp-session-gateway/actions/runs/29792234310)) published the sleep-recovery archive, SPDX inventory, checksum manifest, and three Sigstore bundles. All six immutable-release assets, downloaded checksums, all three GitHub attestations, and all three Cosign bundles verified independently; a clean exact-tag rebuild was byte-identical for the archive (`b446d405d97c2bec181b9d0f4be03c83ede7407d24d603a9d117be428b95576e`), SBOM (`4cb0b1b2c81fdcaf56044cd38259a9ad979bff88efd75ca9a7a2fe3f30d6e8f1`), and checksum-manifest (`08d28faa291f7b374dc8d6d88656c5e7e84cda93f65707acdc6a530415b39326`) digests. The archive records its exact source commit and lock digest and contains the reviewed license and OMP patch inventories.
- Signed-candidate packaging/runtime smoke: the downloaded and independently verified `provenance-test-v0.1.0.10` archive installed with `--no-start` into an isolated macOS root, launched through the real Serve mapping, and authenticated three reconnect-capable patched OMP publisher fixtures. A gateway restart restored all three cards in approximately 227 ms; a real patched OMP process auto-published and revoked on shutdown; and gateway/publisher suspension beyond TTL expired then restored the card within eight seconds in all three resume orders. This does not replace complete LaunchAgent, distinct-device identity, actual sleep/wake and relay/browser recovery, real collaboration, or physical Android qualification.

## Remaining release blockers

- qualify the signed candidate artifact on at least one native host with real Serve authorization/isolation, reboot/login persistence, install/doctor/uninstall, diagnostics, upgrade, rollback, token rotation, and complete capability-leak acceptance;
- run physical Android install, lock/resume, radio/network-change, back-navigation, reconnect, View, Control, interrupt, generation replacement, crash-by-TTL, and leak acceptance.

No operating system or Android release is advertised in `docs/COMPATIBILITY.md` until those gates pass.
