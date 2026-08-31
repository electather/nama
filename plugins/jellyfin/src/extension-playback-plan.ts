import { DynamicRange } from "@nama/api/nama/plugin/v1/media_pb.js";
import {
  DeliveryProtocol,
  PlaybackQuality,
  PlaybackTrackType,
  SubtitleDeliveryMode,
  SubtitlePreference,
} from "@nama/api/nama/plugin/v1/playback_pb.js";
import type { PlanPlaybackRequest } from "@nama/api/nama/plugin/v1/playback_pb.js";

import {
  deliveryProtocol,
  extensionAction,
  extensionRequest,
  extensionTrack,
  postExtension,
  playbackStrategy,
  providerTrack,
} from "./extension-playback-client.ts";
import { validatePlanOutput } from "./extension-playback-plan-validation.ts";
import {
  durationBody,
  futureTimestamp,
  invalidExtensionResponse,
  optionalJellyfinIndex,
  requiredArray,
  requiredJellyfinIndex,
  requiredText,
  sourceReferenceBody,
  trackReference,
} from "./extension-playback-values.ts";
import type { ProviderLaunchDocument } from "./launch-document.ts";

const MAXIMUM_IDENTIFIER_BYTES = 256;
const MILLISECONDS_PER_MINUTE = 60_000;
const PLAN_LIFETIME_MINUTES = 5;
const MAXIMUM_PLAN_LIFETIME_MILLISECONDS = PLAN_LIFETIME_MINUTES * MILLISECONDS_PER_MINUTE;

interface PlanSource {
  readonly item_id: string;
  readonly source_id: string;
}

const deliveryProtocolName = (protocol: DeliveryProtocol): string => {
  if (protocol === DeliveryProtocol.HTTP_PROGRESSIVE) {
    return "http_progressive";
  }
  if (protocol === DeliveryProtocol.HLS) {
    return "hls";
  }
  return "unsupported";
};

const subtitleDeliveryModeName = (mode: SubtitleDeliveryMode): string => {
  if (mode === SubtitleDeliveryMode.EMBEDDED) {
    return "embedded";
  }
  if (mode === SubtitleDeliveryMode.EXTERNAL) {
    return "external";
  }
  if (mode === SubtitleDeliveryMode.BURNED_IN) {
    return "burned_in";
  }
  return "unsupported";
};

const dynamicRangeName = (range: DynamicRange): string => {
  const ranges: Readonly<Record<number, string>> = {
    [DynamicRange.SDR]: "sdr",
    [DynamicRange.HDR10]: "hdr10",
    [DynamicRange.HDR10_PLUS]: "hdr10_plus",
    [DynamicRange.HLG]: "hlg",
    [DynamicRange.DOLBY_VISION]: "dolby_vision",
  };
  return ranges[range] ?? "unsupported";
};

const qualityName = (quality: PlaybackQuality | undefined): string => {
  const qualities: Readonly<Record<number, string>> = {
    [PlaybackQuality.AUTO]: "auto",
    [PlaybackQuality.ORIGINAL]: "original",
    [PlaybackQuality.CAPPED]: "capped",
  };
  if (quality === undefined) {
    return "unsupported";
  }
  return qualities[quality] ?? "unsupported";
};

const subtitlePreferenceName = (preference: SubtitlePreference | undefined): string => {
  const preferences: Readonly<Record<number, string>> = {
    [SubtitlePreference.AUTO]: "auto",
    [SubtitlePreference.OFF]: "off",
    [SubtitlePreference.FORCED_ONLY]: "forced_only",
    [SubtitlePreference.ALWAYS]: "always",
  };
  if (preference === undefined) {
    return "unsupported";
  }
  return preferences[preference] ?? "unsupported";
};

const planRequestBody = (
  launch: ProviderLaunchDocument,
  input: PlanPlaybackRequest,
  source: PlanSource,
) => ({
  capabilities: {
    direct_play_profiles: input.capabilities?.directPlayProfiles.map((profile) => ({
      audio_codecs: profile.audioCodecs,
      container: profile.container,
      video_codec: profile.videoCodec,
    })),
    dynamic_ranges: input.capabilities?.dynamicRanges.map((range) => dynamicRangeName(range)),
    max_audio_channels: input.capabilities?.maxAudioChannels,
    max_height: input.capabilities?.maxHeight,
    max_video_bit_depth: input.capabilities?.maxVideoBitDepth,
    max_width: input.capabilities?.maxWidth,
    protocols: input.capabilities?.protocols.map((protocol) => deliveryProtocolName(protocol)),
    subtitle_capabilities: input.capabilities?.subtitleCapabilities.map((capability) => ({
      delivery_modes: capability.deliveryModes.map((mode) => subtitleDeliveryModeName(mode)),
      format: capability.format,
    })),
  },
  item_id: source.item_id,
  preferences: {
    max_bit_rate_bps: input.preferences?.maxBitRateBps?.toString(),
    preferred_audio_languages: input.preferences?.preferredAudioLanguages,
    preferred_subtitle_languages: input.preferences?.preferredSubtitleLanguages,
    quality: qualityName(input.preferences?.quality),
    subtitle_preference: subtitlePreferenceName(input.preferences?.subtitlePreference),
  },
  source_id: source.source_id,
  start_position: durationBody(input.startPosition),
  user_id: launch.configuration.user_id,
});

