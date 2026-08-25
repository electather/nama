import type {
  ProviderArtwork,
  ProviderAudioTrack,
  ProviderMediaCredit,
  ProviderMediaItem,
  ProviderMediaPart,
  ProviderMediaSource,
  ProviderMediaTrack,
  ProviderSubtitleTrack,
  ProviderVideoTrack,
} from "@nama/api/nama/plugin/v1/media_pb.js";

import type { CatalogItemObservation } from "../database/catalog-persistence.ts";
import {
  ARTWORK_ROLE,
  ARTWORK_TEXT_PRESENCE,
  CREDIT_ROLE,
  DYNAMIC_RANGE,
  SOURCE_AVAILABILITY,
  SPATIAL_AUDIO_FORMAT,
  SUBTITLE_REPRESENTATION,
  durationFromPlugin,
  invalidPage,
  itemDuration,
  optional,
  required,
} from "./catalog-mapper-values.ts";

type CatalogCommonObservation = Omit<
  CatalogItemObservation,
  | "episodeCount"
  | "episodeNumber"
  | "firstReleaseDate"
  | "kind"
  | "lastReleaseDate"
  | "releaseDate"
  | "seasonCount"
  | "seasonNumber"
  | "seasonReference"
  | "showReference"
>;

const itemId = (item: ProviderMediaItem): string => required(item.itemReference).itemId;

const ownedArtworkReference = (artwork: ProviderArtwork, ownerItemId: string): string => {
  const reference = required(artwork.artworkReference);
  if (required(reference.itemReference).itemId !== ownerItemId) {
    throw invalidPage();
  }
  return reference.artworkId;
};

const artworkObservation = (artwork: ProviderArtwork, ownerItemId: string) => {
  const role = required(ARTWORK_ROLE[artwork.role]);
  const textPresence = required(ARTWORK_TEXT_PRESENCE[artwork.textPresence]);
  return {
    artworkReference: ownedArtworkReference(artwork, ownerItemId),
    ...optional("height", artwork.height),
    ...optional("locale", artwork.locale),
    role,
    textPresence,
    ...optional("width", artwork.width),
  };
};

const creditObservation = (credit: ProviderMediaCredit, ownerItemId: string) => {
  const role = required(CREDIT_ROLE[credit.role]);
  const portrait = credit.portraitArtworkReference;
  if (portrait !== undefined && required(portrait.itemReference).itemId !== ownerItemId) {
    throw invalidPage();
  }
  const portraitReference = portrait?.artworkId;
  return {
    ...optional("characterName", credit.characterName),
    name: credit.name,
    ...optional("portraitArtworkReference", portraitReference),
    role,
  };
};

const videoTrackDetails = (track: ProviderVideoTrack) => {
  const dynamicRange = optionalMappedValue(track.dynamicRange, DYNAMIC_RANGE);
  return {
    ...optional("bitDepth", track.bitDepth),
    codec: track.codec,
    ...optional("dynamicRange", dynamicRange),
    ...optional("frameRate", track.frameRate),
    ...optional("height", track.height),
    type: "video" as const,
    ...optional("width", track.width),
  };
};

const audioTrackDetails = (track: ProviderAudioTrack) => {
  const spatialFormat = optionalMappedValue(track.spatialFormat, SPATIAL_AUDIO_FORMAT);
  return {
    ...optional("channelCount", track.channelCount),
    ...optional("channelLayout", track.channelLayout),
    codec: track.codec,
    isCommentary: track.isCommentary,
    isDefault: track.isDefault,
    ...optional("language", track.language),
    ...optional("sampleRateHz", track.sampleRateHz),
    ...optional("spatialFormat", spatialFormat),
    ...optional("title", track.title),
    type: "audio" as const,
  };
};

