import type { ServerResponse } from "node:http";

import type { MessageInitShape } from "@bufbuild/protobuf";
import { expect, it } from "@effect/vitest";
import { PluginService, ProviderCapability } from "@nama/api/nama/plugin/v1/plugin_pb.js";
import {
  WatchStateMutationStatus,
  WatchStateService,
} from "@nama/api/nama/plugin/v1/watch_state_pb.js";
import type { WatchStateMutationSchema } from "@nama/api/nama/plugin/v1/watch_state_pb.js";
import { Effect } from "effect";

import type { SupervisedPlugin } from "../../src/plugin/model.ts";
import { PluginSupervisor } from "../../src/plugin/supervisor.ts";
import {
  API_KEY,
  USER_ID,
  controlledJellyfin,
  respondJson,
  respondRaw,
  superviseJellyfin,
} from "./jellyfin-process.test-support.ts";
import type {
  ControlledHandler,
  ControlledJellyfin,
  ObservedRequest,
} from "./jellyfin-process.test-support.ts";

const CALL_DEADLINE_MILLISECONDS = 2000;
const TIMED_OUT_CALL_DEADLINE_MILLISECONDS = 1000;
const TEST_TIMEOUT_MILLISECONDS = 10_000;
const HTTP_OK = 200;
const HTTP_BAD_REQUEST = 400;
const HTTP_FORBIDDEN = 403;
const HTTP_NOT_FOUND = 404;
const HTTP_UNAVAILABLE = 503;
const FIRST_INDEX = 0;
const MAXIMUM_CONCURRENT_MUTATIONS = 4;
const CONCURRENCY_MEMBER_COUNT = 8;
const MAXIMUM_MEDIA_RESPONSE_BYTES = 16_777_216;
const INDEX_INCREMENT = 1;
const SINGLE_PROVIDER_REQUEST = 1;
const INITIAL_AND_READBACK_REQUESTS = 2;
const MUTATION_WITH_READBACK_REQUESTS = 3;
const NORMALIZED_TARGET_COUNT = 4;
const APPLIED_WRITE_COUNT = 2;
const PROGRESS_POSITION_SECONDS = 1n;
const NEGATIVE_DURATION_SECONDS = -1n;
const OVERSIZED_RESPONSE_SENTINEL = "oversized-mutation-response-sentinel";
const MALFORMED_RESPONSE_SENTINEL = "malformed-mutation-response-sentinel";
const RETRYABLE_RESPONSE_SENTINEL = "retryable-mutation-response-sentinel";
const PERMANENT_RESPONSE_SENTINEL = "permanent-mutation-response-sentinel";
const FAILURE_RESPONSE_BY_ITEM: Readonly<
  Record<string, Readonly<{ body: string; statusCode: number }>>
> = {
  "write-forbidden": { body: "forbidden", statusCode: HTTP_FORBIDDEN },
  "write-malformed": { body: `{${MALFORMED_RESPONSE_SENTINEL}`, statusCode: HTTP_OK },
  "write-missing": { body: "missing", statusCode: HTTP_NOT_FOUND },
  "write-permanent": { body: PERMANENT_RESPONSE_SENTINEL, statusCode: HTTP_BAD_REQUEST },
  "write-retryable": { body: RETRYABLE_RESPONSE_SENTINEL, statusCode: HTTP_UNAVAILABLE },
};
const FAILURE_ITEM_IDS = [
  "write-missing",
  "write-forbidden",
  "write-retryable",
  "write-permanent",
  "write-malformed",
  "write-oversized",
] as const;
const EXPLICIT_RESULT_SUMMARIES = [
  {
    mutationId: "already-watched-mutation",
    status: WatchStateMutationStatus.ALREADY_APPLIED,
    watched: true,
  },
  {
    mutationId: "already-unwatched-mutation",
    status: WatchStateMutationStatus.ALREADY_APPLIED,
    watched: false,
  },
  {
    mutationId: "apply-watched-mutation",
    status: WatchStateMutationStatus.APPLIED,
    watched: true,
  },
  {
    mutationId: "apply-unwatched-mutation",
    status: WatchStateMutationStatus.APPLIED,
    watched: false,
  },
  {
    mutationId: "progress-mutation",
    status: WatchStateMutationStatus.UNSUPPORTED,
    watched: undefined,
  },
];
const AMBIGUOUS_RESULT_SUMMARIES = [
  {
    mutationId: "committed-mutation",
    status: WatchStateMutationStatus.APPLIED,
    watched: true,
  },
  {
    mutationId: "unresolved-mutation",
    status: WatchStateMutationStatus.RETRYABLE_AMBIGUOUS,
    watched: false,
  },
];
const FAILURE_RESULT_SUMMARIES = [
  { status: WatchStateMutationStatus.NOT_FOUND, watched: undefined },
  { status: WatchStateMutationStatus.FORBIDDEN, watched: undefined },
  { status: WatchStateMutationStatus.RETRYABLE_FAILURE, watched: undefined },
  { status: WatchStateMutationStatus.PERMANENT_FAILURE, watched: undefined },
  { status: WatchStateMutationStatus.RETRYABLE_AMBIGUOUS, watched: false },
  { status: WatchStateMutationStatus.APPLIED, watched: true },
];

