# Android client strategy

## Decision: PWA first

Current hosts use stock mainline OMP `>= 18.1.20` with `collab.autoStart` alone: no fork, custom
OMP build, or gateway-specific OMP plugin. Install the gateway separately and retain Bun 1.4.0,
TUN-mode Tailscale Serve, and exact login allowlisting. The gateway polls
OMP metadata and fetches a capability per explicit launch without storing it; Android HTTP/SSE and
in-memory client bootstrap are unchanged. Mainline core physical-client qualification passed for
the exact Pixel 10 Pro / Android 17 / Chrome `152.0.7977.82` combination recorded in the
[release ledger](RELEASE_STATUS.md): View read-only, Control writable, prompt acceptance, return
to the directory, same-page unlock/Airplane/Doze recovery, and seven clean, detectable forbidden
capability sinks. This does not qualify new media, background Web Push, specialized attention, or
branch/resume scenarios. Fork-era results remain historical; none transfers to this cutover.

The existing OMP collaboration client is already a browser application and includes the core live-control experience. The Android deliverable should therefore be the OMP Sessions PWA that launches the existing client, not a new native implementation of the collaboration protocol.

Benefits:

- one UI/protocol implementation across desktop and Android;
- immediate compatibility with OMP's encrypted link format and future UI updates;
- no Android release cycle for ordinary web changes;
- secure HTTPS origin through the tailnet;
- home-screen installation and standalone display;
- lower risk of cryptographic/protocol divergence.

## PWA requirements

- responsive layout for a narrow phone viewport;
- web app manifest with `display: standalone`;
- maskable and standard icons generated specifically for this project;
- theme/background colors chosen by the implementer;
- minimal service worker caching only versioned static shell files;
- loaded-shell transport status that marks the last authenticated metadata stale and retains it only in page memory; authorization failure clears it;
- explicitly enabled Push v2 background alerts with per-device Private/Session/Preview detail, capability-free payloads, exact-request and generation revalidation, and one-tap Control; delivery remains best effort and outside the qualified core matrix;
- Android back behavior: collab client returns to the session directory, with no secret-bearing history entry;
- account for the virtual keyboard and `visualViewport` behavior in the embedded/pinned collab-web build;
- test Chrome stable and at least one Chromium-based alternative if supported.

Do not cache API responses or collab client navigations. A PWA does not need to be an offline copy of sensitive runtime state.

