# API contracts

Status: Setup and Auth runtime semantics, the private plugin-subprocess transport, production Jellyfin discovery/connection verification, authenticated provider-type listing, and provider-instance create/list/get/update including disable and re-enable are implemented and verified.

The files under `proto/` are the source of truth for service and message definitions, field numbers, validation annotations, and generated APIs; this document remains the source of truth for boundary ownership and semantics.

The core implements Setup and Auth workflows plus `ProviderService.ListProviderTypes`, `CreateProviderInstance`, `ListProviderInstances`, `GetProviderInstance`, and `UpdateProviderInstance`. It also implements private plugin process launch, bearer authentication, health/identity handshake, deadline and cancellation propagation, bounded recovery, cleanup, code-owned bundled discovery, restricted-schema acceptance, durable installation reconciliation, one-shot candidate verification, encrypted provider credentials, immutable principal digests, durable create/update idempotency, revision-fenced update persistence, and supervised runtime cutover against generated `nama.plugin.v1` clients. The remaining public and plugin method workflows are durable contracts, not evidence that their handlers, provider adapters, persistence flows, or scheduling exist.

## Scope

The contract covers:

- initial setup and administrator authentication;
- operator health and diagnostics;
- provider discovery, configuration, connection testing, and instance management;
- device pairing, listing, and revocation;
- provider-neutral home, browse, search, media details, artwork, and technical source details;
- playback planning, opening, telemetry, and cleanup;
- the current principal's watched and resume state;
- operator-visible synchronization status and triggering;
- private plugin discovery, library translation, playback translation, and watch-state import/export; and
- validation, authorization, errors, retries, pagination, compatibility, generation, and verification.

The MVP remains single-administrator and single-user. User administration, invitations, roles, and per-user permissions are intentionally absent. They become additive `UserService` and `InvitationService` contracts only when Milestone 8 designs their actual authorization model. No empty services are reserved for them.

## Boundary invariants

1. `nama.api.v1` is the public contract consumed by the TypeScript core, Go CLI, and future universal Swift app rooted in `apps/ios`.
2. `nama.plugin.v1` is a private subprocess contract consumed only by the TypeScript core and TypeScript plugins.
3. The packages do not import each other and do not share a third Protobuf package. Similar public and plugin messages remain separately declared ([ADR-0004](../adr/0004-independent-public-plugin-protobuf-packages.md)).
4. Public consumer messages never expose provider item IDs, stream indexes, SDK objects, raw provider errors, configuration, or reusable provider credentials.
5. Management RPCs may expose Nama-managed resources for installed provider types and their configuration, such as the neutral type identifier `jellyfin`. Remote provider resource IDs, SDK errors and types, and provider-specific consumer shapes remain private to plugins. Provider types never appear in service or message names.
6. Canonical Nama item IDs and provider-instance IDs are Nama-owned. A canonical item may have sources from more than one provider instance.
7. The core maps plugin observations into stored canonical media before serving consumer reads. Public browse and search never proxy a live provider query.
8. The core is a control plane. Artwork and media bytes travel directly from the provider to the client through short-lived, narrowly scoped locators when the provider can supply them safely.
9. All MVP RPCs are unary. Streaming RPCs, event feeds, REST, and GraphQL are deferred until a concrete consumer requires them.
10. Better Auth and provider wire formats are server implementation details. Only Nama-owned messages cross either public boundary ([ADR-0007](../adr/0007-private-better-auth-adapter.md)).

## Package and file layout

The public contract is split across these files under `proto/nama/api/v1/`:

| File | Ownership |
| --- | --- |
| `common.proto` | Cross-cutting public values such as credentials and HTTP headers |
| `health.proto` | Operator status and diagnostics; extends the existing health anchor |
| `setup.proto` | One-time administrator setup |
| `auth.proto` | Administrator sign-in, current user, and sign-out |
| `device.proto` | Pairing approval and device credential lifecycle |
| `provider.proto` | Provider type schema, testing, and instance management |
| `media.proto` | Canonical summaries, details, artwork, sources, parts, and tracks |
| `library.proto` | Home, browse, search, details, hierarchy, source, and artwork reads |
| `playback.proto` | Capabilities, negotiation, session opening, telemetry, and close |
| `user_state.proto` | Current principal's watched and resume state |
| `sync.proto` | Operator synchronization status and manual trigger |

The private contract is split across these files under `proto/nama/plugin/v1/`:

| File | Ownership |
| --- | --- |
| `common.proto` | Plugin-local references, headers, and connection values |
| `health.proto` | Existing subprocess health anchor |
| `plugin.proto` | Plugin identity, schema, capabilities, and connection inspection |
| `media.proto` | Normalized provider observations and technical media structure |
| `library.proto` | Provider catalog reads and artwork resolution |
| `playback.proto` | Provider playback planning, lease creation, telemetry, and cleanup |
| `watch_state.proto` | Best-effort state scans, targeted reads, and explicit mutations |

The `.proto` files are authoritative for service and message names, field numbers, validation, and generated APIs. The summaries below explain their durable semantics. Existing field numbers must never be renumbered or reused.

## Shared conventions

### Identifiers and presence

- Every ID is an opaque non-empty string. Clients may compare and return IDs but must not parse, sort, or synthesize them.
- An operation ID identifies one logical mutation; an event ID identifies one telemetry event. Both are client-generated opaque strings and are scoped as described under idempotency.
- Provider references exist only in `nama.plugin.v1`. The core stores their mapping to canonical IDs.
- Every RPC uses package-local `<MethodName>Request` and `<MethodName>Response` messages, including when one side is empty. `google.protobuf.Empty` is not mixed into the service style.
- Protobuf `optional` is used only when absent and present-with-zero have different meanings. Required scalar fields use Protovalidate constraints rather than wrapper messages.
- Every enum has an `*_UNSPECIFIED = 0` member. Receivers reject unspecified values when the field is required and tolerate unknown future values without crashing.
- Fields that are unknown or unavailable are absent. Adapters do not guess metadata.

### Time, size, and media units

- Instants use `google.protobuf.Timestamp` in UTC.
- Durations and playback positions use `google.protobuf.Duration`.
- Calendar-only release dates use `google.type.Date`.
- File sizes are `uint64` bytes and belong to a media part, not an item or source.
- Bit rates are `uint64` bits per second.
- Dimensions are unsigned pixel counts. Frame rate is a `double` in frames per second.
- Jellyfin ticks, Plex milliseconds, epoch seconds, and all other provider units are normalized inside the plugin.

### Pagination

List and search requests use `page_size` and `page_token` unless a method explicitly has a bounded, non-pageable result. A `page_size` of zero selects the default of 50; the maximum is 100. Responses return `next_page_token`; an absent or empty token means the scan is complete.

Tokens are opaque, short-lived, and bound to the principal, query, filters, sort, page size, and server-side position that created them. A continuation cannot change those inputs. Invalid, expired, or mismatched tokens fail with `INVALID_ARGUMENT` and reason `PAGE_TOKEN_INVALID`. Totals are not returned because providers and reconciliation cannot supply them consistently.

Nama public page tokens use a versioned canonical JSON payload authenticated
with HMAC-SHA-256 under the `nama/page-tokens/v1` master-key derivation. The
payload binds the authenticated principal, fully qualified method, normalized
query, page size, sort cursor, and a 15-minute expiry. Its canonical JSON bytes
and fixed 32-byte authentication tag form one envelope encoded as one unpadded
base64url token. It contains no secret and is authenticated rather than
persisted or encrypted.

Plugin catalog and watch-state scans use an explicit `begin` versus `continuation` oneof. A continuation contains only the opaque token so callers cannot accidentally change a scan midway.

### Client metadata

Every public RPC carries these Connect request headers through generated-client interceptors:

| Header | Value |
| --- | --- |
| `nama-client-name` | Stable application name, such as `nama-cli` or `nama-ios` |
| `nama-client-platform` | Stable platform name, such as `go`, `ios`, `tvos`, or `macos` |
| `nama-client-version` | Released semantic version |

They are untrusted compatibility claims, not credentials or attestation, and may be logged. Missing metadata is tolerated during local Milestone 0 development, but released clients send all three. A server may use the version for compatibility diagnostics or reject a version with a known correctness failure, using `FAILED_PRECONDITION` and reason `CLIENT_VERSION_UNSUPPORTED`; normal additive evolution does not require lock-step versions. No security property relies on the declared version, because a custom client can lie. Authorization, validation, and safe locator rules remain server-enforced for every version.

Each plugin returns its build version and contract major from `PluginService.GetInfo`. The MVP accepts contract major `1`; capabilities, not provider type or version checks, decide which operations may be called.

### Transport, correlation, and secrets

- Public and plugin RPCs use only Connect over HTTP; Nama does not expose gRPC or gRPC-Web ([ADR-0003](../adr/0003-protobuf-connectrpc-boundary.md)). The plugin transport is a core-owned Unix socket authenticated by one random per-launch bearer.
- Supervising a code-owned descriptor and explicit launch kind validates both without creating a child process, socket, or launch artifact. The first valid call starts or joins one shared launch or recovery episode. That episode delivers one canonical versioned UTF-8 JSON launch document of at most 64 KiB through child stdin, then closes stdin. Discovery carries no provider context; one-shot candidate and exact-revision instance launches may carry one configuration and credential snapshot. Children inherit no environment values, and provider context never enters arguments, RPC bodies, RPC metadata, diagnostics, spans, or logs. Readiness requires socket mode `0600`, authenticated health, expected provider type, and contract major `1`; every provider RPC carries an explicit deadline and cancellation.
- The only ordinary public HTTP endpoints are exact `GET /health/live` and `GET /health/ready`. Better Auth routes and callbacks are not mounted.
- Public administrator and device credentials use `Authorization: Bearer`. Plugin credentials use the same header on the private socket.
- The server, not the client, assigns `nama-request-id` at outer Node dispatch and returns it on every Connect-delegated response, including malformed-body failures. Application-generated errors carry the identical value in `google.rpc.RequestInfo`; Connect may reject malformed input before the application pipeline, where the response header is the sole correlation value.
- Request and response bodies, authorization headers, locator headers, passwords, bootstrap tokens, polling tokens, provider configuration, and opaque plugin session context are never logged.
- Locators are absolute HTTP or HTTPS URLs. Any attached headers are allowlisted by the core and valid only for the referenced artwork or playback session.

`nama.api.v1.HttpHeader` contains `name` and `value`. It is used only inside artwork, media, and external-subtitle locator responses and applies only to the locator URL's origin. Every locator also contains repeated `allowed_redirect_origins`, validated by the core. Each value is a normalized scheme/host/port origin with no credentials, path, query, or fragment. Clients enforce that allowlist and never forward any custom locator header when the origin changes. A client or playback engine that cannot enforce both rules is ineligible for adoption; it does not turn either rule into advisory behavior. Exact-source review rejected tvOS AetherEngine `6.21.0`: it replays unrecognized custom headers across origins, preserves recognized credentials for same-host HTTP-to-HTTPS redirects without comparing ports, and publicly logs complete locator URLs in Release. `nama.api.v1.BearerCredential` contains `token` and `expires_at`. Credential-bearing responses are sensitive in their entirety.

## Public services

The public package is one domain-oriented package for consumer and management services ([ADR-0005](../adr/0005-provider-neutral-public-api.md)). The server's method authorization table is authoritative; each client exposes only the subset appropriate to its interface.

### HealthService

