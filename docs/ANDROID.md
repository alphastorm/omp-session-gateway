# Android client strategy

## Decision: PWA first

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
- loaded-shell offline state that says the desktop is unreachable and removes session metadata after the bounded SSE liveness deadline;
- explicitly enabled background Web Push with fixed visible text, metadata-only payloads, exact-generation revalidation, and one-tap Control; delivery remains best effort and requires physical qualification;
- Android back behavior: collab client returns to the session directory, with no secret-bearing history entry;
- account for the virtual keyboard and `visualViewport` behavior in the embedded/pinned collab-web build;
- test Chrome stable and at least one Chromium-based alternative if supported.

Do not cache API responses or collab client navigations. A PWA does not need to be an offline copy of sensitive runtime state.

Navigation always bypasses the service worker, so a cold installed-PWA launch while fully offline is intentionally unavailable and may remain on the browser's OS splash until connectivity returns. An already loaded dashboard receives metadata-free SSE heartbeats every 5 seconds, clears all cards and closes the silent stream after 12 seconds, then retries 4-second snapshots with bounded full jitter under 1/2/4-second caps until a fresh authenticated snapshot succeeds. While a collaboration session is visible, adaptive same-origin gateway probes run every 15 seconds when healthy and every 2 seconds when suspect. Hidden pages cancel idle and pending relay probes. Browser lifecycle and network-change signals trigger a fresh gateway measurement after foregrounding; a successful measurement then rechecks the optional encrypted relay probe instead of declaring health or replacing a healthy socket. Every WebSocket connection attempt has a 10-second deadline before jittered retry resumes. Changed shells cache completely and activate automatically: an idle directory reloads through a synchronously scrubbed no-store update route, while active collaboration remains untouched and adopts the update on ordinary Back or Leave.

Background notification payloads contain only message type, `instanceId`, and generation. Visible
text is the fixed title `OMP session needs attention` with no body, so session labels and prompt
content do not enter Android notification history. Permission is requested only after the dashboard
action. A tap opens a metadata-only attention route, scrubs it immediately, and launches Control
only after exact current-state validation. Physical qualification must cover a closed PWA,
lock-screen text, tap-to-Control, stale/resolved notifications, browser force-stop, permission
revocation, lock/resume, battery policy, and Wi-Fi/cellular transitions. Desktop smoke evidence
does not establish Android support.

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

Every acceptance record includes the package name, Android package version, complete
Browser.getVersion result, launch activity, and DevTools socket. Before recording evidence, the
driver requires the CDP product version to equal the selected package version; a mismatched socket
fails the run. A Canary result applies only to that exact build and socket. Do not claim #65 resolved
until the Stable control reproduces and the selected Canary completes the recorded cycle gate.

## Launch UX

Recommended card behavior:

- tapping the card body opens **View**;
- a distinct **Control** button is present only when the OMP process published control capability;
- mount the pinned collab client in the current standalone PWA document through its in-memory capability bootstrap;
- do not depend on `window.open`/`window.opener` in an installed Android PWA because Chrome may reuse the standalone window;
- only an ordinary browser context that preserves an exact same-origin opener may use the separate `/client/` `MessageChannel` fallback;
- never put the capability in a URL, DOM attribute, clipboard, or persistent state;
- show a short, non-sensitive error if the generation changed or process ended;
- never show or copy the raw link by default.

## Optional passkey/biometric gate

Implement WebAuthn user verification before a control launch when `controlProtection = "passkey"`. On Android this can invoke the device's passkey/biometric flow through the browser. This provides strong user-presence gating while retaining the PWA architecture.

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
