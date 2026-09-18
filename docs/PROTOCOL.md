# Protocol contracts

This document covers the gateway’s HTTP/SSE API and its client side of mainline OMP’s local
discovery/query contract. Browser API shapes are unchanged by the mainline cutover. Runtime
validation lives in `packages/protocol`; browser JSON Schemas remain in `schemas/`.

## 1. OMP discovery directory

Require stock OMP `>= 18.1.20`: [PR #11908](https://github.com/can1357/oh-my-pi/pull/11908), merge `4999b98bd5`, ships in [OMP v18.1.20](https://github.com/can1357/oh-my-pi/releases/tag/v18.1.20).
OMP publishes under `~/.omp/run/collab-hosts`. `PI_CONFIG_DIR` replaces the `.omp` directory
**name relative to the home directory**, not the entire discovery path. The gateway may select an
explicit directory with `omp.discoveryDir`. It only reads this directory: it never creates, writes,
renames, or unlinks discovery entries or endpoints, including apparently stale ones.

Each live publication has one `<entryId>.json` file, mode `0600`, written once and never rewritten
for metadata changes. Its exact shape is:

```json
{
  "version": 1,
  "instanceId": "metadata-instance-id",
  "pid": 12345,
  "endpoint": "/home/user/.omp/run/collab-hosts/entry-id.sock",
  "createdAt": 1789862400000,
  "token": "<per-host-query-token>"
}
```

The token authorizes queries to this one OMP host. It is private authentication material, **not** a
View or Control capability and not a gateway installation credential. Discovery files never
contain collaboration capabilities. Verify private ownership and permissions and reject symlinks
and malformed entries. Read `endpoint` from the file; do not derive it from `entryId` or PID. OMP
relocates overlong socket paths to `/tmp/omp-collab-<hash>/<entryId>.sock`.

## 2. Per-host query transport

The gateway connects to the OMP-owned endpoint as a client. Frames are UTF-8 newline-delimited JSON:
**one request per connection**, followed by one reply and host-initiated close. There is no gateway
listener, publisher handshake, persistent stream, or unsolicited metadata frame on this path.
Terminate the request with a newline; bound request/response bytes using
`MAX_OMP_REGISTRY_REQUEST_BYTES` and `MAX_OMP_REGISTRY_RESPONSE_BYTES`, validate protocol version
1 and reply shape, and never echo raw input or transport errors into logs.

`omp.queryTimeoutMs` defaults to 1500 ms. Gateway log fields accept only numeric or boolean values,
never strings, query tokens, endpoints, snapshots, request bodies, or replies.

### `snapshot`

Request:

```json
{ "v": 1, "token": "<per-host-query-token>", "op": "snapshot" }
```

Success is `{ ok: true, v: 1, snapshot }`. The metadata snapshot contains:

| Field | Meaning |
|---|---|
| `instanceId` | OMP process identity; never use PID alone as the card identity. |
| `generation` | Current collaboration generation, required on link requests. |
| `pid` | Host process ID. |
| `sessionId` | Active OMP session identity. |
| `sessionName` | Session display name. |
| `cwd` | Host working directory; the gateway exposes only its bounded basename by default. |
| `model` | `{ provider, id }`; mapped to a bounded browser display label. |
| `startedAt` | Epoch milliseconds; converted to ISO time for browser metadata. |
| `participants` | Host participant count. |
| `relayConnected` | Host relay-connection state, not a reason to retire discovery. |
| `inputRequired` | Boolean attention signal; no prompt, options, answer, or request content. |
| `access` | Shared access, `view` or `control`; determines Control availability. |

No snapshot contains a capability. The gateway derives bounded `SessionMetadata` plus its own
opaque attention identity; neither full paths nor per-host query tokens enter list/SSE.

### `link`

Only an explicit authorized View/Control launch triggers this request:

```json
{
  "v": 1,
  "token": "<per-host-query-token>",
  "op": "link",
  "access": "view",
  "generation": 3
}
```

`access` is exactly `view` or `control`; `generation` is the value observed by the browser.
Success is `{ ok: true, v: 1, url }`, where `url` is a bearer capability. No example capability is
recorded here. The launch broker validates the reply and revalidates current generation, requested
access, and optional attention request identity before returning the unchanged HTTP launch shape.
It never stores or caches the capability.

### Wire errors

All error replies have the shape `{ ok: false, v: 1, error }`. The complete error-code set is:

| `error` | Meaning |
|---|---|
| `malformed_request` | The request cannot be accepted as a valid query. |
| `unsupported_protocol` | The request protocol version is unsupported. |
| `authentication_failed` | The per-host query token is not accepted. |
| `snapshot_unavailable` | The host cannot currently supply its snapshot. |
| `invalid_operation` | The operation is not `snapshot` or `link`. |
| `invalid_access` | The link access value is invalid. |
| `stale_generation` | The requested collaboration generation is no longer current. |
| `access_unavailable` | The current host does not share the requested role. |

These are OMP wire errors, not gateway HTTP problem codes. None proves that the host has exited.

## 3. Polling, liveness, and reconciliation

`registry.heartbeatSeconds` now means the discovery poll interval (default 10 seconds). Concurrent
polls join one round. A successful observation refreshes metadata freshness using daemon receipt
time from a monotonic clock. `registry.ttlSeconds` defaults to 35 seconds and must exceed twice
the poll interval.

**Only `ENOENT` or `ECONNREFUSED` from a host query proves that host finished.** A timeout,
`EMFILE`, `EACCES`, malformed reply, or any wire error (including `snapshot_unavailable`) is
transient: retain an existing card, without refreshing its successful-observation time, until
TTL expiry. Do not convert these errors into immediate session removal or discovery-file cleanup.
Hosts absent from both the observed and retained sets are removed during reconciliation. An
absent discovery directory is a valid empty directory, not a reason to create it. A normal close
after a query response is framing, not a host-death signal.

After a daemon restart the memory-only registry begins empty and the next poll discovers live
hosts. OMP does not reconnect to or authenticate with the gateway.

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
      "ask": {
        "requestId": "opaque-in-memory-request-id",
        "since": "2026-07-19T16:25:18.000Z"
      },
      "lastSeenAt": "2026-07-19T16:25:20.000Z",
      "canView": true,
      "canControl": true
    }
  ]
}
```

It must never contain a capability, room key, write token, relay secret, per-host query token, readiness token, transcript, answer, tool output, or full path by default. `ask.requestId` is opaque routing metadata generated by the gateway, and `ask.since` is daemon receipt time. `ask.preview` and `optionCount` remain absent until an explicit bounded OMP snapshot contract supplies them.

### `GET /api/v1/events`

Server-Sent Events contain only the same metadata types used by the list endpoint.

Event types:

- `snapshot`;
- `session_upsert`;
- `session_remove`;
- metadata-free named `keepalive` events every 5 seconds, observable by dashboard JavaScript.

A fresh snapshot establishes each connection's state. Keepalives prove transport liveness, not
session freshness; the latter still requires successful OMP observations.

### `GET /api/v1/push/config`

Returns the public half of the per-install VAPID key:

```json
{
  "version": 2,
  "applicationServerKey": "<url-safe-P-256-public-key>"
}
```

The response is authenticated and no-store. The VAPID private key never leaves the gateway's
user-only state file and process memory.

### `POST /api/v1/push/subscription`

After an explicit permission action, the browser registers or updates its subscription:

```json
{
  "version": 2,
  "detailLevel": "session",
  "subscription": {
    "endpoint": "https://push.example.invalid/send/device",
    "expirationTime": null,
    "keys": {
      "p256dh": "<browser-public-key>",
      "auth": "<browser-auth-secret>"
    }
  }
}
```

`detailLevel` is exactly `private`, `session`, or `preview`. New subscriptions explicitly select
`session`. Re-registering an existing browser subscription may omit `detailLevel`; the gateway then
preserves that endpoint's stored choice, defaulting only migrated v1 state to `session`. Require
exact same-origin mutation context, `application/json`, strict keys, HTTPS endpoint without
credentials or fragment, bounded key/endpoint/body sizes, authenticated identity, rate limits, and
at most eight stored subscriptions. Persist only the endpoint/keys, identity, detail level, and
VAPID pair in a private atomic state file. This file is not the session registry and contains no
session metadata or collaboration capability.

`DELETE /api/v1/push/subscription` accepts exactly `{ "version": 2, "endpoint": "..." }`. Browser
unsubscribe is authoritative; a failed delete leaves an unusable endpoint that the gateway removes
when delivery returns `404` or `410`.

### Web Push attention envelope

The encrypted payload is exactly one of:

```json
{
  "version": 2,
  "type": "attention",
  "instanceId": "metadata-instance-id",
  "generation": 3,
  "requestId": "opaque-in-memory-request-id",
  "pendingAskCount": 2,
  "title": "OMP session needs attention",
  "body": "Fix payment retry logic · checkout-service"
}
{
  "version": 2,
  "type": "clear",
  "instanceId": "metadata-instance-id",
  "requestId": "opaque-in-memory-request-id",
  "pendingAskCount": 1
}
```

`body` is omitted for `private`; `preview` may append one bounded preview line and otherwise falls
back to `session`. Presentation fields are built at send time and never persisted in gateway push
state. Send with high urgency, a five-minute TTL, and an instance-derived coalescing topic. The
VAPID `sub` claim is the repository URL, `https://github.com/alphastorm/omp-session-gateway`: a
contact the push service can reach, which Apple enforces by rejecting the JWT otherwise. The
service worker uses one notification tag per instance, updates it silently, closes it on `clear`,
and sets or clears the app badge from `pendingAskCount`.

