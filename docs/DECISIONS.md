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

**Decision:** Emit a metadata-free named `keepalive` SSE event every 15 seconds. The loaded dashboard resets a 35-second liveness deadline on every directory event or keepalive. Missing that deadline clears all displayed session metadata and marks the transport unavailable. The next event after a silent partition triggers a fresh authenticated snapshot and a new SSE epoch before cards return.

**Consequences:** Silent partitions now have a bounded stale-display window of 35 seconds. The additive event is ignored safely by older v1 clients and carries no session data or capability. API responses and navigation remain outside service-worker caches; a cold installed-PWA launch while fully offline is intentionally unavailable, while an already loaded shell fails closed without stale metadata.
