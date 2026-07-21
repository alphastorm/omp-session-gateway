# Implementation plan

## Milestone 0 — compatibility spike

Purpose: retire the highest-risk assumptions before broad implementation.

Deliverables:

- build/run the current OMP `packages/collab-web` client on an Android-sized browser viewport;
- connect it to a mock or real OMP collab host;
- confirm view and control behavior;
- prove a loopback dashboard served through Tailscale Serve receives expected identity headers;
- prove the phone can install/open a minimal PWA at the tailnet HTTPS origin;
- decide whether the client can be vendored as build output or should be included as a source workspace/submodule;
- record current OMP commit and link-format fixtures.

Exit criteria: no protocol/UI rewrite is required.

## Milestone 1 — gateway daemon and metadata-only PWA

Suggested commits:

1. repository/tooling/strict TypeScript setup;
2. secure config and publisher-token creation;
3. local IPC server with hello/auth and schema validation;
4. in-memory registry, generation semantics, heartbeat TTL;
5. loopback HTTP server with Tailscale identity middleware;
6. metadata list endpoint and SSE;
7. responsive PWA session list using synthetic publisher fixtures;
8. installer/autostart skeleton and `doctor`.

Exit criteria: fixture publishers appear/disappear on the Android PWA; no capability launch yet.

## Milestone 2 — just-in-time capability launch

Suggested commits:

1. split secret and metadata storage types;
2. implement launch POST with generation and origin checks;
3. vendor/pin collab-web and expose a reviewed in-memory bootstrap API;
4. connect the directory to the collab client without putting capabilities in URLs or DOM state;
5. add a same-origin `MessageChannel` path if a separate client page is required;
6. keep ephemeral-fragment support only as a temporary compatibility fallback;
7. enforce CSP/no-store/service-worker exclusions;
8. browser URL/history/storage/cache/log/test-artifact secret-leak tests.

Exit criteria: synthetic full/view links launch correctly and leave no persistent secret.

## Milestone 3 — OMP `CollabController` patch

Suggested upstream-friendly commits:

1. extract controller from `/collab` with no behavior change;
2. add controller lifecycle tests;
3. add `collab.autoStart` setting (default off);
4. add local registry publisher and protocol fixture tests;
5. wire session-generation replacement/revocation;
6. add status/diagnostic UX and documentation.

Keep formatting/refactors unrelated to the feature out of these commits.

Exit criteria: real OMP processes register automatically; manual commands remain compatible.

## Milestone 4 — cross-platform packaging and hardening

- Linux systemd-user installer and tests.
- macOS LaunchAgent installer and tests.
- Windows named-pipe/autostart implementation and ACL tests.
- Tailscale Serve setup guidance and grants example.
- load/rate-limit/fuzz tests.
- Android foreground/background/reconnect tests.
- upgrade and daemon-restart tests.
- privacy-safe diagnostics bundle.

Exit criteria: all mandatory cases in `docs/TEST_PLAN.md` pass on supported platforms.

## Milestone 5 — open-source release candidate

- public README, contribution/security policies, compatibility matrix, and attribution review;
- CI release builds, checksums, SBOM, provenance, and clean-install tests;
- private vulnerability reporting and issue-template secret warnings;
- v0.1 changelog, upgrade/rollback instructions, and support claims validated against the matrix.

Exit criteria: a maintainer can publish a signed v0.1 release candidate without architecture or security work remaining.

## Milestone 6 — optional features, in priority order

1. WebAuthn/passkey gate for control launch.
2. Session naming/favorites that store only metadata.
3. Self-hosted relay mode after WebSocket soak validation.
4. TWA wrapper with Digital Asset Links.
5. Background Push API notifications only after a separate privacy/security design.

Do not combine these remaining optional features with the v1 security-critical patch. The
foreground-only, explicitly enabled attention notification uses no Push API or persistent state.

## Work split for multiple agents

- **Agent A — OMP patch:** controller, settings, lifecycle, publisher.
- **Agent B — daemon:** IPC, registry, HTTP/auth, packaging.
- **Agent C — web:** dashboard, collab-web integration, PWA behavior.
- **Agent D — security/tests:** threat-model verification, secret leak harness, E2E and platform test matrix.

Merge through the protocol schemas and fixed fixtures. Agent D should review every launch/secret-handling path before release.
