# tvOS guidance

Read [tvOS application](../../docs/architecture/tvos-app.md) and [playback](../../docs/architecture/playback.md) before changing this subtree.

- Use generated public clients behind app-owned models; do not import provider-private types.
- Keep AetherEngine behind the single Nama-owned player adapter.
- Media flows directly from the provider through safe contract locators; credentials stay in Keychain and out of logs.
