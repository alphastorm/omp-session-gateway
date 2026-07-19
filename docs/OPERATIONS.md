# Installation and operations

## 1. One-time prerequisites

- an OMP build containing the supported collaboration automation/publisher integration;
- Tailscale installed and signed into the same tailnet on the desktop and Android phone;
- tailnet HTTPS/DNS enabled as required by Tailscale Serve;
- a tailnet policy restricting the gateway host's HTTPS service to the intended user/device posture;
- an Android browser supported by the release compatibility matrix.

The system is zero-effort per OMP session, not zero-effort to install. Initial Tailscale login, gateway installation, and OMP configuration happen once.

For v1 header-based authorization, the Android source must be a user-authenticated Tailscale device. Tagged source devices do not receive the user identity header used by the default auth mode.

## 2. CLI and daemon installation

Provide an idempotent command:

```text
omp-gateway install
```

It should:

1. install the exact signed/released `omp-gateway` and `omp-gatewayd` binaries plus static assets into a user-scoped location;
2. create the config/state/runtime directories with current-user-only permissions;
3. create the publisher token atomically;
4. install an autostart definition for the current OS;
5. start or restart the daemon;
6. run local health, listener, ACL, and permission checks;
7. print the Tailscale Serve and policy steps without exposing secrets;
8. show the PWA URL after Serve is configured.

Platform targets:

- Linux: systemd user service named `omp-session-gateway.service`, with an explicit support policy for non-systemd systems;
- macOS: LaunchAgent under the current user;
- Windows: current-user scheduled task or equivalently scoped user service, plus a current-user named pipe ACL.

Also provide:

```text
omp-gateway status
omp-gateway doctor
omp-gateway doctor --bundle
omp-gateway rotate-publisher-token
omp-gateway uninstall
```

Uninstall must not edit OMP settings or Tailscale policy without explicit confirmation. It should offer commands to remove the Serve mapping and local runtime state separately.

## 3. Paths

Recommended defaults:

### Linux/XDG

- config: `${XDG_CONFIG_HOME:-$HOME/.config}/omp-session-gateway/config.jsonc`;
- token: `${XDG_CONFIG_HOME:-$HOME/.config}/omp-session-gateway/publisher-token`;
- runtime: `$XDG_RUNTIME_DIR/omp-session-gateway/`;
- state/logs: `${XDG_STATE_HOME:-$HOME/.local/state}/omp-session-gateway/`.

### macOS

Use `~/Library/Application Support/OMP Session Gateway/` for config/state and a current-user temporary runtime directory for the socket. Use unified logging or a bounded user log with secret-safe fields.

### Windows

