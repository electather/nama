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
  readonly revokeAppleClientRefreshTokens: Effect.Effect<
    void,
    Readonly<{ readonly _tag: "DatabaseAuthenticationMutationError" }>
  >;
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

interface AppleOAuthConfigurationRow {
  readonly application_type: string | null;
  readonly client_id: string;
  readonly client_secret: string | null;
  readonly grant_types: string[] | null;
  readonly resource: string;
  readonly resource_scopes: string[] | null;
  readonly scopes: string[] | null;
  readonly token_endpoint_auth_method: string | null;
}
interface RefreshTokenRevocationRow {
  readonly client_id: string;
  readonly id: string;
  readonly revoked: Date | null;
}
const SERVER_KEY = "server";
const FIRST_ROW_INDEX = 0;
const SINGLE_MARKER_COUNT = 1;
const SECOND_ROW_INDEX = 1;
const THIRD_ROW_INDEX = 2;
const DATABASE_PATH_PREFIX_LENGTH = 1;
const ADMINISTRATOR: AdministratorFixture = {
  email: "administrator@example.test",
  id: "administrator-user",
  name: "Administrator",
};

const APPLE_CLIENT_ID = "nama-apple";
const APPLE_RESOURCE = "http://localhost:8080/";
const DEVICE_CODE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
const APPLE_SCOPES = [
  "nama:library",
  "nama:playback",
  "nama:user-state",
  "offline_access",
] as const;
const RESOURCE_SCOPES = ["nama:library", "nama:playback", "nama:user-state"] as const;
const OTHER_CLIENT_ID = "other-client";
const EXISTING_REVOCATION = new Date("2026-08-20T12:00:00.000Z");
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
const readAppleOAuthConfiguration = (databaseUrl: string) =>
  withPool(databaseUrl, (observer) =>
    Effect.map(
      Effect.promise(() =>
        observer.query<AppleOAuthConfigurationRow>(
          `SELECT
             client.client_id,
             client.client_secret,
             client.token_endpoint_auth_method,
             client.application_type,
             client.grant_types,
             client.scopes,
             resource.identifier AS resource,
             resource.allowed_scopes AS resource_scopes
           FROM oauth_client AS client
           JOIN oauth_client_resource AS link ON link.client_id = client.client_id
           JOIN oauth_resource AS resource ON resource.identifier = link.resource_id
           WHERE client.client_id = $1`,
          [APPLE_CLIENT_ID],
        ),
      ),
      (result) => result.rows,
    ),
  );
const prepareRefreshTokenFamilies = (databaseUrl: string) =>
  withPool(databaseUrl, (observer) =>
    Effect.promise(async () => {
      await observer.query(
        `INSERT INTO "user" (id, name, email, email_verified)
         VALUES ('oauth-user', 'OAuth User', 'oauth-user@example.test', true)`,
      );
      await observer.query(
        `INSERT INTO oauth_client (id, client_id, redirect_uris)
         VALUES ('other-client', $1, ARRAY[]::text[])`,
        [OTHER_CLIENT_ID],
      );
      await observer.query(
        `INSERT INTO oauth_refresh_token
           (id, token, client_id, user_id, expires_at, created_at, revoked, scopes)
         VALUES
           ('apple-active', 'apple-active-token', $2, 'oauth-user', '2026-09-20T12:00:00Z', '2026-08-20T12:00:00Z', NULL, ARRAY['offline_access']::text[]),
           ('apple-revoked', 'apple-revoked-token', $2, 'oauth-user', '2026-09-20T12:00:00Z', '2026-08-20T12:00:00Z', $3, ARRAY['offline_access']::text[]),
           ('other-active', 'other-active-token', $1, 'oauth-user', '2026-09-20T12:00:00Z', '2026-08-20T12:00:00Z', NULL, ARRAY['offline_access']::text[])`,
        [OTHER_CLIENT_ID, APPLE_CLIENT_ID, EXISTING_REVOCATION],
      );
    }),
  );

const readRefreshTokenRevocations = (databaseUrl: string) =>
  withPool(databaseUrl, (observer) =>
    Effect.map(
      Effect.promise(() =>
        observer.query<RefreshTokenRevocationRow>(
          "SELECT id, client_id, revoked FROM oauth_refresh_token ORDER BY id",
        ),
      ),
      (result) => result.rows,
    ),
  );

it.live("seeds the fixed Apple public client for the configured Nama resource", () =>
  withIsolatedDatabase((databaseUrl) =>
    useDatabase(databaseUrl, productionMigrations, () =>
      Effect.gen(function* fixedAppleClientTest() {
        const rows = yield* readAppleOAuthConfiguration(databaseUrl);
        expect(rows).toEqual([
          {
            application_type: "native",
            client_id: APPLE_CLIENT_ID,
            // oxlint-disable-next-line unicorn/no-null -- A public OAuth client has no database secret.
            client_secret: null,
            grant_types: [DEVICE_CODE_GRANT, "refresh_token"],
            resource: APPLE_RESOURCE,
            resource_scopes: [...RESOURCE_SCOPES],
            scopes: [...APPLE_SCOPES],
            token_endpoint_auth_method: "none",
          },
        ]);
      }),
    ),
  ),
);
it.live("revokes every active refresh-token family for only the fixed Apple client", () =>
  withIsolatedDatabase((databaseUrl) =>
    useDatabase(databaseUrl, productionMigrations, (database) =>
      Effect.gen(function* fixedAppleClientRevocationTest() {
        yield* prepareRefreshTokenFamilies(databaseUrl);
        yield* database.authentication.revokeAppleClientRefreshTokens;
        const rows = yield* readRefreshTokenRevocations(databaseUrl);

        expect(rows.map((row) => ({ clientId: row.client_id, id: row.id }))).toEqual([
          { clientId: APPLE_CLIENT_ID, id: "apple-active" },
          { clientId: APPLE_CLIENT_ID, id: "apple-revoked" },
          { clientId: OTHER_CLIENT_ID, id: "other-active" },
        ]);
        expect(rows[FIRST_ROW_INDEX]?.revoked).toBeInstanceOf(Date);
        expect(rows[SECOND_ROW_INDEX]?.revoked).toEqual(EXISTING_REVOCATION);
        expect(rows[THIRD_ROW_INDEX]?.revoked).toBeNull();
      }),
    ),
  ),
);

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
