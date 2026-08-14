# Issue 20: Bootable Effect Core Design

Status: approved in chat; awaiting written review.

Issue: <https://github.com/electather/nama/issues/20>

## Goal

Create the first executable `@nama/server` process. It must become ready only after configuration, PostgreSQL, and migrations are ready. It must report operational health, emit safe structured logs, and release resources deterministically.

## Scope

Issue #20 owns:

- immutable TOML configuration;
- five explicit content overrides plus the `NAMA_CONFIG` file selector;
- structured Effect logging;
- one shared PostgreSQL pool and Drizzle instance;
- startup migration execution;
- exact liveness and readiness HTTP routes;
- the native Node listener and Effect callback bridge;
- graceful `SIGINT` and `SIGTERM` handling; and
- unit, integration, and real-process lifecycle verification.

Issue #20 does not own:

- production table definitions or schema migrations;
- Better Auth or administrator setup;
- Connect service registration or RPC handlers;
- bootstrap tokens;
- plugin supervision;
- retries, configuration reload, metrics, distributed tracing, or migration coordination; or
- any public endpoint besides the two operational health routes.

Issue #21 adds production schema definitions and reviewed migrations. Issue #23 adds Connect delegation and handlers at the listener seam.

## Invariants

1. Effect owns service composition, scopes, interruption, logging, and shutdown.
2. The process does not bind before migrations and an initial database probe succeed.
3. Configuration is decoded once and cannot change in process.
4. Only the five named content overrides affect decoded configuration.
5. Database and master-key values never enter logs, errors, spans, or health responses.
6. Consumers do not receive `pg.Pool`.
7. There is one pool, one Drizzle instance, one request runtime, and one HTTP listener.
8. Startup performs no write or migration retry.
9. Readiness may recover after transient database loss without restarting.
10. Finalizers release only acquired resources and are safe after partial startup.
11. Effect-local spans remain process-internal diagnostics, not an exported or propagated tracing contract.

## Dependencies

Add exact-pinned native dependencies through pnpm.

| Kind | Packages | Purpose |
| --- | --- | --- |
| Runtime | `effect`, `@effect/platform-node` | Application graph, scopes, runtime, logging, filesystem access |
| Runtime | `pg`, `drizzle-orm` | Shared PostgreSQL pool, Drizzle instance, runtime migration application |
| Runtime | `smol-toml` | ESM TOML parser with no runtime dependencies |
| Development | `@types/pg`, `vitest`, `@effect/vitest` | Strict types and one server test runner |

Do not add Connect, Better Auth, `@effect/opentelemetry`, a second dependency-injection system, Testcontainers, a retry library, or an observability backend.

## File ownership

| Path | Responsibility |
| --- | --- |
| `apps/server/src/main.ts` | Provide the live graph, launch it once, and select the process exit status |
| `apps/server/src/app.ts` | Define strict startup composition and the long-lived root program |
| `apps/server/src/config.ts` | Read TOML, overlay allowed environment values, validate, and provide immutable redacted configuration |
| `apps/server/src/logging.ts` | Build the configured Effect JSON logger and the pre-configuration fatal writer |
| `apps/server/src/database.ts` | Own pool, Drizzle, migration execution, readiness probes, and database failure normalization |
| `apps/server/src/server.ts` | Own readiness state, health dispatch, request runtime, listener, drain, and connection closure |
| `apps/server/src/errors.ts` | Define the small tagged startup and shutdown error set |
| `apps/server/drizzle/meta/_journal.json` | Valid zero-entry production migration journal; issue #21 adds entries and SQL |
| `apps/server/test/` | Vitest unit and integration suites plus migration fixtures |
| `apps/server/test/compose.yaml` | Isolated PostgreSQL 18 integration service |
| `scripts/check-server-tests.sh` | Start and tear down the isolated Compose project around serial integration tests |

Move `apps/server/src/contract.test.ts` to `apps/server/test/contract.test.ts` and convert it from `node:test` to Vitest. Replace the server-local contract-only test script with one complete `check:test` script. The root TypeScript check must execute it. Do not add a root Mise task.

## Configuration

### Loading and precedence

1. Read `NAMA_CONFIG`; use `/etc/nama/nama.toml` when absent.
2. Read the selected file once through the Effect filesystem service.
3. Parse the complete file into `unknown` through `smol-toml`.
4. Apply each present allowlisted content override.
5. Decode the complete value once with Effect Schema.
6. Provide one immutable configuration value to the remaining graph.

The selected file must exist. An empty `NAMA_CONFIG` is an invalid selected path. An empty content override is present input and must fail validation when the target field disallows it.

Only these content overrides exist:

