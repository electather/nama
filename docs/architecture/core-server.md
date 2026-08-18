# Core server

Status: the bootable lifecycle, production persistence, durable initialization, bootstrap-token boundary, Connect setup/authentication runtime, and authenticated plugin-subprocess supervisor are implemented and verified.

This note is the canonical record for durable core-server boundaries. The implementation under `apps/server/` owns mechanics.

## Current boundary

`@nama/server` is an executable Node process and one Effect modular monolith. Its implemented boundary owns:

- immutable TOML configuration and an explicit environment override allowlist;
- safe structured Effect and allowlisted terminal RPC logging;
- one PostgreSQL pool, one schema-aware Drizzle instance, and a narrow private authentication capability;
- automatic reviewed migrations, transactional fail-closed initialization reconciliation, and bounded readiness probes;
- the process-local bootstrap-token state machine and transactional administrator completion;
- exact liveness and readiness routes before Connect delegation;
- one native Node listener and one Effect managed request runtime for health and RPC callbacks;
- runtime-controlled readiness and fatal post-bind failure;
- one Effect-scoped authenticated plugin-subprocess supervisor; and
- deterministic signal shutdown, bounded drain, process-group termination, and resource finalization.

The private runtime-loaded Better Auth adapter implements administrator creation, sign-in, bearer resolution, current-user mapping, and confirmed sign-out without mounting Better Auth routes ([ADR-0007](../adr/0007-private-better-auth-adapter.md)). All generated public services are registered behind the explicit default-deny authority inventory; only Setup and Auth behavior is implemented, while other descriptors remain denied or reach Connect's `UNIMPLEMENTED` response only after authorization. The private plugin transport now launches, authenticates, handshakes with, calls, recovers, and terminates code-owned subprocesses, but no production provider descriptor or plugin method workflow is registered. Pairing, CLI setup/sign-in, client behavior, provider persistence, schedules, and exported tracing remain outside this runtime.

## Architecture decisions

The server uses Node.js 24, strict TypeScript, ESM, exact-pinned Effect v4, PostgreSQL through Drizzle over `pg`, and pnpm. Vitest and `@effect/vitest` own TypeScript behavior tests.

A native Node listener owns operational-route precedence, request-fiber interruption, idle connection closure, bounded drain, and forced connection closure ([ADR-0002](../adr/0002-native-node-http-lifecycle.md)). A future transport abstraction may replace it only if it preserves that lifecycle and supplies a current second use.

Effect owns composition, scopes, interruption, logging, expected failures, and shutdown ([ADR-0001](../adr/0001-effect-application-graph.md)). Node HTTP, `pg`, Drizzle, Connect, and Better Auth remain narrow adapters at module edges. There is no second dependency-injection system.

Under [ADR-0010](../adr/0010-postgresql-drizzle-persistence-boundary.md), Drizzle stays on the shared `pg.Pool`; do not introduce `@effect/sql-pg`. Wrap Promise-based database operations once inside the Effect module that owns the operation.

The implemented dependency graph is:

```text
main -> app
app -> config + logging + database + lifecycle + authentication + plugin + http
logging -> config
database -> config
plugin -> Node subprocess/process-group + private plugin.v1 Connect transport
authentication -> config + database + lifecycle + bootstrap token
http -> config + database + lifecycle + authentication
```

`src/main.ts` launches the root Effect once and selects process exit status. `src/app.ts` owns graph construction and startup ordering. Runtime responsibilities live under `src/config/`, `src/logging/`, `src/database/`, `src/setup/`, `src/authentication/`, `src/lifecycle/`, `src/plugin/`, and `src/http/`; generated-contract policy lives independently under `src/contracts/`. Fallow covers every TypeScript file and enforces this acyclic direction.

Organize server code by concrete responsibility, not technical layer or file size. Split an owner only when it has independently changing responsibilities; there is no line-count limit. Keep `database/` cohesive until implemented behavior proves another owner is needed. Imports name concrete modules; do not add `index.ts` barrels.

Keep validation, overlay mapping, route decisions, error classification, and state transitions beside their owner. Do not create generic `core`, `utils`, `shared`, `repositories`, `interfaces`, or central error modules. Introduce an interface only when a second real implementation exists.

