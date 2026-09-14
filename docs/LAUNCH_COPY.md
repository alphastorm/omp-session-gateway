# Launch copy — DRAFT, not posted

> **Status: draft only. Nothing in this file has been posted, submitted, or scheduled anywhere.**
> Prepared for published stable [v0.4.0](https://github.com/alphastorm/omp-session-gateway/releases/tag/v0.4.0).
> Immediately before any use, reverify release, setup, and support claims against the
> [release ledger](RELEASE_STATUS.md) and [compatibility policy](COMPATIBILITY.md).

Stable is the published release classification, not a claim of universal support or production
readiness. This is an independent community project, not affiliated with or endorsed by the Oh My Pi
maintainers. Native integration means using the registry and controller shipped in stock OMP
`>= 18.1.20`; it does not mean the gateway ships with OMP or needs no setup.

Existing media is a **historical synthetic demo**, not a v0.4.0 capture or current qualification
receipt. Preserve its [recorded provenance](media/README.md). The Android toast is capture-only chrome,
not a real system notification; background Web Push remains unqualified on the mainline matrix.
Do not attach these assets without that context or replace them with personal session captures.

## Pre-publish checklist

- [ ] [v0.4.0](https://github.com/alphastorm/omp-session-gateway/releases/tag/v0.4.0) still matches
      the intended release and the current ledger; all outbound links resolve.
- [ ] Setup still requires the separate gateway, Bun 1.4.0, one-time `collab.autoStart`,
      and TUN-mode Tailscale Serve with an exact allowlist and Funnel disabled.
- [ ] Exact host/client qualification and known limits still match the compatibility policy.
- [ ] Attached media are canonical, unmodified, and explicitly labeled historical synthetic demos;
      no real hostname, path, account, capability, or transcript appears.
- [ ] No wording implies guaranteed alerts, production readiness, broader platform qualification,
      personal experience, or upstream affiliation.

## GitHub repository description

**Live terminal OMP sessions, one private mobile page. Uses stock OMP ≥18.1.20 — no fork or gateway-specific OMP plugin.**

## README one-liner

**Every live OMP session. One private mobile page. Works with stock OMP 18.1.20+.**

## GitHub release summary — published stable v0.4.0

**Leave the terminal. Keep the session.**

OMP Session Gateway is a private mobile directory for running interactive Oh My Pi sessions.
Open View or Control in OMP's existing encrypted collaboration client without copying a link
for each session. The gateway keeps bounded session metadata, not transcripts.

[v0.4.0](https://github.com/alphastorm/omp-session-gateway/releases/tag/v0.4.0) uses the native
registry and controller shipped in stock OMP `>= 18.1.20`: no fork, custom OMP build, or
gateway-specific OMP plugin. Install the separate gateway with Bun 1.4.0, enable
`collab.autoStart` once, and configure TUN-mode Tailscale Serve with an exact user allowlist and
Funnel disabled. Then start participating sessions with plain `omp`.

The exact signed-candidate matrix used OMP 18.1.20 and Bun 1.4.0 on Debian 13 x86-64 and
macOS 26.6.1 arm64, with a physical Pixel 10 Pro running Android 17 and Chrome 152.0.7977.82.
The relay check passed for **1,800 seconds**, not eight hours. A separate published-byte
local/Pixel smoke passed with the existing OMP 18.1.21; that does not expand the exact matrix,
and the cause of its initial intermittent Control-upgrade failure remains undetermined.
Windows, background Web Push, specialized attention, branch/resume, and broader host/browser
combinations remain unqualified. See the
[release ledger](https://github.com/alphastorm/omp-session-gateway/blob/main/docs/RELEASE_STATUS.md)
and [compatibility policy](https://github.com/alphastorm/omp-session-gateway/blob/main/docs/COMPATIBILITY.md)
for evidence and limits.

Community project; not affiliated with or endorsed by the Oh My Pi maintainers.

*Optional media: `omp-session-gateway-product-flow.png`, labeled “Historical synthetic demo;
not a v0.4.0 qualification capture.” Preserve the media provenance above.*

## X post — product-first

Your live OMP sessions. One private page on your phone.

OMP Session Gateway v0.4.0 uses stock OMP ≥18.1.20 — no fork or gateway-specific OMP plugin.
One-time setup; then plain omp.

https://github.com/alphastorm/omp-session-gateway/releases/tag/v0.4.0

## X post — tighter

Leave the terminal. Keep the session.

OMP Session Gateway v0.4.0 brings View/Control for running terminal sessions to a private mobile
page using stock OMP ≥18.1.20. Separate gateway + Tailscale setup required.

https://github.com/alphastorm/omp-session-gateway/releases/tag/v0.4.0

*For either post, link-only is sufficient. If attaching existing media, include the historical
synthetic-demo caption and notification caveat above; do not imply a fresh stable-release capture.*

## Show HN title

**Show HN: OMP Session Gateway – live terminal sessions, one private mobile page**

## Show HN body

OMP Session Gateway is for keeping work in the terminal while reaching a running OMP session
from a phone. It discovers participating interactive sessions through stock OMP's native local
registry, then opens View or Control in OMP's existing encrypted collaboration client.

Stock OMP `>= 18.1.20` supplies the registry and controller. No OMP fork, custom build, or
gateway-specific OMP plugin is needed. The gateway is still a separate install: use Bun 1.4.0,
enable `collab.autoStart` once, and set up TUN-mode Tailscale Serve with an exact user allowlist
and Funnel disabled. After that, start sessions with plain `omp`; no per-session link copying.

The gateway is a directory and launch broker, not a replacement chat client or a public dashboard.
It keeps bounded metadata rather than transcripts. Published stable
[v0.4.0](https://github.com/alphastorm/omp-session-gateway/releases/tag/v0.4.0) is qualified on the
exact Debian/macOS/Pixel combination in the
[compatibility policy](https://github.com/alphastorm/omp-session-gateway/blob/main/docs/COMPATIBILITY.md),
not every device or later OMP version. The fresh relay check was 30 minutes, not eight hours;
background Web Push and the other excluded workflows are not part of that claim. The
[release ledger](https://github.com/alphastorm/omp-session-gateway/blob/main/docs/RELEASE_STATUS.md)
also retains an initial intermittent Control-upgrade failure whose cause remains unknown after a
passing post-release smoke. Feedback on setup friction and real phone workflows is welcome.

Independent community project; not affiliated with or endorsed by the Oh My Pi maintainers.

## Phrases to avoid

- “Zero setup” or “zero-touch install.” The gateway, OMP setting, and tailnet need one-time setup.
- “Manage all your agents from anywhere.” Too broad; implies a replacement client and public reachability.
- “Your AI command center.” Generic and incorrectly expands the product boundary.
- “Never miss anything” or “reliable background alerts.” Background Web Push is not qualified here.
- “Military-grade security.” Meaningless and unsupported.
- “Works on every device” or “all OMP versions supported.” Contrary to the exact qualification model.
- “Production-ready” or transferred eight-hour endurance claims. Published stable does not establish either.
- Invented first-person origin stories, usage reports, or testimonials.
- Anything implying Oh My Pi affiliation, endorsement, or an official gateway product.
