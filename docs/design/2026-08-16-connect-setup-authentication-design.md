# Connect Setup and Authentication Design

Status: approved in chat; pending written review.
Issue: #23.

## Outcome

Serve Nama Connect RPCs through the existing native listener. Implement app-owned setup and administrator authentication backed by Better Auth without mounting Better Auth routes.

Implemented methods:

- `SetupService.GetStatus`;
- `SetupService.CreateAdministrator`;
- `AuthService.SignIn`;
- `AuthService.GetCurrentUser`; and
- `AuthService.SignOut`.

`GetStatus` is included because the accepted Milestone 2 recovery flow depends on it.

## Scope

Issue #23 owns:

- Connect delegation behind exact operational health routes;
- private Better Auth runtime integration over the existing PostgreSQL database;
- one-administrator setup coordination and durable marker completion;
- administrator sign-in, session resolution, current-user mapping, and confirmed sign-out;
- default-deny authorization for the complete generated public method inventory;
- Protobuf request validation and Nama-owned Connect error details;
- SignIn rate limiting;
- request correlation and terminal RPC logging;
- request cancellation, deadline, drain, and fatal-runtime behavior;
- the password-bound contract correction approved for this issue; and
- focused, PostgreSQL, generated-client, and process verification.

Explicit non-goals:

- public signup;
- invitations;
- password-reset email;
- OAuth or OIDC;
- roles beyond the sole administrator;
- device-pairing behavior;
- CLI behavior;
- a web administration UI;
- database storage of the bootstrap token;
- another listener or dependency-injection system;
- multi-process setup coordination; and
- changes to provider, plugin, media, playback, or synchronization behavior.

## Existing constraints

- Better Auth is a server-side implementation detail behind Nama RPCs.
- Better Auth routes, cookies, request models, response models, errors, and secrets never cross the private adapter boundary.
- The pinned Better Auth release remains `1.6.26` because it owns the committed generated auth schema and prior spike evidence.
- The existing `pg.Pool`, schema-aware Drizzle instance, native listener, callback `ManagedRuntime`, and Effect application graph remain singular.
- Exact `GET /health/live` and `GET /health/ready` routes retain precedence.
- Setup eligibility comes only from startup database reconciliation.
- The bootstrap-token state machine remains process-local, single-flight, and fail-closed after possible commitment.
- The process remains single-instance for the MVP.
- Configuration and secret values never enter errors, logs, spans, or responses.

## Decisions

1. Use a runtime-loaded private Better Auth boundary. Do not statically import the incompatible Better Auth declaration closure into strict TypeScript.
2. Keep exact `better-auth@1.6.26` and use its private server APIs, Drizzle adapter, and signed bearer plugin.
3. Keep Better Auth schema generation and runtime configuration separate. `better-auth.config.ts` remains tooling-only and the sole auth-model source.
4. Configure the Drizzle adapter with the existing generated schema, PostgreSQL mode, and transaction support.
5. Enable email/password authentication, disable automatic sign-in after signup, and require signed bearer tokens.
6. Keep Better Auth default session expiry, refresh, rotation, and revocation policy.
7. Derive the Better Auth secret from the master key with HKDF-SHA-256, empty salt, and info `nama/better-auth/v1`.
8. Register every generated `nama.api.v1` service so authorization precedes Connect's built-in unimplemented handlers. Do not register `nama.plugin.v1`.
9. Enable only the Connect protocol. Do not expose gRPC or gRPC-Web.
10. Add a concrete runtime-control service for readiness and fatal post-bind failure. Do not depend on request-fiber failure to stop the process.
11. Tighten both public password fields from 1–1024 to 8–128 characters. This is an approved validation-compatibility exception made before the first runtime implementation.
12. Add stable reasons `SETUP_IN_PROGRESS`, `SETUP_UNAVAILABLE`, and `AUTHENTICATION_UNAVAILABLE`.
13. Add server-owned response header `nama-request-id` for every delegated Connect response. Application errors also carry the same value in `google.rpc.RequestInfo`.
14. Use bounded process-local fixed-window SignIn limits: 100 attempts per 10 seconds globally and 5 attempts per 15 minutes per normalized-email digest.
15. Do not add a migration. Runtime-only Better Auth options and Protobuf password annotations do not change the committed auth table shape.

