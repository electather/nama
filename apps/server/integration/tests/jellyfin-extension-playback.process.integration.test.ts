// oxlint-disable eslint/max-lines-per-function, eslint/max-statements, eslint/no-magic-numbers, unicorn/max-nested-calls -- The private extension process proof keeps each ordered protocol lifecycle and exact expiry boundary visible.
import { Code } from "@connectrpc/connect";
import { expect, it } from "@effect/vitest";
import { DynamicRange, SubtitleRepresentation } from "@nama/api/nama/plugin/v1/media_pb.js";
import {
  DeliveryProtocol,
  SubtitleDeliveryMode,
  PlaybackAuthorizationScope,
  PlaybackCloseReason,
  PlaybackQuality,
  PlaybackService,
  PlaybackState,
  PlaybackStrategy,
  PlaybackTrackType,
  SubtitlePreference,
  TrackActionKind,
} from "@nama/api/nama/plugin/v1/playback_pb.js";
import { PluginService, ProviderCapability } from "@nama/api/nama/plugin/v1/plugin_pb.js";
import { Effect, Exit, Fiber } from "effect";

import { PluginSupervisor } from "../../src/plugin/supervisor.ts";
import {
  USER_ID,
  controlledJellyfin,
  respondJson,
  respondRaw,
  superviseJellyfin,
} from "./jellyfin-process.test-support.ts";
import type { ControlledHandler } from "./jellyfin-process.test-support.ts";

const CALL_DEADLINE_MILLISECONDS = 10_000;
const SERVER_ID = "extension-server-id";
const STOCK_CAPABILITIES = [
  ProviderCapability.LIBRARY_READ,
  ProviderCapability.ARTWORK_RESOLVE,
  ProviderCapability.WATCH_STATE_READ,
  ProviderCapability.WATCHED_WRITE,
];
const PLAYBACK_EXTENSION_CAPABILITIES = [
  ProviderCapability.PLAYBACK_PLAN,
  ProviderCapability.PLAYBACK_OPEN,
  ProviderCapability.PLAYBACK_REPORT,
  ProviderCapability.PLAYBACK_REPORTS_USER_STATE,
] as const;
const COHERENT_PROGRESS_CAPABILITIES = [
  ...PLAYBACK_EXTENSION_CAPABILITIES,
  ProviderCapability.PROGRESS_WRITE,
] as const;
const MEDIA_ITEM_ID = "0123456789abcdef0123456789abcdef";
const MEDIA_SOURCE_ID = "source-1";
const AUDIO_TRACK_ID = "1";
const SUBTITLE_TRACK_ID = "3";

const sourceReference = {
  itemReference: { itemId: MEDIA_ITEM_ID },
  sourceId: MEDIA_SOURCE_ID,
};
const audioTrackReference = {
  partReference: { partId: MEDIA_SOURCE_ID, sourceReference },
  trackId: AUDIO_TRACK_ID,
};
const subtitleTrackReference = {
  partReference: { partId: MEDIA_SOURCE_ID, sourceReference },
  trackId: SUBTITLE_TRACK_ID,
};

const directPlanRequest = {
  capabilities: {
    directPlayProfiles: [{ audioCodecs: ["aac"], container: "mp4", videoCodec: "h264" }],
    dynamicRanges: [DynamicRange.SDR],
    protocols: [DeliveryProtocol.HTTP_PROGRESSIVE],
    subtitleCapabilities: [],
  },
  itemReference: sourceReference.itemReference,
  preferences: {
    preferredAudioLanguages: [],
    preferredSubtitleLanguages: [],
    quality: PlaybackQuality.AUTO,
    subtitlePreference: SubtitlePreference.AUTO,
  },
  sourceReference,
  startPosition: { nanos: 0, seconds: 0n },
};

interface LifecycleHandlerOptions {
  readonly planExpiresAt: string;
  readonly planBodies?: unknown[];
  readonly planResponse?: Readonly<Record<string, unknown>>;
  readonly planId?: string;
  readonly requests: string[];
  readonly sessionResponse?: Readonly<Record<string, unknown>>;
  readonly sessionExpiresAt: string;
}