`health.proto` preserves the existing `CheckRequest`, `CheckResponse`, `ServingStatus`, and `HealthService.Check` field numbers. It extends them additively and adds diagnostics:

| RPC | Access | Result |
| --- | --- | --- |
| `Check(CheckRequest) returns (CheckResponse)` | Administrator | Server version, initialization, readiness, and sanitized database state |
| `GetDiagnostics(GetDiagnosticsRequest) returns (GetDiagnosticsResponse)` | Administrator | Bounded component status for core, database, and configured provider instances |

`CheckResponse` contains the existing `status`, then `server_version`, `initialized`, `ready`, and `database_status`. Both status fields use `ServingStatus`.

`DiagnosticComponent` contains `name`, `status`, `summary`, and `checked_at`. `status` uses `ServingStatus`. `name` is globally unique and stable for the component: initial keys are `core`, `database`, and `provider_instance/<opaque-id>`. It is bounded to 274 characters so the 18-character provider-instance prefix can contain a maximum-length 256-character opaque ID. Clients compare a name but do not parse an opaque provider ID from it. `summary` is a short redacted operator message.

`GetDiagnosticsResponse` contains `server_version`, `request_id`, and repeated `components` in deterministic order: core, database, then provider instances by opaque ID. It is complete rather than paginated or truncated. The MVP limit of 100 configured provider instances bounds the response at 102 components. It never contains configuration values, URLs, credentials, raw database messages, provider errors, or stack traces.

The public HTTP liveness endpoint only proves that the process can answer. Readiness probes PostgreSQL with the bounded behavior defined in `core-server.md`. These HTTP responses are not mirrors of the authenticated RPC messages.

### SetupService ([ADR-0008](../adr/0008-fail-closed-setup-reconciliation.md))

| RPC | Access | Request fields | Response fields |
| --- | --- | --- | --- |
| `GetStatus` | Public | none | `initialized` |
| `CreateAdministrator` | Bootstrap token in request | `bootstrap_token`, `display_name`, `email`, `password` | `administrator` |

`Administrator` contains only `id`, `display_name`, and normalized `email`.
Both public password inputs—`CreateAdministratorRequest.password` and `SignInRequest.password`—accept 8 through 128 characters. These bounds were tightened before the first runtime implementation and are the compatibility floor for every client.

`CreateAdministrator` is single-use and not generally idempotent. It does not create or return a session. Better Auth is configured with automatic sign-in disabled. If the response is lost after user creation, the client calls `GetStatus` and then `AuthService.SignIn`; it does not replay setup. The bootstrap token is validated before password hashing and is never returned in an error.

During an active claim, `ABORTED/SETUP_IN_PROGRESS` is returned only for the matching current-process token; every other candidate returns only `UNAUTHENTICATED/AUTHENTICATION_FAILED`. These documented errors are the complete token-observable contract.

Once the Better Auth creation call can commit, cancellation cannot restore setup eligibility. The core masks interruption across the create-and-marker boundary. If the Better Auth commit outcome is ambiguous, the process disables setup in memory, marks itself unready, and exits non-zero so startup repair inspects durable users before serving again. A cancelled client can therefore produce either no user with the same valid token, or exactly one recoverable user with setup closed—never a reopened race for a second administrator.

In the process that detects fatal commit ambiguity, `GetStatus` fails `UNAVAILABLE/SETUP_UNAVAILABLE` and never answers `initialized=false`. Only a restarted process resumes status after reconciliation: a repaired one-user marker reports `initialized=true`, while a zero-user result is a new setup-eligible process state rather than a local ambiguity response.

### AuthService

| RPC | Access | Request fields | Response fields |
| --- | --- | --- | --- |
| `SignIn` | Public, rate-limited | `email`, `password` | `administrator`, `credential` |
| `GetCurrentUser` | Administrator | none | `administrator` |
| `SignOut` | Administrator | none | none |

`SignIn` calls Better Auth's private server API with automatic sign-in disabled and returns the signed token extracted from its `set-auth-token` response header, never a raw session token or cookie ([ADR-0007](../adr/0007-private-better-auth-adapter.md)). Better Auth owns expiry, rotation, and revocation; Nama adds no refresh-token protocol and does not force a different expiry. Authentication failure always uses the same public reason regardless of whether an email exists. A Nama-owned limiter wraps the public SignIn RPC because private server-API calls do not rely on Better Auth's HTTP-route limiter.

Under [ADR-0009](../adr/0009-confirm-durable-session-revocation.md), `SignOut` succeeds only after the durable session store confirms that the presented bearer no longer resolves to an active session. Clearing cookies or client state is not proof of revocation. If deletion fails or its outcome cannot be confirmed, Nama returns `UNAVAILABLE` with reason `SESSION_REVOCATION_UNCONFIRMED`; the caller retains the bearer and resolves the ambiguity with `GetCurrentUser` before retrying. An unauthenticated read proves the credential is no longer usable. PostgreSQL coverage forces session-deletion failure and proves Nama never reports successful sign-out while the bearer remains valid.

### DeviceService

Device pairing separates the short human code from a high-entropy polling secret. Possession of the human code alone can never obtain a device credential.

| RPC | Access | Request fields | Response fields |
| --- | --- | --- | --- |
| `BeginPairing` | Public, rate-limited | `display_name` | `pairing_id`, `user_code`, `polling_token`, `expires_at`, `poll_interval` |
| `GetPairingStatus` | Matching polling token | `pairing_id`, `polling_token` | `status`, optional `device`, optional `credential` |
| `ApprovePairing` | Administrator | `operation_id`, `user_code` | `device` |
| `ListDevices` | Administrator | `page_size`, `page_token` | repeated `devices`, `next_page_token` |
| `RevokeDevice` | Administrator | `device_id` | `device` |

`BeginPairing` is not idempotent because an unauthenticated global key could disclose another request's polling secret. A lost response leaves only an expiring orphan, and the device begins again. `PairingStatus` is `PENDING`, `APPROVED`, or `EXPIRED`. Denial is not an MVP operation; an administrator may leave an unwanted request to expire. `GetPairingStatus` is safely repeatable until expiry. Once approved, repeated polling returns the same logical device and credential rather than minting additional devices.

`Device` contains `id`, `display_name`, `created_at`, optional `last_seen_at`, `revoked`, and optional `revoked_at`. A device bearer authorizes only consumer library, playback, and user-state RPCs. Revocation is naturally idempotent and immediately prevents new authenticated calls.

`ListDevices` follows the common page contract and orders devices by creation time then opaque ID, so every credential remains discoverable and revocable.

Pairing requests expire, user codes are single-use, and polling earlier than `poll_interval` is rate-limited with `RetryInfo`. An authenticated administrator approves the human code shown on the television; the polling-only `pairing_id` is not required at the CLI. User codes are normalized for human entry; polling tokens are compared as secrets and never accepted in place of administrator authentication.

### ProviderService

Provider management is neutral and schema-driven
([ADR-0019](../adr/0019-restricted-schema-driven-provider-configuration.md)).
A provider type is an installed runtime capability, not a dedicated endpoint.
The same CLI or future UI renders any supported provider configuration from the
returned schema.

| RPC | Access | Request | Response |
| --- | --- | --- | --- |
| `ListProviderTypes` | Administrator | `page_size`, `page_token` | repeated `provider_types`, `next_page_token` |
| `ListProviderInstances` | Administrator | `page_size`, `page_token` | repeated `provider_instances`, `next_page_token` |
| `GetProviderInstance` | Administrator | `provider_instance_id` | `provider_instance` |
| `TestProviderConfiguration` | Administrator | `provider_type_id`, `configuration` | `result` |
| `CreateProviderInstance` | Administrator | `operation_id`, `provider_type_id`, `display_name`, `configuration`, `enabled`, optional `sync_priority` | `provider_instance` |
| `UpdateProviderInstance` | Administrator | `operation_id`, `provider_instance_id`, `expected_revision`, optional `display_name`, optional `enabled`, optional `sync_priority`, `configuration_patch`, repeated `clear_configuration_fields` | `provider_instance` |
| `TestProviderInstance` | Administrator | `provider_instance_id` | `result` |
| `DeleteProviderInstance` | Administrator | `operation_id`, `provider_instance_id`, `expected_revision` | empty |

`configuration`, `configuration_patch`, and the provider schema use `google.protobuf.Struct`. A create sends the full configuration. An update sends only changed keys; omitted keys remain unchanged. `clear_configuration_fields` explicitly removes optional values. A key cannot appear in both the patch and clear list. Required keys cannot be cleared.

The core validates the complete merged configuration against the accepted
schema and limits its canonical UTF-8 JSON representation, including secrets,
to 64 KiB. A schema `default` only prepopulates client controls; the core never
materializes an omitted value, and a secret property may not declare a default.
The core splits accepted secret and non-secret values before persistence, so no
write-only value enters the JSONB configuration returned to management clients.

`ProviderType` contains:

- `id`, `display_name`, and `description`;
- repeated explicit `capabilities`;
- `configuration_schema`;
- `schema_profile_version`; and
- `schema_revision`.

Provider types come only from a code-owned bundled-plugin registry. Bounded
startup discovery validates provider identity, contract major, capabilities,
and restricted schema before atomically persisting the last accepted metadata.
A missing or incompatible plugin leaves that record intact and the type
unavailable; database values never select an executable, argument, or stderr
schema.

Initial provider capabilities are `LIBRARY_READ`, `ARTWORK_RESOLVE`, `PLAYBACK_PLAN`, `PLAYBACK_OPEN`, `PLAYBACK_REPORT`, `PLAYBACK_REPORTS_USER_STATE`, `WATCH_STATE_READ`, `WATCHED_WRITE`, and `PROGRESS_WRITE`. `PLAYBACK_REPORTS_USER_STATE` describes a side effect: the provider's playback telemetry also changes its watched/progress state. Unknown capabilities are ignored. The core calls only advertised operations.

`ProviderInstance` contains:

- Nama-owned `id`, `provider_type_id`, `display_name`, and `enabled`;
- positive `sync_priority`, where lower values win unreliable-time and exact-time ties;
- `status` (`HEALTHY`, `UNAVAILABLE`, `AUTHENTICATION_FAILED`, or `DISABLED`);
- non-secret `configuration`;
- repeated `configured_secrets`, each containing `key` and `configured`;
- opaque `revision`; and
- `created_at` and `updated_at`.

`status` is the last completed observation made with the current stored
configuration revision. Its database write is conditional on that revision and
does not change the resource revision or `updated_at`. A disabled instance
projects `DISABLED` without erasing its prior observation. Candidate tests never
change an existing instance's status; stored-instance tests and ordinary
provider calls may.

Secret values are write-only. They are omitted from returned `configuration`, diagnostics, errors, logs, and event metadata. A configured marker reveals only whether a value exists. Updating another field does not require resending existing secrets.

Secret classification is monotonic
([ADR-0020](../adr/0020-monotonic-provider-secret-classification.md)). Once a
property key has been accepted as `writeOnly`, the core persists that
classification and rejects a later schema revision that removes it or changes
the property's type. A provider must introduce a new key plus an explicit
migration to replace a secret field; a plugin update can never make stored
ciphertext readable through management responses.

Recoverable secret values use one versioned AES-256-GCM envelope per
provider-instance and configuration key under the domain-separated protection
defined by
[ADR-0028](../adr/0028-domain-separated-provider-protection.md). Returned
configured-secret markers are derived from credential-row presence without
decrypting values. Startup authenticates envelopes individually; a damaged
envelope makes only that provider instance unavailable, while master-key loss
never falls back to plaintext or authorizes rebinding.

