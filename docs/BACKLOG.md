# Backlog

## v1 required

- [x] Compatibility spike and pinned OMP commit.
- [x] Protocol package and validators.
- [x] Secure publisher token and IPC server.
- [x] In-memory registry with generations/TTL.
- [x] Loopback HTTP, Tailscale identity middleware, allowlist.
- [x] Metadata list and SSE.
- [x] PWA dashboard and no-secret service worker policy.
- [x] Just-in-time view/control launch.
- [x] Vendored/pinned collab-web client.
- [x] In-memory collab-web bootstrap with no fragment fallback.
- [x] OMP CollabController refactor patch.
- [x] OMP auto-start and publisher patch.
- [x] Linux/macOS/Windows autostart definitions.
- [x] Secret leak test harness.
- [ ] Android and lifecycle E2E suite.
- [x] Install, doctor, uninstall, token rotation.
- [x] Update the README with a neutral comparison to [`omp-deck`](https://libraries.io/npm/omp-deck): explain that OMP Session Gateway is a minimal tailnet session directory and capability broker for already-running terminal OMP processes that reuses OMP's existing `collab-web`, rather than a persistent full agent cockpit with its own chat, task board, routines, knowledge base, and messaging integrations; state when each approach is the better fit.

## v1.1 candidates

- [ ] WebAuthn/passkey gate for Control.
- [ ] Session metadata aliases/favorites.
- [ ] Per-session control policy rules.
- [ ] More granular tailnet/device posture guidance.
- [x] Keyless signed release artifacts, deterministic SPDX SBOM, and provenance workflow.
- [ ] Separately threat-modeled signed update mechanism.

## Later / optional

- [ ] Self-hosted relay deployment mode.
- [ ] TWA Android wrapper.
- [x] Background Push API privacy/security design and repository implementation.
  - [ ] Physical Android closed-PWA, force-stop, lock-screen, stale-tap, and network-change qualification.
- [ ] Multiple desktop hosts in one dashboard, with explicit host grouping.
- [ ] Read-only shared family/team dashboard roles.