interface MutationCallResponse {
  readonly results: readonly {
    readonly mutationId: string;
    readonly observedState?:
      | {
          readonly observedAt?: unknown;
          readonly watched: boolean;
        }
      | undefined;
    readonly status: WatchStateMutationStatus;
  }[];
}
interface ConcurrencyObservation {
  active: number;
  maximum: number;
  requests: number;
}
interface PendingWrite {
  readonly itemId: string;
  readonly response: ServerResponse;
}
interface BoundedMutationState {
  readonly pendingWrites: PendingWrite[];
  readonly watchedByItem: Map<string, boolean>;
  readonly writeObservation: ConcurrencyObservation;
}
type MutationInput = MessageInitShape<typeof WatchStateMutationSchema>;
const respondWatchState = (response: ServerResponse, itemId: string, watched: boolean): void => {
  let itemType = "Movie";
  if (itemId.includes("episode")) {
    itemType = "Episode";
  }
  respondJson(response, {
    Id: itemId,
    Type: itemType,
    UserData: { PlaybackPositionTicks: 0, Played: watched },
  });
};
const respondMutationState = (response: ServerResponse, itemId: string, watched: boolean): void => {
  respondJson(response, {
    ItemId: itemId,
    Key: itemId,
    PlaybackPositionTicks: 0,
    Played: watched,
  });
};

const watchedMutation = (mutationId: string, itemId: string, watched: boolean): MutationInput => ({
  itemReference: { itemId },
  mutationId,
  target: { case: "setWatched", value: { watched } },
});
const progressMutation = (mutationId: string, itemId: string): MutationInput => ({
  itemReference: { itemId },
  mutationId,
  target: {
    case: "setProgress",
    value: { position: { nanos: 0, seconds: PROGRESS_POSITION_SECONDS }, watched: false },
  },
});
const pushWatchStates = (
  plugin: SupervisedPlugin,
  mutations: readonly MutationInput[],
  deadlineMilliseconds = CALL_DEADLINE_MILLISECONDS,
) =>
  plugin.call(
    WatchStateService.method.pushWatchStates,
    { batchId: "batch-identity", mutations: [...mutations] },
    deadlineMilliseconds,
  );

const itemIdFromUrl = (url: string, segment: "Items" | "UserPlayedItems"): string | undefined => {
  const endpoint = new URL(url, "http://controlled-jellyfin");
  const prefix = `/jellyfin/${segment}/`;
  if (!endpoint.pathname.startsWith(prefix)) {
    return undefined;
  }
  return decodeURIComponent(endpoint.pathname.slice(prefix.length));
};
const expectAuthorizedRequests = (requests: readonly ObservedRequest[]): void => {
  expect(
    requests.every(({ authorization }) => authorization === `MediaBrowser Token="${API_KEY}"`),
  ).toBe(true);
};
const respondNotFound = (response: ServerResponse): void => {
  response.statusCode = HTTP_NOT_FOUND;
  response.end();
};
const respondKnownCurrentState = (
  watchedByItem: ReadonlyMap<string, boolean>,
  response: ServerResponse,
  observation: ObservedRequest,
): boolean => {
  const itemId = itemIdFromUrl(observation.url, "Items");
  let watched: boolean | undefined = undefined;
  if (itemId !== undefined) {
    watched = watchedByItem.get(itemId);
  }
  if (observation.method !== "GET" || itemId === undefined || watched === undefined) {
    return false;
  }
  respondWatchState(response, itemId, watched);
  return true;
};
const respondSuccessfulWatchedMutation = (
  watchedByItem: Map<string, boolean>,
  response: ServerResponse,
  observation: ObservedRequest,
): boolean => {
  const itemId = itemIdFromUrl(observation.url, "UserPlayedItems");
  if (itemId === undefined || (observation.method !== "POST" && observation.method !== "DELETE")) {
    return false;
  }
  const watched = observation.method === "POST";
  watchedByItem.set(itemId, watched);
  respondMutationState(response, itemId, watched);
  return true;
};
const explicitTargetHandler =
  (watchedByItem: Map<string, boolean>): ControlledHandler =>
  (_request, response, observation) => {
    if (
      respondKnownCurrentState(watchedByItem, response, observation) ||
      respondSuccessfulWatchedMutation(watchedByItem, response, observation)
    ) {
      return;
    }
    respondNotFound(response);
  };