const connectionHandler =
  (extensionResponse?: unknown): ControlledHandler =>
  (_request, response, { url }) => {
    const endpoint = new URL(url, "http://jellyfin.invalid");
    if (endpoint.pathname === "/jellyfin/System/Info/Public") {
      respondJson(response, {
        Id: SERVER_ID,
        ServerName: "Extension Jellyfin",
        Version: "10.11.11",
      });
      return;
    }
    if (endpoint.pathname === `/jellyfin/Users/${USER_ID}`) {
      respondJson(response, {
        Id: USER_ID,
        Policy: { IsDisabled: false },
        ServerId: SERVER_ID,
      });
      return;
    }
    if (endpoint.pathname === "/jellyfin/Nama/v1/handshake" && extensionResponse !== undefined) {
      respondJson(response, extensionResponse);
      return;
    }
    respondRaw(response, 404, "missing");
  };

const lifecycleHandler =
  ({
    planExpiresAt,
    planBodies,
    planResponse,
    planId = "opaque-plan",
    requests,
    sessionResponse,
    sessionExpiresAt,
  }: LifecycleHandlerOptions): ControlledHandler =>
  (request, response, { url }) => {
    const endpoint = new URL(url, "http://jellyfin.invalid");
    requests.push(`${request.method ?? ""} ${endpoint.pathname}`);
    if (endpoint.pathname === "/jellyfin/Nama/v1/playback/plans") {
      const responseBody = {
        actions: [{ action: "copy", track_index: 1 }],
        audio_codec: "aac",
        container: "mp4",
        default_audio_track_index: 1,
        expires_at: planExpiresAt,
        plan_id: planId,
        protocol: "http_progressive",
        strategy: "direct",
        tracks: [
          {
            channels: 2,
            codec: "aac",
            index: 1,
            is_default: true,
            is_forced: false,
            label: "Main",
            language: "eng",
            type: "audio",
          },
        ],
        video_codec: "h264",
        ...planResponse,
      };
      if (planBodies === undefined) {
        respondJson(response, responseBody);
        return;
      }
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
      });
      request.on("end", () => {
        planBodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown);
        respondJson(response, responseBody);
      });
      return;
    }
    if (endpoint.pathname === "/jellyfin/Nama/v1/playback/sessions") {
      respondJson(
        response,
        sessionResponse ?? {
          expires_at: sessionExpiresAt,
          external_subtitles: [],
          item_id: MEDIA_ITEM_ID,
          lease: "scoped-lease-sentinel",
          media_resource: "opaque-media-resource",
          mime_type: "video/mp4",
          protocol: "http_progressive",
          report_interval_seconds: 15,
          selected_audio_track_index: 1,
          session_context: "c2Vzc2lvbi1jb250ZXh0",
          session_id: "opaque-session",
          source_id: MEDIA_SOURCE_ID,
          tracks: [{ index: 1, switchable_without_reopen: false }],
        },
      );
      return;
    }
    if (endpoint.pathname === "/jellyfin/Nama/v1/playback/sessions/opaque-session/reports") {
      respondJson(response, {});
      return;
    }
    if (endpoint.pathname === "/jellyfin/Nama/v1/playback/sessions/opaque-session/close") {
      respondJson(response, {});
      return;
    }
    if (endpoint.pathname === "/jellyfin/Nama/v1/playback/opaque-media-resource") {
      let status = 401;
      if (request.headers["x-nama-playback-lease"] === "scoped-lease-sentinel") {
        status = 200;
      }
      respondRaw(response, status, "media");
      return;
    }
    connectionHandler({
      capabilities: ["direct_progressive", "playback_telemetry"],
      extension_version: "1.0.0",
      protocol: "nama.jellyfin.extension",
      protocol_version: 2,
    })(request, response, {
      authorization: request.headers.authorization,
      method: request.method,
      url,
    });
  };

