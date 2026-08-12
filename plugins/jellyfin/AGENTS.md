# Jellyfin plugin guidance

Read [plugin system](../../docs/architecture/plugin-system.md) and [playback](../../docs/architecture/playback.md) before changing this subtree.

- Keep the plugin a stateless `nama.plugin.v1` adapter with no database or durable state.
- The core owns configuration, credentials, schedules, cursors, retries, and reconciliation.
