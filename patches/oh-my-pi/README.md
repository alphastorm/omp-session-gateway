# OMP patch handoff

Place the eventual patch series, fork commit SHAs, or upstream PR notes here.

Expected patch units:

1. Extract `CollabController` and make `/collab` delegate to it without behavior change.
2. Add typed `collab.autoStart` and `collab.registryEndpoint` settings.
3. Add the local registry publisher and protocol tests.
4. Wire active-session generation changes and revocation ordering.
5. Add documentation and backward-compatibility tests.
6. Optionally expose a supported extension `ctx.collab` API in a separate PR.

Keep generated/vendor changes out of the core patch where possible.
