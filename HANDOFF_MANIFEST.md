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
- apply-ready cross-platform OMP controller/auto-start/publisher patch with mutual HMAC authentication, named-pipe squatter resistance, daemon-restart/token-rotation and host-suspension reconnect, ambient child-tool configuration preservation, pre-mutation revocation, and post-mutation republish tests;
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

- `bun run check`: handoff validation, all four workspace typechecks, production web/client build, 85 tests with 344 assertions across 16 files, and the capability-leak scan passed. The IPC suite regression-tests three concurrent same-PID publishers plus capacity rejection, rapid heartbeat/generation activity, per-owner isolation, socket-close cleanup, silent authenticated idle close, and lost-heartbeat-state reconnect signaling; a separate real IPC case authenticates, upserts, heartbeats, and removes 50 concurrent same-PID publishers.
- `bun audit`: no vulnerabilities found.
- `git apply --check patches/oh-my-pi/0001-collab-controller-autostart-registry.patch` against the pinned fixture: passed.
- OMP patch lifecycle fixtures: 36 controller/publisher/settings/session-ordering/slash-command tests passed in isolation-safe invocations, including the pinned mutual-HMAC vector, fake-server capability-withholding, legitimate-server exchange, deterministic daemon-restart recovery that rereads a rotated token before republishing, and explicit-token-path publication that preserves ambient XDG configuration; the full coding-agent package typecheck passed.
- Isolated local mutual-authentication smoke: a real gateway process and synthetic publisher completed the challenge exchange, exposed one metadata-only session at `/api/v1/sessions`, logged only the authentication event, and removed the session immediately when the publisher stopped.
- Host-suspension recovery experiment: the exact patched OMP publisher and gateway were suspended beyond a five-second test TTL, then resumed gateway-first, publisher-first, and together. All three orders retained or republished the session within eight seconds; gateway-first and simultaneous resume exercised expiry, clean authenticated disconnect, mutual re-authentication, and full upsert. This finite missed-timer reproduction does not replace actual macOS sleep/wake qualification.
- Current mutual-authentication OMP patch: `bun run ci:check:full` completed cleanly across the full pinned checkout. The preceding lifecycle-hardened revision also passed every official TypeScript test bucket with the native `/tmp` root after temporary exclusion of 32 upstream-baseline-sensitive tests reproduced without the patch; all exclusions were restored. The mutual-authentication delta is covered by the focused fixtures and full coding-agent typecheck above.
- `bun scripts/build-release.ts` plus its release-builder suite: repeated clean-checkout builds were byte-identical; the archive preserved unrelated output and contained the exact lockfile/digest, embedded SPDX inventory, reviewed licenses, and OMP patch component.
- Managed runtime tests proved content-addressed staging, digest verification, atomic pointer activation, and loading a verified runtime created by an older gateway version.
- Chromium at 412 × 915: three synthetic sessions rendered without visual overflow; SSE remained ready across a 26-second keepalive observation; stale launch returned `409`; valid launch was `no-store`; the client scrubbed its handoff URL; Local Storage, Session Storage, IndexedDB, history state, and service-worker cache contained no capability; publisher socket close removed all cards promptly.
- Chromium at 390 × 844: overlapping refresh/online snapshots retained the newest revision after a delayed older response; a lower-revision SSE snapshot could not replace a newer event; transport loss removed all cards; and a query-bearing hashed asset bypassed Cache Storage.
- macOS 26.5.2 arm64 development-checkout qualification: live LaunchAgent install/reinstall, private permissions, atomic token rotation, doctor/bundle, Tailscale Serve allow/deny checks, loopback/LAN isolation, and uninstall passed.
- Debian 13 arm64 systemd-container qualification: live user-service install/autostart, active PID replacement, private permissions, token rotation, and uninstall passed; this is not a bare-metal support claim.
- Hosted Windows source-checkout qualification: [GitHub Actions run `29761604154`](https://github.com/alphastorm/omp-session-gateway/actions/runs/29761604154) applied the exact pinned OMP patch, passed all ten publisher fixtures—including mutual authentication, fake-server withholding, restart recovery, and post-restart token reread—and the coding-agent typecheck, then passed gateway IPC/config/token ACL checks, current-user publisher access plus cross-user publisher-write denial, UTF-16 scheduled-task install/start, active health/status, atomic token rotation with graceful PID replacement, idempotent active reinstall, and process-clean uninstall.
- Real desktop relay/browser acceptance: three patched interactive OMP processes auto-published; View was read-only, Control prompted and interrupted, `/new` advanced the live generation only after session replacement and the prior generation returned `409`; exited/crashed processes disappeared, secret-free leave navigation passed, and foreground/online events created fresh relay sockets.
- Default-relay endurance qualification: a read-only `GuestClient` against gateway checkout HEAD `6e32bd98386a1ac2c04987bed3476c492a2b2e51` and the pinned OMP baseline plus repository patch remained live for 28,804 seconds, completed with three expected phase transitions, and reported `finalPhase: "live"`; final gateway RSS was 44,384 KiB. The checked-in `bun run qualify:relay-soak` harness reproduced the final-live path in a one-second smoke run.
- Final provenance-test release [`provenance-test-v0.1.0.9`](https://github.com/alphastorm/omp-session-gateway/releases/tag/provenance-test-v0.1.0.9) at protected-main merge commit `9048b8163664a7c710a7fb94de7f04b7c534a4c8` ([GitHub Actions run `29762023088`](https://github.com/alphastorm/omp-session-gateway/actions/runs/29762023088)) published the current mutual-authentication-hardened archive, SPDX inventory, checksum manifest, and three Sigstore bundles. All six immutable-release assets, downloaded checksums, all three GitHub attestations, and all three Cosign bundles verified independently; a clean exact-tag rebuild was byte-identical for the archive (`652af41fe7e27af6b6f716b4012d550e8a59428f248aff65f28abb108e70b02c`), SBOM (`5640b406ceff1d4807b49181e5b0cf22c19bb8c046fb081732a9f1b556bc4997`), and checksum-manifest (`bf2303802e4010db76101a0c5bae59dc3f186b011c9b989ba26dd27f009fa564`) digests. The archive records its exact source commit and lock digest and contains the reviewed license and OMP patch inventories.
- Signed-candidate packaging/runtime smoke: the downloaded and independently verified `provenance-test-v0.1.0.9` archive installed with `--no-start` into an isolated macOS root, launched the installed runtime, mutually authenticated three synthetic publishers, returned metadata-only directory records and a no-store just-in-time launch response, removed all records after publisher exit, and exposed the three-card PWA plus health/session APIs through the existing real Tailscale Serve mapping. Canary capability and publisher-token scans of gateway and publisher logs were empty. This does not replace native lifecycle, identity-isolation, real OMP, or physical Android qualification.

## Remaining release blockers

- qualify the signed candidate artifact on at least one native host with real Serve authorization/isolation, reboot/login persistence, install/doctor/uninstall, diagnostics, upgrade, rollback, token rotation, and complete capability-leak acceptance;
- run physical Android install, lock/resume, radio/network-change, back-navigation, reconnect, View, Control, interrupt, generation replacement, crash-by-TTL, and leak acceptance.

No operating system or Android release is advertised in `docs/COMPATIBILITY.md` until those gates pass.
