# Modular Core Server Design

Status: approved in chat; awaiting written review.

## Goal

Restructure `apps/server/` into concrete responsibility modules before merging the bootable core. Preserve all issue #20 behavior while making ownership, dependency direction, and test placement explicit.

## Scope

This change owns:

- splitting configuration, logging, and HTTP transport by independent reasons to change;
- grouping database and contract code under concrete owners;
- colocating unit and service tests with their production owner;
- retaining one small integration area for disposable PostgreSQL and real-process behavior;
- removing duplicated integration database setup;
- updating TypeScript, Vitest, Fallow, and test-script paths required by the moves; and
- updating the canonical core-server architecture note after the implementation cutover.

This change does not own:

- new runtime behavior;
- public API or Protobuf changes;
- production schema, Better Auth, setup, Connect handlers, or plugin supervision;
- new dependencies, abstractions, retries, metrics, or tracing;
- Fallow rule, threshold, suppression, formatter, linter, or root-task changes; or
- compatibility aliases, barrels, or old-path re-exports.

## Decisions

1. Organize by concrete responsibility, not technical layers.
2. Split a file only when responsibilities can change independently.
3. Use no hard line limit. File size is a review signal, not the split criterion.
4. Keep `main.ts` and `app.ts` as package edges.
5. Keep `database.ts` cohesive until implemented database behavior establishes another owner.
6. Use no `index.ts` barrels. Imports name concrete files.
7. Keep all production exports minimal. Tests do not create new production seams.
8. Preserve the existing Effect graph, native Node listener, resource counts, and dependency direction.
9. Perform a clean cutover. Remove every old path after moving all callers.

## Source layout

```text
apps/server/
  src/
    main.ts
    app.ts

    config/
      config.ts
      errors.ts
      overlay.ts
      schema.ts
      config.test.ts
      schema.test.ts
      config.test-support.ts

    logging/
      logging.ts
      record.ts
      logging.test.ts

    database/
      database.ts

    http/
      http-server.ts
      health.ts
      listener.ts
      request-runtime.ts
      health.test.ts
      http-server.test.ts
      listener.test.ts
      request-runtime.test.ts
      http-server.test-support.ts
      network.test-support.ts

    contracts/
      authorization.ts
      field-errors.ts
      probe.ts
      authorization.test.ts
      field-errors.test.ts
      playback.test.ts
      public-services.test-support.ts
      plugin-services.test-support.ts

  integration/
    compose.yaml
    database.integration.test.ts
    process.integration.test.ts
    postgres.test-support.ts
    process.test-support.ts
    migration-failure-main.test-support.ts
    fixtures/migrations/...
```

Test-support filenames may be split further only when separate resource lifecycles require it. Do not create generic `utils`, `shared`, `core`, `interfaces`, or repository directories.

## Module ownership

### Package edges

- `main.ts` owns `NodeRuntime.runMain` and process exit selection.
- `app.ts` owns graph construction, startup classification, readiness announcement, long-lived waiting, shutdown classification, and the final stopped event.
- No feature module launches the application or constructs a second root scope.

### Configuration

- `config/config.ts` exposes `Config`, selects and reads the file, parses TOML, and orchestrates decoding.
- `config/errors.ts` defines only the three configuration-local tagged failures.
- `config/overlay.ts` copies unknown parsed input and applies the five explicit content overrides.
- `config/schema.ts` owns field validation, Effect Schema decoding, normalization, redaction, and freezing.
- Raw source, parsed TOML, selected paths, and environment snapshots never leave `config/`.

### Logging

- `logging/logging.ts` owns the configured Effect logger layer, lifecycle event API, failure event API, and bootstrap writer.
- `logging/record.ts` owns pure message allowlisting, error-tag classification, stack sanitation, and JSON-record construction.
- The stable record fields and stdout/stderr split remain unchanged.

### Database

