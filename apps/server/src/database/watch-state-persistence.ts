import { and, eq, sql } from "drizzle-orm";
import { Effect } from "effect";

import { canonicalItem } from "./catalog-item-schema.ts";
import { providerSourceMapping } from "./catalog-source-schema.ts";
import { canonicalWatchState, watchStatePersistenceFailure } from "./watch-state-model.ts";
import type {
  CanonicalWatchState,
  CanonicalWatchStateCommitResult,
  CanonicalWatchStateKey,
  CanonicalWatchStateTarget,
  CompareAndCommitCanonicalWatchStateInput,
  PlayableCanonicalItemKind,
  WatchDuration,
  WatchStateDatabase,
  WatchStateReader,
  WatchStateTransaction,
} from "./watch-state-model.ts";
import { activityOriginColumns, storedWatchState } from "./watch-state-persistence-private.ts";

const FIRST_ROW = 0;
const SINGLE_ROW_LIMIT = 1;
const SQL_NULL = sql`null`;

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
): Promise<PlayableCanonicalItemKind> => {
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

const validateTargetSourceOwnership = async (
  transaction: WatchStateTransaction,
  target: CanonicalWatchStateTarget,
): Promise<void> => {
  if (target.lastSourceId === undefined) {
    return;
  }
  const rows = await transaction
    .select({ sourceId: providerSourceMapping.sourceId })
    .from(providerSourceMapping)
    .where(
      and(
        eq(providerSourceMapping.sourceId, target.lastSourceId),
        eq(providerSourceMapping.canonicalItemId, target.canonicalItemId),
      ),
    )
    .for("key share")
    .limit(SINGLE_ROW_LIMIT);
  if (rows[FIRST_ROW] === undefined) {
    throw new Error("canonical Watch state Source belongs to another item");
  }
};

const insertCanonicalWatchState = async (
  transaction: WatchStateTransaction,
  target: CanonicalWatchStateTarget,
  canonicalItemKind: PlayableCanonicalItemKind,
): Promise<CanonicalWatchState> => {
  const rows = await transaction
    .insert(canonicalWatchState)
    .values({
      ...activityOriginColumns(target.activity.origin),
      activityOccurredAt: target.activity.occurredAt,
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
  const { activity, duration: targetDuration, position: targetPosition, watched } = target;
  const activityOrigin = activityOriginColumns(activity.origin);
  const duration = nullableDurationColumns(targetDuration);
  const position = nullableDurationColumns(targetPosition);
  return {
    ...activityOrigin,
    activityOccurredAt: activity.occurredAt,
    activityReliability: activity.reliability,
    activitySemantics: activity.semantics,
    committedAt: sql`transaction_timestamp()`,
    durationNanoseconds: duration.nanoseconds,
    durationSeconds: duration.seconds,
    lastSourceId: target.lastSourceId ?? SQL_NULL,
    positionNanoseconds: position.nanoseconds,
    positionSeconds: position.seconds,
    version: sql`${canonicalWatchState.version} + 1`,
    watched,
  };
};

interface CanonicalWatchStateUpdateInput {
  readonly current: CanonicalWatchState;
  readonly target: CanonicalWatchStateTarget;
  readonly transaction: WatchStateTransaction;
}

const updateCanonicalWatchState = async ({
  current,
  target,
  transaction,
}: CanonicalWatchStateUpdateInput): Promise<CanonicalWatchState> => {
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
  canonicalItemKind: PlayableCanonicalItemKind,
): Promise<CanonicalWatchStateCommitResult> => {
  if (input.expectedVersion !== undefined) {
    return { state: undefined, status: "stale" };
  }
  await validateTargetSourceOwnership(transaction, input.target);
  const state = await insertCanonicalWatchState(transaction, input.target, canonicalItemKind);
  return { state, status: "committed" };
};

interface LoadedCanonicalWatchStateCommit {
  readonly canonicalItemKind: PlayableCanonicalItemKind;
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
  await validateTargetSourceOwnership(transaction, input.target);
  if (resolvedStateEquals(current, input.target)) {
    return { state: current, status: "committed" };
  }
  const state = await updateCanonicalWatchState({
    current,
    target: input.target,
    transaction,
  });
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

const makeWatchStatePersistence = (database: WatchStateDatabase) => ({
  compareAndCommit: (input: CompareAndCommitCanonicalWatchStateInput) =>
    Effect.tryPromise({
      catch: watchStatePersistenceFailure,
      try: () => compareAndCommitCanonicalWatchState(database, input),
    }),
  load: (key: CanonicalWatchStateKey) =>
    Effect.tryPromise({
      catch: watchStatePersistenceFailure,
      try: () => loadCanonicalWatchState(database, key),
    }),
});

type WatchStatePersistence = ReturnType<typeof makeWatchStatePersistence>;

export {
  type CanonicalWatchState,
  type CanonicalWatchStateCommitResult,
  type CanonicalWatchStateTarget,
  type WatchStatePersistence,
  makeWatchStatePersistence,
};
