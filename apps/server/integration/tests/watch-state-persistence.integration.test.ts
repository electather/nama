import { expect, it } from "@effect/vitest";
import { Effect } from "effect";

import type { Database } from "../../src/database/database.ts";
import type {
  CanonicalWatchState,
  CanonicalWatchStateCommitResult,
  CanonicalWatchStateTarget,
} from "../../src/database/watch-state-persistence.ts";
import {
  ADMINISTRATOR_ID,
  episodeObservation,
  initializeCatalogDatabase,
  movieObservation,
  seasonObservation,
  showObservation,
} from "./catalog-persistence.test-support.ts";
import { insertFixtureUser } from "./database-constraint.test-support.ts";
import { productionMigrations, useDatabase, withPool } from "./database.test-support.ts";
import { withIsolatedDatabase } from "./postgres.test-support.ts";

const FIRST_SOURCE_INDEX = 0;
const ZERO_NANOSECONDS = 0;
const SECOND_PRINCIPAL_ID = "watch-state-second-principal";
const PROVIDER_INSTANCE_ID = "watch-state-provider";
const ACTIVITY_OCCURRED_AT = new Date("2026-08-27T14:15:16.789Z");
const EQUAL_ACTIVITY_OCCURRED_AT = new Date("2026-08-27T15:16:17.890Z");
const UPDATED_ACTIVITY_OCCURRED_AT = new Date("2026-08-27T16:17:18.901Z");
const STALE_ACTIVITY_OCCURRED_AT = new Date("2026-08-27T17:18:19.012Z");
const INITIAL_ACTIVITY_POSITION_SECONDS = 321n;
const WATCHED_STATUS_ACTION_POSITION_SECONDS = 322n;
const PROVIDER_REPLICA_POSITION_SECONDS = 323n;

type DatabaseService = Database["Service"];
const NAMA_PLAYBACK_ORIGIN: CanonicalWatchStateTarget["activity"]["origin"] = {
  kind: "nama_playback",
};
const NAMA_WATCHED_STATUS_ACTION_ORIGIN: CanonicalWatchStateTarget["activity"]["origin"] = {
  kind: "nama_watched_status_action",
};
const PROVIDER_REPLICA_ITEM_REFERENCE = "watch-state-provider-item-reference";
const PROVIDER_REPLICA_ORIGIN: CanonicalWatchStateTarget["activity"]["origin"] = {
  kind: "provider_replica",
  providerInstanceId: PROVIDER_INSTANCE_ID,
  providerItemReference: PROVIDER_REPLICA_ITEM_REFERENCE,
};

interface ActivityOriginCommitInput {
  readonly canonicalItemId: string;
  readonly expectedVersion?: bigint | undefined;
  readonly origin: CanonicalWatchStateTarget["activity"]["origin"];
  readonly positionSeconds: bigint;
  readonly sourceId: string;
}

interface ActivityOriginReplacementInput {
  readonly current: CanonicalWatchState;
  readonly expectedOrigin: CanonicalWatchStateTarget["activity"]["origin"];
  readonly nextOrigin: CanonicalWatchStateTarget["activity"]["origin"];
  readonly positionSeconds: bigint;
  readonly sourceId: string;
}

const LOCAL_STATE_ACTIVITY: CanonicalWatchStateTarget["activity"] = {
  occurredAt: ACTIVITY_OCCURRED_AT,
  origin: NAMA_WATCHED_STATUS_ACTION_ORIGIN,
  reliability: "reliable",
  semantics: "state_changed",
};
const PROVIDER_HEURISTIC_ACTIVITY: CanonicalWatchStateTarget["activity"] = {
  occurredAt: ACTIVITY_OCCURRED_AT,
  origin: PROVIDER_REPLICA_ORIGIN,
  reliability: "heuristic",
  semantics: "unknown",
};
const PROVIDER_PLAYBACK_ACTIVITY: CanonicalWatchStateTarget["activity"] = {
  occurredAt: ACTIVITY_OCCURRED_AT,
  origin: PROVIDER_REPLICA_ORIGIN,
  reliability: "reliable",
  semantics: "playback_started",
};
const initializeWatchStateDatabase = (databaseUrl: string) =>
  initializeCatalogDatabase(databaseUrl, [{ id: PROVIDER_INSTANCE_ID, priority: 1 }], true);

