# Governance

## Initial model

OMP Session Gateway begins as a maintainer-led open-source project. The repository owner is the initial maintainer and final decision maker while the contributor base is small.

The maintainer is responsible for:

- product scope and release decisions;
- security-response coordination;
- reviewing changes to trust boundaries and capability handling;
- maintaining compatibility with supported OMP releases;
- protecting release credentials and signing/provenance systems; and
- documenting significant decisions publicly.

## Decision process

Routine changes are decided through pull-request review. Significant architectural changes should include an Architecture Decision Record in `docs/DECISIONS.md` with context, options, security impact, and consequences.

For contentious decisions, the maintainer should seek written input from active contributors and upstream OMP maintainers when the change affects OMP integration. Final decisions and rationale remain public.

## Maintainer growth

A contributor may become a maintainer after demonstrating sustained, high-quality work; sound security judgment; respectful review behavior; and familiarity with release/incident procedures. Maintainer additions should be recorded here and announced in a repository discussion or release note.

## Releases

Only maintainers may publish releases. Releases should be built by CI from protected tags, include checksums and provenance when practical, identify the exact supported OMP baseline, and avoid mutable vendored artifacts without recorded source.

## Project scope

The project owns private session discovery, authorization, capability brokering, the mobile session directory, packaging, and OMP integration patches. It does not aim to replace OMP, its collaboration protocol, or its transcript UI.

Scope expansion into a general agent dashboard, hosted SaaS control plane, or independent collaboration protocol requires an explicit ADR and project-owner approval.

## Conflicts of interest

Maintainers should disclose material relationships that could influence dependency, hosting, telemetry, or commercial decisions. Security and privacy defaults must not be weakened to benefit a hosted service.
