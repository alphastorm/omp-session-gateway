# Windows qualification

Hosted CI (`platform-qualification.yml`, job `windows-service-lifecycle`) proves install,
named-pipe derivation, token ACLs, rotation and uninstall on Windows. The runner is then
destroyed, so nothing there can prove the service comes back after a reboot. That is the same
class of defect as issue #69 on Linux, which was invisible to every install-time check and only
appeared across a boot.

This document records what a persistent-VM attempt established on 2026-08-20, so the next
attempt starts from measurements rather than assumptions.

## Finding: the Windows gateway is login-gated by design

`apps/gateway/src/service.ts:84` registers the Scheduled Task with:

```xml
<Triggers><LogonTrigger><Enabled>true</Enabled></LogonTrigger></Triggers>
<Principals><Principal id="Author"><LogonType>InteractiveToken</LogonType>…</Principals>
```

A `LogonTrigger` fires on interactive logon and an `InteractiveToken` principal can only run
while that session exists. **The Windows gateway therefore does not start at boot. It starts at
the next interactive logon.**

This is coherent with the product being a user-level agent, but it is not symmetric across
platforms, and the asymmetry is user-visible:

| Platform | Mechanism | After a reboot with nobody logged in |
| --- | --- | --- |
| Linux | systemd user unit, `WantedBy=default.target`, plus `loginctl enable-linger` (`service.ts:63`) | **Runs.** Proven on hardware after issue #69: class `manager`, no interactive login. |
| macOS | LaunchAgent, `RunAtLoad` (`service.ts:71`) | Does not run until the user logs in. |
| Windows | Scheduled Task, `LogonTrigger` + `InteractiveToken` (`service.ts:84`) | Does not run until the user logs in. |

Linux is the outlier because lingering was enabled deliberately. Whether Windows and macOS
should match it is a product decision, not a bug to fix silently — but the operational answer to
"will my phone see sessions after the computer reboots?" differs by platform today and should be
documented wherever install is described.

### The install failure is a separate defect, not the logon gating

An early reading blamed the non-interactive transport for `install` failing with

```
service installed but the loopback readiness proof did not become valid
```

**That was wrong, and a later run refuted it.** An RDP logon was established first — `query
session` showed `rdp-tcp#1  Administrator  Active` and `explorer` was running — and `install`
failed identically. The interactive session is required for the task to *run*, but it is not why
install fails.

Polling every 3 s during the install shows what actually happens:

| t | task | state | lastResult | bun procs | listener :4317 |
| --- | --- | --- | --- | --- | --- |
| 21s | absent | – | – | 1 | 0 |
| 24s | present | Running | 267009 | 2 | 0 |
| 39s | present | Running | 267009 | 2 | 0 |
| 42s | present | Ready | 267014 | 2 | 0 |
| 45s | absent | – | – | 0 | 0 |

The Scheduled Task is created and genuinely runs — two `bun` processes, the daemon alive for
about 18 s — but it never binds the loopback listener before `install` gives up and rolls back.

The cause is a fixed 15 s readiness budget (`cli.ts:200`) against ACL verification that spawns a
separate PowerShell process per path (`config.ts:66-95`, reached from 7 call sites). A single
minimal `Get-Acl` spawn on this 2-vCPU host measured 2132, 1780, 1787, 1810, 1762 ms — mean
1854 ms. Several of those exhaust the budget before the HTTP listener is reached.

