// oxlint-disable eslint/max-lines-per-function, eslint/max-statements, eslint/no-magic-numbers, unicorn/max-nested-calls -- The ordered real-provider proof keeps one subprocess lifecycle, exact fixture values, and watched-state transitions visible.
import { join } from "node:path";

import { expect, it } from "@effect/vitest";
import {
  ArtworkAuthorizationScope,
  LibraryService,
  ListConsistency,
} from "@nama/api/nama/plugin/v1/library_pb.js";
import { DynamicRange, MediaKind, SourceAvailability } from "@nama/api/nama/plugin/v1/media_pb.js";
import type { ProviderMediaItem } from "@nama/api/nama/plugin/v1/media_pb.js";
import {
  PluginConnectionStatus,
  PluginService,
  ProviderCapability,
} from "@nama/api/nama/plugin/v1/plugin_pb.js";
import {
  WatchStateConsistency,
  WatchStateMutationStatus,
  WatchStateReadStatus,
  WatchStateService,
} from "@nama/api/nama/plugin/v1/watch_state_pb.js";
import type {
  ProviderWatchState,
  WatchStateMutationResult,
  WatchStateReadResult,
} from "@nama/api/nama/plugin/v1/watch_state_pb.js";
import { Effect } from "effect";

import { PluginSupervisor } from "../../src/plugin/supervisor.ts";
import { provisionJellyfin } from "./provider-durable-loop.test-support.ts";

const JELLYFIN_PLUGIN_PATH = join(import.meta.dirname, "../../../../plugins/jellyfin/src/main.ts");
const CALL_DEADLINE_MILLISECONDS = 10_000;
const TEST_TIMEOUT_MILLISECONDS = 120_000;
const EXPECTED_CAPABILITIES = [
  ProviderCapability.LIBRARY_READ,
  ProviderCapability.ARTWORK_RESOLVE,
  ProviderCapability.WATCH_STATE_READ,
  ProviderCapability.WATCHED_WRITE,
];
const MOVIE_TITLE = "Nama Proof Movie (2026)";
const EPISODE_TITLE = "Nama Proof Show S01E02";
const FIXTURE_RUNTIME_SECONDS = 1n;

interface AppliedMutationExpectation {
  readonly itemId: string;
  readonly mutationId: string;
  readonly watched: boolean;
}

const required = <Value>(value: Value | undefined, description: string): Value => {
  if (value === undefined) {
    throw new Error(`${description} was absent`);
  }
  return value;
};

const itemNamed = (
  items: readonly ProviderMediaItem[],
  title: string,
  kind: MediaKind,
): ProviderMediaItem =>
  required(
    items.find((item) => item.title === title && item.kind === kind),
    `${title} observation`,
  );

const expectNormalizedSource = (item: ProviderMediaItem): void => {
  expect(item.runtime).toMatchObject({ nanos: 0, seconds: FIXTURE_RUNTIME_SECONDS });
  expect(item.sources).toHaveLength(1);
  const source = required(item.sources[0], `${item.title} source`);
  expect(source).toMatchObject({
    availability: SourceAvailability.AVAILABLE,
    runtime: { nanos: 0, seconds: FIXTURE_RUNTIME_SECONDS },
  });
  expect(source.parts).toHaveLength(1);
  const part = required(source.parts[0], `${item.title} part`);
  expect(part.container).toBe("mp4");
  expect(part.runtime).toMatchObject({ nanos: 0, seconds: FIXTURE_RUNTIME_SECONDS });
  expect(part.sizeBytes).toBeGreaterThan(0n);
  expect(part.tracks).toHaveLength(2);
  expect(part.tracks.map(({ details }) => details.case)).toEqual(["video", "audio"]);
  expect(part.tracks[0]?.details).toMatchObject({
    case: "video",
    value: {
      codec: "h264",
      dynamicRange: DynamicRange.SDR,
      height: 90,
      width: 160,
    },
  });
  expect(part.tracks[1]?.details).toMatchObject({
    case: "audio",
    value: {
      channelCount: 1,
      codec: "aac",
      isDefault: true,
      sampleRateHz: 48_000,
    },
  });
};

