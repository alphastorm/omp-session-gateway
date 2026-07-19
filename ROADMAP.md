# Roadmap

The roadmap is ordered by dependency, not calendar promises.

## Phase 0 — implementation foundation

- Public repository bootstrap, CI, issue labels, and security reporting.
- Versioned protocol package and strict validators.
- Synthetic secret fixtures and leak-detection harness.
- Current OMP baseline pinned in `UPSTREAM.lock.json`.

## Phase 1 — local gateway prototype

- Authenticated user-only IPC server.
- In-memory, generation-aware session registry with heartbeats and TTL.
- Loopback metadata API and SSE.
- Mobile-first PWA driven by synthetic publishers.

## Phase 2 — safe collaboration launch

- Just-in-time view/control launch endpoint.
- Pinned/reproducible `collab-web` build.
- Direct in-memory `collab-web` bootstrap with no capability in a URL or DOM attribute.
- Temporary fragment compatibility adapter only when upstream requires it, synchronously scrubbed and blocked from release until browser non-persistence tests pass.
- Browser storage, history, cache, and CSRF test coverage.

## Phase 3 — OMP integration

- Shared `CollabController` in OMP.
- `collab.autoStart` and local registry configuration.
- Lifecycle-safe publisher and generation revocation.
- Backward-compatible manual collaboration behavior.

## Phase 4 — installable alpha

- Linux systemd-user, macOS LaunchAgent, and Windows current-user service/autostart support.
- Tailscale Serve setup and `doctor` diagnostics.
- Android/PWA end-to-end tests.
- Signed or provenance-attested release artifacts.

## Phase 5 — v1 hardening

- Independent security review or structured community review.
- Multi-hour lifecycle and reconnect soak tests.
- Compatibility matrix across supported OMP versions.
- Stable configuration and upgrade/migration policy.

## Post-v1 candidates

- WebAuthn/passkey user verification before Control launch.
- Optional Trusted Web Activity packaging.
- Session aliases, favorites, and per-session access policy.
- Explicit multi-desktop grouping.
- Qualified self-hosted relay deployment.

## Deliberately deferred

- A fully native Android collaboration client.
- A public hosted control plane.
- Tailscale Funnel support.
- Transcript indexing or persistence in the gateway.
- General replacement for OMP's UI or collaboration protocol.
