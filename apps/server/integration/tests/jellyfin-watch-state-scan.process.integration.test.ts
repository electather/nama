import type { ServerResponse } from "node:http";

import { Code } from "@connectrpc/connect";
import { expect, it } from "@effect/vitest";
import { LibraryService } from "@nama/api/nama/plugin/v1/library_pb.js";
import {
  ProviderActivityReliability,
  ProviderActivitySemantics,
  WatchStateConsistency,
  WatchStateService,
} from "@nama/api/nama/plugin/v1/watch_state_pb.js";
import type {
  ListWatchStatesResponse,
  ProviderWatchState,
} from "@nama/api/nama/plugin/v1/watch_state_pb.js";
import { Effect } from "effect";
import { TestClock } from "effect/testing";

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
const IDLE_RETIREMENT_MILLISECONDS = 30_000;
const MILLISECONDS_PER_SECOND = 1000;
const WATCHED_MOVIE_ID = "watched-movie";
const UNWATCHED_EPISODE_ID = "unwatched-episode";
const LAST_PLAYED_DATE = "2026-08-19T21:14:15.123Z";
const LAST_PLAYED_SECONDS = BigInt(
  Math.floor(Date.parse(LAST_PLAYED_DATE) / MILLISECONDS_PER_SECOND),
);
const LAST_PLAYED_NANOSECONDS = 123_000_000;
const TICKS_PER_SECOND = 10_000_000;
const NANOSECONDS_PER_TICK = 100;
const ZERO_TICKS = 0;
const POSITION_TICKS = 12_345_678;
const DURATION_TICKS = 72_000_000_000;
const MAXIMUM_SCAN_RESPONSE_BYTES = 16_777_216;
const WATCH_PAGE_SIZE = 2;
const CATALOG_PAGE_SIZE = 1;
const DEFAULT_REQUESTED_PAGE_SIZE = 0;
const MAXIMUM_ACCEPTED_PAGE_SIZE = 100;
const EXCESSIVE_PAGE_SIZE = 101;
const FIRST_CODE_UNIT_LENGTH = 1;
const HTTP_OK = 200;
const HTTP_FORBIDDEN = 403;
const HTTP_NOT_FOUND = 404;
const HTTP_UNAVAILABLE = 503;
const FORBIDDEN_PAGE_SIZE = 5;
const UNAVAILABLE_PAGE_SIZE = 6;
const MALFORMED_JSON_PAGE_SIZE = 7;
const OVERSIZED_PAGE_SIZE = 8;
const CANCELED_PAGE_SIZE = 9;
const MALFORMED_ITEM_PAGE_SIZE = 10;
const PROVIDER_TOTAL_SENTINEL = 999;
const CROSS_SCOPE_PROVIDER_REQUEST_COUNT = 2;
const SINGLE_CANCELED_REQUEST_COUNT = 1;
const PROVIDER_ERROR_SENTINEL = "private-watch-scan-provider-error";
const OVERSIZED_RESPONSE_SENTINEL = "private-watch-scan-oversized-response";
const PLUGIN_SUPERVISOR_LAYER = PluginSupervisor.layer();

const WATCH_STATE_RESPONSES = [
  {
    Id: WATCHED_MOVIE_ID,
    RunTimeTicks: DURATION_TICKS,
    Type: "Movie",
    UserData: {
      LastPlayedDate: LAST_PLAYED_DATE,
      PlaybackPositionTicks: POSITION_TICKS,
      Played: true,
    },
  },
  {
    Id: UNWATCHED_EPISODE_ID,
    Type: "Episode",
    UserData: {
      PlaybackPositionTicks: ZERO_TICKS,
      Played: false,
    },
  },
] as const;
const [WATCHED_MOVIE_RESPONSE] = WATCH_STATE_RESPONSES;
const CATALOG_RESPONSES = [
  {
    Id: "catalog-movie",
    MediaSources: [],
    Name: "Catalog movie",
    PlayAccess: "Full",
    Type: "Movie",
  },
] as const;

