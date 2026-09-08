# `packages/collab-client`

Pinned integration of OMP's existing `packages/collab-web` source at tag `v18.1.14`, commit
`daf07999c2fee9b22edc7bf8fea1fb6272e0df5e`. The upstream collab package remains version
`16.3.6`; `@oh-my-pi/pi-wire` is pinned exactly to `18.1.14`. Wire protocol source is unchanged
from `v17.4.1`; the wire package delta is release metadata and toolchain scripts only.

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

The `v18.1.14` client changes are integrated without weakening the gateway's local boundaries. LaTeX
delimiters render through KaTeX `0.18.5` as native MathML with `trust: false`; no KaTeX stylesheet,
font URL, or remote asset is emitted. The browser bundle retains npm `marked` `18.0.9` and vendors
the pure delimiter grammar from `@oh-my-pi/pi-utils` `18.1.14` at the same commit rather than adding
that package's native dependency closure. Initial and recovered `live` transitions return the main
transcript to its tail, while the compact agent transcript remains independent. Upstream's retired
`inspect_image` renderer is removed.
Markdown links use the browser URL parser before the HTTP(S)/mailto allowlist, preventing
control-character-obfuscated unsafe schemes while retaining relative links and fragments.

Long histories no longer stall the first paint. The transcript waits behind a `loading transcript…`
placeholder until the guest snapshot completes, then mounts only its newest 150 entries; a
`Show earlier` control reveals 300 more per tap and holds the reader's scroll anchor while those
older rows mount.

Control sessions expose the existing OMP v3 `prompt.images` path as a phone-first photo action.
The Photo action opens an explicit two-choice panel: **Take photo** invokes a rear-camera capture
input, while **Choose existing** opens the ordinary photo library/file picker. The browser rejects
source dimensions above an 8,192px edge or 20 megapixels and normalizes up to four JPEG, PNG, or
WebP inputs to metadata-free JPEGs with a 2,048px edge and 1 MiB per-image cap. Volatile previews
stay available until the host echoes the
sent transcript entry; a lost send retains the exact draft for retry. The gateway HTTP service and
service worker never receive media. Removing, acknowledged sending, or leaving drops preview
references; the normalized image then follows ordinary OMP transcript and model-provider handling
on the host.

`upstream/UPSTREAM.json` records the exact source paths, package versions, Bun `1.4.0`, and local patch list.
`upstream/LICENSE` preserves the upstream license. The build remains a narrow integration; it does not fork the
collaboration protocol or transcript UI.
