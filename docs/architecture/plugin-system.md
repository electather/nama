# Plugin system

The first integration boundary is a separate first-party TypeScript executable bundled in the application image, launched and supervised by the core, and called through `nama.plugin.v1` ConnectRPC over an HTTP/1.1 Unix domain socket ([ADR-0006](../adr/0006-stateless-supervised-plugin-subprocesses.md)). The core owns configuration, credentials, deadlines, restarts, logging, schedules, cursors, retries, and all durable state. Plugins advertise only the capabilities they implement and translate provider APIs into Nama messages; they receive no database, queue, migration system, marketplace, installer, WASM host, or stable third-party SDK in the MVP.

## Launch and process identity

The implemented Effect-scoped supervisor validates code-owned executable descriptors, launches each process in a detached process group without inherited environment values, and sends one canonical, versioned UTF-8 JSON launch document of at most 64 KiB through stdin before EOF. Every launch receives a fresh random 32-byte bearer and protected Unix-socket path. The document's discriminated launch kind carries no provider context for discovery, one proposed configuration and credential map for a candidate, or one opaque provider-instance ID, revision, configuration, and credential map for instance operation. Runtime and launch directories use mode `0700`; the socket must be mode `0600` and fit the platform path bound. Startup requires authenticated `HealthService.Check` and `PluginService.GetInfo`, serving health, the expected provider type, and contract major `1` within five seconds.

Acquiring a scoped handle validates its code-owned descriptor without creating a subprocess, socket, or launch artifact. The first valid call lazily starts or joins one shared launch or recovery episode while calls retain their individual deadlines. Every registered plugin RPC requires the current launch bearer and one explicit caller deadline. Cancellation aborts only that request. A supervisor-owned deadline aborts the request, allows one second for cancellation, then recycles the process; sibling calls fail unavailable when that process is replaced. Logical plugin RPC statuses are reduced to a safe code and do not recycle a healthy process. Calls are never transparently replayed. Unexpected exits recover through one shared three-launch episode with `100ms` and `500ms` backoff, and a process healthy for 60 seconds resets the episode budget. Deterministic authentication, identity, contract, socket, descriptor, and launch-protocol rejections do not retry.
Each valid call holds demand from lifecycle selection through RPC completion. When demand returns to zero, the handle starts a fixed 30-second Effect-clock grace period; intervening demand cancels that timer, while expiry stops the complete process group, removes its launch artifacts, and resets the recovery episode before later demand may create a fresh incarnation. Demand arriving after retirement commits joins the shared teardown within its own existing deadline and cannot call or rescue the retiring process.
Candidate handles admit one verification call and then synchronously retire their child and artifacts on success, failure, deadline, or cancellation. Instance supervision shares one lifecycle only for an exact provider-instance ID and revision. Admitting a different revision closes the stale lifecycle to new demand, drains already admitted calls under their existing finite deadlines, requires complete child cleanup, and only then installs the replacement; stale handles remain closed.

Idle cleanup failure is contained as handle lifecycle state. The handle retains its owned process or launch-artifact cleanup target, maps later calls to the existing plugin-unavailable result, emits no automatic retry, and cannot launch a duplicate incarnation. Its scope finalizer bypasses idle grace, joins retirement already in progress, and retries retained cleanup once; persistent failure remains a server-shutdown failure.

Effect scope owns shutdown: signal the complete process group, wait two seconds, escalate to `SIGKILL`, reap it, and remove launch artifacts before the runtime root and database finalize. Stdout is discarded. Stderr accepts only declared newline-delimited JSON records up to 4 KiB with numeric or enumerated fields, levels `debug` through `error`, and a 20-record/second token bucket with burst 40; malformed, undeclared, oversized, and excess records produce at most one safe drop event per launch. Successful idle retirement emits one debug `plugin.process_idle_stopped` record; failed idle cleanup emits one error `plugin.process_idle_stop_failed` record. Lifecycle logs expose only provider identity, attempt, exit, signal, and declared fields—never bearers, socket paths, arguments, environment, configuration, or raw stderr.

The disposable real subprocess fixture verifies all three launch documents, malformed and oversized context rejection, empty child environments, context confinement to stdin, one-shot candidate cleanup, exact instance-revision reuse and fencing, descriptor-only handle acquisition, shared first-demand launch, authenticated transport, bounded recovery, per-call demand and deadlines, idle timing, retirement races, cleanup-failure containment, scope-finalization retry, no replay, process-group termination, safe logging, and artifact cleanup. The production Jellyfin discovery executable is separately exercised through the same supervisor. Resource limits beyond process-group containment, provider-instance connection behavior, schedules, and container packaging remain unimplemented in their owning milestones. Windows transport remains deferred.

