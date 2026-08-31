// oxlint-disable eslint/max-lines-per-function, eslint/max-statements, eslint/no-magic-numbers, import/max-dependencies, unicorn/max-nested-calls -- The ordered real-provider proof keeps one subprocess lifecycle, exact fixture values, and watched-state transitions visible across the real Jellyfin boundary.
import { join } from "node:path";

import { Code } from "@connectrpc/connect";
import { expect, it } from "@effect/vitest";
import {
  ArtworkAuthorizationScope,
  LibraryService,
  ListConsistency,
} from "@nama/api/nama/plugin/v1/library_pb.js";
import { DynamicRange, MediaKind, SourceAvailability } from "@nama/api/nama/plugin/v1/media_pb.js";
import type { ProviderMediaItem } from "@nama/api/nama/plugin/v1/media_pb.js";
import {
  DeliveryProtocol,
  PlaybackAuthorizationScope,
  PlaybackCloseReason,
  PlaybackQuality,
  PlaybackService,
  PlaybackState,
  PlaybackStrategy,
  SubtitlePreference,
} from "@nama/api/nama/plugin/v1/playback_pb.js";
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
import { Effect, Exit, Fiber } from "effect";

import { catalogPageFromPlugin } from "../../src/catalog/catalog-item-mapper.ts";
import { PluginSupervisor } from "../../src/plugin/supervisor.ts";
import { restartJellyfin } from "./jellyfin-extension-restart.test-support.ts";
import { acquireJellyfinFaultProxy } from "./jellyfin-fault-proxy.test-support.ts";
import { provisionJellyfin } from "./provider-durable-loop.test-support.ts";

