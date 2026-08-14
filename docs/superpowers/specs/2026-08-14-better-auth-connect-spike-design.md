# Better Auth Connect Spike Design

Status: approved on 2026-08-14 for GitHub sub-issue #18.

## Goal

Prove the disposable Milestone 1 authentication risk through Nama-owned generated Connect RPCs: create the sole administrator, sign in, authenticate a protected current-user call with the returned bearer, and sign out. Better Auth types and HTTP endpoints remain private. A failed session deletion must never produce a successful Nama sign-out while the bearer remains valid.

## Scope

The spike adds a loopback Node server and one focused behavioral test under `apps/server/src`. It uses the existing `nama.api.v1` `SetupService` and `AuthService` descriptors without changing Protobuf. It does not implement the Milestone 2 Effect application, PostgreSQL persistence, migrations, configuration, bootstrap-token restart semantics, CLI integration, or production lifecycle.

Approved exact runtime dependencies are:

- `better-auth@1.6.26`
- `@connectrpc/connect@2.1.2`
- `@connectrpc/connect-node@2.1.2`

The spike uses Better Auth's official stateful memory adapter. That adapter is test-only evidence for Better Auth/Connect translation and revocation behavior; it is not PostgreSQL or durable restart proof.

## Components

### Better Auth adapter boundary

`auth-spike.ts` is the only module that imports Better Auth. It configures email/password authentication with automatic sign-in disabled and the bearer plugin with signed tokens required. The backing memory adapter accepts a test-controlled session-delete fault so the behavioral test can reproduce Better Auth `v1.6.26` swallowing a database deletion exception in its sign-out endpoint.

The module exposes only Nama-owned startup inputs and shutdown controls. No Better Auth request, response, user, session, adapter, or error type crosses the module boundary.

### Nama Connect boundary

A native loopback Node listener delegates RPC traffic to `connectNodeAdapter`. Only existing `SetupService` and `AuthService` methods are registered. Better Auth's HTTP handler is never mounted.

`CreateAdministrator` verifies and consumes an injected bootstrap token, calls Better Auth's private email signup API, and maps the resulting user to the generated `Administrator` message. `SignIn` calls Better Auth's private email sign-in API, extracts the signed token from the `set-auth-token` response header, and returns a generated `BearerCredential` and `Administrator`.

A Connect interceptor protects `GetCurrentUser` and `SignOut`. It reads `Authorization: Bearer`, resolves the Better Auth session, and makes only the mapped Nama administrator identity available to handlers. Missing, malformed, expired, or revoked credentials fail with `UNAUTHENTICATED` and stable reason `CREDENTIAL_INVALID`.

### Confirmed sign-out

`SignOut` calls Better Auth's private sign-out API with the presented bearer, then resolves the same bearer again against the stateful session store. It reports success only when the credential no longer resolves.

If Better Auth reports success but the credential still resolves, Nama returns `UNAVAILABLE` with stable reason `SESSION_REVOCATION_UNCONFIRMED`. The bearer remains with the caller for ambiguity resolution and retry. Raw Better Auth and adapter errors are discarded at the private boundary; responses contain no session token, password, bootstrap token, stack, or internal database detail.

## Behavioral proof

The focused Node test starts the actual loopback Connect server and uses generated clients to execute one flow:

1. Create an administrator with the bootstrap token.
2. Sign in and receive a signed bearer credential.
3. Call protected `GetCurrentUser` with that credential and verify the mapped administrator.
4. Enable the session-delete fault.
5. Call `SignOut` and require `UNAVAILABLE` plus `SESSION_REVOCATION_UNCONFIRMED`.
6. Call `GetCurrentUser` with the same bearer and require success, proving the server did not claim sign-out while the bearer remained valid.
7. Disable the fault, call `SignOut` successfully, then require the same bearer to fail with `UNAUTHENTICATED`.

The test also verifies public failures contain no configured or issued secret. Existing TypeScript checks and the complete repository check remain owning verification.

## Durable evidence

After the behavioral proof passes, `docs/architecture/authentication-and-setup.md` records the pinned Better Auth behavior, Nama's post-sign-out session confirmation rule, the exact focused command, and the explicit limitation that PostgreSQL and production server lifecycle remain Milestone 2 work. The spike code stays disposable; the boundary decision and regression evidence remain.