The click route `/collab/:instanceId?request=:requestId` contains routing metadata only and returns
the no-store application shell. The app loads current authenticated metadata and performs the
ordinary Control launch POST only when the exact request identity remains actionable and
controllable. A capability never enters the push payload, route, notification, service worker, or
history state.

### `POST /api/v1/sessions/:instanceId/launch`

Request:

```json
{
  "mode": "view",
  "generation": 3
}
```

Request-specific Control launches also include the current opaque `requestId`. The gateway
revalidates that exact ask as well as the generation before releasing Control; the ID is routing
metadata, not an authorization credential.

Requirements:

- exact same-origin `Origin`;
- `Sec-Fetch-Site` of `same-origin` when present;
- `Content-Type: application/json` with no ambiguous encodings;
- verified and allowed Tailscale identity;
- current generation match and fresh successful host observation;
- requested access is still shared by OMP;
- per-identity and per-session rate limits;
- no WebAuthn assertion in the current API; an additional Control gate remains the ADR-008 proposal.

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
- requested role no longer shared: `409 Conflict` with `mode_unavailable`;
- exact attention request no longer current: `409 Conflict` with `request_mismatch`;
- malformed request: bounded `400` response that does not echo input.

### `GET /api/v1/health`

A local unauthenticated health endpoint returns only generic process readiness. Session counts,
identities, config, paths, and session health require authenticated diagnostics or local CLI access.
Readiness includes discovery health, not just HTTP reachability: an absent OMP directory is valid,
but an unsafe or unreadable directory degrades discovery. No directory path, token, count, or host
detail appears in this response. The optional HMAC challenge/response uses the gateway’s private
readiness token and keeps its existing shape; that token is never given to OMP.

