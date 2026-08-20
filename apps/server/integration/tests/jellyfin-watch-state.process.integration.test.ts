import type { ServerResponse } from "node:http";

import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { expect, it } from "@effect/vitest";
import { PluginService, ProviderCapability } from "@nama/api/nama/plugin/v1/plugin_pb.js";
import {
  ProviderActivityReliability,
  ProviderActivitySemantics,
  WatchStateReadStatus,
  WatchStateService,
} from "@nama/api/nama/plugin/v1/watch_state_pb.js";
import type {
  GetWatchStatesResponse,
  ProviderWatchState,
} from "@nama/api/nama/plugin/v1/watch_state_pb.js";
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
import type { ControlledHandler, ControlledJellyfin } from "./jellyfin-process.test-support.ts";

const CALL_DEADLINE_MILLISECONDS = 2000;
const CANCELLATION_DEADLINE_MILLISECONDS = 50;
const TEST_TIMEOUT_MILLISECONDS = 10_000;
const MILLISECONDS_PER_SECOND = 1000;
const MOVIE_ID = "movie-identity";
const EPISODE_ID = "episode-identity";
const LAST_PLAYED_DATE = "2026-08-19T21:14:15.123Z";
const NOT_FOUND_ID = "missing-identity";
const FORBIDDEN_ID = "forbidden-identity";
const RETRYABLE_ID = "retryable-identity";
const RATE_LIMITED_ID = "rate-limited-identity";
const MALFORMED_ID = "malformed-identity";
const OVERSIZED_ID = "oversized-identity";
const HANGING_ID = "hanging-identity";
const MALFORMED_RESPONSE_SENTINEL = "malformed-watch-state-sentinel";
const OVERSIZED_RESPONSE_SENTINEL = "oversized-watch-state-sentinel";
const UNAVAILABLE_RESPONSE_SENTINEL = "unavailable-watch-state-sentinel";
const RATE_LIMITED_RESPONSE_SENTINEL = "rate-limited-watch-state-sentinel";
const HTTP_OK = 200;
const HTTP_FORBIDDEN = 403;
const HTTP_RATE_LIMITED = 429;
const HTTP_UNAVAILABLE = 503;
const TICKS_PER_SECOND = 10_000_000;
const NANOSECONDS_PER_TICK = 100;
const POSITION_TICKS = 12_345_678;
const DURATION_TICKS = 72_000_000_000;
const MAXIMUM_MEDIA_RESPONSE_BYTES = 16_777_216;
const SINGLE_RESULT_COUNT = 1;
const REPEATED_REFERENCE_COUNT = 3;

interface ProviderItemReferenceInput {
  readonly itemId: string;
}

interface CallTimeBounds {
  readonly afterSeconds: bigint;
  readonly beforeSeconds: bigint;
}

const respondKnownWatchState = (url: string, response: ServerResponse): boolean => {
  if (url === `/jellyfin/Items/${MOVIE_ID}?userId=${USER_ID}`) {
    respondJson(response, {
      Id: MOVIE_ID,
      RunTimeTicks: DURATION_TICKS,
      Type: "Movie",
      UserData: {
        LastPlayedDate: LAST_PLAYED_DATE,
        PlaybackPositionTicks: POSITION_TICKS,
        Played: true,
      },
    });
    return true;
  }
  if (url === `/jellyfin/Items/${EPISODE_ID}?userId=${USER_ID}`) {
    respondJson(response, {
      Id: EPISODE_ID,
      Type: "Episode",
      UserData: {
        LastPlayedDate: "not-a-date",
        PlaybackPositionTicks: 0,
        Played: false,
      },
    });
    return true;
  }
  return false;
};

