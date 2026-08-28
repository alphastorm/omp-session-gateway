# Changelog

All notable project changes will be documented here.

The format is based on Keep a Changelog and Semantic Versioning.

## [Unreleased]

### Changed

- Give working-session titles the full card width and move uptime, project, and model into one
  compact secondary row; show the useful model slug, remove wasteful flex gaps, strengthen title
  contrast, and replace the ambiguous × with a quiet 44px `Hide` action.
- Compress the all-clear state into the same left-aligned information grid as the directory,
  removing repeated live/working counts while preserving honest alert state.

### Fixed

- Report the true product version from managed installations and diagnostics: the published
  v0.2.0 archive still names its version directories, `status` output, and doctor bundles
  `0.1.0-<content-hash>` because two runtime constants sat outside the release version sweep.
  Install and rollback identity bind to the content hash and source commit, so behavior was
  unaffected; a version-coherence test now fails `bun run check` when any constant lags
  `package.json`.
- Prevent long session titles from colliding with Control and connection state in the mobile
  collaboration shell by giving the title its own full-width header row.
- Derive draft and published release asset names from the validated tag version; the first 0.2.1
  candidate failed closed after signing when draft validation still looked for 0.2.0 filenames.

## [v0.2.0] — 2026-08-28

### Added

- Restyle the couch-flow directory for phone-first triage: full-width session titles with a
  compact per-row **Dismiss here** control, sentence-case ask previews with option counts, a
  labeled **Requeue** control on held rows, a calm borderless **All clear** statement, and a real
  empty state when no session is live.
- Move background-alert control, notification detail, and build identity into one Settings bottom
  sheet behind a persistent masthead control; the seven exact alert states are unchanged, the
  toggle disables in place, and the resting screen claims "You'll get pinged" only while alerts
  are enabled.
- Precache the pinned collaboration client with the application shell, preload it from the
  document, and warm its module import while the directory idles, so View/Control taps pay only
  for the no-store launch request and relay connect; capabilities are still fetched only on tap.
- Render long transcripts incrementally in the embedded client: the initial snapshot defers to one
  loading placeholder until it completes, and the transcript windows to the newest entries with a
  **Show earlier** control instead of building the full history DOM at connect.
- Add device-local couch triage to the PWA: exact-ask **Hold for desk** preserves authoritative
  attention while advancing to the next request, and reversible **Dismiss here** hides a
  non-attention row on one device without stopping OMP.
- Add a fail-closed stable release policy: only the exact bare v0.1.0 tag selects the stable
  archive claim and GitHub Latest publication; every engineering, alpha, and beta tag remains a
  prerelease, and unknown or cross-version shapes fail before artifact creation.
- Require a signed-tag-bound stable qualification manifest plus a GitHub-verified annotated tag
  before stable publication; recheck checkout HEAD and tag target before provenance, draft creation,
  and public promotion. Move future signatures to signed-release.yml so the superseded historical
  tag workflow can be disabled.
- Retire historical GitHub workflow ID 316404456 with state deleted and activate hardened
  signed-release.yml as workflow ID 339848215, preventing old commits from selecting
  pre-remediation tag logic.
- Rehearse the exact six-asset GitHub draft/publish commands with gh 2.97.0 in a private repository:
  prerelease remained not-Latest, stable became non-prerelease Latest only when published, the
  latest-release API resolved to stable, and all synthetic releases/tags were removed.
- Validate draft and published release state through the GitHub API, including uploaded asset
  digests and Latest status; on a failed post-publication check, delete the release. A private live
  rehearsal verified draft, publication, deletion compensation, tag cleanup, and no residual release.
- Compare every GitHub asset digest to the exact locally signed file, retry draft/published state
  observation on bounded 0/2/4/8-second delays, and delete either a failed draft or an unverified
  public release. Move macOS sudo and Linux GitHub credentials from SSH argv/environment prefixes
  to a NUL-framed stdin bootstrap.
- Make physical Android acceptance browser-selectable and record the exact package, installed
  package version, Browser.getVersion revision, activity, and DevTools socket in evidence.
- Add prolonged-outage recovery guidance in a help panel carried by the loaded PWA shell. The PWA
  keeps its bounded retry path, suggests force-stop/reopen only after 45 uninterrupted seconds of
  visible failure, removes the guidance on recovery, and makes no third-party probe.
- Add a bounded post-release smoke command that verifies published stable provenance, upgrades or
  verifies the configured local Mac without changing config/token or unrelated Serve mappings,
  exercises exact patched OMP through an owned tmux fixture, and drives physical Android
  View/Control, forbidden-sink, same-page recovery, and installed-WebAPK checks before scoped cleanup.

### Changed

- Remove the completed implementation-handoff packet and consolidate its remaining contributor,
  attribution, backlog, and release guidance into maintained documents.
- Define stable 0.1 as support for the exact qualified Debian/macOS/Pixel/Tailscale/OMP matrix,
  not unnamed platforms or a promise that JavaScript can repair Chrome's process-wide network
  wedge. Windows, background Push qualification, Portal Tunnel, userspace networking, alternate
  relays, and paired OMP packaging remain explicitly outside this release.

### Fixed

- Keep Android Chrome's native EventSource reconnection alive after transport errors while retaining
  the bounded snapshot fallback, so a lost JavaScript timer cannot strand a long-lived PWA after
  Airplane mode or Doze. Physical qualification now reads rendered state without competing fetches
  and fails on any page reload.
