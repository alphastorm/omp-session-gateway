# Contributing

Thank you for helping build OMP Session Gateway.

## Start here

Read `README.md`, `AGENTS.md`, `docs/DECISIONS.md`, and `docs/SECURITY.md` before changing behavior. Security properties are part of the product contract, not optional hardening work.

## Development workflow

1. Open or select a focused issue from `docs/ISSUE_PLAN.md`.
2. Create a branch from `main`.
3. Keep the change small enough to review and test.
4. Add tests for behavior, failure modes, and secret non-persistence.
5. Run the repository checks.
6. Open a pull request using the template and explain architecture/security impact.

Suggested branch names:

```text
feat/registry-ipc
fix/stale-generation-launch
docs/tailscale-deployment
```

Suggested commit subjects use conventional prefixes:

```text
feat(protocol): validate generation-aware upserts
test(security): detect capabilities in browser storage
fix(web): reject stale launch generations
```

## Security-sensitive contributions

Never use real OMP collaboration links in code, tests, screenshots, recordings, issues, or pull requests. Generate conspicuous synthetic fixtures. Do not add telemetry, third-party browser assets, public listeners, or persistent capability storage.

Changes touching any of the following require threat-model review and negative tests:

- Tailscale identity/authentication;
- loopback binding and proxy trust;
- IPC authentication or permissions;
- capability parsing/delivery;
- browser history/storage/service workers;
- logging, diagnostics, tracing, or crash handling;
- OMP session-generation lifecycle;
- self-hosted relay support.

## Coding standards

The planned stack is strict TypeScript on Bun, with minimal dependencies. Prefer explicit types at trust boundaries, runtime validation for all untrusted input, bounded queues and payloads, and dependency injection for clocks, randomness, storage, and network listeners so security behavior is testable.

Do not introduce a framework solely for convenience when a small maintained dependency or platform primitive is sufficient. Explain significant dependency additions in the pull request.

## Documentation

Update the relevant architecture, protocol, operations, compatibility, and security documents in the same pull request as a behavior change. Add an ADR entry to `docs/DECISIONS.md` when changing a previously accepted decision.

## Licensing

By contributing, you agree that your contribution is licensed under the repository's MIT License. Preserve all upstream notices when adapting OMP or third-party material.

## Community conduct

Be respectful, specific, and evidence-driven. Critique designs and code rather than people. Harassment, threats, discrimination, doxxing, and deliberate disclosure of other users' secrets are not acceptable.
