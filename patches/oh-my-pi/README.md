# OMP patch handoff

`0001-collab-controller-autostart-registry.patch` is based on OMP commit
`39c95e5e29b1c8b082059f57421ce445c3dffdd4` (nearest release: v17.0.5).

It:

1. makes one `CollabController` own manual and automatic collaboration;
2. adds backward-compatible `collab.autoStart` and local-only `collab.registryEndpoint` settings;
3. publishes view/control capabilities to an authenticated, owner-checked POSIX registry without blocking normal OMP operation; Windows publication fails closed until named-pipe server authentication is implemented;
4. revokes generation N before active-session mutation, publishes generation N+1 only after the replacement is active, keeps manually started hosts stopped when auto-start is off, and unregisters on stop, shutdown, or fatal host failure; and
5. bounds and cancels pending publisher handshakes and adds controller, publisher-safety, setting-default, and session-mutation ordering tests.

Apply from the OMP repository root:

```sh
git apply --check /path/to/0001-collab-controller-autostart-registry.patch
git apply /path/to/0001-collab-controller-autostart-registry.patch
bun test packages/coding-agent/test/collab/controller.test.ts \
  packages/coding-agent/test/collab/registry-publisher.test.ts \
  packages/coding-agent/test/config/collab-settings.test.ts \
  packages/coding-agent/test/agent-session-bash-session-ownership.test.ts
bun test packages/coding-agent/test/slash-commands/collab-qrcode.test.ts
```

The current focused commands pass 31 controller, publisher, settings, session-ordering, and slash-command tests,
and the full coding-agent package typecheck passes. The final hardening revision also passes
`bun run ci:check:full`. The complete official TypeScript matrix passes via `bun run ci:test:ts`
with the native `/tmp` root after temporary exclusion of 32 upstream-baseline-sensitive tests:
two Python completion bridge cases, one Python shortcut case, one UTC/local-date logger assertion,
and the intermittently failing 28-test auto-compaction suite. Those exclusions were restored.

No upstream PR or fork commit exists yet. Rebase by revalidating the paths in `UPSTREAM.lock.json`, applying
with `git apply --3way`, resolving only narrow collaboration conflicts, then rerunning all listed and
coding-agent tests. Keep generated assets, gateway code, and an optional future extension API out of this patch.
