# Protocol contracts

The JSON Schemas in `schemas/` are the machine-readable starting point. This document defines lifecycle and security semantics that are not fully expressible in schema.

## 1. Local endpoint discovery

### Linux and other XDG systems

Preferred socket:

```text
$XDG_RUNTIME_DIR/omp-session-gateway/registry.sock
```

The directory must be owned by the current user and mode `0700`; the socket must not be accessible to other users.

### macOS and POSIX fallback

Use a current-user runtime directory with a short path, for example:

```text
$TMPDIR/omp-session-gateway-<uid>/registry.sock
```

or, when a secure runtime directory is unavailable:

```text
~/.local/state/omp-session-gateway/registry.sock
```

Refuse symlinked endpoint/token paths, unexpected owners, or directories writable by group/other users. Account for Unix socket path-length limits.

### Windows

Use a current-user-scoped named pipe:

```text
\\.\pipe\omp-session-gateway-<stable-user-hash>
```

Apply an ACL permitting only the current user and SYSTEM. Store the publisher token under `%LOCALAPPDATA%\OMP Session Gateway\publisher-token` with equivalent ACLs.

### Publisher authentication key

`omp-gatewayd` creates 32 random bytes and stores their 43-character unpadded base64url encoding in the platform config directory, for example:

```text
~/.config/omp-session-gateway/publisher-token
```

Create atomically with current-user-only permissions or ACLs. Reject weak length, permissive ownership/mode/ACL, symlinks, or non-regular files. Never print the key or send it over IPC. The protocol uses the key's 43 ASCII bytes as the HMAC-SHA-256 key; implementations keep it in a mutable buffer and overwrite that buffer after authentication. Compare proofs in constant time after strict size validation.

## 2. IPC framing

Use UTF-8 newline-delimited JSON, one object per line.

Required bounds:

- maximum frame: 64 KiB;
- maximum capability: 8 KiB;
- maximum display label: 256 Unicode code points;
- reject NUL, invalid UTF-8, duplicate critical fields, non-finite numbers, and unknown protocol major versions;
- cap concurrent publishers and malformed/authentication attempts;
- use read and idle timeouts;
- close with a generic protocol error that never echoes input.

The first frame must be `hello`. It contains a fresh nonce and no shared secret. No secret-bearing
`upsert` object may be sent, parsed into application structures, or accepted before both peers
authenticate.

## 3. Publisher protocol v1

### Mutual authentication

The publisher begins with a fresh 32-byte, unpadded-base64url client nonce:

```json
{
  "v": 1,
  "op": "hello",
  "clientNonce": "<43-character-client-nonce>",
  "instanceId": "0190d9ad-example",
  "pid": 12345
}
```

The daemon returns a fresh server nonce and proof:

```json
{
  "v": 1,
  "op": "challenge",
  "serverNonce": "<43-character-server-nonce>",
  "proof": "<43-character-server-proof>"
}
```

For domain `D`, define the UTF-8 proof transcript as the exact string:

```text
D\n<clientNonce>\n<serverNonce>\n<instanceId>\n<pid>
```

The daemon proof is the unpadded base64url encoding of
`HMAC-SHA-256(publisher-key-as-ASCII, transcript)` using domain
`omp-session-gateway.registry.server.v1`. The publisher validates it in constant time before
sending any proof or capability. It then responds with the same construction under domain
`omp-session-gateway.registry.client.v1`:

```json
{
  "v": 1,
  "op": "authenticate",
  "proof": "<43-character-client-proof>"
}
```

Only after the daemon validates that proof may it return:

```json
{
  "v": 1,
  "op": "hello_ok",
  "heartbeatSeconds": 10,
  "ttlSeconds": 35
}
```

Both nonces must be independently generated for every connection. All four authentication frames
use exact-key validation; unknown fields, malformed values, replayed proofs, timeouts, or extra
pre-authentication frames close the connection. The publisher treats a bad daemon proof as a
security failure and does not retry during that OMP process lifetime.
One authenticated connection owns exactly one `instanceId` and cannot mutate another instance.

### `upsert`

```json
{
  "v": 1,
  "op": "upsert",
  "session": {
    "instanceId": "0190d9ad-example",
    "generation": 3,
    "pid": 12345,
    "sessionId": "omp-session-id",
    "title": "Fix payment retry logic",
    "cwdLabel": "checkout-service",
    "model": "provider/model",
    "startedAt": "2026-07-19T16:25:00.000Z",
    "inputRequired": true,
    "viewLink": "<generated-view-capability>",
    "controlLink": "<generated-control-capability>"
  }
}
```

Rules:

- `instanceId` must match the authenticated connection;
- `generation` must be greater than or equal to the stored generation;
- repeating the same generation is idempotent only when its immutable session identity matches;
- same-generation upserts may refresh bounded display labels and `inputRequired` only for the same immutable session identity and capability set;
- capability strings are parsed/validated using pinned upstream OMP code where possible, not logged or reflected;
- `controlLink` may be absent when the session is view-only;
- `inputRequired` is a boolean only; it conveys no prompt text, options, answer, request ID, request type, or pending-operation count;
- metadata and capabilities must be copied into separate registry structures immediately.

### `heartbeat`

```json
{
  "v": 1,
  "op": "heartbeat",
  "instanceId": "0190d9ad-example",
  "generation": 3
}
```

