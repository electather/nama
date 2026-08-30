import { MIMEType } from "node:util";

import {
  DeliveryProtocol,
  PlaybackAuthorizationScope,
} from "@nama/api/nama/plugin/v1/playback_pb.js";
import type { OpenPlaybackRequest } from "@nama/api/nama/plugin/v1/playback_pb.js";

import {
  EXTENSION_PATH,
  extensionRequest,
  postExtension,
  providerSessionTrack,
} from "./extension-playback-client.ts";
import {
  canonicalBase64Url,
  futureTimestamp,
  invalidExtensionResponse,
  requiredArray,
  requiredInteger,
  requiredJellyfinIndex,
  requiredText,
  subtitleIndex,
  trackIndex,
  trackReference,
} from "./extension-playback-values.ts";
import type { ProviderLaunchDocument } from "./launch-document.ts";
import type { JellyfinRequest } from "./request.ts";

const HOURS_PER_DAY = 24;
const LEASE_HEADER = "X-Nama-Playback-Lease";
const MAXIMUM_IDENTIFIER_BYTES = 256;
const MAXIMUM_MEDIA_RESOURCE_BYTES = 1024;
const MAXIMUM_REPORT_INTERVAL_SECONDS = 300;
const MAXIMUM_TOKEN_BYTES = 8192;
const MILLISECONDS_PER_HOUR = 3_600_000;
const MINIMUM_REPORT_INTERVAL_SECONDS = 1;
const MAXIMUM_SESSION_LIFETIME_MILLISECONDS = HOURS_PER_DAY * MILLISECONDS_PER_HOUR;
const ZERO_NANOSECONDS = 0;

interface OpenIdentity {
  readonly itemId: string;
  readonly mediaResource: string;
  readonly mimeType: string;
  readonly selectedAudioIndex: number;
  readonly sessionId: string;
  readonly sourceId: string;
  readonly url: string;
}

const normalizedMimeType = (value: unknown): string => {
  const text = requiredText(value, MAXIMUM_IDENTIFIER_BYTES);
  try {
    const mimeType = new MIMEType(text);
    if (mimeType.type !== "video" && mimeType.type !== "audio") {
      return invalidExtensionResponse();
    }
    return mimeType.essence;
  } catch {
    return invalidExtensionResponse();
  }
};

const openIdentity = (
  body: Readonly<Record<string, unknown>>,
  request: JellyfinRequest,
): OpenIdentity => {
  const itemId = requiredText(body["item_id"], MAXIMUM_IDENTIFIER_BYTES);
  const sourceId = requiredText(body["source_id"], MAXIMUM_IDENTIFIER_BYTES);
  const sessionId = requiredText(body["session_id"], MAXIMUM_IDENTIFIER_BYTES);
  const mediaResource = requiredText(body["media_resource"], MAXIMUM_MEDIA_RESOURCE_BYTES);
  const url = request.resourceUrl([...EXTENSION_PATH, mediaResource]);
  if (url === undefined || body["selected_subtitle_track_index"] !== undefined) {
    return invalidExtensionResponse();
  }
  return {
    itemId,
    mediaResource,
    mimeType: normalizedMimeType(body["mime_type"]),
    selectedAudioIndex: requiredJellyfinIndex(body["selected_audio_track_index"]),
    sessionId,
    sourceId,
    url,
  };
};

const reportInterval = (value: unknown) => ({
  $typeName: "google.protobuf.Duration" as const,
  nanos: ZERO_NANOSECONDS,
  seconds: BigInt(
    requiredInteger(value, MINIMUM_REPORT_INTERVAL_SECONDS, MAXIMUM_REPORT_INTERVAL_SECONDS),
  ),
});

const disabledSubtitleSelection = () => ({
  $typeName: "nama.plugin.v1.ProviderSubtitleSelection" as const,
  selection: { case: "disabled" as const, value: true },
});

const openResponse = (body: Readonly<Record<string, unknown>>, request: JellyfinRequest) => {
  const identity = openIdentity(body, request);
  return {
    $typeName: "nama.plugin.v1.OpenPlaybackResponse" as const,
    lease: {
      $typeName: "nama.plugin.v1.PlaybackLease" as const,
      allowedRedirectOrigins: [request.origin],
      authorizationScope: PlaybackAuthorizationScope.SESSION,
      expiresAt: futureTimestamp(body["expires_at"], MAXIMUM_SESSION_LIFETIME_MILLISECONDS),
      externalSubtitles: [],
      headers: [
        {
          $typeName: "nama.plugin.v1.HttpHeader" as const,
          name: LEASE_HEADER,
          value: requiredText(body["lease"], MAXIMUM_TOKEN_BYTES),
        },
      ],
      mimeType: identity.mimeType,
      protocol: DeliveryProtocol.HTTP_PROGRESSIVE,
      reportInterval: reportInterval(body["report_interval_seconds"]),
      selectedAudioTrackReference: trackReference(
        identity.itemId,
        identity.sourceId,
        identity.selectedAudioIndex,
      ),
      selectedSubtitle: disabledSubtitleSelection(),
      sessionContext: canonicalBase64Url(body["session_context"]),
      sessionId: identity.sessionId,
      tracks: requiredArray(body["tracks"]).map((value) =>
        providerSessionTrack(value, identity.itemId, identity.sourceId),
      ),
      url: identity.url,
    },
  };
};

const openJellyfinPlayback = async (
  launch: ProviderLaunchDocument,
  input: OpenPlaybackRequest,
  signal: AbortSignal,
) => {
  const request = extensionRequest(launch);
  const body = await postExtension({
    body: {
      audio_track_index: trackIndex(input.audioTrackReference),
      operation_id: input.operationId,
      plan_id: input.planId,
      subtitle_track_index: subtitleIndex(input.subtitle),
    },
    path: ["sessions"],
    request,
    signal,
  });
  return openResponse(body, request);
};

export { openJellyfinPlayback };
