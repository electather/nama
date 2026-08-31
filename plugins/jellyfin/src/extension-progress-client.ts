import type { ProviderItemReference } from "@nama/api/nama/plugin/v1/common_pb.js";

import { durationBody } from "./extension-playback-values.ts";
import type { JellyfinFailureResponse } from "./request-failure.ts";
import type { JellyfinRequest } from "./request.ts";
import { isUnknownRecord } from "./value.ts";
import { timestampFromMilliseconds } from "./watch-state-value.ts";
import type { NormalizedWatchState } from "./watch-state-value.ts";

const MAXIMUM_EXTENSION_RESPONSE_BYTES = 65_536;
const MAXIMUM_DURATION_SECONDS = 315_576_000_000n;
const MAXIMUM_DURATION_NANOS = 999_999_999;
const ZERO_SECONDS = 0n;
const ZERO_NANOS = 0;
const DECIMAL_INTEGER = /^(?:0|[1-9][0-9]*)$/u;
const INVALID_DURATION = Symbol("invalid_duration");

type ProgressStatus = "already_applied" | "applied";
type ProgressDuration = Readonly<{ nanos: number; seconds: bigint }>;
type ExtensionProgressResponse =
  | Readonly<{
      kind: "success";
      state: NormalizedWatchState;
      status: ProgressStatus;
    }>
  | JellyfinFailureResponse
  | Readonly<{ kind: "ambiguous" }>;

interface ExtensionProgressCall {
  readonly cancellationSignal: AbortSignal;
  readonly duration?: ProgressDuration | undefined;
  readonly itemReference: ProviderItemReference;
  readonly position: ProgressDuration;
  readonly request: JellyfinRequest;
  readonly signal: AbortSignal;
  readonly userId: string;
  readonly watched: boolean;
}

const parseDuration = (value: unknown): ProgressDuration | typeof INVALID_DURATION => {
  if (
    !isUnknownRecord(value) ||
    typeof value["seconds"] !== "string" ||
    !DECIMAL_INTEGER.test(value["seconds"]) ||
    typeof value["nanos"] !== "number" ||
    !Number.isInteger(value["nanos"]) ||
    value["nanos"] < ZERO_NANOS ||
    value["nanos"] > MAXIMUM_DURATION_NANOS
  ) {
    return INVALID_DURATION;
  }
  const seconds = BigInt(value["seconds"]);
  if (seconds > MAXIMUM_DURATION_SECONDS) {
    return INVALID_DURATION;
  }
  return { nanos: value["nanos"], seconds };
};

const applyDuration = (
  state: NormalizedWatchState,
  field: "duration" | "position",
  value: unknown,
): boolean => {
  const duration = parseDuration(value);
  if (duration === INVALID_DURATION) {
    return false;
  }
  if (duration.seconds !== ZERO_SECONDS || duration.nanos !== ZERO_NANOS) {
    state[field] = duration;
  }
  return true;
};

const normalizeProgressResponse = (
  itemReference: ProviderItemReference,
  body: Readonly<Record<string, unknown>>,
): ExtensionProgressResponse => {
  const { duration, item_id: itemId, position, status, watched } = body;
  if (
    itemId !== itemReference.itemId ||
    typeof watched !== "boolean" ||
    (status !== "applied" && status !== "already_applied")
  ) {
    return { kind: "ambiguous" };
  }
  const state: NormalizedWatchState = {
    itemReference,
    observedAt: timestampFromMilliseconds(Date.now()),
    watched,
  };
  if (!applyDuration(state, "position", position) || !applyDuration(state, "duration", duration)) {
    return { kind: "ambiguous" };
  }
  return { kind: "success", state, status };
};

const setExtensionProgress = async ({
  cancellationSignal,
  duration,
  itemReference,
  position,
  request,
  signal,
  userId,
  watched,
}: ExtensionProgressCall): Promise<ExtensionProgressResponse> => {
  const response = await request.requestMutationJson(["Nama", "v1", "progress"], {
    authentication: "api_key",
    body: {
      duration: durationBody(duration),
      item_id: itemReference.itemId,
      position: durationBody(position),
      user_id: userId,
      watched,
    },
    cancellationSignal,
    maximumResponseBytes: MAXIMUM_EXTENSION_RESPONSE_BYTES,
    method: "POST",
    signal,
  });
  if (response.kind !== "success") {
    return response;
  }
  return normalizeProgressResponse(itemReference, response.body);
};

export { setExtensionProgress };
export type { ExtensionProgressResponse, ProgressDuration };
