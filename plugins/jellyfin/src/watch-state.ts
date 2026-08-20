import type { ProviderItemReference } from "@nama/api/nama/plugin/v1/common_pb.js";
import {
  ProviderActivityReliability,
  ProviderActivitySemantics,
  WatchStateReadStatus,
} from "@nama/api/nama/plugin/v1/watch_state_pb.js";

import { createJellyfinRequest } from "./request.ts";
import type { JellyfinJsonResponse } from "./request.ts";
import { isUnknownRecord } from "./value.ts";

const MAXIMUM_MEDIA_RESPONSE_BYTES = 16_777_216;
const MAXIMUM_CONCURRENT_READS = 4;
const JELLYFIN_TICKS_PER_SECOND = 10_000_000;
const NANOSECONDS_PER_JELLYFIN_TICK = 100;
const MILLISECONDS_PER_SECOND = 1000;
const NANOSECONDS_PER_MILLISECOND = 1_000_000;
const ZERO_TICKS = 0;
const INDEX_INCREMENT = 1;
const INVALID_TICKS = Symbol("invalid_ticks");
const ABSENT_VALUE = Symbol("absent_value");

type JellyfinWatchStateContext = Readonly<{
  apiKey: string;
  baseUrl: string;
  userId: string;
}>;

type ProtobufTimestamp = Readonly<{ nanos: number; seconds: bigint }>;
type ProtobufDuration = Readonly<{ nanos: number; seconds: bigint }>;
type NormalizedProviderActivity = Readonly<{
  occurredAt: ProtobufTimestamp;
  reliability: ProviderActivityReliability;
  semantics: ProviderActivitySemantics;
}>;

interface NormalizedWatchState {
  duration?: ProtobufDuration;
  readonly itemReference: ProviderItemReference;
  readonly observedAt: ProtobufTimestamp;
  position?: ProtobufDuration;
  providerActivity?: NormalizedProviderActivity;
  readonly watched: boolean;
}
interface JellyfinUserData {
  readonly played: boolean;
  readonly record: Readonly<Record<string, unknown>>;
}
interface NormalizedReadResult {
  readonly itemReference: ProviderItemReference;
  readonly state?: NormalizedWatchState;
  readonly status: WatchStateReadStatus;
}

const timestampFromMilliseconds = (milliseconds: number): ProtobufTimestamp => {
  const wholeSeconds = Math.floor(milliseconds / MILLISECONDS_PER_SECOND);
  return {
    nanos: (milliseconds - wholeSeconds * MILLISECONDS_PER_SECOND) * NANOSECONDS_PER_MILLISECOND,
    seconds: BigInt(wholeSeconds),
  };
};

const parseOptionalTicks = (
  value: unknown,
): number | typeof ABSENT_VALUE | typeof INVALID_TICKS => {
  if (value === undefined || value === null) {
    return ABSENT_VALUE;
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < ZERO_TICKS) {
    return INVALID_TICKS;
  }
  return value;
};

const durationFromTicks = (ticks: number): ProtobufDuration => ({
  nanos: (ticks % JELLYFIN_TICKS_PER_SECOND) * NANOSECONDS_PER_JELLYFIN_TICK,
  seconds: BigInt(Math.floor(ticks / JELLYFIN_TICKS_PER_SECOND)),
});

const providerActivity = (value: unknown): NormalizedProviderActivity | typeof ABSENT_VALUE => {
  if (typeof value !== "string") {
    return ABSENT_VALUE;
  }
  const occurredAtMilliseconds = Date.parse(value);
  if (!Number.isFinite(occurredAtMilliseconds)) {
    return ABSENT_VALUE;
  }
  return {
    occurredAt: timestampFromMilliseconds(occurredAtMilliseconds),
    reliability: ProviderActivityReliability.HEURISTIC,
    semantics: ProviderActivitySemantics.UNKNOWN,
  };
};

