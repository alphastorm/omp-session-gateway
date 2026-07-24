# Third-party notices

The release archive contains a Bun-compiled gateway and a browser bundle built from the pinned
OMP collaboration client. The runtime dependency closure below is derived from the bundled
workspace roots in the distributed `bun.lock`; development-only packages are not shipped. Exact
package integrity values are preserved in `bun.lock` and `SBOM.spdx.json`; `release-info.json`
records the SHA-256 of the distributed lockfile.

The npm packages listed below are not locally modified. Bun 1.3.14 bundles their imported runtime
code into either the gateway executable or the web assets. Their distributed license notices,
source locations, and required attributions are included at the stated archive paths.

## Bundled runtime dependencies

### @oh-my-pi/pi-wire@17.0.6

- Source: <https://github.com/can1357/oh-my-pi/tree/v17.0.6/packages/wire>
- License: MIT
- Copyright: Copyright (c) 2025 Mario Zechner; Copyright (c) 2025-2026 Can Bölük
- License text: `licenses/runtime/@oh-my-pi__pi-wire/LICENSE`

### agent-base@7.1.4

- Source: <https://github.com/TooTallNate/proxy-agents/tree/agent-base%407.1.4/packages/agent-base>
- License: MIT
- Copyright: Copyright (c) 2013 Nathan Rajlich
- License text: `licenses/runtime/agent-base/LICENSE`

### asn1.js@5.4.1

- Source: <https://github.com/indutny/asn1.js/tree/v5.4.1>
- License: MIT
- Copyright: Copyright (c) 2017 Fedor Indutny
- License text: `licenses/runtime/asn1.js/LICENSE`

### bn.js@4.12.5

- Source: <https://github.com/indutny/bn.js/tree/v4.12.5>
- License: MIT
- Copyright: Copyright Fedor Indutny, 2015
- License text: `licenses/runtime/bn.js/LICENSE`

### buffer-equal-constant-time@1.0.1

- Source: <https://github.com/goinstant/buffer-equal-constant-time/tree/v1.0.1>
- License: BSD-3-Clause
- Copyright: Copyright (c) 2013, GoInstant Inc., a salesforce.com company
- License text: `licenses/runtime/buffer-equal-constant-time/LICENSE`

### debug@4.4.3

- Source: <https://github.com/debug-js/debug/tree/4.4.3>
- License: MIT
- Copyright: Copyright (c) 2014-2017 TJ Holowaychuk; Copyright (c) 2018-2021 Josh Junon
- License text: `licenses/runtime/debug/LICENSE`

### ecdsa-sig-formatter@1.0.11

- Source: <https://github.com/Brightspace/node-ecdsa-sig-formatter/tree/v1.0.11>
- License: Apache-2.0
- Copyright: Copyright 2015 D2L Corporation
- License text: `licenses/runtime/ecdsa-sig-formatter/LICENSE`

### http_ece@1.2.0

- Source: <https://github.com/martinthomson/encrypted-content-encoding/tree/v1.2.0>
- License: MIT
- Copyright: Copyright (c) 2015 Martin Thomson
- License text: `licenses/runtime/http_ece/LICENSE`

### https-proxy-agent@7.0.6

- Source: <https://github.com/TooTallNate/proxy-agents/tree/https-proxy-agent%407.0.6/packages/https-proxy-agent>
- License: MIT
- Copyright: Copyright (c) 2013 Nathan Rajlich
- License text: `licenses/runtime/https-proxy-agent/LICENSE`

### inherits@2.0.4

- Source: <https://github.com/isaacs/inherits/tree/v2.0.4>
- License: ISC
- Copyright: Copyright (c) Isaac Z. Schlueter
- License text: `licenses/runtime/inherits/LICENSE`

### jwa@2.0.1

- Source: <https://github.com/brianloveswords/node-jwa/tree/2.0.1>
- License: MIT
- Copyright: Copyright (c) 2013 Brian J. Brennan
- License text: `licenses/runtime/jwa/LICENSE`

### jws@4.0.1

- Source: <https://github.com/brianloveswords/node-jws/tree/v4.0.1>
- License: MIT
- Copyright: Copyright (c) 2013 Brian J. Brennan
- License text: `licenses/runtime/jws/LICENSE`


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

### minimalistic-assert@1.0.1

- Source: <https://github.com/calvinmetcalf/minimalistic-assert/tree/v1.0.1>
- License: ISC
- Copyright: Copyright 2015 Calvin Metcalf
- License text: `licenses/runtime/minimalistic-assert/LICENSE`

### minimist@1.2.8

- Source: <https://github.com/minimistjs/minimist/tree/v1.2.8>
- License: MIT
- Copyright: no assertion in the distributed package license
- License text: `licenses/runtime/minimist/LICENSE`

### ms@2.1.3

- Source: <https://github.com/vercel/ms/tree/2.1.3>
- License: MIT
- Copyright: Copyright (c) 2020 Vercel, Inc.
- License text: `licenses/runtime/ms/LICENSE`


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

### safe-buffer@5.2.1

- Source: <https://github.com/feross/safe-buffer/tree/v5.2.1>
- License: MIT
- Copyright: Copyright (c) Feross Aboukhadijeh
- License text: `licenses/runtime/safe-buffer/LICENSE`

### safer-buffer@2.1.2

- Source: <https://github.com/ChALkeR/safer-buffer/tree/v2.1.2>
- License: MIT
- Copyright: Copyright (c) 2018 Nikita Skovoroda
- License text: `licenses/runtime/safer-buffer/LICENSE`


### scheduler@0.27.0

- Source: <https://github.com/facebook/react/tree/861811347b8fa936b4a114fc022db9b8253b3d86/packages/scheduler>
- License: MIT
- Copyright: Copyright (c) Meta Platforms, Inc. and affiliates
- License text: `licenses/runtime/scheduler/LICENSE`

### web-push@3.6.7

- Source: <https://github.com/web-push-libs/web-push/tree/v3.6.7>
- License: MPL-2.0
- Copyright: Copyright 2015 Marco Castelluccio
- License text: `licenses/runtime/web-push/LICENSE`


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
