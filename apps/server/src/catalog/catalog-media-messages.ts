import { MediaCreditRole, MediaKind } from "../../../../gen/ts/src/nama/api/v1/media_pb.js";
import type { MediaDetails } from "../../../../gen/ts/src/nama/api/v1/media_pb.js";
import type {
  CatalogCreditRole,
  CatalogMediaKind,
  StoredCatalogArtwork,
  StoredCatalogItem,
} from "../database/catalog-persistence-model-private.ts";
import { technicalSourceMessage } from "./catalog-source-messages.ts";
import {
  artworkMessage,
  sourceMessage,
  sourceSummaries,
  summaryMessage,
} from "./catalog-summary-messages.ts";

const ABSENT_VALUE = undefined;
const ZERO = 0;

const MEDIA_KIND: Readonly<Record<CatalogMediaKind, MediaKind>> = Object.freeze({
  episode: MediaKind.EPISODE,
  movie: MediaKind.MOVIE,
  season: MediaKind.SEASON,
  show: MediaKind.SHOW,
});
const CREDIT_ROLE: Readonly<Record<CatalogCreditRole, MediaCreditRole>> = Object.freeze({
  actor: MediaCreditRole.ACTOR,
  director: MediaCreditRole.DIRECTOR,
  writer: MediaCreditRole.WRITER,
});

// oxlint-disable-next-line unicorn/no-null -- Stored summary cursors preserve PostgreSQL null semantics for absent sortable fields.
const nullable = <Value>(value: Value | undefined): Value | null => value ?? null;

const dateMessage = (date: string | undefined) => {
  if (date === undefined) {
    return ABSENT_VALUE;
  }
  const [year = ZERO, month = ZERO, day = ZERO] = date.split("-").map(Number);
  return { $typeName: "google.type.Date" as const, day, month, year };
};

const requiredNumber = (value: number | undefined): number => {
  if (value === undefined) {
    throw new Error("stored media kind detail is missing");
  }
  return value;
};

const kindDetails = (item: StoredCatalogItem): MediaDetails["kindDetails"] => {
  switch (item.kind) {
    case "movie": {
      return {
        case: "movie",
        value: {
          $typeName: "nama.api.v1.MovieDetails",
          releaseDate: dateMessage(item.releaseDate),
        },
      };
    }
    case "show": {
      return {
        case: "show",
        value: {
          $typeName: "nama.api.v1.ShowDetails",
          episodeCount: item.episodeCount,
          firstReleaseDate: dateMessage(item.firstReleaseDate),
          lastReleaseDate: dateMessage(item.lastReleaseDate),
          seasonCount: item.seasonCount,
        },
      };
    }
    case "season": {
      return {
        case: "season",
        value: {
          $typeName: "nama.api.v1.SeasonDetails",
          episodeCount: item.episodeCount,
          seasonNumber: requiredNumber(item.seasonNumber),
        },
      };
    }
    case "episode": {
      return {
        case: "episode",
        value: {
          $typeName: "nama.api.v1.EpisodeDetails",
          episodeNumber: requiredNumber(item.episodeNumber),
          releaseDate: dateMessage(item.releaseDate),
          seasonNumber: requiredNumber(item.seasonNumber),
        },
      };
    }
    default: {
      throw new Error("stored media kind is invalid");
    }
  }
};

const portraitArtwork = (artwork: StoredCatalogArtwork | undefined) => {
  if (artwork === undefined) {
    return ABSENT_VALUE;
  }
  return artworkMessage(artwork);
};

const detailsMessage = (item: StoredCatalogItem): MediaDetails => {
  const sourceSummaryModels = sourceSummaries(item.sources);
  return {
    $typeName: "nama.api.v1.MediaDetails",
    artwork: item.artwork.map((artwork) => artworkMessage(artwork)),
    credits: item.credits.map((credit) => ({
      $typeName: "nama.api.v1.MediaCredit",
      characterName: credit.characterName,
      name: credit.name,
      portraitArtwork: portraitArtwork(credit.portraitArtwork),
      role: CREDIT_ROLE[credit.role],
    })),
    genres: [...item.genres],
    kindDetails: kindDetails(item),
    originalTitle: item.originalTitle,
    parents: item.parents.map((parent) => ({
      $typeName: "nama.api.v1.MediaParent",
      id: parent.id,
      kind: MEDIA_KIND[parent.kind],
      title: parent.title,
    })),
    sourceSummaries: sourceSummaryModels.map((source) => sourceMessage(source)),
    studios: [...item.studios],
    summary: summaryMessage({
      artwork: item.artwork,
      contentRating: nullable(item.contentRating),
      episodeNumber: nullable(item.episodeNumber),
      genres: item.genres,
      id: item.id,
      kind: item.kind,
      releaseYear: nullable(item.releaseYear),
      runtimeNanoseconds: item.runtime.nanoseconds,
      runtimeSeconds: item.runtime.seconds,
      seasonNumber: nullable(item.seasonNumber),
      sources: sourceSummaryModels,
      title: item.title,
    }),
    synopsis: item.synopsis,
    tagline: item.tagline,
  };
};

export { detailsMessage, summaryMessage, technicalSourceMessage };
