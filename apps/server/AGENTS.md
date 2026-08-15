# Server guidance

Read [core server](../../docs/architecture/core-server.md) before changing this subtree.

- The core owns identity, authorization, configuration, and durable state; Better Auth stays private behind Nama RPCs.
- Test Effect services with `@effect/vitest`; use ordinary Vitest for pure functions.
- Changes to formatting, linting, pre-commit, or Fallow configuration require explicit user permission; when possible, satisfy existing rules by restructuring code.
