# Repository bootstrap

This directory can be initialized and published as a new repository named `omp-session-gateway`.

## 1. Local initialization

```bash
git init -b main
git add .
git commit -m "docs: bootstrap OMP Session Gateway implementation handoff"
```

The packaged handoff may already include a local Git history or a `.bundle`; inspect it before re-initializing.

## 2. Create the remote

Using GitHub CLI after choosing the owner:

```bash
gh repo create <owner>/omp-session-gateway \
  --public \
  --description "Secure, zero-touch mobile access to every running Oh My Pi session" \
  --source . \
  --remote origin \
  --push
```

Do not enable GitHub Pages for the daemon/dashboard without an explicit design review; the intended dashboard is served privately from the user's computer.

## 3. Repository settings

Before inviting users:

- enable private vulnerability reporting;
- enable dependency alerts and automated security updates;
- enable secret scanning and push protection where available;
- protect `main` with required pull requests and CI;
- disallow force pushes and branch deletion;
- require signed commits/tags if the maintainer can support them consistently;
- enable Discussions only if maintainers intend to moderate them;
- disable unused wiki/projects features or configure them intentionally.

## 4. Suggested labels

```text
area: gateway
area: web
area: protocol
area: omp-integration
area: packaging
area: docs
security
compatibility
bug
enhancement
good first issue
help wanted
blocked: upstream
release blocker
```

## 5. Suggested milestones

1. `M0 — contracts and security harness`
2. `M1 — local synthetic prototype`
3. `M2 — safe collab launch`
4. `M3 — OMP integration`
5. `M4 — installable alpha`
6. `M5 — v1 hardening`

Use `docs/ISSUE_PLAN.md` to create the initial issue set.

## 6. Security channel

The issue template and root `SECURITY.md` point to the repository's private GitHub Security Advisory channel. Confirm that advisories and maintainer notifications remain enabled before publishing an alpha.

## 7. Package/release namespaces

Do not reserve or publish npm packages until the package structure is stable. The workspace currently uses private names under `@omp-session-gateway/*`; the repository owner may choose an organization scope later.

The primary user-facing release can be platform binaries and an installer rather than an npm package.

## 8. Branch strategy

Use a protected `main` branch and short-lived topic branches. Keep the OMP patch in one of these forms:

- a separate fork/branch with PR links recorded under `patches/oh-my-pi/`;
- generated `.patch` files produced from a pinned commit; or
- a small compatibility package if OMP exposes a stable API.

Do not vendor a full mutable OMP fork into this repository.

## 9. First public announcement

The announcement should clearly state:

- pre-alpha or alpha status;
- exact supported OMP version/commit;
- private tailnet-only deployment model;
- no affiliation with OMP maintainers;
- threat model and known limitations; and
- where to report vulnerabilities privately.