Exports stay minimal. Raw TOML, environment snapshots, parser errors, `pg.Pool`, Drizzle migration internals, request fibers, and sockets remain private. Tests must not widen production seams: behavior tests and support live in the `tests/` subdirectory of the smallest `src/` owner, while only disposable-PostgreSQL and real-process behavior lives under `integration/tests/`. Production modules never import test support.

## Invariants

1. Configuration is read and decoded once, then remains immutable for the process lifetime.
2. The listener does not bind until configuration, database acquisition, migrations, durable initialization reconciliation, an initial database probe, and plugin-supervisor runtime-root acquisition succeed.
3. There is one pool, one Drizzle instance, one callback runtime, and one listener.
4. The database pool is never exposed as an application service.
5. Startup performs no retry for connection, migration, or other writes.
6. Readiness can recover after transient database loss without replacing the pool or restarting the process.
7. Finalizers release only acquired resources and remain safe after partial startup.
8. Configuration secrets, database details, raw external failures, locator data, and arbitrary exception fields never cross errors, logs, spans, or health responses.
9. Effect-local spans are process-internal diagnostics, not an exported or propagated tracing contract.
10. New runtime behavior goes in its current owner and preserves the enforced dependency direction.

## Configuration contract

`NAMA_CONFIG` selects the TOML file and defaults to `/etc/nama/nama.toml`. The selected file must exist and is read once through Effect's filesystem service. An empty `NAMA_CONFIG` is an invalid selected path.

Loading order is fixed:

1. read the selected file;
2. parse the complete TOML document into unknown data;
3. overlay each present allowlisted content override;
4. decode the complete value once with Effect Schema; and
5. freeze the decoded configuration and provide it to the graph.

Only these content overrides exist:

| Environment variable | Configuration field   |
| -------------------- | --------------------- |
| `NAMA_DATABASE_URL`  | `database.url`        |
| `NAMA_MASTER_KEY`    | `security.master_key` |
| `NAMA_BIND`          | `server.bind`         |
| `NAMA_PUBLIC_URL`    | `server.public_url`   |
| `NAMA_LOG_LEVEL`     | `logging.level`       |

Do not derive environment names or scan a prefix. In particular, no environment value can change `database.max_connections`. An empty content override is present input and fails when the target field disallows it.

Required values are `server.public_url`, `database.url`, and `security.master_key`. Defaults are:

- `server.bind`: `0.0.0.0:8080`;
- `database.max_connections`: `10`; and
- `logging.level`: `info`.

Validation rejects unknown keys at every object level. It also enforces:

- a hostname or IPv4 address plus a port, or bracketed IPv6 plus a port, with ports from 1 through 65535; hostnames are validated but not resolved during decoding;
- an absolute HTTP or HTTPS public URL with no credentials, query, fragment, or path other than `/`;
- a non-empty database URL, while `pg` remains responsible for connection-string semantics;
- a connection limit from 1 through 100;
- a canonical standard `base64:` master key that decodes to exactly 32 bytes; and
- log level `trace`, `debug`, `info`, `warn`, `error`, or `fatal`.

TOML dates, arrays, tables, and other values fail where the schema expects a different type. `database.url` and `security.master_key` decode directly to Effect `Redacted` values. Never attach parser input, raw schema output, selected paths, or secret values to errors or log annotations. Restart remains the only way to apply configuration changes.

## Startup and database ownership

Startup is strictly ordered:

```text
read and decode configuration
  -> install configured logging
  -> acquire and verify the shared pg pool
  -> construct Drizzle and apply migrations
  -> transactionally reconcile durable initialization
  -> run the initial SELECT 1 probe
  -> acquire the protected plugin-supervisor runtime root
  -> construct bootstrap, private authentication, setup, runtime-control, and request-runtime services
  -> bind the native HTTP listener with health-first Connect dispatch
  -> synchronously activate bootstrap output
  -> mark runtime ready, emit server.ready, and wait for interruption or fatal runtime failure
```

The production migration directory is resolved relative to the server module, never the current working directory. Tests inject independent migration fixture directories through layer construction; migration location is not operator configuration.

