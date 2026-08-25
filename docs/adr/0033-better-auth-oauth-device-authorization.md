---
status: accepted
---

# Use Better Auth OAuth device authorization

Nama uses Better Auth's JWT, OAuth Provider, and OAuth Device Authorization plugins as the public authorization server for one fixed first-party Apple native public client; Better Auth owns the standard OAuth metadata, JWKS, device-code, token, refresh, and revocation endpoints plus schema, device-code state, token lifecycle, and cleanup. An already authenticated Go CLI sends the Apple app's displayed user code through `AuthService.ApproveDeviceAuthorization`; the Connect handler binds the grant to that session principal and invokes Better Auth's internal verification and approval APIs without a target user ID or Administrator-role check, while Connect remains the scoped protected resource and management API. This replaces Nama's bespoke Pairing and Device credential model because accepting the plugin's maintained behavior is less costly than owning parallel cryptography, persistence, replay, cleanup, and client contracts. It supersedes ADR-0007 only where that decision prohibited the required public OAuth authorization-server routes, and supersedes ADR-0030 and ADR-0031 completely.

## Consequences

The Apple client requests one exact Nama API resource with granular library, playback, and user-state scopes plus `offline_access`, verifies access JWTs locally, and keeps one endpoint-bound token bundle. The CLI-only Connect approval path is role-neutral and requires no browser or repeated password entry. Milestone 4 still delivers only the existing single Administrator account, but a later non-Administrator session works without a wire or CLI change. Issue #167 may add browser sign-in and confirmation as a separate web-app alternative over the same internal approval service without becoming a prerequisite for Apple authorization. Nama no longer identifies, lists, or revokes individual installations; the one deliberate plugin gap is an Administrator operation that revokes every refresh-token family for the fixed client, while issued JWTs remain valid until Better Auth's default one-hour expiry.

Nama deliberately retains its existing transport exception: after explicit endpoint acknowledgement, loopback, private, link-local, `localhost`/`.localhost`, and `.local` Nama endpoints may carry session and OAuth credentials over HTTP, while public names and addresses require HTTPS. This accepts the local-network interception risk and deviates from Better Auth's RFC 8628 production HTTPS guidance to preserve certificate-free private-LAN deployment.
