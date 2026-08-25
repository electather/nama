---
status: accepted
---

# Keep Better Auth private behind Nama-owned authentication RPCs

Nama's setup and authentication clients need stable Nama semantics rather than Better Auth's transport and model shapes. Better Auth is loaded only by a private runtime adapter behind Nama-owned authentication RPCs; its routes, cookies, errors, sessions, and models do not become public contracts. This retains replacement freedom instead of mounting Better Auth directly for clients to consume.

[ADR-0033](0033-better-auth-oauth-device-authorization.md) supersedes the prohibition on public Better Auth routes only for the fixed Apple client's standard OAuth authorization-server metadata, JWKS, device-code, token, refresh, and revocation endpoints. Nama setup, session authentication, and role-neutral CLI approval remain behind generated Connect contracts and the private adapter; browser email/password and session routes remain private unless issue #167 implements its separate web approval surface.
