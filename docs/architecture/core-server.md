# Core Server Foundation Design

Status: approved on 2026-08-09.

## Purpose

This specification defines the Milestone 2 Nama server foundation: process lifecycle, configuration, PostgreSQL access and migrations, one-time administrator setup, authentication, health reporting, error handling, observability, and verification.

Milestone 0 already defines the related plugin, provider-management, media, pairing, playback, and watch-state wire schemas and services. Milestone 2 does not implement their handlers, persistence, plugin supervision, or provider behavior; those arrive only in the milestones that exercise them.

## Accepted architecture changes

This design amends the earlier architecture in five places:

1. Effect v4 beta is the foundation of the TypeScript server and is pinned to an exact version.
2. Hono is removed. A scoped native Node HTTP listener dispatches two operational routes and delegates RPC traffic to `@connectrpc/connect-node`.
3. Drizzle remains on one shared `pg.Pool`. Nama-owned database operations become Effects at the service boundary; `@effect/sql-pg` is not used.
4. Vitest with `@effect/vitest` replaces Node's test runner for TypeScript.
5. Plugin, pairing, media, and synchronization tables move out of Milestone 2 and into the milestones that first use them.

Protobuf/ConnectRPC, Better Auth, PostgreSQL, Drizzle-generated reviewed SQL migrations, Node.js 24, strict TypeScript, ESM, and pnpm remain fixed.

## System shape

The server is a modular monolith built as one Effect application graph. `Context.Service` and explicit `Layer` composition provide service wiring and lifecycle management. There is no second dependency-injection mechanism.

```mermaid
flowchart LR
    Entrypoint["NodeRuntime.runMain"] --> App["AppLive"]
    App --> Config
    Config["ConfigLive"] --> Database["DatabaseLive"]
    Database --> Migrations["Automatic migrations"]
    Config --> Auth["AuthLive"]
    Database --> Auth
    Auth --> Setup["SetupLive"]
    Database --> Setup
    Migrations --> Runtime["ManagedRuntime bridge"]
    Setup --> Runtime
    Runtime --> Server["Scoped Node HTTP server"]
    Server --> Health["/health/live and /health/ready"]
    Server --> Connect["Connect api.v1 handlers"]
```

Effect owns configuration, composition, resource scopes, typed failures, logging, interruption, and shutdown. Three external APIs remain deliberately narrow adapters:

- Node and Connect supply callback- or Promise-based transport APIs.
- Drizzle and `pg` supply Promise-based database APIs.
- Better Auth supplies Promise-based server APIs and session persistence.

Each adapter is wrapped once. Promise types do not spread into application services.

## Components and boundaries

### Entrypoint

The entrypoint composes `AppLive` and launches it through `NodeRuntime.runMain`. It contains no business rules, route implementations, or manual service locator.

### Configuration

The configuration module reads TOML, applies the explicit environment override allowlist, validates the result with Effect Schema, and provides one immutable redacted value to the application graph.

### Database

The database module owns one `pg.Pool`, the Drizzle instance, the schema, migration execution, connectivity checks, and database-error normalization. Consumers do not receive the pool.

The Drizzle instance may be passed to the private Better Auth adapter. Nama-owned queries are wrapped in `Effect.tryPromise` inside the module that owns the operation. No repository interface is introduced until two implementations exist.

### Authentication

The authentication module is the only module permitted to import Better Auth. It exposes Nama-owned Effect methods for administrator creation, sign-in, session lookup, and sign-out. Better Auth routes, cookies, request models, response models, and errors never cross the module boundary.

### Setup

The setup module owns the process-local bootstrap-token state machine and the permanent database initialization marker. It depends on authentication, database access, and a cryptographically secure random service.

### Server

The server module owns the native Node listener, exact operational-route dispatch, generated Connect registration, validation and authentication interceptors, the Effect-to-Promise bridge, and Connect error mapping.

### Pure logic

Value validation, error classification, environment-overlay mapping, and state transitions remain plain functions beside the feature using them. They do not become services merely to fit the Effect graph.

## Configuration

### Source and precedence

`NAMA_CONFIG` selects the TOML file. It defaults to `/etc/nama/nama.toml`. The file must exist and is read once during startup.

The server applies configuration in this order:

1. Read the selected file with Effect's filesystem service.
2. Parse TOML into unknown data through one small parser adapter.
3. Apply only the five supported environment overrides.
4. Decode and validate the complete object with Effect Schema.
5. Store sensitive values as Effect redacted values.

The only content overrides are:

| Environment variable | TOML field |
| --- | --- |
| `NAMA_DATABASE_URL` | `database.url` |
| `NAMA_MASTER_KEY` | `security.master_key` |
| `NAMA_BIND` | `server.bind` |
| `NAMA_PUBLIC_URL` | `server.public_url` |
| `NAMA_LOG_LEVEL` | `logging.level` |

No automatic environment-name mapping exists for other fields.

### Shape

```toml
[server]
bind = "0.0.0.0:8080"
public_url = "http://nama.local:8080"

[database]
url = "postgres://nama:password@postgres/nama"
max_connections = 10

[security]
master_key = "base64:REPLACE_WITH_32_RANDOM_BYTES"

[logging]
level = "info"
```

Required fields are `server.public_url`, `database.url`, and `security.master_key`. Defaults are:

- `server.bind`: `0.0.0.0:8080`
- `database.max_connections`: `10`
- `logging.level`: `info`

`server.public_url` must be an absolute HTTP or HTTPS URL without credentials, query, fragment, or a non-root path. Client-side rules continue to reject plain HTTP for public addresses.

The master key uses the `base64:` prefix and must decode to exactly 32 bytes. It is operator-supplied; Nama never generates or writes it.

Unknown keys, malformed TOML, invalid override values, missing required values, invalid URLs, and invalid master keys are startup errors. Configuration is immutable after startup; restart is the apply mechanism.

## Startup, health, and shutdown

### Startup order

Startup is strictly ordered:

1. Resolve and decode configuration.
2. Install structured logging.
3. Acquire the database pool and Drizzle instance.
4. Run all pending reviewed migrations serially.
5. Inspect and, when safe, repair the initialization marker.
6. Build Better Auth, authentication, and setup services.
7. Build the single managed runtime used by transport callbacks.
8. Bind the HTTP listener and mark the process ready.

The process does not listen before migrations and service construction succeed. Docker health-check start periods cover this startup window.

Configuration, database-connection, migration, bind, or service-construction failures emit one redacted fatal record and exit non-zero. Startup does not retry writes or migrations; the deployment restart policy is the recovery mechanism.

### Health

`GET /health/live` returns success when the HTTP process can answer requests. It does not query dependencies.

`GET /health/ready` runs a `SELECT 1` probe with a two-second timeout. It returns success only while the server is accepting traffic and PostgreSQL is reachable. It returns HTTP 503 during shutdown or database loss.

`nama.api.v1.HealthService` is an authenticated operator RPC. It may report version, readiness, and sanitized database status for the CLI, but never configuration values or secrets.

### Shutdown

On `SIGINT` or `SIGTERM`, the root Effect scope:

1. marks readiness false;
2. stops accepting new connections;
3. allows in-flight requests up to ten seconds to finish;
4. interrupts remaining request Effects and closes remaining HTTP connections;
5. disposes the managed runtime; and
6. closes the shared database pool.

Normal signal shutdown exits zero. A finalizer failure is logged and exits non-zero.

## Persistence and migrations

Milestone 2 persists only:

- reviewed Better Auth tables and indexes; and
- one `nama_server_state` singleton row.

The state row contains a fixed singleton key, nullable `initialized_at`, and nullable `administrator_user_id`. Once `initialized_at` is set, no application operation can clear it. The administrator reference restricts deletion.

Drizzle schema definitions generate SQL migrations. Generated SQL, including Better Auth schema changes, is reviewed and committed. The server applies those migrations automatically before listening.

The MVP supports one server process. It does not add a distributed migration lock or multi-replica coordination. Drizzle's migration bookkeeping and the single-process deployment boundary are sufficient until clustering is a real requirement.

### Initialization repair

Startup interprets state as follows:

| Marker | Better Auth users | Outcome |
| --- | ---: | --- |
| initialized | exactly one | configured |
| initialized | zero or more than one | fatal integrity error; never reopen setup |
| uninitialized | zero | enter setup mode |
| uninitialized | exactly one | set marker to that user and continue configured |
| uninitialized | more than one | fatal integrity error |

