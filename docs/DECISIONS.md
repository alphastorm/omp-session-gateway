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


---

## ADR-020 — Measure network paths adaptively and acknowledge remote actions

**Status:** Accepted

**Context:** Browser online/type signals do not prove the gateway or encrypted relay path, fixed
five-second polling wastes healthy radio time, deterministic retry bursts synchronize clients, and
WebSocket-open state does not prove the host is still reachable. The shell also removed an Ask as
soon as its response was written to the socket, so a drop before host settlement looked successful.
The installed PWA and existing top/bottom shell already provide the required lifecycle surfaces;
a native wrapper, Workbox runtime cache, or persisted Background Sync queue would add complexity and
could retain capability-bearing action data.

**Decision:** Keep the PWA and its exact no-secret service worker. Treat browser lifecycle and
Network Information events only as triggers. Measure the same-origin gateway with smoothed RTT and
variance, bounded adaptive timeouts, a 15-second healthy cadence, a two-second suspect cadence, two
result hysteresis, and capped full-jitter outage retries. Count authenticated host frames as passive
relay liveness between explicit probes; after ten idle seconds, hosts that advertise the optional
encrypted extension answer sequence-numbered ping frames. Hidden pages cancel idle and pending
relay probes; foreground and network signals request a gateway probe and, only after required
gateway hysteresis reaches healthy, an immediate relay probe. A stale pong or unrelated inbound
frame does not satisfy the current bidirectional probe.
One missed reply degrades the path and triggers an immediate second probe; two
misses replace the socket. Every WebSocket handshake has a ten-second deadline, and subsequent
reconnects use capped full jitter.

Healthy chrome is only an accessible green dot. A disruption first shows `Reconnecting…`; after
three seconds the existing top/bottom shell identifies `Gateway unavailable` or `Relay unavailable`
and shows a meaningful retry countdown. Recovery shows `Connected` for 1.8 seconds. Submitted UI
responses remain visible, disabled, and marked `Sending…` in embedded and standalone modes until
the host sends `ui-request-end`; directory metadata cannot announce `Answered` first. The client
preserves and resends one pending response after a fresh welcome. A writable duplicate or late
response receives a targeted end frame even when the host already settled it, making the
acknowledgement idempotent without changing the v3 wire protocol. Adaptive recovery stops when the
client becomes terminal so the final action, status, and keyboard focus remain stable.

**Consequences:** Healthy operation has no persistent status text and fewer active probes. Gateway,
relay, and terminal Mac/session failures are distinguishable on existing surfaces without trusting
browser hints. Active actions cannot be mistaken for acknowledged actions, and an acknowledgement
lost during reconnect converges without a second user action when OMP includes patch commit 5.
Older hosts remain usable for ordinary live collaboration: their frames provide passive liveness
and they never advertise idle probes. They do not provide the duplicate-response acknowledgement
needed to guarantee pending-action convergence across reconnect. The extension adds only encrypted
timing traffic and no session data, capability, storage, URL, native surface, Workbox dependency,
or Background Sync queue. ADR-016's fixed collaboration-client probe cadence and reconnect
mechanics are superseded by this decision; its SSE heartbeat contract remains.

---

## ADR-021 — Treat the registry rendezvous path as failure-prone and make readiness prove it

**Status:** Accepted

**Context:** A production daemon ran continuously for a week yet published no sessions. It had not
crashed: macOS reaps entries under the per-user `TMPDIR` after roughly three idle days, and it had
deleted `omp-session-gateway-<uid>/registry.sock` together with its parent directory. Bun kept the
listening socket alive on the now-unlinked inode, so `lsof` still showed the bound path while
`stat` returned `ENOENT`. Publishers resolve that path by name, so every OMP `upsert` attempt failed
with `ENOENT`. ADR-required behavior — a missing gateway never breaks OMP — then converted a total
outage into silence: bounded retry, no UI noise, and nothing in the daemon log. `GET /api/v1/health`
returned `{"status":"ready"}` throughout because it only proved that the HTTP listener answered, so
`omp-gateway status`, `doctor`, and the install readiness probe all agreed the daemon was healthy.
The runtime directory cannot simply move: OMP's publisher independently computes the same darwin
`TMPDIR` path, so changing one side alone breaks the rendezvous until a patched OMP ships.

