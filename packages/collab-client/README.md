# `packages/collab-client`

Pinned integration point for OMP's existing `packages/collab-web` build.

Preferred approaches, in order:

1. consume an upstream package/build artifact if OMP publishes one;
2. include a pinned source subtree or submodule and build it reproducibly in CI;
3. vendor reviewed static output with the exact upstream commit and build provenance recorded.

Required local/upstream change: expose a small bootstrap such as `startWithCapability(capability)` or a component prop so the gateway can pass the capability directly from JavaScript memory. Prefer mounting the client in the same document; a same-origin child page may receive the value through a one-time `MessageChannel`. Do not put the capability in a URL or DOM attribute. A fragment parser may exist only as a temporary compatibility adapter, must scrub the fragment synchronously with `history.replaceState`, and is release-blocked until history, cache, referrer, screenshot, trace, and copied-URL tests prove non-persistence.

Do not fork the collaboration protocol or transcript UI beyond small, upstreamable integration changes. Record all local patches and license notices.
