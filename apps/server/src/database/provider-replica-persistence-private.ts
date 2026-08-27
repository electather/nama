import { and, eq, sql } from "drizzle-orm";

import {
  commitLoadedCanonicalWatchState,
  loadCanonicalWatchState,
  nullableWatchDurationColumns,
} from "./canonical-watch-state-persistence-private.ts";
import { canonicalItem, providerItemMapping } from "./catalog-item-schema.ts";
import { providerWatchStateReplica } from "./watch-state-model.ts";
import {
  providerActivityColumns,
  storedProviderReplica,
} from "./watch-state-persistence-private.ts";
import type {
  CanonicalWatchState,
  CompareAndCommitProviderReplicaInput,
  PlayableCanonicalItemKind,
  ProviderReplica,
  ProviderReplicaCommitResult,
  ProviderReplicaKey,
  ProviderReplicaTarget,
  WatchStateDatabase,
  WatchStateReader,
  WatchStateTransaction,
} from "./watch-state-types-private.ts";

const FIRST_ROW = 0;
const SINGLE_ROW_LIMIT = 1;
const SQL_NULL = sql`null`;

const loadProviderReplicaRow = async (
  database: WatchStateReader,
  key: ProviderReplicaKey,
): Promise<typeof providerWatchStateReplica.$inferSelect | undefined> => {
  const rows = await database
    .select()
    .from(providerWatchStateReplica)
    .where(
      and(
        eq(providerWatchStateReplica.principalId, key.principalId),
        eq(providerWatchStateReplica.providerInstanceId, key.providerInstanceId),
        eq(providerWatchStateReplica.providerItemReference, key.providerItemReference),
      ),
    )
    .limit(SINGLE_ROW_LIMIT);
  return rows[FIRST_ROW];
};

const loadProviderReplica = async (
  database: WatchStateReader,
  key: ProviderReplicaKey,
): Promise<ProviderReplica | undefined> => {
  const row = await loadProviderReplicaRow(database, key);
  if (row === undefined) {
    return undefined;
  }
  return storedProviderReplica(row);
};

interface PlayableProviderMapping {
  readonly canonicalItemId: string;
  readonly canonicalItemKind: PlayableCanonicalItemKind;
}

const lockPlayableProviderMapping = async (
  transaction: WatchStateTransaction,
  key: ProviderReplicaKey,
): Promise<PlayableProviderMapping> => {
  const rows = await transaction
    .select({
      canonicalItemId: providerItemMapping.canonicalItemId,
      canonicalItemKind: canonicalItem.kind,
    })
    .from(providerItemMapping)
    .innerJoin(canonicalItem, eq(canonicalItem.id, providerItemMapping.canonicalItemId))
    .where(
      and(
        eq(providerItemMapping.providerInstanceId, key.providerInstanceId),
        eq(providerItemMapping.itemReference, key.providerItemReference),
      ),
    )
    .for("update")
    .limit(SINGLE_ROW_LIMIT);
  const mapping = rows[FIRST_ROW];
  if (
    mapping === undefined ||
    (mapping.canonicalItemKind !== "episode" && mapping.canonicalItemKind !== "movie")
  ) {
    throw new Error("Provider replica mapping is not playable");
  }
  return {
    canonicalItemId: mapping.canonicalItemId,
    canonicalItemKind: mapping.canonicalItemKind,
  };
};

const insertProviderReplica = async (
  transaction: WatchStateTransaction,
  target: ProviderReplicaTarget,
  mapping: PlayableProviderMapping,
): Promise<ProviderReplica> => {
  const rows = await transaction
    .insert(providerWatchStateReplica)
    .values({
      ...providerActivityColumns(target.providerActivity),
      canonicalItemId: mapping.canonicalItemId,
      canonicalItemKind: mapping.canonicalItemKind,
      durationNanoseconds: target.duration?.nanoseconds,
      durationSeconds: target.duration?.seconds,
      observedAt: target.observedAt,
      positionNanoseconds: target.position?.nanoseconds,
      positionSeconds: target.position?.seconds,
      principalId: target.principalId,
      providerInstanceId: target.providerInstanceId,
      providerItemReference: target.providerItemReference,
      providerRevision: target.providerRevision,
      version: 1n,
      watched: target.watched,
    })
    .returning();
  const inserted = rows[FIRST_ROW];
  if (inserted === undefined) {
    throw new Error("Provider replica insert returned no row");
  }
  return storedProviderReplica(inserted);
};

const providerReplicaUpdate = (target: ProviderReplicaTarget) => {
  const duration = nullableWatchDurationColumns(target.duration);
  const position = nullableWatchDurationColumns(target.position);
  return {
    ...providerActivityColumns(target.providerActivity),
    durationNanoseconds: duration.nanoseconds,
    durationSeconds: duration.seconds,
    observedAt: target.observedAt,
    positionNanoseconds: position.nanoseconds,
    positionSeconds: position.seconds,
    providerRevision: target.providerRevision ?? SQL_NULL,
    version: sql`${providerWatchStateReplica.version} + 1`,
    watched: target.watched,
  };
};

