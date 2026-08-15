import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Context, Data, Effect, Layer, Redacted } from "effect";
import { Pool } from "pg";

import { Config } from "../config/config.ts";

const PROBE_TIMEOUT_MILLISECONDS = 2000;

const taggedError = Data.TaggedError;
const contextService = Context.Service;
const DatabaseConnectionError = taggedError("DatabaseConnectionError");
const MigrationError = taggedError("MigrationError");

interface DatabaseService {
  readonly checkReadiness: Effect.Effect<boolean>;
}
const ignoreIdlePoolError = (): void => {
  // The bounded readiness probe reports idle connection loss without retaining PostgreSQL details.
};

const verifyConnection = (pool: Readonly<Pool>) =>
  Effect.tryPromise({
    catch: () => new DatabaseConnectionError(undefined),
    try: async () => {
      const connection = await pool.connect();
      connection.release();
    },
  });

const runInitialProbe = (pool: Readonly<Pool>) =>
  Effect.tryPromise({
    catch: () => new DatabaseConnectionError(undefined),
    try: () => pool.query("SELECT 1"),
  });

const makeReadinessProbe = (pool: Readonly<Pool>): Effect.Effect<boolean> =>
  Effect.tryPromise({
    catch: () => new DatabaseConnectionError(undefined),
    try: () => pool.query("SELECT 1"),
  }).pipe(
    Effect.timeout(PROBE_TIMEOUT_MILLISECONDS),
    Effect.as(true),
    Effect.match({ onFailure: () => false, onSuccess: (ready) => ready }),
  );

const makeDatabase = (migrationsFolder: string) =>
  Effect.gen(function* makeDatabaseService() {
    const config = yield* Config;
    const pool = yield* Effect.acquireRelease(
      Effect.sync(() => {
        const acquiredPool = new Pool({
          application_name: "nama-server",
          connectionString: Redacted.value(config.database.url),
          connectionTimeoutMillis: PROBE_TIMEOUT_MILLISECONDS,
          max: config.database.maxConnections,
          query_timeout: PROBE_TIMEOUT_MILLISECONDS,
        });
        acquiredPool.on("error", ignoreIdlePoolError);
        return acquiredPool;
      }),
      (acquiredPool: Readonly<Pool>) => Effect.promise(() => acquiredPool.end()),
    );

    yield* verifyConnection(pool);
    const database = drizzle(pool, { logger: false });
    yield* Effect.tryPromise({
      catch: () => new MigrationError(undefined),
      try: () => migrate(database, { migrationsFolder }),
    });
    yield* runInitialProbe(pool);

    return Database.of({ checkReadiness: makeReadinessProbe(pool) });
  });

export class Database extends contextService<Database, DatabaseService>()("@nama/server/Database") {
  static readonly layer = (migrationsFolder: string) =>
    Layer.effect(Database, makeDatabase(migrationsFolder));
}
