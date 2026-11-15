# Authentication, setup, and OAuth authorization

Status: issue #23 server setup and Administrator authentication plus issue #24 CLI setup, sign-in, and status are implemented and verified. Issue #145 defines the accepted Better Auth OAuth authorization target with authenticated CLI approval; its runtime, wire-contract, CLI, and Apple behavior remain unimplemented. Issue #167 separately owns browser approval.

Nama owns public setup, Administrator authentication, and protected-resource authorization semantics. The implemented setup and CLI Administrator-authentication adapter remains private behind `SetupService` and `AuthService`; [ADR-0033](../adr/0033-better-auth-oauth-device-authorization.md) deliberately exposes only the fixed Apple client's standard OAuth metadata, JWKS, device-code, token, refresh, and revocation routes, superseding that part of [ADR-0007](../adr/0007-private-better-auth-adapter.md). CLI approval remains a generated `AuthService` operation over the private adapter. Browser email/password and session routes remain private unless issue #167 implements its separate web-app surface.

## Implemented runtime boundary

The private adapter is currently the only production module that loads Better Auth. Better Auth routes, cookies, request and response models, errors, raw sessions, and secrets are not mounted in the implemented runtime. The adapter uses the shared PostgreSQL pool through the database module's narrow Drizzle capability, while `better-auth.config.ts` remains tooling-only and the committed generated auth schema remains its sole model source. It derives a 32-byte secret from the redacted master key with HKDF-SHA-256 and context `nama/better-auth/v1`, encodes it as unpadded base64url, enables email/password and signed bearer credentials, disables automatic sign-in, logging, and telemetry, and leaves Better Auth's Administrator-session lifecycle unchanged.

Under [ADR-0025](../adr/0025-default-deny-rpc-authorization.md), all generated public descriptors are registered behind the default-deny method inventory, so authorization precedes an unimplemented handler. The implemented runtime supports `SetupService.GetStatus`, `SetupService.CreateAdministrator`, `AuthService.SignIn`, `AuthService.GetCurrentUser`, and `AuthService.SignOut`. The unimplemented `DeviceService` descriptors remain generated only until issue #145 removes the obsolete contract.

## Durable setup and recovery ([ADR-0008](../adr/0008-fail-closed-setup-reconciliation.md))

Startup reconciliation remains the only source of setup eligibility. The singleton marker and one administrator must agree: an initialized marker requires exactly one user; an uninitialized marker with one user is conditionally repaired; zero users is setup-eligible; a missing marker, multiple users, or any other disagreement is fatal. Setup never reopens after initialization or corruption.

On an eligible start, the listener-bound bootstrap service emits one high-entropy token, retains only its digest, and permits one scoped claim. While a claim is active, only its matching token returns `ABORTED/SETUP_IN_PROGRESS`; every other candidate returns `UNAUTHENTICATED/AUTHENTICATION_FAILED`. `CreateAdministrator` validates the token before password hashing, disables automatic sign-in, creates the Better Auth user and credential account transactionally, then conditionally completes both durable marker fields. It returns an administrator and never a session.

Before creation becomes commit-capable, cancellation restores the claim. Afterwards, interruption is masked: any ambiguous authentication or marker result destroys the digest, makes runtime readiness false, and exits non-zero. In that fatal process state, `GetStatus` fails `UNAVAILABLE/SETUP_UNAVAILABLE` rather than returning `initialized=false`. Restart reconciliation then determines durable truth—zero users may receive a new process token, one complete user repairs the marker and then reports initialized, and corruption remains fatal. No setup write is retried.

## Administrator authentication

`SignIn` applies process-local fixed windows: 100 decoded attempts per 10-second global window and five validated normalized-email attempts per 15-minute identity window. Invalid fields consume only the global budget; the identity key is a SHA-256 digest and never plaintext email. A successful sign-in clears its identity entry, expired entries are pruned, and rate-limit failures carry the remaining window delay in `google.rpc.RetryInfo`; all limiter state resets on process restart. The CLI retains that delay as a typed duration for logic and renders a positive JSON `retry_delay` as a unit-bearing string. Invalid credentials have one public shape, and the adapter returns only the administrator, signed bearer extracted from its private `set-auth-token` response header, and session expiry.

Bearer resolution accepts only the allowlisted Authorization value and stores the mapped administrator in request context. `GetCurrentUser` returns that request-local value. Better Auth owns expiry, rotation, and revocation; Nama adds no refresh-token protocol.

Under [ADR-0009](../adr/0009-confirm-durable-session-revocation.md), `SignOut` ignores Better Auth's claimed success and confirms that the presented bearer no longer resolves through the durable session store. A remaining session, deletion failure, or failed confirmation returns `UNAVAILABLE` with `SESSION_REVOCATION_UNCONFIRMED`; callers retain the bearer and use `GetCurrentUser` to resolve ambiguity. Only the presented session is revoked.

