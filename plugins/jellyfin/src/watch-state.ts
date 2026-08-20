import type { ProviderItemReference } from "@nama/api/nama/plugin/v1/common_pb.js";
import { WatchStateReadStatus } from "@nama/api/nama/plugin/v1/watch_state_pb.js";

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
interface NormalizedReadResult {
  readonly itemReference: ProviderItemReference;
  readonly state?: NormalizedWatchState;
  readonly status: WatchStateReadStatus;
}

const failedRead = (
  itemReference: ProviderItemReference,
  status: WatchStateReadStatus,
): NormalizedReadResult => ({ itemReference, status });

const permanentFailure = (itemReference: ProviderItemReference) =>
  failedRead(itemReference, WatchStateReadStatus.PERMANENT_FAILURE);

const providerFailure = (
  itemReference: ProviderItemReference,
  category: JellyfinFailureCategory,
): NormalizedReadResult => {
  if (category === "forbidden") {
    return failedRead(itemReference, WatchStateReadStatus.FORBIDDEN);
  }
  if (category === "missing") {
    return failedRead(itemReference, WatchStateReadStatus.NOT_FOUND);
  }
  if (category === "retryable") {
    return failedRead(itemReference, WatchStateReadStatus.RETRYABLE_FAILURE);
  }
  return permanentFailure(itemReference);
};

const watchStateReadResult = (
  itemReference: ProviderItemReference,
  response: JellyfinJsonResponse,
  observedAt: ProtobufTimestamp,
): NormalizedReadResult => {
  if (response.kind !== "success") {
    return providerFailure(itemReference, jellyfinFailureCategory(response.kind));
  }
  const state = normalizeJellyfinWatchState(itemReference, response.body, observedAt);
  if (state === ABSENT_VALUE) {
    return permanentFailure(itemReference);
  }
  return { itemReference, state, status: WatchStateReadStatus.FOUND };
};

const orderedReadResults = (
  itemReferences: readonly ProviderItemReference[],
  resultsByIndex: ReadonlyMap<number, NormalizedReadResult>,
): NormalizedReadResult[] =>
  itemReferences.map((_itemReference, index) => {
    const result = resultsByIndex.get(index);
    if (result === undefined) {
      throw new Error("Jellyfin read result is unavailable");
    }
    return result;
  });

const getJellyfinWatchStates = async (
  context: JellyfinWatchStateContext,
  itemReferences: readonly ProviderItemReference[],
  signal: AbortSignal,
) => {
  const request = createJellyfinRequest({ apiKey: context.apiKey, baseUrl: context.baseUrl });
  if (request === undefined) {
    return { results: itemReferences.map((itemReference) => permanentFailure(itemReference)) };
  }
  const resultsByIndex = new Map<number, NormalizedReadResult>();
  const observedAt = timestampFromMilliseconds(Date.now());
  await forEachBounded(itemReferences, MAXIMUM_CONCURRENT_READS, async (itemReference, index) => {
    const response = await request.requestJson(["Items", itemReference.itemId], {
      authentication: "api_key",
      maximumResponseBytes: MAXIMUM_MEDIA_RESPONSE_BYTES,
      query: { userId: context.userId },
      signal,
    });
    resultsByIndex.set(index, watchStateReadResult(itemReference, response, observedAt));
  });
  return { results: orderedReadResults(itemReferences, resultsByIndex) };
};

export { getJellyfinWatchStates };
export type { JellyfinWatchStateContext, NormalizedReadResult };
