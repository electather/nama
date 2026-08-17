import { expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { productionMigrations, useDatabase, withPool } from "./database.test-support.ts";
import { withIsolatedDatabase } from "./postgres.test-support.ts";

interface AdministratorFixture {
  readonly email: string;
  readonly id: string;
  readonly name: string;
}

interface AdministratorRow {
  readonly email: string;
  readonly id: string;
  readonly name: string;
}

interface DatabaseInitializationCompletionError {
  readonly _tag: "DatabaseInitializationCompletionError";
}

interface DatabaseAuthentication {
  readonly completeInitialization: (
    administratorUserId: string,
  ) => Effect.Effect<void, DatabaseInitializationCompletionError>;
}

interface DatabaseTimeRow {
  readonly database_time: Date;
}

interface MarkerRow {
  readonly administrator_user_id: string | null;
  readonly initialized_at: Date | null;
  readonly key: string;
}

interface PreparedCompletion {
  readonly databaseTimeBeforeCompletion: Date | undefined;
  readonly uninitializedMarker: readonly MarkerRow[];
}

interface CompletedMarker {
  readonly completedMarker: readonly MarkerRow[];
  readonly databaseTimeAfterCompletion: Date | undefined;
}

interface PersistedCompletion {
  readonly administrators: readonly AdministratorRow[];
  readonly marker: readonly MarkerRow[];
}

const SERVER_KEY = "server";
const FIRST_ROW_INDEX = 0;
const SINGLE_MARKER_COUNT = 1;
const DATABASE_PATH_PREFIX_LENGTH = 1;
const ADMINISTRATOR: AdministratorFixture = {
  email: "administrator@example.test",
  id: "administrator-user",
  name: "Administrator",
};

const readServerMarker = (databaseUrl: string) =>
  withPool(databaseUrl, (observer) =>
    Effect.map(
      Effect.promise(() =>
        observer.query<MarkerRow>(
          'SELECT "key", initialized_at, administrator_user_id FROM nama_server_state WHERE "key" = $1',
          [SERVER_KEY],
        ),
      ),
      (result) => result.rows,
    ),
  );

const readDatabaseTime = (databaseUrl: string) =>
  withPool(databaseUrl, (observer) =>
    Effect.map(
      Effect.promise(() =>
        observer.query<DatabaseTimeRow>("SELECT CURRENT_TIMESTAMP AS database_time"),
      ),
      (result) => result.rows[FIRST_ROW_INDEX]?.database_time,
    ),
  );

const prepareAdministratorCompletion = (databaseUrl: string): Effect.Effect<PreparedCompletion> =>
  Effect.gen(function* prepareAdministratorCompletionEffect() {
    const uninitializedMarker = yield* readServerMarker(databaseUrl);
    yield* withPool(databaseUrl, (observer) =>
      Effect.promise(() =>
        observer.query('INSERT INTO "user" (id, name, email) VALUES ($1, $2, $3)', [
          ADMINISTRATOR.id,
          ADMINISTRATOR.name,
          ADMINISTRATOR.email,
        ]),
      ),
    );
    const databaseTimeBeforeCompletion = yield* readDatabaseTime(databaseUrl);
    return { databaseTimeBeforeCompletion, uninitializedMarker };
  });

const completeInitialization = (
  authentication: DatabaseAuthentication,
  databaseUrl: string,
): Effect.Effect<CompletedMarker, DatabaseInitializationCompletionError> =>
  Effect.gen(function* completeInitializationEffect() {
    yield* authentication.completeInitialization(ADMINISTRATOR.id);
    const completedMarker = yield* readServerMarker(databaseUrl);
    const databaseTimeAfterCompletion = yield* readDatabaseTime(databaseUrl);
    return { completedMarker, databaseTimeAfterCompletion };
  });

const readPersistedCompletion = (databaseUrl: string): Effect.Effect<PersistedCompletion> =>
  withPool(databaseUrl, (observer) =>
    Effect.gen(function* readPersistedCompletionEffect() {
      const marker = yield* Effect.map(
        Effect.promise(() =>
          observer.query<MarkerRow>(
            'SELECT "key", initialized_at, administrator_user_id FROM nama_server_state WHERE "key" = $1',
            [SERVER_KEY],
          ),
        ),
        (result) => result.rows,
      );
      const administrators = yield* Effect.map(
        Effect.promise(() =>
          observer.query<AdministratorRow>('SELECT id, name, email FROM "user" WHERE id = $1', [
            ADMINISTRATOR.id,
          ]),
        ),
        (result) => result.rows,
      );
      return { administrators, marker };
    }),
  );

const assertUninitializedMarker = (markerRows: readonly MarkerRow[]): void => {
  expect(markerRows).toHaveLength(SINGLE_MARKER_COUNT);
  const marker = markerRows[FIRST_ROW_INDEX];
  expect(marker).toMatchObject({ key: SERVER_KEY });
  expect(marker?.administrator_user_id).toBeNull();
  expect(marker?.initialized_at).toBeNull();
};

const assertCompletedMarker = (
  markerRows: readonly MarkerRow[],
  databaseTimeBeforeCompletion: Date | undefined,
  databaseTimeAfterCompletion: Date | undefined,
): void => {
  expect(markerRows).toHaveLength(SINGLE_MARKER_COUNT);
  const marker = markerRows[FIRST_ROW_INDEX];
  expect(marker?.administrator_user_id).toBe(ADMINISTRATOR.id);
  expect(marker?.initialized_at).toBeInstanceOf(Date);
  expect(marker?.initialized_at?.getTime()).toBeGreaterThanOrEqual(
    databaseTimeBeforeCompletion?.getTime() ?? Number.POSITIVE_INFINITY,
  );
  expect(marker?.initialized_at?.getTime()).toBeLessThanOrEqual(
    databaseTimeAfterCompletion?.getTime() ?? Number.NEGATIVE_INFINITY,
  );
};

const assertSafeCompletionFailure = (
  completionError: DatabaseInitializationCompletionError,
  databaseUrl: string,
): void => {
  expect(completionError).toMatchObject({ _tag: "DatabaseInitializationCompletionError" });
  expect(JSON.stringify(completionError)).toBe('{"_tag":"DatabaseInitializationCompletionError"}');
  const parsedDatabaseUrl = new URL(databaseUrl);
  let renderedError = JSON.stringify(completionError);
  if (completionError instanceof Error) {
    renderedError = [renderedError, completionError.message].join("\n");
  }
  for (const detail of [
    databaseUrl,
    parsedDatabaseUrl.hostname,
    parsedDatabaseUrl.pathname.slice(DATABASE_PATH_PREFIX_LENGTH),
    parsedDatabaseUrl.port,
    "UPDATE nama_server_state",
    ADMINISTRATOR.id,
  ]) {
    expect(renderedError).not.toContain(detail);
  }
};

const assertRepeatCompletionPreservesDatabase = (
  persistedCompletion: PersistedCompletion,
  completedMarker: readonly MarkerRow[],
): void => {
  expect(persistedCompletion.marker).toEqual(completedMarker);
  expect(persistedCompletion.administrators).toEqual([ADMINISTRATOR]);
};

it.live(
  "completes the durable initialization marker once and reports repeat completion safely",
  () =>
    withIsolatedDatabase((databaseUrl) =>
      useDatabase(databaseUrl, productionMigrations, (database) =>
        Effect.gen(function* authenticationMarkerCompletionTest() {
          const preparedCompletion = yield* prepareAdministratorCompletion(databaseUrl);
          assertUninitializedMarker(preparedCompletion.uninitializedMarker);

          const completedMarker = yield* completeInitialization(
            database.authentication,
            databaseUrl,
          );
          assertCompletedMarker(
            completedMarker.completedMarker,
            preparedCompletion.databaseTimeBeforeCompletion,
            completedMarker.databaseTimeAfterCompletion,
          );

          const completionError = yield* database.authentication
            .completeInitialization(ADMINISTRATOR.id)
            .pipe(Effect.flip);
          assertSafeCompletionFailure(completionError, databaseUrl);

          const persistedCompletion = yield* readPersistedCompletion(databaseUrl);
          assertRepeatCompletionPreservesDatabase(
            persistedCompletion,
            completedMarker.completedMarker,
          );
        }),
      ),
    ),
);
