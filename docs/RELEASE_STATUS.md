# Release status

**Updated:** 2026-07-20  
**Repository version:** `0.1.0` (unreleased)  
**Classification:** implemented pre-alpha  
**Alpha decision:** **NO-GO**  
**Advertised host/client platforms:** none

The repository implements the intended v1 path and can build a deterministic Bun-runtime
archive. It is not production-qualified, no alpha artifact is approved for publication, and no
operating system, browser, or Android device is currently supported. Repository commits and
locally built archives are engineering inputs for qualification only.

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
| Repository check | **PASS** | `bun run check` passed handoff validation, four workspace typechecks, production web/client builds, 39 tests across nine files, and capability-leak scanning. |
| Dependency audit | **PASS** | `bun audit` reported no vulnerabilities for the recorded lockfile. |
| OMP patch application and lifecycle fixtures | **PASS** | Patch apply-check passed; 20 controller/publisher/settings/session-ordering tests and the full coding-agent package typecheck passed. |
| Full pinned OMP checkout | **PASS** | `bun run ci:check:full` passed after temporary exclusion of upstream-baseline failures reproduced in an untouched checkout; exclusions were restored and are not part of the patch. |
| Deterministic runtime archive | **PASS** | Two local `bun scripts/build-release.ts` runs produced byte-identical archives and a SHA-256 manifest. |
| Extracted archive command smoke | **PASS** | Repeated `install --no-start`, redacted diagnostics bundle creation, and `uninstall --no-stop` behaved as documented in the recorded environment. |
| Desktop mobile-viewport browser smoke | **PASS** | Chromium at `412 × 915` rendered three synthetic sessions; SSE, generation conflict, no-store launch, URL scrub, storage/cache checks, and prompt socket-close removal passed. |
| macOS/Tailscale development-checkout qualification | **PASS** | macOS 26.5.2 arm64 completed live LaunchAgent install/reinstall, permissions, token rotation, diagnostics bundle, real Serve identity allow/deny/spoof checks, loopback/LAN isolation, and uninstall. |
| Linux container lifecycle qualification | **PASS** | Debian 13 arm64 with a real systemd user manager completed install, autostart, active PID replacement, permissions, token rotation, and uninstall; this is explicitly not bare-metal qualification. |
| Windows hosted lifecycle qualification | **PASS** | [GitHub Actions run 29715302992](https://github.com/alphastorm/omp-session-gateway/actions/runs/29715302992) on commit `ff3b56370822` completed strict ACL tests, UTF-16 scheduled-task install/start, health/status, token rotation, authenticated exact-Origin graceful restart with PID replacement, active reinstall, and process-clean uninstall. |
| Real desktop OMP/browser acceptance | **PASS** | Three patched interactive OMP processes auto-published without `/collab`; Chrome 150 at `412 × 915` observed cards, View/Control separation, prompt, interrupt, process removal, safe leave, no URL/storage capability, and foreground/online transport replacement. A live `/new` revoked generation 1, published generation 2 after replacement, and left generation 1 unlaunchable (`409`). |
| Private vulnerability reporting | **PASS** | GitHub repository private vulnerability reporting returned `enabled: true` on 2026-07-20. |
| Deterministic SPDX inventory | **PASS** | Two release builds produced identical archive and SPDX 2.3 digests; `SHA256SUMS` verified both and the archive contains `SBOM.spdx.json`. |

The evidence date and caveats above come from the implementation handoff. A release candidate
must rerun every applicable command from a clean checkout and attach the resulting CI/native
qualification records to the candidate tag.

## Alpha gate ledger

| Release gate | Status | Evidence or missing proof | Required to close |
|---|---|---|---|
| Exact OMP and collab-web provenance | **PASS** | Immutable source commit, package versions, relevant paths, local integration, and patch are recorded in `UPSTREAM.lock.json` and `packages/collab-client/upstream/UPSTREAM.json`. | Revalidate unchanged data at the candidate tag. |
| Repository automated suite | **PASS** | Typechecks, production asset builds, unit/integration tests, handoff checks, and the repository leak scanner passed. | Rerun from clean CI at the candidate tag. |
| OMP patch compatibility | **PASS** | Patch and lifecycle fixtures passed against the exact pinned OMP checkout; upstream-baseline exclusions are documented. | Rerun against the immutable pin; do not broaden the OMP range. |
| Capability non-persistence | **PARTIAL** | Automated scans and desktop Chromium storage/history/cache checks passed. | Complete Android lifecycle checks and scan release CI artifacts, recordings, diagnostics, browser state, and all forbidden sinks with canary capabilities. |
| Loopback-only exposure | **PARTIAL** | macOS listener inspection and direct LAN/Tailscale-IP connection attempts proved the development checkout loopback-only. | Repeat with every signed candidate artifact and qualified host OS. |
| Tailscale Serve identity and application allowlist | **PARTIAL** | Real macOS Serve accepted the exact allowlisted login; denied, missing, and spoofed direct-backend identities failed; Funnel was disabled. | Repeat from distinct allowed and denied tailnet devices with the candidate artifact. |
| Linux host lifecycle | **PARTIAL** | Debian 13 arm64 container with a real systemd user manager passed install, autostart, permissions, restart/reinstall, token rotation, and uninstall. | Repeat on a bare-metal/VM candidate OS and qualify upgrade/rollback and diagnostics. |
| macOS host lifecycle | **PARTIAL** | macOS 26.5.2 arm64 passed live LaunchAgent install, private permissions, restart/reinstall, token rotation, diagnostics/bundle, Serve checks, and uninstall. | Repeat from a signed candidate artifact and qualify reboot/login persistence plus upgrade/rollback. |
| Windows host lifecycle | **PARTIAL** | [GitHub Actions run 29715302992](https://github.com/alphastorm/omp-session-gateway/actions/runs/29715302992) passed config/token ACL checks, scheduled-task install/start, token rotation, authenticated exact-Origin graceful PID replacement, active reinstall, and process-clean uninstall. | Repeat with a signed candidate artifact; qualify reboot/login persistence, diagnostics, upgrade, and rollback. |
| Android PWA installation | **NOT RUN** | Installable assets and Android-sized Chrome emulation passed. | Install from the real tailnet HTTPS origin on the target Android/Chrome version and verify update/offline states. |
| Three real OMP processes auto-discover | **PARTIAL** | Three patched interactive OMP processes appeared automatically within the acceptance window in Android-sized desktop Chrome. | Repeat on a physical Android device. |
| Real View and Control behavior | **PARTIAL** | Real desktop browser clients proved View composer disabled, Control prompt delivery, shared transcript updates, and interrupt. | Repeat every action from physical Android and verify host-side view mutation rejection. |
| Real lifecycle revocation | **PARTIAL** | Generation, stale launch, socket close, TTL tests, and real process exit/crash removal passed; no stale capability was returned. | Prove switch/branch/resume replacement ordering and crash-by-TTL on the candidate OMP/Android path. |
| Android lock, resume, network, back, and reconnect | **PARTIAL** | Chrome lifecycle/online events forced a fresh relay transport, the resumed view received new traffic, and leave returned to a secret-free directory URL. | Repeat OS lock, radio/network transition, browser back, and history/storage checks on physical Android. |
| Existing OMP relay connectivity | **PARTIAL** | Real desktop View/Control/interrupt and reconnect passed through the default relay; an automated eight-hour view client soak is running. | Complete the soak and repeat connectivity/lifecycle on physical Android. |
| Platform install/doctor/uninstall | **PARTIAL** | Full development-checkout flows passed on macOS, a Debian 13 systemd container, and hosted Windows; Windows included process-clean uninstall. | Qualify signed candidate artifacts on every advertised OS. |
| Configuration migration and rollback | **PARTIAL** | Active reinstall/PID replacement passed on macOS, Linux, and hosted Windows; configuration and token ownership were preserved. | Execute explicit forward migration and rollback with candidate artifacts on each advertised host. |
| Private vulnerability reporting | **PASS** | GitHub private vulnerability reporting is enabled and repository security guidance identifies the private path. | Reverify before publication. |
| Release signing, SBOM, and provenance | **PARTIAL** | Provenance test `provenance-test-v0.1.0.5` verified hosted GitHub attestations and Cosign bundles for the archive and checksum manifest. The updated commit-pinned workflow locally produces and covers the deterministic SPDX 2.3 inventory, but that SBOM-bearing path has not run from `main`. | Run `provenance-test-v0.1.0.6` after integration; verify GitHub attestations, Cosign bundles, checksums, SBOM, and immutable release assets after the 24-hour grace period. |
| Known limitations and exact compatibility matrix | **PASS** | This ledger and `COMPATIBILITY.md` state the pre-alpha boundary, exact OMP pin, unqualified platforms, and unsupported modes. | Keep both synchronized with every candidate. |
| Self-hosted/proxied relay | **N/A** | Explicitly unsupported and deferred. | Do not advertise; a future release needs the dedicated WebSocket soak and a separate security qualification. |

## Current release blockers

The alpha decision remains **NO-GO** until, at minimum:

1. at least one proposed host platform passes its complete native lifecycle and security matrix;
2. real Tailscale Serve authorization and LAN/public isolation pass on that platform;
3. a real Android device passes install, automatic discovery, View, Control, interrupt,
   generation replacement, lock/resume, network-change, back-navigation, reconnect, and leak checks;
4. the default OMP relay path passes the applicable connectivity/soak scenarios;
5. upgrade, rollback, diagnostics, token rotation, and uninstall pass for every advertised host;
6. release artifacts are produced by protected CI with checksums, SBOM/dependency inventory,
   signing or documented provenance, and a clean canary leak scan; and
7. private vulnerability reporting is enabled and verified.

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
