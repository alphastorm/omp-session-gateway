# `packages/protocol`

Shared TypeScript types, strict runtime validators, and protocol constants corresponding to `schemas/`.

Enforced invariants:

- secret-bearing records are structurally distinct from browser-facing metadata;
- unknown versions, fields, duplicate JSON keys, invalid UTF-8, and bounded-invalid input are rejected;
- capability wrappers cannot be serialized and redact string/inspector conversion;
- publisher, browser snapshot, SSE event, launch request, and launch response payloads are runtime validated; and
- distinctive synthetic capability fixtures are covered by the repository leak scanner.
