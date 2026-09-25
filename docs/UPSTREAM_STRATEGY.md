# Oh My Pi upstream strategy

## Goal

Use stock OMP’s native collaboration registry/controller and keep gateway-specific policy,
Tailscale, PWA, and installers outside OMP. Users install the separate gateway service, set
`collab.autoStart` once, and keep launching plain `omp`. No fork, custom OMP build, gateway-specific
OMP plugin, or downstream OMP patch set is required or maintained by this integration.

## Landed upstream seam

[PR #11908](https://github.com/can1357/oh-my-pi/pull/11908), merge `4999b98bd5`, ships in [OMP v18.1.20](https://github.com/can1357/oh-my-pi/releases/tag/v18.1.20). Stock mainline OMP `>= 18.1.20` provides
the shared controller, opt-in `collab.autoStart`, local discovery/query registry, and
`omp collab list` / `omp collab link` commands. Earlier releases lack this registry and are
unsupported by the current gateway. This supersedes the fork prerequisite accepted in ADR-024;
ADR-028 records the cutover without rewriting the fork-era decisions or qualification evidence.

The gateway reads discovery and queries host snapshots, then resolves a link only for an explicit
launch. It never writes OMP’s discovery directory, receives unsolicited OMP publications, or
stores capabilities. The private readiness token belongs only to gateway/CLI readiness.

## Integration boundaries

- Use the published endpoint and per-host token from each discovery file, never a derived path.
- Keep the supported OMP setting contract to `collab.autoStart` alone.
- Keep HTTP/SSE, attention routing, private Tailscale authorization, and the PWA in this repository.
- Keep the pinned in-memory `collab-web` integration and its attribution independently reviewable.
- Propose generally useful registry/controller improvements upstream rather than reviving a fork
  transport or importing private APIs.
- Never fall back to process-memory inspection, terminal automation, QR decoding, or saved-session
  scraping when the supported query surface fails.

## Compatibility discipline

- Record exact engineering source and package pins in `UPSTREAM.lock.json`.
- Validate discovery, both query operations, every error code, and generation/access races.
- Preserve the liveness distinction: only `ENOENT`/`ECONNREFUSED` proves a queried host dead.
- Exercise start, stop, switch, branch, resume, and gateway restart against the real mainline host.
- Verify link formats through the pinned upstream parser without recording links.
- Repeat exact signed-artifact host/client/relay qualification before making a release claim.
  Mainline core qualification passed for the exact candidate and matrix in the
  [release ledger](RELEASE_STATUS.md), including the Windows host and Pixel background Web Push
  lanes from 0.6.0; no fork-era result transfers. Specialized attention and branch/resume remain
  outside that qualified claim.

## Communication

Cite the merged general-purpose collaboration/discovery contribution, not an obligation for OMP
to adopt the gateway. Preserve the statement that OMP Session Gateway is independent and
community-maintained unless upstream formally adopts or endorses it.

