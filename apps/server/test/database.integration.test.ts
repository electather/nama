import { join } from "node:path";

import { NodeFileSystem } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Clock, Effect, FileSystem, Redacted } from "effect";
import { Pool } from "pg";

import { Config } from "../src/config.ts";
import { Database } from "../src/database.ts";

const integrationUrl = process.env["NAMA_TEST_DATABASE_URL"];
if (integrationUrl === undefined) {
  throw new Error("NAMA_TEST_DATABASE_URL is required for database integration tests");
}

const MASTER_KEY_BYTES = 32;
const FIRST_ROW_INDEX = 0;
const PROBE_BOUND_MILLISECONDS = 3000;
const ENCODED_MASTER_KEY = Buffer.alloc(MASTER_KEY_BYTES).toString("base64");
const MASTER_KEY = `base64:${ENCODED_MASTER_KEY}`;

const migrationPath = (relativePath: string): string => join(import.meta.dirname, relativePath);
const productionMigrations = migrationPath("../drizzle/");
const priorMigrations = migrationPath("fixtures/migrations/upgrade/prior/");
const latestMigrations = migrationPath("fixtures/migrations/upgrade/latest/");
const failingMigrations = migrationPath("fixtures/migrations/failure/");

const configForDatabase = (databaseUrl: string) =>
  Config.of({
    database: Object.freeze({ maxConnections: 3, url: Redacted.make(databaseUrl) }),
    logging: Object.freeze({ level: "info" as const }),
    security: Object.freeze({
      masterKey: Redacted.make(MASTER_KEY),
    }),
    server: Object.freeze({ bind: "127.0.0.1:8080", publicUrl: "http://localhost:8080/" }),
  });

const useDatabase = <Result, Error, Requirements>(
  databaseUrl: string,
  migrationsFolder: string,
  use: (database: Database["Service"]) => Effect.Effect<Result, Error, Requirements>,
) => {
  const config = configForDatabase(databaseUrl);
  const databaseLayer = Database.layer(migrationsFolder);
  const program = Effect.gen(function* useDatabaseProgram() {
    const database = yield* Database;
    return yield* use(database);
  }).pipe(Effect.provide(databaseLayer), Effect.provideService(Config, config));
  return Effect.scoped(program);
};

const databaseFailure = (databaseUrl: string, migrationsFolder: string) => {
  const config = configForDatabase(databaseUrl);
  const databaseLayer = Database.layer(migrationsFolder);
  const program = Database.pipe(
    Effect.provide(databaseLayer),
    Effect.provideService(Config, config),
    Effect.flip,
  );
  return Effect.scoped(program);
};

const withPool = <Result, Error, Requirements>(
  databaseUrl: string,
  use: (pool: Pool) => Effect.Effect<Result, Error, Requirements>,
) =>
  Effect.acquireUseRelease(
    Effect.sync(() => new Pool({ connectionString: databaseUrl, max: 1 })),
    use,
    (pool) => Effect.promise(() => pool.end()),
  );

