# Compatibility and support policy

## Current claim

**Current public release:** qualified alpha `v0.1.0-alpha.1`.<br>
**Rollback predecessor:** qualified alpha `v0.1.0-alpha`.<br>
**Qualification candidate:** signed `v0.1.0-prealpha.19`.<br>
**Advertised combinations:** Debian 13 (trixie) x86-64 and macOS 26.6.1 arm64 hosts, with Chrome
`151.0.7922.171` on Android 17 (Pixel 10 Pro). Nothing else is advertised.

Tailscale Serve over tailnet HTTPS is the only supported remote path. Funnel must remain disabled
and Tailscale must run its **TUN-mode** client; userspace-networking `tailscaled` does not establish
the required loopback/identity boundary and is refused
([#98](https://github.com/alphastorm/omp-session-gateway/issues/98)). The gateway requires exact OMP
`v17.3.8` at `858f7dd91fff9b84cf8a2c6a6bb85aa0e6d03a55` plus the repository's six-commit patch.

The default branch has moved the next candidate to exact OMP `v17.4.1` at
`9350b7990d26ebf69a604edc82d8558ef04adf30`. That source integration is **not** part of either
published alpha and carries no support claim until the applicable signed-artifact, host, relay, and
physical-client lanes are requalified.

The successor's support claim comes from exact signed-candidate evidence, not row counts:

- Debian [run `32502584598`](https://github.com/alphastorm/omp-session-gateway/actions/runs/32502584598)
  passed the complete artifact/lifecycle/migration/rollback/identity/persistence/uninstall order,
  including `107/107` rollback invariants and both lingering states.
- macOS passed signed-artifact install, `doctor` 17/17, rotation, distinct-node exposure checks, a
  Scaleway control-plane reboot with unchanged token and automatic LaunchAgent return, and uninstall.
- the physical Pixel passed the seven-sink capability sweep, a genuine BFCache history restoration,
  read-only View, explicit Control, remote prompt/interrupt, and safe return to Sessions.
- hosted Windows source/lifecycle checks passed, but Windows remains unadvertised.

Known limits remain part of the claim. Chrome-for-Android can wedge its process-wide network stack
after an abrupt radio transition while the device itself remains healthy, so network-change and
reconnect are not proven ([#65](https://github.com/alphastorm/omp-session-gateway/issues/65)).
Preview notification detail currently falls back to Session detail. Self-hosted/proxied relays,
Funnel, userspace-networking Tailscale, shared mutually untrusted local accounts, and every
unnamed platform/browser/version remain unsupported.

A signed artifact proves origin, not fitness. Candidate history for this point release is explicit:

| Candidate | Build | Disposition | Verification |
|---|---|---|---|
| `v0.1.0-prealpha.18` | `0.1.0-3a9bb1cccc6e` | **Failed qualification; retained as evidence.** Repeated explicit rollback reached systemd's start-rate limit and repair could not restart. | Six signed/attested assets verified; macOS/Pixel/relay sublanes passed; Debian full lane failed at W2. |
| `v0.1.0-prealpha.19` | `0.1.0-28d89a99565d` | **Qualified replacement.** Clears the systemd start-rate counter only before an explicit operator-requested install/rollback start. | Archive SHA-256 `f6e01c4b96b5630fccbb3c79f0a0dae1677e316990d869db6e300ce96605a762`; checksums, three GitHub attestations, and three Cosign bundles verified; exact Debian/macOS/Pixel evidence above. |

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
| default branch, unreleased | `can1357/oh-my-pi@9350b7990d26ebf69a604edc82d8558ef04adf30` | `v17.4.1` | coding-agent `17.4.1`; wire `17.4.1` | collab-web `16.3.6` from the same source commit | 1 | Source-integrated next candidate; qualification pending |

`v17.3.8` is the package baseline qualified for the published alpha. No earlier or later OMP
release, commit, fork, or loose semver range is supported by that release. The v17.4.1 row is an
explicit development target, not a retroactive expansion of the alpha support boundary.

**Development pin refreshed 2026-08-21, from `v17.3.8` to `v17.4.1`.** The maintained
`gateway-collaboration` series already targeted the new exact base. The carried health-probe commit
applied cleanly, and the v17.4.1 QR-command fixture was adapted to exercise manual publication
recovery. Upstream collab-web source and wire protocol source are unchanged across these pins;
package versions, package authorship/license metadata, the mbox, and all provenance records still
move to the exact new commit. No platform or signed-artifact evidence transfers to this row.

**Pin refreshed 2026-08-19, from `v17.0.6` / `89d6a8f6d14286f32f09ec9c8aa8af7b3451d2d6`.** The
previous mbox did not apply at this commit (`interactive-mode.ts`, `agent-session.ts`,
`session-manager.ts`, and `builtin-registry.ts` all conflicted), so the shipped patch was
regenerated against `v17.3.8`. The refresh itself carried source-level evidence only: it re-ran the
documented patch suite and the repository suite, and it re-ran no native host, Tailscale, relay,
Android, browser, or signed-artifact qualification. Any platform row whose evidence predates
2026-08-19 is therefore **NOT RUN** for this pin until re-executed, and an unchanged row is never
coverage of `v17.3.8`.

Re-execution is current at the successor candidate. On 2026-08-21,
`v0.1.0-prealpha.19` passed the complete Debian signed-artifact lifecycle and all `107/107`
rollback invariants, the complete macOS install/rotation/identity/control-plane-reboot/uninstall
sequence, and the physical Pixel capability-leak/BFCache/View/Control/interrupt sequence. The
candidate records the same OMP pin and collab-client bytes named above. The bounded real relay smoke
was followed by a protected 28,800-second default-relay run on 2026-08-21: 22 room transitions,
`finalPhase: "live"`, exit code 0, and no restart. The remaining explicit limit is Android
network-change/reconnect, blocked by [#65](https://github.com/alphastorm/omp-session-gateway/issues/65).

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

The following describes code, evidence, and each row's support boundary. Linux, macOS, and the
Android client retain their `v0.1.0-alpha` support claim and have passed successor
`v0.1.0-alpha.1` qualification for the exact versions named below. Windows is implemented and
hosted-lifecycle tested but remains unadvertised pending a persistent reboot→interactive-login
qualification. Desktop Chromium is smoke only.

| Platform | Implemented path | Recorded evidence | Qualification | Support claim |
|---|---|---|---|---|
| Linux host | Unix-domain socket; systemd user service | Two environments. A **Debian 13 aarch64 container** with a real `systemd --user` manager passed the development-checkout lifecycle and repeated it from an unsigned extracted archive. On its 2026-08-20 re-run at the `v17.3.8` pin, from an archive built at merge commit `ac63641` on Bun 1.3.14, install reached ready with MainPID 159; the unit file, `config.json`, and the 44-byte publisher token were `0600` with `0700` config and state directories; `ss` showed a single listener bound to `127.0.0.1:4317`; active reinstall replaced PID 159 with 239; token rotation changed the token digest and replaced PID 239 with 292; the diagnostics bundle contained no token, allowlisted login, tailnet host, or home path; `uninstall --no-stop` refused with exit 1 while the service stayed active; and normal uninstall removed the unit and left zero listeners on 4317. A **real Debian 13 (trixie) x86_64 DigitalOcean droplet** — kernel `6.12.94+deb13-amd64`, systemd 257, `systemd-detect-virt` reporting `kvm` — then ran the sequence from the signed candidates. Install reported `{installed:true, active:true, ready:true, authMode:tailscale-serve}` with the listener bound to `127.0.0.1:4317` only and `doctor` at 12/16; the four false checks were `identityAllowed`, `pwa`, `securityHeaders`, and `publisherHealth`, all expected with no Serve mapping and no publishers. Reboot persistence **failed** on `.14` ([#69](https://github.com/alphastorm/omp-session-gateway/issues/69)): with lingering enabled, `loginctl Linger=yes`, and the boot id confirmed changed, `user@1000.service` came back `active` while the gateway daemon did not, leaving no pid and no listeners. It **passes** on `.15`: after a clean reboot with **no interactive login**, `loginctl` showed the uid-1000 session as class `manager`, the gateway ran as pid 766 with the listener on `127.0.0.1:4317`, and the process was 57 s old against 69 s of system uptime, so it started about 12 s after boot rather than on connection; the same procedure on `.14` left no pid and no listener. `.15` also reported `installed/active/ready`, `doctor` 12/16 with the same four expected false checks, socket mode 600 under the systemd-owned runtime directory, token rotation across pids 2208 to 2305, and a diagnostics bundle containing zero token bytes and zero home-path hits. On `.16`, with the service genuinely active, `uninstall --no-stop` **refused as required**, and a real uninstall then left no unit file, no gateway pid, and no listener. The `migration` lane passed 11/11 invariants from `.15` up to `.16` and back, including that `ExecStart` tracks the active version, that the unit stays `enabled` so an upgrade cannot silently reintroduce #69, that the main pid changes across the upgrade, and that the listener stays loopback-only after the rollback. | **PASS** in the ledger for Debian 13 on x86-64 only. A KVM guest is a virtual machine, not bare metal: firmware, real disks, real NICs, and physical power loss remain untested, and "bare-metal" is the wrong word for this evidence. The architecture also moved from aarch64 to x86_64 while the distribution was held fixed, so architecture-sensitive behaviour is newly covered rather than re-confirmed. No OMP publisher, browser, or Android device took part on this host, so `publisherHealth` reflects an empty registry and no session discovery, View/Control, generation replacement, relay, or capability-leak evidence comes from it. `doctor` cannot reach 16/16 on a tagged node by construction, because its self-probe through Serve carries no user identity. Persistence is proven for systemd user lingering on this one distribution; no other init system, and no non-systemd path, has any claim. | **Supported** in `v0.1.0-alpha` for Debian 13 (trixie) x86-64 only |
| macOS host | User-only Unix-domain socket; LaunchAgent | macOS **26.5.2** arm64 passed live LaunchAgent install, private permissions, restart/reinstall, atomic token rotation, `doctor`/bundle, Serve access as the allowlisted node identity, loopback-backend identity rejection, loopback/LAN isolation, and uninstall — all from a **development checkout**. The independently verified `provenance-test-v0.1.0.10` archive passed an isolated `--no-start` install/runtime smoke, real Serve routing, gateway-restart recovery, one patched interactive OMP publication/removal, and three controlled publisher/gateway suspension orders beyond TTL. Signed candidate `.14` was then installed over the live service: the in-place upgrade replaced `0.1.0-61114587f124` with `0.1.0-8773d783ca96`, moved the daemon from PID 41501 to 51469, kept `doctor` at 16/16, left the tailnet origin answering `200` with loopback still `403`, reconnected all three live publishers within 40 seconds with the in-memory registry correctly restarting empty at revision 0 before repopulating, and preserved `config.json` and the publisher token unchanged (digest `f361650a4974`, mode 600). A second in-place upgrade moved `0.1.0-8773d783ca96` to `0.1.0-2813d6b23306` (`.16`) and the daemon from PID 51469 to 12327, with **`doctor` at 16/16** and the origin still answering `200`; that build is what the live daemon runs. Rollback was measured on **macOS 26.6.1** arm64 with Bun 1.3.14 by `scripts/qualify-rollback.sh`, in an isolated root against both signed artifacts: install `.13`, upgrade `.14`, roll back to `.13`, **20/20 invariants**, `current.json` tracking `0.1.0-1b654b660ec4` to `0.1.0-8773d783ca96` and back, the predecessor version directory surviving the upgrade, `config.json` byte-identical at `sha256:60d9c36e2766`, the publisher-token digest and mode 600 unchanged throughout, and `ProgramArguments` naming the active version at all three steps. | **PASS** in the ledger for macOS 26.6.1 on arm64 only. The rollback lane ran `--no-start` throughout, so it measured the installer's state machine and not a running-service transition: no bootout/bootstrap, no readiness handshake, no PID replacement, and no post-rollback `status`/`doctor`/health probe, which means a rollback that leaves correct files behind but never brings the predecessor back up would still have passed every invariant. launchd's label namespace is per-uid and cannot be scoped, so the lane shimmed the part of launchd it could not isolate and everything downstream of "the service definition on disk is correct" — RunAtLoad, KeepAlive, reboot and login persistence, `bootstrap` failure modes — is untested by construction; the rollback step itself was obtained with launchd reads scoped. Only one rollback shape was exercised: a pruned predecessor directory, a `config.json` schema change, and a readiness-protocol change are all untested, as is the non-atomic window between the service-definition rewrite and the `current.json` write. Actual sleep/wake, relay/browser recovery, real OMP collaboration on this host, and candidate-artifact capability-leak acceptance remain unqualified; reboot/login persistence closed on 2026-08-21, and the ledger states that this proves return at automatic console login rather than start-up with nobody logged in. | **Supported** in `v0.1.0-alpha` for macOS 26.6.1 arm64 only |
| Windows host | Current-user named pipe and scheduled task; OMP publisher requires a nonce-bound mutual HMAC handshake before releasing capabilities | [GitHub Actions run 29791906104](https://github.com/alphastorm/omp-session-gateway/actions/runs/29791906104) applied the exact candidate OMP patch on `windows-latest`, passed all eleven publisher fixtures—including mutual authentication, fake-server withholding, restart recovery, post-restart token reread, and explicit-token-path publication preserving ambient XDG configuration—and the coding-agent typecheck, then passed gateway IPC/config/token ACL tests, current-user publisher access, cross-user publisher-write denial, UTF-16 task installation, active health, atomic token rotation with graceful PID replacement, idempotent active reinstall, and process-clean uninstall | Hosted source-checkout evidence is not signed-artifact qualification; reboot/login persistence, diagnostics, upgrade/rollback, and a release-candidate run remain unqualified. The ledger keeps this row **PARTIAL**: install cannot complete on a modest Windows host until [#90](https://github.com/alphastorm/omp-session-gateway/issues/90) is fixed, so Windows is implemented and partly qualified but not advertised. | None |
| Android client | Installable HTTPS PWA through Tailscale Serve | **Current device baseline (2026-08-20):** Pixel 10 Pro (the paired device), Android 17 build `CP2A.260805.005` (SDK 37), Chrome `151.0.7922.139`, measured layout viewport 411×816 within a 412×919 screen at device pixel ratio 2.625. Measured at the `v17.3.8` pin on this combination: `scripts/android-leak-sweep.ts` against a **development install** returned launch `200` with `cache-control: no-store, max-age=0` and body keys `capability,generation,mode`, carrying the 66-character capability (`sha256:d107fb0d826278b5`) in JSON to same-origin JavaScript rather than in any URL component, and found it absent from Local Storage, Session Storage, cookies, Cache Storage keys and bodies (only `omp-sessions-shell-c304cf72b454` present), IndexedDB, `location`/fragment (0-character hash, so no fragment fallback was used), `history.state`, referrer, resource-timing entries, and serialized DOM — with the detector first proving itself by planting a synthetic secret in all seven sinks, requiring all seven to be found, then removing them with no residue. Re-run against the **signed candidate** serving the live tailnet origin, the sweep was clean across all seven sinks with the detector again proving itself (7 planted, 7 detected, no residue), launch `200` `no-store`, capability `sha256:39478ea244d0c1ef`, zero-character fragment. As a **distinct tailnet node** rather than the host, the phone received `200` for `GET /api/v1/sessions` and for a `POST …/launch` with identity headers supplied by Serve, and `403` with `{"code":"forbidden"}` and no `instanceId` or `cwdLabel` in the body from an isolated second gateway on Serve port `:9443` whose allowlist held only the placeholder `denied-identity@qual.invalid`. Recovery matrix via `scripts/android-acceptance.ts`, first from a **development install** and then against the **signed candidate**: lock and resume recovered in 3,465-3,674 ms after wake with a 64-106 ms fetch and no unreachable banner across three runs, and in 3,872 ms on the candidate; forced deep Doze reached `IDLE` and recovered in 8,484-9,348 ms, and in 9,335 ms on the candidate; airplane mode showed the unreachable banner during the outage in every run and recovered automatically without a reload in 14,873 ms and in 83 ms on two runs, but a third run stalled for 471,257 ms while `adb shell ping` proved the device had reached the host at 28,424 ms, recovering only after the Doze cycle, and that stall reproduced on the signed candidate with the device reachable at 28,354 ms. **Historical scenario evidence**, on the superseded Android 17 build `CP2A.260705.006` (SDK 37) with Chrome `150.0.7871.128`: corrected `v0.1.0-prealpha.4` passed installed-PWA View/Control/Back, exactly-once retained response, foreground and lock-screen attention notification, dashboard-only notification tap, lock/resume, automatic relay reconnect, generation replacement with stale `409`, and TTL removal/republication; the independently verified `v0.1.0-prealpha.5` artifact auto-discovered three real OMP processes, cleared all cards after a silent Airplane-mode partition, and restored exactly three from a fresh snapshot without Refresh; on signed `v0.1.0-prealpha.7` the user reported the instructed explicit-enable, closed-PWA background notification, and tap-to-current-Control flow working, without fresh version capture or a named evidence artifact. | **PARTIAL** in the ledger on every applicable row, and nothing here is a resilience claim. **Wi-Fi to cellular is untested.** With Wi-Fi disabled this device reports `Active default network: none` and `connect: Network is unreachable`, because its Google Fi SIM is present but `NOT_READY`. The historical Wi-Fi→cellular→Wi-Fi pass therefore cannot be reproduced on this hardware and must be read as **unverified** until a device with working cellular data is available. **Post-outage recovery is not qualified:** [#65](https://github.com/alphastorm/omp-session-gateway/issues/65) is open, the 471,257 ms stall is reproduced but unattributed between the application, Chrome's network stack, and the Tailscale interface, and the harness cannot evaluate the page while Chrome's renderer is frozen, so the hidden part of an outage window is unobserved rather than proven healthy. Chrome also freezes the renderer while the display is off, so lock-state observation is only possible after waking. Cold offline navigation is intentionally unavailable because navigation is never service-worker cached. The capability sweep still needs the collaboration client page itself after it connects, `control` mode, and release CI artifacts, recordings, and diagnostics scanned with canary capabilities from a signed candidate artifact. Physical interrupt, host-observed rejection of a View mutation attempt, switch/branch/saved-session resume, process crash, and the background-Push lock-screen, force-stop, and stale-generation matrix all remain incomplete, as does re-running every historical scenario on the current device and browser. Platform-capability observations on the real origin — `isSecureContext === true`, `navigator.serviceWorker` with a non-null controller, Cache Storage, `PushManager`, `Notification.permission === "granted"`, `navigator.setAppBadge`, `navigator.clearAppBadge`, and `PublicKeyCredential` — make [`TEST_PLAN.md`](TEST_PLAN.md) gate D.10's badge requirement achievable and the deferred WebAuthn control-gating path feasible on this device; neither is qualified. | **Supported** in `v0.1.0-alpha` for Chrome `151.0.7922.139` on Android 17 only; the ledger measures this client against pre-alpha candidate `v0.1.0-prealpha.17`, and network-change and reconnect are a stated known limitation ([#65](https://github.com/alphastorm/omp-session-gateway/issues/65)) |
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
| Tailscale Serve over tailnet HTTPS | Required production architecture. All recorded evidence is macOS-hosted Serve: macOS 26.5.2 arm64 for the development-checkout lifecycle, macOS 26.6.1 arm64 for the rollback lane. The ledger records no Tailscale client version for any of this evidence; this workstation's client reported `1.102.2` on 2026-08-20, so no Tailscale version range is qualified. | The identity matrix is closed against signed candidate `v0.1.0-prealpha.16`. A **tagged** droplet carrying no user identity was refused `403` through Serve on both `/api/v1/sessions` and `/`, and a loopback request supplying no identity was refused `403`. From a distinct user-owned node, a real identity absent from the allowlist got `403`; a **forged** `Tailscale-User-Login` naming an allowlisted login got `403` while the caller's real identity was not allowlisted; the real allowlisted identity got `200`; and a forged header from an already-allowlisted caller was simply ignored, still `200`. That last pair is the proof that Serve owns the header rather than the caller, so remote identity-header spoofing cannot bypass the Serve path. Direct LAN and Tailscale-IP access failed and Funnel remained disabled. Direct loopback spoofing remains outside the explicitly single-user v1 trust boundary above, and the evidence must be repeated on each newly advertised host platform. |
| User-owned Tailscale source identity | Designed identity-header mode | One exact user-owned login — the operator's own — was observed through Serve and allowlisted for qualification; no broader identity or device support is claimed. The login itself is deliberately not reproduced here: the only login written into this file is a placeholder in a reserved TLD, so nothing readable here is ever authenticable. A denial by a *different real person's* login has never been measured and cannot be produced by a single-account tailnet. |
| Tagged Tailscale source device | Unsupported, and now measured | Serve populates user identity headers only for user-owned source devices, so a request proxied from a tagged source arrives with no user identity and the `tailscale-serve` auth mode must fail closed. Measured on droplet a node carrying `tag:omp-session-gateway`, confirmed by both `tailscale status` and `tailscale whois`, which reported no user profile and a tag list: `403` through Serve on `/api/v1/sessions` and on `/`. A tagged phone would need a separately designed app-capabilities or equivalent authentication mode; do not silently weaken authentication to accommodate one. |
| Any other forwarder onto the gateway's loopback port | Unsupported; a complete authentication bypass | A tunnel, reverse proxy, port forward, container publish, or SSH `-L` that terminates remote traffic and relays it to `127.0.0.1:<port>` presents a loopback peer, satisfying the first authorization check, and then forwards whatever `Tailscale-User-Login` the remote caller chose. Tailscale Serve is safe here only because it overwrites caller-supplied identity headers; nothing else in this design does. See [`SECURITY.md`](SECURITY.md) §4 and [#74](https://github.com/alphastorm/omp-session-gateway/issues/74). |
| Existing OMP encrypted relay | Required v1 relay path | Real desktop View/Control/interrupt passed. The signed `v0.1.0-prealpha.2` recovery soak remained live for 28,800 seconds through eight relay-room transitions with no restart, `finalPhase: "live"`, and gateway RSS moving from 45,776 KiB to 46,496 KiB (+720 KiB, approximately 1.6%). A protected replacement completed another 28,800-second authored window on 2026-08-21 with 22 transitions, `finalPhase: "live"`, exit code 0, and no restart; that harness records no memory metrics. Physical Android qualification closed on 2026-08-21 for the one advertised client, with network-change and reconnect stated as a known limitation ([#65](https://github.com/alphastorm/omp-session-gateway/issues/65)); relay availability and traffic metadata are inherited dependencies. |
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