The Go CLI implements named profile targeting, setup followed by sign-in, later sign-in, and authentication status over these RPCs. It keeps bearer credentials only in the native credential facility, binds each record to its canonical full server target, and never falls back to a plaintext file. Malformed and legacy unbound records never attach; a successful deletion makes them an absent credential that setup or login may replace, while deletion failure is a typed, fail-closed credential-cleanup error. A process-injected bearer is eligible for authentication status without native-store access and is never persisted or deleted; setup and login reject while the injection is active so they cannot orphan a newly issued bearer. Lost non-wire setup responses are recovered by status without replaying administrator creation. Once recovery confirms initialization, sign-in and credential storage use a separate fresh bounded settlement context even if the original caller context expired; known wire application failures still return directly. Malformed sign-in responses with a usable bearer are revoked. Failed local credential storage restores the prior native state and revokes the new session, and an unconfirmed revocation takes precedence over the storage error.

## Target Better Auth authorization server

Issue #145 adds the exact compatible Better Auth JWT, OAuth Provider, and OAuth
Device Authorization plugins. Better Auth owns the RFC 8628 device-code
records, issuance and polling endpoints, approval state, token issuance,
refresh rotation, expiry, revocation endpoints, migrations, and cleanup. Nama
does not wrap the Apple client's device-code, token, or refresh protocol in
Connect or maintain parallel code, digest, delivery-envelope, approval-result,
Device, or cleanup records. The one Connect approval method is a role-neutral
authenticated-principal adapter over Better Auth's internal APIs.

The existing listener publicly delegates Better Auth's OAuth
authorization-server metadata, required protected-resource metadata, JWKS,
device-code issuance, token exchange, refresh, and revocation routes. It does
not expose verification or approve/deny routes for issue #145. The generated
`AuthService.ApproveDeviceAuthorization` method derives the grant subject only
from the authenticated session context and passes that context through the
private adapter to Better Auth's internal verification and approval APIs. It
accepts no target user ID and requires no Administrator role. Setup and CLI
authentication retain their existing Nama Connect contracts. The implementation
continues to
suppress Better Auth logging and telemetry and never logs cookies,
authorization headers, device or user codes, access tokens, refresh tokens,
request bodies, or arbitrary OAuth parameters.

Under ADR-0033's explicit transport exception, the existing acknowledged
local-HTTP policy also applies to session sign-in, device authorization,
token exchange, refresh, and bearer-protected Connect calls. Loopback, private,
link-local, `localhost`/`.localhost`, and `.local` endpoints may use HTTP after
the existing warning and exact endpoint acknowledgement; public names and
addresses require HTTPS. This is a deliberate deviation from Better Auth's
production HTTPS guidance, not a claim that HTTP provides transport secrecy.

A reviewed Better Auth/Drizzle migration deterministically seeds one code-owned
first-party Apple OAuth client. It is a native public client with
`token_endpoint_auth_method: none`, no client secret, and only the device-code
and refresh-token grants. Better Auth's cached-trusted-client facility prevents
CRUD changes to it. Dynamic client registration, authorization-code and
client-credentials grants, and OIDC identity scopes remain disabled.

The client requests one resource equal to the exact canonical Nama API
endpoint and the scopes `nama:library`, `nama:playback`, `nama:user-state`, and
`offline_access`. It does not request `openid`, profile claims, or an ID token.
The resource binds the JWT audience; it does not turn the transport endpoint
into deployment identity.

Better Auth's pinned-version defaults own device-code storage, collision
handling, polling, access- and refresh-token persistence, rotation, expiry,
revocation, and cleanup. The target adds no Nama-specific HMAC domains,
encrypted credential-delivery envelope, operation replay record, custom
device-authorization capacity, or cleanup scheduler. Access JWTs retain Better
Auth's one-hour default and refresh tokens retain its 30-day default.

## Target CLI device authorization

The Apple public client requests an OAuth device authorization directly from
Better Auth and presents the returned user code with instructions for the
already authenticated CLI user to run
`nama auth approve-device <user-code>` against the same endpoint. It polls
Better Auth's OAuth token endpoint with the device-code grant no faster than
the returned interval. Approval yields an audience-bound JWT access token for
that session principal and, because `offline_access` was granted, a rotating
refresh token.

The CLI sends the user code through the generated
`AuthService.ApproveDeviceAuthorization` method using its existing signed
session bearer from the selected profile or `NAMA_TOKEN`. The handler binds the
grant to that exact principal and invokes Better Auth's internal `deviceVerify`
then `deviceApprove` APIs with the same session context. It accepts no target
user ID and does not require the Administrator role, ask for the password
again, mint a second session, call Better Auth over loopback HTTP, manipulate
Better Auth persistence, or reproduce its approval policy. Invoking the command
with the displayed code is the explicit approval action. Invalid, expired,
already-processed, session-mismatched, and unauthenticated results map to stable
safe Connect failures.

