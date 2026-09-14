# `apps/gateway`

Implementation of the `omp-gateway` CLI and per-user `omp-gatewayd` daemon.

Stock OMP `>= 18.1.20` supplies the collaboration controller and local registry natively. This
separately installed gateway reads that registry; no fork, custom OMP build, or gateway-specific
OMP plugin is required. Enable `collab.autoStart` once, then start plain `omp`. Deployment still
requires Bun 1.4.0 and TUN-mode Tailscale Serve; see [OMP integration](../../docs/OMP_INTEGRATION.md).

Implemented modules:

- strict configuration and private gateway-only readiness token;
- read-only OMP discovery, endpoint ownership/permission checks, and per-host query authentication;
- bounded snapshot polling and generation-bound, just-in-time link queries to OMP-owned endpoints;
- schema validation and protocol versioning;
- metadata-only in-memory registry; no capability store or cache;
- generation and poll/TTL reconciliation;
- loopback-only HTTP server;
- Tailscale Serve identity middleware and exact allowlist;
- metadata list, SSE, just-in-time launch, generic local health, and redacted local diagnostics;
- static PWA and pinned collab-web asset serving;
- `serve`, `install`, `uninstall`, `status`, `doctor`, and `rotate-readiness-token` commands;
- systemd-user, LaunchAgent, and Windows current-user integration;
- privacy-safe structured logging.

Platform service code is not a support claim: the exact v0.4.0 qualified matrix is recorded in the
[release ledger](../../docs/RELEASE_STATUS.md); Windows remains unqualified.

Do not implement a relay in this package for v1. Do not add a persistent session database.
