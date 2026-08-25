import { and, eq, isNull, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Context, Data, Effect, Layer, Redacted } from "effect";
import { Pool } from "pg";

import { Config } from "../config/config.ts";
import { makeCatalog } from "./catalog-persistence.ts";
import type { CatalogPersistence, CatalogQueryStorage } from "./catalog-persistence.ts";
import { reconcileDatabaseInitialization } from "./initialization.ts";
import type { DatabaseInitialization } from "./initialization.ts";
import { makeProviderPersistence } from "./provider-persistence.ts";
import type { ProviderPersistence } from "./provider-persistence.ts";
import { databaseSchema, namaServerState } from "./schema.ts";

const EXPECTED_SINGLE_UPDATED_MARKER_COUNT = 1;
const PROBE_TIMEOUT_MILLISECONDS = 2000;
const SERVER_KEY = "server";

const taggedError = Data.TaggedError;
const contextService = Context.Service;
const DatabaseConnectionError = taggedError("DatabaseConnectionError");
const MigrationError = taggedError("MigrationError");
const DatabaseInitializationCompletionError = taggedError("DatabaseInitializationCompletionError");
type DatabaseInitializationCompletionFailure = InstanceType<
  typeof DatabaseInitializationCompletionError
>;
type DatabaseDrizzle = NodePgDatabase<typeof databaseSchema>;

interface DatabaseAuthentication {
  readonly database: DatabaseDrizzle;
  readonly completeInitialization: (
    administratorUserId: string,
  ) => Effect.Effect<void, DatabaseInitializationCompletionFailure>;
}

interface DatabaseService {
  readonly authentication: DatabaseAuthentication;
  readonly catalog: CatalogPersistence;
  readonly catalogQueries: CatalogQueryStorage;
  readonly initialization: DatabaseInitialization;
  readonly checkReadiness: Effect.Effect<boolean>;
  readonly providers: ProviderPersistence;
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

const completeInitialization = (
  database: DatabaseDrizzle,
  administratorUserId: string,
): Effect.Effect<void, DatabaseInitializationCompletionFailure> =>
  Effect.tryPromise({
    catch: () => new DatabaseInitializationCompletionError({}),
    try: () =>
      database.transaction(async (transaction) => {
        const updatedRows = await transaction
          .update(namaServerState)
          .set({
            administratorUserId,
            initializedAt: sql`transaction_timestamp()`,
          })
          .where(
            and(
              eq(namaServerState.key, SERVER_KEY),
              isNull(namaServerState.administratorUserId),
              isNull(namaServerState.initializedAt),
            ),
          )
          .returning({ key: namaServerState.key });
        if (updatedRows.length !== EXPECTED_SINGLE_UPDATED_MARKER_COUNT) {
          throw new DatabaseInitializationCompletionError(undefined);
        }
      }),
  });

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
    const database = drizzle(pool, { logger: false, schema: databaseSchema });
    yield* Effect.tryPromise({
      catch: () => new MigrationError(undefined),
      try: () => migrate(database, { migrationsFolder }),
    });
    const initialization = yield* reconcileDatabaseInitialization(database);
    const catalog = makeCatalog(database);
    const providerPersistence = yield* Effect.acquireRelease(
      makeProviderPersistence(database, config.security.masterKey),
      (owner) => Effect.sync(owner.close),
    );
    yield* runInitialProbe(pool);

    return Database.of({
      authentication: {
        completeInitialization: (administratorUserId) =>
          completeInitialization(database, administratorUserId),
        database,
      },
      catalog: catalog.persistence,
      catalogQueries: catalog.queries,
      checkReadiness: makeReadinessProbe(pool),
      initialization,
      providers: providerPersistence.service,
    });
  });

class Database extends contextService<Database, DatabaseService>()("@nama/server/Database") {
  static readonly layer = (migrationsFolder: string) =>
    Layer.effect(Database, makeDatabase(migrationsFolder));
}

export { Database };
