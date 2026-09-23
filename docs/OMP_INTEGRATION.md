# Mainline OMP integration

## Supported prerequisite

Use stock mainline OMP `>= 18.1.20`. [PR #11908](https://github.com/can1357/oh-my-pi/pull/11908), merge `4999b98bd5`, ships in [OMP v18.1.20](https://github.com/can1357/oh-my-pi/releases/tag/v18.1.20).
The integration is native to stock OMP: no fork, custom OMP build, or gateway-specific OMP plugin
is required. The separately installed gateway consumes OMP's supported local registry; it does not
patch OMP, import private controller APIs, or install a second OMP executable. Releases earlier
than 18.1.20 lack this registry and are unsupported by the current gateway. The deployment still
requires Bun 1.4.0, TUN-mode Tailscale Serve, an exact login allowlist, and the one-time
`collab.autoStart` setting below; native integration does not mean a bundled gateway or public access.

`UPSTREAM.lock.json` records the exact engineering source baseline: `v18.1.20`, commit
`1bd60c6fbd0e800a75fd09b1e4804af5a5e6d63b`, tree
`aca949970fb8b73170b05f6a23bf18e23fb5841f`. The minimum supported host version is distinct from
that exact host/source baseline. The embedded browser client has its own preserved
[v18.1.14 source and wire pins](../packages/collab-client/README.md); do not conflate them with
the host minimum.

Stable [v0.4.0](https://github.com/alphastorm/omp-session-gateway/releases/tag/v0.4.0) is published
as immutable GitHub Latest. Its exact signed candidate `v0.4.0-prealpha.1` passed core
qualification on OMP 18.1.20 / Bun 1.4.0, Debian 13 x86-64, macOS 26.6.1 arm64, and Pixel 10 Pro /
Android 17 / Chrome 152.0.7977.82. The fresh relay check covered **1,800 seconds**, not eight hours.
Windows, background Web Push, specialized attention, and branch/resume remain unqualified.
The published-byte local smoke also passed with the existing OMP 18.1.21; it does not broaden the
exact matrix or establish the cause of the initial intermittent Control-upgrade failure.
See the [release ledger](RELEASE_STATUS.md) for receipts, limits, and that unresolved observation;
no fork-era qualification transfers.

## Additive activity compatibility

The unreleased #219 fix accepts `busy` from OMP 18.2.9 while retaining older hosts in the same
directory. Upstream [PR #12844](https://github.com/can1357/oh-my-pi/pull/12844), merge
`1eb2f51bb4d1a4324e46cdfad5c259be9b8ccee9`, adds this optional field without changing registry v1.
Its source is `session.isStreaming`: true while running a turn, false while idle, and unknown
when omitted/null. It is not proof of successful completion or process exit. The parser validates
this named extension; it does not admit arbitrary snapshot fields or expose prompt/answer data.
The exact engineering baseline, minimum host version, embedded client, and native pins above stay
unchanged. Mixed-version IPC tests do not qualify a new physical platform or full OMP version.

The source activity extension projects known `busy` into browser metadata and supports stop alerts
through the existing opt-in Push channel. Older hosts remain unknown and cannot produce stop
alerts. The exact trigger and View-only tap semantics are in
[ATTENTION_SPEC.md](ATTENTION_SPEC.md#activity-stop-notifications); no extra OMP setting is needed.

## 1. Operator settings

The only required OMP setting is:

```sh
omp config set collab.autoStart control
# Or choose read-only sharing:
omp config set collab.autoStart view
```

Equivalent settings:

```jsonc
{
  "collab": {
    "autoStart": "control" // "off" | "view" | "control"; default "off"
  }
}
```

Start participating interactive sessions with plain `omp`. OMP owns automatic collaboration
startup after session initialization and publishes its own local discovery entry. The gateway
discovers the host on its next poll, whether OMP or the gateway started first. Manual collaboration
commands remain OMP’s responsibility and require no gateway integration hook.

At cutover, restart a process launched from an older OMP under mainline; changing an executable
on disk does not replace code already loaded into a running process. Enabling auto-start also
does not rerun initialization in an existing session. Manual `/collab` prints capabilities, so do
not run it in a recorded or supervised terminal.

## 2. Discovery and per-host queries

OMP owns `~/.omp/run/collab-hosts`. `PI_CONFIG_DIR` replaces the `.omp` directory name relative
to the home directory. The gateway can select another directory through `omp.discoveryDir`.
Every publication consists of a private discovery file and an owner-only query endpoint.

`OmpHostReader` reads the file’s version, instance identity, PID, endpoint, creation time, and
per-host query token. It uses the published endpoint verbatim: long socket paths may be relocated
under `/tmp/omp-collab-<hash>`. Discovery files are written once, so file timestamps do not
represent metadata freshness. The gateway only reads them and never repairs or removes them.

Queries are newline-framed JSON, one request and response per connection. `snapshot` returns
metadata, while `link` resolves one exact generation and role on an explicit launch. The complete
file, snapshot, operation, and error-code contracts are in [PROTOCOL.md](PROTOCOL.md).

OMP also provides `omp collab list [--json]` and
`omp collab link <instanceId|pid> [--view] [--json]`. The latter deliberately outputs a bearer
capability: do not capture it in logs, files, fixtures, diagnostics, or issue reports. The gateway
queries the endpoint directly and never shells out to a link-printing command.

## 3. Polling and lifecycle

`startHostPoller` coalesces concurrent rounds and reconciles observed metadata with retained
hosts. `registry.heartbeatSeconds` is now the poll interval (default 10 seconds);
`registry.ttlSeconds` defaults to 35 seconds and must exceed twice that interval.

Only `ENOENT`/`ECONNREFUSED` proves a queried host dead. Timeouts, `EMFILE`, `EACCES`, and
wire errors such as `snapshot_unavailable` retain a previously observed card until TTL expiry.
A host absent from discovery is removed; a reply followed by socket close is normal query framing.
A stopped gateway has no effect on OMP publication, and restarting it requires no OMP reconnect.

OMP’s instance identity keys the process card. Generation changes identify host replacement; PID
alone is unsafe because PIDs are reused. The gateway maps `sessionName`, `cwd`, and model
metadata to bounded browser labels, with basename-only paths by default. `inputRequired` is a
boolean, not a prompt or answer. The gateway derives its own opaque attention identity and receipt
time for browser routing; mainline OMP does not supply previews or option counts.

## 4. Per-launch capability broker

`OmpLaunchResolver` authorizes the requested generation, role, and optional attention request
identity against current metadata, fetches a link from that OMP host, and revalidates before
release. The gateway never stores or caches a capability, including in its memory-only registry.

HTTP list/SSE and launch shapes remain unchanged. Launch refusal includes `generation_mismatch`,
`request_mismatch`, `missing`, and `mode_unavailable`; the last becomes HTTP 409 when the host
no longer shares the requested role. Capabilities remain confined to transient query/response and
active client memory and never appear in logs or diagnostics. Gateway log fields are numeric or
boolean only.

## 5. Gateway configuration and readiness

`omp.discoveryDir` defaults to the OMP directory above; `omp.queryTimeoutMs` defaults to 1500.
The gateway’s `readiness-token` proves managed loopback readiness only and is not sent to OMP.
`doctor` checks that `omp` on PATH reports at least 18.1.20 (`compatibility`), verifies discovery
is absent or safely readable (`discoveryReadable`), and reports `sessionHealth`. It no longer
qualifies a patched source tree or staged OMP patch.

## 6. Client and qualification boundary

The gateway still embeds the pinned OMP `collab-web` integration and in-memory bootstrap. The
photo composer uses existing encrypted v3 image prompts; it does not add a gateway media endpoint
or alter the discovery/query contract. Client changes and a mainline minimum do not by themselves
prove relay endurance, response replay, native host behavior, or physical Android behavior.

The migration’s behavioral proof belongs to `apps/gateway/test/omp-registry.test.ts`. Release
qualification must exercise the actual mainline binary, View/Control launch and refusal, host
replacement and stop, gateway restart, transient query failures, capability non-persistence, and
the exact client/relay path. See [TEST_PLAN.md](TEST_PLAN.md), [COMPATIBILITY.md](COMPATIBILITY.md),
and the current mainline evidence and separate fork-era archive in
[RELEASE_STATUS.md](RELEASE_STATUS.md).