const committedState = (result: CanonicalWatchStateCommitResult): CanonicalWatchState => {
  expect(result.status).toBe("committed");
  if (result.status !== "committed") {
    throw new Error("canonical Watch state commit was stale");
  }
  return result.state;
};

const observeMovieWithSource = (database: DatabaseService) =>
  Effect.gen(function* observeCanonicalMovieWithSource() {
    const movie = yield* database.catalog.observeItem(movieObservation(PROVIDER_INSTANCE_ID));
    const sourceId = movie.sources[FIRST_SOURCE_INDEX]?.id;
    if (sourceId === undefined) {
      return yield* Effect.die("catalog fixture source is missing");
    }
    return { movie, sourceId };
  });

const completeTarget = (canonicalItemId: string, sourceId: string): CanonicalWatchStateTarget => ({
  activity: {
    occurredAt: ACTIVITY_OCCURRED_AT,
    origin: PROVIDER_REPLICA_ORIGIN,
    reliability: "reliable",
    semantics: "state_changed",
  },
  canonicalItemId,
  duration: { nanoseconds: 987_654_321, seconds: 7200n },
  lastSourceId: sourceId,
  position: { nanoseconds: 123_456_789, seconds: INITIAL_ACTIVITY_POSITION_SECONDS },
  principalId: ADMINISTRATOR_ID,
  watched: true,
});

const loadedWatchState = (database: DatabaseService, canonicalItemId: string) =>
  Effect.gen(function* loadPersistedCanonicalWatchState() {
    const state = yield* database.watchState.load({
      canonicalItemId,
      principalId: ADMINISTRATOR_ID,
    });
    if (state === undefined) {
      return yield* Effect.die("canonical Watch state was not persisted");
    }
    return state;
  });

const expectActivityOrigin = (
  state: CanonicalWatchState,
  origin: CanonicalWatchStateTarget["activity"]["origin"],
): void => {
  expect(state.activity.origin).toEqual(origin);
};

const commitActivityOrigin = (database: DatabaseService, input: ActivityOriginCommitInput) =>
  Effect.gen(function* commitCanonicalWatchStateWithContractOrigin() {
    const state = committedState(
      yield* database.watchState.compareAndCommit({
        expectedVersion: input.expectedVersion,
        target: {
          ...completeTarget(input.canonicalItemId, input.sourceId),
          activity: {
            occurredAt: ACTIVITY_OCCURRED_AT,
            origin: input.origin,
            reliability: "reliable",
            semantics: "state_changed",
          },
          position: { nanoseconds: ZERO_NANOSECONDS, seconds: input.positionSeconds },
        },
      }),
    );
    expectActivityOrigin(state, input.origin);
    expect(state.position).toEqual({
      nanoseconds: ZERO_NANOSECONDS,
      seconds: input.positionSeconds,
    });

    const loaded = yield* loadedWatchState(database, input.canonicalItemId);
    expectActivityOrigin(loaded, input.origin);
    expect(loaded.position).toEqual({
      nanoseconds: ZERO_NANOSECONDS,
      seconds: input.positionSeconds,
    });
    return loaded;
  });

const expectCompleteState = (
  state: CanonicalWatchState,
  canonicalItemId: string,
  sourceId: string,
): void => {
  expect(state).toMatchObject({
    activity: {
      occurredAt: ACTIVITY_OCCURRED_AT,
      origin: PROVIDER_REPLICA_ORIGIN,
      reliability: "reliable",
      semantics: "state_changed",
    },
    canonicalItemId,
    duration: { nanoseconds: 987_654_321, seconds: 7200n },
    lastSourceId: sourceId,
    position: { nanoseconds: 123_456_789, seconds: INITIAL_ACTIVITY_POSITION_SECONDS },
    principalId: ADMINISTRATOR_ID,
    version: 1n,
    watched: true,
  });
};

