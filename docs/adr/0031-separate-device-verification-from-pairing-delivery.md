---
status: superseded by ADR-0033
---

# Separate Device credential verification from pairing delivery

Nama verifies an active Device credential through a versioned, domain-separated HMAC digest and retains a separately encrypted AES-256-GCM copy only on its approved Pairing until that Pairing expires. This temporary recoverability lets repeated matching polls return the same credential after a lost response without making Device bearers generally recoverable; Device credentials have no scheduled MVP expiry, revocation removes both verification and undelivered recovery material, and missing keys or damaged records fail closed.

Superseded by [ADR-0033](0033-better-auth-oauth-device-authorization.md).
