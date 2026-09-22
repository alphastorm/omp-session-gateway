# Security design and threat model

## 1. Security objective

OMP Session Gateway safely brokers existing OMP collaboration bearer capabilities from local OMP processes to one authorized mobile user without persisting or broadly exposing those capabilities.

The project reduces manual secret handling; it does not make an OMP collaboration capability less powerful. A full-control link can read and steer a session, and a view-only link can read sensitive transcript/tool activity.

Stock OMP `>= 18.1.20` supplies the native collaboration controller and local registry. No fork,
custom OMP build, or gateway-specific OMP plugin is required. The separately installed gateway
reads metadata and brokers one capability per authorized launch; native integration does not
remove the TUN-mode Tailscale Serve, allowlist, or user-controlled-workstation requirements below.

## 2. Assets

Highest-value assets:

- full-control collaboration capabilities;
- view-only collaboration capabilities;
- transcript/tool/subagent data reachable through those capabilities;
- session metadata such as project names, models, activity timing, and whether human input is required;
- per-host OMP query tokens and the gateway-only readiness token;
- tailnet and WebAuthn identity material;
- private VAPID key material and browser push subscription endpoints/keys;
- release-signing and update infrastructure.

## 3. Threat model

### In scope

- public-Internet scanning and accidental public exposure;
- other devices/users on the LAN;
- unauthorized users or devices in the tailnet;
- cross-site requests and malicious web origins;
- accidental secret persistence in logs, traces, metrics, caches, history, browser storage, screenshots, crash reports, source-map services, or diagnostics;
- stale capability use after an OMP process exits, crashes, stops collaboration, or changes session;
- a lost or temporarily unlocked phone that remains authorized in the tailnet;
- malicious or malformed IPC/API input and resource exhaustion;
- dependency, build, installer, and update compromise;
- a relay operator observing permitted metadata and ciphertext.

### Out of scope or inherited compromise

- code already executing as the same desktop OS user;
- a compromised OMP process, desktop kernel, browser engine, Android OS, identity provider, or Tailscale control plane;
- a user intentionally sharing a collaboration link;
- OMP model/provider behavior and tool authorization on the host;
- forensic recovery from process memory or swap after full local compromise.

Document these limits plainly. Do not market the project as protection against same-user malware.

## 4. Network exposure

Required default:

- `omp-gatewayd` binds only to loopback;
- Tailscale Serve provides tailnet HTTPS and strips spoofed incoming identity headers before adding trusted ones;
- tailnet grants restrict HTTPS access to the intended user/device posture;
- the application independently allowlists exact login names;
- missing identity fails closed;
- Tailscale Funnel and public reverse tunnels are not configured;
- plain LAN HTTP is unsupported.

Keep the backend on localhost because another remotely reachable path would let callers inject
`Tailscale-User-*` headers themselves. Direct loopback requests cannot be distinguished
cryptographically from Serve-originated requests, so every untrusted process or OS account able
to run on the desktop host is outside the v1 HTTP trust boundary. V1 is for a user-controlled
workstation without mutually untrusted local accounts; do not deploy it on a shared shell host.
OMP’s private discovery files and endpoints restrict per-host queries to their OS-user boundary.
The gateway-only readiness token proves managed-install readiness; neither credential authenticates
browser API requests.

