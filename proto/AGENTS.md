# Protobuf guidance

Read [repository tooling](../docs/architecture/repository-and-tooling.md) before changing this subtree.

- Protobuf owns service and message definitions; document every schema change in `docs/architecture/api-contracts.md`.
- Do not test generated bindings. Test only handwritten Nama policy, validation, or adapter behavior.
