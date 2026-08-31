import { createHash } from "node:crypto";

import { Clock, Effect } from "effect";
import { Pool } from "pg";

const SINGLE_CONNECTION = 1;
const DATABASE_SCOPE_HASH_LENGTH = 20;
const DATABASE_SCOPE_INCREMENT = 1;
const FIRST_DATABASE_SCOPE = 1;
const FIRST_ROW_INDEX = 0;
const ACTIVITY_WAIT_MILLISECONDS = 5000;
const ACTIVITY_POLL_MILLISECONDS = 20;
const NO_ACTIVITY_COUNT = 0;
const ALL_NAMA_SERVER_ACTIVITY = false;
const MIGRATION_LOCK_ACTIVITY = true;

let nextDatabaseScope = FIRST_DATABASE_SCOPE;

const databaseScopePrefix = createHash("sha256")
  .update(
    [
      process.env["NAMA_TEST_RUN_ID"] ?? `local-${process.ppid}`,
      process.env["VITEST_POOL_ID"] ?? "pool-unknown",
      process.env["VITEST_WORKER_ID"] ?? "worker-unknown",
      process.pid.toString(),
    ].join(":"),
  )
  .digest("hex")
  .slice(FIRST_ROW_INDEX, DATABASE_SCOPE_HASH_LENGTH);

const claimDatabaseName = () => {
  const databaseName = `nama_test_${databaseScopePrefix}_${nextDatabaseScope}`;
  nextDatabaseScope += DATABASE_SCOPE_INCREMENT;
  return databaseName;
};

const integrationUrl = (() => {
  const value = process.env["NAMA_TEST_DATABASE_URL"];
  if (value === undefined) {
    throw new Error("NAMA_TEST_DATABASE_URL is required for server integration tests");
  }
  return value;
})();
const namaServerActivityCount = (observer: Pool, migrationLockOnly: boolean) =>
  Effect.map(
    Effect.promise(() =>
      observer.query<{ readonly activity_count: string }>(
        "SELECT count(*) AS activity_count FROM pg_stat_activity WHERE datname = current_database() AND application_name = 'nama-server' AND ($1::boolean = FALSE OR (wait_event_type = 'Lock' AND query ILIKE '%__drizzle_migrations%'))",
        [migrationLockOnly],
      ),
    ),
    (result) => Number(result.rows[FIRST_ROW_INDEX]?.activity_count ?? NO_ACTIVITY_COUNT),
  );

const namaServerConnectionCount = (observer: Pool) =>
  namaServerActivityCount(observer, ALL_NAMA_SERVER_ACTIVITY);

const pollActivity = (
  condition: Effect.Effect<boolean>,
  description: string,
  deadline: number,
): Effect.Effect<void> =>
  Effect.gen(function* activityPoll() {
    const now = yield* Clock.currentTimeMillis;
    if (now >= deadline) {
      yield* Effect.die(new Error(`timed out waiting for ${description}`));
    }
    if (!(yield* condition)) {
      yield* Effect.sleep(ACTIVITY_POLL_MILLISECONDS);
      yield* pollActivity(condition, description, deadline);
    }
  });

const waitForActivity = (condition: Effect.Effect<boolean>, description: string) =>
  Clock.currentTimeMillis.pipe(
    Effect.flatMap((now) => pollActivity(condition, description, now + ACTIVITY_WAIT_MILLISECONDS)),
  );

const waitForNamaServerMigrationLock = (observer: Pool) =>
  waitForActivity(
    Effect.map(
      namaServerActivityCount(observer, MIGRATION_LOCK_ACTIVITY),
      (count) => count > NO_ACTIVITY_COUNT,
    ),
    "nama-server to wait on the migration table lock",
  );

const waitForNamaServerConnectionCount = (observer: Pool, expected: number) =>
  waitForActivity(
    Effect.map(namaServerConnectionCount(observer), (count) => count === expected),
    `nama-server connection count ${expected}`,
  );

const withAdminPool = <Result, Error, Requirements>(
  use: (pool: Pool) => Effect.Effect<Result, Error, Requirements>,
) =>
  Effect.acquireUseRelease(
    Effect.sync(() => new Pool({ connectionString: integrationUrl, max: SINGLE_CONNECTION })),
    use,
    (pool) => Effect.promise(() => pool.end()),
  );

const withIsolatedDatabase = <Result, Error, Requirements>(
  use: (databaseUrl: string) => Effect.Effect<Result, Error, Requirements>,
) => {
  const databaseName = claimDatabaseName();
  const databaseUrl = new URL(integrationUrl);
  databaseUrl.pathname = `/${databaseName}`;

  return withAdminPool((admin) =>
    Effect.acquireUseRelease(
      Effect.promise(async () => {
        await admin.query(`CREATE DATABASE "${databaseName}"`);
        return databaseUrl.toString();
      }),
      (url) => Effect.scoped(use(url)),
      () =>
        Effect.promise(async () => {
          await admin.query(
            "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
            [databaseName],
          );
          await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
        }),
    ),
  );
};

export {
  SINGLE_CONNECTION,
  integrationUrl,
  namaServerConnectionCount,
  waitForNamaServerConnectionCount,
  waitForNamaServerMigrationLock,
  withAdminPool,
  withIsolatedDatabase,
};