it.live("derives playback capabilities only from a compatible extension handshake", () =>
  Effect.scoped(
    Effect.gen(function* compatibleExtensionScenario() {
      const compatible = yield* controlledJellyfin(
        connectionHandler({
          capabilities: ["direct_progressive", "playback_telemetry", "coherent_progress"],
          extension_version: "1.0.0",
          protocol: "nama.jellyfin.extension",
          protocol_version: 1,
        }),
      );
      const playbackOnly = yield* controlledJellyfin(
        connectionHandler({
          capabilities: ["direct_progressive", "playback_telemetry"],
          extension_version: "1.0.0",
          protocol: "nama.jellyfin.extension",
          protocol_version: 2,
        }),
      );
      const absent = yield* controlledJellyfin(connectionHandler());
      const incompatible = yield* controlledJellyfin(
        connectionHandler({
          capabilities: ["direct_progressive", "playback_telemetry"],
          extension_version: "1.0.0",
          protocol: "nama.jellyfin.extension",
          protocol_version: 1,
        }),
      );
      const supervisor = yield* PluginSupervisor;
      const compatiblePlugin = yield* superviseJellyfin(supervisor, compatible, {
        providerInstanceId: "compatible-extension",
      });
      const playbackOnlyPlugin = yield* superviseJellyfin(supervisor, playbackOnly, {
        providerInstanceId: "playback-only-extension",
      });
      const absentPlugin = yield* superviseJellyfin(supervisor, absent, {
        providerInstanceId: "absent-extension",
      });
      const incompatiblePlugin = yield* superviseJellyfin(supervisor, incompatible, {
        providerInstanceId: "incompatible-extension",
      });

      const staticInfo = yield* compatiblePlugin.call(
        PluginService.method.getInfo,
        {},
        CALL_DEADLINE_MILLISECONDS,
      );
      expect(staticInfo.pluginInfo?.capabilities).toEqual(STOCK_CAPABILITIES);

      const compatibleConnection = yield* compatiblePlugin.call(
        PluginService.method.getConnection,
        {},
        CALL_DEADLINE_MILLISECONDS,
      );
      const playbackOnlyConnection = yield* playbackOnlyPlugin.call(
        PluginService.method.getConnection,
        {},
        CALL_DEADLINE_MILLISECONDS,
      );
      const absentConnection = yield* absentPlugin.call(
        PluginService.method.getConnection,
        {},
        CALL_DEADLINE_MILLISECONDS,
      );
      const incompatibleConnection = yield* incompatiblePlugin.call(
        PluginService.method.getConnection,
        {},
        CALL_DEADLINE_MILLISECONDS,
      );

      expect(compatibleConnection.connection?.capabilities).toEqual([
        ...STOCK_CAPABILITIES,
        ...COHERENT_PROGRESS_CAPABILITIES,
      ]);
      expect(playbackOnlyConnection.connection?.capabilities).toEqual([
        ...STOCK_CAPABILITIES,
        ...PLAYBACK_EXTENSION_CAPABILITIES,
      ]);
      expect(absentConnection.connection?.capabilities).toEqual(STOCK_CAPABILITIES);
      expect(incompatibleConnection.connection?.capabilities).toEqual(STOCK_CAPABILITIES);
      expect(compatible.requests.at(-1)).toMatchObject({
        authorization: 'MediaBrowser Token="jellyfin-api-key-sentinel"',
        method: "GET",
        url: "/jellyfin/Nama/v1/handshake",
      });
    }).pipe(Effect.provide(PluginSupervisor.layer())),
  ),
);

it.live("rejects playback dispatch without a compatible extension handshake", () => {
  const requests: string[] = [];
  const now = Date.now();
  const playbackHandler = lifecycleHandler({
    planExpiresAt: new Date(now + 5 * 60 * 1000).toISOString(),
    requests,
    sessionExpiresAt: new Date(now + 60 * 60 * 1000).toISOString(),
  });
  const incompatibleHandshake = connectionHandler({
    capabilities: ["direct_progressive", "playback_telemetry"],
    extension_version: "2.0.0",
    protocol: "nama.jellyfin.extension",
    protocol_version: 1,
  });
  const handler: ControlledHandler = (request, response, observation) => {
    if (
      new URL(observation.url, "http://jellyfin.invalid").pathname === "/jellyfin/Nama/v1/handshake"
    ) {
      incompatibleHandshake(request, response, observation);
      return;
    }
    playbackHandler(request, response, observation);
  };
  return Effect.scoped(
    Effect.gen(function* incompatiblePlaybackScenario() {
      const jellyfin = yield* controlledJellyfin(handler);
      const supervisor = yield* PluginSupervisor;
      const plugin = yield* superviseJellyfin(supervisor, jellyfin, {
        providerInstanceId: "incompatible-playback-extension",
      });

      const failure = yield* plugin
        .call(PlaybackService.method.planPlayback, directPlanRequest, CALL_DEADLINE_MILLISECONDS)
        .pipe(
          Effect.flatMap(() => Effect.fail(new Error("playback unexpectedly dispatched"))),
          Effect.flip,
        );

      expect(failure).toMatchObject({ _tag: "PluginRpcError", code: Code.Unimplemented });
      expect(requests).toEqual([]);
    }).pipe(Effect.provide(PluginSupervisor.layer())),
  );
});

