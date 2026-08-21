<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/logo.svg">
  <source media="(prefers-color-scheme: light)" srcset="assets/logo-light.svg">
  <img src="assets/logo-light.svg" alt="" width="72" height="72">
</picture>

# OMP Session Gateway

**Every live OMP session. One private mobile page.**

An Android-first PWA that auto-discovers running
[Oh My Pi](https://github.com/can1357/oh-my-pi) sessions, alerts you when one needs input,
and opens the exact encrypted OMP collaboration surface — without QR codes or copied links.

<img src="docs/media/omp-session-gateway-demo.gif" alt="Four live OMP sessions listed automatically in the private Sessions directory; a fifth appears on its own; when sessions start waiting for input the directory switches to Needs you and promotes the oldest request; Open request opens OMP's encrypted collaboration client on that exact request, which stays connected." width="900">

**[Build and run](#build-and-run)** · **[How it works](#how-it-works)** ·
**[Security model](docs/SECURITY.md)** · **[Compatibility](docs/COMPATIBILITY.md)** ·
**[Latest release](https://github.com/alphastorm/omp-session-gateway/releases/latest)**

[![CI][ci-badge]][ci]
[![Coverage][coverage-badge]][coverage]
[![Latest release][release-badge]][releases]
[![OMP baseline][omp-badge]][omp-lock]
[![License][license-badge]][license]

[ci]: https://github.com/alphastorm/omp-session-gateway/actions/workflows/ci.yml
[ci-badge]: https://img.shields.io/github/actions/workflow/status/alphastorm/omp-session-gateway/ci.yml?branch=main&label=CI&labelColor=0B0E11
[coverage]: https://codecov.io/gh/alphastorm/omp-session-gateway
[coverage-badge]: https://img.shields.io/codecov/c/github/alphastorm/omp-session-gateway?label=coverage&color=1C232B&labelColor=0B0E11
[releases]: https://github.com/alphastorm/omp-session-gateway/releases
[release-badge]: https://img.shields.io/github/v/release/alphastorm/omp-session-gateway?include_prereleases&filter=v*&label=release&color=C99B45&labelColor=0B0E11

[omp-lock]: UPSTREAM.lock.json
[omp-badge]: https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2Falphastorm%2Fomp-session-gateway%2Fmain%2FUPSTREAM.lock.json&query=%24.tag&label=OMP%20baseline&color=1C232B&labelColor=0B0E11
[license]: LICENSE
[license-badge]: https://img.shields.io/github/license/alphastorm/omp-session-gateway?color=1C232B&labelColor=0B0E11

<sub><strong>Private by design:</strong> loopback-only gateway · allowlisted tailnet identity · memory-only capabilities · no transcript storage</sub>

</div>

> **Qualified beta — not stable or production-qualified.**
> [`v0.1.0-beta.1`](https://github.com/alphastorm/omp-session-gateway/releases/tag/v0.1.0-beta.1)
> is independently qualified against exact signed candidate `v0.1.0-prealpha.20`. Advertised
> combinations only: Debian 13 (trixie) x86-64 or macOS 26.6.1 arm64 hosts with Chrome
> `151.0.7922.171` on Android 17, behind Tailscale Serve with the **TUN-mode** client and Funnel
> disabled. Everything else — including Windows and self-hosted or proxied relays — is unadvertised
> and must not be treated as a working deployment path. Details and known limitations:
> [Compatibility and beta status](#compatibility-and-beta-status) ·
> [compatibility matrix](docs/COMPATIBILITY.md) · [release ledger](docs/RELEASE_STATUS.md).

OMP Session Gateway is a local-first companion for Oh My Pi (OMP). The terminal remains the source
of truth: the gateway is a private directory for already-running interactive OMP processes, a
metadata-only attention queue, and a just-in-time **View**/**Control** capability broker — not a
second agent client. Opening a session hands off to OMP's existing encrypted `collab-web`
interface; the gateway never stores or renders transcripts.

This is a community project and is not affiliated with or endorsed by the Oh My Pi maintainers.

## How it works

<div align="center">
<img
  src="docs/media/omp-session-gateway-product-flow.png"
  alt="Three-step product flow: discover every live OMP session automatically, triage the oldest request that needs attention, and open the exact encrypted OMP collaboration session with View or Control."
  width="1100"
>
</div>

<table>
  <tr>
    <td align="center" width="33%">
      <img src="docs/media/01-all-clear.png" alt="OMP Sessions directory in the All clear state, showing a Live · 4 pill and four working sessions, none waiting for input" width="260"><br>
      <strong>Every session, automatically</strong><br>
      <sub>No per-session command, QR scan, or link copy.</sub>
    </td>
    <td align="center" width="33%">
      <img src="docs/media/02-needs-you.png" alt="Sessions directory in the Needs you state with two waiting requests: the oldest, Gateway auth hardening, is promoted to a hero card with Open request and View transcript instead actions, ahead of Release qualification and three working sessions" width="260"><br>
      <strong>The oldest ask first</strong><br>
      <sub>Bounded metadata outside; the authoritative prompt stays in OMP.</sub>
    </td>
    <td align="center" width="33%">
      <img src="docs/media/03-open-request.png" alt="OMP's encrypted collaboration client opened on the exact request that was waiting for input" width="260"><br>
      <strong>One tap to the real session</strong><br>
      <sub>View or Control opens OMP's existing encrypted client.</sub>
    </td>
  </tr>
</table>

<sub>All media on this page is captured from the built app and pinned collaboration client, driven
by seeded synthetic fixture data — no real sessions, hosts, accounts, or capabilities. Regeneration
steps: [`docs/media/README.md`](docs/media/README.md) · MP4 master:
[`omp-session-gateway-demo.mp4`](docs/media/omp-session-gateway-demo.mp4).</sub>

## The problem

OMP's `/collab` feature already provides an excellent browser experience, but each running session
must be started and opened individually — a per-session command, then a link or QR code moved to
the phone. With several terminals that does not scale. The gateway removes that per-session
ceremony without widening exposure: it lists every live OMP session automatically, surfaces a
metadata-only **Needs you** state when one is waiting for human input, opens read-only or
full-control collaboration in one tap, removes stale sessions on its own, and keeps collaboration
capabilities out of the public Internet, logs, notifications, and persistent browser storage.

## User experience

After installation and tailnet configuration:

1. `omp-gatewayd` starts automatically when the desktop user logs in; `omp-gateway serve` provides
   the equivalent foreground/development entry point.
2. Tailscale Serve exposes only the loopback dashboard/API to approved tailnet identities.
3. Each interactive `omp` process automatically starts collaboration when configured and registers
   its current view/control capability through authenticated local IPC.
4. The Android PWA lists every live process within a few seconds: a FIFO **Needs you** queue when
   anything is waiting, otherwise **All clear** and the working sessions.
5. **Open request** launches Control for the oldest ask; **View transcript instead** stays
   read-only. The healthy gateway shell stays quiet, distinguishes gateway and relay interruptions
   when they persist, and keeps each answer at `Sending…` until OMP acknowledges it. After an
   authoritative answer, it offers the next ask or returns to the exact directory order and scroll
   position.
6. An explicit dashboard action enables background Web Push alerts; each device chooses Private,
   Session, or Preview detail. A tap revalidates the exact live request and opens Control through
   the ordinary no-store, in-memory launch path; no collaboration capability enters push or a URL.
7. Session switches, exits, crashes, daemon restarts, and phone/tailnet outages reconcile without
   manual cleanup or a prominent Refresh control.

<div align="center">
<img
  src="docs/media/04-notification-settings.png"
  alt="Background alerts settings sheet titled Notification detail, with per-device Private, Session, and Preview levels, Session selected as the default, and a Disable background alerts action"
  width="300"
><br>
<sub>Notification detail is chosen per device; payloads are built at the chosen level — the phone
never redacts.</sub>
</div>

## Compatibility and beta status

The beta is qualified for exact combinations, not platform families. Anything not named below is
unsupported and must not be treated as a working deployment path.

| | Current claim |
|---|---|
| Release | `v0.1.0-beta.1`, independently qualified against signed candidate `v0.1.0-prealpha.20` |
| Hosts | Debian 13 (trixie) x86-64 · macOS 26.6.1 arm64 |
| Client | Chrome `151.0.7922.171` on Android 17 (Pixel 10 Pro) |
| Remote path | Tailscale Serve over tailnet HTTPS, TUN-mode client, Funnel disabled |
| OMP baseline | Exact `v17.4.1` plus the repository's pinned patch and versioned `omp-gateway-patched` route |

**Upstream baseline.** Beta targets exact OMP `v17.4.1` at
`9350b7990d26ebf69a604edc82d8558ef04adf30`, observed and qualified on **2026-08-21**.
Stock OMP is insufficient; the required versioned build/activation route is
[`patches/oh-my-pi/README.md`](patches/oh-my-pi/README.md#supported-beta-prerequisite-route-linux-and-macos).
The published alpha remains immutable at its recorded v17.3.8 commit. Exact package and source
metadata: [`UPSTREAM.lock.json`](UPSTREAM.lock.json).

Known limits are part of the claim — read them before installing:

- **TUN mode is mandatory.** With userspace-networking `tailscaled` there is no tunnel device,
  every tailnet peer arrives as a loopback peer, and the gateway fails closed rather than believing
  an identity header ([#98](https://github.com/alphastorm/omp-session-gateway/issues/98)). See
  [Build and run](#build-and-run) for the `doctor` signal.
- **Never enable Tailscale Funnel.** There is no supported public-Internet path.
- **Android radio transitions are unproven.** Chrome for Android can wedge its process-wide network
  stack after an abrupt radio change while the device stays healthy; recovery may require
  force-stopping Chrome ([#65](https://github.com/alphastorm/omp-session-gateway/issues/65)).
- **Preview notification detail currently falls back to Session detail** — the OMP publisher
  carries no bounded preview field yet.
- **Windows source acceptance passes, but Windows is not advertised.** A persistent Server 2025 VM
  passed install, reboot→interactive-login startup, `doctor` 17/17, rotation, upgrade/rollback,
  patched OMP publication, and uninstall. Exact signed gateway/OMP artifacts must repeat the lane
  before support is claimed ([#90](https://github.com/alphastorm/omp-session-gateway/issues/90)).
- **Untrusted local accounts are out of scope.** V1 assumes a user-controlled workstation: a direct
  loopback caller can forge non-cryptographic Tailscale identity headers. Do not deploy on a shared
  shell host.
- **Self-hosted or proxied relay modes are unsupported.** The beta keeps OMP's existing
  end-to-end-encrypted relay.

The [compatibility matrix](docs/COMPATIBILITY.md) defines the supported boundary; the
[release ledger](docs/RELEASE_STATUS.md) holds the exact per-candidate evidence and is
authoritative where they disagree.

## Build and run

Requires Bun 1.3.14 or newer:

```sh
bun install --frozen-lockfile
bun run check

# Loopback-only development mode
bun apps/gateway/src/cli.ts serve \
  --dev-localhost \
  --port 4317 \
  --origin http://127.0.0.1:4317
```

Production installation requires an exact tailnet HTTPS origin and at least one normalized
Tailscale login:

```sh
bun run build
bun apps/gateway/src/cli.ts install \
  --origin https://host.tailnet.ts.net \
  --allow user@example.com
bun apps/gateway/src/cli.ts serve-guidance
bun apps/gateway/src/cli.ts doctor
```

**Run Tailscale's TUN-mode client on the gateway host.** With
`tailscaled --tun=userspace-networking` there is no tunnel device, so its netstack forwards inbound
tailnet connections to `localhost` and every tailnet peer reaches the loopback listener as a
loopback peer. The daemon detects that and returns `403` to every request rather than believing an
identity header, `doctor` reports `loopbackTrustSound: false`, and the log carries one
`http.identity_trust_unsound`. If a correctly configured host is refused, that check is what to
look at first.

Never enable Tailscale Funnel. Stock OMP is insufficient: build and launch participating sessions
with the exact versioned v17.4.1 patch route in
[`patches/oh-my-pi/README.md`](patches/oh-my-pi/README.md#supported-beta-prerequisite-route-linux-and-macos),
then set `collab.autoStart` to `view` or `control`; see
[`docs/OPERATIONS.md`](docs/OPERATIONS.md).

Build the deterministic Bun-runtime archive and checksum manifest with `bun run release:build`.
An archive is qualified only for the exact platform and candidate combination recorded in
[`docs/RELEASE_STATUS.md`](docs/RELEASE_STATUS.md); a build from `main` carries no native
qualification until a lane has been run against those bytes and its record attached to a tag.

## Architecture

```mermaid
flowchart LR
    OMP1[OMP process A] -->|user-only IPC| GATEWAY[Session Gateway daemon]
    OMP2[OMP process B] -->|user-only IPC| GATEWAY
    OMPN[OMP process N] -->|user-only IPC| GATEWAY

    PHONE[Android PWA] -->|tailnet HTTPS| SERVE[Tailscale Serve]
    SERVE -->|loopback HTTP + identity headers| GATEWAY

    PHONE -->|encrypted collaboration frames| RELAY[OMP relay]
    OMP1 -->|encrypted collaboration frames| RELAY
    OMP2 -->|encrypted collaboration frames| RELAY
    GATEWAY -->|encrypted metadata-only push| PUSH[Browser push service]
    PUSH -->|wake service worker| PHONE
```

The recommended v1 keeps OMP's existing end-to-end-encrypted relay and uses the gateway only for
private discovery and just-in-time capability delivery. A self-hosted relay remains an optional
later deployment mode. Deeper detail: [architecture](docs/ARCHITECTURE.md) ·
[protocol](docs/PROTOCOL.md) · [operations](docs/OPERATIONS.md).

## Why PWA first

OMP already ships `packages/collab-web`, which renders the transcript, streaming output, tool
cards, prompts, interrupts, and subagent controls. A native Android client would duplicate the most
security-sensitive and compatibility-sensitive parts of OMP.

The v1 path is therefore:

- mobile-first PWA for the session directory;
- existing OMP `collab-web` for the actual session;
- optional Trusted Web Activity packaging later; and
- no independent native implementation of OMP's collaboration protocol.

## Security model

OMP collaboration links are bearer capabilities. The implementation treats both view and control
links as secrets.

Release-blocking invariants include:

- capabilities remain in OMP/gateway/browser memory only;
- list and SSE APIs return metadata only;
- launch capabilities are fetched only after an explicit tap and use `Cache-Control: no-store`;
- no capability enters logs, telemetry, crash reports, files, cookies, Local Storage, IndexedDB, Cache Storage, query strings, or service-worker caches;
- the HTTP server binds only to loopback by default;
- identity headers are believed only while Tailscale's tunnel device is present, because a
  userspace-networking `tailscaled` forwards inbound tailnet traffic to that loopback listener and
  the caller then arrives indistinguishable from a local one;
- production requests require a verified and allowlisted Tailscale identity;
- the local registry uses user-only IPC plus a random 256-bit installation token;
- stale and replaced generations become unlaunchable promptly; and
- the default deployment never enables Tailscale Funnel.

See [the threat model](docs/SECURITY.md) and [security reporting policy](SECURITY.md).

## How it compares

Remote access to live OMP sessions is an active ecosystem — see the upstream
[discussion](https://github.com/can1357/oh-my-pi/discussions/6460) that inventories these efforts.
The comparison below was source-verified against each project's public README and package metadata
on **2026-08-21**; these projects move quickly, so check their current documentation before
choosing. None of them — including this one — is affiliated with or endorsed by the Oh My Pi
maintainers, and OMP itself may grow first-party enrollment and session listing
([oh-my-pi#6171](https://github.com/can1357/oh-my-pi/issues/6171),
[oh-my-pi#6354](https://github.com/can1357/oh-my-pi/pull/6354)) that would reshape this landscape.

| | OMP Session Gateway | [`omp-deck`](https://github.com/bjb2/omp-deck) 0.6.1 | [`oh-my-portal`](https://github.com/gosuda/oh-my-portal) | [`claudecodeui`](https://github.com/siteboon/claudecodeui) (CloudCLI) | [`pi-agent-dashboard`](https://github.com/BlackBeltTechnology/pi-agent-dashboard) |
|---|---|---|---|---|---|
| Workflow boundary | Private directory, attention queue, and just-in-time View/Control broker for already-running terminal OMP sessions; not a second client | Web cockpit hosting its own OMP SDK sessions plus kanban, plan mode, inbox, knowledge base, routines, and messaging bridges | Skills plugin that exposes an agent from the phone — web chat, real terminal, sharing, notify — for OMP, Claude Code, Codex, Gemini CLI, and opencode | Web/desktop/mobile UI for Claude Code, Cursor CLI, and Codex with chat, shell, file and git explorers | Browser dashboard to spawn, mirror, and drive [`pi`](https://github.com/badlogic/pi-mono) agents; its README states Oh My Pi is **not** supported |
| Zero-touch discovery of live terminal sessions | Yes — every live interactive OMP process registers through authenticated local IPC; no per-session command | No terminal attach; the deck creates and hosts its own sessions in-process | Per-surface setup through skills; its `omp-collab` skill shares one OMP session over OMP's own path | Discovers existing session files automatically; live terminal mirroring for OMP is proposed in the open PR below | For `pi` only, via a bridge extension loaded into every session |
| Mobile surface | Android-first installable PWA with opt-in Web Push attention alerts, qualified on physical Pixel hardware | Responsive web app; Telegram bridge for DM-driven use | Phone browser over encrypted Portal tunnels; push via self-hosted ntfy | Responsive mobile design, hosted cloud, and desktop companion apps | Mobile-friendly responsive layout |
| Exact OMP collab client reuse | Yes — View/Control opens OMP's own encrypted `collab-web` client from pinned upstream source; no second chat surface | No — own chat surface over the embedded OMP SDK (`@oh-my-pi/*` 15.1.7) | No — own web chat over OMP RPC; `omp-collab` reuses OMP collab links separately | No — own transcript UI over ACP stdio | No — own WebSocket mirror protocol, `pi` only |
| Attention triage | Metadata-only FIFO **Needs you** queue; the oldest ask is promoted to **Open request**; **All clear** otherwise | Plan-mode approvals and queued prompts per session; no cross-session attention queue described | `agent-notify` pushes when the agent needs you (labels-only content) | Interactive per-tool approvals in the UI; no cross-session queue described | Interactive `ask_user` prompts inside a session view |
| Capability and secret handling | Collaboration capabilities stay memory-only, fetched `no-store` after an explicit tap; never in logs, URLs, push, or browser storage | Provider OAuth/API keys in `~/.omp/agent/auth.db` and a deck-managed `.env`, masked in the UI | Password/token gate per surface; hosted `my.omp.sh` link option is end-to-end encrypted | Agent tools disabled by default and enabled selectively; uses your own provider subscriptions | Provider keys in `auth.json`; paired-device bearer tokens for its MCP endpoint |
| Remote path | Tailscale Serve over tailnet HTTPS only; loopback-only bind, TUN mode required, Funnel and public access unsupported | Loopback-only default; you front it with Tailscale Serve, an SSH tunnel, or an authenticated reverse proxy | Portal relay tunnels — end-to-end encrypted, terminating on your machine, behind a mandatory auth gate | Self-hosted on your network (`[yourip]:port`), documented remote-server setup, or the hosted CloudCLI Cloud | `localhost:8000` by default; optional zrok public tunnel with persistent URLs; mDNS LAN discovery |
| Transcript storage | None — the directory renders bounded metadata only; transcripts stay in OMP | Sessions persist and resume by design (shared `~/.omp/agent` store; deck state in SQLite and markdown) | Web chat keeps conversation memory; the terminal is a live tmux | Session history persisted, with resume and paging | Mirrors live sessions and lazy-loads historical `pi` session files |
| Install maturity and support | **Qualified beta, not stable**: signed artifacts and a per-release evidence ledger for exact host/client combinations; requires the pinned six-commit OMP patch and versioned binary route; everything else unsupported | npm `0.6.1` global install or `bunx`; CI matrix and container builds | Plugin-marketplace install; contract-tested frontend bridge | Established npm/Docker/desktop/cloud distribution (AGPL-3.0); **OMP support is an open, unmerged PR ([#1143](https://github.com/siteboon/claudecodeui/pull/1143)) as of 2026-08-21** | Mature npm/Electron/Docker installers for `pi`; the only OMP route is a community fork ([`omp-agent-dashboard`](https://github.com/oldschoola/omp-agent-dashboard)), **fork-only and dormant since 2026-07** with no upstream merge path |
| Official OMP affiliation | None — independent community project | None | None | None | None; targets `pi`, not OMP |

Where each one shines:

- **`omp-deck`** has the strongest around-the-chat workflow layer — kanban, routines, a knowledge
  base, an inbox, plan-mode approvals, and durable resumable sessions. Choose it when the browser
  should be a persistent cockpit and hosting sessions inside it is acceptable.
- **`oh-my-portal`** has the broadest agent coverage, and is the only one offering full terminal
  access and per-person teammate sharing from a phone, with conversational skill-driven setup.
- **`claudecodeui` (CloudCLI)** has the most established distribution — npm, Docker, desktop apps,
  and a hosted cloud — and its proposed OMP integration needs no OMP patch at all; note that OMP
  support is not merged yet.
- **`pi-agent-dashboard`** is the richest dashboard in the `pi` ecosystem (session spawning, flows,
  OpenSpec, plugins, polished installers) — but it targets `pi`, not OMP.
- **OMP Session Gateway** is the only one that attaches through OMP's own encrypted collaboration
  path and reuses the exact upstream client, with zero-touch discovery of terminal sessions, a
  metadata-only attention queue, memory-only capability handling, and per-release qualification
  evidence. The cost of that approach today is an exact OMP version pin plus the repository's
  six-commit patch.

Choose OMP Session Gateway when the desired change is narrowly: “make every current terminal OMP
session safely reachable from my phone without copying links.” Choose one of the others when the
desired change is a broader browser-first working environment, multi-agent coverage, or raw
terminal access. The gateway is intentionally not a chat rewrite, task system, routine engine,
knowledge base, or messaging hub; reusing `collab-web` is the point.

## Repository layout

| Path | Purpose |
|---|---|
| `apps/gateway` | Loopback daemon, authenticated registry IPC, HTTP API, CLI, services, and diagnostics |
| `apps/web` | Mobile session directory PWA and no-secret service worker |
| `packages/protocol` | Versioned runtime-validated IPC and browser contracts |
| `packages/collab-client` | Pinned OMP `collab-web` source and in-memory bootstrap patch |
| `patches/oh-my-pi` | Apply-ready controller, auto-start, and publisher patch for pinned OMP |
| `scripts/build-web.ts` | Reproducible hashed PWA/client asset build |
| `scripts/build-release.ts` | Deterministic Bun-runtime release archive and SHA-256 manifest |
| `docs/media` | Canonical README media plus its seeded-fixture capture provenance |
| `docs/` | Architecture, protocol, security, operations, compatibility, and acceptance plans |
| `UPSTREAM.lock.json` | Exact OMP source and package baseline |


## Contributing and releases

The project is intended to be developed in public. See:

- [Contributing](CONTRIBUTING.md)
- [Governance](GOVERNANCE.md)
- [Roadmap](ROADMAP.md)
- [Security policy](SECURITY.md)
- [Repository bootstrap](docs/REPOSITORY_BOOTSTRAP.md)

No telemetry, analytics, or hosted control plane is planned for v1.

## License

MIT. See [LICENSE](LICENSE).
