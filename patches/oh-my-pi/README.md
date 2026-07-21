# OMP patch handoff

`0001-collab-controller-autostart-registry.patch` is based on OMP commit
`89d6a8f6d14286f32f09ec9c8aa8af7b3451d2d6` (nearest release: v17.0.6).
The artifact is one mbox containing four reviewable commits:

- `ff82b33ae` — shared collaboration controller, auto-start, lifecycle, and authenticated registry publisher;
- `1026379ab` — bounded, replayable host UI requests retained before a writable guest joins;
- `37b77ca6b` — generation-scoped `inputRequired` publication; and
- `ac5b7153c` — safe response-UI mirroring, race cleanup, and startup ordering.

It:

1. makes one `CollabController` own manual and automatic collaboration;
2. adds backward-compatible `collab.autoStart` and local-only `collab.registryEndpoint` settings;
3. publishes view/control capabilities through owner-checked Unix sockets or current-user Windows named pipes only after a nonce-bound, domain-separated mutual HMAC handshake; the publisher key never crosses IPC;
4. refreshes the active generation's bounded title, directory basename, and `provider/model` metadata after live name, working-directory, or model changes without rotating capabilities;
5. revokes generation N before active-session mutation, publishes generation N+1 only after the replacement is active, keeps manually started hosts stopped when auto-start is off, and unregisters on stop, shutdown, or fatal host failure;
6. retains a bounded host UI request before any writer connects, replays it to later writable guests, mirrors only serializable response UI, and keeps callback-, timeout-, disabled-row-, slider-, and prompt-style operations local;
7. publishes generation-scoped `inputRequired` only while at least one response operation has been accepted for a writable guest, clears it before remove/fault/replacement, and ignores stale generation releases;
8. starts collaboration before extension startup hooks can present response UI, and aborts both local and remote race sides on every settlement or failure; and
9. bounds and cancels pending publisher handshakes, scrubs mutable key/frame buffers, reconnects with a freshly reread token after gateway replacement or lost heartbeat state, permits an absolute launcher-scoped token path without replacing ambient XDG configuration, and adds controller, metadata, publisher mutual-authentication/squatter-resistance/reconnect, setting-default, session-mutation, retained-request, response-race, and startup-ordering tests.

Apply from the OMP repository root:

```sh
git apply --check /path/to/0001-collab-controller-autostart-registry.patch
git apply /path/to/0001-collab-controller-autostart-registry.patch
# Or preserve the four reviewable commits:
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

The v17.0.6 attention-path verification passes 114 controller, publisher, retained-request,
read-only, response-UI, hook-editor, startup-ordering, settings, session-ordering, and slash-command
tests together (531 assertions), plus the coding-agent typecheck and `bun run ci:check:full`. It
covers same-generation metadata refresh and protocol-label bounds, generation-scoped nested and
concurrent attention leases, pre-writer retention, the 64-request admission cap, View exclusion,
multi-writer exactly-once settlement, symmetric response-race cleanup, mutual authentication,
reconnect/token reread, explicit-token-path isolation, and collaboration-before-hooks ordering.
Every official TypeScript test outside five failures reproduced unchanged on the pristine pin
passed in its official bucket; no patch-specific failure remained.

Isolated launchers may set `OMP_GATEWAY_PUBLISHER_TOKEN_PATH` to an absolute publisher-token file so OMP can use a trial gateway without replacing `XDG_CONFIG_HOME` for OMP tools and child processes. The same regular-file, no-symlink, current-user ownership, mode, ACL, length, and alphabet checks apply; the environment variable carries only the path, never the token.

No upstream PR or fork commit exists yet. Rebase by revalidating the paths in `UPSTREAM.lock.json`, applying
with `git apply --3way`, resolving only narrow collaboration conflicts, then rerunning all listed and
coding-agent tests. Keep generated assets, gateway code, and an optional future extension API out of this patch.
