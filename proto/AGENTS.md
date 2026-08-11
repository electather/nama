# Protobuf guidance

Read [API contracts](../docs/architecture/api-contracts.md) and [repository tooling](../docs/architecture/repository-and-tooling.md) before changing this subtree.

- Protobuf owns service and message definitions; document every schema change in `docs/architecture/api-contracts.md`.
- Preserve the `nama.api.v1` public boundary and separate `nama.plugin.v1` private boundary.
- Regenerate through the root repository task and never hand-edit generated output.
- Do not test generated bindings. Test only handwritten Nama policy, validation, or adapter behavior.
