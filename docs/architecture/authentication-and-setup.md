# Authentication, setup, and pairing

Status: setup and administrator-authentication runtime is implemented and verified. Device pairing, CLI setup/sign-in, and Apple-client behavior remain unfinished.

Nama owns the public setup and authentication semantics. Better Auth is a private server-side implementation detail used only by the runtime-loaded adapter behind `SetupService` and `AuthService`; generated auth persistence alone is not the boundary ([ADR-0007](../adr/0007-private-better-auth-adapter.md)).

## Implemented runtime boundary

The private adapter is the only production module that loads Better Auth. Better Auth routes, cookies, request and response models, errors, raw sessions, and secrets never cross that boundary and are never mounted. It uses the shared PostgreSQL pool through the database module's narrow Drizzle capability, while `better-auth.config.ts` remains tooling-only and the committed generated auth schema remains its sole model source. The adapter derives a 32-byte secret from the redacted master key with HKDF-SHA-256 and context `nama/better-auth/v1`, encodes it as unpadded base64url, enables email/password and signed bearer credentials, disables automatic sign-in, logging, and telemetry, and leaves Better Auth's session lifecycle unchanged.

Under [ADR-0025](../adr/0025-default-deny-rpc-authorization.md), all generated public descriptors are registered behind the default-deny method inventory, so authorization precedes an unimplemented handler. The implemented runtime supports `SetupService.GetStatus`, `SetupService.CreateAdministrator`, `AuthService.SignIn`, `AuthService.GetCurrentUser`, and `AuthService.SignOut`. Device descriptors have no pairing or device-credential behavior.

## Durable setup and recovery ([ADR-0008](../adr/0008-fail-closed-setup-reconciliation.md))

Startup reconciliation remains the only source of setup eligibility. The singleton marker and one administrator must agree: an initialized marker requires exactly one user; an uninitialized marker with one user is conditionally repaired; zero users is setup-eligible; a missing marker, multiple users, or any other disagreement is fatal. Setup never reopens after initialization or corruption.

On an eligible start, the listener-bound bootstrap service emits one high-entropy token, retains only its digest, and permits one scoped claim. While a claim is active, only its matching token returns `ABORTED/SETUP_IN_PROGRESS`; every other candidate returns `UNAUTHENTICATED/AUTHENTICATION_FAILED`. `CreateAdministrator` validates the token before password hashing, disables automatic sign-in, creates the Better Auth user and credential account transactionally, then conditionally completes both durable marker fields. It returns an administrator and never a session.

Before creation becomes commit-capable, cancellation restores the claim. Afterwards, interruption is masked: any ambiguous authentication or marker result destroys the digest, makes runtime readiness false, and exits non-zero. In that fatal process state, `GetStatus` fails `UNAVAILABLE/SETUP_UNAVAILABLE` rather than returning `initialized=false`. Restart reconciliation then determines durable truth—zero users may receive a new process token, one complete user repairs the marker and then reports initialized, and corruption remains fatal. No setup write is retried.

## Administrator authentication

`SignIn` applies process-local fixed windows: 100 decoded attempts per 10-second global window and five validated normalized-email attempts per 15-minute identity window. Invalid fields consume only the global budget; the identity key is a SHA-256 digest and never plaintext email. A successful sign-in clears its identity entry, expired entries are pruned, and rate-limit failures carry the remaining window delay in `google.rpc.RetryInfo`; all limiter state resets on process restart. Invalid credentials have one public shape, and the adapter returns only the administrator, signed bearer extracted from its private `set-auth-token` response header, and session expiry.

Bearer resolution accepts only the allowlisted Authorization value and stores the mapped administrator in request context. `GetCurrentUser` returns that request-local value. Better Auth owns expiry, rotation, and revocation; Nama adds no refresh-token protocol.

Under [ADR-0009](../adr/0009-confirm-durable-session-revocation.md), `SignOut` ignores Better Auth's claimed success and confirms that the presented bearer no longer resolves through the durable session store. A remaining session, deletion failure, or failed confirmation returns `UNAVAILABLE` with `SESSION_REVOCATION_UNCONFIRMED`; callers retain the bearer and use `GetCurrentUser` to resolve ambiguity. Only the presented session is revoked.

## Correlation, safety, and verification

[ADR-0026](../adr/0026-standard-google-rpc-error-details.md) governs application failure details, and [ADR-0027](../adr/0027-logical-operation-idempotency.md) keeps server-owned request correlation separate from logical-operation identity. The outer Node dispatch assigns server-owned `nama-request-id` to every delegated Connect response before decoding. Application-generated failures carry the same value in `google.rpc.RequestInfo`; malformed Connect input may fail before the application pipeline, so the response header is the correlation fallback. Terminal RPC logs contain only the request ID, method, Connect code, and duration. Public errors and logs never expose credentials, identities, passwords, bootstrap tokens, database detail, or Better Auth data.

Focused, disposable-PostgreSQL, generated-client, and package-entrypoint process coverage verifies setup creation and restart repair, sign-in/current-user/sign-out, forced session-deletion failure, rate limits, cancellation, correlation, public-error and log redaction, readiness, and fatal ambiguity handling.

## Unfinished work

Device pairing—including human codes, polling tokens, approval, device credentials, listing, and revocation—is not implemented. No CLI flow creates or signs in an administrator, and no Apple client discovers, pairs with, or stores a credential. Public signup, invitations, password recovery, OAuth/OIDC, multiple roles, and a web administration UI remain outside the implemented runtime.
