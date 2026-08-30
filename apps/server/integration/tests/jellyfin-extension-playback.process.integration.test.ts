// oxlint-disable eslint/max-lines-per-function, eslint/max-statements, eslint/no-magic-numbers, unicorn/max-nested-calls -- The private extension process proof keeps each ordered protocol lifecycle and exact expiry boundary visible.
import { Code } from "@connectrpc/connect";
import { expect, it } from "@effect/vitest";
import {
  DeliveryProtocol,
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
const EXTENSION_CAPABILITIES = [
  ProviderCapability.PLAYBACK_PLAN,
  ProviderCapability.PLAYBACK_OPEN,
  ProviderCapability.PLAYBACK_REPORT,
  ProviderCapability.PLAYBACK_REPORTS_USER_STATE,
];
const MEDIA_ITEM_ID = "0123456789abcdef0123456789abcdef";
const MEDIA_SOURCE_ID = "source-1";
const AUDIO_TRACK_ID = "1";

const sourceReference = {
  itemReference: { itemId: MEDIA_ITEM_ID },
  sourceId: MEDIA_SOURCE_ID,
};
const audioTrackReference = {
  partReference: { partId: MEDIA_SOURCE_ID, sourceReference },
  trackId: AUDIO_TRACK_ID,
};

const directPlanRequest = {
  capabilities: {
    directPlayProfiles: [{ audioCodecs: ["aac"], container: "mp4", videoCodec: "h264" }],
    dynamicRanges: [],
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
  readonly planId?: string;
  readonly requests: string[];
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
    planId = "opaque-plan",
    requests,
    sessionExpiresAt,
  }: LifecycleHandlerOptions): ControlledHandler =>
  (request, response, { url }) => {
    const endpoint = new URL(url, "http://jellyfin.invalid");
    requests.push(`${request.method ?? ""} ${endpoint.pathname}`);
    if (endpoint.pathname === "/jellyfin/Nama/v1/playback/plans") {
      respondJson(response, {
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
      });
      return;
    }
    if (endpoint.pathname === "/jellyfin/Nama/v1/playback/sessions") {
      respondJson(response, {
        expires_at: sessionExpiresAt,
        item_id: MEDIA_ITEM_ID,
        lease: "scoped-lease-sentinel",
        media_resource: "opaque-media-resource",
        mime_type: "video/mp4",
        report_interval_seconds: 15,
        selected_audio_track_index: 1,
        session_context: "c2Vzc2lvbi1jb250ZXh0",
        session_id: "opaque-session",
        source_id: MEDIA_SOURCE_ID,
        tracks: [{ index: 1, switchable_without_reopen: false }],
      });
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
      protocol_version: 1,
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
          capabilities: ["direct_progressive", "playback_telemetry"],
          extension_version: "1.0.0",
          protocol: "nama.jellyfin.extension",
          protocol_version: 1,
        }),
      );
      const absent = yield* controlledJellyfin(connectionHandler());
      const incompatible = yield* controlledJellyfin(
        connectionHandler({
          capabilities: ["direct_progressive", "playback_telemetry"],
          extension_version: "2.0.0",
          protocol: "nama.jellyfin.extension",
          protocol_version: 2,
        }),
      );
      const supervisor = yield* PluginSupervisor;
      const compatiblePlugin = yield* superviseJellyfin(supervisor, compatible, {
        providerInstanceId: "compatible-extension",
      });
      const absentPlugin = yield* superviseJellyfin(supervisor, absent, {
        providerInstanceId: "absent-extension",
      });
      const incompatiblePlugin = yield* superviseJellyfin(supervisor, incompatible, {
        providerInstanceId: "incompatible-extension",
      });

      const compatibleConnection = yield* compatiblePlugin.call(
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
        ...EXTENSION_CAPABILITIES,
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
    protocol_version: 1,
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
      expect(requests).toEqual(["/jellyfin/Nama/v1/playback/plans"]);
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
    protocol_version: 1,
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
