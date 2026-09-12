# OMP patch handoff

`0001-collab-controller-autostart-registry.patch` is based on OMP commit
`daf07999c2fee9b22edc7bf8fea1fb6272e0df5e` (tag: v18.1.14, upstream tree
`2de2fa56660883822c1b07dc6c754511475c5878`). The artifact is one mbox containing four
reviewable commits:

- `729f42c4eadfdb0e7841d92e142511dadcf239fb` — shared collaboration controller, auto-start, lifecycle, generation-scoped attention, publication recovery, and authenticated registry publisher;
- `c47228ffed146e6a82112a351c9a5b4845436ca8` — bounded, replayable host UI requests retained before a writable guest joins;
- `8174dbe911fbb620b592f634e17d0cf8288eda8d` — safe response-UI mirroring, race cleanup, and startup ordering; and
- `b56e4da12d00322e54ac80da5da95a8d4d408dd0` — optional encrypted health probes and idempotent response acknowledgement.

The first three commits reconstruct only the active maintained downstream
`gateway-collaboration` topic, in authoritative order `0006 → 0002 → 0004`. Their source
sha256 values are `416856f5abc7ba6fa2e9202ef6520f4cc25150b233abfe353794abe0dd85e79e`,
`5061a09b0ce4d9703a807b35569b64da5529c0b8c8403e00c0fe8cfd1741da48`, and
`badb01bb3572bc409b3526dad1d3e325eca28a7696279b33d55925c4b906d481`. Historical
`0003` (response-required publication) and `0007` (publication recovery) are already folded
into `0006` and are not re-applied; no unrelated downstream patch is included.

The v18.1.14 reroll restores one existing shutdown-order contract around `0006`. The raw active
patch awaited controller teardown before displaying upstream's immediate `Closing session…` status,
which failed `interactive-mode-still-closing.test.ts`. This handoff puts controller cleanup under
upstream's already bounded slow-close timer, preserving the prior gateway mbox behavior without
widening the subsystem.

Commit four is the standalone `1564b4a3698bb465e912e3273ffb92e401da9e14` lineage carried from
the previous gateway mbox. Pristine v18.1.14 has the `ui-request-end` grammar and broadcasts that
frame when an admitted request settles, but `CollabHost.#handleUiResponse` still silently drops a
duplicate or late response, and no `gateway-health` frame or seed advertisement exists. The carry
therefore remains required: `#relayProbeSupported` becomes true only after the host sends a seed
`gateway-health-pong`, and a duplicate writable response receives a targeted idempotent
`ui-request-end` acknowledgement. Older v3 hosts remain compatible and fall back to passive relay
traffic.

The resulting mbox is 195,644 bytes with sha256
`7e11924670c0e703e86ac4e4c0ce7aa52e99c48bb7cf847f58b9318fda08870b`. Plain `git am` on
pristine v18.1.14 reproduces tree `17f84676442ee103564d01755ed1f76bbc51820e`.

The patched workspace reports `@oh-my-pi/pi-coding-agent@18.1.14`,
`@oh-my-pi/pi-wire@18.1.14`, `@oh-my-pi/pi-natives@18.1.14`, and
`@oh-my-pi/collab-web@16.3.6`. Its wire constant remains `COLLAB_PROTO = 3`; the optional
health frames are an extension of that compatible encrypted channel, not a protocol-major bump.