it.live("retains stock capabilities when the optional extension handshake stalls", () => {
  const baseConnectionHandler = connectionHandler();
  const handler: ControlledHandler = (request, response, observation) => {
    const endpoint = new URL(observation.url, "http://jellyfin.invalid");
    if (endpoint.pathname === "/jellyfin/Nama/v1/handshake") {
      return;
    }
    baseConnectionHandler(request, response, observation);
  };
  return Effect.scoped(
    Effect.gen(function* stalledHandshakeScenario() {
      const jellyfin = yield* controlledJellyfin(handler);
      const supervisor = yield* PluginSupervisor;
      const plugin = yield* superviseJellyfin(supervisor, jellyfin, {
        providerInstanceId: "stalled-extension-handshake",
      });

      const connection = yield* plugin.call(PluginService.method.getConnection, {}, 3000);

      expect(connection.connection?.capabilities).toEqual(STOCK_CAPABILITIES);
    }).pipe(Effect.provide(PluginSupervisor.layer())),
  );
});

it.live("translates one complete scoped direct-progressive lifecycle", () => {
  const extensionRequests: string[] = [];
  const planExpiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
  const sessionExpiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  return Effect.scoped(
    Effect.gen(function* directProgressiveScenario() {
      const jellyfin = yield* controlledJellyfin(
        lifecycleHandler({ planExpiresAt, requests: extensionRequests, sessionExpiresAt }),
      );
      const supervisor = yield* PluginSupervisor;
      const plugin = yield* superviseJellyfin(supervisor, jellyfin, {
        providerInstanceId: "direct-progressive-extension",
      });

      const planned = yield* plugin.call(
        PlaybackService.method.planPlayback,
        directPlanRequest,
        CALL_DEADLINE_MILLISECONDS,
      );
      expect(planned.plan).toMatchObject({
        actions: [{ action: TrackActionKind.COPY, trackReference: audioTrackReference }],
        audioCodec: "aac",
        container: "mp4",
        defaultAudioTrackReference: audioTrackReference,
        defaultSubtitle: { selection: { case: "disabled", value: true } },
        id: "opaque-plan",
        protocol: DeliveryProtocol.HTTP_PROGRESSIVE,
        strategy: PlaybackStrategy.DIRECT,
        tracks: [
          {
            details: { case: "audio", value: { channelCount: 2, codec: "aac" } },
            trackReference: audioTrackReference,
            type: PlaybackTrackType.AUDIO,
          },
        ],
        videoCodec: "h264",
      });

      const opened = yield* plugin.call(
        PlaybackService.method.openPlayback,
        {
          audioTrackReference,
          operationId: "open-operation",
          planId: "opaque-plan",
          subtitle: { selection: { case: "disabled", value: true } },
        },
        CALL_DEADLINE_MILLISECONDS,
      );
      expect(opened.lease).toMatchObject({
        authorizationScope: PlaybackAuthorizationScope.SESSION,
        headers: [{ name: "X-Nama-Playback-Lease", value: "scoped-lease-sentinel" }],
        mimeType: "video/mp4",
        protocol: DeliveryProtocol.HTTP_PROGRESSIVE,
        reportInterval: { nanos: 0, seconds: 15n },
        selectedAudioTrackReference: audioTrackReference,
        selectedSubtitle: { selection: { case: "disabled", value: true } },
        sessionId: "opaque-session",
        tracks: [{ switchableWithoutReopen: false, trackReference: audioTrackReference }],
      });
      expect(opened.lease?.url).toBe(`${jellyfin.baseUrl}/Nama/v1/playback/opaque-media-resource`);
      expect(opened.lease?.url).not.toContain(MEDIA_ITEM_ID);
      expect(opened.lease?.url).not.toContain(MEDIA_SOURCE_ID);
      expect(opened.lease?.url).not.toContain("jellyfin-api-key-sentinel");
      const sessionContext = opened.lease?.sessionContext;
      if (sessionContext === undefined) {
        throw new Error("extension session context was absent");
      }

      yield* plugin.call(
        PlaybackService.method.reportPlayback,
        {
          eventId: "report-event",
          position: { nanos: 0, seconds: 1n },
          sequence: 1n,
          sessionContext,
          sessionId: "opaque-session",
          state: PlaybackState.PLAYING,
        },
        CALL_DEADLINE_MILLISECONDS,
      );
      yield* plugin.call(
        PlaybackService.method.closePlayback,
        {
          finalPosition: { nanos: 0, seconds: 1n },
          operationId: "close-operation",
          reason: PlaybackCloseReason.STOPPED,
          sessionContext,
          sessionId: "opaque-session",
        },
        CALL_DEADLINE_MILLISECONDS,
      );

      expect(extensionRequests).toContain(
        "POST /jellyfin/Nama/v1/playback/sessions/opaque-session/reports",
      );
      expect(extensionRequests).toContain(
        "POST /jellyfin/Nama/v1/playback/sessions/opaque-session/close",
      );
    }).pipe(Effect.provide(PluginSupervisor.layer())),
  );
});

