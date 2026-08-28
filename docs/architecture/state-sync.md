# Watch-state synchronization

Nama's target synchronization architecture makes it the canonical authority for
Watch state while plugins expose provider-observation and mutation operations
([ADR-0023](../adr/0023-canonical-watch-state-reconciliation.md)). The core
polls configured provider instances, stores each exact provider item mapping's
last normalized Provider replica and a core-owned checkpoint, reconciles
progress and watched status, and exports changes without treating its own
writes as new activity. A Nama-originated action always wins and fans out;
otherwise the most recent reliable activity wins even when it is a regression
or rewatch, with provider-instance synchronization priority breaking ties or
replacing missing timestamps.

[ADR-0034](../adr/0034-versioned-watch-state-snapshots.md) keeps sparse
canonical state separate from per-mapping Provider replicas. Canonical and
replica rows use independent core-owned monotonic versions, and narrow
compare-and-commit commands atomically replace evidence and an optional fully
resolved canonical target. Exact canonical equality is a no-op; stale versions
return current snapshots so reconciliation policy can recompute.

The core uses repeated best-effort full scans with opaque continuations and
durable core-owned checkpoints
([ADR-0024](../adr/0024-best-effort-provider-scans.md)). It deduplicates
observations, retries only according to durable logical-operation semantics
([ADR-0027](../adr/0027-logical-operation-idempotency.md)), and permits only
one non-overlapping run per provider instance. Provider events remain future
invalidation hints; the unary MVP does not subscribe to them or treat them as
current truth.

Sparse canonical Watch state persistence is implemented for one authenticated
principal and one playable canonical item, including versioned compare-and-
commit, durable selected activity evidence, same-item last-Source validation,
and caller-resolved last-Source identity. Retained provider-source mappings keep
that identity available through temporary catalog projection removal.
Production core synchronization remains unimplemented: scheduling, Provider
replica and checkpoint persistence, reconciliation, bounded fingerprint
retention, and retry execution remain target work.
The Jellyfin adapter implements resumable best-effort full movie and episode scans, bounded targeted
reads for repair and confirmation, and explicit watched/unwatched writes with
bounded ambiguity readback. It advertises `WATCH_STATE_READ` and
`WATCHED_WRITE`. The contract supports one or more configured Jellyfin
instances without adding a queue or provider-owned durable state; later
provider types reuse that contract.
