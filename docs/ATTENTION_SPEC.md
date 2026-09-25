# Needs-attention and notification detail contract

Normative implementation contract for the Couch Flow directory, authoritative ask loop, and
per-device background alerts. Read with [ARCHITECTURE.md](ARCHITECTURE.md) and ADR-019,
ADR-026, and ADR-027 in [DECISIONS.md](DECISIONS.md); this document specifies their metadata,
push, and privacy behavior.

## Product boundary

The dashboard is a session directory and capability broker, not a second agent UI. It may display
bounded gateway metadata:

- session and project labels;
- `inputRequired` and optional `busy` activity;
- an opaque request ID and server receipt timestamp;
- an optional bounded request preview and option count.

It never renders a transcript, response option labels, prefills, answers, or collaboration
capabilities. The baseline OMP attention contract supplies only boolean `inputRequired`; newer
hosts additionally report activity `busy`. Neither supplies request content, so preview and option
count remain absent: the hero says `Waiting for your input`, Preview notifications fall back to
Session detail, and Control opens the authoritative ask in the pinned collaboration client.
The gateway polls this metadata and fetches a capability only for an explicit launch; it never
stores links. Activity is optional in browser metadata; stop notifications add one strict Push v2 variant.

## Directory behavior

The home screen has one whole-screen mode:

- any waiting session: `Needs you`, FIFO by `ask.since`, with one `Up next` hero, remaining waiting
  rows under `Then`, and remaining live rows last;
- no waiting sessions and at least one live session: `Sessions`, one `All clear` summary, then
  live rows newest-first;
- no live sessions: the empty state with `collab.autoStart` guidance and no count pill.

The hero action is `Open request` when Control is available and `View transcript` otherwise.
Control-capable heroes also offer `Hold for desk` and `Transcript`. A bounded `ask.preview`
renders as readable sentence-case text with the option count; it is never uppercased. Every
non-hero waiting or non-waiting item is a whole-row button; the working row's trailing compact
`Hide` control keeps the exact device-local dismissal semantics (reversible, no network
effect) with an explicit accessible label. The `All clear` summary repeats the ping promise only
while background alerts are enabled; otherwise it shows a chip that opens Settings. The masthead
has no manual Refresh control; snapshots, SSE, liveness checks, and bounded retry own directory
freshness.

Known activity is shown distinctly from idle or unknown. These labels do not create a Completed
state or imply that an inactive host exited; all live hosts remain selectable.

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
close a rearmed ask. Push delivery uses high urgency and a five-minute TTL, and remains best effort.
Messages carry no Web Push `Topic`: FCM treats a topic as a collapse key and throttles collapsible
messages to a burst of 20 per app per device, refilling one every three minutes, so ordinary ask,
clear, and stop traffic would be delayed by minutes. Without a topic, a push service holding
messages for an offline device delivers every unexpired one on reconnect, not only the newest.

## Activity-stop notifications

