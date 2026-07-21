# Changelog

All notable project changes will be documented here.

The format is based on Keep a Changelog, and the project intends to use Semantic Versioning once implementation releases begin.

## [Unreleased]
### Added

- Publish a strict metadata-only `inputRequired` boolean, surface attention-first session cards, and retain bounded host-origin response requests so a later Control guest can answer once while View remains read-only.
- Add explicitly enabled foreground browser notifications for authoritative false-to-true attention transitions; permission is never requested on load, state remains volatile, and notification taps return only to the dashboard.
- Add deterministic dashboard/service-worker tests and Android-sized Playwright coverage for attention ordering, stale-state clearing, notification dedupe, click routing, and forbidden-content canaries.

### Changed

- Pin the OMP integration and collab-web source to `can1357/oh-my-pi@89d6a8f6d14286f32f09ec9c8aa8af7b3451d2d6` (nearest release v17.0.6).
- Split the downstream OMP artifact into four reviewable commits covering controller/publisher integration, bounded pre-writer request retention, generation-scoped response-required publication, and collaboration-aware response UI/startup ordering.

### Security

- Keep prompt text, options, prefills, answers, request IDs/types/counts, and collaboration capabilities out of IPC metadata, list/SSE responses, DOM copy, notifications, service-worker messages, storage, caches, logs, diagnostics, screenshots, and traces.
- Authenticate Windows named-pipe servers with the same nonce-bound mutual HMAC handshake used on POSIX before the publisher sends any proof or capability-bearing frame.


## [0.1.0-prealpha.2] - 2026-07-21

### Fixed

- Recover established collaboration guests across transient relay room replacement with bounded exponential retries while keeping initial missing rooms and exhausted recovery terminal.

## [0.1.0-prealpha.1] - 2026-07-21

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
- Loopback-only, no-store-enforcing default-relay soak harness with bounded duration and secret-free results.

### Changed

- Replaced handoff-only `bun run check` with TypeScript, browser/client build, full test, handoff, and capability-leak gates.
- Pinned the research baseline to OMP commit `39c95e5e29b1c8b082059f57421ce445c3dffdd4` (nearest release v17.0.5).
- Kept all platform and Android support entries unadvertised until real-device and cross-OS acceptance passes.
- Qualified the final source-review-hardened OMP patch in the complete pinned upstream checkout; checks and every official TypeScript test bucket passed with documented upstream-baseline exclusions restored afterward.
- Completed an eight-hour default-relay endurance run: the read-only client remained connected for 28,804 seconds and finished in the live phase.
- Published and independently verified the immutable provenance-test `provenance-test-v0.1.0.8` from the post-soak `main` commit, including deterministic archive/SBOM/checksum reproduction, GitHub build attestations, Cosign bundles, and immutable release-asset attestations.
- Published and independently verified immutable provenance-test `provenance-test-v0.1.0.9` from protected `main`, including the mutual-authentication and reconnect hardening, current hosted Windows qualification, byte-identical exact-tag archive/SBOM/checksum reproduction, GitHub build attestations, Cosign bundles, and a signed-artifact macOS packaging/runtime smoke through Tailscale Serve; native lifecycle and physical Android gates remain open.
- Published and independently verified corrected immutable provenance-test `provenance-test-v0.1.0.10` from protected `main`, including host-suspension reconnect recovery, current hosted Windows qualification, byte-identical exact-tag archive/SBOM/checksum reproduction, GitHub build attestations, Cosign bundles, and signed-artifact macOS Serve, restart, patched-publisher, and finite-suspension smoke; native lifecycle and physical Android gates remain open.
- Documented the distinct product boundaries and best-fit workflows for OMP Session Gateway and `omp-deck` without presenting either as a universal replacement.
- Adopted the dark-first Gate visual identity across the PWA and repository, including installable platform icons, accessible View/Control hierarchy, branded social artwork, and a normative brand specification.

- Made production install a config/service/runtime transaction with prior-endpoint checks, instance-bound HMAC readiness, verified legacy-runtime rollback, exact external Serve-port guidance, and recovery uninstall that does not require a readable application config.

### Fixed

- Kept Bun's HTTP idle timeout above the SSE keepalive interval so live updates do not cycle through reconnect state.
- Close authenticated publisher sockets without a protocol-error payload after idle expiry or missing heartbeat state so the existing bounded reconnect path republishes sessions after host suspension; isolated launchers can now select the publisher-token file without replacing child-tool XDG configuration.
- Refresh the active gateway card's bounded title, directory basename, and `provider/model` metadata after live OMP name, working-directory, or model changes without rotating its generation or capabilities.
- Redirect direct, reloaded, invalid, and BFCache-restored collaboration client documents to the secret-free session directory; discard stale reconnect sends and emit a fresh guest hello before current-generation frames.
- Force a fresh collab relay transport after mobile foreground and online transitions so suspended sockets cannot remain silently stale.
- Revoke the active OMP collaboration generation before session mutation, keep manual hosts stopped when auto-start is off, force explicit relay replacements, and revoke/re-publish same-relay View/Control mode changes.
- Harden Windows config and publisher-token paths with current-user/SYSTEM-only ACLs, write Task Scheduler XML as UTF-16, run Bun directly, and wait for exact task termination during reinstall and uninstall without exposing a loopback shutdown credential.
- Bound unauthenticated IPC handshakes and authenticated publisher idleness so stalled local clients cannot exhaust publisher capacity; partial frames now use fixed-capacity buffers that are scrubbed on release.
- Made unsafe-permission test fixtures independent of the invoking shell's `umask`.
- Bound registry authentication, frame buffering, idle connections, publisher slots, private config/token reads, diagnostics command output, and launch-path decoding; verify POSIX publisher endpoint ownership; reject cross-connection instance replacement; and derive Windows pipe names from a normalized stable user identity.
- Authenticate both registry peers with fresh nonces and domain-separated HMAC proofs before capability release; never send the publisher key over IPC; reject replayed proofs and fake named-pipe servers; and enable the OMP publisher's current-user Windows named-pipe path with strict token ACL validation.
- Detect bare default-relay capabilities in leak scans and redact malformed collaboration capabilities from parser errors so they cannot enter logs or crash reports.
- Authenticate loopback startup/doctor readiness with a publisher-token HMAC challenge so another local account cannot satisfy install health checks by pre-binding the configured port.
- Stage immutable content-addressed gateway runtimes, verify their manifests and payload digests across version upgrades, idempotently reuse a verified payload during Windows reinstall, preserve the prior runtime for rollback, and retain the fresh publisher token while stopping the service if rotation restart fails.
- Ship `bun.lock`, its SHA-256, the embedded SPDX inventory, complete reviewed license texts, and the distributed OMP coding-agent patch component in deterministic release archives.
- Detect raw extensionless publisher-token files, percent-encoded legacy collaboration links, and contextual publisher-token JSON/file leaks in staged release payloads and CI leak gates.
- Reject unknown CLI options, missing values, and query-bearing API/static requests before mutation or cache admission; rate-limit repetitive denial/protocol logs; bound readiness response bodies; order PWA snapshots and SSE events by connection epoch and revision; clear stale metadata on transport loss; distinguish empty, unauthorized, offline, unavailable-action, and busy states; and arm the client handoff before capability fetch so an immediately ready collaboration window cannot race launch.
