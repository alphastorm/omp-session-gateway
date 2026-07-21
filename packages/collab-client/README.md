# `packages/collab-client`

Pinned integration of OMP's existing `packages/collab-web` source at commit
`89d6a8f6d14286f32f09ec9c8aa8af7b3451d2d6`.

The local patch passes the capability directly into the root `App` component, supports a one-time same-origin
`MessageChannel` handoff, closes the transfer port after acknowledgement, and returns to the gateway on leave
or reload. It never writes the capability into a URL, DOM attribute, browser storage, or service-worker cache.
Foreground, BFCache restore, and online transitions replace a potentially stale relay transport before reuse.

`upstream/UPSTREAM.json` records the exact source path, package version, Bun version, and local patch list.
`upstream/LICENSE` preserves the upstream license. The build remains a narrow integration; it does not fork the
collaboration protocol or transcript UI.
