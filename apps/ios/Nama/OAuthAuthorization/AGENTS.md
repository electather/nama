# OAuth Authorization

Read
[`../../../../docs/architecture/authentication-and-setup.md`](../../../../docs/architecture/authentication-and-setup.md)
and
[`../../../../docs/adr/0033-better-auth-oauth-device-authorization.md`](../../../../docs/adr/0033-better-auth-oauth-device-authorization.md).

Use Better Auth's native OAuth Device Authorization and token endpoints rather
than `DeviceService` or a handwritten parallel client. Issue #145 presents the
user code with `nama auth approve-device <user-code>` instructions and must
complete without a browser; issue #167 owns any browser verification
presentation. Keep returned polling time and endpoint-bound token storage
injectable so interval, expiry, refresh, replacement-commit, and
damaged-Keychain tests run without real delays.
