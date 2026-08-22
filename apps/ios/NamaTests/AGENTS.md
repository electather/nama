# Application tests

Read the owning source module's `AGENTS.md`. Mirror feature ownership under this
single Swift Testing target.

- Test observable module behavior, not private helpers or generated round trips.
- Use deterministic in-memory adapters, clocks, and identities; never sleep or
  depend on live Nama, Jellyfin, Keychain, or privacy prompts.
- Restore process globals, URL protocol handlers, defaults suites, temporary
  Keychain records, and locale changes in the test that owns them.