Newer OMP hosts publish optional `busy` from `session.isStreaming` (upstream PR #12844). True
means a turn is running; false means no turn is currently running. Missing/null is unknown,
not idle. The value may be false during a scheduling pause; it never proves successful completion
or process exit. Older hosts remain visible but cannot produce activity-stop alerts.

The registry recognizes only a known `true → false` sample for the same continuing generation
and immutable host/session identity, with neither the previous nor current sample waiting for
input. Ask start or resolution wins when it overlaps the sampled stop. Initial idle, repeated
idle, unknown activity, generation/identity replacement, disappearance, endpoint death, TTL expiry,
and daemon restart never synthesize a stop. Retained/unreadable polls clear only activity knowledge,
without refreshing receipt time, last-seen time, ask state, or TTL; recovery at false cannot alert.

Stop transitions are gateway-internal events, not a new browser SSE event. An in-memory marker on
existing registry records invalidates queued stops across activity, uncertainty, or identity
changes, even if later metadata looks identical. Delivery rechecks that marker and current ask
state. No activity history, transcript, capability, or notification ledger is persisted.

The strict additive Push v2 payload is:

```json
{
  "version": 2,
  "type": "activity_stop",
  "instanceId": "metadata-only-instance-id",
  "generation": 3,
  "pendingAskCount": 0,
  "title": "OMP session activity stopped",
  "body": "optional server-built session detail"
}
```

Private omits the body. Session uses existing bounded labels; Preview falls back to Session
because a stop has no ask preview. View-only sessions are eligible. Opening the gateway or
creating/renewing a subscription does not replay historical stops.

Stop and attention share the notification tag, five-minute TTL, and ordered delivery queue. A
displayed valid attention notification wins over an incoming stop;
attention replacing a stop requests a fresh alert (`renotify: true`), while duplicate attention
delivery does not re-alert. A delayed request-specific clear cannot close a stop, whose
notification data has no request ID. The badge still counts pending controllable asks, not stops.
Delivery is best effort: brief turns between polls can be missed, and attention priority may
suppress a stop while an earlier attention notification remains displayed. After an offline
period, an ask resolved meanwhile can alert briefly before its queued clear closes it. Push services
do not guarantee order, so a clear that overtakes its attention leaves that attention displayed
until the next ask replaces it or the user dismisses it. Taps still revalidate the exact current
request before acquiring Control.

Older Push v2 workers cannot interpret the new variant and continue to handle attention/clear.
Ignoring an unsupported push is not guaranteed silent: browsers enforcing `userVisibleOnly`
may display their own generic background-update notification. Open or refresh the PWA after
upgrading to activate the current worker before relying on stop alerts. No push-state schema,
opt-in preference, or installed-client qualification changes.

## Notification tap

For attention, the worker focuses/navigates an existing same-origin directory client or opens:

`/collab/{instanceId}?request={requestId}`

The app synchronously replaces that routing URL with `/`, loads an authenticated snapshot, and
opens Control only when the same instance still has the exact request ID, `inputRequired: true`,
and `canControl: true`. Otherwise it keeps the directory visible and reports the request as
resolved or changed. The later launch POST revalidates generation and returns the collaboration
capability through the ordinary no-store, in-memory path.

For a stop, the route is `/collab/{instanceId}?activity=stopped&generation={generation}`.
The app scrubs it before networking, fetches authenticated metadata, and opens **View** only for
the same generation when View remains available. It never upgrades the tap to Control. A gone,
replaced, or unavailable session leaves the directory visible with an expired/changed notice.
Activity may have resumed after delivery; the tap opens the current transcript, not a claimed
completed result. The ordinary launch endpoint revalidates generation and access again.
Both route variants reject duplicate, mixed, extra, or malformed parameters.

Opaque request IDs are correlation metadata, not bearer authorization. They may occur transiently
in push, notification data, the scrubbed route, and capability-free history state. Collaboration
capabilities remain forbidden from push state/payloads, notifications, URLs, history, service
worker messages, browser storage, caches, logs, and diagnostics.

## Acceptance checklist

The checked items below record pre-cutover implementation acceptance, including **fork-era**
layout and leak-suite evidence. They do not qualify this specialized attention/notification
matrix on mainline OMP; its exact host, physical-client, and background-Push qualification
remains pending. The [release ledger](RELEASE_STATUS.md) records passed mainline core checks,
not qualification of these specialized scenarios.

- [x] Whole-mode queue, FIFO `Up next`, boolean fallback, whole-row actions, and no manual Refresh.
- [x] Seven exact notification states; permission only after explicit enable.
- [x] Per-device Private/Session/Preview sheet with default, warning, footnote, and disable action.
- [x] Strict v2 attention/clear payloads; per-instance replacement; exact-request clear; app badge.
- [x] Notification tap scrubs and revalidates the exact ask before the no-store Control launch.
- [x] Last-known metadata survives phone, tailnet, desktop, and relay failures with distinct copy.
- [x] The measured 411×816 Pixel layout viewport and synthetic 390×844 browser checks remain overflow-free with targets at least 44px.
- [x] Capability-leak scan and focused protocol, registry, HTTP, app, worker, and browser tests pass.
