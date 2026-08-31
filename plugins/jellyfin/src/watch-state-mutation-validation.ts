import type { ProviderItemReference } from "@nama/api/nama/plugin/v1/common_pb.js";
import { WatchStateMutationStatus } from "@nama/api/nama/plugin/v1/watch_state_pb.js";
import type { WatchStateMutation } from "@nama/api/nama/plugin/v1/watch_state_pb.js";

import { identifierViolationReason } from "./identifier.ts";
import type { NormalizedWatchState } from "./watch-state-value.ts";

const MAXIMUM_MUTATION_ID_LENGTH = 256;
const MAXIMUM_ITEM_ID_LENGTH = 256;
const NO_OCCURRENCES = 0;
const DUPLICATE_OCCURRENCES = 1;
const INDEX_INCREMENT = 1;
const ZERO_DURATION_SECONDS = 0n;
const ZERO_DURATION_NANOS = 0;
const MAXIMUM_DURATION_SECONDS = 315_576_000_000n;
const MAXIMUM_DURATION_NANOS = 999_999_999;
const NANOSECONDS_PER_JELLYFIN_TICK = 100;

interface NormalizedMutationResult {
  readonly mutationId: string;
  readonly observedState?: NormalizedWatchState;
  readonly status: WatchStateMutationStatus;
}
interface MutationConflictCounts {
  readonly itemIds: Map<string, number>;
  readonly mutationIds: Map<string, number>;
}
interface PendingWatchedMutation {
  readonly index: number;
  readonly itemReference: ProviderItemReference;
  readonly mutation: WatchStateMutation;
  readonly watched: boolean;
}
interface PendingProgressMutation {
  readonly duration?: Readonly<{ nanos: number; seconds: bigint }> | undefined;
  readonly index: number;
  readonly itemReference: ProviderItemReference;
  readonly mutation: WatchStateMutation;
  readonly position: Readonly<{ nanos: number; seconds: bigint }>;
  readonly watched: boolean;
}
interface MutationClassification {
  readonly progressMutations: PendingProgressMutation[];
  readonly resultsByIndex: Map<number, NormalizedMutationResult>;
  readonly watchedMutations: PendingWatchedMutation[];
}
interface MutableMutationClassification extends MutationClassification {
  readonly counts: MutationConflictCounts;
}

const identifierIsValid = (value: string, maximumLength: number): boolean =>
  identifierViolationReason(value, maximumLength) === false;

const incrementCount = (counts: Map<string, number>, value: string): void => {
  counts.set(value, (counts.get(value) ?? NO_OCCURRENCES) + INDEX_INCREMENT);
};

const mutationConflictCounts = (
  mutations: readonly WatchStateMutation[],
): MutationConflictCounts => {
  const itemIds = new Map<string, number>();
  const mutationIds = new Map<string, number>();
  for (const mutation of mutations) {
    if (identifierIsValid(mutation.mutationId, MAXIMUM_MUTATION_ID_LENGTH)) {
      incrementCount(mutationIds, mutation.mutationId);
    }
    const itemId = mutation.itemReference?.itemId;
    if (itemId !== undefined && identifierIsValid(itemId, MAXIMUM_ITEM_ID_LENGTH)) {
      incrementCount(itemIds, itemId);
    }
  }
  return { itemIds, mutationIds };
};

const durationIsValidTarget = (
  duration: Readonly<{ nanos: number; seconds: bigint }> | undefined,
): boolean => {
  if (duration === undefined) {
    return false;
  }
  if (
    duration.seconds < ZERO_DURATION_SECONDS ||
    duration.seconds > MAXIMUM_DURATION_SECONDS ||
    !Number.isInteger(duration.nanos) ||
    duration.nanos < ZERO_DURATION_NANOS ||
    duration.nanos > MAXIMUM_DURATION_NANOS
  ) {
    return false;
  }
  return (
    (duration.seconds !== MAXIMUM_DURATION_SECONDS || duration.nanos === ZERO_DURATION_NANOS) &&
    duration.nanos % NANOSECONDS_PER_JELLYFIN_TICK === ZERO_DURATION_NANOS
  );
};

