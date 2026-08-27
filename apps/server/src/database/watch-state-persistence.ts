import { and, eq, sql } from "drizzle-orm";
import { Effect } from "effect";

import { canonicalItem } from "./catalog-item-schema.ts";
import { canonicalWatchState, watchStatePersistenceFailure } from "./watch-state-model.ts";
import type {
  CanonicalWatchState,
  CanonicalWatchStateCommitResult,
  CanonicalWatchStateKey,
  CanonicalWatchStateTarget,
  CompareAndCommitCanonicalWatchStateInput,
  WatchDuration,
  WatchStateDatabase,
  WatchStatePersistenceFailure,
  WatchStateReader,
  WatchStateTransaction,
} from "./watch-state-model.ts";

const FIRST_ROW = 0;
const SINGLE_ROW_LIMIT = 1;
const SQL_NULL = sql`null`;

const storedDuration = (
  seconds: bigint | null,
  nanoseconds: number | null,
): WatchDuration | undefined => {
  if (seconds === null) {
    if (nanoseconds !== null) {
      throw new Error("stored Watch duration has nanoseconds without seconds");
    }
    return undefined;
  }
  if (nanoseconds === null) {
    throw new Error("stored Watch duration has seconds without nanoseconds");
  }
  return { nanoseconds, seconds };
};

const storedWatchState = (row: typeof canonicalWatchState.$inferSelect): CanonicalWatchState => ({
  activity: {
    occurredAt: row.activityOccurredAt,
    origin: row.activityOrigin,
    reliability: row.activityReliability,
    semantics: row.activitySemantics,
  },
  canonicalItemId: row.canonicalItemId,
  committedAt: row.committedAt,
  duration: storedDuration(row.durationSeconds, row.durationNanoseconds),
  lastSourceId: row.lastSourceId ?? undefined,
  position: storedDuration(row.positionSeconds, row.positionNanoseconds),
  principalId: row.principalId,
  version: row.version,
  watched: row.watched,
});

const optionalDurationEquals = (
  stored: WatchDuration | undefined,
  target: WatchDuration | undefined,
): boolean => {
  if (stored === undefined || target === undefined) {
    return stored === target;
  }
  return stored.nanoseconds === target.nanoseconds && stored.seconds === target.seconds;
};

const resolvedStateEquals = (
  current: CanonicalWatchState,
  target: CanonicalWatchStateTarget,
): boolean =>
  current.watched === target.watched &&
  optionalDurationEquals(current.position, target.position) &&
  optionalDurationEquals(current.duration, target.duration) &&
  current.lastSourceId === target.lastSourceId;

const loadWatchStateRow = async (
  database: WatchStateReader,
  key: CanonicalWatchStateKey,
): Promise<typeof canonicalWatchState.$inferSelect | undefined> => {
  const rows = await database
    .select()
    .from(canonicalWatchState)
    .where(
      and(
        eq(canonicalWatchState.principalId, key.principalId),
        eq(canonicalWatchState.canonicalItemId, key.canonicalItemId),
      ),
    )
    .limit(SINGLE_ROW_LIMIT);
  return rows[FIRST_ROW];
};

const loadCanonicalWatchState = async (
  database: WatchStateReader,
  key: CanonicalWatchStateKey,
): Promise<CanonicalWatchState | undefined> => {
  const row = await loadWatchStateRow(database, key);
  if (row === undefined) {
    return undefined;
  }
  return storedWatchState(row);
};

const lockPlayableCanonicalItem = async (
  transaction: WatchStateTransaction,
  canonicalItemId: string,
): Promise<"episode" | "movie"> => {
  const rows = await transaction
    .select({ kind: canonicalItem.kind })
    .from(canonicalItem)
    .where(eq(canonicalItem.id, canonicalItemId))
    .for("update")
    .limit(SINGLE_ROW_LIMIT);
  const kind = rows[FIRST_ROW]?.kind;
  if (kind !== "episode" && kind !== "movie") {
    throw new Error("canonical Watch state target is not playable");
  }
  return kind;
};

const insertCanonicalWatchState = async (
  transaction: WatchStateTransaction,
  target: CanonicalWatchStateTarget,
  canonicalItemKind: "episode" | "movie",
): Promise<CanonicalWatchState> => {
  const rows = await transaction
    .insert(canonicalWatchState)
    .values({
      activityOccurredAt: target.activity.occurredAt,
      activityOrigin: target.activity.origin,
      activityReliability: target.activity.reliability,
      activitySemantics: target.activity.semantics,
      canonicalItemId: target.canonicalItemId,
      canonicalItemKind,
      committedAt: sql`transaction_timestamp()`,
      durationNanoseconds: target.duration?.nanoseconds,
      durationSeconds: target.duration?.seconds,
      lastSourceId: target.lastSourceId,
      positionNanoseconds: target.position?.nanoseconds,
      positionSeconds: target.position?.seconds,
      principalId: target.principalId,
      version: 1n,
      watched: target.watched,
    })
    .returning();
  const inserted = rows[FIRST_ROW];
  if (inserted === undefined) {
    throw new Error("canonical Watch state insert returned no row");
  }
  return storedWatchState(inserted);
};

