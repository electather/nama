# Authentication, setup, and pairing

Status: production persistence and fail-closed initialization reconciliation are implemented. Better Auth runtime integration, setup and authentication handlers, bootstrap-token behavior, and device pairing remain unfinished.

The target boundary keeps Better Auth as a server-side implementation detail called only inside Nama's `SetupService`, `AuthService`, and `DeviceService`. The planned one-administrator flow uses a high-entropy bootstrap token for one successful administrator creation or until restart, then disables setup permanently. The Go CLI will exchange that token to create and sign in the administrator; the universal Apple app will discover or accept a server URL, display a short-lived code, and wait for CLI approval before storing its bearer credential in Keychain. Public signup, roles, invites, password recovery, OAuth/OIDC, email delivery, and a browser login flow are deferred. Clients allow plain HTTP only for loopback, private/link-local addresses, or `.local` discovery names with an explicit warning, and require HTTPS for public names and addresses.

## Implemented durable boundary

The [core server](core-server.md#durable-persistence-and-initialization) owns the implemented generated auth persistence and permanent initialization marker. That boundary supplies the future private authentication adapter's database contract and guarantees that setup eligibility cannot reopen after initialization; this note owns the authentication consequences and remaining gates.

Generated persistence does not include a Better Auth runtime import or adapter, mounted Better Auth routes, Nama setup or authentication handlers, or proof of public authentication behavior.

Issue #23 must use the Better Auth release pinned alongside the generated schema or regenerate the schema and reopen migration review before changing that release.

## Prior Milestone 1 Better Auth Connect spike

The earlier disposable spike used Better Auth's official stateful memory adapter. It demonstrated the intended administrator lifecycle through generated Nama `SetupService` and `AuthService` clients without mounting a Better Auth HTTP route: administrator creation was single-flight with automatic sign-in disabled, and sign-in exposed only the bearer plugin's signed token through Nama's `BearerCredential`. That evidence established RPC translation and failure semantics, not the current production runtime.

The spike also showed that Better Auth could report successful sign-out after session deletion failed. Nama must therefore continue to treat that result as non-authoritative: sign-out succeeds only after the presented bearer no longer resolves in the durable session store. A still-valid bearer or failed confirmation returns `UNAVAILABLE` with reason `SESSION_REVOCATION_UNCONFIRMED`; the client retains the bearer and resolves ambiguity through `GetCurrentUser`. Public errors and logs never expose issued secrets or private Better Auth failures.

## Issue #23 runtime integration gates

Only the private authentication adapter may import Better Auth. Better Auth routes, cookies, request and response models, errors, and secrets must not cross that boundary or be mounted directly.

The pinned Better Auth runtime and its transitive fetch declarations exposed strict-TypeScript incompatibilities during the spike through optional runtime types and incompatible optional properties. Issue #23 must resolve that runtime and declaration compatibility risk before adopting a normal static import. It must not weaken strict TypeScript, enable `skipLibCheck`, or add unused runtime packages to hide upstream type failures.