Publication recovery is folded into the first commit from maintained `0007`. It fixes
[#61](https://github.com/alphastorm/omp-session-gateway/issues/61): `CollabRegistryPublisher`
latched publication off in one place and never reset it, and its setup `catch` treated every error
that was not `ENOENT`/`ECONNREFUSED` as a security event, so a transient token read — `EACCES`,
`EMFILE`, or a torn rewrite while the gateway recreates its runtime directory — was
indistinguishable from a real privacy violation. Because `CollabController` builds the publisher
once behind `??=`, `/collab stop` then `/collab` reused the latched instance, and a live session
stayed absent from the directory for the rest of the OMP process lifetime while the daemon reported
healthy. The fix splits the classification rather than widening the retry: a non-IPC
`collab.registryEndpoint` and a world-readable socket raise `PublisherSecurityViolation` and still
latch, since both are deterministic properties of the machine that no retry can clear, while every
other setup failure retries with backoff. `publisher.resume()` clears a latch on an explicit manual
`/collab` only, never on auto-start, and `/collab status` reports
`off`/`publishing`/`retrying`/`disabled` so the state is diagnosable instead of silent.

It:

1. makes one `CollabController` own manual and automatic collaboration;
2. adds backward-compatible `collab.autoStart` and local-only `collab.registryEndpoint` settings;
3. publishes view/control capabilities through owner-checked Unix sockets or current-user Windows named pipes only after a nonce-bound, domain-separated mutual HMAC handshake; the publisher key never crosses IPC;
4. refreshes the active generation's bounded title, directory basename, and `provider/model` metadata after live name, working-directory, or model changes without rotating capabilities;
5. revokes generation N before active-session mutation, publishes generation N+1 only after the replacement is active, keeps manually started hosts stopped when auto-start is off, and unregisters on stop, shutdown, or fatal host failure;
6. retains a bounded host UI request before any writer connects, replays it to later writable guests, mirrors only serializable response UI, and keeps callback-, timeout-, disabled-row-, slider-, and prompt-style operations local;
7. publishes generation-scoped `inputRequired` only while at least one response operation has been accepted for a writable guest, clears it before remove/fault/replacement, and ignores stale generation releases;
8. starts collaboration before extension startup hooks can present response UI, and aborts both local and remote race sides on every settlement or failure;
9. advertises and answers optional encrypted browser-to-host health probes for admitted View and Control guests, and acknowledges duplicate writable responses after reconnect; and
10. bounds and cancels pending publisher handshakes, scrubs mutable key/frame buffers, reconnects with a freshly reread token after gateway replacement or lost heartbeat state, permits an absolute launcher-scoped token path without replacing ambient XDG configuration, and adds controller, metadata, publisher mutual-authentication/squatter-resistance/reconnect, setting-default, session-mutation, retained-request, response-race, health-probe, and startup-ordering tests.

An older v3 host remains joinable and supplies passive relay liveness through ordinary frames, but
the browser's pending `Sending…` action can converge after reconnect only with commit 4 applied: the
host must acknowledge a duplicate or late response after the original request has already settled.

Apply from the OMP repository root:

```sh
git apply --check /path/to/0001-collab-controller-autostart-registry.patch
git am /path/to/0001-collab-controller-autostart-registry.patch
bun test packages/coding-agent/test/collab/controller.test.ts \
  packages/coding-agent/test/collab/registry-publisher.test.ts \
  packages/coding-agent/test/collab/collab-command-publication.test.ts \
  packages/coding-agent/test/config/collab-settings.test.ts \
  packages/coding-agent/test/collab/guest-ui-request.test.ts \
  packages/coding-agent/test/collab/read-only.test.ts \
  packages/coding-agent/test/hook-editor.test.ts \
  packages/coding-agent/test/interactive-mode-default-plan-mode.test.ts \
  packages/coding-agent/test/interactive-mode-still-closing.test.ts \
  packages/coding-agent/test/agent-session-bash-session-ownership.test.ts \
  packages/coding-agent/test/session-manager-branch-order.test.ts \
  packages/coding-agent/test/slash-commands/collab-qrcode.test.ts
```

On Bun 1.4.0, that exact clean reconstruction passed 138 focused tests across the 12 files above
(628 assertions). They cover same-generation metadata refresh and protocol-label bounds,
generation-scoped nested and concurrent attention leases, pre-writer retention, the 64-request
admission cap, View exclusion, multi-writer exactly-once settlement, symmetric response-race
cleanup, mutual authentication, reconnect/token reread, explicit-token-path isolation,
collaboration-before-hooks ordering, immediate and bounded shutdown status, optional read-only
health probes, and duplicate response acknowledgement. `bun run ci:check:full` also passed on the
clean Darwin arm64 reconstruction; the complete coding-agent test buckets and applicable platform
lanes remain release gates rather than evidence silently inherited by this refresh.

## Current v18.1.14 gateway prerequisite route

Stock OMP v18.1.14 is not sufficient. Until the controller/publication seam lands upstream, every
OMP process expected to appear automatically must run a binary built from the exact source and
mbox above. This is the current v18.1.14 development/support route; the last completed stable
gateway qualification remains OMP v17.4.1, and none of that historical qualification is transferred
to this refresh. The route is versioned and deliberately does not overwrite the user's ordinary
`omp` command:

```sh
export GATEWAY_ROOT=/absolute/path/to/omp-session-gateway
export OMP_ROOT="$HOME/src/oh-my-pi-gateway-v18.1.14"

git clone --filter=blob:none --branch v18.1.14 --single-branch \
  https://github.com/can1357/oh-my-pi.git "$OMP_ROOT"
git -C "$OMP_ROOT" checkout --detach daf07999c2fee9b22edc7bf8fea1fb6272e0df5e
test "$(git -C "$OMP_ROOT" rev-parse HEAD)" = daf07999c2fee9b22edc7bf8fea1fb6272e0df5e
git -C "$OMP_ROOT" -c user.name=omp-session-gateway -c user.email=qual@example.invalid \
  am "$GATEWAY_ROOT/patches/oh-my-pi/0001-collab-controller-autostart-registry.patch"
test "$(git -C "$OMP_ROOT" rev-parse 'HEAD^{tree}')" = 17f84676442ee103564d01755ed1f76bbc51820e

(
  cd "$OMP_ROOT"
  test "$(bun --version)" = 1.4.0
  bun install --frozen-lockfile

  # Fresh source workspaces shadow the npm package, so stage the exact official native addon.
  native_fixture="$(mktemp -d)"
  trap 'rm -rf "$native_fixture"' EXIT
  printf '%s\n' '{"private":true,"dependencies":{"@oh-my-pi/pi-natives":"18.1.14"}}' \
    > "$native_fixture/package.json"
  (cd "$native_fixture" && bun install)
  case "$(uname -s)-$(uname -m)" in
    Darwin-arm64)
      native_package=pi-natives-darwin-arm64
      native_file=pi_natives.darwin-arm64.node
      ;;
    Linux-x86_64)
      native_package=pi-natives-linux-x64
      native_file=pi_natives.linux-x64-baseline.node
      ;;
    Linux-aarch64|Linux-arm64)
      native_package=pi-natives-linux-arm64
      native_file=pi_natives.linux-arm64.node
      ;;
    *)
      echo "unsupported v18.1.14 build host: $(uname -s)-$(uname -m)" >&2
      exit 1
      ;;
  esac
  cp "$native_fixture/node_modules/@oh-my-pi/$native_package/$native_file" \
    "packages/natives/native/$native_file"
  if [ "$native_file" = pi_natives.darwin-arm64.node ]; then
    test "$(shasum -a 256 "packages/natives/native/$native_file" | cut -d' ' -f1)" = \
      21e96210267275212d9555481d38b48deb37289dc08cab4f9c9f8c74c99675bc
  fi

  bun run ci:check:full
  bun --cwd=packages/coding-agent run build
  test "$(packages/coding-agent/dist/omp --version)" = omp/18.1.14
)

version_dir="$HOME/.local/lib/omp-session-gateway/omp/v18.1.14-17f84676"
mkdir -p "$version_dir" "$HOME/.local/bin"
install -m 0755 "$OMP_ROOT/packages/coding-agent/dist/omp" "$version_dir/omp"
ln -sfn "$version_dir/omp" "$HOME/.local/bin/omp-gateway-patched"
test "$(readlink "$HOME/.local/bin/omp-gateway-patched")" = "$version_dir/omp"
"$HOME/.local/bin/omp-gateway-patched" config set collab.autoStart control
"$HOME/.local/bin/omp-gateway-patched" config set collab.registryEndpoint auto
if command -v sha256sum >/dev/null; then
  sha256sum "$version_dir/omp"
else
  shasum -a 256 "$version_dir/omp"
fi
"$HOME/.local/bin/omp-gateway-patched" config get collab.autoStart --json
"$HOME/.local/bin/omp-gateway-patched" config get collab.registryEndpoint --json
```

The native step consumes OMP's exact official npm package and matching platform addon rather than
requiring a local Rust toolchain. A fresh workspace shadows that package with `packages/natives`,
which is why `bun install` alone does not place the `.node` file where the binary builder can embed
it. `bun setup` remains upstream's source-development route when Rust/Cargo is installed. For the
Darwin arm64 package used in this refresh, the official
`pi-natives-darwin-arm64-18.1.14.tgz` sha256 is
`d640ae8ea3679d2b3c6ea89b1b64d978e4cc793212cb67dc8badff10937bc7cc` and its
`pi_natives.darwin-arm64.node` sha256 is
`21e96210267275212d9555481d38b48deb37289dc08cab4f9c9f8c74c99675bc`.

The previously recorded macOS arm64 and Debian 13 x86-64 beta evidence, including Linux
[run `32537603211`](https://github.com/alphastorm/omp-session-gateway/actions/runs/32537603211),
qualifies the historical v17.4.1 route only. It is intentionally not claimed for v18.1.14. This
refresh has local Darwin arm64 patch application, focused-test, full-check, and standalone-build
evidence. The 2026-09-08 isolated real-host Chromium smoke also passed publication, View launch and
read-only controls, MathML rendering, retained Ask confirmation and host acknowledgement, relay
reconnect, and publisher removal. Linux, Windows, and physical-device qualification remain outstanding.

Launch sessions that should publish with `omp-gateway-patched`, not stock `omp`. Keep the source
checkout: its exact commit/tree plus a SHA-256 of the installed binary are the local provenance
record. `omp-gateway doctor` verifies the bundled integration artifacts but cannot inspect a
separate OMP executable, so the `readlink`, version, and source-tree assertions above are required.

For rollback, stop every process launched from `omp-gateway-patched` before changing the symlink;
running processes retain their original executable and capabilities. Repoint the symlink to a
previously retained, exact qualified patched version and re-run the source-tree, readlink, version,
and config assertions. The historical exact alpha v17.3.8 → beta v17.4.1 → alpha
symlink/version/config reversal passed in an isolated macOS home; the gateway archive must be
restored separately. This is a manual primitive, not paired packaging. If returning to stock OMP
instead, first set `collab.autoStart` to `off`, remove only the `omp-gateway-patched` symlink, and
accept that zero-touch gateway enrollment is disabled. Never silently point it at an unpatched or
loosely versioned binary.
On Windows every publisher-token fixture is secured, and the publisher's own token ACL is
validated, by spawning `powershell.exe`. Hosted runner images have made that spawn cost seconds
rather than milliseconds, and the first test in `registry-publisher.test.ts` pays two cold starts.
`registry-publisher.test.ts` therefore scales its per-test and handshake budgets by platform
(`PUBLISHER_TEST_TIMEOUT_MS`, `HANDSHAKE_TIMEOUT_MS`). Those budgets bound security assertions, not
latency: they exist so a slow spawn cannot masquerade as a protocol failure. Treat a *sustained*
rise in these tests' runtime as a signal to profile the Windows ACL path rather than to widen them
again.

Isolated launchers may set `OMP_GATEWAY_PUBLISHER_TOKEN_PATH` to an absolute publisher-token file so OMP can use a trial gateway without replacing `XDG_CONFIG_HOME` for OMP tools and child processes. The same regular-file, no-symlink, current-user ownership, mode, ACL, length, and alphabet checks apply; the environment variable carries only the path, never the token.

## Upstream status

Discussion: [can1357/oh-my-pi#6460 — Seamlessly connect all oh-my-pi collab session from anywhere](https://github.com/can1357/oh-my-pi/discussions/6460); the 2026-09-10 status and findings comment is [discussioncomment-18387101](https://github.com/can1357/oh-my-pi/discussions/6460#discussioncomment-18387101). Project writeup: [#9036](https://github.com/can1357/oh-my-pi/discussions/9036).

| Piece | Upstream state |
| --- | --- |
| Bounded pending host UI retention (`0002` lineage) | **Merged upstream 2026-09-10** as [PR #9031](https://github.com/can1357/oh-my-pi/pull/9031), merge `598109394f`, source `3e2b31f44b`, with zero-writer retention as the default. It is on upstream `main` and in no tag yet (`v18.1.16` predates it), so the v18.1.14 mbox still carries commit two; drop it at the first rebase onto a base containing `598109394f`. |
| Controller, auto-start, and registry publisher | Not submitted. It is a new subsystem spanning several packages, which upstream `CONTRIBUTING.md` requires be discussed in Discord *before* implementation; it also overlaps [#6354](https://github.com/can1357/oh-my-pi/pull/6354) and [#6171](https://github.com/can1357/oh-my-pi/issues/6171). |
| Optional encrypted `gateway-health` probes and duplicate-response acknowledgement (commit four) | Split. The acknowledgement half **merged upstream 2026-09-10** as [PR #11561](https://github.com/can1357/oh-my-pi/pull/11561) (merge `10fc05c0d0`, source `d8b81c6d3c`; on `main`, not yet tagged): a targeted `ui-request-end` to a writable guest whose `ui-response` names an already-settled request. The `gateway-health` seed/probe seam is not submitted and remains a required carry; at the next mbox refresh onto a base containing `10fc05c0d0`, shrink commit four to that seam. |
| Vendored `collab-web` link-scheme hardening (`packages/collab-client/upstream/UPSTREAM.json`) | **Merged upstream 2026-09-10** as [PR #11562](https://github.com/can1357/oh-my-pi/pull/11562) (merge `3dc99dae75`, source `daa7d76921`; not yet tagged): `safeHref` resolves the scheme with the URL parser. The vendored patch stays until the collab-client pin moves past `3dc99dae75`. |
| Gateway daemon, PWA, Tailscale identity, capability broker | Out of scope for upstream by design. |

Do not open an upstream issue for work that is about to be submitted: upstream `CONTRIBUTING.md` treats actionable issues as work its bot may pick up in parallel. Link an existing issue from the pull request instead. Every pull request body must also contain at least one sentence written by the human contributor.

Rebase by first refreshing the maintained downstream `gateway-collaboration` series to the new
exact OMP pin, then restoring the carried health commit and rerunning every listed coding-agent
fixture plus the complete upstream suite. Keep generated assets, gateway code, and an optional
future extension API out of this patch.
