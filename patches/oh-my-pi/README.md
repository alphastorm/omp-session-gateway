# OMP patch handoff

`0001-collab-controller-autostart-registry.patch` is based on OMP commit
`858f7dd91fff9b84cf8a2c6a6bb85aa0e6d03a55` (tag: v17.3.8).
The artifact is one mbox containing five reviewable commits:

- `0158f3c7f` — shared collaboration controller, auto-start, lifecycle, and authenticated registry publisher;
- `a8c555dbb` — bounded, replayable host UI requests retained before a writable guest joins;
- `11f371c0e` — generation-scoped `inputRequired` publication;
- `5e2227914` — safe response-UI mirroring, race cleanup, and startup ordering; and
- `c7912a6e1` — optional encrypted health probes and idempotent response acknowledgement.

The first four commits are the maintained downstream `gateway-collaboration` series in its
authoritative order (`0006 → 0002 → 0003 → 0004`, indices 0–3, so they sit directly on pristine
`858f7dd9`). They were taken verbatim from the reviewed handoff artifact
`gateway-collaboration-v17.3.8.mbox`, sha256
`f63f74c90d72776ca1ebcb4b1a75b18130b3c65d1c6e0133c9bbb3a8e5b4af49`, 173,604 bytes.

The fifth commit is carried only here. The maintained series no longer contains it, and no
`gateway-health` seam exists in upstream `v17.3.8`, but the pinned collab client in this repository
requires it: `#relayProbeSupported` becomes true only when the host sends a seed
`gateway-health-pong`, so without this commit the browser's relay probes never start and relay
liveness silently degrades to passive traffic only. Re-apply it on every refresh.

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
# Or preserve the five reviewable commits:
git am /path/to/0001-collab-controller-autostart-registry.patch
bun test packages/coding-agent/test/collab/controller.test.ts \
  packages/coding-agent/test/collab/registry-publisher.test.ts \
  packages/coding-agent/test/config/collab-settings.test.ts \
  packages/coding-agent/test/collab/guest-ui-request.test.ts \
  packages/coding-agent/test/collab/read-only.test.ts \
  packages/coding-agent/test/hook-editor.test.ts \
  packages/coding-agent/test/interactive-mode-default-plan-mode.test.ts \
  packages/coding-agent/test/agent-session-bash-session-ownership.test.ts \
  packages/coding-agent/test/session-manager-branch-order.test.ts
bun test packages/coding-agent/test/slash-commands/collab-qrcode.test.ts
```

The v17.3.8 attention-path verification suite covers same-generation metadata refresh and
protocol-label bounds, generation-scoped nested and concurrent attention leases, pre-writer
retention, the 64-request admission cap, View exclusion, multi-writer exactly-once settlement,
symmetric response-race cleanup, mutual authentication, reconnect/token reread,
explicit-token-path isolation, collaboration-before-hooks ordering, optional read-only health
probes, and duplicate response acknowledgement. Run every listed test, the coding-agent typecheck,
and `bun run ci:check:full` against the exact pin before release qualification.

On Windows every publisher-token fixture is secured, and the publisher's own token ACL is
validated, by spawning `powershell.exe`. Hosted runner images have made that spawn cost seconds
rather than milliseconds, and the first test in `registry-publisher.test.ts` pays two cold starts.
`registry-publisher.test.ts` therefore scales its per-test and handshake budgets by platform
(`PUBLISHER_TEST_TIMEOUT_MS`, `HANDSHAKE_TIMEOUT_MS`). Those budgets bound security assertions, not
latency: they exist so a slow spawn cannot masquerade as a protocol failure. Treat a *sustained*
rise in these tests' runtime as a signal to profile the Windows ACL path rather than to widen them
again.

Isolated launchers may set `OMP_GATEWAY_PUBLISHER_TOKEN_PATH` to an absolute publisher-token file so OMP can use a trial gateway without replacing `XDG_CONFIG_HOME` for OMP tools and child processes. The same regular-file, no-symlink, current-user ownership, mode, ACL, length, and alphabet checks apply; the environment variable carries only the path, never the token.

No upstream PR or fork commit exists yet. Rebase by revalidating the paths in `UPSTREAM.lock.json`, applying
with `git apply --3way`, resolving only narrow collaboration conflicts, then rerunning all listed and
coding-agent tests. Keep generated assets, gateway code, and an optional future extension API out of this patch.
