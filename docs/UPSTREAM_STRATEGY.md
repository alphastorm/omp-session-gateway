# Oh My Pi upstream strategy

## Goal

Keep OMP-specific changes minimal, independently testable, backward-compatible by default, and useful to OMP beyond this project.

## Preferred integration order

1. Use an existing supported OMP API if the pinned version now exposes collaboration lifecycle control.
2. Otherwise, submit a behavior-preserving refactor that extracts a reusable collaboration controller used by the existing `/collab` command.
3. Expose the smallest typed API or lifecycle events needed by a separately packaged publisher extension.
4. Keep gateway protocol, Tailscale behavior, PWA code, and installers out of the OMP repository.
5. If upstream declines the API, maintain a small rebased patch set in `patches/oh-my-pi/` and publish an explicit compatibility matrix.

## Suggested PR decomposition

### PR 1 — controller refactor

- Extract the owner of `CollabHost` lifecycle.
- Make existing slash commands delegate to it.
- Add tests proving no behavior/settings change.
- Do not mention the gateway as a requirement.

### PR 2 — supported automation surface

One of:

- typed `ctx.collab.start/get/stop` extension API plus lifecycle events; or
- opt-in core `collab.autoStart` and a publisher hook interface.

Keep defaults off and document capability secrecy.

### PR 3 — optional settings/documentation

- `collab.autoStart` and local registry endpoint if upstream accepts core publication;
- otherwise keep these in the extension package/config owned by this repository.

Do not combine vendored web assets, Tailscale configuration, or gateway implementation with these PRs.

## Compatibility discipline

- Record every tested OMP commit in `UPSTREAM.lock.json` and the compatibility matrix.
- Test manual `/collab`, `/collab view`, status, stop, join, leave, resume, branch, and session switching.
- Verify full and view link formats using upstream parsers, not local regular expressions.
- Detect API drift in CI against selected OMP versions.
- Never silently fall back to terminal automation when the supported integration breaks.

## Communication

Before proposing public API names, open a focused upstream discussion or issue describing the general need: programmatic ownership of the existing collaboration host for extensions and automation. Avoid asking upstream to adopt the entire mobile gateway architecture.

Preserve the statement that OMP Session Gateway is independent and community-maintained unless upstream formally adopts or endorses it.