- `database/database.ts` continues to own pool acquisition, connection verification, Drizzle construction, migration execution, the initial probe, bounded readiness, failure normalization, and pool finalization.
- Consumers receive only Nama-owned Effect operations.
- `pg.Pool`, Drizzle, migration internals, and SQL remain private.

### HTTP

- `http/health.ts` owns exact liveness/readiness policy and readiness-transition logging behavior. It receives a readiness Effect instead of importing `Database`.
- `http/request-runtime.ts` owns the one `ManagedRuntime`, active request-fiber registry, request execution, request waiting, interruption, and runtime disposal.
- `http/listener.ts` owns bind parsing, native listener acquisition, empty Node responses, idle connection closure, bounded drain, forced closure, and Node failure normalization.
- `http/http-server.ts` wires config, database readiness, accepting state, health dispatch, request runtime, listener, and unmatched-request delegation. It exports only `HttpServer` across owner boundaries.
- Active fibers, sockets, and the mutable accepting cell remain private to `http/`.

### Contracts

- `contracts/authorization.ts` owns the exhaustive generated-method authority table.
- `contracts/field-errors.ts` owns deterministic, bounded, metadata-stripping field-error normalization.
- `contracts/probe.ts` remains the compile/Fallow entry for generated public and plugin namespaces.
- Contract modules remain independent from the server runtime graph.

## Dependency direction

```text
main -> app
app -> config + logging + database + http
logging -> config
database -> config
http -> config + database
contracts -> generated bindings only
integration -> concrete owners and the real entrypoint
```

Internal dependency direction is:

```text
config -> errors + overlay + schema
logging -> record
http-server -> health + request-runtime + listener
```

No runtime module imports `app`, `main`, `contracts`, tests, or integration support. Fallow must cover every moved file and enforce the acyclic owner graph.

## Data flow

### Configuration

```text
environment
  -> select and read one file
  -> parse complete TOML into unknown data
  -> overlay five allowlisted values
  -> decode complete value once
  -> normalize, redact, and freeze
  -> provide Config
```

Malformed sections survive overlay and fail complete decoding. Secrets become `Redacted` during decoding. Restart remains the only reload mechanism.

### Startup

```text
load Config under bootstrap failure handling
  -> install configured logging
  -> acquire and verify Database
  -> construct Drizzle and migrate
  -> run initial database probe
  -> construct request ManagedRuntime
  -> bind native listener
  -> emit server.ready
  -> wait for interruption
```

The listener never binds before configuration, migrations, and the initial probe succeed.

### Request dispatch

```text
Node callback
  -> exact route decision
     -> unmatched: invoke injected RequestListener without readiness work
     -> health: build health Effect
        -> run and track through request ManagedRuntime
        -> write empty response
        -> remove completed fiber
```

Exact health precedence, empty response shape, and unmatched delegation remain unchanged.

### Shutdown

```text
mark accepting false
  -> emit server.stopping
  -> stop accepts and close idle connections
  -> drain for at most ten seconds
  -> interrupt remaining request Effects
  -> force-close remaining HTTP connections
  -> await request completion
  -> dispose request ManagedRuntime
  -> close PostgreSQL pool
  -> emit server.stopped
```

Acquisition order and reverse finalization enforce this sequence. Finalizers remain idempotent and safe after partial acquisition.

## Error ownership

| Owner | Failures | Safe retained data |
| --- | --- | --- |
| `config/` | `ConfigReadError`, `ConfigParseError`, `ConfigValidationError` | Optional TOML location or allowlisted field path |
| `database/database.ts` | `DatabaseConnectionError`, `MigrationError` | Stable tag only |
| `http/listener.ts` | `ServerBindError`, `ShutdownError` | Stable tag only |
| `logging/record.ts` | No application failures | Stable known tag or bounded message-free stack frames |
| `app.ts` | No new failure type | Failure phase and interruption state only |

Normalize external failures where captured. Do not add a central error module, base exception, raw-cause wrapper, or cross-feature error union. Expected failures never retain parser, PostgreSQL, Drizzle, or Node messages. Unexpected defects expose only the existing bounded sanitized stack frames to the logger.