Navigation always bypasses the service worker, so a cold installed-PWA launch while fully offline
is intentionally unavailable and may remain on the browser's OS splash until connectivity returns.
An already loaded dashboard receives metadata-free SSE heartbeats every 5 seconds. After 12 seconds
of silence it closes the stream and marks the last authenticated cards stale; it does not clear
them or persist them to storage. Initial snapshot requests use a 4-second timeout, recovery requests
20 seconds. Retry delays use the upper half of 1/2/4/8/16/30-second caps. These are current runtime
bounds; the runtime differs from ADR-016's original recovery policy (see the current audit note in
[DECISIONS.md](DECISIONS.md#current-implementation-audit--2026-09-14)).

While a collaboration session is visible, adaptive same-origin gateway probes run every 15 seconds
when healthy and every 2 seconds when suspect. Hidden pages cancel idle and pending relay probes.
Browser lifecycle and network-change signals trigger remeasurement rather than proving
connectivity. Optional encrypted idle relay probes require host support; ordinary host frames
provide passive liveness. See [ARCHITECTURE.md](ARCHITECTURE.md#5-availability-behavior).

Push v2 carries bounded identity, a pending-ask count, and the chosen presentation detail;
attention includes the observed generation, while clear targets the exact request. Private uses
`OMP session needs attention` with no body. Session (the default) includes bounded session/project
labels; Preview currently falls back to Session because stock OMP supplies no preview. Visible
text can persist in Android notification history, screenshots, and wearables. No capability,
transcript, prompt, option, or answer enters these payloads. Activity-stop alerts (since v0.5.0) use a
fixed activity title and observed generation, no request ID, and the same privacy levels. Their tap
opens View after authenticated same-generation validation, never Control. This is not new physical
Android/background-Push qualification.

Permission is requested only from the explicit Settings action. The worker replaces one
notification per instance, closes only the matching request on clear, and updates the app badge.
A tap opens `/collab/:instanceId?request=:requestId`, scrubs the route, and launches Control only
after current authenticated metadata confirms that exact ask; the launch POST also revalidates
generation. Physical background qualification must cover a closed PWA, lock-screen detail,
tap-to-Control, stale/cleared notifications, force-stop, permission revocation, lock/resume,
battery policy, and Wi-Fi/cellular transitions. Passed core Android smoke does not qualify this
background-alert matrix.

## Browser-process recovery and physical qualification

Issue [#65](https://github.com/alphastorm/omp-session-gateway/issues/65) establishes a failure
outside the PWA: Android retained a working default route while Chrome failed the gateway and an
unrelated public origin, then stopped answering through its own DevTools socket. Force-stopping and
reopening Chrome restored networking. The dashboard therefore keeps bounded retries and accurate
path status, then opens recovery guidance already present in the loaded shell after 45 uninterrupted
seconds of visible failure. It does not add a public connectivity probe, reload loop, cache-busting
URL, extra EventSource, or outage-time navigation; none can restart Chrome's network service.

The physical-device driver defaults to stable Chrome. Alternate channels require explicit package,
activity, and DevTools socket selection:

    OMP_ANDROID_BROWSER_PACKAGE=com.chrome.canary \
    OMP_ANDROID_BROWSER_ACTIVITY=com.chrome.canary/com.google.android.apps.chrome.Main \
    OMP_ANDROID_DEVTOOLS_SOCKET=localabstract:chrome_devtools_remote \
    bun scripts/android-acceptance.ts "$ORIGIN" "$DISPOSABLE_SESSION_LABEL"

Lock/resume qualification uses a dedicated numeric device PIN from macOS Keychain. Store it under
the attached device's ADB serial; keep `-w` last so `security` prompts instead of placing the PIN in
shell history or argv:

    security add-generic-password -a '<adb-serial>' -s 'omp-session-gateway.android-qualification-pin' -U -w

The value must contain 4–16 decimal digits. The harness reads it directly into process memory,
reveals the primary PIN bouncer with one bounded non-secret swipe, and writes digit keyevents to one
interactive `adb shell` stdin stream. It authenticates once, requires
`isKeyguardShowing=false`, and redacts every credential-path failure. Never pass the PIN through an
environment variable, command argument, file, log, receipt, or CI secret. Pattern unlock is not a
supported qualification setup: ADB's single swipe command cannot reproduce arbitrary multi-segment
patterns without weakening the physical lock/resume gate.

Every acceptance record includes the package name, Android package version, complete
Browser.getVersion result, launch activity, and DevTools socket. Before recording evidence, the
driver reads the forwarded endpoint's Android-Package, Browser, and loopback WebSocket URL and
requires package, version, host, and port to match the selected browser and local ADB forward;
Browser.getVersion must agree again after CDP connects. A Canary result applies only to that exact
build and socket. Do not claim #65 resolved until the Stable control reproduces and the selected
Canary completes the recorded cycle gate.

## Launch UX

Shipped card behavior:

- working rows open **View**;
- waiting rows open **Control** when available and **View** otherwise; the hero names these actions **Open request** and **View transcript**;
- request-specific Control launches carry the exact opaque ask identity as well as the generation;
- mount the pinned collab client in the current standalone PWA document through its in-memory capability bootstrap;
- do not depend on `window.open`/`window.opener` in an installed Android PWA because Chrome may reuse the standalone window;
- the documented separate-page `MessageChannel` alternative is not the shipped path and is suitable only for an ordinary browser context preserving an exact same-origin opener;
- never put the capability in a URL, DOM attribute, clipboard, or persistent state;
- show a short, non-sensitive error if the generation changed, the process ended, or the requested
  role is no longer shared (`mode_unavailable`);
- never show or copy the raw link by default.

## Physical background-Push lane

`scripts/android-push-qualification.ts` is the background-Push lane, separate from the existing
ordinary-Chrome View/Control smoke. Its exported preflight is read-only. Stable qualification
supplies the signed candidate identity, exact OMP pins, retained Mac Serve origin, a host executor,
and the shared `pixel()` lease. The host executor runs argv; fixture operations do not assume the
fixture is a local child process. Stage `push-qualification-fixture.ts`, `omp-fixture.ts`,
`omp-fixture.json`, and `fixtures/push-qualification-extension.ts` together in the configured
scripts directory. Both a pinned native OMP executable and a Bun JavaScript entrypoint are accepted.

The fixture explicitly loads one qualification extension while retaining `--no-extensions` and
`--no-skills`. A private one-process `--config` overlay sets `collab.autoStart: control`; the
operator's `~/.omp/agent/config.yml` is never changed. The public initial extension command owns
the control loop. `ctx.ui.select` publishes an authoritative ask, a held `before_agent_start`
publishes known busy activity, and command-context `newSession()` replaces generation N with N+1
without replacing the instance. Preparation is aborted before provider transport: only a synthetic
model key is used. Control files are owner-only, epoch-bound, monotonically sequenced, and outside
OMP discovery. No terminal injection, private OMP import, or discovery-file editing is involved.
The fixture host needs Python 3 with `os.forkpty`, checked with the exact Bun, OMP, and staged
extension pins through the host executor before fixture creation. Device admission has no local
fixture requirement. An owned, detached holder keeps the PTY open and reads/discards its output; it never
writes terminal input. Graceful fixture stop is followed, when needed, by signals to the verified
holder process group, with a final command-line check for surviving owned OMP processes. No tmux
or Homebrew installation is needed. The local fixture was observed published idle and then absent
after cleanup with this holder.

Read-only preflight accepts only the origin; candidate identity is bound at run and cleanup.
The retained-Mac adapter injects the fixture executor, base, Bun, OMP binary, and staged scripts
directory. Its `gatewayLogsDiscarded` callback probes that host through SSH; the default probe
remains the local LaunchAgent. Pixel adb/CDP, Keychain access, the driver Bun pin, and the expected
extension-source hash remain local to the controller.

### Device admission and one-time WebAPK setup

Turn Do Not Disturb off manually for the complete qualification window. Preflight reads
`zen_mode` and each notification phase rechecks it; a schedule reactivating DND fails the phase.
The lane never changes DND or its schedules. Real sessions may continue publishing: ownership is
bound to NotificationManager's package, topic/tag, key, and post/update time, never a count of
similarly titled lock-screen rows. A new or updated unowned record re-arms the affected phase
**once**, recording `rearmCount: 1` and `rearmReason: "unowned_notification_overlap"`. A second
overlap fails. Missing required events are never retried. Unowned notifications are never dismissed;
ambiguous UI attribution still fails closed. Tap probes use Session detail to locate the fixture's
unique synthetic project label after checking its OS record.
Presentation and privacy checks are limited to that record's observed Android notification-content
subtree; text from an unrelated shade row is not attributed to the fixture.

The origin must already have granted notification permission before the run. The lane never accepts
a permission prompt as part of admission. For its negative window, it retains a browser-only CDP
connection holding an origin-scoped denial while the WebAPK task is closed. Chrome removes this
override when the connection closes. Restoration first rewarms the browser, closes the override
connection, verifies the real granted preference, and requires fresh delivery. No global permission
reset or Android runtime-permission mutation is used. Local adb forwards 9237 and 9238 are reserved
for the lane; preflight refuses occupied mappings. Interrupted cleanup removes only matching
device/stock-Chrome mappings, including an orphaned denial connection's listener.

The lane requires exactly one installed OMP Sessions WebAPK for the **origin under test**. An app
installed for the developer Mac does not qualify the retained Mac's origin. Equipment setup is a
separate explicit operation, never part of lane run or cleanup:

```sh
export PATH="$HOME/.local/lib/omp-session-gateway/bun/v1.4.0:$PATH"
bun scripts/android-webapk.ts setup "$ORIGIN"
```

Setup uses the browser's Install app UI and verifies Android package ownership; it is bounded and
idempotent. Obtain authorization before installing for another origin. The installed app is
persistent qualification equipment: the lane never uninstalls apps or clears Chrome/WebAPK data.
Development device mutations acquire `/tmp/omp-gw-pixel.lock` atomically. A lease is released only
after restoring its baseline; never remove another lane's lock. The PIN remains in Keychain and is
read only by `android-device.ts`, never echoed or copied into configuration.
Display wake checks keyguard state before sending MENU/dismiss events. On an unlocked Pixel those
events open Chrome's application menu instead of unlocking anything, intercepting subsequent
touches. The helper preserves the unlocked page and authenticates only a still-visible keyguard.

### Matrix and evidence

- Closed-PWA Private, Session, and Preview delivery; one notification across repeated current
  samples; Preview must equal Session detail for the pinned OMP contract.
- Actual lock-screen presentation observed through in-memory UIAutomator output; no screenshots
  or XML files. Notification dumps are read with `adb exec-out` and reduced to booleans/counts.
- Current attention tap revalidates the request and generation before Control; stop tap opens View
  only; same-instance stale-generation tap scrubs to `/` without a launch request.
- Authoritative clear, followed by a fresh request retained across repeated current samples.
- Browser force-stop records delivery while stopped or suppression until relaunch; both variants
  still require a fresh post-relaunch delivery.
- Origin-permission denial suppresses notifications; restoring permission must permit a fresh
  delivery. Lock/resume and forced Doze record observed behavior, not a delivery guarantee.
- Real Wi-Fi and cellular tailnet delivery, Airplane suppression, and bounded recovery. Missing
  working cellular data is a named blocked sub-phase, never substituted with Wi-Fi. Airplane
  suppression and Wi-Fi recovery are still exercised; the missing cellular result prevents a pass.
- A positive control proves the seven historical browser sinks plus notification title/body/data
  are detectable; real launch material stays in page memory during the sweep. URL/history, DOM,
  and resource timings are included. On macOS, `plutil` must confirm both LaunchAgent streams are
  `/dev/null`; evidence records `gatewayLogsDiscarded: true`, not a fictional clean empty log scan.

The complete checkpoint precedes effects and contains only an attempt UUID, identity binding hash,
closed phase, baseline booleans/preferences, an opaque SHA-256 notification-topic binding, and bounded
observations. The binding permits cleanup even after the fixture publication disappears; no raw topic
or instance identifier is checkpointed. `phaseElapsedMs` records
checkpoint-to-checkpoint time, including any explicitly recorded re-arm.
Raw OS notification keys, tags, and content remain transient. Cleanup attempts every step
even after failure: settle the owned ask, exit forced Doze/reset battery emulation, restore radios,
stop only the owned fixture, remove owned notifications, restore subscription/detail/origin
permission, and restore WebAPK task and display/keyguard state. Stopping the producer before
notification and subscription cleanup ensures that cleanup also follows fixture shutdown.
A failed cleanup remains cleanup-required;
it never becomes a passing receipt. Its error carries `pixelUnrestored: true`, poisoning the shared
stable-campaign Pixel lease; an ordinary phase failure followed by successful cleanup does not.
The private development cleanup command can recover its own retained lease only after the recorded
owner process has exited; live owners and other lanes remain untouched. Chrome and WebAPK runtime
notification-permission booleans are observed before and after, but never changed by the lane.

For a development run against an already installed gateway, provide the matching published archive
and exact pinned OMP executable. The command does not install, restart, reconfigure, or rotate the
gateway:

```sh
OMP_PUSH_FIXTURE_BINARY="$PINNED_OMP" bun scripts/android-push-qualification.ts development "$PUBLISHED_ARCHIVE"
# Resume cleanup after an interrupted development attempt:
OMP_PUSH_FIXTURE_BINARY="$PINNED_OMP" bun scripts/android-push-qualification.ts cleanup "$PUBLISHED_ARCHIVE"
```

Private checkpoints and tested evidence live under
`~/.local/share/omp-session-gateway/qualification/dev/androidPush/` with mode `0600`. They are
explicitly development evidence, never a stable receipt. Only the lead-owned `qualify:stable`
integration may qualify the exact signed candidate.

Development observations on 2026-09-25: the isolated stock OMP **18.3.0** fixture published a real
ask, held known busy across two gateway polls, returned idle, and replaced the same instance by
exactly one generation; its process was stopped. The local **v0.5.3** gateway with Pixel 10 Pro,
Android **17**, and Chrome **153.0.8010.52** delivered the three requested detail variants with the
WebAPK task closed and their lock-screen presentations verified. One full-sequence attempt recorded
delivery observations of 1.950 s (Private), 2.908 s (Session), and 1.816 s (Preview), including no
duplicate repost during each repeated observation window. A focused real attention tap separately
observed exactly one successful launch, current generation/request validation, route scrubbing,
enabled native ask controls, and an authoritative answer using Select then Send. Fresh-runtime
cleanup also removed an owned, digest-bound OS notification without a fixture publication while
preserving a separate synthetic control; both controls and the device baseline were then restored.
The 632.07-second full-sequence development attempt additionally passed attention Control and
Select/Send, known-busy-to-idle View, same-instance N+1 rejection with zero stale launch requests,
authoritative clear/fresh retention, and the `delivered_while_force_stopped` variant with fresh
post-relaunch delivery. It then exposed a harness error: its denied-permission connection had already
closed. A corrected focused probe held denial for 33.158 seconds with the WebAPK task closed,
restored the real permission, received a fresh notification, and restored the baseline in 183.23 seconds.
Later full-sequence attempts passed the permission phase but repeatedly failed
`lock_resume_verified` with an authoritative-clear timeout. Waiting for initialized notification
controls and a visible directory did not resolve that failure. The Android build was
**CP2A.260805.005**, with Bun **1.4.0** throughout.

Bounded predecessor bisection and in-memory request-correlated instrumentation observed:

| Predecessor before lock/resume | Observed result | Attempt time, including restoration |
| --- | --- | --- |
| Subscription only | Exact current request cleared | 85.027 s |
| Force-stop only | Exact current request cleared | 149.501 s |
| Permission denial/restoration only | Exact current request cleared | 211.008 s |
| Clear/fresh only | Exact current request cleared | 159.149 s |
| Stale-generation only | Exact current request cleared | 210.218 s |
| Stale-generation → clear/fresh | Exact current request cleared | 285.682 s |
| Stale-generation → clear/fresh → force-stop | First post-relaunch authoritative clear timed out, before lock/resume | Failure observed at 324.204 s |

The last row is the **smallest observed failing combined prefix**, not a proven minimal cause.
Repeating that prefix with a worker-side recorder passed: force-stop clear took 1.105 s after
authoritative resolution; subsequent lock/resume clear took 0.584 s; restoration was observed at
358.663 s. In the instrumented lock/resume probes, the displayed request matched the received
clear, the gateway held the browser's current endpoint, and both browser and OS records disappeared.
The permission probe also observed a changed endpoint correctly retained by the gateway. These
passing traces do not establish why the uninstrumented failure occurred; attaching CDP changes the
observation conditions. Those traces alone did not establish a gateway or worker product defect.

The failed combined prefix left one owned active OS notification with no corresponding browser
notification handle. Ordinary cleanup failed closed and retained the Pixel lease. A separate
restoration experiment showed that immediately closing a same-tag replacement could be followed by
its late native OS post. Waiting for that replacement's actual OS post (observed after 806 ms) before
closing its browser handle removed the owned row for a 7.588-second observation window while
preserving unrelated notifications. This was explicit cleanup, not a successful authoritative clear
or a retry of the failed phase; its connection to the original clear failure remains unestablished.

Three later repetitions kept both page and worker DevTools detached throughout force-stop,
Android-only relaunch, and the first clear. All three cleared: **0 failures in 3 trials**, with
restoration observed at 313.076, 323.434, and 327.261 seconds. Passive Android notification-service
traces placed the second enqueue for the owned tag before its cancellation by 1.171, 1.288, and
2.239 seconds respectively; no later enqueue appeared in those windows. The last two trials also
observed five additional seconds without a native repost. Browser endpoint/key digests were
unchanged and matched the gateway target throughout. This does not explain the earlier failure.
The release build emitted no selected FCM receipt diagnostics; their absence is a visibility gap,
not proof of non-delivery or receipt ordering. Native content hashes, timestamps, process roles,
and request hashes were retained; raw logcat, notification content, and XML were not.

A subsequent controlled native-API probe reproduced the orphan independently of Web Push. Each
pair started with a posted, silent synthetic notice, then an in-memory button in the existing PWA
replaced it with a different synthetic title and the same tag. After awaiting `showNotification()`,
the button found exactly one notification, closed it, and observed zero browser handles. The
button was activated by an Android touch event; page and worker DevTools were detached throughout
each observation window. Neither the gateway nor the installed worker was modified.

| Controlled condition | Valid pairs | Native orphans | Native notification-service ordering |
| --- | --- | --- | --- |
| Warm browser | 5 | 5 | Replacement enqueued 48, 63, 68, 78, and 66 ms after cancellation |
| Chrome force-stop and cold relaunch before each pair | 5 | 0 | Replacement enqueued 18, 15, 15, 3, and 20 ms before cancellation |

Every warm orphan had the canceled record's key and the replacement's content hash, not the
seed's. Its native post timestamp was also after cancellation, and it remained about 15.8 seconds
after the browser reported zero handles. No Chrome process lifecycle event occurred inside any
pair; each cold setup recorded its preceding process kill and restart. The experiment completed
in 308.214 seconds including restoration. The transient button and its in-memory state were
verified absent after reload. Each orphan was removed outside its outcome window by the explicit
native-post-observed restoration procedure. These small controlled samples demonstrate a native
ordering failure, not a production failure-rate estimate or proof of the earlier sequence's cause.

Source analysis of the exact Chrome **153.0.8010.52** implementation also limits possible repairs.
Notification resources load before the browser display acknowledgement, but the Android display
path subsequently awaits WebAPK/channel work independently of close. Android reports no native
display synchronization support; `getNotifications()` reads the browser notification database.
Consequently, neither a resolved `showNotification()` nor a returned notification handle is an
acknowledgement that Android has posted the notification. Reasserting a silent same-tag placeholder
and closing it as soon as `getNotifications()` finds it is not a native-display fence. A bounded
delay is a heuristic rather than a native-display acknowledgement. The worker now retains a
monotonic display timestamp in memory and holds an exact current-request clear until 2,000 ms
after a recent show resolves, then re-queries the browser handles before closing. The budget is
about 25 times the largest observed 78 ms late enqueue, not a delivery guarantee. Old notices
and notices inherited by a fresh worker close immediately. The existing serial push queue
preserves clear/replacement ordering; an independently replaced request is not closed.
An identical current attention replay with the same title and body updates the badge without
re-showing or extending that timestamp. Changed content and dismissed notices still show.
This reduces needless native replacements but cannot recover an already native-only orphan.
Fake-timer regressions cover the timing boundary, exact-request re-query, queued replacement,
duplicate content, changed content, dismissal, and worker restart. Physical qualification is
still required; no full-matrix pass is inferred from those tests.
The pinned Chromium sources are the
[display acknowledgement](https://github.com/chromium/chromium/blob/153.0.8010.52/content/browser/notifications/platform_notification_service_proxy.cc#L40-L53),
[asynchronous Android display](https://github.com/chromium/chromium/blob/153.0.8010.52/chrome/android/java/src/org/chromium/chrome/browser/notifications/NotificationPlatformBridge.java#L724-L784),
and [unsupported native synchronization](https://github.com/chromium/chromium/blob/153.0.8010.52/chrome/browser/notifications/notification_platform_bridge_android.cc#L444-L462).

All final device baseline booleans matched, the original granted/subscribed Preview preference was
restored after a later **10 warm + 5 cold** settled native-API run as well. All 15 pairs were valid
and left **zero native orphans**. Each awaited a same-tag replacement, waited the remaining
2,000 ms, re-queried the exact browser notice, closed it, and observed zero browser handles.
Observed show-return-to-close times were 2.010–2.030 s; detached Android-only observation
continued for 13.726–14.103 s after completion. That run took 412.195 s including restoration.
The transient button/state were absent after reload, the Python-PTY fixture had published idle
and was then absent, and the lease was released. Earlier settled-probe attempts produced no valid
samples: an application-menu popup intercepted the touch. The shared wake helper now avoids
sending MENU to an unlocked phone; its regression models real keyguard/authentication state.
This native sample supports the measured mitigation but is not an uninterrupted Web Push matrix.

The original granted/subscribed Preview preference was
restored, the owned fixture was absent, and the development Pixel lease was independently observed
released. The daily gateway, global OMP installations, and user OMP configuration were unchanged.
The complete uninterrupted matrix remains **blocked at authoritative clear**. Forced Doze, the
complete real network matrix, and the final real sink sweep have not passed end to end. These are
**tested observations**, not qualification of v0.5.3 or the future v0.6.0 candidate.

## Optional passkey/biometric gate

WebAuthn Control protection is proposed in ADR-008, not implemented in v0.4.0. There is no
`controlProtection = "passkey"` setting or enrollment flow to enable today. Device lock, narrow
tailnet policy, and prompt revocation remain the available controls. A future implementation could
use browser-managed passkey/biometric verification without introducing a native protocol client.

## When to add a Trusted Web Activity

A TWA is the preferred “native package” if the project later needs:

- Play Store distribution;
- a branded launcher/splash experience;
- verified Android App Links;
- managed-device deployment;
- a thin native bridge for carefully scoped features.

The TWA should load the same owned HTTPS PWA and be verified with Digital Asset Links. Do not put protocol/crypto logic in the Android wrapper.

## When a fully native app might be justified

Only reconsider a native UI if the qualified Web Push path proves inadequate for required delivery or OS integration. Even then, prefer a native/TWA shell that reuses the web collaboration client rather than independently implementing the OMP wire protocol.

## Why not a generic WebView wrapper?

A custom WebView creates more responsibility for cookie/storage policy, navigation, updates, security patching, and platform integration. TWA uses the user's browser engine and verified site ownership, while the plain PWA is simpler still. A WebView wrapper offers no meaningful v1 advantage.
