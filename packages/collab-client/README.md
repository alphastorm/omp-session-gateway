# `packages/collab-client`

Pinned integration of OMP's existing `packages/collab-web` source at tag `v18.3.0`, commit
`62bc57be1b03ef0802a33cf7f5f530e534527531`. The upstream collab package remains version
`16.3.6`; `@oh-my-pi/pi-wire` is pinned exactly to `18.3.0`. Its collaboration protocol is
unchanged from `v18.1.14`; the wire package only adds unrelated `skillshare` and `stream` modules.

These are the preserved browser-client provenance pins, not the OMP host prerequisite. The gateway
consumes the native registry/controller in stock OMP `>= 18.1.20` without a fork, custom OMP
build, or gateway-specific OMP plugin. Its root `UPSTREAM.lock.json` records that separate
host/source baseline; the two pins happen to name the same tag but move independently. See
[OMP_INTEGRATION.md](../../docs/OMP_INTEGRATION.md) for qualification and deployment scope.

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

The `v18.1.14` and `v18.3.0` client changes are integrated without weakening the gateway's local
boundaries. `v18.3.0` adds the `wait` tool renderer and memoizes the transcript's active-tool
scan; the hub-family renderers upstream removed (`hub`, `irc`, `job`, `await`, `poll`,
`cancel_job`) stay registered because the older OMP releases the gateway supports still emit them.
Upstream's unbounded guest room-recovery retry and its cached entries array are not adopted: the
bounded local room recovery recorded in `upstream/UPSTREAM.json` already keeps established guests,
and entries are replaced only by entry frames, so their reference is already stable across
streaming frames. LaTeX
delimiters render through KaTeX `0.18.5` as native MathML with `trust: false`; no KaTeX stylesheet,
font URL, or remote asset is emitted. The browser bundle retains npm `marked` `18.0.9` and vendors
the pure delimiter grammar from `@oh-my-pi/pi-utils` `18.3.0` at the same commit rather than adding
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