const respondMemberFailure = (url: string, response: ServerResponse): boolean => {
  if (url === `/jellyfin/Items/${FORBIDDEN_ID}?userId=${USER_ID}`) {
    respondRaw(response, HTTP_FORBIDDEN, "forbidden");
    return true;
  }
  if (url === `/jellyfin/Items/${HANGING_ID}?userId=${USER_ID}`) {
    return true;
  }
  return false;
};
const respondRetryableFailure = (url: string, response: ServerResponse): boolean => {
  if (url === `/jellyfin/Items/${RETRYABLE_ID}?userId=${USER_ID}`) {
    respondRaw(response, HTTP_UNAVAILABLE, UNAVAILABLE_RESPONSE_SENTINEL);
    return true;
  }
  if (url === `/jellyfin/Items/${RATE_LIMITED_ID}?userId=${USER_ID}`) {
    respondRaw(response, HTTP_RATE_LIMITED, RATE_LIMITED_RESPONSE_SENTINEL);
    return true;
  }
  return false;
};

const respondPermanentFailure = (url: string, response: ServerResponse): boolean => {
  if (url === `/jellyfin/Items/${MALFORMED_ID}?userId=${USER_ID}`) {
    respondRaw(response, HTTP_OK, `{${MALFORMED_RESPONSE_SENTINEL}`);
    return true;
  }
  if (url === `/jellyfin/Items/${OVERSIZED_ID}?userId=${USER_ID}`) {
    const body = JSON.stringify({
      Padding: `${OVERSIZED_RESPONSE_SENTINEL}:${"x".repeat(MAXIMUM_MEDIA_RESPONSE_BYTES)}`,
    });
    respondRaw(response, HTTP_OK, body);
    return true;
  }
  return false;
};
const handleJellyfinRequest: ControlledHandler = (_request, response, { url }) => {
  if (
    respondKnownWatchState(url, response) ||
    respondMemberFailure(url, response) ||
    respondRetryableFailure(url, response) ||
    respondPermanentFailure(url, response)
  ) {
    return;
  }
  response.statusCode = 404;
  response.end();
};

const acquireControlledJellyfin = controlledJellyfin(handleJellyfinRequest);

const callWatchStates = (
  plugin: SupervisedPlugin,
  itemReferences: readonly ProviderItemReferenceInput[],
  deadlineMilliseconds = CALL_DEADLINE_MILLISECONDS,
) =>
  plugin.call(
    WatchStateService.method.getWatchStates,
    { itemReferences: [...itemReferences] },
    deadlineMilliseconds,
  );

const expectMovieResponse = (
  response: GetWatchStatesResponse,
  jellyfin: ControlledJellyfin,
  timeBounds: CallTimeBounds,
): void => {
  const [result] = response.results;
  const state = result?.state;
  if (state === undefined) {
    throw new Error("Targeted watch state was absent");
  }
  expect(response.results).toHaveLength(SINGLE_RESULT_COUNT);
  expect(result).toMatchObject({
    itemReference: { itemId: MOVIE_ID },
    state: {
      duration: { nanos: 0, seconds: BigInt(DURATION_TICKS / TICKS_PER_SECOND) },
      itemReference: { itemId: MOVIE_ID },
      position: {
        nanos: (POSITION_TICKS % TICKS_PER_SECOND) * NANOSECONDS_PER_TICK,
        seconds: BigInt(Math.floor(POSITION_TICKS / TICKS_PER_SECOND)),
      },
      providerActivity: {
        occurredAt: timestampFromDate(new Date(LAST_PLAYED_DATE)),
        reliability: ProviderActivityReliability.HEURISTIC,
        semantics: ProviderActivitySemantics.UNKNOWN,
      },
      watched: true,
    },
    status: WatchStateReadStatus.FOUND,
  });
  expect(state.observedAt?.seconds).toBeGreaterThanOrEqual(timeBounds.beforeSeconds);
  expect(state.observedAt?.seconds).toBeLessThanOrEqual(timeBounds.afterSeconds);
  expect(state.revision).toBeUndefined();
  expect(jellyfin.requests).toEqual([
    {
      authorization: `MediaBrowser Token="${API_KEY}"`,
      method: "GET",
      url: `/jellyfin/Items/${MOVIE_ID}?userId=${USER_ID}`,
    },
  ]);
};

