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

## Provider management persistence

The issue #29 target adds five core-owned record families:

- provider installations retain the accepted provider-type identity, build and
  contract versions, capabilities, restricted configuration schema, profile
  version, and schema revision discovered from a code-owned bundled plugin;
- provider instances retain their installation reference, Nama identity,
  display name, enabled state, synchronization priority, non-secret JSONB
  configuration, keyed provider-principal digest, opaque revision, and resource
  timestamps;
- provider credentials retain one encrypted envelope per instance and
  configuration key;
- provider-instance observations retain the last connection outcome obtained
  with a stored configuration revision, independently of resource revision; and
- provider operation results retain a keyed request fingerprint, safe serialized
  response, and expiry independently of instance lifetime so a delete retry can
  resolve after the instance is gone.

Database transactions and constraints protect ownership, enabled-priority
uniqueness, credential-key uniqueness, the global 100-instance limit, and
referential integrity. Provider create transactions serialize count and
default-priority allocation; updates never renumber neighboring instances.

Recoverable provider secrets use per-key, versioned AES-256-GCM envelopes under
an HKDF-SHA-256 key derived from the configured master key. Fresh 96-bit nonces
and authenticated data bind the envelope version, provider type, provider
instance, and configuration key. Provider-principal equality needs no recovery,
so Nama retains only an instance-bound HMAC digest under a separate derived key
([ADR-0028](../adr/0028-domain-separated-provider-protection.md)). Secret
classification remains monotonic under
[ADR-0020](../adr/0020-monotonic-provider-secret-classification.md).

Startup authenticates stored credential envelopes one at a time before provider
management becomes ready. A damaged envelope makes only its provider instance
unavailable. Master-key loss cannot authorize a replacement principal for an
existing instance; recovery requires a new instance rather than rebinding old
sources or synchronization evidence.

The initial provider schema supports the one Jellyfin connection slice and adds
columns or tables only when a shipped feature owns their lifecycle.