const expectDatabaseCommitTime = (
  state: CanonicalWatchState,
  beforeCommit: Date,
  afterCommit: Date,
): void => {
  expect(state.committedAt.getTime()).toBeGreaterThanOrEqual(beforeCommit.getTime());
  expect(state.committedAt.getTime()).toBeLessThanOrEqual(afterCommit.getTime());
};

const commitRoundTripFixture = (database: DatabaseService) =>
  Effect.gen(function* commitDurableCanonicalWatchState() {
    const { movie, sourceId } = yield* observeMovieWithSource(database);
    const absent = yield* database.watchState.load({
      canonicalItemId: movie.id,
      principalId: ADMINISTRATOR_ID,
    });
    expect(absent).toBeUndefined();

    const beforeCommit = new Date();
    const result = yield* database.watchState.compareAndCommit({
      expectedVersion: undefined,
      target: completeTarget(movie.id, sourceId),
    });
    const afterCommit = new Date();
    const state = committedState(result);
    expectCompleteState(state, movie.id, sourceId);
    expectDatabaseCommitTime(state, beforeCommit, afterCommit);
    return state;
  });

const roundTripScenario = (databaseUrl: string) =>
  Effect.gen(function* roundTripCanonicalWatchState() {
    yield* initializeWatchStateDatabase(databaseUrl);
    const committed = yield* useDatabase(databaseUrl, productionMigrations, commitRoundTripFixture);
    const reconstructed = yield* useDatabase(databaseUrl, productionMigrations, (database) =>
      database.watchState.load({
        canonicalItemId: committed.canonicalItemId,
        principalId: ADMINISTRATOR_ID,
      }),
    );
    expect(reconstructed).toEqual(committed);
  });

it.live("round-trips one accepted canonical Watch state after database reconstruction", () =>
  withIsolatedDatabase(roundTripScenario),
);

const commitInitialActivityOrigin = (database: DatabaseService) =>
  Effect.gen(function* commitInitialContractActivityOrigin() {
    const { movie, sourceId } = yield* observeMovieWithSource(database);
    const state = yield* commitActivityOrigin(database, {
      canonicalItemId: movie.id,
      expectedVersion: undefined,
      origin: NAMA_PLAYBACK_ORIGIN,
      positionSeconds: INITIAL_ACTIVITY_POSITION_SECONDS,
      sourceId,
    });
    return { sourceId, state };
  });

const replaceActivityOrigin = (database: DatabaseService, input: ActivityOriginReplacementInput) =>
  Effect.gen(function* replacePersistedActivityOrigin() {
    const reconstructed = yield* loadedWatchState(database, input.current.canonicalItemId);
    expectActivityOrigin(reconstructed, input.expectedOrigin);
    return yield* commitActivityOrigin(database, {
      canonicalItemId: input.current.canonicalItemId,
      expectedVersion: input.current.version,
      origin: input.nextOrigin,
      positionSeconds: input.positionSeconds,
      sourceId: input.sourceId,
    });
  });