## Architecture

```text
configuration + database + bootstrap token
                  |
                  +-- authentication
                  |     +-- private Better Auth adapter
                  |     +-- administrator setup coordinator
                  |     +-- SignIn limiter
                  |
runtime control --+-- Connect transport -- existing HTTP listener
                  +-- root application lifecycle
```

The application remains a modular monolith. Each unit has one concrete owner.

| Unit | Responsibility | Dependencies |
| --- | --- | --- |
| Database authentication capability | Share the existing schema-aware Drizzle instance only with the private auth adapter. Conditionally complete the durable initialization marker. | Existing database owner. |
| Bootstrap token | Preserve generation, digest validation, scoped attempt, and disable semantics. | Database startup classification. |
| Private Better Auth adapter | Load checked runtime exports, configure Better Auth, call private APIs, and map only Nama-owned values and tagged outcomes. | Configuration, private Drizzle capability, generated auth schema. |
| Administrator setup coordinator | Own dynamic setup status, token claim, interruption masking, administrator creation, marker completion, and fatal ambiguity. | Bootstrap token, private auth adapter, database capability, runtime control. |
| SignIn limiter | Own global and normalized-email-digest windows and retry delays. | Clock and SHA-256. |
| Authentication service | Own sign-in, bearer resolution, current administrator, and confirmed sign-out. | Private Better Auth adapter and limiter. |
| Runtime control | Own ready state and one fatal-runtime latch observed by the root application. | Effect. |
| Connect transport | Register services and map generated handlers to Effect operations. | Authentication, setup coordinator, contracts. |
| Connect interceptor pipeline | Own correlation, setup gates, authorization, validation, rate limiting, error mapping, and terminal RPC logs. | Request runtime and contract authority inventory. |
| Request runtime | Bridge Connect promises into tracked Effect fibers with AbortSignal support. | Existing managed runtime ownership. |

Expected source owners:

- `apps/server/src/authentication/` for the private adapter, setup coordinator, authentication service, limiter, and focused tests;
- `apps/server/src/lifecycle/` for runtime control and tests;
- `apps/server/src/http/` for Connect construction, interceptors, request correlation, and the managed-runtime bridge;
- `apps/server/src/database/` for the narrow authentication capability and marker mutation; and
- `apps/server/src/contracts/` for pure method-authority and field-error policy.

Update Fallow only for these concrete zones and dependency directions. Do not add generic `core`, `shared`, `utils`, repository, or interface zones.

## Private Better Auth boundary

The adapter is the only production module that loads Better Auth. Use Node's proven runtime module loader and validate that the Better Auth factory, Drizzle adapter, and bearer plugin exports are callable before constructing the runtime. Handwritten private types describe only the methods and values Nama consumes. Runtime result checks protect the remaining seam.

Configuration:

- application base URL is the immutable configured public URL;
- secret is 32 HKDF output bytes encoded as unpadded base64url;
- email/password is enabled;
- automatic sign-in is disabled;
- password length is 8–128 characters;
- Better Auth logging and telemetry are disabled;
- bearer tokens require signatures;
- the Drizzle adapter uses the exact generated `user`, `session`, `account`, and `verification` schema;
- the Drizzle adapter uses PostgreSQL and transactions; and
- no Better Auth migration or route handler runs at runtime.

Transaction support is required. Better Auth signup creates the user and credential account inside one adapter transaction. Startup repair may therefore observe zero users or one complete user/account pair, never a committed user without its credential account from a normal signup failure.

The adapter accepts plain Nama inputs. For authenticated calls it accepts only the allowlisted Authorization value and constructs fresh `Headers` internally. Arbitrary request headers never reach Better Auth.

The adapter may return only:

- administrator `id`, `displayName`, and normalized `email`;
- a signed bearer and session expiry for SignIn;
- an invalid-credentials outcome;
- an invalid-bearer outcome;
- an authentication-store-unavailable outcome;
- an unconfirmed-revocation outcome; or
- a private defect outcome.

Raw session tokens, cookies, Better Auth users, Better Auth sessions, adapter objects, errors, response bodies, and internal headers never cross the module.

