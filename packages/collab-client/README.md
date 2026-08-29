# `packages/collab-client`

Pinned integration of OMP's existing `packages/collab-web` source at commit
`9350b7990d26ebf69a604edc82d8558ef04adf30`.

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

Long histories no longer stall the first paint. The transcript waits behind a `loading transcript…`
placeholder until the guest snapshot completes, then mounts only its newest 150 entries; a
`Show earlier` control reveals 300 more per tap and holds the reader's scroll anchor while those
older rows mount.

Control sessions expose the existing OMP v3 `prompt.images` path as a phone-first photo action.
The browser opens the system camera/photo chooser, rejects source dimensions above an 8,192px edge
or 20 megapixels, and normalizes up to four JPEG, PNG, or WebP inputs to metadata-free JPEGs with a
2,048px edge and 1 MiB per-image cap. Volatile previews stay available until the host echoes the
sent transcript entry; a lost send retains the exact draft for retry. The gateway HTTP service and
service worker never receive media. Removing, acknowledged sending, or leaving drops preview
references; the normalized image then follows ordinary OMP transcript and model-provider handling
on the host.

`upstream/UPSTREAM.json` records the exact source path, package version, Bun version, and local patch list.
`upstream/LICENSE` preserves the upstream license. The build remains a narrow integration; it does not fork the
collaboration protocol or transcript UI.