Enabled instances have unique positive sync priorities. On create, an omitted priority receives the next lowest precedence after existing instances. An update may reorder it; a duplicate value returns a field-level `CONFLICT`. This field is the administrator-configured source-priority tie breaker required by watch-state reconciliation.

Default-priority allocation and the global instance count are serialized under
concurrent creates. An omitted priority is one greater than the current maximum
across enabled and disabled instances. Re-enabling an instance whose priority
now conflicts fails rather than moving another instance, and priority updates
never renumber neighbors.

The MVP permits at most 100 configured provider instances. Creating another returns `RESOURCE_EXHAUSTED` with reason `PROVIDER_INSTANCE_LIMIT_REACHED`. This hard bound keeps complete operator diagnostics unary without introducing a second pagination contract.

The opaque provider-principal binding is established by the successful create
connection test and is immutable for the instance
([ADR-0021](../adr/0021-immutable-provider-principal-binding.md)). A
configuration or credential update may reconnect only as the same provider
principal. Changing the remote principal requires a new provider instance so
existing replica state cannot silently cross identities.

Create validates one isolated candidate connection before any instance row
exists and commits only a `CONNECTED` result with an opaque principal reference;
failed candidates leave no draft. Display-name, priority, and disable-only
updates are database-local. Any configuration or credential change and every
disabled-to-enabled transition validates the full merged candidate as the
existing principal before committing; failure preserves configuration,
credentials, binding, status, and revision.

Deleting an instance is allowed only after it is disabled and has no active playback session or sync run; otherwise it fails with `PROVIDER_INSTANCE_BUSY`. Delete invalidates unopened plans and atomically removes encrypted credentials, configuration, scheduler state, scan continuations, provider sources, and provider-to-canonical mappings for that instance. It never calls a destructive provider API and never cascades into canonical user state. Canonical items backed by another source remain. Items left without any source lose public library membership—browse, search, and `GetMedia` treat them as absent—while their internal Nama-owned state is retained indefinitely in the MVP. Garbage collection requires a separately reviewed lifecycle policy.

Provider update and delete acquire a per-instance writer gate and recheck
`expected_revision`. Configuration cutover closes old-revision admission,
drains bounded in-flight plugin calls, requires certain process cleanup, and
then commits the new snapshot. Delete performs the same fencing and cleanup
before its transaction. Playback sessions may continue through their opaque
session context; a sync run may finish its current plugin call but no later step
may cross the instance revision.

`ProviderConnectionTest` contains `status`, `summary`, optional `remote_name`, optional `remote_version`, and repeated discovered `capabilities`. Status is `CONNECTED`, `AUTHENTICATION_FAILED`, `UNREACHABLE`, or `INCOMPATIBLE`. Invalid request fields fail as `INVALID_ARGUMENT` with field violations; an expected remote connection outcome is returned as a test result so management clients can render it without parsing errors.

`ListProviderTypes` orders by provider type ID. `ListProviderInstances` orders by creation time then opaque ID. Both follow the common page contract.

Provider page tokens follow the common stateless HMAC contract. Type cursors
bind the last provider-type ID; instance cursors bind creation time plus opaque
ID. Neither cursor grants access or contains provider configuration.

#### Restricted configuration schema

`configuration_schema` is JSON Schema represented as a `Struct`, restricted to a deterministic profile that both CLI and UI clients can render:

- the root is `type: object` with `additionalProperties: false`;
- `properties` are flat; nested objects and arrays of objects are forbidden;
- a property may be `string`, `integer`, `number`, `boolean`, or an array whose `items` schema is a string with an optional enum;
- supported annotations are `title`, `description`, `default`, `examples`, `writeOnly`, and integer `x-nama-order`;
- supported constraints are `required`, `enum`, `minLength`, `maxLength`, `minimum`, `maximum`, `minItems`, `maxItems`, and `uniqueItems`;
- numeric values must be finite; integers stay within the interoperable signed 53-bit JSON range;
- supported string formats are `uri`, `hostname`, and `password`;
- a secret is a string with `writeOnly: true`; `password` only selects a masked control and is not itself validation;
- property names are stable lower_snake_case keys;
- the complete canonical UTF-8 JSON schema is at most 64 KiB; and
- `$ref`, remote resources, executable code, conditional schemas, composition keywords, regex patterns, and unevaluated nested graphs are forbidden.

Any keyword outside this profile is rejected rather than ignored.

Clients derive controls from type, enum, format, title, description, default,
and order. `default` is an input affordance, not an implicit stored or effective
value. Client-side validation is an immediate UX aid; the core revalidates the
restricted schema and submitted configuration and remains authoritative.
Provider-dependent and cross-field validation uses `BadRequest.FieldViolation`
paths such as `configuration.base_url`.

A provider schema revision is accepted only when existing properties remain,
types, formats, and `writeOnly` classifications are unchanged, enums only gain
values, constraints are equal or looser, new properties are optional, and every
persisted instance still validates. Titles, descriptions, examples, defaults,
and display order may change. A new required property needs a code-owned
migration that has already populated every instance; its data migration and
installation metadata commit atomically. Any incompatible revision preserves
the previous accepted schema and makes the provider type unavailable.

## Canonical media model

The public media model serves the universal Apple app without mirroring either
Jellyfin or Plex. Lists stay lean; detail and technical requests are explicit.
A duplicate title from multiple provider instances is one canonical item with
multiple Nama-owned sources when identity reconciliation has enough evidence
([ADR-0022](../adr/0022-canonical-provider-neutral-media-model.md)). Distinct
cuts or editions remain distinct items; alternate encodes and resolutions of
the same edition are sources.

### MediaSummary

`MediaSummary` is the only item shape used in home, browse, search, and child lists. It contains:

- `id`, `kind`, and mandatory `title`;
- optional `release_year`, `runtime`, and `content_rating`;
- optional `primary_genre`;
- optional `episode_position` containing `season_number` and `episode_number`;
- repeated `artwork` references;
- optional current-principal `user_state`;
- `playability`; and
- optional `default_source` with neutral quality data.

`MediaKind` is `MOVIE`, `SHOW`, `SEASON`, or `EPISODE`. `Playability` is `PLAYABLE`, `TEMPORARILY_UNAVAILABLE`, or `NO_AVAILABLE_SOURCE`. A provider outage changes source availability; it does not make the canonical item not found.

`MediaUserState` contains `watched`, optional `position`, optional `duration`, and `updated_at`. An absent position means no resumable progress; zero is a real position. The MVP stores direct state for playable movies and episodes; season and show summaries may omit it rather than inventing aggregate semantics. The current authenticated principal is implicit, so public requests do not accept a `user_id` in the MVP.

`MediaSourceSummary` contains:

- core-owned `id` and optional human `label`;
- `is_default` and `availability`;
- optional `container`;
- optional `video_quality` with codec, width, height, and dynamic range; and
- optional `audio_quality` with codec, channel count, and spatial format.

Quality fields describe the source's default video and audio selection. The optional label is user-assigned or core-generated neutral text. The API never synthesizes a provider type or instance identifier into it; user-entered text is returned as entered. These structured fields let clients render familiar badges such as resolution, HDR, and spatial audio without provider-specific display strings. `SourceAvailability` is `AVAILABLE`, `PROVIDER_UNAVAILABLE`, or `UNSUPPORTED`.

### MediaDetails

`MediaDetails` contains:

- its `summary`;
- optional `original_title`, `synopsis`, and `tagline`;
- repeated ordered `genres`, `studios`, and `credits`;
- all `artwork` references;
- ordered `parents` containing canonical `id`, `kind`, and `title`;
- repeated `source_summaries`; and
- exactly one typed `kind_details` member.

The `kind_details` oneof contains:

| Member | Fields |
| --- | --- |
| `MovieDetails` | optional `release_date` |
| `ShowDetails` | optional `first_release_date`, optional `last_release_date`, optional `season_count`, optional `episode_count` |
| `SeasonDetails` | `season_number`, optional `episode_count` |
| `EpisodeDetails` | `season_number`, `episode_number`, optional `release_date` |

The selected oneof member must agree with `summary.kind`. Counts are absent when unknown rather than set to zero.

`MediaCredit` contains `name`, `role`, optional `character_name`, and optional portrait artwork. Initial roles are `ACTOR`, `DIRECTOR`, and `WRITER`. Repeated order is display order. Producers and arbitrary crew roles wait for a screen that consumes them.

### Artwork

`ArtworkReference` contains:

- opaque `id`;
- `role` (`POSTER`, `BACKDROP`, `LOGO`, `THUMBNAIL`, or `PORTRAIT`);
- optional source `width` and `height`;
- optional BCP 47 `locale`; and
- `text_presence` (`UNKNOWN`, `TEXTLESS`, or `CONTAINS_TEXT`).

Text presence is descriptive, not guaranteed. Clients prefer textless cover art when available but always render the mandatory media title as the accessibility and missing-art fallback.

Under [ADR-0013](../adr/0013-origin-scoped-short-lived-locators.md), artwork references never contain a provider path, token, or URL. `LibraryService.ResolveArtwork` converts one reference into an `ArtworkLocator` containing `url`, repeated scoped `headers`, repeated `allowed_redirect_origins`, `refresh_at`, optional `access_expires_at`, and optional resolved dimensions. The request may include `max_width` and `max_height`; zero means no preference. `refresh_at` is the core-selected time after which the client resolves the reference again; it is cache freshness, not an access-control claim. `access_expires_at` is present only when the provider enforces that the locator authorization stops working at that time. Clients do not start a new fetch after either deadline.

The core validates the initial and allowed redirect origins and that the locator contains no reusable account credential. Headers apply only to the initial origin and are stripped on any origin change. A locator whose URL or headers carry authorization must have provider-enforced, item-constrained access and an `access_expires_at`; otherwise resolution fails as ordinary missing artwork and the client keeps its title fallback. A credential-free public artwork URL may omit `access_expires_at`; its `refresh_at` remains only a re-resolution deadline.

### Sources, parts, and tracks

`GetMedia` returns source summaries. `GetMediaSource` returns technical details only when a details or source-selection screen asks for them.

`MediaSource` contains `id`, `media_id`, optional `label`, `availability`, optional `runtime`, optional aggregate `bit_rate_bps`, and ordered `parts`.

`MediaPart` contains:

- stable core-owned `id` and `order`;
- `container`;
- optional `runtime`, `size_bytes`, and `bit_rate_bps`; and
- ordered normalized `tracks`.

File size belongs to a part. The public API never exposes a filesystem path, provider media source ID, provider part key, or provider stream index.

`MediaTrack` contains `order` and one of:

| Track | Fields |
| --- | --- |
| `VideoTrack` | codec, optional width, height, frame rate, bit depth, dynamic range |
| `AudioTrack` | codec, optional title and language, channel count, channel layout, sample rate, spatial format, `is_default`, and `is_commentary` |
| `SubtitleTrack` | codec, optional title and language, representation (`TEXT` or `IMAGE`), `is_default`, `is_forced`, `is_hearing_impaired`, and `is_commentary` |

`DynamicRange` initially supports `SDR`, `HDR10`, `HDR10_PLUS`, `HLG`, and `DOLBY_VISION`. `SpatialAudioFormat` initially supports `NONE`, `DOLBY_ATMOS`, and `DTS_X`. Unknown future values must not make a details screen fail.

