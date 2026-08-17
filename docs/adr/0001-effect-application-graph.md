# Use one Effect application graph for the core

Nama needs one owner for composition, scopes, interruption, expected failures, logging, and shutdown across its runtime. The core uses one Effect application graph, keeps Node HTTP, PostgreSQL, Drizzle, Connect, and Better Auth as narrow adapters, and does not add a second dependency-injection system. This centralizes lifecycle and typed-failure semantics rather than dividing ownership between framework middleware and a separate DI container.
