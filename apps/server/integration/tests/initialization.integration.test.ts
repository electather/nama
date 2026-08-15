import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import type { Pool } from "pg";

import { productionMigrations, useDatabase, withPool } from "./database.test-support.ts";
import { withIsolatedDatabase } from "./postgres.test-support.ts";

interface FixtureUser {
  readonly email: string;
  readonly id: string;
}

interface MarkerRow {
  readonly administrator_user_id: string | null;
  readonly initialized_at: Date | null;
  readonly key: string;
}

const SERVER_KEY = "server";
const DATABASE_PATH_PREFIX_LENGTH = 1;
const MARKER_ROW_INDEX = 0;
const SINGLE_MARKER_COUNT = 1;
const ADMINISTRATOR: FixtureUser = {
  email: "administrator@example.test",
  id: "administrator-user",
};
const SECOND_USER: FixtureUser = {
  email: "second@example.test",
  id: "second-user",
};
const ORPHANED_ADMINISTRATOR_ID = "orphaned-administrator";
const MARKER_FOREIGN_KEY = "nama_server_state_administrator_user_id_user_id_fk";

const acquireProductionDatabase = (databaseUrl: string) =>
  useDatabase(databaseUrl, productionMigrations, (database) => database.checkReadiness);

const insertUsers = (pool: Pool, users: readonly FixtureUser[]) =>
  Effect.promise(() =>
    Promise.all(
      users.map((user) =>
        pool.query('INSERT INTO "user" (id, name, email) VALUES ($1, $2, $3)', [
          user.id,
          "Administrator",
          user.email,
        ]),
      ),
    ),
  );

const initializeMarker = (pool: Pool, administratorUserId: string) =>
  Effect.promise(() =>
    pool.query(
      'UPDATE nama_server_state SET initialized_at = CURRENT_TIMESTAMP, administrator_user_id = $1 WHERE "key" = $2',
      [administratorUserId, SERVER_KEY],
    ),
  );

const readMarker = (databaseUrl: string) =>
  withPool(databaseUrl, (pool) =>
    Effect.map(
      Effect.promise(() =>
        pool.query<MarkerRow>(
          'SELECT "key", initialized_at, administrator_user_id FROM nama_server_state',
        ),
      ),
      (result) => result.rows,
    ),
  );

const databaseDetails = (databaseUrl: string): readonly string[] => {
  const parsed = new URL(databaseUrl);
  return [
    databaseUrl,
    parsed.hostname,
    parsed.pathname.slice(DATABASE_PATH_PREFIX_LENGTH),
    parsed.port,
  ];
};

const expectIntegrityFailure = (databaseUrl: string, prohibitedDetails: readonly string[]) =>
  Effect.gen(function* expectDatabaseIntegrityFailure() {
    const error = yield* acquireProductionDatabase(databaseUrl).pipe(Effect.flip);

    expect(error).toMatchObject({ _tag: "DatabaseIntegrityError" });
    expect(JSON.stringify(error)).toBe('{"_tag":"DatabaseIntegrityError"}');

    let errorMessage = "";
    if (error instanceof Error) {
      errorMessage = error.message;
    }
    const renderedError = [JSON.stringify(error), String(error), errorMessage].join("\n");
    for (const detail of prohibitedDetails) {
      expect(renderedError).not.toContain(detail);
    }
  });

const expectRepairedMarker = (
  repaired: readonly MarkerRow[],
  databaseTimeBeforeRepair: Date | undefined,
  databaseTimeAfterRepair: Date | undefined,
): void => {
  expect(repaired).toHaveLength(SINGLE_MARKER_COUNT);
  const marker = repaired[MARKER_ROW_INDEX];
  expect(marker?.administrator_user_id).toBe(ADMINISTRATOR.id);
  expect(marker?.initialized_at).toBeInstanceOf(Date);
  expect(marker?.initialized_at?.getTime()).toBeGreaterThanOrEqual(
    databaseTimeBeforeRepair?.getTime() ?? Number.POSITIVE_INFINITY,
  );
  expect(marker?.initialized_at?.getTime()).toBeLessThanOrEqual(
    databaseTimeAfterRepair?.getTime() ?? Number.NEGATIVE_INFINITY,
  );
};

