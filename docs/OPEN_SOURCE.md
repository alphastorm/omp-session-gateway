# Open-source project strategy

## Decision

Publish the project as **OMP Session Gateway** in repository `omp-session-gateway` under the MIT License.

The project is a good open-source candidate because it handles high-value bearer capabilities and sits at a security boundary. Users should be able to inspect exactly how capabilities are registered, authorized, launched, logged, cached, and expired. Public threat modeling, reproducible builds, and community compatibility testing are material product benefits.

## Positioning

The project should be described as:

> A local-first, capability-safe gateway that automatically exposes all running Oh My Pi collaboration sessions through one private mobile PWA.

Its differentiation is narrow and intentional:

- it works with already-running interactive OMP processes;
- it starts and registers collaboration automatically;
- it aggregates many sessions into one private launcher;
- it reuses OMP's native encrypted collaboration client;
- it does not introduce a hosted control plane or transcript database.

Avoid positioning it as a complete OMP dashboard, a replacement agent client, remote desktop, or Android-native rewrite.

## Naming

| Surface | Name |
|---|---|
| Product | OMP Session Gateway |
| Repository | `omp-session-gateway` |
| CLI | `omp-gateway` |
| Service | `omp-session-gateway` |
| Daemon | `omp-gatewayd` |
| Foreground/development alias | `omp-gateway serve` |
| PWA display name | OMP Sessions |
| Default example tailnet tag | `tag:omp-session-gateway` |
| Suggested npm workspace prefix | `@omp-session-gateway/*` |

The repository owner should re-check GitHub, npm, package registries, and relevant trademark databases immediately before publishing. Search results are not a legal clearance.

## Scope boundaries

### In scope

- local publisher authentication and IPC;
- live in-memory session registry;
- private dashboard authorization;
- metadata-only session discovery;
- just-in-time view/control capability delivery;
- PWA installation and Android UX;
- pinned OMP collab-web integration;
- OMP controller/auto-start patch;
- desktop service installation and diagnostics;
- compatibility, security, and lifecycle tests.

### Out of scope for v1

- a second collaboration protocol or transcript renderer;
- persistent transcript storage/indexing;
- a public SaaS dashboard;
- multi-tenant hosting;
- native Android protocol implementation;
- public Internet exposure through Funnel;
- automatic session sharing with other users;
- a relay bundled into the gateway service.

## License

MIT aligns with OMP's permissive ecosystem and makes upstream reuse straightforward. Preserve the license notices of any copied or adapted OMP code. Vendored static assets must retain their applicable notices and exact source/build provenance.

## Privacy posture

- No telemetry or analytics by default.
- No third-party browser scripts, fonts, images, or CDNs at runtime.
- No hosted account system.
- No transcript collection by the gateway.
- Privacy-safe logging with capabilities and full paths forbidden.
- Documentation should explain what Tailscale, the configured relay, and the local desktop can observe.

## Upstream relationship

Keep the OMP patch small and upstreamable. Prefer collaboration with OMP maintainers rather than a long-lived fork. The public README must include a non-affiliation statement and avoid OMP artwork unless permission is granted.

Recommended ownership split:

```text
can1357/oh-my-pi
  └── shared CollabController + auto-start/registry integration hook

<owner>/omp-session-gateway
  ├── daemon and protocol
  ├── PWA and collab-web packaging
  ├── installers and Tailscale operations
  ├── compatibility/security tests
  └── patch/PR tracking
```

## Community model

Begin maintainer-led. Use public issues and ADRs for product decisions. Route vulnerabilities through private security advisories. Require security-impact explanations for changes to identity, IPC, capability handling, browser storage, logging, and OMP lifecycle.

## Release posture

Do not publish a “stable” claim until:

- all security acceptance gates pass;
- the exact OMP compatibility range is tested;
- install/uninstall and upgrades work on advertised platforms;
- releases are built by protected CI with checksums/provenance;
- a private vulnerability-reporting channel is active; and
- docs do not instruct users to expose unfinished builds publicly.