Concretely, and stated as an operator rule because the reasoning above is easy to read as advisory:
**never point any other forwarder at the gateway's loopback port.** A tunnel, reverse proxy, port
forward, container publish, or SSH `-L` that terminates remote traffic and relays it to
`127.0.0.1:<port>` presents a loopback peer, which satisfies the first authorization check in
`apps/gateway/src/auth.ts`, and then forwards whatever `Tailscale-User-Login` the remote caller
chose. That is not a weakened boundary but a complete authentication bypass: any client reaching the
forwarder can name an allowlisted login and receive the session directory and live view and control
capabilities. Tailscale Serve is safe here only because it overwrites caller-supplied identity
headers; nothing else in this design does. A future non-Serve path therefore requires its own
authenticator plus unconditional stripping of `Tailscale-User-*`, not merely a transport swap. See
[#74](https://github.com/alphastorm/omp-session-gateway/issues/74) and
[#158](https://github.com/alphastorm/omp-session-gateway/issues/158) for worked examples of
proposals that fail on exactly this point.

**The listener now refuses requests that carry evidence of a second HTTP hop,** so the most likely
version of that mistake fails closed instead of silently granting control. An HTTP proxy leaves
marks that Serve never produces, and a remote caller cannot instruct the proxy in front of it to
stop inserting them. Measured against Serve's own proxy (`ipn/ipnlocal/serve.go`,
`addProxyForwardedHeaders` and `addTailscaleIdentityHeaders`), a Serve-originated request carries
`X-Forwarded-For` set to exactly one address — the tailnet source — and `X-Forwarded-Host` set to
the host Serve answered on, and Serve deletes every inbound `Tailscale-*` header before setting its
own. `authorizeHttpRequest` therefore refuses, before reading the identity header, when
`X-Forwarded-For` names more than one hop or a non-Tailscale address, when `X-Forwarded-Host`
disagrees with the configured public origin, when `Forwarded`, `X-Real-IP`, `CF-Connecting-IP`,
`CF-Ray`, or `X-Forwarded-Server` is present, or when the request is marked as Funnel.

**This is defence in depth and explicitly not authentication.** It catches Cloudflare Tunnel,
ngrok, and ordinary reverse proxies, which all insert at least one of those headers. It does not
catch a raw TCP forwarder — `socat`, `ssh -L`, a bare tunnel — which inserts nothing and remains
indistinguishable from Serve, and it does not make the operator rule above optional. Only an
authenticator the gateway can verify itself closes that gap. The mode dispatch in
`authorizeHttpRequest` is exhaustive for the same reason: a future auth mode denies until it is
given an explicit arm, rather than inheriting Tailscale header trust by omission.

**Tailscale's own userspace-networking mode is such a forwarder, and this is the trap most likely to
catch a real operator.** `tailscaled --tun=userspace-networking` has no TUN device, so its netstack
accepts inbound tailnet connections and dials `localhost` to service them. The gateway then sees a
genuine loopback peer for traffic that originated on another machine, and trusts the caller's
`Tailscale-User-Login` verbatim. Serve is not in that path and cannot overwrite anything.

This was demonstrated on 2026-08-21 against a qualification host running `v0.1.0-prealpha.17` with
its listener correctly bound to `127.0.0.1:4317` only. From a *different* tailnet node,
`http://<node-tailnet-ip>:4317/api/v1/sessions` returned `403` with no header and **`200` with a
forged `Tailscale-User-Login` naming an allowlisted account**. The same probes against a host running
the normal TUN-mode client are refused outright on both its tailnet and LAN addresses.

Userspace mode is not exotic: it is the usual way to run Tailscale in a container, on many VPS
images, and on headless servers, which are exactly the hosts an operator is most likely to automate.
Run the TUN-mode client on any host serving this gateway. Tracked as
[#98](https://github.com/alphastorm/omp-session-gateway/issues/98).

**The gateway now refuses rather than warns.** Because Tailscale gives the backend no secret,
signature, or channel binding that Serve alone could present, there is nothing to verify per
request; the only thing checkable is whether the topology still makes Serve the sole path in. In
`tailscale-serve` mode the daemon therefore reads the host's interface table and, unless an interface
looks like Tailscale's *tunnel device*, returns `403` to every request instead of believing
`Tailscale-User-Login`. It logs `http.identity_trust_unsound` once when it observes that state, and
`doctor` reports `loopbackTrustSound: false`. Refusing costs nothing when the signal is absent:
without a tailnet interface, Serve cannot be routing tailnet requests to that process anyway.

**`100.64.0.0/10` does not vouch for itself.** That range is not Tailscale's: RFC 6598 assigns it as
shared address space, and carriers, mobile hotspots and container networks allocate out of it
routinely, so a host holding a CGNAT lease would otherwise pass this check while running userspace
mode — a container with a CGNAT pod CIDR being the obvious case, and containers being exactly where
userspace networking is used. Accepted instead are an address in `fd7a:115c:a1e0::/48`, which is
Tailscale's own allocation and decisive on its own, or a `100.64.0.0/10` **host route** on a
tunnel-named interface (`tailscale0`, `utun<n>`, `Tailscale`). An IPv6-disabled host whose device is
renamed through `--tun` fails closed and visibly, which is the safe direction for that error.

An admitted `/api/v1/events` stream is re-authorized on each keepalive, so a feed cannot outlive the
topology that justified it.

The signal has to be read in that direction. Probing our own tailnet address cannot tell the two
topologies apart, because in userspace mode the host has no route to that address either, so the
probe fails identically on a safe host and an exposed one. Detecting *whether tailscaled is running*
is no better: its socket path is platform-specific and can be overridden on the command line, so a
detection miss would silently re-open the bypass. Absence of a tailnet interface is therefore treated
as unsafe rather than inconclusive.

One escape exists for automated harnesses, `auth.trustIdentityWithoutTailnetDevice`. It declares that
no tailnet can reach the host at all, which is true of a CI runner with no Tailscale installed and is
how the capacity job exercises the production identity path. It asserts a fact rather than
establishing one: setting it on a host running userspace-mode `tailscaled` restores the full bypass.
`doctor` reports `loopbackTrustSound` from the interface table and not from the configuration, so a
host that sets the flag while running userspace mode still fails that check. Never set it on a host
that has Tailscale installed.

A host that sets the flag also **cannot roll back** to an earlier gateway without editing its
configuration, because the older parser rejects unknown `auth` keys and refuses to start.

**If a pre-fix build ever ran on a userspace-mode host, treat what it accepted as compromised.**
Refusing new requests does not retract what the exposed window granted. Push subscriptions are the
persistent case: delivery re-checks the stored identity against the current allowlist on every send,
so removing a login stops delivery, but a subscription registered under a *forged allowlisted* login
is indistinguishable from a legitimate one. Delete `push-state.json` from the state directory and
re-enable notifications from the phone. Collaboration capabilities need no such step because they are
never persisted and die with their generation.

A second tailnet node remains the only *end-to-end* proof, because the refusal above is a local
inference about the topology rather than an observation of what a remote peer can reach; the
qualification lanes probe the gateway port from a distinct node for that reason.

Tailscale Serve user identity headers are populated for user-owned source devices, not tagged source devices. V1 therefore supports a user-authenticated Android phone for header-based identity. A tagged phone requires a separately designed app-capabilities or equivalent authentication mode; do not silently weaken authentication.

Background notifications add outbound HTTPS from the gateway to browser-provided push endpoints.
No inbound public gateway route is required. Web Push encrypts the payload for the browser
subscription, while the push service still observes the endpoint, source IP, size, and delivery
timing. Treat subscription endpoints and keys as sensitive private state even though they cannot
grant collaboration access.

## 5. Relay exposure

OMP encrypts collaboration frames client-side. The relay can observe room identifiers, connection/routing metadata, participant counts, timing, and ciphertext sizes, but should not receive plaintext payloads or room keys.

The existing relay is acceptable for v1 when this metadata/availability dependency is understood. Self-hosting can reduce third-party exposure but introduces TLS, WebSocket, update, and availability responsibilities. Treat it as an explicit advanced mode and run long-lived connection tests through the exact deployment path.

Phone photos are prompt content, not gateway metadata. A writable client accepts only JPEG, PNG,
or WebP source files up to 24 MiB, rejects source dimensions above an 8,192px edge or 20 megapixels,
canvas-re-encodes at most four as JPEG with a 2,048px edge and 1 MiB per-image cap, and thereby
removes filenames, EXIF, and location metadata before transport.
Only the normalized bytes enter the existing encrypted `prompt.images` frame. They never traverse
gateway HTTP/IPC, the service worker, URLs, history, logs, diagnostics, analytics, or browser
storage. Preview data URLs and base64 references are dropped on remove, host-confirmed send, and
client disposal; an unconfirmed send retains the draft for retry. JavaScript memory is not claimed
to be zeroized. After send, the normalized image
is ordinary OMP prompt content and may persist in the host transcript and at the selected model
provider under those systems' normal retention policies. The original phone file is not uploaded.

The Photo action uses two hidden file inputs behind explicit user choices. **Take photo** adds the
browser `capture="environment"` hint; **Choose existing** omits `capture`. Native file-input
capture launches the operating-system camera UI and does not grant script-level camera access, so
the gateway keeps `Permissions-Policy: camera=()` and never invokes `getUserMedia`.

## 6. Capability handling

Mandatory rules:

- keep capabilities only in OMP process memory, transient gateway query/launch-response memory, and
  active browser client memory; the gateway never stores or caches them;
- keep the memory-only registry metadata-only, structurally separate from secret-bearing responses;
- never give capability-bearing objects generic serializers, inspectors, debug printers, or telemetry hooks;
- minimize query/response references and drop browser references on launch disposal;
- revalidate generation, access, and attention identity before releasing a queried capability;
- never pre-render, prefetch, preload, or include capabilities in HTML, SSE, manifests, or hydration data;
- release exactly one requested role through a no-store POST after an explicit user action;
- prefer in-memory client bootstrap; do not use a URL path, query, fragment, window name, DOM attribute, clipboard, cookie, Local Storage, IndexedDB, Cache Storage, service-worker message, BroadcastChannel, notification, or crash/error SDK;
- suppress access/body tracing for launch endpoints;
- disable third-party runtime scripts, analytics, telemetry, remote fonts, and source-map upload services;
- use generated canary capabilities for tests, never real user links.

`inputRequired` remains the only attention field accepted from the OMP snapshot. The gateway may
derive an opaque random request ID and receipt timestamp in memory for each false-to-true
transition, expose them in list/SSE and routing URLs, and destroy them on clear, removal, expiry, or
generation replacement. They are metadata, not authorization. Prompt text, options, answers, and
transcript content remain prohibited unless a later OMP snapshot contract explicitly introduces a
bounded plain-text preview contract; the current implementation always uses the boolean fallback.

The PWA may persist two bounded, non-secret local routing record types: an exact held ask
`(instanceId, requestId, heldAt)`, and a generation-scoped dismissed session
`(instanceId, generation, dismissedAt)`. It must reject malformed, oversized, non-canonical, or
excess records and must never add session labels, paths, models, prompt content, transcript content,
or capabilities. Holding does not change authoritative attention or badge counts. Dismissal is only
a reversible local hide of a non-attention row: it makes no network request and does not stop OMP.
Authoritative ask changes clear holds; removal, generation replacement, or attention clears
dismissals. Transport failures clear neither. A held ask may close only a notification with the
matching instance tag and request ID.

After an explicit permission/subscription action, the gateway may persist a user-only VAPID key
pair, bounded browser subscription set, authenticated identity, and per-device `private`,
`session`, or `preview` choice. It assembles encrypted push presentation at send time. `private`
uses the fixed title and no body; `session` may add bounded session/project labels; `preview` may
also add a bounded preview but falls back to `session` until such data is available. The UI must
warn that visible notification text can persist in notification history, screenshots, and
wearables. A tap routes through `/collab/:instanceId?request=:requestId`, fetches a current
authenticated snapshot, requires the exact current attention identity and Control availability,
and then uses the existing generation-bound no-store launch POST.
Never put a collaboration capability in a payload, notification data, route, history,
service-worker message, persisted push state, badge, or request identifier.

JavaScript strings cannot be reliably zeroized. Minimize lifetime, copies, closures, global state, and persistence instead of claiming memory erasure.

## 7. Browser controls

Representative response policy; adapt CSP hashes/nonces to the build and configured relay allowlist:

```http
Content-Security-Policy: default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self' wss://my.omp.sh; manifest-src 'self'; worker-src 'self'
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Resource-Policy: same-origin
Referrer-Policy: no-referrer
X-Content-Type-Options: nosniff
Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), bluetooth=()
```

Additional requirements:

- exact Origin validation on POST and WebAuthn enrollment/assertion endpoints;
- validate `Sec-Fetch-Site` when supplied;
- no wildcard CORS and no credentialed cross-origin API;
- all metadata rendered as text, never unsanitized HTML;
- strip control/bidi characters or display them safely in titles/paths;
- cap label length and session count;
- service worker caches only queryless, content-hashed static shell files (the app shell plus the pinned collaboration-client module and stylesheet — never a capability-bearing response) and explicitly bypasses `/api/`, `/internal/`, `/client/`, `/collab/`, `/update/`, navigation, query-bearing URLs, and all non-GET requests;
- service worker Push handling accepts exact `attention`/`clear` envelopes, uses one per-instance tag, updates only the bounded app badge count, and never fetches or receives a collaboration capability;
- transient directory transport failure retains the last authenticated metadata only in volatile page memory, marks it stale with the last-fresh timestamp, and disables no actions solely because SSE disconnected; authorization failure clears it;
- no capability in Redux/React Query persistence, devtools globals, error boundaries, replay tools, performance marks, history state, or directory snapshots;
- external links use `rel="noopener noreferrer"`;
- production builds disable framework devtools hooks where practical;
- reload returns to the metadata directory.
- an activated shell update may navigate only an exact same-origin idle `/` client to the no-store `/update/` bootstrap; the new document synchronously scrubs it to `/`, while launch-pending, request-routed, and active `/client/` pages are never auto-navigated;

**Unresolved implementation gap:** the last bullet is the accepted ADR-018 requirement, not a
fully implemented guarantee. The worker excludes non-root URLs, but `launch()` changes the root
URL to `/client/` only after its asynchronous asset/capability work. Its in-page pending flag
protects the page's fallback reload, not worker-initiated navigation. Activation may therefore
interrupt a pending directory launch. The pre-launch reservation requirement remains in force.

If relay origins are configurable, generate `connect-src` only from administrator-controlled validated origins.

## 8. Tailnet authorization

In `auth.mode = "tailscale-serve"`:

1. require `Tailscale-User-Login`;
2. decode/normalize only according to documented header encoding rules;
3. compare against an exact configured allowlist;
4. reject wildcard defaults;
5. treat external users who accepted a device share as ordinary identities requiring explicit allowlisting;
6. optionally display the current identity without persisting it;
7. log only numeric or boolean fields, never identity strings or hashes;
8. maintain a separate `dev-localhost` mode that starts only with an explicit flag and accepts loopback clients only.

Tailnet grants and application allowlisting are both required defense layers. Future device-specific policy may use posture or Tailscale app capabilities, but must have tests and must not fall back to “any tailnet member.”

## 9. Local discovery and queries

Stock mainline OMP `>= 18.1.20` owns the discovery/query endpoint, introduced by [PR #11908](https://github.com/can1357/oh-my-pi/pull/11908), merge `4999b98bd5`, ships in [OMP v18.1.20](https://github.com/can1357/oh-my-pi/releases/tag/v18.1.20).
The gateway is a reader and query client, not a publisher server. Required boundaries:

- read only private, current-user-owned discovery entries and endpoints; reject symlinks and
  unsafe ownership or permissions;
- use each entry’s endpoint and per-host query token, never a guessed socket path;
- bound newline-framed requests, responses, connection time, and discovery entries;
- never write, rename, or unlink OMP-owned files or sockets;
- fetch metadata with `snapshot`, capabilities only with an explicit generation-bound `link`;
- never log query tokens, raw replies, transport error strings, or capability-bearing parse errors;
- treat only `ENOENT`/`ECONNREFUSED` as conclusive host death; permission, timeout, resource,
  and wire failures retain existing metadata until TTL expiry;
- reject stale generations and unavailable roles rather than substituting a newer or stronger link.

A discovery token is not a collaboration capability, but permits querying that host for links and
therefore remains private. These controls reduce accidental and cross-user access; they are not a
sandbox against same-user malware. The gateway has no capability store, even in memory.

Service installation and `doctor` do not trust a generic loopback health response. The daemon
returns an HMAC over a fresh 256-bit challenge using its private `readiness-token`; managed startup
also binds the HMAC to a one-time instance nonce written into the new service definition. The CLI
requires that exact nonce before activating the staged runtime, so an older same-token process
cannot satisfy replacement readiness. This token belongs only to gateway/CLI readiness and is
never provisioned to OMP. Token rotation validates the managed runtime first and never restores
the prior token after replacement; a failed restart retains the fresh token and stops the service.

Fork-era runtimes used a shared publication/readiness credential. Their recorded readiness and
rollback results are historical, not proof that a mainline cutover can be reversed by changing
only the gateway pointer; follow [UPGRADE_ROLLBACK.md](UPGRADE_ROLLBACK.md).

## 10. Lost phone and user presence

Minimum guidance:

- use Android device lock/biometrics;
- require strong identity-provider authentication for Tailscale;
- remove or expire a lost device promptly;
- keep tailnet grants narrow;
- persist no session capability in the PWA.

Proposed stronger Control protection — ADR-008, not implemented in v0.4.0:

There is no current passkey enrollment or per-launch WebAuthn gate. The following remains a future
contract, not a substitute for device revocation, lock, or tailnet policy:

- enroll a WebAuthn credential with user verification;
- require a fresh assertion for each Control launch or a very short verified window;
- bind challenge, operation, origin, instance, generation, and mode server-side;
- store only public credential material;
- never treat a successful View action as authorization for Control.

## 11. Logging, diagnostics, and test artifacts

Allowed at normal verbosity:

- fixed event names selected by the implementation, not data from a host or request;
- numeric protocol versions, generations, counts, and durations;
- boolean success/failure and health fields.

All gateway log fields are numeric or boolean. Never attach string-valued identifiers, hashes,
paths, error messages, metadata, or serialized query objects.

Forbidden:

- capabilities or substrings;
- request/response bodies for launch endpoints;
- authorization or identity headers;
- per-host query tokens or the readiness token;
- transcript, prompt, tool, or subagent content;
- full filesystem paths by default;
- browser network traces containing secret responses;
- screenshots while a canary capability is visible;
- unredacted tailnet names and identities in public bundles.

Test infrastructure must fail when a known canary appears in logs, files, Playwright traces, HARs, screenshots, video, browser history, DOM snapshots, caches, storage, service-worker state, or diagnostics archives.

### Manual `/collab` is outside this boundary

The rules above bind the gateway. Upstream OMP's manual `/collab` command deliberately prints the
full capability to the terminal, because showing you the link is the entire point of that flow. It
is not a defect there and this project cannot change it.

The consequence is that anything recording an OMP terminal captures a live, unexpired capability:
session transcripts, terminal recorders, CI logs of a PTY, and supervised process managers that
retain stdout. Observed directly on 2026-08-19, when a `/collab` issued inside a supervised scratch
session wrote a control link into that supervisor's log; the session was stopped and the capability
revoked within seconds.

This is the sharpest argument for the gateway's model rather than a gap in it. The gateway never
renders a capability: the session list is metadata-only, a capability is fetched just-in-time after
an explicit action, bound to the session's generation, and returned `no-store` to same-origin
JavaScript that hands it straight to the pinned client. Nothing on that path is printable.

Operationally: treat any recording of a terminal that ran `/collab` as containing a secret, and
prefer gateway-mediated access wherever a session is being recorded or supervised.

## 12. Supply-chain and updates

- minimal reviewed dependencies and committed lockfiles;
- dependency license and maintenance review;
- CI builds from tagged source;
- checksums, SBOM, and provenance for release artifacts;
- signed tags/artifacts where maintainers can support them;
- installer verifies downloaded artifacts before execution;
- no self-update channel in v1 unless it is signed, rollback-safe, and separately threat-modeled;
- preserve upstream OMP attribution for vendored or adapted code.

## 13. Security acceptance gates

Before release, prove:

- public and LAN clients cannot reach the service;
- unauthorized, absent, shared-but-not-allowlisted, and tagged-without-supported-auth identities are denied;
- remote identity-header spoofing cannot bypass the loopback Serve path;
- list/SSE/static HTML contain no capability canary;
- launch responses are no-store and absent from logs/traces/caches;
- browser URL, history, DOM, clipboard, cookies, Local Storage, IndexedDB, Cache Storage, service-worker state, test artifacts, and diagnostics contain no canary after leaving a session;
- collaboration-capability canaries never enter attention metadata, persisted push state, push payloads, notifications, or notification routes;
- persisted push state contains only the private subscription/VAPID/identity/detail contract, never session metadata or content;
- attention and notification surfaces expose only ADR-019's approved bounded metadata: opaque request identity, count, and detail-selected labels; Private has no body, and Preview falls back to Session because current OMP snapshots supply no preview. Prompt/option/answer/transcript content, full paths, and any field outside that contract remain forbidden;
- stopped, expired, and replaced generations cannot launch;
- view-only mutation attempts are rejected by the OMP host;
- cross-origin launches fail; any future WebAuthn endpoints must enforce the same exact-origin boundary;
- malformed and oversized IPC/API input stays bounded;
- gateway restart starts empty and discovery polling repopulates only live hosts;
- release binaries bind loopback only and match published checksums.
