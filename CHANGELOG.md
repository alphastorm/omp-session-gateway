# Changelog

All notable project changes will be documented here.

The format is based on Keep a Changelog, and the project intends to use Semantic Versioning once implementation releases begin.

## [Unreleased]

### Added

- Versioned protocol package with strict publisher, metadata, SSE, launch, and secret-separation validation.
- Authenticated local IPC registry, generation revocation, monotonic TTL expiry, publisher bounds, and privacy-safe logging.
- Loopback HTTP API with Tailscale identity allowlisting, exact-Origin launch protection, SSE, security headers, and no-store responses.
- Mobile PWA with live session states, explicit View/Control actions, safe back behavior, and shell-only service-worker caching.
- Pinned OMP collab-web source with direct in-memory one-time `MessageChannel` capability bootstrap.
- Apply-ready OMP `CollabController`, auto-start, local publisher, lifecycle revocation, and test patch.
- Cross-platform user-service definitions and management commands for install, uninstall, status, doctor, token rotation, and Serve guidance.
- Deterministic redacted diagnostics archives and Bun-runtime release archives with SPDX 2.3 dependency inventories and SHA-256 manifests.
- Keyless GitHub OIDC build attestations and Cosign signatures with immutable tag-triggered pre-alpha releases and documented verification.
- Unit/integration coverage for protocol, registry, IPC, HTTP authorization and launch, config permissions, services, diagnostics, and capability leaks.
- Explicit compatibility/support matrices and a release-status gate ledger separating implemented, smoke-tested, qualified, and supported claims.
- Protected `main` with signed commits, pull-request/CI gates, immutable releases, dependency alerts, automated security updates, secret scanning, and push protection.

### Changed

- Replaced handoff-only `bun run check` with TypeScript, browser/client build, full test, handoff, and capability-leak gates.
- Pinned the research baseline to OMP commit `39c95e5e29b1c8b082059f57421ce445c3dffdd4` (nearest release v17.0.5).
- Kept all platform and Android support entries unadvertised until real-device and cross-OS acceptance passes.
- Qualified the OMP patch in a complete pinned upstream checkout; the full upstream check passed and every test bucket passed outside baseline failures reproduced without the patch.

### Fixed

- Kept Bun's HTTP idle timeout above the SSE keepalive interval so live updates do not cycle through reconnect state.
- Force a fresh collab relay transport after mobile foreground, BFCache restore, and online transitions so suspended sockets cannot remain silently stale.
- Revoke the active OMP collaboration generation before session mutation and publish its replacement only after the new session or tree state is active.
- Harden Windows config and publisher-token paths with current-user/SYSTEM-only ACLs, write Task Scheduler XML as UTF-16, and use an authenticated loopback shutdown so reinstall and uninstall cannot orphan the gateway process.
- Bound unauthenticated IPC handshakes and authenticated publisher idleness so stalled local clients cannot exhaust publisher capacity; partial frames now use fixed-capacity buffers that are scrubbed on release.
- Made unsafe-permission test fixtures independent of the invoking shell's `umask`.