const expectExplicitTargetResults = (response: MutationCallResponse): void => {
  expect(
    response.results.map(({ mutationId, observedState, status }) => ({
      mutationId,
      status,
      watched: observedState?.watched,
    })),
  ).toEqual(EXPLICIT_RESULT_SUMMARIES);
  expect(
    response.results
      .slice(FIRST_INDEX, NORMALIZED_TARGET_COUNT)
      .every(({ observedState }) => observedState?.observedAt !== undefined),
  ).toBe(true);
};
const expectExplicitTargetRequests = (jellyfin: ControlledJellyfin): void => {
  const writes = jellyfin.requests.filter(({ method }) => method !== "GET");
  expect(writes).toHaveLength(APPLIED_WRITE_COUNT);
  expect(writes).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        method: "POST",
        url: `/jellyfin/UserPlayedItems/apply-watched?userId=${USER_ID}`,
      }),
      expect.objectContaining({
        method: "DELETE",
        url: `/jellyfin/UserPlayedItems/apply-unwatched-episode?userId=${USER_ID}`,
      }),
    ]),
  );
  expect(jellyfin.requests.some(({ url }) => url.includes("progress-item"))).toBe(false);
  expectAuthorizedRequests(jellyfin.requests);
};

const explicitTargetsTest = () => {
  const watchedByItem = new Map<string, boolean>([
    ["already-watched", true],
    ["already-unwatched-episode", false],
    ["apply-watched", false],
    ["apply-unwatched-episode", true],
  ]);
  const handler = explicitTargetHandler(watchedByItem);
  const program = Effect.gen(function* explicitTargetsScenario() {
    const jellyfin = yield* controlledJellyfin(handler);
    const supervisor = yield* PluginSupervisor;
    const plugin = yield* superviseJellyfin(supervisor, jellyfin);
    const info = yield* plugin.call(PluginService.method.getInfo, {}, CALL_DEADLINE_MILLISECONDS);
    expect(info.pluginInfo?.capabilities).toEqual([
      ProviderCapability.LIBRARY_READ,
      ProviderCapability.ARTWORK_RESOLVE,
      ProviderCapability.WATCH_STATE_READ,
      ProviderCapability.WATCHED_WRITE,
    ]);

    const response = yield* pushWatchStates(plugin, [
      watchedMutation("already-watched-mutation", "already-watched", true),
      watchedMutation("already-unwatched-mutation", "already-unwatched-episode", false),
      watchedMutation("apply-watched-mutation", "apply-watched", true),
      watchedMutation("apply-unwatched-mutation", "apply-unwatched-episode", false),
      progressMutation("progress-mutation", "progress-item"),
    ]);

    expectExplicitTargetResults(response);
    expectExplicitTargetRequests(jellyfin);
  }).pipe(Effect.provide(PluginSupervisor.layer()));
  return Effect.scoped(program);
};

