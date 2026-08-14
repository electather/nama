# Watch-state synchronization

Nama is the canonical watch-state ledger while plugins expose source and sink operations: the core polls configured sources, stores each source's last observed replica and cursor, reconciles progress and watched status, and exports changes without feeding its own writes back as new activity. A Nama-originated action always wins and fans out; otherwise the most recent reliable activity wins even when it is a regression or rewatch, with administrator-configured source priority breaking ties or replacing missing timestamps. MVP ships this machinery for one or more configured Jellyfin instances with durable checkpoints, idempotent calls, and a single non-overlapping scheduler; other provider types and provider events reuse the contract later without adding a queue now.

## Milestone 1 reconciliation evidence

The behavioral replay fixtures in `apps/server/src/watch-state-reconciliation.test.ts` preserve the accepted ordering rules:

| Evidence | Proven result |
| --- | --- |
| Reliable activity times | The newest timestamp wins across and within providers. An older later-delivered observation does not regress canonical state and receives the unchanged canonical target as an export. |
| Genuine rewatch | A newer reliable observation may lower progress and clear watched state; neither maximum progress nor watched state is dominant. |
| Missing or heuristic activity time | Configured provider priority replaces time comparison. Lower positive `sync_priority` wins. A later untimestamped observation from the same provider replaces that provider's earlier replica. |
| Exact reliable-time tie | Lower positive `sync_priority` wins deterministically. |
| Duplicate provider observation | Replaying the same normalized observation creates neither another canonical version nor another export. |
| Retry idempotency | Replaying one Nama `operation_id` with the same state preserves one canonical version and one set of provider targets. Replaying a confirmed provider export does not re-arm a consumed echo fingerprint. |
| Provider echo | A confirmed export records an exact normalized fingerprint. The identical next observation is suppressed; a different newer observation is reconciled normally. |
| Canonical ownership | Nama actions commit before export. Provider export confirmations update replicas and echo evidence without replacing canonical state. |

This evidence is a pure reconciliation proof, not a production runtime. Milestone 5 still owns scheduling, persistence, provider adapters, bounded fingerprint retention, and retry execution; the spike adds no public schema or dependency decision.