- Make browser recovery failure tests wait for and assert an active replacement SSE stream before
  disconnecting it, eliminating a race where the snapshot hid the banner just before EventSource
  installation and the fixture's disconnect became a silent no-op.
- Let Android network recovery snapshots run for 20 seconds once a directory is loaded, and back
  repeated failures off with equal jitter to a 30-second ceiling instead of aborting and retrying
  every four seconds. This prevents reconnect churn from keeping a long-lived Chrome tab wedged
  after the phone's tailnet route returns.
- Harden stable qualification with durable Debian dispatch identity, same-commit receipts, restart-safe
  Mac cleanup, NUL-framed sudo transport, exact candidate/native-byte pins, workstation-staged rollback
  assets, bounded session paths, generic persisted failures, and zero-listener teardown evidence.
- Treat a ready Android directory with the owned target plus unrelated live sessions as recovered,
  and require disposable-target eligibility in the standalone capability leak sweep. The prior
  exactly-one-row probe falsely failed local post-release smoke while preserving unrelated sessions.
- Let the macOS patched-OMP helper consume an explicit pinned Bun executable and private build/native
  staging paths, so release smoke does not need to replace the user's global Bun runtime.
- Refuse a missing, unauthorized, or ambiguous adb device before post-release download, host
  mutation, or fixture startup instead of failing after an otherwise valid release setup.

## [v0.1.0-beta.1] — 2026-08-21

### Added

- Add deterministic, provenance-bound README media capture and verification, canonical mobile
  screenshots/GIF/MP4/product-flow assets, a product-first public README, a source-verified
  alternatives matrix, and draft launch copy. All public media uses seeded synthetic data.
- Record the protected default-relay replacement soak: the complete 28,800-second authored window,
  22 room transitions, final phase `live`, exit code 0, and no process restart.
- Add a fail-closed `beta` release channel. The release workflow accepts `v<version>-beta[.<n>]` and
  derives `OMP_RELEASE_CHANNEL=beta` only from that validated tag shape; `release-info.json` records
  a beta qualification that names the combinations recorded at the source commit and the exact
  patched OMP baseline while explicitly disclaiming stable or production readiness; and the
  conservative beta draft notes keep the Windows-unadvertised, Android network-change, and
  unsupported self-hosted/proxied relay caveats alongside the required exact OMP patch.
  `release-candidate` and stable tags stay rejected, pre-alpha and alpha archives stay
  byte-compatible, and the SBOM stays channel-independent.
- Qualify the exact signed beta candidate on Debian 13 x86-64, macOS 26.6.1 arm64, and Chrome
  151 / Android 17 on a physical Pixel 10 Pro; verify checksums, attestations, Cosign bundles,
  byte-identical rebuild, gateway lifecycle/capability isolation, exact patched-OMP source builds
  and real publication on both host architectures, alpha.1 gateway rollback-by-reinstall on Debian
  and macOS, manual exact-OMP symlink/config reversal, and a fresh default-relay smoke. Android
  radio recovery and background Push, Windows, Portal Tunnel, and self-hosted/proxied relays remain
  explicitly unadvertised.

### Changed

- Move the beta OMP baseline to exact `v17.4.1` /
  `9350b7990d26ebf69a604edc82d8558ef04adf30`, update `@oh-my-pi/pi-wire` to `17.4.1`, and
  regenerate the six-commit collaboration patch from the maintained downstream series plus the
  carried health-probe commit. The qualified route reproduced its patch tree, passed source checks,
  built a versioned binary, auto-published View/Control, and revoked on stop.
- Keep the exact tested v17.4.1 OMP patch as the beta installation prerequisite. Paired OMP
  signing/install/update/rollback stays deliberately deferred and is a disclosed limitation rather
  than a beta gate; stock OMP is never sufficient on its own. Published alphas remain immutable at
  their recorded v17.3.8 patch.

### Fixed

- Preserve OMP's immediate `Closing session…` status and arm its bounded slow-close timer before
  collaboration teardown; the v17.4.1 upstream regression test exposed the ordering defect during
  the patch rebase.
- Bind `release-info.json` qualification to the workflow-validated release channel, so alpha tags
  no longer ship the pre-alpha claim and unknown future channels fail before producing artifacts.
- Make pre-release candidate notes channel-neutral and bind them to the current OMP patch,
  advertised beta lanes, limitations, and `v0.1.0-alpha.1` rollback predecessor instead of the
  already-published alpha-point plan.
- Make the documented OMP binary route work on a fresh host without ambient Git identity or
  Rust/Cargo by supplying a scoped synthetic committer identity and staging the exact official
  `@oh-my-pi/pi-natives@17.4.1` platform addon before the upstream binary build; retain `bun setup`
  as the source-development alternative.
- Give Windows managed-service startup a measured 60-second hard readiness deadline while
  retaining 15 seconds elsewhere, so cold per-path ACL verification no longer rolls back a
  progressing service before it can bind. A persistent Server 2025 source lane now passes install,
  reboot→interactive-login startup, `doctor` 17/17, rotation, upgrade/rollback, patched OMP
  publication, and uninstall; Windows remains unadvertised until signed gateway/OMP artifacts
  repeat it.
