import { Effect } from "effect";

import {
  compareAndCommitCanonicalWatchState,
  loadCanonicalWatchState,
} from "./canonical-watch-state-persistence-private.ts";
import {
  compareAndCommitProviderReplica,
  loadProviderReplica,
} from "./provider-replica-persistence-private.ts";
import { watchStatePersistenceFailure } from "./watch-state-types-private.ts";
import type {
  CanonicalWatchState,
  CanonicalWatchStateCommitResult,
  CanonicalWatchStateKey,
  CanonicalWatchStateTarget,
  CompareAndCommitCanonicalWatchStateInput,
  CompareAndCommitProviderReplicaInput,
  ProviderReplica,
  ProviderReplicaCommitResult,
  ProviderReplicaKey,
  ProviderReplicaTarget,
  WatchStateDatabase,
  WatchStatePersistenceFailure,
} from "./watch-state-types-private.ts";

type WatchStatePersistence = Readonly<{
  compareAndCommitCanonicalWatchState: (
    input: CompareAndCommitCanonicalWatchStateInput,
  ) => Effect.Effect<CanonicalWatchStateCommitResult, WatchStatePersistenceFailure>;
  compareAndCommitProviderReplica: (
    input: CompareAndCommitProviderReplicaInput,
  ) => Effect.Effect<ProviderReplicaCommitResult, WatchStatePersistenceFailure>;
  loadCanonicalWatchState: (
    key: CanonicalWatchStateKey,
  ) => Effect.Effect<CanonicalWatchState | undefined, WatchStatePersistenceFailure>;
  loadProviderReplica: (
    key: ProviderReplicaKey,
  ) => Effect.Effect<ProviderReplica | undefined, WatchStatePersistenceFailure>;
}>;

const makeWatchStatePersistence = (database: WatchStateDatabase): WatchStatePersistence => ({
  compareAndCommitCanonicalWatchState: (input: CompareAndCommitCanonicalWatchStateInput) =>
    Effect.tryPromise({
      catch: watchStatePersistenceFailure,
      try: () => compareAndCommitCanonicalWatchState(database, input),
    }),
  compareAndCommitProviderReplica: (input: CompareAndCommitProviderReplicaInput) =>
    Effect.tryPromise({
      catch: watchStatePersistenceFailure,
      try: () => compareAndCommitProviderReplica(database, input),
    }),
  loadCanonicalWatchState: (key: CanonicalWatchStateKey) =>
    Effect.tryPromise({
      catch: watchStatePersistenceFailure,
      try: () => loadCanonicalWatchState(database, key),
    }),
  loadProviderReplica: (key: ProviderReplicaKey) =>
    Effect.tryPromise({
      catch: watchStatePersistenceFailure,
      try: () => loadProviderReplica(database, key),
    }),
});

export {
  type CanonicalWatchState,
  type CanonicalWatchStateCommitResult,
  type CanonicalWatchStateTarget,
  type ProviderReplicaCommitResult,
  type ProviderReplicaTarget,
  type WatchStatePersistence,
  makeWatchStatePersistence,
};
