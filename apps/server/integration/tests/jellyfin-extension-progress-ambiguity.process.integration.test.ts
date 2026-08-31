import type { IncomingMessage, ServerResponse } from "node:http";
import { inspect } from "node:util";

import { expect, it } from "@effect/vitest";
import { WatchStateMutationStatus } from "@nama/api/nama/plugin/v1/watch_state_pb.js";
import type { PushWatchStatesResponse } from "@nama/api/nama/plugin/v1/watch_state_pb.js";
import { Effect } from "effect";

import { PluginSupervisor } from "../../src/plugin/supervisor.ts";
import {
  extensionHandshake,
  HTTP_NOT_FOUND,
  HTTP_UNAVAILABLE,
  isHandshakePath,
  isProgressPath,
  itemIdFromPath,
  parseJsonBody,
  progressMutation,
  pushProgress,
  RAW_ERROR_SENTINEL,
  respondItemState,
} from "./jellyfin-extension-progress.test-support.ts";
import type { ProviderState } from "./jellyfin-extension-progress.test-support.ts";
import {
  controlledJellyfin,
  respondJson,
  respondRaw,
  superviseJellyfin,
} from "./jellyfin-process.test-support.ts";
import type { ControlledHandler, ObservedRequest } from "./jellyfin-process.test-support.ts";

const EXPECTED_PROGRESS_REQUESTS = 4;
const EXPECTED_READBACK_REQUESTS = 1;
const TARGET = { position: { nanos: 0, seconds: 2n }, watched: true };
const applyProgressRequest = (
  states: Map<string, ProviderState>,
  request: IncomingMessage,
  response: ServerResponse,
): void => {
  parseJsonBody(request, response, (body) => {
    const itemId = String(body["item_id"]);
    if (itemId === "committed") {
      states.set(itemId, { positionTicks: 20_000_000, watched: true });
    }
    if (itemId === "malformed") {
      respondJson(response, { private_error: RAW_ERROR_SENTINEL });
      return;
    }
    response.destroy();
  });
};
const applyUnresolvedReadback = (itemId: string | undefined, response: ServerResponse): boolean => {
  if (itemId !== "unresolved") {
    return false;
  }
  respondRaw(response, HTTP_UNAVAILABLE, RAW_ERROR_SENTINEL);
  return true;
};

const applyReadback = (
  states: ReadonlyMap<string, ProviderState>,
  response: ServerResponse,
  observation: ObservedRequest,
): boolean => {
  const itemId = itemIdFromPath(observation);
  if (applyUnresolvedReadback(itemId, response)) {
    return true;
  }
  if (itemId === undefined) {
    return false;
  }
  const current = states.get(itemId);
  if (current === undefined) {
    return false;
  }
  respondItemState(response, itemId, current);
  return true;
};

const lostResponseHandler = (): ControlledHandler => {
  const states = new Map<string, ProviderState>([
    ["committed", { positionTicks: 0, watched: false }],
    ["conflicting", { positionTicks: 10_000_000, watched: false }],
    ["malformed", { positionTicks: 10_000_000, watched: false }],
  ]);
  return (request, response, observation) => {
    if (isHandshakePath(observation)) {
      extensionHandshake(response);
      return;
    }
    if (isProgressPath(observation)) {
      applyProgressRequest(states, request, response);
      return;
    }
    if (applyReadback(states, response, observation)) {
      return;
    }
    respondRaw(response, HTTP_NOT_FOUND, "missing");
  };
};

const expectAmbiguousResults = (
  result: PushWatchStatesResponse,
  requests: readonly ObservedRequest[],
): void => {
  const summaries = result.results.map(({ observedState, status }) => ({
    position: observedState?.position?.seconds,
    status,
    watched: observedState?.watched,
  }));
  const progressRequests = requests.filter(({ url }) => url.includes("/Nama/v1/progress"));
  expect(summaries).toEqual([
    { position: 2n, status: WatchStateMutationStatus.APPLIED, watched: true },
    { position: 1n, status: WatchStateMutationStatus.RETRYABLE_AMBIGUOUS, watched: false },
    {
      position: undefined,
      status: WatchStateMutationStatus.RETRYABLE_AMBIGUOUS,
      watched: undefined,
    },
    { position: 1n, status: WatchStateMutationStatus.RETRYABLE_AMBIGUOUS, watched: false },
  ]);
  expect(inspect(result, { depth: undefined })).not.toContain(RAW_ERROR_SENTINEL);
  expect(progressRequests).toHaveLength(EXPECTED_PROGRESS_REQUESTS);
  for (const itemId of ["committed", "conflicting", "unresolved", "malformed"]) {
    const readbacks = requests.filter(({ url }) => url.includes(`/Items/${itemId}?`));
    expect(readbacks).toHaveLength(EXPECTED_READBACK_REQUESTS);
  }
};

const progressAmbiguityTest = () => {
  const program = Effect.gen(function* lostResponseScenario() {
    const jellyfin = yield* controlledJellyfin(lostResponseHandler());
    const supervisor = yield* PluginSupervisor;
    const plugin = yield* superviseJellyfin(supervisor, jellyfin);
    const result = yield* pushProgress(plugin, [
      progressMutation("committed", "committed", TARGET),
      progressMutation("conflicting", "conflicting", TARGET),
      progressMutation("unresolved", "unresolved", TARGET),
      progressMutation("malformed", "malformed", TARGET),
    ]);
    expectAmbiguousResults(result, jellyfin.requests);
  }).pipe(Effect.provide(PluginSupervisor.layer()));
  return Effect.scoped(program);
};

it.live(
  "reads a lost progress response once and never replays a conflicting target",
  progressAmbiguityTest,
);