const updateProviderReplica = async (
  transaction: WatchStateTransaction,
  current: ProviderReplica,
  target: ProviderReplicaTarget,
): Promise<ProviderReplica> => {
  const rows = await transaction
    .update(providerWatchStateReplica)
    .set(providerReplicaUpdate(target))
    .where(
      and(
        eq(providerWatchStateReplica.principalId, target.principalId),
        eq(providerWatchStateReplica.providerInstanceId, target.providerInstanceId),
        eq(providerWatchStateReplica.providerItemReference, target.providerItemReference),
        eq(providerWatchStateReplica.version, current.version),
      ),
    )
    .returning();
  const updated = rows[FIRST_ROW];
  if (updated === undefined) {
    throw new Error("locked Provider replica update returned no row");
  }
  return storedProviderReplica(updated);
};

interface ReplaceProviderReplicaInput {
  readonly current: ProviderReplica | undefined;
  readonly mapping: PlayableProviderMapping;
  readonly target: ProviderReplicaTarget;
  readonly transaction: WatchStateTransaction;
}

const replaceProviderReplica = ({
  current,
  mapping,
  target,
  transaction,
}: ReplaceProviderReplicaInput): Promise<ProviderReplica> => {
  if (current === undefined) {
    return insertProviderReplica(transaction, target, mapping);
  }
  return updateProviderReplica(transaction, current, target);
};

const validateCanonicalTargetOwnership = (
  input: CompareAndCommitProviderReplicaInput,
  mapping: PlayableProviderMapping,
): void => {
  const target = input.canonicalTarget;
  if (target === undefined) {
    return;
  }
  if (
    target.canonicalItemId !== mapping.canonicalItemId ||
    target.principalId !== input.replicaTarget.principalId
  ) {
    throw new Error("Provider replica canonical target has different ownership");
  }
};

interface LoadedProviderReplicaCommit {
  readonly currentCanonical: CanonicalWatchState | undefined;
  readonly currentReplica: ProviderReplica | undefined;
  readonly mapping: PlayableProviderMapping;
  readonly transaction: WatchStateTransaction;
}

const loadProviderReplicaCommit = async (
  transaction: WatchStateTransaction,
  input: CompareAndCommitProviderReplicaInput,
): Promise<LoadedProviderReplicaCommit> => {
  const mapping = await lockPlayableProviderMapping(transaction, input.replicaTarget);
  validateCanonicalTargetOwnership(input, mapping);
  const currentReplica = await loadProviderReplica(transaction, input.replicaTarget);
  const currentCanonical = await loadCanonicalWatchState(transaction, {
    canonicalItemId: mapping.canonicalItemId,
    principalId: input.replicaTarget.principalId,
  });
  return { currentCanonical, currentReplica, mapping, transaction };
};

const commitCanonicalTarget = async (
  loaded: LoadedProviderReplicaCommit,
  input: CompareAndCommitProviderReplicaInput,
): Promise<CanonicalWatchState | undefined> => {
  if (input.canonicalTarget === undefined) {
    return loaded.currentCanonical;
  }
  const result = await commitLoadedCanonicalWatchState({
    canonicalItemKind: loaded.mapping.canonicalItemKind,
    current: loaded.currentCanonical,
    input: {
      expectedVersion: input.expectedCanonicalVersion,
      target: input.canonicalTarget,
    },
    transaction: loaded.transaction,
  });
  if (result.status !== "committed") {
    throw new Error("locked canonical Watch state commit became stale");
  }
  return result.state;
};

const commitMatchingProviderReplica = async (
  loaded: LoadedProviderReplicaCommit,
  input: CompareAndCommitProviderReplicaInput,
): Promise<ProviderReplicaCommitResult> => {
  const providerReplica = await replaceProviderReplica({
    current: loaded.currentReplica,
    mapping: loaded.mapping,
    target: input.replicaTarget,
    transaction: loaded.transaction,
  });
  const canonicalState = await commitCanonicalTarget(loaded, input);
  return { canonicalState, providerReplica, status: "committed" };
};

const compareAndCommitProviderReplica = (
  database: WatchStateDatabase,
  input: CompareAndCommitProviderReplicaInput,
): Promise<ProviderReplicaCommitResult> =>
  database.transaction(async (transaction) => {
    const loaded = await loadProviderReplicaCommit(transaction, input);
    if (
      loaded.currentReplica?.version !== input.expectedReplicaVersion ||
      loaded.currentCanonical?.version !== input.expectedCanonicalVersion
    ) {
      return {
        canonicalState: loaded.currentCanonical,
        providerReplica: loaded.currentReplica,
        status: "stale",
      };
    }
    return commitMatchingProviderReplica(loaded, input);
  });

export { compareAndCommitProviderReplica, loadProviderReplica };
