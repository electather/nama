# Canonical data model

[ADR-0010](../adr/0010-postgresql-drizzle-persistence-boundary.md)
establishes the shared PostgreSQL and Drizzle persistence boundary. Persistence
stores Nama-owned users, server and plugin configuration, canonical media
records, provider-to-canonical identifier mappings, library membership,
playback progress, watched state, device pairing, and per-source synchronization
replicas and checkpoints.

Canonical media records and their provider-to-canonical mappings are Nama-owned;
provider payloads may be retained only as bounded diagnostic metadata, never as
the model clients depend on
([ADR-0022](../adr/0022-canonical-provider-neutral-media-model.md)).
Synchronization replicas and checkpoints are evidence for reconciling
Nama-owned watch state, not canonical state themselves
([ADR-0023](../adr/0023-canonical-watch-state-reconciliation.md)).

Database constraints protect identity, uniqueness, and referential integrity.
Secrets are encrypted or hashed according to whether the core must recover them
and retain their write-only classification
([ADR-0020](../adr/0020-monotonic-provider-secret-classification.md)).

The initial schema supports the one Jellyfin vertical slice and adds columns or
tables only when a shipped feature needs them.