const subtitleTrackDetails = (track: ProviderSubtitleTrack) => ({
  codec: track.codec,
  isCommentary: track.isCommentary,
  isDefault: track.isDefault,
  isForced: track.isForced,
  isHearingImpaired: track.isHearingImpaired,
  ...optional("language", track.language),
  representation: required(SUBTITLE_REPRESENTATION[track.representation]),
  ...optional("title", track.title),
  type: "subtitle" as const,
});

const optionalMappedValue = <Key extends number, Value>(
  key: Key | undefined,
  values: Readonly<Record<Key, Value | undefined>>,
): Value | undefined => {
  if (key === undefined) {
    return undefined;
  }
  return required(values[key]);
};

const trackDetails = (track: ProviderMediaTrack) => {
  if (track.details.case === "audio") {
    return audioTrackDetails(track.details.value);
  }
  if (track.details.case === "subtitle") {
    return subtitleTrackDetails(track.details.value);
  }
  if (track.details.case === "video") {
    return videoTrackDetails(track.details.value);
  }
  throw invalidPage();
};

interface TrackOwner {
  readonly itemId: string;
  readonly partId: string;
  readonly sourceId: string;
}

const trackObservation = (track: ProviderMediaTrack, owner: TrackOwner) => {
  const reference = required(track.trackReference);
  const part = required(reference.partReference);
  const source = required(part.sourceReference);
  if (
    required(source.itemReference).itemId !== owner.itemId ||
    source.sourceId !== owner.sourceId ||
    part.partId !== owner.partId
  ) {
    throw invalidPage();
  }
  return { details: trackDetails(track), order: track.order, trackReference: reference.trackId };
};

const partObservation = (part: ProviderMediaPart, ownerItemId: string, ownerSourceId: string) => {
  const reference = required(part.partReference);
  const source = required(reference.sourceReference);
  if (required(source.itemReference).itemId !== ownerItemId || source.sourceId !== ownerSourceId) {
    throw invalidPage();
  }
  const owner = { itemId: ownerItemId, partId: reference.partId, sourceId: ownerSourceId };
  return {
    ...optional("bitRateBps", part.bitRateBps),
    container: part.container,
    order: part.order,
    partReference: reference.partId,
    runtime: durationFromPlugin(part.runtime),
    ...optional("sizeBytes", part.sizeBytes),
    tracks: part.tracks.map((track) => trackObservation(track, owner)),
  };
};

const sourceObservation = (source: ProviderMediaSource, ownerItemId: string) => {
  const reference = required(source.sourceReference);
  if (required(reference.itemReference).itemId !== ownerItemId) {
    throw invalidPage();
  }
  return {
    availability: required(SOURCE_AVAILABILITY[source.availability]),
    ...optional("bitRateBps", source.bitRateBps),
    ...optional("label", source.label),
    parts: source.parts.map((part) => partObservation(part, ownerItemId, reference.sourceId)),
    runtime: durationFromPlugin(source.runtime),
    sourceReference: reference.sourceId,
  };
};

const commonObservation = (
  providerInstanceId: string,
  coreRunId: string,
  item: ProviderMediaItem,
): CatalogCommonObservation => {
  const ownerItemId = itemId(item);
  return {
    artwork: item.artwork.map((artwork) => artworkObservation(artwork, ownerItemId)),
    ...optional("contentRating", item.contentRating),
    credits: item.credits.map((credit) => creditObservation(credit, ownerItemId)),
    externalIdentifiers: item.externalIdentifiers.map((identifier) => ({
      namespace: identifier.namespace,
      value: identifier.value,
    })),
    genres: [...item.genres],
    itemReference: ownerItemId,
    lastSeenScanRunId: coreRunId,
    ...optional("originalTitle", item.originalTitle),
    providerInstanceId,
    ...optional("releaseYear", item.releaseYear),
    runtime: itemDuration(item),
    sources: item.sources.map((source) => sourceObservation(source, ownerItemId)),
    studios: [...item.studios],
    ...optional("synopsis", item.synopsis),
    ...optional("tagline", item.tagline),
    title: item.title,
  };
};

export { commonObservation };
export type { CatalogCommonObservation };
