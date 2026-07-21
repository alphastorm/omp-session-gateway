# Release status

**Updated:** 2026-07-21<br>
**Repository version:** `0.1.0` (`v0.1.0-prealpha.2`; no alpha)<br>
**Classification:** implemented pre-alpha<br>
**Alpha decision:** **NO-GO**<br>
**Advertised host/client platforms:** none

The repository implements the intended v1 path and may publish deterministic Bun-runtime
pre-alpha archives for evaluation. It is not production-qualified, no alpha artifact is
approved for publication, and no operating system, browser, or Android device is currently
supported. Repository commits, pre-alpha archives, and provenance-test archives are engineering
inputs for qualification only.

This ledger is the source of truth for the current release decision. Compatibility claims live
in [`COMPATIBILITY.md`](COMPATIBILITY.md); required scenarios are defined in
[`TEST_PLAN.md`](TEST_PLAN.md); the detailed implementation evidence is recorded in
[`../HANDOFF_MANIFEST.md`](../HANDOFF_MANIFEST.md).

## Status rules

| Status | Meaning |
|---|---|
| **PASS** | The named scope has current, reproducible evidence. It says nothing about a broader scope. |
| **PARTIAL** | Some automated or smoke evidence exists, but the complete release scenario has not passed. |
| **NOT RUN** | No completed result is recorded for the required environment or scenario. |
| **BLOCKED** | A known prerequisite prevents completion or publication. |
| **N/A** | Deliberately excluded from this release and not advertised. |

An alpha requires every applicable release-blocking row below to be **PASS**. Automated tests,
mocks, a desktop mobile viewport, or generated service definitions do not substitute for native
OS, real Tailscale, real relay, or Android qualification.

## Recorded implementation evidence

These checks establish the implemented pre-alpha baseline; they do not resolve the acceptance
gaps in the next section.

