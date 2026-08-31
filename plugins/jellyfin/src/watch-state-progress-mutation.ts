import { WatchStateMutationStatus } from "@nama/api/nama/plugin/v1/watch_state_pb.js";

import { forEachBounded } from "./bounded-concurrency.ts";
import { jellyfinExtensionSupportsProgress } from "./connection.ts";
import { setExtensionProgress } from "./extension-progress-client.ts";
import type { ExtensionProgressResponse } from "./extension-progress-client.ts";
import { jellyfinFailureCategory } from "./request-failure.ts";
import type { JellyfinFailureKind } from "./request-failure.ts";
import {
  boundedProviderResponseSignal,
  readBackAmbiguousMutation,
} from "./watch-state-mutation-execution.ts";
import type { MutationExecution } from "./watch-state-mutation-execution.ts";
import { mutationResult } from "./watch-state-mutation-validation.ts";
import type {
  NormalizedMutationResult,
  PendingProgressMutation,
} from "./watch-state-mutation-validation.ts";
import type { NormalizedWatchState } from "./watch-state-value.ts";
import { WATCH_STATE_STATUSES_BY_FAILURE_CATEGORY } from "./watch-state.ts";

const MAXIMUM_CONCURRENT_MUTATIONS = 4;
const NO_PENDING_MUTATIONS = 0;
const ZERO_DURATION_SECONDS = 0n;
type SuccessfulProgressResponse = Extract<ExtensionProgressResponse, { kind: "success" }>;
const ZERO_DURATION_NANOS = 0;

const durationMatches = (
  left: Readonly<{ nanos: number; seconds: bigint }> | undefined,
  right: Readonly<{ nanos: number; seconds: bigint }>,
): boolean => {
  if (left === undefined) {
    return right.seconds === ZERO_DURATION_SECONDS && right.nanos === ZERO_DURATION_NANOS;
  }
  return left.seconds === right.seconds && left.nanos === right.nanos;
};

const progressTargetMatches = (
  pending: PendingProgressMutation,
  state: NormalizedWatchState,
): boolean => {
  if (state.watched !== pending.watched || !durationMatches(state.position, pending.position)) {
    return false;
  }
  return pending.duration === undefined || durationMatches(state.duration, pending.duration);
};

const failedProgressResult = (
  pending: PendingProgressMutation,
  kind: JellyfinFailureKind,
): Promise<NormalizedMutationResult> => {
  const status = WATCH_STATE_STATUSES_BY_FAILURE_CATEGORY[jellyfinFailureCategory(kind)].mutation;
  return Promise.resolve(mutationResult(pending.mutation, status));
};
const successfulProgressResult = (
  pending: PendingProgressMutation,
  response: SuccessfulProgressResponse,
): Promise<NormalizedMutationResult> => {
  if (!progressTargetMatches(pending, response.state)) {
    return Promise.resolve(
      mutationResult(
        pending.mutation,
        WatchStateMutationStatus.RETRYABLE_AMBIGUOUS,
        response.state,
      ),
    );
  }
  let status = WatchStateMutationStatus.APPLIED;
  if (response.status === "already_applied") {
    status = WatchStateMutationStatus.ALREADY_APPLIED;
  }
  return Promise.resolve(mutationResult(pending.mutation, status, response.state));
};

const progressResponseResult = (
  execution: MutationExecution,
  pending: PendingProgressMutation,
  response: ExtensionProgressResponse,
): Promise<NormalizedMutationResult> => {
  if (response.kind === "ambiguous" || response.kind === "unreachable") {
    return readBackAmbiguousMutation(execution, pending, (state) =>
      progressTargetMatches(pending, state),
    );
  }
  if (response.kind !== "success") {
    if (response.kind === "incompatible") {
      return Promise.resolve(mutationResult(pending.mutation, WatchStateMutationStatus.INVALID));
    }
    return failedProgressResult(pending, response.kind);
  }
  return successfulProgressResult(pending, response);
};

const applyProgressMutation = async (
  execution: MutationExecution,
  pending: PendingProgressMutation,
): Promise<NormalizedMutationResult> => {
  if (execution.request === undefined) {
    return mutationResult(pending.mutation, WatchStateMutationStatus.PERMANENT_FAILURE);
  }
  const response = await setExtensionProgress({
    cancellationSignal: execution.signal,
    duration: pending.duration,
    itemReference: pending.itemReference,
    position: pending.position,
    request: execution.request,
    signal: boundedProviderResponseSignal(execution),
    userId: execution.context.userId,
    watched: pending.watched,
  });
  return progressResponseResult(execution, pending, response);
};

const markUnsupported = (
  execution: MutationExecution,
  pendingMutations: readonly PendingProgressMutation[],
): void => {
  for (const pending of pendingMutations) {
    execution.resultsByIndex.set(
      pending.index,
      mutationResult(pending.mutation, WatchStateMutationStatus.UNSUPPORTED),
    );
  }
};

const executeProgressMutations = async (
  execution: MutationExecution,
  pendingMutations: readonly PendingProgressMutation[],
): Promise<void> => {
  if (pendingMutations.length === NO_PENDING_MUTATIONS) {
    return;
  }
  const supported = await jellyfinExtensionSupportsProgress(execution.context, execution.signal);
  if (!supported) {
    markUnsupported(execution, pendingMutations);
    return;
  }
  const completed = await forEachBounded(
    pendingMutations,
    MAXIMUM_CONCURRENT_MUTATIONS,
    async (pending) => ({
      index: pending.index,
      result: await applyProgressMutation(execution, pending),
    }),
  );
  for (const { index, result } of completed) {
    execution.resultsByIndex.set(index, result);
  }
};

export { executeProgressMutations };
