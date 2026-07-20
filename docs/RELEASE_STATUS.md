# Release status

**Updated:** 2026-07-20  
**Repository version:** `0.1.0` (provenance-test artifact only; no alpha)  
**Classification:** implemented pre-alpha  
**Alpha decision:** **NO-GO**  
**Advertised host/client platforms:** none

The repository implements the intended v1 path and publishes a deterministic Bun-runtime
archive only as a provenance exercise. It is not production-qualified, no alpha artifact is
approved for publication, and no operating system, browser, or Android device is currently
supported. Repository commits and provenance-test archives are engineering inputs for qualification only.

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
| Repository check | **PASS** | `bun run check` passed handoff validation, four workspace typechecks, production web/client builds, 83 tests with 336 assertions across 16 files, and capability-leak scanning. Real IPC coverage includes three concurrent same-PID publishers, a capacity-rejected fourth connection, rapid heartbeat/generation activity, per-owner isolation, and socket-close cleanup. |
| Dependency audit | **PASS** | `bun audit` reported no vulnerabilities for the recorded lockfile. |
| OMP patch application and lifecycle fixtures | **PASS** | Patch apply-check passed against the pristine pin; 34 controller/publisher/settings/session-ordering/slash-command tests—including mutual-HMAC vector, fake-server withholding, and legitimate exchange cases—and the full coding-agent package typecheck passed. |
| Registry mutual authentication | **PASS** | Shared gateway and standalone OMP proof-vector tests agree; stale client proof replay is rejected; a fake server receives only `hello`; and an isolated real gateway/synthetic-publisher smoke published metadata then revoked it on disconnect without key/capability log output. |
| Full pinned OMP checkout | **PASS** | The current mutual-authentication patch passed `bun run ci:check:full` across the full pin. The preceding lifecycle revision passed every official TypeScript test bucket with documented upstream-baseline exclusions restored afterward; the authentication delta is covered by focused fixtures and the coding-agent typecheck. |
| Deterministic runtime archive | **PASS** | Two clean local builds from hardening commit `99e34ee866d30dbb6424346404dc293727daa319` produced byte-identical 848,896-byte archives, SPDX 2.3 inventories, and checksum manifests. `SHA256SUMS` verified archive digest `7c25c37dd25bf2e93f7b8c48d1f0214c51f46709d82fcb830f7a0b7aae80e472` and SPDX digest `730097f950f9f2f4684b0358907870b889f32b690f7a6bbfe0d544be50b686fd`; `release-info.json` pins that source commit, upstream `39c95e5e29b1c8b082059f57421ce445c3dffdd4`, and the exact lock digest. This is unsigned local preflight, not signed-candidate qualification. |
| Extracted archive command smoke | **PASS** | The hardening archive's bundled CLI completed `--help`, isolated `install --no-start`, inactive `status`, Serve guidance, redacted `doctor --bundle`, and `uninstall --no-stop` on macOS arm64 without touching the live trial. The generated publisher token was 43 bytes with mode `0600`, its config directory was `0700`, and its bytes appeared in no other smoke file or diagnostic; the synthetic login, tailnet host, and full smoke path were also absent from diagnostics. A fresh archive from commit `a514c9ca8ab9611dd934c09b5ddc8dd2074c2ac7` then ran its bundled gateway on an isolated loopback port, mutually authenticated three source-checkout publishers, returned metadata-only revision 3, served a no-store in-memory launch response, rejected a stale generation with `409` and no capability field, and removed all records on publisher socket close at revision 6. |
| Desktop mobile-viewport browser smoke | **PASS** | Chromium at `412 × 915` rendered three synthetic sessions; SSE, generation conflict, no-store launch, URL scrub, storage/cache checks, and prompt socket-close removal passed. A separate `390 × 844` run proved overlapping snapshot/SSE revision ordering, stale-metadata clearing on transport loss, and query-bearing asset cache bypass. The extracted `a514c9c` runtime repeated the `412 × 915` path: its client popup used `/client/` with no query, fragment, referrer, cookie, history state, Local/Session Storage, IndexedDB, or secret-bearing resource URL; Cache Storage contained only the two immutable app assets, recovery returned to `/`, and SSE exposed the empty state immediately after socket-close removal. |
| macOS/Tailscale development-checkout qualification | **PASS** | macOS 26.5.2 arm64 completed live LaunchAgent install/reinstall, permissions, token rotation, diagnostics bundle, real Serve identity allow/deny checks, loopback/LAN isolation, and uninstall. |
| Linux container lifecycle qualification | **PASS** | Debian 13 arm64 with a real systemd user manager completed the development-checkout lifecycle and repeated it from unsigned extracted archive commit `f821335e1ae7fc5c98bf57370019bdc9176b5c2e`. The artifact installed and became ready, kept config/token/service files at `0600` and private directories at `0700`, accepted only loopback traffic, replaced PID 234 with 415 on active reinstall, rotated the token and replaced PID 415 with 497, produced diagnostics excluding the token, login, host, and home path, refused `uninstall --no-stop` while active, then removed the service, process, and listener on normal uninstall. This is explicitly container preflight, not bare-metal or signed-candidate qualification. |
| Windows hosted source-checkout qualification | **PASS** | [GitHub Actions run 29749928494](https://github.com/alphastorm/omp-session-gateway/actions/runs/29749928494) applied the exact pinned OMP patch, passed its publisher mutual-authentication/fake-server tests and coding-agent typecheck, then completed gateway IPC/config/token ACL tests, current-user publisher access plus cross-user publisher-write denial, UTF-16 scheduled-task install/start, health/status, token rotation with graceful PID replacement, idempotent active reinstall, and process-clean uninstall. |
| Real desktop OMP/browser acceptance | **PASS** | Three patched interactive OMP processes auto-published without `/collab`; Chrome 150 at `412 × 915` observed cards, View/Control separation, prompt, interrupt, process removal, safe leave, no URL/storage capability, and foreground/online transport replacement. A live `/new` revoked generation 1, published generation 2 after replacement, and left generation 1 unlaunchable (`409`). |
| Default-relay endurance soak | **PASS** | A read-only `GuestClient` remained connected for 28,804 seconds, observed three phase transitions, and completed with `finalPhase: "live"`. |
| Private vulnerability reporting | **PASS** | GitHub repository private vulnerability reporting returned `enabled: true` on 2026-07-20. |
| Deterministic SPDX inventory | **PASS** | Two release builds produced identical archive and SPDX 2.3 digests; `SHA256SUMS` verified both and the archive contains `SBOM.spdx.json`. |
| Hosted signing and provenance | **PASS** | Final [`provenance-test-v0.1.0.8`](https://github.com/alphastorm/omp-session-gateway/releases/tag/provenance-test-v0.1.0.8) at post-soak commit `100bebc84f72d61a980c06b094f17909a4856add` ([run `29737239983`](https://github.com/alphastorm/omp-session-gateway/actions/runs/29737239983)) published six immutable-release-attested assets. Downloaded checksums, all three GitHub build attestations, all three Cosign bundles, and every release asset verified independently; a clean exact-tag rebuild was byte-identical. |
| Repository security controls | **PASS** | Private vulnerability reporting, dependency alerts and automated security updates, secret scanning and push protection, and immutable releases are enabled. `main` requires signed commits, pull requests, current implementation/Windows checks, resolved conversations, and blocks force-pushes and deletion. |

The evidence date and caveats above come from the implementation handoff and the current
provenance-test artifact. Every later candidate must rerun the applicable clean-checkout CI and
native qualification and attach those records to its tag.

## Alpha gate ledger

| Release gate | Status | Evidence or missing proof | Required to close |
|---|---|---|---|
| Exact OMP and collab-web provenance | **PASS** | Immutable source commit, package versions, relevant paths, local integration, and patch are recorded in `UPSTREAM.lock.json` and `packages/collab-client/upstream/UPSTREAM.json`. | Revalidate unchanged data at the candidate tag. |
| Repository automated suite | **PASS** | Typechecks, production asset builds, 83 unit/integration tests with 336 assertions across 16 files, handoff checks, and the repository leak scanner passed. The IPC regression suite proves concurrent same-process publisher isolation and capacity enforcement rather than relying only on manual multi-publisher smoke evidence. | Repeat from clean CI for every subsequent candidate. |
| OMP patch compatibility | **PASS** | Patch apply-check passed. The 34 lifecycle/slash-command fixtures include the mutual-HMAC vector and fake-server capability-withholding coverage; the coding-agent package typecheck and `bun run ci:check:full` also passed against the exact pin. | Rerun from the exact pin at the candidate tag; do not broaden the OMP range. |
| Capability non-persistence | **PARTIAL** | Automated scans and desktop Chromium storage/history/cache checks passed. | Complete Android lifecycle checks and scan release CI artifacts, recordings, diagnostics, browser state, and all forbidden sinks with canary capabilities. |
| Loopback-only exposure | **PARTIAL** | macOS listener inspection and direct LAN/Tailscale-IP connection attempts proved the development checkout loopback-only. | Repeat with every signed candidate artifact and qualified host OS. |
| Tailscale Serve identity and application allowlist | **PARTIAL** | Real macOS Serve accepted the exact allowlisted login; denied and missing identities failed; direct LAN and Tailscale-IP access failed; Funnel was disabled. Direct loopback header spoofing is outside the explicit single-user v1 boundary. | Repeat from distinct allowed and denied tailnet devices with the candidate artifact. |
| Linux host lifecycle | **PARTIAL** | Debian 13 arm64 container runs with a real systemd user manager passed both development-checkout and unsigned extracted-archive install, readiness, permissions, loopback isolation, active reinstall/PID replacement, token rotation/restart, redacted diagnostics generation, active `--no-stop` refusal, uninstall, and process/listener cleanup. | Repeat the signed candidate on a bare-metal/VM target, prove reboot/login persistence, execute explicit forward upgrade and rollback, and complete real Tailscale/identity diagnostics. |
| macOS host lifecycle | **PARTIAL** | macOS 26.5.2 arm64 passed live LaunchAgent install, private permissions, restart/reinstall, token rotation, diagnostics/bundle, Serve checks, and uninstall. | Repeat from a signed candidate artifact and qualify reboot/login persistence plus upgrade/rollback. |
| Windows host lifecycle | **PARTIAL** | Hosted run `29749928494` passed the patched OMP publisher's current-user pipe derivation, strict token ACL inspection, mutual HMAC, fake-server rejection, and typecheck together with the complete gateway lifecycle and cross-user denial workflow. | Repeat with a signed candidate artifact and qualify reboot/login persistence, diagnostics, upgrade, and rollback. |
| Android PWA installation | **NOT RUN** | Installable assets and Android-sized Chrome emulation passed. | Install from the real tailnet HTTPS origin on the target Android/Chrome version and verify update/offline states. |
| Three real OMP processes auto-discover | **PARTIAL** | Three patched interactive OMP processes appeared automatically within the acceptance window in Android-sized desktop Chrome. | Repeat on a physical Android device. |
| Real View and Control behavior | **PARTIAL** | Real desktop browser clients proved View composer disabled, Control prompt delivery, shared transcript updates, and interrupt. | Repeat every action from physical Android and verify host-side view mutation rejection. |
| Real lifecycle revocation | **PARTIAL** | Generation, stale launch, socket close, TTL tests, and real process exit/crash removal passed; no stale capability was returned. | Prove switch/branch/resume replacement ordering and crash-by-TTL on the candidate OMP/Android path. |
| Android lock, resume, network, back, and reconnect | **PARTIAL** | Chrome lifecycle/online events forced a fresh relay transport, the resumed view received new traffic, and leave returned to a secret-free directory URL. | Repeat OS lock, radio/network transition, browser back, and history/storage checks on physical Android. |
| Existing OMP relay connectivity | **PARTIAL** | Real desktop View/Control/interrupt and reconnect passed through the default relay. An eight-hour read-only client against gateway checkout HEAD `6e32bd98386a1ac2c04987bed3476c492a2b2e51` and the pinned OMP patch completed after 28,804 seconds with three phase transitions and the client still live; final gateway RSS was 44,384 KiB. | Repeat connectivity/lifecycle on physical Android; any memory-growth claim still requires start/end measurements. |
| Platform install/doctor/uninstall | **PARTIAL** | Full development-checkout flows passed on macOS, a Debian 13 systemd container, and hosted Windows; Windows included process-clean uninstall. | Qualify signed candidate artifacts on every advertised OS. |
| Configuration migration and rollback | **PARTIAL** | Active reinstall/PID replacement passed on macOS, Linux, and hosted Windows; configuration and token ownership were preserved. | Execute explicit forward migration and rollback with candidate artifacts on each advertised host. |
| Private vulnerability reporting | **PASS** | GitHub private vulnerability reporting is enabled and repository security guidance identifies the private path. | Reverify before publication. |
| Release signing, SBOM, and provenance | **PASS** | Final `provenance-test-v0.1.0.8` verified the protected tag workflow and post-soak payload: archive `40eccc3dd12d5c25adc8621f1df21907d36c6b8e589456e69b114b32df8a1415`, SPDX inventory `275d1d4fcd21d3117abe60d2bc6cd9f466b0842cc582e8e380655a73dccaa69f`, and checksum manifest `d2750e7569d55c4a0e75e7fc4e54d3957d4ae45a581ec730e02ce78e9dfb63e2`. The archive records exact source commit `100bebc84f72d61a980c06b094f17909a4856add` and its `bun.lock` digest, includes reviewed licenses and the distributed OMP patch, and its SBOM identifies that patch component. All six immutable release assets, three GitHub attestations, and three Cosign bundles verified; a clean exact-tag rebuild matched all payload digests. | Repeat for every subsequent candidate; this PASS does not qualify a host or Android client. |
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