const activityOriginRoundTripCommits = (databaseUrl: string) =>
  Effect.gen(function* commitContractActivityOriginsAcrossDatabaseReconstruction() {
    const initial = yield* useDatabase(
      databaseUrl,
      productionMigrations,
      commitInitialActivityOrigin,
    );
    const watchedStatusAction = yield* useDatabase(databaseUrl, productionMigrations, (database) =>
      replaceActivityOrigin(database, {
        current: initial.state,
        expectedOrigin: NAMA_PLAYBACK_ORIGIN,
        nextOrigin: NAMA_WATCHED_STATUS_ACTION_ORIGIN,
        positionSeconds: WATCHED_STATUS_ACTION_POSITION_SECONDS,
        sourceId: initial.sourceId,
      }),
    );
    return yield* useDatabase(databaseUrl, productionMigrations, (database) =>
      replaceActivityOrigin(database, {
        current: watchedStatusAction,
        expectedOrigin: NAMA_WATCHED_STATUS_ACTION_ORIGIN,
        nextOrigin: PROVIDER_REPLICA_ORIGIN,
        positionSeconds: PROVIDER_REPLICA_POSITION_SECONDS,
        sourceId: initial.sourceId,
      }),
    );
  });

const activityOriginRoundTripScenario = (databaseUrl: string) =>
  Effect.gen(function* roundTripContractActivityOriginsAfterDatabaseReconstruction() {
    yield* initializeWatchStateDatabase(databaseUrl);
    const providerReplica = yield* activityOriginRoundTripCommits(databaseUrl);
    const reconstructed = yield* useDatabase(databaseUrl, productionMigrations, (database) =>
      loadedWatchState(database, providerReplica.canonicalItemId),
    );
    expect(reconstructed.activity.origin).toEqual(PROVIDER_REPLICA_ORIGIN);
  });

it.live("round-trips complete Activity origins after database reconstruction", () =>
  withIsolatedDatabase(activityOriginRoundTripScenario),
);

const confirmEqualTarget = (
  database: DatabaseService,
  initial: CanonicalWatchState,
  sourceId: string,
) =>
  Effect.gen(function* preserveEqualCanonicalWatchState() {
    yield* Effect.sleep("10 millis");
    const target = completeTarget(initial.canonicalItemId, sourceId);
    const equal = yield* database.watchState.compareAndCommit({
      expectedVersion: initial.version,
      target: {
        ...target,
        activity: {
          occurredAt: EQUAL_ACTIVITY_OCCURRED_AT,
          origin: NAMA_PLAYBACK_ORIGIN,
          reliability: "heuristic",
          semantics: "playback_completed",
        },
      },
    });
    expect(equal.status).toBe("committed");
    expect(equal.state).toEqual(initial);
  });

const commitChangedTarget = (
  database: DatabaseService,
  initial: CanonicalWatchState,
  sourceId: string,
) =>
  Effect.gen(function* changeCanonicalWatchState() {
    yield* Effect.sleep("10 millis");
    const result = yield* database.watchState.compareAndCommit({
      expectedVersion: initial.version,
      target: {
        activity: {
          occurredAt: UPDATED_ACTIVITY_OCCURRED_AT,
          origin: NAMA_WATCHED_STATUS_ACTION_ORIGIN,
          reliability: "reliable",
          semantics: "state_changed",
        },
        canonicalItemId: initial.canonicalItemId,
        duration: undefined,
        lastSourceId: sourceId,
        position: undefined,
        principalId: ADMINISTRATOR_ID,
        watched: false,
      },
    });
    const changed = committedState(result);
    expect(changed).toMatchObject({
      activity: {
        occurredAt: UPDATED_ACTIVITY_OCCURRED_AT,
        origin: NAMA_WATCHED_STATUS_ACTION_ORIGIN,
        reliability: "reliable",
        semantics: "state_changed",
      },
      lastSourceId: sourceId,
      version: 2n,
      watched: false,
    });
    expect(changed.position).toBeUndefined();
    expect(changed.duration).toBeUndefined();
    expect(changed.committedAt.getTime()).toBeGreaterThan(initial.committedAt.getTime());
    return changed;
  });

