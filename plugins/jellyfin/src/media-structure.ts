import { Code, ConnectError } from "@connectrpc/connect";
import { ArtworkRole, MediaKind } from "@nama/api/nama/plugin/v1/media_pb.js";

import { normalizeJellyfinSources } from "./media-source.ts";
import type { JellyfinSourceContext } from "./media-source.ts";
import {
  ABSENT_MEDIA_VALUE,
  invalidMedia,
  normalizedDate,
  optionalProperty,
  requiredText,
} from "./media-value.ts";

const ZERO = 0;
const MAXIMUM_UINT32 = 4_294_967_295;

const optionalCount = (value: unknown) => {
  if (value === undefined || value === null) {
    return ABSENT_MEDIA_VALUE;
  }
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < ZERO ||
    value > MAXIMUM_UINT32
  ) {
    return invalidMedia();
  }
  return value;
};

const requiredPositiveUint32 = (value: unknown): number => {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value <= ZERO ||
    value > MAXIMUM_UINT32
  ) {
    return invalidMedia();
  }
  return value;
};

const normalizedMovieDetails = (item: Readonly<Record<string, unknown>>) => ({
  case: "movie" as const,
  value: { ...optionalProperty("releaseDate", normalizedDate(item["PremiereDate"])) },
});

const normalizedShowDetails = (item: Readonly<Record<string, unknown>>) => ({
  case: "show" as const,
  value: {
    ...optionalProperty("firstReleaseDate", normalizedDate(item["PremiereDate"])),
    ...optionalProperty("lastReleaseDate", normalizedDate(item["EndDate"])),
    ...optionalProperty("seasonCount", optionalCount(item["ChildCount"])),
    ...optionalProperty("episodeCount", optionalCount(item["RecursiveItemCount"])),
  },
});

const normalizedSeasonDetails = (item: Readonly<Record<string, unknown>>) => {
  if (item["IndexNumber"] === ZERO) {
    throw new ConnectError("Jellyfin season-zero hierarchy is unsupported", Code.Unimplemented);
  }
  return {
    case: "season" as const,
    value: {
      ...optionalProperty("episodeCount", optionalCount(item["ChildCount"])),
      seasonNumber: requiredPositiveUint32(item["IndexNumber"]),
      showReference: { itemId: requiredText(item["SeriesId"]) },
    },
  };
};

const normalizedEpisodeDetails = (item: Readonly<Record<string, unknown>>) => {
  if (item["ParentIndexNumber"] === ZERO) {
    throw new ConnectError("Jellyfin season-zero hierarchy is unsupported", Code.Unimplemented);
  }
  return {
    case: "episode" as const,
    value: {
      episodeNumber: requiredPositiveUint32(item["IndexNumber"]),
      ...optionalProperty("releaseDate", normalizedDate(item["PremiereDate"])),
      seasonNumber: requiredPositiveUint32(item["ParentIndexNumber"]),
      seasonReference: { itemId: requiredText(item["SeasonId"]) },
      showReference: { itemId: requiredText(item["SeriesId"]) },
    },
  };
};

const normalizedPlayableSources = (item: Readonly<Record<string, unknown>>, itemId: string) => {
  const context: JellyfinSourceContext = {
    itemId,
    itemRuntime: item["RunTimeTicks"],
    locationType: item["LocationType"],
  };
  return normalizeJellyfinSources(item["MediaSources"], context);
};

const normalizeJellyfinItemStructure = (
  item: Readonly<Record<string, unknown>>,
  itemId: string,
) => {
  switch (item["Type"]) {
    case "Movie": {
      return {
        kind: MediaKind.MOVIE,
        kindDetails: normalizedMovieDetails(item),
        primaryArtworkRole: ArtworkRole.POSTER,
        sources: normalizedPlayableSources(item, itemId),
      };
    }
    case "Series": {
      return {
        kind: MediaKind.SHOW,
        kindDetails: normalizedShowDetails(item),
        primaryArtworkRole: ArtworkRole.POSTER,
        sources: [],
      };
    }
    case "Season": {
      return {
        kind: MediaKind.SEASON,
        kindDetails: normalizedSeasonDetails(item),
        primaryArtworkRole: ArtworkRole.POSTER,
        sources: [],
      };
    }
    case "Episode": {
      return {
        kind: MediaKind.EPISODE,
        kindDetails: normalizedEpisodeDetails(item),
        primaryArtworkRole: ArtworkRole.THUMBNAIL,
        sources: normalizedPlayableSources(item, itemId),
      };
    }
    default: {
      throw new ConnectError("Jellyfin media kind is unsupported", Code.Unimplemented);
    }
  }
};

export { normalizeJellyfinItemStructure };