const nullableDurationColumns = (duration: WatchDuration | undefined) => {
  if (duration === undefined) {
    return { nanoseconds: SQL_NULL, seconds: SQL_NULL };
  }
  return duration;
};

const canonicalWatchStateUpdate = (target: CanonicalWatchStateTarget) => {
  const {
    activity,
    duration: targetDuration,
    lastSourceId: targetLastSourceId,
    position: targetPosition,
    watched,
  } = target;
  const duration = nullableDurationColumns(targetDuration);
  const position = nullableDurationColumns(targetPosition);
  let lastSourceId: string | typeof SQL_NULL = SQL_NULL;
  if (targetLastSourceId !== undefined) {
    lastSourceId = targetLastSourceId;
  }
  return {
    activityOccurredAt: activity.occurredAt,
    activityOrigin: activity.origin,
    activityReliability: activity.reliability,
    activitySemantics: activity.semantics,
    committedAt: sql`transaction_timestamp()`,
    durationNanoseconds: duration.nanoseconds,
    durationSeconds: duration.seconds,
    lastSourceId,
    positionNanoseconds: position.nanoseconds,
    positionSeconds: position.seconds,
    version: sql`${canonicalWatchState.version} + 1`,
    watched,
  };
};

const updateCanonicalWatchState = async (
  transaction: WatchStateTransaction,
  current: CanonicalWatchState,
  target: CanonicalWatchStateTarget,
): Promise<CanonicalWatchState> => {
  const rows = await transaction
    .update(canonicalWatchState)
    .set(canonicalWatchStateUpdate(target))
    .where(
      and(
        eq(canonicalWatchState.principalId, target.principalId),
        eq(canonicalWatchState.canonicalItemId, target.canonicalItemId),
        eq(canonicalWatchState.version, current.version),
      ),
    )
    .returning();
  const updated = rows[FIRST_ROW];
  if (updated === undefined) {
    throw new Error("locked canonical Watch state update returned no row");
  }
  return storedWatchState(updated);
};

const commitAbsentCanonicalWatchState = async (
  transaction: WatchStateTransaction,
  input: CompareAndCommitCanonicalWatchStateInput,
  canonicalItemKind: "episode" | "movie",
): Promise<CanonicalWatchStateCommitResult> => {
  if (input.expectedVersion !== undefined) {
    return { state: undefined, status: "stale" };
  }
  const state = await insertCanonicalWatchState(transaction, input.target, canonicalItemKind);
  return { state, status: "committed" };
};

interface LoadedCanonicalWatchStateCommit {
  readonly canonicalItemKind: "episode" | "movie";
  readonly current: CanonicalWatchState | undefined;
  readonly input: CompareAndCommitCanonicalWatchStateInput;
  readonly transaction: WatchStateTransaction;
}

const commitLoadedCanonicalWatchState = async ({
  canonicalItemKind,
  current,
  input,
  transaction,
}: LoadedCanonicalWatchStateCommit): Promise<CanonicalWatchStateCommitResult> => {
  if (current === undefined) {
    return commitAbsentCanonicalWatchState(transaction, input, canonicalItemKind);
  }
  if (current.version !== input.expectedVersion) {
    return { state: current, status: "stale" };
  }
  if (resolvedStateEquals(current, input.target)) {
    return { state: current, status: "committed" };
  }
  const state = await updateCanonicalWatchState(transaction, current, input.target);
  return { state, status: "committed" };
};

const compareAndCommitCanonicalWatchState = (
  database: WatchStateDatabase,
  input: CompareAndCommitCanonicalWatchStateInput,
): Promise<CanonicalWatchStateCommitResult> =>
  database.transaction(async (transaction) => {
    const canonicalItemKind = await lockPlayableCanonicalItem(
      transaction,
      input.target.canonicalItemId,
    );
    const current = await loadCanonicalWatchState(transaction, input.target);
    return commitLoadedCanonicalWatchState({
      canonicalItemKind,
      current,
      input,
      transaction,
    });
  });

interface WatchStatePersistence {
  readonly compareAndCommit: (
    input: CompareAndCommitCanonicalWatchStateInput,
  ) => Effect.Effect<CanonicalWatchStateCommitResult, WatchStatePersistenceFailure>;
  readonly load: (
    key: CanonicalWatchStateKey,
  ) => Effect.Effect<CanonicalWatchState | undefined, WatchStatePersistenceFailure>;
}

const makeWatchStatePersistence = (database: WatchStateDatabase): WatchStatePersistence => ({
  compareAndCommit: (input) =>
    Effect.tryPromise({
      catch: watchStatePersistenceFailure,
      try: () => compareAndCommitCanonicalWatchState(database, input),
    }),
  load: (key) =>
    Effect.tryPromise({
      catch: watchStatePersistenceFailure,
      try: () => loadCanonicalWatchState(database, key),
    }),
});

export {
  type CanonicalWatchState,
  type CanonicalWatchStateCommitResult,
  type CanonicalWatchStateKey,
  type CanonicalWatchStateTarget,
  type CompareAndCommitCanonicalWatchStateInput,
  type WatchStatePersistence,
  type WatchStatePersistenceFailure,
  makeWatchStatePersistence,
};
