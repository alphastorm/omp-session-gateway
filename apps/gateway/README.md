# `apps/gateway`

Implementation of the `omp-gateway` CLI and per-user `omp-gatewayd` daemon.

Implemented modules:

- strict configuration and secure publisher-token store;
- platform endpoint discovery and permission checks;
- Unix-domain socket / Windows named-pipe registry server;
- schema validation and protocol versioning;
- metadata/secret-separated in-memory registry;
- generation and heartbeat/TTL reconciliation;
- loopback-only HTTP server;
- Tailscale Serve identity middleware and exact allowlist;
- metadata list, SSE, just-in-time launch, generic local health, and redacted local diagnostics;
- static PWA and pinned collab-web asset serving;
- `serve`, `install`, `uninstall`, `status`, `doctor`, and token-rotation commands;
- systemd-user, LaunchAgent, and Windows current-user integration;
- privacy-safe structured logging.

Do not implement a relay in this package for v1. Do not add a persistent session database.