const expectUninitializedMarker = (rows: readonly MarkerRow[]): void => {
  expect(rows).toHaveLength(SINGLE_MARKER_COUNT);
  const marker = rows[MARKER_ROW_INDEX];
  expect(marker).toMatchObject({ key: SERVER_KEY });
  expect(marker?.administrator_user_id).toBeNull();
  expect(marker?.initialized_at).toBeNull();
};

it.live("accepts an initialized marker with exactly one user", () =>
  withIsolatedDatabase((databaseUrl) =>
    Effect.gen(function* initializedOneUserTest() {
      expect(yield* acquireProductionDatabase(databaseUrl)).toBe(true);
      yield* withPool(databaseUrl, (pool) =>
        Effect.gen(function* configureFixture() {
          yield* insertUsers(pool, [ADMINISTRATOR]);
          yield* initializeMarker(pool, ADMINISTRATOR.id);
        }),
      );
      const before = yield* readMarker(databaseUrl);

      expect(yield* acquireProductionDatabase(databaseUrl)).toBe(true);
      expect(yield* readMarker(databaseUrl)).toEqual(before);
    }),
  ),
);

it.live("rejects an initialized marker with zero users", () =>
  withIsolatedDatabase((databaseUrl) =>
    Effect.gen(function* initializedZeroUsersTest() {
      expect(yield* acquireProductionDatabase(databaseUrl)).toBe(true);
      yield* withPool(databaseUrl, (pool) =>
        Effect.gen(function* corruptInitializedFixture() {
          yield* Effect.promise(() =>
            pool.query(`ALTER TABLE nama_server_state DROP CONSTRAINT "${MARKER_FOREIGN_KEY}"`),
          );
          yield* initializeMarker(pool, ORPHANED_ADMINISTRATOR_ID);
        }),
      );

      yield* expectIntegrityFailure(databaseUrl, [
        ORPHANED_ADMINISTRATOR_ID,
        "0",
        ...databaseDetails(databaseUrl),
      ]);
    }),
  ),
);

it.live("rejects an initialized marker with more than one user", () =>
  withIsolatedDatabase((databaseUrl) =>
    Effect.gen(function* initializedMultipleUsersTest() {
      expect(yield* acquireProductionDatabase(databaseUrl)).toBe(true);
      yield* withPool(databaseUrl, (pool) =>
        Effect.gen(function* corruptInitializedFixture() {
          yield* insertUsers(pool, [ADMINISTRATOR, SECOND_USER]);
          yield* initializeMarker(pool, ADMINISTRATOR.id);
        }),
      );

      yield* expectIntegrityFailure(databaseUrl, [
        ADMINISTRATOR.id,
        ADMINISTRATOR.email,
        SECOND_USER.id,
        SECOND_USER.email,
        "2",
        ...databaseDetails(databaseUrl),
      ]);
    }),
  ),
);

it.live("accepts an uninitialized marker with zero users without changing it", () =>
  withIsolatedDatabase((databaseUrl) =>
    Effect.gen(function* uninitializedZeroUsersTest() {
      expect(yield* acquireProductionDatabase(databaseUrl)).toBe(true);
      const before = yield* readMarker(databaseUrl);

      expect(yield* acquireProductionDatabase(databaseUrl)).toBe(true);
      expect(yield* readMarker(databaseUrl)).toEqual(before);
      expectUninitializedMarker(before);
    }),
  ),
);

