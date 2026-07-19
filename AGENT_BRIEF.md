# Standalone implementation brief

Implement the repository **OMP Session Gateway** (`omp-session-gateway`) according to `AGENTS.md` and all files under `docs/`.

## Outcome

Produce a working v0.1 open-source system with:

- `omp-gatewayd`: a per-user, loopback-only daemon with authenticated local IPC, an in-memory live-session registry, metadata-only HTTP/SSE APIs, Tailscale identity authorization, static PWA serving, TTL cleanup, and safe diagnostics;
- `omp-gateway`: install, uninstall, status, doctor, serve-guidance, and publisher-token rotation commands;
- **OMP Sessions**: an installable Android-friendly PWA that lists every live OMP session and launches View or Control just in time without persisting collaboration capabilities;
- a pinned integration with OMP's existing `collab-web` client through a direct in-memory bootstrap; any fragment adapter is temporary and release-blocked until non-persistence is proven;
- a small backward-compatible OMP patch or supported extension integration that automatically starts collaboration and publishes each active interactive session;
- Linux, macOS, and Windows user-level service packaging to the extent claimed by the release;
- complete unit, integration, E2E, lifecycle, authorization, and secret-leak tests;
- MIT licensing, contribution/security documentation, compatibility matrix, release checklist, and public-repository hygiene.

## Required first step

Pin an exact current `can1357/oh-my-pi` commit in `UPSTREAM.lock.json` and revalidate every upstream assumption before coding. Use a supported upstream API if one now exists; otherwise implement the minimal controller/API change in `docs/OMP_INTEGRATION.md`.

## Non-negotiable constraints

- No native Android protocol rewrite in v1.
- No terminal injection, terminal scraping, QR decoding, clipboard monitoring, process-memory inspection, or persisted link discovery.
- No public listener or Tailscale Funnel default.
- No collaboration capability in logs, browser history, query parameters, cookies, browser storage, service-worker caches, diagnostics, analytics, telemetry, or issue data.
- Metadata-only session listing; explicit no-store POST for one View/Control launch.
- Loopback-only gateway with fail-closed Tailscale identity allowlisting.
- View is the default action; Control is separate and optionally WebAuthn-gated.
- Gateway failure cannot crash or materially delay OMP.
- Keep the project narrowly focused on aggregating and launching existing OMP collaboration sessions.

## Completion standard

Do not return only a plan or scaffold. Implement, test, and document a usable release candidate. Run every acceptance gate in `docs/TEST_PLAN.md`, update `CHANGELOG.md`, and leave the repository in a state that a maintainer can publish after supplying organization-specific package/release credentials.
