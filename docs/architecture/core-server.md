# Core server

Status: the bootable server lifecycle from issue #20 is implemented and verified. The persistence, bootstrap, and Connect/authentication extensions in issues #21–#23 remain approved Milestone 2 work and are not implemented.

This note is the canonical record for durable core-server boundaries. The implementation under `apps/server/` owns mechanics; the completed [issue #20 design](../design/2026-08-14-bootable-effect-core-design.md) records implementation detail and evidence, not a second runtime contract.

## Current boundary

`@nama/server` is an executable Node process and one Effect modular monolith. The implemented foundation owns:

- immutable TOML configuration and an explicit environment override allowlist;
- safe structured Effect logging;
- one PostgreSQL pool and one Drizzle instance;
- automatic migration application before bind;
- exact liveness and readiness HTTP routes;
- one native Node listener and one Effect managed runtime for callbacks; and
- deterministic `SIGINT` and `SIGTERM` shutdown.

The current process has no production tables, Better Auth adapter, administrator setup, Connect service registration, RPC handlers, plugin supervision, retries, configuration reload, metrics, or exported tracing. Until issue #23 adds Connect delegation, every HTTP request other than the two exact health routes returns 404. Generated contracts compiling does not prove any of those runtime behaviors exist.

## Architecture decisions

The server uses Node.js 24, strict TypeScript, ESM, exact-pinned Effect v4, PostgreSQL through Drizzle over `pg`, and pnpm. Vitest and `@effect/vitest` own TypeScript behavior tests.

Hono remains removed. The native Node listener is deliberate: Nama owns operational-route precedence, request-fiber interruption, idle connection closure, bounded drain, and forced connection closure. A future transport abstraction may replace it only if it preserves that lifecycle and supplies a current second use.

Effect owns composition, scopes, interruption, logging, expected failures, and shutdown. Node HTTP, `pg`, Drizzle, and later Connect or Better Auth remain narrow adapters at module edges. There is no second dependency-injection system.

Keep Drizzle on the shared `pg.Pool`; do not introduce `@effect/sql-pg`. Wrap Promise-based database operations once inside the Effect module that owns the operation.

The implemented dependency graph is:

```text
main -> app
app -> config + logging + database + server
logging -> config
database -> config
server -> config + database
```

`main.ts` launches the root Effect once and selects process exit status. `app.ts` owns construction and startup ordering. `config.ts`, `logging.ts`, `database.ts`, and `server.ts` each own their named policy. Contract probe files remain independent from runtime modules. Fallow must continue to cover every source file and enforce this acyclic direction as new modules are added.

Keep validation, overlay mapping, route decisions, error classification, and state transitions as plain functions beside their owner. Do not create generic `core`, `utils`, `repositories`, `interfaces`, or central error modules. Split a module only after it gains multiple coherent reasons to change; introduce an interface only when a second real implementation exists.

Exports stay minimal. Raw TOML, environment snapshots, parser errors, `pg.Pool`, Drizzle migration internals, request fibers, and sockets remain private. Tests use the owning service or the real process rather than widening production exports.

## Invariants

1. Configuration is read and decoded once, then remains immutable for the process lifetime.
2. The listener does not bind until configuration, database acquisition, migrations, and an initial database probe succeed.
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

| Environment variable | Configuration field |
| --- | --- |
| `NAMA_DATABASE_URL` | `database.url` |
| `NAMA_MASTER_KEY` | `security.master_key` |
| `NAMA_BIND` | `server.bind` |
| `NAMA_PUBLIC_URL` | `server.public_url` |
| `NAMA_LOG_LEVEL` | `logging.level` |

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
  -> run the initial SELECT 1 probe
  -> construct the shared request ManagedRuntime
  -> bind the native HTTP listener
  -> emit server.ready and wait for interruption
```

The production migration directory is resolved relative to the server module, never the current working directory. Tests inject independent migration fixture directories through layer construction; migration location is not operator configuration.

The current production journal is valid and has zero entries. Missing or malformed migration metadata is fatal. Issue #21 adds reviewed production schema and SQL migrations without changing the pre-bind migration rule.

The database module owns pool creation, Drizzle construction, migrations, probes, and normalization of database failures. Consumers receive only Nama-owned Effect operations. Issue #21 may pass the private Drizzle instance to the private Better Auth adapter, but it must not expose a generic query service or repository abstraction.

The MVP runs one core process. Drizzle bookkeeping is sufficient; do not add advisory locks, distributed migration coordination, Redis, or a job framework before multi-process deployment is accepted.

### Readiness

The readiness probe performs `SELECT 1` with both PostgreSQL query timeout and Effect timeout bounded to two seconds. It returns only ready or unavailable to the HTTP layer. SQL text, PostgreSQL messages, hostnames, database names, and connection values stop at the database boundary.

A failed probe does not close or replace the pool. Normal `pg` reconnection allows a later probe to restore readiness. The server logs `database.readiness_changed` on the first observed state and subsequent transitions only; health traffic is not logged at info level.

## HTTP transport

The listener dispatches only:

| Request | Response |
| --- | --- |
| exact `GET /health/live` | 200 when the listener can answer |
| exact `GET /health/ready` while accepting and PostgreSQL is reachable | 200 |
| exact `GET /health/ready` while shutting down or PostgreSQL is unavailable | 503 |
| every other method or target | 404 |

Targets containing a query string or trailing slash are not exact matches. Every response has an empty body and `Content-Length: 0`; health routes have no response schema or content type. Liveness performs no dependency work. Readiness checks local accepting state before touching PostgreSQL.

Health callbacks run through one shared `ManagedRuntime`, so request Effects have the same interruption and shutdown ownership as future handlers. The runtime currently contains only the services required by health handling. Issue #23 must extend this runtime and delegate unmatched requests to the supported Connect Node adapter rather than create a second runtime or listener. Exact health-route precedence and listener ownership must not change.

## Failure and logging contract

Expected failures are tagged beside their owner:

- configuration: `ConfigReadError`, `ConfigParseError`, `ConfigValidationError`;
- database: `DatabaseConnectionError`, `MigrationError`; and
- transport: `ServerBindError`, `ShutdownError`.

There is no central error module. Safe tagged-error data is limited to the stable tag, optional allowlisted configuration field path, and optional TOML line and column. Raw parser, PostgreSQL, Node, Drizzle, and later Better Auth errors are normalized at their adapter boundary.

A configuration, connection, migration, runtime-construction, or bind failure emits exactly one safe `server.start_failed` record, releases acquired resources, leaves no listener, and exits non-zero. Failures before configured logging exists use one minimal JSON record on stderr. Later startup failures use the configured Effect logger on stdout. Effect's default cause reporting remains disabled so it cannot emit a second unsafe record.

Normal logs are newline-delimited JSON on stdout. The configured threshold applies after configuration is decoded. Stable lifecycle events are:

- `server.ready`;
- `server.stopping`;
- `server.stopped`;
- `server.start_failed`;
- `server.shutdown_failed`; and
- `database.readiness_changed`.

Current lifecycle log fields are limited to `timestamp`, `level`, `event`, `duration_ms`, `error_tag`, and `sanitized_stack_frames`. Expected failures expose no arbitrary exception message or cause. An unexpected defect may include bounded stack frames after removing the exception message; sanitation must never serialize enumerable exception properties.

Never log bind address, public URL, database URL, master key, source TOML, SQL, environment values, request bodies, arbitrary headers, credentials, locator URLs, or locator headers. Issue #23 adds Nama request and correlation IDs for RPC logs independently; it does not turn Effect spans into distributed tracing.

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
  -> close the PostgreSQL pool
  -> emit server.stopped after the full resource graph finalizes successfully
```

An already-established connection sees readiness become 503 as soon as accepting is false, without a database probe. Finalizers are idempotent and tolerate partial acquisition. A finalizer failure emits `server.shutdown_failed` and exits non-zero.

## Approved Milestone 2 extensions

These sections remain active specifications for unfinished work. Implementing one issue must preserve the bootable lifecycle above and must not claim later issue behavior.

### Issue #21: persistence and initialization marker

Add reviewed Better Auth tables and one `nama_server_state` singleton row. The row has a fixed key, nullable `initialized_at`, and nullable `administrator_user_id`. Once set, initialization cannot be cleared by an application operation, and the administrator reference restricts deletion.

Startup repair remains fail-closed:

| Initialization marker | Better Auth users | Outcome |
| --- | ---: | --- |
| initialized | exactly one | configured |
| initialized | zero or more than one | fatal integrity error; setup never reopens |
| uninitialized | zero | setup mode |
| uninitialized | exactly one | repair the marker to that user, then continue configured |
| uninitialized | more than one | fatal integrity error |

The single-user repair handles a crash after Better Auth commits the administrator but before Nama commits its marker. Production schema changes come from Drizzle definitions and committed, reviewed SQL; generated migrations still run before bind.

### Issue #22: one-time administrator bootstrap

On each unconfigured start, generate 32 cryptographically random bytes and render them as base64url. Emit exactly one operator-console line:

```text
NAMA_BOOTSTRAP_TOKEN=<token>
```

This is the sole deliberate secret-output exception and bypasses structured logging. Never repeat the token or attach it to an error or span. Retain only its SHA-256 digest in memory; never store the token in PostgreSQL. Restart replaces every unused token.

Administrator creation is single-flight. Validate the token before password hashing, compare fixed-size digests in constant time, and disable setup in process as soon as user creation can have committed. A failure before user creation leaves the token valid. If user creation commits but marker persistence fails or is ambiguous, remain unready and exit so startup repair resolves the durable state; never reopen setup for a second administrator.

### Issue #23: Connect setup and authentication

Only the private authentication adapter may import Better Auth. Better Auth routes, cookies, request/response models, errors, and secrets never cross that module boundary and are never mounted directly. Derive its secret from the redacted master key with HKDF-SHA-256 and context `nama/better-auth/v1`.

Register generated Nama Connect handlers through `connectNodeAdapter` behind the existing health dispatcher. One shared managed runtime bridges callbacks into Effect. Connect cancellation and deadlines interrupt the request Effect; do not create detached request fibers.

Public methods are limited to setup status, administrator creation, and sign-in. Every other generated method fails closed unless it is in one explicit public-method set. Authentication stores a Nama administrator identity in request context; no mutable global current-user state exists.

Administrator creation keeps Better Auth automatic sign-in disabled and returns no session. The operator signs in explicitly after setup.

Sign-in returns the Better Auth bearer plugin's signed credential through Nama's response, not a cookie or raw session model. Better Auth owns session expiry, rotation, and revocation; Nama adds no refresh-token protocol. Sign-out succeeds only after the durable session store confirms the presented bearer no longer resolves. An ambiguous or failed deletion returns `UNAVAILABLE` with reason `SESSION_REVOCATION_UNCONFIRMED`; the caller retains the credential and resolves state through `GetCurrentUser`.

Application errors map exhaustively to the Connect codes and Nama-owned typed details defined by the API contract. Clients receive stable reasons and correlation IDs, never database messages, Better Auth errors, credentials, configuration, or stacks. Writes are not retried automatically.

The Better Auth compatibility constraints and spike evidence remain in [authentication and setup](authentication-and-setup.md). Do not weaken strict TypeScript, enable `skipLibCheck`, or add unused runtime packages to hide upstream type failures.

## Verification contract

The server test gate must continue to exercise behavior, not only generated contracts or compilation:

- pure and Effect-scoped configuration, logging, routing, drain, deadline interruption, and finalization behavior;
- serial integration against disposable PostgreSQL with real migration journals, upgrade and failure fixtures, pool closure, and loss/recovery;
- the actual package entrypoint, both termination signals, released listener ports, normalized startup failure, valid JSON output, and secret absence; and
- root TypeScript checks that execute the complete server suite.

Integration PostgreSQL must use an isolated Compose project, dynamically published host port, and disposable volume; it must never touch the developer database. A compile-only check or generated Protobuf round trip is not server runtime proof.

Issues #21–#23 must extend the real-flow gate for migration repair, concurrent setup, token replacement and consumption, generated-client setup/authentication, fail-closed authorization, confirmed session revocation, request cancellation, and secret-safe errors and logs.

## Deferred work

Configuration reload, startup retries, multiple administrators, signup, password recovery, OAuth/OIDC, roles, a web administration app, multi-process migration coordination, Redis, worker pools, a job framework, exported tracing, and an observability backend remain deferred until a concrete accepted use case requires them. Plugin, pairing, media, playback, and synchronization runtime behavior belongs to their owning milestones.