const expectSafeFailureResponse = (response: GetWatchStatesResponse): void => {
  const returned = JSON.stringify(response);
  expect(returned).not.toContain(API_KEY);
  expect(returned).not.toContain(MALFORMED_RESPONSE_SENTINEL);
  expect(returned).not.toContain(UNAVAILABLE_RESPONSE_SENTINEL);
  expect(returned).not.toContain(RATE_LIMITED_RESPONSE_SENTINEL);
  expect(returned).not.toContain(OVERSIZED_RESPONSE_SENTINEL);
};

const expectFailureResponse = (
  response: GetWatchStatesResponse,
  jellyfin: ControlledJellyfin,
  requestedCount: number,
): void => {
  const summaries = response.results.map(({ itemReference, state, status }) => ({
    itemId: itemReference?.itemId,
    state,
    status,
  }));
  expect(summaries).toEqual([
    { itemId: NOT_FOUND_ID, state: undefined, status: WatchStateReadStatus.NOT_FOUND },
    { itemId: FORBIDDEN_ID, state: undefined, status: WatchStateReadStatus.FORBIDDEN },
    { itemId: RETRYABLE_ID, state: undefined, status: WatchStateReadStatus.RETRYABLE_FAILURE },
    {
      itemId: RATE_LIMITED_ID,
      state: undefined,
      status: WatchStateReadStatus.RETRYABLE_FAILURE,
    },
    { itemId: MALFORMED_ID, state: undefined, status: WatchStateReadStatus.PERMANENT_FAILURE },
    { itemId: OVERSIZED_ID, state: undefined, status: WatchStateReadStatus.PERMANENT_FAILURE },
    { itemId: NOT_FOUND_ID, state: undefined, status: WatchStateReadStatus.NOT_FOUND },
  ]);
  expect(jellyfin.requests).toHaveLength(requestedCount);
  const requestsAreAuthorized = jellyfin.requests.every(
    ({ authorization }) => authorization?.includes(API_KEY) === true,
  );
  expect(requestsAreAuthorized).toBe(true);
  expectSafeFailureResponse(response);
};

const expectDefaultEpisodeState = (state: ProviderWatchState | undefined): void => {
  expect(state?.position).toBeUndefined();
  expect(state?.duration).toBeUndefined();
  expect(state?.providerActivity).toBeUndefined();
  expect(state?.revision).toBeUndefined();
};

const expectRepeatedResponse = (
  response: GetWatchStatesResponse,
  jellyfin: ControlledJellyfin,
): void => {
  const summaries = response.results.map(({ itemReference, state, status }) => ({
    itemId: itemReference?.itemId,
    status,
    watched: state?.watched,
  }));
  expect(summaries).toEqual([
    { itemId: EPISODE_ID, status: WatchStateReadStatus.FOUND, watched: false },
    { itemId: MOVIE_ID, status: WatchStateReadStatus.FOUND, watched: true },
    { itemId: EPISODE_ID, status: WatchStateReadStatus.FOUND, watched: false },
  ]);
  const [firstEpisodeResult, movieResult, repeatedEpisodeResult] = response.results;
  expectDefaultEpisodeState(firstEpisodeResult?.state);
  expect(firstEpisodeResult?.state?.observedAt).toEqual(movieResult?.state?.observedAt);
  expect(firstEpisodeResult?.state?.observedAt).toEqual(repeatedEpisodeResult?.state?.observedAt);
  expect(jellyfin.requests).toHaveLength(REPEATED_REFERENCE_COUNT);
};

