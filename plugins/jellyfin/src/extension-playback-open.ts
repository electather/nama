import { MIMEType } from "node:util";

import {
  DeliveryProtocol,
  PlaybackAuthorizationScope,
} from "@nama/api/nama/plugin/v1/playback_pb.js";
import type { OpenPlaybackRequest } from "@nama/api/nama/plugin/v1/playback_pb.js";

import {
  EXTENSION_PATH,
  deliveryProtocol,
  extensionRequest,
  postExtension,
  providerSessionTrack,
} from "./extension-playback-client.ts";
import {
  canonicalBase64Url,
  futureTimestamp,
  invalidExtensionResponse,
  optionalJellyfinIndex,
  requiredArray,
  requiredInteger,
  requiredJellyfinIndex,
  requiredText,
  subtitleIndex,
  trackIndex,
  trackReference,
} from "./extension-playback-values.ts";
import type { ProtobufTimestamp } from "./extension-playback-values.ts";
import type { ProviderLaunchDocument } from "./launch-document.ts";
import type { JellyfinRequest } from "./request.ts";
import { isUnknownRecord } from "./value.ts";

const HOURS_PER_DAY = 24;
const LEASE_HEADER = "X-Nama-Playback-Lease";
const MAXIMUM_IDENTIFIER_BYTES = 256;
const MAXIMUM_MEDIA_RESOURCE_BYTES = 7168;
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
  readonly protocol: DeliveryProtocol;
  readonly selectedAudioIndex: number;
  readonly selectedSubtitleIndex: number | undefined;
  readonly sessionId: string;
  readonly sourceId: string;
  readonly url: string;
}