The daemon uses its own monotonic receipt time for TTL decisions. If the record is already absent or expired, the daemon closes the authenticated connection without a protocol-error payload; the publisher reconnects, re-authenticates, and re-sends its current upsert.

### `remove`

```json
{
  "v": 1,
  "op": "remove",
  "instanceId": "0190d9ad-example",
  "generation": 3,
  "reason": "session_changed"
}
```

A remove for generation N must not delete N+1. Removal deletes capability references before publishing a metadata removal event.

## 4. Browser HTTP API

Production requests are accepted only through the loopback Tailscale Serve proxy path and require an allowed identity. No CORS is enabled.

Every `/api/` response includes at least:

```http
Cache-Control: no-store, max-age=0
Pragma: no-cache
Referrer-Policy: no-referrer
X-Content-Type-Options: nosniff
Cross-Origin-Resource-Policy: same-origin
```

The server's access log must suppress query strings, request/response bodies, authorization headers, identity headers, and launch endpoint response sizes.

### `GET /api/v1/sessions`

Returns metadata only:

```json
{
  "revision": 42,
  "sessions": [
    {
      "instanceId": "0190d9ad-example",
      "generation": 3,
      "title": "Fix payment retry logic",
      "cwdLabel": "checkout-service",
      "model": "provider/model",
      "startedAt": "2026-07-19T16:25:00.000Z",
      "inputRequired": true,
      "lastSeenAt": "2026-07-19T16:25:20.000Z",
      "canView": true,
      "canControl": true
    }
  ]
}
```

It must never contain a capability, room key, write token, relay secret, publisher token, transcript, prompt, response option, answer, request identity, pending-operation count, tool output, or full path by default.

### `GET /api/v1/events`

Server-Sent Events contain only the same metadata types used by the list endpoint.

Recommended event types:

- `snapshot`;
- `session_upsert`;
- `session_remove`;
- keepalive comments.

Use a bounded revision history or send a fresh snapshot on reconnect. Never send heartbeat events merely to expose timestamps more precisely than the UI needs.

### `POST /api/v1/sessions/:instanceId/launch`

Request:

```json
{
  "mode": "view",
  "generation": 3
}
```

Requirements:

- exact same-origin `Origin`;
- `Sec-Fetch-Site` of `same-origin` when present;
- `Content-Type: application/json` with no ambiguous encodings;
- verified and allowed Tailscale identity;
- current generation match and fresh heartbeat;
- requested capability exists;
- per-identity and per-session rate limits;
- optional WebAuthn assertion for Control.

Successful response, classified as secret-bearing:

```json
{
  "mode": "view",
  "generation": 3,
  "capability": "<opaque-omp-collaboration-capability>"
}
```

The response is consumed once in memory. It is never cached, logged, traced, retried by a service worker, included in browser error reporting, or inserted into the DOM.

Error behavior:

- generation mismatch: `409 Conflict` with a generic non-secret problem object;
- missing/expired record: `404 Not Found`;
- unauthorized identity: `403 Forbidden` without session existence details;
- unsupported mode: `404` or `409`, consistently documented;
- malformed request: bounded `400` response that does not echo input.

### `GET /api/v1/health`

A local unauthenticated health endpoint may return only generic process readiness. Session counts, identities, config, paths, and publisher health require authenticated diagnostics or local CLI access.

## 5. In-memory collab client bootstrap

Preferred same-page API:

```ts
interface CollabBootstrap {
  capability: string;
  onDispose(): void;
}

startCollabWithCapability(bootstrap: CollabBootstrap): Promise<void>;
```

Requirements:

- parse with pinned upstream OMP code;
- do not stringify or attach the bootstrap object to React/Vue devtools-visible global state in production;
- never assign the capability to `location`, an element attribute, text content, a form field, or persistent state;
- clear references on disconnect/leave and call `onDispose`;
- reload returns to the directory rather than reconnecting.

Separate-page alternative:

1. open `/client/` synchronously during the user's tap;
2. the child creates a `MessageChannel` and sends a ready message to its exact same-origin opener;
3. the opener fetches the launch response and transfers the capability through the channel;
4. both sides validate origin, source window, one-time state, and message shape;
5. the opener drops its reference immediately after acknowledgement;
6. the child closes on timeout or origin mismatch.

Do not put the capability in a path, query, fragment, window name, BroadcastChannel, clipboard, or service-worker message.

## 6. Fragment compatibility mode

Only when the pinned collab client cannot yet accept in-memory bootstrap:

1. obtain the capability through the launch POST;
2. navigate to the OMP client with a fragment;
3. parse synchronously before other application code;
4. replace browser history immediately with a non-secret URL;
5. disable reload recovery and all service-worker handling for the navigation;
6. block broad release until automated browser-history, screenshot, cache, and copy-link tests pass.

This mode is a migration path, not the desired final architecture.

## 7. Revisions and races

- Each registry mutation increments a daemon-wide revision.
- A client starts a new directory epoch by aborting any prior snapshot, closing its prior SSE source, fetching one authenticated snapshot, and only then opening SSE.
- Within one connected epoch, a response or event with a lower revision is ignored. Duplicate same-revision snapshots remain idempotent.
- An SSE transport failure clears displayed metadata immediately. A successful reconnect resets revision ordering before its initial snapshot because a daemon restart resets both revision and registry state.
- Launch requests carry the generation observed in the metadata response.
- A mismatch never returns a capability.
- Expired and removed records are indistinguishable to remote callers.
- A session removed while a client page is opening closes or resets that page with a generic message.
