# Backlog

## v1 required

- [x] Compatibility spike and pinned OMP commit.
- [x] Protocol package and validators.
- [x] Secure publisher token and IPC server.
- [x] In-memory registry with generations/TTL.
- [x] Loopback HTTP, Tailscale identity middleware, allowlist.
- [x] Metadata list and SSE.
- [x] PWA dashboard and no-secret service worker policy.
- [x] Just-in-time view/control launch.
- [x] Vendored/pinned collab-web client.
- [x] In-memory collab-web bootstrap with no fragment fallback.
- [x] OMP CollabController refactor patch.
- [x] OMP auto-start and publisher patch.
- [x] Linux/macOS/Windows autostart definitions.
- [x] Secret leak test harness.
- [ ] Android and lifecycle E2E suite.
- [x] Install, doctor, uninstall, token rotation.
- [x] Update the README with a neutral comparison to [`omp-deck`](https://libraries.io/npm/omp-deck): explain that OMP Session Gateway is a minimal tailnet session directory and capability broker for already-running terminal OMP processes that reuses OMP's existing `collab-web`, rather than a persistent full agent cockpit with its own chat, task board, routines, knowledge base, and messaging integrations; state when each approach is the better fit.
- [ ] Replace `powershell.exe` in the Windows publisher-token ACL path with native `icacls`/`whoami`.
      Both the test fixture and the production `assertWindowsPublisherTokenPrivate` check spawn
      PowerShell, and the first spawn pair on `windows-2025-vs2026` is now wildly variable: 685 ms on
      2026-07-21, then 13.7 s, >30 s (timeout), and 6.6 s across three runs within 80 minutes on
      2026-08-19 — the same window in which an Ubuntu mirror stalled a CI job for 38 minutes, so the
      outlier is at least partly hosted-runner degradation. Widening budgets again is the wrong
      answer; the fixture does not need a .NET type load to set two ACEs, and every Windows OMP
      publisher start pays the production probe at runtime. Validate on a day when the runners are
      healthy.
- [ ] Re-run the native, Tailscale, relay, Android, browser, and signed-artifact qualification at
      the `v17.3.8` pin. The 2026-08-19 refresh regenerated source-level evidence only.

## v1.1 candidates

- [ ] WebAuthn/passkey gate for Control.
- [ ] Session metadata aliases/favorites.
- [ ] Per-session control policy rules.
- [ ] More granular tailnet/device posture guidance.
- [x] Keyless signed release artifacts, deterministic SPDX SBOM, and provenance workflow.
- [ ] Separately threat-modeled signed update mechanism.

## Later / optional

- [ ] Self-hosted relay deployment mode.
- [ ] TWA Android wrapper.
- [x] Background Push API privacy/security design and repository implementation.
  - [ ] Physical Android closed-PWA, force-stop, lock-screen, stale-tap, and network-change qualification.
- [ ] Multiple desktop hosts in one dashboard, with explicit host grouping.
- [ ] Read-only shared family/team dashboard roles.
