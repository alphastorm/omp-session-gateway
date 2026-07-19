# `packages/collab-client`

Pinned integration point for OMP's existing `packages/collab-web` build.

Preferred approaches, in order:

1. consume an upstream package/build artifact if OMP publishes one;
2. include a pinned source subtree or submodule and build it reproducibly in CI;
3. vendor reviewed static output with the exact upstream commit and build provenance recorded.

Required local/upstream change: optional ephemeral-fragment handling that parses the capability, keeps it only in memory, removes it from visible history with `history.replaceState`, and returns to the dashboard on reload.

Do not fork the collaboration protocol or transcript UI beyond small, upstreamable integration changes. Record all local patches and license notices.
