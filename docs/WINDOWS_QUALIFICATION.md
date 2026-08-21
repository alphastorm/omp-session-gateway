# Windows qualification

Hosted CI (`platform-qualification.yml`, job `windows-service-lifecycle`) proves install,
named-pipe derivation, token ACLs, rotation and uninstall on Windows. The runner is then
destroyed, so nothing there can prove the service comes back after a reboot. That is the same
class of defect as issue #69 on Linux, which was invisible to every install-time check and only
appeared across a boot.

This document records the failed 2026-08-20 diagnosis and the successful 2026-08-21 persistent-VM
source acceptance. Release support still requires the signed-byte rerun described below.

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

The cause was a fixed 15 s readiness budget (`cli.ts`) against ACL verification that spawns a
separate PowerShell process per path (`config.ts`, `applyWindowsAcl` and
`assertWindowsAclPrivate`, reached from five call sites). A single minimal `Get-Acl` spawn on this
2-vCPU host measured 2132, 1780, 1787, 1810, 1762 ms — mean 1854 ms. A cold `serve` executes ten
of those spawns before it binds the listener — one for `config.json`, five for the publisher token
and the two directories it creates, four more when the push service re-verifies them — so ACL
verification alone costs ~18.5 s. The budget was gone before the listener was reached, which is
exactly the ~18 s of daemon lifetime tabulated above.

