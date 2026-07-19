# Compatibility policy

## Research baseline

This handoff was refreshed on **2026-07-19** against the public OMP **v17.0.5** release and current documentation available that day.

Relevant observed interfaces include:

- `docs/collab.md` for link roles, encryption, web client behavior, and settings;
- `packages/coding-agent/src/collab/host.ts` for `CollabHost` ownership and link getters;
- `packages/coding-agent/src/modes/types.ts` for the interactive context's `collabHost` field;
- `docs/extensions.md` for lifecycle events and managed extension timers; and
- `packages/collab-web` for the browser client.

`UPSTREAM.lock.json` intentionally has a null commit because this design artifact did not clone and pin a source checkout. The first implementation change must replace that with an exact 40-character commit SHA.

## Compatibility contract

The gateway should version three independently changing surfaces:

1. **Registry protocol** between OMP publishers and the gateway.
2. **Gateway HTTP API** between the PWA and daemon.
3. **OMP integration compatibility** between the patch/package and upstream OMP internals.

The first two must have explicit protocol versions and runtime validation. The third should be represented by a tested compatibility matrix, not by a claim that private OMP internals are indefinitely stable.

## Supported OMP range

For pre-alpha development, support exactly one pinned OMP commit. Broaden support only after CI proves multiple versions.

A future release matrix should look like:

| Gateway version | OMP versions/commits | Registry protocol | Status |
|---|---|---:|---|
| `0.1.x` | exact pinned commit(s) | 1 | experimental |
| `0.2.x` | tested release range | 1 | alpha |

Do not use loose peer ranges without integration tests.

## Upstream refresh procedure

For each OMP update:

1. Fetch the new release/tag and inspect collaboration-related changes.
2. Update `UPSTREAM.lock.json` with exact tag, commit, package version, Bun version, and relevant paths.
3. Rebase or regenerate the OMP patch series.
4. Run unit tests for the controller and publisher.
5. Run full host/browser integration tests for view and control.
6. Verify link parsing and collab-web behavior.
7. Run lifecycle tests for start, stop, switch, branch, resume/tree navigation, relay reconnect, and shutdown.
8. Run the capability-leak suite.
9. Update the matrix and changelog.

## Protocol evolution

- Reject unknown major protocol versions.
- Add optional fields compatibly within a major version only when old peers safely ignore them.
- Do not silently reinterpret a field's security meaning.
- Support a short rolling-upgrade overlap where practical: current gateway accepts current and immediately previous publisher protocol, while emitting one browser API version.
- Include protocol version in diagnostics, never capability values.

## Pinned collab-web

Every gateway release must identify the exact OMP source commit used to build `collab-web`. Prefer reproducible source builds in CI. If static output is vendored, include:

- source repository and commit;
- build command and Bun/Node version;
- dependency lockfile hash;
- license notices;
- local patch list, especially the in-memory bootstrap and any temporary fragment fallback; and
- content hashes for shipped assets.

## Platform support

Advertise an OS only after its installation, permissions, autostart, token rotation, diagnostics, upgrade, and uninstall flows pass CI or documented manual release qualification.

Initial target matrix:

| Platform | Local IPC | Autostart target | Status |
|---|---|---|---|
| Linux | Unix-domain socket under `$XDG_RUNTIME_DIR` | systemd user service | planned |
| macOS | Unix-domain socket in a user-only runtime directory | LaunchAgent | planned |
| Windows | current-user named pipe | scheduled task or user service | planned |
| Android | HTTPS PWA through Tailscale | browser installation | planned |