type FailureResponder = (response: ServerResponse) => void;
type FailureResponse = FailureResponder | "pending";
const FAILURE_RESPONDER_BY_PAGE_SIZE: Readonly<Record<number, FailureResponse>> = {
  [FORBIDDEN_PAGE_SIZE]: (response) => {
    respondRaw(response, HTTP_FORBIDDEN, `${PROVIDER_ERROR_SENTINEL}:${API_KEY}`);
  },
  [UNAVAILABLE_PAGE_SIZE]: (response) => {
    respondRaw(response, HTTP_UNAVAILABLE, `${PROVIDER_ERROR_SENTINEL}:${API_KEY}`);
  },
  [MALFORMED_JSON_PAGE_SIZE]: (response) => {
    respondRaw(response, HTTP_OK, `{${PROVIDER_ERROR_SENTINEL}`);
  },
  [OVERSIZED_PAGE_SIZE]: (response) => {
    respondJson(response, {
      Items: [
        {
          ...WATCHED_MOVIE_RESPONSE,
          Padding: `${OVERSIZED_RESPONSE_SENTINEL}:${"x".repeat(MAXIMUM_SCAN_RESPONSE_BYTES)}`,
        },
      ],
    });
  },
  [CANCELED_PAGE_SIZE]: "pending",
  [MALFORMED_ITEM_PAGE_SIZE]: (response) => {
    respondJson(response, {
      Items: [{ Id: WATCHED_MOVIE_ID, Type: "Movie" }],
    });
  },
};

const respondScanFailure = (pageSize: number, response: ServerResponse): boolean => {
  const responder = FAILURE_RESPONDER_BY_PAGE_SIZE[pageSize];
  if (responder === undefined) {
    return false;
  }
  if (responder === "pending") {
    return true;
  }
  responder(response);
  return true;
};
const providerItemsFor = (endpoint: URL): readonly unknown[] => {
  if (endpoint.searchParams.get("enableUserData") === "false") {
    return CATALOG_RESPONSES;
  }
  return WATCH_STATE_RESPONSES;
};

const handleJellyfinRequest: ControlledHandler = (_request, response, observation) => {
  const endpoint = new URL(observation.url, "http://jellyfin.invalid");
  if (
    endpoint.pathname !== "/jellyfin/Items" ||
    observation.authorization !== `MediaBrowser Token="${API_KEY}"`
  ) {
    respondRaw(response, HTTP_NOT_FOUND, "");
    return;
  }
  const pageSize = Number(endpoint.searchParams.get("limit"));
  if (respondScanFailure(pageSize, response)) {
    return;
  }
  const startIndex = Number(endpoint.searchParams.get("startIndex"));
  const providerItems = providerItemsFor(endpoint);
  respondJson(response, {
    Items: providerItems.slice(startIndex, startIndex + pageSize),
    TotalRecordCount: PROVIDER_TOTAL_SENTINEL,
  });
};

const acquireControlledJellyfin = controlledJellyfin(handleJellyfinRequest);

const beginWatchStateScan = (
  plugin: SupervisedPlugin,
  pageSize: number,
  deadlineMilliseconds = CALL_DEADLINE_MILLISECONDS,
) =>
  plugin.call(
    WatchStateService.method.listWatchStates,
    { scan: { case: "begin", value: { pageSize } } },
    deadlineMilliseconds,
  );

const continueWatchStateScan = (plugin: SupervisedPlugin, continuation: string) =>
  plugin.call(
    WatchStateService.method.listWatchStates,
    { scan: { case: "continuation", value: continuation } },
    CALL_DEADLINE_MILLISECONDS,
  );

const continuationFrom = (response: ListWatchStatesResponse): string => {
  if (response.nextPageToken === undefined) {
    throw new Error("Jellyfin watch-state continuation was absent");
  }
  return response.nextPageToken;
};

interface CallTimeBounds {
  readonly afterSeconds: bigint;
  readonly beforeSeconds: bigint;
}

