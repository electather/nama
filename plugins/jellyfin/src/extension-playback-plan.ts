import { DeliveryProtocol } from "@nama/api/nama/plugin/v1/playback_pb.js";
import type { PlanPlaybackRequest } from "@nama/api/nama/plugin/v1/playback_pb.js";

import {
  directStrategy,
  extensionAction,
  extensionRequest,
  extensionTrack,
  postExtension,
  progressiveProtocol,
  providerTrack,
} from "./extension-playback-client.ts";
import {
  durationBody,
  futureTimestamp,
  invalidExtensionResponse,
  optionalText,
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
const UNSPECIFIED_PREFERENCE = 0;

interface PlanSource {
  readonly item_id: string;
  readonly source_id: string;
}

const deliveryProtocolName = (protocol: DeliveryProtocol): string => {
  if (protocol === DeliveryProtocol.HTTP_PROGRESSIVE) {
    return "http_progressive";
  }
  return "unsupported";
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
    protocols: input.capabilities?.protocols.map((protocol) => deliveryProtocolName(protocol)),
  },
  item_id: source.item_id,
  preferences: {
    max_bit_rate_bps: input.preferences?.maxBitRateBps?.toString(),
    quality: input.preferences?.quality ?? UNSPECIFIED_PREFERENCE,
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

const planFromBody = (body: Readonly<Record<string, unknown>>, source: PlanSource) => {
  const tracks = uniqueTracks(body["tracks"]);
  const defaultAudioIndex = requiredJellyfinIndex(body["default_audio_track_index"]);
  if (body["default_subtitle_track_index"] !== undefined) {
    return invalidExtensionResponse();
  }
  return {
    $typeName: "nama.plugin.v1.PlanPlaybackResponse" as const,
    plan: {
      $typeName: "nama.plugin.v1.PluginPlaybackPlan" as const,
      actions: requiredArray(body["actions"]).map((action) =>
        extensionAction(action, source.item_id, source.source_id),
      ),
      audioCodec: optionalText(body["audio_codec"]),
      container: requiredText(body["container"], MAXIMUM_IDENTIFIER_BYTES),
      defaultAudioTrackReference: trackReference(
        source.item_id,
        source.source_id,
        defaultAudioIndex,
      ),
      defaultSubtitle: {
        $typeName: "nama.plugin.v1.ProviderSubtitleSelection" as const,
        selection: { case: "disabled" as const, value: true },
      },
      expiresAt: futureTimestamp(body["expires_at"], MAXIMUM_PLAN_LIFETIME_MILLISECONDS),
      id: requiredText(body["plan_id"], MAXIMUM_IDENTIFIER_BYTES),
      protocol: progressiveProtocol(body["protocol"]),
      strategy: directStrategy(body["strategy"]),
      tracks: tracks.map((track) => providerTrack(track, source.item_id, source.source_id)),
      videoCodec: optionalText(body["video_codec"]),
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
  return planFromBody(body, source);
};

export { planJellyfinPlayback };