**Decision:** Treat the filesystem rendezvous point as failure-prone rather than assuming the OS
preserves it. The IPC server records the device and inode it bound, and `verifyEndpoint()`
re-`lstat`s that path on a bounded 15-second cadence. A missing path means our own rendezvous point
vanished, so the daemon stops the orphaned listener, recreates the `0700` runtime directory, re-binds,
re-applies `0600`, and re-asserts private permissions. A path that exists but resolves to a different
inode means another process owns it; the daemon reports an unhealthy endpoint and never clobbers it,
because two daemons fighting over one socket is worse than one daemon reporting degraded. Readiness
becomes state-faithful: `/api/v1/health` returns `degraded` whenever the endpoint is unreachable,
keeping the HMAC challenge shape unchanged and still exposing no paths, counts, or publisher detail.
`gatewayReady` already requires `status === "ready"`, so an unreachable endpoint now fails readiness
instead of passing it.

Moving the darwin runtime directory out of the reapable `TMPDIR` to
`~/.local/state/omp-session-gateway/run/` remains the preferred way to remove the trigger, but it is
a rendezvous-contract change that must ship in lockstep with a regenerated OMP publisher patch. It is
deferred to that coordinated release; the watchdog is not a reason to skip it.

**Consequences:** A reaped socket now self-heals within one watchdog interval instead of causing a
silent multi-day outage, and the same control covers any other cause of socket loss. Detection costs
one `lstat` per interval. Sessions published before a reap survive the re-bind because live publisher
connections are not closed. The `degraded` status is a new observable value for health consumers, so
monitoring that only checked HTTP reachability now distinguishes a serving daemon from a usable one.
Until the lockstep path migration lands, the reap still happens; the daemon merely repairs it.

---

## ADR-022 — Refresh the OMP pin to v17.3.8 and keep npm `marked` in the vendored client

**Status:** Accepted

**Context:** The repository pinned `v17.0.6` / `89d6a8f6d14286f32f09ec9c8aa8af7b3451d2d6` from
2026-07-21, but the maintained downstream integration and the author's activated runtime had moved
to `v17.3.8` / `858f7dd91fff9b84cf8a2c6a6bb85aa0e6d03a55`. The shipped mbox no longer applied
there: `interactive-mode.ts`, `agent-session.ts`, `session-manager.ts`, and `builtin-registry.ts`
all conflicted. Separately, upstream `collab-web` replaced its npm `marked` dependency with
`@oh-my-pi/pi-utils/marked`, which drags `@oh-my-pi/pi-natives` and its per-platform binaries into
the bundled runtime dependency closure.

**Decision:** Refresh the pin to `v17.3.8`. Take the maintained series verbatim from the reviewed
handoff artifact `gateway-collaboration-v17.3.8.mbox` (sha256 `f63f74c9…`, four commits in
authoritative order `0006 → 0002 → 0003 → 0004`) and append a fifth commit. Take upstream's `collab-web` source wholesale
except for one line: keep `import { Marked } from "marked"`. Restore the health-probe and
response-acknowledgement commit, which the maintained series had dropped.

**Consequences:** The gateway ships a pure-JavaScript runtime closure instead of multi-platform
native addons for a markdown renderer, at the cost of a twelfth documented local patch that must be
re-applied on every refresh. The `Marked` API is identical across both import sources, so the
divergence is one import line. Because only source-level evidence was regenerated, every native,
Tailscale, relay, Android, browser, and signed-artifact row reverts to **NOT RUN** for this pin;
the previous pin's platform evidence does not transfer. Had the dropped health-probe commit not
been restored, the client's relay probes would have gone permanently inert rather than failing
loudly, because `#relayProbeSupported` only becomes true when the host sends a seed pong.

---

## ADR-023 — Move the unreleased OMP target to v17.4.1 without widening alpha support

**Status:** Accepted

**Context:** OMP released `v17.4.1` at
`9350b7990d26ebf69a604edc82d8558ef04adf30`. The maintained downstream
`gateway-collaboration` series already uses that exact base. Relative to the alpha's v17.3.8 pin,
upstream changed neither collab-web source nor wire-protocol source; collab-web only changed package
authorship metadata, while coding-agent integration points changed enough that the new
slash-command fixture needed to model `resumePublication()`. The published alphas remain qualified
only for v17.3.8.

**Decision:** Target v17.4.1 on the default branch for the next candidate. Regenerate the shipped
six-commit mbox from the maintained v17.4.1 commits `0006 → 0002 → 0003 → 0004 → 0007`, restoring
the separately carried health-probe commit before `0007`. Update `@oh-my-pi/pi-wire`, upstream
locks, licenses, notices, release metadata, doctor expectations, and hosted patch-application lanes
to the same immutable commit. Keep npm `marked` and the existing in-memory client integration;
there is no upstream client-source change to re-vendor.

**Consequences:** Source application and test results can establish that the patch is correctly
rebased, but v17.3.8 platform evidence does not transfer. Until a signed candidate repeats the
applicable host, relay, and physical-client lanes, v17.4.1 is an unreleased development target and
must not be advertised as supported. The published alpha matrix remains immutable.

