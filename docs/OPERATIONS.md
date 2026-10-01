# Installation and operations

## 1. One-time prerequisites

- stock mainline OMP `>= 18.1.20` on PATH;
- Bun 1.4.0 installed at a persistent path for the gateway runtime;
- Tailscale installed and signed into the same tailnet on the desktop and Android phone, with
  TUN-mode networking on the gateway host (not userspace networking);
- tailnet HTTPS/DNS enabled as required by Tailscale Serve;
- a tailnet policy restricting the gateway host’s HTTPS service to the intended user/device posture;
- a browser/host combination qualified for the exact gateway artifact before claiming support.

[PR #11908](https://github.com/can1357/oh-my-pi/pull/11908), merge `4999b98bd5`, ships in [OMP v18.1.20](https://github.com/can1357/oh-my-pi/releases/tag/v18.1.20). Stock OMP is sufficient: set
`collab.autoStart` once, then use plain `omp`. The gateway only reads OMP’s discovery directory
and queries each host. No fork, custom OMP build, gateway-specific OMP plugin, or shared
publication credential is needed. Install the separate gateway service once.

**Install the [latest stable release](https://github.com/alphastorm/omp-session-gateway/releases/latest).**
Its qualification, publication, and published-byte checks are recorded in the
[release ledger](RELEASE_STATUS.md) and its changes in the [changelog](../CHANGELOG.md); use the
[compatibility policy](COMPATIBILITY.md) for its support limits. Published `v0.3.0` and `v0.2.1`
retain their **fork-era** patched OMP v18.1.14 and v17.4.1 evidence respectively; use each tag’s
matching instructions for those artifacts. Gateway rollback alone neither switches OMP nor
restores fork-era configuration.

The system is zero-effort per OMP session, not zero-effort to install. Initial Tailscale login,
gateway installation, and OMP configuration happen once.

For v1 header-based authorization, the Android source must be a user-authenticated Tailscale device. Tagged source devices do not receive the user identity header used by the default auth mode.

## 2. CLI and daemon installation

Use the published Bun-runtime archive, not a source checkout or candidate tag, for normal
installation. Follow [Verify a published build](RELEASE.md#verify-a-published-build) before
extracting or executing it.

**Upgrading from a fork-era gateway?** Complete the matching-old-CLI stopped-service step below
first. Do not run the new installer over an active fork-era service.

From the directory containing the verified download, run as the desktop user, not root. Replace
the example origin and login with the deployment’s exact Tailscale HTTPS origin and allowlist:

```sh
tar -xf omp-session-gateway-*-bun.tar
cd omp-session-gateway-*-bun
bun apps/gateway/src/cli.js install \
  --origin https://host.tailnet.ts.net \
  --allow you@example.com
bun apps/gateway/src/cli.js serve-guidance
```

On Windows, run the same steps in PowerShell, one command per line; Windows 10 and later include
`tar`:

```powershell
tar -xf (Get-Item omp-session-gateway-*-bun.tar).Name
cd omp-session-gateway-*-bun
bun apps/gateway/src/cli.js install --origin https://host.tailnet.ts.net --allow you@example.com
bun apps/gateway/src/cli.js serve-guidance
```

The archive contains one bundled JavaScript CLI and static web assets, not separate native
`omp-gateway` and `omp-gatewayd` binaries. Both package command names refer to that CLI. The
installer stages the verified payload in private, content-addressed storage, creates or retains
the gateway-only readiness token, registers the current-user service, starts it, and requires
authenticated readiness before activating the runtime. It prints Serve guidance; it does not
configure Tailscale, validate tailnet policy, install OMP, or change OMP settings.

**Apply the printed private Serve command and the [tailnet policy](#6-tailnet-access-policy)
before running `doctor`.** Inspect `tailscale serve status` and keep Funnel disabled. Then, from
the same extraction root:

```sh
bun apps/gateway/src/cli.js status
bun apps/gateway/src/cli.js doctor
```

Open the configured HTTPS origin only after these checks pass; finish the allowed/denied-device
checks below. The service records the Bun executable used during install: keep Bun 1.4.0 at that
persistent path. The installer does not create a shell shortcut. Below, `omp-gateway <command>`
means `bun apps/gateway/src/cli.js <command>` from this verified extraction root; keep the
matching archive for recovery.

An upgrade reads and validates the existing private configuration first.
Continue passing the production `--origin` and `--allow` values on install and upgrade. An omitted
`--port` preserves the existing port; hostname, identity-trust, registry settings, and explicitly
authored `omp` overrides are retained. Omitted OMP fields remain derived rather than being pinned
to the installer's home directory.
A malformed existing configuration fails closed instead of being replaced with defaults. The
readiness token is retained, and an unchanged configuration is not rewritten. Installation removes
the legacy fork-era publication token; this is not a reversible credential migration.

Starting with v0.5.2, a successful, readiness-proven install/upgrade also prunes superseded staged
runtimes after committing `installation/current.json` and `installation/history.json`. It keeps
the active runtime and the two most recent **distinct** predecessors in activation history
(three distinct activations total), including the predecessor plain `rollback` selects. If the
installed service definition names a different runtime, that runtime is additionally protected.
Older versions, versions predating history, and staged-but-never-activated versions outside this
set are removed. `rollback --to <version-directory>` can only select versions still retained;
keep verified release archives separately for deliberate recovery to an older release.

Pruning is best-effort: install prints numeric retained/removed/failed counts and cleanup errors
never fail or revert the successful installation. It never runs on a failed install, on
`install --no-start` (which proves no readiness), during rollback, or during uninstall. A victim
is first renamed inside the private versions root to a non-version `.prune-<uuid>` marker; the
next successful ready install finishes interrupted removals. Foreign names, non-directory
entries, symlinks (including within a payload), and unsafe or unrecognized installation metadata
are left alone. Each pass examines at most 4,096 versions-root entries and, separately, 4,096
payload entries, descending at most 32 levels, so an interrupted removal that fits is always
finished; oversized payloads or filesystem failures can leave extra payloads for a later install.
The retained count describes runtimes protected by the policy, not failed/deferred removals.

**First fork-era → mainline upgrade:** retain the predecessor's signed archive and private
configuration, then run that archive's `uninstall` command before installing this gateway.
Uninstall stops and unregisters its owned service without removing config or installed runtimes.
An active fork-era service cannot prove readiness with the new token, so an in-place active
upgrade is refused rather than weakening readiness authentication. The stopped upgrade creates
the new readiness credential and retires `publisher-token`. Use the explicit recovery procedure
in [UPGRADE_ROLLBACK.md](UPGRADE_ROLLBACK.md) to return across that boundary.

Service mechanisms (qualification is limited to the exact release matrix):

- Linux: systemd user service named `omp-session-gateway.service`; Debian 13 x86-64 is qualified,
  not every Linux distribution or non-systemd host;
- macOS: LaunchAgent under the current user; starts after that user logs in, not at unattended boot;
- Windows: current-user scheduled task that starts at that user's interactive logon, not at
  unattended boot; Windows Server 2025 x86-64 is qualified
  ([Windows qualification](WINDOWS_QUALIFICATION.md)), and other versions are supported and
  CI-tested (service lifecycle on every change, a daily stock-OMP named-pipe canary).

Operator commands:

```text
omp-gateway status
omp-gateway doctor
omp-gateway doctor --bundle
omp-gateway rotate-readiness-token
omp-gateway uninstall
```

Uninstall does not edit OMP settings or Tailscale policy. Normal uninstall derives the fixed
current-user service path without parsing application config, stops the service, and removes its
autostart registration even when config is absent or malformed. `uninstall --no-stop` is accepted
only when the service is already inactive; it refuses an active service rather than orphaning a
daemon. Serve mappings and local config/token state remain separate, explicit cleanup steps.

Install snapshots the prior private config, validates any existing managed service/runtime, rejects
authenticated foreground listeners on both the prior and requested endpoints, stages a
content-addressed runtime, and verifies its manifest and payload digest. It starts that exact CLI
with a one-time readiness-instance nonce and advances the current pointer only after a
readiness-token HMAC bound to that nonce succeeds. A generic loopback
`{"status":"ready"}` response and a same-token prior process are insufficient. If config, service
registration, startup, readiness, or pointer activation fails, install restores the prior config,
service state, and verified runtime. An unavailable token is repaired only while the prior service
is inactive and its loopback endpoint is unoccupied.

Readiness-token rotation validates the managed runtime before replacing the token. If the service
cannot restart on the fresh token, the fresh token remains authoritative and the service is
stopped; the prior potentially exposed token is never restored. Repair the failure, then rerun the
normal install command to restore service registration. Mutation commands reject unknown options,
missing values, and misspelled safety flags before changing state.

## 3. Paths

The gateway’s private config directory contains `config.json` and `readiness-token`; its private
state directory holds the managed runtime and optional push state. Use the installed CLI’s
configuration/diagnostics rather than assuming an OMP path from a gateway runtime directory.
Capabilities are never stored in any of these paths.

OMP separately owns `~/.omp/run/collab-hosts`. `PI_CONFIG_DIR` changes the `.omp` directory name
relative to the home directory. The gateway reads each discovery file’s `endpoint` verbatim because
OMP can relocate long socket paths. Never delete or repair entries from the gateway.

## 4. Gateway configuration

`install --origin https://host.tailnet.ts.net --allow you@example.com` creates the private gateway
configuration. The mainline integration adds these fields:

| Field | Default | Meaning |
|---|---|---|
| `omp.discoveryDir` | OMP discovery directory resolved as above | Explicit directory override for the reader. |
| `omp.queryTimeoutMs` | `1500` | Per-host query deadline in milliseconds. |
| `registry.heartbeatSeconds` | `10` | Discovery poll interval in seconds, not a publisher heartbeat. |
| `registry.ttlSeconds` | `35` | Retention of an existing card during transient query failure. |

TTL must exceed twice the poll interval. Only `ENOENT`/`ECONNREFUSED` proves a queried host dead;
timeouts, permission/resource errors, and wire errors retain the card until TTL expiry. A host
absent from discovery is removed. An absent discovery directory is valid when no hosts are sharing.

Validate strictly and fail closed. Reject wildcard listen addresses in production, wildcard
identities, unsafe paths, unknown fields, and invalid poll/TTL combinations.

## 5. Tailscale Serve

After the gateway service is healthy on loopback, configure a persistent private HTTPS proxy. Ask the
installed CLI for the command matching the configured public origin:

```bash
omp-gateway serve-guidance
```

For a default HTTPS origin it prints a command equivalent to:

```bash
tailscale serve --bg --https=443 http://127.0.0.1:4317
```

An origin such as `https://host.tailnet.ts.net:8443` produces `--https=8443`; `doctor` requires the
exact configured external host and port plus the exact loopback target. Check `tailscale serve
--help` on the installed version, apply the printed private Serve mapping, and inspect `tailscale
serve status`. Never execute `tailscale funnel` or enable public exposure.

The gateway remains loopback-only after Serve is configured. `doctor` fails for a mismatched Serve
host, external port, loopback proxy, non-loopback listener, or active Funnel mapping.

Tailscale Serve removes spoofed incoming identity headers before adding trusted tailnet identity
headers. The backend still requires the exact expected header and application allowlist. Direct
loopback callers can forge those headers; the supported v1 host is therefore a user-controlled
workstation with no mutually untrusted local accounts.

## 6. Tailnet access policy

### Access policy and identities

Use [Tailscale Serve](https://tailscale.com/kb/1312/serve) over tailnet HTTPS as the only remote
path; never enable Funnel. Keep the TUN-mode gateway backend on loopback behind Serve. Serve
removes caller-supplied identity headers and supplies `Tailscale-User-Login` for user-owned source
devices. The gateway compares that login with its exact application allowlist; network access
alone is not authorization. A tagged **destination** gateway is appropriate, but keep the phone
**user-owned**: tagged sources have no user identity header and are denied, even if their network
grant permits HTTPS. See the [deployment matrix](COMPATIBILITY.md#deployment-dependency-matrix).

Merge [the example policy](../examples/tailscale-policy.hujson), not a replacement tailnet policy.
Replace its placeholder login in both `tagOwners` and `src`; separately configure the same intended
login in the gateway allowlist. [Tags](https://tailscale.com/kb/1068/tags) identify service devices,
and `tagOwners` controls who may assign them, not who may connect. Applying a tag replaces a
device’s user identity. Restrict ownership of `tag:omp-session-gateway` and assign that tag only to
the intended gateway node; audit any additional tags, whose permissions also apply.

Prefer [grants over legacy ACLs](https://tailscale.com/docs/reference/grants-vs-acls) for new rules.
Both can coexist; migrating unrelated rules is not required. The example uses the documented
[grant syntax](https://tailscale.com/docs/reference/syntax/grants): an exact user in `src`,
`tag:omp-session-gateway` in `dst`, and `tcp:443` in `ip`. If the configured Serve HTTPS port is
8443, use `tcp:8443` instead; never grant remote access to backend port 4317. An existing legacy
ACL expresses the same path with `action: "accept"`, that user in `src`, `proto: "tcp"`, and
`"tag:omp-session-gateway:443"` in `dst`
([policy syntax](https://tailscale.com/docs/reference/syntax/policy-file)).

Grants are additive, not ordered deny rules: a narrower rule does not override a broader grant.
Review **all** grants and legacy ACLs for overlapping access, including the initial
[allow-all policy](https://tailscale.com/kb/1018/acls). Remove or narrow such access as appropriate
before relying on the example. An exact user source permits that user’s matching devices, not
just one phone; the optional posture below narrows a class of devices, not a unique handset.
Keep the gateway’s own source permissions minimal: do not grant it broad access to other tailnet
nodes merely because it serves the phone. Inventory any separately needed administration paths;
the HTTPS grant is not a reason to add SSH, subnet routing, or exit-node privileges. This is a
tailnet access policy, not a substitute for host hardening or a general Internet egress firewall.

### Device admission: approval or Tailnet Lock

Choose deliberately between the following admission controls. **Current Tailscale documentation
says device approval and Tailnet Lock are mutually exclusive**
([Tailnet Lock limitations](https://tailscale.com/kb/1226/tailnet-lock#limitations)). Neither
replaces network policy, ongoing device maintenance, or the gateway application allowlist.

- **[Device approval](https://tailscale.com/kb/1099/device-approval):** enable it in the admin
  console’s Device management settings; review the new gateway and phone in Machines before
  approving them. A device marked **Needs approval** cannot send or receive tailnet traffic.
  Pre-approved auth keys bypass this manual review, so treat their issuance as an admission
  decision. Approval is for the device, not each subsequent user/node on shared hardware, and is
  not proof of current patch level or protection from a compromised already-approved phone.
- **[Tailnet Lock](https://tailscale.com/kb/1226/tailnet-lock):** trusted signing nodes sign node
  keys; peers verify signatures rather than trusting the coordination server alone to introduce
  new nodes. Plan at least two separately protected signing nodes, as the documented setup
  requires, and securely retain the initialization-time disablement secrets outside those nodes.
  Lock keys remain on their devices, so compromising a signer can compromise that authority.
  Do not make the gateway the only recovery dependency.

  For a new user-owned Android phone, sign in normally, locate its **Locked out** entry in
  Machines, verify the device, select the signing dialog’s CLI tab, and run its generated
  `tailscale lock sign` command on a trusted Linux, macOS, or Windows signing node. Android
  currently cannot act as a signer; the phone can still be a signed member. Sign a new gateway
  node using the same reviewed workflow. An unsigned node remains locked out even if its user
  and network rule would otherwise allow access. Normal reauthentication after a signed node
  key expires rotates its signature automatically; it does not require manual re-signing.

  Document custody and recovery before enabling Lock: retain access to another trusted signer;
  use the documented compromised-key revocation workflow if a signer is compromised (nodes
  signed by a revoked key need fresh signatures). Disabling Lock requires a disablement secret.
  Providing one to Tailscale support at initialization is optional and delegates that recovery
  authority; if you lose the secrets and did not provide one to support, the documentation warns
  the tailnet cannot be recovered. Lock is not a health check, per-request user verification, or
  a cure for an already compromised signed phone.

### Node key expiry and renewal

[Key expiry](https://tailscale.com/kb/1028/key-expiry) limits how long a device can remain
authenticated without reauthentication. When its key expires, connections to/from that endpoint
stop working. A long-running gateway daemon can remain locally healthy while its Serve path is
unreachable; an expired phone loses tailnet access even though its installed PWA still exists.
Do not treat either failure as a reason to enable Funnel or relax the allowlist.

Check the actual expiry setting for **both** devices in Machines. First-time tagged-device
authentication disables key expiry by default; do not assume the gateway renews periodically.
For an unattended gateway, explicitly choose between disabled expiry with a revocation plan and
enabled expiry with scheduled reauthentication and alternate local access. Prefer retaining
expiry on the user-owned phone and reauthenticate in its Tailscale client when required.
Disabling expiry improves availability but removes that periodic authentication boundary; expiry
is not immediate lost-device revocation and does not replace the application allowlist.

For CLI-equipped hosts, the documented renewal command is `tailscale up --force-reauth` (with
privilege elevation if required). It can disconnect the host: do not run it over the only SSH/RDP
path without alternate access. For an already-expired node, an administrator can use **Temporarily
extend key** in Machines to obtain a 30-minute recovery window, then complete reauthentication.
Verify the Serve mapping and allowed-phone access afterwards.

### Optional source-device posture

[Device posture](https://tailscale.com/kb/1288/device-posture) adds source conditions to a
network rule. Define named `posture:` entries in the top-level `postures` object and reference
them with the grant’s `srcPosture` array. Every condition within one posture must match; any one
of multiple named postures in `srcPosture` can match. A required unset attribute does not match.
An explicit `srcPosture` replaces, rather than adds to, `defaultSrcPosture`, so preserve any
existing baseline requirements when adapting the example.

The example’s commented alternative restricts the same user-to-gateway HTTPS grant to Android
sources on the stable Tailscale release track. **Replace** the original grant; adding the
restricted grant alongside the unrestricted one leaves the original access intact. The variant
is an illustration, not a claim that Android plus stable means patched, managed, or uncompromised.

Available default attributes are `node:os`, `node:osVersion`, `node:tsVersion`,
`node:tsReleaseTrack`, `node:tsAutoUpdate`, and `node:tsStateEncrypted`
([attribute reference](https://tailscale.com/kb/1288/device-posture#default-attributes)). Choose
OS/client version floors from your maintenance policy and check actual values in each machine’s
**Device Postures** section before enforcing them. `node:tsAutoUpdate` refers only to Tailscale’s
built-in updater: App Store/Google Play updates report false, so requiring true would exclude
those clients. `node:tsStateEncrypted` concerns Tailscale client state, not whole-device disk
encryption. Third-party MDM/EDR, custom, and geolocation attributes have separate integration and
plan requirements; do not assume they exist on a personal phone.

Posture checks apply to the **source**, not the destination: the phone grant does not attest the
gateway host’s security. Maintain that host independently. Tailscale documents that source
posture restrictions do not apply to shared/external devices or devices behind subnet routers
in the same way as direct nodes within the tailnet; those paths can still be admitted by
matching network rules. Do not share this gateway externally or introduce such paths as a
posture workaround. Device sharing can also supply external user identity headers
([Serve identity](https://tailscale.com/kb/1312/serve#identity-headers)); the exact application
allowlist remains mandatory. The gateway neither reads nor enforces posture: Tailscale does.

### Validate the combined controls

Validate the merged example and any posture variant in the admin console’s policy preview
([Access controls → Preview rules](https://tailscale.com/docs/features/tailnet-policy-file/manage-tailnet-policies#preview-changes));
inspect effective permissions and add policy tests for intended allowed/denied paths. Syntax
acceptance or preview is not an end-to-end proof of device posture or gateway authorization.
From separate devices, verify both:

- successful HTTPS directory access from the intended user-owned phone after admission,
  renewal, and any required posture checks;
- denial for unauthorized sources and, when posture is enabled, a nonmatching source, with no
  overlapping unrestricted rule. A tagged source allowed through the network must still fail
  gateway authorization; an unlisted user must also fail the application allowlist.

For failures, inspect admission/signature state, key expiry, effective network rules and reported
source posture before changing application authorization. Run `doctor` after restoring the
supported Serve path; it does not audit these tailnet controls. Keep lost-phone response in
[section 10](#10-lost-phone-and-revocation): these controls do not retract a capability already
issued or disconnect an established OMP relay session.

## 7. OMP configuration

See `examples/omp-settings.jsonc`:

```jsonc
{
  "collab": {
    "autoStart": "control"
  }
}
```

The upstream-safe default remains `off`. A conservative deployment can choose `view` and retain manual full-control collaboration for occasional use.

Set it with `omp config set collab.autoStart control` (or `view`), then start interactive sessions
with plain `omp`. No other OMP setting is required for gateway discovery.

## 8. Android/PWA installation

1. Join the Android device to the allowed tailnet identity.
2. Open the Tailscale Serve HTTPS URL in a supported browser.
3. Verify the authenticated identity shown by the PWA.
4. Install **OMP Sessions** to the home screen.
5. Test View and Control against a disposable OMP session.
6. Verify browser reload returns to the directory and does not reconnect from stored capability state.

Do not ask the user to bookmark or copy an individual OMP collaboration link.

## 9. Updates

- pin the collab-web integration to an exact OMP commit and record it in `UPSTREAM.lock.json` and the compatibility matrix;
- run parser/client compatibility fixtures before updating OMP;
- support explicit protocol versions and a safe rolling-upgrade overlap where practical;
- gateway restart begins empty and the next poll rediscovers live mainline hosts;
- rotate the readiness token after suspected local exposure or ownership/permission failure;
  Rotation atomically replaces an unsafe regular-file/symlink leaf inside the verified private
  config directory, but refuses an unsafe parent or non-file token path.
- verify release checksums and provenance before replacing the gateway runtime payload;
- retain matching gateway configuration and OMP versions for any planned rollback.

An OMP process keeps code loaded at process start. Restart fork-era OMP processes under mainline
at cutover; a gateway upgrade cannot retrofit them. Changing `collab.autoStart` does not rerun
initialization in an existing session either. Once mainline OMP has published a host, gateway
restarts require no per-session command. Avoid manual `/collab` in recorded terminals because OMP
deliberately prints its bearer links.

## 10. Lost phone and revocation

If the phone is lost or compromised:

1. remove or expire the Android device in Tailscale;
2. revoke relevant identity-provider sessions when appropriate;
3. narrow or temporarily disable the tailnet grant;
4. stop the gateway with its matching CLI’s `uninstall` command if directory access must be
   disabled immediately; this does not disconnect an already-established OMP relay session;
5. stop/restart OMP collaboration hosts to rotate room capabilities;
6. rotate the readiness token only when local desktop exposure is suspected—it does not revoke an
   OMP query token or a remote collaboration room.

WebAuthn Control protection is not implemented;
[ADR-008](DECISIONS.md#adr-008--optional-webauthn-gate-not-native-biometrics) remains a proposal.
Do not rely on a separate biometric or credential-enrollment gate for revocation.

## 11. `doctor` and diagnostics bundle

`omp-gateway doctor` checks:

- daemon and autostart state;
- loopback-only listener;
- private readiness-token permissions and OMP discovery readability;
- Tailscale connectivity and Serve mapping;
- absence of Funnel exposure;
- trusted identity header flow through Serve;
- allowed-login match;
- PWA, manifest, CSP, and service-worker availability;
- relay DNS/TLS connectivity without creating or logging a real capability;
- `sessionHealth` without exposing capabilities;
- config validation and `compatibility`: the `omp` on PATH reports at least 18.1.20;
- `discoveryReadable`: OMP discovery is absent or readable, owned by the current user, and not a symlink.

`doctor` checks the configured host and an allowed HTTPS metadata request; it is not an
independent tailnet-policy audit or proof that an unauthorized device is denied. Complete both
[tailnet access checks](#6-tailnet-access-policy). It also does not establish a signed-artifact or
native-platform qualification: qualification must exercise the real host/query/launch path
against the exact gateway candidate.
Even in development mode, `doctor` fails unless it can query Tailscale and prove Funnel is disabled.

`doctor --bundle` writes a deterministic `omp-gateway-diagnostics.tar` (or the path supplied with `--output`) and refuses to overwrite an existing file. Its manifest lists every included field. The archive excludes capabilities, tokens, authorization/identity headers, transcripts, prompts, tool output, full paths, browser storage, raw logs, tailnet DNS names, and account identities.

Never ask a user to paste a collaboration link into an issue.

## 12. Self-hosted relay mode

Self-hosted/proxied relays are outside current support. The following are qualification
requirements for a separately designed deployment, not a supported installation recipe:

- deploy a pinned compatible OMP relay;
- use private DNS/TLS and explicit relay allowlisting;
- configure OMP and the browser client consistently;
- run multi-hour WebSocket, Android sleep/resume, network switch, and reconnect tests;
- document metadata, backup, upgrade, and availability responsibilities;
- never silently fall back to the public relay.
