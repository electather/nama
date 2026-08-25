---
status: accepted
---

# Use Better Auth OAuth device authorization

Nama uses Better Auth's JWT, OAuth Provider, and OAuth Device Authorization plugins as the public authorization server for one fixed first-party Apple native public client; Better Auth owns the standard OAuth endpoints, schema, device-code state, token lifecycle, and cleanup. An already authenticated Go CLI claims and approves the Apple app's displayed user code through Better Auth's native device routes using its existing signed Administrator session bearer, while Connect remains the scoped protected resource and CLI management API. This replaces Nama's bespoke Pairing and Device credential model because accepting the plugin's maintained behavior is less costly than owning parallel cryptography, persistence, replay, cleanup, and client contracts. It supersedes ADR-0007 only where that decision prohibited the required public authorization-server and device-approval routes, and supersedes ADR-0030 and ADR-0031 completely.

## Consequences

The Apple client requests one exact Nama API resource with granular library, playback, and user-state scopes plus `offline_access`, verifies access JWTs locally, and keeps one endpoint-bound token bundle. The CLI-only approval path requires no browser or repeated password entry. Issue #167 may add browser sign-in and confirmation as a separate web-app alternative without becoming a prerequisite for Apple authorization. Nama no longer identifies, lists, or revokes individual installations; the one deliberate plugin gap is an Administrator operation that revokes every refresh-token family for the fixed client, while issued JWTs remain valid until Better Auth's default one-hour expiry.

Nama deliberately retains its existing transport exception: after explicit endpoint acknowledgement, loopback, private, link-local, `localhost`/`.localhost`, and `.local` Nama endpoints may carry Administrator and OAuth credentials over HTTP, while public names and addresses require HTTPS. This accepts the local-network interception risk and deviates from Better Auth's RFC 8628 production HTTPS guidance to preserve certificate-free private-LAN deployment.