| Environment variable | Field |
| --- | --- |
| `NAMA_DATABASE_URL` | `database.url` |
| `NAMA_MASTER_KEY` | `security.master_key` |
| `NAMA_BIND` | `server.bind` |
| `NAMA_PUBLIC_URL` | `server.public_url` |
| `NAMA_LOG_LEVEL` | `logging.level` |

No environment-name derivation or prefix scan exists. In particular, an environment variable cannot override `database.max_connections`.

### Shape and validation

Required fields:

- `server.public_url`;
- `database.url`; and
- `security.master_key`.

Defaults:

- `server.bind`: `0.0.0.0:8080`;
- `database.max_connections`: `10`; and
- `logging.level`: `info`.

Validation rules:

- Reject unknown keys at every object level.
- Accept a bind hostname or IPv4 address followed by a port, or bracketed IPv6 followed by a port.
- Do not resolve bind hostnames during decoding.
- Require bind ports from 1 through 65535.
- Require `database.max_connections` from 1 through 100.
- Accept only absolute HTTP or HTTPS public URLs.
- Reject public URL credentials, query, fragment, and any path other than `/`.
- Require a standard `base64:` value that decodes strictly to 32 bytes.
- Accept log levels `trace`, `debug`, `info`, `warn`, `error`, and `fatal`.
- Reject TOML dates, arrays, and tables where the schema expects another type.

Decode `database.url` and `security.master_key` into `Redacted` values. Raw parser output must not be attached to an Effect failure or log annotation.

## Application graph

The graph is one modular monolith. Services use Effect context and layers. Plain validation and mapping logic remains plain functions.

Startup dependency order:

```text
ConfigLive
  -> configured logger
  -> DatabaseLive
  -> migration application
  -> initial database probe
  -> request ManagedRuntime
  -> HttpServerLive
  -> accepting and ready
```

`main.ts` uses the platform runtime once. The configured logger wraps every stage after configuration. Failures before logger installation use the bootstrap fatal writer.

The migration folder is a constructor input to the database layer, not configuration or an environment override. Production resolves `apps/server/drizzle/` relative to the server module rather than the current working directory. Tests provide fixture folders through test layers.

The request runtime contains only the services needed by listener callbacks. It is constructed once and disposed once. Issue #23 extends its service context rather than creating another runtime.

## Database and migrations

`DatabaseLive`:

- constructs one `pg.Pool` from the redacted URL and configured maximum;
- constructs one Drizzle instance over that pool;
- applies Drizzle migration files serially;
- runs an initial `SELECT 1` before returning;
- exposes a bounded readiness effect; and
- closes the pool in its finalizer.

The pool remains private. Future Nama-owned operations are added as Effect methods beside their owning feature. Better Auth may receive the private Drizzle instance in issue #21, but no generic repository or database interface is introduced.

The production migration journal has zero entries in issue #20. Missing or malformed journal metadata is fatal. Test fixtures contain real SQL and independent journals for successful upgrade and forced failure cases.

The MVP runs one process. Drizzle bookkeeping is sufficient. Do not add advisory locks or multi-process coordination.

### Readiness probe

The probe performs `SELECT 1` with both PostgreSQL query timeout and Effect timeout bounded to two seconds. It returns only ready or unavailable to the HTTP layer. PostgreSQL messages, hostnames, database names, and SQL text do not cross the database boundary.

A failed probe does not close or replace the pool. A later probe uses normal pool reconnection and can restore readiness.

## HTTP server

Use a scoped native Node HTTP listener.

Dispatch only:

| Request | Ready condition | Response |
| --- | --- | --- |
| exact `GET /health/live` | Listener can answer | HTTP 200, empty body |
| exact `GET /health/ready` | Accepting state is true and database probe succeeds | HTTP 200, empty body |
| exact `GET /health/ready` while unavailable | Any readiness condition fails | HTTP 503, empty body |
| every other method or target | Not applicable | HTTP 404, empty body |

Exact targets contain no query string. Set `Content-Length: 0`; do not create a health response schema or content type.

Liveness performs no dependency operation. Readiness checks local accepting state before touching PostgreSQL. Health callbacks run through the shared managed runtime so interruption and shutdown ownership match later Effect-backed handlers.

Keep unmatched-request delegation as a small listener function. Issue #20 supplies the 404 implementation. Issue #23 replaces it with the Connect Node adapter without changing operational-route precedence or listener ownership.

## Failure model

Normalize expected failures at the boundary that owns them:

- `ConfigReadError`;
- `ConfigParseError`;
- `ConfigValidationError`;
- `DatabaseConnectionError`;
- `MigrationError`;
- `ServerBindError`; and
- `ShutdownError`.

Safe error data is limited to the tag, an optional configuration field path, and optional TOML line and column. Never retain arbitrary parser or PostgreSQL messages in tagged errors.

A configuration, connection, migration, runtime-construction, or bind failure:

1. emits exactly one safe fatal record;
2. releases already acquired resources;
3. never binds, or closes a partially acquired listener; and
4. exits non-zero.