it.live("translates opaque HLS delivery with provider-evidenced subtitle tracks", () => {
  const requests: string[] = [];
  const planBodies: unknown[] = [];
  const planExpiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
  const sessionExpiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  return Effect.scoped(
    Effect.gen(function* hlsSubtitleScenario() {
      const jellyfin = yield* controlledJellyfin(
        lifecycleHandler({
          planBodies,
          planExpiresAt,
          planResponse: {
            actions: [
              { action: "copy", track_index: 1 },
              { action: "external", track_index: 3 },
            ],
            audio_codec: "aac",
            container: "mp4",
            default_audio_track_index: 1,
            default_subtitle_track_index: 3,
            expires_at: planExpiresAt,
            plan_id: "opaque-hls-plan",
            protocol: "hls",
            strategy: "remux",
            tracks: [
              {
                channels: 2,
                codec: "aac",
                index: 1,
                is_default: true,
                is_forced: false,
                language: "eng",
                type: "audio",
              },
              {
                codec: "vtt",
                index: 3,
                is_default: true,
                is_forced: false,
                language: "eng",
                representation: "text",
                type: "subtitle",
              },
            ],
            video_codec: "h264",
          },
          requests,
          sessionExpiresAt,
          sessionResponse: {
            expires_at: sessionExpiresAt,
            external_subtitles: [
              {
                media_resource: "opaque-subtitle-resource",
                mime_type: "text/vtt",
                track_index: 3,
              },
            ],
            item_id: MEDIA_ITEM_ID,
            lease: "scoped-lease-sentinel",
            media_resource: "opaque-media-resource",
            mime_type: "application/vnd.apple.mpegurl",
            protocol: "hls",
            report_interval_seconds: 15,
            selected_audio_track_index: 1,
            selected_subtitle_track_index: 3,
            session_context: "c2Vzc2lvbi1jb250ZXh0",
            session_id: "opaque-session",
            source_id: MEDIA_SOURCE_ID,
            tracks: [
              { index: 1, switchable_without_reopen: false },
              { index: 3, switchable_without_reopen: false },
            ],
          },
        }),
      );
      const supervisor = yield* PluginSupervisor;
      const plugin = yield* superviseJellyfin(supervisor, jellyfin, {
        providerInstanceId: "hls-subtitle-extension",
      });
      const planned = yield* plugin.call(
        PlaybackService.method.planPlayback,
        {
          ...directPlanRequest,
          capabilities: {
            ...directPlanRequest.capabilities,
            protocols: [DeliveryProtocol.HLS],
            subtitleCapabilities: [
              { deliveryModes: [SubtitleDeliveryMode.EXTERNAL], format: "vtt" },
            ],
          },
          preferences: {
            ...directPlanRequest.preferences,
            preferredSubtitleLanguages: ["eng"],
            subtitlePreference: SubtitlePreference.ALWAYS,
          },
        },
        CALL_DEADLINE_MILLISECONDS,
      );
      expect(planBodies).toEqual([
        {
          capabilities: {
            direct_play_profiles: [
              { audio_codecs: ["aac"], container: "mp4", video_codec: "h264" },
            ],
            dynamic_ranges: ["sdr"],
            protocols: ["hls"],
            subtitle_capabilities: [{ delivery_modes: ["external"], format: "vtt" }],
          },
          item_id: MEDIA_ITEM_ID,
          preferences: {
            preferred_audio_languages: [],
            preferred_subtitle_languages: ["eng"],
            quality: "auto",
            subtitle_preference: "always",
          },
          source_id: MEDIA_SOURCE_ID,
          start_position: { nanos: 0, seconds: "0" },
          user_id: USER_ID,
        },
      ]);
      expect(planned.plan).toMatchObject({
        actions: [
          { action: TrackActionKind.COPY, trackReference: audioTrackReference },
          { action: TrackActionKind.EXTERNAL, trackReference: subtitleTrackReference },
        ],
        defaultSubtitle: {
          selection: { case: "trackReference", value: subtitleTrackReference },
        },
        protocol: DeliveryProtocol.HLS,
        strategy: PlaybackStrategy.REMUX,
        tracks: [
          { trackReference: audioTrackReference, type: PlaybackTrackType.AUDIO },
          {
            details: {
              case: "subtitle",
              value: { codec: "vtt", representation: SubtitleRepresentation.TEXT },
            },
            trackReference: subtitleTrackReference,
            type: PlaybackTrackType.SUBTITLE,
          },
        ],
      });
      const opened = yield* plugin.call(
        PlaybackService.method.openPlayback,
        {
          audioTrackReference,
          operationId: "open-hls-operation",
          planId: "opaque-hls-plan",
          subtitle: { selection: { case: "trackReference", value: subtitleTrackReference } },
        },
        CALL_DEADLINE_MILLISECONDS,
      );
      expect(opened.lease).toMatchObject({
        externalSubtitles: [
          {
            headers: [{ name: "X-Nama-Playback-Lease", value: "scoped-lease-sentinel" }],
            mimeType: "text/vtt",
            trackReference: subtitleTrackReference,
          },
        ],
        mimeType: "application/vnd.apple.mpegurl",
        protocol: DeliveryProtocol.HLS,
        selectedSubtitle: {
          selection: { case: "trackReference", value: subtitleTrackReference },
        },
      });
      expect(opened.lease?.externalSubtitles[0]?.url).toBe(
        `${jellyfin.baseUrl}/Nama/v1/playback/opaque-subtitle-resource`,
      );
    }).pipe(Effect.provide(PluginSupervisor.layer())),
  );
});

