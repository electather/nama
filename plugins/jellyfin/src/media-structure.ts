import { Code, ConnectError } from "@connectrpc/connect";
import { ArtworkRole, MediaKind } from "@nama/api/nama/plugin/v1/media_pb.js";

import { normalizeJellyfinSources } from "./media-source.ts";
import {
  ABSENT_MEDIA_VALUE,
  invalidMedia,
  normalizedDate,
  optionalProperty,
  requiredText,
} from "./media-value.ts";

const ZERO = 0;
const MAXIMUM_UINT32 = 4_294_967_295;

type SupportedJellyfinMediaType = "Episode" | "Movie" | "Season" | "Series";

const MEDIA_KIND_BY_TYPE: Readonly<Record<SupportedJellyfinMediaType, MediaKind>> = Object.freeze({
  Episode: MediaKind.EPISODE,
  Movie: MediaKind.MOVIE,
  Season: MediaKind.SEASON,
  Series: MediaKind.SHOW,
});

const normalizedMediaType = (value: unknown): SupportedJellyfinMediaType => {
  if (value === "Movie" || value === "Series" || value === "Season" || value === "Episode") {
    return value;
  }
  throw new ConnectError("Jellyfin media kind is unsupported", Code.Unimplemented);
};

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

const normalizedKindDetails = (
  item: Readonly<Record<string, unknown>>,
  mediaType: SupportedJellyfinMediaType,
) => {
  if (mediaType === "Movie") {
    return {
      case: "movie" as const,
      value: { ...optionalProperty("releaseDate", normalizedDate(item["PremiereDate"])) },
    };
  }
  if (mediaType === "Series") {
    return {
      case: "show" as const,
      value: {
        ...optionalProperty("firstReleaseDate", normalizedDate(item["PremiereDate"])),
        ...optionalProperty("lastReleaseDate", normalizedDate(item["EndDate"])),
        ...optionalProperty("seasonCount", optionalCount(item["ChildCount"])),
        ...optionalProperty("episodeCount", optionalCount(item["RecursiveItemCount"])),
      },
    };
  }
  if (mediaType === "Season") {
    return normalizedSeasonDetails(item);
  }
  return normalizedEpisodeDetails(item);
};

const normalizeJellyfinItemStructure = (
  item: Readonly<Record<string, unknown>>,
  itemId: string,
) => {
  const mediaType = normalizedMediaType(item["Type"]);
  const kind = MEDIA_KIND_BY_TYPE[mediaType];
  const kindDetails = normalizedKindDetails(item, mediaType);
  if (mediaType === "Movie" || mediaType === "Episode") {
    let primaryArtworkRole = ArtworkRole.POSTER;
    if (mediaType === "Episode") {
      primaryArtworkRole = ArtworkRole.THUMBNAIL;
    }
    return {
      kind,
      kindDetails,
      primaryArtworkRole,
      sources: normalizeJellyfinSources(item["MediaSources"], itemId, item["LocationType"]),
    };
  }
  return {
    kind,
    kindDetails,
    primaryArtworkRole: ArtworkRole.POSTER,
    sources: [],
  };
};

export { normalizeJellyfinItemStructure };
