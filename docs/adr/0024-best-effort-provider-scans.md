# Use best-effort provider scans and core-owned checkpoints

The core repeatedly consumes best-effort full provider scans with opaque continuations and persists its own scan progress; adapters do not manufacture durable provider cursors or snapshots from mutable activity fields. Provider events are future invalidation hints, not current truth. Nama accepts repeated scans and deduplication because Jellyfin and Plex do not document durable, no-gap current-state cursors, rather than misrepresenting timestamps, offsets, or events as authoritative checkpoints.