## HTTP and Connect dispatch

Dispatch order:

1. Match exact operational health routes.
2. For every other request, generate a UUID request ID at Node dispatch.
3. Set `nama-request-id` before Connect decoding.
4. Delegate to `connectNodeAdapter`.
5. Return 404 when no registered Connect path matches.

Health response shape, route exactness, readiness probe bounds, listener ownership, and shutdown behavior remain unchanged except that runtime-control readiness becomes an additional fail-closed readiness input.

Register all generated public services. Provide implementations only for Setup and Auth methods in this issue. Connect supplies `UNIMPLEMENTED` for omitted methods after interceptors run. This makes an unauthenticated protected future method fail before its implementation status is exposed.

Do not register private plugin services. Unknown services and paths do not gain application behavior.

Connect 2.1.2 decodes unary input before invoking interceptors. A malformed body can therefore fail before Nama can attach `RequestInfo`. The server-owned `nama-request-id` header is the client-visible correlation fallback for those failures. Every application-generated error still carries `RequestInfo` with the same value.

## Request pipeline

For a decoded unary request:

1. recover the server request ID;
2. apply setup-state precedence where specified;
3. consume the global SignIn budget when applicable;
4. authorize the method;
5. validate the Protobuf message;
6. consume the per-identity SignIn budget when applicable;
7. invoke the handler;
8. normalize the outcome; and
9. emit one terminal RPC log record.

### State precedence

- A configured `CreateAdministrator` always fails with `ALREADY_INITIALIZED`.
- A setup-eligible `SignIn` fails with `NOT_INITIALIZED`.
- A setup-eligible `BeginPairing` reaches the accepted `NOT_INITIALIZED` gate even though pairing behavior remains unimplemented.
- `GetStatus` always returns the process setup state.
- Protected methods authenticate before validation.

### Authorization

Build the fully qualified method name from generated service and method descriptors. Look it up in `contractAuthorityByMethod`.

- Missing inventory entry fails `PERMISSION_DENIED`.
- `public` requires no credential.
- `bootstrap-token` defers body credential validation to the setup coordinator.
- `administrator` accepts only a valid Better Auth administrator session.
- `administrator-or-device` accepts an administrator now; device credentials remain unimplemented.
- `polling-token` has no valid runtime principal in issue #23.
- `plugin-bearer` is unreachable on the public listener.

A valid administrator is stored only in Connect request context. There is no mutable global current user.

Missing, malformed, expired, or revoked administrator bearers fail `UNAUTHENTICATED/CREDENTIAL_INVALID`. Failure to query the authoritative session store fails `UNAVAILABLE/AUTHENTICATION_UNAVAILABLE`. A valid principal without the required authority fails `PERMISSION_DENIED/PERMISSION_DENIED`.

### Validation

Use pinned Protovalidate annotations on every implemented request. Normalize no more than 50 violations in deterministic Protobuf field-path order.

| Validation condition | Field reason |
| --- | --- |
| Required value absent | `REQUIRED` |
| Email or other format invalid | `INVALID_FORMAT` |
| Minimum or maximum violated | `OUT_OF_RANGE` |
| Enum or value unsupported | `UNSUPPORTED_VALUE` |
| Cross-field equality failed | `MISMATCH` |
| Values conflict | `CONFLICT` |

Use fixed Nama descriptions. Do not forward validator messages or inputs. Validator compilation or runtime failure is `INTERNAL/INTERNAL`.

### Error details

Expected application failures carry `google.rpc.ErrorInfo` and `google.rpc.RequestInfo`. Validation adds `google.rpc.BadRequest`. Rate limiting adds `google.rpc.RetryInfo`.

New mappings:

| Condition | Connect code | Stable reason |
| --- | --- | --- |
| Concurrent valid setup claim | `ABORTED` | `SETUP_IN_PROGRESS` |
| Defensive pre-activation setup state | `UNAVAILABLE` | `SETUP_UNAVAILABLE` |
| Authentication store cannot serve a sign-in or session read | `UNAVAILABLE` | `AUTHENTICATION_UNAVAILABLE` |

