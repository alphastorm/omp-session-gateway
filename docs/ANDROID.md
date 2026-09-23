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
transcript, prompt, option, or answer enters these payloads. Unreleased activity-stop alerts use a
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
