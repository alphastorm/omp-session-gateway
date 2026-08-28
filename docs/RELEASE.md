# Release process

## Pre-alpha, alpha, beta, and stable artifacts

The repository produces working Bun-runtime engineering candidates and advertised alpha, beta,
and stable releases. v0.2.1 is the current stable publication and GitHub Latest. Its support claim
is bound to the signed predecessor and exact evidence in `STABLE_RELEASE.lock.json` and
`RELEASE_STATUS.md`; generated artifacts never promote themselves.

Stable 0.2 is a bounded support claim, not an expansion to platform families. It covers only the
hosts, Android client, TUN-mode Tailscale Serve path, and exact patched OMP baseline recorded in
COMPATIBILITY.md at the release commit. Windows, background Push qualification, Portal Tunnel,
userspace networking, Funnel, self-hosted/proxied relays, stock OMP, and every unnamed combination
remain unsupported.

The supported OMP procedure is the
[versioned omp-gateway-patched route](../patches/oh-my-pi/README.md#supported-01-prerequisite-route-linux-and-macos).
Upstreaming and paired packaging remain deferred under ADR-024 and ADR-025. Every participating OMP
process must use the exact verified binary; the gateway release alone cannot add the missing stock
OMP controller/publication seam.

Gateway rollback does not implicitly switch OMP. A rollback to the v0.2.0 stable predecessor
retains the same exact v17.4.1 patched OMP prerequisite; use managed gateway rollback when the
predecessor archive remains in installation history, otherwise reinstall the signed v0.2.0
archive. Any change to the active OMP binary or symlink remains the separate documented manual
operation.

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

Stable v0.2.1 additionally requires that the exact signed tag's tree contain a fully passed
STABLE_RELEASE.lock.json candidate tag/source/archive digest, runtime-byte comparison, Debian,
retained Mac14,3, physical Pixel, patched-OMP publication, provenance, and secret-sink evidence.
The workflow asserts checked-out HEAD equals the event SHA, checks candidate ancestry and the
published candidate digest, requires a GitHub-verified signed annotated tag, and rechecks tag state
before public provenance, draft creation, and promotion. Issue #65 remains a browser-process
environment limitation: after 45 uninterrupted visible failure seconds, the loaded shell offers
retry and force-stop/reopen help without a third-party probe or a claim that JavaScript repaired
Chrome.

Run the exact host/client sequence from a clean, published Darwin-arm64 branch:

```sh
bun run qualify:stable --tag v0.2.1-prealpha.2
```

The command re-verifies the signed tag, six release assets, checksums, three GitHub attestations, and three Sigstore bundles; dispatches or resumes the Debian workflow; discovers the retained Scaleway Mac by name; runs install, doctor, exposure, reboot, stable-to-candidate rollback, exact patched-OMP build/publication/revocation, physical-Pixel acceptance and forbidden-sink sweep, and a bounded relay smoke; then uninstalls and removes qualification-owned Mac state. It writes one mode-`0600` receipt at `~/.local/share/omp-session-gateway/qualification/<tag>/stable-qualification.json`.

The receipt resumes only for the same candidate, exact orchestrator commit, and v0.2.0 rollback predecessor. A stale `OMP_STABLE_PREVIOUS_TAG` or mismatched `--previous-tag` is refused before effects; remove the override and rerun the documented command to resume cleanup and qualification. Before Debian dispatch, the command persists a UUID, supplies it as the workflow run name, and discovers the resulting run through the Actions API. An accepted dispatch that is not yet discoverable fails closed rather than creating a duplicate billed run. Before renewed Mac effects, the command reopens the durable cleanup lane so a later process can recover after a crash. Persisted failures are generic markers; diagnostic subprocess errors stay only in the active process output.

Qualification is a single-operator procedure: run exactly one orchestrator process for a tag. Receipt replacement is atomic but is not cross-process locked; concurrent invocations can dispatch two billed Debian runs and contend for the retained Mac.

If a persisted Debian dispatch UUID is not discoverable, do not start a second process or delete the receipt blindly. Search Actions for the exact `Stable qualification <uuid>` title and orchestrator commit. Resume when that run appears. Only after API evidence proves no matching run exists and every Mac-related lane has zero attempts may the operator archive the entire private qualification directory and restart; otherwise recover the recorded Mac cleanup state first. Automatic redispatch is intentionally refused because an accepted-but-delayed workflow cannot be distinguished safely from a rejected request.

Mac qualification receives the archive SHA-256 already verified by the orchestrator and rejects different bytes. The workstation verifies and stages rollback assets, including their Sigstore bundles, so the retained Mac needs no GitHub credential. OMP source commit, patched tree, Bun version, native-package tarball, and extracted native binary are exact pins from `patches/oh-my-pi/qualification.env`.

Prerequisites are `gh`, `cosign`, `adb`, the repository workflow secrets, one attached Pixel, and a mode-private `~/.scaleway-apikey` for the retained `omp-macqual-01` lease. Environment overrides are prefixed `OMP_STABLE_`; `--previous-tag` changes the exact rollback predecessor.

The orchestrator refuses a dirty or unpublished branch, rejects changed candidate or receipt identity, and hash-guards `STABLE_RELEASE.lock.json` plus `docs/RELEASE_STATUS.md`. It never edits either file, creates a stable tag, or publishes a stable release. Ledger approval and stable publication remain separate maintainer effects after the receipt is reviewed.

## Post-release local installation smoke

After a stable release is public, run its published bytes on the configured local Darwin-arm64 Mac
and the attached physical Android client. This is a post-publication install/upgrade smoke, not a
second stable qualification run and not a substitute for `qualify:stable`.

Prerequisites are Bun 1.3.14, `gh`, `cosign`, `git`, `shasum`, `tar`, `plutil`, `tailscale`, `tmux`,
and `adb`; an attached supported Pixel; an existing private gateway config and publisher token; the
configured Tailscale Serve origin; and the **OMP Sessions** WebAPK already installed for that exact
origin. The Android qualification PIN stays in the documented macOS Keychain service.

Zero, unauthorized, or ambiguous adb devices are refused before release download, host mutation, or
fixture creation; set `OMP_ANDROID_SERIAL` when more than one authorized device is attached.

For the current stable, run:

```sh
bunx bun@1.3.14 run smoke:release -- \
  --tag v0.2.1 \
  --archive-sha256 <the omp-session-gateway-0.2.1-bun.tar digest from the published SHA256SUMS>
```

The command verifies the annotated tag, GitHub Latest state, all six release asset digests,
`SHA256SUMS`, three GitHub attestations, three Sigstore bundles, archive source metadata, the hashed
PWA asset, and the exact OMP/Bun pins. It then installs or verifies the stable gateway through the
persistent pinned Bun runtime, proves the config and publisher token remained byte-identical,
creates only the configured Serve mapping while comparing every unrelated mapping, and requires all
`doctor` checks to pass.

The OMP lane reuses an already exact source/runtime or builds the archived patch and pins without
deleting a changed checkout. It starts one uniquely named `omp-post-release-*` tmux fixture carrying
only the synthetic qualification credential, then runs physical View-to-Control prompt/interrupt,
forbidden-sink, lock/Airplane/Doze same-page recovery, and installed-WebAPK launch checks. Target
eligibility is checked before touching the device; protected, soak, old, missing, ambiguous, or
non-Control fixtures fail closed.

Normal success and failure kill only that tmux session, wait for registry revocation, remove the
fixture only when its per-run ownership marker still matches, and delete private staging. The stable
gateway, config/token, Bun runtime, exact patched OMP source/binary/symlink, Serve configuration, and
WebAPK remain installed. `--force-reinstall` retests an already active stable gateway;
`--rebuild-omp` rebuilds only an already exact source/runtime. `--plan` prints the bounded effects
without network, service, Tailscale, OMP, or Android changes.

If the orchestrator is killed before its `finally` cleanup runs, inspect tmux for the single
`omp-post-release-*` name and require the matching
`~/<label>/.omp-session-gateway-post-release-smoke` marker before killing or removing anything.
Never wildcard-delete fixture directories or touch unrelated tmux sessions or Serve mappings.


Before the real stable tag, rehearse the exact gh create/edit flags in a private repository. Require
six assets in the draft and published states, prerelease/not-Latest for the prerelease control,
non-prerelease/Latest for the stable case, a matching latest-release API result, and complete
release/tag cleanup. Record the gh version and resulting JSON in the release ledger.

The protected 28,800-second default-relay result may transfer only while relay host/client,
collab-web, and wire bytes remain identical. A bounded real relay smoke still runs for the exact
candidate. Windows and every other excluded mode are not stable blockers because they are not
advertised; they must remain explicit exclusions.

The superseded release.yml workflow (GitHub workflow ID 316404456) reports state deleted. Hardened
signed-release.yml is active as workflow ID 339848215. Historical tags retain release.yml in their
certificate identity; new tags use signed-release.yml. A run that fails after
attestation or Cosign signing may leave public GitHub
attestations or Rekor entries even when no release is published; those records are failed-attempt
provenance, not an advertised release.
The workflow validates API-observed draft and published flags plus six uploaded asset digests
against the exact local signed files. It retries state observation after 0/2/4/8 seconds. If draft
validation still fails, it deletes the draft; if post-publication tag or release-state validation
still fails, it deletes the release. The signed tag remains for operator diagnosis. Private live
rehearsal proved publication/deletion compensation. Already-public attestation or Rekor records are
not removed and remain failed-attempt provenance.

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

.github/workflows/signed-release.yml runs bun run check, builds the deterministic archive,
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
emits `dist/release/omp-session-gateway-<package-version>-bun.tar`, a deterministic SPDX 2.3 dependency
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
WORKFLOW=$([ "$TAG" = v0.1.0-beta.1 ] && printf release.yml || printf signed-release.yml)
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
    --signer-workflow "$REPO/.github/workflows/$WORKFLOW" \
    --source-ref "refs/tags/$TAG"
done
```

Verify the independent Sigstore bundles against the GitHub Actions OIDC issuer and exact
workflow-ref certificate identity:

```sh
CERTIFICATE_IDENTITY="https://github.com/$REPO/.github/workflows/$WORKFLOW@refs/tags/$TAG"
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
