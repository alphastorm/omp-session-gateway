# Repository agent instructions

This file applies to the entire repository unless a more specific `AGENTS.md` exists below a
subdirectory.

## Product boundary

OMP Session Gateway is a secure, local-first directory and capability broker for the browser
collaboration pages of currently running interactive Oh My Pi (OMP) processes.

- Reuse OMP's existing `packages/collab-web` client and wire protocol.
- The PWA lists sessions and launches that client; it does not render or mutate transcripts.
- Keep the gateway and the narrowly scoped OMP controller/publisher patch independently reviewable.
- Do not add terminal injection, terminal or PTY scraping, QR decoding, clipboard monitoring,
  process-memory inspection, or saved-session-file scraping.
- Do not claim affiliation with or endorsement by OMP, and do not reuse OMP artwork without
  permission.

## Sources of truth

Read the documents governing the subsystem before changing it:

- architecture or trust boundaries: `docs/DECISIONS.md`, `docs/ARCHITECTURE.md`, and
  `docs/SECURITY.md`;
- IPC or HTTP contracts: `docs/PROTOCOL.md`;
- OMP integration: `docs/OMP_INTEGRATION.md` and `UPSTREAM.lock.json`;
- release claims: `docs/TEST_PLAN.md`, `docs/COMPATIBILITY.md`, and
  `docs/RELEASE_STATUS.md`.

`UPSTREAM.lock.json` is the exact current OMP baseline. Inspect that source rather than relying on
an older prose snapshot. Update the lock, compatibility data, patch notes, and accepted decisions
together when the baseline or design changes. Keep `bun run check` green.

## Product names

- Product and repository: **OMP Session Gateway** / `omp-session-gateway`
- Management CLI: `omp-gateway`
- Daemon: `omp-gatewayd`
- Optional foreground alias: `omp-gateway serve`
- Service identifier: `omp-session-gateway`
- PWA name: **OMP Sessions**
- Default example tailnet tag: `tag:omp-session-gateway`

## Architecture and security invariants

### Network and IPC

- Production HTTP listeners bind only to `127.0.0.1` and optionally `::1`.
- Tailscale Serve over tailnet HTTPS is the supported remote path. Do not configure or document
  Tailscale Funnel as a normal path.
- Trust Tailscale identity headers only on the loopback backend behind Serve. Production rejects
  missing identity and compares normalized `Tailscale-User-Login` against an exact allowlist.
- Development auth may allow loopback clients without Tailscale, but must reject non-loopback
  sources.
- OMP publication uses a Unix-domain socket on POSIX and a current-user named pipe on Windows,
  plus a random per-install token with at least 256 bits of entropy and user-only permissions.
- The registry is memory-only. A daemon restart begins empty and live publishers repopulate it.
- Keep metadata records structurally separate from capability-bearing records.

### Capabilities

View and Control links are bearer secrets. They may exist only in:

- the live OMP process;
- authenticated local IPC request memory;
- the gateway's in-memory secret store;
- one no-store launch response; and
- volatile collaboration-client JavaScript memory.

They must never enter files, databases, ordinary logs, diagnostics, tracing, metrics, crash reports,
URLs, redirect locations, cookies, browser storage, service-worker caches, analytics, third-party
assets, screenshots, recordings, issue fixtures, or CI artifacts. JavaScript strings cannot be
reliably zeroized; minimize their lifetime and references instead of claiming zeroization.

Session-list and SSE responses contain metadata only. Fetch a capability only after an explicit View
or Control action. Launch requests include the expected generation; stale cards fail rather than
receiving a newer capability. Transfer capabilities to the same-origin pinned client in memory.

### HTTP and browser

- Validate exact `Origin` on state-changing requests and evaluate `Sec-Fetch-Site` defensively.
- Do not use wildcard CORS.
- API and launch responses are `no-store`.
- Set strict CSP, `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`, frame
  protections, and a narrow Permissions Policy.
- The service worker caches only immutable application-shell assets and bypasses navigation,
  non-GET requests, `/api/`, and collaboration-client bootstrap traffic.
- Keep runtime assets first-party; do not add analytics, remote fonts, third-party scripts, or CDNs.

## OMP integration invariants

Manual collaboration commands and automatic startup share one collaboration controller; never
duplicate `CollabHost` ownership or import unstable private APIs from an external plugin.

The supported settings contract is:

```jsonc
{
  "collab": {
    "autoStart": "off",        // "off" | "view" | "control"
    "registryEndpoint": "auto" // "auto" | "off" | explicit local IPC path
  }
}
```

- `off` preserves normal OMP behavior.
- Start only after interactive context and session initialization complete.
- Register only after the collaboration host connects successfully.
- `view` publishes only View; `control` publishes View and Control.
- Revoke generation N before publishing N+1 whenever the active host or session changes.
- Stop, shutdown, and fatal host failure unregister immediately.
- A missing gateway must not crash or materially delay OMP. Retry with bounded jittered backoff and
  no repetitive UI noise.
- Preserve `/collab`, `/collab view`, `/collab status`, `/collab stop`, `/join`, and
  `/leave` behavior.

## Reliability and bounds

- Default heartbeat is 10 seconds and TTL is 35 seconds; both remain bounded configuration values.
- Expiry uses daemon receipt time from a monotonic clock.
- Socket close may remove records immediately; TTL is the crash fallback.
- Publisher reconnect is idempotent and generation-aware.
- Bound publishers, records, frame and body sizes, SSE queues, titles, paths, and reconnect rates.
- Keep the current OMP relay for the supported path. A self-hosted or proxied relay remains
  unsupported until separately threat-modeled and soak-qualified.

## Change and release discipline

- Fix the source behavior; do not suppress failures or special-case fixtures.
- Add or update tests for every behavior change, including failure modes and secret non-persistence.
- Use distinctive synthetic secrets and keep capability and identifier leak scans green.
- Exercise the real changed surface before declaring it working.
- Advertise only the exact combinations marked qualified in `docs/RELEASE_STATUS.md` and
  `docs/COMPATIBILITY.md`.
- Update architecture, protocol, operations, compatibility, security, and changelog material when
  their contracts change. Record accepted architecture changes in `docs/DECISIONS.md`.
- Keep generated assets and unrelated refactors out of the OMP patch.
- Use Conventional Commits subjects: `type(scope): lowercase imperative description` or
  `type: lowercase imperative description`.

