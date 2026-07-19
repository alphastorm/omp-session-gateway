# Project positioning and naming

## One-sentence description

**OMP Session Gateway is a local-first, capability-safe gateway that automatically exposes all running Oh My Pi collaboration sessions through one private mobile PWA.**

## User problem

OMP's collaboration page is already useful on a phone, but each live terminal session currently requires a separate manual start/share step and produces a separate secret link. A user with several OMP processes needs one trustworthy place to discover the sessions already running on their computer and open the correct one without copying links.

## Product boundary

OMP Session Gateway is intentionally a thin aggregation and launch layer over OMP's native collaboration feature.

It owns:

- automatic session publication;
- local lifecycle tracking;
- access authorization;
- safe just-in-time capability release;
- a mobile session directory;
- installation, diagnostics, and recovery.

It does not own:

- transcript rendering;
- agent prompting semantics;
- subagent UI;
- OMP's encryption or relay protocol;
- model/session/workflow management beyond what OMP collaboration already permits;
- general remote terminal control.

This boundary keeps the project differentiated from broad dashboards and reduces compatibility and security risk.

## Intended users

Primary:

- developers who run multiple interactive OMP sessions on one workstation;
- people who already use Tailscale on their computer and Android phone;
- security-conscious users who prefer inspectable, self-hosted local software.

Secondary:

- teams evaluating a multi-host or role-based evolution after the single-user v1 is stable;
- downstream dashboards that may consume a future metadata-only API without receiving raw capabilities.

## Name system

| Surface | Canonical name | Notes |
|---|---|---|
| Project and product | OMP Session Gateway | Public prose and headings. |
| Repository | `omp-session-gateway` | Recheck availability before publication. |
| CLI | `omp-gateway` | Human-facing management command. |
| Daemon | `omp-gatewayd` | Long-running background process. |
| PWA | OMP Sessions | Short Android home-screen label. |
| Service | `omp-session-gateway.service` | Linux user unit; analogous names on other platforms. |
| Config namespace | `omp-session-gateway` | Avoid legacy “mobile-hub” names. |

Avoid names that imply a complete replacement UI or a broad management product: “deck,” “studio,” “cockpit,” “dashboard,” or “remote.” “Gateway” accurately communicates the security and launch boundary.

## Public tagline options

Preferred:

> Secure, zero-touch mobile access to every running Oh My Pi session.

Technical:

> A local-first, capability-safe gateway for live OMP collaboration sessions.

Repository description:

> Automatically discover and securely open every running Oh My Pi collaboration session from one private mobile PWA.

## Community relationship

Use this disclaimer prominently until the OMP maintainers request different wording:

> OMP Session Gateway is an independent community project. It is not affiliated with or endorsed by the Oh My Pi maintainers.

Keep the OMP core patch narrow and upstreamable. Coordinate with upstream before introducing public API names, settings, or package integration that OMP would need to support long-term.

## Scope-control test

Before accepting a feature, ask:

1. Does it help discover, authorize, launch, or safely operate an existing OMP collaboration session?
2. Can it be implemented without duplicating OMP's collab protocol/UI?
3. Does it preserve a local-first, memory-only capability model?

A “no” usually means the feature belongs upstream in OMP or in a separate dashboard project.