Tracked as [#90](https://github.com/alphastorm/omp-session-gateway/issues/90). It plausibly also
explains the Windows CI job's recorded flakiness (`685 ms → 13.7 s → >30 s` spawn variance),
which has been handled by rerunning rather than diagnosed.

What survives from the original reading is narrower but still true: the readiness proof fails
closed, rolls back completely, and does not claim success for a service that never served.

## Provider findings (Vultr)

Vultr was evaluated as the persistent-Windows provider. Usable, but only via WinRM.

| Question | Result |
| --- | --- |
| Startup scripts (`script_id`) on Windows | **Never run.** Attached at create; sshd was never installed and the marker file never appeared. |
| `user_data` (Cloudbase-Init) on Windows | **Never runs.** `Get-Service cloudbase-init` does not exist on the image, so there is no agent to consume it. |
| SSH | Not available. Keys are injected for Linux only; port 22 never opened across 25 polls (~750 s). |
| RDP 3389 | Open and reliable. |
| WinRM 5985 | **Open out of the box and works.** `Administrator` + the instance's default password over NTLM. |
| WinRM encryption | `AllowUnencrypted` is `false`; pywinrm's NTLM transport applies message-level encryption. |
| Time to WinRM | ~4–5 min from create. A plain TCP port check is misleading — it reads open during setup and then times out. Poll with a real authenticated call. |
| `default_password` | **Returned only in the create response.** It is absent from `GET /v2/instances/{id}`, so an instance whose creation response was discarded is unreachable and must be destroyed. |

Image used: Windows Server 2025 Standard (`os_id` 2514), `vc2-2c-4gb`, region `ewr`.
Measured on the VM: PowerShell 5.1, `AMD64`, Bun 1.4.0 installs cleanly, and this repository's
`bun install --frozen-lockfile` (36 packages) plus `bun run build` both succeed.

### Recipe for the next attempt

1. Create the instance and **capture `default_password` from the create response immediately**;
   it is unrecoverable afterwards.
2. Poll with an authenticated WinRM call, not a port scan.
3. Immediately restrict 5985 to the operator's egress address:
   `New-NetFirewallRule -DisplayName 'omp-winrm-locked' -LocalPort 5985 -Protocol TCP -Action Allow -RemoteAddress <egress>`.
   The default rule is profile-scoped and leaves the port world-reachable.
4. Label the instance `omp-winqual-*` so `scripts/vultr-target.ts` will accept it as disposable,
   and destroy it as soon as the lane finishes.

## What is still unproven

Automatic logon is the obvious way to create the interactive session a Scheduled Task needs, and
**Windows Server 2025 refuses it**. `AutoAdminLogon=1`, `DefaultUserName`, `DefaultPassword`,
`DefaultDomainName`, `AutoLogonCount=5` and `DisableCAD=1` were all set and verified present in
the registry; across two reboots `LogonUI` remained at the login screen and `explorer` never
started. Do not spend more time on this knob.

**RDP works and is solved.** `sdl-freerdp` connects headlessly from macOS with no X server,
because SDL uses native Cocoa; `xfreerdp` cannot, since `DISPLAY` is unset and `+auth-only`
deliberately skips the display and therefore creates no session. One short connection is enough:
an RDP logon fires the `LogonTrigger`, and a disconnected RDP session keeps its processes
running, so the client does not need to stay attached. Lock 3389 to the operator's egress
address alongside 5985.

Remaining to close the row, in order:

1. Fix [#90](https://github.com/alphastorm/omp-session-gateway/issues/90). Until `install` can
   finish on a modest Windows host, nothing downstream of it can be qualified there. This is now
   the blocker, not session creation.
2. Then, with an RDP session established: `install`, reboot, reconnect RDP to produce the logon,
   and assert the task started with no manual step. That proves what the product actually
   promises on Windows.
3. Decide the product question above. If the gateway should survive a reboot with no login on
   Windows, the task needs a boot trigger and a non-interactive principal — a behaviour change
   with its own privilege and token-ACL consequences, not to be made casually.

Until then, `Windows host lifecycle` stays **PARTIAL**. The reason is now specific and has two
parts: the gateway starts at interactive logon rather than at boot, and that logon has not been
exercised across a reboot because `install` cannot currently complete on a 2-vCPU host.

## Cost and hygiene

Two instances were created and destroyed during this work; the account was verified empty of
`omp-winqual-*` instances and startup scripts afterwards. The captured administrator password was
shredded locally. No instance identifier, address, or credential is recorded in this repository.
