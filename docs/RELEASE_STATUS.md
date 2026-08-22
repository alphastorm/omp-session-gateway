# Release status

**Updated:** 2026-08-22<br>
**Repository version:** `0.1.0`, released as **`v0.1.0-beta.1`**<br>
**Qualification predecessor:** **`v0.1.0-prealpha.20`**, independently verified<br>
**Classification:** qualified beta; not stable or production-qualified<br>
**Beta decision:** **GO, completed**, for the combinations named below and nothing else. The final
tag, six assets, checksums, attestations, Cosign bundles, immutable-release record, metadata, and
candidate/runtime-byte comparison are independently verified.

### Beta advertised combinations

| role | exact candidate combination | evidence |
| --- | --- | --- |
| host | Debian 13 (trixie) x86-64, systemd 257, kernel `6.12.94+deb13-amd64` | [gateway run `32530180990`](https://github.com/alphastorm/omp-session-gateway/actions/runs/32530180990): signed artifact, install/readiness, alpha.1 migration/rollback, `107/107` invariants, identity denial, lingering-off/on persistence, uninstall, and teardown. [OMP run `32537603211`](https://github.com/alphastorm/omp-session-gateway/actions/runs/32537603211): exact v17.4.1 source/tree, full checks, Linux binary build, generation-1 View/Control publication, no-store launches, immediate revocation, OMP cleanup, and complete droplet/tailnet/key teardown. |
| host | macOS 26.6.1 arm64 (`Mac14,3`) | candidate checksums/attestations/Cosign, private install, loopback-only listener, `doctor` 17/17, rotation, distinct-node identity/exposure, control-plane reboot/LaunchAgent return, exact patched-OMP build/publication/revocation, and cleanup. A separate alpha.1 → candidate `.20` → alpha.1 rollback-by-reinstall passed 20/20 isolated invariants without touching the live LaunchAgent; exact alpha/beta patched source builds passed manual symlink/version/config reversal. |
| client | Chrome `151.0.7922.171` on Android 17, Pixel 10 Pro | exact candidate discovery and launch authorization; View connected read-only, Control enabled the composer and accepted send, stale View/Control `409`, lock/resume in 5,190 ms, self-verifying 7/7 capability sweep clean before and after force-stop recovery. Abrupt network recovery and background Web Push are excluded. |

**Candidate provenance.** `v0.1.0-prealpha.20` records source
`cffd6bf697c2d3e4c5a5d235c6e58168f5db2eba`, exact OMP
`9350b7990d26ebf69a604edc82d8558ef04adf30`, patch tree
`a5cfc80fcc0df1ca6e430c125371bcae43d5e5f7`, and archive/SBOM/checksum-manifest
SHA-256 values `ba789f7a7f6799a53dab205e26cf6f3ebbaa39c2e26655315c1a809075b09ed2`,
`ab2ee850e8a3daeda6c6d77a9dcc77ab9c48c3c0cd225196943de05a27f9988f`, and
`f30fbc8b3a4c276eccd202fcff3765c8ad4d9575f3439c442bf2f443e3f42671`.
`SHA256SUMS`, all three GitHub attestations, all three Cosign bundles, and the signed tag verified;
a clean exact-tag rebuild reproduced all three files byte-for-byte.

**Final release provenance.** `v0.1.0-beta.1` records source
`678887a67e85b14c14afb008cf100391a56aa933`; archive/SBOM/checksum-manifest SHA-256 values are
`2d77c1b23c37d7ee524faa3afd100bcaddc03010a87192b6e313fbcefa0a63c6`,
`4012cd6c8e09d770469498785c58b3a4c1d86ec9a5b4b4944653f29ab4dbffeb`, and
`4e959b394396fea2a56c40dbb9ae8722e2d28ce6c8c4548328712b7620324fa3`. The signed tag resolves
to that source commit; release [run `32539462210`](https://github.com/alphastorm/omp-session-gateway/actions/runs/32539462210)
passed; `gh release verify`, `SHA256SUMS`, all three exact-tag GitHub attestations, and all three
exact-workflow Cosign bundles verified. Published `release-info.json` names the exact source,
v17.4.1 upstream commit, lock digest, and qualified-beta/not-stable boundary.

Candidate and final archives contain the same 48 files. **45 are byte-identical**, including every
runtime executable, gateway module, PWA/collab asset, protocol, dependency lock, license, OMP patch,
and integration metadata file. The only differences are expected and reviewed:
`release-info.json` changes source/timestamp/channel qualification; `SBOM.spdx.json` changes only
source-bound namespace/timestamp/sourceInfo; and `patches/oh-my-pi/README.md` carries the
fresh-host native-addon/Git-identity instructions, exact Linux evidence, and manual rollback prose
that candidate qualification itself proved.

The first post-tag hosted main run exposed a test-fixture race, not a release-byte failure: a
snapshot could hide the banner immediately before replacement EventSource installation, making a
disconnect injection a no-op. The exact scenario passed 10/10 after stream synchronization, the
complete browser suite passed 22/22, private JIT appliance run
[`32540339219`](https://github.com/alphastorm/omp-session-gateway/actions/runs/32540339219) passed,
and post-fix main run [`32540626681`](https://github.com/alphastorm/omp-session-gateway/actions/runs/32540626681)
is green. The fix changes tests only and does not alter the immutable beta artifact.

**Required OMP route.** Stock OMP is insufficient. On both advertised host architectures, the exact
v17.4.1 mbox applied to a pristine checkout, reproduced the pinned tree, passed source checks, and
built `omp-gateway-patched` using OMP's exact official native addon. The macOS build (SHA-256
`310ffd097c87752cbdf78d483e258c09a8450e123eed4e9df05fe9858a7de6b7`) and Linux build (SHA-256
`193b2b8088e78cf61d9bbf28661f3a8c971463cb008fc8d37e1d27eee63c95d3`) each reported
`omp/17.4.1`, auto-published generation-1 View/Control, returned no-store launches, and revoked on
process close. Upstreaming and paired packaging are not beta gates; using the versioned patched
executable is.

**Relay evidence.** The candidate completed a fresh 300-second default-relay smoke with two room
transitions, `finalPhase: "live"`, and exit 0. The protected 28,800-second result transfers because
the relay host/client implementation, collab-web, and wire bytes are identical in the exact alpha
and beta patched trees. The v17.4.1 session-close ordering change is outside the sustained path.

**Accepted limitations, not hidden passes.** The Pixel again reproduced issue #65: after Airplane
mode the device regained tailnet reachability at 29,109 ms while Chrome failed to recover through
the 521-second window, and the subsequent Doze leg also remained wedged. Force-stopping/restarting
Chrome restored a clean capability sweep. Network-change/reconnect therefore remains explicitly
unproven. Background Web Push is implemented but not beta-qualified. Windows, Portal Tunnel,
self-hosted/proxied relays, userspace-networking Tailscale, and every unnamed platform/browser
remain unadvertised.

Named local evidence:
`~/.local/share/omp-session-gateway/test/v0.1.0-prealpha.20/qualification/beta-candidate.json`.
Every candidate resource was cleaned: both Debian droplet/tailnet-node/SSH-key sets were deleted;
the macOS gateway, Serve mapping, patched OMP process/binary/source, and listener were removed; the
isolated rollback root was deleted without changing the live LaunchAgent; and Pixel radio/battery/
Doze state was restored.

## Published alpha baseline

**Alpha.1 decision:** **GO, completed**, for the historical combinations and evidence immediately
below. This section remains the immutable record for `v0.1.0-alpha.1`; it is not the beta claim.

**Advertised host platforms**

| host | exact-candidate evidence | candidate |
| --- | --- | --- |
| Debian 13 (trixie) x86-64, systemd 257, kernel `6.12.94+deb13-amd64` | [run `32502584598`](https://github.com/alphastorm/omp-session-gateway/actions/runs/32502584598): full default lane order, `107/107` rollback invariants, reboot persistence with and without lingering, identity denial, and clean uninstall | `v0.1.0-prealpha.19` |
| macOS 26.6.1 arm64 (`Mac14,3`, build `25G76`) | signed artifact install, `doctor` **17/17**, active token rotation, distinct-node identity/exposure checks, Scaleway control-plane reboot with token continuity, auto-login/LaunchAgent return, and clean uninstall | `v0.1.0-prealpha.19` |

**Advertised client:** Chrome `151.0.7922.171` on Android 17 (Pixel 10 Pro, build
`CP2A.260805.005`, SDK 37), exercised through the macOS candidate host.

**The replacement candidate is bound to exact bytes.** `v0.1.0-prealpha.19` records source commit
`e1b91763b4f0a0e963fc1394d8984ec13ed08d6b`, upstream
`858f7dd91fff9b84cf8a2c6a6bb85aa0e6d03a55`, build
`0.1.0-28d89a99565d`, and archive SHA-256
`f6e01c4b96b5630fccbb3c79f0a0dae1677e316990d869db6e300ce96605a762`. From a clean directory,
`SHA256SUMS` verified, all three GitHub attestations verified against the exact tag/workflow, and all
three Cosign bundles returned `Verified OK`.

**The final release is independently verified and executable-byte-equivalent to the candidate.**
`v0.1.0-alpha.1` records source `5323303cdc3156854f7ede9267863b0148407357`; its archive, SPDX,
and checksum-manifest digests are respectively
`37f12c21975759bbc10fb2f7288149d3cdc5dc82caddcc0a1645d93be71b7506`,
`5c83c333579fc948857255383e4003535c64c596e129444379c910da77a65f7b`, and
`ce220ca82e4174f23da86e3f710b2fbc5020382adb5e966b506952a23ce28a27`. Checksums, all three
GitHub attestations, and all three Cosign bundles verified against the final tag. Candidate and
final archives contain the same 48 paths; 46 are byte-identical, and the only differences are
`release-info.json` plus `SBOM.spdx.json`, where source commit/timestamp/namespace provenance names
the final tag commit.

The final `release-info.json` still carries the build script's conservative static
`pre-alpha; cross-OS and real Android acceptance not yet completed` qualification string. It
underclaims the independently verified release but does not alter executable bytes or the support
matrix above. Rather than rewrite this immutable release, `scripts/build-release.ts` now derives
that field from the release channel `release.yml` exports for the validated tag shape:
`-alpha[.<n>]` records qualified alpha, `-beta[.<n>]` qualified beta, and `-prealpha.<n>` plus
`provenance-test-v…` stay pre-alpha. A build with no channel defaults to pre-alpha; every unknown
value fails. Byte-exact advertised-tag rebuilds must set the matching `alpha` or `beta` channel.

**Candidate `.18` is retained as failed qualification evidence, not promoted.** It exposed a real
operator-path defect: after several successful explicit version switches, systemd's start-rate
counter refused the next rollback and its repair. Candidate `.19` resets that counter only
immediately before an explicit install/rollback start. The state-faithful regression passed locally,
hosted Linux/Windows checks passed, and the exact `.19` Debian lane then completed W0 through W5,
including the formerly failing W2, before ending with the candidate active and `107/107` invariants
passing.

**Debian candidate result.** The archive and provenance were reverified on the droplet; install
produced loopback-only `127.0.0.1:4317`, private `0600` config/token/unit files, and
`installed/active/ready` status. Token rotation replaced PID `2199` with `2302`; diagnostics
contained neither token nor home path. Upgrade from `v0.1.0-alpha`, requested and recorded rollback,
induced-divergence repair, identity denial, two reboot/login persistence passes, active
`uninstall --no-stop` refusal, uninstall, tailnet-node deletion, and droplet teardown all passed.

**macOS candidate result.** The leased M2 host independently verified checksums, GitHub attestations,
and the Cosign bundle, then installed the candidate with private files, a loopback-only listener, and
`doctor` 17/17. Serve returned metadata-only `200 no-store` to the allowlisted identity while direct
tailnet-IP and public-IP backend probes were refused. Token rotation restarted the daemon; the
diagnostics bundle contained neither token nor login. A control-plane reboot changed the measured
boot time, and automatic console login returned the LaunchAgent listening only on
`127.0.0.1:4317` with `installed/active/ready` status and no divergence. The publisher token
remained byte-identical without publishing its fingerprint. Uninstall then left no plist, launchd
job, gateway process, or listener.

**Physical Pixel result.** The candidate launch returned `200` with
`cache-control: no-store, max-age=0`; a self-verifying control planted and detected all seven
forbidden sinks, removed its plants, and found the real capability in none of Local Storage, Session
Storage, cookies, Cache Storage, IndexedDB, history/address state, resource timings, or DOM. A real
history traversal recorded `pagehide.persisted=true` then `pageshow.persisted=true`, restoring `/`
with one directory and no collaboration shell. Against a patched OMP `v17.3.8` process, View exposed
a disabled composer, explicit Control enabled a fresh prompt, the remote turn became interruptible,
Stop settled it, and Sessions returned to a capability-free directory.

**Windows remains unadvertised.** The exact source tree passed hosted current-user service lifecycle,
ACL, IPC, and clean-uninstall checks in [run `32501662399`](https://github.com/alphastorm/omp-session-gateway/actions/runs/32501662399).
Persistent source acceptance on 2026-08-21 subsequently passed install, reboot, first-interactive-
login startup, `doctor` 17/17, rotation, upgrade/rollback, patched OMP publication, and uninstall;
Windows stays unadvertised pending the exact signed gateway/OMP rerun.

**Endurance evidence is reused by code identity, not silently inherited.** Neither the pinned
collaboration client nor the six-commit OMP patch changed in this point release. Candidate `.19`
adds a bounded real Pixel View/Control/prompt/interrupt smoke against those same bytes. The
previous 27,600-second current-pin rerun remains recorded as externally contaminated evidence, and
a protected replacement completed the full authored 28,800-second window on 2026-08-21 with 22
relay-room transitions, `finalPhase: "live"`, exit code 0, and no process restart. Its named record
is `~/.local/share/omp-session-gateway/test/v0.1.0-alpha.1/soak/protected-relay-soak-8h.json`.

**Required deployment preconditions.** Tailscale Serve over tailnet HTTPS is the only supported
remote path; Funnel must stay disabled; and Tailscale must run its **TUN-mode** client.
Userspace-networking `tailscaled` does not establish the listener/identity trust boundary and the
gateway fails closed in that topology ([#98](https://github.com/alphastorm/omp-session-gateway/issues/98)).

**Known limitations.** Recovery after an abrupt radio transition on Android may require
force-stopping Chrome: Chrome-for-Android can wedge its network stack while the device remains
healthy, so network-change and reconnect remain explicitly **unproven**
([#65](https://github.com/alphastorm/omp-session-gateway/issues/65)). Preview notification detail
currently falls back to Session detail because the OMP publisher carries no bounded preview field.
Windows is not advertised: #90 and reboot/login behavior now pass in source, but its exact signed
Windows artifact lane remains open; that narrower support gap does not block beta. Self-hosted or
proxied relay modes remain unsupported.

Anything outside the table above is unqualified and must not be presented as a working deployment
path. Passing one platform permits advertising only that exact platform/version combination.

**Pin (historical alpha baseline).** OMP `v17.3.8` /
`858f7dd91fff9b84cf8a2c6a6bb85aa0e6d03a55`, refreshed 2026-08-19 and revalidated for alpha.1.

This ledger is the source of truth for the current release decision. Compatibility claims live in
[`COMPATIBILITY.md`](COMPATIBILITY.md); required scenarios are defined in
[`TEST_PLAN.md`](TEST_PLAN.md); implementation evidence is recorded in
[`../HANDOFF_MANIFEST.md`](../HANDOFF_MANIFEST.md).

## Status rules

| Status | Meaning |
|---|---|
| **PASS** | The named scope has current, reproducible evidence. It says nothing about a broader scope. |
| **PARTIAL** | Some automated or smoke evidence exists, but the complete release scenario has not passed. |
| **NOT RUN** | No completed result is recorded for the required environment or scenario. |
| **BLOCKED** | A known prerequisite prevents completion or publication. |
| **N/A** | Deliberately excluded from this release and not advertised. |

An advertised alpha or beta requires every applicable release-blocking row below to be **PASS**.
Automated tests, mocks, a desktop mobile viewport, or generated service definitions do not
substitute for native OS, real Tailscale, real relay, or Android qualification.

## Recorded implementation evidence

The table retains historical evidence across pre-alpha and alpha qualification. The current beta
decision and its exact successor evidence are the bounded record at the top of this document.

| Scope | Status | Recorded evidence |
|---|---|---|
| Exact upstream pin | **PASS** | `UPSTREAM.lock.json` pins `can1357/oh-my-pi@858f7dd91fff9b84cf8a2c6a6bb85aa0e6d03a55`, tag `v17.3.8`, with package and Bun versions. The regenerated five-commit mbox applies cleanly to the pristine pin and reproduces tree `1320e3e7e7596dbe2f6a130d568072a9a38f2943`. Its first four commits are the reviewed handoff artifact `gateway-collaboration-v17.3.8.mbox` (sha256 `f63f74c90d72776ca1ebcb4b1a75b18130b3c65d1c6e0133c9bbb3a8e5b4af49`) applied verbatim with plain `git am`; the fifth restores the health-probe commit that the maintained series no longer carries. Recorded 2026-08-19. |
| Repository check | **PASS** | Re-run at the `v17.3.8` pin on 2026-08-19, at doctor pin-contract commit `bb0a852b0c4c72181718033f261e0ff2901a08c8`. `bun run check` passed handoff validation, four workspace typechecks, production web/client builds, 133 tests with 767 assertions across 22 files, and capability-leak scanning. Twenty Android-sized Playwright cases passed at both `412 × 915` and `390 × 844`: installed-PWA View/Control handoff, the embedded active-ask 3d shell, direct client navigation returning to the directory, answer-feedback dismissal by keyboard/tap-out/swipe/timeout, transport-interruption reconnect, stale-session failure states, metadata-only attention and background-alert settings, and automatic plus collaboration-preserving PWA activation. |
| Host-suspension recovery experiment | **PASS** | The downloaded and independently verified `provenance-test-v0.1.0.10` gateway plus the exact patched OMP publisher were suspended beyond a five-second test TTL, then resumed gateway-first, publisher-first, and together. Every order first lost the expired card, mutually re-authenticated, sent a full upsert, and restored one session within eight seconds. This finite missed-timer reproduction does not replace actual macOS sleep/wake qualification. |
| Dependency audit | **PASS** | `bun audit` reported no vulnerabilities for the recorded lockfile. |
| OMP patch application and lifecycle fixtures | **PASS** | Re-run at `v17.3.8` on 2026-08-19: `git apply --check` passed against the pristine pin, and the documented suite passed 108 tests with 506 assertions across nine files plus five slash-command tests with 29 assertions. `bunx tsc --noEmit -p packages/coding-agent/tsconfig.json` produced 66 errors on the patched tree and the identical 66 on pristine `v17.3.8`, with none unique to the patch; those are upstream-baseline errors in advisor, eval, markit, stt, tts, and vibe files, several from optional dependencies such as `mupdf` that are absent in a fresh checkout. |
| Registry mutual authentication | **PASS** | Shared gateway and standalone OMP proof-vector tests agree; stale client proof replay is rejected; a fake server receives only `hello`; and an isolated real gateway/synthetic-publisher smoke published metadata then revoked it on disconnect without key/capability log output. |
| Full pinned OMP checkout | **PASS** | `bun run ci:check:full` passed. Every official TypeScript test outside five independently reproduced pristine-baseline failures passed in its official bucket. The unchanged baseline failures are two Python completion-runtime assertions, two status-path assertions, and one session-file timestamp-ordering assertion; no patch-specific failure remained. |
| Deterministic runtime archive | **PASS** | Two clean local builds from hardening commit `99e34ee866d30dbb6424346404dc293727daa319` produced byte-identical 848,896-byte archives, SPDX 2.3 inventories, and checksum manifests. `SHA256SUMS` verified archive digest `7c25c37dd25bf2e93f7b8c48d1f0214c51f46709d82fcb830f7a0b7aae80e472` and SPDX digest `730097f950f9f2f4684b0358907870b889f32b690f7a6bbfe0d544be50b686fd`; `release-info.json` pins that source commit, upstream `39c95e5e29b1c8b082059f57421ce445c3dffdd4`, and the exact lock digest. This is unsigned local preflight, not signed-candidate qualification. |
| Extracted archive command smoke | **PASS** | The hardening archive's bundled CLI completed `--help`, isolated `install --no-start`, inactive `status`, Serve guidance, redacted `doctor --bundle`, and `uninstall --no-stop` on macOS arm64 without touching the live trial. The generated publisher token was 43 bytes with mode `0600`, its config directory was `0700`, and its bytes appeared in no other smoke file or diagnostic; the synthetic login, tailnet host, and full smoke path were also absent from diagnostics. A fresh archive from commit `a514c9ca8ab9611dd934c09b5ddc8dd2074c2ac7` then ran its bundled gateway on an isolated loopback port, mutually authenticated three source-checkout publishers, returned metadata-only revision 3, served a no-store in-memory launch response, rejected a stale generation with `409` and no capability field, and removed all records on publisher socket close at revision 6. Re-run at the `v17.3.8` pin on 2026-08-19 from a freshly built archive at merge commit `ac63641`, in a hermetic root under `env -i`. `--help`, `install --no-start`, `status`, `serve-guidance`, `rotate-publisher-token`, `doctor --bundle`, and `uninstall --no-stop` all behaved correctly; the publisher token was 44 bytes at `0600` with `0700` config and state directories, and the diagnostics bundle contained no token, allowlisted login, tailnet host, or install path. This run doubles as the regression proof for the service-ownership fix: the same sequence on 2026-08-19 had reported `active: true` from the production service and `rotate-publisher-token` booted out the live daemon, whereas it now reports `active: false`, rotation exits 0 on the inactive branch, and the live daemon's PID, launchd registration, LaunchAgent file, and sixteen `doctor` checks were all unchanged across the run. |
| Desktop mobile-viewport browser smoke | **PASS** | Chromium at `412 × 915` rendered three synthetic sessions; SSE, generation conflict, no-store launch, URL scrub, storage/cache checks, and prompt socket-close removal passed. A separate `390 × 844` run proved overlapping snapshot/SSE revision ordering, stale-metadata clearing on transport loss, and query-bearing asset cache bypass. The extracted `a514c9c` runtime repeated the `412 × 915` path: its client popup used `/client/` with no query, fragment, referrer, cookie, history state, Local/Session Storage, IndexedDB, or secret-bearing resource URL; Cache Storage contained only the two immutable app assets, recovery returned to `/`, and SSE exposed the empty state immediately after socket-close removal. Re-run at the `v17.3.8` pin with the re-vendored client on 2026-08-19: all twenty Playwright cases passed at both `412 × 915` and `390 × 844`. |
| Desktop background Web Push browser smoke | **PASS** | Chromium at `412 × 915` explicitly granted permission and created a real HTTPS Push subscription. With the PWA document navigated away, the gateway delivered encrypted Web Push and the service worker displayed fixed title `OMP session needs attention`, an empty body, and metadata-only instance/generation data. A stale notification route was synchronously scrubbed to `/` and retained the visible expired state. This does not prove Android OS delivery, force-stop behavior, lock-screen presentation, or tap-to-Control. |
| Isolated attention lifecycle smoke | **PASS** | A real gateway and mutually authenticated publisher drove same-generation false-to-true-to-false state through IPC, registry, SSE, and the built dashboard. Chromium observed the accessible attention state, authoritative clear, and removal; no synthetic capability marker appeared in DOM, URL/history, Local/Session Storage, cookies, gateway logs, or cached shell state. This does not replace a patched real-OMP retained-request/Control smoke or physical Android qualification. |
| macOS/Tailscale development-checkout qualification | **PASS** | macOS 26.5.2 arm64 completed live LaunchAgent install/reinstall, permissions, token rotation, diagnostics bundle, Serve access as the allowlisted node identity, loopback-backend identity rejection, loopback/LAN isolation, and uninstall. Distinct-device allowlist isolation remains a separate gate below. |
| Linux container lifecycle qualification | **PASS** | Debian 13 arm64 with a real systemd user manager completed the development-checkout lifecycle and repeated it from unsigned extracted archive commit `f821335e1ae7fc5c98bf57370019bdc9176b5c2e`. The artifact installed and became ready, kept config/token/service files at `0600` and private directories at `0700`, accepted only loopback traffic, replaced PID 234 with 415 on active reinstall, rotated the token and replaced PID 415 with 497, produced diagnostics excluding the token, login, host, and home path, refused `uninstall --no-stop` while active, then removed the service, process, and listener on normal uninstall. This is explicitly container preflight, not bare-metal or signed-candidate qualification. Re-run at the `v17.3.8` pin on 2026-08-20 on Debian 13.6 aarch64 with `systemctl --user` reporting `running`, from an extracted archive built at merge commit `ac63641` on Bun 1.3.14. Install reached ready with MainPID 159; the unit file, `config.json`, and the 44-byte publisher token were `0600` with `0700` config and state directories; `ss` showed a single listener bound to `127.0.0.1:4317`; active reinstall replaced PID 159 with 239; token rotation changed the token digest and replaced PID 239 with 292; the diagnostics bundle contained no token, allowlisted login, tailnet host, or home path; `uninstall --no-stop` refused with exit 1 while the service stayed active; and normal uninstall removed the unit, left `is-active` inactive, left zero listeners on 4317, and reported `installed:false`. |
| Windows hosted source-checkout qualification | **PASS** | [GitHub Actions run 29791906104](https://github.com/alphastorm/omp-session-gateway/actions/runs/29791906104) applied the exact candidate OMP patch, passed all eleven publisher fixtures—including mutual authentication, fake-server withholding, restart recovery, post-restart token reread, and an explicit token path preserving ambient XDG configuration—and the coding-agent typecheck, then completed gateway IPC/config/token ACL tests, current-user publisher access plus cross-user publisher-write denial, UTF-16 scheduled-task install/start, health/status, token rotation with graceful PID replacement, idempotent active reinstall, and process-clean uninstall. |
| Real desktop OMP/browser acceptance | **PASS** | Three patched interactive OMP processes auto-published without `/collab`; Chrome 150 at `412 × 915` observed cards, View/Control separation, prompt, interrupt, process removal, safe leave, no URL/storage capability, and foreground/online transport replacement. A live `/new` revoked generation 1, published generation 2 after replacement, and left generation 1 unlaunchable (`409`). A later metadata-refresh smoke published the initial `provider/model`, updated title and CWD plus two model events on the same instance/generation across directory revisions 14–18, and revoked at revision 19. |
| Default-relay endurance soak | **PASS** | The signed `v0.1.0-prealpha.2` recovery rerun completed 28,800 seconds with eight relay-room transitions, `finalPhase: "live"`, exit code 0, and no process restart. Gateway RSS moved from 45,776 KiB to 46,496 KiB (+720 KiB, approximately 1.6%). The named record is `~/.local/share/omp-session-gateway/test/v0.1.0-prealpha.2/soak/recovery-v012-relay-soak-8h.json`. A re-run at the `v17.3.8` pin on 2026-08-20 sustained **27,600 seconds**, 96% of the 28,800-second window, before terminating on `relay ended during soak: timed out waiting for the host's welcome`. The cause was external and documented: three Android acceptance runs were pointed at the soak's own host session, and each fires real view, control, and stale-generation launches into that session's relay room, so the collaboration host faulted. The relay connection itself did not fail. An earlier attempt the same day ended at 2h48m when its host session, started before the [#61](https://github.com/alphastorm/omp-session-gateway/issues/61) fix was activated, hit the publisher latch. Both terminations are attributable to the host side rather than the relay. A protected replacement then completed **28,800 of 28,800 seconds** from `2026-08-21T09:44:45.171Z` to `17:44:45.344Z`, made 22 relay-room transitions, remained in `finalPhase: "live"`, and exited 0 with no process restart. The harness records no memory metrics, so no RSS delta is claimed. Named record: `~/.local/share/omp-session-gateway/test/v0.1.0-alpha.1/soak/protected-relay-soak-8h.json`. |
| Physical Android `v0.1.0-prealpha.4` trial | **PARTIAL** | Pixel 10 Pro, Android 17 build `CP2A.260705.006` (SDK 37), Chrome `150.0.7871.128` passed installed-PWA View/Control/Back, exactly-once retained response, attention clearing, metadata-only foreground and lock-screen notification, dashboard-only notification tap, lock/resume, Wi-Fi/cellular transition, automatic relay reconnect, generation replacement with stale `409`, and TTL removal/republication. Distinct-identity denial, deep physical-browser sink inspection, interrupt, and remaining switch/branch/resume cases were deferred. Named record: `~/.local/share/omp-session-gateway/test/v0.1.0-prealpha.4/qualification/local-android-launch-fix.json`. |
| Physical Android and capacity `v0.1.0-prealpha.5` trial | **PASS** | The downloaded archive passed checksum, GitHub attestation, Cosign bundle, signed-tag, and exact-byte reproduction verification. On the same Pixel/Android/Chrome combination, three real patched OMP sessions appeared automatically; Airplane mode cleared all cards by the 40-second observation after the configured 35-second SSE deadline, and restoration returned exactly three without Refresh or duplicates. A separate signed-runtime run held 50 publishers for a 642-second measured window at the normal heartbeat cadence, averaging 0.125% of one CPU core with maximum observed daemon RSS 63,760 KiB; all 50 remained fresh and clean shutdown removed all 50. Twenty local launch calls measured 0.496 ms p95. Named record: `~/.local/share/omp-session-gateway/test/v0.1.0-prealpha.5/qualification/android-offline-and-capacity.json`. |
| Physical Android background Push `v0.1.0-prealpha.7` trial | **PARTIAL** | After the signed candidate was installed behind the canonical Tailscale Serve origin, the user reported the instructed phone flow working: explicit background-alert enablement, notification delivery with the PWA closed, and notification-tap entry into current Control. This is direct user confirmation of the core experience, not a complete qualification record: fresh device/OS/browser versions, lock-screen presentation, force-stop behavior, stale-generation handling, network transitions, forbidden-sink inspection, and a named evidence artifact were not captured in this trial. |
| Private vulnerability reporting | **PASS** | GitHub repository private vulnerability reporting returned `enabled: true` on 2026-07-20. |
| Deterministic SPDX inventory | **PASS** | Two release builds produced identical archive and SPDX 2.3 digests; `SHA256SUMS` verified both and the archive contains `SBOM.spdx.json`. |
| Hosted signing and provenance | **PASS** | Corrected [`provenance-test-v0.1.0.10`](https://github.com/alphastorm/omp-session-gateway/releases/tag/provenance-test-v0.1.0.10) at protected-main merge commit `1c33c90252643d7d0f572fe57a0e560f00b72afb` ([run `29792234310`](https://github.com/alphastorm/omp-session-gateway/actions/runs/29792234310)) published six immutable-release-attested assets. Downloaded checksums, all three GitHub build attestations, all three Cosign bundles, and release provenance verified independently. A clean exact-tag rebuild was byte-identical for the archive (`b446d405d97c2bec181b9d0f4be03c83ede7407d24d603a9d117be428b95576e`), SPDX inventory (`4cb0b1b2c81fdcaf56044cd38259a9ad979bff88efd75ca9a7a2fe3f30d6e8f1`), and checksum manifest (`08d28faa291f7b374dc8d6d88656c5e7e84cda93f65707acdc6a530415b39326`). |
| Signed candidate packaging/runtime smoke | **PASS** | The downloaded and independently verified `provenance-test-v0.1.0.10` archive installed with `--no-start` into an isolated macOS root, launched the installed runtime through the existing real Tailscale Serve mapping, and mutually authenticated three reconnect-capable patched OMP publisher fixtures. A real gateway restart restored all three cards in approximately 227 ms; a patched interactive OMP process auto-published a fourth card and revoked it immediately on shutdown. The controlled suspension experiment used this installed gateway and restored each expired session within eight seconds in all three resume orders. This is packaging/runtime and finite-suspension evidence, not complete LaunchAgent, distinct-device identity, actual sleep/wake, real collaboration, or Android qualification. |
| Repository security controls | **PASS** | Private vulnerability reporting, dependency alerts and automated security updates, secret scanning and push protection, and immutable releases are enabled. `main` requires signed commits, pull requests, current implementation/Windows checks, resolved conversations, and blocks force-pushes and deletion. |
| Production registry-socket rebind | **PASS** | On 2026-08-19 the installed macOS daemon (PID 9994, started 2026-08-16 23:13) was observed listening on a `registry.sock` whose inode was created 2026-08-17 09:31 — about ten hours after process start — so the watchdog re-bound the rendezvous point after macOS reaped the per-user `TMPDIR` entry, with no operator action and no daemon restart. `doctor` returned all sixteen checks true and four `omp-code-mode` publishers were connected to the re-bound socket. This is unsolicited production evidence for the fix merged in PR #47; it does not advance the macOS host lifecycle gate below. |
| Live `doctor` at the refreshed pin | **PASS** | On 2026-08-19, after the `v17.3.8` refresh, `doctor` run from the updated checkout against the installed macOS daemon returned all sixteen checks true, including `compatibility`, `serveMapping`, `identityAllowed`, `funnelDisabled`, `listenerLoopbackOnly`, and `publisherHealth`. The first attempt returned `compatibility: false` because `doctor` hardcodes the expected upstream identity and the refresh had left it naming `v17.0.6`; that is fixed and now bound to `UPSTREAM.lock.json` by a pin-contract test. Four `omp-code-mode` publishers from the previous `17.3.5` release were connected throughout, so this is not evidence that a `17.3.8` OMP process publishes. |

The evidence date and caveats above come from the implementation handoff and the current
provenance-test artifact. Every later candidate must rerun the applicable clean-checkout CI and
native qualification and attach those records to its tag.

## Alpha gate ledger

| Release gate | Status | Evidence or missing proof | Required to close |
|---|---|---|---|
| Exact OMP and collab-web provenance | **PASS** | Immutable source commit, package versions, relevant paths, local integration, and patch are recorded in `UPSTREAM.lock.json` and `packages/collab-client/upstream/UPSTREAM.json`. **Pin classification 2026-08-21:** this row is repository state, not a candidate-tag revalidation. `UPSTREAM.lock.json` itself records `observedAt` 2026-08-19 at `v17.3.8`/`858f7dd9`, so the pin metadata is current, but the ledger sentence carried no observation date of its own. Treat provenance as current only for the files and patch as they stand at the recorded pin; re-inspect them at each new candidate tag rather than assuming this row travels forward. | Revalidate unchanged data at the candidate tag. |
| Repository automated suite | **PASS** | Candidate `.19` release gates passed handoff validation, every workspace typecheck, production web/client build, 382 Bun tests with 1,955 assertions across 30 files, capability/identifier leak scans, and 22 Playwright cases across both Android viewports. Required PR checks also passed the hosted Windows lifecycle and native Linux arm64 source checkout. | Keep required checks green on the final tag commit. |
| OMP patch compatibility | **PASS** | Patch apply-check, 114 focused attention/lifecycle fixtures, the coding-agent package typecheck, and `bun run ci:check:full` passed against the exact pin. Every non-baseline official TypeScript test passed; five failures reproduce unchanged on the pristine pin. | Rerun from the exact pin at the candidate tag; do not broaden the OMP range. |
| Fifty-publisher capacity | **PASS** | The signed `v0.1.0-prealpha.5` daemon held 50 authenticated publishers and sessions for a 642-second measured window at the normal 10-second heartbeat cadence. It consumed 0.80 CPU seconds over that interval (0.125% of one core average), stayed below 63,760 KiB observed RSS, retained 50 fresh records, logged no warnings/errors, and removed all 50 on clean publisher shutdown. The capacity files contained no synthetic capability marker. **Re-run 2026-08-21 against `v0.1.0-prealpha.17`** using the in-repository `synthetic-publisher.ts` against an isolated daemon on port 4319 with its own config, state and runtime roots, so the founder's live daemon on 4317 was never involved. 50 publishers completed the real mutual-HMAC handshake over the Unix-domain socket and were held for a 606-second window at the 10-second heartbeat across 41 samples. Session count was **50 at every one of the 41 samples**, minimum equal to maximum, so no record expired while its publisher was heartbeating. The daemon consumed **0.85 CPU seconds over 606 s (0.140% of one core)** with **peak RSS 68,832 KiB and mean 54,078 KiB**. Both figures are modestly higher than the `v0.1.0-prealpha.5` baseline of 0.80 CPU seconds at 0.125% and under 63,760 KiB; recorded as measured rather than smoothed. The metadata response contained no capability-bearing field. | Repeat on every later candidate and investigate any material regression from this baseline. |
| Capability non-persistence | **PASS** | On candidate `.19`, Pixel Chrome `151.0.7922.171` ran the self-verifying `android-leak-sweep.ts`: all seven control sinks detected the planted secret and were cleaned, the real launch was `200 no-store`, and the capability was absent from browser storage, cookies, caches, IndexedDB, URL/history, resource timings, and DOM. | Repeat on every advertised client candidate. |
| Loopback-only exposure | **PASS** | Candidate `.19` listened only on `127.0.0.1:4317` on Debian and macOS. Distinct-node probes to the macOS tailnet and public addresses were refused; Debian public/tailnet backend probes were refused and uninstall removed the listener. | Repeat on every advertised host candidate. |
| Tailscale Serve identity and application allowlist | **PASS** | macOS Serve returned metadata-only `200 no-store` for the real allowlisted identity and ignored a forged header; direct backend addresses were refused. The tagged Debian node carried no user login and was denied, while local requests without identity returned `403`. Funnel was disabled and both hosts had a real TUN interface. | Repeat allowed and denied halves for later candidates. |
| Linux host lifecycle | **PASS** | Candidate `.19` passed [run `32502584598`](https://github.com/alphastorm/omp-session-gateway/actions/runs/32502584598): signed artifact verification, private permissions, install/readiness, rotation, migration from `v0.1.0-alpha`, requested and recorded rollback, `107/107` rollback invariants, identity denial, reboot persistence with lingering off/on, active-uninstall refusal, uninstall, and paid-resource teardown. | Re-run for each advertised Linux candidate. |
| macOS host lifecycle | **PASS** | Candidate `.19` on macOS 26.6.1 arm64 (`Mac14,3`) passed artifact verification, install, `doctor` 17/17, rotation, identity/exposure, control-plane reboot with `kern.boottime` change and unchanged token, automatic LaunchAgent return at console login, loopback-only readiness, active-uninstall refusal, uninstall, and process/listener cleanup. | Re-run for each advertised macOS candidate; the claim is interactive-login startup. |
| Windows host lifecycle | **PARTIAL** | Hosted run `29791906104` passed current-user pipe derivation, strict token ACLs, publisher mutual authentication, cross-user denial, service lifecycle, rotation, and uninstall. Persistent Windows Server 2025 source acceptance on 2026-08-21 then exercised the real boundary: exact source `622c242c625f3ab23b11b55f5a6994953895ba23` installed in 77,498 ms on 2 vCPU/4 GiB; a real reboot left the task installed but inactive with no listener before login; a certificate-pinned RDP login fired `LogonTrigger` without `/Run` and restored readiness; config/token hashes survived. Rotation, active upgrade, history-selected rollback, TUN-mode Serve, `doctor` 17/17, and uninstall passed. Exact OMP `v17.4.1` plus patch SHA-256 `abcc8866f76fc82485a42c0ce51ca19aec3b928afcddf0af1c25c35dd10ad4e2` produced an unsigned Windows binary that auto-published View/Control, returned `200 no-store` launches, denied a stale generation `409`, and revoked within 374 ms after forced exit. The source lane is accepted; release status stays PARTIAL because both gateway and OMP inputs were unsigned and the complete Windows `read-only.test.ts` fixture exposed a hang after six passing cases. See `docs/WINDOWS_QUALIFICATION.md`. | Repeat the whole sequence with the exact signed gateway candidate and paired signed OMP distribution; resolve or explicitly baseline the bounded fixture hang. Advertise only “starts at interactive login,” never unattended boot. |
| Android PWA installation | **PARTIAL** | Pixel 10 Pro, Android 17 build `CP2A.260705.006` (SDK 37), Chrome `150.0.7871.128` installed the PWA from tailnet HTTPS, activated corrected `v0.1.0-prealpha.4` and signed `v0.1.0-prealpha.5` shells, and loaded the metadata directory. The loaded v0.1.0-prealpha.5 shell cleared all cards after a silent Airplane-mode partition and restored only a fresh snapshot; cold offline navigation remained unavailable as designed because navigation bypasses the service worker. **Re-run 2026-08-21 against `v0.1.0-prealpha.17`** on the physical Pixel 10 Pro with Chrome `151.0.7922.139`: the shell loaded over tailnet HTTPS with the service worker **active** at the origin root scope, the manifest resolving to name **OMP Sessions**, `display: standalone`, four icons and `start_url: /`. Cache storage held exactly one entry, the immutable application shell `omp-sessions-shell-c08260c80b66`, and `location.hash` was **0 characters**, so no capability reached the address bar. The metadata directory answered `200` in 51 ms at revision 42. | Complete the deferred deep physical-browser sink inspection before advertising this client combination. |
| Three real OMP processes auto-discover | **PASS** | Three patched interactive OMP processes in `workspace`, `workspace-2`, and `workspace-3` appeared automatically without Refresh on the physical Pixel through the signed `v0.1.0-prealpha.5` gateway. **Re-run 2026-08-21 against `v0.1.0-prealpha.17`**: three patched interactive OMP processes launched in `qual-three-a`, `qual-three-b` and `qual-three-c` all appeared automatically in the live directory at revision 30 without Refresh, each at generation 1 with `canView` and `canControl` true. This re-establishes the host half at the current candidate; the physical-device half of this row still rests on the earlier `v0.1.0-prealpha.5` observation. | Repeat on every later candidate/device combination. |
| Real View and Control behavior | **PASS** | On candidate `.19` and the physical Pixel, a patched OMP `v17.3.8` session auto-published with View and Control. View rendered a disabled composer; explicit Control enabled a fresh prompt; the remote turn became interruptible; Stop settled it; and Sessions returned to a capability-free directory. The separate launch/leak sweep returned `200 no-store`. | Repeat the real interaction smoke on later client/candidate combinations. |
| Real lifecycle revocation | **PARTIAL** | Physical Android observed automatic single-card generation 2→3 replacement without Refresh; old generations 1 and 2 each returned `409`. Suspending the live OMP publisher expired the card at revision 19 and resuming restored generation 3 at revision 20 without Refresh, duplication, or stale launch. Re-measured on 2026-08-19 at the `v17.3.8` pin against the upgraded live gateway `0.1.0-61114587f124`, using a scratch OMP session so live sessions were untouched. **Switch** (`/new`): generation 1 returned `200` through t=10 s, `404` at t=12 s, and `409` from t=13 s, which is when generation 2 first became visible — the stale generation was unreachable before the replacement was published, with no overlap. **Crash** (`SIGKILL`): removed in ~1 s by socket close, launch `404`. **TTL sweeper** (`SIGSTOP`, socket held open, heartbeats stopped): still listed and launchable at t=30 s, absent at t=38 s, so expiry landed at ~34 s against the configured 35 s budget; `SIGCONT` republished the same instance at revision 24. A nonexistent generation returned `409 generation_mismatch`, and repeated launches returned `429`. Branch and saved-session resume were measured on 2026-08-20 with a session carrying real conversation history, recorded in [`LIFECYCLE_BRANCH_RESUME.md`](LIFECYCLE_BRANCH_RESUME.md). Branch ordering held: generation 1 read `404` at 15:31:05.027Z and generation 2 first appeared at 15:31:05.847Z, an 833 ms window in which the old generation was already dead and the replacement did not yet exist, so the directory never showed two generations at once and the sequence was `200 -> 404 -> 409`, never `200 -> 200`. Stale **control** at the old generation returned `409 generation_mismatch` while generation 2 was live with `canControl` true. A branch also produces a second revoke/publish pair 35 s later re-advertising the same capability digest, and ordering holds there too. Clean exit removed the card in about 13 s, well inside TTL, and resume republished as a **new** instance at generation 1 about 18 s after process start, with the pre-exit pair returning `404` on all 41 probes including an explicit stale-control probe.| The tree-navigation spelling of `/branch`, which this host's default `doubleEscapeAction=tree` actually routes to, was not exercised, and no browser or Android observation was made. The default-relay half of blocker 4 remains separate. |
| Android lock, resume, network, back, and reconnect | **PARTIAL** | Pixel 10 Pro lock/unlock preserved the authoritative attention state without duplicates; Wi-Fi→cellular→Wi-Fi recovered automatically with Tailscale enabled; View reconnected, and Android Back returned to Sessions. On signed `v0.1.0-prealpha.5`, a silent Airplane-mode partition cleared all cards by the 40-second observation after the configured 35-second deadline despite Tailscale's virtual interface, and restoration fetched exactly three fresh cards without Refresh. On 2026-07-25, the unreleased 5-second SSE / 12-second liveness build was installed on the canonical macOS gateway; `doctor` passed every check and a live Android-sized Chromium offline→online transition restored two cards automatically without Refresh. On 2026-08-20 the matrix was re-run at the `v17.3.8` pin from a development install via `scripts/android-acceptance.ts` on Android 17 `CP2A.260805.005` / Chrome `151.0.7922.139`. Lock and resume recovered in 3,465-3,674 ms after wake with a 64-106 ms fetch and no unreachable banner, across three runs. Forced deep Doze reached `IDLE` and recovered in 8,484-9,348 ms. Airplane mode showed the unreachable banner during the outage in every run and recovered automatically without a reload in 14,873 ms and in 83 ms on two runs — but a third run stalled for 471,257 ms while `adb shell ping` proved the device had reached the host at 28,424 ms, recovering only after the Doze cycle ([#65](https://github.com/alphastorm/omp-session-gateway/issues/65)). The Wi-Fi-to-cellular leg could **not** be exercised: with Wi-Fi disabled the device reported `Active default network: none` and `connect: Network is unreachable`, because the Google Fi SIM is present but `NOT_READY`. The earlier Wi-Fi/cellular/Wi-Fi claim in this row therefore cannot currently be reproduced on this hardware and should be treated as unverified until a device with working cellular data is available. Chrome freezes the renderer while the display is off, so lock-state observation is only possible after waking. Re-run on 2026-08-20 against the signed candidate: lock/resume recovered in 3,872 ms and forced deep Doze in 9,335 ms, and the airplane stall reproduced a second time with the device reachable at 28,354 ms versus 28,424 ms on the development install, confirming [#65](https://github.com/alphastorm/omp-session-gateway/issues/65) is not specific to a development build and reproduces when a lock/resume cycle precedes the transition. **Partially re-run 2026-08-21 against `v0.1.0-prealpha.17`** on Chrome `151.0.7922.139`. Lock/resume: after a screen-off, wake and unlock cycle the directory still answered `200` in 41 ms. Recorded honestly, the page reported `visibilityState: hidden` at that instant, so this shows the fetch path surviving the cycle rather than a foregrounded render. Back navigation: launching View is a **real navigation** from `/` to `/client/` that grows history from 2 to 3 entries and carries **no URL fragment**, and both `history.back()` and the in-app `← Sessions` control return to `/`. A hardware Back sent via `adb input keyevent 4` produced no change even with `Page.bringToFront` confirming `visible`, so that key is not reaching the page through this harness; it is a **harness delivery limitation, not a product result**, and physical-gesture Back remains unproven. **Network-change and reconnect remain blocked** by [#65](https://github.com/alphastorm/omp-session-gateway/issues/65). | Characterise and attribute #65, obtain a device with working cellular data to re-prove the Wi-Fi/cellular transition, repeat the exact `alpha`↔`alpha_2g` transition on physical Android, and re-run all of it against a signed candidate artifact. |
| Android attention notification | **PARTIAL** | The earlier foreground-only trial passed fixed metadata-only notification text, lock-screen presentation, dashboard-only tap, and lock/resume. On signed `v0.1.0-prealpha.7`, the user subsequently reported the instructed closed-PWA background notification and tap-to-current-Control flow working. The report confirms the core physical experience but lacks fresh version capture and the remaining background matrix. **Re-run 2026-08-21 against `v0.1.0-prealpha.17`** on the physical Pixel 10 Pro with Chrome `151.0.7922.139`, exercising the full cycle rather than only the appearance. A disposable OMP session was driven into a real pending ask; the directory then reported that session as the only one with `inputRequired` true and `canControl` true, and the PWA rendered its attention affordance, offering **Open request** and **View transcript instead**. The `ask` field is metadata-only: a 90-character object carrying just `requestId` and `since`, with no question text, no capability and no URL, so the attention signal travels without the content. Answering the prompt cleared it at directory revision 51, with no session reporting `inputRequired` and no session carrying an `ask`. | Capture exact current device/OS/browser versions and complete lock-screen, force-stop, stale-generation, network-change, and forbidden-sink checks with a named evidence artifact before broadening the claim. |
| Existing OMP relay connectivity | **PASS** | The unchanged collab client/OMP patch retains the signed 28,800-second PASS, the 27,600-second externally contaminated current-pin rerun, and the protected 28,800-second replacement completed on 2026-08-21 with 22 transitions, `finalPhase: "live"`, exit code 0, and no restart. Candidate `.19` also passed a bounded real Pixel smoke through the default relay: View, Control upgrade, prompt, interrupt, and return. | Re-run endurance only when relay/client/host protocol bytes change; keep a bounded real smoke per candidate. |
| Platform install/doctor/uninstall | **PASS** | Both advertised hosts passed complete signed-candidate `.19` artifact lifecycles. Debian included migration/rollback and reboot/lingering; macOS included control-plane reboot/login persistence. Windows now passes the same source-level lifecycle through reboot→interactive-login, `doctor` 17/17, rotation, upgrade/rollback, patched OMP publication, and uninstall, but remains unadvertised until exact signed gateway and OMP artifacts repeat it. | Requalify exact signed bytes on every advertised host. |
| Configuration migration and rollback | **PASS** | Candidate `.19` upgraded from `v0.1.0-alpha`, preserved configuration/token/modes, exercised requested and history-selected rollback in both directions, repaired induced divergence, and passed all `107/107` rollback invariants. The `.18` start-rate failure is retained as the regression this candidate closes. | Repeat predecessor→candidate migration and rollback for later release lines. |
| Private vulnerability reporting | **PASS** | GitHub private vulnerability reporting is enabled and repository security guidance identifies the private path. This is hosting state and pin-independent; it was rechecked before alpha promotion. | Reverify before publication. |
| Release signing, SBOM, and provenance | **PASS** | `v0.1.0-prealpha.19` published six assets from source `e1b91763…`; archive SHA-256 is `f6e01c4b96b5630fccbb3c79f0a0dae1677e316990d869db6e300ce96605a762`. `SHA256SUMS`, all three GitHub attestations, and all three Cosign bundles verified against the exact tag/workflow, independently on the qualification hosts where applicable. | Verify the final tag and compare executable bytes with `.19`. |
| Known limitations and exact compatibility matrix | **PASS** | This ledger, `COMPATIBILITY.md`, and the release notes name exact OMP `v17.3.8`/`858f7dd9`, Debian/macOS/Pixel versions, TUN-mode Serve requirement, unadvertised Windows, Android radio-transition limitation, Preview fallback, and unsupported relay/deployment modes. | Keep synchronized with every candidate and release. |
| Self-hosted/proxied relay | **N/A** | Explicitly unsupported and deferred. **Pin classification 2026-08-21: pin-independent.** `N/A` here is deliberate policy rather than an untested result. Self-hosted or proxied forwarding stays unsupported because `SECURITY.md` documents that any forwarder in front of the loopback listener defeats identity checking, so the OMP pin does not apply. It must not be advertised without a dedicated long-lived WebSocket soak and its own security qualification. | Do not advertise; a future release needs the dedicated WebSocket soak and a separate security qualification. |

> **Candidate artifacts `v0.1.0-prealpha.14`, `.15`, and `.16` have been deleted.** The build
> identifiers and tag names cited below therefore no longer resolve to a downloadable artifact.
> Nothing depends on their presence: `main` carries all of the code and evidence they were cut
> from, there were no consumers beyond machines that have since been destroyed, and a
> measurement does not stop being true because the artifact that produced it is gone. This is a
> traceability gap, not a correctness one. The next candidate will be cut when an artifact is
> actually needed.

## Alpha qualification blockers (historical)

The alpha decision was **NO-GO** until the following were closed. All six closed for the exact
alpha combinations recorded in the historical section above:

1. ~~at least one proposed host platform passes its complete native lifecycle and security matrix
   from the signed candidate artifact, including reboot/login persistence, upgrade, rollback,
   diagnostics, token rotation, and uninstall~~ — **closed 2026-08-20 for Debian 13 on x86-64**.
   Signed candidate `v0.1.0-prealpha.17`, independently verified from a clean directory
   (`shasum -c` OK, `gh attestation verify` exit 0, `cosign verify-blob` "Verified OK" for the
   archive, SBOM and `SHA256SUMS` against certificate identity
   `.../release.yml@refs/tags/v0.1.0-prealpha.17`), passed **49 assertions with 0 failures** across
   `artifact`, `lifecycle`, `migration`, `rollback`, `persistence` and `uninstall` on a fresh
   droplet, with `identity` passing separately earlier the same day. Per the rule below this list,
   that permits advertising **only** Debian 13 x86-64 with this exact candidate;
2. ~~real Tailscale Serve authorization and LAN/public isolation pass from distinct allowed and
   denied devices against that candidate host~~ — **closed 2026-08-20**. A tagged droplet
   (`tag:omp-session-gateway`) carries no user identity and was refused `403`
   through Serve on both `/api/v1/sessions` and `/`; this workstation, a distinct user-owned node,
   got `403` for a non-allowlisted real identity, `403` for a forged `Tailscale-User-Login` naming an
   allowlisted login, and `200` for the real allowlisted identity, with a forged header from an
   already-allowlisted caller simply ignored. Direct LAN and Tailscale-IP access already failed and
   Funnel is disabled. Measured against candidate `v0.1.0-prealpha.16`;
3. ~~a physical Android device passes install, automatic discovery, View, Control, interrupt,
   generation replacement, lock/resume, network-change, back-navigation, reconnect, and leak
   checks~~ — **closed 2026-08-21 by explicit founder decision to advertise without the two
   environment-blocked gates.** Everything the project is answerable for passed on the physical
   Pixel 10 Pro with Chrome `151.0.7922.139` against `v0.1.0-prealpha.17`: automatic discovery
   without Refresh, View and Control each `200` with a `no-store` capability, stale View **and**
   stale Control each `409 generation_mismatch`, unknown session `404`, generation replacement with
   revoke ordered before publish, lock/resume, PWA installability, the full attention appear-and-clear
   cycle, back navigation as a real history entry carrying no fragment, and a self-verifying
   capability-leak sweep clean across all seven forbidden sinks.
   **Network-change and reconnect are not proven and are advertised as a known limitation.** They are
   blocked by [#65](https://github.com/alphastorm/omp-session-gateway/issues/65), a Chrome-for-Android
   defect measured with the device healthy throughout — airplane off, Wi-Fi on, `ping 1.1.1.1` at 0%
   loss — while Chrome's own DevTools socket stopped answering with six Chrome processes alive, and
   `am force-stop` restored it instantly. It survived a Chrome 150 to 151 major-version bump. This is
   recorded as an environment defect with its evidence rather than dropped, and it was **not** closed
   by re-running until Chrome cooperated;
4. ~~the candidate OMP path passes branch, saved-session resume, and applicable default-relay
   connectivity scenarios without exposing a stale capability~~ — **closed 2026-08-20**. Switch
   ordering, socket-close crash removal, and TTL-sweeper expiry were measured at the `v17.3.8` pin on
   2026-08-19. Branch and resume were then measured against `v0.1.0-prealpha.17` on a session
   carrying **real conversation history** — two authored turns, the second explicitly referring back
   to the first, with real tool calls and a file written and then edited.
   **Branch:** generation 1 went absent at revision 21 and generation 2 appeared at revision 22, a
   977 ms window in which no card existed; the sequence was never `200`→`200`. Both stale
   `view` **and** stale `control` launches returned `409 generation_mismatch` while generation 2 was
   live, the live generation returned `200`, and generation `0` returned `400`. A second
   revoke/publish pair followed about 35 s later, independently reproducing the pair-of-pairs
   behaviour first recorded in `docs/LIFECYCLE_BRANCH_RESUME.md`.
   **Exit and resume:** `/exit` removed the record 6.6 s later, after which both generations of the
   exited instance returned `404 not_found`. `--continue` republished 13.8 s later as a **new
   instance** at generation 1, and the pre-exit instance stayed `404` for both generations
   throughout. Conversation history survived: the resumed session recalled the specific distinction
   discussed before the branch without re-reading the file. It also correctly reported the branched
   timeline's bullet count rather than the file's, which is worth knowing — a branch forks the
   conversation, not the filesystem;
5. ~~the native, Tailscale, relay, Android, browser, and signed-artifact rows are re-run at the
   current `v17.3.8` pin~~ — **closed 2026-08-21**. No ledger row is stale or indeterminate. **Audited 2026-08-20**: of the 23 ledger rows, **10 are current**
   (evidence at the refreshed pin or from a candidate built after it), **6 were stale**; **three
   have since been re-run at `v0.1.0-prealpha.17` on 2026-08-20/21** (Release signing/SBOM/provenance,
   Fifty-publisher capacity, and the host half of Three real OMP processes auto-discover), and on 2026-08-21 the remaining **three Android rows were re-run**
   at `v0.1.0-prealpha.17` on Chrome `151.0.7922.139`, so **no ledger row is stale**. The only
   evidence still outstanding anywhere is the network-change and reconnect pair inside the Android
   lock/resume row, which is blocked by the Chrome defect in
   [#65](https://github.com/alphastorm/omp-session-gateway/issues/65) rather than by a missing run
   and **7 were indeterminate** because their text cited no pin or date at all. **All seven were classified on
   2026-08-21 and each now states its position explicitly**: `Private vulnerability reporting` and the
   `Self-hosted/proxied relay` row are pin-independent, the latter being deliberate policy rather than an
   untested result; `Known limitations and exact compatibility matrix` is mixed, its boundary statements
   pin-independent while its *exact* baseline must be re-checked at every candidate; `Exact OMP and
   collab-web provenance` is repository state carrying `UPSTREAM.lock.json`'s own 2026-08-19 observation
   rather than a candidate revalidation; and `Loopback-only exposure`, `Real View and Control behavior`
   and `Platform install/doctor/uninstall` needed re-runs, of which the first and third are now
   superseded for Debian 13 and macOS 26.6.1 by the signed-candidate runs and the second is
   half-re-measured, its launch-authorization results current and its interaction half still open
   indeterminate** and are the priority: an indeterminate row cannot be treated as re-run, because doing
   so is exactly how a stale row gets silently promoted.
   **The relay component was originally accepted by explicit one-time exception, and the desirable
   full-window follow-up is now complete.** The earlier re-run reached 27,600 of 28,800 seconds,
   96% of the window, before an acceptance run fired real launches into the soak host's own relay
   room. That external contamination remains recorded as a failure rather than rewritten. A
   protected replacement ran the complete 28,800-second authored window on 2026-08-21, crossed 22
   relay-room transitions, finished `live`, and exited 0 with no process restart. The named record
   is `~/.local/share/omp-session-gateway/test/v0.1.0-alpha.1/soak/protected-relay-soak-8h.json`;
   the harness has no memory metric, so this run makes no RSS claim. This closes the outstanding
   current-alpha-pin full-window requirement; and
6. ~~every advertised host/client combination completes its candidate-artifact capability-leak
   acceptance across all forbidden sinks~~ — **closed 2026-08-20 for the one advertised
   combination**. Against `v0.1.0-prealpha.17` on a physical Pixel 10 Pro running Chrome
   `151.0.7922.139`, `scripts/android-leak-sweep.ts` planted a synthetic secret in all 7 forbidden
   sinks and detected all 7 before removing them, so the detector is proven live rather than
   vacuously clean. The real 66-character capability was then absent from every sink, from resource
   timings, and from the DOM; the launch response was `200` with `no-store, max-age=0`; the address
   bar retained a 0-character fragment. This covers the Linux host and this Android client only.

Blocker 7, the silent publisher latch
([#61](https://github.com/alphastorm/omp-session-gateway/issues/61)), is **closed**. The fix is
mirrored here as the sixth handoff commit (`bfc555227`) and was clean-room verified on 2026-08-20:
all six commits `git am` onto pristine `858f7dd9` from a fresh shallow clone,
`registry-publisher.test.ts` passes 13/13 and `controller.test.ts` 15/15. The behavioral gap was
then closed with a live tracer against an isolated gateway on the activated release, recording the
full state-faithful transition `publishing` → `retrying (attempt 8: EACCES)` → `publishing` with no
manual `/collab` or process restart. The fault denied read access to a launcher-scoped
`OMP_GATEWAY_PUBLISHER_TOKEN_PATH` copy and restarted the isolated gateway to force a token reread;
the card vanished and returned about 20 seconds after access was restored. Production was
untouched: the daemon stayed alive on the candidate and the tailnet origin kept answering `200`.
Process, instance, and publisher-token fingerprints are intentionally omitted from this public
ledger.

Passing one platform permits advertising only that exact qualified platform/version combination.
It does not promote untested rows or broaden the pinned OMP range. Two platforms passed, so two
are advertised; every other host, browser, device and OMP version remains unqualified.

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
- Tagged Tailscale source devices, Tailscale Funnel, Portal Tunnel, public/LAN HTTP, self-hosted
  relays, WebAuthn gating, TWA/native clients, and multi-host federation are not supported by this
  release line. Background Web Push is implemented but remains unqualified until the physical
  Android closed-PWA, lock-screen, tap-to-Control, stale-generation, force-stop, and network matrix
  passes.
- Gateway rollback-by-reinstall from candidate `.20` to alpha.1 passed on Debian and macOS. OMP
  rollback remains a separate manual operation: stop patched OMP processes, repoint the versioned
  symlink to the exact alpha v17.3.8 build, and repeat source/tree/version/config assertions before
  restarting. Isolated alpha→beta→alpha symlink/config reversal passed; paired gateway/OMP
  update/rollback is not implemented or claimed.

## Updating this ledger

Change a row only with a reproducible command result or a named manual qualification record that
identifies the source commit, artifact checksum, OS/browser/device versions, deployment path, and
date. Record failures as failures; do not turn a narrower automated pass into a broader platform
claim. Update this file, `COMPATIBILITY.md`, `CHANGELOG.md`, and release notes together whenever a
support claim or gate changes.
