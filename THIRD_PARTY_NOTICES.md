# Third-party notices

The release archive contains a Bun-compiled gateway and a browser bundle built from the pinned
OMP collaboration client. The runtime dependency closure below is derived from the bundled
workspace roots in the distributed `bun.lock`; development-only packages are not shipped. Exact
package integrity values are preserved in `bun.lock` and `SBOM.spdx.json`; `release-info.json`
records the SHA-256 of the distributed lockfile.

The npm packages listed below are not locally modified. Bun 1.3.14 bundles their imported
runtime code into `apps/web/dist/assets/collab-client.<content-hash>.js`. Their full license
texts and required attributions are included at the stated archive paths.

## Bundled runtime dependencies

### @oh-my-pi/pi-wire@17.0.6

- Source: <https://github.com/can1357/oh-my-pi/tree/v17.0.6/packages/wire>
- License: MIT
- Copyright: Copyright (c) 2025 Mario Zechner; Copyright (c) 2025-2026 Can Bölük
- License text: `licenses/runtime/@oh-my-pi__pi-wire/LICENSE`

### lucide-react@1.24.0

- Source: <https://github.com/lucide-icons/lucide/tree/1.24.0/packages/lucide-react>
- License: ISC, with the included Feather-derived icons under MIT
- Copyright: Copyright (c) 2026 Lucide Icons and Contributors; Copyright (c) 2013-present Cole Bemis
- License text: `licenses/runtime/lucide-react/LICENSE`

### marked@18.0.6

- Source: <https://github.com/markedjs/marked/tree/39bd884c5f17a8370cf957b8d46a15751868ab4d>
- License: MIT, with the reproduced Markdown license and attribution
- Copyright: Copyright (c) 2018+ MarkedJS; Copyright (c) 2011-2018 Christopher Jeffrey; Copyright (c) 2004 John Gruber
- License text: `licenses/runtime/marked/LICENSE`

### react@19.2.7

- Source: <https://github.com/facebook/react/tree/6117d7cca4906492c51fe6a03381e35adfd86e7d/packages/react>
- License: MIT
- Copyright: Copyright (c) Meta Platforms, Inc. and affiliates
- License text: `licenses/runtime/react/LICENSE`

### react-dom@19.2.7

- Source: <https://github.com/facebook/react/tree/6117d7cca4906492c51fe6a03381e35adfd86e7d/packages/react-dom>
- License: MIT
- Copyright: Copyright (c) Meta Platforms, Inc. and affiliates
- License text: `licenses/runtime/react-dom/LICENSE`

### scheduler@0.27.0

- Source: <https://github.com/facebook/react/tree/861811347b8fa936b4a114fc022db9b8253b3d86/packages/scheduler>
- License: MIT
- Copyright: Copyright (c) Meta Platforms, Inc. and affiliates
- License text: `licenses/runtime/scheduler/LICENSE`

## Vendored and locally modified runtime component

### @oh-my-pi/collab-web@16.3.6

- Source: <https://github.com/can1357/oh-my-pi/tree/89d6a8f6d14286f32f09ec9c8aa8af7b3451d2d6/packages/collab-web>
- Pinned source: tag `v17.0.6`, commit `89d6a8f6d14286f32f09ec9c8aa8af7b3451d2d6`
- License: MIT
- Copyright: Copyright (c) 2025 Mario Zechner; Copyright (c) 2025-2026 Can Bölük
- License text: `licenses/collab-web/LICENSE`
- Distributed code: `apps/web/dist/assets/collab-client.<content-hash>.js` and
  `apps/web/dist/assets/collab-client.<content-hash>.css`
- Local modifications: direct in-memory capability input with no capability URL/hash writes;
  one-time same-origin `MessageChannel` bootstrap; secret-free direct-entry, reload, and BFCache
  recovery; fresh relay transport after mobile foreground and online transitions; generation-bound
  send queues with a fresh hello before application frames; exact-optional typing for view links;
  and redaction of invalid capability input from collaboration-link errors.

## Distributed OMP integration patch

### @oh-my-pi/pi-coding-agent patch@17.0.6

- Source: <https://github.com/can1357/oh-my-pi/tree/89d6a8f6d14286f32f09ec9c8aa8af7b3451d2d6/packages/coding-agent>
- Pinned source: tag `v17.0.6`, commit `89d6a8f6d14286f32f09ec9c8aa8af7b3451d2d6`
- License: MIT
- Copyright: Copyright (c) 2025 Mario Zechner; Copyright (c) 2025-2026 Can Bölük
- License text: `licenses/oh-my-pi/LICENSE`
- Distributed patch: `patches/oh-my-pi/0001-collab-controller-autostart-registry.patch`
- Local modifications: shared collaboration controller ownership, auto-start settings, lifecycle
  revocation/publication ordering, and authenticated local registry publication as documented in
  `patches/oh-my-pi/README.md`.

The top-level `LICENSE` covers OMP Session Gateway itself. `NOTICE.md` describes the project's
independent relationship to Oh My Pi; it does not replace any license text listed above.
