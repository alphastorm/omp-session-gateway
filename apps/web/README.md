# `apps/web`

Implementation target for the **OMP Sessions** dashboard PWA.

Required states:

- authenticated live session list;
- empty state with gateway/OMP setup guidance;
- desktop offline or unreachable;
- unauthorized identity;
- SSE reconnect and snapshot recovery;
- View and Control launch actions;
- stale generation, expired session, and process-ended errors;
- privacy/security information and authenticated identity display;
- optional passkey enrollment only after v1.

The dashboard receives metadata only. It must not render transcripts, prefetch capabilities, or implement the OMP collaboration protocol.

The service worker may cache only immutable versioned application-shell assets. It must bypass `/api/`, `/client/`, launch responses, and collaboration navigation. Use no third-party runtime scripts, fonts, analytics, or CDNs.
