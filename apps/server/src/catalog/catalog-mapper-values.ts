import type { Duration } from "@bufbuild/protobuf/wkt";
import type { Date as ProtobufDate } from "@nama/api/google/type/date_pb.js";
import {
  ArtworkRole,
  ArtworkTextPresence,
  DynamicRange,
  MediaCreditRole,
  MediaKind,
  SourceAvailability,
  SpatialAudioFormat,
  SubtitleRepresentation,
} from "@nama/api/nama/plugin/v1/media_pb.js";
import type { ProviderMediaItem } from "@nama/api/nama/plugin/v1/media_pb.js";

import type { CatalogItemObservation } from "../database/catalog-persistence.ts";

type CatalogTrackDetails =
  CatalogItemObservation["sources"][number]["parts"][number]["tracks"][number]["details"];
type CatalogVideoDetails = Extract<CatalogTrackDetails, { readonly type: "video" }>;
type CatalogAudioDetails = Extract<CatalogTrackDetails, { readonly type: "audio" }>;
type CatalogSubtitleDetails = Extract<CatalogTrackDetails, { readonly type: "subtitle" }>;

const INVALID_PAGE_MESSAGE = "invalid plugin catalog page";
const DATE_YEAR_WIDTH = 4;
const DATE_PART_WIDTH = 2;
const ZERO_DURATION = Object.freeze({ nanoseconds: 0, seconds: 0n });

const ARTWORK_ROLE: Readonly<
  Record<ArtworkRole, CatalogItemObservation["artwork"][number]["role"] | undefined>
> = {
  [ArtworkRole.UNSPECIFIED]: undefined,
  [ArtworkRole.POSTER]: "poster",
  [ArtworkRole.BACKDROP]: "backdrop",
  [ArtworkRole.LOGO]: "logo",
  [ArtworkRole.THUMBNAIL]: "thumbnail",
  [ArtworkRole.PORTRAIT]: "portrait",
};
const ARTWORK_TEXT_PRESENCE: Readonly<
  Record<ArtworkTextPresence, CatalogItemObservation["artwork"][number]["textPresence"] | undefined>
> = {
  [ArtworkTextPresence.UNSPECIFIED]: undefined,
  [ArtworkTextPresence.UNKNOWN]: "unknown",
  [ArtworkTextPresence.TEXTLESS]: "textless",
  [ArtworkTextPresence.CONTAINS_TEXT]: "contains_text",
};
const CREDIT_ROLE: Readonly<
  Record<MediaCreditRole, CatalogItemObservation["credits"][number]["role"] | undefined>
> = {
  [MediaCreditRole.UNSPECIFIED]: undefined,
  [MediaCreditRole.ACTOR]: "actor",
  [MediaCreditRole.DIRECTOR]: "director",
  [MediaCreditRole.WRITER]: "writer",
};
const SOURCE_AVAILABILITY: Readonly<
  Record<SourceAvailability, CatalogItemObservation["sources"][number]["availability"] | undefined>
> = {
  [SourceAvailability.UNSPECIFIED]: undefined,
  [SourceAvailability.AVAILABLE]: "available",
  [SourceAvailability.PROVIDER_UNAVAILABLE]: "provider_unavailable",
  [SourceAvailability.UNSUPPORTED]: "unsupported",
};
const DYNAMIC_RANGE: Readonly<
  Record<DynamicRange, CatalogVideoDetails["dynamicRange"] | undefined>
> = {
  [DynamicRange.UNSPECIFIED]: undefined,
  [DynamicRange.SDR]: "sdr",
  [DynamicRange.HDR10]: "hdr10",
  [DynamicRange.HDR10_PLUS]: "hdr10_plus",
  [DynamicRange.HLG]: "hlg",
  [DynamicRange.DOLBY_VISION]: "dolby_vision",
};
const SPATIAL_AUDIO_FORMAT: Readonly<
  Record<SpatialAudioFormat, CatalogAudioDetails["spatialFormat"] | undefined>
> = {
  [SpatialAudioFormat.UNSPECIFIED]: undefined,
  [SpatialAudioFormat.NONE]: "none",
  [SpatialAudioFormat.DOLBY_ATMOS]: "dolby_atmos",
  [SpatialAudioFormat.DTS_X]: "dts_x",
};
const SUBTITLE_REPRESENTATION: Readonly<
  Record<SubtitleRepresentation, CatalogSubtitleDetails["representation"] | undefined>
> = {
  [SubtitleRepresentation.UNSPECIFIED]: undefined,
  [SubtitleRepresentation.TEXT]: "text",
  [SubtitleRepresentation.IMAGE]: "image",
};

const invalidPage = (): Error => new Error(INVALID_PAGE_MESSAGE);

const required = <Value>(value: Value | undefined): Value => {
  if (value === undefined) {
    throw invalidPage();
  }
  return value;
};

const optional = (key: string, value: unknown): Readonly<Record<string, unknown>> => {
  if (value === undefined) {
    return {};
  }
  return { [key]: value };
};

const durationFromPlugin = (value: Duration | undefined) => {
  const present = required(value);
  return { nanoseconds: present.nanos, seconds: present.seconds };
};

const itemDuration = (item: ProviderMediaItem): CatalogItemObservation["runtime"] => {
  if (
    item.runtime === undefined &&
    (item.kind === MediaKind.SEASON || item.kind === MediaKind.SHOW)
  ) {
    return ZERO_DURATION;
  }
  return durationFromPlugin(item.runtime);
};

const dateFromPlugin = (value: ProtobufDate | undefined): string | undefined => {
  if (value === undefined) {
    return undefined;
  }
  const year = value.year.toString().padStart(DATE_YEAR_WIDTH, "0");
  const month = value.month.toString().padStart(DATE_PART_WIDTH, "0");
  const day = value.day.toString().padStart(DATE_PART_WIDTH, "0");
  return `${year}-${month}-${day}`;
};

export {
  ARTWORK_ROLE,
  ARTWORK_TEXT_PRESENCE,
  CREDIT_ROLE,
  DYNAMIC_RANGE,
  SOURCE_AVAILABILITY,
  SPATIAL_AUDIO_FORMAT,
  SUBTITLE_REPRESENTATION,
  dateFromPlugin,
  durationFromPlugin,
  invalidPage,
  itemDuration,
  optional,
  required,
};
export type {
  CatalogAudioDetails,
  CatalogSubtitleDetails,
  CatalogTrackDetails,
  CatalogVideoDetails,
};
