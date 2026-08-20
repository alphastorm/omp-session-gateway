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

### Consequence for testing

`install` cannot succeed over any non-interactive transport. Measured: over WinRM the install
staged a version, registered nothing durable, and failed with

```
service installed but the loopback readiness proof did not become valid
```

leaving no Scheduled Task, an empty `current.json`, and nothing listening on the loopback port.
That is the correct behaviour — it refused to claim success — and it is a useful negative
result: **the readiness proof genuinely detects a service that cannot start.**

Confirmed the session state directly rather than inferring it: `query session` showed the console
session with no username and `Get-Process explorer` returned nothing.

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

Remaining to close the row, in preference order:

1. Drive a real RDP logon (for example `xfreerdp`) to create the interactive session, then
   `install`, reboot, log in again, and assert the task started with no manual step. This proves
   the behaviour the product actually promises on Windows.
2. Decide the product question above. If the gateway should survive a reboot with no login on
   Windows, the task needs a boot trigger and a non-interactive principal, which is a behaviour
   change with its own privilege and token-ACL consequences and must not be made casually.

Until one of those happens, `Windows host lifecycle` stays **PARTIAL**, and the reason is now
specific: not "untested", but "starts at interactive logon, and that logon has not been
exercised across a reboot".

## Cost and hygiene

Two instances were created and destroyed during this work; the account was verified empty of
`omp-winqual-*` instances and startup scripts afterwards. The captured administrator password was
shredded locally. No instance identifier, address, or credential is recorded in this repository.
