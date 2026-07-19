# `apps/web`

Implementation of the **OMP Sessions** dashboard PWA.

Implemented states:

- authenticated live session list;
- empty state with gateway/OMP setup guidance;
- desktop offline or unreachable;
- unauthorized identity;
- SSE reconnect and snapshot recovery;
- View and Control launch actions;
- stale generation, expired session, and process-ended errors;
- privacy/security guidance.

Passkey enrollment is deferred until after the v1 path is qualified.

The dashboard receives metadata only. It must not render transcripts, prefetch capabilities, or implement the OMP collaboration protocol.

The service worker may cache only immutable versioned application-shell assets. It must bypass `/api/`, `/client/`, launch responses, and collaboration navigation. Use no third-party runtime scripts, fonts, analytics, or CDNs.
