# Make Nama canonical for watch state with explicit reconciliation precedence

Nama-originated watch-state changes commit first and win. Otherwise, the newest reliable provider activity wins—including a legitimate lower-position seek, unwatch, or rewatch—while configured provider priority resolves missing or heuristic activity times and exact reliable-time ties; equality and exact confirmed-export fingerprints prevent echoes. This accepts reconciliation metadata and ordering work instead of maximum-progress, watched-wins, provider-authoritative, or last-delivered-event rules so real regressions are preserved without loops.

A reconciliation proof established that an older later-delivered observation
does not regress canonical state and receives the unchanged canonical target as
an export; a later untimestamped observation replaces that provider's earlier
replica; duplicate normalized observations create neither another canonical
version nor another export; and an export confirmation updates replica and echo
evidence without replacing canonical state. A confirmed export records an exact
normalized fingerprint: the identical next observation is suppressed, while a
different newer observation is reconciled normally. Production scheduling,
persistence, adapters, bounded fingerprint retention, and retry execution
remain unimplemented.
