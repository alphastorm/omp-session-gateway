# Backlog

GitHub issues are the active work queue. [Release status](RELEASE_STATUS.md) records qualification;
[the changelog](../CHANGELOG.md) records shipped work. This file keeps only open product direction.

## Current

- Qualify and publish the signed stable v0.1.0 successor against the exact advertised matrix.
- Close the remaining Android and lifecycle scenarios required by that stable claim.
- Qualify background Push on the advertised physical Android/browser combination.
- Decide whether to advertise Windows; replace the PowerShell publisher-token ACL probe with native
  `icacls`/`whoami` only as part of that qualified support path.
- Keep the OMP patch rebased on the pinned release and upstream the smallest generally useful
  controller/API pieces when maintainers are receptive.

## Candidate follow-ups

- WebAuthn/passkey verification before Control launch.
- Session aliases, favorites, and per-session control policy.
- More granular tailnet/device posture guidance.
- A separately threat-modeled signed update mechanism.
- Physical Android qualification for closed-PWA, force-stop, lock-screen, stale-notification tap,
  and network-change Push behavior.

## Later or optional

- A qualified self-hosted relay deployment mode.
- Trusted Web Activity packaging.
- Multiple desktop hosts with explicit grouping.
- Read-only family or team dashboard roles.

## Not planned

- A native Android collaboration client.
- A public hosted control plane or Tailscale Funnel support.
- Transcript indexing or persistence in the gateway.
- Replacing OMP's UI or collaboration protocol.
