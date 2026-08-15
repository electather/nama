# PostgreSQL Auth Migrations Design

Status: approved in chat; pending written review.
Issue: #21.

## Outcome

Add the reviewed Better Auth PostgreSQL tables and Nama's permanent server-initialization marker. Apply the generated migration before the listener binds. Reconcile initialization fail-closed on every start.

## Scope

Included:

- Better Auth `1.6.26` core persistence for email/password users and durable sessions.
- One Nama-owned singleton initialization row.
- Drizzle schema definitions and committed migration artifacts.
- Package-local, exact-pinned Drizzle Kit generation tooling.
- Startup integrity inspection and single-user marker repair.
- Real PostgreSQL and process-level verification.

Excluded:

- Better Auth runtime integration or imports.
- Setup tokens or administrator creation.
- Connect handlers or public API changes.
- Public signup, invitations, password reset, OAuth/OIDC, or additional roles.
- Better Auth database rate limiting or optional-plugin tables.
- Bootstrap-token persistence.
- Multi-process migration coordination, advisory locks, or retries.
- Provider, pairing, media, playback, or synchronization tables.

## Decisions

1. Keep persistence, migrations, and startup reconciliation inside the existing database owner.
2. Keep Better Auth's default singular table names: `user`, `session`, `account`, and `verification`.
3. Match the pinned Better Auth `1.6.26` core generator output. Preserve its default field names, nullability, defaults, indexes, unique constraints, and foreign-key actions.
4. Do not add constraints unsupported by the pinned Better Auth schema. In particular, do not add a composite account provider/account unique constraint.
5. Use `nama_server_state` for Nama-owned initialization state.
6. Generate SQL with package-local Drizzle Kit. Commit and review the SQL, journal, and metadata snapshot.
7. Add no root Mise task and no production Better Auth dependency in issue 21.
8. Preserve the existing application dependency graph and readiness-only `Database` service surface.

Issue 23 must use Better Auth `1.6.26` against this schema or reopen schema and migration review before changing the version.

## Components

| Path | Responsibility |
| --- | --- |
| `apps/server/src/database/schema.ts` | Authoritative Drizzle definitions for the four Better Auth tables and `nama_server_state`. |
| `apps/server/src/database/initialization.ts` | Private startup transaction, state classification, repair, and integrity error. |
| `apps/server/src/database/database.ts` | Pool ownership, schema-aware Drizzle construction, migration ordering, reconciliation call, probes, and finalization. |
| `apps/server/drizzle.config.ts` | Package-local Drizzle generation input. |
| `apps/server/drizzle/` | Reviewed SQL migration, journal entry, and Drizzle metadata. |
| `apps/server/package.json` | Exact-pinned Drizzle Kit dev dependency and package-local generation command. |
| `apps/server/integration/tests/database.integration.test.ts` | Production migration, upgrade, constraint, and failure coverage. |
| `apps/server/integration/tests/initialization.integration.test.ts` | Startup state matrix and repair coverage. |
| `apps/server/integration/tests/process.integration.test.ts` | Real-process pre-bind failure, redaction, exit, and readiness coverage. |

The database directory remains one owner. `initialization.ts` is a focused internal unit, not a new service or dependency-injection boundary.

## Persistence invariants

### Better Auth tables

- `user` owns administrator identity.
- User email is unique.
- `session` tokens are unique.
- Session and account user references are indexed.
- Verification identifiers are indexed.
- Session and account rows reference `user` with cascade deletion.
- Better Auth owns writes to its update timestamps. No database update trigger is added.
- Credential-bearing account and session values remain secrets.
- Nama code in issue 21 does not read credential-bearing values.

### Initialization marker

- `nama_server_state` admits only the fixed primary-key value `server`.
- The migration inserts that row in the uninitialized state.
- `initialized_at` and `administrator_user_id` are either both null or both set.
- `initialized_at` is a PostgreSQL timestamp with time zone set from database transaction time.
- `administrator_user_id` uses the same text identity type as `user.id`.
- The administrator reference restricts deletion.
- No database service operation deletes the singleton, clears initialization, or resets setup eligibility.
- A missing singleton is corruption, never a fresh deployment.

The database administrator remains outside the application security boundary and can corrupt any application schema. Nama must repair or reject states it encounters; it does not attempt to defend against a PostgreSQL superuser.

## Migration workflow

1. Define the reviewed persistence shape in `schema.ts`.
2. Compare the Better Auth-owned definitions with the pinned `1.6.26` core schema and Drizzle generator output.
3. Run the package-local Drizzle Kit generation command.
4. Review the generated SQL directly.
5. Commit the SQL, journal entry, and metadata snapshot with the schema change.
6. Let the existing runtime migrator apply committed migrations before reconciliation and bind.

The first production migration upgrades the existing zero-entry journal and initializes a fresh database identically. Runtime code never invokes Drizzle Kit. Existing unmanaged tables are neither adopted nor overwritten; a conflict fails migration and startup.

## Startup data flow

Startup order is fixed:

1. Read and decode configuration.
2. Install configured logging.
3. Acquire and verify the shared PostgreSQL pool.
4. Construct one schema-aware Drizzle instance.
5. Apply committed migrations.
6. Reconcile initialization in one transaction.
7. Run the existing initial `SELECT 1` probe.
8. Construct the shared request runtime.
9. Bind the native HTTP listener.
10. Emit `server.ready`.

The reconciliation transaction locks the singleton row, then reads at most two user IDs. It never performs an unbounded user read or selects unused columns.

