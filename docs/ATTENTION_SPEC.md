# Needs-attention + notification opt-in — design contract

Normative UI and privacy contract for the implemented `inputRequired` and background Web Push
features. The static markup, application controller, service worker, gateway sender, and automated
tests use these class names, state labels, and copy.

Visual reference: `OMP Sessions PWA.dc.html`, addendum section (screens 04–07;
canonical 01–03 show the updated masthead).

## Product boundary

The dashboard is a session directory and capability broker. It never renders
prompt text, response options, option counts, request IDs, or transcript
content. A notification tap is an explicit Control action only after opt-in:
the app revalidates the exact generation and current attention state, then
uses the ordinary just-in-time, no-store, in-memory launch path.

## Feature 1 — attention card

When authoritative metadata has `inputRequired: true`:

```html
<div class="session-card">
  <h2>relay soak harness</h2>
  <div class="session-meta">…</div>
  <p class="attention" id="attention-{instanceId}">Needs attention</p>
  <!-- view-only sessions instead: -->
  <!-- <p class="attention" id="attention-{instanceId}">Needs attention — Control unavailable</p> -->
  <div class="session-actions" data-count="2">
    <button class="action action-primary" aria-describedby="attention-{instanceId}">View</button>
    <button class="action action-control" aria-describedby="attention-{instanceId}">Control</button>
  </div>
</div>
```

- Pill sits **below the metadata, before the actions**. Omit it entirely when
  `inputRequired` is false.
- Exact copy: `Needs attention` / `Needs attention — Control unavailable`
  (em dash).
- Gold `--control` / `--control-border` treatment. The **card border does not
  change** — no gold outline around the card.
- Static and descriptive: not a button, no pulse/animation, no live region,
  no alarm decoration. Text carries the meaning, never color alone.
- Every rendered action button gets `aria-describedby="attention-{instanceId}"`.
- View first, primary. When Control is unavailable, **omit the Control button
  entirely** (no disabled placeholder); `data-count="1"` makes View full-width.
- Attention never clears optimistically when View/Control is launched. It
  clears only when authoritative metadata returns `inputRequired: false`, or
  the record is removed by expiry, offline handling, or auth failure.

### Ordering

Attention cards sort ahead of ordinary cards. Within each group:

1. Newest `startedAt` first.
2. `instanceId` as deterministic tie-breaker.

Reorder only on accepted authoritative updates.

## Feature 2 — background alert control

In `index.html` (dashboard chrome, subordinate to the session list — never
per-card):

```html
<div class="masthead-actions">
  <button id="refresh" class="refresh" type="button">Refresh</button>
  <button id="notify" class="notify" type="button" data-state="checking" disabled>Checking background alerts…</button>
  <p id="notify-note" class="notify-note">Alerts work with the app closed. Tapping one opens current Control after revalidation.</p>
</div>
```

`app.ts` drives `#notify` (`data-state` + `disabled` + `textContent`) and
`#notify-note`. **Enable background alerts** and **Disable background alerts**
are interactive. Use the exact ellipsis character `…`.

| `data-state` | Label | Enabled? | `#notify-note` copy |
|---|---|---:|---|
| `checking` | `Checking background alerts…` | No | default |
| `idle` | `Enable background alerts` | Yes | default |
| `enabling` | `Enabling…` | No | default |
| `disabling` | `Disabling…` | No | default |
| `enabled` | `Disable background alerts` | Yes | default |
| `blocked` | `Notifications blocked` | No | `Notifications are blocked. Enable them in this site's browser settings.` |
| `unavailable` | `Background alerts unavailable` | No | default |

Default copy: `Alerts work with the app closed. Tapping one opens current
Control after revalidation.` The note is always visible; only denied swaps
its text.

- **Never** request permission on page load; the prompt is always
  user-initiated via the button.
- A previously granted browser subscription may be re-registered with the
  gateway on load without prompting again.
- Enabling creates a browser Push subscription and stores its endpoint/keys
  plus the per-install VAPID key pair in a private gateway state file.
- Disabling unsubscribes in the browser and asks the gateway to remove the
  endpoint; a later `404`/`410` delivery response also removes stale state.
- Notification failures never degrade the metadata directory.

## Notification firing

The gateway observes authoritative registry metadata. It sends an encrypted
Web Push message when a Control-capable session becomes actionable:

- first observation of an active `inputRequired: true` generation;
- same-generation `false → true`; or
- subscription opt-in while a current Control-capable attention state exists.

Repeated `true` updates do not send again. `true → false`, exact-generation
removal, and generation replacement send a matching `resolved` message so the
service worker closes the tagged notification. View-only attention does not
push because the notification could not open a resolving Control client.

Payloads contain exactly:

```json
{
  "version": 1,
  "type": "attention",
  "instanceId": "metadata-only-instance-id",
  "generation": 3
}
```

`type` may instead be `resolved`. Prompt text, options, labels, paths, request
identity, transcript content, and collaboration capabilities are forbidden.
The visible notification is exactly:

- Title: `OMP session needs attention`
- Body: omitted
- Tag: exact instance/generation-derived notification identity

The gateway requests high-urgency delivery with a five-minute TTL and a
coalescing topic. Delivery remains best effort: browser force-stop,
notification settings, device power policy, network loss, or an unavailable
desktop can delay or prevent it.

On tap, the worker focuses/navigates an existing same-origin directory window
or opens `/attention/{instanceId}/{generation}`. The app synchronously
replaces that metadata-only route with `/`, loads an authenticated snapshot,
and opens Control only when the exact generation still has
`inputRequired: true` and `canControl: true`. Otherwise it shows the expired
state. The capability is fetched later by the existing launch POST and stays
out of the push payload, URL, history, service-worker messages, and storage.

## Acceptance checklist

- [ ] Pill below meta / above actions; both exact labels; no full-card gold
      border; no animation or live region.
- [ ] View precedes Control; missing Control ⇒ button omitted, View
      full-width via `data-count="1"`.
- [ ] Mixed list puts attention sessions first; ordering rules 1–2; reorders
      only on authoritative updates; no optimistic clearing.
- [ ] All seven `#notify` labels exact; enable/disable are the only interactive
      states; no permission prompt on load.
- [ ] Browser subscription persists across a closed page; private gateway
      state contains only VAPID/subscription material, never session content.
- [ ] Strict attention/resolved payloads contain only version, type,
      `instanceId`, and generation; visible text has the fixed title and no
      body.
- [ ] A tap scrubs the attention route, validates exact current state, and
      opens Control through the no-store in-memory launch path; stale taps
      stay on the dashboard.
- [ ] Duplicate transitions collapse, resolution closes the exact tag, and
      `404`/`410` endpoints are removed.
- [ ] 412×915 and 390×844: masthead actions row wraps cleanly; targets
      ≥44px; all states overflow-free.
- [ ] No prompt/transcript content, request details, or capability secrets
      appear in push state, payloads, notifications, URLs/history, dashboard,
      service-worker messages, storage, caches, logs, or diagnostics.