it.live("rejects extension plan and session expiries beyond their contract bounds", () => {
  const requests: string[] = [];
  const now = Date.now();
  return Effect.scoped(
    Effect.gen(function* expiryBoundsScenario() {
      const supervisor = yield* PluginSupervisor;
      const overlongPlanServer = yield* controlledJellyfin(
        lifecycleHandler({
          planExpiresAt: new Date(now + 6 * 60 * 1000).toISOString(),
          requests,
          sessionExpiresAt: new Date(now + 60 * 60 * 1000).toISOString(),
        }),
      );
      const overlongPlanPlugin = yield* superviseJellyfin(supervisor, overlongPlanServer, {
        providerInstanceId: "overlong-plan-extension",
      });
      const planExit = yield* Effect.exit(
        overlongPlanPlugin.call(
          PlaybackService.method.planPlayback,
          directPlanRequest,
          CALL_DEADLINE_MILLISECONDS,
        ),
      );
      expect(Exit.isFailure(planExit)).toBe(true);

      const overlongSessionServer = yield* controlledJellyfin(
        lifecycleHandler({
          planExpiresAt: new Date(now + 5 * 60 * 1000).toISOString(),
          requests,
          sessionExpiresAt: new Date(now + 25 * 60 * 60 * 1000).toISOString(),
        }),
      );
      const overlongSessionPlugin = yield* superviseJellyfin(supervisor, overlongSessionServer, {
        providerInstanceId: "overlong-session-extension",
      });
      const plan = yield* overlongSessionPlugin.call(
        PlaybackService.method.planPlayback,
        directPlanRequest,
        CALL_DEADLINE_MILLISECONDS,
      );
      const openExit = yield* Effect.exit(
        overlongSessionPlugin.call(
          PlaybackService.method.openPlayback,
          {
            audioTrackReference,
            operationId: "overlong-session-open",
            planId: plan.plan?.id ?? "missing-plan",
            subtitle: { selection: { case: "disabled", value: true } },
          },
          CALL_DEADLINE_MILLISECONDS,
        ),
      );
      expect(Exit.isFailure(openExit)).toBe(true);
    }).pipe(Effect.provide(PluginSupervisor.layer())),
  );
});