Technical tracks returned by `GetMediaSource` are descriptive and not selectable by index. Playback planning returns separate opaque, plan-scoped track IDs. Deep codec profile/level/color metadata, chapters, and raw probe payloads are deferred until a real playback diagnosis requires them.

## LibraryService

| RPC | Access | Request | Response |
| --- | --- | --- | --- |
| `GetHome` | Administrator or device | optional `section_size` | repeated `sections` |
| `ListLibrary` | Administrator or device | filters, sort, `page_size`, `page_token` | repeated `items`, `next_page_token` |
| `Search` | Administrator or device | `query`, optional kinds, `page_size`, `page_token` | repeated `items`, `next_page_token` |
| `GetMedia` | Administrator or device | `media_id` | `media` |
| `ListChildren` | Administrator or device | `parent_media_id`, `page_size`, `page_token` | repeated `items`, `next_page_token` |
| `GetMediaSource` | Administrator or device | `media_id`, `source_id` | `source` |
| `ResolveArtwork` | Administrator or device | `artwork_id`, optional `max_width`, optional `max_height` | `locator` |

`GetHome` returns ordered `HomeSection` values with stable `id`, display `title`, `kind`, and ordered `MediaSummary` items. Initial section kinds are `CONTINUE_WATCHING`, `MOVIES`, and `SHOWS`. The default section size is 20 and maximum is 50. Home is intentionally a bounded snapshot with no per-section pagination contract. `RECENTLY_ADDED` remains the conditional release-plan feature and is added only after navigation evidence requires it.

`ListLibrary` accepts a small `LibraryFilter` rather than a generic query language:

- repeated `kinds`;
- optional `genre`;
- optional `release_year`;
- `watch_filter` (`ANY`, `WATCHED`, `UNWATCHED`, or `IN_PROGRESS`); and
- `playable_only`.

Initial `LibrarySort` values are `TITLE_ASC`, `RELEASE_DATE_DESC`, and `DATE_ADDED_DESC`. Search uses server relevance and does not accept arbitrary sort. It matches normalized title, original title, cast names, and genres in the stored canonical index. An empty or whitespace-only query is invalid.

`ListChildren` is valid for a show or season and returns the next canonical level in display order. A movie or episode parent fails with `FAILED_PRECONDITION` and reason `MEDIA_HAS_NO_CHILDREN`.

All reads use the stored canonical model. `NOT_FOUND` means the canonical resource or artwork reference does not exist or is not visible to the principal. A present item whose retained source is temporarily unusable remains visible with its availability and playability state; intentional deletion of its last source removes library visibility as specified by `ProviderService`.

## PlaybackService

[ADR-0014](../adr/0014-four-stage-playback-lifecycle.md) defines the playback lifecycle: plan without long-lived side effects, open exactly one session, report ordered telemetry, and close idempotently. The public and plugin services intentionally mirror this lifecycle while keeping their messages package-local.

### Capabilities and preferences

`PlaybackCapabilities` describes what the actual client/player can consume:

- repeated `direct_play_profiles`;
- repeated supported delivery `protocols`;
- repeated `subtitle_capabilities`;
- optional maximum width, height, video bit depth, and audio channels; and
- repeated supported dynamic-range values.

A `DirectPlayProfile` is one supported combination of container, optional video codec, and allowed audio codecs. Clients send multiple profiles rather than independent codec lists that would imply unsupported combinations. A video-less profile describes audio-only media.

Initial `DeliveryProtocol` values are `HTTP_PROGRESSIVE` and `HLS`. `SubtitleCapability` combines subtitle codec or format with allowed delivery modes `EMBEDDED`, `EXTERNAL`, and `BURNED_IN`.

`PlaybackPreferences` contains:

- `quality` (`AUTO`, `ORIGINAL`, or `CAPPED`);
- optional `max_bit_rate_bps`, required only for `CAPPED`;
- ordered preferred audio languages;
- ordered preferred subtitle languages; and
- subtitle preference (`AUTO`, `OFF`, `FORCED_ONLY`, or `ALWAYS`).

Capabilities are hard limits. Preferences express a choice within those limits. The server never silently treats a quality preference as a capability.

### PlanPlayback

`PlanPlaybackRequest` contains `media_id`, optional `source_id`, `capabilities`, optional `start_position`, and `preferences`.

`PlanPlaybackResponse` contains a `PlaybackPlan` with:

- opaque `id`, `media_id`, and selected `source_id`;
- `expires_at`;
- delivery `strategy`;
- expected `container`, `video_codec`, `audio_codec`, and protocol;
- ordered selectable audio and subtitle `tracks`;
- default audio track ID and a `SubtitleSelection`; and
- per-stream `actions`.

`PlaybackStrategy` is `DIRECT`, `REMUX`, `TRANSCODE_AUDIO`, or `TRANSCODE_VIDEO`. `TrackAction` associates an opaque plan-scoped track ID with `COPY`, `TRANSCODE`, `BURN`, `EXTERNAL`, or `OMIT`. A `PlaybackTrack` contains the plan-scoped `id`, type, label, language, default and forced flags, and the relevant normalized audio or subtitle format fields.

`SubtitleSelection` is a oneof containing either `track_id` or `disabled`; there is no magic empty-string track. The selected IDs must come from the plan.

Planning is side-effect-free from Nama's perspective: it creates only an expiring plan record and no long-lived provider playback session. The server selects the default available source when `source_id` is absent. A requested unavailable source fails visibly instead of silently switching editions. The MVP playback lifecycle supports a source with one part. Multi-part sources remain visible in technical details but planning returns `PLAYBACK_UNSUPPORTED`; segment sequencing is added only with representative multi-part fixtures.

### OpenPlayback

`OpenPlaybackRequest` contains `operation_id`, `plan_id`, optional selected `audio_track_id`, and an explicit `SubtitleSelection`.

`OpenPlaybackResponse` contains a `PlaybackSession` with:

- core-owned `id`;
- `strategy` and expected protocol/container/codecs;
- a `PlaybackLocator` containing URL, scoped headers, MIME type, and expiry;
- repeated core-validated allowed redirect origins within the locator;
- `report_interval`; and
- repeated `PlaybackSessionTrack` values in `tracks`, optional session-scoped `selected_audio_track_id`, and session-scoped `selected_subtitle` using `SubtitleSelection`; and
- repeated `ExternalSubtitleLocator` values in `external_subtitles`, keyed by session track ID.

`PlaybackSessionTrack` contains a new opaque session-scoped `id`, type, optional label and language, default and forced flags, the relevant normalized audio or subtitle format fields, and `switchable_without_reopen`. `ExternalSubtitleLocator` contains `track_id`, `url`, repeated scoped `headers`, repeated `allowed_redirect_origins`, `mime_type`, and `expires_at`. It exists exactly once for each session subtitle track delivered as `EXTERNAL`; `track_id` must identify that session track. It follows the same origin, redirect, header, credential, and expiry rules as the main playback locator.

On successful open, the core copies the materialized plan-to-provider track mappings into the active session and retains them until the session is closed or its bounded abandoned-session cleanup expires. Plan expiry after open does not invalidate session track IDs. Only a track marked `switchable_without_reopen` may be selected locally and reported under the existing session. Selecting any other plan candidate requires close, a new plan, and a new open at the current position. There is no `SwitchTrack` RPC in the unary MVP.

Opening the same operation ID with the same request returns the same logical session while it remains valid. Opening with a different payload fails with `IDEMPOTENCY_KEY_REUSED`. A plan may be opened once logically; a second operation ID fails with `PLAYBACK_PLAN_ALREADY_OPENED`.

Under [ADR-0013](../adr/0013-origin-scoped-short-lived-locators.md), the locator authorizes only the planned item/session and expires no earlier than the expected runtime plus a bounded grace period. It never contains an administrator, device, provider API-key, or reusable provider-account credential. Media bytes then flow from the provider to the Apple client without traversing the core.

Milestone 1 must prove that Jellyfin can satisfy this security boundary on real hardware. Current documented Jellyfin APIs do not themselves promise an item- or session-scoped media credential, so this is a release-blocking proof rather than an assumed implementation detail. Jellyfin does not advertise usable `PLAYBACK_OPEN` to the core until that proof passes. Milestone 4 repeats the transport, logging, and redirect proof on iOS, tvOS, and macOS. The same rule applies to every later provider, including Plex. If a provider cannot safely constrain direct authorization, playback returns to security design; Nama does not ship a reusable provider credential or silently become a proxy.

### ReportPlayback

`ReportPlaybackRequest` contains:

- `event_id` and `playback_session_id`;
- monotonically increasing `sequence` within the session;
- `state` (`PLAYING`, `PAUSED`, or `BUFFERING`);
- `position`, optional `duration`, and optional `client_observed_at`; and
- optional selected session-scoped audio and subtitle track IDs.

`ReportPlaybackResponse` contains `accepted_sequence` and the canonical `user_state` after applying any accepted event.

Reported track IDs are observations of player state, not commands to switch a provider stream. They must belong to the active session and may change only to a track marked `switchable_without_reopen`. A candidate requiring another lease follows the close, replan, and reopen flow instead.

Duplicate event IDs return the original logical result. A sequence at or below the highest applied sequence is acknowledged without regressing state. A later genuine seek or rewatch may report a smaller position with a higher sequence and must be preserved. Nama-originated ordering uses server receipt time plus session sequence; bounded client time is diagnostic evidence only and never outranks those values. Telemetry is sent on state change and at the returned report interval; reporting frequency is not encoded as a fixed provider rule.

Canonical state commits before provider telemetry is considered delivered. A provider report failure cannot roll back accepted Nama progress or trick the client into replaying an ambiguous provider timeline event. The core records the provider-side outcome for session diagnostics and synchronization; it retries only when the adapter can prove that no provider mutation occurred.

### ClosePlayback

`ClosePlaybackRequest` contains `operation_id`, `playback_session_id`, `final_position`, optional `duration`, `reason`, and optional `client_observed_at`. Initial reasons are `STOPPED`, `COMPLETED`, `FAILED`, and `CANCELLED`. The terminal canonical activity time is assigned by the server.

`ClosePlaybackResponse` contains final canonical `user_state`. Close is idempotent and persists the final state first. Provider close telemetry is the export when the plugin declares that side effect; otherwise the core schedules an explicit supported watch-state export. It attempts provider cleanup immediately; an unreachable provider leaves bounded cleanup pending until a later safe retry or lease expiry rather than falsely reporting that the remote resource was released. Failure or cancellation follows the same cleanup rule. Reporting or closing an already-closed session returns its terminal result when the logical operation is known.

## UserStateService

| RPC | Access | Request | Response |
| --- | --- | --- | --- |
| `GetUserState` | Administrator or device | `media_id` | `user_state` |
| `SetWatched` | Administrator or device | `operation_id`, `media_id`, `watched` | `user_state` |

`SetWatched` is an explicit target, never a toggle. Both marking watched and marking unwatched are valid state changes. The server timestamps the local action; the client does not supply a trusted activity time. Direct state applies to playable movies and episodes in the MVP. Playback progress is persisted through `ReportPlayback` and `ClosePlayback`; there is no second public `SetProgress` path. Provider export occurs asynchronously after the Nama state commits.

## SyncService

| RPC | Access | Request | Response |
| --- | --- | --- | --- |
| `GetSyncStatus` | Administrator | optional `provider_instance_id`, `page_size`, `page_token` | `aggregate_status`, repeated `provider_statuses`, `next_page_token` |
| `TriggerSync` | Administrator | `operation_id`, optional `provider_instance_id` | `run` |
| `GetSyncRun` | Administrator | `sync_run_id` | `run` |