`apps/server/better-auth.config.ts` is the sole owner of Better Auth models and fields, and `apps/server/src/database/auth-schema.ts` is committed Better Auth CLI output that must never be hand-edited. The configuration remains tooling-only: schema generation selects the database shape without a live runtime adapter. The private runtime adapter separately receives the generated schema and the database's narrow capability; neither Better Auth migration nor route handling runs in the server.

`schema.ts` hand-defines only Nama's initialization state. Drizzle owns the reviewed SQL, migration journal, and runtime application over the shared pool; a database carrying the prior zero-entry journal upgrades exactly once, and missing or malformed migration metadata is fatal.

The database module owns pool creation, schema-aware Drizzle construction, migrations, initialization reconciliation, probes, and normalization of database failures. It exposes immutable startup classification and Nama-owned readiness operations, plus a private authentication capability containing the existing Drizzle instance and conditional durable-marker completion. It does not expose a generic query service or repository abstraction.

The MVP runs one core process. Drizzle bookkeeping is sufficient; do not add advisory locks, distributed migration coordination, Redis, or a job framework before multi-process deployment is accepted.

### Durable persistence and initialization

The committed generated auth schema and reviewed SQL provide the Better Auth core `user`, `session`, `account`, and `verification` tables alongside one Nama-owned `nama_server_state` singleton. The private adapter uses that shared schema and pool only through the database capability; [authentication and setup](authentication-and-setup.md) owns the application-facing consequences.

The initialization marker admits only the fixed `server` key. Its initialization time and administrator user reference are either both absent or both present, and the administrator reference restricts deletion. No application operation deletes the singleton, clears either field, or resets setup eligibility. A missing singleton is corruption rather than a fresh deployment.

Startup locks and classifies the marker and a bounded view of users in one transaction:

| Initialization marker |     Better Auth users | Outcome                                                                        |
| --------------------- | --------------------: | ------------------------------------------------------------------------------ |
| initialized           |           exactly one | continue configured                                                            |
| initialized           | zero or more than one | fatal integrity error; setup never reopens                                     |
| uninitialized         |                  zero | continue setup-eligible                                                        |
| uninitialized         |           exactly one | conditionally repair both marker fields to that user, then continue configured |
| uninitialized         |         more than one | fatal integrity error                                                          |
| missing               |             any count | fatal integrity error                                                          |

The single-user repair records database transaction time and the administrator reference together ([ADR-0008](../adr/0008-fail-closed-setup-reconciliation.md)); any failed or ambiguous conditional update is fatal. No startup write is retried, and corruption never falls back to setup eligibility. Database details, SQL, table contents, user identifiers, and underlying failures remain inside the database boundary.

### Readiness

The readiness probe performs `SELECT 1` with both PostgreSQL query timeout and Effect timeout bounded to two seconds. It returns only ready or unavailable to the HTTP layer. SQL text, PostgreSQL messages, hostnames, database names, and connection values stop at the database boundary.

A failed probe does not close or replace the pool. Normal `pg` reconnection allows a later probe to restore readiness. The server logs `database.readiness_changed` on the first observed state and subsequent transitions only; health traffic is not logged at info level.

## HTTP transport ([ADR-0002](../adr/0002-native-node-http-lifecycle.md))

The listener dispatches in this order:

| Request | Response |
| --- | --- |
| exact `GET /health/live` | 200 when the listener can answer |
| exact `GET /health/ready` while accepting, runtime-ready, and PostgreSQL is reachable | 200 |
| exact `GET /health/ready` while shutting down, runtime-unready, or PostgreSQL is unavailable | 503 |
| every other target | server-owned request ID, then Connect delegation or 404 fallback |

Targets containing a query string or trailing slash are not exact health matches. Health responses retain their empty body and `Content-Length: 0`; liveness performs no dependency work, and readiness checks local accepting and runtime state before its bounded database probe. For delegated traffic the outer Node dispatch assigns `nama-request-id` before decoding, so malformed Connect input and application responses have a server-owned correlation header. Exact health precedence, one-listener ownership, and one managed request runtime remain invariant.

## Failure and logging contract

Expected failures are tagged beside their owner:

- configuration: `ConfigReadError`, `ConfigParseError`, `ConfigValidationError`;
- database: `DatabaseConnectionError`, `MigrationError`, `DatabaseIntegrityError`;
- setup: `BootstrapTokenInitializationError`;
- plugin supervision: `PluginUnavailable`, `PluginDeadlineExceeded`, `PluginRpcError`, `PluginSupervisorBoundaryError`, `PluginSupervisorCleanupError`; and
- transport: `ServerBindError`, `ShutdownError`.

There is no central error module. Safe tagged-error data is limited to the stable tag, optional allowlisted configuration field path, and optional TOML line and column. Raw parser, PostgreSQL, Node, Drizzle, and Better Auth errors are normalized at their adapter boundary.

A configuration, connection, migration, integrity, runtime-construction, bind, or bootstrap-activation failure emits exactly one safe `server.start_failed` record, releases acquired resources, leaves no listener, and exits non-zero. Failures before configured logging exists use one minimal JSON record on stderr. Later startup failures use the configured Effect logger on stdout. Effect's default cause reporting remains disabled so it cannot emit a second unsafe record.

Normal logs are newline-delimited JSON on stdout. The configured threshold applies after configuration is decoded. Stable server lifecycle events are:

- `server.ready`;
- `server.stopping`;
- `server.stopped`;
- `server.start_failed`;
- `server.shutdown_failed`; and
- `database.readiness_changed`.

Plugin supervision additionally emits `plugin.recovery_attempt`, `plugin.process_exited`, `plugin.rpc_deadline_exceeded`, `plugin.recovery_exhausted`, `plugin.stderr_dropped`, and code-declared plugin events. Plugin lifecycle fields are restricted to `provider_type`, `provider_instance_id`, `recovery_attempt`, `exit_code`, and `signal`; code-declared plugin fields are finite numbers or allowlisted enum values. Bearers, socket paths, executable arguments, environment, configuration, raw stderr, and arbitrary process errors never enter records.

Expected failures expose no arbitrary exception message or cause. An unexpected defect may include bounded stack frames after removing the exception message; sanitation must never serialize enumerable exception properties. Fatal post-bind failure emits exactly one `server.runtime_failed` record at `fatal` severity, so configured `warn`, `error`, and `fatal` thresholds cannot suppress the sole record.

The only secret-output exception is exactly one direct stdout line, `NAMA_BOOTSTRAP_TOKEN=<token>\n`, after a setup-eligible listener binds. It bypasses Effect logging and JSON record construction through one checked synchronous write; a short or failed write is not retried because a partial output could be ambiguous. Startup then fails before `server.ready`.

Never log bind address, public URL, database URL, master key, source TOML, SQL, environment values, request bodies, arbitrary headers, credentials, bootstrap tokens, locator URLs, or locator headers. Terminal RPC logs use only the request ID, fully qualified method, Connect code, and duration; Effect spans do not become distributed tracing.

Do not add OpenTelemetry, OTLP, trace-header propagation, sampling, exporters, a metrics backend, or trace/span IDs to the stable log contract without a separately accepted operational need.

## Shutdown

`SIGINT` and `SIGTERM` interrupt the root Effect. Normal signal interruption exits zero.

Shutdown order is fixed:

```text
mark accepting false
  -> emit server.stopping
  -> stop accepting new connections and close idle connections
  -> drain in-flight requests for at most 10 seconds
  -> interrupt remaining request Effects
  -> force-close remaining HTTP connections
  -> dispose the request ManagedRuntime
  -> terminate and reap active plugin process groups
  -> remove plugin launch directories and the supervisor runtime root
  -> close the PostgreSQL pool
  -> emit server.stopped after the full resource graph finalizes successfully
```

An already-established connection sees readiness become 503 as soon as accepting is false, without a database probe. Finalizers are idempotent and tolerate partial acquisition. A finalizer failure emits `server.shutdown_failed` and exits non-zero.

## Implemented setup and authentication runtime ([ADR-0007](../adr/0007-private-better-auth-adapter.md), [ADR-0008](../adr/0008-fail-closed-setup-reconciliation.md))

