# Primary-source references

Research date: **2026-07-21**.

These links informed the design snapshot. OMP and Tailscale are active projects; the implementation agent must re-open the current primary sources, pin exact versions/commits, and update `UPSTREAM.lock.json` before coding.

## Oh My Pi

- Repository and collaboration overview: https://github.com/can1357/oh-my-pi
- Release baseline observed for this handoff (`v17.0.6`): https://github.com/can1357/oh-my-pi/releases/tag/v17.0.6
- Collaboration protocol, link roles, browser client, settings, and relay architecture: https://github.com/can1357/oh-my-pi/blob/main/docs/collab.md
- Browser collaboration client package: https://github.com/can1357/oh-my-pi/tree/main/packages/collab-web
- Browser client source: https://github.com/can1357/oh-my-pi/tree/main/packages/collab-web/src
- Browser client manifest: https://github.com/can1357/oh-my-pi/blob/main/packages/collab-web/public/manifest.webmanifest
- Existing collaboration host: https://github.com/can1357/oh-my-pi/blob/main/packages/coding-agent/src/collab/host.ts
- Interactive mode context containing collaboration host state: https://github.com/can1357/oh-my-pi/blob/main/packages/coding-agent/src/modes/types.ts
- Extension API documentation: https://github.com/can1357/oh-my-pi/blob/main/docs/extensions.md
- Root package/toolchain: https://github.com/can1357/oh-my-pi/blob/main/package.json

## Tailscale

- Tailscale Serve: https://tailscale.com/docs/features/tailscale-serve
- Serve CLI: https://tailscale.com/kb/1242/tailscale-serve
- Grants: https://tailscale.com/docs/features/access-control/grants
- Grants syntax: https://tailscale.com/docs/reference/syntax/grants
- Funnel, which is intentionally excluded from the default design: https://tailscale.com/docs/features/tailscale-funnel
- WebSocket stability report relevant to optional relay qualification: https://github.com/tailscale/tailscale/issues/18827

## Android and web platform

- Trusted Web Activity overview: https://developer.android.com/develop/ui/views/layout/webapps/trusted-web-activities
- TWA and Digital Asset Links guide: https://developer.android.com/develop/ui/views/layout/webapps/guide-trusted-web-activities-version2
- Android App Links verification: https://developer.android.com/training/app-links/verify-applinks
- Web App Manifest: https://developer.mozilla.org/docs/Web/Manifest
- WebAuthn: https://www.w3.org/TR/webauthn-3/
- MessageChannel: https://developer.mozilla.org/docs/Web/API/MessageChannel

## Notes for the implementer

- Verify that OMP has not added a supported collaboration automation API since this snapshot.
- Use upstream OMP link parsers and collab-web code rather than reproducing the link grammar from memory.
- Inspect the installed Tailscale CLI and current documentation before generating Serve commands or identity-header assumptions.
- Record exact source commits and license notices for every vendored or compiled upstream asset.