const expectUnwatchedState = (state: ProviderWatchState, itemId: string): void => {
  expect(state).toMatchObject({
    duration: { nanos: 0, seconds: FIXTURE_RUNTIME_SECONDS },
    itemReference: { itemId },
    watched: false,
  });
  expect(state.observedAt).toBeDefined();
  expect(state.position).toBeUndefined();
  expect(state.providerActivity).toBeUndefined();
  expect(state.revision).toBeUndefined();
};

const expectFoundRead = (result: WatchStateReadResult, itemId: string): void => {
  expect(result).toMatchObject({ itemReference: { itemId }, status: WatchStateReadStatus.FOUND });
  expectUnwatchedState(required(result.state, `${itemId} targeted watch state`), itemId);
};

const expectAppliedMutation = (
  result: WatchStateMutationResult,
  expected: AppliedMutationExpectation,
): void => {
  const { itemId, mutationId, watched } = expected;
  expect(result).toMatchObject({
    mutationId,
    observedState: { itemReference: { itemId }, watched },
    status: WatchStateMutationStatus.APPLIED,
  });
  expect(result.observedState?.observedAt).toBeDefined();
};

it.live.skipIf(process.env["NAMA_TEST_JELLYFIN_URL"] === undefined)(
  "proves the complete adapter against Jellyfin 10.11.11",
  () =>
    Effect.scoped(
      Effect.gen(function* realJellyfinAdapterProof() {
        const jellyfin = yield* provisionJellyfin;
        const supervisor = yield* PluginSupervisor;
        const plugin = yield* supervisor.supervise(
          {
            arguments: [JELLYFIN_PLUGIN_PATH],
            executable: process.execPath,
            expectedProviderType: "jellyfin",
            stderrEvents: [],
          },
          {
            configuration: { base_url: jellyfin.baseUrl, user_id: jellyfin.primaryUserId },
            credentials: { api_key: jellyfin.primaryApiKey },
            kind: "instance",
            providerInstanceId: "real-jellyfin-provider-instance",
            revision: "real-jellyfin-revision-1",
          },
        );

        const info = yield* plugin.call(
          PluginService.method.getInfo,
          {},
          CALL_DEADLINE_MILLISECONDS,
        );
        expect(info.pluginInfo?.capabilities).toEqual(EXPECTED_CAPABILITIES);

        const connection = yield* plugin.call(
          PluginService.method.getConnection,
          {},
          CALL_DEADLINE_MILLISECONDS,
        );
        expect(connection.connection).toMatchObject({
          capabilities: EXPECTED_CAPABILITIES,
          remoteVersion: "10.11.11",
          status: PluginConnectionStatus.CONNECTED,
        });

        const catalog = yield* plugin.call(
          LibraryService.method.listItems,
          { scan: { case: "begin", value: { pageSize: 100 } } },
          CALL_DEADLINE_MILLISECONDS,
        );
        expect(catalog).toMatchObject({
          complete: true,
          consistency: ListConsistency.BEST_EFFORT_SCAN,
        });
        expect(catalog.nextPageToken).toBeUndefined();
        const catalogMovie = itemNamed(catalog.items, MOVIE_TITLE, MediaKind.MOVIE);
        const catalogEpisode = itemNamed(catalog.items, EPISODE_TITLE, MediaKind.EPISODE);
        expectNormalizedSource(catalogMovie);
        expectNormalizedSource(catalogEpisode);

        const movie = required(
          (yield* plugin.call(
            LibraryService.method.getItem,
            { itemReference: catalogMovie.itemReference },
            CALL_DEADLINE_MILLISECONDS,
          )).item,
          "targeted movie observation",
        );
        const episode = required(
          (yield* plugin.call(
            LibraryService.method.getItem,
            { itemReference: catalogEpisode.itemReference },
            CALL_DEADLINE_MILLISECONDS,
          )).item,
          "targeted episode observation",
        );
        expectNormalizedSource(movie);
        expectNormalizedSource(episode);
        expect(episode.kindDetails).toMatchObject({
          case: "episode",
          value: { episodeNumber: 2, seasonNumber: 1 },
        });

        const artworkReference = required(movie.artwork[0]?.artworkReference, "movie artwork");
        const artwork = yield* plugin.call(
          LibraryService.method.resolveArtwork,
          { artworkReference, maxHeight: 96, maxWidth: 64 },
          CALL_DEADLINE_MILLISECONDS,
        );
        const lease = required(artwork.lease, "resolved artwork lease");
        expect(lease).toMatchObject({
          allowedRedirectOrigins: [new URL(jellyfin.baseUrl).origin],
          authorizationScope: ArtworkAuthorizationScope.PUBLIC,
          headers: [],
          mimeType: "image/jpeg",
        });
        expect(lease.accessExpiresAt).toBeUndefined();
        const anonymousArtwork = yield* Effect.promise(() =>
          fetch(lease.url, { redirect: "manual" }),
        );
        expect(anonymousArtwork.status).toBe(200);
        expect(anonymousArtwork.headers.get("location")).toBeNull();
        expect(anonymousArtwork.headers.get("content-type")).toMatch(/^image\/jpeg\b/u);

        const watchScan = yield* plugin.call(
          WatchStateService.method.listWatchStates,
          { scan: { case: "begin", value: { pageSize: 100 } } },
          CALL_DEADLINE_MILLISECONDS,
        );
        expect(watchScan).toMatchObject({
          complete: true,
          consistency: WatchStateConsistency.BEST_EFFORT_SCAN,
        });
        expect(watchScan.nextPageToken).toBeUndefined();
        expect(watchScan.states).toHaveLength(2);
        const movieItemReference = required(movie.itemReference, "movie item reference");
        const episodeItemReference = required(episode.itemReference, "episode item reference");
        const movieItemId = movieItemReference.itemId;
        const episodeItemId = episodeItemReference.itemId;
        expectUnwatchedState(
          required(
            watchScan.states.find(({ itemReference }) => itemReference?.itemId === movieItemId),
            "scanned movie watch state",
          ),
          movieItemId,
        );
        expectUnwatchedState(
          required(
            watchScan.states.find(({ itemReference }) => itemReference?.itemId === episodeItemId),
            "scanned episode watch state",
          ),
          episodeItemId,
        );

        const targetedStates = yield* plugin.call(
          WatchStateService.method.getWatchStates,
          { itemReferences: [movieItemReference, episodeItemReference] },
          CALL_DEADLINE_MILLISECONDS,
        );
        expect(targetedStates.results).toHaveLength(2);
        expectFoundRead(required(targetedStates.results[0], "targeted movie result"), movieItemId);
        expectFoundRead(
          required(targetedStates.results[1], "targeted episode result"),
          episodeItemId,
        );

        const watched = yield* plugin.call(
          WatchStateService.method.pushWatchStates,
          {
            batchId: "batch-mark-watched",
            mutations: [
              {
                itemReference: { itemId: movieItemId },
                mutationId: "mark-watched",
                target: { case: "setWatched", value: { watched: true } },
              },
            ],
          },
          CALL_DEADLINE_MILLISECONDS,
        );
        expectAppliedMutation(required(watched.results[0], "watched mutation result"), {
          itemId: movieItemId,
          mutationId: "mark-watched",
          watched: true,
        });
        const watchedReadback = yield* plugin.call(
          WatchStateService.method.getWatchStates,
          { itemReferences: [{ itemId: movieItemId }] },
          CALL_DEADLINE_MILLISECONDS,
        );
        expect(watchedReadback.results[0]).toMatchObject({
          state: { itemReference: { itemId: movieItemId }, watched: true },
          status: WatchStateReadStatus.FOUND,
        });

        const unwatched = yield* plugin.call(
          WatchStateService.method.pushWatchStates,
          {
            batchId: "batch-mark-unwatched",
            mutations: [
              {
                itemReference: { itemId: movieItemId },
                mutationId: "mark-unwatched",
                target: { case: "setWatched", value: { watched: false } },
              },
            ],
          },
          CALL_DEADLINE_MILLISECONDS,
        );
        expectAppliedMutation(required(unwatched.results[0], "unwatched mutation result"), {
          itemId: movieItemId,
          mutationId: "mark-unwatched",
          watched: false,
        });
        const finalReadback = yield* plugin.call(
          WatchStateService.method.getWatchStates,
          { itemReferences: [{ itemId: movieItemId }] },
          CALL_DEADLINE_MILLISECONDS,
        );
        expectFoundRead(
          required(finalReadback.results[0], "final unwatched readback"),
          movieItemId,
        );
      }).pipe(Effect.provide(PluginSupervisor.layer())),
    ),
  TEST_TIMEOUT_MILLISECONDS,
);