The process-local bootstrap boundary retains one digest-backed, single-flight token after a setup-eligible listener binds. It is invalidated on successful completion or any possible commit; cancellation before that boundary restores the claim. `CreateAdministrator` validates the token before password hashing, keeps automatic sign-in disabled, creates the administrator through the private adapter, and conditionally completes both durable marker fields. A confirmed result closes setup and returns no session. An ambiguous authentication or marker outcome disables setup, makes runtime readiness false, and causes non-zero exit so startup reconciliation, rather than a retry, determines durable truth.

After fatal setup-commit ambiguity, this process's `GetStatus` fails `UNAVAILABLE/SETUP_UNAVAILABLE` until exit and never returns `initialized=false`. While a bootstrap attempt is active, only its matching token returns `ABORTED/SETUP_IN_PROGRESS`; every other candidate returns `UNAUTHENTICATED/AUTHENTICATION_FAILED`.

Only the private authentication adapter loads Better Auth. Better Auth routes, cookies, request/response models, errors, secrets, raw sessions, and raw tokens neither cross that boundary nor mount on the public listener. Its secret derives from the redacted master key with HKDF-SHA-256 and context `nama/better-auth/v1`; the generated schema, shared pool, PostgreSQL transactions, signed bearer tokens, and Better Auth's session lifecycle remain private implementation concerns.

Generated public services are registered through `connectNodeAdapter` behind the health dispatcher. Connect cancellation and deadlines interrupt their tracked Effect request; shutdown drains those same health and RPC fibers through the one managed runtime. The request pipeline applies setup-state precedence, default-deny authorization, validation, sign-in limits, Nama-owned errors, and one allowlisted terminal record. Valid administrators exist only in request context.

`SetupService.GetStatus` and `CreateAdministrator`, plus `AuthService.SignIn`, `GetCurrentUser`, and `SignOut`, are implemented. Sign-in returns only the signed bearer credential and administrator; there is no refresh-token protocol. Sign-out returns success only after the durable store no longer resolves the presented bearer. Deletion or confirmation ambiguity returns `UNAVAILABLE/SESSION_REVOCATION_UNCONFIRMED`, and the caller resolves it through `GetCurrentUser`. Application failures carry stable Nama details and the same request ID as the response header; they never expose database messages, Better Auth errors, credentials, configuration, or stacks. Writes are not retried automatically.

## Verification contract

The server test gate must continue to exercise behavior, not only generated contracts or compilation:

- pure and Effect-scoped configuration, logging, routing, drain, deadline interruption, and finalization behavior;
- a real disposable plugin subprocess covering protected launch material, bearer authentication, handshake rejection, bounded recovery, cancellation, deadlines, no replay, structured stderr, process-group escalation, and artifact cleanup;
- serial integration against disposable PostgreSQL with production migrations, prior-journal upgrade, constraints, the complete initialization state matrix, conditional repair failure, pool closure, and readiness loss/recovery;
- the actual package entrypoint, both termination signals, migration-and-reconciliation-before-bind ordering, released listener ports, normalized startup and integrity failures, valid JSON output, and secret absence; and
- root TypeScript checks that execute the complete server suite.

Integration PostgreSQL must use an isolated Compose project, dynamically published host port, and disposable volume; it must never touch the developer database. A compile-only check or generated Protobuf round trip is not server runtime proof.

The implemented coverage exercises generated-client and real-process setup/authentication flows plus the private plugin-supervision transport: token consumption and reuse rejection, concurrent administrator creation, durable-marker completion and restart repair, ambiguous-commit handling, sign-in limits, bearer lifecycle, confirmed and unconfirmed sign-out, plugin launch authentication and authority rotation, recovery, call cancellation and deadlines, process-group cleanup, correlation, safe public errors and logs, readiness, and fatal runtime exit.

## Deferred work

Configuration reload, startup retries, multiple administrators, signup, password recovery, OAuth/OIDC, roles, a web administration app, multi-process migration coordination, Redis, worker pools, a job framework, exported tracing, and an observability backend remain deferred until a concrete accepted use case requires them. Production provider descriptors and workflows, on-demand or idle policy, persistence and credentials, Jellyfin behavior, pairing, media, playback, and synchronization belong to their owning milestones.
