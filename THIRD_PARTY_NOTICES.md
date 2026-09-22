# Third-party notices

The release archive contains a Bun-compiled gateway and a browser bundle built from the pinned
OMP collaboration client. The runtime dependency closure below is derived from the bundled
workspace roots in the distributed `bun.lock`; development-only packages are not shipped. Exact
package integrity values are preserved in `bun.lock` and `SBOM.spdx.json`; `release-info.json`
records the SHA-256 of the distributed lockfile.

The npm packages listed below are not locally modified. Bun 1.4.0 bundles their imported runtime
code into either the gateway executable or the web assets. Their distributed license notices,
source locations, and required attributions are included at the stated archive paths.

## Bundled runtime dependencies

### @oh-my-pi/pi-wire@18.1.14

- Source: <https://github.com/can1357/oh-my-pi/tree/v18.1.14/packages/wire>
- License: MIT
- Copyright: Copyright (c) 2025-2026 Can Bölük; Copyright (c) 2026 Stencil Labs, Inc.
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

### commander@15.0.0

- Source: <https://github.com/tj/commander.js/tree/v15.0.0>
- License: MIT
- Copyright: Copyright (c) 2011 TJ Holowaychuk <tj@vision-media.ca>
- License text: `licenses/runtime/commander/LICENSE`

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

### katex@0.18.5

- Source: <https://github.com/KaTeX/KaTeX/tree/v0.18.5>
- License: MIT
- Copyright: Copyright (c) 2013-2020 Khan Academy and other contributors
- License text: `licenses/runtime/katex/LICENSE`

### lucide-react@1.31.0

- Source: <https://github.com/lucide-icons/lucide/tree/1.31.0/packages/lucide-react>
- License: ISC, with the included Feather-derived icons under MIT
- Copyright: Copyright (c) 2026 Lucide Icons and Contributors; Copyright (c) 2013-present Cole Bemis
- License text: `licenses/runtime/lucide-react/LICENSE`

### marked@18.0.9

- Source: <https://github.com/markedjs/marked/tree/8e858a4f8e7f53ffeae7392a4c9f455e693aa737>
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


### @hexagon/base64@1.1.28

- Source: <https://registry.npmjs.org/@hexagon/base64/-/base64-1.1.28.tgz>
- License: MIT
- Copyright: Copyright (c) 2021-2022 Hexagon <github.com/Hexagon>
- License text: `licenses/runtime/@hexagon__base64/LICENSE`

### @levischuck/tiny-cbor@0.2.11

- Source: <https://registry.npmjs.org/@levischuck/tiny-cbor/-/tiny-cbor-0.2.11.tgz>
- License: MIT
- Copyright: Copyright (c) 2025 Levi
- License text: `licenses/runtime/@levischuck__tiny-cbor/LICENSE`

### @peculiar/asn1-android@2.9.5

- Source: <https://registry.npmjs.org/@peculiar/asn1-android/-/asn1-android-2.9.5.tgz>
- License: MIT
- Copyright: Copyright (c) 2020
- License text: `licenses/runtime/@peculiar__asn1-android/LICENSE`

### @peculiar/asn1-asym-key@2.9.5

- Source: <https://registry.npmjs.org/@peculiar/asn1-asym-key/-/asn1-asym-key-2.9.5.tgz>
- License: MIT
- Copyright: Copyright (c) 2023 Peculiar Ventures, LLC
- License text: `licenses/runtime/@peculiar__asn1-asym-key/LICENSE`

### @peculiar/asn1-cms@2.9.5

- Source: <https://registry.npmjs.org/@peculiar/asn1-cms/-/asn1-cms-2.9.5.tgz>
- License: MIT
- Copyright: Copyright (c) 2020
- License text: `licenses/runtime/@peculiar__asn1-cms/LICENSE`

### @peculiar/asn1-csr@2.9.5

- Source: <https://registry.npmjs.org/@peculiar/asn1-csr/-/asn1-csr-2.9.5.tgz>
- License: MIT
- Copyright: Copyright (c) 2020
- License text: `licenses/runtime/@peculiar__asn1-csr/LICENSE`

### @peculiar/asn1-ecc@2.9.5