## Test ownership

A test lives beside the smallest production owner whose observable contract it verifies. Only assembled-process and disposable-PostgreSQL behavior lives under `integration/`.

| Test owner | Observable coverage |
| --- | --- |
| `config/config.test.ts` | Selection, reads, TOML failure, defaults, overrides, immutability, redaction |
| `config/schema.test.ts` | Bind, URL, connection count, key, log level, malformed sections |
| `logging/logging.test.ts` | Filtering, fixed JSON shape, safe expected and unexpected failures, bootstrap output |
| `http/health.test.ts` | Liveness/readiness policy and transition suppression |
| `http/http-server.test.ts` | Exact routing, empty responses, delegation, readiness behavior, finalization order |
| `http/listener.test.ts` | Partial bind cleanup, active sockets, graceful drain, forced shutdown |
| `http/request-runtime.test.ts` | Runtime disposal and request-fiber interruption |
| `contracts/*.test.ts` | Generated method coverage, authority, field errors, playback validation |
| `integration/database.integration.test.ts` | Journals, upgrade, migration failure, unavailable startup, invalid metadata, pool closure |
| `integration/process.integration.test.ts` | Real entrypoint, both signals, listener release, startup failure, database loss/recovery, safe output |

Preserve every existing behavioral assertion. Do not delete, skip, focus, or weaken tests to make moves pass. Split the current HTTP test suite by observable owner, not by individual function.

## Test support

- Configuration support remains under `config/`.
- HTTP server, socket, and port support remains under `http/` and may be split by resource lifecycle.
- `integration/postgres.test-support.ts` owns the isolated database helper shared by database and process integration suites.
- `integration/process.test-support.ts` owns child spawning, output capture, status polling, signal delivery, and forced cleanup.
- Compose and migration fixtures remain integration-only resources.
- Production files never import test support.

## Tooling changes

- `vitest.config.ts` discovers colocated `src/**/*.test.ts` and `integration/**/*.test.ts`.
- Tests remain serial.
- `scripts/check-server-tests.sh` keeps unique Compose project and disposable volume orchestration; only moved paths and discovery inputs change.
- `tsconfig.json` includes `src/`, `integration/`, and Vitest configuration.
- `.fallowrc.json` updates entry and zone patterns for the new paths. Existing rules, thresholds, coverage requirement, and suppressions remain unchanged.
- The implementation updates `docs/architecture/core-server.md` from the initial flat layout to the accepted owner directories and dependency graph after the code cutover.

## Future attachment points

- Issue #21 extends `database/` with implemented persistence behavior. It does not expose a generic query service or repository.
- Issue #22 creates `setup/` only when bootstrap behavior is implemented.
- Issue #23 creates concrete `auth/` and `rpc/` owners. RPC supplies the unmatched listener, and the existing request runtime receives the required services.
- No empty future directory, placeholder interface, second listener, second runtime, or compatibility layer is created by this refactor.

## Implementation sequence

1. Establish owner directories and colocated test discovery without changing behavior.
2. Move contract and already-cohesive owner files; migrate every import and Fallow path.
3. Split configuration into load, errors, overlay, and schema responsibilities.
4. Split logging into Effect integration and pure record construction.
5. Split HTTP into health, request runtime, native listener, and composition responsibilities.
6. Consolidate integration PostgreSQL support and move process/database fixtures.
7. Remove all old paths and obsolete support modules.
8. Update the canonical core-server architecture note.
9. Run focused owner checks, then repository checks.

## Verification

Required checks:

1. Run the server type check.
2. Run the complete server test gate with disposable PostgreSQL.
3. Run the server Fallow gate.
4. Run `mise run check:ts`.
5. Run `mise run check`.

Behavioral proof must include the actual package entrypoint, both termination signals, listener-port release, disposable PostgreSQL migrations, database loss/recovery, exact health responses, bounded shutdown, safe logs, and secret absence. Compilation and generated-contract round trips are not runtime proof.
