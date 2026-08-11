# CLI guidance

Read [system architecture](../../docs/architecture.md), [CLI](../../docs/architecture/cli.md), and [API contracts](../../docs/architecture/api-contracts.md) before changing this subtree.

- Keep the CLI a thin client of generated public RPCs; business rules stay in the core.
- Do not import Better Auth or `nama.plugin.v1` types.
- Preserve non-interactive operation, stable JSON and exit codes, and safe credential handling.