- Source: <https://registry.npmjs.org/@peculiar/asn1-ecc/-/asn1-ecc-2.9.5.tgz>
- License: MIT
- Copyright: Copyright (c) 2020
- License text: `licenses/runtime/@peculiar__asn1-ecc/LICENSE`

### @peculiar/asn1-pfx@2.9.5

- Source: <https://registry.npmjs.org/@peculiar/asn1-pfx/-/asn1-pfx-2.9.5.tgz>
- License: MIT
- Copyright: Copyright (c) 2020
- License text: `licenses/runtime/@peculiar__asn1-pfx/LICENSE`

### @peculiar/asn1-pkcs8@2.9.5

- Source: <https://registry.npmjs.org/@peculiar/asn1-pkcs8/-/asn1-pkcs8-2.9.5.tgz>
- License: MIT
- Copyright: Copyright (c) 2020
- License text: `licenses/runtime/@peculiar__asn1-pkcs8/LICENSE`

### @peculiar/asn1-pkcs9@2.9.5

- Source: <https://registry.npmjs.org/@peculiar/asn1-pkcs9/-/asn1-pkcs9-2.9.5.tgz>
- License: MIT
- Copyright: Copyright (c) 2020
- License text: `licenses/runtime/@peculiar__asn1-pkcs9/LICENSE`

### @peculiar/asn1-rsa@2.9.5

- Source: <https://registry.npmjs.org/@peculiar/asn1-rsa/-/asn1-rsa-2.9.5.tgz>
- License: MIT
- Copyright: Copyright (c) 2020
- License text: `licenses/runtime/@peculiar__asn1-rsa/LICENSE`

### @peculiar/asn1-schema@2.9.5

- Source: <https://registry.npmjs.org/@peculiar/asn1-schema/-/asn1-schema-2.9.5.tgz>
- License: MIT
- Copyright: Copyright (c) 2020
- License text: `licenses/runtime/@peculiar__asn1-schema/LICENSE`

### @peculiar/asn1-x509-attr@2.9.5

- Source: <https://registry.npmjs.org/@peculiar/asn1-x509-attr/-/asn1-x509-attr-2.9.5.tgz>
- License: MIT
- Copyright: Copyright (c) 2020
- License text: `licenses/runtime/@peculiar__asn1-x509-attr/LICENSE`

### @peculiar/asn1-x509-post-quantum@2.9.5

- Source: <https://registry.npmjs.org/@peculiar/asn1-x509-post-quantum/-/asn1-x509-post-quantum-2.9.5.tgz>
- License: MIT
- Copyright: Copyright (c) 2023 Peculiar Ventures, LLC
- License text: `licenses/runtime/@peculiar__asn1-x509-post-quantum/LICENSE`

### @peculiar/asn1-x509@2.9.5

- Source: <https://registry.npmjs.org/@peculiar/asn1-x509/-/asn1-x509-2.9.5.tgz>
- License: MIT
- Copyright: Copyright (c) 2020
- License text: `licenses/runtime/@peculiar__asn1-x509/LICENSE`

### @peculiar/utils@2.0.3

- Source: <https://registry.npmjs.org/@peculiar/utils/-/utils-2.0.3.tgz>
- License: MIT
- Copyright: Copyright (c) 2017-2026 Peculiar Ventures, LLC
- License text: `licenses/runtime/@peculiar__utils/LICENSE`

### @peculiar/x509@2.1.0

- Source: <https://registry.npmjs.org/@peculiar/x509/-/x509-2.1.0.tgz>
- License: MIT
- Copyright: Copyright (c) Peculiar Ventures. All rights reserved.
- License text: `licenses/runtime/@peculiar__x509/LICENSE`

### @simplewebauthn/server@14.0.2

- Source: <https://registry.npmjs.org/@simplewebauthn/server/-/server-14.0.2.tgz>
- License: MIT
- Copyright: Copyright (c) 2020 Matthew Miller
- License text: `licenses/runtime/@simplewebauthn__server/LICENSE.md`

### asn1js@3.0.10

- Source: <https://registry.npmjs.org/asn1js/-/asn1js-3.0.10.tgz>
- License: BSD-3-Clause
- Copyright: Copyright (c) 2014, GMO GlobalSign; Copyright (c) 2015-2022, Peculiar Ventures
- License text: `licenses/runtime/asn1js/LICENSE`

