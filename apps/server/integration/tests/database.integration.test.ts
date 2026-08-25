import { join } from "node:path";

import { NodeFileSystem } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Clock, Effect, FileSystem } from "effect";

import {
  exerciseMarkerConstraints,
  insertFixtureUser,
} from "./database-constraint.test-support.ts";
import {
  createZeroEntryMigrationJournal,
  databaseFailure,
  productionMigrations,
  useDatabase,
  withPool,
} from "./database.test-support.ts";
import { integrationUrl, withIsolatedDatabase } from "./postgres.test-support.ts";

const FIRST_ROW_INDEX = 0;
const PROBE_BOUND_MILLISECONDS = 3000;
const SINGLE_ROW_COUNT = 1;
const PRODUCTION_MIGRATION_COUNT = "4";
const PRODUCTION_TABLE_NAMES = [
  "account",
  "canonical_artwork",
  "canonical_credit",
  "canonical_hierarchy",
  "canonical_item",
  "device_code",
  "jwks",
  "library_entry",
  "media_part",
  "media_source",
  "media_track",
  "nama_server_state",
  "oauth_access_token",
  "oauth_client",
  "oauth_client_assertion",
  "oauth_client_resource",
  "oauth_consent",
  "oauth_refresh_token",
  "oauth_resource",
  "provider_artwork_mapping",
  "provider_catalog_scan_state",
  "provider_credential",
  "provider_external_identifier",
  "provider_installation",
  "provider_instance",
  "provider_instance_observation",
  "provider_item_mapping",
  "provider_item_parent_reference",
  "provider_operation_result",
  "provider_part_mapping",
  "provider_source_mapping",
  "provider_track_mapping",
  "session",
  "user",
  "verification",
] as const;

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

it.live("creates all production tables and one uninitialized server singleton", () =>
  withIsolatedDatabase((databaseUrl) =>
    Effect.gen(function* freshMigrationTest() {
      yield* useDatabase(databaseUrl, productionMigrations, (database) => database.checkReadiness);
      const result = yield* withPool(databaseUrl, (observer) =>
        Effect.promise(async () => {
          const tables = await observer.query<{ readonly table_name: string }>(
            "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name",
          );
          const state = await observer.query<{
            readonly administrator_user_id: string | null;
            readonly initialized_at: Date | null;
            readonly initialized_at_type: string;
            readonly key: string;
          }>(
            'SELECT "key", initialized_at, administrator_user_id, pg_typeof(initialized_at)::text AS initialized_at_type FROM nama_server_state',
          );
          return {
            state: state.rows,
            tables: tables.rows,
          };
        }),
      );

      expect(result.tables.map(({ table_name: tableName }) => tableName)).toEqual(
        PRODUCTION_TABLE_NAMES,
      );
      expect(result.state).toEqual([
        expect.objectContaining({
          initialized_at_type: "timestamp with time zone",
          key: "server",
        }),
      ]);
      const serverState = result.state[FIRST_ROW_INDEX];
      expect(serverState?.administrator_user_id).toBeNull();
      expect(serverState?.initialized_at).toBeNull();
    }),
  ),
);

it.live("exposes immutable setup eligibility after reconciliation", () =>
  withIsolatedDatabase((databaseUrl) =>
    Effect.gen(function* setupEligibilityTest() {
      const initialization = yield* useDatabase(databaseUrl, productionMigrations, (database) =>
        Effect.succeed(database.initialization),
      );

      expect(initialization).toBe("setup-eligible");
    }),
  ),
);

it.live("upgrades the prior zero-entry production journal exactly once", () =>
  withIsolatedDatabase((databaseUrl) =>
    Effect.gen(function* migrationUpgradeTest() {
      yield* withPool(databaseUrl, createZeroEntryMigrationJournal);
      const migrationCount = () =>
        withPool(databaseUrl, (observer) =>
          Effect.map(
            Effect.promise(() =>
              observer.query<{ readonly migration_count: string }>(
                "SELECT count(*) AS migration_count FROM drizzle.__drizzle_migrations",
              ),
            ),
            (result) => result.rows[FIRST_ROW_INDEX]?.migration_count,
          ),
        );
      expect(yield* migrationCount()).toBe("0");

      yield* useDatabase(databaseUrl, productionMigrations, (database) => database.checkReadiness);
      expect(yield* migrationCount()).toBe(PRODUCTION_MIGRATION_COUNT);
      yield* useDatabase(databaseUrl, productionMigrations, (database) => database.checkReadiness);
      expect(yield* migrationCount()).toBe(PRODUCTION_MIGRATION_COUNT);
    }),
  ),
);

it.live("repeated Database acquisition preserves an initialized marker", () =>
  withIsolatedDatabase((databaseUrl) =>
    Effect.gen(function* idempotentMigrationTest() {
      yield* useDatabase(databaseUrl, productionMigrations, (database) => database.checkReadiness);
      const before = yield* withPool(databaseUrl, (observer) =>
        Effect.gen(function* initializeMarker() {
          yield* insertFixtureUser(observer, "administrator", "administrator@example.test");
          yield* Effect.promise(() =>
            observer.query(
              "UPDATE nama_server_state SET initialized_at = CURRENT_TIMESTAMP, administrator_user_id = $1 WHERE \"key\" = 'server'",
              ["administrator"],
            ),
          );
          return yield* Effect.promise(() =>
            observer.query(
              "SELECT initialized_at::text AS initialized_at, administrator_user_id FROM nama_server_state",
            ),
          );
        }),
      );

      yield* useDatabase(databaseUrl, productionMigrations, (database) => database.checkReadiness);
      const after = yield* withPool(databaseUrl, (observer) =>
        Effect.promise(() =>
          observer.query(
            "SELECT initialized_at::text AS initialized_at, administrator_user_id FROM nama_server_state",
          ),
        ),
      );
      expect(after.rows).toEqual(before.rows);
    }),
  ),
);

it.live("enforces the fixed, paired, restrictive server marker", () =>
  withIsolatedDatabase((databaseUrl) =>
    Effect.gen(function* markerConstraintTest() {
      yield* useDatabase(databaseUrl, productionMigrations, (database) => database.checkReadiness);
      const result = yield* exerciseMarkerConstraints(databaseUrl);

      expect(result.failures).toMatchObject({
        administratorWithoutInitialization: { code: "23514" },
        initializedWithoutAdministrator: { code: "23514" },
        invalidKey: { code: "23514" },
        retainedAdministratorDeletion: { code: "23001" },
      });
      expect(result.retainedUsers).toEqual([{ user_count: SINGLE_ROW_COUNT }]);
    }),
  ),
);

it.live("normalizes unmanaged-table conflict and closes its partially acquired pool", () =>
  withIsolatedDatabase((databaseUrl) =>
    Effect.gen(function* migrationConflictTest() {
      yield* withPool(databaseUrl, (observer) =>
        Effect.promise(() => observer.query('CREATE TABLE "user" (id text PRIMARY KEY)')),
      );
      const error = yield* databaseFailure(databaseUrl, productionMigrations);
      expect(error).toMatchObject({ _tag: "MigrationError" });
      expect(JSON.stringify(error)).not.toContain("already exists");
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
