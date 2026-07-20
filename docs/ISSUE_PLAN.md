# Initial GitHub issue plan

Create these issues after publishing the repository. Each issue should link to the authoritative docs and avoid pasting real collaboration capabilities.

## Milestone M0 — contracts and security harness

### 1. Pin current OMP upstream and record compatibility baseline

**Labels:** `compatibility`, `area: omp-integration`, `release blocker`

- Replace the null commit in `UPSTREAM.lock.json`.
- Verify current collaboration, settings, extension, and collab-web paths.
- Record any deviations from this handoff in `docs/DECISIONS.md`.
- Add a repeatable upstream-refresh script or documented command.

### 2. Implement versioned protocol package and strict validators

**Labels:** `area: protocol`, `security`

- Generate or hand-write runtime validators for every schema.
- Separate metadata and secret-bearing types.
- Add positive, negative, oversized, unknown-version, and unknown-field tests.
- Define redacted test factories.

### 3. Build capability-leak test harness

**Labels:** `security`, `release blocker`

- Create synthetic view/control/token fixtures.
- Scan logs, files, browser stores, caches, diagnostics, snapshots, and CI artifacts.
- Fail on exact fixtures and meaningful substrings.
- Document permitted transient locations.

## Milestone M1 — local synthetic prototype

### 4. Implement secure token/config store and platform endpoint discovery

**Labels:** `area: gateway`, `security`

- Atomic 256-bit token creation.
- POSIX ownership/mode and symlink checks.
- Windows ACL design/tests.
- Config validation and safe defaults.

### 5. Implement authenticated NDJSON registry server

**Labels:** `area: gateway`, `area: protocol`, `security`

- Unix socket and named pipe abstractions.
- Nonce-bound mutual HMAC authentication with constant-time proof comparison and no raw key on the wire.
- Frame/connection/rate limits.
- Generation-aware ownership and disconnect behavior.

### 6. Implement in-memory registry, heartbeat TTL, and metadata events

**Labels:** `area: gateway`

- Monotonic expiry.
- Metadata/secret separation.
- Idempotent reconnect and bounded resources.
- Unit tests for generation races and stale removal.

### 7. Implement loopback HTTP auth, metadata API, and SSE

**Labels:** `area: gateway`, `security`

- Loopback-only production binding.
- Tailscale identity allowlist middleware.
- Exact Origin/Fetch Metadata protections.
- No-store/security headers and bounded SSE queues.

### 8. Build mobile-first session-directory PWA

**Labels:** `area: web`, `enhancement`

- Session cards, live SSE updates, empty/offline/auth/expired states.
- Installable manifest and Android-sized E2E tests.
- No third-party runtime assets.
- Service worker caches application shell only.

## Milestone M2 — safe collab launch

### 9. Implement generation-bound just-in-time launch endpoint

**Labels:** `area: gateway`, `area: web`, `security`

- Explicit View/Control tap.
- Expected generation required.
- One no-store JSON response.
- No redirects or capability-bearing metadata/SSE.
- CSRF, stale, expired, and permission tests.

### 10. Pin and reproducibly build OMP collab-web

**Labels:** `area: web`, `compatibility`

- Choose official artifact, source pin, or reviewed vendoring strategy.
- Record source SHA, build environment, licenses, and hashes.
- Add mock-relay integration test.

### 11. Add in-memory collab bootstrap and browser non-persistence tests

**Labels:** `area: web`, `security`, `release blocker`

- Add a direct in-memory bootstrap API to the pinned collab client.
- Use a one-time same-origin `MessageChannel` when the client lives in a child page.
- Keep fragment handling only as a temporary fallback and remove it synchronously.
- Reload returns to the gateway.
- Prove no URL, history, screenshot, trace, storage, cache, referrer, or service-worker persistence.

## Milestone M3 — OMP integration

### 12. Extract reusable OMP CollabController without behavior change

**Labels:** `area: omp-integration`, `blocked: upstream`

- Manual commands delegate to one controller.
- Preserve current links, status, participants, join/leave, and errors.
- Add concurrency and lifecycle tests.

### 13. Add OMP auto-start settings and lifecycle-safe publisher

**Labels:** `area: omp-integration`, `area: protocol`, `security`

- `off`/`view`/`control` behavior.
- Local endpoint only.
- Revoke old generation before replacement.
- Missing gateway is non-fatal with bounded retries.
- No capability logging.

### 14. Complete real OMP end-to-end tests

**Labels:** `area: omp-integration`, `area: web`, `release blocker`

- Three hosts appear automatically.
- View rejection and Control prompt/interrupt.
- Switch/branch/resume/tree/stop/shutdown/crash behavior.
- Relay reconnect and daemon restart.

## Milestone M4 — installable alpha

### 15. Implement `omp-gateway` CLI and diagnostics

**Labels:** `area: gateway`, `area: packaging`

- `serve`, `install`, `uninstall`, `status`, `doctor`, token rotation.
- Redacted diagnostics.
- Clear Tailscale policy/Serve checks.

### 16. Package Linux, macOS, and Windows user services

**Labels:** `area: packaging`

- systemd-user, LaunchAgent, Windows current-user mechanism.
- Permissions, upgrade, rollback, and uninstall tests.
- No administrator requirement unless unavoidable and documented.

### 17. Complete Android/PWA lifecycle qualification

**Labels:** `area: web`, `release blocker`

- Install, lock/resume, browser back, network transition, reconnect.
- Unauthorized identity and lost-phone revocation runbook.
- Accessibility and responsive interaction checks.

## Milestone M5 — v1 hardening

### 18. Security review and first alpha release

**Labels:** `security`, `release blocker`

- Threat-model review.
- Dependency/license audit.
- Capability-leak and long-run soak suite.
- Protected CI release, checksums, provenance, and exact compatibility notes.
- Update root security policy with supported versions and private contact.