Approval is for the current authenticated principal and grants no Administrator
authority. Milestone 4 still delivers only the existing single Administrator
account; non-Administrator account creation remains deferred, but a later
non-Administrator session can use the same RPC and CLI command unchanged. Issue
#167 separately owns browser sign-in and explicit device confirmation as an
optional web-app surface over the same role-neutral internal application
service. The issue #145 flow remains complete without a browser.

## Target protected-resource authorization

Connect remains the protected resource API. Its default-deny method inventory
locally verifies every OAuth access JWT's signature through the Better Auth
JWKS, issuer, exact audience, expiry, fixed client ID, and required scope:

| Scope | Authorized method group |
| --- | --- |
| `nama:library` | `LibraryService.*` |
| `nama:playback` | `PlaybackService.*` |
| `nama:user-state` | `UserStateService.*` |

Every authenticated session may call current-principal consumer methods.
Administrator sessions additionally authorize management methods. OAuth access
tokens never authorize setup, session authentication, health, provider
management, synchronization, grant management, or plugin methods. A malformed,
expired, wrong-issuer,
wrong-audience, wrong-client, or insufficient-scope token fails before handler
validation without revealing protected field details.

Locally verified JWTs are self-contained and cannot be revoked server-side.
Revoking refresh authority therefore stops renewal while an already-issued JWT
remains valid for at most its one-hour expiry. Better Auth's device grant does
not create an OAuth consent row, so consent deletion cannot revoke a lost
installation's offline grant. The one intentional application-owned gap is a
narrow Administrator CLI operation that revokes every Better Auth refresh-token
family for the fixed Apple client. It does not identify, list, or revoke
individual installations.

## Target Apple OAuth token ownership

One universal Apple app installation owns one active endpoint-bound OAuth token
bundle, shared by every window. The last verified endpoint without credentials
remains in `UserDefaults`. A versioned Keychain record contains the exact
canonical Nama endpoint, refresh token, and current access-token material,
uses `kSecAttrAccessibleWhenUnlockedThisDeviceOnly`, and is excluded from
iCloud Keychain synchronization. Authorization state is restored entirely from
that record and is never assembled from unrelated defaults.

Endpoint replacement verifies and authorizes the candidate without attaching
the active token, commits the candidate's complete Keychain bundle, and only
then deletes the previous bundle. Cancellation or failure before that commit
preserves the active authorization. An unknown or damaged record, definitive
refresh failure, or expired refresh authority fails closed into visible device
authorization; ordinary offline and transient failures preserve the stored
grant. Multiple saved endpoint grants remain deferred.

## Correlation, safety, and verification

[ADR-0026](../adr/0026-standard-google-rpc-error-details.md) governs Connect application failure details, and [ADR-0027](../adr/0027-logical-operation-idempotency.md) keeps server-owned request correlation separate from logical-operation identity. The outer Node dispatch assigns server-owned `nama-request-id` to every delegated Connect response before decoding. Application-generated failures carry the same value in `google.rpc.RequestInfo`; malformed Connect input may fail before the application pipeline, so the response header is the correlation fallback. Terminal RPC logs contain only the request ID, method, Connect code, and duration. Better Auth HTTP endpoints retain their standard protocol errors but share the same credential and body redaction rules.

Focused server and CLI coverage, disposable PostgreSQL, generated clients, compiled-command smoke tests, and package-entrypoint process coverage verify the implemented setup creation and restart repair, sign-in/current-user/sign-out, CLI setup recovery and credential replacement, forced session-deletion failure, rate limits, cancellation, correlation, public-error and log redaction, readiness, and fatal ambiguity handling. Issue #145 additionally requires executable authorization-server discovery, generated Connect CLI approval over the private Better Auth adapter, device-code exchange, JWT enforcement, refresh rotation, broad client-grant revocation, and Apple Keychain flows before the OAuth target may be called implemented.

## Unfinished work

Better Auth OAuth Provider, public authorization-server routes, CLI device approval, JWT-protected consumer access, broad Apple-client grant revocation, and Apple Keychain token ownership are not implemented. Browser sign-in and device confirmation remain the separate issue #167 web-app target. The current `DeviceService` Protobuf contract is obsolete target material and remains only until the implementation cutover removes it and regenerates every consumer. CLI sign-out remains unfinished. Public signup, invitations, password recovery, dynamic client registration, authorization-code and client-credentials grants, OIDC identity scopes, multiple roles, multiple saved endpoint grants, and a general web administration UI beyond issue #167 remain outside the target runtime.