Use `%LOCALAPPDATA%\OMP Session Gateway\` for config/state and a current-user named pipe.

Capabilities are never stored in any of these paths.

## 4. Gateway configuration

Example `config.jsonc`:

```jsonc
{
  "listen": "127.0.0.1:4317",
  "auth": {
    "mode": "tailscale-serve",
    "allowedLogins": ["you@example.com"]
  },
  "registry": {
    "heartbeatSeconds": 10,
    "ttlSeconds": 35,
    "metadataPathMode": "basename"
  },
  "controlProtection": "tailnet",
  "relayAllowlist": ["wss://my.omp.sh"]
}
```

Validate strictly and fail closed. Reject wildcard listen addresses in production, wildcard identities, unsupported relay schemes, unsafe paths, unknown fields, and heartbeat/TTL combinations that make stale control likely.

`controlProtection` may later support `webauthn`; it must not silently downgrade to `tailnet` after enrollment.

## 5. Tailscale Serve

After `omp-gatewayd` is healthy on loopback, configure a persistent private HTTPS proxy. A representative current command is:

```bash
tailscale serve --bg http://127.0.0.1:4317
```

The installer must inspect the installed Tailscale CLI help/version, run or print the compatible command, and show `tailscale serve status`. It must never execute `tailscale funnel` or enable public exposure.

The gateway remains loopback-only after Serve is configured. `doctor` must fail if it detects a non-loopback listener or an active Funnel mapping for this service.

Tailscale Serve removes spoofed incoming identity headers before adding trusted tailnet identity headers. The backend must still require the exact expected header and application allowlist.

## 6. Tailnet access policy

Use a dedicated destination tag for the desktop gateway where appropriate and an exact user/group source. See `examples/tailscale-policy.hujson`.

The template is not universally drop-in. The administrator must merge it into existing policy, confirm the tag owner, and test both:

- successful access from the intended Android identity;
- denial from an unauthorized identity or device posture.

Application allowlisting remains required even when grants are narrow. Device sharing can introduce external identities; they are denied unless explicitly allowed.

## 7. OMP configuration

See `examples/omp-settings.jsonc`:

```jsonc
{
  "collab": {
    "autoStart": "control",
    "registryEndpoint": "auto"
  }
}
```

The upstream-safe default remains `off`. A conservative deployment can choose `view` and retain manual full-control collaboration for occasional use.

If the implementation lands as an extension rather than core settings, provide equivalent extension configuration without changing the security or lifecycle semantics.

## 8. Android/PWA installation

1. Join the Android device to the allowed tailnet identity.
2. Open the Tailscale Serve HTTPS URL in a supported browser.
3. Verify the authenticated identity shown by the PWA.
4. Install **OMP Sessions** to the home screen.
5. Test View and Control against a disposable OMP session.
6. Verify browser reload returns to the directory and does not reconnect from stored capability state.

Do not ask the user to bookmark or copy an individual OMP collaboration link.

## 9. Updates

- pin the collab-web integration to an exact OMP commit and record it in `UPSTREAM.lock.json` and the compatibility matrix;
- run parser/client compatibility fixtures before updating OMP;
- support explicit protocol versions and a safe rolling-upgrade overlap where practical;
- gateway restart begins empty and publishers reconnect;
- rotate the publisher token after suspected local exposure or ownership/permission failure;
- verify release checksums and provenance before replacing binaries;
- provide rollback instructions for gateway and OMP patch/extension versions.

## 10. Lost phone and revocation

Document a direct checklist:

1. remove or expire the Android device in Tailscale;
2. revoke relevant identity-provider sessions when appropriate;
3. narrow or temporarily disable the tailnet grant;
4. restart `omp-gatewayd` to drop active browser sessions if necessary;
5. stop/restart OMP collaboration hosts to rotate room capabilities;
6. rotate the publisher token only when local desktop exposure is suspected—it does not revoke a remote collaboration room by itself.

When WebAuthn Control protection is enabled, remove the lost credential and enroll a replacement.

## 11. `doctor` and diagnostics bundle

`omp-gateway doctor` checks:

- daemon and autostart state;
- loopback-only listener;
- IPC endpoint/token ownership and permissions;
- Tailscale connectivity and Serve mapping;
- absence of Funnel exposure;
- trusted identity header flow through Serve;
- allowed-login match;
- PWA, manifest, CSP, and service-worker availability;
- relay DNS/TLS connectivity without creating or logging a real capability;
- publisher count and heartbeat health without exposing capabilities;
- config validation and OMP compatibility.

`doctor --bundle` creates a deterministic redacted archive with a manifest of included fields. It excludes capabilities, tokens, authorization/identity headers, transcripts, prompts, tool output, full paths, browser storage, raw logs, tailnet DNS names, and account identities by default.

Never ask a user to paste a collaboration link into an issue.

## 12. Self-hosted relay mode

Treat as a separate advanced installation:

- deploy a pinned compatible OMP relay;
- use private DNS/TLS and explicit relay allowlisting;
- configure OMP and the browser client consistently;
- run multi-hour WebSocket, Android sleep/resume, network switch, and reconnect tests;
- document metadata, backup, upgrade, and availability responsibilities;
- never silently fall back to the public relay.