it.live("rejects extension plan identifiers outside the plugin contract", () => {
  const requests: string[] = [];
  const now = Date.now();
  return Effect.scoped(
    Effect.gen(function* overlongPlanIdScenario() {
      const jellyfin = yield* controlledJellyfin(
        lifecycleHandler({
          planExpiresAt: new Date(now + 5 * 60 * 1000).toISOString(),
          planId: "p".repeat(257),
          requests,
          sessionExpiresAt: new Date(now + 60 * 60 * 1000).toISOString(),
        }),
      );
      const supervisor = yield* PluginSupervisor;
      const plugin = yield* superviseJellyfin(supervisor, jellyfin, {
        providerInstanceId: "overlong-plan-id-extension",
      });

      const failure = yield* plugin
        .call(PlaybackService.method.planPlayback, directPlanRequest, CALL_DEADLINE_MILLISECONDS)
        .pipe(Effect.flip);

      expect(failure).toMatchObject({ _tag: "PluginRpcError", code: Code.Internal });
    }).pipe(Effect.provide(PluginSupervisor.layer())),
  );
});
it.live("rejects extension plans inconsistent with the submitted capabilities", () => {
  const now = Date.now();
  return Effect.scoped(
    Effect.gen(function* inconsistentPlanScenario() {
      const supervisor = yield* PluginSupervisor;
      const subtitleTrack = {
        codec: "srt",
        index: 3,
        is_default: true,
        is_forced: false,
        language: "eng",
        representation: "text",
        type: "subtitle",
      };
      const subtitlePlan = (action: "burn" | "external") => ({
        actions: [
          { action: "copy", track_index: 1 },
          { action, track_index: 3 },
        ],
        default_subtitle_track_index: 3,
        tracks: [
          {
            channels: 2,
            codec: "aac",
            index: 1,
            is_default: true,
            is_forced: false,
            label: "Main",
            language: "eng",
            type: "audio",
          },
          subtitleTrack,
        ],
      });
      const burnedSubtitleRequest = {
        ...directPlanRequest,
        capabilities: {
          ...directPlanRequest.capabilities,
          subtitleCapabilities: [
            { deliveryModes: [SubtitleDeliveryMode.BURNED_IN], format: "srt" },
          ],
        },
      };
      const cases = [
        {
          id: "inconsistent-plan-protocol",
          request: directPlanRequest,
          response: { protocol: "hls" },
        },
        {
          id: "inconsistent-plan-actions",
          request: directPlanRequest,
          response: { strategy: "transcode_audio" },
        },
        {
          id: "undeclared-external-subtitle-action",
          request: directPlanRequest,
          response: subtitlePlan("external"),
        },
        {
          id: "direct-burned-subtitle-action",
          request: burnedSubtitleRequest,
          response: subtitlePlan("burn"),
        },
      ] as const;
      for (const testCase of cases) {
        const jellyfin = yield* controlledJellyfin(
          lifecycleHandler({
            planExpiresAt: new Date(now + 5 * 60 * 1000).toISOString(),
            planResponse: testCase.response,
            requests: [],
            sessionExpiresAt: new Date(now + 60 * 60 * 1000).toISOString(),
          }),
        );
        const plugin = yield* superviseJellyfin(supervisor, jellyfin, {
          providerInstanceId: testCase.id,
        });
        const exit = yield* Effect.exit(
          plugin.call(
            PlaybackService.method.planPlayback,
            testCase.request,
            CALL_DEADLINE_MILLISECONDS,
          ),
        );
        expect(Exit.isFailure(exit)).toBe(true);
      }
    }).pipe(Effect.provide(PluginSupervisor.layer())),
  );
});

it.live("retains one lost telemetry response as redacted ambiguity without replay", () => {
  const requests: string[] = [];
  const now = Date.now();
  let reportAttempts = 0;
  const baseHandler = lifecycleHandler({
    planExpiresAt: new Date(now + 5 * 60 * 1000).toISOString(),
    requests,
    sessionExpiresAt: new Date(now + 60 * 60 * 1000).toISOString(),
  });
  const handler: ControlledHandler = (request, response, observation) => {
    if (
      new URL(observation.url, "http://jellyfin.invalid").pathname ===
      "/jellyfin/Nama/v1/playback/sessions/opaque-session/reports"
    ) {
      reportAttempts += 1;
      response.destroy();
      return;
    }
    baseHandler(request, response, observation);
  };
  return Effect.scoped(
    Effect.gen(function* telemetryAmbiguityScenario() {
      const jellyfin = yield* controlledJellyfin(handler);
      const supervisor = yield* PluginSupervisor;
      const plugin = yield* superviseJellyfin(supervisor, jellyfin, {
        providerInstanceId: "telemetry-ambiguity-extension",
      });
      const plan = yield* plugin.call(
        PlaybackService.method.planPlayback,
        directPlanRequest,
        CALL_DEADLINE_MILLISECONDS,
      );
      const opened = yield* plugin.call(
        PlaybackService.method.openPlayback,
        {
          audioTrackReference,
          operationId: "ambiguity-open",
          planId: plan.plan?.id ?? "missing-plan",
          subtitle: { selection: { case: "disabled", value: true } },
        },
        CALL_DEADLINE_MILLISECONDS,
      );
      const sessionContext = opened.lease?.sessionContext;
      if (sessionContext === undefined) {
        throw new Error("ambiguity session context was absent");
      }

      const failure = yield* plugin
        .call(
          PlaybackService.method.reportPlayback,
          {
            eventId: "ambiguous-report",
            position: { nanos: 0, seconds: 1n },
            sequence: 1n,
            sessionContext,
            sessionId: "opaque-session",
            state: PlaybackState.PLAYING,
          },
          CALL_DEADLINE_MILLISECONDS,
        )
        .pipe(Effect.flip);
      expect(failure).toMatchObject({ _tag: "PluginRpcError", code: Code.Unavailable });
      expect(reportAttempts).toBe(1);
      expect(JSON.stringify(failure)).not.toContain("jellyfin-api-key-sentinel");
    }).pipe(Effect.provide(PluginSupervisor.layer())),
  );
});