const normalizedMimeType = (value: unknown, protocol?: DeliveryProtocol): string => {
  const text = requiredText(value, MAXIMUM_IDENTIFIER_BYTES);
  try {
    const mimeType = new MIMEType(text);
    const isProgressiveMedia =
      protocol === DeliveryProtocol.HTTP_PROGRESSIVE &&
      (mimeType.type === "video" || mimeType.type === "audio");
    const isHls =
      protocol === DeliveryProtocol.HLS && mimeType.essence === "application/vnd.apple.mpegurl";
    const isSubtitle =
      protocol === undefined &&
      (mimeType.type === "text" ||
        mimeType.essence === "application/vnd.apple.mpegurl" ||
        mimeType.essence === "application/x-subrip" ||
        mimeType.essence === "application/octet-stream");
    if (!isProgressiveMedia && !isHls && !isSubtitle) {
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
  if (url === undefined) {
    return invalidExtensionResponse();
  }
  const protocol = deliveryProtocol(body["protocol"]);
  const selectedSubtitleIndex = optionalJellyfinIndex(body["selected_subtitle_track_index"]);
  return {
    itemId,
    mediaResource,
    mimeType: normalizedMimeType(body["mime_type"], protocol),
    protocol,
    selectedAudioIndex: requiredJellyfinIndex(body["selected_audio_track_index"]),
    selectedSubtitleIndex,
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

const leaseHeaders = (lease: unknown) => [
  {
    $typeName: "nama.plugin.v1.HttpHeader" as const,
    name: LEASE_HEADER,
    value: requiredText(lease, MAXIMUM_TOKEN_BYTES),
  },
];

const subtitleSelection = (
  itemId: string,
  sourceId: string,
  trackIndexValue: number | undefined,
) => {
  if (trackIndexValue === undefined) {
    return disabledSubtitleSelection();
  }
  return {
    $typeName: "nama.plugin.v1.ProviderSubtitleSelection" as const,
    selection: {
      case: "trackReference" as const,
      value: trackReference(itemId, sourceId, trackIndexValue),
    },
  };
};

interface ExternalSubtitleInput {
  readonly expiresAt: ProtobufTimestamp;
  readonly identity: OpenIdentity;
  readonly lease: unknown;
  readonly request: JellyfinRequest;
  readonly value: unknown;
}

const externalSubtitle = ({
  expiresAt,
  identity,
  lease,
  request,
  value,
}: ExternalSubtitleInput) => {
  if (!isUnknownRecord(value)) {
    return invalidExtensionResponse();
  }
  const mediaResource = requiredText(value["media_resource"], MAXIMUM_MEDIA_RESOURCE_BYTES);
  const url = request.resourceUrl([...EXTENSION_PATH, mediaResource]);
  if (url === undefined) {
    return invalidExtensionResponse();
  }
  return {
    $typeName: "nama.plugin.v1.ProviderExternalSubtitleLocator" as const,
    allowedRedirectOrigins: [request.origin],
    expiresAt,
    headers: leaseHeaders(lease),
    mimeType: normalizedMimeType(value["mime_type"]),
    trackReference: trackReference(
      identity.itemId,
      identity.sourceId,
      requiredJellyfinIndex(value["track_index"]),
    ),
    url,
  };
};

const disabledSubtitleSelection = () => ({
  $typeName: "nama.plugin.v1.ProviderSubtitleSelection" as const,
  selection: { case: "disabled" as const, value: true },
});

interface OpenParsing {
  readonly body: Readonly<Record<string, unknown>>;
  readonly expiresAt: ProtobufTimestamp;
  readonly identity: OpenIdentity;
  readonly lease: unknown;
  readonly request: JellyfinRequest;
}

const sessionResources = ({ body, expiresAt, identity, lease, request }: OpenParsing) => {
  const tracks = requiredArray(body["tracks"]).map((value) =>
    providerSessionTrack(value, identity.itemId, identity.sourceId),
  );
  const trackIds = tracks.map(({ trackReference: reference }) => reference?.trackId);
  const externalSubtitles = requiredArray(body["external_subtitles"]).map((value) =>
    externalSubtitle({ expiresAt, identity, lease, request, value }),
  );
  const externalTrackIds = externalSubtitles.map(
    ({ trackReference: reference }) => reference?.trackId,
  );
  if (
    new Set(trackIds).size !== trackIds.length ||
    new Set(externalTrackIds).size !== externalTrackIds.length ||
    !trackIds.includes(String(identity.selectedAudioIndex)) ||
    (identity.selectedSubtitleIndex !== undefined &&
      !trackIds.includes(String(identity.selectedSubtitleIndex))) ||
    externalTrackIds.some((trackId) => !trackIds.includes(trackId))
  ) {
    return invalidExtensionResponse();
  }
  return { externalSubtitles, tracks };
};

const openResponse = (body: Readonly<Record<string, unknown>>, request: JellyfinRequest) => {
  const identity = openIdentity(body, request);
  const expiresAt = futureTimestamp(body["expires_at"], MAXIMUM_SESSION_LIFETIME_MILLISECONDS);
  const { lease } = body;
  const { externalSubtitles, tracks } = sessionResources({
    body,
    expiresAt,
    identity,
    lease,
    request,
  });
  return {
    $typeName: "nama.plugin.v1.OpenPlaybackResponse" as const,
    lease: {
      $typeName: "nama.plugin.v1.PlaybackLease" as const,
      allowedRedirectOrigins: [request.origin],
      authorizationScope: PlaybackAuthorizationScope.SESSION,
      expiresAt,
      externalSubtitles,
      headers: leaseHeaders(lease),
      mimeType: identity.mimeType,
      protocol: identity.protocol,
      reportInterval: reportInterval(body["report_interval_seconds"]),
      selectedAudioTrackReference: trackReference(
        identity.itemId,
        identity.sourceId,
        identity.selectedAudioIndex,
      ),
      selectedSubtitle: subtitleSelection(
        identity.itemId,
        identity.sourceId,
        identity.selectedSubtitleIndex,
      ),
      sessionContext: canonicalBase64Url(body["session_context"]),
      sessionId: identity.sessionId,
      tracks,
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
      subtitle_disabled:
        input.subtitle?.selection.case === "disabled" && input.subtitle.selection.value,
      subtitle_track_index: subtitleIndex(input.subtitle),
    },
    path: ["sessions"],
    request,
    signal,
  });
  return openResponse(body, request);
};

export { openJellyfinPlayback };
