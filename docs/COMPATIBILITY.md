# Compatibility and support policy

## Current claim

**No operating system, browser, or Android device is currently advertised as supported.**
The repository version is `0.1.0`, but it is unreleased and classified as an implemented
**pre-alpha**, not an alpha or production-qualified release. A locally built archive is an
engineering artifact, not a supported distribution.

The exact release decision and outstanding acceptance gates are tracked in
[`RELEASE_STATUS.md`](RELEASE_STATUS.md). This document defines what the project is compatible
with and how a compatibility claim becomes supportable.

## Status vocabulary

Compatibility statements use these terms deliberately:

| Term | Meaning |
|---|---|
| **Implemented** | The relevant code path exists and has repository-level automated coverage. |
| **Smoke-tested** | A named scenario passed in one recorded environment. This is not a platform support claim. |
| **Qualified** | The complete applicable release matrix passed on the named version, OS, browser, and deployment path. |
| **Supported** | A published release advertises that qualified combination and accepts bug reports against it. |
| **Deferred** | Intentionally outside the current release target. |
| **Unsupported** | Must not be presented as a working deployment path. |

An implemented or smoke-tested row remains unqualified until every applicable security,
installation, lifecycle, and cleanup scenario passes. Blank version ranges never imply support.

## Exact OMP baseline

The pre-alpha targets one immutable upstream source revision:

| Gateway line | OMP source | Nearest release baseline | OMP package baselines | Collab client | Registry protocol | Claim |
|---|---|---|---|---|---:|---|
| `0.1.0` (unreleased) | `can1357/oh-my-pi@89d6a8f6d14286f32f09ec9c8aa8af7b3451d2d6` | `v17.0.6` | coding-agent `17.0.6`; wire `17.0.6` | collab-web `16.3.6` from the same source commit | 1 | Exact-commit pre-alpha qualification only |

`v17.0.6` is the nearest release and package baseline recorded on **2026-07-21**. It is
not a claim that every checkout or package combination labeled `v17.0.6` is compatible.
No earlier or later OMP release, commit, fork, or loose semver range is supported.

The immutable source paths, versions, observation date, and upstream findings live in
[`UPSTREAM.lock.json`](../UPSTREAM.lock.json). The gateway integration currently requires:

- the apply-ready OMP controller/auto-start/registry patch in
  [`patches/oh-my-pi`](../patches/oh-my-pi/README.md);
- the pinned collab-web source integration described by
  [`packages/collab-client/upstream/UPSTREAM.json`](../packages/collab-client/upstream/UPSTREAM.json);
- the reviewed in-memory client bootstrap, because unchanged upstream collab-web writes a
  capability to `location.hash`; and
- Bun `1.3.14` for the recorded build and test baseline. The runtime archive declares
  Bun `>=1.3.14`, but versions newer than the pinned baseline are not release-qualified yet.

## Versioned interfaces

Three compatibility surfaces change independently:

| Surface | Current version | Current behavior |
|---|---:|---|
| OMP publisher to gateway registry | 1 | Strict runtime validation; unknown major versions are rejected. |
| PWA to gateway HTTP API | `/api/v1` | One emitted API major; list/SSE remain metadata-only and launch remains generation-bound. |
| Gateway patch to OMP internals | Exact commit above | Tested as a patch against the pinned checkout; no private-internals compatibility range is inferred. |

Package version compatibility does not override a protocol major or exact OMP source pin.
Rolling compatibility with an earlier publisher protocol may be added only after explicit
cross-version tests exist.

## Host and client matrix

The following describes code and evidence, not advertised support:

