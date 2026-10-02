# Backlog

GitHub issues are the active work queue. [Release status](RELEASE_STATUS.md) records qualification;
[the changelog](../CHANGELOG.md) records shipped work. This file keeps only open product direction.

The latest stable release ships native stock-OMP integration. Exact evidence and remaining limits
live in the [release ledger](RELEASE_STATUS.md).

## Current

- Qualify and publish v0.7.2: qualification tooling, the configured Mac Studio (Mac17,14) replacing
  the retained Scaleway Mac, and the OMP 18.4.8 engineering baseline; no gateway runtime fixes and
  no embedded-client change. Published v0.7.1 remains current stable until qualification and approval.
- Qualify the specialized attention and lifecycle (branch/resume) scenarios in the v0.7.2
  campaign. The lanes are implemented and tested; development evidence does not qualify a release.
  See [attention acceptance](ATTENTION_SPEC.md) and [lifecycle coverage](LIFECYCLE_BRANCH_RESUME.md).
- Track upstream discovery/query compatibility with the daily executable
  [upstream OMP canary](../.github/workflows/upstream-canary.yml), starting at stock `v18.1.20`.
  The gateway ignores fields OMP adds under registry v1 (ADR-028); a version bump or a
  changed type for a field it reads still needs a gateway change.

## Candidate follow-ups

- WebAuthn/passkey verification before Control launch.
- Session aliases, favorites, and per-session control policy.
- A separately threat-modeled signed update mechanism.

## Later or optional

- A qualified self-hosted relay deployment mode.
- Trusted Web Activity packaging.
- Multiple desktop hosts with explicit grouping.
- Read-only family or team dashboard roles.
- Alternative remote paths such as Cloudflare Tunnel (#158) or Portal Tunnel (#74), only with broad
  demand; Tailscale Serve stays the only supported path.

## Not planned

- A native Android collaboration client.
- A public hosted control plane or Tailscale Funnel support.
- Transcript indexing or persistence in the gateway.
- Replacing OMP's UI or collaboration protocol.
