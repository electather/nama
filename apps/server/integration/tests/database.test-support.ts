import { join } from "node:path";

import { Effect, Redacted } from "effect";
import { Pool } from "pg";
import type { PoolClient } from "pg";

import { Config } from "../../src/config/config.ts";
import { Database } from "../../src/database/database.ts";

const MASTER_KEY_BYTES = 32;
const FIRST_ROW_INDEX = 0;
const ENCODED_MASTER_KEY = Buffer.alloc(MASTER_KEY_BYTES).toString("base64");
const MASTER_KEY = `base64:${ENCODED_MASTER_KEY}`;

const productionMigrations = join(import.meta.dirname, "../../drizzle/");
const createZeroEntryMigrationJournal = (pool: Pool) =>
  Effect.promise(() =>
    pool.query(`CREATE SCHEMA drizzle;
CREATE TABLE drizzle.__drizzle_migrations (
  id serial PRIMARY KEY,
  hash text NOT NULL,
  created_at bigint
)`),
  );

interface MigratedState {
  readonly migrationCount: string | undefined;
  readonly serverState:
    | {
        readonly administrator_user_id: string | null;
        readonly initialized_at: Date | null;
        readonly key: string;
      }
    | undefined;
}

const acquireMigrationLock = (pool: Pool) =>
  Effect.gen(function* acquireMigrationLockEffect() {
    yield* createZeroEntryMigrationJournal(pool);
    return yield* Effect.promise(async () => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("LOCK TABLE drizzle.__drizzle_migrations IN ACCESS EXCLUSIVE MODE");
        return client;
      } catch (error) {
        client.release();
        throw error;
      }
    });
  });

const releaseMigrationLock = (client: PoolClient) =>
  Effect.promise(async () => {
    try {
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  });

const readMigratedState = (observer: Pool) =>
  Effect.promise(async () => {
    const migrationCount = await observer.query<{ readonly count: string }>(
      "SELECT count(*) AS count FROM drizzle.__drizzle_migrations",
    );
    const state = await observer.query<{
      readonly administrator_user_id: string | null;
      readonly initialized_at: Date | null;
      readonly key: string;
    }>('SELECT "key", initialized_at, administrator_user_id FROM nama_server_state');
    return {
      migrationCount: migrationCount.rows.at(FIRST_ROW_INDEX)?.count,
      serverState: state.rows.at(FIRST_ROW_INDEX),
    };
  });

const configForDatabase = (databaseUrl: string, masterKey = MASTER_KEY) =>
  Config.of({
    database: Object.freeze({ maxConnections: 3, url: Redacted.make(databaseUrl) }),
    logging: Object.freeze({ level: "info" as const }),
    security: Object.freeze({
      masterKey: Redacted.make(masterKey),
    }),
    server: Object.freeze({ bind: "127.0.0.1:8080", publicUrl: "http://localhost:8080/" }),
  });

interface DatabaseUseOptions<Result, Error, Requirements> {
  readonly masterKey: string;
  readonly use: (database: Database["Service"]) => Effect.Effect<Result, Error, Requirements>;
}

const useConfiguredDatabase = <Result, Error, Requirements>(
  databaseUrl: string,
  migrationsFolder: string,
  options: DatabaseUseOptions<Result, Error, Requirements>,
) => {
  const config = configForDatabase(databaseUrl, options.masterKey);
  const databaseLayer = Database.layer(migrationsFolder);
  const program = Effect.gen(function* useDatabaseProgram() {
    const database = yield* Database;
    return yield* options.use(database);
  }).pipe(Effect.provide(databaseLayer), Effect.provideService(Config, config));
  return Effect.scoped(program);
};

const useDatabase = <Result, Error, Requirements>(
  databaseUrl: string,
  migrationsFolder: string,
  use: (database: Database["Service"]) => Effect.Effect<Result, Error, Requirements>,
) => useConfiguredDatabase(databaseUrl, migrationsFolder, { masterKey: MASTER_KEY, use });

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

export {
  type DatabaseUseOptions,
  type MigratedState,
  acquireMigrationLock,
  createZeroEntryMigrationJournal,
  databaseFailure,
  productionMigrations,
  readMigratedState,
  releaseMigrationLock,
  useDatabase,
  useConfiguredDatabase,
  withPool,
};