const expectWatchedMovie = (movie: ProviderWatchState | undefined): void => {
  expect(movie).toMatchObject({
    duration: { nanos: ZERO_TICKS, seconds: BigInt(DURATION_TICKS / TICKS_PER_SECOND) },
    itemReference: { itemId: WATCHED_MOVIE_ID },
    position: {
      nanos: (POSITION_TICKS % TICKS_PER_SECOND) * NANOSECONDS_PER_TICK,
      seconds: BigInt(Math.floor(POSITION_TICKS / TICKS_PER_SECOND)),
    },
    providerActivity: {
      occurredAt: {
        nanos: LAST_PLAYED_NANOSECONDS,
        seconds: LAST_PLAYED_SECONDS,
      },
      reliability: ProviderActivityReliability.HEURISTIC,
      semantics: ProviderActivitySemantics.UNKNOWN,
    },
    watched: true,
  });
  expect(movie?.revision).toBeUndefined();
};

const expectDefaultUnwatchedEpisode = (episode: ProviderWatchState | undefined): void => {
  expect(episode).toMatchObject({
    itemReference: { itemId: UNWATCHED_EPISODE_ID },
    watched: false,
  });
  expect(episode?.position).toBeUndefined();
  expect(episode?.duration).toBeUndefined();
  expect(episode?.providerActivity).toBeUndefined();
  expect(episode?.revision).toBeUndefined();
};

const expectObservationTime = (
  movie: ProviderWatchState | undefined,
  episode: ProviderWatchState | undefined,
  bounds: CallTimeBounds,
): void => {
  expect(movie?.observedAt).toEqual(episode?.observedAt);
  expect(movie?.observedAt?.seconds).toBeGreaterThanOrEqual(bounds.beforeSeconds);
  expect(movie?.observedAt?.seconds).toBeLessThanOrEqual(bounds.afterSeconds);
};

const expectNormalizedStates = (
  response: ListWatchStatesResponse,
  bounds: CallTimeBounds,
): void => {
  expect(response.states).toHaveLength(WATCH_PAGE_SIZE);
  const [movie, episode] = response.states;
  expectWatchedMovie(movie);
  expectDefaultUnwatchedEpisode(episode);
  expectObservationTime(movie, episode, bounds);
};

const expectFirstScanPage = (response: ListWatchStatesResponse, bounds: CallTimeBounds): void => {
  expect(response.complete).toBe(false);
  expect(response.consistency).toBe(WatchStateConsistency.BEST_EFFORT_SCAN);
  expectNormalizedStates(response, bounds);
};

const expectCompleteScanPage = (response: ListWatchStatesResponse): void => {
  expect(response).toMatchObject({
    complete: true,
    consistency: WatchStateConsistency.BEST_EFFORT_SCAN,
    states: [],
  });
  expect(response.nextPageToken).toBeUndefined();
};

const observedWatchRequest = ({ authorization, url }: ControlledJellyfin["requests"][number]) => {
  const endpoint = new URL(url, "http://jellyfin.invalid");
  return {
    authorization,
    pathname: endpoint.pathname,
    query: Object.fromEntries(endpoint.searchParams),
  };
};

const expectedWatchRequest = (startIndex: string) => ({
  authorization: `MediaBrowser Token="${API_KEY}"`,
  pathname: "/jellyfin/Items",
  query: {
    collapseBoxSetItems: "false",
    enableImages: "false",
    enableTotalRecordCount: "false",
    enableUserData: "true",
    includeItemTypes: "Movie,Episode",
    limit: String(WATCH_PAGE_SIZE),
    recursive: "true",
    sortBy: "SortName",
    sortOrder: "Ascending",
    startIndex,
    userId: USER_ID,
  },
});

const expectWatchScanRequests = (jellyfin: ControlledJellyfin): void => {
  const observed = jellyfin.requests.map((request) => observedWatchRequest(request));
  const expected = ["0", "2"].map((startIndex) => expectedWatchRequest(startIndex));
  expect(observed).toEqual(expected);
};

const expectDefaultPage = (response: ListWatchStatesResponse): void => {
  expect(response.complete).toBe(true);
  expect(response.states.map((state) => state.itemReference?.itemId)).toEqual([
    WATCHED_MOVIE_ID,
    UNWATCHED_EPISODE_ID,
  ]);
};