const progressTargetIsValid = (mutation: WatchStateMutation): boolean => {
  if (mutation.target.case !== "setProgress") {
    return true;
  }
  const { duration, position } = mutation.target.value;
  return (
    durationIsValidTarget(position) && (duration === undefined || durationIsValidTarget(duration))
  );
};

const mutationIsInvalid = (
  mutation: WatchStateMutation,
  counts: MutationConflictCounts,
): boolean => {
  const itemId = mutation.itemReference?.itemId;
  if (
    !identifierIsValid(mutation.mutationId, MAXIMUM_MUTATION_ID_LENGTH) ||
    itemId === undefined ||
    !identifierIsValid(itemId, MAXIMUM_ITEM_ID_LENGTH) ||
    (mutation.target.case !== "setWatched" && mutation.target.case !== "setProgress") ||
    !progressTargetIsValid(mutation)
  ) {
    return true;
  }
  const mutationIdOccurrences = counts.mutationIds.get(mutation.mutationId) ?? NO_OCCURRENCES;
  const itemIdOccurrences = counts.itemIds.get(itemId) ?? NO_OCCURRENCES;
  return mutationIdOccurrences > DUPLICATE_OCCURRENCES || itemIdOccurrences > DUPLICATE_OCCURRENCES;
};

const mutationResult = (
  mutation: WatchStateMutation,
  status: WatchStateMutationStatus,
  observedState?: NormalizedWatchState,
): NormalizedMutationResult => {
  if (observedState === undefined) {
    return { mutationId: mutation.mutationId, status };
  }
  return { mutationId: mutation.mutationId, observedState, status };
};

const addWatchedMutation = (
  mutation: WatchStateMutation,
  index: number,
  classification: MutableMutationClassification,
): void => {
  const { itemReference, target } = mutation;
  if (itemReference === undefined || target.case !== "setWatched") {
    classification.resultsByIndex.set(
      index,
      mutationResult(mutation, WatchStateMutationStatus.INVALID),
    );
    return;
  }
  classification.watchedMutations.push({
    index,
    itemReference,
    mutation,
    watched: target.value.watched,
  });
};
const addProgressMutation = (
  mutation: WatchStateMutation,
  index: number,
  classification: MutableMutationClassification,
): void => {
  const { itemReference, target } = mutation;
  if (
    itemReference === undefined ||
    target.case !== "setProgress" ||
    target.value.position === undefined
  ) {
    classification.resultsByIndex.set(
      index,
      mutationResult(mutation, WatchStateMutationStatus.INVALID),
    );
    return;
  }
  classification.progressMutations.push({
    duration: target.value.duration,
    index,
    itemReference,
    mutation,
    position: target.value.position,
    watched: target.value.watched,
  });
};

const classifyMutation = (
  mutation: WatchStateMutation,
  index: number,
  classification: MutableMutationClassification,
): void => {
  if (mutationIsInvalid(mutation, classification.counts)) {
    classification.resultsByIndex.set(
      index,
      mutationResult(mutation, WatchStateMutationStatus.INVALID),
    );
    return;
  }
  if (mutation.target.case === "setProgress") {
    addProgressMutation(mutation, index, classification);
    return;
  }
  addWatchedMutation(mutation, index, classification);
};

const classifyMutations = (mutations: readonly WatchStateMutation[]): MutationClassification => {
  const classification: MutableMutationClassification = {
    counts: mutationConflictCounts(mutations),
    progressMutations: [],
    resultsByIndex: new Map(),
    watchedMutations: [],
  };
  for (const [index, mutation] of mutations.entries()) {
    classifyMutation(mutation, index, classification);
  }
  return classification;
};

export { classifyMutations, mutationResult };
export type { NormalizedMutationResult, PendingProgressMutation, PendingWatchedMutation };