The implemented provider launch protocol creates a mode-`0700` runtime directory and gives each launch a new 32-byte bearer and socket path through the single launch document, followed by EOF:

- a discovery process receives no provider configuration and serves health plus `GetInfo`;
- a candidate process receives one proposed configuration, serves one `GetConnection`, and retires immediately; and
- an instance process receives one configured provider instance and revision and may serve nearby calls until its implemented 30-second idle retirement.

The optional provider context carries one provider type, optional Nama-owned instance identity and revision, non-secret configuration, and a separate secret map. Its canonical UTF-8 JSON representation is limited to 64 KiB. It never contains PostgreSQL access, the Nama master key, administrator or device credentials, another instance's data, or public operation IDs. This process-incarnation-scoped snapshot is the precise meaning of operation-scoped configuration: ordinary plugin RPC bodies remain credential-free, while no process crosses stored instance revisions.

The supervisor keys current instance admission by opaque instance ID and exact revision. Provider management loads each transactional configuration and credential snapshot, holds its per-instance writer gate across supervisor retirement and durable update, and prevents a stale revision from reopening after commit. Playback sessions will outlive process incarnations through their opaque session context; synchronization runs will never mix instance revisions.

Every registered RPC requires the per-launch bearer and carries an explicit deadline and cancellation. The core validates untrusted plugin responses before storing or exposing mapped data. Credential loading wipes mutable decrypted byte buffers after launch-document delivery; immutable JavaScript strings are not claimed to be zeroizable, and provider plaintext remains confined to the isolated child until exit or garbage collection.

Public candidate connection tests acquire a one-shot launch and public
stored-instance tests acquire the enabled instance's exact durable revision
through provider-management activity admission. Both propagate request
cancellation and deadlines into `GetConnection`; only a completed
stored-instance result can conditionally update that same revision's
observation.

## Jellyfin discovery, connection, artwork, library, and watch-state profile

The production Jellyfin executable implements authenticated health, `GetInfo`
for context-free discovery, `GetConnection` for candidate and instance
launches, targeted `LibraryService.GetItem`, resumable
`LibraryService.ListItems`, `LibraryService.ResolveArtwork`, targeted
`WatchStateService.GetWatchStates`, resumable
`WatchStateService.ListWatchStates`, and explicit
`WatchStateService.PushWatchStates` watched/unwatched mutations for configured
instance launches. It declares provider type `jellyfin`, contract major `1`,
and a restricted schema requiring `base_url`, `user_id`, and write-only
`api_key`. Static information and successful configured connections advertise
`LIBRARY_READ`, `ARTWORK_RESOLVE`, `WATCH_STATE_READ`, and `WATCHED_WRITE`.
Startup validates and persists discovery information before the public
provider-type list becomes available.

`GetConnection` first reads unauthenticated public system information, then
reads the explicitly configured user with Jellyfin's credentialed
authorization header. A connected result requires a non-empty server identity,
the returned configured user on that same server, and a non-disabled user. The
plugin hashes the canonical server/user pair into one versioned opaque
provider-principal reference; the core immediately converts that reference to
the non-recoverable binding digest required by
[ADR-0021](../adr/0021-immutable-provider-principal-binding.md) and
[ADR-0028](../adr/0028-domain-separated-provider-protection.md).

Jellyfin base URLs accept HTTP or HTTPS private, link-local, loopback, local,
or single-label destinations with at most one path prefix. They reject
credentials, query strings, fragments, public destinations, and additional
path segments.

One concrete Jellyfin request module builds endpoints from encoded path
segments and code-owned query names, confines them to the configured origin
and prefix, applies the API key only to authenticated calls, rejects redirects,
and receives RPC cancellation. Artwork probes use anonymous `HEAD` against the
exact reconstructed endpoint and never receive the request module's provider
authorization. JSON operations stream each body under the caller-selected
positive byte limit: connection inspection selects 64 KiB, targeted item reads
select 1 MiB, and catalog, watch-state scan, targeted watch-state read, and
mutation responses select 16 MiB.
Targeted watch-state reads and independent writes each admit at most four
provider responses concurrently so the per-response bound cannot
multiply across the complete 100-member request. Callers receive only
normalized response categories and parsed records, so raw provider bodies and
credential-bearing request details never enter responses or logs.

`GetItem` reads one explicitly referenced supported Jellyfin movie, show,
season, or episode for the configured user. It normalizes required and optional
metadata, kind details, supported matching identifiers, credits, genres,
studios, and bounded artwork. Shows and seasons remain non-playable hierarchy
observations. Positive-numbered seasons retain their opaque show reference;
positive-numbered episodes retain opaque show and season references and
normalize every media source through the same source, part, and track rules as
movies. Season-zero specials are deliberately unsupported. Filesystem paths,
provider objects, authorized URLs, and arbitrary identifier namespaces are
discarded. Missing, forbidden, unavailable, oversized, malformed, and
cancelled reads return only sanitized Connect outcomes.

