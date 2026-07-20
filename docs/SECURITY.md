# Security design and threat model

## 1. Security objective

OMP Session Gateway safely brokers existing OMP collaboration bearer capabilities from local OMP processes to one authorized mobile user without persisting or broadly exposing those capabilities.

The project reduces manual secret handling; it does not make an OMP collaboration capability less powerful. A full-control link can read and steer a session, and a view-only link can read sensitive transcript/tool activity.

## 2. Assets

Highest-value assets:

- full-control collaboration capabilities;
- view-only collaboration capabilities;
- transcript/tool/subagent data reachable through those capabilities;
- session metadata such as project names, models, and activity timing;
- the local publisher token;
- tailnet and WebAuthn identity material;
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
The private publisher token and IPC permissions still prevent a different local account from
registering sessions or satisfying managed-install readiness, but they do not authenticate browser
API requests.

Tailscale Serve user identity headers are populated for user-owned source devices, not tagged source devices. V1 therefore supports a user-authenticated Android phone for header-based identity. A tagged phone requires a separately designed app-capabilities or equivalent authentication mode; do not silently weaken authentication.

## 5. Relay exposure

OMP encrypts collaboration frames client-side. The relay can observe room identifiers, connection/routing metadata, participant counts, timing, and ciphertext sizes, but should not receive plaintext payloads or room keys.

The existing relay is acceptable for v1 when this metadata/availability dependency is understood. Self-hosting can reduce third-party exposure but introduces TLS, WebSocket, update, and availability responsibilities. Treat it as an explicit advanced mode and run long-lived connection tests through the exact deployment path.

## 6. Capability handling

Mandatory rules:

- keep capabilities only in OMP process memory, gateway memory, and the active browser client memory;
- use structurally separate metadata and secret-bearing types/maps;
- never give capability-bearing objects generic serializers, inspectors, debug printers, or telemetry hooks;
- delete references promptly on stop, generation change, TTL expiry, launch disposal, and shutdown;
- never pre-render, prefetch, preload, or include capabilities in HTML, SSE, manifests, or hydration data;
- release exactly one requested role through a no-store POST after an explicit user action;
- prefer in-memory client bootstrap; do not use a URL path, query, fragment, window name, DOM attribute, clipboard, cookie, Local Storage, IndexedDB, Cache Storage, service-worker message, BroadcastChannel, notification, or crash/error SDK;
- suppress access/body tracing for launch endpoints;
- disable third-party runtime scripts, analytics, telemetry, remote fonts, and source-map upload services;
- use generated canary capabilities for tests, never real user links.

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
- service worker caches only queryless, content-hashed static shell files and explicitly bypasses `/api/`, `/internal/`, `/client/` bootstrap, navigation, query-bearing URLs, and all non-GET requests;
- clear session metadata and disable launch actions whenever the directory transport fails; repopulate only from a current authenticated snapshot/SSE epoch and ignore lower revisions within that epoch;
- no capability in Redux/React Query persistence, devtools globals, error boundaries, replay tools, or performance marks;
- external links use `rel="noopener noreferrer"`;
- production builds disable framework devtools hooks where practical;
- reload returns to the metadata directory.

If relay origins are configurable, generate `connect-src` only from administrator-controlled validated origins.

## 8. Tailnet authorization

In `auth.mode = "tailscale-serve"`:

1. require `Tailscale-User-Login`;
2. decode/normalize only according to documented header encoding rules;
3. compare against an exact configured allowlist;
4. reject wildcard defaults;
5. treat external users who accepted a device share as ordinary identities requiring explicit allowlisting;
6. optionally display the current identity without persisting it;
7. log only a process-salted hash or allow/deny category at normal verbosity;
8. maintain a separate `dev-localhost` mode that starts only with an explicit flag and accepts loopback clients only.

Tailnet grants and application allowlisting are both required defense layers. Future device-specific policy may use posture or Tailscale app capabilities, but must have tests and must not fall back to “any tailnet member.”

## 9. Local IPC

- current-user-only socket/pipe permissions;
- random token with at least 256 bits of entropy;
- strict first-frame authentication and constant-time comparison;
- one instance ID per connection;
- message, connection, and rate limits;
- bounded queues and backpressure;
- reject unsafe owners, modes, ACLs, symlinks, and endpoint replacement;
- atomic token creation and rotation;
- no capability-bearing data in parse errors;
- capability parsing only after authentication;
- publisher reconnect cannot resurrect an older generation.

The token prevents accidents and cross-user access; it is not protection from same-user malware.

Service installation and `doctor` do not trust a generic loopback health response. The daemon
returns an HMAC over a fresh 256-bit challenge using the private publisher token; managed startup
also binds the HMAC to a one-time instance nonce written into the new service definition. The CLI
requires that exact nonce before activating the staged runtime, so an older same-token process
cannot satisfy replacement readiness. Runtime manifests record the readiness protocol so rollback
to a verified pre-nonce runtime can use a service-manager-checked legacy proof. The challenge,
nonce, and proof disclose no publisher token. Token rotation validates the managed runtime first
and never restores the prior token after replacement; a failed restart retains the fresh token and
stops the service.

On POSIX, the publisher also verifies that the registry endpoint is a socket owned by the current
user and that both the socket and its immediate parent are private before reading capabilities.
The Windows pre-alpha path still lacks client-side proof of the named-pipe server identity and a
completed namespace-squatting test. A private server DACL and publisher token do not by themselves
authenticate a server that pre-creates the expected pipe name. Do not advertise Windows support
until that boundary is implemented and qualified.

## 10. Lost phone and user presence

Minimum guidance:

- use Android device lock/biometrics;
- require strong identity-provider authentication for Tailscale;
- remove or expire a lost device promptly;
- keep tailnet grants narrow;
- persist no session capability in the PWA.

Optional stronger Control protection:

- enroll a WebAuthn credential with user verification;
- require a fresh assertion for each Control launch or a very short verified window;
- bind challenge, operation, origin, instance, generation, and mode server-side;
- store only public credential material;
- never treat a successful View action as authorization for Control.

## 11. Logging, diagnostics, and test artifacts

Allowed at normal verbosity:

- event name;
- protocol version;
- generic success/failure category;
- opaque or process-salted instance hash;
- generation;
- bounded counts and durations;
- generic IPC/relay/Serve health.

Forbidden:

- capabilities or substrings;
- request/response bodies for launch endpoints;
- authorization or identity headers;
- publisher token;
- transcript, prompt, tool, or subagent content;
- full filesystem paths by default;
- browser network traces containing secret responses;
- screenshots while a canary capability is visible;
- unredacted tailnet names and identities in public bundles.

Test infrastructure must fail when a known canary appears in logs, files, Playwright traces, HARs, screenshots, video, browser history, DOM snapshots, caches, storage, service-worker state, or diagnostics archives.

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
- stopped, expired, and replaced generations cannot launch;
- view-only mutation attempts are rejected by the OMP host;
- cross-origin launch and WebAuthn requests fail;
- malformed and oversized IPC/API input stays bounded;
- gateway restart starts empty and only live authenticated publishers repopulate it;
- release binaries bind loopback only and match published checksums.
