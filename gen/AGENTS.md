# Generated output guidance

Read [repository tooling](../docs/architecture/repository-and-tooling.md) and [API contracts](../docs/architecture/api-contracts.md) before changing this subtree.

- Do not edit generated files directly; change schemas or generator configuration and run the root generation task.
- Keep handwritten source, manifests, and tests out of Buf-owned generated leaves.
- Public bindings serve current consumers; private plugin bindings remain TypeScript-only.