it.live("repairs an uninitialized marker with exactly one user and preserves it", () =>
  withIsolatedDatabase((databaseUrl) =>
    Effect.gen(function* uninitializedOneUserTest() {
      expect(yield* acquireProductionDatabase(databaseUrl)).toBe(true);
      const databaseTimeBeforeRepair = yield* withPool(databaseUrl, (pool) =>
        Effect.gen(function* prepareRepairFixture() {
          yield* insertUsers(pool, [ADMINISTRATOR]);
          const result = yield* Effect.promise(() =>
            pool.query<{ readonly database_time: Date }>(
              "SELECT CURRENT_TIMESTAMP AS database_time",
            ),
          );
          return result.rows[MARKER_ROW_INDEX]?.database_time;
        }),
      );

      expect(yield* acquireProductionDatabase(databaseUrl)).toBe(true);
      const repaired = yield* readMarker(databaseUrl);
      const databaseTimeAfterRepair = yield* withPool(databaseUrl, (pool) =>
        Effect.map(
          Effect.promise(() =>
            pool.query<{ readonly database_time: Date }>(
              "SELECT CURRENT_TIMESTAMP AS database_time",
            ),
          ),
          (result) => result.rows[MARKER_ROW_INDEX]?.database_time,
        ),
      );

      expectRepairedMarker(repaired, databaseTimeBeforeRepair, databaseTimeAfterRepair);

      expect(yield* acquireProductionDatabase(databaseUrl)).toBe(true);
      expect(yield* readMarker(databaseUrl)).toEqual(repaired);
    }),
  ),
);

it.live("rejects an uninitialized marker with more than one user", () =>
  withIsolatedDatabase((databaseUrl) =>
    Effect.gen(function* uninitializedMultipleUsersTest() {
      expect(yield* acquireProductionDatabase(databaseUrl)).toBe(true);
      yield* withPool(databaseUrl, (pool) => insertUsers(pool, [ADMINISTRATOR, SECOND_USER]));

      yield* expectIntegrityFailure(databaseUrl, [
        ADMINISTRATOR.id,
        ADMINISTRATOR.email,
        SECOND_USER.id,
        SECOND_USER.email,
        "2",
        ...databaseDetails(databaseUrl),
      ]);
    }),
  ),
);

it.live("rejects a missing server singleton", () =>
  withIsolatedDatabase((databaseUrl) =>
    Effect.gen(function* missingSingletonTest() {
      expect(yield* acquireProductionDatabase(databaseUrl)).toBe(true);
      yield* withPool(databaseUrl, (pool) =>
        Effect.promise(() =>
          pool.query('DELETE FROM nama_server_state WHERE "key" = $1', [SERVER_KEY]),
        ),
      );

      yield* expectIntegrityFailure(databaseUrl, [SERVER_KEY, ...databaseDetails(databaseUrl)]);
    }),
  ),
);

it.live("fails when the conditional one-user repair updates zero marker rows", () =>
  withIsolatedDatabase((databaseUrl) =>
    Effect.gen(function* suppressedRepairTest() {
      expect(yield* acquireProductionDatabase(databaseUrl)).toBe(true);
      yield* withPool(databaseUrl, (pool) =>
        Effect.gen(function* suppressRepairFixture() {
          yield* insertUsers(pool, [ADMINISTRATOR]);
          yield* Effect.promise(() =>
            pool.query(
              "CREATE FUNCTION nama_test_suppress_marker_update() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$",
            ),
          );
          yield* Effect.promise(() =>
            pool.query(
              "CREATE TRIGGER nama_test_suppress_marker_update BEFORE UPDATE ON nama_server_state FOR EACH ROW EXECUTE FUNCTION nama_test_suppress_marker_update()",
            ),
          );
        }),
      );

      yield* expectIntegrityFailure(databaseUrl, [
        ADMINISTRATOR.id,
        ADMINISTRATOR.email,
        "0",
        ...databaseDetails(databaseUrl),
      ]);
      expectUninitializedMarker(yield* readMarker(databaseUrl));
    }),
  ),
);