const targetedMovieWatchStateTest = () => {
  const program = Effect.gen(function* targetedMovieWatchStateScenario() {
    const jellyfin = yield* acquireControlledJellyfin;
    const supervisor = yield* PluginSupervisor;
    const plugin = yield* superviseJellyfin(supervisor, jellyfin);
    const info = yield* plugin.call(PluginService.method.getInfo, {}, CALL_DEADLINE_MILLISECONDS);
    expect(info.pluginInfo?.capabilities).toEqual([
      ProviderCapability.LIBRARY_READ,
      ProviderCapability.ARTWORK_RESOLVE,
      ProviderCapability.WATCHED_WRITE,
    ]);
    const beforeCallSeconds = BigInt(Math.floor(Date.now() / MILLISECONDS_PER_SECOND));
    const response = yield* callWatchStates(plugin, [{ itemId: MOVIE_ID }]);
    const afterCallSeconds = BigInt(Math.floor(Date.now() / MILLISECONDS_PER_SECOND));
    expectMovieResponse(response, jellyfin, {
      afterSeconds: afterCallSeconds,
      beforeSeconds: beforeCallSeconds,
    });
  }).pipe(Effect.provide(PluginSupervisor.layer()));
  return Effect.scoped(program);
};

const targetedWatchStateFailureTest = () => {
  const program = Effect.gen(function* targetedWatchStateFailureScenario() {
    const jellyfin = yield* acquireControlledJellyfin;
    const supervisor = yield* PluginSupervisor;
    const plugin = yield* superviseJellyfin(supervisor, jellyfin);
    const itemReferences = [
      { itemId: NOT_FOUND_ID },
      { itemId: FORBIDDEN_ID },
      { itemId: RETRYABLE_ID },
      { itemId: RATE_LIMITED_ID },
      { itemId: MALFORMED_ID },
      { itemId: OVERSIZED_ID },
      { itemId: NOT_FOUND_ID },
    ];
    const response = yield* callWatchStates(plugin, itemReferences);
    expectFailureResponse(response, jellyfin, itemReferences.length);
  }).pipe(Effect.provide(PluginSupervisor.layer()));
  return Effect.scoped(program);
};

const repeatedTargetedWatchStateTest = () => {
  const program = Effect.gen(function* repeatedTargetedWatchStateScenario() {
    const jellyfin = yield* acquireControlledJellyfin;
    const supervisor = yield* PluginSupervisor;
    const plugin = yield* superviseJellyfin(supervisor, jellyfin);
    const response = yield* callWatchStates(plugin, [
      { itemId: EPISODE_ID },
      { itemId: MOVIE_ID },
      { itemId: EPISODE_ID },
    ]);
    expectRepeatedResponse(response, jellyfin);
  }).pipe(Effect.provide(PluginSupervisor.layer()));
  return Effect.scoped(program);
};

const cancelledTargetedWatchStateTest = () => {
  const program = Effect.gen(function* cancelledTargetedWatchStateScenario() {
    const jellyfin = yield* acquireControlledJellyfin;
    const supervisor = yield* PluginSupervisor;
    const plugin = yield* superviseJellyfin(supervisor, jellyfin);
    yield* plugin.call(PluginService.method.getInfo, {}, CALL_DEADLINE_MILLISECONDS);
    const failure = yield* callWatchStates(
      plugin,
      [{ itemId: HANGING_ID }],
      CANCELLATION_DEADLINE_MILLISECONDS,
    ).pipe(Effect.flip);
    expect(failure).toMatchObject({ _tag: "PluginDeadlineExceeded" });
    expect(jellyfin.requests).toEqual([
      {
        authorization: `MediaBrowser Token="${API_KEY}"`,
        method: "GET",
        url: `/jellyfin/Items/${HANGING_ID}?userId=${USER_ID}`,
      },
    ]);
  }).pipe(Effect.provide(PluginSupervisor.layer()));
  return Effect.scoped(program);
};

it.live(
  "normalizes a targeted movie watch state through the generated RPC",
  targetedMovieWatchStateTest,
  TEST_TIMEOUT_MILLISECONDS,
);
it.live(
  "distinguishes independent member failures in request order",
  targetedWatchStateFailureTest,
  TEST_TIMEOUT_MILLISECONDS,
);
it.live(
  "returns an ordered normalized result for every repeated reference",
  repeatedTargetedWatchStateTest,
  TEST_TIMEOUT_MILLISECONDS,
);
it.live(
  "propagates cancellation through a targeted provider read",
  cancelledTargetedWatchStateTest,
  TEST_TIMEOUT_MILLISECONDS,
);
