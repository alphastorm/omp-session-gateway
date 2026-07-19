# Release process

## Pre-alpha

The repository can produce a working Bun-runtime pre-alpha archive, but it must not be described as an alpha or production release until the gates below pass. Repository commits remain preferred while platform and Android qualification is incomplete.

## Alpha release gates

Before publishing an alpha binary:

- private vulnerability reporting is enabled;
- `UPSTREAM.lock.json` contains an exact tested OMP commit;
- all automated unit/integration/E2E/security tests pass;
- advertised OS installers have been qualified;
- capability-leak scans cover logs, files, browser stores, caches, history, diagnostics, and CI artifacts;
- the default listener is proven loopback-only;
- Tailscale identity and Origin protections have negative tests;
- all vendored collab-web assets have provenance and license notices;
- configuration and upgrade behavior are documented;
- known limitations are listed prominently.

## Build and provenance

Run `bun run check` and then `bun run release:build`. The builder emits a deterministic
`dist/release/omp-session-gateway-0.1.0-bun.tar` plus `SHA256SUMS`; it contains no source maps.
This runtime-neutral Bun archive is not a substitute for qualified platform installers.

Build release artifacts in protected CI from a signed or protected tag. Publish:

- platform binaries/installers;
- SHA-256 checksums;
- build provenance/attestations when available;
- SBOM or dependency inventory;
- exact OMP/collab-web source commit;
- registry/API protocol versions;
- migration and rollback notes.

Do not upload source maps, logs, test recordings, or diagnostics that might contain fixture capabilities unless the leak scanner has verified them.

## Versioning

Use Semantic Versioning after implementation begins:

- breaking configuration/protocol/security behavior increments the appropriate version;
- pre-1.0 minor versions may contain breaking changes but must state them prominently;
- protocol versions are explicit and not inferred solely from package versions.

## Release notes

Every release note should include:

- status (experimental/alpha/beta/stable);
- compatible OMP versions/commits;
- security-relevant changes;
- user-visible changes;
- configuration or migration steps;
- known issues and rollback instructions; and
- acknowledgements without exposing reporter-sensitive details.