Unsafe writes receive no automatic retry guidance. Unexpected defects become `INTERNAL/INTERNAL` with the request ID and no private cause.

### RPC logging

Emit one allowlisted terminal record after decoding enters the application pipeline:

- event `rpc.completed`;
- request ID;
- fully qualified RPC method;
- Connect code; and
- duration in milliseconds.

Expected client errors do not add stacks. Unexpected defects may add existing sanitized stack frames. Never log bodies, arbitrary URLs, headers, client credentials, user identity, email, email digest, bootstrap token, password, bearer, session data, database detail, or Better Auth data.

## Runtime control

Runtime control begins not ready. The root application marks it ready only after listener binding and bootstrap activation complete. Readiness requires:

- listener accepting state;
- runtime-control ready state; and
- successful bounded database probe.

The root application waits for signal interruption or the fatal-runtime latch. A fatal post-bind failure:

1. changes runtime readiness to false synchronously;
2. completes the latch once;
3. emits one safe `server.runtime_failed` record;
4. closes the listener through the existing bounded drain;
5. disposes the shared request runtime;
6. closes the database pool; and
7. exits non-zero.

Normal signal shutdown and finalizer-failure behavior remain distinct. A failed request fiber alone never terminates the process.

## Setup flow

### GetStatus

Seed process state from startup reconciliation:

- `configured` means initialized;
- `setup-eligible` means uninitialized.

Only confirmed durable marker completion changes uninitialized to initialized. An ambiguous setup attempt makes the runtime unavailable and exits before another status request can succeed.

### CreateAdministrator

1. Reject configured state.
2. Validate request fields.
3. Claim the bootstrap token.
4. Mark the attempt commit-capable immediately before Better Auth signup.
5. Mask interruption across signup and marker completion.
6. Create the user and credential account transactionally through Better Auth.
7. Conditionally set both marker fields with database transaction time and the created user ID.
8. Require exactly one updated marker row.
9. Change process setup state to initialized.
10. Succeed the bootstrap attempt.
11. Return only the administrator.

Claim failures map as follows:

| Bootstrap state | Public result |
| --- | --- |
| Invalid candidate | `UNAUTHENTICATED/AUTHENTICATION_FAILED` |
| Another valid attempt active | `ABORTED/SETUP_IN_PROGRESS` |
| Activation pending | `UNAVAILABLE/SETUP_UNAVAILABLE` |
| Configured or disabled | `FAILED_PRECONDITION/ALREADY_INITIALIZED` |

The token is validated before password hashing. Administrator creation never returns a session.

The Better Auth server API does not expose the exact point where its transaction can commit. Treat every failure after API invocation begins as ambiguous. Do not add Better Auth hooks, async-local signaling, or guessed rollback classification.

On ambiguous authentication or marker outcome:

- the scoped token attempt disables and destroys its digest;
- runtime readiness becomes false;
- the root exits non-zero; and
- startup reconciliation determines durable truth.

Reconciliation then observes zero users and emits a new process token, observes one complete user/account and repairs the marker, or rejects corruption. No write is retried.

Cancellation before commit-capable work restores the same token. Cancellation or deadline after that boundary cannot interrupt signup plus marker completion. A lost successful response is recovered by `GetStatus`, then `SignIn`.

## SignIn limiter

Use fixed process-local windows.

### Global window

- length: 10 seconds;
- first 100 SignIn attempts proceed;
- attempt 101 and later fail until the window resets; and
- every decoded SignIn attempt in initialized state counts.

### Identity window

- key: SHA-256 of the validated lowercase email;
- length: 15 minutes;
- first 5 attempts proceed;
- attempt 6 and later fail until the window resets; and
- successful SignIn removes that identity entry.

Validate email before creating the identity key. Invalid fields consume the global budget but create no identity entry. Prune expired entries before insertion. The global budget bounds adversarial key growth. Store no plaintext email, user ID, credential, or database state.

Rate-limit failure is `RESOURCE_EXHAUSTED/RATE_LIMITED` with the remaining fixed-window delay in `RetryInfo`. Limiter state resets on process restart. Multi-process coordination and a persistent limiter remain deferred.

## Authentication flows

### SignIn

