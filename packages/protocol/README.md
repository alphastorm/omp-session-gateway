# `packages/protocol`

Shared TypeScript types, strict runtime validators, and protocol constants for the stock OMP
local discovery/query contract and the gateway browser API. Browser JSON Schemas live in `schemas/`;
[PROTOCOL.md](../../docs/PROTOCOL.md) describes the complete boundary. The gateway is OMP's query
client, not a publisher registry server.

Enforced invariants:

- secret-bearing records are structurally distinct from browser-facing metadata;
- unknown versions, fields, duplicate JSON keys, invalid UTF-8, and bounded-invalid input are rejected;
- capability wrappers cannot be serialized and redact string/inspector conversion;
- OMP discovery entries and snapshot/link replies, browser snapshots/SSE, launch requests/responses, and Push v2 subscription/attention/clear payloads are runtime validated; and
- distinctive synthetic capability fixtures are covered by the repository leak scanner.