const JELLYFIN_PLUGIN_PATH = join(import.meta.dirname, "../../../../plugins/jellyfin/src/main.ts");
const CALL_DEADLINE_MILLISECONDS = 10_000;
const EXPIRY_OBSERVATION_DELAY_MILLISECONDS = 1000;
const PLAN_EXPIRY_WAIT_MILLISECONDS = 301_000;
const SESSION_LIFETIME_MILLISECONDS = 1_801_000;
const TEST_TIMEOUT_MILLISECONDS = 2_100_000;
const STOCK_CAPABILITIES = [
  ProviderCapability.LIBRARY_READ,
  ProviderCapability.ARTWORK_RESOLVE,
  ProviderCapability.WATCH_STATE_READ,
  ProviderCapability.WATCHED_WRITE,
];
const EXPECTED_CAPABILITIES = [
  ...STOCK_CAPABILITIES,
  ProviderCapability.PLAYBACK_PLAN,
  ProviderCapability.PLAYBACK_OPEN,
  ProviderCapability.PLAYBACK_REPORT,
  ProviderCapability.PLAYBACK_REPORTS_USER_STATE,
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
const isUnknownRecord = (value: unknown): value is Readonly<Record<string, unknown>> => {
  if (typeof value !== "object" || !value || Array.isArray(value)) {
    return false;
  }
  return true;
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
  expect(part.tracks).toHaveLength(3);
  expect(part.tracks.map(({ details }) => details.case)).toEqual(["video", "audio", "audio"]);
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
      language: "eng",
      sampleRateHz: 48_000,
    },
  });
  expect(part.tracks[2]?.details).toMatchObject({
    case: "audio",
    value: {
      channelCount: 1,
      codec: "aac",
      isDefault: false,
      language: "spa",
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
        const faultProxy = yield* acquireJellyfinFaultProxy(jellyfin);
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
        expect(info.pluginInfo?.capabilities).toEqual(STOCK_CAPABILITIES);

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
        const canonicalPage = catalogPageFromPlugin(
          "real-jellyfin-provider-instance",
          "real-jellyfin-core-run",
          catalog,
        );
        expect(canonicalPage.items).toHaveLength(catalog.items.length);
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

        const markWatchedResponse = yield* plugin.call(
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
        expectAppliedMutation(required(markWatchedResponse.results[0], "watched mutation result"), {
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

        const markUnwatchedResponse = yield* plugin.call(
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
        expectAppliedMutation(
          required(markUnwatchedResponse.results[0], "unwatched mutation result"),
          {
            itemId: movieItemId,
            mutationId: "mark-unwatched",
            watched: false,
          },
        );
        const finalReadback = yield* plugin.call(
          WatchStateService.method.getWatchStates,
          { itemReferences: [{ itemId: movieItemId }] },
          CALL_DEADLINE_MILLISECONDS,
        );
        expectFoundRead(
          required(finalReadback.results[0], "final unwatched readback"),
          movieItemId,
        );

        const movieSource = required(movie.sources[0]?.sourceReference, "movie source reference");
        const moviePart = required(movie.sources[0]?.parts[0], "movie source part");
        const audioTrack = required(
          moviePart.tracks.find(
            ({ details }) => details.case === "audio" && details.value.isDefault,
          )?.trackReference,
          "movie default audio track",
        );
        const privatePlanInput = {
          capabilities: {
            direct_play_profiles: [
              { audio_codecs: ["aac"], container: "mp4", video_codec: "h264" },
            ],
            protocols: ["http_progressive"],
          },
          item_id: movieItemId,
          preferences: { quality: 1 },
          source_id: movieSource.sourceId,
          start_position: { nanos: 0, seconds: "0" },
          user_id: jellyfin.primaryUserId,
        };
        const ordinaryHandshakeProbe = yield* Effect.promise(() =>
          fetch(new URL("Nama/v1/handshake", jellyfin.baseUrl), {
            headers: {
              authorization: `MediaBrowser Token="${jellyfin.administratorAccessToken}"`,
            },
            redirect: "manual",
          }),
        );
        expect(ordinaryHandshakeProbe.status).toBe(403);
        const ordinaryPlanProbe = yield* Effect.promise(() =>
          fetch(new URL("Nama/v1/playback/plans", jellyfin.baseUrl), {
            body: JSON.stringify(privatePlanInput),
            headers: {
              authorization: `MediaBrowser Token="${jellyfin.administratorAccessToken}"`,
              "content-type": "application/json",
            },
            method: "POST",
            redirect: "manual",
          }),
        );
        expect(ordinaryPlanProbe.status).toBe(403);
        const privatePlanProbe = yield* Effect.promise(() =>
          fetch(new URL("Nama/v1/playback/plans", jellyfin.baseUrl), {
            body: JSON.stringify(privatePlanInput),
            headers: {
              authorization: `MediaBrowser Token="${jellyfin.primaryApiKey}"`,
              "content-type": "application/json",
            },
            method: "POST",
            redirect: "manual",
          }),
        );
        if (privatePlanProbe.status !== 200) {
          const failureBody = yield* Effect.promise(() => privatePlanProbe.text());
          throw new Error(
            `private extension plan failed: ${privatePlanProbe.status} ${failureBody}`,
          );
        }
        const privatePlanValue: unknown = yield* Effect.promise(() => privatePlanProbe.json());
        if (!isUnknownRecord(privatePlanValue)) {
          throw new Error("private extension plan response was not an object");
        }
        const privatePlanBody = privatePlanValue;
        const privatePlanId = privatePlanBody["plan_id"];
        if (typeof privatePlanId !== "string") {
          throw new TypeError("private extension plan identifier was not a string");
        }
        expect(Buffer.byteLength(privatePlanId, "utf8")).toBeLessThanOrEqual(256);
        expect({
          actions: privatePlanBody["actions"],
          audio_codec: privatePlanBody["audio_codec"],
          container: privatePlanBody["container"],
          default_audio_track_index: privatePlanBody["default_audio_track_index"],
          default_subtitle_track_index: privatePlanBody["default_subtitle_track_index"],
          expires_at_type: typeof privatePlanBody["expires_at"],
          plan_id_type: typeof privatePlanBody["plan_id"],
          protocol: privatePlanBody["protocol"],
          strategy: privatePlanBody["strategy"],
          tracks: privatePlanBody["tracks"],
          video_codec: privatePlanBody["video_codec"],
        }).toEqual({
          actions: [{ action: "copy", track_index: 1 }],
          audio_codec: "aac",
          container: "mp4",
          default_audio_track_index: 1,
          default_subtitle_track_index: undefined,
          expires_at_type: "string",
          plan_id_type: "string",
          protocol: "http_progressive",
          strategy: "direct",
          tracks: [
            {
              channels: 1,
              codec: "aac",
              index: 1,
              is_default: true,
              is_forced: false,
              language: "eng",
              type: "audio",
            },
          ],
          video_codec: "h264",
        });
        const directPlanRequest = {
          capabilities: {
            directPlayProfiles: [{ audioCodecs: ["aac"], container: "mp4", videoCodec: "h264" }],
            dynamicRanges: [DynamicRange.SDR],
            protocols: [DeliveryProtocol.HTTP_PROGRESSIVE],
            subtitleCapabilities: [],
          },
          itemReference: movieItemReference,
          preferences: {
            preferredAudioLanguages: [],
            preferredSubtitleLanguages: [],
            quality: PlaybackQuality.AUTO,
            subtitlePreference: SubtitlePreference.AUTO,
          },
          sourceReference: movieSource,
        };
        const planned = yield* plugin.call(
          PlaybackService.method.planPlayback,
          directPlanRequest,
          CALL_DEADLINE_MILLISECONDS,
        );
        const unopenedPlan = required(
          (yield* plugin.call(
            PlaybackService.method.planPlayback,
            directPlanRequest,
            CALL_DEADLINE_MILLISECONDS,
          )).plan,
          "unopened playback plan",
        );
        const plan = required(planned.plan, "direct-progressive playback plan");
        expect(plan).toMatchObject({
          audioCodec: "aac",
          container: "mp4",
          defaultSubtitle: { selection: { case: "disabled", value: true } },
          protocol: DeliveryProtocol.HTTP_PROGRESSIVE,
          strategy: PlaybackStrategy.DIRECT,
          videoCodec: "h264",
        });
        expect(plan.defaultAudioTrackReference).toEqual(audioTrack);
        const openStartedAt = Date.now();
        expect(plan.tracks).toHaveLength(1);
        const openRequest = {
          operationId: "real-extension-open",
          planId: plan.id,
          subtitle: plan.defaultSubtitle,
        };
        const opened = yield* plugin.call(
          PlaybackService.method.openPlayback,
          openRequest,
          CALL_DEADLINE_MILLISECONDS,
        );
        const openFinishedAt = Date.now();
        const replayedOpen = yield* plugin.call(
          PlaybackService.method.openPlayback,
          openRequest,
          CALL_DEADLINE_MILLISECONDS,
        );
        const playbackLease = required(opened.lease, "direct-progressive playback lease");
        expect(replayedOpen.lease).toEqual(playbackLease);
        const equivalentPlanId = Buffer.from(plan.id, "base64url").toString("base64");
        expect(equivalentPlanId).not.toBe(plan.id);
        const equivalentPlanFailure = yield* plugin
          .call(
            PlaybackService.method.openPlayback,
            {
              operationId: "equivalent-plan-open",
              planId: equivalentPlanId,
              subtitle: plan.defaultSubtitle,
            },
            CALL_DEADLINE_MILLISECONDS,
          )
          .pipe(
            Effect.flatMap(() => Effect.fail(new Error("equivalent plan opened twice"))),
            Effect.flip,
          );
        expect(equivalentPlanFailure).toMatchObject({
          _tag: "PluginRpcError",
          code: Code.FailedPrecondition,
        });
        yield* Effect.sleep(PLAN_EXPIRY_WAIT_MILLISECONDS);
        const replayedAfterPlanExpiry = yield* plugin.call(
          PlaybackService.method.openPlayback,
          openRequest,
          CALL_DEADLINE_MILLISECONDS,
        );
        expect(replayedAfterPlanExpiry.lease).toEqual(playbackLease);
        const leaseExpiry = required(playbackLease.expiresAt, "playback lease expiry");
        const leaseExpiryMilliseconds =
          Number(leaseExpiry.seconds) * 1000 + leaseExpiry.nanos / 1_000_000;
        expect(leaseExpiryMilliseconds).toBeGreaterThanOrEqual(
          openStartedAt + SESSION_LIFETIME_MILLISECONDS,
        );
        expect(leaseExpiryMilliseconds).toBeLessThanOrEqual(
          openFinishedAt + SESSION_LIFETIME_MILLISECONDS,
        );
        const expiredUnopenedPlanFailure = yield* plugin
          .call(
            PlaybackService.method.openPlayback,
            {
              operationId: "expired-unopened-plan",
              planId: unopenedPlan.id,
              subtitle: unopenedPlan.defaultSubtitle,
            },
            CALL_DEADLINE_MILLISECONDS,
          )
          .pipe(Effect.flip);
        expect(expiredUnopenedPlanFailure).toMatchObject({
          _tag: "PluginRpcError",
          code: Code.FailedPrecondition,
        });
        expect(playbackLease).toMatchObject({
          authorizationScope: PlaybackAuthorizationScope.SESSION,
          headers: [{ name: "X-Nama-Playback-Lease" }],
          mimeType: "video/mp4",
          protocol: DeliveryProtocol.HTTP_PROGRESSIVE,
          reportInterval: { nanos: 0, seconds: 15n },
        });
        expect(playbackLease.url).not.toContain(movieItemId);
        expect(playbackLease.url).not.toContain(movieSource.sourceId);
        expect(playbackLease.url).not.toContain(jellyfin.primaryApiKey);
        const unauthorizedMedia = yield* Effect.promise(() =>
          fetch(playbackLease.url, { redirect: "manual" }),
        );
        expect(unauthorizedMedia.status).toBe(401);
        const mediaHeaders = Object.fromEntries(
          playbackLease.headers.map(({ name, value }) => [name, value]),
        );
        const wrongResource = new URL(playbackLease.url);
        wrongResource.pathname += "-wrong";
        const wrongResourceMedia = yield* Effect.promise(() =>
          fetch(wrongResource, { headers: mediaHeaders, redirect: "manual" }),
        );
        expect(wrongResourceMedia.status).toBe(401);
        const leaseHeader = required(playbackLease.headers[0], "playback lease header");
        let tamperedLeaseHeaderValue = `${leaseHeader.value.slice(0, -1)}A`;
        if (tamperedLeaseHeaderValue === leaseHeader.value) {
          tamperedLeaseHeaderValue = `${leaseHeader.value.slice(0, -1)}B`;
        }
        expect(tamperedLeaseHeaderValue).not.toBe(leaseHeader.value);
        const tamperedLeaseMedia = yield* Effect.promise(() =>
          fetch(playbackLease.url, {
            headers: {
              [leaseHeader.name]: tamperedLeaseHeaderValue,
            },
            redirect: "manual",
          }),
        );
        expect(tamperedLeaseMedia.status).toBe(401);
        const authorizedHead = yield* Effect.promise(() =>
          fetch(playbackLease.url, {
            headers: mediaHeaders,
            method: "HEAD",
            redirect: "manual",
          }),
        );
        expect(authorizedHead.status).toBe(200);
        expect(authorizedHead.headers.get("location")).toBeNull();
        expect((yield* Effect.promise(() => authorizedHead.arrayBuffer())).byteLength).toBe(0);
        const authorizedMedia = yield* Effect.promise(() =>
          fetch(playbackLease.url, {
            headers: mediaHeaders,
            redirect: "manual",
          }),
        );
        expect(authorizedMedia.status).toBe(200);
        expect(authorizedMedia.headers.get("location")).toBeNull();
        expect(
          (yield* Effect.promise(() => authorizedMedia.arrayBuffer())).byteLength,
        ).toBeGreaterThan(0);

        const replacementPlugin = yield* supervisor.supervise(
          {
            arguments: [JELLYFIN_PLUGIN_PATH],
            executable: process.execPath,
            expectedProviderType: "jellyfin",
            stderrEvents: [],
          },
          {
            configuration: { base_url: faultProxy.baseUrl, user_id: jellyfin.primaryUserId },
            credentials: { api_key: jellyfin.primaryApiKey },
            kind: "instance",
            providerInstanceId: "real-jellyfin-provider-instance",
            revision: "real-jellyfin-revision-2",
          },
        );
        expect(
          (yield* replacementPlugin.call(
            PluginService.method.getConnection,
            {},
            CALL_DEADLINE_MILLISECONDS,
          )).connection?.capabilities,
        ).toEqual(EXPECTED_CAPABILITIES);

        const planRequestsBeforeFaults = faultProxy.planRequests();
        const malformedSecret = "real-extension-malformed-secret-sentinel";
        faultProxy.malformNextPlanResponse(malformedSecret);
        const malformedFailure = yield* replacementPlugin
          .call(PlaybackService.method.planPlayback, directPlanRequest, CALL_DEADLINE_MILLISECONDS)
          .pipe(Effect.flip);
        expect(malformedFailure).toMatchObject({
          _tag: "PluginRpcError",
          code: Code.Internal,
        });
        expect(JSON.stringify(malformedFailure)).not.toContain(malformedSecret);
        expect(JSON.stringify(malformedFailure)).not.toContain(jellyfin.primaryApiKey);

        faultProxy.redirectNextPlanResponse();
        const redirectFailure = yield* replacementPlugin
          .call(PlaybackService.method.planPlayback, directPlanRequest, CALL_DEADLINE_MILLISECONDS)
          .pipe(Effect.flip);
        expect(redirectFailure).toMatchObject({
          _tag: "PluginRpcError",
          code: Code.FailedPrecondition,
        });
        expect(JSON.stringify(redirectFailure)).not.toContain("attacker.example");

        const stalledPlan = faultProxy.stallNextPlanResponse();
        const canceledPlanCall = yield* Effect.forkChild(
          replacementPlugin.call(
            PlaybackService.method.planPlayback,
            directPlanRequest,
            CALL_DEADLINE_MILLISECONDS,
          ),
        );
        yield* Effect.promise(() => stalledPlan.requestStarted);
        yield* Fiber.interrupt(canceledPlanCall);
        yield* Effect.promise(() => stalledPlan.cancellationObserved);
        expect(faultProxy.planRequests() - planRequestsBeforeFaults).toBe(3);

        const { sessionContext } = playbackLease;
        faultProxy.loseNextReportResponse();
        const reportFailure = yield* replacementPlugin
          .call(
            PlaybackService.method.reportPlayback,
            {
              eventId: "real-extension-report",
              position: { nanos: 0, seconds: 0n },
              sequence: 1n,
              sessionContext,
              sessionId: playbackLease.sessionId,
              state: PlaybackState.PLAYING,
            },
            CALL_DEADLINE_MILLISECONDS,
          )
          .pipe(Effect.flip);
        expect(reportFailure).toMatchObject({ _tag: "PluginRpcError", code: Code.Unavailable });
        expect(faultProxy.reportRequests()).toBe(1);
        expect(faultProxy.committedLostReportResponses()).toBe(1);
        expect(JSON.stringify(reportFailure)).not.toContain(jellyfin.primaryApiKey);
        const closeRequest = {
          finalPosition: { nanos: 0, seconds: 0n },
          operationId: "real-extension-close",
          reason: PlaybackCloseReason.STOPPED,
          sessionContext,
          sessionId: playbackLease.sessionId,
        };
        yield* replacementPlugin.call(
          PlaybackService.method.closePlayback,
          closeRequest,
          CALL_DEADLINE_MILLISECONDS,
        );
        yield* replacementPlugin.call(
          PlaybackService.method.closePlayback,
          closeRequest,
          CALL_DEADLINE_MILLISECONDS,
        );

        const restartPlan = required(
          (yield* replacementPlugin.call(
            PlaybackService.method.planPlayback,
            directPlanRequest,
            CALL_DEADLINE_MILLISECONDS,
          )).plan,
          "restart playback plan",
        );
        const restartOpened = yield* replacementPlugin.call(
          PlaybackService.method.openPlayback,
          {
            audioTrackReference: restartPlan.defaultAudioTrackReference,
            operationId: "restart-extension-open",
            planId: restartPlan.id,
            subtitle: restartPlan.defaultSubtitle,
          },
          CALL_DEADLINE_MILLISECONDS,
        );
        const restartLease = required(restartOpened.lease, "restart playback lease");
        const restartedBaseUrl = yield* Effect.tryPromise(() => restartJellyfin());
        yield* Effect.sleep(5000);
        const restartedUser = yield* Effect.promise(() =>
          fetch(new URL(`Users/${jellyfin.primaryUserId}`, restartedBaseUrl), {
            headers: { authorization: `MediaBrowser Token="${jellyfin.primaryApiKey}"` },
            redirect: "manual",
          }),
        );
        expect(restartedUser.status).toBe(200);
        const restartedHandshake = yield* Effect.promise(() =>
          fetch(new URL("Nama/v1/handshake", restartedBaseUrl), {
            headers: { authorization: `MediaBrowser Token="${jellyfin.primaryApiKey}"` },
            redirect: "manual",
          }),
        );
        expect(restartedHandshake.status).toBe(200);
        const restartedPlugin = yield* supervisor.supervise(
          {
            arguments: [JELLYFIN_PLUGIN_PATH],
            executable: process.execPath,
            expectedProviderType: "jellyfin",
            stderrEvents: [],
          },
          {
            configuration: { base_url: restartedBaseUrl, user_id: jellyfin.primaryUserId },
            credentials: { api_key: jellyfin.primaryApiKey },
            kind: "instance",
            providerInstanceId: "real-jellyfin-provider-instance",
            revision: "real-jellyfin-revision-3",
          },
        );
        const restartedConnection = yield* restartedPlugin.call(
          PluginService.method.getConnection,
          {},
          CALL_DEADLINE_MILLISECONDS,
        );
        expect(restartedConnection.connection?.status).toBe(PluginConnectionStatus.CONNECTED);
        expect(restartedConnection.connection?.capabilities).toEqual(EXPECTED_CAPABILITIES);
        const restartedMedia = yield* Effect.promise(() =>
          fetch(new URL(new URL(restartLease.url).pathname, restartedBaseUrl), {
            headers: Object.fromEntries(
              restartLease.headers.map(({ name, value }) => [name, value]),
            ),
            redirect: "manual",
          }),
        );
        expect(restartedMedia.status).toBe(200);
        const lostSessionExit = yield* Effect.exit(
          restartedPlugin.call(
            PlaybackService.method.reportPlayback,
            {
              eventId: "restart-lost-session-report",
              position: { nanos: 0, seconds: 0n },
              selectedAudioTrackReference: restartLease.selectedAudioTrackReference,
              sequence: 1n,
              sessionContext: restartLease.sessionContext,
              sessionId: restartLease.sessionId,
              state: PlaybackState.PLAYING,
            },
            CALL_DEADLINE_MILLISECONDS,
          ),
        );
        expect(Exit.isFailure(lostSessionExit)).toBe(true);
        const remainingLeaseLifetime =
          leaseExpiryMilliseconds - Date.now() + EXPIRY_OBSERVATION_DELAY_MILLISECONDS;
        if (remainingLeaseLifetime > 0) {
          yield* Effect.sleep(remainingLeaseLifetime);
        }
        const expiredMedia = yield* Effect.promise(() =>
          fetch(new URL(new URL(playbackLease.url).pathname, restartedBaseUrl), {
            headers: mediaHeaders,
            redirect: "manual",
          }),
        );
        expect(expiredMedia.status).toBe(401);
      }).pipe(Effect.provide(PluginSupervisor.layer())),
    ),
  TEST_TIMEOUT_MILLISECONDS,
);
