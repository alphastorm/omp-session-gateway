# Security policy

## Project status

OMP Session Gateway is currently pre-alpha and contains an implementation handoff rather than production-ready software. Do not expose an unfinished implementation to untrusted networks or use it to protect sensitive OMP sessions.

## Reporting a vulnerability

Please report suspected vulnerabilities privately through GitHub's **Security Advisories** feature for the repository once it is published. Do not open a public issue containing:

- collaboration links or URL fragments;
- publisher tokens;
- transcript content;
- Tailscale identity details;
- filesystem paths that reveal private project names; or
- exploit steps that would put current users at immediate risk.

Until a private reporting channel is configured, contact the repository owner through a private channel listed in their GitHub profile. The maintainer should add a dedicated security contact before the first alpha release.

## What to include

Include the affected version/commit, deployment mode, impact, minimal reproduction, and whether any bearer capability or transcript data may have been exposed. Redact all live secrets and use synthetic fixtures.

## Response expectations

The initial maintainer should document response targets before the first public release. A reasonable starting policy is:

- acknowledge within 3 business days;
- provide an initial severity assessment within 7 business days; and
- coordinate disclosure after a fix or mitigation is available.

These are goals, not a service-level guarantee for a volunteer project.

## Security design

The detailed threat model, trust boundaries, and release gates are in [`docs/SECURITY.md`](docs/SECURITY.md). Changes to authentication, capability handling, IPC, browser storage, logging, or OMP lifecycle must update that document and include security-focused tests.

## Supported versions

No version is currently supported for production use. After the first stable release, this file should contain an explicit supported-version table and end-of-support policy.
