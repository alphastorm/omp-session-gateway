# Launch copy — DRAFT, not published

> **Status: draft only. Nothing in this file has been posted, submitted, or scheduled anywhere.**
> It is prepared for the `v0.1.0-alpha.1` launch window and must not be used before that tag is
> actually published. Immediately before any use, reverify every claim against
> [`docs/RELEASE_STATUS.md`](../RELEASE_STATUS.md) and
> [`docs/COMPATIBILITY.md`](../COMPATIBILITY.md), and replace every `[release link]` placeholder
> with the real tag URL.

All copy below describes a **qualified alpha**. Do not edit it toward beta or production readiness,
broader platform support, or upstream affiliation: this is a community project, not affiliated with
or endorsed by the Oh My Pi maintainers. All referenced media is captured from the built app with
seeded synthetic fixture data — verify no real hostname, path, account, capability, or transcript
appears in anything attached to a post.

## Pre-publish checklist

- [ ] `v0.1.0-alpha.1` is tagged, published, and named as the current release in the ledger.
- [ ] Advertised host/client combinations below still match `docs/COMPATIBILITY.md` exactly.
- [ ] Known-limitation wording (#65 radio transitions, Preview fallback, Windows unadvertised)
      still matches the ledger.
- [ ] Attached media are the canonical files from this directory, unmodified.
- [ ] Every `[release link]` placeholder replaced; links resolve.

## GitHub repository description

**Private, zero-touch mobile access to every live Oh My Pi session.**

Alternative, more concrete:

**Auto-discover live OMP sessions, get alerted when one needs input, and open the exact encrypted
session from Android.**

## README one-liner

**Every live OMP session. One private mobile page.**

## GitHub release body — `v0.1.0-alpha.1`

**Leave the terminal. Keep the session.**

OMP Session Gateway puts every live Oh My Pi session on one private mobile page: automatic
discovery, a metadata-only **Needs you** queue, opt-in background alerts, and one-tap handoff to
OMP's existing encrypted collaboration client.

`v0.1.0-alpha.1` is a qualification point release over `v0.1.0-alpha`. It fixes explicit rollback
hitting systemd's start-rate limit after repeated version switches, hardens alpha lifecycle
boundaries, and re-qualifies the exact signed candidate end to end: the full Debian 13 lifecycle
lane, the macOS 26.6.1 lane including a control-plane reboot, and a physical Pixel capability-sink
sweep with real View/Control handoff.

This is a **qualified alpha**, not a beta. Only the combinations in the
[compatibility matrix](../COMPATIBILITY.md) are advertised: Debian 13 (trixie) x86-64 or
macOS 26.6.1 arm64 hosts with Chrome on Android 17, behind Tailscale Serve with the TUN-mode client
and Funnel disabled. Known limits: Android reconnect after an abrupt radio change remains unproven
(#65); Preview notification detail currently falls back to Session detail; Windows is implemented
but not advertised (#90). Evidence lives in the [release ledger](../RELEASE_STATUS.md).

Community project; not affiliated with or endorsed by the Oh My Pi maintainers.

*Suggested media: `omp-session-gateway-demo.mp4` or `omp-session-gateway-demo.gif`, plus
`omp-session-gateway-product-flow.png`.*

## X post — product-first

I got tired of starting `/collab` and copying a link every time I stepped away from my desk.

OMP Session Gateway puts every live Oh My Pi session on one private mobile page, pings me when one
needs input, and opens the exact encrypted Control surface.

v0.1.0-alpha.1: [release link]

*Attach `omp-session-gateway-demo.mp4` (preferred) or `omp-session-gateway-demo-poster.png`.*

## X post — tighter

Every live Oh My Pi session, one private page on my phone.

OMP Session Gateway auto-discovers sessions, alerts me when one needs input, and opens the exact
encrypted `/collab` surface — no QR scans or copied links.

v0.1.0-alpha.1: [release link]

*Attach `omp-session-gateway-demo.mp4` (preferred) or `omp-session-gateway-demo-poster.png`.*

## Show HN title

**Show HN: OMP Session Gateway – a private mobile directory for every live Oh My Pi session**

## Show HN body

I built OMP Session Gateway because OMP's encrypted `/collab` client is useful away from the desk,
but starting it and moving a link for each terminal session does not scale.

The gateway runs locally, discovers every live interactive OMP process, and presents a private
Android-first PWA over Tailscale Serve. When a session is waiting for input, it rises into a FIFO
`Needs you` queue; tapping it revalidates the exact request and opens OMP's existing encrypted
collaboration client with View or Control.

The gateway intentionally does not replace OMP's client, store transcripts, or expose a public
dashboard. It is an independent community project, not affiliated with the Oh My Pi maintainers.
The current release is a qualified alpha: only the exact combinations in the compatibility matrix
are advertised, Tailscale must run its TUN-mode client, and Android reconnect after an abrupt radio
change is a known open limitation. I would especially value feedback on setup friction, reconnect
behavior, and whether the attention flow matches how people actually run multiple OMP sessions.

## Phrases to avoid

- “Manage all your agents from anywhere.” Too broad; implies a replacement client and public
  reachability.
- “Your AI command center.” Generic and incorrectly expands the product boundary.
- “Never miss anything.” Unprovable, especially for best-effort push and network transitions.
- “Military-grade security.” Meaningless and unsupported.
- “Works on every device.” Contrary to the current qualification model.
- “Beta” or “production-ready.” The release classification is qualified alpha; use that term only.
- Anything implying Oh My Pi affiliation, endorsement, or an official integration.