const withIsolatedDatabase = <Result, Error, Requirements>(
  use: (databaseUrl: string) => Effect.Effect<Result, Error, Requirements>,
) => {
  const databaseName = `nama_test_${crypto.randomUUID().replaceAll("-", "")}`;
  const databaseUrl = new URL(integrationUrl);
  databaseUrl.pathname = `/${databaseName}`;
  return withPool(integrationUrl, (admin) =>
    Effect.acquireUseRelease(
      Effect.promise(async () => {
        await admin.query(`CREATE DATABASE "${databaseName}"`);
        return databaseUrl.toString();
      }),
      use,
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

const namaConnectionCount = (databaseUrl: string) =>
  withPool(databaseUrl, (observer) =>
    Effect.map(
      Effect.promise(() =>
        observer.query<{ readonly connection_count: string }>(
          "SELECT count(*) AS connection_count FROM pg_stat_activity WHERE datname = current_database() AND application_name = 'nama-server'",
        ),
      ),
      (result) => result.rows[FIRST_ROW_INDEX]?.connection_count,
    ),
  );

const makeInvalidMigrationFolders = Effect.gen(function* invalidMigrationFolders() {
  const fileSystem = yield* FileSystem.FileSystem;
  const missing = yield* fileSystem.makeTempDirectoryScoped({
    prefix: "nama-migrations-missing-",
  });
  const malformed = yield* fileSystem.makeTempDirectoryScoped({
    prefix: "nama-migrations-malformed-",
  });
  yield* fileSystem.makeDirectory(join(malformed, "meta"));
  yield* fileSystem.writeFileString(join(malformed, "meta", "_journal.json"), "not-json");
  return { malformed, missing };
}).pipe(Effect.provide(NodeFileSystem.layer));

it.live("boots an empty database with the zero-entry production journal", () =>
  withIsolatedDatabase((databaseUrl) =>
    Effect.gen(function* emptyDatabaseTest() {
      const ready = yield* useDatabase(
        databaseUrl,
        productionMigrations,
        (database) => database.checkReadiness,
      );
      expect(ready).toBe(true);

      const result = yield* withPool(databaseUrl, (observer) =>
        Effect.promise(() =>
          observer.query<{ readonly table_name: string }>(
            "SELECT table_name FROM information_schema.tables WHERE table_schema = 'drizzle'",
          ),
        ),
      );
      expect(result.rows.map(({ table_name: tableName }) => tableName)).toContain(
        "__drizzle_migrations",
      );
    }),
  ),
);

it.live("upgrades a database that already applied the prior fixture migration", () =>
  withIsolatedDatabase((databaseUrl) =>
    Effect.gen(function* migrationUpgradeTest() {
      yield* useDatabase(databaseUrl, priorMigrations, (database) => database.checkReadiness);
      yield* useDatabase(databaseUrl, latestMigrations, (database) => database.checkReadiness);

      const result = yield* withPool(databaseUrl, (observer) =>
        Effect.promise(() =>
          observer.query<{ readonly upgraded: boolean; readonly value: string }>(
            "SELECT value, upgraded FROM nama_fixture_upgrade",
          ),
        ),
      );
      expect(result.rows).toEqual([{ upgraded: true, value: "prior" }]);
    }),
  ),
);

it.live("normalizes migration failure and closes its partially acquired pool", () =>
  withIsolatedDatabase((databaseUrl) =>
    Effect.gen(function* migrationFailureTest() {
      const error = yield* databaseFailure(databaseUrl, failingMigrations);
      expect(error).toMatchObject({ _tag: "MigrationError" });
      expect(JSON.stringify(error)).not.toContain("nama_forced_migration_failure");
      expect(JSON.stringify(error)).not.toContain(databaseUrl);
      expect(yield* namaConnectionCount(databaseUrl)).toBe("0");
    }),
  ),
);

it.live("normalizes initial database unavailability within the probe bound", () =>
  Effect.gen(function* unavailableDatabaseTest() {
    const unavailable = new URL(integrationUrl);
    unavailable.port = "1";
    const startedAt = yield* Clock.currentTimeMillis;
    const error = yield* databaseFailure(unavailable.toString(), productionMigrations);
    const completedAt = yield* Clock.currentTimeMillis;

    expect(error).toMatchObject({ _tag: "DatabaseConnectionError" });
    expect(completedAt - startedAt).toBeLessThan(PROBE_BOUND_MILLISECONDS);
    expect(JSON.stringify(error)).not.toContain(unavailable.toString());
  }),
);

it.live("rejects missing and malformed migration journals", () =>
  withIsolatedDatabase((databaseUrl) =>
    Effect.gen(function* invalidMigrationJournalTest() {
      const folders = yield* makeInvalidMigrationFolders;
      const missingError = yield* databaseFailure(databaseUrl, folders.missing);
      const malformedError = yield* databaseFailure(databaseUrl, folders.malformed);

      expect(missingError).toMatchObject({ _tag: "MigrationError" });
      expect(malformedError).toMatchObject({ _tag: "MigrationError" });
    }),
  ),
);

it.live("closes the shared pool when its Effect scope exits", () =>
  withIsolatedDatabase((databaseUrl) =>
    Effect.gen(function* poolClosureTest() {
      const duringScope = yield* useDatabase(databaseUrl, productionMigrations, (database) =>
        Effect.gen(function* inspectOpenPool() {
          yield* database.checkReadiness;
          return yield* namaConnectionCount(databaseUrl);
        }),
      );
      expect(duringScope).toBe("1");
      expect(yield* namaConnectionCount(databaseUrl)).toBe("0");
    }),
  ),
);
