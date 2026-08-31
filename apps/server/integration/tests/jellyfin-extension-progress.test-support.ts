import type { IncomingMessage, ServerResponse } from "node:http";

import type { MessageInitShape } from "@bufbuild/protobuf";
import type { WatchStateMutationSchema } from "@nama/api/nama/plugin/v1/watch_state_pb.js";
import { WatchStateService } from "@nama/api/nama/plugin/v1/watch_state_pb.js";

import type { SupervisedPlugin } from "../../src/plugin/model.ts";
import { respondJson, respondRaw } from "./jellyfin-process.test-support.ts";
import type { ObservedRequest } from "./jellyfin-process.test-support.ts";

const CALL_DEADLINE_MILLISECONDS = 10_000;
const JELLYFIN_TICKS_PER_SECOND = 10_000_000;
const NANOSECONDS_PER_JELLYFIN_TICK = 100;
const MEDIA_RUNTIME_TICKS = 100_000_000;
const MEDIA_RUNTIME_SECONDS = 10n;
const HTTP_BAD_REQUEST = 400;
const HTTP_FORBIDDEN = 403;
const HTTP_NOT_FOUND = 404;
const HTTP_UNAVAILABLE = 503;
const RAW_ERROR_SENTINEL = "coherent-progress-private-error-sentinel";

type ProgressTarget = Readonly<{
  duration?: Readonly<{ nanos: number; seconds: bigint }>;
  position: Readonly<{ nanos: number; seconds: bigint }>;
  watched: boolean;
}>;
type ProviderState = Readonly<{ positionTicks: number; watched: boolean }>;
type JsonRecord = Readonly<Record<string, unknown>>;

const isJsonRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const progressMutation = (mutationId: string, itemId: string, target: ProgressTarget) => ({
  itemReference: { itemId },
  mutationId,
  target: {
    case: "setProgress" as const,
    value: {
      duration: target.duration,
      position: target.position,
      watched: target.watched,
    },
  },
});

const pushProgress = (
  plugin: SupervisedPlugin,
  mutations: readonly MessageInitShape<typeof WatchStateMutationSchema>[],
) =>
  plugin.call(
    WatchStateService.method.pushWatchStates,
    { batchId: "coherent-progress-batch", mutations: [...mutations] },
    CALL_DEADLINE_MILLISECONDS,
  );

const extensionHandshake = (response: ServerResponse, coherent = true): void => {
  let capabilities = ["direct_progressive", "playback_telemetry"];
  if (coherent) {
    capabilities = [...capabilities, "coherent_progress"];
  }
  respondJson(response, {
    capabilities,
    extension_version: "1.0.0",
    protocol: "nama.jellyfin.extension",
    protocol_version: 2,
  });
};

const parseJsonBody = (
  request: IncomingMessage,
  response: ServerResponse,
  receive: (body: JsonRecord) => void,
): void => {
  const chunks: Buffer[] = [];
  request.on("data", (chunk: Buffer) => {
    chunks.push(chunk);
  });
  request.on("end", () => {
    const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!isJsonRecord(body)) {
      respondRaw(response, HTTP_BAD_REQUEST, "invalid");
      return;
    }
    receive(body);
  });
};

const durationBody = (ticks: number) => ({
  nanos: (ticks % JELLYFIN_TICKS_PER_SECOND) * NANOSECONDS_PER_JELLYFIN_TICK,
  seconds: Math.floor(ticks / JELLYFIN_TICKS_PER_SECOND).toString(),
});

const respondProgressState = ({
  itemId,
  response,
  state,
  status,
}: Readonly<{
  itemId: string;
  response: ServerResponse;
  state: ProviderState;
  status: "already_applied" | "applied";
}>): void => {
  respondJson(response, {
    duration: durationBody(MEDIA_RUNTIME_TICKS),
    item_id: itemId,
    position: durationBody(state.positionTicks),
    status,
    watched: state.watched,
  });
};

const respondItemState = (response: ServerResponse, itemId: string, state: ProviderState): void => {
  respondJson(response, {
    Id: itemId,
    RunTimeTicks: MEDIA_RUNTIME_TICKS,
    Type: "Movie",
    UserData: {
      PlaybackPositionTicks: state.positionTicks,
      Played: state.watched,
    },
  });
};

const itemIdFromPath = (observation: ObservedRequest): string | undefined => {
  const path = new URL(observation.url, "http://jellyfin.invalid").pathname;
  const match = /^\/jellyfin\/Items\/(?<itemId>[^/]+)$/u.exec(path);
  return match?.groups?.["itemId"];
};

const isProgressPath = (observation: ObservedRequest): boolean => {
  const path = new URL(observation.url, "http://jellyfin.invalid").pathname;
  return path === "/jellyfin/Nama/v1/progress";
};

const isHandshakePath = (observation: ObservedRequest): boolean => {
  const path = new URL(observation.url, "http://jellyfin.invalid").pathname;
  return path === "/jellyfin/Nama/v1/handshake";
};

const ticksFromDurationBody = (value: unknown): number => {
  if (!isJsonRecord(value)) {
    throw new TypeError("expected a duration body");
  }
  const { nanos, seconds } = value;
  if (typeof seconds !== "string" || typeof nanos !== "number") {
    throw new TypeError("expected a duration body");
  }
  return Number(seconds) * JELLYFIN_TICKS_PER_SECOND + nanos / NANOSECONDS_PER_JELLYFIN_TICK;
};

export {
  extensionHandshake,
  HTTP_BAD_REQUEST,
  HTTP_FORBIDDEN,
  HTTP_NOT_FOUND,
  HTTP_UNAVAILABLE,
  isHandshakePath,
  isProgressPath,
  itemIdFromPath,
  MEDIA_RUNTIME_SECONDS,
  parseJsonBody,
  progressMutation,
  pushProgress,
  RAW_ERROR_SENTINEL,
  respondItemState,
  respondProgressState,
  ticksFromDurationBody,
};
export type { JsonRecord, ProgressTarget, ProviderState };