const expectPageSizeRequests = (jellyfin: ControlledJellyfin): void => {
  const limits = jellyfin.requests.map(({ url }) => {
    const endpoint = new URL(url, "http://jellyfin.invalid");
    return endpoint.searchParams.get("limit");
  });
  expect(limits).toEqual(["50", "100"]);
};

const tamperedToken = (token: string): string => {
  let replacementCharacter = "A";
  if (token.startsWith(replacementCharacter)) {
    replacementCharacter = "B";
  }
  return `${replacementCharacter}${token.slice(FIRST_CODE_UNIT_LENGTH)}`;
};

const expectInvalidWatchContinuation = (plugin: SupervisedPlugin, token: string) =>
  Effect.gen(function* invalidWatchContinuationScenario() {
    const failure = yield* continueWatchStateScan(plugin, token).pipe(Effect.flip);
    expect(failure).toMatchObject({ _tag: "PluginRpcError", code: Code.InvalidArgument });
  });

const expectInvalidCatalogContinuation = (plugin: SupervisedPlugin, token: string) =>
  Effect.gen(function* invalidCatalogContinuationScenario() {
    const failure = yield* plugin
      .call(
        LibraryService.method.listItems,
        { scan: { case: "continuation", value: token } },
        CALL_DEADLINE_MILLISECONDS,
      )
      .pipe(Effect.flip);
    expect(failure).toMatchObject({ _tag: "PluginRpcError", code: Code.InvalidArgument });
  });

const catalogContinuationFrom = (plugin: SupervisedPlugin) =>
  Effect.gen(function* catalogContinuationScenario() {
    const page = yield* plugin.call(
      LibraryService.method.listItems,
      { scan: { case: "begin", value: { pageSize: CATALOG_PAGE_SIZE } } },
      CALL_DEADLINE_MILLISECONDS,
    );
    if (page.nextPageToken === undefined) {
      throw new Error("Jellyfin catalog continuation was absent");
    }
    return page.nextPageToken;
  });

const FAILURE_CASES = [
  [FORBIDDEN_PAGE_SIZE, Code.PermissionDenied],
  [UNAVAILABLE_PAGE_SIZE, Code.Unavailable],
  [MALFORMED_JSON_PAGE_SIZE, Code.Internal],
  [OVERSIZED_PAGE_SIZE, Code.Internal],
  [MALFORMED_ITEM_PAGE_SIZE, Code.Internal],
] as const;

const expectSafeScanFailures = (plugin: SupervisedPlugin) =>
  Effect.gen(function* safeScanFailureScenarios() {
    for (const [pageSize, code] of FAILURE_CASES) {
      const failure = yield* beginWatchStateScan(plugin, pageSize).pipe(Effect.flip);
      expect(failure).toMatchObject({ _tag: "PluginRpcError", code });
      const serializedFailure = JSON.stringify(failure);
      expect(serializedFailure).not.toContain(API_KEY);
      expect(serializedFailure).not.toContain(PROVIDER_ERROR_SENTINEL);
      expect(serializedFailure).not.toContain(OVERSIZED_RESPONSE_SENTINEL);
    }
  });

const expectCanceledScanFailure = (plugin: SupervisedPlugin) =>
  Effect.gen(function* canceledScanFailureScenario() {
    const failure = yield* beginWatchStateScan(
      plugin,
      CANCELED_PAGE_SIZE,
      CANCELLATION_DEADLINE_MILLISECONDS,
    ).pipe(Effect.flip);
    expect(failure).toMatchObject({ _tag: "PluginDeadlineExceeded" });
    expect(JSON.stringify(failure)).not.toContain(API_KEY);
  });
const firstScanPageWithBounds = (plugin: SupervisedPlugin) =>
  Effect.gen(function* firstScanPageWithBoundsScenario() {
    const beforeSeconds = BigInt(Math.floor(Date.now() / MILLISECONDS_PER_SECOND));
    const response = yield* beginWatchStateScan(plugin, WATCH_PAGE_SIZE);
    const afterSeconds = BigInt(Math.floor(Date.now() / MILLISECONDS_PER_SECOND));
    return { bounds: { afterSeconds, beforeSeconds }, response };
  });

