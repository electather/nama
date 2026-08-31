import { expect, it } from "@effect/vitest";
import { WatchStateMutationStatus } from "@nama/api/nama/plugin/v1/watch_state_pb.js";
import type { PushWatchStatesResponse } from "@nama/api/nama/plugin/v1/watch_state_pb.js";
import { Effect } from "effect";

import type { SupervisedPlugin } from "../../src/plugin/model.ts";
import { PluginSupervisor } from "../../src/plugin/supervisor.ts";
import {
  extensionHandshake,
  HTTP_BAD_REQUEST,
  HTTP_FORBIDDEN,
  HTTP_NOT_FOUND,
  isHandshakePath,
  isProgressPath,
  MEDIA_RUNTIME_SECONDS,
  parseJsonBody,
  progressMutation,
  pushProgress,
  RAW_ERROR_SENTINEL,
} from "./jellyfin-extension-progress.test-support.ts";
import {
  controlledJellyfin,
  respondRaw,
  superviseJellyfin,
} from "./jellyfin-process.test-support.ts";
import type { ControlledHandler } from "./jellyfin-process.test-support.ts";

const FIRST_RESULT_INDEX = 0;

const HTTP_INTERNAL_SERVER_ERROR = 500;
const STATUS_BY_ITEM: Readonly<Record<string, number>> = {
  forbidden: HTTP_FORBIDDEN,
  missing: HTTP_NOT_FOUND,
  persistence: HTTP_INTERNAL_SERVER_ERROR,
  stale: HTTP_BAD_REQUEST,
};
const EXPECTED_FAILURE_STATUSES = [
  WatchStateMutationStatus.INVALID,
  WatchStateMutationStatus.INVALID,
  WatchStateMutationStatus.NOT_FOUND,
  WatchStateMutationStatus.FORBIDDEN,
  WatchStateMutationStatus.RETRYABLE_AMBIGUOUS,
];
const VALID_TARGET = {
  duration: { nanos: 0, seconds: MEDIA_RUNTIME_SECONDS },
  position: { nanos: 0, seconds: 2n },
  watched: false,
};

const coherentFailureHandler: ControlledHandler = (request, response, observation) => {
  if (isHandshakePath(observation)) {
    extensionHandshake(response);
    return;
  }
  if (isProgressPath(observation)) {
    parseJsonBody(request, response, (body) => {
      const status = STATUS_BY_ITEM[String(body["item_id"])] ?? HTTP_BAD_REQUEST;
      respondRaw(response, status, RAW_ERROR_SENTINEL);
    });
    return;
  }
  respondRaw(response, HTTP_NOT_FOUND, "missing");
};

const playbackOnlyHandler: ControlledHandler = (_request, response, observation) => {
  if (isHandshakePath(observation)) {
    extensionHandshake(response, false);
    return;
  }
  respondRaw(response, HTTP_NOT_FOUND, "missing");
};
const exerciseFailures = (coherentPlugin: SupervisedPlugin, playbackOnlyPlugin: SupervisedPlugin) =>
  Effect.gen(function* failureCalls() {
    const unsupported = yield* pushProgress(playbackOnlyPlugin, [
      progressMutation("unsupported", "unsupported", VALID_TARGET),
    ]);
    const failures = yield* pushProgress(coherentPlugin, [
      progressMutation("malformed", "malformed", {
        position: { nanos: 1, seconds: 2n },
        watched: false,
      }),
      progressMutation("stale", "stale", VALID_TARGET),
      progressMutation("missing", "missing", VALID_TARGET),
      progressMutation("forbidden", "forbidden", VALID_TARGET),
      progressMutation("persistence", "persistence", VALID_TARGET),
    ]);
    return { failures, unsupported };
  });
const expectFailureResults = (
  unsupported: PushWatchStatesResponse,
  failures: PushWatchStatesResponse,
  progressDispatched: boolean,
): void => {
  const failureStatuses = failures.results.map(({ status }) => status);
  expect(unsupported.results[FIRST_RESULT_INDEX]?.status).toBe(
    WatchStateMutationStatus.UNSUPPORTED,
  );
  expect(failureStatuses).toEqual(EXPECTED_FAILURE_STATUSES);
  expect(progressDispatched).toBe(false);
  expect(JSON.stringify(failures)).not.toContain(RAW_ERROR_SENTINEL);
};

const progressFailuresTest = () => {
  const program = Effect.gen(function* failureScenario() {
    const coherent = yield* controlledJellyfin(coherentFailureHandler);
    const playbackOnly = yield* controlledJellyfin(playbackOnlyHandler);
    const supervisor = yield* PluginSupervisor;
    const coherentPlugin = yield* superviseJellyfin(supervisor, coherent, {
      providerInstanceId: "coherent-progress-failures",
    });
    const playbackOnlyPlugin = yield* superviseJellyfin(supervisor, playbackOnly, {
      providerInstanceId: "playback-only-progress",
    });
    const { failures, unsupported } = yield* exerciseFailures(coherentPlugin, playbackOnlyPlugin);
    const progressDispatched = playbackOnly.requests.some(({ url }) =>
      url.includes("/Nama/v1/progress"),
    );
    expectFailureResults(unsupported, failures, progressDispatched);
  }).pipe(Effect.provide(PluginSupervisor.layer()));
  return Effect.scoped(program);
};

it.live(
  "gates coherent progress and normalizes malformed, stale, missing, forbidden, and failed targets",
  progressFailuresTest,
);
