# Canonical data model

[ADR-0010](../adr/0010-postgresql-drizzle-persistence-boundary.md)
establishes the shared PostgreSQL and Drizzle persistence boundary. Persistence
stores Nama-owned users, server and plugin configuration, canonical media
records, provider-to-canonical identifier mappings, Library entries, playback
progress, watched state, Device pairing, and per-source synchronization replicas
and checkpoints.

Canonical media records and their provider-to-canonical mappings are Nama-owned;
provider payloads may be retained only as bounded diagnostic metadata, never as
the model clients depend on
([ADR-0022](../adr/0022-canonical-provider-neutral-media-model.md)).
Synchronization replicas and checkpoints are evidence for reconciling
Nama-owned watch state, not canonical state themselves
([ADR-0023](../adr/0023-canonical-watch-state-reconciliation.md)).
Device credential verification and temporary Pairing delivery use separate
protected records under
[ADR-0031](../adr/0031-separate-device-verification-from-pairing-delivery.md).

## Target Pairing and Device persistence

Pairing persistence has four independently retained record families:

- Pairing requests retain the Nama pairing identity, display name, keyed human
  code and polling-token digests, expiry and next-poll times, approval state,
  optional Device link, and only the temporary encrypted credential delivery;
- Devices retain their public identity, display name, creation and approximate
  last-seen times, and durable revocation state;
- Device credentials retain one versioned, domain-separated keyed digest per
  active Device; and
- Pairing approval results retain the Administrator, method, operation ID,
  authenticated request fingerprint, safe Device response, and 24-hour expiry
  independently of the Pairing request.

Approval creates the Device, credential verifier, encrypted delivery, Pairing
state, and operation result atomically. The delivery envelope uses a fresh
96-bit AES-256-GCM nonce and authenticated data binding its version, Pairing,
Device, and credential version. It becomes inaccessible at Pairing expiry and
is cleared by bounded startup and once-per-minute cleanup. Revocation retains
the Device but removes its verifier and any undelivered credential. Expired
Pairing identity and digest evidence remains for 24 hours so a matching poller
can observe `EXPIRED`; cleanup never cascades into an active Device.

## Target canonical catalog persistence

The stored catalog is a typed relational projection, not a serialized plugin
message or provider payload. Its record graph covers canonical items, Library
entries, hierarchy, credits, artwork, sources, parts, tracks, exact
provider-item mappings, nested provider-reference mappings, external-identifier
evidence, and one catalog-scan state per provider instance. Bounded ordered
scalar collections such as genres and studios may use PostgreSQL arrays.

Milestone 4 performs exact mapping only. A previously unseen provider-instance
and item-reference pair creates one canonical item; later observations of that
pair replace its complete projection atomically. No external-ID, title, fuzzy,
cross-instance, or cross-provider merge occurs before Milestone 7. Mapping rows
retain normalized external IDs as later reconciliation evidence without
retaining a second full observation replica.

Nama-owned IDs remain stable while the same private item, source, part, track,
or artwork reference exists. A refreshed item may remove a nested resource from
the active public projection while retaining an inactive reference mapping, so
the same reference reuses its Nama ID if it returns. Provider-instance deletion
removes that instance's mappings permanently.

Each accepted catalog item commits as one complete aggregate and publishes
incrementally; a full scan is not staged as a false provider snapshot. Seasons
and episodes with unresolved private parent references remain outside the
Library until the required canonical hierarchy exists. A best-effort Milestone
4 scan adds or refreshes observed mappings but never infers deletion from
omission. Explicit removal of a final source removes the Library entry while
retaining the internal canonical item and its Nama-owned state.

The scan-state row retains the captured provider revision, core run ID, status,
last accepted continuation, safe failure reason, timestamps, and next retry
time. Page acceptance and continuation advancement share one transaction and
apply only while that provider revision remains current and enabled. Restart
resumes a valid continuation or begins again; disable pauses scanning without
removing stored media, and re-enable starts a fresh pass.

## Provider management persistence

The implemented provider persistence boundary has five core-owned record families:

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