- Reconcile every current beta support surface with candidate `.20`: replace stale alpha-era
  detailed matrix rows, narrow Push and Android outage promises, require exact Bun 1.3.14 for the
  qualified source route, name Portal Tunnel as unsupported, make gateway/OMP rollback separation
  explicit, scrub live identity/token/capability fingerprints from public evidence, and make the
  published-build verification recipe target `v0.1.0-beta.1` instead of a historical provenance
  test tag.

## [v0.1.0-alpha.1] — 2026-08-21

### Fixed

- Admit SSE consumers through an atomic registry snapshot/subscription handshake, serialize
  reentrant registry mutations, and isolate observer failures, so healthy consumers receive one
  snapshot followed by every later revision in strictly increasing order.
- Preserve a renewed Web Push subscription when an older in-flight delivery for the same endpoint
  fails permanently; stale cleanup now removes only the exact failed transport target.
- Return a collaboration page restored from the browser back/forward cache to the live session
  directory after its capability-bearing client has been disposed, rather than leaving an inert
  client shell or attempting to reuse the capability.
- Refuse install, stop, and uninstall before touching files or service-manager state when either a
  loaded manager identity or an unloaded definition belongs to another gateway installation root;
  an unavailable ownership probe now fails closed.
- Scope launch rate windows to the authenticated identity and operation instead of caller-selected
  instance IDs, preventing one allowed identity from exhausting bucket capacity for another.
- Clear systemd's start-rate counter before an explicit install or rollback restart, so several
  successful version switches cannot deadlock the next operator-requested recovery.

### Testing

- Cover identity-isolated launch rate windows, declared and streamed request-body ceilings,
  identity-scoped push deletion, reentrant registry ordering and observer failure, push-renewal
  races, file-only and manager-loaded service ownership, and capability-safe back/forward-cache
  restoration.

### Documentation

- Align the release and rollback guides with the published `v0.1.0-alpha` tag contract and the
  implemented `omp-gateway rollback [--to <version>]` command.

## [v0.1.0-alpha] — 2026-08-21

First advertised release. Qualified for Debian 13 (trixie) x86-64 and macOS 26.6.1 arm64 as hosts,
with Chrome `151.0.7922.139` on Android 17 as the client, and for nothing else. Both hosts were
qualified from a signed candidate whose executable surface is byte-identical to this release: all 46
files match, and the only differences are `sourceCommit`/`sourceCreated` in `release-info.json` and
the same commit and timestamp inside `SBOM.spdx.json`.

Requires Tailscale's **TUN-mode** client; the daemon refuses identity headers otherwise. Never enable
Tailscale Funnel. Android network-change recovery is a known limitation, Windows is implemented but
not advertised, and self-hosted or proxied relay modes remain unsupported.

### Added

- **Alpha decision is GO** for two host platforms and one client, against candidate
  `v0.1.0-prealpha.17`: Debian 13 (trixie) x86-64 and macOS 26.6.1 arm64 as hosts, with Chrome
  `151.0.7922.139` on Android 17 as the client. All six release blockers are closed. Nothing outside
  that combination is advertised, and the scope rule is unchanged: passing a platform permits
  advertising only that exact platform and version.
- Coverage reporting through Codecov, with the runtime's limits recorded in `codecov.yml` rather than
  left for a badge reader to misread: Bun emits **no** branch records at all and no per-function
  attribution, and it omits modules no test imports. `scripts/module-import-sweep.test.ts` imports
  every server-side module so an untested file becomes a visible row instead of an absent one, and it
  doubles as a smoke test for import-time side effects — which is how it found that
  `synthetic-publisher.ts` published sessions into a live gateway merely by being imported.
- `apps/gateway/test/security-mutations.test.ts` weakens seven named security guards in a copy of the
  tree and requires a specific named test to fail, so the suite demonstrates that its assertions
  discriminate rather than only that lines executed. A `find` pattern that stops matching is a
  failure rather than a skip, because a silently inapplicable mutation is worse than none.
- `runDoctorChecks` takes an injectable topology probe, closing a wiring gap an earlier commit
  recorded as unprotected in its own message.