`GetSyncStatusResponse` contains `aggregate_status`, repeated `ProviderSyncStatus` values, and `next_page_token`. When `provider_instance_id` is absent, all configured instances, including disabled instances, follow the common page contract and are ordered by provider-instance creation time then opaque ID. `aggregate_status` is computed over every matching instance, not only the returned page. When the ID is present, page fields must be absent or default, exactly one matching status is returned, and `next_page_token` is absent; an unknown ID returns `NOT_FOUND`.

`ProviderSyncStatus` contains `provider_instance_id`, `status`, optional `active_run`, optional `last_success_at`, optional `next_attempt_at`, and optional redacted `failure_summary`. `SyncStatus` is `IDLE`, `QUEUED`, `RUNNING`, `FAILED`, or `DISABLED`. An active run determines `QUEUED` or `RUNNING`; otherwise a disabled instance is `DISABLED`, the latest unresolved terminal failure is `FAILED`, and the instance is `IDLE`. Aggregate precedence is `FAILED`, `RUNNING`, `QUEUED`, then `IDLE`; it is `DISABLED` only when every matching instance is disabled. An empty configured set is `IDLE`.

`SyncRun` contains core-owned `id`, optional `provider_instance_id`, `phase`, `created_at`, optional `started_at`, optional `finished_at`, bounded `counts`, optional redacted `failure_summary`, and repeated `child_runs`. A `SyncChildRunReference` contains `sync_run_id` and `provider_instance_id`. Provider runs set `provider_instance_id` and have no children. Parent runs omit it and contain one child reference per enabled instance targeted by that trigger. A child has no parent ID because one already-active provider run may be joined by multiple aggregate triggers.

Phases are `QUEUED`, `RUNNING`, `PULLING`, `RECONCILING`, `PUSHING`, `COMPLETED`, or `FAILED`. `RUNNING` is used only by a parent while any child is active; provider runs use the stage-specific phases. A parent is `QUEUED` before any referenced child starts, `RUNNING` while any child is nonterminal after work starts, `FAILED` after all children are terminal if any failed, and otherwise `COMPLETED`.

A parent's `created_at` is the aggregate-trigger time. Its `started_at` is that same time when any joined child is already active, otherwise the first later child start; it never precedes `created_at`. `finished_at` is set when every referenced child is terminal. A parent with no enabled children sets all three timestamps to the trigger time and completes immediately. Parent counts are bounded sums of each referenced child's full-lifetime counts, including work completed before this parent joined an already-active child.

`SyncCounts` contains items scanned, canonical states reconciled, mutations attempted, mutations applied, and mutations failed. Counts are operational summaries, not transaction guarantees.

For `TriggerSync`, an omitted provider instance means all enabled instances. The response is a parent run with explicit child references; each reference may identify a newly created child or an active provider run joined by this trigger. With a provider ID, the response is that provider run. Only one run per provider instance is active. Triggering during an active run returns that run rather than queuing duplicate work. The MVP has no separate pull/push buttons and no cancellation RPC.

A failed import or export does not roll back already committed canonical state. Status failures are sanitized so the CLI can show recovery without raw provider errors.

Reconciliation stores the last normalized replica observed from each provider
instance ([ADR-0023](../adr/0023-canonical-watch-state-reconciliation.md)). A
committed Nama-originated action wins immediately and is exported outward.
Otherwise the most recent reliable provider activity wins, including a lower
position or unwatched state from a genuine seek or rewatch. Missing or
heuristic activity time, and exact reliable-time ties, use the instance's
configured `sync_priority`. Equality with an already observed target produces
no export. No rule takes maximum position or makes watched state permanently
dominant.

## Plugin services
The stateless supervised process boundary is defined by [ADR-0006](../adr/0006-stateless-supervised-plugin-subprocesses.md). Its production transport is implemented: eager code-owned executable and launch-kind validation, descriptor-only handle acquisition, shared first-demand launch, protected per-launch authority and Unix socket, authenticated health and identity handshake, explicit caller deadlines, cancellation without replay, bounded recovery, structured stderr, process-group cleanup, one-shot candidate retirement, and exact-revision instance fencing. Production provider descriptors and method workflows remain unimplemented.


Each plugin process receives one discriminated launch kind through the
supervisor's canonical, size-bounded, versioned stdin launch document. Discovery
has no provider context and serves health plus `GetInfo`. A candidate receives
one proposed configuration, serves one `GetConnection`, and retires immediately.
A stored instance receives one provider-instance ID, configuration revision,
non-secret configuration, and separate secret map and may serve nearby calls
until its bounded idle retirement. Ordinary RPC bodies, metadata, argv, and the
empty child environment never transport provider credentials.
One valid call holds supervisor demand through lifecycle waiting and RPC completion. Zero demand starts a fixed 30-second grace; intervening demand resets the full interval, while expiry retires the complete process group and launch artifacts before a later call may launch a fresh incarnation. Demand arriving after retirement commits joins that teardown within its existing caller deadline.

Cleanup uncertainty is private lifecycle state, not a plugin or public wire status. Failed idle cleanup retains ownership sufficient to prohibit a duplicate launch, maps later calls to the existing plugin-unavailable contract, emits no background retry, and is retried only by scope finalization. Finalization bypasses idle grace and joins cleanup already in progress; persistent failure follows the existing server-shutdown failure contract.


The canonical launch context is limited to 64 KiB and contains no database,
master-key, administrator, device, other-instance, or public-operation
authority. Stored calls acquire demand under instance ID plus revision; no
process crosses durable configuration revisions. Credential storage and any
refresh material belong to the core. Automatic provider credential refresh is
outside the MVP until an additive core-owned update contract exists.

Every plugin RPC requires the per-launch bearer. Calls carry explicit deadlines
and cancellation. Plugin requests contain only the provider references and
values needed for that operation. Plugin responses are untrusted input: the
core validates their Protobuf constraints, normalized values, URL origins,
header allowlist, and size bounds before storage or public mapping.

### Plugin HealthService

The existing `nama.plugin.v1.HealthService.Check` remains the additive anchor with its existing field numbers. It reports whether the process and RPC loop are serving. It does not contact the provider; provider reachability belongs to `PluginService.GetConnection`.

### PluginService

| RPC | Request | Response |
| --- | --- | --- |
| `GetInfo` | empty | `plugin_info` |
| `GetConnection` | empty | `connection` |

`PluginInfo` contains:

- stable `provider_type_id`, `display_name`, and `description`;
- plugin `build_version` and `contract_major`;
- repeated explicit `capabilities`; and
- the restricted `configuration_schema`, `schema_profile_version`, and `schema_revision`.

`GetInfo` does not require instance configuration or a successful provider connection and returns static information suitable for `ProviderService.ListProviderTypes`. The plugin schema follows exactly the restricted public profile; the core validates it before publishing it. `GetConnection` requires an instance or candidate launch.

`PluginConnection` contains `status`, optional redacted `remote_name`, optional `remote_version`, optional opaque `provider_user_reference`, and repeated discovered capabilities. Every connected candidate or configured instance requires that private reference; despite the wire field name, it carries the provider-principal identity that the core digests and never publishes through `nama.api.v1`. Status is `CONNECTED`, `AUTHENTICATION_FAILED`, `UNREACHABLE`, or `INCOMPATIBLE`. Raw provider error bodies and credential-bearing URLs are never returned.

The initial Jellyfin schema requires absolute `base_url` with at most 2,048
UTF-8 bytes, explicit `user_id` with at most 128 UTF-8 bytes, and write-only
`api_key` with at most 4,096 UTF-8 bytes. `GetConnection` first reads
unauthenticated public system information, then reads the configured user with
Jellyfin's credentialed authorization header. It requires matching canonical
server and user identities and a non-disabled user, and returns their versioned
combination as the opaque principal reference. Jellyfin base URLs may use HTTP
or HTTPS, private destinations, and one path prefix but no embedded credentials,
query, or fragment. Requests refuse redirects and propagate the RPC
cancellation signal so the API key never crosses the configured origin or path.
Issue #29 advertises no media capability; issue #30 adds only capabilities it
implements.

### Plugin media model

The plugin media package mirrors normalized public concepts but retains opaque
provider references
([ADR-0022](../adr/0022-canonical-provider-neutral-media-model.md)). It never
returns a provider SDK object or an unbounded payload map.

`ProviderItemReference` contains opaque `item_id`. The configured provider instance is implied by the authenticated process, so it is not repeated in every request. `ProviderSourceReference`, `ProviderPartReference`, `ProviderTrackReference`, and `ProviderArtworkReference` contain the parent reference plus their corresponding opaque provider identifier where needed.

`ProviderMediaItem` contains:

- its provider item reference, kind, title, and optional original title;
- optional synopsis, tagline, release date or year, runtime, and content rating;
- show, season, and episode parent references and numbering where applicable;
- ordered genres, studios, and normalized credits;
- repeated external identifiers as `namespace` and opaque `value` pairs;
- repeated artwork observations; and
- ordered provider media sources.

Its kind-specific fields use the same Movie/Show/Season/Episode oneof rule as the public model. External identifiers are evidence used by core reconciliation; they are never copied into public consumer messages.

`ProviderArtwork` contains its opaque reference, normalized role, optional dimensions and locale, and text presence. It contains no raw path, access token, or already-authorized public URL.

`ProviderMediaSource` contains opaque source reference, optional label, availability, runtime, aggregate bit rate, and ordered parts. A part contains its opaque reference, order, container, duration, size in bytes, bit rate, and ordered tracks. A track contains its opaque reference plus the same normalized video, audio, or subtitle technical fields described by the public media model.

Adapter normalization rules are mandatory:

- alternate encodes and resolutions of one edition become sources;
- provider editions or cuts remain separate items;
- provider stream indexes and filesystem paths remain private references;
- Jellyfin ticks and Plex millisecond values become `Duration`;
- bit rates are bits per second and sizes are bytes;
- HDR, channel, spatial-audio, forced-subtitle, and accessibility mappings are fixture-tested; and
- absent provider data stays absent rather than being inferred from a display string.

### Plugin LibraryService

| RPC | Request | Response |
| --- | --- | --- |
| `ListItems` | oneof `begin` or `continuation` | repeated `items`, optional `next_page_token`, `complete`, `consistency` |
| `GetItem` | `item_reference` | `item` |
| `ResolveArtwork` | `artwork_reference`, optional maximum dimensions | `lease` |

`BeginListItems` contains `page_size`. `continuation` is the opaque token
alone. The plugin binds the token to provider instance, catalog scope,
requested non-watch-state ordering, query shape, and offset. `ListConsistency`
is `BEST_EFFORT_SCAN` for the MVP. Providers may ignore ordering or pagination
hints, and a scan may duplicate or miss items during concurrent changes.
`complete` means only that the adapter reached the provider's end-of-pass
condition; it does not claim snapshot or no-gap coverage. The core deduplicates
references and later full scans reconcile shifts.

The core durably records the catalog scan run and last accepted continuation
([ADR-0024](../adr/0024-best-effort-provider-scans.md)). After restart it
resumes a valid token or begins the full scan again; an opaque plugin token is
never treated as an authoritative provider change cursor.

`GetItem` supports targeted repair and refresh before a write. Missing items return `NOT_FOUND`; provider unavailability returns `UNAVAILABLE`. Provider event subscriptions are not part of the unary MVP contract.

