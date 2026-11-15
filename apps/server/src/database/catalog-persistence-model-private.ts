import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { Data } from "effect";

import type { databaseSchema } from "./schema.ts";

const FIRST_ARGUMENT = 0;

type CatalogDatabase = NodePgDatabase<typeof databaseSchema>;
type CatalogTransaction = Parameters<
  Parameters<CatalogDatabase["transaction"]>[typeof FIRST_ARGUMENT]
>[typeof FIRST_ARGUMENT];
type CatalogMediaKind = "episode" | "movie" | "season" | "show";
type CatalogAvailability = "available" | "provider_unavailable" | "unsupported";
type CatalogArtworkRole = "backdrop" | "logo" | "portrait" | "poster" | "thumbnail";
type CatalogArtworkTextPresence = "contains_text" | "textless" | "unknown";
type CatalogCreditRole = "actor" | "director" | "writer";
type CatalogDynamicRange = "dolby_vision" | "hdr10" | "hdr10_plus" | "hlg" | "sdr";
type CatalogSpatialAudioFormat = "dolby_atmos" | "dts_x" | "none";
type CatalogSubtitleRepresentation = "image" | "text";
type CatalogHierarchyRelationship = "season" | "show";

interface CatalogDuration {
  readonly nanoseconds: number;
  readonly seconds: bigint;
}

interface CatalogVideoTrackObservation {
  readonly bitDepth?: number | undefined;
  readonly codec: string;
  readonly dynamicRange?: CatalogDynamicRange | undefined;
  readonly frameRate?: number | undefined;
  readonly height?: number | undefined;
  readonly type: "video";
  readonly width?: number | undefined;
}

interface CatalogAudioTrackObservation {
  readonly channelCount?: number | undefined;
  readonly channelLayout?: string | undefined;
  readonly codec: string;
  readonly isCommentary: boolean;
  readonly isDefault: boolean;
  readonly language?: string | undefined;
  readonly sampleRateHz?: number | undefined;
  readonly spatialFormat?: CatalogSpatialAudioFormat | undefined;
  readonly title?: string | undefined;
  readonly type: "audio";
}

interface CatalogSubtitleTrackObservation {
  readonly codec: string;
  readonly isCommentary: boolean;
  readonly isDefault: boolean;
  readonly isForced: boolean;
  readonly isHearingImpaired: boolean;
  readonly language?: string | undefined;
  readonly representation: CatalogSubtitleRepresentation;
  readonly title?: string | undefined;
  readonly type: "subtitle";
}

type CatalogTrackDetailsObservation =
  | CatalogAudioTrackObservation
  | CatalogSubtitleTrackObservation
  | CatalogVideoTrackObservation;

interface CatalogMediaTrackObservation {
  readonly details: CatalogTrackDetailsObservation;
  readonly order: number;
  readonly trackReference: string;
}

interface CatalogMediaPartObservation {
  readonly bitRateBps?: bigint | undefined;
  readonly container: string;
  readonly order: number;
  readonly partReference: string;
  readonly runtime: CatalogDuration;
  readonly sizeBytes?: bigint | undefined;
  readonly tracks: readonly CatalogMediaTrackObservation[];
}

interface CatalogMediaSourceObservation {
  readonly availability: CatalogAvailability;
  readonly bitRateBps?: bigint | undefined;
  readonly label?: string | undefined;
  readonly parts: readonly CatalogMediaPartObservation[];
  readonly runtime: CatalogDuration;
  readonly sourceReference: string;
}

interface CatalogArtworkObservation {
  readonly artworkReference: string;
  readonly height?: number | undefined;
  readonly locale?: string | undefined;
  readonly role: CatalogArtworkRole;
  readonly textPresence: CatalogArtworkTextPresence;
  readonly width?: number | undefined;
}

interface CatalogCreditObservation {
  readonly characterName?: string | undefined;
  readonly name: string;
  readonly portraitArtworkReference?: string | undefined;
  readonly role: CatalogCreditRole;
}

interface CatalogExternalIdentifierObservation {
  readonly namespace: string;
  readonly value: string;
}

interface CatalogItemObservationCommon {
  readonly artwork: readonly CatalogArtworkObservation[];
  readonly contentRating?: string | undefined;
  readonly credits: readonly CatalogCreditObservation[];
  readonly externalIdentifiers: readonly CatalogExternalIdentifierObservation[];
  readonly genres: readonly string[];
  readonly itemReference: string;
  readonly lastSeenScanRunId?: string | undefined;
  readonly originalTitle?: string | undefined;
  readonly providerInstanceId: string;
  readonly releaseYear?: number | undefined;
  readonly runtime: CatalogDuration;
  readonly sources: readonly CatalogMediaSourceObservation[];
  readonly studios: readonly string[];
  readonly synopsis?: string | undefined;
  readonly tagline?: string | undefined;
  readonly title: string;
}

interface CatalogMovieObservation extends CatalogItemObservationCommon {
  readonly kind: "movie";
  readonly releaseDate?: string | undefined;
}

interface CatalogShowObservation extends CatalogItemObservationCommon {
  readonly episodeCount?: number | undefined;
  readonly firstReleaseDate?: string | undefined;
  readonly kind: "show";
  readonly lastReleaseDate?: string | undefined;
  readonly seasonCount?: number | undefined;
}

