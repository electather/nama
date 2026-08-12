# Nama agent guidance

Before changing this repository, read [system architecture](docs/architecture.md) and [API contracts](docs/architecture/api-contracts.md), then the relevant subsystem record in `docs/architecture/`. Their decisions are requirements; change one only when the task explicitly requires it and record the reason in the affected architecture note.

- Keep `nama.api.v1` public and `nama.plugin.v1` private. Remote provider resource IDs, errors, SDK types, and reusable credentials must not cross the public boundary or appear in logs.
- Protobuf schemas and generator configuration are the source of truth. Never edit generated files directly; change their source and run the root generation task.
- Implement only the behavior required by the current milestone. Compile-only boundaries prove compilation, not runtime behavior.
