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

## Jellyfin discovery, connection, and targeted library profile

The production Jellyfin executable implements authenticated health, `GetInfo`
for context-free discovery, `GetConnection` for candidate and instance
launches, and targeted `LibraryService.GetItem` for configured instance
launches. It declares provider type `jellyfin`, contract major `1`, and a
restricted schema requiring `base_url`, `user_id`, and write-only `api_key`.
It still declares no media capability: `LIBRARY_READ` remains unadvertised
until the complete supported catalog can be scanned. Startup validates and
persists discovery information before the public provider-type list becomes
available.

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
and receives RPC cancellation. It streams each JSON body under the
caller-selected positive byte limit: connection inspection selects 64 KiB and
the targeted movie read selects 1 MiB. Callers receive only normalized response
categories and parsed records, so raw provider bodies and credential-bearing
request details never enter responses or logs.

`GetItem` reads one explicitly referenced Jellyfin movie for the configured
user. It normalizes required and optional metadata, movie details, supported
matching identifiers, credits, genres, studios, bounded artwork, and every
media source. Each source contains one part; only video, audio, and subtitle
streams become bounded normalized tracks, while source and stream identifiers
remain private references. Filesystem paths, provider objects, authorized
URLs, and arbitrary identifier namespaces are discarded. Missing, forbidden,
unavailable, oversized, malformed, and cancelled reads return only sanitized
Connect outcomes.

The provider-management process flow provisions a controlled Jellyfin endpoint
and reaches it through both public connection-test RPCs using candidate and
exact persisted-instance launches. It verifies cancellation reaches the real
subprocess and provider request, exact-revision observations are conditional,
and public results omit provider credentials and principal references.
Controlled HTTP subprocess coverage also exercises the targeted movie RPC,
source and track normalization, bounded response handling, cancellation,
safe failure codes, and raw-body redaction.

Windows transport and persistent or background native-media plugins remain deferred until a real plugin requires them. Complete catalog scans, artwork resolution, playback, and watch-state behavior belong to issue #30; explicit connection-test commands belong to issue #31; and container packaging belongs to issue #32.

