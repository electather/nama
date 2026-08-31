import {
  WatchStateMutationStatus,
  WatchStateReadStatus,
} from "@nama/api/nama/plugin/v1/watch_state_pb.js";

import type { JellyfinRequest } from "./request.ts";
import { mutationResult } from "./watch-state-mutation-validation.ts";
import type {
  NormalizedMutationResult,
  PendingProgressMutation,
  PendingWatchedMutation,
} from "./watch-state-mutation-validation.ts";
import type { NormalizedWatchState } from "./watch-state-value.ts";
import { getJellyfinWatchStates } from "./watch-state.ts";
import type { JellyfinWatchStateContext } from "./watch-state.ts";

const MINIMUM_RESPONSE_TIMEOUT_MILLISECONDS = 1;
const RESPONSE_TIMEOUT_DIVISOR = 2;

type PendingMutation = PendingProgressMutation | PendingWatchedMutation;
interface MutationExecution {
  readonly context: JellyfinWatchStateContext;
  readonly request: JellyfinRequest | undefined;
  readonly resultsByIndex: Map<number, NormalizedMutationResult>;
  readonly signal: AbortSignal;
  readonly timeoutMs: () => number | undefined;
}

const boundedProviderResponseSignal = (execution: MutationExecution): AbortSignal => {
  const remainingMilliseconds = execution.timeoutMs();
  if (remainingMilliseconds === undefined || !Number.isFinite(remainingMilliseconds)) {
    return execution.signal;
  }
  const responseTimeoutMilliseconds = Math.max(
    MINIMUM_RESPONSE_TIMEOUT_MILLISECONDS,
    Math.floor(remainingMilliseconds / RESPONSE_TIMEOUT_DIVISOR),
  );
  return AbortSignal.any([execution.signal, AbortSignal.timeout(responseTimeoutMilliseconds)]);
};

const readBackAmbiguousMutation = async (
  execution: MutationExecution,
  pending: PendingMutation,
  targetMatches: (state: NormalizedWatchState) => boolean,
): Promise<NormalizedMutationResult> => {
  const readback = await getJellyfinWatchStates(execution.context, [pending.itemReference], {
    cancellation: execution.signal,
    request: execution.signal,
  });
  const [result] = readback.results;
  if (result?.status !== WatchStateReadStatus.FOUND || result.state === undefined) {
    return mutationResult(pending.mutation, WatchStateMutationStatus.RETRYABLE_AMBIGUOUS);
  }
  if (targetMatches(result.state)) {
    return mutationResult(pending.mutation, WatchStateMutationStatus.APPLIED, result.state);
  }
  return mutationResult(
    pending.mutation,
    WatchStateMutationStatus.RETRYABLE_AMBIGUOUS,
    result.state,
  );
};

export { boundedProviderResponseSignal, readBackAmbiguousMutation };
export type { MutationExecution };
