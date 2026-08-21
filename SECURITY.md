# Security policy

## Project status

OMP Session Gateway is a qualified alpha, not a stable or production-qualified service. Use only the exact host/client/deployment combinations advertised in [`docs/COMPATIBILITY.md`](docs/COMPATIBILITY.md); do not expose the loopback backend directly, enable Tailscale Funnel, or treat an unqualified platform as supported.

## Reporting a vulnerability

Please report suspected vulnerabilities privately through this repository's [GitHub Security Advisories](https://github.com/alphastorm/omp-session-gateway/security/advisories/new). Do not open a public issue containing:

- collaboration links or URL fragments;
- publisher tokens;
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

`v0.1.0-alpha` is the current published qualified alpha; `v0.1.0-alpha.1` has passed exact-candidate qualification and is pending promotion. Neither is a stable-production support promise. Supported combinations, known limitations, and release-specific evidence are maintained in [`docs/COMPATIBILITY.md`](docs/COMPATIBILITY.md) and [`docs/RELEASE_STATUS.md`](docs/RELEASE_STATUS.md).
