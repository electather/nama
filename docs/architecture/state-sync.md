# Watch-state synchronization

Nama's target synchronization architecture makes it the canonical watch-state
ledger while plugins expose source and sink operations
([ADR-0023](../adr/0023-canonical-watch-state-reconciliation.md)). The core
polls configured sources, stores each source's last normalized replica and
core-owned checkpoint, reconciles progress and watched status, and exports
changes without treating its own writes as new activity. A Nama-originated
action always wins and fans out; otherwise the most recent reliable activity
wins even when it is a regression or rewatch, with administrator-configured
source priority breaking ties or replacing missing timestamps.

The core uses repeated best-effort full scans with opaque continuations and
durable core-owned checkpoints
([ADR-0024](../adr/0024-best-effort-provider-scans.md)). It deduplicates
observations, retries only according to durable logical-operation semantics
([ADR-0027](../adr/0027-logical-operation-idempotency.md)), and permits only
one non-overlapping run per provider instance. Provider events remain future
invalidation hints; the unary MVP does not subscribe to them or treat them as
current truth.

Production synchronization is unimplemented: scheduling, persistence, provider
adapters, bounded fingerprint retention, and retry execution remain target
work. The contract supports one or more configured Jellyfin instances without
adding a queue or provider-owned durable state; later provider types reuse that
contract.
