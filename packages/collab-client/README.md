# `packages/collab-client`

Pinned integration of OMP's existing `packages/collab-web` source at commit
`39c95e5e29b1c8b082059f57421ce445c3dffdd4`.

The local patch passes the capability directly into the root `App` component, supports a one-time same-origin
`MessageChannel` handoff, closes the transfer port after acknowledgement, and returns to the gateway on leave
or reload. It never writes the capability into a URL, DOM attribute, browser storage, or service-worker cache.

`upstream/UPSTREAM.json` records the exact source path, package version, Bun version, and local patch list.
`upstream/LICENSE` preserves the upstream license. The build remains a narrow integration; it does not fork the
collaboration protocol or transcript UI.