it.effect("resumes a normalized full watch-state scan after plugin replacement", () =>
  Effect.scoped(
    Effect.gen(function* jellyfinWatchStateScanScenario() {
      const jellyfin = yield* acquireControlledJellyfin;
      const supervisor = yield* PluginSupervisor;
      const plugin = yield* superviseJellyfin(supervisor, jellyfin);
      const { bounds, response: first } = yield* firstScanPageWithBounds(plugin);
      expectFirstScanPage(first, bounds);
      yield* TestClock.adjust(IDLE_RETIREMENT_MILLISECONDS);
      const complete = yield* continueWatchStateScan(plugin, continuationFrom(first));
      expectCompleteScanPage(complete);
      expectWatchScanRequests(jellyfin);
    }).pipe(Effect.provide(PLUGIN_SUPERVISOR_LAYER)),
  ),
);

it.live(
  "defaults watch-state pages to 50, accepts 100, and rejects larger requests",
  () =>
    Effect.scoped(
      Effect.gen(function* jellyfinWatchStatePageBoundsScenario() {
        const jellyfin = yield* acquireControlledJellyfin;
        const supervisor = yield* PluginSupervisor;
        const plugin = yield* superviseJellyfin(supervisor, jellyfin);
        const defaultPage = yield* beginWatchStateScan(plugin, DEFAULT_REQUESTED_PAGE_SIZE);
        expectDefaultPage(defaultPage);
        const maximumPage = yield* beginWatchStateScan(plugin, MAXIMUM_ACCEPTED_PAGE_SIZE);
        expect(maximumPage.complete).toBe(true);
        const excessiveFailure = yield* beginWatchStateScan(plugin, EXCESSIVE_PAGE_SIZE).pipe(
          Effect.flip,
        );
        expect(excessiveFailure).toMatchObject({
          _tag: "PluginRpcError",
          code: Code.InvalidArgument,
        });
        expectPageSizeRequests(jellyfin);
      }).pipe(Effect.provide(PLUGIN_SUPERVISOR_LAYER)),
    ),
  TEST_TIMEOUT_MILLISECONDS,
);

it.live(
  "rejects tampered and cross-scope watch-state continuations",
  () =>
    Effect.scoped(
      Effect.gen(function* jellyfinWatchStateContinuationBindingScenario() {
        const jellyfin = yield* acquireControlledJellyfin;
        const supervisor = yield* PluginSupervisor;
        const plugin = yield* superviseJellyfin(supervisor, jellyfin);
        const first = yield* beginWatchStateScan(plugin, CATALOG_PAGE_SIZE);
        const watchToken = continuationFrom(first);
        yield* expectInvalidWatchContinuation(plugin, tamperedToken(watchToken));
        const catalogToken = yield* catalogContinuationFrom(plugin);
        yield* expectInvalidWatchContinuation(plugin, catalogToken);
        yield* expectInvalidCatalogContinuation(plugin, watchToken);
        expect(jellyfin.requests).toHaveLength(CROSS_SCOPE_PROVIDER_REQUEST_COUNT);
      }).pipe(Effect.provide(PLUGIN_SUPERVISOR_LAYER)),
    ),
  TEST_TIMEOUT_MILLISECONDS,
);

it.live(
  "returns safe visible failures for unsuccessful watch-state scans",
  () =>
    Effect.scoped(
      Effect.gen(function* jellyfinWatchStateScanFailureScenario() {
        const jellyfin = yield* acquireControlledJellyfin;
        const supervisor = yield* PluginSupervisor;
        const plugin = yield* superviseJellyfin(supervisor, jellyfin);
        yield* expectSafeScanFailures(plugin);
        yield* expectCanceledScanFailure(plugin);
        expect(jellyfin.requests).toHaveLength(
          FAILURE_CASES.length + SINGLE_CANCELED_REQUEST_COUNT,
        );
      }).pipe(Effect.provide(PLUGIN_SUPERVISOR_LAYER)),
    ),
  TEST_TIMEOUT_MILLISECONDS,
);
