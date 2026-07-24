# Release status

**Updated:** 2026-07-24<br>
**Repository version:** `0.1.0` (`v0.1.0-prealpha.7`; no alpha)<br>
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
| Exact upstream pin | **PASS** | `UPSTREAM.lock.json` pins `can1357/oh-my-pi@89d6a8f6d14286f32f09ec9c8aa8af7b3451d2d6`, nearest release `v17.0.6`, with package and Bun versions; the four-commit patch applies cleanly to the pristine pin. |
| Repository check | **PASS** | `bun run check` passed handoff validation, four workspace typechecks, production web/client builds, 105 tests with 561 assertions across 19 files, and capability-leak scanning. Four Android-sized Playwright cases separately passed same-document View/Control launch plus explicit background-Push subscription, strict service-worker delivery, metadata-only notification tap routing, unsubscribe, and forbidden-cache/content checks. |
| Host-suspension recovery experiment | **PASS** | The downloaded and independently verified `provenance-test-v0.1.0.10` gateway plus the exact patched OMP publisher were suspended beyond a five-second test TTL, then resumed gateway-first, publisher-first, and together. Every order first lost the expired card, mutually re-authenticated, sent a full upsert, and restored one session within eight seconds. This finite missed-timer reproduction does not replace actual macOS sleep/wake qualification. |
| Dependency audit | **PASS** | `bun audit` reported no vulnerabilities for the recorded lockfile. |
| OMP patch application and lifecycle fixtures | **PASS** | The v17.0.6 patch apply-check passed against the pristine pin; 114 focused tests with 531 assertions passed across controller/publisher leases, pre-writer retention and bounds, View exclusion, multi-writer settlement, response-race cleanup, collaboration-before-hooks startup, metadata refresh, lifecycle revocation, settings, session ordering, and slash commands. |
| Registry mutual authentication | **PASS** | Shared gateway and standalone OMP proof-vector tests agree; stale client proof replay is rejected; a fake server receives only `hello`; and an isolated real gateway/synthetic-publisher smoke published metadata then revoked it on disconnect without key/capability log output. |
| Full pinned OMP checkout | **PASS** | `bun run ci:check:full` passed. Every official TypeScript test outside five independently reproduced pristine-baseline failures passed in its official bucket. The unchanged baseline failures are two Python completion-runtime assertions, two status-path assertions, and one session-file timestamp-ordering assertion; no patch-specific failure remained. |
| Deterministic runtime archive | **PASS** | Two clean local builds from hardening commit `99e34ee866d30dbb6424346404dc293727daa319` produced byte-identical 848,896-byte archives, SPDX 2.3 inventories, and checksum manifests. `SHA256SUMS` verified archive digest `7c25c37dd25bf2e93f7b8c48d1f0214c51f46709d82fcb830f7a0b7aae80e472` and SPDX digest `730097f950f9f2f4684b0358907870b889f32b690f7a6bbfe0d544be50b686fd`; `release-info.json` pins that source commit, upstream `39c95e5e29b1c8b082059f57421ce445c3dffdd4`, and the exact lock digest. This is unsigned local preflight, not signed-candidate qualification. |
| Extracted archive command smoke | **PASS** | The hardening archive's bundled CLI completed `--help`, isolated `install --no-start`, inactive `status`, Serve guidance, redacted `doctor --bundle`, and `uninstall --no-stop` on macOS arm64 without touching the live trial. The generated publisher token was 43 bytes with mode `0600`, its config directory was `0700`, and its bytes appeared in no other smoke file or diagnostic; the synthetic login, tailnet host, and full smoke path were also absent from diagnostics. A fresh archive from commit `a514c9ca8ab9611dd934c09b5ddc8dd2074c2ac7` then ran its bundled gateway on an isolated loopback port, mutually authenticated three source-checkout publishers, returned metadata-only revision 3, served a no-store in-memory launch response, rejected a stale generation with `409` and no capability field, and removed all records on publisher socket close at revision 6. |
| Desktop mobile-viewport browser smoke | **PASS** | Chromium at `412 × 915` rendered three synthetic sessions; SSE, generation conflict, no-store launch, URL scrub, storage/cache checks, and prompt socket-close removal passed. A separate `390 × 844` run proved overlapping snapshot/SSE revision ordering, stale-metadata clearing on transport loss, and query-bearing asset cache bypass. The extracted `a514c9c` runtime repeated the `412 × 915` path: its client popup used `/client/` with no query, fragment, referrer, cookie, history state, Local/Session Storage, IndexedDB, or secret-bearing resource URL; Cache Storage contained only the two immutable app assets, recovery returned to `/`, and SSE exposed the empty state immediately after socket-close removal. |
| Desktop background Web Push browser smoke | **PASS** | Chromium at `412 × 915` explicitly granted permission and created a real HTTPS Push subscription. With the PWA document navigated away, the gateway delivered encrypted Web Push and the service worker displayed fixed title `OMP session needs attention`, an empty body, and metadata-only instance/generation data. A stale notification route was synchronously scrubbed to `/` and retained the visible expired state. This does not prove Android OS delivery, force-stop behavior, lock-screen presentation, or tap-to-Control. |
| Isolated attention lifecycle smoke | **PASS** | A real gateway and mutually authenticated publisher drove same-generation false-to-true-to-false state through IPC, registry, SSE, and the built dashboard. Chromium observed the accessible attention state, authoritative clear, and removal; no synthetic capability marker appeared in DOM, URL/history, Local/Session Storage, cookies, gateway logs, or cached shell state. This does not replace a patched real-OMP retained-request/Control smoke or physical Android qualification. |
| macOS/Tailscale development-checkout qualification | **PASS** | macOS 26.5.2 arm64 completed live LaunchAgent install/reinstall, permissions, token rotation, diagnostics bundle, Serve access as the allowlisted node identity, loopback-backend identity rejection, loopback/LAN isolation, and uninstall. Distinct-device allowlist isolation remains a separate gate below. |
| Linux container lifecycle qualification | **PASS** | Debian 13 arm64 with a real systemd user manager completed the development-checkout lifecycle and repeated it from unsigned extracted archive commit `f821335e1ae7fc5c98bf57370019bdc9176b5c2e`. The artifact installed and became ready, kept config/token/service files at `0600` and private directories at `0700`, accepted only loopback traffic, replaced PID 234 with 415 on active reinstall, rotated the token and replaced PID 415 with 497, produced diagnostics excluding the token, login, host, and home path, refused `uninstall --no-stop` while active, then removed the service, process, and listener on normal uninstall. This is explicitly container preflight, not bare-metal or signed-candidate qualification. |
| Windows hosted source-checkout qualification | **PASS** | [GitHub Actions run 29791906104](https://github.com/alphastorm/omp-session-gateway/actions/runs/29791906104) applied the exact candidate OMP patch, passed all eleven publisher fixtures—including mutual authentication, fake-server withholding, restart recovery, post-restart token reread, and an explicit token path preserving ambient XDG configuration—and the coding-agent typecheck, then completed gateway IPC/config/token ACL tests, current-user publisher access plus cross-user publisher-write denial, UTF-16 scheduled-task install/start, health/status, token rotation with graceful PID replacement, idempotent active reinstall, and process-clean uninstall. |
| Real desktop OMP/browser acceptance | **PASS** | Three patched interactive OMP processes auto-published without `/collab`; Chrome 150 at `412 × 915` observed cards, View/Control separation, prompt, interrupt, process removal, safe leave, no URL/storage capability, and foreground/online transport replacement. A live `/new` revoked generation 1, published generation 2 after replacement, and left generation 1 unlaunchable (`409`). A later metadata-refresh smoke published the initial `provider/model`, updated title and CWD plus two model events on the same instance/generation across directory revisions 14–18, and revoked at revision 19. |
| Default-relay endurance soak | **PASS** | The signed `v0.1.0-prealpha.2` recovery rerun completed 28,800 seconds with eight relay-room transitions, `finalPhase: "live"`, exit code 0, and no process restart. Gateway RSS moved from 45,776 KiB to 46,496 KiB (+720 KiB, approximately 1.6%). The named record is `~/.local/share/omp-session-gateway/test/v0.1.0-prealpha.2/soak/recovery-v012-relay-soak-8h.json`. |
| Physical Android `v0.1.0-prealpha.4` trial | **PARTIAL** | Pixel 10 Pro, Android 17 build `CP2A.260705.006` (SDK 37), Chrome `150.0.7871.128` passed installed-PWA View/Control/Back, exactly-once retained response, attention clearing, metadata-only foreground and lock-screen notification, dashboard-only notification tap, lock/resume, Wi-Fi/cellular transition, automatic relay reconnect, generation replacement with stale `409`, and TTL removal/republication. Distinct-identity denial, deep physical-browser sink inspection, interrupt, and remaining switch/branch/resume cases were deferred. Named record: `~/.local/share/omp-session-gateway/test/v0.1.0-prealpha.4/qualification/local-android-launch-fix.json`. |
| Physical Android and capacity `v0.1.0-prealpha.5` trial | **PASS** | The downloaded archive passed checksum, GitHub attestation, Cosign bundle, signed-tag, and exact-byte reproduction verification. On the same Pixel/Android/Chrome combination, three real patched OMP sessions appeared automatically; Airplane mode cleared all cards by the 40-second observation after the configured 35-second SSE deadline, and restoration returned exactly three without Refresh or duplicates. A separate signed-runtime run held 50 publishers for a 642-second measured window at the normal heartbeat cadence, averaging 0.125% of one CPU core with maximum observed daemon RSS 63,760 KiB; all 50 remained fresh and clean shutdown removed all 50. Twenty local launch calls measured 0.496 ms p95. Named record: `~/.local/share/omp-session-gateway/test/v0.1.0-prealpha.5/qualification/android-offline-and-capacity.json`. |
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
| Repository automated suite | **PASS** | Typechecks, production asset builds, 105 unit/integration tests with 561 assertions across 19 files, handoff checks, capability-leak scanning, and four Android-sized Playwright cases passed. The suite proves strict metadata-only attention/Push transitions, stale-state clearing after a 35-second SSE liveness deadline, fresh-snapshot recovery, duplicate collapse, generation-bound notification clicks, explicit subscribe/unsubscribe, and no-popup same-document View/Control launch. | Repeat from clean CI for every subsequent candidate. |
| OMP patch compatibility | **PASS** | Patch apply-check, 114 focused attention/lifecycle fixtures, the coding-agent package typecheck, and `bun run ci:check:full` passed against the exact pin. Every non-baseline official TypeScript test passed; five failures reproduce unchanged on the pristine pin. | Rerun from the exact pin at the candidate tag; do not broaden the OMP range. |
| Fifty-publisher capacity | **PASS** | The signed `v0.1.0-prealpha.5` daemon held 50 authenticated publishers and sessions for a 642-second measured window at the normal 10-second heartbeat cadence. It consumed 0.80 CPU seconds over that interval (0.125% of one core average), stayed below 63,760 KiB observed RSS, retained 50 fresh records, logged no warnings/errors, and removed all 50 on clean publisher shutdown. The capacity files contained no synthetic capability marker. | Repeat on every later candidate and investigate any material regression from this baseline. |
| Capability non-persistence | **PARTIAL** | Automated scans and desktop Chromium storage/history/cache checks passed. | Complete Android lifecycle checks and scan release CI artifacts, recordings, diagnostics, browser state, and all forbidden sinks with canary capabilities. |
| Loopback-only exposure | **PARTIAL** | macOS listener inspection and direct LAN/Tailscale-IP connection attempts proved the development checkout loopback-only. | Repeat with every signed candidate artifact and qualified host OS. |
| Tailscale Serve identity and application allowlist | **PARTIAL** | Real macOS Serve accepted requests as this node's exact allowlisted identity; the loopback backend rejected wrong and missing identities and accepted the allowed identity. Serve overwrites caller-supplied identity headers, so same-node requests cannot prove denied-device behavior. Direct LAN and Tailscale-IP access failed and Funnel was disabled. | Repeat from distinct allowed and denied tailnet devices with the candidate artifact. |
| Linux host lifecycle | **PARTIAL** | Debian 13 arm64 container runs with a real systemd user manager passed both development-checkout and unsigned extracted-archive install, readiness, permissions, loopback isolation, active reinstall/PID replacement, token rotation/restart, redacted diagnostics generation, active `--no-stop` refusal, uninstall, and process/listener cleanup. | Repeat the signed candidate on a bare-metal/VM target, prove reboot/login persistence, execute explicit forward upgrade and rollback, and complete real Tailscale/identity diagnostics. |
| macOS host lifecycle | **PARTIAL** | macOS 26.5.2 arm64 passed live LaunchAgent install, private permissions, restart/reinstall, token rotation, diagnostics/bundle, Serve checks, and uninstall from a development checkout. The independently verified `provenance-test-v0.1.0.10` archive passed an isolated `--no-start` install/runtime smoke, real Serve routing, gateway-restart recovery, one patched interactive OMP publication/removal, and three controlled publisher/gateway suspension orders beyond TTL. | Complete the corrected signed candidate's LaunchAgent lifecycle, actual sleep/wake and relay/browser recovery, reboot/login persistence, explicit upgrade/rollback, distinct-device identity isolation, real OMP collaboration, and capability-leak acceptance. |
| Windows host lifecycle | **PARTIAL** | Hosted run `29791906104` passed the exact candidate OMP publisher's current-user pipe derivation, strict token ACL inspection, eleven mutual-authentication/fake-server/restart/token-reread/explicit-path fixtures, and coding-agent typecheck together with the complete gateway lifecycle and cross-user denial workflow. | Repeat with a signed candidate artifact and qualify reboot/login persistence, diagnostics, upgrade, and rollback. |
| Android PWA installation | **PARTIAL** | Pixel 10 Pro, Android 17 build `CP2A.260705.006` (SDK 37), Chrome `150.0.7871.128` installed the PWA from tailnet HTTPS, activated corrected `v0.1.0-prealpha.4` and signed `v0.1.0-prealpha.5` shells, and loaded the metadata directory. The loaded v0.1.0-prealpha.5 shell cleared all cards after a silent Airplane-mode partition and restored only a fresh snapshot; cold offline navigation remained unavailable as designed because navigation bypasses the service worker. | Complete the deferred deep physical-browser sink inspection before advertising this client combination. |
| Three real OMP processes auto-discover | **PASS** | Three patched interactive OMP processes in `workspace`, `workspace-2`, and `workspace-3` appeared automatically without Refresh on the physical Pixel through the signed `v0.1.0-prealpha.5` gateway. | Repeat on every later candidate/device combination. |
| Real View and Control behavior | **PARTIAL** | On the physical Pixel, corrected same-document View opened read-only, Android Back returned to Sessions, Control presented the pre-existing retained ask, the response was accepted exactly once, and attention cleared at directory revision 2. | Exercise physical interrupt and a host-observed rejected View mutation attempt before broadening the claim. |
| Real lifecycle revocation | **PARTIAL** | Physical Android observed automatic single-card generation 2→3 replacement without Refresh; old generations 1 and 2 each returned `409`. Suspending the live OMP publisher expired the card at revision 19 and resuming restored generation 3 at revision 20 without Refresh, duplication, or stale launch. | Prove switch, branch, and saved-session resume ordering plus a process-crash path on the candidate OMP/Android combination. |
| Android lock, resume, network, back, and reconnect | **PARTIAL** | Pixel 10 Pro lock/unlock preserved the authoritative attention state without duplicates; Wi-Fi→cellular→Wi-Fi recovered automatically with Tailscale enabled; View reconnected, and Android Back returned to Sessions. On signed `v0.1.0-prealpha.5`, a silent Airplane-mode partition cleared all cards by the 40-second observation after the configured 35-second deadline despite Tailscale's virtual interface, and restoration fetched exactly three fresh cards without Refresh. | Complete the deferred physical URL/history/storage/cache inspection. |
| Android attention notification | **PASS** | With one live foreground dashboard tab and explicit permission already enabled, a false→true transition produced exactly `OMP session needs attention` plus `Gateway qualification ask tool`; prompt/options/answers were absent. The same metadata-only content appeared on the lock screen, its tap opened Sessions rather than Control, lock/resume preserved state, and a closed PWA correctly produced no notification under the foreground-only contract. | Repeat on every later candidate/browser combination; do not infer background or killed-browser delivery. |
| Existing OMP relay connectivity | **PASS** | Desktop View/Control/interrupt passed; the signed `v0.1.0-prealpha.2` recovery soak completed 28,800 seconds through eight room transitions with a live final phase, no restart, and a 720 KiB RSS increase. Physical Android then passed View and Control, lock/resume, Wi-Fi/cellular transition, automatic reconnect, generation replacement, and post-TTL View recovery through the default relay. | Repeat for every advertised OMP/browser combination; relay availability and traffic metadata remain inherited dependencies. |
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
  WebAuthn gating, TWA/native clients, and multi-host federation are not supported by this release
  line. Background Web Push is implemented but remains unqualified until the physical Android
  closed-PWA, lock-screen, tap-to-Control, stale-generation, force-stop, and network matrix passes.
- No production upgrade or rollback path has completed cross-platform qualification.

## Updating this ledger

Change a row only with a reproducible command result or a named manual qualification record that
identifies the source commit, artifact checksum, OS/browser/device versions, deployment path, and
date. Record failures as failures; do not turn a narrower automated pass into a broader platform
claim. Update this file, `COMPATIBILITY.md`, `CHANGELOG.md`, and release notes together whenever a
support claim or gate changes.
