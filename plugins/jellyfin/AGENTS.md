# Jellyfin plugin guidance

Read [system architecture](../../docs/architecture.md), [plugin system](../../docs/architecture/plugin-system.md), [playback](../../docs/architecture/playback.md), and [API contracts](../../docs/architecture/api-contracts.md) before changing this subtree.

- Keep the plugin a stateless `nama.plugin.v1` adapter with no database or durable state.
- The core owns configuration, credentials, schedules, cursors, retries, and reconciliation.
- Keep Jellyfin IDs, errors, SDK types, and reusable credentials out of public contracts and logs.