const confirmStaleTarget = (
  database: DatabaseService,
  initial: CanonicalWatchState,
  changed: CanonicalWatchState,
) =>
  Effect.gen(function* preserveCurrentCanonicalWatchState() {
    const sourceId = changed.lastSourceId;
    if (sourceId === undefined) {
      throw new Error("changed canonical Watch state source is missing");
    }
    const target = completeTarget(initial.canonicalItemId, sourceId);
    const stale = yield* database.watchState.compareAndCommit({
      expectedVersion: initial.version,
      target: {
        ...target,
        activity: {
          occurredAt: STALE_ACTIVITY_OCCURRED_AT,
          origin: PROVIDER_REPLICA_ORIGIN,
          reliability: "reliable",
          semantics: "playback_started",
        },
        position: { nanoseconds: ZERO_NANOSECONDS, seconds: 700n },
      },
    });
    expect(stale.status).toBe("stale");
    expect(stale.state).toEqual(changed);
  });

const compareFixture = (database: DatabaseService) =>
  Effect.gen(function* compareVersionedCanonicalWatchState() {
    const { movie, sourceId } = yield* observeMovieWithSource(database);
    const initial = committedState(
      yield* database.watchState.compareAndCommit({
        expectedVersion: undefined,
        target: completeTarget(movie.id, sourceId),
      }),
    );
    yield* confirmEqualTarget(database, initial, sourceId);
    const changed = yield* commitChangedTarget(database, initial, sourceId);
    yield* confirmStaleTarget(database, initial, changed);
    return changed;
  });

const compareScenario = (databaseUrl: string) =>
  Effect.gen(function* compareCanonicalWatchStateAfterReconstruction() {
    yield* initializeWatchStateDatabase(databaseUrl);
    const changed = yield* useDatabase(databaseUrl, productionMigrations, compareFixture);
    const reconstructed = yield* useDatabase(databaseUrl, productionMigrations, (database) =>
      database.watchState.load({
        canonicalItemId: changed.canonicalItemId,
        principalId: ADMINISTRATOR_ID,
      }),
    );
    expect(reconstructed).toEqual(changed);
  });

it.live("commits matching versions and preserves metadata for an equal resolved state", () =>
  withIsolatedDatabase(compareScenario),
);

const expectIndependentStates = (
  states: Readonly<Record<string, CanonicalWatchState | undefined>>,
  movieId: string,
  episodeId: string,
): void => {
  expect(states["administratorMovie"]).toMatchObject({
    canonicalItemId: movieId,
    principalId: ADMINISTRATOR_ID,
    version: 1n,
    watched: true,
  });
  expect(states["administratorEpisode"]).toMatchObject({
    canonicalItemId: episodeId,
    principalId: ADMINISTRATOR_ID,
    version: 1n,
    watched: false,
  });
  expect(states["secondPrincipalMovie"]).toMatchObject({
    canonicalItemId: movieId,
    position: { nanoseconds: ZERO_NANOSECONDS, seconds: 12n },
    principalId: SECOND_PRINCIPAL_ID,
    version: 1n,
    watched: false,
  });
  expect(states["secondPrincipalEpisode"]).toBeUndefined();
};

const loadIndependentStates = (database: DatabaseService, movieId: string, episodeId: string) =>
  Effect.all({
    administratorEpisode: database.watchState.load({
      canonicalItemId: episodeId,
      principalId: ADMINISTRATOR_ID,
    }),
    administratorMovie: database.watchState.load({
      canonicalItemId: movieId,
      principalId: ADMINISTRATOR_ID,
    }),
    secondPrincipalEpisode: database.watchState.load({
      canonicalItemId: episodeId,
      principalId: SECOND_PRINCIPAL_ID,
    }),
    secondPrincipalMovie: database.watchState.load({
      canonicalItemId: movieId,
      principalId: SECOND_PRINCIPAL_ID,
    }),
  });
