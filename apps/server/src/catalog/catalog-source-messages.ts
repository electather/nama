import {
  DynamicRange,
  SourceAvailability,
  SpatialAudioFormat,
  SubtitleRepresentation,
} from "../../../../gen/ts/src/nama/api/v1/media_pb.js";
import type { MediaSource, MediaTrack } from "../../../../gen/ts/src/nama/api/v1/media_pb.js";
import type {
  CatalogAvailability,
  CatalogDynamicRange,
  CatalogSpatialAudioFormat,
  CatalogSubtitleRepresentation,
  StoredCatalogMediaSource,
  StoredCatalogMediaTrack,
} from "../database/catalog-persistence-model-private.ts";

const ABSENT_VALUE = undefined;

const SOURCE_AVAILABILITY: Readonly<Record<CatalogAvailability, SourceAvailability>> =
  Object.freeze({
    available: SourceAvailability.AVAILABLE,
    provider_unavailable: SourceAvailability.PROVIDER_UNAVAILABLE,
    unsupported: SourceAvailability.UNSUPPORTED,
  });
const DYNAMIC_RANGE: Readonly<Record<CatalogDynamicRange, DynamicRange>> = Object.freeze({
  dolby_vision: DynamicRange.DOLBY_VISION,
  hdr10: DynamicRange.HDR10,
  hdr10_plus: DynamicRange.HDR10_PLUS,
  hlg: DynamicRange.HLG,
  sdr: DynamicRange.SDR,
});
const SPATIAL_AUDIO_FORMAT: Readonly<Record<CatalogSpatialAudioFormat, SpatialAudioFormat>> =
  Object.freeze({
    dolby_atmos: SpatialAudioFormat.DOLBY_ATMOS,
    dts_x: SpatialAudioFormat.DTS_X,
    none: SpatialAudioFormat.NONE,
  });
const SUBTITLE_REPRESENTATION: Readonly<
  Record<CatalogSubtitleRepresentation, SubtitleRepresentation>
> = Object.freeze({
  image: SubtitleRepresentation.IMAGE,
  text: SubtitleRepresentation.TEXT,
});

const dynamicRange = (value: CatalogDynamicRange | undefined): DynamicRange | undefined => {
  if (value === undefined) {
    return ABSENT_VALUE;
  }
  return DYNAMIC_RANGE[value];
};

const spatialAudioFormat = (
  value: CatalogSpatialAudioFormat | undefined,
): SpatialAudioFormat | undefined => {
  if (value === undefined) {
    return ABSENT_VALUE;
  }
  return SPATIAL_AUDIO_FORMAT[value];
};

const videoTrackMessage = (track: StoredCatalogMediaTrack): MediaTrack => {
  if (track.details.type !== "video") {
    throw new Error("stored video track type is invalid");
  }
  return {
    $typeName: "nama.api.v1.MediaTrack",
    details: {
      case: "video",
      value: {
        $typeName: "nama.api.v1.VideoTrack",
        bitDepth: track.details.bitDepth,
        codec: track.details.codec,
        dynamicRange: dynamicRange(track.details.dynamicRange),
        frameRate: track.details.frameRate,
        height: track.details.height,
        width: track.details.width,
      },
    },
    order: track.order,
  };
};

const audioTrackMessage = (track: StoredCatalogMediaTrack): MediaTrack => {
  if (track.details.type !== "audio") {
    throw new Error("stored audio track type is invalid");
  }
  return {
    $typeName: "nama.api.v1.MediaTrack",
    details: {
      case: "audio",
      value: {
        $typeName: "nama.api.v1.AudioTrack",
        channelCount: track.details.channelCount,
        channelLayout: track.details.channelLayout,
        codec: track.details.codec,
        isCommentary: track.details.isCommentary,
        isDefault: track.details.isDefault,
        language: track.details.language,
        sampleRateHz: track.details.sampleRateHz,
        spatialFormat: spatialAudioFormat(track.details.spatialFormat),
        title: track.details.title,
      },
    },
    order: track.order,
  };
};

const subtitleTrackMessage = (track: StoredCatalogMediaTrack): MediaTrack => {
  if (track.details.type !== "subtitle") {
    throw new Error("stored subtitle track type is invalid");
  }
  return {
    $typeName: "nama.api.v1.MediaTrack",
    details: {
      case: "subtitle",
      value: {
        $typeName: "nama.api.v1.SubtitleTrack",
        codec: track.details.codec,
        isCommentary: track.details.isCommentary,
        isDefault: track.details.isDefault,
        isForced: track.details.isForced,
        isHearingImpaired: track.details.isHearingImpaired,
        language: track.details.language,
        representation: SUBTITLE_REPRESENTATION[track.details.representation],
        title: track.details.title,
      },
    },
    order: track.order,
  };
};

const trackMessage = (track: StoredCatalogMediaTrack): MediaTrack => {
  switch (track.details.type) {
    case "video": {
      return videoTrackMessage(track);
    }
    case "audio": {
      return audioTrackMessage(track);
    }
    case "subtitle": {
      return subtitleTrackMessage(track);
    }
    default: {
      throw new Error("stored track type is invalid");
    }
  }
};

const technicalSourceMessage = (
  mediaId: string,
  source: StoredCatalogMediaSource,
): MediaSource => ({
  $typeName: "nama.api.v1.MediaSource",
  availability: SOURCE_AVAILABILITY[source.availability],
  bitRateBps: source.bitRateBps,
  id: source.id,
  label: source.label,
  mediaId,
  parts: source.parts.map((part) => ({
    $typeName: "nama.api.v1.MediaPart",
    bitRateBps: part.bitRateBps,
    container: part.container,
    id: part.id,
    order: part.order,
    runtime: {
      $typeName: "google.protobuf.Duration",
      nanos: part.runtime.nanoseconds,
      seconds: part.runtime.seconds,
    },
    sizeBytes: part.sizeBytes,
    tracks: part.tracks.map(trackMessage),
  })),
  runtime: {
    $typeName: "google.protobuf.Duration",
    nanos: source.runtime.nanoseconds,
    seconds: source.runtime.seconds,
  },
});

export { technicalSourceMessage };