## 5. In-memory collab client bootstrap

Shipped same-page API, defined in `packages/collab-client/upstream/src/embed.ts`:

```ts
function startCollabWithCapability(
  container: HTMLElement,
  capability: string,
  onDispose: () => void,
  options?: CollabEmbedOptions,
): () => void;
```

The return value disposes the mounted client; the capability is passed directly to the pinned
component rather than through a navigation or persistent bootstrap object.

Requirements:

- parse with pinned upstream OMP code;
- derive View/read-only state from the absence of the capability write token; a host welcome may
  further restrict a full link but omission of its optional `readOnly` field must never upgrade a
  View link or replay a pending mutating response;
- do not stringify or attach the bootstrap object to React/Vue devtools-visible global state in production;
- never assign the capability to `location`, an element attribute, text content, a form field, or persistent state;
- clear references on disconnect/leave and call `onDispose`;
- reload returns to the directory rather than reconnecting.
- treat browser network APIs only as remeasurement triggers; derive gateway and relay state from
  same-origin HTTP results, passive host traffic, and optional encrypted health ping/pong frames;
- keep a submitted host UI response visible and disabled until `ui-request-end`; resend it after a
  fresh welcome, and accept a targeted end frame as the idempotent acknowledgement when the host
  already settled that request;
- for writable photo prompts, use the pinned v3 `{ t: "prompt", text, images }` frame without a
  gateway media endpoint or protocol revision; each `ImageContent` is a normalized `image/jpeg`
  data block, with at most four blocks and at most 1 MiB of decoded bytes per block;
