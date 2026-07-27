# Architecture decision records

## ADR-001 — Use a PWA, not a native Android protocol client

**Status:** Accepted

**Context:** OMP already ships a browser collaboration client that understands the encrypted capability, relay protocol, transcript, composer, tools, interrupts, and subagents.

**Decision:** Build a PWA dashboard and reuse that client. Add a TWA only for packaging needs.

**Consequences:** Lowest duplication and protocol risk. Native-only background/OS features are deferred.

---

## ADR-002 — Aggregate through a local daemon

**Status:** Accepted

**Context:** Multiple independent OMP processes need one discoverable list. Capabilities must not be persisted to disk.

**Decision:** A per-user daemon holds an in-memory registry and receives authenticated local IPC publications.

**Consequences:** Requires one autostart component, but provides clean lifecycle/TTL semantics and one secure phone endpoint.

---

## ADR-003 — Require a small OMP core patch

**Status:** Accepted

**Context:** Process scanning cannot create/recover a live collaboration host, and the documented extension API does not currently expose built-in collab startup.

**Decision:** Extract a reusable `CollabController`, add opt-in auto-start, and publish controller events. Preserve an upstream-safe default of off.

**Consequences:** A fork/PR is required initially. The patch can later enable an extension-only publisher.

---

## ADR-004 — Tailnet-only dashboard via Tailscale Serve

**Status:** Accepted

**Context:** The dashboard distributes bearer capabilities and must not be public. The user wants access from one Android phone without port forwarding.

**Decision:** Bind the gateway to loopback and expose it through Tailscale Serve, with grants and application allowlisting.

**Consequences:** Requires Tailscale on both devices and initial login. Avoids public ingress and supplies authenticated identity headers.

---

## ADR-005 — Keep the existing E2EE relay for v1

**Status:** Accepted

**Context:** The collaboration protocol already encrypts payloads client-side. Proxying/self-hosting the relay increases deployment and long-lived WebSocket risk.

**Decision:** Use the existing relay for v1. Self-hosting is optional after a soak-tested transport is available.

**Consequences:** The relay still observes limited traffic metadata and remains an availability dependency, but not plaintext/content keys.

---

## ADR-006 — Capabilities are memory-only and fetched just in time

**Status:** Accepted

**Context:** Full links grant control; even view links expose sensitive transcripts.

**Decision:** Store capabilities only in daemon and process memory, omit them from list/SSE, and return one only after an explicit no-store launch POST.

**Consequences:** Daemon restart loses the registry until live OMP publishers reconnect, which is desirable. Offline access is intentionally impossible.

---

## ADR-007 — Use SSE for dashboard metadata

**Status:** Accepted

**Context:** The dashboard needs one-way low-rate updates; WebSocket proxying is unnecessary for discovery.

**Decision:** Use ordinary HTTP plus SSE for metadata. The collab client connects directly to its relay.

**Consequences:** Simple proxy behavior, reconnection, observability, and security. No secret crosses SSE.

---

## ADR-008 — Optional WebAuthn gate, not native biometrics

**Status:** Proposed after v1

**Context:** A lost/unlocked phone with an active tailnet identity could control sessions.

**Decision:** Offer WebAuthn user verification for Control launches before considering a native app.

**Consequences:** Strong user-presence check with the same PWA; requires one-time credential enrollment.


---

## ADR-009 — Bootstrap the collab client in memory, not through a URL

**Status:** Accepted

**Context:** OMP browser deep links conventionally carry the collaboration capability in a URL fragment. Fragments are not sent to the HTTP server, but they can remain in browser history, copied URLs, screenshots, and test artifacts.

**Decision:** Add a small pinned/upstreamable in-memory bootstrap API to `collab-web` and pass the just-in-time capability directly from the PWA. A same-origin `MessageChannel` is acceptable for a separate client page. Ephemeral fragment removal is a temporary compatibility fallback only.

**Consequences:** Requires a small collab-web integration change, but materially reduces accidental persistence and makes the security invariant testable. Reload intentionally returns to the session directory.

---

## ADR-010 — Open source under MIT with no telemetry by default

**Status:** Accepted

**Context:** The gateway handles powerful bearer capabilities, so users benefit from auditable code and reproducible releases. The upstream OMP project is MIT-licensed.

**Decision:** Publish OMP Session Gateway under MIT, preserve upstream notices, ship no telemetry/analytics/remote runtime assets, and require private vulnerability reporting plus release provenance.

**Consequences:** Public review improves trust, while maintainers assume responsibility for security triage, dependency hygiene, compatibility documentation, and release integrity.

