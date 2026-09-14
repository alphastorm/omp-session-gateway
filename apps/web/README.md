# `apps/web`

Implementation of the **OMP Sessions** dashboard PWA.

Implemented states:

- authenticated live session list;
- empty state with gateway/OMP setup guidance;
- desktop offline or unreachable;
- unauthorized identity;
- SSE reconnect and snapshot recovery, retaining stale metadata only in page memory on transport failure;
- request-specific attention queue, device-local Hold for desk and reversible Hide;
- View and Control launch actions through the pinned client's same-document, in-memory bootstrap;
- stale generation/request, unavailable role, expired session, and process-ended errors;
- explicit Settings-based Push v2 opt-in with Private/Session/Preview detail and exact-request routing;
- privacy/security guidance.

Passkey enrollment and per-Control WebAuthn verification are not implemented; ADR-008 remains a
proposal. Background Web Push and specialized attention remain outside the v0.4.0 qualified core
matrix. See the [release ledger](../../docs/RELEASE_STATUS.md).

The worker's update path still has the [ADR-018 pending-launch reservation gap](../../docs/DECISIONS.md#current-implementation-audit--2026-09-14):
the page defers its own reload, but worker activation can navigate a launch still at `/` before
it mounts `/client/`. The accepted requirement to protect pending launches remains unchanged.

The dashboard receives metadata only. It must not render transcripts, prefetch capabilities, or implement the OMP collaboration protocol.

The service worker may cache only immutable versioned application-shell assets. It must bypass `/api/`, `/client/`, launch responses, and collaboration navigation. Use no third-party runtime scripts, fonts, analytics, or CDNs.
