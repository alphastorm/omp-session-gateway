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
- offline state that says the desktop is unreachable and does not display stale session metadata;
- no Push API or killed-browser notification delivery in v1; optional foreground notifications require an explicit permission action, keep transition state volatile, and open only the dashboard;
- Android back behavior: collab client returns to the session directory, with no secret-bearing history entry;
- account for the virtual keyboard and `visualViewport` behavior in the embedded/pinned collab-web build;
- test Chrome stable and at least one Chromium-based alternative if supported.

Do not cache API responses or collab client navigations. A PWA does not need to be an offline copy of sensitive runtime state.

Foreground notifications may expose the bounded session title or directory label on the Android
lock screen. The dashboard must warn about that disclosure before its only permission action,
never prompt on load, and recommend one live dashboard tab because volatile per-tab dedupe can
produce one notification per tab. Physical Android qualification must inspect lock-screen text,
permission behavior, notification taps, lock/resume, and SSE reconnects. Desktop emulation does
not establish background or killed-browser support.

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

Only reconsider a native UI if requirements emerge that cannot be delivered adequately by the browser, such as reliable background push workflows, deep OS integration, advanced notification actions, or enterprise mobile-device-management APIs. Even then, prefer embedding/reusing the web collaboration client rather than independently implementing the OMP wire protocol.

## Why not a generic WebView wrapper?

A custom WebView creates more responsibility for cookie/storage policy, navigation, updates, security patching, and platform integration. TWA uses the user's browser engine and verified site ownership, while the plain PWA is simpler still. A WebView wrapper offers no meaningful v1 advantage.
