# Needs-attention + notification opt-in — design contract

Normative UI and privacy contract for the implemented `inputRequired` and foreground-notification
features. The static markup, application controller, service worker, styles, and automated tests
use these class names, state labels, and copy.

Visual reference: `OMP Sessions PWA.dc.html`, addendum section (screens 04–07;
canonical 01–03 show the updated masthead).

## Product boundary

The dashboard is a session directory and capability broker. It never renders
prompt text, response options, option counts, request IDs, or transcript
content. Notification taps return to the dashboard; they never launch Control
or the collab client.

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

## Feature 2 — notification control

In `index.html` (dashboard chrome, subordinate to the session list — never
per-card):

```html
<div class="masthead-actions">
  <button id="refresh" class="refresh" type="button">Refresh</button>
  <button id="notify" class="notify" type="button" data-state="checking" disabled>Checking notifications…</button>
  <p id="notify-note" class="notify-note">Notifications may show session names on your lock screen.</p>
</div>
```

`app.ts` drives `#notify` (`data-state` + `disabled` + `textContent`) and
`#notify-note`. Only **Enable notifications** is interactive. Use the exact
ellipsis character `…`.

| `data-state` | Label | Enabled? | `#notify-note` copy |
|---|---|---:|---|
| `checking` | `Checking notifications…` | No | default |
| `idle` | `Enable notifications` | Yes | default |
| `enabling` | `Enabling…` | No | default |
| `enabled` | `Notifications enabled` | No | default |
| `blocked` | `Notifications blocked` | No | `Notifications are blocked. Enable them in this site's browser settings.` |
| `unavailable` | `Notifications unavailable` | No | default |

Default copy: `Notifications may show session names on your lock screen.`
The note is always visible; only denied swaps its text. Denied is
informational — no in-app retry path; permission changes happen in browser
site settings.

- **Never** request permission on page load; the prompt is always
  user-initiated via the button.
- Disabled states read as status, not broken buttons (CSS: settled states get
  subtle border + muted text; `checking`/`enabling` add progress cursor +
  reduced opacity).
- Notification failures are silent and never degrade the dashboard.

## Notification firing

Foreground/live-page enhancement, **not Web Push**: requires the dashboard
open/alive; no delivery promise after the browser/page is killed; one live
tab recommended; duplicates across multiple open tabs are accepted.

Fires only when **all** hold:

- Browser permission granted.
- Initial metadata baseline complete.
- An accepted update for the same session generation flips `inputRequired`
  `false → true`.

Suppress for: sessions already true at initial load · a newly observed
generation already true · repeated/duplicate true updates · stale updates ·
denied/unavailable API. A `true → false → true` transition re-arms.

Content, exact:

- Title: `OMP session needs attention`
- Body: session title; if absent, `cwdLabel`; if both absent, omit the body.
- Nothing else — no actions, request details, prompt content, or capability
  secrets.

On tap: focus an existing same-origin dashboard window, else open `/`.
Never open Control or the collab client.

## Acceptance checklist

- [ ] Pill below meta / above actions; both exact labels; no full-card gold
      border; no animation or live region.
- [ ] View precedes Control; missing Control ⇒ button omitted, View
      full-width via `data-count="1"`.
- [ ] Mixed list puts attention sessions first; ordering rules 1–2; reorders
      only on authoritative updates; no optimistic clearing.
- [ ] All six `#notify` labels exact (real `…`); only Enable interactive;
      denied swaps the note copy; no auto-prompt on load.
- [ ] Notification: generic title, privacy-minimized body fallback; fires
      only on same-generation false→true after baseline; suppression +
      re-arm honored; tap returns to `/`.
- [ ] 412×915 and 390×844: masthead actions row wraps cleanly; targets
      ≥44px; all states overflow-free.
- [ ] No prompt/transcript content, request details, or capability secrets
      anywhere in the dashboard.