`ProviderArtworkLease` contains provider URL, required headers, repeated proposed `allowed_redirect_origins`, optional provider-enforced `access_expires_at`, MIME type, and artwork authorization scope (`PUBLIC`, `MEDIA_ITEM`, or `PROVIDER_ACCOUNT`). A `PUBLIC` lease carries no credential and may omit access expiry. A `MEDIA_ITEM` lease must be constrained to that item and include an enforced access expiry. `PROVIDER_ACCOUNT` is always rejected.

The core independently validates every origin against configured provider/CDN policy before converting the lease to a public `ArtworkLocator`, and selects the public `refresh_at` no later than any provider access expiry. A lease that requires a reusable provider-account credential, claims protected access without enforced expiry, or proposes an unsafe redirect is rejected; the client receives ordinary missing artwork and keeps its title fallback.

### Plugin PlaybackService

The plugin lifecycle has the same four RPC names as the public service:

| RPC | Purpose |
| --- | --- |
| `PlanPlayback` | Translate a provider source and client constraints into a provider plan without a long-lived session |
| `OpenPlayback` | Materialize one provider playback lease from the plan |
| `ReportPlayback` | Send bounded provider telemetry for an active lease |
| `ClosePlayback` | Send the terminal provider event and release provider resources |

The package-local `PlanPlaybackRequest` contains the provider item and source references, normalized playback capabilities, optional start position, and preferences. Capability and preference fields have the same semantics as the public package but are independently declared in `nama.plugin.v1`.

`PluginPlaybackPlan` contains an opaque plugin plan ID, expiry, strategy, expected format and protocol, provider-scoped selectable tracks, defaults, and track actions. The core maps provider-scoped IDs to new public plan-scoped IDs for planning. When a plan opens, it copies every materialized mapping needed by the returned lease into the active core session and retains it through session cleanup rather than only through plan expiry.

The package-local `OpenPlaybackRequest` contains `operation_id`, plugin plan ID, and explicit selected provider track references. It returns a private `PlaybackLease` containing:

- opaque provider `session_id`;
- provider URL, headers, protocol, and MIME type;
- repeated proposed `allowed_redirect_origins`;
- expiry and recommended report interval;
- authorization scope (`SESSION`, `MEDIA_ITEM`, or `PROVIDER_ACCOUNT`); and
- repeated `ProviderSessionTrack` values, selected audio and subtitle provider track references, and repeated `ProviderExternalSubtitleLocator` values; and
- opaque `session_context` bytes needed for later report or close calls.

`ProviderSessionTrack` contains `track_reference` from the plugin plan and `switchable_without_reopen`. `ProviderExternalSubtitleLocator` contains `track_reference`, `url`, repeated required `headers`, repeated proposed `allowed_redirect_origins`, `mime_type`, and `expires_at`. It is required exactly once for every external subtitle in the materialized session and inherits the enclosing lease's authorization scope. The core validates it independently and maps it to the corresponding public session track ID.

`session_context` may contain provider state or secrets. The core keeps it only for the active session, never logs it, and supplies it unchanged to later plugin processes if the original process restarts. It is never copied to a public response.

The core exposes only `SESSION` or sufficiently constrained `MEDIA_ITEM` leases. It rejects `PROVIDER_ACCOUNT` authorization and any header, URL, or redirect origin that is reusable or unsafe outside the planned item. Redirect origins proposed by a plugin are untrusted and must match core configuration; public clients strip custom headers on every origin change. A plugin cannot weaken this rule by advertising a capability.

Plugin report fields mirror public event ID, sequence, state, position, duration, observed selected tracks, and optional diagnostic client time, plus the private session context. Selected track references must belong to the active lease and are observations rather than switch commands. Plugin close fields mirror final position, duration, reason, operation ID, and optional diagnostic client time, plus the context.

A provider that has no report or cleanup operation may implement the relevant call as a validated no-op. The core attempts to close every materialized lease on stop, cancellation, deadline, abandoned public open, shutdown, or partial failure. When the provider is unreachable, cleanup remains pending for a bounded safe retry and otherwise expires with the lease. If a public open is cancelled after the provider created a lease, the core records and attempts cleanup before discarding its active mapping.

When a plugin advertises `PLAYBACK_REPORTS_USER_STATE`, report and close are the sole provider-side writers for the corresponding local playback events. The core does not also enqueue equivalent `PushWatchStates` mutations for the same provider and canonical state version. Providers without that side effect receive an explicit supported watch-state export instead. One local event therefore has one provider-side write path.

### Plugin WatchStateService

Jellyfin and Plex can both enumerate current state, but neither documents a
durable current-state change cursor, snapshot revision, provider-side
idempotency key, compare-and-set write, or atomic multi-item mutation. The
plugin contract follows
[ADR-0024](../adr/0024-best-effort-provider-scans.md) rather than
manufacturing a cursor from mutable activity fields.

| RPC | Request | Response |
| --- | --- | --- |
| `ListWatchStates` | oneof `begin` or `continuation` | repeated `states`, optional `next_page_token`, `complete`, `consistency` |
| `GetWatchStates` | repeated `item_references` | one ordered `result` per reference |
| `PushWatchStates` | `batch_id`, repeated `mutations` | repeated per-mutation `results` |

`BeginWatchStateList` contains only `page_size`. A continuation contains only its opaque page token. The token binds the provider instance, immutable configured user binding, catalog scope, requested non-watch-state sort, query shape, offset, and scan identity. `WatchStateConsistency` is `BEST_EFFORT_SCAN` for Jellyfin and Plex. `complete` means end of this pass, not a provider snapshot or proof that concurrent changes created no gap. There is no checkpoint field in MVP.

The core durably stores its scan-run identity, last accepted opaque continuation, reconciliation progress, and last completed pass time. Those are core-owned scheduler checkpoints, satisfying restart recovery without pretending the provider supplied a change cursor. After restart the core resumes a still-valid continuation; if the token is expired or rejected, it safely restarts the full pass and deduplicates observations.

A future provider that offers a documented durable cursor may add a separate capability and additive `ListWatchStateChanges` RPC. Existing plugins must not put `LastPlayedDate`, `lastViewedAt`, item update time, scan time, or an offset token into a field and call it a durable checkpoint.

`ProviderWatchState` covers playable movies and episodes in the MVP and contains:

- `item_reference` and `watched`;
- optional `position` and `duration`;
- `observed_at`, when the plugin read the state;
- optional `provider_activity` containing time, semantics, and reliability;
- optional real provider `revision`.

Provider activity semantics are `PLAYBACK_STARTED`, `PLAYBACK_COMPLETED`, `STATE_CHANGED`, or `UNKNOWN`. Reliability is `RELIABLE` or `HEURISTIC`. Activity time is evidence for reconciliation, not automatically canonical truth. A missing or heuristic timestamp invokes the configured provider-priority tie breaker in core logic. Jellyfin `LastPlayedDate` is reported as heuristic with unknown semantics unless an observed event proves more. Plex `lastViewedAt` is completion evidence only, never a generic state-mutation time; manual watched/unwatched and current-progress reads have no reliable Plex activity time. Public `MediaUserState.updated_at` is always Nama's commit time, not either provider field.

`GetWatchStates` accepts at most 100 references and supports targeted repair and post-write confirmation. It returns one `WatchStateReadResult` per requested reference, in request order, with the reference, optional state, and status `FOUND`, `NOT_FOUND`, `FORBIDDEN`, `RETRYABLE_FAILURE`, or `PERMANENT_FAILURE`. Only `FOUND` includes state. Missing references are never fabricated as unwatched.

`WatchStateMutation` contains `mutation_id`, `item_reference`, and exactly one explicit target:

- `SetWatched` with the desired `watched` boolean; or
- `SetProgress` with desired `watched`, `position`, and optional `duration` as one coherent target.

There is no toggle, play-count setter, played-percentage setter, or last-played setter. `SetProgress` includes watched state because a resumable rewatch such as `watched = false, position > 0` must reach Jellyfin coherently in one per-item write. This claims no cross-item or cross-provider atomicity. Plex supports `SetWatched` but not an exact `SetProgress`; its active progress is reported through `Plugin PlaybackService.ReportPlayback`. Jellyfin may support both targets.

Each `WatchStateMutationResult` repeats `mutation_id`, returns optional observed state, and has one status:

- `APPLIED`;
- `ALREADY_APPLIED`;
- `UNSUPPORTED`;
- `NOT_FOUND`;
- `FORBIDDEN`;
- `INVALID`;
- `RETRYABLE_FAILURE`;
- `RETRYABLE_AMBIGUOUS`; or
- `PERMANENT_FAILURE`.

The batch is explicitly non-atomic. `APPLIED` and `ALREADY_APPLIED` require `observed_state`; a provider write that does not return state is followed by a targeted read before either status is reported. Retry only failed members with the same mutation IDs. After an ambiguous provider timeout, the plugin re-reads current state before deciding whether another write is safe. Providers do not receive credit for Nama idempotency merely because repeated absolute writes usually converge.

Provider events, Jellyfin WebSocket messages, Plex EventSource/WebSocket streams, webhooks, and playback history would be invalidation hints only, but the unary MVP does not subscribe to them. The core periodically repeats complete scans. Adapters request a provider-supported non-watch-state order where available, never watched state, play count, progress, or activity time. Because providers may ignore ordering or mutate the catalog mid-pass, deduplication and later scans—not a false snapshot guarantee—provide convergence.

The core computes an exact semantic fingerprint from normalized state confirmed
by the post-write observation and records it for a bounded period
([ADR-0023](../adr/0023-canonical-watch-state-reconciliation.md)). Plugins do
not define reconciliation fingerprints. Only an identical subsequent provider
observation is eligible for suppression. Causal attribution remains best-effort
because providers do not echo Nama operation IDs; loop safety ultimately comes
from never exporting a target already observed at that provider. “Ignore the
next event for this item,” maximum-position merging, and “watched wins” are
forbidden because a real seek, unwatch, or rewatch can race the export.

## Authentication and authorization

[ADR-0025](../adr/0025-default-deny-rpc-authorization.md) records the default-deny authorization choice and rationale. The server maintains one explicit table keyed by generated method descriptor; adding an RPC without adding an access rule fails a descriptor-level test.

| Method group | Accepted authority |
| --- | --- |
| `SetupService.GetStatus` | Public |
| `SetupService.CreateAdministrator` | Valid current-process bootstrap token |
| `AuthService.SignIn` | Public, rate-limited |
| `DeviceService.BeginPairing` | Public, rate-limited |
| `DeviceService.GetPairingStatus` | Matching high-entropy polling token |
| `HealthService.*` | Administrator session |
| `AuthService.GetCurrentUser`, `AuthService.SignOut` | Administrator session |
| `DeviceService.ApprovePairing`, `ListDevices`, `RevokeDevice` | Administrator session |
| `ProviderService.*` | Administrator session |
| `SyncService.*` | Administrator session |
| `LibraryService.*`, `PlaybackService.*`, `UserStateService.*` | Administrator session or active device bearer |
| Every `nama.plugin.v1` method | Matching per-launch plugin bearer |

Before initialization, only the two operational HTTP health endpoints and setup RPCs can succeed. `SignIn` and `BeginPairing` remain publicly callable descriptors but return `FAILED_PRECONDITION` with `NOT_INITIALIZED`. After initialization, `CreateAdministrator` always returns `ALREADY_INITIALIZED`, even after database damage; setup never reopens itself.