const CONFLICTING_MUTATIONS: readonly MutationInput[] = [
  watchedMutation("duplicate-mutation", "duplicate-id-first", true),
  watchedMutation("duplicate-mutation", "duplicate-id-second", false),
  watchedMutation("duplicate-target-first", "duplicate-target", true),
  watchedMutation("duplicate-target-second", "duplicate-target", false),
  progressMutation("progress-mutation", "progress-item"),
  {
    itemReference: { itemId: "missing-progress-position" },
    mutationId: "missing-progress-position",
    target: { case: "setProgress", value: { watched: false } },
  },
  {
    itemReference: { itemId: "negative-progress-position" },
    mutationId: "negative-progress-position",
    target: {
      case: "setProgress",
      value: {
        position: { nanos: 0, seconds: NEGATIVE_DURATION_SECONDS },
        watched: false,
      },
    },
  },
  {
    itemReference: { itemId: "negative-progress-duration" },
    mutationId: "negative-progress-duration",
    target: {
      case: "setProgress",
      value: {
        duration: { nanos: 0, seconds: NEGATIVE_DURATION_SECONDS },
        position: { nanos: 0, seconds: PROGRESS_POSITION_SECONDS },
        watched: false,
      },
    },
  },
  { ...watchedMutation("", "missing-mutation-id", true), mutationId: "" },
  {
    mutationId: "missing-item-reference",
    target: { case: "setWatched", value: { watched: true } },
  },
  { itemReference: { itemId: "missing-target" }, mutationId: "missing-target" },
  watchedMutation("independent-mutation", "independent-item", false),
];
const CONFLICTING_RESULT_SUMMARIES = [
  { mutationId: "duplicate-mutation", status: WatchStateMutationStatus.INVALID },
  { mutationId: "duplicate-mutation", status: WatchStateMutationStatus.INVALID },
  { mutationId: "duplicate-target-first", status: WatchStateMutationStatus.INVALID },
  { mutationId: "duplicate-target-second", status: WatchStateMutationStatus.INVALID },
  { mutationId: "progress-mutation", status: WatchStateMutationStatus.UNSUPPORTED },
  { mutationId: "missing-progress-position", status: WatchStateMutationStatus.INVALID },
  { mutationId: "negative-progress-position", status: WatchStateMutationStatus.INVALID },
  { mutationId: "negative-progress-duration", status: WatchStateMutationStatus.INVALID },
  { mutationId: "", status: WatchStateMutationStatus.INVALID },
  { mutationId: "missing-item-reference", status: WatchStateMutationStatus.INVALID },
  { mutationId: "missing-target", status: WatchStateMutationStatus.INVALID },
  { mutationId: "independent-mutation", status: WatchStateMutationStatus.ALREADY_APPLIED },
];
const conflictingMemberHandler: ControlledHandler = (_request, response, observation) => {
  const itemId = itemIdFromUrl(observation.url, "Items");
  if (observation.method === "GET" && itemId === "independent-item") {
    respondWatchState(response, itemId, false);
    return;
  }
  respondNotFound(response);
};

const conflictingMembersTest = () => {
  const handler = conflictingMemberHandler;
  const program = Effect.gen(function* conflictingMembersScenario() {
    const jellyfin = yield* controlledJellyfin(handler);
    const supervisor = yield* PluginSupervisor;
    const plugin = yield* superviseJellyfin(supervisor, jellyfin);
    const response = yield* pushWatchStates(plugin, CONFLICTING_MUTATIONS);

    expect(response.results.map(({ mutationId, status }) => ({ mutationId, status }))).toEqual(
      CONFLICTING_RESULT_SUMMARIES,
    );
    expect(jellyfin.requests).toEqual([
      {
        authorization: `MediaBrowser Token="${API_KEY}"`,
        method: "GET",
        url: `/jellyfin/Items/independent-item?userId=${USER_ID}`,
      },
      {
        authorization: `MediaBrowser Token="${API_KEY}"`,
        method: "GET",
        url: "/jellyfin/Nama/v1/handshake",
      },
    ]);
  }).pipe(Effect.provide(PluginSupervisor.layer()));
  return Effect.scoped(program);
};

