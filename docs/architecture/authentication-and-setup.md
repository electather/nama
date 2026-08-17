# Authentication, setup, and pairing

Status: issue #23 server setup and administrator authentication plus issue #24 CLI setup, sign-in, and status are implemented and verified. Device pairing and Apple-client behavior remain unfinished.

Nama owns the public setup and authentication semantics. Better Auth is a private server-side implementation detail used only by the runtime-loaded adapter behind `SetupService` and `AuthService`; generated auth persistence alone is not the boundary.

## Implemented runtime boundary

The private adapter is the only production module that loads Better Auth. Better Auth routes, cookies, request and response models, errors, raw sessions, and secrets never cross that boundary and are never mounted. It uses the shared PostgreSQL pool through the database module's narrow Drizzle capability, while `better-auth.config.ts` remains tooling-only and the committed generated auth schema remains its sole model source. The adapter derives a 32-byte secret from the redacted master key with HKDF-SHA-256 and context `nama/better-auth/v1`, encodes it as unpadded base64url, enables email/password and signed bearer credentials, disables automatic sign-in, logging, and telemetry, and leaves Better Auth's session lifecycle unchanged.

All generated public descriptors are registered behind the default-deny method inventory, so authorization precedes an unimplemented handler. The issue implements `SetupService.GetStatus`, `SetupService.CreateAdministrator`, `AuthService.SignIn`, `AuthService.GetCurrentUser`, and `AuthService.SignOut`. Device descriptors have no pairing or device-credential behavior.

## Durable setup and recovery

Startup reconciliation remains the only source of setup eligibility. The singleton marker and one administrator must agree: an initialized marker requires exactly one user; an uninitialized marker with one user is conditionally repaired; zero users is setup-eligible; a missing marker, multiple users, or any other disagreement is fatal. Setup never reopens after initialization or corruption.

On an eligible start, the listener-bound bootstrap service emits one high-entropy token, retains only its digest, and permits one scoped claim. While a claim is active, only its matching token returns `ABORTED/SETUP_IN_PROGRESS`; every other candidate returns `UNAUTHENTICATED/AUTHENTICATION_FAILED`. `CreateAdministrator` validates the token before password hashing, disables automatic sign-in, creates the Better Auth user and credential account transactionally, then conditionally completes both durable marker fields. It returns an administrator and never a session.

Before creation becomes commit-capable, cancellation restores the claim. Afterwards, interruption is masked: any ambiguous authentication or marker result destroys the digest, makes runtime readiness false, and exits non-zero. In that fatal process state, `GetStatus` fails `UNAVAILABLE/SETUP_UNAVAILABLE` rather than returning `initialized=false`. Restart reconciliation then determines durable truth—zero users may receive a new process token, one complete user repairs the marker and then reports initialized, and corruption remains fatal. No setup write is retried.

## Administrator authentication

`SignIn` applies process-local fixed windows: 100 decoded attempts per 10-second global window and five validated normalized-email attempts per 15-minute identity window. Invalid fields consume only the global budget; the identity key is a SHA-256 digest and never plaintext email. A successful sign-in clears its identity entry, expired entries are pruned, and rate-limit failures carry the remaining window delay in `google.rpc.RetryInfo`; all limiter state resets on process restart. The CLI retains that delay as a typed duration for logic and renders a positive JSON `retry_delay` as a unit-bearing string. Invalid credentials have one public shape, and the adapter returns only the administrator, signed bearer extracted from its private `set-auth-token` response header, and session expiry.

Bearer resolution accepts only the allowlisted Authorization value and stores the mapped administrator in request context. `GetCurrentUser` returns that request-local value. Better Auth owns expiry, rotation, and revocation; Nama adds no refresh-token protocol.

`SignOut` ignores Better Auth's claimed success and confirms that the presented bearer no longer resolves through the durable session store. A remaining session, deletion failure, or failed confirmation returns `UNAVAILABLE` with `SESSION_REVOCATION_UNCONFIRMED`; callers retain the bearer and use `GetCurrentUser` to resolve ambiguity. Only the presented session is revoked.

The Go CLI implements named profile targeting, setup followed by sign-in, later sign-in, and authentication status over these RPCs. It keeps bearer credentials only in the native credential facility, binds each record to its canonical full server target, and never falls back to a plaintext file. Malformed and legacy unbound records never attach; a successful deletion makes them an absent credential that setup or login may replace, while deletion failure is a typed, fail-closed credential-cleanup error. A process-injected bearer is eligible for authentication status without native-store access and is never persisted or deleted; setup and login reject while the injection is active so they cannot orphan a newly issued bearer. Lost non-wire setup responses are recovered by status without replaying administrator creation. Once recovery confirms initialization, sign-in and credential storage use a separate fresh bounded settlement context even if the original caller context expired; known wire application failures still return directly. Malformed sign-in responses with a usable bearer are revoked. Failed local credential storage restores the prior native state and revokes the new session, and an unconfirmed revocation takes precedence over the storage error.

## Correlation, safety, and verification

The outer Node dispatch assigns server-owned `nama-request-id` to every delegated Connect response before decoding. Application-generated failures carry the same value in `google.rpc.RequestInfo`; malformed Connect input may fail before the application pipeline, so the response header is the correlation fallback. Terminal RPC logs contain only the request ID, method, Connect code, and duration. Public errors and logs never expose credentials, identities, passwords, bootstrap tokens, database detail, or Better Auth data.

Focused server and CLI coverage, disposable PostgreSQL, generated clients, compiled-command smoke tests, and package-entrypoint process coverage verify setup creation and restart repair, sign-in/current-user/sign-out, CLI setup recovery and credential replacement, forced session-deletion failure, rate limits, cancellation, correlation, public-error and log redaction, readiness, and fatal ambiguity handling. A local macOS flow additionally verifies setup and stored-session status through Keychain; it is not portable keyring coverage.

## Unfinished work

Device pairing—including human codes, polling tokens, approval, device credentials, listing, and revocation—is not implemented. CLI sign-out and Apple-client discovery, pairing, and credential storage remain unfinished. Public signup, invitations, password recovery, OAuth/OIDC, multiple roles, and a web administration UI remain outside the implemented runtime.
