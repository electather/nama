# Authentication, setup, and pairing

Better Auth manages the one MVP administrator's credentials and sessions but is only called inside Nama's `SetupService`, `AuthService`, and `DeviceService`: on an unconfigured start the server prints a high-entropy bootstrap token valid for one successful admin creation or until restart, replaces it on each unconfigured restart, and disables setup permanently after the admin exists. The Go CLI exchanges that token to create and sign in the administrator; the universal Apple app discovers or accepts a server URL, displays a short-lived code, and waits for `nama devices approve CODE`, after which its bearer credential is stored in Keychain. Public signup, roles, invites, password recovery, OAuth/OIDC, email delivery, and a browser login flow are deferred; clients allow plain HTTP only for loopback, private/link-local addresses, or `.local` discovery names with an explicit warning, and require HTTPS for public names and addresses.

## Milestone 1 Better Auth Connect spike

GitHub issue #18 exercised Better Auth `1.6.26` only through generated Nama `SetupService` and `AuthService` clients. The loopback spike mounted no Better Auth HTTP route. Administrator creation kept automatic sign-in disabled; `AuthService.SignIn` extracted the bearer plugin's signed `set-auth-token` header and returned it only as `BearerCredential.token`.

Source review and the forced-failure flow confirmed that Better Auth `1.6.26` catches a failed `deleteSession()` call, clears client cookie state, and still returns `{ success: true }`. Nama must therefore treat that result as non-authoritative. `AuthService.SignOut` re-resolves the presented bearer against the session store and succeeds only when no session remains. A still-valid bearer or a failed confirmation returns `UNAVAILABLE` with reason `SESSION_REVOCATION_UNCONFIRMED`; the client retains the bearer and resolves the ambiguity through `GetCurrentUser`.

The focused proof is:

```bash
pnpm --filter @nama/server exec node --test src/auth-spike.test.ts
```

It creates the administrator, signs in, authenticates `GetCurrentUser`, forces session deletion to fail, observes failed sign-out while the same bearer remains valid, removes the fault, signs out, and observes that the bearer is then rejected. A concurrent setup case also proves that one bootstrap token creates exactly one administrator. The tests confirm that Better Auth's sign-in endpoint is not mounted and that public revocation errors contain none of the issued secrets.

The spike uses Better Auth's official stateful memory adapter. It proves RPC translation and failure semantics only; it does not prove PostgreSQL migrations, durable initialization, restart repair, production logging, or server lifecycle. Those remain Milestone 2 work.

Better Auth `1.6.26` and its transitive `@better-fetch/fetch` declarations do not compile under this repository's TypeScript `7.0.2`, `exactOptionalPropertyTypes: true`, and `skipLibCheck: false` settings: they reference optional Bun and Cloudflare types and contain incompatible optional-property declarations. The disposable spike loads the pinned runtime behind a private, structurally typed boundary instead of weakening repository type checks. Milestone 2 must resolve this upstream compatibility risk before adopting a normal static Better Auth import; it must not enable `skipLibCheck` or add unused runtime packages to hide it.