| Scope | Status | Recorded evidence |
|---|---|---|
| Exact upstream pin | **PASS** | `UPSTREAM.lock.json` pins `can1357/oh-my-pi@39c95e5e29b1c8b082059f57421ce445c3dffdd4`, nearest release `v17.0.5`, with package and Bun versions. |
| Repository check | **PASS** | `bun run check` passed handoff validation, four workspace typechecks, production web/client builds, 85 tests with 344 assertions across 16 files, and capability-leak scanning. Real IPC coverage includes three concurrent same-PID publishers plus capacity rejection and rapid replacement activity, silent authenticated idle close, lost-heartbeat-state reconnect signaling, and a separate 50-publisher authentication/upsert/heartbeat/socket-close cleanup case. |
| Host-suspension recovery experiment | **PASS** | The downloaded and independently verified `provenance-test-v0.1.0.10` gateway plus the exact patched OMP publisher were suspended beyond a five-second test TTL, then resumed gateway-first, publisher-first, and together. Every order first lost the expired card, mutually re-authenticated, sent a full upsert, and restored one session within eight seconds. This finite missed-timer reproduction does not replace actual macOS sleep/wake qualification. |
| Dependency audit | **PASS** | `bun audit` reported no vulnerabilities for the recorded lockfile. |
| OMP patch application and lifecycle fixtures | **PASS** | Patch apply-check passed against the pristine pin; 41 controller/metadata/publisher/settings/session-ordering/slash-command tests with 164 assertions—including same-generation title/CWD/model refresh, 256-code-point label bounds, the mutual-HMAC vector, fake-server withholding, legitimate exchange, deterministic daemon-restart recovery that rereads a rotated token before republishing, and explicit-token-path publication that preserves ambient XDG configuration—and the full coding-agent package typecheck passed. |
| Registry mutual authentication | **PASS** | Shared gateway and standalone OMP proof-vector tests agree; stale client proof replay is rejected; a fake server receives only `hello`; and an isolated real gateway/synthetic-publisher smoke published metadata then revoked it on disconnect without key/capability log output. |
| Full pinned OMP checkout | **PASS** | The current metadata-refresh patch passed `bun run ci:check:full` across the full pin. The preceding lifecycle revision passed every official TypeScript test bucket with documented upstream-baseline exclusions restored afterward; the current delta is covered by focused fixtures, the coding-agent typecheck, and live directory smoke. |
| Deterministic runtime archive | **PASS** | Two clean local builds from hardening commit `99e34ee866d30dbb6424346404dc293727daa319` produced byte-identical 848,896-byte archives, SPDX 2.3 inventories, and checksum manifests. `SHA256SUMS` verified archive digest `7c25c37dd25bf2e93f7b8c48d1f0214c51f46709d82fcb830f7a0b7aae80e472` and SPDX digest `730097f950f9f2f4684b0358907870b889f32b690f7a6bbfe0d544be50b686fd`; `release-info.json` pins that source commit, upstream `39c95e5e29b1c8b082059f57421ce445c3dffdd4`, and the exact lock digest. This is unsigned local preflight, not signed-candidate qualification. |
| Extracted archive command smoke | **PASS** | The hardening archive's bundled CLI completed `--help`, isolated `install --no-start`, inactive `status`, Serve guidance, redacted `doctor --bundle`, and `uninstall --no-stop` on macOS arm64 without touching the live trial. The generated publisher token was 43 bytes with mode `0600`, its config directory was `0700`, and its bytes appeared in no other smoke file or diagnostic; the synthetic login, tailnet host, and full smoke path were also absent from diagnostics. A fresh archive from commit `a514c9ca8ab9611dd934c09b5ddc8dd2074c2ac7` then ran its bundled gateway on an isolated loopback port, mutually authenticated three source-checkout publishers, returned metadata-only revision 3, served a no-store in-memory launch response, rejected a stale generation with `409` and no capability field, and removed all records on publisher socket close at revision 6. |
| Desktop mobile-viewport browser smoke | **PASS** | Chromium at `412 × 915` rendered three synthetic sessions; SSE, generation conflict, no-store launch, URL scrub, storage/cache checks, and prompt socket-close removal passed. A separate `390 × 844` run proved overlapping snapshot/SSE revision ordering, stale-metadata clearing on transport loss, and query-bearing asset cache bypass. The extracted `a514c9c` runtime repeated the `412 × 915` path: its client popup used `/client/` with no query, fragment, referrer, cookie, history state, Local/Session Storage, IndexedDB, or secret-bearing resource URL; Cache Storage contained only the two immutable app assets, recovery returned to `/`, and SSE exposed the empty state immediately after socket-close removal. |
| macOS/Tailscale development-checkout qualification | **PASS** | macOS 26.5.2 arm64 completed live LaunchAgent install/reinstall, permissions, token rotation, diagnostics bundle, Serve access as the allowlisted node identity, loopback-backend identity rejection, loopback/LAN isolation, and uninstall. Distinct-device allowlist isolation remains a separate gate below. |
| Linux container lifecycle qualification | **PASS** | Debian 13 arm64 with a real systemd user manager completed the development-checkout lifecycle and repeated it from unsigned extracted archive commit `f821335e1ae7fc5c98bf57370019bdc9176b5c2e`. The artifact installed and became ready, kept config/token/service files at `0600` and private directories at `0700`, accepted only loopback traffic, replaced PID 234 with 415 on active reinstall, rotated the token and replaced PID 415 with 497, produced diagnostics excluding the token, login, host, and home path, refused `uninstall --no-stop` while active, then removed the service, process, and listener on normal uninstall. This is explicitly container preflight, not bare-metal or signed-candidate qualification. |
| Windows hosted source-checkout qualification | **PASS** | [GitHub Actions run 29791906104](https://github.com/alphastorm/omp-session-gateway/actions/runs/29791906104) applied the exact candidate OMP patch, passed all eleven publisher fixtures—including mutual authentication, fake-server withholding, restart recovery, post-restart token reread, and an explicit token path preserving ambient XDG configuration—and the coding-agent typecheck, then completed gateway IPC/config/token ACL tests, current-user publisher access plus cross-user publisher-write denial, UTF-16 scheduled-task install/start, health/status, token rotation with graceful PID replacement, idempotent active reinstall, and process-clean uninstall. |
| Real desktop OMP/browser acceptance | **PASS** | Three patched interactive OMP processes auto-published without `/collab`; Chrome 150 at `412 × 915` observed cards, View/Control separation, prompt, interrupt, process removal, safe leave, no URL/storage capability, and foreground/online transport replacement. A live `/new` revoked generation 1, published generation 2 after replacement, and left generation 1 unlaunchable (`409`). A later metadata-refresh smoke published the initial `provider/model`, updated title and CWD plus two model events on the same instance/generation across directory revisions 14–18, and revoked at revision 19. |
| Default-relay endurance soak | **PARTIAL** | An earlier read-only `GuestClient` remained connected for 28,804 seconds, observed three phase transitions, and completed with `finalPhase: "live"`. The signed `v0.1.0-prealpha.1` repeat ended after approximately 2 hours 4 minutes with `room closed` while the gateway and patched OMP host remained running without restart. The current source fix recovers established guests across bounded relay room replacement; deterministic room-close/missing-room/recovery tests and a 60-second live-relay smoke passed, but the complete eight-hour rerun remains open. |
| Private vulnerability reporting | **PASS** | GitHub repository private vulnerability reporting returned `enabled: true` on 2026-07-20. |
| Deterministic SPDX inventory | **PASS** | Two release builds produced identical archive and SPDX 2.3 digests; `SHA256SUMS` verified both and the archive contains `SBOM.spdx.json`. |
| Hosted signing and provenance | **PASS** | Corrected [`provenance-test-v0.1.0.10`](https://github.com/alphastorm/omp-session-gateway/releases/tag/provenance-test-v0.1.0.10) at protected-main merge commit `1c33c90252643d7d0f572fe57a0e560f00b72afb` ([run `29792234310`](https://github.com/alphastorm/omp-session-gateway/actions/runs/29792234310)) published six immutable-release-attested assets. Downloaded checksums, all three GitHub build attestations, all three Cosign bundles, and release provenance verified independently. A clean exact-tag rebuild was byte-identical for the archive (`b446d405d97c2bec181b9d0f4be03c83ede7407d24d603a9d117be428b95576e`), SPDX inventory (`4cb0b1b2c81fdcaf56044cd38259a9ad979bff88efd75ca9a7a2fe3f30d6e8f1`), and checksum manifest (`08d28faa291f7b374dc8d6d88656c5e7e84cda93f65707acdc6a530415b39326`). |
| Signed candidate packaging/runtime smoke | **PASS** | The downloaded and independently verified `provenance-test-v0.1.0.10` archive installed with `--no-start` into an isolated macOS root, launched the installed runtime through the existing real Tailscale Serve mapping, and mutually authenticated three reconnect-capable patched OMP publisher fixtures. A real gateway restart restored all three cards in approximately 227 ms; a patched interactive OMP process auto-published a fourth card and revoked it immediately on shutdown. The controlled suspension experiment used this installed gateway and restored each expired session within eight seconds in all three resume orders. This is packaging/runtime and finite-suspension evidence, not complete LaunchAgent, distinct-device identity, actual sleep/wake, real collaboration, or Android qualification. |
| Repository security controls | **PASS** | Private vulnerability reporting, dependency alerts and automated security updates, secret scanning and push protection, and immutable releases are enabled. `main` requires signed commits, pull requests, current implementation/Windows checks, resolved conversations, and blocks force-pushes and deletion. |

The evidence date and caveats above come from the implementation handoff and the current
provenance-test artifact. Every later candidate must rerun the applicable clean-checkout CI and
native qualification and attach those records to its tag.

## Alpha gate ledger

| Release gate | Status | Evidence or missing proof | Required to close |
|---|---|---|---|
| Exact OMP and collab-web provenance | **PASS** | Immutable source commit, package versions, relevant paths, local integration, and patch are recorded in `UPSTREAM.lock.json` and `packages/collab-client/upstream/UPSTREAM.json`. | Revalidate unchanged data at the candidate tag. |
| Repository automated suite | **PASS** | Typechecks, production asset builds, 85 unit/integration tests with 344 assertions across 16 files, handoff checks, and the repository leak scanner passed. The IPC regression suite proves concurrent same-process publisher isolation, capacity enforcement, 50-publisher operation, silent authenticated idle close, and lost-heartbeat-state reconnect signaling rather than relying only on manual multi-publisher smoke evidence. | Repeat from clean CI for every subsequent candidate. |
| OMP patch compatibility | **PASS** | Patch apply-check passed. The 41 lifecycle/metadata/slash-command fixtures include same-generation metadata refresh and label bounds, the mutual-HMAC vector, fake-server capability-withholding, daemon-restart/token-rotation reconnect, and explicit-token-path publication that preserves ambient XDG configuration; the coding-agent package typecheck and `bun run ci:check:full` also passed against the exact pin. | Rerun from the exact pin at the candidate tag; do not broaden the OMP range. |
| Fifty-publisher capacity | **PARTIAL** | A real IPC integration test concurrently authenticates 50 same-PID/distinct-instance publishers, upserts 50 sessions, sends one heartbeat per owner, and proves all 50 socket closes remove only their owned records. | Measure sustained candidate-artifact CPU and RSS at the normal heartbeat cadence; the integration test does not qualify “without material CPU usage.” |
| Capability non-persistence | **PARTIAL** | Automated scans and desktop Chromium storage/history/cache checks passed. | Complete Android lifecycle checks and scan release CI artifacts, recordings, diagnostics, browser state, and all forbidden sinks with canary capabilities. |
| Loopback-only exposure | **PARTIAL** | macOS listener inspection and direct LAN/Tailscale-IP connection attempts proved the development checkout loopback-only. | Repeat with every signed candidate artifact and qualified host OS. |
| Tailscale Serve identity and application allowlist | **PARTIAL** | Real macOS Serve accepted requests as this node's exact allowlisted identity; the loopback backend rejected wrong and missing identities and accepted the allowed identity. Serve overwrites caller-supplied identity headers, so same-node requests cannot prove denied-device behavior. Direct LAN and Tailscale-IP access failed and Funnel was disabled. | Repeat from distinct allowed and denied tailnet devices with the candidate artifact. |
| Linux host lifecycle | **PARTIAL** | Debian 13 arm64 container runs with a real systemd user manager passed both development-checkout and unsigned extracted-archive install, readiness, permissions, loopback isolation, active reinstall/PID replacement, token rotation/restart, redacted diagnostics generation, active `--no-stop` refusal, uninstall, and process/listener cleanup. | Repeat the signed candidate on a bare-metal/VM target, prove reboot/login persistence, execute explicit forward upgrade and rollback, and complete real Tailscale/identity diagnostics. |
| macOS host lifecycle | **PARTIAL** | macOS 26.5.2 arm64 passed live LaunchAgent install, private permissions, restart/reinstall, token rotation, diagnostics/bundle, Serve checks, and uninstall from a development checkout. The independently verified `provenance-test-v0.1.0.10` archive passed an isolated `--no-start` install/runtime smoke, real Serve routing, gateway-restart recovery, one patched interactive OMP publication/removal, and three controlled publisher/gateway suspension orders beyond TTL. | Complete the corrected signed candidate's LaunchAgent lifecycle, actual sleep/wake and relay/browser recovery, reboot/login persistence, explicit upgrade/rollback, distinct-device identity isolation, real OMP collaboration, and capability-leak acceptance. |
| Windows host lifecycle | **PARTIAL** | Hosted run `29791906104` passed the exact candidate OMP publisher's current-user pipe derivation, strict token ACL inspection, eleven mutual-authentication/fake-server/restart/token-reread/explicit-path fixtures, and coding-agent typecheck together with the complete gateway lifecycle and cross-user denial workflow. | Repeat with a signed candidate artifact and qualify reboot/login persistence, diagnostics, upgrade, and rollback. |
| Android PWA installation | **NOT RUN** | Installable assets and Android-sized Chrome emulation passed. | Install from the real tailnet HTTPS origin on the target Android/Chrome version and verify update/offline states. |
| Three real OMP processes auto-discover | **PARTIAL** | Three patched interactive OMP processes appeared automatically within the acceptance window in Android-sized desktop Chrome. | Repeat on a physical Android device. |
| Real View and Control behavior | **PARTIAL** | Real desktop browser clients proved View composer disabled, Control prompt delivery, shared transcript updates, and interrupt. | Repeat every action from physical Android and verify host-side view mutation rejection. |
| Real lifecycle revocation | **PARTIAL** | Generation, stale launch, socket close, TTL tests, and real process exit/crash removal passed; no stale capability was returned. | Prove switch/branch/resume replacement ordering and crash-by-TTL on the candidate OMP/Android path. |
| Android lock, resume, network, back, and reconnect | **PARTIAL** | Chrome lifecycle/online events forced a fresh relay transport, the resumed view received new traffic, and leave returned to a secret-free directory URL. | Repeat OS lock, radio/network transition, browser back, and history/storage checks on physical Android. |
| Existing OMP relay connectivity | **PARTIAL** | Real desktop View/Control/interrupt and reconnect passed through the default relay. An earlier eight-hour read-only client against gateway checkout HEAD `6e32bd98386a1ac2c04987bed3476c492a2b2e51` completed after 28,804 seconds with three phase transitions and the client still live. The signed `v0.1.0-prealpha.1` repeat exposed terminal guest handling of a transient host room replacement after approximately 2 hours 4 minutes; deterministic recovery tests and a 60-second live smoke now pass in the source fix. | Complete an eight-hour candidate rerun with the recovery fix, repeat connectivity/lifecycle on physical Android, and capture start/end RSS before making any memory-growth claim. |
| Platform install/doctor/uninstall | **PARTIAL** | Full development-checkout flows passed on macOS, a Debian 13 systemd container, and hosted Windows; Windows included process-clean uninstall. | Qualify signed candidate artifacts on every advertised OS. |
| Configuration migration and rollback | **PARTIAL** | Active reinstall/PID replacement passed on macOS, Linux, and hosted Windows; configuration and token ownership were preserved. | Execute explicit forward migration and rollback with candidate artifacts on each advertised host. |
| Private vulnerability reporting | **PASS** | GitHub private vulnerability reporting is enabled and repository security guidance identifies the private path. | Reverify before publication. |
| Release signing, SBOM, and provenance | **PASS** | Corrected `provenance-test-v0.1.0.10` verified the protected tag workflow and sleep-recovery payload: archive `b446d405d97c2bec181b9d0f4be03c83ede7407d24d603a9d117be428b95576e`, SPDX inventory `4cb0b1b2c81fdcaf56044cd38259a9ad979bff88efd75ca9a7a2fe3f30d6e8f1`, and checksum manifest `08d28faa291f7b374dc8d6d88656c5e7e84cda93f65707acdc6a530415b39326`. The archive records exact source commit `1c33c90252643d7d0f572fe57a0e560f00b72afb` and its `bun.lock` digest, includes reviewed licenses and the distributed OMP patch, and its SBOM identifies that patch component. All six immutable release assets, three GitHub attestations, and three Cosign bundles verified; a clean exact-tag rebuild was byte-identical for all three payload files. | Repeat for every subsequent candidate; this PASS does not qualify a host or Android client. |
| Known limitations and exact compatibility matrix | **PASS** | This ledger and `COMPATIBILITY.md` state the pre-alpha boundary, exact OMP pin, unqualified platforms, and unsupported modes. | Keep both synchronized with every candidate. |
| Self-hosted/proxied relay | **N/A** | Explicitly unsupported and deferred. | Do not advertise; a future release needs the dedicated WebSocket soak and a separate security qualification. |

## Current release blockers

The alpha decision remains **NO-GO** until, at minimum:

1. at least one proposed host platform passes its complete native lifecycle and security matrix
   from the signed candidate artifact, including reboot/login persistence, upgrade, rollback,
   diagnostics, token rotation, and uninstall;
2. real Tailscale Serve authorization and LAN/public isolation pass from distinct allowed and
   denied devices against that candidate host;
3. a physical Android device passes install, automatic discovery, View, Control, interrupt,
   generation replacement, lock/resume, network-change, back-navigation, reconnect, and leak checks;
4. the candidate OMP path passes switch, branch, resume, crash-by-TTL, and applicable default-relay
   connectivity scenarios without exposing a stale capability; and
5. every advertised host/client combination completes its candidate-artifact capability-leak
   acceptance across all forbidden sinks.

Passing one platform permits advertising only that exact qualified platform/version combination.
It does not promote untested rows or broaden the pinned OMP range.

## Known limitations

- The gateway requires the exact pinned OMP source plus the repository patch; there is no
  upstream release/API compatibility promise yet.
- A daemon restart intentionally starts with an empty in-memory registry until live publishers
  reconnect.
- Browser reload intentionally returns to the session directory because collaboration
  capabilities are not persisted.
- The existing OMP relay remains an availability and traffic-metadata dependency.
- Same-desktop-user malware, a compromised browser/OS, and an unlocked authorized phone are
  outside or inherited trust boundaries described in `SECURITY.md`.
- Tagged Tailscale source devices, Tailscale Funnel, public/LAN HTTP, self-hosted relays,
  WebAuthn gating, TWA/native clients, push notifications, and multi-host federation are not
  supported by this release line.
- No production upgrade or rollback path has completed cross-platform qualification.

## Updating this ledger

Change a row only with a reproducible command result or a named manual qualification record that
identifies the source commit, artifact checksum, OS/browser/device versions, deployment path, and
date. Record failures as failures; do not turn a narrower automated pass into a broader platform
claim. Update this file, `COMPATIBILITY.md`, `CHANGELOG.md`, and release notes together whenever a
support claim or gate changes.
