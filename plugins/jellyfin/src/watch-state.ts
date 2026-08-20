import type { ProviderItemReference } from "@nama/api/nama/plugin/v1/common_pb.js";
import {
  WatchStateMutationStatus,
  WatchStateReadStatus,
} from "@nama/api/nama/plugin/v1/watch_state_pb.js";

import { forEachBounded } from "./bounded-concurrency.ts";
import { jellyfinFailureCategory } from "./request-failure.ts";
import type { JellyfinFailureCategory } from "./request-failure.ts";
import { createJellyfinRequest } from "./request.ts";
import type { JellyfinJsonResponse } from "./request.ts";
import {
  ABSENT_VALUE,
  normalizeJellyfinWatchState,
  timestampFromMilliseconds,
} from "./watch-state-value.ts";
import type { NormalizedWatchState, ProtobufTimestamp } from "./watch-state-value.ts";

const MAXIMUM_MEDIA_RESPONSE_BYTES = 16_777_216;
const MAXIMUM_CONCURRENT_READS = 4;

type JellyfinWatchStateContext = Readonly<{
  apiKey: string;
  baseUrl: string;
  userId: string;
}>;
interface JellyfinWatchStateSignals {
  readonly cancellation: AbortSignal;
  readonly request: AbortSignal;
}
interface NormalizedReadResult {
  readonly itemReference: ProviderItemReference;
  readonly state?: NormalizedWatchState;
  readonly status: WatchStateReadStatus;
}
interface WatchStateFailureStatuses {
  readonly mutation: WatchStateMutationStatus;
  readonly read: WatchStateReadStatus;
}

const WATCH_STATE_STATUSES_BY_FAILURE_CATEGORY = {
  forbidden: {
    mutation: WatchStateMutationStatus.FORBIDDEN,
    read: WatchStateReadStatus.FORBIDDEN,
  },
  missing: {
    mutation: WatchStateMutationStatus.NOT_FOUND,
    read: WatchStateReadStatus.NOT_FOUND,
  },
  permanent: {
    mutation: WatchStateMutationStatus.PERMANENT_FAILURE,
    read: WatchStateReadStatus.PERMANENT_FAILURE,
  },
  retryable: {
    mutation: WatchStateMutationStatus.RETRYABLE_FAILURE,
    read: WatchStateReadStatus.RETRYABLE_FAILURE,
  },
} as const satisfies Readonly<Record<JellyfinFailureCategory, WatchStateFailureStatuses>>;

const failedRead = (
  itemReference: ProviderItemReference,
  status: WatchStateReadStatus,
): NormalizedReadResult => ({ itemReference, status });

const permanentFailure = (itemReference: ProviderItemReference) =>
  failedRead(itemReference, WatchStateReadStatus.PERMANENT_FAILURE);

const watchStateReadResult = (
  itemReference: ProviderItemReference,
  response: JellyfinJsonResponse,
  observedAt: ProtobufTimestamp,
): NormalizedReadResult => {
  if (response.kind !== "success") {
    const category = jellyfinFailureCategory(response.kind);
    return failedRead(itemReference, WATCH_STATE_STATUSES_BY_FAILURE_CATEGORY[category].read);
  }
  const state = normalizeJellyfinWatchState(itemReference, response.body, observedAt);
  if (state === ABSENT_VALUE) {
    return permanentFailure(itemReference);
  }
  return { itemReference, state, status: WatchStateReadStatus.FOUND };
};

const getJellyfinWatchStates = async (
  context: JellyfinWatchStateContext,
  itemReferences: readonly ProviderItemReference[],
  signals: JellyfinWatchStateSignals,
) => {
  const request = createJellyfinRequest({ apiKey: context.apiKey, baseUrl: context.baseUrl });
  if (request === undefined) {
    return { results: itemReferences.map((itemReference) => permanentFailure(itemReference)) };
  }
  const observedAt = timestampFromMilliseconds(Date.now());
  const results = await forEachBounded(
    itemReferences,
    MAXIMUM_CONCURRENT_READS,
    async (itemReference) => {
      const response = await request.requestJson(["Items", itemReference.itemId], {
        authentication: "api_key",
        cancellationSignal: signals.cancellation,
        maximumResponseBytes: MAXIMUM_MEDIA_RESPONSE_BYTES,
        query: { userId: context.userId },
        signal: signals.request,
      });
      return watchStateReadResult(itemReference, response, observedAt);
    },
  );
  return { results };
};

export { WATCH_STATE_STATUSES_BY_FAILURE_CATEGORY, getJellyfinWatchStates };
export type { JellyfinWatchStateContext, NormalizedReadResult };
