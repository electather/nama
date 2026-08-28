import { expect, it } from "@effect/vitest";
import { Effect } from "effect";

import type { Database } from "../../src/database/database.ts";
import type {
  CanonicalWatchStateTarget,
  ProviderReplicaCommitResult,
  ProviderReplicaTarget,
} from "../../src/database/watch-state-persistence.ts";
import {
  ADMINISTRATOR_ID,
  initializeCatalogDatabase,
  movieObservation,
} from "./catalog-persistence.test-support.ts";
import { productionMigrations, useDatabase } from "./database.test-support.ts";
import { withIsolatedDatabase } from "./postgres.test-support.ts";

const PROVIDER_INSTANCE_ID = "provider-replica-provider";
const PROVIDER_ITEM_REFERENCE = "provider-replica-item";
const OBSERVED_AT = new Date("2026-08-27T18:19:20.123Z");
const PROVIDER_ACTIVITY_OCCURRED_AT = new Date("2026-08-27T18:18:19.012Z");
const CANONICAL_ACTIVITY_OCCURRED_AT = new Date("2026-08-27T18:20:21.234Z");
const LATER_OBSERVED_AT = new Date("2026-08-27T19:20:21.234Z");
const PROVIDER_REVISION = "opaque/provider/revision";
const SECOND_PROVIDER_REPLICA_VERSION = 2n;
const THIRD_PROVIDER_REPLICA_VERSION = 3n;

type DatabaseService = Database["Service"];
type CommittedProviderReplicaResult = Extract<
  ProviderReplicaCommitResult,
  { readonly status: "committed" }
>;

interface AcceptedProviderSnapshots {
  readonly accepted: CommittedProviderReplicaResult;
  readonly movieId: string;
}

interface AtomicProviderSnapshots extends AcceptedProviderSnapshots {
  readonly replicaOnly: CommittedProviderReplicaResult;
}

const initializeProviderReplicaDatabase = (databaseUrl: string) =>
  initializeCatalogDatabase(databaseUrl, [{ id: PROVIDER_INSTANCE_ID, priority: 1 }], true);

const observeMappedMovie = (database: DatabaseService) =>
  database.catalog.observeItem(
    movieObservation(PROVIDER_INSTANCE_ID, { itemReference: PROVIDER_ITEM_REFERENCE }),
  );

const completeReplicaTarget = (watched = true): ProviderReplicaTarget => ({
  duration: { nanoseconds: 987_654_321, seconds: 7200n },
  observedAt: OBSERVED_AT,
  position: { nanoseconds: 123_456_789, seconds: 321n },
  principalId: ADMINISTRATOR_ID,
  providerActivity: {
    occurredAt: PROVIDER_ACTIVITY_OCCURRED_AT,
    reliability: "heuristic",
    semantics: "playback_started",
  },
  providerInstanceId: PROVIDER_INSTANCE_ID,
  providerItemReference: PROVIDER_ITEM_REFERENCE,
  providerRevision: PROVIDER_REVISION,
  watched,
});

const canonicalTarget = (canonicalItemId: string, watched = true): CanonicalWatchStateTarget => ({
  activity: {
    occurredAt: CANONICAL_ACTIVITY_OCCURRED_AT,
    origin: {
      kind: "provider_replica",
      providerInstanceId: PROVIDER_INSTANCE_ID,
      providerItemReference: PROVIDER_ITEM_REFERENCE,
    },
    reliability: "heuristic",
    semantics: "playback_started",
  },
  canonicalItemId,
  duration: { nanoseconds: 987_654_321, seconds: 7200n },
  position: { nanoseconds: 123_456_789, seconds: 321n },
  principalId: ADMINISTRATOR_ID,
  watched,
});

const committedResult = (result: ProviderReplicaCommitResult) => {
  expect(result.status).toBe("committed");
  if (result.status !== "committed") {
    throw new Error("Provider replica commit was stale");
  }
  return result;
};