const uniqueTracks = (value: unknown) => {
  const tracks = requiredArray(value).map((track) => extensionTrack(track));
  const trackIds = tracks.map(({ index }) => index);
  if (new Set(trackIds).size !== trackIds.length) {
    return invalidExtensionResponse();
  }
  return tracks;
};

const uniqueActions = (value: unknown, source: PlanSource) => {
  const actions = requiredArray(value).map((action) =>
    extensionAction(action, source.item_id, source.source_id),
  );
  const trackIds = actions.map(({ trackReference: reference }) => reference?.trackId);
  if (new Set(trackIds).size !== trackIds.length) {
    return invalidExtensionResponse();
  }
  return actions;
};

const planTracks = (body: Readonly<Record<string, unknown>>) => {
  const tracks = uniqueTracks(body["tracks"]);
  const defaultAudioIndex = requiredJellyfinIndex(body["default_audio_track_index"]);
  const defaultAudio = tracks.find(
    ({ index, type }) => index === defaultAudioIndex && type === PlaybackTrackType.AUDIO,
  );
  if (defaultAudio === undefined) {
    return invalidExtensionResponse();
  }
  const defaultSubtitleIndex = optionalJellyfinIndex(body["default_subtitle_track_index"]);
  if (
    defaultSubtitleIndex !== undefined &&
    !tracks.some(
      ({ index, type }) => index === defaultSubtitleIndex && type === PlaybackTrackType.SUBTITLE,
    )
  ) {
    return invalidExtensionResponse();
  }
  return { defaultAudioIndex, defaultSubtitleIndex, tracks };
};

const defaultSubtitle = (source: PlanSource, trackIndexValue: number | undefined) => {
  if (trackIndexValue === undefined) {
    return { case: "disabled" as const, value: true };
  }
  return {
    case: "trackReference" as const,
    value: trackReference(source.item_id, source.source_id, trackIndexValue),
  };
};

const planFromBody = (
  body: Readonly<Record<string, unknown>>,
  source: PlanSource,
  input: PlanPlaybackRequest,
) => {
  const { defaultAudioIndex, defaultSubtitleIndex, tracks } = planTracks(body);
  const actions = uniqueActions(body["actions"], source);
  const audioCodec = requiredText(body["audio_codec"], MAXIMUM_IDENTIFIER_BYTES);
  const container = requiredText(body["container"], MAXIMUM_IDENTIFIER_BYTES);
  const protocol = deliveryProtocol(body["protocol"]);
  const strategy = playbackStrategy(body["strategy"]);
  const videoCodec = requiredText(body["video_codec"], MAXIMUM_IDENTIFIER_BYTES);
  validatePlanOutput({
    actions,
    audioCodec,
    container,
    defaultAudioIndex,
    defaultSubtitleIndex,
    input,
    protocol,
    strategy,
    tracks,
    videoCodec,
  });
  return {
    $typeName: "nama.plugin.v1.PlanPlaybackResponse" as const,
    plan: {
      $typeName: "nama.plugin.v1.PluginPlaybackPlan" as const,
      actions,
      audioCodec,
      container,
      defaultAudioTrackReference: trackReference(
        source.item_id,
        source.source_id,
        defaultAudioIndex,
      ),
      defaultSubtitle: {
        $typeName: "nama.plugin.v1.ProviderSubtitleSelection" as const,
        selection: defaultSubtitle(source, defaultSubtitleIndex),
      },
      expiresAt: futureTimestamp(body["expires_at"], MAXIMUM_PLAN_LIFETIME_MILLISECONDS),
      id: requiredText(body["plan_id"], MAXIMUM_IDENTIFIER_BYTES),
      protocol,
      strategy,
      tracks: tracks.map((track) => providerTrack(track, source.item_id, source.source_id)),
      videoCodec,
    },
  };
};

const planJellyfinPlayback = async (
  launch: ProviderLaunchDocument,
  input: PlanPlaybackRequest,
  signal: AbortSignal,
) => {
  const source = sourceReferenceBody(input.sourceReference);
  const request = extensionRequest(launch);
  const body = await postExtension({
    body: planRequestBody(launch, input, source),
    path: ["plans"],
    request,
    signal,
  });
  return planFromBody(body, source, input);
};

export { planJellyfinPlayback };