const watchStateUserData = (
  itemReference: ProviderItemReference,
  body: Readonly<Record<string, unknown>>,
): JellyfinUserData | typeof ABSENT_VALUE => {
  const userData = body["UserData"];
  if (
    body["Id"] !== itemReference.itemId ||
    (body["Type"] !== "Movie" && body["Type"] !== "Episode") ||
    !isUnknownRecord(userData) ||
    typeof userData["Played"] !== "boolean"
  ) {
    return ABSENT_VALUE;
  }
  return { played: userData["Played"], record: userData };
};

const applyProviderActivity = (state: NormalizedWatchState, userData: JellyfinUserData): void => {
  const activity = providerActivity(userData.record["LastPlayedDate"]);
  if (activity !== ABSENT_VALUE) {
    state.providerActivity = activity;
  }
};

const applyOptionalState = (
  state: NormalizedWatchState,
  body: Readonly<Record<string, unknown>>,
  userData: JellyfinUserData,
): boolean => {
  const positionTicks = parseOptionalTicks(userData.record["PlaybackPositionTicks"]);
  const durationTicks = parseOptionalTicks(body["RunTimeTicks"]);
  if (positionTicks === INVALID_TICKS || durationTicks === INVALID_TICKS) {
    return false;
  }
  if (durationTicks !== ABSENT_VALUE && durationTicks > ZERO_TICKS) {
    state.duration = durationFromTicks(durationTicks);
  }
  if (positionTicks !== ABSENT_VALUE && positionTicks > ZERO_TICKS) {
    state.position = durationFromTicks(positionTicks);
  }
  applyProviderActivity(state, userData);
  return true;
};

const normalizeWatchState = (
  itemReference: ProviderItemReference,
  body: Readonly<Record<string, unknown>>,
  observedAt: ProtobufTimestamp,
): NormalizedWatchState | typeof ABSENT_VALUE => {
  const userData = watchStateUserData(itemReference, body);
  if (userData === ABSENT_VALUE) {
    return ABSENT_VALUE;
  }
  const state: NormalizedWatchState = {
    itemReference,
    observedAt,
    watched: userData.played,
  };
  if (!applyOptionalState(state, body, userData)) {
    return ABSENT_VALUE;
  }
  return state;
};

const failedRead = (itemReference: ProviderItemReference, status: WatchStateReadStatus) => ({
  itemReference,
  status,
});

const permanentFailure = (itemReference: ProviderItemReference) =>
  failedRead(itemReference, WatchStateReadStatus.PERMANENT_FAILURE);

const providerFailure = (
  itemReference: ProviderItemReference,
  kind: "authentication_failed" | "forbidden" | "incompatible" | "not_found" | "unreachable",
) => {
  if (kind === "authentication_failed" || kind === "forbidden") {
    return failedRead(itemReference, WatchStateReadStatus.FORBIDDEN);
  }
  if (kind === "not_found") {
    return failedRead(itemReference, WatchStateReadStatus.NOT_FOUND);
  }
  if (kind === "unreachable") {
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
    return providerFailure(itemReference, response.kind);
  }
  const state = normalizeWatchState(itemReference, response.body, observedAt);
  if (state === ABSENT_VALUE) {
    return permanentFailure(itemReference);
  }
  return { itemReference, state, status: WatchStateReadStatus.FOUND };
};

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
  let nextIndex = 0;
  const readNext = async (): Promise<void> => {
    const index = nextIndex;
    nextIndex += INDEX_INCREMENT;
    const itemReference = itemReferences[index];
    if (itemReference === undefined) {
      return;
    }
    const response = await request.requestJson(["Items", itemReference.itemId], {
      authentication: "api_key",
      maximumResponseBytes: MAXIMUM_MEDIA_RESPONSE_BYTES,
      query: { userId: context.userId },
      signal,
    });
    resultsByIndex.set(index, watchStateReadResult(itemReference, response, observedAt));
    await readNext();
  };
  await Promise.all(
    Array.from({ length: Math.min(MAXIMUM_CONCURRENT_READS, itemReferences.length) }, () =>
      readNext(),
    ),
  );
  const results = itemReferences.map((_itemReference, index) => {
    const result = resultsByIndex.get(index);
    if (result === undefined) {
      throw new Error("Jellyfin read result is unavailable");
    }
    return result;
  });
  return { results };
};

export { getJellyfinWatchStates };
export type { JellyfinWatchStateContext };
