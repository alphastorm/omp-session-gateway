# Linux qualification lane

One throwaway DigitalOcean droplet, driven by
[`scripts/provision-linux-qual.sh`](../scripts/provision-linux-qual.sh), that produces measured
evidence for four holes in [`RELEASE_STATUS.md`](RELEASE_STATUS.md) at once.

This document is the operating manual for that lane. It does not promote any ledger row. Every
command below prints numbers; the lead decides what those numbers mean.

## 1. Why a droplet and not the existing container

The Linux evidence in the ledger came from a Debian 13 aarch64 container with a real `systemd --user`
manager. That run was worth having: it proved the install/readiness/permissions/reinstall/rotation/
uninstall sequence and the file modes. It could not prove four things, for structural reasons rather
than for want of effort.

| The container could not show | Because |
|---|---|
| A real machine lifecycle | It shares the host kernel, has no firmware or boot sequence of its own, and no public address of its own. |
| Reboot and login persistence | It never boots. Its user manager exists because something outside it kept the container alive, so "the service came back" was never a question it could be asked. |
| A denied Tailscale identity | It was not a tailnet node. Every tailnet device on a single account is user-owned, and Serve stamps user-owned sources with a login that is on the allowlist, so denial has never been observable. |
| Public-Internet unreachability | It had no public IP, so "the listener is not reachable from the Internet" was true by absence rather than by policy. |

A droplet answers all four. It boots, it can be rebooted freely unlike the operator's workstation, it
has a routable public IP, and it can join the tailnet as a **tagged** node, which is the only
practical way to make Tailscale Serve present an identity that the gateway must refuse.

