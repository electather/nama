import { Effect } from "effect";
import { Pool } from "pg";

const SINGLE_CONNECTION = 1;
const ISOLATED_DATABASE_NAME = "nama_test_isolated";

const integrationUrl = (() => {
  const value = process.env["NAMA_TEST_DATABASE_URL"];
  if (value === undefined) {
    throw new Error("NAMA_TEST_DATABASE_URL is required for server integration tests");
  }
  return value;
})();

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
  const databaseUrl = new URL(integrationUrl);
  databaseUrl.pathname = `/${ISOLATED_DATABASE_NAME}`;

  return withAdminPool((admin) =>
    Effect.acquireUseRelease(
      Effect.promise(async () => {
        await admin.query('CREATE DATABASE "nama_test_isolated"');
        return databaseUrl.toString();
      }),
      (url) => Effect.scoped(use(url)),
      () =>
        Effect.promise(async () => {
          await admin.query(
            "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
            [ISOLATED_DATABASE_NAME],
          );
          await admin.query('DROP DATABASE IF EXISTS "nama_test_isolated"');
        }),
    ),
  );
};

export { SINGLE_CONNECTION, integrationUrl, withIsolatedDatabase };
