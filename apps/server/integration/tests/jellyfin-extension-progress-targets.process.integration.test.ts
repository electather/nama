import { expect, it } from "@effect/vitest";
import { WatchStateMutationStatus } from "@nama/api/nama/plugin/v1/watch_state_pb.js";
import { Effect } from "effect";

import type { SupervisedPlugin } from "../../src/plugin/model.ts";
import { PluginSupervisor } from "../../src/plugin/supervisor.ts";
import {
  extensionHandshake,
  isHandshakePath,
  isProgressPath,
  MEDIA_RUNTIME_SECONDS,
  parseJsonBody,
  progressMutation,
  pushProgress,
  respondProgressState,
  ticksFromDurationBody,
} from "./jellyfin-extension-progress.test-support.ts";
import type {
  JsonRecord,
  ProgressTarget,
  ProviderState,
} from "./jellyfin-extension-progress.test-support.ts";
import {
  USER_ID,
  controlledJellyfin,
  respondRaw,
  superviseJellyfin,
} from "./jellyfin-process.test-support.ts";
import type { ControlledHandler } from "./jellyfin-process.test-support.ts";

const FIRST_RESULT_INDEX = 0;

const HTTP_NOT_FOUND = 404;
const TARGETS: readonly ProgressTarget[] = [
  {
    duration: { nanos: 0, seconds: MEDIA_RUNTIME_SECONDS },
    position: { nanos: 0, seconds: 5n },
    watched: false,
  },
  {
    duration: { nanos: 0, seconds: MEDIA_RUNTIME_SECONDS },
    position: { nanos: 0, seconds: 5n },
    watched: false,
  },
  { position: { nanos: 0, seconds: 2n }, watched: false },
  { position: { nanos: 0, seconds: 10n }, watched: true },
  { position: { nanos: 0, seconds: 0n }, watched: false },
  { position: { nanos: 0, seconds: 3n }, watched: false },
];
const EXPECTED_STATUSES = [
  WatchStateMutationStatus.APPLIED,
  WatchStateMutationStatus.ALREADY_APPLIED,
  WatchStateMutationStatus.APPLIED,
  WatchStateMutationStatus.APPLIED,
  WatchStateMutationStatus.APPLIED,
  WatchStateMutationStatus.APPLIED,
];

const statefulHandler = (received: JsonRecord[]): ControlledHandler => {
  let state: ProviderState = { positionTicks: 0, watched: false };
  return (request, response, observation) => {
    if (isHandshakePath(observation)) {
      extensionHandshake(response);
      return;
    }
    if (!isProgressPath(observation)) {
      respondRaw(response, HTTP_NOT_FOUND, "missing");
      return;
    }
    parseJsonBody(request, response, (body) => {
      received.push(body);
      const next = {
        positionTicks: ticksFromDurationBody(body["position"]),
        watched: body["watched"] === true,
      };
      let status: "already_applied" | "applied" = "applied";
      if (next.positionTicks === state.positionTicks && next.watched === state.watched) {
        status = "already_applied";
      }
      state = next;
      respondProgressState({ itemId: String(body["item_id"]), response, state, status });
    });
  };
};

const exerciseTargets = (plugin: SupervisedPlugin) =>
  Effect.gen(function* targetTransitions() {
    const statuses: WatchStateMutationStatus[] = [];
    for (const [index, target] of TARGETS.entries()) {
      const result = yield* pushProgress(plugin, [
        progressMutation(`target-${index}`, "progress-item", target),
      ]);
      statuses.push(
        result.results[FIRST_RESULT_INDEX]?.status ?? WatchStateMutationStatus.UNSPECIFIED,
      );
    }
    return statuses;
  });

const progressTargetsTest = () => {
  const program = Effect.gen(function* coherentTargetScenario() {
    const received: JsonRecord[] = [];
    const jellyfin = yield* controlledJellyfin(statefulHandler(received));
    const supervisor = yield* PluginSupervisor;
    const plugin = yield* superviseJellyfin(supervisor, jellyfin);
    const statuses = yield* exerciseTargets(plugin);
    const positions = received.map((body) => body["position"]);
    const expectedPositions = TARGETS.map((target) => ({
      nanos: target.position.nanos,
      seconds: target.position.seconds.toString(),
    }));

    expect(statuses).toEqual(EXPECTED_STATUSES);
    expect(received[FIRST_RESULT_INDEX]).toEqual({
      duration: { nanos: 0, seconds: "10" },
      item_id: "progress-item",
      position: { nanos: 0, seconds: "5" },
      user_id: USER_ID,
      watched: false,
    });
    expect(positions).toEqual(expectedPositions);
  }).pipe(Effect.provide(PluginSupervisor.layer()));
  return Effect.scoped(program);
};

it.live(
  "preserves forward, backward, rewatch, watched, unwatched, and equal progress targets",
  progressTargetsTest,
);