it.live("rejects malformed extension output without exposing its body", () => {
  const secret = "malformed-extension-secret-sentinel";
  const requests: string[] = [];
  const baseConnectionHandler = connectionHandler({
    capabilities: ["direct_progressive", "playback_telemetry"],
    extension_version: "1.0.0",
    protocol: "nama.jellyfin.extension",
    protocol_version: 2,
  });
  const handler: ControlledHandler = (request, response, observation) => {
    const endpoint = new URL(observation.url, "http://jellyfin.invalid");
    requests.push(endpoint.pathname);
    if (endpoint.pathname === "/jellyfin/Nama/v1/playback/plans") {
      respondJson(response, { plan_id: secret, tracks: "malformed" });
      return;
    }
    baseConnectionHandler(request, response, observation);
  };
  return Effect.scoped(
    Effect.gen(function* malformedOutputScenario() {
      const jellyfin = yield* controlledJellyfin(handler);
      const supervisor = yield* PluginSupervisor;
      const plugin = yield* superviseJellyfin(supervisor, jellyfin, {
        providerInstanceId: "malformed-output-extension",
      });
      const failure = yield* plugin
        .call(PlaybackService.method.planPlayback, directPlanRequest, CALL_DEADLINE_MILLISECONDS)
        .pipe(Effect.flip);
      expect(failure).toMatchObject({ _tag: "PluginRpcError", code: Code.Internal });
      expect(JSON.stringify(failure)).not.toContain(secret);
      expect(requests).toEqual(["/jellyfin/Nama/v1/handshake", "/jellyfin/Nama/v1/playback/plans"]);
    }).pipe(Effect.provide(PluginSupervisor.layer())),
  );
});

it.live("propagates playback planning cancellation to the extension request", () => {
  const requestStarted = Promise.withResolvers<void>();
  const cancellationObserved = Promise.withResolvers<void>();
  let planningRequests = 0;
  const baseConnectionHandler = connectionHandler({
    capabilities: ["direct_progressive", "playback_telemetry"],
    extension_version: "1.0.0",
    protocol: "nama.jellyfin.extension",
    protocol_version: 2,
  });
  const handler: ControlledHandler = (request, response, observation) => {
    const endpoint = new URL(observation.url, "http://jellyfin.invalid");
    if (endpoint.pathname === "/jellyfin/Nama/v1/playback/plans") {
      planningRequests += 1;
      response.once("close", () => {
        cancellationObserved.resolve();
      });
      requestStarted.resolve();
      return;
    }
    baseConnectionHandler(request, response, observation);
  };
  return Effect.scoped(
    Effect.gen(function* playbackCancellationScenario() {
      const jellyfin = yield* controlledJellyfin(handler);
      const supervisor = yield* PluginSupervisor;
      const plugin = yield* superviseJellyfin(supervisor, jellyfin, {
        providerInstanceId: "canceled-playback-extension",
      });
      const call = yield* Effect.forkChild(
        plugin.call(
          PlaybackService.method.planPlayback,
          directPlanRequest,
          CALL_DEADLINE_MILLISECONDS,
        ),
      );
      yield* Effect.promise(() => requestStarted.promise);
      yield* Fiber.interrupt(call);
      yield* Effect.promise(() => cancellationObserved.promise);
      expect(planningRequests).toBe(1);
    }).pipe(Effect.provide(PluginSupervisor.layer())),
  );
});