---

## ADR-011 — Pin OMP main and patch collab-web source in memory

**Status:** Accepted

**Context:** Upstream `main` at `89d6a8f6d14286f32f09ec9c8aa8af7b3451d2d6` still has the slash command directly own `CollabHost`, exposes no supported `ctx.collab` extension API, and has `collab-web` write every connected capability to `location.hash`. Its relevant host, UI, wire v3, and collab-web blocks are byte-identical to the prior pin; unrelated interactive-mode plan/token-rate changes must be preserved.

**Decision:** Target that exact v17.0.6 commit, keep the initial controller/publisher integration as a narrow core patch, and build a pinned collab-web source integration with a direct in-memory bootstrap that never writes the capability to a URL.

**Consequences:** The OMP patch remains necessary for automatic startup and lifecycle-safe publication. The gateway cannot consume upstream collab-web unchanged because doing so would violate the no-persistence capability invariant.

---

## ADR-012 — Prove managed readiness and activate immutable runtimes

**Status:** Accepted

**Context:** A generic loopback health body does not prove that the configured port belongs to the
newly managed gateway; another local account can pre-bind it. In-place runtime replacement also
makes failed upgrades and cross-version rollback difficult to verify.

**Decision:** Stage each gateway payload in a private content-addressed version directory, verify
its manifest and complete payload digest before activation, and advance an atomic current pointer
only after the exact managed service answers a fresh publisher-token HMAC challenge bound to a
one-time instance nonce in its service definition. Snapshot the prior config before mutation and
restore config, service state, and runtime pointer if install fails. Probe both prior and requested
loopback endpoints before replacement. Runtime manifests record the readiness protocol; accept
prior SemVer runtime directories only after the same containment, manifest, and digest verification,
and use a stable service-manager check with the legacy HMAC only for a verified pre-nonce runtime.
Publisher-token rotation never restores the previous token; a failed restart retains the fresh
token and stops the service.

**Consequences:** Installs and upgrades reject generic, same-token-stale, and authenticated
foreground readiness responses without exposing the publisher token. Verified legacy payloads
remain rollback-compatible. Disk use grows by one immutable payload per staged version until an
explicit future garbage-collection policy is qualified.

---

## ADR-013 — Mutually authenticate local registry peers without transmitting the key

**Status:** Accepted

**Context:** A first-frame publisher key authenticates the client to the gateway but not the gateway
to the publisher. On Windows, a same-session process may pre-create the expected named-pipe name
before the gateway starts and receive that key and subsequent capabilities. OS ACLs prevent
cross-user access but do not establish that the process owning the pipe is `omp-gatewayd`.

**Decision:** Replace the raw-key hello with a four-frame, nonce-bound mutual HMAC handshake on every
platform. The publisher sends a fresh client nonce; the gateway sends a fresh server nonce and a
domain-separated server proof; the publisher validates that proof before sending its separately
domain-separated client proof; and the gateway accepts capability-bearing frames only after that
proof validates. Bind both proofs to both nonces, `instanceId`, and PID. Require exact frame keys,
fixed 43-character base64url values, constant-time proof comparison, bounded handshake time/space,
and mutable-buffer scrubbing. Derive the Windows pipe name identically in both components and
require the private token ACL to contain only the current user and SYSTEM.

**Consequences:** The publisher key never crosses IPC, a process that merely squats the pipe
namespace receives only a nonce-bearing hello, stale proofs do not replay, and Windows OMP
publication can fail closed on an unauthenticated server instead of remaining disabled. This is a
clean pre-alpha protocol cutover: old publishers and daemons do not interoperate. Same-user malware
that can read the private token remains outside the v1 threat boundary.

---

## ADR-014 — Recover publication by reconnecting without replacing ambient tool configuration

**Status:** Accepted

**Context:** A host suspension can outlive the registry TTL while leaving the local IPC socket open.
The registry then forgets the record, but a heartbeat alone cannot reconstruct capability-bearing
state. Sending a protocol-error frame after authentication also makes the security-hardened
publisher disable itself rather than reconnect. Separately, an isolated trial that repoints
`XDG_CONFIG_HOME` so the publisher can find its token also hides GitHub and other XDG-backed
credentials from OMP child tools.

**Decision:** When an authenticated publisher exceeds its idle deadline or heartbeats a missing
record, close its IPC connection without an error payload. The existing bounded reconnect path
must re-read the token, mutually authenticate, and re-send the current upsert. Permit isolated
launchers to provide an absolute publisher-token path through
`OMP_GATEWAY_PUBLISHER_TOKEN_PATH`, while retaining every ownership, mode, ACL, symlink, length,
and alphabet check and leaving normal installations on the standard per-user token path.

