# Security policy

## Project status

OMP Session Gateway v0.4.0 is the current qualified stable release and works with stock OMP
`>= 18.1.20` through its native discovery/query contract. No OMP fork or custom build is required. Use only the exact host/client/deployment combinations advertised in [`docs/COMPATIBILITY.md`](docs/COMPATIBILITY.md); do not expose the loopback backend directly, enable Tailscale Funnel, use Portal Tunnel or another forwarder, or treat an unqualified platform or background Web Push as supported.

## Reporting a vulnerability

Please report suspected vulnerabilities privately through this repository's [GitHub Security Advisories](https://github.com/alphastorm/omp-session-gateway/security/advisories/new). Do not open a public issue containing:

- collaboration links or URL fragments;
- OMP discovery/query tokens, gateway readiness tokens, or legacy publisher tokens;
- transcript content;
- Tailscale identity details;
- filesystem paths that reveal private project names; or
- exploit steps that would put current users at immediate risk.

If GitHub Security Advisories is unavailable, contact `@alphastorm` through a private channel listed on the maintainer's GitHub profile.

## What to include

Include the affected version/commit, deployment mode, impact, minimal reproduction, and whether any bearer capability or transcript data may have been exposed. Redact all live secrets and use synthetic fixtures.

## Response expectations

The volunteer-maintainer response targets are:

- acknowledge within 3 business days;
- provide an initial severity assessment within 7 business days; and
- coordinate disclosure after a fix or mitigation is available.

These are goals, not a service-level guarantee for a volunteer project.

## Security design

The detailed threat model, trust boundaries, and release gates are in [`docs/SECURITY.md`](docs/SECURITY.md). Changes to authentication, capability handling, IPC, browser storage, logging, or OMP lifecycle must update that document and include security-focused tests.

## Supported versions

Use the [current stable release](https://github.com/alphastorm/omp-session-gateway/releases/latest).
The [compatibility policy](docs/COMPATIBILITY.md) defines the exact supported host/client/deployment
matrix; the [release ledger](docs/RELEASE_STATUS.md) records its evidence and known limitations.
The minimum OMP version is not qualification of every later version or platform.

Older releases retain their own historical prerequisites. In particular, v0.3.0 is a fork-era
migration/rollback predecessor, not the current recommended install; crossing that boundary
requires the [stopped recovery procedure](docs/UPGRADE_ROLLBACK.md), and gateway rollback does not
switch OMP. Please report suspected vulnerabilities in any version privately.
