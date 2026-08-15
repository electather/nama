import { Effect } from "effect";
import type { Pool } from "pg";

import { withPool } from "./database.test-support.ts";

const captureQueryFailure = (query: () => Promise<unknown>) =>
  Effect.promise(async () => {
    try {
      return await query();
    } catch (error: unknown) {
      return error;
    }
  });

const capturePoolQueryFailure = (pool: Pool, query: string, parameters?: unknown[]) =>
  captureQueryFailure(() => pool.query(query, parameters));

const insertFixtureUser = (pool: Pool, id: string, email: string) =>
  Effect.promise(() =>
    pool.query('INSERT INTO "user" (id, name, email) VALUES ($1, $2, $3)', [
      id,
      "Administrator",
      email,
    ]),
  );

const exerciseMarkerConstraints = (databaseUrl: string) =>
  withPool(databaseUrl, (observer) =>
    Effect.gen(function* markerConstraints() {
      yield* insertFixtureUser(observer, "marker-user", "marker@example.test");
      const invalidKey = yield* capturePoolQueryFailure(
        observer,
        'INSERT INTO nama_server_state ("key") VALUES ($1)',
        ["other"],
      );
      const initializedWithoutAdministrator = yield* capturePoolQueryFailure(
        observer,
        "UPDATE nama_server_state SET initialized_at = CURRENT_TIMESTAMP WHERE \"key\" = 'server'",
      );
      const administratorWithoutInitialization = yield* capturePoolQueryFailure(
        observer,
        "UPDATE nama_server_state SET administrator_user_id = $1 WHERE \"key\" = 'server'",
        ["marker-user"],
      );
      yield* Effect.promise(() =>
        observer.query(
          "UPDATE nama_server_state SET initialized_at = CURRENT_TIMESTAMP, administrator_user_id = $1 WHERE \"key\" = 'server'",
          ["marker-user"],
        ),
      );
      const retainedAdministratorDeletion = yield* capturePoolQueryFailure(
        observer,
        'DELETE FROM "user" WHERE id = $1',
        ["marker-user"],
      );
      const retainedUsers = yield* Effect.promise(() =>
        observer.query<{ readonly user_count: number }>(
          'SELECT count(*)::integer AS user_count FROM "user"',
        ),
      );
      return {
        failures: {
          administratorWithoutInitialization,
          initializedWithoutAdministrator,
          invalidKey,
          retainedAdministratorDeletion,
        },
        retainedUsers: retainedUsers.rows,
      };
    }),
  );

export { exerciseMarkerConstraints, insertFixtureUser };
