import {
  ArtworkRole,
  ArtworkTextPresence,
  DynamicRange,
  MediaKind,
  Playability,
  SourceAvailability,
  SpatialAudioFormat,
} from "../../../../gen/ts/src/nama/api/v1/media_pb.js";
import type {
  MediaSourceSummary,
  MediaSummary,
} from "../../../../gen/ts/src/nama/api/v1/media_pb.js";
import type {
  CatalogArtworkRole,
  CatalogArtworkTextPresence,
  CatalogAvailability,
  CatalogDynamicRange,
  CatalogMediaKind,
  CatalogSpatialAudioFormat,
  StoredCatalogArtwork,
} from "../database/catalog-persistence-model-private.ts";
import type {
  StoredCatalogAudioQuality,
  StoredCatalogSourceSummary,
  StoredCatalogSummary,
  StoredCatalogVideoQuality,
} from "../database/catalog-summary-model-private.ts";
import { sourceSummaries } from "./catalog-source-summary-private.ts";

const ABSENT_VALUE = undefined;
const FIRST_ITEM_INDEX = 0;

const MEDIA_KIND: Readonly<Record<CatalogMediaKind, MediaKind>> = Object.freeze({
  episode: MediaKind.EPISODE,
  movie: MediaKind.MOVIE,
  season: MediaKind.SEASON,
  show: MediaKind.SHOW,
});
const SOURCE_AVAILABILITY: Readonly<Record<CatalogAvailability, SourceAvailability>> =
  Object.freeze({
    available: SourceAvailability.AVAILABLE,
    provider_unavailable: SourceAvailability.PROVIDER_UNAVAILABLE,
    unsupported: SourceAvailability.UNSUPPORTED,
  });
const ARTWORK_ROLE: Readonly<Record<CatalogArtworkRole, ArtworkRole>> = Object.freeze({
  backdrop: ArtworkRole.BACKDROP,
  logo: ArtworkRole.LOGO,
  portrait: ArtworkRole.PORTRAIT,
  poster: ArtworkRole.POSTER,
  thumbnail: ArtworkRole.THUMBNAIL,
});
const ARTWORK_TEXT_PRESENCE: Readonly<Record<CatalogArtworkTextPresence, ArtworkTextPresence>> =
  Object.freeze({
    contains_text: ArtworkTextPresence.CONTAINS_TEXT,
    textless: ArtworkTextPresence.TEXTLESS,
    unknown: ArtworkTextPresence.UNKNOWN,
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

const artworkMessage = (artwork: StoredCatalogArtwork) => ({
  $typeName: "nama.api.v1.ArtworkReference" as const,
  height: artwork.height,
  id: artwork.id,
  locale: artwork.locale,
  role: ARTWORK_ROLE[artwork.role],
  textPresence: ARTWORK_TEXT_PRESENCE[artwork.textPresence],
  width: artwork.width,
});

const audioQualityMessage = (
  quality: StoredCatalogAudioQuality | undefined,
): MediaSourceSummary["audioQuality"] => {
  if (quality === undefined) {
    return ABSENT_VALUE;
  }
  let spatialFormat: SpatialAudioFormat | undefined = ABSENT_VALUE;
  if (quality.spatialFormat !== undefined) {
    spatialFormat = SPATIAL_AUDIO_FORMAT[quality.spatialFormat];
  }
  return {
    $typeName: "nama.api.v1.AudioQuality",
    channelCount: quality.channelCount,
    codec: quality.codec,
    spatialFormat,
  };
};

const videoQualityMessage = (
  quality: StoredCatalogVideoQuality | undefined,
): MediaSourceSummary["videoQuality"] => {
  if (quality === undefined) {
    return ABSENT_VALUE;
  }
  let dynamicRange: DynamicRange | undefined = ABSENT_VALUE;
  if (quality.dynamicRange !== undefined) {
    dynamicRange = DYNAMIC_RANGE[quality.dynamicRange];
  }
  return {
    $typeName: "nama.api.v1.VideoQuality",
    codec: quality.codec,
    dynamicRange,
    height: quality.height,
    width: quality.width,
  };
};

const sourceMessage = (source: StoredCatalogSourceSummary): MediaSourceSummary => ({
  $typeName: "nama.api.v1.MediaSourceSummary",
  audioQuality: audioQualityMessage(source.audioQuality),
  availability: SOURCE_AVAILABILITY[source.availability],
  container: source.container,
  id: source.id,
  isDefault: source.isDefault,
  label: source.label,
  videoQuality: videoQualityMessage(source.videoQuality),
});

const playability = (sources: readonly StoredCatalogSourceSummary[]): Playability => {
  if (sources.some((source) => source.availability === "available")) {
    return Playability.PLAYABLE;
  }
  if (sources.some((source) => source.availability === "provider_unavailable")) {
    return Playability.TEMPORARILY_UNAVAILABLE;
  }
  return Playability.NO_AVAILABLE_SOURCE;
};

const episodePosition = (
  summary: Pick<StoredCatalogSummary, "episodeNumber" | "seasonNumber">,
): MediaSummary["episodePosition"] => {
  if (summary.seasonNumber === null || summary.episodeNumber === null) {
    return ABSENT_VALUE;
  }
  return {
    $typeName: "nama.api.v1.EpisodePosition",
    episodeNumber: summary.episodeNumber,
    seasonNumber: summary.seasonNumber,
  };
};

const summaryMessage = (
  summary: Pick<
    StoredCatalogSummary,
    | "artwork"
    | "contentRating"
    | "episodeNumber"
    | "genres"
    | "id"
    | "kind"
    | "releaseYear"
    | "runtimeNanoseconds"
    | "runtimeSeconds"
    | "seasonNumber"
    | "sources"
    | "title"
  >,
): MediaSummary => {
  const sources = summary.sources.map((source) => sourceMessage(source));
  const defaultSource = sources.find((source) => source.isDefault);
  const position = episodePosition(summary);
  return {
    $typeName: "nama.api.v1.MediaSummary",
    artwork: summary.artwork.map((artwork) => artworkMessage(artwork)),
    contentRating: summary.contentRating ?? undefined,
    defaultSource,
    episodePosition: position,
    id: summary.id,
    kind: MEDIA_KIND[summary.kind],
    playability: playability(summary.sources),
    primaryGenre: summary.genres[FIRST_ITEM_INDEX],
    releaseYear: summary.releaseYear ?? undefined,
    runtime: {
      $typeName: "google.protobuf.Duration",
      nanos: summary.runtimeNanoseconds,
      seconds: summary.runtimeSeconds,
    },
    title: summary.title,
    userState: undefined,
  };
};

export { artworkMessage, sourceMessage, sourceSummaries, summaryMessage };
