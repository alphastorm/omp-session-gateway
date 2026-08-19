# `packages/collab-client`

Pinned integration of OMP's existing `packages/collab-web` source at commit
`858f7dd91fff9b84cf8a2c6a6bb85aa0e6d03a55`.

The local patch passes the capability directly into the root `App` component. The installed PWA
mounts that component in its current document so Android standalone navigation does not depend on
`window.opener`. Embedded gateway mode suppresses the client's competing header, rail, and lifecycle
overlays while retaining its transcript, tool cards, agent drill-down, and sole composer; an active
Ask uses that composer rather than a duplicate shell control. The capability remains in client
memory, and leaving or reloading returns to the gateway without writing it into a URL, DOM
attribute, browser storage, or service-worker cache. Foreground, BFCache restore, online, and
Network Information transitions replace a potentially stale relay transport. While visible, a
metadata-free same-origin health probe also forces one replacement after a detected gateway outage
recovers.

`upstream/UPSTREAM.json` records the exact source path, package version, Bun version, and local patch list.
`upstream/LICENSE` preserves the upstream license. The build remains a narrow integration; it does not fork the
collaboration protocol or transcript UI.