## Initialization state machine

| Marker | Better Auth users | Result |
| --- | ---: | --- |
| Initialized | Exactly one | Continue configured. |
| Initialized | Zero | Fail with `DatabaseIntegrityError`. |
| Initialized | More than one | Fail with `DatabaseIntegrityError`. |
| Uninitialized | Zero | Continue setup-eligible. |
| Uninitialized | Exactly one | Repair the marker to that user, then continue configured. |
| Uninitialized | More than one | Fail with `DatabaseIntegrityError`. |
| Missing | Any count | Fail with `DatabaseIntegrityError`. |

Single-user repair sets `initialized_at` from database transaction time and `administrator_user_id` in one conditional update. The update matches only the fixed `server` singleton while both initialization fields remain null. Exactly one row must change. Any other row count is fatal.

The transaction classifies its result as setup-eligible or configured. Issue 21 does not expose setup behavior or widen the public `Database` service. Issue 22 may extend the database owner to consume this result without exposing raw Drizzle or `pg.Pool` access.

No startup write is retried. A failed or ambiguous repair never falls back to setup eligibility.

## Failure contract

Add a database-owned `DatabaseIntegrityError` for semantic persistence corruption or a conditional repair invariant violation.

Keep existing classifications:

- connection or query execution failure: `DatabaseConnectionError`;
- migration application failure: `MigrationError`;
- invalid marker/user state: `DatabaseIntegrityError`.

Raw PostgreSQL, Drizzle, SQL, constraint, table, row, and user details stop at the database boundary. Integrity errors contain no user IDs, email addresses, row counts, database identifiers, or underlying messages.

Any migration, connection, or integrity failure before bind:

- emits exactly one redacted `server.start_failed` record;
- releases every acquired resource, including the pool;
- leaves no listener;
- exits non-zero.

Do not change the stable log field allowlist. Do not log Better Auth table contents or migration SQL.

## Security boundaries

- Better Auth remains an implementation detail behind future Nama RPCs.
- Issue 21 does not mount Better Auth routes or add a Better Auth runtime import.
- The schema contains no bootstrap token.
- The application exposes no reset or administrator-deletion operation.
- Restrictive marker ownership prevents a normal Better Auth user deletion from reopening setup.
- Startup repair handles the crash window where Better Auth committed one administrator before Nama committed its marker.
- Multiple users always fail closed.
- TypeScript strictness is not weakened to accommodate Better Auth declarations.

## Verification

Follow test-driven development. Add the focused PostgreSQL expectation first and confirm it fails against the zero-entry production journal. Add each reconciliation case before its implementation and confirm the intended failure.

### Migration behavior

1. A fresh database contains the four Better Auth tables, `nama_server_state`, and one uninitialized singleton after `Database` acquisition.
2. A database with the prior zero-entry production journal upgrades exactly once.
3. Reacquisition is idempotent and does not alter the initialized marker.
4. Better Auth uniqueness, required values, user references, and delete actions match the pinned schema.
5. Marker constraints reject half-initialized state and deletion of the referenced administrator.
6. Migration conflicts remain normalized and close the partially acquired pool.

### Reconciliation behavior

Exercise every state-machine row against isolated PostgreSQL:

- initialized with exactly one user;
- initialized with zero users;
- initialized with multiple users;
- uninitialized with zero users;
- uninitialized with exactly one user;
- uninitialized with multiple users;
- missing singleton.

For single-user repair, verify both marker fields are set to that user and a second startup remains configured. Use a disposable fixture that suppresses the conditional update and verify fatal integrity handling rather than setup fallback.

The initialized-with-zero-users fixture may drop the administrator foreign key only inside its disposable database. The suppressed-update fixture may add a test-only trigger only inside its disposable database. Production migrations remain unchanged.

### Process behavior

1. Start the actual package entrypoint with a blocking migration fixture, verify its port remains unbound while migration is blocked, release the migration, then observe readiness after migration and reconciliation.
2. Start it against corrupt initialization state and verify non-zero exit without a bound listener.
3. Verify exactly one `server.start_failed` record and absence of database details, SQL, user data, and credentials.
4. Verify pool closure after the failed process.

### Commands

- Run focused database, initialization, and process integration tests.
- Run `pnpm --filter @nama/server run check:test`.
- Run `mise run check`.

## Documentation reconciliation after implementation

Update:

- `docs/architecture.md` — production persistence and durable initialization are implemented; setup/auth handlers remain absent.
- `docs/architecture/core-server.md` — issue 21 moves from approved extension to current boundary; issues 22–23 remain unfinished.
- `docs/architecture/authentication-and-setup.md` — record durable schema compatibility and startup repair evidence.

Do not change Protobuf contracts or generated bindings.

## Acceptance mapping

| Issue acceptance | Design proof |
| --- | --- |
| Fresh database migrates before the listener serves. | Existing pre-bind migration order, production migration integration test, and actual-process readiness test. |
| Setup eligibility never reopens after initialization. | Paired marker state, restrictive administrator reference, no reset operation, single-user repair, missing/corrupt-state fatal behavior, and restart coverage. |

## Upstream review anchors

- Better Auth `v1.6.26` core table definition: `packages/core/src/db/get-tables.ts`.
- Better Auth `v1.6.26` Drizzle generator: `packages/cli/src/generators/drizzle.ts`.
- Better Auth `v1.6.26` Drizzle schema snapshots: `packages/cli/test/__snapshots__/`.
