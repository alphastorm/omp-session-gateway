# Release process

## Pre-alpha, alpha, beta, and stable artifacts

The repository can produce working Bun-runtime engineering candidates and advertised alpha, beta,
and stable releases. v0.1.0-beta.1 remains the current qualified publication while the exact stable
candidate is prepared. A bare v0.1.0 is the only stable tag shape and becomes GitHub Latest only
after the release ledger records a GO decision for its signed predecessor.

Stable 0.1 is a bounded support claim, not an expansion to platform families. It covers only the
hosts, Android client, TUN-mode Tailscale Serve path, and exact patched OMP baseline recorded in
COMPATIBILITY.md at the release commit. Windows, background Push qualification, Portal Tunnel,
userspace networking, Funnel, self-hosted/proxied relays, stock OMP, and every unnamed combination
remain unsupported.

The supported OMP procedure is the
[versioned omp-gateway-patched route](../patches/oh-my-pi/README.md#supported-01-prerequisite-route-linux-and-macos).
Upstreaming and paired packaging remain deferred under ADR-024 and ADR-025. Every participating OMP
process must use the exact verified binary; the gateway release alone cannot add the missing stock
OMP controller/publication seam.

Gateway rollback does not implicitly switch OMP. A stable-to-beta rollback retains the same exact
v17.4.1 patched OMP prerequisite; use managed gateway rollback when the beta archive remains in
installation history, otherwise reinstall v0.1.0-beta.1. Any change to the active OMP binary or
symlink remains the separate documented manual operation.

## Release gates

The current decision and exact evidence live in RELEASE_STATUS.md; compatibility claims live in
COMPATIBILITY.md. Generated or signed artifacts do not promote themselves.

Every advertised release requires:

- private vulnerability reporting and repository security controls enabled;
- an exact OMP commit, reviewed patch, collab-web provenance, and license inventory;
- all automated unit, integration, browser, type, build, and secret/identifier-leak checks green;
- advertised host installers qualified against the exact signed candidate;
- loopback-only exposure plus positive and negative Tailscale identity/Origin evidence;
- exact physical-client View/Control, stale-generation, lifecycle, and forbidden-sink evidence;
- documented configuration, upgrade, rollback, cleanup, compatibility, and limitations; and
- complete checksums, SBOM, GitHub attestations, Cosign bundles, signed tag, and reproducible build
  verification.

Stable v0.1.0 additionally requires that STABLE_RELEASE.lock.json bind the exact release commit to a
fully passed candidate, candidate archive digest, runtime-byte comparison, Debian, retained
Mac14,3, physical Pixel, patched-OMP publication, provenance, and secret-sink evidence. The workflow
also requires a GitHub-verified signed annotated tag and rechecks its target before draft creation
and public promotion. Issue #65 remains a browser-process environment limitation: after 45
uninterrupted visible failure seconds, the loaded shell offers retry and force-stop/reopen help
without a third-party probe or a claim that JavaScript repaired Chrome.

Before the real stable tag, rehearse the exact gh create/edit flags in a private repository. Require
six assets in the draft and published states, prerelease/not-Latest for the prerelease control,
non-prerelease/Latest for the stable case, a matching latest-release API result, and complete
release/tag cleanup. Record the gh version and resulting JSON in the release ledger.

The protected 28,800-second default-relay result may transfer only while relay host/client,
collab-web, and wire bytes remain identical. A bounded real relay smoke still runs for the exact
candidate. Windows and every other excluded mode are not stable blockers because they are not
advertised; they must remain explicit exclusions.

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

The release workflow accepts only tags matching the current package.json version:

- v<version>-prealpha.<n> for an internal engineering artifact;
- v<version>-alpha[.<n>] for the advertised alpha shape;
- v<version>-beta[.<n>] for the advertised beta shape;
- the exact bare v<version> for the stable GitHub Latest shape; and
- provenance-test-v<version>.<n> for a provenance exercise.

The integer n must be positive. Release-candidate, rc, stable-suffixed, zero-indexed, cross-version,
and all unknown shapes fail before artifact creation. The tagged commit must be reachable from main.

scripts/release-policy.ts is the sole tag classifier. It maps only the bare version to stable,
non-prerelease, and Latest; alpha, beta, pre-alpha, and provenance shapes remain prereleases and
not-Latest. The validated channel selects release-info.json qualification; it cannot author or
widen the claim, and every unknown OMP_RELEASE_CHANNEL fails the build.

`.github/workflows/release.yml` runs `bun run check`, builds the deterministic archive,
checks its SHA-256 digest, and then uses GitHub Actions OIDC for both provenance systems:

- `actions/attest-build-provenance` publishes GitHub build attestations for the archive,
  deterministic SPDX 2.3 SBOM, and `SHA256SUMS`;
- Cosign signs all three files keylessly and writes a Sigstore bundle beside each one; and
- no repository signing key or long-lived signing secret exists.

The workflow creates one complete draft, uploads every asset, then publishes once. Stable is published as a non-prerelease and explicitly marked Latest; every other channel is published as a prerelease with Latest disabled:

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
For a byte-exact rebuild of an advertised tag, set OMP_RELEASE_CHANNEL to that tag's channel. Valid
values are pre-alpha (default), alpha, beta, and stable; every other value fails. The channel moves
release-info.json and nothing else: every other archive member and the SBOM stay byte-identical
across channels. This runtime-neutral Bun archive is not a substitute for qualified host operation.

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
