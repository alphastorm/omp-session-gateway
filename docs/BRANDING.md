# OMP Session Gateway — brand & UI spec

Identity for `omp-session-gateway`: a sober, security-first infra tool that is
visibly a *companion* to [oh-my-pi](https://github.com/can1357/oh-my-pi) without
copying its mark. This file is the source of truth for the implementing agent.

## The mark: "The Gate"

A lintel over two posts — a gateway that quietly echoes π — with an emerald dot
passing through: a live session crossing the boundary. Geometry (96×96 viewBox,
all radii 2):

- lintel `x12 y16 w72 h10`
- posts `x24/x62 y26 w10 h52`
- dot `cx48 cy58 r8` in Live emerald

Rules:

- Never use upstream OMP's π-with-plug mark or derivatives of it.
- Clearspace: one dot diameter (16 units) on all sides. Minimum size 16px.
- The dot is always Live emerald; the frame is Ink on dark surfaces
  (`logo.svg`) or Ink-dark on light surfaces (`logo-light.svg`). Never recolor.
- The dot doubles as the product-wide "live" motif (status dots, pills).

## Color

Dark-first (GitHub audience, terminal-native product). Blue-black ground —
deliberately cooler than OMP's warm `#0d0d0d`.

| Token | Hex | oklch | Use |
|---|---|---|---|
| ground | `#060809` | oklch(0.13 0.005 240) | page background |
| ink-dark | `#0B0E11` | oklch(0.16 0.008 240) | icon tiles, buttons on light |
| surface | `#0E1319` | oklch(0.18 0.012 245) | cards, panels |
| border-subtle | `#161C22` | oklch(0.22 0.012 245) | inner hairlines |
| border | `#1C232B` | oklch(0.26 0.014 245) | card borders |
| ink | `#E8ECEF` | oklch(0.94 0.004 240) | headings, primary buttons |
| body | `#B6BEC7` | oklch(0.80 0.010 240) | body text |
| muted | `#8A939D` | oklch(0.66 0.012 240) | meta, labels |
| live | `#31C48D` | oklch(0.73 0.14 163) | live status, accents, links, focus |
| control | `#C99B45` | oklch(0.73 0.11 80) | Control action (privileged) |
| danger | `#C85045` | oklch(0.58 0.14 27) | unauthorized / error states |
| kinship | `#F97316` | — (upstream orange) | see rule below |

**Kinship rule:** upstream orange appears at most once per surface, only as a
micro-dot (≤5px UI, ≤8px banner) adjacent to an oh-my-pi mention — never in the
mark, never on interactive elements, never as a fill. It is a citation, not an
accent.

## Type

- **Space Grotesk** (Google Fonts) 500/600 — headings, buttons, wordmark.
  Wordmark: "OMP Session Gateway", weight 600, letter-spacing −0.015em.
- **JetBrains Mono** 400/500 — eyebrows, session metadata, paths, chips.
  Labels: 11–12px, uppercase, letter-spacing 0.1–0.22em.
- Fallbacks: `system-ui, sans-serif` / `ui-monospace, monospace`. Self-host or
  system-fallback in the PWA if offline-first matters; never block render.

## Voice

Sober and exact. Sentence case everywhere except mono eyebrows. No emoji, no
exclamation marks. Security claims stated as invariants ("Capabilities are
requested only when you tap an action."). Keep the standing disclaimer:
"Community project; not affiliated with OMP."

## Asset inventory

| File | Purpose |
|---|---|
| `assets/logo.svg` | mark, transparent, for dark backgrounds |
| `assets/logo-light.svg` | mark for light backgrounds |
| `assets/banner.html` | README banner source (1280×320) |
| `assets/banner.png` | rendered banner @2x (2560×640) |
| `assets/og.png` | GitHub social preview (1280×640) |
| `apps/web/icon.svg` | PWA icon source (512, rx116 tile) |
| `apps/web/favicon.svg` | favicon (96, rx22 tile) |
| `apps/web/icon-192.png` / `icon-512.png` | manifest icons, `purpose: any` |
| `apps/web/icon-maskable-512.png` | manifest icon, `purpose: maskable` |
| `apps/web/apple-touch-icon-180.png` | apple-touch-icon |
| `apps/web/src/index.html` / `styles.css` / `manifest.webmanifest` | drop-in PWA shell implementing this spec (see `HANDOFF_NOTES.md`) |

Manifest snippet:

```json
"background_color": "#060809",
"theme_color": "#060809",
"icons": [
  { "src": "/icon-192.png", "sizes": "192x192", "type": "image/png" },
  { "src": "/icon-512.png", "sizes": "512x512", "type": "image/png" },
  { "src": "/icon-maskable-512.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable" }
]
```

README: use `assets/banner.png` at top (it is dark-mode native and acceptable
on light GitHub). `<meta name="theme-color" content="#060809">`.

## PWA UI system ("OMP Sessions")

Reference mockup: `OMP Sessions PWA.dc.html` (three states side by side).
Register: Stripe/Uber/Square-grade restraint — strong type, hard hierarchy,
few colors, no decoration that isn't information.

- Layout: single column, `min(100% − 2rem, 26rem)` on phones; cards grid
  `repeat(auto-fill, minmax(20rem, 1fr))` from 44rem up. Spacing on a 4px grid.
- Radii: 8px cards/buttons, 999px pills. Borders 1px `border`; shadows none —
  hierarchy comes from surface steps, not elevation.
- App bar: mark 24px + mono eyebrow `PRIVATE TAILNET DIRECTORY` (live color) +
  H1 "Sessions" (Space Grotesk 600, 28px) + live pill (`live` dot + "Live · N").
- Session card (`surface` bg, `border`): title 17px/600; mono meta rows 12px
  (model, cwd truncated middle, age, `g<N>` generation chip); actions row.
- Actions: **View** = primary, solid `ink` bg / `ink-dark` text (Uber-style
  white-on-dark). **Control** = outlined `control` color, transparent bg;
  optional WebAuthn hint under it. Buttons ≥48px tall, radius 8, weight 600.
- Status banner: left-borderless — a full-width `surface` strip with a leading
  status dot (live/loading/danger). Unauthorized state uses `danger` text +
  dot, mono detail line, and hides all cards.
- Empty state: ghost mark (mark at 20% opacity), "No live sessions", mono hint
  about `collab.autoStart`.
- Focus: 2px `live` ring, 2px offset. Motion: 150ms ease-out fades only;
  respect `prefers-reduced-motion`.
- Links: `live` color, hover lighten (`#5FD9A9`).

Security-UX invariants (do not regress): capabilities fetched only on tap
(no-store), never rendered into DOM attributes/history/storage; footer keeps
both standing lines from the current app.

## Relationship to upstream

Independent community project; not affiliated with or endorsed by the Oh My Pi
maintainers. Respect `TRADEMARKS.md`. "OMP" appears in the name as plain
nominative reference; do not restyle upstream's logo.
