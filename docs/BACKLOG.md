# Backlog

GitHub issues are the active work queue. [Release status](RELEASE_STATUS.md) records qualification;
[the changelog](../CHANGELOG.md) records shipped work. This file keeps only open product direction.

Stable v0.5.0 is published with native stock-OMP integration and approved candidate evidence.
The published-byte local/Android checks are complete; exact evidence and remaining limits live in
the [release ledger](RELEASE_STATUS.md).

## Current

- Release the worker-navigation fix (ADR-018 amendment) and confirm a clean first-attempt
  post-release View/Control smoke across the upgrade.
- Decide notification-click window reuse: the worker picks a "dashboard" window by `client.url`,
  which Chromium reports as the creation URL, so a live `/client/` page can be navigated to the
  notification route. Settle the Android WebAPK single-window behavior before changing it.
- Qualify the specialized attention and branch/resume scenarios separately from the core matrix.
- Qualify background Push on the advertised physical Android/browser combination.
- Decide whether to advertise Windows only after exact mainline discovery and signed-candidate
  install/reboot-login/upgrade/rollback/uninstall acceptance.
- Track upstream discovery/query compatibility after PR #11908 (`4999b98bd5`), shipped in
  `v18.1.20`; consume the supported seam rather than maintaining a downstream OMP patch.

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
