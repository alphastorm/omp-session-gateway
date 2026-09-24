# Backlog

GitHub issues are the active work queue. [Release status](RELEASE_STATUS.md) records qualification;
[the changelog](../CHANGELOG.md) records shipped work. This file keeps only open product direction.

The latest stable release ships native stock-OMP integration. Exact evidence and remaining limits
live in the [release ledger](RELEASE_STATUS.md).

## Current

- Decide notification-click window reuse: the worker picks a "dashboard" window by `client.url`,
  which Chromium reports as the creation URL, so a live `/client/` page can be navigated to the
  notification route. Settle the Android WebAPK single-window behavior before changing it.
- Qualify the specialized attention and branch/resume scenarios separately from the core matrix.
- Qualify background Push on the advertised physical Android/browser combination.
- Decide whether to advertise Windows only after exact mainline discovery and signed-candidate
  install/reboot-login/upgrade/rollback/uninstall acceptance.
- Track upstream discovery/query compatibility after PR #11908 (`4999b98bd5`), shipped in
  `v18.1.20`. The gateway ignores fields OMP adds under registry v1 (ADR-028); a version bump or a
  changed type for a field it reads still needs a gateway change.

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
- Alternative remote paths such as Cloudflare Tunnel (#158) or Portal Tunnel (#74), only with broad
  demand; Tailscale Serve stays the only supported path.

## Not planned

- A native Android collaboration client.
- A public hosted control plane or Tailscale Funnel support.
- Transcript indexing or persistence in the gateway.
- Replacing OMP's UI or collaboration protocol.
