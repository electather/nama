import { Code, ConnectError } from "@connectrpc/connect";
import {
  DeliveryProtocol,
  PlaybackStrategy,
  PlaybackTrackType,
  TrackActionKind,
} from "@nama/api/nama/plugin/v1/playback_pb.js";

import {
  invalidExtensionResponse,
  optionalText,
  requiredBoolean,
  requiredInteger,
  requiredJellyfinIndex,
  requiredText,
  trackReference,
} from "./extension-playback-values.ts";
import type { ProviderLaunchDocument } from "./launch-document.ts";
import { createJellyfinRequest } from "./request.ts";
import type { JellyfinMutationResponse, JellyfinRequest } from "./request.ts";
import { isUnknownRecord } from "./value.ts";

const MAXIMUM_EXTENSION_RESPONSE_BYTES = 65_536;
const MAXIMUM_CHANNEL_COUNT = 256;
const MAXIMUM_CODEC_BYTES = 256;
const MINIMUM_CHANNEL_COUNT = 1;
const EXTENSION_PATH = ["Nama", "v1", "playback"] as const;

interface ExtensionTrack {
  readonly channels: number | undefined;
  readonly codec: string;
  readonly index: number;
  readonly isDefault: boolean;
  readonly isForced: boolean;
  readonly label: string | undefined;
  readonly language: string | undefined;
}

interface ExtensionCall {
  readonly body: Readonly<Record<string, unknown>>;
  readonly path: readonly string[];
  readonly request: JellyfinRequest;
  readonly signal: AbortSignal;
}

const extensionRequest = (launch: ProviderLaunchDocument): JellyfinRequest => {
  const request = createJellyfinRequest({
    apiKey: launch.credentials.api_key,
    baseUrl: launch.configuration.base_url,
  });
  if (request === undefined) {
    throw new ConnectError("Jellyfin adapter is unavailable", Code.Internal);
  }
  return request;
};

const successfulBody = (response: JellyfinMutationResponse): Readonly<Record<string, unknown>> => {
  if (response.kind === "success") {
    return response.body;
  }
  if (response.kind === "authentication_failed" || response.kind === "forbidden") {
    throw new ConnectError("Jellyfin extension access was denied", Code.PermissionDenied);
  }
  if (response.kind === "not_found") {
    throw new ConnectError("Jellyfin extension resource was not found", Code.NotFound);
  }
  if (response.kind === "unreachable" || response.kind === "ambiguous") {
    throw new ConnectError("Jellyfin extension outcome is ambiguous", Code.Unavailable);
  }
  throw new ConnectError("Jellyfin extension rejected playback", Code.FailedPrecondition);
};

const postExtension = async ({ body, path, request, signal }: ExtensionCall) =>
  successfulBody(
    await request.requestMutationJson([...EXTENSION_PATH, ...path], {
      authentication: "api_key",
      body,
      cancellationSignal: signal,
      maximumResponseBytes: MAXIMUM_EXTENSION_RESPONSE_BYTES,
      method: "POST",
      signal,
    }),
  );

const optionalChannelCount = (value: unknown): number | undefined => {
  if (value === undefined) {
    return value;
  }
  return requiredInteger(value, MINIMUM_CHANNEL_COUNT, MAXIMUM_CHANNEL_COUNT);
};

const extensionTrack = (value: unknown): ExtensionTrack => {
  if (!isUnknownRecord(value) || value["type"] !== "audio") {
    return invalidExtensionResponse();
  }
  const channels = optionalChannelCount(value["channels"]);
  return {
    channels,
    codec: requiredText(value["codec"], MAXIMUM_CODEC_BYTES),
    index: requiredJellyfinIndex(value["index"]),
    isDefault: requiredBoolean(value["is_default"]),
    isForced: requiredBoolean(value["is_forced"]),
    label: optionalText(value["label"]),
    language: optionalText(value["language"]),
  };
};

const providerTrack = (track: ExtensionTrack, itemId: string, sourceId: string) => ({
  $typeName: "nama.plugin.v1.ProviderPlaybackTrack" as const,
  details: {
    case: "audio" as const,
    value: {
      $typeName: "nama.plugin.v1.PlaybackAudioTrackDetails" as const,
      channelCount: track.channels,
      codec: track.codec,
    },
  },
  isDefault: track.isDefault,
  isForced: track.isForced,
  label: track.label,
  language: track.language,
  trackReference: trackReference(itemId, sourceId, track.index),
  type: PlaybackTrackType.AUDIO,
});

const extensionAction = (value: unknown, itemId: string, sourceId: string) => {
  if (!isUnknownRecord(value) || value["action"] !== "copy") {
    return invalidExtensionResponse();
  }
  return {
    $typeName: "nama.plugin.v1.ProviderTrackAction" as const,
    action: TrackActionKind.COPY,
    trackReference: trackReference(itemId, sourceId, requiredJellyfinIndex(value["track_index"])),
  };
};

const providerSessionTrack = (value: unknown, itemId: string, sourceId: string) => {
  if (!isUnknownRecord(value)) {
    return invalidExtensionResponse();
  }
  return {
    $typeName: "nama.plugin.v1.ProviderSessionTrack" as const,
    switchableWithoutReopen: requiredBoolean(value["switchable_without_reopen"]),
    trackReference: trackReference(itemId, sourceId, requiredJellyfinIndex(value["index"])),
  };
};

const directStrategy = (value: unknown): PlaybackStrategy => {
  if (value !== "direct") {
    return invalidExtensionResponse();
  }
  return PlaybackStrategy.DIRECT;
};

const progressiveProtocol = (value: unknown): DeliveryProtocol => {
  if (value !== "http_progressive") {
    return invalidExtensionResponse();
  }
  return DeliveryProtocol.HTTP_PROGRESSIVE;
};

export {
  directStrategy,
  EXTENSION_PATH,
  extensionAction,
  extensionRequest,
  extensionTrack,
  postExtension,
  progressiveProtocol,
  providerSessionTrack,
  providerTrack,
};