interface CatalogSeasonObservation extends CatalogItemObservationCommon {
  readonly episodeCount?: number | undefined;
  readonly kind: "season";
  readonly seasonNumber: number;
  readonly showReference: string;
}

interface CatalogEpisodeObservation extends CatalogItemObservationCommon {
  readonly episodeNumber: number;
  readonly kind: "episode";
  readonly releaseDate?: string | undefined;
  readonly seasonNumber: number;
  readonly seasonReference: string;
  readonly showReference: string;
}

type CatalogItemObservation =
  // fallow-ignore-next-line private-type-leak -- The catalog seam exposes one discriminated input contract without parallel caller-facing variant names.
  | CatalogEpisodeObservation
  // fallow-ignore-next-line private-type-leak -- The catalog seam exposes one discriminated input contract without parallel caller-facing variant names.
  | CatalogMovieObservation
  // fallow-ignore-next-line private-type-leak -- The catalog seam exposes one discriminated input contract without parallel caller-facing variant names.
  | CatalogSeasonObservation
  // fallow-ignore-next-line private-type-leak -- The catalog seam exposes one discriminated input contract without parallel caller-facing variant names.
  | CatalogShowObservation;

interface StoredCatalogMediaTrack {
  readonly details: CatalogTrackDetailsObservation;
  readonly id: string;
  readonly order: number;
}

interface StoredCatalogMediaPart {
  readonly bitRateBps?: bigint | undefined;
  readonly container: string;
  readonly id: string;
  readonly order: number;
  readonly runtime: CatalogDuration;
  readonly sizeBytes?: bigint | undefined;
  readonly tracks: readonly StoredCatalogMediaTrack[];
}

interface StoredCatalogMediaSource {
  readonly availability: CatalogAvailability;
  readonly bitRateBps?: bigint | undefined;
  readonly id: string;
  readonly label?: string | undefined;
  readonly parts: readonly StoredCatalogMediaPart[];
  readonly runtime: CatalogDuration;
}

interface StoredCatalogArtwork {
  readonly height?: number | undefined;
  readonly id: string;
  readonly locale?: string | undefined;
  readonly role: CatalogArtworkRole;
  readonly textPresence: CatalogArtworkTextPresence;
  readonly width?: number | undefined;
}

interface StoredCatalogCredit {
  readonly characterName?: string | undefined;
  readonly name: string;
  readonly portraitArtwork?: StoredCatalogArtwork | undefined;
  readonly role: CatalogCreditRole;
}

interface StoredCatalogParent {
  readonly id: string;
  readonly kind: CatalogMediaKind;
  readonly relationship: CatalogHierarchyRelationship;
  readonly title: string;
}

interface StoredCatalogItem {
  readonly artwork: readonly StoredCatalogArtwork[];
  readonly contentRating?: string | undefined;
  readonly credits: readonly StoredCatalogCredit[];
  readonly episodeCount?: number | undefined;
  readonly episodeNumber?: number | undefined;
  readonly firstReleaseDate?: string | undefined;
  readonly genres: readonly string[];
  readonly id: string;
  readonly kind: CatalogMediaKind;
  readonly lastReleaseDate?: string | undefined;
  readonly libraryCreatedAt?: Date | undefined;
  readonly originalTitle?: string | undefined;
  readonly parents: readonly StoredCatalogParent[];
  readonly releaseDate?: string | undefined;
  readonly releaseYear?: number | undefined;
  readonly runtime: CatalogDuration;
  readonly seasonCount?: number | undefined;
  readonly seasonNumber?: number | undefined;
  readonly sources: readonly StoredCatalogMediaSource[];
  readonly studios: readonly string[];
  readonly synopsis?: string | undefined;
  readonly tagline?: string | undefined;
  readonly title: string;
}

const taggedError = Data.TaggedError;
const CatalogPersistenceError = taggedError("CatalogPersistenceError")<Record<string, never>>;
type CatalogPersistenceFailure = InstanceType<typeof CatalogPersistenceError>;

const catalogPersistenceFailure = (): CatalogPersistenceFailure => new CatalogPersistenceError({});

export {
  type CatalogArtworkObservation,
  type CatalogArtworkRole,
  type CatalogArtworkTextPresence,
  type CatalogAudioTrackObservation,
  type CatalogAvailability,
  type CatalogCreditObservation,
  type CatalogCreditRole,
  type CatalogDatabase,
  type CatalogTransaction,
  type CatalogDuration,
  type CatalogDynamicRange,
  type CatalogHierarchyRelationship,
  type CatalogItemObservation,
  type CatalogMediaKind,
  type CatalogMediaPartObservation,
  type CatalogMediaSourceObservation,
  type CatalogMediaTrackObservation,
  type CatalogPersistenceFailure,
  type CatalogSpatialAudioFormat,
  type CatalogSubtitleRepresentation,
  type CatalogSubtitleTrackObservation,
  type CatalogTrackDetailsObservation,
  type CatalogVideoTrackObservation,
  type StoredCatalogArtwork,
  type StoredCatalogCredit,
  type StoredCatalogItem,
  type StoredCatalogMediaPart,
  type StoredCatalogMediaSource,
  type StoredCatalogMediaTrack,
  type StoredCatalogParent,
  catalogPersistenceFailure,
};