const independentOwnershipFixture = (databaseUrl: string, database: DatabaseService) =>
  Effect.gen(function* ownCanonicalWatchStateIndependently() {
    const movie = yield* database.catalog.observeItem(movieObservation(PROVIDER_INSTANCE_ID));
    const episode = yield* database.catalog.observeItem(episodeObservation(PROVIDER_INSTANCE_ID));
    yield* withPool(databaseUrl, (pool) =>
      insertFixtureUser(pool, SECOND_PRINCIPAL_ID, "second-principal@example.test"),
    );
    const commits = yield* Effect.all([
      database.watchState.compareAndCommit({
        expectedVersion: undefined,
        target: {
          activity: LOCAL_STATE_ACTIVITY,
          canonicalItemId: movie.id,
          principalId: ADMINISTRATOR_ID,
          watched: true,
        },
      }),
      database.watchState.compareAndCommit({
        expectedVersion: undefined,
        target: {
          activity: PROVIDER_HEURISTIC_ACTIVITY,
          canonicalItemId: episode.id,
          principalId: ADMINISTRATOR_ID,
          watched: false,
        },
      }),
      database.watchState.compareAndCommit({
        expectedVersion: undefined,
        target: {
          activity: PROVIDER_PLAYBACK_ACTIVITY,
          canonicalItemId: movie.id,
          position: { nanoseconds: ZERO_NANOSECONDS, seconds: 12n },
          principalId: SECOND_PRINCIPAL_ID,
          watched: false,
        },
      }),
    ]);
    for (const result of commits) {
      committedState(result);
    }
    const states = yield* loadIndependentStates(database, movie.id, episode.id);
    expectIndependentStates(states, movie.id, episode.id);
  });

const independentOwnershipScenario = (databaseUrl: string) =>
  Effect.gen(function* independentlyOwnedCanonicalWatchState() {
    yield* initializeWatchStateDatabase(databaseUrl);
    yield* useDatabase(databaseUrl, productionMigrations, (database) =>
      independentOwnershipFixture(databaseUrl, database),
    );
  });

it.live("owns sparse canonical Watch state independently by principal and playable item", () =>
  withIsolatedDatabase(independentOwnershipScenario),
);

const nonPlayableTarget = (canonicalItemId: string): CanonicalWatchStateTarget => ({
  activity: {
    occurredAt: ACTIVITY_OCCURRED_AT,
    origin: NAMA_WATCHED_STATUS_ACTION_ORIGIN,
    reliability: "reliable",
    semantics: "state_changed",
  },
  canonicalItemId,
  principalId: ADMINISTRATOR_ID,
  watched: true,
});

const rejectNonPlayableFixture = (database: DatabaseService) =>
  Effect.gen(function* rejectNonPlayableCanonicalWatchState() {
    const show = yield* database.catalog.observeItem(showObservation(PROVIDER_INSTANCE_ID));
    const season = yield* database.catalog.observeItem(seasonObservation(PROVIDER_INSTANCE_ID));
    const failures = yield* Effect.all([
      database.watchState
        .compareAndCommit({ expectedVersion: undefined, target: nonPlayableTarget(show.id) })
        .pipe(Effect.flip),
      database.watchState
        .compareAndCommit({ expectedVersion: undefined, target: nonPlayableTarget(season.id) })
        .pipe(Effect.flip),
    ]);
    expect(failures).toMatchObject([
      { _tag: "WatchStatePersistenceError" },
      { _tag: "WatchStatePersistenceError" },
    ]);
    const states = yield* Effect.all([
      database.watchState.load({
        canonicalItemId: show.id,
        principalId: ADMINISTRATOR_ID,
      }),
      database.watchState.load({
        canonicalItemId: season.id,
        principalId: ADMINISTRATOR_ID,
      }),
    ]);
    expect(states).toEqual([undefined, undefined]);
  });

const rejectNonPlayableScenario = (databaseUrl: string) =>
  Effect.gen(function* rejectNonPlayableCanonicalWatchState() {
    yield* initializeWatchStateDatabase(databaseUrl);
    yield* useDatabase(databaseUrl, productionMigrations, rejectNonPlayableFixture);
  });

it.live("rejects non-playable canonical items without fabricating Watch state", () =>
  withIsolatedDatabase(rejectNonPlayableScenario),
);
