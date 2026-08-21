# OMP patch handoff

`0001-collab-controller-autostart-registry.patch` is based on OMP commit
`9350b7990d26ebf69a604edc82d8558ef04adf30` (tag: v17.4.1).
The artifact is one mbox containing six reviewable commits:

- `adbe1d48b` — shared collaboration controller, auto-start, lifecycle, and authenticated registry publisher;
- `d837e8b71` — bounded, replayable host UI requests retained before a writable guest joins;
- `d961e5c3c` — generation-scoped `inputRequired` publication;
- `770003247` — safe response-UI mirroring, race cleanup, and startup ordering;
- `1564b4a36` — optional encrypted health probes and idempotent response acknowledgement; and
- `fd8237acb` — publication recovery after transient registry faults.

Commits one through four and six come from the maintained downstream `gateway-collaboration`
series in its authoritative order (`0006 → 0002 → 0003 → 0004 → 0007`) on the exact v17.4.1
base. Commit one preserves upstream's immediate `Closing session…` status and starts its bounded
slow-close timer before collaboration teardown. Commit six adapts upstream's QR-command fixture to
assert publication recovery when an already-hosting session runs `/collab`. Commit five is carried
only here: no `gateway-health` seam
exists in upstream v17.4.1, but the pinned collab client requires it. `#relayProbeSupported`
becomes true only when the host sends a seed `gateway-health-pong`; without this commit the
browser's relay probes never start and relay liveness silently degrades to passive traffic only.
Re-apply it on every refresh.

The resulting mbox is 232,346 bytes with sha256
`abcc8866f76fc82485a42c0ce51ca19aec3b928afcddf0af1c25c35dd10ad4e2`.
Plain `git am` on pristine v17.4.1 reproduces tree
`a5cfc80fcc0df1ca6e430c125371bcae43d5e5f7`.

The sixth commit returns to the maintained series as `0007`. It fixes
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
`/collab` only, never on auto-start, and `/collab status` now reports
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
the browser's pending `Sending…` action can converge after reconnect only with commit 5 applied: the
host must acknowledge a duplicate or late response after the original request has already settled.

Apply from the OMP repository root:

```sh
git apply --check /path/to/0001-collab-controller-autostart-registry.patch
git apply /path/to/0001-collab-controller-autostart-registry.patch
# Or preserve the six reviewable commits:
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
  packages/coding-agent/test/session-manager-branch-order.test.ts
bun test packages/coding-agent/test/slash-commands/collab-qrcode.test.ts
```

The v17.4.1 attention-path verification suite covers same-generation metadata refresh and
protocol-label bounds, generation-scoped nested and concurrent attention leases, pre-writer
retention, the 64-request admission cap, View exclusion, multi-writer exactly-once settlement,
symmetric response-race cleanup, mutual authentication, reconnect/token reread,
explicit-token-path isolation, collaboration-before-hooks ordering, immediate and bounded shutdown
status, optional read-only health probes, and duplicate response acknowledgement. Run all 122
focused tests, the complete coding-agent test buckets, `bun run ci:check:full`, and the applicable
platform lanes against the exact pin before release qualification.

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

Discussion: [can1357/oh-my-pi#6460 — Seamlessly connect all oh-my-pi collab session from anywhere](https://github.com/can1357/oh-my-pi/discussions/6460). Project writeup: [#9036](https://github.com/can1357/oh-my-pi/discussions/9036).

| Piece | Upstream state |
| --- | --- |
| Bounded pending host UI retention (`0002` lineage) | Submitted as [PR #9031](https://github.com/can1357/oh-my-pi/pull/9031) from `alphastorm:contrib/collab-retain-pending-ui`. Isolated from the controller/registry stack: three files, no wire-protocol change. |
| Controller, auto-start, and registry publisher | Not submitted. It is a new subsystem spanning several packages, which upstream `CONTRIBUTING.md` requires be discussed in Discord *before* implementation; it also overlaps [#6354](https://github.com/can1357/oh-my-pi/pull/6354) and [#6171](https://github.com/can1357/oh-my-pi/issues/6171). |
| Optional encrypted `gateway-health` probes (commit five) | Not submitted; no upstream seam exists at `v17.4.1`. Flagged in the discussion because it fails inert rather than loudly. |
| Gateway daemon, PWA, Tailscale identity, capability broker | Out of scope for upstream by design. |

Do not open an upstream issue for work that is about to be submitted: upstream `CONTRIBUTING.md` treats actionable issues as work its bot may pick up in parallel. Link an existing issue from the pull request instead. Every pull request body must also contain at least one sentence written by the human contributor.

Rebase by first refreshing the maintained downstream `gateway-collaboration` series to the new
exact OMP pin, then restoring the carried health commit and rerunning every listed coding-agent
fixture plus the complete upstream suite. Keep generated assets, gateway code, and an optional
future extension API out of this patch.
