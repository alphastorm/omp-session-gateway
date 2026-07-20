# Release process

## Pre-alpha

The repository can produce a working Bun-runtime pre-alpha archive, but it must not be described as an alpha or production release until the gates below pass. Repository commits remain preferred while platform and Android qualification is incomplete.

The current release decision, evidence, and open gates are maintained in
[`RELEASE_STATUS.md`](RELEASE_STATUS.md). Exact OMP, protocol, platform, browser, and deployment
claims are maintained separately in [`COMPATIBILITY.md`](COMPATIBILITY.md). A generated archive
does not change either status.

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

## Build and keyless provenance

The release workflow accepts only tags matching the current `package.json` version:

- `v<version>-prealpha.<n>` for a pre-alpha build;
- `provenance-test-v<version>.<n>` for a provenance exercise; and
- `<n>` must be a positive decimal integer.

Alpha, beta, release-candidate, and stable tags are intentionally rejected while the
platform, Android, and security gates remain open. The tagged commit must be reachable
from `main`.

`.github/workflows/release.yml` runs `bun run check`, builds the deterministic archive,
checks its SHA-256 digest, and then uses GitHub Actions OIDC for both provenance systems:

- `actions/attest-build-provenance` publishes GitHub build attestations for the archive
  and `SHA256SUMS`;
- Cosign signs both files keylessly and writes a Sigstore bundle beside each one; and
- no repository signing key or long-lived signing secret exists.

The workflow creates a draft, uploads the complete asset set, and publishes exactly once:

- `omp-session-gateway-<version>-bun.tar`;
- `SHA256SUMS`;
- `omp-session-gateway-<version>-bun.tar.sigstore.json`; and
- `SHA256SUMS.sigstore.json`.

The repository's **Settings → General → Features → Immutable releases** setting must be
enabled. The workflow checks this setting and refuses to publish otherwise. GitHub applies
a 24-hour grace period after publication before locking the release, assets, and tag and
issuing the immutable-release attestation. Treat the release as final at publication;
publish a new tag to correct it.

Run `bun run check` and `bun run release:build` for a local unsigned build. The builder
emits `dist/release/omp-session-gateway-0.1.0-bun.tar` plus `SHA256SUMS`; it contains no
source maps. This runtime-neutral Bun archive is not a substitute for qualified platform
installers.

Do not upload source maps, logs, test recordings, or diagnostics that might contain
fixture capabilities unless the leak scanner has verified them.

## Verify a published build

Install current GitHub CLI and Cosign releases, choose the tag, and download into an empty
directory:

```sh
REPO=alphastorm/omp-session-gateway
TAG=provenance-test-v0.1.0.1
ARCHIVE=omp-session-gateway-0.1.0-bun.tar

mkdir release-verification
gh release download "$TAG" --repo "$REPO" --dir release-verification
cd release-verification
```

After GitHub's 24-hour grace period, verify the immutable release attestation and every
release asset. A failure means the release is not yet immutable or the downloaded asset is
not part of the attested release:

```sh
gh release verify "$TAG" --repo "$REPO"
for asset in \
  "$ARCHIVE" \
  SHA256SUMS \
  "$ARCHIVE.sigstore.json" \
  SHA256SUMS.sigstore.json
do
  gh release verify-asset "$TAG" "$asset" --repo "$REPO"
done
```

Verify the archive checksum (`shasum -a 256 -c SHA256SUMS` is the macOS equivalent):

```sh
sha256sum --check SHA256SUMS
```

Verify GitHub build provenance against the exact repository, workflow, and tag ref:

```sh
for artifact in "$ARCHIVE" SHA256SUMS
do
  gh attestation verify "$artifact" \
    --repo "$REPO" \
    --signer-workflow "$REPO/.github/workflows/release.yml" \
    --source-ref "refs/tags/$TAG"
done
```

Verify the independent Sigstore bundles against the GitHub Actions OIDC issuer and exact
workflow-ref certificate identity:

```sh
CERTIFICATE_IDENTITY="https://github.com/$REPO/.github/workflows/release.yml@refs/tags/$TAG"
for artifact in "$ARCHIVE" SHA256SUMS
do
  cosign verify-blob \
    --bundle "$artifact.sigstore.json" \
    --certificate-identity "$CERTIFICATE_IDENTITY" \
    --certificate-oidc-issuer "https://token.actions.githubusercontent.com" \
    "$artifact"
done
```

Successful checksum, build-attestation, Cosign, and immutable-release checks establish
integrity and origin. They do not qualify the pre-alpha for supported use; the alpha gates
above still apply.

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
