import {
  DynamicRange,
  SourceAvailability,
  SpatialAudioFormat,
  SubtitleRepresentation,
} from "@nama/api/nama/plugin/v1/media_pb.js";

import {
  ABSENT_MEDIA_VALUE,
  invalidMedia,
  optionalDuration,
  optionalPositiveInteger,
  optionalPositiveNumber,
  optionalProperty,
  optionalText,
  optionalUint32,
  optionalUnsignedInteger,
  providerBoolean,
  requiredText,
} from "./media-value.ts";
import { isUnknownRecord } from "./value.ts";

const ZERO = 0;
const MAXIMUM_SOURCES = 100;
const MAXIMUM_TRACKS = 100;
const DYNAMIC_RANGE_BY_TYPE: Readonly<Record<string, DynamicRange>> = Object.freeze({
  DOVI: DynamicRange.DOLBY_VISION,
  DOVIWithEL: DynamicRange.DOLBY_VISION,
  DOVIWithELHDR10Plus: DynamicRange.DOLBY_VISION,
  DOVIWithHDR10: DynamicRange.DOLBY_VISION,
  DOVIWithHDR10Plus: DynamicRange.DOLBY_VISION,
  DOVIWithHLG: DynamicRange.DOLBY_VISION,
  DOVIWithSDR: DynamicRange.DOLBY_VISION,
  HDR10: DynamicRange.HDR10,
  HDR10Plus: DynamicRange.HDR10_PLUS,
  HLG: DynamicRange.HLG,
  SDR: DynamicRange.SDR,
});
const SPATIAL_AUDIO_BY_TYPE: Readonly<Record<string, SpatialAudioFormat>> = Object.freeze({
  DTSX: SpatialAudioFormat.DTS_X,
  DolbyAtmos: SpatialAudioFormat.DOLBY_ATMOS,
  None: SpatialAudioFormat.NONE,
});
const AVAILABILITY_BY_LOCATION_TYPE: Readonly<Record<string, SourceAvailability>> = Object.freeze({
  FileSystem: SourceAvailability.AVAILABLE,
  Offline: SourceAvailability.PROVIDER_UNAVAILABLE,
  Remote: SourceAvailability.AVAILABLE,
  Virtual: SourceAvailability.UNSUPPORTED,
});

interface TrackContext {
  readonly itemId: string;
  readonly order: number;
  readonly sourceId: string;
}

const dynamicRange = (value: unknown) => {
  if (value === undefined || value === null || value === "Unknown") {
    return ABSENT_MEDIA_VALUE;
  }
  if (typeof value !== "string") {
    return invalidMedia();
  }
  return DYNAMIC_RANGE_BY_TYPE[value] ?? ABSENT_MEDIA_VALUE;
};

const spatialAudioFormat = (value: unknown) => {
  if (value === undefined || value === null) {
    return ABSENT_MEDIA_VALUE;
  }
  if (typeof value !== "string") {
    return invalidMedia();
  }
  return SPATIAL_AUDIO_BY_TYPE[value] ?? ABSENT_MEDIA_VALUE;
};

const videoTrack = (stream: Readonly<Record<string, unknown>>) => {
  const width = optionalUint32(stream["Width"]);
  const height = optionalUint32(stream["Height"]);
  let frameRate = optionalPositiveNumber(stream["AverageFrameRate"]);
  if (frameRate === ABSENT_MEDIA_VALUE) {
    frameRate = optionalPositiveNumber(stream["RealFrameRate"]);
  }
  const bitDepth = optionalUint32(stream["BitDepth"]);
  const normalizedDynamicRange = dynamicRange(stream["VideoRangeType"]);
  return {
    ...optionalProperty("bitDepth", bitDepth),
    codec: requiredText(stream["Codec"]),
    ...optionalProperty("dynamicRange", normalizedDynamicRange),
    ...optionalProperty("frameRate", frameRate),
    ...optionalProperty("height", height),
    ...optionalProperty("width", width),
  };
};

const audioTrack = (stream: Readonly<Record<string, unknown>>) => {
  const title = optionalText(stream["Title"]);
  const language = optionalText(stream["Language"]);
  const channelCount = optionalUint32(stream["Channels"]);
  const channelLayout = optionalText(stream["ChannelLayout"]);
  const sampleRateHz = optionalUint32(stream["SampleRate"]);
  const spatialFormat = spatialAudioFormat(stream["AudioSpatialFormat"]);
  return {
    ...optionalProperty("channelCount", channelCount),
    ...optionalProperty("channelLayout", channelLayout),
    codec: requiredText(stream["Codec"]),
    isCommentary: providerBoolean(stream["IsCommentary"]),
    isDefault: providerBoolean(stream["IsDefault"]),
    ...optionalProperty("language", language),
    ...optionalProperty("sampleRateHz", sampleRateHz),
    ...optionalProperty("spatialFormat", spatialFormat),
    ...optionalProperty("title", title),
  };
};