- `doctor` now withholds `listenerLoopbackOnly` when tailscaled owns no TUN device. A loopback bind
  address is necessary but not sufficient, because userspace-networking `tailscaled` forwards inbound
  tailnet connections to localhost and the caller then arrives as a loopback peer that `auth.ts`
  trusts ([#98](https://github.com/alphastorm/omp-session-gateway/issues/98)).
- A scheduled capacity workflow and an evidence checker that compares machine-readable qualification
  records against the ledger, so a claim that contradicts its own measurement fails mechanically
  rather than relying on someone rereading a log.
- `omp-gateway rollback` is qualified on Linux, and a Linux lane now exercises the command itself
  rather than only rollback-by-reinstall.

### Security

- **The daemon now refuses to believe `Tailscale-User-Login` unless Tailscale's tunnel device is
  present.** `tailscaled --tun=userspace-networking` has no TUN device, so its netstack forwards
  inbound tailnet connections to localhost; a listener bound strictly to `127.0.0.1` was therefore
  reachable from the whole tailnet, and the caller arrived as a loopback peer whose forged identity
  header was trusted verbatim. Demonstrated against a real host, from a distinct tailnet node, on a
  build whose listener was correctly loopback-bound
  ([#98](https://github.com/alphastorm/omp-session-gateway/issues/98)).

  In `tailscale-serve` mode the gateway now reads the host's interface table and returns `403` to
  every request unless an interface carries an address in `fd7a:115c:a1e0::/48` or a
  `100.64.0.0/10` host route on a tunnel-named interface. `100.64.0.0/10` alone is not accepted: RFC
  6598 assigns it as shared space that carriers and container networks also use, so a CGNAT address
  on an ordinary interface proves nothing. `doctor` gains `loopbackTrustSound`, and an admitted SSE
  stream is re-authorized on each keepalive so a feed cannot outlive the topology that justified it.

  **This is a behaviour change.** A host running userspace-mode `tailscaled` now receives `403`
  instead of working; that configuration was never supported and is the vulnerable one.
  `auth.trustIdentityWithoutTailnetDevice` exists for loopback-only harnesses on machines with no
  Tailscale installed, logs `http.identity_trust_declared` whenever it is set, and cannot influence
  what `doctor` reports. Note that a config carrying that key will **not** load on an older gateway,
  which rejects unknown `auth` keys, so a host that sets it cannot roll back without editing config.

- `SECURITY.md` now names userspace-mode `tailscaled` as a forwarder that defeats loopback trust.
  This was previously implied by a general rule about tunnels and reverse proxies; it is now stated
  explicitly because it is the forwarder an operator is most likely to run, and because it was
  demonstrated as a working remote authentication bypass against a real host.

- Bumped `actions/attest-build-provenance` from v2.4.0 to v4.2.2, two majors on the action that
  produces release provenance. Validated by a tag run rather than a pull-request check, because
  `release.yml` executes only on tag pushes and a green check on the pull request would have proved
  nothing about the attestation path. `provenance-test-v0.1.0.11` published six assets whose
  checksums, three GitHub attestations and three Cosign bundles all verified independently from a
  clean directory, with a byte-identical rebuild from the exact tag.

### Known limitations

- Recovery after an abrupt radio transition on Android may require force-stopping Chrome.
  Chrome-for-Android wedges its own network stack browser-wide while the device remains healthy, so
  network-change and reconnect are not proven
  ([#65](https://github.com/alphastorm/omp-session-gateway/issues/65)).
- Windows is implemented and partly qualified but not advertised
  ([#90](https://github.com/alphastorm/omp-session-gateway/issues/90)).
- Self-hosted and proxied relay modes remain unsupported.

### Fixed

- Mirror the upstream fix for the silent publisher latch
  ([#61](https://github.com/alphastorm/omp-session-gateway/issues/61)) as the sixth commit of the
  OMP handoff patch. `CollabRegistryPublisher` latched publication off in one place and never reset
  it, and its setup `catch` treated every error that was not `ENOENT`/`ECONNREFUSED` as a security
  event, so a transient publisher-token read was indistinguishable from a real privacy violation.
  Because `CollabController` builds the publisher once behind `??=`, `/collab stop` then `/collab`
  reused the latched instance, and a live session stayed absent from the directory for the rest of
  the OMP process lifetime while the daemon reported healthy. Only a deterministic
  `PublisherSecurityViolation` now latches; everything else retries with backoff, a manual
  `/collab` resumes, and `/collab status` reports the publication state.

- Re-bind the registry socket when its path disappears underneath the daemon. macOS reaps idle
  per-user `TMPDIR` entries, which deleted `registry.sock` and its parent directory while Bun kept
  listening on the unlinked inode, so every OMP publisher failed to connect with `ENOENT` and no
  session could ever appear. The daemon now records the bound device/inode, re-checks the path every
  15 seconds, and recreates the private runtime directory and listener when the path is gone. A path
  owned by a different inode is reported as unhealthy instead of being clobbered.
- Report `status: "degraded"` from `GET /api/v1/health` when publishers cannot reach the registry
  endpoint. Readiness previously proved only that the HTTP listener answered, so a daemon that no
  publisher could reach still passed `status`, `doctor`, and install readiness checks.

### Changed

- Refresh the OMP pin from `v17.0.6` / `89d6a8f6d14286f32f09ec9c8aa8af7b3451d2d6` to `v17.3.8` /
  `858f7dd91fff9b84cf8a2c6a6bb85aa0e6d03a55`. The previous mbox no longer applied
  (`interactive-mode.ts`, `agent-session.ts`, `session-manager.ts`, and `builtin-registry.ts`
  conflicted), so it is regenerated as five commits reproducing tree
  `1320e3e7e7596dbe2f6a130d568072a9a38f2943`. The first four are the reviewed handoff artifact
  `gateway-collaboration-v17.3.8.mbox` (sha256 `f63f74c9…`) applied verbatim; the fifth restores the
  health-probe commit the maintained series no longer carries. `@oh-my-pi/pi-wire` moves to `17.3.8`; `collab-web`
  stays at package version `16.3.6` with refreshed source.
- Re-vendor the pinned collab client onto `v17.3.8`. Only `Composer.tsx` needed manual resolution
  (upstream added `RefObject` and composition handlers; the gateway had added `useMemo` and
  `disabled`); all eleven prior local patches survived unchanged. The client keeps npm `marked`
  rather than upstream's new `@oh-my-pi/pi-utils/marked`, because that import pulls
  `@oh-my-pi/pi-natives` and its per-platform binaries into a previously pure-JavaScript runtime
  closure. The `Marked` API is identical, so the divergence is one import line.
- Reset every native, Tailscale, relay, Android, browser, and signed-artifact ledger row to
  **NOT RUN** for the new pin. Only source-level evidence was regenerated; the previous pin's
  platform qualification does not transfer.

### Testing

- Scale the OMP publisher fixtures' per-test and handshake budgets by platform. Every Windows
  publisher-token fixture is secured, and the publisher's token ACL validated, by spawning
  `powershell.exe`; hosted runner images made that spawn cost seconds rather than milliseconds, so
  the file's first test — which pays two cold starts — exceeded the 5-second default and the
  2-second handshake budget while asserting security behavior that had not regressed. The patch is
  regenerated, so its five commit SHAs changed.
- Drive a virtual clock in the collab-client fake-timer harness. `CollabSocket` schedules its idle
  relay probe as `lastRelayActivityAt + RELAY_IDLE_PROBE_MS - Date.now()`, and `#commit()` runs
  between the two reads, so faking `setTimeout` while leaving `Date.now()` on the wall clock let
  real milliseconds shorten the delay to `9_99x`. The relay-probe test failed roughly one full-suite
  run in six. The clock now advances only when a fake timer fires; injecting 3 ms of real work into
  `#commit()` reproduced `9997` before the change and `10000` after.

## [0.1.0-prealpha.14] - 2026-07-26

### Added

- Measure the same-origin gateway path with adaptive probes and the encrypted browser-to-host relay
  path with optional idle ping/pong frames; ordinary host traffic provides passive relay liveness
  between explicit bidirectional probes.
- Keep submitted Ask actions in a disabled `Sending…` state until the host acknowledges
  `ui-request-end`, including idempotent resend and acknowledgement after relay reconnection.

### Changed

- Keep healthy collaboration chrome quiet as a green dot. Brief interruptions show only
  `Reconnecting…`; failures lasting three seconds identify the gateway or relay and show the next
  jittered retry, while recovery confirms `Connected` briefly.
- Replace fixed gateway polling and deterministic reconnects with RTT-adaptive timeouts,
  two-result hysteresis, passive liveness, hidden-page probe cancellation, bounded WebSocket
  handshakes, and capped full-jitter retry scheduling. Directory metadata cannot replace `Sending…`
  with `Answered` before host acknowledgement. The existing no-secret service worker remains
  deliberately unchanged; Workbox and Background Sync add no safe value to the capability-bearing
  live path.
- Stop collaboration path probing as soon as the client becomes terminal so the final action and
  keyboard focus remain stable. Standalone select responses now retain the chosen option and expose
  the same visible, polite `Sending…` acknowledgement state as the embedded PWA shell.

### Testing

- Exercise gateway hysteresis/timeouts, event-cancelled probes without false degradation, recovery
  without an `online` event, hidden-page relay cancellation, blackholed WebSocket handshakes,
  relay idle-probe failure, stale-pong rejection, full-jitter retry caps, delayed snapshot sync,
  response resend/acknowledgement, acknowledgement-gated answer feedback in embedded and standalone
  modes, terminal focus and probe shutdown, quiet accessible healthy chrome, keyboard triage
  dismissal, outage attribution changes, recovery confirmation, and unobscured `Sending…` feedback
  at both Android viewports.

## [0.1.0-prealpha.13] - 2026-07-26

### Fixed

- Match the approved Couch Flow 3d client body: remove the embedded client's competing header and
  agent rail, keep one transcript/composer, and render the active Ask as the native input card with
  numbered radio rows, explicit selection, recommendation badge, and green `Send` action.
- Complete all four shell triage states. Answer feedback remains dismissible; relay reconnection
  and clean session end now remain visible below the composer with exact copy, status markers, and
  the specified return action.
- Center the shell title independently of its left/right controls and keep every top-bar target,
  composer inset, and bottom safe-area boundary intact at both approved Android viewports.

### Security

- Keep the collaboration capability confined to the pinned client's in-memory bootstrap while the
  gateway shell receives lifecycle state only; no capability enters shell markup, URLs, history,
  storage, caches, or diagnostics.

### Testing

- Exercise embedded Ask selection/submission, recommendation ownership, transient relay recovery,
  clean ended-session feedback, absent duplicate chrome, and non-overlapping composer/triage
  geometry at 390×844 and 412×915.

## [0.1.0-prealpha.12] - 2026-07-26

### Fixed

- Implement the approved Couch Flow 3d shell as one fixed frame: gateway top bar, the untouched
  pinned collaboration client, and an answer-only bottom triage bar below the composer.
- Remove the embedded client's connecting window and ended-session popup; connection lifecycle is
  represented only by the shell's Connected, Reconnecting, or Offline chip.
- Show triage feedback only after the exact opened request resolves, then dismiss it after eight
  seconds, tap-out, or swipe without covering the composer or its safe-area inset.
- Route direct and historical `/client/` navigation back through the PWA directory and stop
  shipping the obsolete popup/MessageChannel bootstrap.

### Security

- Continue passing the launch capability directly into the pinned client mount in memory without
  adding it to shell state, DOM, URL, history, browser storage, or service-worker caches.

### Testing

- Exercise the exact three-child shell frame, single transcript/composer/interrupt controls,
  lifecycle-popup suppression, answer-only triage, composer geometry, Back restoration, and direct
  `/client/` recovery at both Android viewport sizes.

## [0.1.0-prealpha.11] - 2026-07-26

### Fixed

- Match the approved couch-flow resting screen exactly: remove the explanatory lede and footer,
  keep background-alert settings below the session directory, and restore all-clear state, list
  order, and scroll position immediately from route-safe history state.
- Drive the collaboration shell's Connected, Reconnecting, Offline, and ended states from the
  pinned client's lifecycle instead of rendered-text inspection; focus request Control on the
  pending composer and keep all four triage states outside its viewport.
- Complete answer feedback with exact next/all-clear copy, eight-second expiry, tap-out and swipe
  dismissal, and authoritative request-resolution gating.
- Use the exact phone, tailnet, desktop, and relay failure copy while preserving timestamped,
  authenticated session metadata through transient transport failures.

### Security

- Bind every request-specific Control launch to both generation and opaque request ID at the final
  capability lookup, closing the same-generation clear/re-arm race for home, shell, triage, and
  notification launches.

### Testing

- Exercise one through six asks, all-clear, every failure banner, exact shell lifecycle and triage,
  composer inset, request-bound Control, and cache-first Back behavior at 390×844 and 412×915.

## [0.1.0-prealpha.10] - 2026-07-26

### Added

- Complete the approved Couch Flow handoff with whole-screen waiting/all-clear modes, FIFO ask
  ordering, boolean fallback, whole-row session actions, exact collaboration-shell triage, and
  capability-free directory order/scroll restoration.
- Add per-device Private, Session, and Preview notification detail with a mobile bottom sheet,
  server-built payloads, exact-request clearing, one notification per session, app badge counts,
  and notification-to-Control request routing.

### Fixed

- Distinguish phone-offline, tailnet-unreachable, desktop-unreachable, and relay-reconnecting states
  while retaining the last authenticated directory with a freshness timestamp.
- Remove the prominent manual Refresh control; liveness detection, bounded reconnect, and PWA
  activation now own routine recovery.

### Security

- Derive opaque ask identities in gateway memory without changing the capability-bearing publisher
  contract; revalidate the exact ask and generation before every notification-launched Control.
- Keep collaboration capabilities out of push state and payloads, notification data, URLs, history,
  browser storage, caches, logs, and diagnostics while limiting optional visible detail to the
  level selected for each device.

## [0.1.0-prealpha.9] - 2026-07-26

### Fixed

- Show an accent `Recommended` badge on the explicitly recommended option while an Ask request is awaiting a remote Control response, including late joins, without treating OMP's default selection index as a recommendation.

## [0.1.0-prealpha.8] - 2026-07-25

### Added

- Replace the mixed session-card dashboard with the approved ask-first couch flow: a FIFO boolean-only attention queue, gold request hero, compact working rows, and an all-clear resting state.
- Wrap the pinned collaboration client in gateway chrome with Sessions navigation, View-to-Control upgrade, relay state, in-memory directory/scroll restoration, and authoritative answer/ended triage bars.

### Fixed

- Recover dashboard sessions automatically across half-open Wi-Fi/Tailscale transitions by closing silent SSE streams after 12 seconds, timing out snapshots after 4 seconds, and retrying on bounded 1/2/4-second backoff.
- Refresh an active collaboration relay transport after browser network changes or a failed-then-recovered 3-second same-origin health probe, without persisting or transmitting a collaboration capability.
- Activate changed PWA shells automatically without a manual Refresh: idle directories reload through a scrubbed no-store update route, while pending or active collaboration defers the new document until ordinary failure recovery, Back, or Leave.
- Run Playwright through a cross-platform Bun wrapper that clears the conflicting `NO_COLOR` value before worker startup when the harness forces color, removing Node's ignored-environment warning without suppressing other warnings.

### Security

- Keep the redesign on the existing metadata-only `inputRequired` contract: no prompt previews, request IDs, collaboration capabilities, URLs, storage, or service-worker payloads were added.

### Changed

- Record the user-reported physical Android `v0.1.0-prealpha.7` core background-Push flow as partial evidence while keeping exact-version lock-screen, force-stop, stale-generation, network-change, and forbidden-sink qualification open.

## [0.1.0-prealpha.7] - 2026-07-24

### Fixed

- Correct the release install/upgrade and rollback instructions to include the CLI's required `--origin` and `--allow` values. The signed `v0.1.0-prealpha.6` artifact remains valid, but its published install command was incomplete.

## [0.1.0-prealpha.6] - 2026-07-24

### Added

- Add explicitly enabled background Web Push using private persisted VAPID/subscription state, strict metadata-only attention/resolution payloads, duplicate collapse, resolution cleanup, and stale-endpoint pruning.
- Add one-tap notification-to-Control routing through a synchronously scrubbed metadata-only path, exact current-generation/attention validation, and the existing no-store in-memory capability launch.

### Security

- Keep prompt/session labels, paths, request data, transcript content, and collaboration capabilities out of push state, payloads, visible notification text, routes, history, service-worker messages, logs, and diagnostics.
- Treat browser push endpoints/keys and the VAPID private key as bounded user-only state; retain the session registry and collaboration capabilities in memory only.

### Changed

- Recorded the signed `v0.1.0-prealpha.2` recovery relay soak as passed after 28,800 seconds, eight room transitions, a live final phase, no restart, and a 720 KiB gateway RSS increase; physical Android relay qualification remains open.
- Recorded the corrected `v0.1.0-prealpha.4` physical trial on Pixel 10 Pro / Android 17 / Chrome 150: installed-PWA View/Control/Back, exactly-once retained response, attention clearing, metadata-only foreground and lock-screen notification, dashboard-only notification tap, lock/resume, network transition, relay reconnect, generation replacement with stale `409`, and TTL removal/republication passed. Distinct-device denial, deep browser-sink inspection, physical interrupt, remaining switch/branch/resume cases, and signed host release qualification remain deferred.
- Recorded the signed `v0.1.0-prealpha.5` physical Android three-process and silent-partition trial plus a 50-publisher capacity run: all three real OMP cards appeared automatically, Airplane mode cleared them by the 40-second observation after the configured 35-second deadline, and recovery restored exactly three, while 50 normal-cadence publishers averaged 0.125% of one CPU core and stayed below 63 MiB observed daemon RSS.

## [0.1.0-prealpha.5] - 2026-07-21

### Fixed

- Replace opaque SSE comment pings with metadata-free `keepalive` events and clear session cards after two missed heartbeats, so silent Android/Tailscale network partitions cannot leave stale sessions visible.
- Fetch a fresh authoritative snapshot when transport resumes; physical Android testing covered three real auto-published OMP sessions, Airplane-mode loss, bounded stale-state clearing, and automatic three-card recovery without Refresh.

## [0.1.0-prealpha.4] - 2026-07-21

### Fixed

- Mount the collaboration client in the installed PWA's current document so Android Chrome cannot discard the in-memory capability handoff by reusing a standalone window without `window.opener`.
- Preserve the separate same-origin `MessageChannel` bootstrap only as an ordinary-browser fallback, with Android-sized View/Control launch, back-navigation, URL, history, storage, cache, and no-popup regression coverage.

## [0.1.0-prealpha.3] - 2026-07-21
### Added

- Publish a strict metadata-only `inputRequired` boolean, surface attention-first session cards, and retain bounded host-origin response requests so a later Control guest can answer once while View remains read-only.
- Add explicitly enabled foreground browser notifications for authoritative false-to-true attention transitions; permission is never requested on load, state remains volatile, and notification taps return only to the dashboard.
- Add deterministic dashboard/service-worker tests and Android-sized Playwright coverage for attention ordering, stale-state clearing, notification dedupe, click routing, and forbidden-content canaries.

### Changed

- Pin the OMP integration and collab-web source to `can1357/oh-my-pi@89d6a8f6d14286f32f09ec9c8aa8af7b3451d2d6` (nearest release v17.0.6).
- Split the downstream OMP artifact into four reviewable commits covering controller/publisher integration, bounded pre-writer request retention, generation-scoped response-required publication, and collaboration-aware response UI/startup ordering.

### Security

- Keep prompt text, options, prefills, answers, request IDs/types/counts, and collaboration capabilities out of IPC metadata, list/SSE responses, DOM copy, notifications, service-worker messages, storage, caches, logs, diagnostics, screenshots, and traces.
- Authenticate Windows named-pipe servers with the same nonce-bound mutual HMAC handshake used on POSIX before the publisher sends any proof or capability-bearing frame.


## [0.1.0-prealpha.2] - 2026-07-21

### Fixed

- Recover established collaboration guests across transient relay room replacement with bounded exponential retries while keeping initial missing rooms and exhausted recovery terminal.

## [0.1.0-prealpha.1] - 2026-07-21

### Added

- Versioned protocol package with strict publisher, metadata, SSE, launch, and secret-separation validation.
- Authenticated local IPC registry, generation revocation, monotonic TTL expiry, publisher bounds, and privacy-safe logging.
- Loopback HTTP API with Tailscale identity allowlisting, exact-Origin launch protection, SSE, security headers, and no-store responses.
- Mobile PWA with live session states, explicit View/Control actions, safe back behavior, and shell-only service-worker caching.
- Pinned OMP collab-web source with direct in-memory one-time `MessageChannel` capability bootstrap.
- Apply-ready OMP `CollabController`, auto-start, local publisher, lifecycle revocation, and test patch.
- Cross-platform user-service definitions and management commands for install, uninstall, status, doctor, token rotation, and Serve guidance.
- Deterministic redacted diagnostics archives and Bun-runtime release archives with SPDX 2.3 dependency inventories and SHA-256 manifests.
- Keyless GitHub OIDC build attestations and Cosign signatures with immutable tag-triggered pre-alpha releases and documented verification.
- Unit/integration coverage for protocol, registry, IPC, HTTP authorization and launch, config permissions, services, diagnostics, and capability leaks.
- Explicit compatibility/support matrices and a release-status gate ledger separating implemented, smoke-tested, qualified, and supported claims.
- Protected `main` with signed commits, pull-request/CI gates, immutable releases, dependency alerts, automated security updates, secret scanning, and push protection.
- Loopback-only, no-store-enforcing default-relay soak harness with bounded duration and secret-free results.

### Changed

- Replaced handoff-only `bun run check` with TypeScript, browser/client build, full test, handoff, and capability-leak gates.
- Pinned the research baseline to OMP commit `39c95e5e29b1c8b082059f57421ce445c3dffdd4` (nearest release v17.0.5).
- Kept all platform and Android support entries unadvertised until real-device and cross-OS acceptance passes.
- Qualified the final source-review-hardened OMP patch in the complete pinned upstream checkout; checks and every official TypeScript test bucket passed with documented upstream-baseline exclusions restored afterward.
- Completed an eight-hour default-relay endurance run: the read-only client remained connected for 28,804 seconds and finished in the live phase.
- Published and independently verified the immutable provenance-test `provenance-test-v0.1.0.8` from the post-soak `main` commit, including deterministic archive/SBOM/checksum reproduction, GitHub build attestations, Cosign bundles, and immutable release-asset attestations.
- Published and independently verified immutable provenance-test `provenance-test-v0.1.0.9` from protected `main`, including the mutual-authentication and reconnect hardening, current hosted Windows qualification, byte-identical exact-tag archive/SBOM/checksum reproduction, GitHub build attestations, Cosign bundles, and a signed-artifact macOS packaging/runtime smoke through Tailscale Serve; native lifecycle and physical Android gates remain open.
- Published and independently verified corrected immutable provenance-test `provenance-test-v0.1.0.10` from protected `main`, including host-suspension reconnect recovery, current hosted Windows qualification, byte-identical exact-tag archive/SBOM/checksum reproduction, GitHub build attestations, Cosign bundles, and signed-artifact macOS Serve, restart, patched-publisher, and finite-suspension smoke; native lifecycle and physical Android gates remain open.
- Documented the distinct product boundaries and best-fit workflows for OMP Session Gateway and `omp-deck` without presenting either as a universal replacement.
- Adopted the dark-first Gate visual identity across the PWA and repository, including installable platform icons, accessible View/Control hierarchy, branded social artwork, and a normative brand specification.

- Made production install a config/service/runtime transaction with prior-endpoint checks, instance-bound HMAC readiness, verified legacy-runtime rollback, exact external Serve-port guidance, and recovery uninstall that does not require a readable application config.

### Fixed

- Kept Bun's HTTP idle timeout above the SSE keepalive interval so live updates do not cycle through reconnect state.
- Close authenticated publisher sockets without a protocol-error payload after idle expiry or missing heartbeat state so the existing bounded reconnect path republishes sessions after host suspension; isolated launchers can now select the publisher-token file without replacing child-tool XDG configuration.
- Refresh the active gateway card's bounded title, directory basename, and `provider/model` metadata after live OMP name, working-directory, or model changes without rotating its generation or capabilities.
- Redirect direct, reloaded, invalid, and BFCache-restored collaboration client documents to the secret-free session directory; discard stale reconnect sends and emit a fresh guest hello before current-generation frames.
- Force a fresh collab relay transport after mobile foreground and online transitions so suspended sockets cannot remain silently stale.
- Revoke the active OMP collaboration generation before session mutation, keep manual hosts stopped when auto-start is off, force explicit relay replacements, and revoke/re-publish same-relay View/Control mode changes.
- Harden Windows config and publisher-token paths with current-user/SYSTEM-only ACLs, write Task Scheduler XML as UTF-16, run Bun directly, and wait for exact task termination during reinstall and uninstall without exposing a loopback shutdown credential.
- Bound unauthenticated IPC handshakes and authenticated publisher idleness so stalled local clients cannot exhaust publisher capacity; partial frames now use fixed-capacity buffers that are scrubbed on release.
- Made unsafe-permission test fixtures independent of the invoking shell's `umask`.
- Bound registry authentication, frame buffering, idle connections, publisher slots, private config/token reads, diagnostics command output, and launch-path decoding; verify POSIX publisher endpoint ownership; reject cross-connection instance replacement; and derive Windows pipe names from a normalized stable user identity.
- Authenticate both registry peers with fresh nonces and domain-separated HMAC proofs before capability release; never send the publisher key over IPC; reject replayed proofs and fake named-pipe servers; and enable the OMP publisher's current-user Windows named-pipe path with strict token ACL validation.
- Detect bare default-relay capabilities in leak scans and redact malformed collaboration capabilities from parser errors so they cannot enter logs or crash reports.
- Authenticate loopback startup/doctor readiness with a publisher-token HMAC challenge so another local account cannot satisfy install health checks by pre-binding the configured port.
- Stage immutable content-addressed gateway runtimes, verify their manifests and payload digests across version upgrades, idempotently reuse a verified payload during Windows reinstall, preserve the prior runtime for rollback, and retain the fresh publisher token while stopping the service if rotation restart fails.
- Ship `bun.lock`, its SHA-256, the embedded SPDX inventory, complete reviewed license texts, and the distributed OMP coding-agent patch component in deterministic release archives.
- Detect raw extensionless publisher-token files, percent-encoded legacy collaboration links, and contextual publisher-token JSON/file leaks in staged release payloads and CI leak gates.
- Reject unknown CLI options, missing values, and query-bearing API/static requests before mutation or cache admission; rate-limit repetitive denial/protocol logs; bound readiness response bodies; order PWA snapshots and SSE events by connection epoch and revision; clear stale metadata on transport loss; distinguish empty, unauthorized, offline, unavailable-action, and busy states; and arm the client handoff before capability fetch so an immediately ready collaboration window cannot race launch.