Administrator sessions cannot be manufactured from device credentials. Device credentials cannot call provider, device-management, sync, health, setup, or administrator-auth methods. A plugin bearer is accepted only on its process socket and never on the public listener.

Authentication and correlation run before handler validation so unauthenticated protected requests do not receive field-level oracle details. Public and bootstrap methods still receive complete field validation. Node dispatch assigns the request ID before decoding, authentication, and validation. Application failures carry it in `RequestInfo`; decoder failures retain only the same server-owned response header.

## Validation and form errors

Structural validation uses pinned Protovalidate annotations in both packages and runs at every trust boundary:

- non-empty and bounded strings, IDs, and operation IDs;
- email, URL, timestamp, duration, range, enum, page-size, and collection limits;
- required oneofs and mutually exclusive selections;
- maximum 100 entries in any page request, targeted reference read, or mutation batch; and
- bounded plugin response strings, collections, opaque tokens, URLs, headers, and session context.

Handlers enforce state-dependent and cross-field rules: setup state, credential ownership, provider schema values, source membership, plan expiry, track membership, expected revision, sequence ordering, and idempotency payload identity. The core validates all plugin responses before mapping or storage. The restricted provider JSON Schema validator is independent of Protobuf validation.

[ADR-0026](../adr/0026-standard-google-rpc-error-details.md) records the failure-model choice and rationale. Application-generated validation and expected failures use these standard Google RPC details:

- `google.rpc.ErrorInfo` carries the overall stable reason and domain;
- `google.rpc.BadRequest` carries repeated per-field violations;
- `google.rpc.RequestInfo` carries the server-assigned correlation ID; and
- `google.rpc.RetryInfo` carries a server-selected retry delay when retry is safe.

For public errors, `ErrorInfo.domain` is `nama.api.v1`; for plugin errors it is `nama.plugin.v1`.

Every `BadRequest.FieldViolation` uses:

- `field`: a Protobuf field path such as `email`, `sources[0].label`, or `configuration.base_url`;
- `description`: a concise non-secret fallback explanation;
- `reason`: a stable machine value; and
- `localized_message`: an optional server-provided localized fallback.

Initial field reasons are `REQUIRED`, `INVALID_FORMAT`, `OUT_OF_RANGE`, `UNSUPPORTED_VALUE`, `MISMATCH`, and `CONFLICT`. Protovalidate, restricted JSON Schema, and handler validation normalize into the same reasons and field-path form. A cross-field rule attaches a violation to each involved control. Clients map `field` to a form control, branch on `reason`, and may supply their own localized copy.

All discoverable violations are returned in one response, capped at 50 in deterministic field-path order. Additional violations are omitted rather than producing an unbounded error. Passwords, bootstrap tokens, polling tokens, bearer values, secret configuration values, locator headers, and opaque plugin context are never repeated in a description, localized message, reason, or error metadata.

## Connect errors

Clients first branch on Connect code, then on `ErrorInfo.reason`. They must fall back to the code when a newer server returns an unknown reason.

| Condition | Connect code | Stable reason |
| --- | --- | --- |
| Structural, schema, or cross-field input failure | `INVALID_ARGUMENT` | `VALIDATION_FAILED` |
| Invalid or mismatched page token | `INVALID_ARGUMENT` | `PAGE_TOKEN_INVALID` |
| Invalid bootstrap candidate or sign-in credentials | `UNAUTHENTICATED` | `AUTHENTICATION_FAILED` |
| Matching current-process bootstrap token during its active claim | `ABORTED` | `SETUP_IN_PROGRESS` |
| Fatal local setup-commit ambiguity before process exit | `UNAVAILABLE` | `SETUP_UNAVAILABLE` |
| Missing, invalid, expired, or revoked bearer | `UNAUTHENTICATED` | `CREDENTIAL_INVALID` |
| Durable session revocation cannot be confirmed | `UNAVAILABLE` | `SESSION_REVOCATION_UNCONFIRMED` |
| Authenticated authority cannot call method | `PERMISSION_DENIED` | `PERMISSION_DENIED` |
| Server has not completed setup | `FAILED_PRECONDITION` | `NOT_INITIALIZED` |
| Setup is permanently closed | `FAILED_PRECONDITION` | `ALREADY_INITIALIZED` |
| Client is below a required correctness floor | `FAILED_PRECONDITION` | `CLIENT_VERSION_UNSUPPORTED` |
| Plugin contract major is unsupported | `FAILED_PRECONDITION` | `PLUGIN_CONTRACT_UNSUPPORTED` |
| Canonical resource is absent or invisible | `NOT_FOUND` | `RESOURCE_NOT_FOUND` |
| Media kind cannot have children | `FAILED_PRECONDITION` | `MEDIA_HAS_NO_CHILDREN` |
| Media kind has no direct MVP user state | `FAILED_PRECONDITION` | `MEDIA_STATE_UNSUPPORTED` |
| Administrator attempts to approve an expired pairing | `FAILED_PRECONDITION` | `PAIRING_EXPIRED` |
| Requested source is unavailable | `UNAVAILABLE` | `SOURCE_UNAVAILABLE` |
| No safe compatible playback can be built | `FAILED_PRECONDITION` | `PLAYBACK_UNSUPPORTED` |
| Playback plan expired | `FAILED_PRECONDITION` | `PLAYBACK_PLAN_EXPIRED` |
| Playback plan was opened by another operation | `ALREADY_EXISTS` | `PLAYBACK_PLAN_ALREADY_OPENED` |
| Playback session is terminal for a new event | `FAILED_PRECONDITION` | `PLAYBACK_SESSION_CLOSED` |
| Same idempotency key was reused for another payload | `ALREADY_EXISTS` | `IDEMPOTENCY_KEY_REUSED` |
| Expected provider revision is stale | `ABORTED` | `REVISION_MISMATCH` |
| Provider update commit outcome remains unresolved | `UNAVAILABLE` | `PROVIDER_COMMIT_AMBIGUOUS` |
| Updated configuration resolves to another provider principal | `FAILED_PRECONDITION` | `PROVIDER_USER_CHANGED` |
| Candidate provider credentials are rejected | `FAILED_PRECONDITION` | `PROVIDER_AUTHENTICATION_FAILED` |
| Remote provider is incompatible | `FAILED_PRECONDITION` | `PROVIDER_INCOMPATIBLE` |
| Stored provider credential cannot be authenticated | `UNAVAILABLE` | `PROVIDER_CREDENTIALS_UNAVAILABLE` |
| Configured provider-instance limit is reached | `RESOURCE_EXHAUSTED` | `PROVIDER_INSTANCE_LIMIT_REACHED` |
| Provider deletion is blocked by active work or enabled state | `FAILED_PRECONDITION` | `PROVIDER_INSTANCE_BUSY` |
| Provider is temporarily unreachable | `UNAVAILABLE` | `PROVIDER_UNAVAILABLE` |
| Plugin launch or runtime is unavailable | `UNAVAILABLE` | `PLUGIN_UNAVAILABLE` |
| Plugin returned invalid or unsafe data | `INTERNAL` | `PLUGIN_RESPONSE_INVALID` |
| Public or pairing rate limit exceeded | `RESOURCE_EXHAUSTED` | `RATE_LIMITED` |
| Client cancelled | `CANCELLED` | `REQUEST_CANCELLED` |
| Deadline elapsed | `DEADLINE_EXCEEDED` | `DEADLINE_EXCEEDED` |
| Unexpected defect | `INTERNAL` | `INTERNAL` |

Expected application errors include `ErrorInfo` and `RequestInfo`. Rate limiting, temporary provider/plugin unavailability, and other explicitly retryable failures also include `RetryInfo`. `RetryInfo` is not attached to writes that are unsafe to repeat.

`ErrorInfo.metadata` has an allowlist of non-secret context such as canonical `resource_type`, canonical `resource_id`, or `minimum_client_version`. It never contains provider response text, provider references in a public error, database text, stack traces, request bodies, config fields, or credentials. Unexpected defects are logged server-side under the request ID and reduced to the generic public `INTERNAL` reason.

## Retry, idempotency, and concurrency

[ADR-0027](../adr/0027-logical-operation-idempotency.md) records the identity-model choice and rationale. A transport request ID correlates one network attempt. An operation or event ID identifies one logical action across attempts. They are not interchangeable.

### Safe retries

The following are safe to retry after `UNAVAILABLE` or `DEADLINE_EXCEEDED`: reads, lists, search, status checks, connection tests, targeted state reads, `PlanPlayback`, and polling pairing status. Clients still honor deadlines and `RetryInfo`.

`CreateAdministrator`, `SignIn`, and `SignOut` are never retried automatically. Lost setup response recovery is status then sign-in. After `SESSION_REVOCATION_UNCONFIRMED`, a client retains the bearer and calls `GetCurrentUser`: `UNAUTHENTICATED` resolves the operation as revoked, while a still-active session permits an explicit `SignOut` retry. Device revocation is naturally convergent, but clients read current state after an ambiguous result.

These public mutations carry `operation_id` and are retried only with the same ID and identical payload:

- approve pairing;
- create, update, and delete provider instance;
- open and close playback;
- set watched state; and
- trigger synchronization.

`ReportPlayback` carries `event_id` plus session sequence. Each plugin watch-state mutation carries `mutation_id`; its enclosing `batch_id` groups diagnostics but does not make the batch atomic. Plugin open/close calls carry the public logical operation ID, and plugin report calls carry the public event ID.

At the public boundary, an idempotency key is scoped to authenticated principal
plus fully qualified method. Repeating the same logical request returns the
original safe serialized result. Reusing it with a different normalized payload
returns `ALREADY_EXISTS` and `IDEMPOTENCY_KEY_REUSED`. The core stores a
domain-separated keyed HMAC of the canonical request, including secret values,
never the plaintext request or credentials.

Completed provider mutation results are retained for seven days and expired in
bounded startup and opportunistic mutation batches. Database uniqueness
arbitrates concurrent duplicates; duplicate read-only candidate connection
tests may occur, but only one provider mutation and result commit. No database
transaction, lock, or persisted pending-operation lease spans a provider call.
Other public mutation classes retain at least their existing 24-hour,
request-expiry, or session-expiry minimum.

At the plugin boundary, operation, event, batch, and mutation IDs are correlation and recovery keys; they do not imply provider-native idempotency. The core prevents duplicate plugin calls when it has a recorded outcome. If provider commitment is ambiguous, the adapter follows the operation-specific re-read or cleanup rule and never automatically replays a Jellyfin playback-start call or other non-convergent telemetry.

### Concurrency

- Provider update and delete require `expected_revision`. A stale value returns `ABORTED`; clients fetch the current instance before deciding whether to reapply edits.
- Provider calls load one transactional configuration and credential snapshot
  and acquire runtime demand under provider-instance ID plus revision. A stale
  scheduled or request snapshot refetches or fails; it never launches an old
  revision.
- Configuration cutover and delete stop admission, drain bounded calls, and
  require process cleanup before committing. Status observations commit only
  while their captured revision remains current; last committed completion wins.
- Provider create serializes count and omitted-priority allocation so the
  100-instance bound and default ordering hold under concurrency.
- Setup is process single-flight and permanently closes immediately after administrator creation commits.
- Pairing approval is single-flight per pairing request. Only one logical device can result.
- Only one sync run is active per provider instance. A trigger joins the active run.
- Playback telemetry applies increasing sequence numbers. Higher sequence, not greater position, determines event order.
- Plugin watch batches are the only specified non-atomic batch; every member has its own result.