| Platform | Implemented path | Recorded evidence | Qualification | Support claim |
|---|---|---|---|---|
| Linux host | Unix-domain socket; systemd user service | Debian 13 arm64 container with a real user manager passed live install, autostart, active reinstall/PID replacement, private permissions, token rotation, and uninstall | Container evidence is not bare-metal qualification; rollback and non-systemd paths remain unrun | None |
| macOS host | User-only Unix-domain socket; LaunchAgent | macOS 26.5.2 arm64 passed live install, restart/reinstall, private permissions, atomic token rotation, doctor/bundle, Serve access as the allowlisted node identity, loopback-backend identity rejection, loopback/LAN isolation, and uninstall from a development checkout; independently verified `provenance-test-v0.1.0.10` passed isolated install/runtime, real Serve routing, gateway restart, patched OMP publication/removal, and finite beyond-TTL suspension smoke | Full signed-candidate LaunchAgent lifecycle, rollback, reboot/login persistence, actual sleep/wake and relay/browser recovery, distinct-device identity isolation, and real collaboration remain unqualified | None |
| Windows host | Current-user named pipe and scheduled task; OMP publisher requires a nonce-bound mutual HMAC handshake before releasing capabilities | [GitHub Actions run 29791906104](https://github.com/alphastorm/omp-session-gateway/actions/runs/29791906104) applied the exact candidate OMP patch on `windows-latest`, passed all eleven publisher fixtures—including mutual authentication, fake-server withholding, restart recovery, post-restart token reread, and explicit-token-path publication preserving ambient XDG configuration—and the coding-agent typecheck, then passed gateway IPC/config/token ACL tests, current-user publisher access, cross-user publisher-write denial, UTF-16 task installation, active health, atomic token rotation with graceful PID replacement, idempotent active reinstall, and process-clean uninstall | Hosted source-checkout evidence is not signed-artifact qualification; reboot/login persistence, diagnostics, upgrade/rollback, and a release-candidate run remain unqualified | None |
| Android client | Installable HTTPS PWA through Tailscale Serve | Pixel 10 Pro, Android 17 build `CP2A.260705.006` (SDK 37), Chrome `150.0.7871.128` passed the corrected `v0.1.0-prealpha.4` installed-PWA View/Control/Back, exactly-once retained response, foreground and lock-screen attention notification, dashboard-only notification tap, lock/resume, Wi-Fi/cellular transition, automatic relay reconnect, generation replacement with stale `409`, and TTL removal/republication. The independently verified `v0.1.0-prealpha.5` artifact then auto-discovered three real OMP processes, cleared all cards after a silent Airplane-mode partition, and restored exactly three from a fresh snapshot without Refresh. On signed `v0.1.0-prealpha.7`, the user reported the instructed explicit-enable, closed-PWA background notification, and tap-to-current-Control flow working on their phone; fresh device/OS/browser versions and a named evidence artifact were not captured. | Cold offline navigation is intentionally unavailable because navigation is never service-worker cached. The background Push lock-screen, force-stop, stale-generation, network-change, and forbidden-sink matrix remains incomplete, as do physical interrupt, host-observed View mutation rejection, switch/branch/saved-session resume, process crash, distinct-identity denial, and deep URL/history/storage/cache inspection. | None |
| Desktop Chromium | Development/smoke client | Serve access as the current node's allowed identity, loopback-backend identity rejection, three real OMP cards, View/Control/interrupt, SSE, URL scrub, browser-store/cache checks, process removal, foreground/online reconnect, and live `/new` generation revocation (`409` for the stale generation) passed | Not a release target, not denied-device identity proof, and not a substitute for physical Android qualification | Smoke only |

No other Linux init system, macOS deployment mode, Windows service mechanism, iOS browser,
Firefox, Safari, or Chromium derivative has a compatibility claim.

The v1 HTTP identity boundary assumes a user-controlled workstation. Any untrusted process or
different OS account that can connect to the desktop's loopback port can forge the non-cryptographic
Serve identity headers and is therefore outside the support boundary. Shared shell hosts and
mutually untrusted local accounts are unsupported even though IPC publication itself remains
current-user/token protected.

## Deployment dependency matrix

| Dependency or mode | Current state | Compatibility statement |
|---|---|---|
| Tailscale Serve over tailnet HTTPS | Required production architecture; live on macOS 26.5.2 with Tailscale 1.98.8 | Allowed identity succeeded through Serve; denied and missing identities were rejected; direct LAN and Tailscale-IP port access failed and Funnel remained disabled. Direct loopback spoofing remains outside the explicitly single-user v1 trust boundary above. |
| User-owned Tailscale source identity | Designed identity-header mode | The exact `alphastorm@github` login was observed through Serve and allowlisted for qualification; no broader identity/device support is claimed. |
| Tagged Tailscale source device | Unsupported | Serve user identity headers do not provide the required user identity for this source type. |
| Existing OMP encrypted relay | Required v1 relay path | Real desktop View/Control/interrupt passed. The signed `v0.1.0-prealpha.2` recovery soak remained live for 28,800 seconds through eight room transitions with no restart and a 720 KiB gateway RSS increase. Physical Android qualification remains release-blocking; relay availability and traffic metadata are inherited dependencies. |
| Self-hosted or proxied relay | Unsupported/deferred | Must pass the dedicated long-lived WebSocket soak before it can be documented as supported. |
| `dev-localhost` HTTP mode | Development only | Never a remote, LAN, or production deployment path. |
| Tailscale Funnel or public reverse tunnel | Unsupported | Must not be enabled or documented as a normal deployment path. |

WebAuthn control gating, a Trusted Web Activity, native Android applications, and multi-host
federation remain deferred. Background Web Push delivery is implemented with repository tests and
a desktop Chromium closed-page smoke, and its core explicit-enable, closed-PWA notification, and
tap-to-current-Control flow has one user-reported physical Android success on `v0.1.0-prealpha.7`.
No compatibility promise exists until the exact-version physical lock-screen, stale-generation,
force-stop, network-change, and forbidden-sink matrix passes with a named evidence artifact.

## Upstream refresh procedure

For every proposed OMP update:

1. Inspect the new release/tag and collaboration-related source changes.
2. Update `UPSTREAM.lock.json` with the exact tag, commit, package versions, Bun version,
   relevant paths, findings, and observation date.
3. Rebase or regenerate the OMP patch series without unrelated changes.
4. Rebuild the pinned collab-web integration and verify its provenance and license notices.
5. Run controller, publisher, protocol, link parsing, View, and Control tests.
6. Run start, stop, switch, branch, resume/tree-navigation, relay-replacement, fatal-failure,
   and shutdown lifecycle tests.
7. Run the complete capability-leak suite and real browser/Android acceptance.
8. Qualify every advertised host installer and deployment path.
9. Update this matrix, [`RELEASE_STATUS.md`](RELEASE_STATUS.md), and the changelog.

Do not broaden the OMP range from one exact commit until CI and acceptance results prove
each additional version independently.

## Protocol evolution

- Reject unknown major protocol versions.
- Add optional fields within a major only when old peers safely ignore them.
- Never reinterpret a field's security meaning in place.
- Emit one browser API major at a time.
- Record protocol versions in diagnostics without capability values.
- Document upgrade order and rollback behavior before supporting mixed gateway/publisher versions.

Every published release must identify the exact OMP and collab-web source, build command,
Bun version, dependency lockfile hash, local patches, license notices, and shipped asset hashes.
