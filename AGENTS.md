# Repository agent instructions

This file applies to the entire repository unless a more specific `AGENTS.md` exists below a
subdirectory.

## Product boundary

OMP Session Gateway is a secure, local-first directory and capability broker for the browser
collaboration pages of currently running interactive Oh My Pi (OMP) processes.

- Reuse OMP's existing `packages/collab-web` client and wire protocol.
- The PWA lists sessions and launches that client; it does not render or mutate transcripts.
- Consume mainline OMP’s discovery/query contract; keep gateway changes independent of OMP internals.
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
an older prose snapshot. Update the lock, compatibility data, integration notes, and accepted decisions
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
- Trust Tailscale identity headers only in `tailscale-serve` mode on the loopback backend behind
  Serve. That mode rejects missing identity and compares normalized `Tailscale-User-Login` against
  an exact allowlist. The unreleased `webauthn` mode independently verifies enrolled passkeys;
  every non-Serve path strips `Tailscale-User-*` before handling the request. Never fall back between
  authentication modes. Tailscale Serve remains the only qualified remote path.
- Development auth may allow loopback clients without Tailscale, but must reject non-loopback
  sources.
- Require stock mainline OMP `>= 18.1.20`; the controller and local registry shipped in
  PR #11908 (`4999b98bd5`), carried by `v18.1.20`.
- The gateway only reads OMP’s private discovery directory and queries each host’s published endpoint.
  Never write, rename, or unlink discovery files or sockets; never derive the endpoint from a filename.
- Per-host discovery tokens authorize queries to OMP; the gateway’s private readiness token proves
  managed loopback readiness to its CLI and is never an OMP credential.
- The registry is metadata-only and memory-only. A daemon restart begins empty; polling repopulates it.
- Keep metadata records structurally separate from transient launch responses.

### Browser authentication (ADR-030)

- WebAuthn credential enrollment requires a short-lived local foreground grant, never just a
  loopback peer. Use the normal gateway listener and state protections, not another admin service.
- Persist only public credential records/counters. Require exact HTTPS origin/RP binding and
  user presence/verification; bound and consume browser-bound challenges exactly once.
- Gateway login cookies are a distinct bearer-secret class: host-only Secure/HttpOnly/SameSite=Strict,
  one-hour absolute server lifetime, volatile token-digest table, no refresh or sliding renewal.
  Browsers may persist session cookies for restoration; no application storage, URLs, logs,
  diagnostics, service-worker caches, or artifacts may contain them. OMP capabilities remain
  forbidden in every cookie and durable sink.
- Revalidate login before SSE emission and after asynchronous OMP launch resolution. Restart
  invalidates all browser sessions. Credential maintenance requires exclusive listener ownership
  before reading mutable state and releases that ownership automatically on process death.
- Logout disposes local collaboration and clears resume intent; it cannot revoke OMP capabilities
  already issued. Host-side collaboration stop is the hard revocation mechanism.
- Push subscription opt-in survives cookie expiry, but credential revocation removes associated
  subscriptions; notification navigation authenticates before metadata/launch.
- No WebAuthn physical-client, alternate-tunnel, or per-Control-presence qualification is implied.

### Capabilities

View and Control links are bearer secrets. They may exist only in:

- the live OMP process;
- authenticated per-host query and launch request memory;
- one no-store launch response; and
- volatile collaboration-client JavaScript memory.

They must never enter files, databases, ordinary logs, diagnostics, tracing, metrics, crash reports,
URLs, redirect locations, cookies, browser storage, service-worker caches, analytics, third-party
assets, screenshots, recordings, issue fixtures, or CI artifacts. JavaScript strings cannot be
reliably zeroized; minimize their lifetime and references instead of claiming zeroization.

Session-list and SSE responses contain metadata only. Fetch a capability only after an explicit View
or Control action. Launch requests include the expected generation; stale cards fail rather than
receiving a newer capability. Transfer capabilities to the same-origin pinned client in memory. The gateway fetches each
capability from OMP at launch time and never stores or caches it, even in the registry.
Gateway log fields are numeric or boolean only; never log strings from host queries or metadata.

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
    "autoStart": "off" // "off" | "view" | "control"
  }
}
```

- `off` preserves normal OMP behavior.
- Start only after interactive context and session initialization complete.
- Register only after the collaboration host connects successfully.
- `view` permits View queries; `control` permits View and Control queries.
- Revoke generation N before publishing N+1 whenever the active host or session changes.
- Stop, shutdown, and fatal host failure unregister immediately.
- OMP publication is independent of gateway availability; OMP does not connect to the gateway.
- Preserve `/collab`, `/collab view`, `/collab status`, `/collab stop`, `/join`, and
  `/leave` behavior.

## Reliability and bounds

- `registry.heartbeatSeconds` is the discovery poll interval (default 10 seconds); TTL defaults to
  35 seconds and must exceed twice the interval. Both remain bounded configuration values.
- Expiry uses daemon receipt time from a monotonic clock.
- Only `ENOENT`/`ECONNREFUSED` proves a queried host dead. Timeouts, permission/resource errors,
  and wire errors retain its card until TTL expiry; absence from discovery removes it.
- Poll rounds coalesce, and launches revalidate generation, access, and any attention request identity.
- Bound host entries, records, query and body sizes, SSE queues, titles, and paths.
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
- Keep generated assets and unrelated refactors out of integration changes.
- Use Conventional Commits subjects: `type(scope): lowercase imperative description` or
  `type: lowercase imperative description`.