The repair case handles a crash after Better Auth commits the administrator but before Nama updates its marker.

## One-time administrator setup

On each unconfigured start, Nama creates a 32-byte cryptographically random bootstrap token and renders it as base64url. It emits exactly one dedicated console line:

```text
NAMA_BOOTSTRAP_TOKEN=<token>
```

This line bypasses normal structured logging. It is the sole deliberate secret-output exception and may still be captured by Docker's container logs. The token is never repeated, attached to a span, or placed in an error. Only its SHA-256 digest remains in memory after emission.

`SetupService.GetStatus` is public and returns only whether setup is complete.

`SetupService.CreateAdministrator` is public and accepts the bootstrap token, display name, email, and password. A process-local Effect semaphore makes the flow single-flight. The service:

1. rejects calls immediately when the permanent marker is set;
2. hashes the presented token and compares fixed-size digests in constant time;
3. asks Better Auth to create the email/password user;
4. immediately and irreversibly disables setup in process once user creation commits; and
5. records the administrator and `initialized_at`.

Token validation occurs before password hashing. A failure before user creation leaves the token valid. If user creation commits but the marker update fails, the process remains unready and exits so the next boot can repair the marker; it never permits a second setup attempt. If only the response is lost, the operator can sign in with the created credentials.

Restart replaces every unused token. No bootstrap token is stored in PostgreSQL.

## Authentication and authorization

The administrator uses Better Auth email/password authentication. Public signup and Better Auth HTTP routes are not mounted.

The operator-supplied master key derives a distinct 32-byte Better Auth secret through HKDF-SHA-256 with the fixed context string `nama/better-auth/v1`. The original master key is never passed around as a plain string.

The Better Auth bearer plugin requires signed tokens. `AuthService.SignIn` calls the server-side email sign-in API, converts its session output into a Nama bearer credential, and returns a Nama user. `AuthService.GetCurrentUser` resolves an `Authorization: Bearer` header into a Nama user. `AuthService.SignOut` revokes that session.

Nama does not override Better Auth's session lifetime, rotation, or expiry policy. There is no Nama refresh-token system.

RPC authentication is fail-closed. Every method requires a valid administrator session unless its generated method descriptor appears in one explicit public-method set. For this milestone, the public methods are setup status, administrator creation, and sign-in. Health HTTP routes remain public and minimal.

The authentication interceptor stores a Nama administrator identity in Connect request context. Handlers pass that identity explicitly to operations that require it; no global mutable current-user state exists.

## Transport and request flow

The supported Connect server integration, `connectNodeAdapter`, owns the Node request-listener contract. A small dispatcher handles the two exact health paths and delegates all other requests to Connect. Nama does not implement a custom Connect protocol adapter merely to route through Effect's higher-level HTTP router.

One managed runtime bridges callback-based transport into the Effect service graph. It is constructed once, shared by all requests, and disposed during shutdown.

A protected unary request flows through:

1. Node request dispatch;
2. request ID and structured logging interceptor;
3. bearer authentication interceptor for protected methods;
4. Connect/Protobuf validation;
5. generated service handler;
6. `ManagedRuntime.runPromise` using Connect's abort signal;
7. an Effect application service;
8. Drizzle or Better Auth adapter; and
9. a provider-neutral Protobuf response.

The abort signal and Connect deadline interrupt the request Effect. The design adds no detached per-request fibers.

Protobuf remains the structural request source of truth. Validation annotations and the Connect validation interceptor enforce field-level constraints. Effect logic enforces state-dependent rules; it does not duplicate every Protobuf message as an Effect Schema.

## Error contract

Expected failures use Effect tagged errors defined beside the owning feature. External errors are normalized at their adapter boundary. One exhaustive mapper translates application errors into Connect codes and Nama-owned typed details.

| Condition | Connect code |
| --- | --- |
| Malformed or semantically invalid input | `invalid_argument` |
| Invalid bootstrap token or credentials | `unauthenticated` |
| Missing, invalid, or revoked session | `unauthenticated` |
| Setup already completed | `failed_precondition` |
| Authenticated caller lacks permission | `permission_denied` |
| PostgreSQL unavailable | `unavailable` |
| Connect deadline elapsed | `deadline_exceeded` |
| Client cancelled | `cancelled` |
| Unexpected defect | `internal` |

