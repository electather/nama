// oxlint-disable eslint/max-lines-per-function, eslint/max-statements, eslint/no-magic-numbers, import/max-dependencies, unicorn/max-nested-calls -- The ordered real-provider proof keeps one subprocess lifecycle, exact fixture values, and watched-state transitions visible across the real Jellyfin boundary.
import { join } from "node:path";

import type { MessageInitShape } from "@bufbuild/protobuf";
import { Code } from "@connectrpc/connect";
import { expect, it } from "@effect/vitest";
import {
  ArtworkAuthorizationScope,
  LibraryService,
  ListConsistency,
} from "@nama/api/nama/plugin/v1/library_pb.js";
import { DynamicRange, MediaKind, SourceAvailability } from "@nama/api/nama/plugin/v1/media_pb.js";
import type { ProviderMediaItem } from "@nama/api/nama/plugin/v1/media_pb.js";
import type { PlanPlaybackRequestSchema } from "@nama/api/nama/plugin/v1/playback_pb.js";
import {
  DeliveryProtocol,
  PlaybackAuthorizationScope,
  PlaybackCloseReason,
  PlaybackQuality,
  PlaybackService,
  PlaybackState,
  PlaybackStrategy,
  SubtitleDeliveryMode,
  SubtitlePreference,
  TrackActionKind,
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

const jsonForSecretAbsence = (value: unknown): string =>
  JSON.stringify(value, (_key, nested: unknown) => {
    if (typeof nested === "bigint") {
      return nested.toString();
    }
    return nested;
  });
const isUnknownRecord = (value: unknown): value is Readonly<Record<string, unknown>> => {
  if (typeof value !== "object" || !value || Array.isArray(value)) {
    return false;
  }
  return true;
};

const playlistUris = (playlist: string): readonly string[] =>
  playlist
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));

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
  expect(part.tracks.length).toBeGreaterThanOrEqual(3);
  const videoTrack = required(
    part.tracks.find(({ details }) => details.case === "video"),
    `${item.title} video track`,
  );
  const defaultAudioTrack = required(
    part.tracks.find(({ details }) => details.case === "audio" && details.value.isDefault),
    `${item.title} default audio track`,
  );
  const spanishAudioTrack = required(
    part.tracks.find(
      ({ details }) =>
        details.case === "audio" && !details.value.isDefault && details.value.language === "spa",
    ),
    `${item.title} Spanish audio track`,
  );
  expect(videoTrack.details).toMatchObject({
    case: "video",
    value: {
      codec: "h264",
      dynamicRange: DynamicRange.SDR,
      height: 90,
      width: 160,
    },
  });
  expect(defaultAudioTrack.details).toMatchObject({
    case: "audio",
    value: {
      channelCount: 1,
      codec: "aac",
      isDefault: true,
      language: "eng",
      sampleRateHz: 48_000,
    },
  });
  expect(spanishAudioTrack.details).toMatchObject({
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
        const spanishAudioTrack = required(
          moviePart.tracks.find(
            ({ details }) => details.case === "audio" && details.value.language === "spa",
          )?.trackReference,
          "movie Spanish audio track",
        );
        const flacAudioTrack = required(
          moviePart.tracks.find(
            ({ details }) =>
              details.case === "audio" &&
              details.value.codec === "flac" &&
              details.value.language === "deu",
          )?.trackReference,
          "movie German FLAC audio track",
        );
        const videoTrack = required(
          moviePart.tracks.find(({ details }) => details.case === "video")?.trackReference,
          "movie video track",
        );
        const subtitleTrack = required(
          moviePart.tracks.find(
            ({ details }) =>
              details.case === "subtitle" &&
              details.value.codec === "ass" &&
              details.value.language === "eng",
          )?.trackReference,
          "movie external ASS subtitle track",
        );
        const embeddedSubtitleTrack = required(
          moviePart.tracks.find(
            ({ details }) =>
              details.case === "subtitle" &&
              details.value.codec === "mov_text" &&
              details.value.language === "fra",
          )?.trackReference,
          "movie embedded subtitle track",
        );
        const privatePlanInput = {
          capabilities: {
            direct_play_profiles: [
              { audio_codecs: ["aac"], container: "mp4", video_codec: "h264" },
            ],
            dynamic_ranges: [],
            protocols: ["http_progressive"],
            subtitle_capabilities: [],
          },
          item_id: movieItemId,
          preferences: {
            preferred_audio_languages: [],
            preferred_subtitle_languages: [],
            quality: "auto",
            subtitle_preference: "auto",
          },
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
        expect(privatePlanBody["actions"]).toEqual(
          expect.arrayContaining([
            { action: "copy", track_index: Number(videoTrack.trackId) },
            { action: "copy", track_index: Number(audioTrack.trackId) },
            { action: "omit", track_index: Number(spanishAudioTrack.trackId) },
          ]),
        );
        expect({
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
        }).toMatchObject({
          audio_codec: "aac",
          container: "mp4",
          default_audio_track_index: Number(audioTrack.trackId),
          default_subtitle_track_index: undefined,
          expires_at_type: "string",
          plan_id_type: "string",
          protocol: "http_progressive",
          strategy: "direct",
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
        const spanishPlan = required(
          (yield* plugin.call(
            PlaybackService.method.planPlayback,
            {
              ...directPlanRequest,
              preferences: {
                ...directPlanRequest.preferences,
                preferredAudioLanguages: ["spa"],
              },
            },
            CALL_DEADLINE_MILLISECONDS,
          )).plan,
          "preferred-audio playback plan",
        );
        expect(spanishPlan.defaultAudioTrackReference).toEqual(spanishAudioTrack);
        expect(spanishPlan.strategy).toBe(PlaybackStrategy.DIRECT);
        const spanishOpened = yield* plugin.call(
          PlaybackService.method.openPlayback,
          {
            audioTrackReference: spanishAudioTrack,
            operationId: "real-extension-spanish-audio-open",
            planId: spanishPlan.id,
            subtitle: spanishPlan.defaultSubtitle,
          },
          CALL_DEADLINE_MILLISECONDS,
        );
        const spanishLease = required(spanishOpened.lease, "preferred-audio playback lease");
        expect(spanishLease.selectedAudioTrackReference).toEqual(spanishAudioTrack);
        expect(
          spanishLease.tracks.every(({ switchableWithoutReopen }) => !switchableWithoutReopen),
        ).toBe(true);
        const unsafeAudioSwitch = yield* plugin
          .call(
            PlaybackService.method.reportPlayback,
            {
              eventId: "unsafe-audio-switch",
              position: { nanos: 0, seconds: 0n },
              selectedAudioTrackReference: audioTrack,
              sequence: 1n,
              sessionContext: spanishLease.sessionContext,
              sessionId: spanishLease.sessionId,
              state: PlaybackState.PLAYING,
            },
            CALL_DEADLINE_MILLISECONDS,
          )
          .pipe(Effect.flip);
        expect(unsafeAudioSwitch).toMatchObject({
          _tag: "PluginRpcError",
          code: Code.FailedPrecondition,
        });

        const externalSubtitlePlan = required(
          (yield* plugin.call(
            PlaybackService.method.planPlayback,
            {
              ...directPlanRequest,
              capabilities: {
                ...directPlanRequest.capabilities,
                subtitleCapabilities: [
                  { deliveryModes: [SubtitleDeliveryMode.EXTERNAL], format: "ass" },
                ],
              },
              preferences: {
                ...directPlanRequest.preferences,
                preferredSubtitleLanguages: ["eng"],
                subtitlePreference: SubtitlePreference.ALWAYS,
              },
            },
            CALL_DEADLINE_MILLISECONDS,
          )).plan,
          "external-subtitle playback plan",
        );
        expect(externalSubtitlePlan.defaultSubtitle).toEqual({
          $typeName: "nama.plugin.v1.ProviderSubtitleSelection",
          selection: { case: "trackReference", value: subtitleTrack },
        });
        expect(externalSubtitlePlan.actions).toContainEqual({
          $typeName: "nama.plugin.v1.ProviderTrackAction",
          action: TrackActionKind.EXTERNAL,
          trackReference: subtitleTrack,
        });
        const externalSubtitleOpened = yield* plugin.call(
          PlaybackService.method.openPlayback,
          {
            audioTrackReference: externalSubtitlePlan.defaultAudioTrackReference,
            operationId: "real-extension-external-subtitle-open",
            planId: externalSubtitlePlan.id,
            subtitle: externalSubtitlePlan.defaultSubtitle,
          },
          CALL_DEADLINE_MILLISECONDS,
        );
        const externalSubtitleLease = required(
          externalSubtitleOpened.lease,
          "external-subtitle playback lease",
        );
        const externalSubtitle = required(
          externalSubtitleLease.externalSubtitles[0],
          "external subtitle locator",
        );
        expect(externalSubtitle.trackReference).toEqual(subtitleTrack);
        expect(externalSubtitle.url).not.toContain(movieItemId);
        expect(externalSubtitle.url).not.toContain(movieSource.sourceId);
        expect(externalSubtitle.url).not.toContain(jellyfin.primaryApiKey);
        const externalSubtitleResponse = yield* Effect.promise(() =>
          fetch(externalSubtitle.url, {
            headers: Object.fromEntries(
              externalSubtitle.headers.map(({ name, value }) => [name, value]),
            ),
            redirect: "manual",
          }),
        );
        expect(externalSubtitleResponse.status).toBe(200);
        expect(yield* Effect.promise(() => externalSubtitleResponse.text())).toContain(
          "Nama subtitle fixture",
        );
        const embeddedSubtitlePlan = required(
          (yield* plugin.call(
            PlaybackService.method.planPlayback,
            {
              ...directPlanRequest,
              capabilities: {
                ...directPlanRequest.capabilities,
                subtitleCapabilities: [
                  { deliveryModes: [SubtitleDeliveryMode.EMBEDDED], format: "mov_text" },
                ],
              },
              preferences: {
                ...directPlanRequest.preferences,
                preferredSubtitleLanguages: ["fra"],
                subtitlePreference: SubtitlePreference.ALWAYS,
              },
            },
            CALL_DEADLINE_MILLISECONDS,
          )).plan,
          "embedded-subtitle playback plan",
        );
        expect(embeddedSubtitlePlan).toMatchObject({
          defaultSubtitle: {
            selection: { case: "trackReference", value: embeddedSubtitleTrack },
          },
          strategy: PlaybackStrategy.DIRECT,
        });
        expect(embeddedSubtitlePlan.actions).toContainEqual({
          $typeName: "nama.plugin.v1.ProviderTrackAction",
          action: TrackActionKind.COPY,
          trackReference: embeddedSubtitleTrack,
        });
        const embeddedSubtitleOpened = yield* plugin.call(
          PlaybackService.method.openPlayback,
          {
            audioTrackReference: embeddedSubtitlePlan.defaultAudioTrackReference,
            operationId: "real-extension-embedded-subtitle-open",
            planId: embeddedSubtitlePlan.id,
            subtitle: embeddedSubtitlePlan.defaultSubtitle,
          },
          CALL_DEADLINE_MILLISECONDS,
        );
        expect(embeddedSubtitleOpened.lease).toMatchObject({
          externalSubtitles: [],
          selectedSubtitle: {
            selection: { case: "trackReference", value: embeddedSubtitleTrack },
          },
        });

        const fallbackCases: readonly {
          readonly audioCodec: string;
          readonly name: string;
          readonly request: MessageInitShape<typeof PlanPlaybackRequestSchema>;
          readonly strategy: PlaybackStrategy;
          readonly videoCodec: string;
        }[] = [
          {
            audioCodec: "aac",
            name: "audio-transcode",
            request: {
              ...directPlanRequest,
              preferences: {
                ...directPlanRequest.preferences,
                preferredAudioLanguages: ["deu"],
              },
            },
            strategy: PlaybackStrategy.TRANSCODE_AUDIO,
            videoCodec: "h264",
          },
          {
            audioCodec: "aac",
            name: "bit-rate-cap",
            request: {
              ...directPlanRequest,
              preferences: {
                ...directPlanRequest.preferences,
                maxBitRateBps: 1000n,
                quality: PlaybackQuality.CAPPED,
              },
            },
            strategy: PlaybackStrategy.TRANSCODE_VIDEO,
            videoCodec: "h264",
          },
          {
            audioCodec: "aac",
            name: "subtitle-burn",
            request: {
              ...directPlanRequest,
              capabilities: {
                ...directPlanRequest.capabilities,
                subtitleCapabilities: [
                  { deliveryModes: [SubtitleDeliveryMode.BURNED_IN], format: "ass" },
                ],
              },
              preferences: {
                ...directPlanRequest.preferences,
                preferredSubtitleLanguages: ["eng"],
                subtitlePreference: SubtitlePreference.ALWAYS,
              },
            },
            strategy: PlaybackStrategy.TRANSCODE_VIDEO,
            videoCodec: "h264",
          },
        ];
        for (const fallback of fallbackCases) {
          const fallbackPlan = required(
            (yield* plugin.call(
              PlaybackService.method.planPlayback,
              fallback.request,
              CALL_DEADLINE_MILLISECONDS,
            )).plan,
            `${fallback.name} playback plan`,
          );
          expect(fallbackPlan).toMatchObject({
            audioCodec: fallback.audioCodec,
            protocol: DeliveryProtocol.HTTP_PROGRESSIVE,
            strategy: fallback.strategy,
            videoCodec: fallback.videoCodec,
          });
          let expectedVideoAction = TrackActionKind.COPY;
          if (fallback.strategy === PlaybackStrategy.TRANSCODE_VIDEO) {
            expectedVideoAction = TrackActionKind.TRANSCODE;
          }
          expect(fallbackPlan.actions).toContainEqual({
            $typeName: "nama.plugin.v1.ProviderTrackAction",
            action: expectedVideoAction,
            trackReference: videoTrack,
          });
          if (fallback.name === "audio-transcode") {
            expect(fallbackPlan.actions).toContainEqual({
              $typeName: "nama.plugin.v1.ProviderTrackAction",
              action: TrackActionKind.TRANSCODE,
              trackReference: flacAudioTrack,
            });
          }
          if (fallback.name === "subtitle-burn") {
            expect(fallbackPlan.actions).toContainEqual({
              $typeName: "nama.plugin.v1.ProviderTrackAction",
              action: TrackActionKind.BURN,
              trackReference: subtitleTrack,
            });
          }
          const fallbackOpened = yield* plugin.call(
            PlaybackService.method.openPlayback,
            {
              audioTrackReference: fallbackPlan.defaultAudioTrackReference,
              operationId: `real-extension-${fallback.name}-open`,
              planId: fallbackPlan.id,
              subtitle: fallbackPlan.defaultSubtitle,
            },
            CALL_DEADLINE_MILLISECONDS,
          );
          const fallbackLease = required(fallbackOpened.lease, `${fallback.name} playback lease`);
          const fallbackMedia = yield* Effect.promise(() =>
            fetch(fallbackLease.url, {
              headers: Object.fromEntries(
                fallbackLease.headers.map(({ name, value }) => [name, value]),
              ),
              redirect: "manual",
            }),
          );
          expect(fallbackMedia.status).toBe(200);
          expect(
            (yield* Effect.promise(() => fallbackMedia.arrayBuffer())).byteLength,
          ).toBeGreaterThan(0);
        }
        const unsupportedPlayback = yield* plugin
          .call(
            PlaybackService.method.planPlayback,
            {
              ...directPlanRequest,
              capabilities: {
                ...directPlanRequest.capabilities,
                directPlayProfiles: [
                  {
                    audioCodecs: ["unsupported-audio"],
                    container: "mp4",
                    videoCodec: "unsupported-video",
                  },
                ],
              },
            },
            CALL_DEADLINE_MILLISECONDS,
          )
          .pipe(Effect.flip);
        expect(unsupportedPlayback).toMatchObject({
          _tag: "PluginRpcError",
          code: Code.FailedPrecondition,
        });
        const unavailableSource = yield* plugin
          .call(
            PlaybackService.method.planPlayback,
            {
              ...directPlanRequest,
              sourceReference: {
                ...movieSource,
                sourceId: "unavailable-source",
              },
            },
            CALL_DEADLINE_MILLISECONDS,
          )
          .pipe(Effect.flip);
        expect(unavailableSource).toMatchObject({
          _tag: "PluginRpcError",
          code: Code.NotFound,
        });
        const privateHlsProbe = yield* Effect.promise(() =>
          fetch(new URL("Nama/v1/playback/plans", jellyfin.baseUrl), {
            body: JSON.stringify({
              ...privatePlanInput,
              capabilities: {
                ...privatePlanInput.capabilities,
                dynamic_ranges: ["sdr"],
                protocols: ["hls"],
              },
              start_position: undefined,
            }),
            headers: {
              authorization: `MediaBrowser Token="${jellyfin.primaryApiKey}"`,
              "content-type": "application/json",
            },
            method: "POST",
            redirect: "manual",
          }),
        );
        if (privateHlsProbe.status !== 200) {
          const failureBody = yield* Effect.promise(() => privateHlsProbe.text());
          throw new Error(
            `private extension HLS plan failed: ${privateHlsProbe.status} ${failureBody}`,
          );
        }
        const hlsPlanRequest = {
          ...directPlanRequest,
          capabilities: {
            ...directPlanRequest.capabilities,
            protocols: [DeliveryProtocol.HLS],
            subtitleCapabilities: [
              { deliveryModes: [SubtitleDeliveryMode.EXTERNAL], format: "ass" },
            ],
          },
          preferences: {
            ...directPlanRequest.preferences,
            preferredSubtitleLanguages: ["eng"],
            subtitlePreference: SubtitlePreference.ALWAYS,
          },
        };
        const hlsPlan = required(
          (yield* plugin.call(
            PlaybackService.method.planPlayback,
            hlsPlanRequest,
            CALL_DEADLINE_MILLISECONDS,
          )).plan,
          "HLS playback plan",
        );
        expect(hlsPlan).toMatchObject({
          audioCodec: "aac",
          container: "mp4",
          defaultSubtitle: {
            selection: { case: "trackReference", value: subtitleTrack },
          },
          protocol: DeliveryProtocol.HLS,
          strategy: PlaybackStrategy.REMUX,
          videoCodec: "h264",
        });
        expect(hlsPlan.actions).toContainEqual({
          $typeName: "nama.plugin.v1.ProviderTrackAction",
          action: TrackActionKind.EXTERNAL,
          trackReference: subtitleTrack,
        });
        const disabledHlsPlan = required(
          (yield* plugin.call(
            PlaybackService.method.planPlayback,
            hlsPlanRequest,
            CALL_DEADLINE_MILLISECONDS,
          )).plan,
          "disabled-subtitle HLS plan",
        );
        const disabledHlsOpened = yield* plugin.call(
          PlaybackService.method.openPlayback,
          {
            audioTrackReference: disabledHlsPlan.defaultAudioTrackReference,
            operationId: "real-extension-hls-disabled-open",
            planId: disabledHlsPlan.id,
            subtitle: { selection: { case: "disabled", value: true } },
          },
          CALL_DEADLINE_MILLISECONDS,
        );
        expect(disabledHlsOpened.lease).toMatchObject({
          externalSubtitles: [],
          selectedSubtitle: { selection: { case: "disabled", value: true } },
        });
        const hlsOpened = yield* plugin.call(
          PlaybackService.method.openPlayback,
          {
            audioTrackReference: hlsPlan.defaultAudioTrackReference,
            operationId: "real-extension-hls-open",
            planId: hlsPlan.id,
            subtitle: hlsPlan.defaultSubtitle,
          },
          CALL_DEADLINE_MILLISECONDS,
        );
        const hlsLease = required(hlsOpened.lease, "HLS playback lease");
        expect(hlsLease).toMatchObject({
          mimeType: "application/vnd.apple.mpegurl",
          protocol: DeliveryProtocol.HLS,
        });
        expect(hlsLease.externalSubtitles).toHaveLength(1);
        expect(hlsLease.externalSubtitles[0]?.trackReference).toEqual(subtitleTrack);
        const changedHlsReplay = yield* plugin
          .call(
            PlaybackService.method.openPlayback,
            {
              audioTrackReference: hlsPlan.defaultAudioTrackReference,
              operationId: "real-extension-hls-open",
              planId: hlsPlan.id,
              subtitle: { selection: { case: "disabled", value: true } },
            },
            CALL_DEADLINE_MILLISECONDS,
          )
          .pipe(Effect.flip);
        expect(changedHlsReplay).toMatchObject({
          _tag: "PluginRpcError",
          code: Code.FailedPrecondition,
        });
        const hlsHeaders = Object.fromEntries(
          hlsLease.headers.map(({ name, value }) => [name, value]),
        );
        const hlsMasterResponse = yield* Effect.promise(() =>
          fetch(hlsLease.url, { headers: hlsHeaders, redirect: "manual" }),
        );
        expect(hlsMasterResponse.status).toBe(200);
        const hlsMaster = yield* Effect.promise(() => hlsMasterResponse.text());
        expect(hlsMaster).not.toContain("ApiKey");
        expect(hlsMaster).not.toContain(jellyfin.primaryApiKey);
        expect(hlsMaster).not.toContain(movieItemId);
        expect(hlsMaster).not.toContain(movieSource.sourceId);
        const hlsVariants = playlistUris(hlsMaster);
        expect(hlsVariants.length).toBeGreaterThan(0);
        expect(hlsVariants.every((uri) => uri.startsWith("/Nama/v1/playback/"))).toBe(true);
        const hlsVariantResponse = yield* Effect.promise(() =>
          fetch(new URL(required(hlsVariants[0], "HLS variant"), hlsLease.url), {
            headers: hlsHeaders,
            redirect: "manual",
          }),
        );
        expect(hlsVariantResponse.status).toBe(200);
        const hlsVariant = yield* Effect.promise(() => hlsVariantResponse.text());
        expect(hlsVariant).not.toContain("ApiKey");
        expect(hlsVariant).not.toContain(jellyfin.primaryApiKey);
        expect(hlsVariant).not.toContain(movieItemId);
        expect(hlsVariant).not.toContain(movieSource.sourceId);
        const hlsSegments = playlistUris(hlsVariant);
        expect(hlsSegments.length).toBeGreaterThan(0);
        expect(hlsSegments.every((uri) => uri.startsWith("/Nama/v1/playback/"))).toBe(true);
        const hlsSegmentResponse = yield* Effect.promise(() =>
          fetch(new URL(required(hlsSegments[0], "HLS segment"), hlsLease.url), {
            headers: hlsHeaders,
            redirect: "manual",
          }),
        );
        expect(hlsSegmentResponse.status).toBe(200);
        expect(
          (yield* Effect.promise(() => hlsSegmentResponse.arrayBuffer())).byteLength,
        ).toBeGreaterThan(0);
        const hlsSubtitle = required(
          hlsLease.externalSubtitles[0],
          "HLS external subtitle locator",
        );
        expect(hlsSubtitle.url).not.toContain("ApiKey");
        expect(hlsSubtitle.url).not.toContain(movieItemId);
        expect(hlsSubtitle.url).not.toContain(movieSource.sourceId);
        const hlsSubtitleResponse = yield* Effect.promise(() =>
          fetch(hlsSubtitle.url, {
            headers: Object.fromEntries(
              hlsSubtitle.headers.map(({ name, value }) => [name, value]),
            ),
            redirect: "manual",
          }),
        );
        expect(hlsSubtitleResponse.status).toBe(200);
        const hlsSubtitlePlaylist = yield* Effect.promise(() => hlsSubtitleResponse.text());
        expect(hlsSubtitlePlaylist).not.toContain("ApiKey");
        expect(hlsSubtitlePlaylist).not.toContain(jellyfin.primaryApiKey);
        expect(hlsSubtitlePlaylist).not.toContain(movieItemId);
        expect(hlsSubtitlePlaylist).not.toContain(movieSource.sourceId);
        const hlsSubtitleChildren = playlistUris(hlsSubtitlePlaylist);
        expect(hlsSubtitleChildren.length).toBeGreaterThan(0);
        expect(hlsSubtitleChildren.every((uri) => uri.startsWith("/Nama/v1/playback/"))).toBe(true);
        const hlsSubtitleChildUrl = new URL(
          required(hlsSubtitleChildren[0], "HLS subtitle child"),
          hlsSubtitle.url,
        );
        const hlsSubtitleChildResponse = yield* Effect.promise(() =>
          fetch(hlsSubtitleChildUrl, {
            headers: Object.fromEntries(
              hlsSubtitle.headers.map(({ name, value }) => [name, value]),
            ),
            redirect: "manual",
          }),
        );
        expect(hlsSubtitleChildResponse.status).toBe(200);
        const hlsSubtitleBody = yield* Effect.promise(() => hlsSubtitleChildResponse.text());
        expect(hlsSubtitleBody).toContain("Nama subtitle fixture");
        const wrongSessionSubtitleChild = yield* Effect.promise(() =>
          fetch(hlsSubtitleChildUrl, {
            headers: Object.fromEntries(
              externalSubtitleLease.headers.map(({ name, value }) => [name, value]),
            ),
            redirect: "manual",
          }),
        );
        expect(wrongSessionSubtitleChild.status).toBe(401);
        const openStartedAt = Date.now();
        expect(plan.tracks).toHaveLength(2);
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
        let tamperedLeasePrefix = "A";
        if (leaseHeader.value.startsWith(tamperedLeasePrefix)) {
          tamperedLeasePrefix = "B";
        }
        const tamperedLeaseValue = tamperedLeasePrefix + leaseHeader.value.slice(1);
        const tamperedLeaseMedia = yield* Effect.promise(() =>
          fetch(playbackLease.url, {
            headers: {
              [leaseHeader.name]: tamperedLeaseValue,
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
        const replacementHlsMain = yield* Effect.promise(() =>
          fetch(hlsLease.url, { headers: hlsHeaders, redirect: "manual" }),
        );
        expect(replacementHlsMain.status).toBe(200);
        const replacementHlsSubtitle = yield* Effect.promise(() =>
          fetch(hlsSubtitleChildUrl, { headers: hlsHeaders, redirect: "manual" }),
        );
        expect(replacementHlsSubtitle.status).toBe(200);

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
        expect(jsonForSecretAbsence(malformedFailure)).not.toContain(malformedSecret);
        expect(jsonForSecretAbsence(malformedFailure)).not.toContain(jellyfin.primaryApiKey);

        faultProxy.redirectNextPlanResponse();
        const redirectFailure = yield* replacementPlugin
          .call(PlaybackService.method.planPlayback, directPlanRequest, CALL_DEADLINE_MILLISECONDS)
          .pipe(Effect.flip);
        expect(redirectFailure).toMatchObject({
          _tag: "PluginRpcError",
          code: Code.FailedPrecondition,
        });
        expect(jsonForSecretAbsence(redirectFailure)).not.toContain("attacker.example");

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
        expect(jsonForSecretAbsence(reportFailure)).not.toContain(jellyfin.primaryApiKey);
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
        const restartedHlsMain = yield* Effect.promise(() =>
          fetch(new URL(new URL(hlsLease.url).pathname, restartedBaseUrl), {
            headers: hlsHeaders,
            redirect: "manual",
          }),
        );
        expect(restartedHlsMain.status).toBe(200);
        const restartedHlsSubtitle = yield* Effect.promise(() =>
          fetch(new URL(hlsSubtitleChildUrl.pathname, restartedBaseUrl), {
            headers: hlsHeaders,
            redirect: "manual",
          }),
        );
        expect(restartedHlsSubtitle.status).toBe(200);
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