1. Require initialized state.
2. Apply both limiter decisions.
3. Call Better Auth email/password sign-in.
4. Map only the pinned invalid-email-or-password outcome to `AUTHENTICATION_FAILED`.
5. Map authoritative store failures to `AUTHENTICATION_UNAVAILABLE`.
6. Extract only the non-empty signed `set-auth-token` header.
7. Resolve that bearer once to obtain the authoritative administrator and session expiry.
8. Return the mapped administrator and `BearerCredential`.

Unknown email and wrong password have the same code, reason, message shape, and details. A missing or malformed signed-token response is a private defect, not an authentication failure. Never expose Better Auth's raw response token or cookies.

### GetCurrentUser

The authorization interceptor resolves the bearer and stores the mapped administrator in request context. The handler returns only that value.

### SignOut

1. Authenticate the presented bearer.
2. Call Better Auth sign-out with fresh headers containing only that authorization value.
3. Ignore Better Auth's success result.
4. Resolve the same bearer again with cookie cache and session refresh disabled.
5. Return success only when the authoritative lookup returns no session.

A remaining session or failed confirmation returns `UNAVAILABLE/SESSION_REVOCATION_UNCONFIRMED`. Only the presented session is revoked. Other administrator sessions remain valid.

The caller retains the bearer after an unconfirmed result. `GetCurrentUser` resolves ambiguity: unauthenticated means revoked; a valid current user permits an explicit SignOut retry.

## Cancellation and deadlines

Connect request and timeout signals interrupt the tracked Effect request. Do not create detached request fibers. Better Auth's Promise APIs do not accept AbortSignal; underlying PostgreSQL work remains bounded by the existing query timeout while the interrupted Effect stops producing a response.

Setup masks interruption only after the commit-capable boundary. SignIn and SignOut remain unsafe for automatic retry. A cancelled SignOut may already have revoked its session; the client resolves state through `GetCurrentUser`.

Shutdown waits for tracked health and RPC fibers for at most the existing drain interval, interrupts the remainder, disposes the one managed runtime, then closes the shared pool.

## Dependencies and generated ownership

Add exact runtime dependencies:

- `@connectrpc/connect@2.1.2`;
- `@connectrpc/connect-node@2.1.2`; and
- production ownership for Better Auth, Protovalidate, and any directly imported Protobuf runtime already pinned in the workspace.

Keep the Better Auth CLI and Drizzle generation tooling as development dependencies. Do not add another package, generator, root task, lockfile policy, or version range.

Change password annotations only in the authoritative Protobuf files. Run `mise run generate` and commit every generated TypeScript, Go, and Swift leaf. Never edit `gen/` by hand.

Runtime Better Auth behavior changes do not alter its table model. Regenerate the Better Auth schema through the existing command and require byte-identical output. Do not create a migration when generated schema and reviewed SQL remain unchanged.

## Expected change surface

- `apps/server/package.json` and `pnpm-lock.yaml`;
- `proto/nama/api/v1/setup.proto` and `proto/nama/api/v1/auth.proto`;
- generated leaves under `gen/` through Buf;
- `apps/server/better-auth.config.ts` for matching non-schema email/password behavior;
- authentication, lifecycle, HTTP, database, contract, composition, logging, and focused test files under `apps/server/`;
- `apps/server/.fallowrc.json` for approved concrete zones;
- disposable PostgreSQL and process integration tests;
- `docs/architecture.md`;
- `docs/architecture/api-contracts.md`;
- `docs/architecture/core-server.md`;
- `docs/architecture/authentication-and-setup.md`; and
- `AGENTS.md` only if implementation reveals a new durable repository failure rule.

No CLI, plugin, provider, pairing implementation, database migration, or hand-edited auth schema belongs to this issue.

## Verification

Follow test-driven development. Observe each focused failure for the intended reason before implementation.

### Focused behavior

Verify:

