# Compatibility and support policy

## Current claim

**Current release:** qualified beta v0.1.0-beta.1; not stable or production-qualified.<br>
**Stable target:** v0.1.0; its signed successor candidate has not yet completed qualification.<br>
**Rollback predecessor:** qualified beta v0.1.0-beta.1 for the stable target.<br>
**Qualification predecessor:** signed beta candidate v0.1.0-prealpha.20.<br>
**Advertised combinations:** Debian 13 (trixie) x86-64 and macOS 26.6.1 arm64 hosts, with Chrome
151.0.7922.171 on Android 17 (Pixel 10 Pro). Nothing else is advertised.

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

The current beta support claim comes from exact signed-candidate evidence, not row counts. Stable
promotion must repeat every applicable candidate-bound lane rather than inheriting the label:

- Debian [gateway run `32530180990`](https://github.com/alphastorm/omp-session-gateway/actions/runs/32530180990)
  passed the complete candidate lifecycle with `107/107` rollback invariants and both lingering
  states; [OMP run `32537603211`](https://github.com/alphastorm/omp-session-gateway/actions/runs/32537603211)
  then built exact patched OMP, published View/Control, validated no-store launches, revoked, and
  removed every droplet/tailnet/key/OMP resource.
- macOS 26.6.1 arm64 independently verified the candidate, passed `doctor` 17/17, rotation,
  distinct-node identity/exposure, control-plane reboot with unchanged token and automatic
  LaunchAgent return, exact patched-OMP build/publication, and uninstall/cleanup.
- the physical Pixel passed exact candidate discovery, View read-only, Control composer/send,
  stale-generation denial, lock/resume, and the self-verifying seven-sink capability sweep. Issue
  #65 reproduced and recovered after Chrome force-stop, so the limitation remains explicit.
- a 300-second beta relay smoke finished live with two transitions. The protected 28,800-second
  evidence transfers because the relay host/client implementation, collab-web, and wire bytes are
  identical across the two exact patched OMP trees; only package metadata and an out-of-path
  session-close ordering changed.
- Windows source/lifecycle checks passed, but Windows remains unadvertised and is outside beta and the stable target.

Known limits remain part of the claim. Chrome for Android can wedge its process-wide network state
after an abrupt transition while Android remains healthy. The PWA retries and, after 45 uninterrupted
seconds of visible failure, opens force-stop/reopen help already carried by the loaded shell; it
does not claim to repair Chrome
([#65](https://github.com/alphastorm/omp-session-gateway/issues/65)). Preview detail currently falls
back to Session detail. Background Web Push remains outside the stable core claim. Portal Tunnel,
self-hosted/proxied relays, Funnel, userspace networking, shared mutually untrusted local accounts,
and every unnamed platform/browser/version remain unsupported.

A signed artifact proves origin, not fitness. Candidate history for this point release is explicit:

| Candidate | Build | Disposition | Verification |
|---|---|---|---|
| `v0.1.0-prealpha.18` | `0.1.0-3a9bb1cccc6e` | **Failed qualification; retained as evidence.** Repeated explicit rollback reached systemd's start-rate limit and repair could not restart. | Six signed/attested assets verified; macOS/Pixel/relay sublanes passed; Debian full lane failed at W2. |
| `v0.1.0-prealpha.19` | `0.1.0-28d89a99565d` | **Qualified replacement.** Clears the systemd start-rate counter only before an explicit operator-requested install/rollback start. | Archive SHA-256 `f6e01c4b96b5630fccbb3c79f0a0dae1677e316990d869db6e300ce96605a762`; checksums, three GitHub attestations, and three Cosign bundles verified; exact Debian/macOS/Pixel evidence above. |
| `v0.1.0-prealpha.20` | `0.1.0-848c968923f1` | **Qualified and promoted to `v0.1.0-beta.1`.** Uses the accepted exact v17.4.1 patch route; upstreaming and paired packaging are not gates. | Archive SHA-256 `ba789f7a7f6799a53dab205e26cf6f3ebbaa39c2e26655315c1a809075b09ed2`; checksums, signed tag, all attestations/Cosign bundles, byte-identical rebuild, Debian/macOS/Pixel lanes, exact Linux/macOS patched-OMP operation, and bounded beta relay smoke passed. |

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
| 0.1.0, stable target v0.1.0 | can1357/oh-my-pi@9350b7990d26ebf69a604edc82d8558ef04adf30 | v17.4.1 | coding-agent 17.4.1; wire 17.4.1 | collab-web 16.3.6 from the same source commit | 1 | Pending exact signed-candidate qualification; same versioned patched-binary prerequisite as beta |

v17.3.8 remains the immutable alpha baseline. v17.4.1 is independently qualified for beta through
the exact patch/tree and versioned executable route and is the unchanged stable target. No other
OMP release, commit, fork, or loose semver range is supported.

**Pin refreshed 2026-08-21, from `v17.3.8` to `v17.4.1`.** The maintained
`gateway-collaboration` series already targeted the new exact base. The carried health-probe commit
applied cleanly, and the v17.4.1 QR-command fixture was adapted to exercise manual publication
recovery. Upstream collab-web, wire, and relay host/client implementation bytes are unchanged;
package metadata and the out-of-path session-close ordering changed. Earlier platform evidence did
not transfer automatically: candidate `.20` repeated the signed gateway, macOS, Pixel, and bounded
relay lanes, then exact patched-OMP builds/publication/revocation passed independently on advertised
macOS and Debian. The command-complete `omp-gateway-patched` route is therefore the qualified beta
prerequisite; upstreaming and paired OMP packaging remain non-gates.

**Pin refreshed 2026-08-19, from `v17.0.6` / `89d6a8f6d14286f32f09ec9c8aa8af7b3451d2d6`.** The
previous mbox did not apply at this commit (`interactive-mode.ts`, `agent-session.ts`,
`session-manager.ts`, and `builtin-registry.ts` all conflicted), so the shipped patch was
regenerated against `v17.3.8`. The refresh itself carried source-level evidence only: it re-ran the
documented patch suite and the repository suite, and it re-ran no native host, Tailscale, relay,
Android, browser, or signed-artifact qualification. Any platform row whose evidence predates
2026-08-19 is therefore **NOT RUN** for this pin until re-executed, and an unchanged row is never
coverage of `v17.3.8`.

Re-execution is current at the beta candidate. On 2026-08-21, `v0.1.0-prealpha.20` passed the
complete Debian signed-artifact lifecycle and all `107/107` rollback invariants; the complete macOS
install/rotation/identity/control-plane-reboot/uninstall sequence; exact v17.4.1 patched-OMP
build/publication/revocation; and physical Pixel capability-isolation/View/Control/lock-resume
checks. The alpha BFCache and interrupt results transfer only because the relevant client and wire
bytes are unchanged. A fresh 300-second relay smoke finished live; the protected 28,800-second
long-window result transfers on the same byte identity. Android network-change/reconnect remains
unproven under [#65](https://github.com/alphastorm/omp-session-gateway/issues/65).

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
26.6.1 arm64, and Chrome 151 on the Android 17 Pixel have exact beta-candidate qualification.
Earlier rows remain as historical evidence, not substitutes for that candidate result. Windows now
passes persistent source acceptance through reboot→interactive-login and the complete gateway/OMP
path, but remains unadvertised until exact signed gateway and patched-OMP Windows artifacts repeat
it. This Windows-only gap does not block the narrower beta matrix. Desktop Chromium is smoke only.

| Platform | Implemented path | Recorded evidence | Qualification | Support claim |
|---|---|---|---|---|
| Linux host | User-only Unix-domain socket; systemd user service | Exact signed candidate `v0.1.0-prealpha.20` completed Debian 13 trixie x86-64 install/readiness, permissions, rotation, diagnostics, alpha.1 migration/rollback, `107/107` rollback invariants, identity denial, lingering-off/on reboot behavior, refusal-safe uninstall, and teardown in [run `32530180990`](https://github.com/alphastorm/omp-session-gateway/actions/runs/32530180990). A second clean `s-2vcpu-4gb` droplet applied exact OMP v17.4.1, reproduced tree `a5cfc80f…`, passed the full source check, built Linux binary `sha256:193b2b8088e78cf61d9bbf28661f3a8c971463cb008fc8d37e1d27eee63c95d3`, auto-published one generation-1 View/Control session, returned no-store View and Control launches without persisting capabilities, revoked immediately on process close, removed the OMP source/binary/config, uninstalled the gateway, and deleted the droplet, tailnet node, and ephemeral key in [run `32537603211`](https://github.com/alphastorm/omp-session-gateway/actions/runs/32537603211). | **PASS** for exactly Debian 13 trixie x86-64 with systemd 257, the signed gateway, TUN-mode Tailscale Serve, and the exact versioned patched-OMP route. No bare-metal, other distribution/init, or architecture claim. | **Supported in `v0.1.0-beta.1` for Debian 13 (trixie) x86-64 only.** |
| macOS host | User-only Unix-domain socket; LaunchAgent | Exact signed candidate `v0.1.0-prealpha.20` on macOS 26.6.1 arm64 (`Mac14,3`) passed artifact verification, private install, loopback-only readiness, `doctor` 17/17, rotation, distinct-node identity/exposure, control-plane reboot with LaunchAgent return and token continuity, exact v17.4.1 patched-OMP build/publication/revocation, and clean uninstall/Serve/source cleanup. A separate fail-closed isolated lane installed signed `v0.1.0-alpha.1`, upgraded to candidate `.20`, restored alpha.1, preserved config/token content and mode without printing fingerprints, left the live LaunchAgent untouched, and passed **20/20** invariants. Exact patched alpha/beta source builds also passed isolated `alpha → beta → alpha` symlink, version, and config assertions; this is manual OMP recovery, not paired packaging. | **PASS** for exactly macOS 26.6.1 arm64 with the signed gateway, TUN-mode Tailscale Serve, and the exact versioned patched-OMP route. Gateway rollback-by-reinstall is qualified; paired gateway/OMP rollback remains manual and must restore matching exact versions before sessions restart. | **Supported in `v0.1.0-beta.1` for macOS 26.6.1 arm64 only.** |
| Windows host | Current-user named pipe and Scheduled Task with `LogonTrigger` + `InteractiveToken`; paired OMP publisher uses nonce-bound mutual HMAC before releasing capabilities | Hosted run `29791906104` passed publisher mutual authentication, ACLs, cross-user denial, service lifecycle, rotation, and uninstall. A persistent Windows Server 2025 source lane on 2026-08-21 then passed exact-source install in 77,498 ms, reboot with task installed but no pre-login listener, automatic first-RDP-login startup without `/Run`, config/token continuity, rotation, active upgrade, history-selected rollback, TUN-mode Serve, `doctor` 17/17, and clean uninstall. Exact patched OMP `v17.4.1` built on the host, auto-published View and Control, returned `200 no-store` launches, denied a mismatched generation `409`, and revoked within 374 ms after forced exit. | **PARTIAL for release.** The persistent source lane accepts #90 and the reboot/login contract, but its gateway archive and OMP binary were unsigned. A Windows-only hang in the complete `read-only.test.ts` fixture also remains to be dispositioned; the publisher suite passed 13/13 and production publication/revocation passed. Repeat the entire lane with paired signed artifacts. | None; Windows remains unadvertised. If later promoted, the promise is “starts at interactive login,” not unattended boot. |
| Android client | Installable HTTPS PWA through Tailscale Serve | On a physical Pixel 10 Pro running Android 17 and Chrome `151.0.7922.171`, exact candidate `.20` passed metadata discovery, generation-bound View/Control authorization, read-only View, enabled Control and send acceptance, stale generation `409`, unknown session `404`, no-store launch, lock/resume in 5,190 ms, and a self-verifying seven-sink capability sweep with the real capability absent from storage, cookies, caches, history/address state, resource timings, and DOM. The same run reproduced [#65](https://github.com/alphastorm/omp-session-gateway/issues/65): device reachability returned while Chrome remained wedged through the bounded radio/Doze windows; force-stopping Chrome restored a clean sweep. | **PASS** for the advertised directory/View/Control/lock-resume/capability-isolation surface. Abrupt network-change/reconnect and background Web Push are explicitly unqualified. | **Supported in `v0.1.0-beta.1` for Chrome `151.0.7922.171` on Android 17 (Pixel 10 Pro) only, with #65 and Push exclusions.** |
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
| Existing OMP encrypted relay | Required v1 relay path | Real View/Control/interrupt passed. Exact beta candidate `.20` completed a fresh 300-second default-relay smoke with two transitions and final phase live. A protected 28,800-second run completed 22 transitions with no restart; it transfers because the relay host/client implementation, collab-web, and wire bytes are identical across the exact alpha/beta patched trees. The v17.4.1 session-close ordering change is outside the sustained relay path. Relay availability and traffic metadata remain inherited dependencies. |
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