There is no startup retry. Deployment restart policy is the recovery mechanism.

## Logging

Normal logs are newline-delimited JSON on stdout through Effect. The configured level applies after configuration decode.

Stable events:

- `server.ready`;
- `server.stopping`;
- `server.stopped`;
- `server.start_failed`;
- `server.shutdown_failed`; and
- `database.readiness_changed`.

Allowlisted fields:

- `timestamp`;
- `level`;
- `event`;
- `duration_ms`;
- `error_tag`; and
- `sanitized_stack_frames`, only for unexpected defects.

Do not log health probes at info level. Log database readiness only when the observed state changes. Do not log bind address, public URL, database URL, master key, source TOML, SQL, or environment values.

Before configured logging exists, a minimal bootstrap writer emits one JSON object to stderr. It contains only timestamp, fatal level, `server.start_failed`, and a normalized error tag.

Expected failures do not log arbitrary exception messages or causes. Unexpected defects may include sanitized stack frames with the exception message line removed. Stack sanitation must never serialize enumerable exception fields.

### Tracing boundary

Effect-local spans produced by named `Effect.fn` functions are permitted for in-process diagnostics and improved stack traces. They are not a public or operational tracing contract.

Issue #20 does not:

- add OpenTelemetry, OTLP logging, or another exporter;
- configure resource attributes, sampling, or export endpoints;
- accept or propagate trace headers;
- add trace or span IDs to the stable log fields; or
- expose span data.

Issue #23 introduces Nama request and correlation IDs for RPC logs independently. Exported tracing remains deferred to operational hardening after observed need.

## Shutdown

`SIGINT` and `SIGTERM` interrupt the root program.

Shutdown order:

```text
accepting false
  -> stop new connections
  -> drain in-flight requests for at most 10 seconds
  -> interrupt remaining request Effects
  -> close remaining HTTP connections
  -> dispose request ManagedRuntime
  -> close PostgreSQL pool
```

Readiness returns 503 as soon as accepting becomes false for a request already able to reach the listener. `server.close` stops new connections. Idle keep-alive connections are closed. After ten seconds, force-close remaining HTTP connections after interrupting their Effects.

Normal signal shutdown exits zero. A finalizer failure emits `server.shutdown_failed` and exits non-zero. Finalizers are idempotent and tolerate acquisition failure before their resource exists.

## Verification

### Unit tests

Configuration tests cover:

- missing and unreadable files;
- malformed TOML without source leakage;
- unknown keys and missing required fields;
- all defaults;
- each of the five content overrides;
- empty override behavior;
- proof that an unlisted environment variable cannot alter configuration;
- bind, public URL, connection-count, master-key, and log-level boundaries; and
- redacted decoded values.

Pure server tests cover:

- exact route and method matching;
- local readiness short-circuiting;
- liveness independence from PostgreSQL;
- state-transition-only readiness logging; and
- status and empty-body behavior.

Scoped Effect tests cover:

- reverse-order finalization;
- partial acquisition cleanup;
- graceful request drain;
- interruption at the ten-second deadline with a test clock;
- managed-runtime disposal; and
- pool closure.

### PostgreSQL integration tests

Run serially against an isolated PostgreSQL 18 Compose project. Use a dynamically published host port and a unique Compose project name. Always tear down its container and volume. Do not touch the developer `compose.yaml` service or named volume.

Cover:

- an empty database with the zero-entry production journal;
- a prior fixture migration upgraded by a later fixture;
- a failing fixture migration causing non-zero startup without a bound listener;
- initial database unavailability;
- database loss producing ready 503 while live remains 200; and
- database recovery restoring ready 200 without process restart.

### Real-process lifecycle

Spawn the actual package entrypoint with a temporary valid TOML file and isolated PostgreSQL. Prove:

1. the process binds and both health routes return 200;
2. emitted records are valid JSON;
3. `SIGINT` and `SIGTERM` independently cause exit zero;
4. the listener port is released after each signal; and
5. captured output contains neither the fixture database URL nor master key.

A separate captured-failure scenario proves one normalized fatal record and a non-zero exit without a listener.

### Native gates

Run:

- `pnpm --filter @nama/server run check:test`;
- `mise run check:ts`; and
- `mise run check`.

The root TypeScript check executes the complete Vitest suite. Compile-only checks do not satisfy issue #20.

## Completion criteria

Issue #20 is complete when all of the following are observed:

- a native server process boots from valid TOML against empty PostgreSQL;
- migration application and the initial database probe complete before bind;
- readiness follows database loss and recovery while liveness stays available;
- only the documented environment values affect configuration;
- logs and errors exclude every configured secret fixture;
- signal shutdown drains, interrupts at the deadline, closes the listener and pool, and returns the correct exit status; and
- all native gates pass.