- exact global and identity limiter thresholds;
- fixed-window retry delays;
- identity reset after successful sign-in;
- expired-entry pruning and bounded key growth;
- HKDF derivation context and output shape;
- runtime Better Auth export guards;
- strict private response-shape checks;
- password validation at 7, 8, 128, and 129 characters;
- deterministic field paths, reasons, descriptions, ordering, and 50-item cap;
- authorization before validation;
- default denial for every method absent from the authority inventory;
- administrator context remains request-local;
- `nama-request-id` on malformed Connect input;
- matching `RequestInfo` on application errors;
- secret absence from errors and logs;
- invalid claim preservation;
- deterministic concurrent setup rejection;
- pre-commit cancellation restoration;
- successful marker completion and setup closure;
- ambiguous auth and marker outcomes set readiness false and complete the fatal latch;
- post-commit cancellation finishes the protected boundary;
- request cancellation, deadline mapping, drain, and managed-runtime disposal; and
- fatal runtime logging and non-zero application result.

### Generated-client and PostgreSQL behavior

Against disposable PostgreSQL, verify:

1. exact health precedence and 404 for Better Auth routes;
2. `GetStatus` false before setup;
3. SignIn before setup returns `NOT_INITIALIZED`;
4. invalid setup fields and wrong tokens preserve eligibility;
5. concurrent setup creates exactly one user and one credential account;
6. successful setup sets both marker fields, returns no session, closes token reuse, and changes status;
7. configured restart emits no bootstrap token;
8. ambiguous create and cancelled post-commit work recover through startup reconciliation;
9. unknown email and wrong password return indistinguishable failures;
10. the sixth identity attempt and 101st global attempt return `RATE_LIMITED` with `RetryInfo`;
11. successful SignIn returns a signed bearer and valid expiry;
12. the bearer authenticates GetCurrentUser;
13. missing, malformed, expired, and revoked bearers fail closed;
14. an unauthenticated protected unimplemented method fails before validation;
15. an authenticated administrator reaches Connect's `UNIMPLEMENTED` handler;
16. forced PostgreSQL session-deletion failure returns `SESSION_REVOCATION_UNCONFIRMED` while the same bearer remains valid;
17. successful SignOut removes the presented session and invalidates that bearer;
18. another administrator session remains valid;
19. session-store outage returns `AUTHENTICATION_UNAVAILABLE`; and
20. stdout, stderr, response errors, and RPC logs contain no bootstrap token, password, bearer, database detail, or Better Auth error.

Use the actual package entrypoint for the normal lifecycle. Use production layer constructors with controlled private test implementations only for deterministic commit ambiguity and cancellation. Production modules never import test support.

### Required commands

1. Run focused server tests.
2. Run focused disposable-PostgreSQL integration tests.
3. Run `mise run check:contracts`.
4. Run `mise run check:ts`.
5. Run `mise run check`.

Contract checks prove schema format, lint, build, generated drift, and consumer compilation. They do not prove Apple application runtime behavior.

## Acceptance mapping

| Acceptance | Design proof |
| --- | --- |
| App-owned setup/auth behavior backed by Better Auth | Generated clients exercise all five Setup/Auth methods while Better Auth routes remain 404. |
| Protected RPCs fail closed | Every generated public service is registered behind exhaustive authorization. Unauthenticated requests fail before validation or unimplemented handlers. |
| Confirmed SignOut revokes the presented session | Real PostgreSQL deletion, post-delete authoritative lookup, same-bearer rejection, and second-session preservation. |
| Failed revocation never reports success | Forced delete failure returns `SESSION_REVOCATION_UNCONFIRMED`; the bearer remains demonstrably valid. |
| Setup creates only one administrator | Single-flight token claim, transactional user/account creation, conditional marker update, concurrent proof, and restart reconciliation. |
| Public failures are safe and actionable | Stable Connect reasons, request correlation, allowlisted details, rate-limit retry delay, and secret-absence assertions. |

## Documentation completion after implementation

Update the architecture baseline only after runtime verification passes.

- Record Connect runtime integration without claiming CLI or device behavior.
- Record the password-bound compatibility exception and regenerated bindings.
- Record the new setup and authentication availability reasons.
- Record `nama-request-id` as the decoder-failure correlation fallback.
- Record transactional Better Auth signup, fatal ambiguity handling, and confirmed sign-out evidence.
- Mark issue #23 handlers implemented in the core-server and authentication notes.
- Keep device pairing and later Milestone 2 CLI behavior unfinished.
