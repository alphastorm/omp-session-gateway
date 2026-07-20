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
| Repository check | **PASS** | `bun run check` passed handoff validation, four workspace typechecks, production web/client builds, 80 tests across 15 files, and capability-leak scanning. |
| Dependency audit | **PASS** | `bun audit` reported no vulnerabilities for the recorded lockfile. |
| OMP patch application and lifecycle fixtures | **PASS** | Patch reverse-apply check passed in the patched pinned checkout; 31 controller/publisher/settings/session-ordering/slash-command tests and the full coding-agent package typecheck passed. |
| Full pinned OMP checkout | **PASS** | The final hardening revision passed `bun run ci:check:full`; every official TypeScript test bucket passed with the native `/tmp` root after temporary exclusion of 32 upstream-baseline-sensitive tests reproduced without the patch, and all exclusions were restored. |
| Deterministic runtime archive | **PASS** | Two local `bun scripts/build-release.ts` runs produced byte-identical archives and a SHA-256 manifest. |
| Extracted archive command smoke | **PASS** | Repeated `install --no-start`, redacted diagnostics bundle creation, and `uninstall --no-stop` behaved as documented in the recorded environment. |
| Desktop mobile-viewport browser smoke | **PASS** | Chromium at `412 × 915` rendered three synthetic sessions; SSE, generation conflict, no-store launch, URL scrub, storage/cache checks, and prompt socket-close removal passed. A separate `390 × 844` run proved overlapping snapshot/SSE revision ordering, stale-metadata clearing on transport loss, and query-bearing asset cache bypass. |
| macOS/Tailscale development-checkout qualification | **PASS** | macOS 26.5.2 arm64 completed live LaunchAgent install/reinstall, permissions, token rotation, diagnostics bundle, real Serve identity allow/deny checks, loopback/LAN isolation, and uninstall. |
| Linux container lifecycle qualification | **PASS** | Debian 13 arm64 with a real systemd user manager completed install, autostart, active PID replacement, permissions, token rotation, and uninstall; this is explicitly not bare-metal qualification. |
| Windows hosted lifecycle qualification | **PASS** | [GitHub Actions run 29728466089](https://github.com/alphastorm/omp-session-gateway/actions/runs/29728466089) completed strict config/token ACL tests, current-user publisher access plus cross-user publisher-write denial, UTF-16 scheduled-task install/start, health/status, token rotation with graceful PID replacement, idempotent active reinstall, and process-clean uninstall. |
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
| Repository automated suite | **PASS** | Typechecks, production asset builds, 80 unit/integration tests across 15 files, handoff checks, and the repository leak scanner passed again in the final tag-triggered release workflow. | Repeat from clean CI for every subsequent candidate. |
| OMP patch compatibility | **PASS** | The final patch applies cleanly; 31 lifecycle/slash-command fixtures, coding-agent package typecheck, full-checkout checks, and all official TypeScript test buckets passed with documented baseline exclusions restored afterward. | Rerun from the exact pin at the candidate tag; do not broaden the OMP range. |
| Capability non-persistence | **PARTIAL** | Automated scans and desktop Chromium storage/history/cache checks passed. | Complete Android lifecycle checks and scan release CI artifacts, recordings, diagnostics, browser state, and all forbidden sinks with canary capabilities. |
| Loopback-only exposure | **PARTIAL** | macOS listener inspection and direct LAN/Tailscale-IP connection attempts proved the development checkout loopback-only. | Repeat with every signed candidate artifact and qualified host OS. |
| Tailscale Serve identity and application allowlist | **PARTIAL** | Real macOS Serve accepted the exact allowlisted login; denied and missing identities failed; direct LAN and Tailscale-IP access failed; Funnel was disabled. Direct loopback header spoofing is outside the explicit single-user v1 boundary. | Repeat from distinct allowed and denied tailnet devices with the candidate artifact. |
| Linux host lifecycle | **PARTIAL** | Debian 13 arm64 container with a real systemd user manager passed install, autostart, permissions, restart/reinstall, token rotation, and uninstall. | Repeat on a bare-metal/VM candidate OS and qualify upgrade/rollback and diagnostics. |
| macOS host lifecycle | **PARTIAL** | macOS 26.5.2 arm64 passed live LaunchAgent install, private permissions, restart/reinstall, token rotation, diagnostics/bundle, Serve checks, and uninstall. | Repeat from a signed candidate artifact and qualify reboot/login persistence plus upgrade/rollback. |
| Windows host lifecycle | **PARTIAL** | GitHub Actions `windows-latest` run `29728466089` passed config/token ACL checks, current-user publisher access plus cross-user publisher-write denial, scheduled-task install/start, token rotation with graceful PID replacement, idempotent active reinstall, and process-clean uninstall. | Implement and qualify publisher-side named-pipe server identity/namespace-squatting resistance; then repeat with a signed candidate artifact and qualify reboot/login persistence, diagnostics, upgrade, and rollback. |
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
