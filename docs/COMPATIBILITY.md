# Compatibility and support policy

## Current claim

**Current release:** stable-qualified `v0.2.1` for the exact matrix below.<br>
**Stable candidate:** signed `v0.2.1-prealpha.2`, fully qualified and approved.<br>
**Engineering head:** `0.3.0` adds the phone photo composer and is unqualified pre-alpha work;
none of the stable evidence transfers to its changed collaboration-client bytes.<br>
**Rollback predecessor:** published stable `v0.2.0`.<br>
**Qualification predecessor:** signed stable candidate `v0.2.1-prealpha.2`.<br>
**Advertised combinations:** Debian 13 (trixie) x86-64 and macOS 26.6.1 arm64 hosts, with Chrome
151.0.7922.173 on Android 17 (Pixel 10 Pro). Nothing else is advertised.

Tailscale Serve over tailnet HTTPS is the only supported remote path. Funnel must remain disabled
and Tailscale must run its TUN-mode client; userspace-networking tailscaled does not establish the
required loopback/identity boundary and is refused
([#98](https://github.com/alphastorm/omp-session-gateway/issues/98)). The published alpha requires
exact OMP v17.3.8 at 858f7dd91fff9b84cf8a2c6a6bb85aa0e6d03a55 plus its recorded patch. Beta and
the narrow stable target require exact OMP v17.4.1 at
9350b7990d26ebf69a604edc82d8558ef04adf30, patch tree
a5cfc80fcc0df1ca6e430c125371bcae43d5e5f7, and the versioned omp-gateway-patched activation
route. Stock OMP is unsupported. Upstreaming and paired packaging are not gates for this exact
matrix under ADR-024 and ADR-025.

The stable support claim comes from one exact signed-candidate qualification, not row counts or
transferred labels. Candidate `v0.2.1-prealpha.2` at source
`f09e3566c238ad76e220bea093d06d0124f924d9` passed the complete matrix through one resumable
receipt:

- release run [`33206359784`](https://github.com/alphastorm/omp-session-gateway/actions/runs/33206359784)
  verified the signed tag, six assets, checksums, three GitHub attestations, three Sigstore bundles,
  and archive SHA-256 `9fd5e49b9819ab4dfc82f978fcd9e8382b83d5b821bb341c6b6e6979ff42c7fa`;
- Debian run [`33207184350`](https://github.com/alphastorm/omp-session-gateway/actions/runs/33207184350)
  passed the complete disposable Debian 13 lifecycle and the published `v0.2.0` predecessor pair;
- `Mac14,3` / macOS 26.6.1 arm64 passed `doctor` 17/17, rollback 20/20 against published `v0.2.0`,
  persistence, exact artifact checks, patched-OMP publication/revocation, uninstall, and cleanup;
- the physical Pixel passed same-page lock, Airplane, and forced-Doze recovery with a clean
  seven-sink capability sweep after explicit ADB authorization;
- exact patched OMP v17.4.1 published and revoked generation-1 View and Control with `200 no-store`;
- the default relay finished a 60-second smoke live with two transitions; and
- final cleanup measured zero gateway/OMP processes and zero gateway listeners.

Windows source/lifecycle checks pass, but Windows remains unadvertised and outside this stable
matrix. No prior release evidence substitutes for a missing v0.2.1 candidate lane.

Known limits remain part of the claim. Exact candidate `v0.2.0-prealpha.1` recovered same-page automatically
after the qualified lock, Airplane, and forced-Doze transitions. Chrome for Android can still wedge
its process-wide network state after some abrupt transitions while Android remains healthy. Native
EventSource reconnection and the bounded snapshot fallback recover the proven cases; after 45
uninterrupted visible seconds the loaded shell exposes force-stop/reopen help. JavaScript does not
claim it can restart Chrome's network service
([#65](https://github.com/alphastorm/omp-session-gateway/issues/65)). Preview detail currently falls
back to Session detail. Background Web Push remains outside the stable core claim. Portal Tunnel,
self-hosted/proxied relays, Funnel, userspace networking, shared mutually untrusted local accounts,
and every unnamed platform/browser/version remain unsupported.

A signed artifact proves origin, not fitness. Candidate history for the 0.1 point release is
explicit, and the 0.2 campaign adds its own row:

| Candidate | Build | Disposition | Verification |
|---|---|---|---|
| `v0.1.0-prealpha.18` | `0.1.0-3a9bb1cccc6e` | **Failed qualification; retained as evidence.** Repeated explicit rollback reached systemd's start-rate limit and repair could not restart. | Six signed/attested assets verified; macOS/Pixel/relay sublanes passed; Debian full lane failed at W2. |
| `v0.1.0-prealpha.19` | `0.1.0-28d89a99565d` | **Qualified replacement.** Clears the systemd start-rate counter only before an explicit operator-requested install/rollback start. | Archive SHA-256 `f6e01c4b96b5630fccbb3c79f0a0dae1677e316990d869db6e300ce96605a762`; checksums, three GitHub attestations, and three Cosign bundles verified; exact Debian/macOS/Pixel evidence above. |
| `v0.1.0-prealpha.20` | `0.1.0-848c968923f1` | **Qualified and promoted to `v0.1.0-beta.1`.** Uses the accepted exact v17.4.1 patch route; upstreaming and paired packaging are not gates. | Archive SHA-256 `ba789f7a7f6799a53dab205e26cf6f3ebbaa39c2e26655315c1a809075b09ed2`; checksums, signed tag, all attestations/Cosign bundles, byte-identical rebuild, Debian/macOS/Pixel lanes, exact Linux/macOS patched-OMP operation, and bounded beta relay smoke passed. |
| `v0.1.0-prealpha.21` | `0.1.0-a98c526c40a3` | **Rejected.** Final qualification passed artifact, Debian, macOS, and relay lanes but failed the physical Android lane; cleanup passed. | Archive SHA-256 `cb7da13531875b879c3ab1c2451b58683199263877a74475f539258dfdcba33c`; Debian run `32565941928`; receipt `v0.1.0-prealpha.21.failed-32565941928-187994c`. |
| `v0.1.0-prealpha.22` | `0.1.0-489b58e4b862` | **Rejected.** Lock and Doze did not recover, Airplane recovery took 170,210 ms, and no outage status rendered; cleanup passed. | Archive SHA-256 `194958b5b7affce27163145ca90b5cc14c6952ebb0bbf15b43878c351c6c69db`; release run `32579082734` attempt 2; Debian run `32579748768`. |
| `v0.1.0-prealpha.23` | `0.1.0-434cddc44333` | **Qualified and approved for `v0.1.0`.** Native EventSource reconnection plus bounded snapshot fallback passed explicit no-reload recovery. | Archive SHA-256 `f98bad0ce2ae20d3892e560069b2fbfc4ab6d084a403b6aa57e41c628c25ce98`; signed tag/assets/attestations/bundles, exact rebuild, Debian/macOS/Pixel/patched-OMP/relay lanes, seven-sink sweep, and cleanup all passed exactly once. |
| `v0.2.0-prealpha.1` | `0.2.0-db88afb2ca18` | **Qualified and approved for `v0.2.0`.** Couch-flow visual pass, Settings sheet, transcript windowing, and shell-precached collab client; cross-version `v0.1.0` rollback pair. | Archive SHA-256 `149fc1b88a22b9cb1781bcb6219f2c1e41cafc867cb4eefe0a1e04b07eceeea2`; signed tag/assets/attestations/bundles, Debian run `33156664373` incl. `v0.1.0` migration, macOS `doctor` 17/17 and rollback 20/20, Pixel lock/Airplane/Doze recovery with a clean seven-sink sweep, patched-OMP publication/revocation, 60s relay smoke, and cleanup all passed exactly once. |
| `v0.2.1-prealpha.1` | `0.2.1-3ea58e234b6d` | **Rejected before qualification.** Build, attest, and signing passed; draft validation still expected 0.2.0 asset names and deleted the draft. | Signed diagnostic tag and transparency records retained; no GitHub release survived and no host/client qualification ran. |
| `v0.2.1-prealpha.2` | `0.2.1-f09e3566c238` | **Qualified and approved for `v0.2.1`.** Final phone hierarchy, coherent product versioning, predecessor-bound receipts, and stable runtime equivalence gate. | Archive SHA-256 `9fd5e49b9819ab4dfc82f978fcd9e8382b83d5b821bb341c6b6e6979ff42c7fa`; release run `33206359784`, Debian `33207184350`, macOS `doctor` 17/17 and rollback 20/20 from v0.2.0, physical Pixel recovery/leak sweep, patched-OMP publication/revocation, 60s relay smoke, and cleanup passed. |

[`RELEASE_STATUS.md`](RELEASE_STATUS.md) is the source of truth for evidence and release decisions.
This document defines the supported boundary. Where they disagree, the ledger is authoritative.

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

Published releases and unreleased development targets use separate immutable upstream revisions:

| Gateway line | OMP source | Nearest release baseline | OMP package baselines | Collab client | Registry protocol | Claim |
|---|---|---|---|---|---:|---|
| `0.1.0`, published as `v0.1.0-alpha.1` | `can1357/oh-my-pi@858f7dd91fff9b84cf8a2c6a6bb85aa0e6d03a55` | `v17.3.8` | coding-agent `17.3.8`; wire `17.3.8` | collab-web `16.3.6` from the same source commit | 1 | Exact-commit alpha qualification only |
| `0.1.0`, published as `v0.1.0-beta.1` | `can1357/oh-my-pi@9350b7990d26ebf69a604edc82d8558ef04adf30` | `v17.4.1` | coding-agent `17.4.1`; wire `17.4.1` | collab-web `16.3.6` from the same source commit | 1 | Exact-commit beta qualification through the versioned patched-binary route |
| `0.1.0`, published as `v0.1.0` | `can1357/oh-my-pi@9350b7990d26ebf69a604edc82d8558ef04adf30` | `v17.4.1` | coding-agent `17.4.1`; wire `17.4.1` | collab-web `16.3.6` from the same source commit | 1 | Exact-commit stable qualification with patch tree `a5cfc80fcc0df1ca6e430c125371bcae43d5e5f7` through the versioned patched-binary route |
| `0.2.0`, published as `v0.2.0` | `can1357/oh-my-pi@9350b7990d26ebf69a604edc82d8558ef04adf30` | `v17.4.1` | coding-agent `17.4.1`; wire `17.4.1` | collab-web `16.3.6` from the same source commit | 1 | Exact-commit stable qualification with patch tree `a5cfc80fcc0df1ca6e430c125371bcae43d5e5f7` through the versioned patched-binary route |
| `0.2.1`, published as `v0.2.1` | `can1357/oh-my-pi@9350b7990d26ebf69a604edc82d8558ef04adf30` | `v17.4.1` | coding-agent `17.4.1`; wire `17.4.1` | collab-web `16.3.6` from the same source commit | 1 | Exact-commit stable qualification with unchanged patch tree `a5cfc80fcc0df1ca6e430c125371bcae43d5e5f7`; UI/version point release only |

v17.3.8 remains the immutable alpha baseline. Exact v17.4.1 source and patch tree are independently
qualified for beta and stable through the versioned executable route. No other OMP release, commit,
fork, loose semver range, stock binary, or paired-package route is supported.

**Pin refreshed 2026-08-21, from `v17.3.8` to `v17.4.1`.** The maintained
`gateway-collaboration` series already targeted the new exact base. The carried health-probe commit
applied cleanly, and the v17.4.1 QR-command fixture was adapted to exercise manual publication
recovery. Upstream collab-web, wire, and relay host/client implementation bytes are unchanged;
package metadata and the out-of-path session-close ordering changed. Earlier platform evidence did
not transfer automatically: `.20` repeated the beta lanes, and stable candidate `.23` repeated the
complete signed-artifact, Debian, macOS, physical Pixel, exact patched-OMP publication/revocation,
relay, leak, and cleanup gates. The command-complete `omp-gateway-patched` route is the qualified
stable prerequisite; upstreaming and paired OMP packaging remain non-gates.

**Pin refreshed 2026-08-19, from `v17.0.6` / `89d6a8f6d14286f32f09ec9c8aa8af7b3451d2d6`.** The
previous mbox did not apply at this commit (`interactive-mode.ts`, `agent-session.ts`,
`session-manager.ts`, and `builtin-registry.ts` all conflicted), so the shipped patch was
regenerated against `v17.3.8`. The refresh itself carried source-level evidence only: it re-ran the
documented patch suite and the repository suite, and it re-ran no native host, Tailscale, relay,
Android, browser, or signed-artifact qualification. Any platform row whose evidence predates
2026-08-19 is therefore **NOT RUN** for this pin until re-executed, and an unchanged row is never
coverage of `v17.3.8`.

Re-execution is current at stable candidate `v0.2.1-prealpha.2`. On 2026-08-28 it passed the
complete Debian signed-artifact lifecycle including the published `v0.2.0` predecessor
migration; the complete macOS install, persistence, rollback, and cleanup sequence; exact v17.4.1
patched-OMP publication/revocation; physical Pixel same-page lock, Airplane, and forced-Doze
recovery; the seven-sink capability sweep; and the bounded relay smoke. The protected
28,800-second long-window result remains transferable because relay host/client, collab-web, and
wire bytes are unchanged. Issue #65 stays open for other process-wide Chrome failures, not as a
qualification exception for the transitions the candidate actually passed.

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

The following describes code, evidence, and each row's support boundary. Debian 13 x86-64, macOS
26.6.1 arm64, and Chrome 151.0.7922.171 on the Android 17 Pixel have exact stable-candidate `.23`
qualification. Earlier rows remain historical evidence, not substitutes for the stable result.
Windows passes persistent source acceptance through reboot-to-interactive-login and the complete
gateway/OMP path, but remains unadvertised until signed Windows gateway and patched-OMP artifacts
repeat it. This Windows-only gap does not block the narrower stable matrix. Desktop Chromium is
smoke only.

| Platform | Implemented path | Recorded evidence | Qualification | Support claim |
|---|---|---|---|---|
| Linux host | User-only Unix-domain socket; systemd user service | Exact signed candidate `.23` passed the complete Debian 13 trixie x86-64 install/readiness, permission, rotation, diagnostics, rollback, identity-denial, lingering, refusal-safe uninstall, cleanup, and disposable-host teardown lane in [run `32586459902`](https://github.com/alphastorm/omp-session-gateway/actions/runs/32586459902). The orchestrator also qualified exact patched OMP v17.4.1 publication/revocation. | Qualified for Debian 13 x86-64 with TUN-mode Tailscale Serve. Other Linux releases, architectures, init systems, and userspace networking remain unqualified. | Stable `v0.1.0`: Debian 13 x86-64 only |
| macOS host | User-only Unix-domain socket; LaunchAgent | Exact signed candidate `.23` on `Mac14,3` / macOS 26.6.1 arm64 passed archive and native-addon verification, private install, loopback readiness, `doctor` 17/17, rotation/persistence, control-plane restart, rollback 20/20, exact patched-OMP v17.4.1 build/publication/revocation, uninstall, Serve reset, source cleanup, and zero-process/listener cleanup. | Qualified only for macOS 26.6.1 arm64 on `Mac14,3` with TUN-mode Tailscale Serve. | Stable `v0.1.0`: named macOS combination only |
| Windows host | Current-user named pipe and Scheduled Task with `LogonTrigger` + `InteractiveToken`; paired OMP publisher uses nonce-bound mutual HMAC before releasing capabilities | Hosted run `29791906104` passed publisher mutual authentication, ACLs, cross-user denial, service lifecycle, rotation, and uninstall. A persistent Windows Server 2025 source lane on 2026-08-21 then passed exact-source install in 77,498 ms, reboot with task installed but no pre-login listener, automatic first-RDP-login startup without `/Run`, config/token continuity, rotation, active upgrade, history-selected rollback, TUN-mode Serve, `doctor` 17/17, and clean uninstall. Exact patched OMP `v17.4.1` built on the host, auto-published View and Control, returned `200 no-store` launches, denied a mismatched generation `409`, and revoked within 374 ms after forced exit. | **PARTIAL for release.** The persistent source lane accepts #90 and the reboot/login contract, but its gateway archive and OMP binary were unsigned. A Windows-only hang in the complete `read-only.test.ts` fixture also remains to be dispositioned; the publisher suite passed 13/13 and production publication/revocation passed. Repeat the entire lane with paired signed artifacts. | None; Windows remains unadvertised. If later promoted, the promise is “starts at interactive login,” not unattended boot. |
| Android client | Installable HTTPS PWA through Tailscale Serve | Physical Pixel 10 Pro / Android 17 / Chrome `151.0.7922.171` loaded exact candidate asset `/assets/app.2127b031d191.js`. It recovered the same page automatically after secure lock (8,972 ms), a visible Airplane outage (8,998 ms plus ten settled seconds), and forced Doze (8,291 ms), with unchanged `performance.timeOrigin`, no recovery fetch probe, and no reload. The seven forbidden capability sinks were detectable and clean. | Qualified only for the named device/OS/browser through TUN-mode Tailscale Serve. Issue #65 remains a process-wide Chrome limitation outside these proven transitions. | Stable `v0.1.0`: named Pixel combination only |
| Desktop Chromium | Development/smoke client | Serve access as the current node's allowed identity, loopback-backend identity rejection, three real OMP cards, View/Control/interrupt, SSE, URL scrub, browser-store/cache checks, process removal, foreground/online reconnect, and live `/new` generation revocation (`409` for the stale generation) passed | Not a release target, and never a substitute for physical Android qualification: emulating a device's viewport and pixel ratio is not a result from that device. The denied-identity evidence in this document comes from a tagged droplet and the physical Pixel, not from desktop Chromium. | Smoke only |

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
| Tailscale Serve over tailnet HTTPS | Required production architecture. Advertised evidence includes macOS-hosted Serve on macOS 26.5.2/26.6.1 arm64; supplemental Windows Server 2025 source acceptance used Authenticode-valid Tailscale `1.102.3`, TUN mode, and passed `doctor` 17/17. No Tailscale version range is qualified. | The signed-candidate identity matrix is closed for the advertised hosts: tagged/no-user identity denied, real non-allowlisted identity denied, real allowlisted identity admitted, forged headers ignored, direct backend addresses refused, and Funnel disabled. Windows repeats only the allowed self-node/Serve half in unsigned source acceptance and therefore gains no support claim. Direct loopback spoofing remains outside the explicitly single-user v1 trust boundary, and the full identity evidence must repeat on every newly advertised host. |
| User-owned Tailscale source identity | Designed identity-header mode | One exact user-owned login — the operator's own — was observed through Serve and allowlisted for qualification; no broader identity or device support is claimed. The login itself is deliberately not reproduced here: the only login written into this file is a placeholder in a reserved TLD, so nothing readable here is ever authenticable. A denial by a *different real person's* login has never been measured and cannot be produced by a single-account tailnet. |
| Tagged Tailscale source device | Unsupported, and now measured | Serve populates user identity headers only for user-owned source devices, so a request proxied from a tagged source arrives with no user identity and the `tailscale-serve` auth mode must fail closed. Measured on droplet a node carrying `tag:omp-session-gateway`, confirmed by both `tailscale status` and `tailscale whois`, which reported no user profile and a tag list: `403` through Serve on `/api/v1/sessions` and on `/`. A tagged phone would need a separately designed app-capabilities or equivalent authentication mode; do not silently weaken authentication to accommodate one. |
| Any other forwarder onto the gateway's loopback port | Unsupported; a complete authentication bypass | A tunnel, reverse proxy, port forward, container publish, or SSH `-L` that terminates remote traffic and relays it to `127.0.0.1:<port>` presents a loopback peer, satisfying the first authorization check, and then forwards whatever `Tailscale-User-Login` the remote caller chose. Tailscale Serve is safe here only because it overwrites caller-supplied identity headers; nothing else in this design does. See [`SECURITY.md`](SECURITY.md) §4 and [#74](https://github.com/alphastorm/omp-session-gateway/issues/74). |
| Existing OMP encrypted relay | Required v1 relay path. Real View/Control/interrupt passed. Exact stable candidate `.23` finished a 60-second default-relay smoke live with two transitions. A protected 28,800-second run completed 22 transitions without restart; it transfers because relay host/client, collab-web, and wire bytes are identical. Relay availability and traffic metadata remain inherited dependencies. | Supported only through the existing default relay; no availability or metadata-hiding guarantee beyond OMP's relay |
| Self-hosted or proxied relay | Unsupported/deferred | Must pass the dedicated long-lived WebSocket soak and a separate security qualification before it can be documented as supported. |
| `dev-localhost` HTTP mode | Development only | Never a remote, LAN, or production deployment path. |
| Tailscale Funnel or public reverse tunnel | Unsupported | Must not be enabled or documented as a normal deployment path. |

WebAuthn control gating, a Trusted Web Activity, native Android applications, and multi-host
federation remain deferred. Background Web Push delivery is implemented with repository tests and
a desktop Chromium closed-page smoke, and its core explicit-enable, closed-PWA notification, and
tap-to-current-Control flow has one user-reported physical Android success on `v0.1.0-prealpha.7`.
That report predates the current device baseline and every candidate in the table above. No
compatibility promise exists until the exact-version physical lock-screen, stale-generation,
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