const roundTripScenario = (databaseUrl: string) =>
  Effect.gen(function* roundTripProviderReplica() {
    yield* initializeProviderReplicaDatabase(databaseUrl);
    const committed = yield* useDatabase(databaseUrl, productionMigrations, (database) =>
      Effect.gen(function* commitProviderReplica() {
        const movie = yield* observeMappedMovie(database);
        const persistence = database.watchState;
        const result = committedResult(
          yield* persistence.compareAndCommitProviderReplica({
            expectedCanonicalVersion: undefined,
            expectedReplicaVersion: undefined,
            replicaTarget: completeReplicaTarget(),
          }),
        );
        expect(result.canonicalState).toBeUndefined();
        expect(result.providerReplica).toEqual({
          ...completeReplicaTarget(),
          canonicalItemId: movie.id,
          version: 1n,
        });
        return result.providerReplica;
      }),
    );
    const reconstructed = yield* useDatabase(databaseUrl, productionMigrations, (database) =>
      database.watchState.loadProviderReplica(committed),
    );
    expect(reconstructed).toEqual(committed);
  });

it.live("round-trips a complete Provider replica after database reconstruction", () =>
  withIsolatedDatabase(roundTripScenario),
);

const defaultUnwatchedScenario = (databaseUrl: string) =>
  Effect.gen(function* persistDefaultUnwatchedProviderReplica() {
    yield* initializeProviderReplicaDatabase(databaseUrl);
    yield* useDatabase(databaseUrl, productionMigrations, (database) =>
      Effect.gen(function* commitOnlyProviderReplica() {
        const movie = yield* observeMappedMovie(database);
        const persistence = database.watchState;
        const replicaTarget: ProviderReplicaTarget = {
          observedAt: OBSERVED_AT,
          principalId: ADMINISTRATOR_ID,
          providerInstanceId: PROVIDER_INSTANCE_ID,
          providerItemReference: PROVIDER_ITEM_REFERENCE,
          watched: false,
        };
        const result = committedResult(
          yield* persistence.compareAndCommitProviderReplica({
            expectedCanonicalVersion: undefined,
            expectedReplicaVersion: undefined,
            replicaTarget,
          }),
        );
        expect(result.providerReplica).toEqual({
          ...replicaTarget,
          canonicalItemId: movie.id,
          version: 1n,
        });
        expect(result.canonicalState).toBeUndefined();
        const canonical = yield* database.watchState.loadCanonicalWatchState({
          canonicalItemId: movie.id,
          principalId: ADMINISTRATOR_ID,
        });
        expect(canonical).toBeUndefined();
      }),
    );
  });

it.live("stores a first default-unwatched Provider replica without canonical Watch state", () =>
  withIsolatedDatabase(defaultUnwatchedScenario),
);

const commitAcceptedProviderSnapshots = (database: DatabaseService) =>
  Effect.gen(function* commitProviderReplicaWithCanonicalTarget() {
    const movie = yield* observeMappedMovie(database);
    const first = committedResult(
      yield* database.watchState.compareAndCommitProviderReplica({
        expectedCanonicalVersion: undefined,
        expectedReplicaVersion: undefined,
        replicaTarget: completeReplicaTarget(false),
      }),
    );
    const accepted = committedResult(
      yield* database.watchState.compareAndCommitProviderReplica({
        canonicalTarget: canonicalTarget(movie.id),
        expectedCanonicalVersion: undefined,
        expectedReplicaVersion: first.providerReplica.version,
        replicaTarget: completeReplicaTarget(),
      }),
    );
    expect(accepted.providerReplica.version).toBe(SECOND_PROVIDER_REPLICA_VERSION);
    expect(accepted.providerReplica.providerRevision).toBe(PROVIDER_REVISION);
    expect(accepted.canonicalState).toMatchObject({ version: 1n, watched: true });
    return { accepted, movieId: movie.id };
  });