const completeNextBoundedWrite = (state: BoundedMutationState): void => {
  const pending = state.pendingWrites.shift();
  if (pending === undefined) {
    throw new Error("Pending Jellyfin mutation response is unavailable");
  }
  state.writeObservation.active -= INDEX_INCREMENT;
  respondMutationState(pending.response, pending.itemId, true);
};
const releaseBoundedWrites = (state: BoundedMutationState): void => {
  if (state.pendingWrites.length === MAXIMUM_CONCURRENT_MUTATIONS) {
    completeNextBoundedWrite(state);
  }
  if (state.writeObservation.requests === CONCURRENCY_MEMBER_COUNT) {
    while (state.pendingWrites.length > FIRST_INDEX) {
      completeNextBoundedWrite(state);
    }
  }
};
const respondBoundedWrite = (
  state: BoundedMutationState,
  response: ServerResponse,
  observation: ObservedRequest,
): boolean => {
  const itemId = itemIdFromUrl(observation.url, "UserPlayedItems");
  if (observation.method !== "POST" || itemId === undefined) {
    return false;
  }
  state.writeObservation.active += INDEX_INCREMENT;
  state.writeObservation.requests += INDEX_INCREMENT;
  state.writeObservation.maximum = Math.max(
    state.writeObservation.maximum,
    state.writeObservation.active,
  );
  state.watchedByItem.set(itemId, true);
  state.pendingWrites.push({ itemId, response });
  releaseBoundedWrites(state);
  return true;
};
const boundedMutationHandler =
  (state: BoundedMutationState): ControlledHandler =>
  (_request, response, observation) => {
    if (
      respondKnownCurrentState(state.watchedByItem, response, observation) ||
      respondBoundedWrite(state, response, observation)
    ) {
      return;
    }
    respondNotFound(response);
  };
const createBoundedMutationState = (): BoundedMutationState => {
  const state: BoundedMutationState = {
    pendingWrites: [],
    watchedByItem: new Map(),
    writeObservation: { active: FIRST_INDEX, maximum: FIRST_INDEX, requests: FIRST_INDEX },
  };
  for (let index = FIRST_INDEX; index < CONCURRENCY_MEMBER_COUNT; index += INDEX_INCREMENT) {
    state.watchedByItem.set(`bounded-${index}`, false);
  }
  return state;
};

const boundedMutationTest = () => {
  const state = createBoundedMutationState();
  const handler = boundedMutationHandler(state);
  const program = Effect.gen(function* boundedMutationScenario() {
    const jellyfin = yield* controlledJellyfin(handler);
    const supervisor = yield* PluginSupervisor;
    const plugin = yield* superviseJellyfin(supervisor, jellyfin);
    const mutations = Array.from({ length: CONCURRENCY_MEMBER_COUNT }, (_unused, index) =>
      watchedMutation(`bounded-mutation-${index}`, `bounded-${index}`, true),
    );
    const response = yield* pushWatchStates(plugin, mutations);

    expect(response.results.map(({ mutationId, status }) => ({ mutationId, status }))).toEqual(
      mutations.map(({ mutationId }) => ({
        mutationId,
        status: WatchStateMutationStatus.APPLIED,
      })),
    );
    expect(state.writeObservation).toEqual({
      active: FIRST_INDEX,
      maximum: MAXIMUM_CONCURRENT_MUTATIONS,
      requests: CONCURRENCY_MEMBER_COUNT,
    });
    expect(jellyfin.requests.filter(({ method }) => method === "GET")).toHaveLength(
      CONCURRENCY_MEMBER_COUNT,
    );
  }).pipe(Effect.provide(PluginSupervisor.layer()));
  return Effect.scoped(program);
};

const respondLostMutation = (
  watchedByItem: Map<string, boolean>,
  response: ServerResponse,
  observation: ObservedRequest,
): boolean => {
  const itemId = itemIdFromUrl(observation.url, "UserPlayedItems");
  if (observation.method !== "POST" || itemId === undefined) {
    return false;
  }
  if (itemId === "committed-lost-response") {
    watchedByItem.set(itemId, true);
  }
  response.destroy();
  return true;
};
const ambiguousMutationHandler =
  (watchedByItem: Map<string, boolean>): ControlledHandler =>
  (_request, response, observation) => {
    if (
      respondKnownCurrentState(watchedByItem, response, observation) ||
      respondLostMutation(watchedByItem, response, observation)
    ) {
      return;
    }
    respondNotFound(response);
  };
const expectAmbiguousMutationResults = (
  response: MutationCallResponse,
  requests: readonly ObservedRequest[],
): void => {
  expect(
    response.results.map(({ mutationId, observedState, status }) => ({
      mutationId,
      status,
      watched: observedState?.watched,
    })),
  ).toEqual(AMBIGUOUS_RESULT_SUMMARIES);
  for (const itemId of ["committed-lost-response", "unresolved-lost-response"]) {
    expect(requests.filter(({ url }) => url.includes(`/Items/${itemId}?`))).toHaveLength(
      INITIAL_AND_READBACK_REQUESTS,
    );
    expect(requests.filter(({ url }) => url.includes(`/UserPlayedItems/${itemId}?`))).toHaveLength(
      SINGLE_PROVIDER_REQUEST,
    );
  }
};

