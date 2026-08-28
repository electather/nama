# Canonical data model

[ADR-0010](../adr/0010-postgresql-drizzle-persistence-boundary.md)
establishes the shared PostgreSQL and Drizzle persistence boundary. Persistence
stores Nama-owned users, server and plugin configuration, canonical media
records, provider-to-canonical identifier mappings, Library entries, playback
progress, watched state, OAuth authorization state, normalized Provider replicas,
and core-owned synchronization checkpoints.

Canonical media records and their provider-to-canonical mappings are Nama-owned;
provider payloads may be retained only as bounded diagnostic metadata, never as
the model clients depend on
([ADR-0022](../adr/0022-canonical-provider-neutral-media-model.md)).
Provider replicas are evidence for reconciling Nama-owned Watch state, not
canonical state themselves
([ADR-0023](../adr/0023-canonical-watch-state-reconciliation.md),
[ADR-0034](../adr/0034-versioned-watch-state-snapshots.md)).
OAuth authorization persistence is Better Auth-owned under
[ADR-0033](../adr/0033-better-auth-oauth-device-authorization.md).

## Target watch-state persistence

[ADR-0034](../adr/0034-versioned-watch-state-snapshots.md) establishes two
relational snapshot families:

- sparse canonical Watch state keyed by authenticated user and playable
  canonical item, with watched status, optional position and duration, the last
  known playback Source, selected activity evidence, a distinct Activity
  origin, database commit time, and a core-owned monotonic version; and
- one normalized Provider replica per authenticated user and exact provider
  item mapping, with the plugin observation fields, opaque provider revision,
  and a separate core-owned monotonic record version.

A first default-unwatched provider observation creates only a Provider replica;
absence of canonical Watch state means that Nama has accepted no state evidence.
A watched-status action preserves position and duration. A winning complete
provider snapshot with absent position clears resumable progress, while an
absent duration or Source preserves the last known value. Exact canonical value
equality changes neither selected activity evidence, commit time, nor version.

The persistence boundary accepts fully resolved canonical targets and atomically
compare-and-commits them with Provider replica replacements against expected
versions. A stale expectation returns the current snapshots for policy-level
recomputation. Provider-instance deletion removes its replicas and clears live
Source identity and exact Provider-replica origin identity while preserving
decoupled canonical values, copied activity evidence, and a detached
Provider-replica Activity origin.
Scheduler checkpoints, pending exports, bounded fingerprints,
retry state, and reconciliation policy remain separate work owned by their
runtime features.

## Target OAuth authorization persistence

The pinned Better Auth JWT, OAuth Provider, and OAuth Device Authorization
schemas own the authorization-server records. Nama generates and reviews their
Drizzle migration but does not reproduce their models behind a generic
repository or parallel credential store.

The target record families are:

- Better Auth device-code records for RFC 8628 request, user-code, approval,
  polling, expiry, client, scope, and resource state;
- one migration-seeded native public OAuth client for the first-party Apple
  application, protected through Better Auth's cached-trusted-client policy;
- Better Auth refresh-token families for `offline_access`, using the plugin's
  supported storage, rotation, replay, expiry, and revocation behavior; and
- Better Auth JWT signing keys exposed through its JWKS endpoint.

JWT access tokens are self-contained and are not stored. The OAuth device grant
does not create an `oauthConsent` row, so consent records are not the authority
for Apple authorization or revocation. The narrow Administrator revoke-all
operation acts on Better Auth's refresh-token families for the fixed client and
does not introduce a Nama Device, grant, verifier, delivery, last-seen, or
approval-result table.

Better Auth owns expiry and bounded cleanup for its records. Nama adds no
human-code or polling-token digest, master-key domain, encrypted credential
delivery, logical-operation replay record, custom authorization capacity row,
or startup/minute cleanup loop.

## Canonical Watch state persistence

The canonical Watch state boundary stores no row until a resolved movie or
episode target is accepted. Each row is owned by one authenticated principal and
one playable canonical item and contains watched status, optional position and
duration, a nullable last-Source identity, copied activity time, semantics,
reliability, an Activity origin, database transaction time, and a core-owned
positive version. An Activity origin distinguishes Nama playback, a Nama
watched-status action, an exact Provider replica identified by its provider
instance and provider item reference, or a detached Provider-replica Activity
origin retained after that exact identity ceases to exist. The detached variant
identifies no Provider replica and is not an identity tombstone.

Callers resolve precedence before this boundary. A compare-and-commit creates a
row only for an absent expected version or updates it only when the supplied
version matches durable state. A stale expectation returns the current
snapshot. Exact equality of watched status, position, duration, and
last-Source identity returns the existing row without replacing its selected
activity evidence, database time, or version.

The nullable last-Source identity is part of the caller's fully resolved target.
Caller recomputation keeps the current identity when later activity supplies no
exact Source evidence and may explicitly resolve no identity when policy
requires clearing it; persistence does not interpret an omitted identity.
Persistence validates any supplied Source against the same canonical item's
retained provider-source mapping. Removing the Source from the active catalog
projection keeps that mapping and an already stored identity available, and
restoring the same mapping reuses the Nama Source ID.

Exact Provider replica persistence atomically compares the independent replica
and canonical versions before replacing evidence and optionally committing that
target. Reconciliation, export, and public `UserStateService` behavior remain
separate work.

## Canonical catalog persistence

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
Credit portraits remain owned by the canonical media aggregate while their
private artwork mapping separately retains the provider person or other target
item reference required for later resolution.

Each accepted catalog item commits as one complete aggregate and publishes
incrementally; a full scan is not staged as a false provider snapshot. Seasons
and episodes with unresolved private parent references remain outside the
Library until the required canonical hierarchy exists. A best-effort Milestone
4 scan adds or refreshes observed mappings but never infers deletion from
omission. Explicit removal of a final source removes the Library entry while
retaining the internal canonical item and its Nama-owned state.

The scan-state row retains the captured provider revision, core run ID, status,
last accepted continuation, consecutive failure count, safe failure reason,
timestamps, and next retry time. Page acceptance and continuation advancement
share one transaction and apply only while that provider revision remains
current and enabled. Restart
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
