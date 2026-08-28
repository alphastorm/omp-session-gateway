# Needs-attention and notification detail contract

Normative implementation contract for the Couch Flow directory, authoritative ask loop, and
per-device background alerts. `docs/COUCH_FLOW_SPEC.md` defines the complete interaction model;
this document narrows its metadata, push, and privacy behavior.

## Product boundary

The dashboard is a session directory and capability broker, not a second agent UI. It may display
bounded gateway metadata:

- session and project labels;
- `inputRequired`;
- an opaque request ID and server receipt timestamp;
- an optional bounded request preview and option count.

It never renders a transcript, response option labels, prefills, answers, or collaboration
capabilities. Boolean-only publishers remain fully supported: the hero says `Waiting for your
input` and Control opens the authoritative ask in the pinned collaboration client.

## Directory behavior

The home screen has one whole-screen mode:

- any waiting session: `Needs you`, FIFO by `ask.since`, with one `Up next` hero, remaining waiting
  rows under `Then`, and working rows last;
- no waiting sessions and at least one live session: `Sessions`, one `All clear` summary, then
  working rows newest-first;
- no live sessions: the empty state with `collab.autoStart` guidance and no count pill.

The hero action is `Open request` when Control is available and `View transcript` otherwise.
Control-capable heroes also offer `Hold for desk` and `Transcript`. A bounded `ask.preview`
renders as readable sentence-case text with the option count; it is never uppercased. Every
non-hero waiting or working item is a whole-row button; the working row's trailing compact
`Hide` control keeps the exact device-local dismissal semantics (reversible, no network
effect) with an explicit accessible label. The `All clear` summary repeats the ping promise only
while background alerts are enabled; otherwise it shows a chip that opens Settings. The masthead
has no manual Refresh control; snapshots, SSE, liveness checks, and bounded retry own directory
freshness.

## Notification control

The Settings sheet control has exactly these labels:

| State | Label | Enabled? |
|---|---|---:|
| checking | `Checking background alerts…` | No |
| idle | `Enable background alerts` | Yes |
| enabling | `Enabling…` | No |
| disabling | `Disabling…` | No |
| enabled | `Disable background alerts` | Yes; disables in place |
| blocked | `Notifications blocked` | No |
| unavailable | `Background alerts unavailable` | No |

The sheet opens from the persistent masthead Settings control. Notification detail options are
visible only while the subscription is enabled.

Permission is requested only from the explicit enable action inside the sheet. A previously
granted subscription may be reconciled on load without prompting.

The settings bottom sheet stores one level with each browser endpoint:

- `private`: fixed title only;
- `session` (default): session/project labels;
- `preview`: session detail plus the bounded ask preview when one exists.

The sheet warns that Preview may persist in notification history, screenshots, and wearables, and
states that payloads are built on the gateway at the selected level. The phone does not receive a
richer payload and redact it locally. Disabling unsubscribes in the browser and removes that
endpoint from the gateway; delivery `404`/`410` also removes stale state.

## Notification lifecycle

The gateway assigns a new opaque request ID and daemon receipt timestamp on each accepted
`false → true` ask transition. Repeated `true` updates preserve that identity. It sends
Control-capable attention only; view-only sessions cannot open a resolving Control client.

An attention payload is strict Push API version 2:

```json
{
  "version": 2,
  "type": "attention",
  "instanceId": "metadata-only-instance-id",
  "generation": 3,
  "requestId": "opaque-request-identity",
  "pendingAskCount": 2,
  "title": "OMP session needs attention",
  "body": "optional server-built detail"
}
```

`body` is omitted at `private`. The worker uses one replacement tag per `instanceId`, sets the app
badge to `pendingAskCount`, and stores only version, type, instance ID, and request ID in
notification data.

Resolution, removal, or replacement queues a strict clear payload before any replacement ask:

```json
{
  "version": 2,
  "type": "clear",
  "instanceId": "metadata-only-instance-id",
  "requestId": "opaque-request-identity",
  "pendingAskCount": 1
}
```

A clear closes the notification only when its stored request ID matches, so a delayed clear cannot
close a rearmed ask. Push delivery uses high urgency, a five-minute TTL, one coalescing topic per
instance, and remains best effort.

## Notification tap

The worker focuses/navigates an existing same-origin directory client or opens:

`/collab/{instanceId}?request={requestId}`

The app synchronously replaces that routing URL with `/`, loads an authenticated snapshot, and
opens Control only when the same instance still has the exact request ID, `inputRequired: true`,
and `canControl: true`. Otherwise it keeps the directory visible and reports the request as
resolved or changed. The later launch POST revalidates generation and returns the collaboration
capability through the ordinary no-store, in-memory path.

Opaque request IDs are correlation metadata, not bearer authorization. They may occur transiently
in push, notification data, the scrubbed route, and capability-free history state. Collaboration
capabilities remain forbidden from push state/payloads, notifications, URLs, history, service
worker messages, browser storage, caches, logs, and diagnostics.

## Acceptance checklist

- [x] Whole-mode queue, FIFO `Up next`, boolean fallback, whole-row actions, and no manual Refresh.
- [x] Seven exact notification states; permission only after explicit enable.
- [x] Per-device Private/Session/Preview sheet with default, warning, footnote, and disable action.
- [x] Strict v2 attention/clear payloads; per-instance replacement; exact-request clear; app badge.
- [x] Notification tap scrubs and revalidates the exact ask before the no-store Control launch.
- [x] Last-known metadata survives phone, tailnet, desktop, and relay failures with distinct copy.
- [x] The measured 411×816 Pixel layout viewport and synthetic 390×844 browser checks remain overflow-free with targets at least 44px.
- [x] Capability-leak scan and focused protocol, registry, HTTP, app, worker, and browser tests pass.
