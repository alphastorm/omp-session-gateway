# Release process

## Pre-alpha, alpha, beta, and stable artifacts

The repository produces Bun-runtime candidates and publishes only the exact support claim proven
by their signed-artifact qualification. Current source requires stock mainline OMP `>= 18.1.20`;
[PR #11908](https://github.com/can1357/oh-my-pi/pull/11908), merge `4999b98bd5`, ships in [OMP v18.1.20](https://github.com/can1357/oh-my-pi/releases/tag/v18.1.20). Configure `collab.autoStart` alone and launch
plain `omp`. The gateway reads discovery and queries hosts, with no OMP patch set or separate
activation route. It fetches capabilities only per launch and never stores them.

For the current published stable and normal installation, use
[Installation and operations](OPERATIONS.md#2-cli-and-daemon-installation), not the maintainer
qualification commands below. The exact qualified candidate, promoted stable artifact,
host/client matrix, and post-release evidence are recorded in the
[release ledger](RELEASE_STATUS.md). Candidate approval does not imply stable publication or a
passed published-byte smoke. Fork-era locks and receipts cannot authorize the changed runtime bytes.

The remote boundary remains TUN-mode Tailscale Serve with an exact allowlist and Funnel disabled.
Windows, background Push qualification, Portal Tunnel, userspace networking, public forwarding,
and self-hosted/proxied relays remain outside the core claim. A minimum OMP version does not
qualify every future release or platform.

Gateway rollback does not switch OMP, restore the previous configuration, or restore the removed
fork-era publication credential. Qualify the selected predecessor and architecture-crossing
recovery explicitly; see [UPGRADE_ROLLBACK.md](UPGRADE_ROLLBACK.md).

## Mainline stable release procedure

This sequence published v0.5.0 (#222–#225) and v0.5.1 (#227–#230). Each step is a separate effect;
a candidate, a passed receipt, or an approved lock never promotes itself. Work from a clean checkout
of `main` that matches `origin/main` (`qualify:stable` refuses detached or unpublished commits), with
pinned Bun `1.4.0` first on `PATH`.

Three steps need an explicit maintainer decision: the release itself (scope, promotion, and
publication), the live qualification run (a billed Debian droplet, the retained Mac, the attached
Pixel, and the relay check), and the published-byte smoke (it upgrades the installed gateway and
drives the Pixel).

1. **Prepare the candidate.** One `chore(release): prepare X.Y.Z` PR bumps the version in the five
   `package.json` files, `PRODUCT_VERSION` in `apps/gateway/src/diagnostics.ts` and
   `scripts/build-release.ts`, and `GATEWAY_VERSION` in `apps/gateway/src/installation.ts`; cuts the
   `CHANGELOG.md` section; updates the highlights and rollback text in
   `.github/workflows/signed-release.yml`; and notes the preparation in the release ledger. After it
   merges, push a signed annotated `vX.Y.Z-prealpha.1` tag on the merge commit and
   [verify the published candidate](#verify-a-published-build).
2. **Qualify it.** Run `bun run qualify:stable --tag vX.Y.Z-prealpha.1 --preflight`, which checks
   admission prerequisites without effects, then the same command without `--preflight` (about 45
   minutes; see [Release gates](#release-gates)). The droplet workflow takes only an exact candidate
   tag. After a failure, fix the cause on `main`, keep the failed receipt unchanged, and archive it
   only as the release gates allow before rerunning. Afterwards confirm that no qualification
   droplet or ephemeral SSH key remains in the DigitalOcean account.
3. **Promote it.** One `chore(release): approve vX.Y.Z for stable promotion` PR sets
   `STABLE_RELEASE.lock.json` from the passed receipt, records every lane and any failed attempt in
   the ledger, moves the COMPATIBILITY release paragraph, the status page, and `site/llms.txt` to
   "qualified; publication pending" wording, and writes the predecessor section of
   [UPGRADE_ROLLBACK.md](UPGRADE_ROLLBACK.md). Install and download surfaces link to the latest
   release and name no version. `scripts/site-coherence.test.ts` fails while any of these disagree
   with the stable lock. A clean
   `OMP_RELEASE_CHANNEL=stable bun run release:build` of that tree must match every candidate
   archive member by path, mode, and bytes, except `release-info.json`, `SBOM.spdx.json`,
   `STABLE_RELEASE.lock.json`, and `schemas/stable-release.schema.json`. Before merging, run
   `bun run check`, `bun scripts/release-policy.ts vX.Y.Z X.Y.Z STABLE_RELEASE.lock.json`, and
   `bun run smoke:release -- --tag vX.Y.Z --plan`.
4. **Publish.** Merge with the head pinned, confirm the merged tree equals the tested tree, and push
   a signed annotated `vX.Y.Z` tag on the merge commit; `signed-release.yml` publishes it. Verify the
   published build, confirm it is GitHub Latest, and reproduce its archive digest with a local
   stable-channel build of the tag.
5. **Smoke the published bytes.** Run the [post-release smoke](#post-release-local-installation-smoke)
   with the verified digest.
6. **Record the evidence.** One `docs(release): record vX.Y.Z publication and installed
   verification` PR moves the COMPATIBILITY release paragraph, the status page, and `site/llms.txt`
   to "published" and records the publication run, source, digest, and smoke result.

Every mainline release so far has renewed a founder-approved fresh 1,800-second relay check in
place of the eight-hour gate. The orchestrator defaults to 1,800 seconds and rejects shorter
checks; `OMP_STABLE_RELAY_SECONDS` may select 1,800–3,600 seconds. Eight-hour endurance is not
rerun or claimed, and no historical eight-hour receipt transfers.

## v0.3.0 qualification and promotion

**Fork-era record:** this section preserves the named v0.3.0 campaign, its commands, and its
patched OMP evidence. It is not a command to republish that immutable version or a mainline result.

Stable **v0.3.0** was published as immutable GitHub Latest for that campaign;
**v0.3.0-prealpha.3** was its signed qualification vehicle.
The host/client matrix, runtime equivalence, and fresh eight-hour relay endurance passed.
The candidate uses exact patched OMP
v18.1.14 and Bun 1.4.0, with **v0.2.1** as the rollback predecessor. Historical qualification
does not transfer. The retained Mac must have the exact pinned Bun before any host lane runs.

The seven-lane orchestrator includes a bounded relay smoke, not the eight-hour endurance gate.
When the pinned client/host path changes, run the full-duration default-relay procedure below;
do not copy a historical long-window pass into the new release decision.

Land the complete candidate changes on `main`, confirm the final source commit, then create and
push the signed annotated candidate tag at that commit. From the clean published Darwin-arm64
checkout, run:

```sh
bun run qualify:stable --tag v0.3.0-prealpha.3
```

Review every lane in the passed receipt before updating `STABLE_RELEASE.lock.json`. The stable
workflow requires the qualified predecessor to remain GitHub Latest, rechecks it immediately before
promotion, and byte-compares the stable runtime against the signed candidate. Do not publish bare
`v0.3.0` with the historical v0.2.1 lock. Gateway rollback does not switch the separately installed
OMP binary; v0.2.1 retains its exact v17.4.1 prerequisite.

Managed candidate upgrades retain hostname, omitted port, identity-trust, and registry settings.
Continue supplying the production origin and allowlist on both installation and upgrade; unchanged
configuration bytes are not rewritten.

## Release gates

The current decision and exact evidence live in RELEASE_STATUS.md; compatibility claims live in
COMPATIBILITY.md. Generated or signed artifacts do not promote themselves.

Every advertised release requires:

- private vulnerability reporting and repository security controls enabled;
- an exact mainline OMP commit, validated discovery/query contract, collab-web provenance, and
  license inventory;
- all automated unit, integration, browser, type, build, and secret/identifier-leak checks green;
- advertised host installers qualified against the exact signed candidate;
- loopback-only exposure plus positive and negative Tailscale identity/Origin evidence;
- exact physical-client View/Control, stale-generation, lifecycle, and forbidden-sink evidence;
- documented configuration, upgrade, rollback, cleanup, compatibility, and limitations; and
- complete checksums, SBOM, GitHub attestations, Cosign bundles, signed tag, and reproducible build
  verification.

Stable publication additionally requires that the exact signed tag's tree contain a fully passed
STABLE_RELEASE.lock.json candidate tag/source/archive digest, runtime-byte comparison, Debian,
retained Mac14,3, physical Pixel, mainline OMP discovery/query and launch/revocation, provenance,
and secret-sink evidence. No fork-era receipt can stand in for one of these new candidate lanes.
The workflow asserts checked-out HEAD equals the event SHA, checks candidate ancestry and the
published candidate digest, requires a GitHub-verified signed annotated tag, and rechecks tag state
before public provenance, draft creation, and promotion. Issue #65 remains a browser-process
environment limitation: after 45 uninterrupted visible failure seconds, the loaded shell offers
retry and force-stop/reopen help without a third-party probe or a claim that JavaScript repaired
Chrome.

The following command and its result are **fork-era v0.2.1 history**, run from that release’s
clean, published Darwin-arm64 branch, not instructions for a mainline candidate:

```sh
bun run qualify:stable --tag v0.2.1-prealpha.2
```

For a selected mainline candidate, `bun run qualify:stable --tag "$TAG"` must re-verify signed
assets and provenance, exercise Debian and retained-Mac lifecycle, the exact predecessor, real
mainline discovery/launch/revocation, physical Pixel acceptance and secret sinks, bounded relay
smoke, and cleanup. It writes a private receipt under
`~/.local/share/omp-session-gateway/qualification/<tag>/stable-qualification.json`. Retargeted
scripts are not qualification evidence until these lanes run against the exact candidate.

The receipt resumes only for the same candidate, exact orchestrator commit, and configured rollback predecessor. A stale `OMP_STABLE_PREVIOUS_TAG` or mismatched `--previous-tag` is refused before effects; remove the override and rerun the documented command to resume cleanup and qualification. Before Debian dispatch, the command persists a UUID, supplies it as the workflow run name, and discovers the resulting run through the Actions API. An accepted dispatch that is not yet discoverable fails closed rather than creating a duplicate billed run. Before renewed Mac effects, the command reopens the durable cleanup lane so a later process can recover after a crash. Persisted failures are generic markers; diagnostic subprocess errors stay only in the active process output.

A resumed relay pass must contain the existing live summary covering at least the requested
duration, with coherent elapsed time and timestamps inside its recorded attempt and campaign.
Missing, shorter, or stale proof fails overall qualification before admission or dispatch; it does
not automatically rerun the relay lane. Recorded pending Mac cleanup still runs, while completed
cleanup remains completed. A historical 60-second pass cannot satisfy this campaign.

Qualification is a single-operator procedure: run exactly one orchestrator process for a tag. Receipt replacement is atomic but is not cross-process locked; concurrent invocations can dispatch two billed Debian runs and contend for the retained Mac.

If a persisted Debian dispatch UUID is not discoverable, do not start a second process or delete the receipt blindly. Search Actions for the exact `Stable qualification <uuid>` title and orchestrator commit. Resume when that run appears. Only after API evidence proves no matching run exists and every Mac-related lane has zero attempts may the operator archive the entire private qualification directory and restart; otherwise recover the recorded Mac cleanup state first. Automatic redispatch is intentionally refused because an accepted-but-delayed workflow cannot be distinguished safely from a rejected request.

Mac qualification receives the archive SHA-256 already verified by the orchestrator and rejects
different bytes. The workstation verifies and stages rollback assets, including their Sigstore
bundles, so the retained Mac needs no GitHub credential. Mainline source and toolchain pins come
from `UPSTREAM.lock.json`; the OMP pin uses `sourceTree`, not a patched-tree assertion, and cleanup
counts `liveOmpHosts`. Fork-era receipt fields remain historical and must not be relabeled as new
mainline output.

Prerequisites are `gh`, `cosign`, `adb`, the repository workflow secrets, one attached Pixel, and a mode-private `~/.scaleway-apikey` for the retained `omp-macqual-01` lease. Environment overrides are prefixed `OMP_STABLE_`. The rollback predecessor comes from `STABLE_RELEASE.lock.json`; `--previous-tag` and `OMP_STABLE_PREVIOUS_TAG` may only restate it.

The orchestrator refuses a dirty or unpublished branch, rejects changed candidate or receipt identity, and hash-guards `STABLE_RELEASE.lock.json` plus `docs/RELEASE_STATUS.md`. It never edits either file, creates a stable tag, or publishes a stable release. Ledger approval and stable publication remain separate maintainer effects after the receipt is reviewed.

## Post-release local installation smoke

From the matching release tooling checkout, run
`bun run smoke:release -- --tag "$TAG" --archive-sha256 "$ARCHIVE_SHA256"` with the exact verified
public digest. The runtime archive does not contain this maintainer script. Use the release’s
Bun/source pins and stock OMP `>= 18.1.20`; require readiness-token/config preservation, mainline
discovery and launch/revocation, physical Android recovery/isolation, and owned-fixture cleanup.
Signed-candidate qualification and prior release smokes do not substitute for a published-byte run.

Every release's published-byte result, including any failed first attempt, is recorded in the
[release ledger](RELEASE_STATUS.md) with its source, digest, preservation, physical-client, and
cleanup evidence.

### Fork-era post-release smoke procedure

All commands, prerequisites, preservation claims, and results in this subsection are retained
for their named historical release checkout. They do not describe mainline setup.

After a stable release is public, run its published bytes on the configured local Darwin-arm64 Mac
and the attached physical Android client. This is a post-publication install/upgrade smoke, not a
second stable qualification run and not a substitute for `qualify:stable`.

Prerequisites are Bun 1.3.14, `gh`, `cosign`, `git`, `shasum`, `tar`, `plutil`, `tailscale`, `tmux`,
and `adb`; an attached supported Pixel; an existing private gateway config and publisher token; the
configured Tailscale Serve origin; and the **OMP Sessions** WebAPK already installed for that exact
origin. The Android qualification PIN stays in the documented macOS Keychain service.

Zero, unauthorized, or ambiguous adb devices are refused before release download, host mutation, or
fixture creation; set `OMP_ANDROID_SERIAL` when more than one authorized device is attached.

This fork-era example ran from the `v0.2.1` checkout with its own Bun and OMP pins. The later
fork-era v0.3.0 engineering source used Bun 1.4.0 and OMP v18.1.14; neither set of bytes is the
current mainline source or a transferable qualification:


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

Before touching the installed gateway, the OMP lane selects the `omp` on `PATH` when it resolves
inside the mainline `@oh-my-pi/pi-coding-agent` package, and otherwise Bun's global install of that
package, so a same-named launcher such as Code Mode is never exercised. The selected binary must be
`>=18.1.20`, and the smoke refuses before any gateway change when no candidate qualifies. It sets
`collab.autoStart` to `control`, then starts one uniquely named `omp-post-release-*` tmux fixture
carrying only the synthetic qualification credential. Every smoke and qualification fixture uses the
model in `scripts/omp-fixture.json`, starts with `OMP_SKIP_SETUP=1` so an onboarding wizard cannot
swallow prompts, and fails as soon as it publishes without a resolved model. The smoke then runs
physical View-to-Control prompt/interrupt,
forbidden-sink, lock/Airplane/Doze same-page recovery, and installed-WebAPK launch checks. The
installed WebAPK may resume either the directory or its existing collaboration route; the launch
check preserves that page instead of requiring the directory title. Target
eligibility is checked before touching the device; protected, soak, old, missing, ambiguous, or
non-Control fixtures fail closed.

Normal success and failure kill only that tmux session, wait for registry revocation, remove the
fixture only when its per-run ownership marker still matches, and delete private staging. The stable
gateway, config/token, Bun runtime, mainline OMP, Serve configuration, and WebAPK remain installed.
`--rebuild-omp` runs `bun add --global --exact` for the pinned package and uses Bun's global bin.
`--force-reinstall` retests an already active stable gateway. `--plan` prints the
bounded effects without network, service, Tailscale, OMP, or Android changes.

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

This optional long-duration lane is not a mainline release gate; each release has used a
founder-approved fresh 30-minute signed-candidate check instead. Only an actual eight-hour run may
be reported as eight-hour evidence.

Keep a stock mainline OMP `>= 18.1.20` host and the gateway running, then exercise a view-only client for the default
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
long-lived relay scenario. Record the gateway commit, exact mainline OMP commit, output JSON, final
gateway RSS, host/browser versions, and date in `RELEASE_STATUS.md`; start/end measurements are still
required before claiming bounded memory growth. Eight-hour endurance is **not rerun or claimed** by
any mainline release. A passed 30-minute candidate check does not establish bounded memory growth;
no fork-era long-window result transfers to the changed host/query/client baseline.

## Fleet CI runtime

Fleet CI is optional shadow verification, not a substitute for required GitHub-hosted checks or
release qualification. Each job installs and verifies the `packageManager` Bun version; the
shared appliance image is not the repository runtime contract. `bun run check:repository` rejects
jobs that skip runtime setup on self-hosted runners or select a different Bun version.

The fleet controller pins the complete workflow digest. After an intentional workflow change,
review and update that profile binding without rewriting historical qualification evidence.
A successful controller dry-run does not prove host readiness; validate the configured appliance
and run a bounded shadow against the exact clean, pushed checkpoint. Do not bypass workload guards
or replace the shared runner image merely to satisfy this repository's Bun pin.

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
TAG="$(gh release view --repo "$REPO" --json tagName --jq .tagName)"
WORKFLOW=signed-release.yml
ARCHIVE="omp-session-gateway-${TAG#v}-bun.tar"
SBOM="omp-session-gateway-${TAG#v}.spdx.json"

mkdir release-verification
gh release download "$TAG" --repo "$REPO" --dir release-verification
cd release-verification
```

Without a tag, `gh release view` resolves the current GitHub Latest release, which is always the
qualified stable. To verify a historical artifact, set `TAG` to it and use its matching signing
workflow: for example, `v0.1.0-beta.1` used `release.yml`, not `signed-release.yml`. Do not
substitute today’s workflow identity for a historical receipt.

Verify the immutable release attestation and every release asset. A failure means the release is not yet immutable or the downloaded asset is
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

On Windows, in PowerShell (prints `True`):

```powershell
$archive = Get-Item omp-session-gateway-*-bun.tar
(Get-FileHash $archive -Algorithm SHA256).Hash -eq (Select-String -Path SHA256SUMS -SimpleMatch $archive.Name).Line.Split(' ')[0]
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
integrity and origin. They do not by themselves establish host/client compatibility or complete
the release qualification gates above. Continue with the
[verified-archive installation steps](OPERATIONS.md#2-cli-and-daemon-installation).

## Versioning

Use Semantic Versioning:

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