Typed details contain a stable Nama reason and, where useful, a correlation ID. They never contain a database message, stack, Better Auth error, credential, or configuration value.

The server does not automatically retry setup, sign-in, sign-out, or other writes. A lost setup response is resolved by sign-in rather than replaying setup. Read-only client retries remain a client decision.

## Logging and diagnostics

Normal logs are JSON on stdout through Effect logging. Each completed RPC log contains an allowlisted subset of:

- timestamp and level;
- stable event name;
- request/correlation ID;
- RPC service and method;
- duration and final Connect code;
- authenticated Nama user ID; and
- normalized application error tag.

Request bodies and arbitrary headers are not logged. Passwords, database URLs, master keys, bootstrap tokens, bearer tokens, cookie values, and provider credentials are prohibited from logs and spans.

Better Auth log events pass through a sanitizing adapter into Effect logging. Unexpected defects retain useful server-side cause and stack information after redaction; clients see only the correlation ID.

No metrics backend, distributed tracing collector, or custom observability stack is introduced in this milestone.

## Module organization

The initial server should remain small:

```text
apps/server/
  src/
    main.ts
    config.ts
    database.ts
    schema.ts
    auth.ts
    setup.ts
    server.ts
    errors.ts
  drizzle/
  test/
```

This is a responsibility map, not a requirement to preserve large files. A module becomes a directory only when it has multiple coherent files. There is no generic `core`, `utils`, `repositories`, or `interfaces` layer.

## Verification

TypeScript tests use Vitest and `@effect/vitest`. Test layers replace external services where determinism is necessary, including secure random generation. Pure functions use ordinary Vitest tests. Effect service tests use scoped `it.effect` or shared `it.layer` environments.

The integration suite runs serially against disposable PostgreSQL supplied by Docker Compose. It uses real Drizzle migrations, Better Auth, the native Node listener, and a generated Connect client. It adds no Testcontainers dependency or parallel database-schema framework.

Required checks are:

### Configuration

- missing file and malformed TOML;
- unknown keys and missing required values;
- each allowed environment override;
- proof that an unlisted environment variable cannot alter configuration;
- invalid public URLs and master keys; and
- redaction of all sensitive values.

### Database and lifecycle

- empty PostgreSQL migrates and starts;
- a previous migration fixture upgrades cleanly;
- migration failure exits non-zero without binding the listener;
- database loss changes readiness to HTTP 503 while liveness remains HTTP 200;
- recovery restores readiness without restart when the pool reconnects; and
- `SIGTERM` marks unready, drains, interrupts after ten seconds, and closes the pool.

### Setup and authentication

- a fresh server exposes setup status and emits one token;
- two concurrent valid setup calls create exactly one administrator;
- invalid token, consumed-token reuse, and unused-token restart replacement fail safely;
- a lost setup response still permits administrator sign-in;
- the crash-repair state transition permanently disables setup;
- sign-in, current-user, sign-out, invalid-session, and revoked-session paths use generated clients; and
- every RPC is protected unless explicitly public.

### Error and log safety

- every tagged error maps to the documented Connect code and detail;
- defects return only a correlation ID;
- request cancellation interrupts the Effect; and
- captured logs and error responses contain none of the configured or issued secrets.

## Completion criteria

The foundation is complete when an operator can:

1. mount a valid TOML configuration and start Nama against empty PostgreSQL;
2. obtain the one-time bootstrap token from the operator console;
3. create exactly one administrator through generated Connect APIs;
4. sign in, call an authenticated status/current-user RPC, and sign out;
5. observe correct liveness/readiness behavior through database loss and recovery; and
6. stop the process without leaked listeners or database connections.

All configuration, migration, setup, authentication, negative-path, redaction, and shutdown checks must pass. Plugin, media, pairing, playback, and synchronization code is not part of this completion gate.

## Deferred work

- Plugin process supervision and plugin configuration: Milestone 3.
- Pairing persistence and device credentials: Milestone 4.
- Canonical media and provider mapping: Milestone 4.
- Per-user media state, sync replicas, cursors, and reconciliation: Milestone 5.
- Config reload, multiple administrators, signup, recovery email, OAuth/OIDC, and roles: later evidence-driven milestones.
- Multi-process migration coordination, Redis, worker pools, and a job framework: not required for the MVP deployment.