**Consequences:** Gateway and publisher suspension ordering no longer leaves a live OMP session
permanently absent after TTL. Trial OMP processes retain ambient Git, GitHub, and other XDG-backed
tool configuration without sharing the gateway token location. Actual OS sleep, wake, and network
transition still require native-device qualification.

---

## ADR-015 — Publish metadata-only response-required state

**Status:** Accepted

**Context:** A phone user cannot tell which OMP session is blocked on a host-origin response operation. The gateway does not proxy or decrypt collaboration traffic, and a user may open Control only after the operation began.

**Decision:** Add a boolean `inputRequired` field to the existing v1 publisher and browser metadata contracts. OMP retains a bounded serializable UI request before any writable guest exists, publishes `true` while at least one admitted host-origin response operation remains unresolved, and replays the request to later Control guests. Concurrent operations use generation-scoped reference-counted leases; no prompt text, options, answers, request IDs, counts, or transcript content leave OMP through the gateway. The dashboard orders attention cards first. An optional explicit permission action enables foreground-only browser notifications for authoritative false-to-true transitions; notification text contains only a fixed title and the already-approved bounded session title or directory label, and a tap opens or focuses `/`.

**Consequences:** The gateway remains a session directory and capability broker rather than a collaboration proxy. View stays read-only. Same-generation metadata can change without rotating capabilities, but old generations cannot mutate or retain attention state. Browser notification permission is browser-managed; application request state and dedupe state remain volatile. Multiple open dashboard tabs may each notify, killed-browser and background Push API delivery are unsupported, and physical Android lock-screen presentation remains a release qualification gate.

---

## ADR-016 — Detect silent dashboard transport loss with observable SSE heartbeats

**Status:** Accepted

**Context:** On physical Android, Tailscale can keep a virtual interface present while the radio path is unavailable. In that state `navigator.onLine` may remain true and an existing `EventSource` TCP connection may emit no error for more than 30 seconds. The gateway's SSE comment pings kept intermediaries alive but were not observable by dashboard JavaScript, so stale session cards could remain visible.

**Decision:** Emit a metadata-free named `keepalive` SSE event every 5 seconds. The loaded dashboard resets a 12-second liveness deadline on every directory event or keepalive. Missing that deadline clears all displayed session metadata, closes the potentially half-open `EventSource`, and begins authenticated snapshot retries with a 4-second request timeout and bounded 1/2/4-second backoff. While the collaboration client is visible, probe the same-origin generic health endpoint every 5 seconds with a 3-second timeout and listen for browser online, foreground, BFCache, and Network Information changes. A failed-then-successful probe or explicit network transition replaces the potentially stale relay WebSocket without replacing the logical guest.

**Consequences:** Silent dashboard partitions now have a bounded 12-second stale-display window and recover without waiting for a half-open transport to emit another event. Each loaded dashboard receives at most twelve metadata-free keepalives per minute; each visible collaboration client makes at most twelve generic health requests per minute. This local/tailnet availability traffic is accepted to avoid manual Refresh after radio roaming. The additive keepalive remains safe for older v1 clients, and probes carry no session metadata or capability. API responses and navigation remain outside service-worker caches; a cold installed-PWA launch while fully offline is intentionally unavailable, while an already loaded shell fails closed without stale metadata.

---

## ADR-017 — Deliver actionable attention through metadata-only Web Push

**Status:** Accepted

**Context:** Foreground SSE notifications cannot reach an installed PWA after its page closes. The
phone user needs an actionable alert that reaches the exact live session with one tap, without
placing a collaboration capability or prompt content in a notification, URL, or persistent browser
state. A native Android/FCM wrapper would retain the same server-side delivery work while adding an
APK, signing, Digital Asset Links, distribution, and native lifecycle surface.

**Decision:** Use standard Web Push from the loopback gateway to each browser-provided push endpoint.
Persist one per-install VAPID key pair and at most eight authenticated browser subscriptions in a
user-only state file; this state is separate from the in-memory session registry and never contains
session metadata or collaboration capabilities. Send only strict `attention`/`resolved` envelopes
containing protocol version, `instanceId`, and generation, encrypted by Web Push, with a short TTL,
high urgency, and a per-generation coalescing topic. Visible notifications use a fixed title and no
body. After explicit opt-in, the notification tap is the explicit Control action: open a
metadata-only attention route, synchronously scrub it to `/`, authenticate through the normal
Tailscale path, validate exact generation plus current `inputRequired`/Control availability, and
then use the existing no-store in-memory launch flow. Stale taps fail closed to the directory.