The image is `debian-13-x64` deliberately. The ledger already carries Debian 13 evidence, so keeping
the distribution fixed makes the container-versus-machine comparison clean instead of introducing a
second variable. The architecture does change, from aarch64 to x86_64; see
[section 8](#8-what-this-lane-does-not-prove).

## 2. The four gaps, and how each is closed

### Gap 1 — bare-metal/VM Linux host lifecycle

Lane `host` records the machine's own facts: distribution, kernel, `systemd-detect-virt`, systemd
version, CPU/memory, boot id, uptime, and the public IPv4 the droplet reports from its own metadata
service. Lanes `lifecycle` and `uninstall` then run the full install/status/doctor/rotate/uninstall
sequence on that machine from the signed archive.

### Gap 2 — reboot and login persistence

A `systemd --user` service only survives logout and reboot without an active session if lingering is
enabled for that user. The gateway's unit is `WantedBy=default.target` with `Restart=on-failure`, and
`omp-gateway install` does **not** call `loginctl enable-linger`. So "it came back after reboot" is
ambiguous by default: it can mean lingering started the user manager at boot, or it can mean the SSH
login used to check created a session that pulled in `default.target`.

Lane `persistence` removes the ambiguity by rebooting twice and measuring from **root only**, so the
qualified user has zero login sessions at the instant of measurement:

- **Pass A, negative control.** `loginctl disable-linger ompqual`, reboot, then measure as root. The
  daemon must be absent, `user@<uid>.service` must be `inactive`, and the loopback probe must fail.
  A follow-up SSH login as `ompqual` then shows the unit starting, with a process age far smaller
  than system uptime — which is what "a login session started it" looks like.
- **Pass B, the persistence claim.** `loginctl enable-linger ompqual`, reboot, measure as root again.
  The daemon must be running while `loginctl list-sessions` shows **zero** sessions for that user,
  and its process age must track system uptime rather than the age of our connection.

Both passes print the session count and the `process Ns old, system up Ms` pair. Pass B is evidence
only in combination with pass A; on its own it cannot distinguish the two causes.

Reboots are detected by boot id, not by a sleep: the script records
`/proc/sys/kernel/random/boot_id`, issues the reboot, and returns only when SSH answers with a
*different* boot id. A pre-reboot host can therefore never be mistaken for the rebooted one.

### Gap 3 — denied Tailscale identity

This is the reason the box is worth provisioning. Tailscale Serve populates `Tailscale-User-Login`
only for **user-owned** source devices. A tagged node carries no user identity, so a request proxied
through Serve from a tagged source arrives with no user identity at all, and the gateway's
`tailscale-serve` auth mode must fail closed. `docs/SECURITY.md` §4 states this property and §13
requires proving that "tagged-without-supported-auth" identities are denied; this lane is where that
is actually observed.

Lane `identity` measures a matrix:

| Source | Allowlist at the time | Expected |
|---|---|---|
| The tagged droplet, to its own Serve origin | a synthetic address | `403`, and zero `Tailscale-User-*` headers reaching the backend |
| The operator's workstation, a user-owned node, through Serve | a synthetic address | `403` with a well-formed identity that Serve supplied |
| The operator's workstation, through Serve | the workstation's real login | `200`, `no-store`, body keys metadata-only |
| The workstation with a forged `Tailscale-User-Login` header | a synthetic address | `403` — the forged value is discarded |
| The workstation with the same forged header | the real login | `200` — the forged value is ignored, the real identity decides |
| The droplet's tailnet IP, straight to the backend port | any | connection refused |
| The droplet's **public** IP, straight to the backend port, from the workstation | any | connection refused |

The first row is "identity absent". The second is "identity present, well-formed, not equal to the
allowlist". Together they are the two denial shapes the ledger asks for. The forged-header pair is
what shows the header is Serve-controlled rather than caller-controlled: the same supplied value is
refused when the caller's real identity is not allowlisted and ignored when it is.

`tailscale whois` is printed alongside, so the discriminator between "absent" and "present" is a
measurement rather than an assumption: on the tagged pass it reports no user profile and a tag list.

**Be clear about the limit.** A tagged node can never present a user identity, so this box cannot
produce a *second, distinct user* identity. The allowed half therefore comes from the operator's
workstation, which is a genuinely separate user-owned tailnet node — that is real distinct-device
evidence, but it is the operator's own identity, not a third party's. If the ledger needs a denial by
a *different real person's* login, this lane does not provide it and no single-account tailnet can.

A second consequence: `doctor` cannot reach 16/16 on a tagged node, because `doctor` probes its own
public origin and that probe has no user identity. Expect these checks to be `false` and read them as
the denial result rather than as a gateway fault:

| Check | Why it is false on a tagged node |
|---|---|
| `identityAllowed` | The self-probe through Serve is refused, which is the denial being measured. |
| `publisherHealth` | Derived from the same refused session list. |
| `pwa` | `/`, `/manifest.webmanifest`, and `/service-worker.js` are refused for the same reason. |
| `securityHeaders` | Read from that refused response; whether a `403` carries the CSP header is printed rather than predicted. |

`publisherHealth` would also be uninformative here regardless, because no OMP publisher runs on this
droplet.

### Gap 4 — install/doctor/uninstall from the signed candidate artifact

Lane `artifact` downloads the release assets, verifies them, and only then extracts them. Three
independent verifications run **on the droplet**, not on the workstation:

1. `sha256sum --check SHA256SUMS`, with the measured archive digest printed;
2. `cosign verify-blob` against each published `.sigstore.json` bundle, pinned to the exact
   certificate identity `https://github.com/<repo>/.github/workflows/release.yml@refs/tags/<tag>`
   and the GitHub Actions OIDC issuer;
3. `gh attestation verify` for the archive, SBOM, and `SHA256SUMS`, pinned to `--signer-workflow` and
   `--source-ref refs/tags/<tag>`.

`gh attestation verify` needs GitHub API access. If `GH_TOKEN` is exported the droplet verifies
online; otherwise the script uses the already-authenticated workstation `gh` to
`gh attestation download` the bundles, uploads them, and the droplet verifies offline with
`--bundle`. The mode used is printed either way.

`cosign` and `gh` are fetched onto the droplet from their upstream releases and their sha256 digests
are printed, so the run records which tool binaries produced the result.

The lane then extracts the archive, prints the bundled `UPSTREAM.lock.json` pin and
`release-info.json` source commit — which is how a Linux run contributes to the ledger's requirement
that platform rows be re-run at the current `v17.3.8` pin — and installs Bun 1.3.14 to match
`UPSTREAM.lock.json`. Everything afterwards runs the archive's `apps/gateway/src/cli.js`, never a
development checkout.

## 3. Prerequisites

### DigitalOcean

- `doctl` installed and authenticated. Either `doctl auth init` or
  `export DIGITALOCEAN_ACCESS_TOKEN=…`. Create the token at **DigitalOcean → API → Tokens →
  Generate New Token** with read and write scope for droplets. The script calls `doctl account get`
  first and refuses to continue if authentication fails.
- An SSH key registered in the account. The lane defaults to key id **11924832** (name `Alpha`) and
  accepts `OMP_QUAL_SSH_KEY_ID` to override it. Preflight fetches that key's fingerprint and requires
  a matching local private key — from `OMP_QUAL_SSH_IDENTITY`, from `~/.ssh/*.pub`, or from
  `ssh-agent`. If nothing matches it fails and says so **without creating a droplet**, because a
  droplet you cannot log into is pure cost.

### Tailscale

- An auth key that applies the tag, created at **Tailscale admin console → Settings → Keys →
  Generate auth key**:
  - **Tags:** `tag:omp-session-gateway`. This is what makes the node tagged and therefore
    identity-less, which is the entire point of gap 3. Provision fails if the joined node reports no
    tags.
  - **Pre-approved:** required if your tailnet has device approval enabled.
  - **Ephemeral: no.** An ephemeral node is removed shortly after it goes offline, and this lane
    reboots the machine twice. Losing the node mid-run would take the Serve mapping and the node
    identity with it. Cleanup is handled by `destroy` instead.
- `tagOwners` for `tag:omp-session-gateway` in the tailnet policy, and a grant permitting your user
  to reach that tag on `tcp:443`. [`examples/tailscale-policy.hujson`](../examples/tailscale-policy.hujson)
  is the template; it is not drop-in and must be merged into existing policy.
- HTTPS certificates enabled for the tailnet (MagicDNS plus HTTPS), which `tailscale serve` requires.
- Optional: `TS_API_KEY`, an API access token from the same Keys page. Without it `destroy` logs the
  node out but cannot delete the machine record, and you must remove `omp-gateway-qual` in the admin
  console by hand.

### Workstation

`jq`, `curl`, `ssh`, `scp`, `ssh-keygen`, and an authenticated `gh` (used to download release assets
and, when `GH_TOKEN` is absent, attestation bundles). The script checks for each and names the
missing one.

### The candidate

`OMP_QUAL_RELEASE_TAG` must name a published signed candidate, for example `v0.1.0-prealpha.14`. The
archive and SBOM filenames are derived from `package.json`'s version; override with
`OMP_QUAL_VERSION` if they ever diverge.

## 4. Running the lane

```sh
# Credentials. Nothing below is ever echoed, written to a file, or passed in argv.
export DIGITALOCEAN_ACCESS_TOKEN=...      # or: doctl auth init
export TS_AUTHKEY=tskey-auth-...          # tagged, pre-approved, NOT ephemeral
export TS_API_KEY=tskey-api-...           # optional, lets destroy delete the tailnet node

# What to qualify.
export OMP_QUAL_RELEASE_TAG=v0.1.0-prealpha.14
export OMP_QUAL_ALLOWED_LOGIN=you@example.com   # optional; read from local `tailscale status` if unset

cd /path/to/omp-session-gateway
./scripts/provision-linux-qual.sh provision
./scripts/provision-linux-qual.sh qualify
./scripts/provision-linux-qual.sh status
./scripts/provision-linux-qual.sh destroy
```

`provision` is idempotent: it reuses an existing droplet named `omp-gateway-qual` rather than creating
a second one, and it skips `tailscale up` if the node is already online. Re-running it after a failed
attempt is safe and cheap.

`qualify` accepts a lane list, so a single observation can be repeated without paying for the whole
sequence again:

```sh
./scripts/provision-linux-qual.sh qualify host
./scripts/provision-linux-qual.sh qualify artifact lifecycle
./scripts/provision-linux-qual.sh qualify identity
./scripts/provision-linux-qual.sh qualify persistence
./scripts/provision-linux-qual.sh qualify uninstall
```

Default order is `host artifact lifecycle identity persistence uninstall`. The lanes are ordered so
the identity matrix is captured before the reboots: a reboot failure then costs no identity evidence.
`identity` and `persistence` both assume `lifecycle` has already installed the service; run them
after it, or after a previous full run, not standalone on a fresh droplet.

Lane `uninstall` leaves the droplet clean — no service, no Serve mapping — so the next `qualify` starts
from the same state as the first.

### Environment knobs

| Variable | Default | Purpose |
|---|---|---|
| `OMP_QUAL_NAME` | `omp-gateway-qual` | Fixed droplet name; the basis of idempotency. |
| `OMP_QUAL_REGION` | `sfo3` | Any region carrying the size. |
| `OMP_QUAL_SIZE` | `s-1vcpu-2gb` | Smallest size with enough memory for Bun plus the build tools. |
| `OMP_QUAL_IMAGE` | `debian-13-x64` | Matches the distribution already in the ledger. |
| `OMP_QUAL_SSH_KEY_ID` | `11924832` | DigitalOcean SSH key id. |
| `OMP_QUAL_SSH_IDENTITY` | unset | Explicit private key path for `ssh`/`scp`. |
| `OMP_QUAL_USER` | `ompqual` | The non-root user the gateway is installed as. |
| `OMP_QUAL_ALLOWED_LOGIN` | local `tailscale status` | Login used for the allowed half of the identity matrix. |
| `OMP_QUAL_PORT` | `4317` | Gateway loopback port. |
| `OMP_QUAL_BUN_VERSION` | `1.3.14` | Matches `UPSTREAM.lock.json`. |
| `OMP_QUAL_GH_VERSION` | `2.97.0` | `gh` release fetched onto the droplet. |
| `OMP_QUAL_COSIGN_VERSION` | `3.1.3` | `cosign` release fetched onto the droplet. |
| `OMP_QUAL_TAG` | `tag:omp-session-gateway` | Tag the auth key is expected to carry; used in messages only. |
| `GH_TOKEN` | unset | If set, the droplet verifies attestations online instead of offline. |

### Why the gateway runs as a non-root user

`ompqual` exists so that persistence can be measured from outside the user whose service is being
observed. Root SSH stays available for measurement, which is what makes "zero login sessions for the
service's user" a checkable statement. It is also the realistic deployment shape: the gateway
installs a per-user service, not a system one.

Two provisioning steps support this and are worth knowing because neither is done by
`omp-gateway install`:

- `tailscale set --operator=ompqual`, so the non-root user can drive `tailscale serve` and so
  `doctor` can query the local API. Without it, `tailscaleConnected` and `funnelDisabled` fail for a
  permission reason that looks like a gateway fault.
- `loginctl enable-linger ompqual`, so the install and identity lanes are not perturbed by our own
  short SSH sessions starting and stopping the unit. Lane `persistence` turns it off again on purpose
  as its negative control, and leaves it on at the end.

The lifecycle lane also asserts `XDG_RUNTIME_DIR` is set in the SSH session before installing.
`install` derives the runtime directory from it and so does the daemon systemd starts; if the two
disagree, the registry socket lands somewhere the service cannot use. The check fails loudly rather
than producing a subtly broken install.

## 5. Evidence this lane produces, by ledger row

Rows are named exactly as they appear in [`RELEASE_STATUS.md`](RELEASE_STATUS.md). This table says
what is measured and where; it does not assert that any row should change.

| Ledger row | Command | Observable |
|---|---|---|
| Linux host lifecycle | `qualify host lifecycle uninstall` | `systemd-detect-virt` on a booting machine; `status` returning `{installed:true,active:true,ready:true,authMode:"tailscale-serve"}` from the archive CLI; `config.json` `600` in a `700` directory; `publisher-token` `600`; `registry.sock` under `$XDG_RUNTIME_DIR`; main PID before/after `rotate-publisher-token`; `uninstall --no-stop` refused while active; unit file, process, and listener all gone after `uninstall`. |
| Linux host lifecycle (reboot/login half) | `qualify persistence` | Pass A: lingering off, zero sessions, `user@<uid>.service` `inactive`, no daemon PID, loopback probe fails. Pass B: lingering on, zero sessions, `user@<uid>.service` `active`, daemon PID present, process age ≈ system uptime, loopback probe `403`. |
| Tailscale Serve identity and application allowlist | `qualify identity` | `403` for the tagged self-probe with zero `Tailscale-User-*` headers reaching the backend, and `tailscale whois` reporting no user profile; `403` for the workstation's real identity while the allowlist holds a synthetic address; `200` once its login is allowlisted; the forged-header pair denied-then-ignored. |
| Loopback-only exposure | `qualify identity` | `ss` showing only `127.0.0.1:4317`; connection refused to the droplet's tailnet IP on `4317`; connection refused to the droplet's **public** IP on `4317` from the workstation; `tailscale funnel status` showing no funnel. |
| Platform install/doctor/uninstall | `qualify artifact lifecycle uninstall` | `sha256sum --check` result and measured archive digest; `cosign verify-blob` against all three `.sigstore.json` bundles at the exact certificate identity; `gh attestation verify` for all three artifacts at `--source-ref refs/tags/<tag>`; then install/doctor/uninstall executed from that verified archive's CLI. |
| Release signing, SBOM, and provenance (Linux re-verification) | `qualify artifact` | The same three verifications performed on a clean Debian host with freshly downloaded `cosign` and `gh` binaries whose digests are recorded. |

Supporting measurements that are not themselves a row: the bundled `UPSTREAM.lock.json` tag and
commit (relevant to the ledger's requirement that platform rows be re-run at the `v17.3.8` pin), the
`doctor` true/false split with the false checks named, and a literal search of
`doctor --bundle` output for the publisher token and the home path.

**Not this lane.** `Configuration migration and rollback` needs an explicit forward upgrade and
rollback; that is `docs/UPGRADE_ROLLBACK.md` and `scripts/qualify-upgrade-rollback.sh`. This lane does
not upgrade anything, so its `qualify` can run before or after that one on the same droplet.

## 6. Teardown and cost

One `s-1vcpu-2gb` droplet at **$0.01786 per hour**, about **$0.43 per day**. A full `qualify` run is
roughly twenty minutes including two reboots, so the qualification itself costs well under a cent.
The only way this lane becomes expensive is by being forgotten, which is why:

- `provision` prints the hourly rate;
- `status` prints hours elapsed and dollars accrued;
- every invocation prints a boxed reminder on exit while the droplet still exists;
- `destroy` prints the final accrued figure before deleting.

```sh
./scripts/provision-linux-qual.sh destroy
```

`destroy` is safe to run at any time, including when nothing exists and when the droplet is
unreachable. It logs the node out of the tailnet, resets the Serve mapping, deletes the tailnet
device record when `TS_API_KEY` is available, deletes the droplet, waits until it is no longer listed,
and removes the local state and known-hosts entries. DigitalOcean bills whole hours and does not
refund a partial one, so destroying at minute five still costs one hour.

If `TS_API_KEY` is not set, `destroy` says so and names the device to remove by hand. Skipping that is
how tailnets accumulate dead nodes across runs.

## 7. Secret handling

- The DigitalOcean token and Tailscale keys are read from the environment. None is printed, written to
  a file in this repository, or placed in argv.
- The Tailscale auth key is **not** in cloud-init user data. User data is readable from the droplet's
  own metadata service and from the DigitalOcean API, so it carries only package installation, the
  qualified user, and the Tailscale installer. The key is streamed over SSH stdin under a fixed argv
  into a mode-0600 file, consumed by `tailscale up --auth-key file:…`, and removed on both the success
  and failure path.
- The publisher token is never printed. The lifecycle lane reads it only to search the diagnostics
  bundle for it, and reports the byte count and mode rather than the value.
- The service's one-time readiness nonce is redacted where `ExecStart` is printed.
- Every login in this document is a placeholder. `denied-identity@qual.invalid` is in a reserved TLD
  precisely so that nobody can ever authenticate as it, which is what makes it a safe stand-in for a
  well-formed login that is not on the allowlist.

## 8. What this lane does not prove

- **This is a virtual machine, not bare metal.** A DigitalOcean droplet is a KVM guest;
  `systemd-detect-virt` prints `kvm` and the script highlights that line. The accurate term for the
  ledger is "VM", not "bare-metal". Firmware, real disks, real NICs, and physical power loss are all
  still untested.
- **The architecture changed.** The container evidence was aarch64; this is x86_64. The distribution
  is held constant, the architecture is not, so this is not an apples-to-apples container-versus-machine
  comparison. Anything architecture-sensitive is newly covered rather than re-confirmed.
- **No OMP publisher runs here.** No real session discovery, View/Control, generation replacement,
  relay connectivity, or capability-leak evidence comes out of this lane, and `doctor`'s
  `publisherHealth` reflects an empty registry rather than a healthy one.
- **No browser and no Android device.** Nothing here speaks to the PWA, service worker, storage
  sinks, or push.
- **No second user identity.** The tagged node proves "identity absent"; the workstation proves
  "identity present and not on the allowlist" using the operator's own login. A denial by a different
  real person's identity is not produced, and cannot be from a single-account tailnet.
- **`doctor` does not reach 16/16 on the tagged node,** by construction. See the table in
  [section 2](#gap-3--denied-tailscale-identity). A full-pass `doctor` on Linux would require a
  user-owned node, which would in turn make the denial case unavailable.
- **Upgrade and rollback are out of scope here.**
- **Persistence is proven for systemd user lingering on this distribution only.** It says nothing
  about the macOS LaunchAgent or the Windows scheduled task, both of which have their own untested
  reboot/login story.
- **The droplet is not a hardened host.** Its SSH port is on the public Internet. The gateway
  listener is measured loopback-only and the public-IP probe is measured refused, but the machine
  itself is a throwaway, not a model deployment.
- **Signature verification proves origin, not fitness.** Checksum, attestation, and Cosign results
  establish that the bytes are the ones the release workflow produced at that tag. They say nothing
  about whether that build passes any behavioural gate.

## 9. Related documents

- [`RELEASE_STATUS.md`](RELEASE_STATUS.md) — the ledger; the only place a row's status changes.
- [`TEST_PLAN.md`](TEST_PLAN.md) — §4.E authorization and §4.F persistence scenarios this lane feeds.
- [`SECURITY.md`](SECURITY.md) — §4 network exposure, §8 tailnet authorization, §13 acceptance gates.
- [`RELEASE.md`](RELEASE.md) — the canonical artifact verification commands this lane runs remotely.
- [`OPERATIONS.md`](OPERATIONS.md) — install, Serve, paths, and `doctor` semantics.
- [`UPGRADE_ROLLBACK.md`](UPGRADE_ROLLBACK.md) — the sibling lane for forward upgrade and rollback.
