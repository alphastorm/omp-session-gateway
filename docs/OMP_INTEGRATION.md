# OMP integration patch

## Goal

Make built-in collaboration programmatically controllable inside OMP, then add opt-in automatic startup and local publication without changing default behavior.

## Relevant existing areas

The implementer should confirm current paths on the target commit, but expect the work to touch:

- `packages/coding-agent/src/collab/host.ts` — existing `CollabHost` implementation and link getters.
- the interactive-mode/slash-command code that implements `/collab`.
- the settings schema containing `collab.relayUrl`, `collab.webUrl`, and `collab.displayName`.
- interactive session lifecycle code that stops collaboration on session replacement.
- tests around collaboration commands and settings.

Do not import internal classes from a separately installed plugin. Keep the first patch in core and make it suitable for upstream review.

## 1. Extract a `CollabController`

Suggested interface (adapt names to repository conventions):

```ts
export type AutoCollabMode = "off" | "view" | "control";

export interface CollabCapabilities {
  instanceId: string;
  generation: number;
  sessionId: string;
  viewLink: string;
  controlLink?: string;
  startedAt: string;
}

export interface CollabController {
  readonly state: "stopped" | "starting" | "running" | "stopping" | "faulted";
  start(options?: { relayUrl?: string }): Promise<CollabCapabilities>;
  stop(reason?: string): Promise<void>;
  status(): CollabCapabilities | undefined;
  on(event: "started" | "updated" | "stopped" | "faulted", handler: (...args: unknown[]) => void): () => void;
}
```

The controller should own exactly one `CollabHost` for the active interactive context. `start()` must be idempotent for the same generation and serialize concurrent starts/stops.

The current slash command should call this controller. The controller must not print UI itself; the slash-command adapter handles messages/QR output, while auto-start remains quiet except for actionable errors.

## 2. Settings

Add to the existing typed settings schema:

```jsonc
{
  "collab": {
    "autoStart": "off",
    "registryEndpoint": "auto"
  }
}
```

Semantics:

| Setting | Values | Default | Meaning |
|---|---|---:|---|
| `collab.autoStart` | `off`, `view`, `control` | `off` | Start collaboration after interactive session initialization. `view` publishes only the view capability; `control` also publishes the full capability. |
| `collab.registryEndpoint` | `auto`, `off`, or explicit local IPC path | `auto` | Discover the standard per-user gateway endpoint, disable publication, or use an explicit development/test endpoint. Network URLs must not be accepted here. |

Keep `relayUrl`, `webUrl`, and `displayName` behavior unchanged.

The current pre-alpha patch enables registry publication only on POSIX. Windows publication fails
closed until the publisher can authenticate the named-pipe server and resist namespace squatting;
a client ACL and first-frame publisher token authenticate only the client, not the server.

## 3. Process identity and generations

- Create a cryptographically random `instanceId` once per OMP process.
- Start `generation` at 1 and increment whenever a new `CollabHost` replaces the old one.
- Use `instanceId` as the dashboard card key; `sessionId` and generation are mutable fields.
- Do not use PID alone as an identity because PIDs are reused.

## 4. Publisher lifecycle

Create a small `CollabRegistryPublisher` that receives controller events.

```ts
interface PublishedSession {
  instanceId: string;
  generation: number;
  pid: number;
  sessionId: string;
  title?: string;
  cwdLabel?: string;
  model?: string;
  startedAt: string;
  viewLink: string;
  controlLink?: string;
}
```

Rules:

- Redact the working directory to its basename by default.
- Never stringify the full object through the normal logger.
- Treat `viewLink` and `controlLink` as secret values even though view is less privileged.
- Heartbeat every 10 seconds while running.
- Use capped exponential reconnect (for example 250 ms to 30 s with jitter).
- Re-send the current upsert after reconnect.
- Send remove before an orderly stop. Do not block process exit indefinitely; cap shutdown flush.
- If token/endpoint files have unsafe permissions, disable publication and surface one concise security error.
- Before reading capabilities on POSIX, require a current-user-owned socket in a current-user-owned private parent directory.
- Track the pending socket, enforce a bounded hello handshake, and cancel it on shutdown before it can install heartbeat state.
- On Windows, fail closed until client-side named-pipe server authentication is implemented and qualified.

## 5. Session changes

Locate every path that can replace or detach the active interactive session, including resume, branch, new-session, and programmatic session changes.

When auto-start is enabled:

```text
old generation: unregister -> stop host
new context ready: start host -> register new generation
```

Ordering matters. Never leave the old control capability advertised while a new session is becoming active.

If the new host fails to start, the dashboard must show no launchable entry for the old host. Retry may occur, but only after the old record is revoked.

## 6. Manual command interactions

Expected behavior:

- `/collab` when auto-start already has a host: show current full link/status rather than creating another room.
- `/collab view`: show current view link.
- `/collab stop`: stop and unregister. Decide whether auto-start remains suspended for the rest of that process; recommended behavior is **manual stop suspends auto-restart until the next active-session generation or an explicit `/collab`**. Document this.
- an explicit relay URL passed to `/collab`: restart through the controller and republish the replacement generation.
- changing View/Control publication mode on the current relay must revoke the prior registry record before republishing the requested mode.
- status includes whether the session is published to the session gateway, but never logs the link.

## 7. Future extension API (optional follow-up)

After the controller is stable, expose a constrained supported API such as:

```ts
ctx.collab.start();
ctx.collab.stop();
ctx.collab.status();
ctx.collab.on("started", ...);
```

Do not block v1 on moving the publisher into an extension. If the pinned public extension surface still cannot own built-in collaboration startup, keep the first integration in core; otherwise prefer the supported upstream API. See `docs/UPSTREAM_STRATEGY.md`.

## 8. OMP tests

Add tests for:

- setting defaults and validation;
- no auto-start when off;
- view mode omits control capability;
- control mode publishes both capabilities;
- exactly one host under concurrent command/auto-start calls;
- session replacement revokes old generation before publishing new;
- `/collab stop` unregisters;
- daemon absent does not break OMP;
- malformed endpoint/token fails safely;
- no links in captured logs or snapshots;
- command behavior remains backward compatible.