**Qualification update (2026-08-21):** Signed candidate `v0.1.0-prealpha.20` repeated the
applicable Debian, macOS, physical-Pixel, patched-OMP, and relay lanes at this exact pin. The
condition above is therefore satisfied for the bounded beta matrix only; alpha support remains
immutable at v17.3.8 and no loose OMP compatibility range is inferred.

---

## ADR-024 — Use the exact OMP patch as the beta prerequisite and defer paired packaging

**Status:** Accepted

**Context:** Stock OMP v17.4.1 still does not provide the automatic collaboration controller and
authenticated registry publication required by the product. Removing the patch would restore
manual `/collab` commands and link transfer, eliminate zero-touch discovery, and drop the
generation-ordered revoke/publish guarantees. A persistent Windows source lane proved the patch can
produce and run a working binary, but building, signing, installing, updating, rolling back, and
qualifying paired OMP artifacts is a separate distribution project.

**Decision:** Accept the exact, tested v17.4.1 patch in `patches/oh-my-pi` as the supported beta
prerequisite. Upstreaming discussion #6460 and a paired OMP package are not beta gates. The route
must remain command-complete and versioned: exact checkout and tree assertions, upstream-supported
source build, a separate `omp-gateway-patched` activation path, explicit config verification, and
symlink-based rollback. Do not imply stock-OMP compatibility. Windows remains unadvertised for
independent signed-platform reasons, not because paired packaging is absent.

**Consequences:** Beta can ship without waiting on an upstream maintainer or expanding into a
second installer. Installation is more manual than the final product goal, and every participating
OMP process must be launched from the verified patched binary. A future upstream seam or paired
installer can replace this prerequisite, but neither blocks the bounded beta support matrix.

**Qualification update (2026-08-21):** The exact route now passes on both advertised architectures.
macOS candidate qualification and Debian [run `32537603211`](https://github.com/alphastorm/omp-session-gateway/actions/runs/32537603211)
each reproduced the source/tree, used the matching official native addon, built the binary,
auto-published View/Control, validated no-store launches, and revoked on process close. Isolated
exact alpha/beta builds also passed symlink/version/config reversal. This proves the documented
manual primitive; it does not create a coupled gateway/OMP updater or weaken the paired-packaging
deferral.

## ADR-025 — Publish stable 0.1 against a narrow matrix and bound browser-process failure

**Status:** Accepted

**Context:** GitHub excludes every prerelease from its Latest release surface. The qualified beta
already proves the gateway's core security, host, lifecycle, View/Control, and physical-Android
paths for two exact hosts and one exact client, but the release workflow intentionally rejects a
bare tag. Issue #65 separately proves a failure below the PWA: Android retained a healthy default
route while Chrome failed both the gateway and unrelated public traffic, stopped answering on its
DevTools socket, and recovered only after its process was force-stopped. A newly landed Chromium
NetworkChangeNotifier self-heal is relevant but not yet proven to resolve that failure.

**Decision:** Add one fail-closed stable channel selected only by the exact bare v0.1.0 tag. The
stable claim remains limited to the Debian, macOS, physical Pixel, TUN-mode Tailscale Serve, and
exact patched-OMP combinations recorded at the tag's source commit. Every pre-alpha, alpha, beta,
provenance, unknown, and cross-version tag stays a prerelease or fails before artifact creation.
Publish the bare tag as GitHub Latest only after a signed candidate repeats the applicable matrix.

Treat #65 as a documented browser-process environment limitation, not as a passing PWA reconnect
case and not as a reason to add another transport workaround. After 45 seconds of repeated failure
while visibly foregrounded, the PWA must offer a clean retry and same-origin force-stop/reopen
guidance; it must remove that guidance immediately after recovery and must make no third-party
connectivity probe. The physical-device driver must allow package, activity, and DevTools-socket
selection independently and record the exact Android package and browser revision. Canary evidence
may narrow or retire the limitation later; v0.1.0 does not claim the upstream fix is proven.

ADR-024's exact patched-OMP prerequisite and paired-packaging deferral extend to this narrow 0.1
release. Windows, background Push qualification, Portal Tunnel, userspace-networking Tailscale,
and self-hosted/proxied relays remain outside the stable core support claim.

**Consequences:** stable means supported inside one exact, evidence-backed matrix; it does not
mean universal platform support or that page JavaScript can repair a failed browser process. The
project can publish an honest GitHub Latest release without waiting for a speculative Chromium
backport, while every correction still requires a new immutable tag. Operators retain a manual
patched-OMP prerequisite until upstreaming or paired packaging is separately accepted.