# Standalone implementation-agent prompt

Copy the text below into a coding agent after providing it the repository.

---

You are implementing **OMP Session Gateway**, a secure local-first companion for Oh My Pi.

Treat the repository's root `AGENTS.md` as authoritative. Read every file it requires before writing production code. The repository is a pre-alpha implementation handoff, not finished software.

Your goal is to build:

1. a strict TypeScript/Bun gateway daemon and management CLI;
2. a mobile-first metadata-only PWA;
3. safe integration of a pinned OMP `collab-web` build;
4. installers and diagnostics for Linux, macOS, and Windows; and
5. a minimal, upstreamable OMP patch that extracts a shared `CollabController`, auto-starts collaboration when configured, and publishes lifecycle-safe capabilities over authenticated local IPC.

Start by inspecting the current `can1357/oh-my-pi` source. Update `UPSTREAM.lock.json` with an exact commit before relying on any path or type. Record material upstream differences in `docs/DECISIONS.md`.

Implement in the milestone order in `docs/IMPLEMENTATION_PLAN.md` and use `docs/ISSUE_PLAN.md` as the work breakdown. Do not skip directly to the OMP patch before the synthetic registry/PWA path and secret-leak harness are working.

Security requirements are release blockers:

- view and control links are bearer secrets;
- capabilities stay in volatile memory and never enter logs, files, browser storage, caches, query strings, telemetry, diagnostics, or CI artifacts;
- pass launch capabilities directly into a pinned `collab-web` in-memory bootstrap; do not make a URL-fragment handoff the release design;
- list/SSE responses contain metadata only;
- launch is explicit, generation-bound, same-origin, and no-store;
- the production HTTP listener is loopback-only and trusts Tailscale identity headers only behind Tailscale Serve;
- local publication uses user-only IPC and a 256-bit installation token;
- stale generations must be unlaunchable before replacements appear;
- no Funnel, public fallback, terminal scraping, keystroke injection, QR decoding, clipboard monitoring, memory inspection, or private OMP imports;
- reuse OMP's existing collab-web and protocol rather than implementing another transcript/control client.

Keep the repository green. Add tests with each behavior. Use synthetic capabilities and run the leak scanner continuously. Keep commits small and reviewable, document threat-model impact, and update architecture/operations/compatibility docs alongside code.

At the end of each milestone, report completed behavior, commands/tests run, security properties proven, current limitations, and exact next issue. Never claim production readiness until the release gates in `docs/TEST_PLAN.md` pass.

---