Tracked as [#90](https://github.com/alphastorm/omp-session-gateway/issues/90).
**Fixed and accepted in source on a persistent host.** `readinessBudgetMs` keeps 15 s on Linux and
macOS and allows a 60 s hard deadline on Windows. On 2026-08-21 the exact source archive from
`622c242c625f3ab23b11b55f5a6994953895ba23` completed install on the same modest 2-vCPU shape in
77,498 ms end to end, with the Scheduled Task running and the listener bound only to `127.0.0.1`.
The deadline remains fail-closed: tests pin its last legal poll and a never-ready service still
terminates at the bound. PowerShell ACL startup cost remains performance debt; the bounded fix is
enough for correctness but is not evidence that ten process spawns are efficient.

The original failure remains useful regression evidence: its readiness proof rolled back
completely and never claimed success for a service that had not served.

## Persistent-VM acceptance — 2026-08-21

Environment: Windows Server 2025 Standard build `26100`, 2 vCPU, 4 GiB, Bun `1.3.14`, and a
Vultr firewall allowing RDP/WinRM only from the operator's current `/32`. The gateway input was a
deterministic unsigned archive from source
`622c242c625f3ab23b11b55f5a6994953895ba23`, SHA-256
`f458ab376350bb03246fe60ba3401bd67927ef19b6270461fb9c441fc567c2e2`, targeting OMP
`v17.4.1` / `9350b7990d26ebf69a604edc82d8558ef04adf30`.

| Transition | Observed result |
| --- | --- |
| Cold install with an RDP interactive session | Exit 0 after 77,498 ms; task `Running`, loopback health ready, one listener on `127.0.0.1`, 44-byte publisher token owned by the current user with only current-user/SYSTEM allow ACEs. |
| Reboot before login | Both management ports went down and returned; task `Ready`, no interactive Administrator, no `4317` listener, and `status` reported installed but inactive/not ready. Config and token hashes were unchanged. |
| First interactive login after reboot | A certificate-pinned RDP login created an active Administrator session. Without `/Run` or another manual service action, the `LogonTrigger` fired after boot and the gateway reached ready in 106,388 ms; task, listener, config, and token invariants held. |
| Token rotation | Exit 0 after 55,987 ms; token changed, config did not, task and loopback readiness returned. |
| Active upgrade | A synthetic help-text-only build staged a distinct runtime and became ready after 82,287 ms; config/token were byte-identical and activation history recorded the new pointer. |
| History-selected rollback | Returned to the exact source runtime after 59,040 ms; config/token stayed byte-identical, current pointer, latest activation, service definition, and `status` agreed. |
| Tailscale/doctor | Tailscale `1.102.3` was Authenticode-valid and joined as a temporary user-owned node. TUN-mode Serve mapped HTTPS to `127.0.0.1:4317`; `doctor` passed **17/17**. Tailscale was brought down after qualification. |
| Patched OMP path | Pristine upstream `v17.4.1` accepted patch SHA-256 `abcc8866f76fc82485a42c0ce51ca19aec3b928afcddf0af1c25c35dd10ad4e2`. The Windows publisher suite passed 13/13; an unsigned `omp/17.4.1` binary (SHA-256 `4afb47e07092d8a1c14e6fbbc6ec15a5aa8b51bd78ffff25bbab299d0d942c24`) auto-published one generation with View and Control. Both launch modes returned `200` and `no-store`; a mismatched generation returned `409` with no capability; forced process termination removed the card at revision 2 in 374 ms. |
| Uninstall | Exit 0 in 4,648 ms; task, gateway/OMP processes, and listener were absent, while config and publisher token were preserved exactly. |

This accepts the source fix and the reboot→interactive-login contract. It does **not** promote
Windows yet: the gateway archive and patched OMP binary in this lane were unsigned, and the complete
`read-only.test.ts` file exposed a Windows-only fixture hang after its first six passing cases.
The final release lane must repeat against signed gateway and patched-OMP artifacts and disposition
that fixture hang rather than hiding it.

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

Latest accepted image: Windows Server 2025 Standard (`os_id` 2514), `vc2-2c-4gb`, region `ewr`,
Windows build `26100`, PowerShell 5.1, and Bun `1.3.14`. The VM also built the exact patched OMP
Windows binary successfully after installing the official `@oh-my-pi/pi-natives@17.4.1` addon.

### Reproducible provider recipe

1. Create the instance and **capture `default_password` from the create response immediately**;
   it is unrecoverable afterwards.
2. Attach a Vultr firewall group at creation that permits 3389 and 5985 only from the operator's
   current `/32`; do not wait for a guest firewall repair after public boot.
3. Poll with an authenticated WinRM call, not a port scan.
4. Verify the RDP certificate fingerprint through WinRM's local `Remote Desktop` certificate store
   before accepting it, then create the required interactive session.
5. Label the instance `omp-winqual-*`; leave no gateway, OMP, listener, or active tailnet connection
   while held, and destroy the VM immediately after the signed-candidate rerun.

## Remaining release qualification

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

Remaining to advertise Windows:

1. Build and sign the paired patched OMP distribution instead of using the unsigned source-built
   binary from this acceptance.
2. Repeat the accepted install → reboot → no-login inactive proof → RDP login → automatic start →
   `doctor`/rotation/upgrade/rollback/uninstall sequence against the exact signed gateway candidate
   and paired OMP bytes.
3. Keep the product promise explicit: Windows starts at interactive login, not unattended boot.
   Changing that would require a boot trigger and non-interactive principal with different
   privilege and token-ACL consequences; this qualification does not authorize that redesign.
4. Resolve or explicitly baseline the Windows-only `read-only.test.ts` fixture hang. The publisher
   path itself passed 13/13, the remaining isolated patch fixtures passed, and the production binary
   published and revoked correctly, but a hung fixture is not a green full-suite claim.

`Windows host lifecycle` therefore remains **PARTIAL for release**, but no longer because #90 or
reboot/login behavior is unknown. The only release blockers are exact signed-byte repetition,
paired OMP packaging, and the bounded test-hang disposition.

The 2026-08-21 scope decision deliberately stops here: alpha installations continue to require the
exact tested v17.4.1 patch. Building/signing a paired OMP distribution is deferred; before beta,
either upstream the controller/publication seam or ship and qualify a supported paired installer.
This deferral does not weaken the integration requirement or promote Windows.

## Cost and hygiene

The two 2026-08-20 probes and the successful 2026-08-21 qualification VM were destroyed. Before
the final deletion, gateway and OMP tasks were absent, no Bun/OMP process or port-4317 listener
remained, and the temporary Tailscale identity was logged out. The Vultr API then reported zero
`omp-winqual-*` instances and zero firewall groups; the captured administrator password and local
state file were shredded/removed. The one unrelated pre-existing instance was not touched. No
instance identifier, address, login, or credential is recorded in this repository.