const commitReplicaOnlySnapshot = (
  database: DatabaseService,
  snapshots: AcceptedProviderSnapshots,
) =>
  Effect.gen(function* replaceOnlyProviderReplica() {
    const replicaOnly = committedResult(
      yield* database.watchState.compareAndCommitProviderReplica({
        expectedCanonicalVersion: snapshots.accepted.canonicalState?.version,
        expectedReplicaVersion: snapshots.accepted.providerReplica.version,
        replicaTarget: {
          ...completeReplicaTarget(),
          observedAt: LATER_OBSERVED_AT,
        },
      }),
    );
    expect(replicaOnly.providerReplica).toMatchObject({
      observedAt: LATER_OBSERVED_AT,
      providerRevision: PROVIDER_REVISION,
      version: THIRD_PROVIDER_REPLICA_VERSION,
    });
    expect(replicaOnly.canonicalState).toEqual(snapshots.accepted.canonicalState);
    return { ...snapshots, replicaOnly };
  });

const confirmStaleReplicaExpectation = (
  database: DatabaseService,
  snapshots: AtomicProviderSnapshots,
) =>
  Effect.gen(function* preserveSnapshotsForStaleReplicaVersion() {
    const stale = yield* database.watchState.compareAndCommitProviderReplica({
      canonicalTarget: canonicalTarget(snapshots.movieId, false),
      expectedCanonicalVersion: snapshots.accepted.canonicalState?.version,
      expectedReplicaVersion: snapshots.accepted.providerReplica.version,
      replicaTarget: { ...completeReplicaTarget(false), observedAt: LATER_OBSERVED_AT },
    });
    expect(stale).toEqual({
      canonicalState: snapshots.accepted.canonicalState,
      providerReplica: snapshots.replicaOnly.providerReplica,
      status: "stale",
    });
    expect(
      yield* database.watchState.loadProviderReplica(snapshots.replicaOnly.providerReplica),
    ).toEqual(snapshots.replicaOnly.providerReplica);
    expect(
      yield* database.watchState.loadCanonicalWatchState({
        canonicalItemId: snapshots.movieId,
        principalId: ADMINISTRATOR_ID,
      }),
    ).toEqual(snapshots.accepted.canonicalState);
  });

const confirmStaleCanonicalExpectation = (
  database: DatabaseService,
  snapshots: AtomicProviderSnapshots,
) =>
  Effect.gen(function* preserveReplicaForStaleCanonicalVersion() {
    const changedCanonical = yield* database.watchState.compareAndCommitCanonicalWatchState({
      expectedVersion: snapshots.accepted.canonicalState?.version,
      target: canonicalTarget(snapshots.movieId, false),
    });
    expect(changedCanonical.status).toBe("committed");
    const stale = yield* database.watchState.compareAndCommitProviderReplica({
      expectedCanonicalVersion: snapshots.accepted.canonicalState?.version,
      expectedReplicaVersion: snapshots.replicaOnly.providerReplica.version,
      replicaTarget: { ...completeReplicaTarget(false), observedAt: LATER_OBSERVED_AT },
    });
    expect(stale).toEqual({
      canonicalState: changedCanonical.state,
      providerReplica: snapshots.replicaOnly.providerReplica,
      status: "stale",
    });
    expect(
      yield* database.watchState.loadProviderReplica(snapshots.replicaOnly.providerReplica),
    ).toEqual(snapshots.replicaOnly.providerReplica);
  });

const atomicCompareFixture = (database: DatabaseService) =>
  Effect.gen(function* compareProviderReplicaAndCanonicalVersions() {
    const accepted = yield* commitAcceptedProviderSnapshots(database);
    const snapshots = yield* commitReplicaOnlySnapshot(database, accepted);
    yield* confirmStaleReplicaExpectation(database, snapshots);
    yield* confirmStaleCanonicalExpectation(database, snapshots);
  });

const atomicCompareScenario = (databaseUrl: string) =>
  Effect.gen(function* persistProviderReplicaAtomically() {
    yield* initializeProviderReplicaDatabase(databaseUrl);
    yield* useDatabase(databaseUrl, productionMigrations, atomicCompareFixture);
  });

it.live("atomically commits matching versions and returns both current snapshots when stale", () =>
  withIsolatedDatabase(atomicCompareScenario),
);