const ambiguousMutationTest = () => {
  const watchedByItem = new Map<string, boolean>([
    ["committed-lost-response", false],
    ["unresolved-lost-response", false],
  ]);
  const handler = ambiguousMutationHandler(watchedByItem);
  const program = Effect.gen(function* ambiguousMutationScenario() {
    const jellyfin = yield* controlledJellyfin(handler);
    const supervisor = yield* PluginSupervisor;
    const plugin = yield* superviseJellyfin(supervisor, jellyfin);
    const response = yield* pushWatchStates(plugin, [
      watchedMutation("committed-mutation", "committed-lost-response", true),
      watchedMutation("unresolved-mutation", "unresolved-lost-response", true),
    ]);

    expectAmbiguousMutationResults(response, jellyfin.requests);
  }).pipe(Effect.provide(PluginSupervisor.layer()));
  return Effect.scoped(program);
};
const timedOutMutationTest = () => {
  const watchedByItem = new Map<string, boolean>([["timed-out-response", false]]);
  const handler: ControlledHandler = (_request, response, observation) => {
    if (respondKnownCurrentState(watchedByItem, response, observation)) {
      return;
    }
    const itemId = itemIdFromUrl(observation.url, "UserPlayedItems");
    if (observation.method === "POST" && itemId === "timed-out-response") {
      watchedByItem.set(itemId, true);
      return;
    }
    respondNotFound(response);
  };
  const program = Effect.gen(function* timedOutMutationScenario() {
    const jellyfin = yield* controlledJellyfin(handler);
    const supervisor = yield* PluginSupervisor;
    const plugin = yield* superviseJellyfin(supervisor, jellyfin);
    yield* plugin.call(PluginService.method.getInfo, {}, CALL_DEADLINE_MILLISECONDS);
    const response = yield* pushWatchStates(
      plugin,
      [watchedMutation("timed-out-mutation", "timed-out-response", true)],
      TIMED_OUT_CALL_DEADLINE_MILLISECONDS,
    );
    expect(
      response.results.map(({ observedState, status }) => ({
        status,
        watched: observedState?.watched,
      })),
    ).toEqual([{ status: WatchStateMutationStatus.APPLIED, watched: true }]);
    expect(jellyfin.requests.filter(({ method }) => method === "GET")).toHaveLength(
      INITIAL_AND_READBACK_REQUESTS,
    );
    expect(jellyfin.requests.filter(({ method }) => method === "POST")).toHaveLength(
      SINGLE_PROVIDER_REQUEST,
    );
  }).pipe(Effect.provide(PluginSupervisor.layer()));
  return Effect.scoped(program);
};

const respondOversizedMutation = (
  watchedByItem: Map<string, boolean>,
  response: ServerResponse,
  itemId: string,
): boolean => {
  if (itemId !== "write-oversized") {
    return false;
  }
  watchedByItem.set(itemId, true);
  respondJson(response, {
    Padding: `${OVERSIZED_RESPONSE_SENTINEL}:${"x".repeat(MAXIMUM_MEDIA_RESPONSE_BYTES)}`,
  });
  return true;
};

const respondFailureWrite = (
  watchedByItem: Map<string, boolean>,
  response: ServerResponse,
  observation: ObservedRequest,
): boolean => {
  const itemId = itemIdFromUrl(observation.url, "UserPlayedItems");
  if (observation.method !== "POST" || itemId === undefined) {
    return false;
  }
  if (respondOversizedMutation(watchedByItem, response, itemId)) {
    return true;
  }
  const failure = FAILURE_RESPONSE_BY_ITEM[itemId];
  if (failure === undefined) {
    return false;
  }
  respondRaw(response, failure.statusCode, failure.body);
  return true;
};
const failureMutationHandler =
  (watchedByItem: Map<string, boolean>): ControlledHandler =>
  (_request, response, observation) => {
    if (
      respondKnownCurrentState(watchedByItem, response, observation) ||
      respondFailureWrite(watchedByItem, response, observation)
    ) {
      return;
    }
    respondNotFound(response);
  };
