# Open-source and release requirements

## 1. Repository setup

Before making the repository public:

- create it as `omp-session-gateway` under the intended maintainer or organization;
- use `main` as the default branch;
- keep the MIT `LICENSE` and community-project disclaimer;
- enable branch protection, required status checks, signed commits if practical, and private vulnerability reporting;
- enable secret scanning and push protection where available;
- add a monitored security contact and release owner;
- recheck GitHub, package registry, executable, and domain-name collisions;
- replace any placeholder package scope or organization references;
- do not import a `.git` history containing real capabilities, private paths, or generated secrets.

## 2. Public documentation minimum

The first release must include:

- clear install, upgrade, uninstall, and recovery steps;
- a supported OS and OMP compatibility matrix;
- the security threat model and same-user threat limitation;
- Tailscale Serve and least-privilege policy guidance;
- instructions for revoking a lost phone and rotating the publisher token;
- an explicit statement that Funnel/public exposure is unsupported by default;
- a warning never to paste collaboration links into issues;
- upstream patch/fork status and links;
- notices for vendored OMP code and all third-party licenses.

## 3. Licensing and attribution

- New project code is MIT-licensed.
- Preserve OMP's MIT copyright and license notices in copied or substantially adapted files.
- Keep a `THIRD_PARTY_NOTICES.md` file once dependencies or vendored assets are added.
- Record the exact OMP commit used for vendored `collab-web` sources/builds.
- Use original icons and branding unless upstream grants permission to reuse assets.
- Review all dependency licenses before release; do not include code with incompatible terms.

## 4. Supply-chain controls

Release artifacts should include:

- source archive from the release commit;
- platform binaries with SHA-256 checksums;
- an SPDX or CycloneDX SBOM;
- build provenance/attestation where the hosting platform supports it;
- signed tags and release artifacts when maintainers can support key management;
- a documented reproducible-build procedure, or a clear explanation of remaining nondeterminism;
- dependency lockfiles reviewed in the release PR;
- no runtime download-and-execute installer behavior without checksum/signature verification.

Prefer CI-hosted builds from tagged commits over binaries built on a maintainer laptop.

## 5. Privacy and telemetry

The default build must contain:

- no analytics;
- no crash-upload service;
- no telemetry;
- no remote fonts or runtime CDN assets;
- no automatic submission of logs or diagnostics;
- no cloud account requirement.

An explicit future opt-in diagnostics feature would need a separate privacy design and must still exclude capabilities and session content by construction.

## 6. Security release gates

A release candidate is blocked until:

- the full secret-canary suite passes across logs, files, browser state, caches, test traces, screenshots, and diagnostics;
- a network test proves the daemon binds only to loopback;
- unauthorized and missing Tailscale identity cases fail closed;
- view-only mutation attempts are rejected;
- stale generation and TTL tests pass;
- service-worker route auditing proves API/bootstrap exclusion;
- the exact release binaries pass install/upgrade/uninstall tests on every advertised platform;
- dependency and static-analysis findings are triaged;
- `SECURITY.md` has a working private report path.

## 7. Versioning and compatibility

Use pre-1.0 semantic versions while integration surfaces are evolving:

- `0.1.x`: first single-host PWA/gateway release;
- minor version: user-visible compatible feature or new supported OMP range;
- patch version: backward-compatible fix, including security fixes;
- breaking protocol/config change: minor version before 1.0, with migration notes.

Keep the local publisher protocol explicitly versioned. Support a rolling-upgrade overlap where practical, but fail closed on unknown major versions.

Publish a table containing:

- gateway version;
- tested OMP version/tag and commit range;
- tested Bun/runtime version;
- supported desktop OS versions;
- tested Android browser versions;
- known limitations.

## 8. Release process

1. Freeze the exact OMP compatibility target.
2. Update `CHANGELOG.md`, compatibility table, and third-party notices.
3. Run all CI, platform, Android, lifecycle, soak, and security suites.
4. Review generated assets and service-worker precache manifests manually.
5. Build artifacts in clean CI.
6. Generate SBOM, provenance, and checksums.
7. Install and smoke-test the release artifacts, not development builds.
8. Tag and publish release notes with upgrade and rollback instructions.
9. Announce only support claims demonstrated by the release matrix.
10. Monitor private security reports and upstream OMP changes after release.

## 9. Issue and support hygiene

Issue forms must remind users not to attach real links or raw diagnostics. The implemented `omp-gateway doctor --bundle` command should create a deterministic redacted archive and a manifest explaining every included field. Full paths, account identities, transcript data, capabilities, authorization values, tokens, browser storage, and relay frames must be absent by default.
