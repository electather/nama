import { createValidator } from "@bufbuild/protovalidate";
import { ListConsistency, ListItemsResponseSchema } from "@nama/api/nama/plugin/v1/library_pb.js";
import type { ListItemsResponse } from "@nama/api/nama/plugin/v1/library_pb.js";
import { MediaKind } from "@nama/api/nama/plugin/v1/media_pb.js";
import type { ProviderMediaItem } from "@nama/api/nama/plugin/v1/media_pb.js";

import type { CatalogItemObservation } from "../database/catalog-persistence.ts";
import { dateFromPlugin, invalidPage, optional, required } from "./catalog-mapper-values.ts";
import { commonObservation } from "./catalog-media-mapper.ts";
import type { CatalogCommonObservation } from "./catalog-media-mapper.ts";

const validator = createValidator();

type KindDetails = ProviderMediaItem["kindDetails"];
type EpisodeDetails = Extract<KindDetails, { readonly case: "episode" }>["value"];
type MovieDetails = Extract<KindDetails, { readonly case: "movie" }>["value"];
type SeasonDetails = Extract<KindDetails, { readonly case: "season" }>["value"];
type ShowDetails = Extract<KindDetails, { readonly case: "show" }>["value"];

const EXPECTED_MEDIA_KIND: Readonly<Record<Exclude<KindDetails["case"], undefined>, MediaKind>> = {
  episode: MediaKind.EPISODE,
  movie: MediaKind.MOVIE,
  season: MediaKind.SEASON,
  show: MediaKind.SHOW,
};

const validateItemKind = (item: ProviderMediaItem): void => {
  const detailsCase = item.kindDetails.case;
  if (detailsCase === undefined || item.kind !== EXPECTED_MEDIA_KIND[detailsCase]) {
    throw invalidPage();
  }
};

const episodeObservation = (
  common: CatalogCommonObservation,
  details: EpisodeDetails,
): CatalogItemObservation => ({
  ...common,
  episodeNumber: details.episodeNumber,
  kind: "episode",
  ...optional("releaseDate", dateFromPlugin(details.releaseDate)),
  seasonNumber: details.seasonNumber,
  seasonReference: required(details.seasonReference).itemId,
  showReference: required(details.showReference).itemId,
});

const movieObservation = (
  common: CatalogCommonObservation,
  details: MovieDetails,
): CatalogItemObservation => ({
  ...common,
  kind: "movie",
  ...optional("releaseDate", dateFromPlugin(details.releaseDate)),
});

const seasonObservation = (
  common: CatalogCommonObservation,
  details: SeasonDetails,
): CatalogItemObservation => ({
  ...common,
  ...optional("episodeCount", details.episodeCount),
  kind: "season",
  seasonNumber: details.seasonNumber,
  showReference: required(details.showReference).itemId,
});

const showObservation = (
  common: CatalogCommonObservation,
  details: ShowDetails,
): CatalogItemObservation => ({
  ...common,
  ...optional("episodeCount", details.episodeCount),
  ...optional("firstReleaseDate", dateFromPlugin(details.firstReleaseDate)),
  kind: "show",
  ...optional("lastReleaseDate", dateFromPlugin(details.lastReleaseDate)),
  ...optional("seasonCount", details.seasonCount),
});

const kindObservation = (
  common: CatalogCommonObservation,
  item: ProviderMediaItem,
): CatalogItemObservation => {
  if (item.kindDetails.case === "episode") {
    return episodeObservation(common, item.kindDetails.value);
  }
  if (item.kindDetails.case === "movie") {
    return movieObservation(common, item.kindDetails.value);
  }
  if (item.kindDetails.case === "season") {
    return seasonObservation(common, item.kindDetails.value);
  }
  if (item.kindDetails.case === "show") {
    return showObservation(common, item.kindDetails.value);
  }
  throw invalidPage();
};

const itemObservation = (
  providerInstanceId: string,
  coreRunId: string,
  item: ProviderMediaItem,
): CatalogItemObservation => {
  validateItemKind(item);
  return kindObservation(commonObservation(providerInstanceId, coreRunId, item), item);
};

interface CatalogPluginPage {
  readonly complete: boolean;
  readonly items: readonly CatalogItemObservation[];
  readonly nextContinuation?: string;
}

const validPageBoundary = (response: ListItemsResponse): boolean => {
  if (response.complete) {
    return response.nextPageToken === undefined;
  }
  return response.nextPageToken !== undefined;
};

const catalogPageFromPlugin = (
  providerInstanceId: string,
  coreRunId: string,
  response: ListItemsResponse,
): CatalogPluginPage => {
  try {
    const validation = validator.validate(ListItemsResponseSchema, response);
    if (
      validation.kind !== "valid" ||
      response.consistency !== ListConsistency.BEST_EFFORT_SCAN ||
      !validPageBoundary(response)
    ) {
      throw invalidPage();
    }
    return {
      complete: response.complete,
      items: response.items.map((item) => itemObservation(providerInstanceId, coreRunId, item)),
      ...optional("nextContinuation", response.nextPageToken),
    };
  } catch {
    throw invalidPage();
  }
};

export { catalogPageFromPlugin };
export type { CatalogPluginPage };
