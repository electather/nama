# Authentication, setup, and pairing

Status: production persistence, fail-closed initialization reconciliation, and bootstrap-token generation/state are implemented. Better Auth runtime integration, setup and authentication handlers, administrator creation, and device pairing remain unfinished.

The target boundary keeps Better Auth as a server-side implementation detail called only inside Nama's `SetupService`, `AuthService`, and `DeviceService`. On each setup-eligible process start, the implemented core emits one high-entropy administrator bootstrap token after listener bind, retains only its digest, and closes it in memory after success or possible commit. Issue #23 will consume that capability to create and durably mark the administrator; no setup or authentication RPC exists today. The Go CLI will later exchange that token to create and sign in the administrator; the universal Apple app will discover or accept a server URL, display a short-lived code, and wait for CLI approval before storing its bearer credential in Keychain. Public signup, roles, invites, password recovery, OAuth/OIDC, email delivery, and a browser login flow are deferred. Clients allow plain HTTP only for loopback, private/link-local addresses, or `.local` discovery.

## Implemented durable boundary

The [core server](core-server.md#durable-persistence-and-initialization) owns the implemented generated auth persistence and permanent initialization marker. That boundary supplies the future private authentication adapter's database contract and guarantees that setup eligibility cannot reopen after initialization; this note owns the authentication consequences and remaining gates.

Generated persistence does not include a Better Auth runtime import or adapter, mounted Better Auth routes, Nama setup or authentication handlers, or proof of public authentication behavior.

Issue #23 must use the Better Auth release pinned alongside the generated schema or regenerate the schema and reopen migration review before changing that release.

## Implemented bootstrap boundary

Database reconciliation alone classifies startup as `configured` or `setup-eligible`. The setup service is process-local and depends only on that immutable classification. It is inert before bind. Eligible activation obtains 32 random bytes, prints exactly `NAMA_BOOTSTRAP_TOKEN=<token>\n` directly to stdout, retains only the SHA-256 digest, and releases transient token material. Configured starts generate and print nothing.

Candidate validation hashes every string and constant-time compares fixed 32-byte digests. A valid claim yields one scoped opaque attempt. Pre-creation scope exit restores availability; success, commit-capable work that exits unresolved, and ambiguous outcomes disable setup and destroy the digest. Random generation or raw-write failure uses only `BootstrapTokenInitializationError`, does not retry output, and prevents readiness. This boundary has no Better Auth import, database mutation, public route, Connect mapping, or CLI behavior.

## Prior Milestone 1 Better Auth Connect spike

The earlier disposable spike used Better Auth's official stateful memory adapter. It demonstrated the intended administrator lifecycle through generated Nama `SetupService` and `AuthService` clients without mounting a Better Auth HTTP route: administrator creation was single-flight with automatic sign-in disabled, and sign-in exposed only the bearer plugin's signed token through Nama's `BearerCredential`. That evidence established RPC translation and failure semantics, not the current production runtime.

The spike also showed that Better Auth could report successful sign-out after session deletion failed. Nama must therefore continue to treat that result as non-authoritative: sign-out succeeds only after the presented bearer no longer resolves in the durable session store. A still-valid bearer or failed confirmation returns `UNAVAILABLE` with reason `SESSION_REVOCATION_UNCONFIRMED`; the client retains the bearer and resolves ambiguity through `GetCurrentUser`. Public errors and logs never expose issued secrets or private Better Auth failures.

## Issue #23 runtime integration gates

Only the private authentication adapter may import Better Auth. Better Auth routes, cookies, request and response models, errors, and secrets must not cross that boundary or be mounted directly.

The pinned Better Auth runtime and its transitive fetch declarations exposed strict-TypeScript incompatibilities during the spike through optional runtime types and incompatible optional properties. Issue #23 must resolve that runtime and declaration compatibility risk before adopting a normal static import. It must not weaken strict TypeScript, enable `skipLibCheck`, or add unused runtime packages to hide upstream type failures.
