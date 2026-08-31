import {
  WatchStateMutationStatus,
  WatchStateReadStatus,
} from "@nama/api/nama/plugin/v1/watch_state_pb.js";
import type { WatchStateMutation } from "@nama/api/nama/plugin/v1/watch_state_pb.js";

import { forEachBounded } from "./bounded-concurrency.ts";
import { jellyfinFailureCategory } from "./request-failure.ts";
import type { JellyfinFailureKind } from "./request-failure.ts";
import { createJellyfinRequest } from "./request.ts";
import type { JellyfinMutationResponse } from "./request.ts";
import {
  boundedProviderResponseSignal,
  readBackAmbiguousMutation,
} from "./watch-state-mutation-execution.ts";
import type { MutationExecution } from "./watch-state-mutation-execution.ts";
import { classifyMutations, mutationResult } from "./watch-state-mutation-validation.ts";
import type {
  NormalizedMutationResult,
  PendingWatchedMutation,
} from "./watch-state-mutation-validation.ts";
import { executeProgressMutations } from "./watch-state-progress-mutation.ts";
import {
  ABSENT_VALUE,
  normalizeJellyfinMutationWatchState,
  timestampFromMilliseconds,
} from "./watch-state-value.ts";
import { WATCH_STATE_STATUSES_BY_FAILURE_CATEGORY, getJellyfinWatchStates } from "./watch-state.ts";
import type { JellyfinWatchStateContext, NormalizedReadResult } from "./watch-state.ts";

const MAXIMUM_MEDIA_RESPONSE_BYTES = 16_777_216;
const MAXIMUM_CONCURRENT_MUTATIONS = 4;

interface JellyfinWatchStateMutationCall {
  readonly context: JellyfinWatchStateContext;
  readonly mutations: readonly WatchStateMutation[];
  readonly signal: AbortSignal;
  readonly timeoutMs: () => number | undefined;
}
interface CurrentStateClassification {
  readonly pendingMutations: PendingWatchedMutation[];
  readonly resultsByIndex: Map<number, NormalizedMutationResult>;
}

const mutationStatusForRead = (result: NormalizedReadResult): WatchStateMutationStatus => {
  if (result.status === WatchStateReadStatus.NOT_FOUND) {
    return WatchStateMutationStatus.NOT_FOUND;
  }
  if (result.status === WatchStateReadStatus.FORBIDDEN) {
    return WatchStateMutationStatus.FORBIDDEN;
  }
  if (result.status === WatchStateReadStatus.RETRYABLE_FAILURE) {
    return WatchStateMutationStatus.RETRYABLE_FAILURE;
  }
  return WatchStateMutationStatus.PERMANENT_FAILURE;
};

const failedMutationResponseResult = (
  pending: PendingWatchedMutation,
  kind: JellyfinFailureKind,
): Promise<NormalizedMutationResult> => {
  const status = WATCH_STATE_STATUSES_BY_FAILURE_CATEGORY[jellyfinFailureCategory(kind)].mutation;
  return Promise.resolve(mutationResult(pending.mutation, status));
};

const mutationResponseResult = (
  execution: MutationExecution,
  pending: PendingWatchedMutation,
  response: JellyfinMutationResponse,
): Promise<NormalizedMutationResult> => {
  if (response.kind === "ambiguous") {
    return readBackAmbiguousMutation(
      execution,
      pending,
      (state) => state.watched === pending.watched,
    );
  }
  if (response.kind !== "success") {
    return failedMutationResponseResult(pending, response.kind);
  }
  const observedState = normalizeJellyfinMutationWatchState(
    pending.itemReference,
    response.body,
    timestampFromMilliseconds(Date.now()),
  );
  if (observedState === ABSENT_VALUE) {
    return readBackAmbiguousMutation(
      execution,
      pending,
      (state) => state.watched === pending.watched,
    );
  }
  if (observedState.watched === pending.watched) {
    return Promise.resolve(
      mutationResult(pending.mutation, WatchStateMutationStatus.APPLIED, observedState),
    );
  }
  return Promise.resolve(
    mutationResult(pending.mutation, WatchStateMutationStatus.RETRYABLE_AMBIGUOUS, observedState),
  );
};