**Consequences:** Closed-page delivery works without public gateway ingress or a custom cloud broker,
but the browser push service observes endpoint and delivery timing and remains an availability
dependency; payload content is encrypted. Browser force-stop, notification settings, power policy,
offline devices, or a sleeping desktop may delay or prevent delivery. Push state now has a narrowly
scoped private persistence exception, while collaboration capabilities and the session registry
remain memory-only. Physical Android background, lock-screen, tap, force-stop, and network-change
qualification is release-blocking. A native FCM wrapper remains a fallback only if this path fails
that qualification.

---

## ADR-018 — Activate PWA upgrades automatically without interrupting live collaboration

**Status:** Accepted

**Context:** An installed Android PWA can keep an already-loaded JavaScript document and leave a newly installed service worker waiting, so a gateway upgrade previously required a manual Refresh or reopen. Reloading while `/client/` is active would destroy the collaboration capability that intentionally exists only in JavaScript memory.

**Decision:** Build every shell with content-hashed assets and a content-derived cache name. The new service worker caches its complete shell, calls `skipWaiting`, removes prior shell caches during activation, and claims clients. If activation observes a prior shell cache, it navigates only an exact same-origin `/` directory client to the no-store `/update/` bootstrap; the newly loaded app synchronously scrubs that route to `/`. Reserve `/client/` synchronously when a View or Control launch begins, and never auto-navigate `/client/`, `/attention/`, query-bearing, or cross-origin clients. An update-aware page also observes controller replacement and performs a bounded fallback reload only when no capability launch or collaboration client is active. A deferred update applies after a failed launch returns to the directory or when the user naturally leaves collaboration.

**Consequences:** Idle installed PWAs adopt a new build without manual action, including the transition from older clients that do not understand the update protocol. Active collaboration remains uninterrupted and adopts the update on its ordinary return to Sessions. The update route carries no metadata or capability, is synchronously removed from history, is never cached, and adds one authenticated shell navigation per upgrade. A browser that cannot install or activate service workers retains ordinary network-navigation behavior but cannot provide zero-touch in-place upgrades.

---

## ADR-019 — Complete the couch-flow attention contract with bounded presentation metadata

**Status:** Accepted

**Context:** The approved couch-flow handoff requires request-specific triage, per-device notification detail, notification-to-Control routing, and stale-list recovery. ADR-017 deliberately limited attention to one boolean and a bodyless notification, so the partial implementation could not distinguish consecutive requests in one generation, preserve an exact opened request through the shell, or offer the explicitly approved notification detail choices.

**Decision:** Keep the OMP publisher protocol compatible and capability-free. On each accepted `inputRequired: false → true` transition, the gateway creates an opaque, random, in-memory request identifier and receipt timestamp; repeated `true` updates retain them, and clear, removal, or generation replacement destroys them. Browser metadata exposes this bounded attention identity as `ask.requestId` and `ask.since`; an optional server-truncated plain-text preview and option count may be added only when a future publisher contract explicitly supplies them. Until then every surface uses the specified boolean fallback. Push subscriptions persist only endpoint/key material, authenticated identity, and the chosen `private`, `session`, or `preview` detail level. Encrypted push payloads are assembled at send time: `private` is bodyless, `session` may contain bounded session/project labels, and `preview` may add the bounded preview but falls back to `session`. The settings UI warns that non-private text may persist in notification history, screenshots, and wearables.

Push messages use a per-instance notification tag, carry only bounded presentation metadata plus opaque routing identifiers and pending count, and never carry a capability. A tap opens `/collab/:instanceId?request=:requestId`; every request-specific Control POST carries that opaque identity, and the gateway atomically revalidates it with the generation at final capability lookup before releasing Control. Directory transport failures retain the last authenticated metadata in volatile page memory with an explicit stale timestamp; authorization failure still clears it. History state contains only route-safe ordering and scroll data, never session records or capabilities.

**Consequences:** Session labels and optional previews can leave the desktop in encrypted Web Push and become visible/persistent on the selected phone surfaces, but only at the user's per-device detail level. Opaque request IDs and timestamps may appear in list/SSE, push, routes, and history; they are routing metadata, not authorization. Collaboration capabilities remain confined to live process/gateway/client memory. ADR-017's bodyless, generation-tagged envelope and `/attention/` route are superseded; its explicit permission, private push-state, capability isolation, and stale-tap fail-closed requirements remain.