const subtitleTrack = (stream: Readonly<Record<string, unknown>>) => {
  if (typeof stream["IsTextSubtitleStream"] !== "boolean") {
    return invalidMedia();
  }
  const title = optionalText(stream["Title"]);
  const language = optionalText(stream["Language"]);
  let representation = SubtitleRepresentation.IMAGE;
  if (stream["IsTextSubtitleStream"]) {
    representation = SubtitleRepresentation.TEXT;
  }
  return {
    codec: requiredText(stream["Codec"]),
    isCommentary: providerBoolean(stream["IsCommentary"]),
    isDefault: providerBoolean(stream["IsDefault"]),
    isForced: providerBoolean(stream["IsForced"]),
    isHearingImpaired: providerBoolean(stream["IsHearingImpaired"]),
    ...optionalProperty("language", language),
    representation,
    ...optionalProperty("title", title),
  };
};

const isSupportedStream = (value: unknown): value is Readonly<Record<string, unknown>> => {
  if (!isUnknownRecord(value) || typeof value["Type"] !== "string") {
    return invalidMedia();
  }
  return value["Type"] === "Video" || value["Type"] === "Audio" || value["Type"] === "Subtitle";
};

const normalizedTrackId = (value: unknown): string => {
  const index = optionalUint32(value);
  if (index === ABSENT_MEDIA_VALUE) {
    if (value !== ZERO) {
      return invalidMedia();
    }
    return String(ZERO);
  }
  return String(index);
};

const normalizedTrack = (value: Readonly<Record<string, unknown>>, context: TrackContext) => {
  const trackId = normalizedTrackId(value["Index"]);
  const { itemId, order, sourceId } = context;
  const trackReference = {
    partReference: {
      partId: sourceId,
      sourceReference: { itemReference: { itemId }, sourceId },
    },
    trackId,
  };
  if (value["Type"] === "Video") {
    return { details: { case: "video" as const, value: videoTrack(value) }, order, trackReference };
  }
  if (value["Type"] === "Audio") {
    return { details: { case: "audio" as const, value: audioTrack(value) }, order, trackReference };
  }
  return {
    details: { case: "subtitle" as const, value: subtitleTrack(value) },
    order,
    trackReference,
  };
};

const normalizedTracks = (value: unknown, itemId: string, sourceId: string) => {
  if (!Array.isArray(value) || value.length > MAXIMUM_TRACKS) {
    return invalidMedia();
  }
  const streams = value.filter((stream) => isSupportedStream(stream));
  const tracks = streams.map((stream, order) =>
    normalizedTrack(stream, { itemId, order, sourceId }),
  );
  const trackIds = tracks.map((track) => track.trackReference.trackId);
  if (new Set(trackIds).size !== trackIds.length) {
    return invalidMedia();
  }
  return tracks;
};

const normalizedSourceAvailability = (
  sourceType: unknown,
  locationType: unknown,
): SourceAvailability => {
  if (sourceType === "Grouping" || sourceType === "Placeholder") {
    return SourceAvailability.UNSUPPORTED;
  }
  if (sourceType !== "Default" || typeof locationType !== "string") {
    return invalidMedia();
  }
  const availability = AVAILABILITY_BY_LOCATION_TYPE[locationType];
  return availability ?? invalidMedia();
};

const normalizedSource = (
  value: unknown,
  itemId: string,
  locationType: unknown,
  itemRuntime: unknown,
) => {
  if (!isUnknownRecord(value)) {
    return invalidMedia();
  }
  const sourceId = requiredText(value["Id"]);
  const sourceReference = { itemReference: { itemId }, sourceId };
  const partReference = { partId: sourceId, sourceReference };
  const runtime = optionalDuration(value["RunTimeTicks"] ?? itemRuntime);
  const bitRateBps = optionalPositiveInteger(value["Bitrate"]);
  const sizeBytes = optionalUnsignedInteger(value["Size"]);
  return {
    availability: normalizedSourceAvailability(value["Type"], locationType),
    ...optionalProperty("bitRateBps", bitRateBps),
    ...optionalProperty("label", optionalText(value["Name"])),
    parts: [
      {
        ...optionalProperty("bitRateBps", bitRateBps),
        container: requiredText(value["Container"]),
        order: ZERO,
        partReference,
        ...optionalProperty("runtime", runtime),
        ...optionalProperty("sizeBytes", sizeBytes),
        tracks: normalizedTracks(value["MediaStreams"], itemId, sourceId),
      },
    ],
    ...optionalProperty("runtime", runtime),
    sourceReference,
  };
};

const normalizeJellyfinSources = (
  value: unknown,
  itemId: string,
  locationType: unknown,
  itemRuntime: unknown,
) => {
  if (!Array.isArray(value) || value.length > MAXIMUM_SOURCES) {
    return invalidMedia();
  }
  const sources = value.map((sourceValue) =>
    normalizedSource(sourceValue, itemId, locationType, itemRuntime),
  );
  const sourceIds = sources.map((source) => source.sourceReference.sourceId);
  if (new Set(sourceIds).size !== sourceIds.length) {
    return invalidMedia();
  }
  return sources;
};

export { normalizeJellyfinSources };
