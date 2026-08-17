# Use one PostgreSQL and Drizzle persistence boundary

Nama and its private authentication adapter share one PostgreSQL pool and schema-aware Drizzle boundary, with reviewed migrations as the sole runtime migration owner. This keeps setup repair, authentication, and later domain writes in one transactional truth at the cost of rejecting a separate authentication store, `@effect/sql-pg`, and a second pool.
