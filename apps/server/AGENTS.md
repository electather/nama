# Server guidance

Read [system architecture](../../docs/architecture.md), [core server](../../docs/architecture/core-server.md), and [API contracts](../../docs/architecture/api-contracts.md) before changing this subtree.

- The core owns identity, authorization, configuration, and durable state; Better Auth stays private behind Nama RPCs.
- Keep `api.v1` and `plugin.v1` separate, and keep provider-private data out of public responses.
- Implement only behavior required by the current milestone; compile probes do not prove runtime behavior.
