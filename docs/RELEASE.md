# Release process

## Pre-alpha, alpha, and beta artifacts

The repository can produce working Bun-runtime pre-alpha archives, advertised alpha releases, and
advertised beta releases. `v0.1.0-beta.1` is the current qualified beta, promoted from exact signed
candidate `v0.1.0-prealpha.20`; `v0.1.0-alpha.1` is its gateway rollback predecessor. Neither may
be described as stable or production-qualified, and repository commits remain preferred outside
the exact platform and Android combinations recorded in the release ledger.

`beta` is a closed release channel, not a stability grade. A beta tag advertises the boundary the
ledger already records at its source commit; the tag promotes nothing by itself, and the same
prohibition carries over unchanged: never describe a beta build as stable or production-qualified.
A beta install is supported only against the exact patched OMP baseline pinned in
`UPSTREAM.lock.json` — stock OMP is not sufficient at any version, and paired OMP packaging is not
provided.
The supported beta procedure is the
[versioned `omp-gateway-patched` route](../patches/oh-my-pi/README.md#supported-beta-prerequisite-route-linux-and-macos);
upstreaming and paired packaging are not release gates.

Gateway rollback does not roll OMP back. Stop every participating OMP process, restore the exact
alpha v17.3.8 patched binary/symlink and its source/tree/version/config assertions, then restore the
alpha.1 gateway archive before restarting sessions. Gateway rollback-by-reinstall passed on Debian
and macOS; the manual OMP symlink/config reversal passed in isolation. No coupled or paired
gateway/OMP rollback command is implemented or claimed.

## Alpha and beta release gates

The current release decision, evidence, and open gates are maintained in
[`RELEASE_STATUS.md`](RELEASE_STATUS.md). Exact OMP, protocol, platform, browser, and deployment
claims are maintained separately in [`COMPATIBILITY.md`](COMPATIBILITY.md). A generated archive
does not change either status.

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

Before publishing a beta binary, every gate above still applies, and additionally:

- the advertised host and client combinations in [`COMPATIBILITY.md`](COMPATIBILITY.md) are
  unchanged, or re-qualified against the exact bytes being tagged;
- the exact tested OMP commit and the repository patch are recorded and stated in the release notes
  as a required installation precondition; and
- Windows remains unadvertised, and the Android network-change limitation and the unsupported
  self-hosted or proxied relay modes remain disclosed.

## Default-relay soak qualification

Keep a patched OMP process and the gateway running, then exercise a view-only client for the default
eight hours:

```sh
OMP_GATEWAY_SOAK_PUBLIC_ORIGIN=https://gateway.example.ts.net \
OMP_GATEWAY_SOAK_TAILSCALE_LOGIN=user@example.com \
bun run qualify:relay-soak
```

The harness sends identity headers and receives the launch capability only through a numeric loopback
gateway origin, requires `no-store` metadata and launch responses, never prints the capability, and
fails if the collaboration client ends or is not live at completion. Set
`OMP_GATEWAY_SOAK_INSTANCE_ID` to select one published session. `OMP_GATEWAY_SOAK_SECONDS` may shorten
a diagnostic run to at least one second, but only the default 28,800-second duration qualifies the
long-lived relay scenario. Record the gateway commit, pinned OMP commit/patch, output JSON, final
gateway RSS, host/browser versions, and date in `RELEASE_STATUS.md`; start/end measurements are still
required before claiming bounded memory growth.

## Build and keyless provenance

The release workflow accepts only tags matching the current `package.json` version:

- `v<version>-prealpha.<n>` for an internal pre-alpha artifact;
- `v<version>-alpha[.<n>]` for the advertised alpha shape;
- `v<version>-beta[.<n>]` for the advertised beta shape; and
- `provenance-test-v<version>.<n>` for a provenance exercise.
- `<n>` must be a positive decimal integer.

`release-candidate` and stable tags are intentionally rejected while the platform, Android, and
security gates remain open. The tagged commit must be reachable from `main`.

The validated tag shape is also the only thing that selects the qualification recorded in the
archive's `release-info.json`: `-beta[.<n>]` exports `OMP_RELEASE_CHANNEL=beta`, `-alpha[.<n>]`
exports `alpha`, and `-prealpha.<n>` and `provenance-test-v…` stay `pre-alpha`. A tag can select a
recorded claim but never write one, and any channel outside that closed set fails the build.

`.github/workflows/release.yml` runs `bun run check`, builds the deterministic archive,
checks its SHA-256 digest, and then uses GitHub Actions OIDC for both provenance systems:

- `actions/attest-build-provenance` publishes GitHub build attestations for the archive,
  deterministic SPDX 2.3 SBOM, and `SHA256SUMS`;
- Cosign signs all three files keylessly and writes a Sigstore bundle beside each one; and
- no repository signing key or long-lived signing secret exists.

The workflow creates a draft, uploads the complete asset set, and publishes exactly once:

- `omp-session-gateway-<version>-bun.tar`;
- `omp-session-gateway-<version>.spdx.json`;
- `SHA256SUMS`;
- `omp-session-gateway-<version>-bun.tar.sigstore.json`;
- `omp-session-gateway-<version>.spdx.json.sigstore.json`; and
- `SHA256SUMS.sigstore.json`.

The repository's **Settings → General → Features → Immutable releases** setting is
enabled and required before tagging. A maintainer can confirm it without using a signing
secret:

```sh
gh api repos/alphastorm/omp-session-gateway/immutable-releases --jq .enabled
```

It must print `true`. GitHub applies a 24-hour grace period after publication before
locking the release, assets, and tag and issuing the immutable-release attestation. Treat
the release as final at publication; publish a new tag to correct it.

Run `bun run check` and `bun run release:build` for a local unsigned build. The builder
emits `dist/release/omp-session-gateway-0.1.0-bun.tar`, a deterministic SPDX 2.3 dependency
inventory, and `SHA256SUMS`; the archive also contains `SBOM.spdx.json` and no source maps.
For a byte-exact rebuild of an alpha or beta tag, set `OMP_RELEASE_CHANNEL` to that tag's channel;
valid values are `pre-alpha` (default), `alpha`, and `beta`, and any other value fails the build.
The channel moves `release-info.json` and nothing else: every other archive member, and the SBOM,
stay byte-identical across channels.
This runtime-neutral Bun archive is not a substitute for qualified platform installers.

Do not upload source maps, logs, test recordings, or diagnostics that might contain
fixture capabilities unless the leak scanner has verified them.

## Verify a published build

Install current GitHub CLI and Cosign releases, choose the tag, and download into an empty
directory:

```sh
REPO=alphastorm/omp-session-gateway
TAG=v0.1.0-beta.1
ARCHIVE=omp-session-gateway-0.1.0-bun.tar
SBOM=omp-session-gateway-0.1.0.spdx.json

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
  "$SBOM" \
  SHA256SUMS \
  "$ARCHIVE.sigstore.json" \
  "$SBOM.sigstore.json" \
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
for artifact in "$ARCHIVE" "$SBOM" SHA256SUMS
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
for artifact in "$ARCHIVE" "$SBOM" SHA256SUMS
do
  cosign verify-blob \
    --bundle "$artifact.sigstore.json" \
    --certificate-identity "$CERTIFICATE_IDENTITY" \
    --certificate-oidc-issuer "https://token.actions.githubusercontent.com" \
    "$artifact"
done
```

Successful checksum, build-attestation, Cosign, and immutable-release checks establish
integrity and origin. They do not by themselves satisfy any additional deployment or
support claim; the alpha and beta gates above still apply.

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