- accept only JPEG, PNG, and WebP source files up to 24 MiB and at most an 8,192px edge or
  20 megapixels, re-encode to a maximum 2,048px edge in browser memory so source filenames and
  EXIF/location metadata do not cross the relay, and drop preview/base64 references on remove,
  host-confirmed transcript echo, or client disposal;
- expose separate user actions and hidden inputs for **Take photo**
  (`capture="environment"`) and **Choose existing** (no `capture`); both feed the same bounded
  preparation path, and cancelling either chooser sends nothing;
- retain a sent photo draft until an exact `collab-prompt` transcript entry acknowledges its text
  and image blocks after the recorded pre-send entry; if that baseline is absent during reconnect,
  no older identical entry may acknowledge the draft. After five seconds without acknowledgement,
  keep the draft and offer retry only while the relay is healthy;
- permit image-only submission by supplying the explicit neutral text `Please inspect this photo.`
  (or its plural); user-entered text takes precedence unchanged;

Separate-page design alternative (not the shipped launch path):

1. open `/client/` synchronously during the user's tap;
2. the child creates a `MessageChannel` and sends a ready message to its exact same-origin opener;
3. the opener fetches the launch response and transfers the capability through the channel;
4. both sides validate origin, source window, one-time state, and message shape;
5. the opener drops its reference immediately after acknowledgement;
6. the child closes on timeout or origin mismatch.

The separate-page alternative is not valid for installed Android PWA launch: Chrome may reuse the standalone window,
leaving `/client/` without an opener and destroying the only in-memory sender. Installed mode must use the preferred
same-document mount.

Do not put the capability in a path, query, fragment, window name, BroadcastChannel, clipboard, or service-worker message.

## 6. Capability lifetime

The gateway has no secret store. A capability exists in gateway memory only while resolving one
authorized launch and returning its no-store response. It is then passed to the pinned client’s
in-memory bootstrap. Never place it in a URL, redirect, log, fixture, diagnostic, file, or browser
cache; reload returns to the directory.

## 7. Revisions and races

- Each registry mutation increments a daemon-wide revision.
- A client starts a new directory epoch by aborting any prior snapshot, closing its prior SSE source, fetching one authenticated snapshot, and only then opening SSE.
- Within one connected epoch, a response or event with a lower revision is ignored. Duplicate same-revision snapshots remain idempotent.
- The gateway emits a metadata-free `keepalive` SSE event every 5 seconds. After 12 seconds without a directory event or keepalive, a loaded dashboard marks gateway updates paused but retains the last authenticated metadata with a freshness timestamp and closes the stream. Initial snapshots time out after 4 seconds; recovery snapshots use 20 seconds. Retry delays are randomly selected from the upper half of exponentially growing caps of 1/2/4/8/16/30 seconds before a new SSE epoch. This is the current implementation, not ADR-016's original 4-second/1/2/4-second recovery policy; the discrepancy is recorded in the current audit note in [DECISIONS.md](DECISIONS.md#current-implementation-audit--2026-09-14).
- A changed PWA shell caches completely before its worker calls `skipWaiting`. Activation deletes prior shell caches, claims clients, and navigates exact same-origin `/` clients without a query to no-store `/update/`; the new app synchronously replaces that route with `/`. `/client/`, `/collab/` request bootstraps, query-bearing, and cross-origin clients are excluded. **ADR-018 implementation gap:** a pending directory launch still has the root URL until its capability mounts. The worker cannot see the page's pending flag, so its navigation can interrupt that launch. The accepted requirement to reserve `/client/` before asynchronous work remains unsatisfied.
- Launch requests carry the generation observed in the metadata response.
- A mismatch never returns a capability.
- Expired and removed records are indistinguishable to remote callers.
- A session removed while a client page is opening closes or resets that page with a generic message.