const expectSafeFailureResponse = (response: MutationCallResponse): void => {
  const returned = JSON.stringify(response, (_key, value: unknown) => {
    if (typeof value === "bigint") {
      return value.toString();
    }
    return value;
  });
  for (const sentinel of [
    API_KEY,
    MALFORMED_RESPONSE_SENTINEL,
    OVERSIZED_RESPONSE_SENTINEL,
    RETRYABLE_RESPONSE_SENTINEL,
    PERMANENT_RESPONSE_SENTINEL,
  ]) {
    expect(returned).not.toContain(sentinel);
  }
};
const expectFailureNormalization = (
  response: MutationCallResponse,
  requests: readonly ObservedRequest[],
): void => {
  expect(
    response.results.map(({ observedState, status }) => ({
      status,
      watched: observedState?.watched,
    })),
  ).toEqual(FAILURE_RESULT_SUMMARIES);
  for (const itemId of ["write-malformed", "write-oversized"]) {
    expect(requests.filter(({ url }) => url.includes(itemId))).toHaveLength(
      MUTATION_WITH_READBACK_REQUESTS,
    );
  }
  expectSafeFailureResponse(response);
};

const failureNormalizationTest = () => {
  const watchedByItem = new Map<string, boolean>(FAILURE_ITEM_IDS.map((itemId) => [itemId, false]));
  const handler = failureMutationHandler(watchedByItem);
  const program = Effect.gen(function* failureNormalizationScenario() {
    const jellyfin = yield* controlledJellyfin(handler);
    const supervisor = yield* PluginSupervisor;
    const plugin = yield* superviseJellyfin(supervisor, jellyfin);
    const response = yield* pushWatchStates(
      plugin,
      [...watchedByItem.keys()].map((itemId) =>
        watchedMutation(`${itemId}-mutation`, itemId, true),
      ),
    );

    expectFailureNormalization(response, jellyfin.requests);
  }).pipe(Effect.provide(PluginSupervisor.layer()));
  return Effect.scoped(program);
};

const cancelledMutationTest = () => {
  const handler: ControlledHandler = (_request, response, observation) => {
    const itemId = itemIdFromUrl(observation.url, "Items");
    if (observation.method === "GET" && itemId === "hanging-mutation") {
      return;
    }
    respondNotFound(response);
  };
  const program = Effect.gen(function* cancelledMutationScenario() {
    const jellyfin = yield* controlledJellyfin(handler);
    const supervisor = yield* PluginSupervisor;
    const plugin = yield* superviseJellyfin(supervisor, jellyfin);
    yield* plugin.call(PluginService.method.getInfo, {}, CALL_DEADLINE_MILLISECONDS);
    const response = yield* pushWatchStates(
      plugin,
      [watchedMutation("hanging-mutation", "hanging-mutation", true)],
      TIMED_OUT_CALL_DEADLINE_MILLISECONDS,
    );
    expect(response.results.map(({ mutationId, status }) => ({ mutationId, status }))).toEqual([
      {
        mutationId: "hanging-mutation",
        status: WatchStateMutationStatus.RETRYABLE_FAILURE,
      },
    ]);
    expect(jellyfin.requests).toEqual([
      expect.objectContaining({
        method: "GET",
        url: `/jellyfin/Items/hanging-mutation?userId=${USER_ID}`,
      }),
    ]);
  }).pipe(Effect.provide(PluginSupervisor.layer()));
  return Effect.scoped(program);
};

it.live(
  "applies explicit watched and unwatched targets and rejects progress without a progress write",
  explicitTargetsTest,
  TEST_TIMEOUT_MILLISECONDS,
);
it.live(
  "rejects every conflicting or malformed member while applying independent members",
  conflictingMembersTest,
  TEST_TIMEOUT_MILLISECONDS,
);
it.live(
  "bounds independent watched mutations at four and preserves request order",
  boundedMutationTest,
  TEST_TIMEOUT_MILLISECONDS,
);
it.live(
  "reads back a lost mutation response once without replaying the write",
  ambiguousMutationTest,
  TEST_TIMEOUT_MILLISECONDS,
);
it.live(
  "normalizes provider mutation failures without leaking provider data",
  failureNormalizationTest,
  TEST_TIMEOUT_MILLISECONDS,
);
it.live(
  "normalizes a cancelled mutation pre-read per member",
  cancelledMutationTest,
  TEST_TIMEOUT_MILLISECONDS,
);
it.live(
  "reads back a timed-out mutation response before the caller deadline",
  timedOutMutationTest,
  TEST_TIMEOUT_MILLISECONDS,
);
