# Handoff manifest

**Prepared:** 2026-07-19  
**Repository name:** `omp-session-gateway`  
**Status:** open-source-ready implementation handoff; no production implementation yet

## Included

- public README, MIT license, attribution/trademark notices;
- contributor, governance, community conduct, security, roadmap, and release policies;
- authoritative implementation instructions in `AGENTS.md` and a short standalone `AGENT_BRIEF.md`;
- architecture, protocol, threat model, Android/PWA, OMP integration, operations, compatibility, upstream strategy, issue plan, and acceptance tests;
- JSON Schemas for registry, metadata list, SSE, launch request/response, and upstream lock;
- Bun/TypeScript workspace targets for gateway, web, protocol, and collab-client integration;
- GitHub issue forms, pull-request template, CODEOWNERS placeholder, Dependabot, and CI handoff checks;
- example gateway, OMP, and Tailscale policy configuration;
- local validation and capability-leak scanning scripts.

## Important pre-publication replacements

- Replace `OWNER` in `.github/CODEOWNERS` and `.github/ISSUE_TEMPLATE/config.yml`.
- Configure an actual private security-reporting contact/advisory channel.
- Recheck repository, package, executable, domain, and trademark availability.
- Pin an exact current OMP commit in `UPSTREAM.lock.json` before implementation.
- Add third-party notices and a dependency lockfile when dependencies or vendored assets are introduced.

## Validation performed on this snapshot

```text
node --experimental-strip-types scripts/validate-handoff.ts
  handoff validation passed

node --experimental-strip-types scripts/check-capability-leaks.ts
  capability leak scan passed

Local Markdown links, JSON parsing, Draft 2020-12 schema checks,
UPSTREAM.lock.json validation, and GitHub YAML parsing also passed.
```

The intended runtime command is `bun run check`; Node's experimental TypeScript stripping was used only to validate the dependency-free handoff scripts in the artifact-building environment.