Cancellation and deadlines propagate from transport through the core to plugin/provider work. A cancelled mutation may already have committed. The client recovers by repeating the same operation ID or reading current state. A late playback lease is recorded and cleanup is attempted when its identity is known; a process crash before the provider returns an identity can rely only on provider expiry. The server never changes to a broader retry, overwrites a newer revision, or starts a duplicate sync merely because the original caller disappeared.

After provider-process retirement, a lost database commit result keeps only that
instance's gate closed. A fresh database read resolves the durable operation
result and current revision: committed state reopens under the new truth, while
an absent result plus the old revision reopens the old snapshot. Continued
database unavailability returns `UNAVAILABLE`; it does not trigger setup's
global fatal-ambiguity rule or blindly replay candidate/provider work.

## Compatibility policy

Both v1 packages follow additive wire compatibility from the first complete Milestone 0 commit. Buf `FILE` breaking checks protect both packages.

- Never renumber or reuse a field or enum value.
- Never change a field's scalar/message type, cardinality, presence, map shape, or oneof membership.
- Never rename or move an existing package, service, method, message, or file in a way that breaks generated clients.
- Removed fields and enum values are reserved by both number and name.
- New optional fields, methods, enum values, and oneof alternatives may be added when old receivers still behave safely.
- Receivers tolerate unknown enum values and unknown oneof alternatives; they use documented fallback behavior rather than crashing or selecting a provider-specific default.
- Tightening validation on an already accepted value is treated as a breaking behavior change even when Buf cannot detect it.
- A deprecated v1 field remains supported until an intentionally designed v2 migration exists.
- An incompatible semantic change requires a new versioned package; an existing field is never silently reinterpreted.

Plugin semantics remain provisional until a second provider proves the abstraction, but provisional does not mean wire-breaking. Semantic corrections are additive or become `nama.plugin.v2`. The public and plugin packages may evolve independently.

Provider configuration schema changes follow the schema compatibility rules above. Ephemeral page tokens, plans, locators, playback sessions, bootstrap tokens, polling tokens, and bearer credentials are deliberately not portable across server versions beyond their advertised lifetime.

## Generation and verification

`buf.yaml` adds pinned dependencies for Protovalidate annotations and the Google APIs definitions used by `google.rpc` and `google.type`, then commits `buf.lock`. A Buf module dependency supplies schemas to the compiler; it is not by itself a language runtime dependency. Connect error details are also out-of-band and therefore do not become normal imports merely because the server attaches them. `buf.gen.yaml` and the native package manifests own packaging explicitly:

- `buf.gen.yaml` is the cleaning local-module template and `buf.gen.googleapis.yaml` is the additive selected-googleapis template; generation stages both in that order and replaces the three committed generated leaves only after both succeed;
- TypeScript generates both `nama.api.v1` and `nama.plugin.v1` messages and clients, includes transitive non-WKT imports such as `google.type` and validation options, generates the selected `google.rpc` messages, and pins the Protobuf/Protovalidate runtime packages in the workspace lockfile;
- Go generates public messages and Connect clients only, excludes dependency-owned message generation, and pins the Google RPC/type and Protovalidate Go modules named by generated imports in `go.mod`; and
- Swift generates public messages and Connect clients only, uses per-plugin `include_imports: true` for transitive non-WKT definitions, generates the selected `google.rpc` messages, and continues to obtain WKTs from SwiftProtobuf.

The TypeScript and Swift imported-source strategy is restricted to transitive
imports of Nama files plus the four selected error messages; it does not
generate every file in the googleapis or Protovalidate modules. Connect client
generation for imported files produces no extra clients because the selected
inputs define messages/options, not services. The googleapis input is pinned to
the same resolved module commit as `buf.lock`. Selected, committed bindings
follow [ADR-0018](../adr/0018-commit-present-consumer-bindings.md): present
consumers compile as an ownership check, while generated Swift remains
drift-checked but is not a client compilation boundary while no universal iOS
application exists.

Generated code stays committed. Repository checks run:

1. Buf format and lint;
2. module build;
3. pinned deterministic generation into disposable staging;
4. direct comparison of the three staged generated leaves with their committed counterparts;
5. TypeScript and Go compile probes against generated clients; the Swift client probe returns with the future universal iOS application;
6. Buf breaking comparison against the pull request base; and
7. a one-time automated proof that a deliberate field removal is rejected.

Nama does not test generated Protobuf or Connect behavior. Buf and the pinned language generators/runtimes own serialization, descriptor construction, unknown-value preservation, and generated API shape. Current generated-contract acceptance consists of schema format/lint/build, deterministic generated-leaf comparison, pull-request-base breaking checks, and compilation by the real TypeScript server/plugin and Go CLI. The future iOS application must restore native Swift consumer compilation for iOS, tvOS, and macOS before its contract boundary is accepted.

Focused contract tests cover handwritten Nama behavior only:

- every generated RPC method appears exactly once in the handwritten default-deny authorization inventory;
- the package-local `PlaybackPreferences` CEL rule executes for valid and invalid CAPPED bit-rate combinations;
- validation inputs normalize to deterministic, capped per-field errors with stable paths and reasons; and
- adapters translate generated transport values into Nama-owned values without leaking provider-private data.

Generated values or descriptors may be inputs to those tests, but serialization round trips, generated symbol inventories, descriptor snapshots, unknown enum/oneof/field preservation, and cross-language parity are not test subjects.

Handler conformance, database persistence, provider fixtures, authorization
execution, idempotency ledgers, pagination token cryptography, and end-to-end
media tests belong to the milestone that implements each behavior. Do not add
fake handlers, fake provider clients, or database scaffolding merely to make
the schemas look exercised.

## End-to-end contract flows

These flows define how the services compose. They are not authorization shortcuts or new endpoints.

### Fresh setup

1. CLI calls `SetupService.GetStatus`.
2. Operator supplies the current-process bootstrap token to `CreateAdministrator`.
3. CLI calls `AuthService.SignIn` and stores the returned administrator bearer outside its profile file.
4. If setup's response was lost, CLI observes `initialized = true` and proceeds directly to sign-in.

### Configure a provider

1. CLI calls `ListProviderTypes` and selects a runtime provider type.
2. It renders fields from the restricted schema and validates locally.
3. It calls `TestProviderConfiguration`; server-side field violations map back to individual controls.
4. It calls `CreateProviderInstance`; the core encrypts write-only values and returns only configured markers.
5. Later edits use a patch plus clear list and the instance revision.

### Pair an Apple device

1. The Apple app calls `BeginPairing`, retains the polling token, and displays the human code.
2. The administrator approves the displayed human code through the CLI.
3. The app polls no faster than instructed until it receives the single logical device credential.
4. The app stores the credential in Keychain and uses it only for consumer RPCs.
5. Administrator revocation immediately blocks new calls made with that bearer.

### Browse and play

1. Scheduled plugin catalog scans return normalized provider observations.
2. The core reconciles and stores canonical items and source mappings.
3. The Apple app loads lean home/list summaries, then details and technical source data only as screens require them.
4. Artwork references are separately resolved to safe refresh-bounded locators, with access expiry when authorization is present.
5. The app sends the current device's real player capabilities and preferences to `PlanPlayback`.
6. The core calls the owning plugin plan method and maps provider track references to public plan IDs.
7. `OpenPlayback` materializes a private provider lease and returns a safe direct descriptor with session-scoped tracks and any external subtitle locators.
8. Media bytes flow from the provider to the app. The app reports ordered telemetry, including observed session tracks, and closes the session.
9. The core commits canonical state, attempts lease cleanup, and schedules only provider exports not already performed by playback telemetry.

### Synchronize watch state

1. The core starts best-effort full scans using opaque continuations and requests a non-watch-state order where the provider supports one.
2. It normalizes observations and reconciles reliable activity, configured priority, local actions, rewatches, and explicit unwatches.
3. It exports only supported explicit targets with per-mutation IDs.
4. Ambiguous provider writes are re-read before retry.
5. Confirmed semantic fingerprints provide best-effort echo suppression; equality checks prevent loops, while later scans still reconcile indistinguishable real actions.
6. `SyncService` exposes progress and sanitized failures to the administrator.

## Explicitly deferred

- Multiple users, invitations, roles, permission editing, and mapping several Nama users to provider users. The immutable single provider-principal binding required by each MVP instance is configuration, not the deferred multi-user mapping model.
- A management web application or provider-specific public endpoint.
- Third-party plugin installation, marketplace metadata, plugin permissions, WASM, or plugin databases.
- Streaming RPCs, durable provider event feeds, REST, GraphQL, and webhook infrastructure.
- A Nama media proxy or exposure of reusable provider credentials.
- Numeric critic/audience ratings, countries, networks, producers, full crew, trailers, extras, chapters, themes, and deep codec diagnostics.
- Ratings, favourites, playlists, downloads, live TV, and offline playback.
- Generic query languages, arbitrary sorts, exact list totals, sync cancellation, and separate pull/push controls.
- Provider configuration conditionals, nested objects, remote schema references, and custom executable validation.
- Incremental watch-state APIs until a provider supplies a documented durable current-state cursor.

## Research basis

This design follows established provider and television behavior without adopting provider wire shapes:

- Apple tvOS interaction and media-detail expectations: [Designing for tvOS](https://developer.apple.com/design/human-interface-guidelines/designing-for-tvos/) and [Apple TV movie and show information](https://support.apple.com/en-ca/guide/tv/atvb0d26676e/tvos).
- AetherEngine's player surface and separate sidecar-subtitle URL/header handling: [README](https://github.com/superuser404notfound/aetherengine/blob/main/README.md) and [format support](https://github.com/superuser404notfound/aetherengine/blob/main/docs/formats.md).
- Better Auth's sign-out implementation, whose caught session-deletion failure must not become a successful Nama response: [sign-out source](https://github.com/better-auth/better-auth/blob/v1.6.26/packages/better-auth/src/api/routes/sign-out.ts#L34-L49). Nama's runtime confirms revocation with an authoritative follow-up lookup.
- Jellyfin's documented surface: [stable OpenAPI](https://api.jellyfin.org/openapi/jellyfin-openapi-stable.json). Current source was also inspected at commit [`1fbd873`](https://github.com/jellyfin/jellyfin/tree/1fbd8739292cce610231be93daf43368733edf63) to distinguish implementation behavior from API guarantees.
- Plex's documented surface: [metadata](https://developer.plex.tv/pms/#section/API-Info/Metadata-Response), [pagination](https://developer.plex.tv/pms/#section/API-Info/Pagination), [scrobble](https://developer.plex.tv/pms/#tag/Timeline/operation/putScrobble), and [timeline reporting](https://developer.plex.tv/pms/#tag/Timeline/operation/timelinePostSlash).
- Standard field-level error details: [`google/rpc/error_details.proto`](https://github.com/googleapis/googleapis/blob/master/google/rpc/error_details.proto#L250-L310).
- Structural validation: [Protovalidate](https://protovalidate.com/) and its Protobuf annotations.
- Imported code-generation behavior: [Buf v2 `buf.gen.yaml`](https://buf.build/docs/configuration/v2/buf-gen-yaml/), including per-plugin `include_imports`.
- Provider form schemas: [JSON Schema 2020-12](https://json-schema.org/draft/2020-12), narrowed to the deterministic profile specified above.

Provider source behavior is evidence for adapter fixtures, not a promise that undocumented behavior will remain stable. The plugin absorbs provider changes while this public contract remains provider-neutral and additive.
