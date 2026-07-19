# `packages/protocol`

Shared TypeScript types, strict runtime validators, fixtures, and protocol constants corresponding to `schemas/`.

Requirements:

- keep secret-bearing types structurally distinct from browser-facing metadata;
- reject unknown major versions and bounded-invalid input;
- avoid generic `toJSON`, object inspection, or debug printers on capability-bearing values;
- provide redacted fixture factories and distinctive secret-leak fixtures;
- support dependency injection for clock and randomness in tests;
- document compatibility/evolution rules.