const applyWatchedMutation = async (
  execution: MutationExecution,
  pending: PendingWatchedMutation,
): Promise<NormalizedMutationResult> => {
  if (execution.request === undefined) {
    return mutationResult(pending.mutation, WatchStateMutationStatus.PERMANENT_FAILURE);
  }
  let method: "DELETE" | "POST" = "DELETE";
  if (pending.watched) {
    method = "POST";
  }
  const signal = boundedProviderResponseSignal(execution);
  const response = await execution.request.requestMutationJson(
    ["UserPlayedItems", pending.itemReference.itemId],
    {
      authentication: "api_key",
      cancellationSignal: execution.signal,
      maximumResponseBytes: MAXIMUM_MEDIA_RESPONSE_BYTES,
      method,
      query: { userId: execution.context.userId },
      signal,
    },
  );
  return mutationResponseResult(execution, pending, response);
};

const executeWatchedMutations = async (
  execution: MutationExecution,
  pendingMutations: readonly PendingWatchedMutation[],
): Promise<void> => {
  const completed = await forEachBounded(
    pendingMutations,
    MAXIMUM_CONCURRENT_MUTATIONS,
    async (pending) => ({
      index: pending.index,
      result: await applyWatchedMutation(execution, pending),
    }),
  );
  for (const { index, result } of completed) {
    execution.resultsByIndex.set(index, result);
  }
};

const classifyCurrentState = (
  watchedMutation: PendingWatchedMutation,
  result: NormalizedReadResult,
  classification: CurrentStateClassification,
): void => {
  if (result.status !== WatchStateReadStatus.FOUND || result.state === undefined) {
    classification.resultsByIndex.set(
      watchedMutation.index,
      mutationResult(watchedMutation.mutation, mutationStatusForRead(result)),
    );
    return;
  }
  if (result.state.watched === watchedMutation.watched) {
    classification.resultsByIndex.set(
      watchedMutation.index,
      mutationResult(
        watchedMutation.mutation,
        WatchStateMutationStatus.ALREADY_APPLIED,
        result.state,
      ),
    );
    return;
  }
  classification.pendingMutations.push(watchedMutation);
};

const pendingWatchedMutations = async (
  execution: MutationExecution,
  watchedMutations: readonly PendingWatchedMutation[],
): Promise<PendingWatchedMutation[]> => {
  const signal = boundedProviderResponseSignal(execution);
  const current = await getJellyfinWatchStates(
    execution.context,
    watchedMutations.map(({ itemReference }) => itemReference),
    { cancellation: execution.signal, request: signal },
  );
  const classification: CurrentStateClassification = {
    pendingMutations: [],
    resultsByIndex: execution.resultsByIndex,
  };
  for (const [index, watchedMutation] of watchedMutations.entries()) {
    const result = current.results[index];
    if (result === undefined) {
      throw new Error("Jellyfin current watch-state result is unavailable");
    }
    classifyCurrentState(watchedMutation, result, classification);
  }
  return classification.pendingMutations;
};

const orderedMutationResults = (
  mutations: readonly WatchStateMutation[],
  resultsByIndex: ReadonlyMap<number, NormalizedMutationResult>,
): NormalizedMutationResult[] =>
  mutations.map((_mutation, index) => {
    const result = resultsByIndex.get(index);
    if (result === undefined) {
      throw new Error("Jellyfin mutation result is unavailable");
    }
    return result;
  });

const pushJellyfinWatchStates = async ({
  context,
  mutations,
  signal,
  timeoutMs,
}: JellyfinWatchStateMutationCall) => {
  const classification = classifyMutations(mutations);
  const execution: MutationExecution = {
    context,
    request: createJellyfinRequest({ apiKey: context.apiKey, baseUrl: context.baseUrl }),
    resultsByIndex: classification.resultsByIndex,
    signal,
    timeoutMs,
  };
  const pendingMutations = await pendingWatchedMutations(
    execution,
    classification.watchedMutations,
  );
  await executeWatchedMutations(execution, pendingMutations);
  await executeProgressMutations(execution, classification.progressMutations);
  return { results: orderedMutationResults(mutations, execution.resultsByIndex) };
};

export { pushJellyfinWatchStates };