`ListItems` requests one recursive, non-watch-state `SortName` pass containing
only movies, series, seasons, and episodes. It defaults zero page size to 50,
accepts at most 100, deliberately drops unsupported families and season-zero
specials, and normalizes every retained item through the targeted-read path.
Completion follows provider page length rather than mutable totals, so an exact
page multiple requires a final empty call.

Each catalog or watch-state begin call creates an independent random scan
identity and one 24-hour continuation expiry. The versioned canonical JSON
continuation authenticates its operation and query scope, scan identity,
provider instance and exact revision, page size, offset, and expiry with
HMAC-SHA-256 under an API-key-derived operation-domain-separated key. Catalog
and watch-state scopes cannot reuse each other's tokens. A token contains no
credential or plugin-owned durable state. A later same-revision process can
resume it; tampering, expiry, another scope or instance, credential replacement,
and revision replacement fail `INVALID_ARGUMENT` before a provider read.

Artwork observations use a versioned opaque payload containing only one
allowlisted Jellyfin image type, bounded non-negative index, and bounded cache
tag; the item reference remains in its existing private field. Resolution
reconstructs the item-image endpoint beneath the configured prefix, applies
requested non-zero maximum dimensions, and accepts only an anonymous
non-redirected success with a bounded `image/*` MIME type. The resulting lease
has no headers or access expiry, uses `PUBLIC` authorization scope, and
allowlists only the configured origin. Missing, protected, redirected,
unsafe-origin, invalid-content, oversized-MIME, unavailable, malformed
reference, and cancelled cases return only sanitized Connect outcomes.

The provider-management process flow provisions a controlled Jellyfin endpoint
and reaches it through both public connection-test RPCs using candidate and
exact persisted-instance launches. It verifies cancellation reaches the real
subprocess and provider request, exact-revision observations are conditional,
and public results omit provider credentials and principal references.
Controlled HTTP subprocess coverage exercises targeted movie, show, season,
episode, artwork, and watch-state RPCs plus catalog and watch-state begin,
continuation after idle process replacement, exact-page completion, hierarchy,
source, track, and watch-state normalization, bounded response handling,
anonymous exact-resource probes, cancellation, safe failure codes, and
raw-body and credential redaction.

Targeted watch-state reads return one result per requested private item
reference in order. Existing movies and episodes normalize watched state,
positive resume position, known duration, one receipt time, and only heuristic
unknown-semantics Jellyfin activity. Missing, forbidden, retryable, and
permanent member failures remain distinct; no provider revision is invented.

`ListWatchStates` requests one recursive, non-watch-state `SortName` pass
containing only movies and episodes. It defaults zero page size to 50, accepts
at most 100, enables configured-user data, and normalizes every item through
the targeted-read path, including provider-default unwatched observations.
Missing user data fails visibly rather than becoming unwatched. Completion
follows provider page length rather than mutable totals, so an exact page
multiple requires a final empty call.

Explicit watched and unwatched targets first consume one bounded targeted-read
batch. Equal targets return the normalized observation without a provider
write. Unique, independent differing targets use at most four concurrent
Jellyfin absolute played/unplayed writes while results remain in request order;
duplicate mutation IDs or item targets are invalid per member. Structurally
valid exact-progress targets are unsupported without provider traffic, while
malformed targets are invalid. The pre-read batch and each write response
receive at most half the remaining caller deadline. An internally timed-out
pre-read normalizes as `RETRYABLE_FAILURE` per member; direct caller
cancellation remains a generated-RPC cancellation. The write bound preserves
readback budget after a timed-out, potentially committed mutation. A lost or
timed-out response, or a malformed or oversized successful response, causes one
targeted readback. An observed target succeeds; an unresolved target remains
retryable ambiguity, and the plugin never replays the possibly committed write.

Static plugin information and successful configured connections advertise
`WATCH_STATE_READ` and `WATCHED_WRITE` from this implemented profile. Missing,
forbidden, retryable, permanent, ambiguous, malformed, oversized, and cancelled
paths retain sanitized generated-RPC outcomes without exposing provider bodies,
identifiers, or authorization.

Windows transport and persistent or background native-media plugins remain
deferred until a real plugin requires them. Core-owned synchronization
execution remains in issue #30. Production playback belongs to issue #96,
coherent exact progress export belongs to issue #97, and container packaging
belongs to issue #32.