### pvtsutils@1.3.6

- Source: <https://registry.npmjs.org/pvtsutils/-/pvtsutils-1.3.6.tgz>
- License: MIT
- Copyright: Copyright (c) 2017-2024 Peculiar Ventures, LLC
- License text: `licenses/runtime/pvtsutils/LICENSE`

### pvutils@1.2.0

- Source: <https://registry.npmjs.org/pvutils/-/pvutils-1.2.0.tgz>
- License: MIT
- Copyright: Copyright (c) 2016-2019, Peculiar Ventures
- License text: `licenses/runtime/pvutils/LICENSE`

### reflect-metadata@0.2.2

- Source: <https://registry.npmjs.org/reflect-metadata/-/reflect-metadata-0.2.2.tgz>
- License: Apache-2.0
- Copyright: Copyright (c) Microsoft Corporation. All rights reserved.
- License text: `licenses/runtime/reflect-metadata/LICENSE`
- Additional notice: `licenses/runtime/reflect-metadata/CopyrightNotice.txt`

### tslib@1.14.1

- Source: <https://registry.npmjs.org/tslib/-/tslib-1.14.1.tgz>
- License: 0BSD
- Copyright: Copyright (c) Microsoft Corporation.
- License text: `licenses/runtime/tslib@1.14.1/LICENSE.txt`
- Additional notice: `licenses/runtime/tslib@1.14.1/CopyrightNotice.txt`

### tslib@2.8.1

- Source: <https://registry.npmjs.org/tslib/-/tslib-2.8.1.tgz>
- License: 0BSD
- Copyright: Copyright (c) Microsoft Corporation.
- License text: `licenses/runtime/tslib@2.8.1/LICENSE.txt`
- Additional notice: `licenses/runtime/tslib@2.8.1/CopyrightNotice.txt`

### tsyringe@4.10.0

- Source: <https://registry.npmjs.org/tsyringe/-/tsyringe-4.10.0.tgz>
- License: MIT
- Copyright: Copyright (c) Microsoft Corporation. All rights reserved.
- License text: `licenses/runtime/tsyringe/LICENSE`

## Vendored and locally modified runtime component

### @oh-my-pi/collab-web@16.3.6

- Source: <https://github.com/can1357/oh-my-pi/tree/daf07999c2fee9b22edc7bf8fea1fb6272e0df5e/packages/collab-web>
- Additional source: `@oh-my-pi/pi-utils@18.1.14` delimiter grammar from
  <https://github.com/can1357/oh-my-pi/blob/daf07999c2fee9b22edc7bf8fea1fb6272e0df5e/packages/utils/src/math-delimiters.ts>
- Pinned source: tag `v18.1.14`, commit `daf07999c2fee9b22edc7bf8fea1fb6272e0df5e`
- License: MIT
- Copyright: Copyright (c) 2025 Mario Zechner; Copyright (c) 2025-2026 Can Bölük; Copyright (c) 2026 Stencil Labs, Inc.
- License text: `licenses/collab-web/LICENSE`
- Distributed code: `apps/web/dist/assets/collab-client.<content-hash>.js` and
  `apps/web/dist/assets/collab-client.<content-hash>.css`
- Local modifications: memory-only capability bootstrap with no URL/hash/storage writes; embedded
  gateway chrome and sole Ask-aware composer; strict read-only mutation guards; photo capture,
  metadata stripping, bounds, volatile previews, transcript acknowledgements, and retry; foreground,
  online, relay-room, and gateway-health transport recovery; generation-bound sends with fresh hello;
  long-transcript windowing; exact-optional view-link typing; and redacted capability errors. The pure
  delimiter grammar is vendored instead of adding `@oh-my-pi/pi-utils` and its native dependency
  closure; the renderer retains the existing npm `marked` integration.

OMP itself is a separately installed mainline prerequisite, not a bundled or locally modified
runtime component of this archive. The upstream OMP license text is retained at
`licenses/oh-my-pi/LICENSE`; the client and runtime attributions above remain applicable.

The top-level `LICENSE` covers OMP Session Gateway itself. `NOTICE.md` describes the project's
independent relationship to Oh My Pi; it does not replace any license text listed above.
