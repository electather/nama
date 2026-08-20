import { Code, ConnectError } from "@connectrpc/connect";
import {
  ArtworkRole,
  ArtworkTextPresence,
  MediaCreditRole,
  MediaKind,
} from "@nama/api/nama/plugin/v1/media_pb.js";

import { normalizeJellyfinSources } from "./media-source.ts";
import {
  ABSENT_MOVIE_VALUE,
  invalidMovie,
  normalizedDate,
  normalizedStrings,
  optionalDuration,
  optionalProperty,
  optionalText,
  optionalYear,
  requiredText,
} from "./movie-value.ts";
import { isUnknownRecord } from "./value.ts";

const EMPTY_LENGTH = 0;
const ZERO = 0;
const ONE = 1;
const MAXIMUM_IDENTIFIER_MATCHES = 1;
const MAXIMUM_SYNOPSIS_BYTES = 16_384;
const MAXIMUM_GENRES = 50;
const MAXIMUM_STUDIOS = 50;
const MAXIMUM_CREDITS = 100;
const MAXIMUM_ARTWORK = 20;

const CREDIT_ROLE_BY_TYPE: Readonly<Record<string, MediaCreditRole>> = Object.freeze({
  Actor: MediaCreditRole.ACTOR,
  Director: MediaCreditRole.DIRECTOR,
  Writer: MediaCreditRole.WRITER,
});

const normalizedStudios = (value: unknown): string[] => {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value) || value.length > MAXIMUM_STUDIOS) {
    return invalidMovie();
  }
  return value.map((studio) => {
    if (!isUnknownRecord(studio)) {
      return invalidMovie();
    }
    return requiredText(studio["Name"]);
  });
};

const portraitReference = (person: Readonly<Record<string, unknown>>) => {
  if (person["PrimaryImageTag"] === undefined || person["PrimaryImageTag"] === null) {
    return ABSENT_MOVIE_VALUE;
  }
  const itemId = requiredText(person["Id"]);
  const tag = requiredText(person["PrimaryImageTag"]);
  return {
    artworkId: requiredText(`Primary:${tag}`),
    itemReference: { itemId },
  };
};

const normalizedCredit = (value: unknown) => {
  if (!isUnknownRecord(value) || typeof value["Type"] !== "string") {
    return invalidMovie();
  }
  const role = CREDIT_ROLE_BY_TYPE[value["Type"]];
  if (role === undefined) {
    return [];
  }
  const credit = {
    name: requiredText(value["Name"]),
    ...optionalProperty("portraitArtworkReference", portraitReference(value)),
    role,
  };
  if (role === MediaCreditRole.ACTOR) {
    return [{ ...credit, ...optionalProperty("characterName", optionalText(value["Role"])) }];
  }
  return [credit];
};

const normalizedCredits = (value: unknown) => {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    return invalidMovie();
  }
  const credits = value.flatMap((person) => normalizedCredit(person));
  if (credits.length > MAXIMUM_CREDITS) {
    return invalidMovie();
  }
  return credits;
};

const normalizedExternalIdentifier = (
  entries: readonly (readonly [string, unknown])[],
  namespace: "imdb" | "tmdb" | "tvdb",
) => {
  const matches = entries.filter(
    ([providerNamespace]) => providerNamespace.toLowerCase() === namespace,
  );
  if (matches.length > MAXIMUM_IDENTIFIER_MATCHES) {
    return invalidMovie();
  }
  const match = matches[ZERO];
  if (match === undefined) {
    return [];
  }
  return [{ namespace, value: requiredText(match[ONE]) }];
};

const normalizedExternalIdentifiers = (value: unknown) => {
  if (value === undefined || value === null) {
    return [];
  }
  if (!isUnknownRecord(value)) {
    return invalidMovie();
  }
  const entries = Object.entries(value);
  return (["imdb", "tmdb", "tvdb"] as const).flatMap((namespace) =>
    normalizedExternalIdentifier(entries, namespace),
  );
};

const artworkObservation = (itemId: string, artworkId: string, role: ArtworkRole) => ({
  artworkReference: { artworkId: requiredText(artworkId), itemReference: { itemId } },
  role,
  textPresence: ArtworkTextPresence.UNKNOWN,
});

const normalizedImageTags = (value: unknown): Readonly<Record<string, unknown>> => {
  if (value === undefined || value === null) {
    return {};
  }
  if (!isUnknownRecord(value)) {
    return invalidMovie();
  }
  return value;
};

const normalizedBackdrops = (value: unknown, itemId: string, maximumItems: number) => {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    return invalidMovie();
  }
  const artwork = [];
  for (let index = ZERO; index < value.length && artwork.length < maximumItems; index += ONE) {
    const tag = requiredText(value[index]);
    artwork.push(artworkObservation(itemId, `Backdrop:${index}:${tag}`, ArtworkRole.BACKDROP));
  }
  return artwork;
};

const normalizedRemainingArtwork = (
  imageTags: Readonly<Record<string, unknown>>,
  itemId: string,
  maximumItems: number,
) => {
  const artwork = [];
  const remainingRoles = [
    ["Logo", ArtworkRole.LOGO],
    ["Thumb", ArtworkRole.THUMBNAIL],
  ] as const;
  for (const [imageType, role] of remainingRoles) {
    if (artwork.length < maximumItems) {
      const tag = optionalText(imageTags[imageType]);
      if (tag !== ABSENT_MOVIE_VALUE) {
        artwork.push(artworkObservation(itemId, `${imageType}:${tag}`, role));
      }
    }
  }
  return artwork;
};

const normalizedArtwork = (movie: Readonly<Record<string, unknown>>, itemId: string) => {
  const imageTags = normalizedImageTags(movie["ImageTags"]);
  const artwork = [];
  const primaryTag = optionalText(imageTags["Primary"]);
  if (primaryTag !== ABSENT_MOVIE_VALUE) {
    artwork.push(artworkObservation(itemId, `Primary:${primaryTag}`, ArtworkRole.POSTER));
  }
  const maximumBackdrops = MAXIMUM_ARTWORK - artwork.length;
  artwork.push(...normalizedBackdrops(movie["BackdropImageTags"], itemId, maximumBackdrops));
  const maximumRemaining = MAXIMUM_ARTWORK - artwork.length;
  artwork.push(...normalizedRemainingArtwork(imageTags, itemId, maximumRemaining));
  return artwork;
};

const normalizedTagline = (value: unknown) => {
  if (value === undefined || value === null) {
    return ABSENT_MOVIE_VALUE;
  }
  if (!Array.isArray(value)) {
    return invalidMovie();
  }
  if (value.length === EMPTY_LENGTH) {
    return ABSENT_MOVIE_VALUE;
  }
  return optionalText(value[ZERO]);
};

const normalizedItemId = (
  movie: Readonly<Record<string, unknown>>,
  requestedItemId: string,
): string => {
  const itemId = requiredText(movie["Id"]);
  if (itemId !== requestedItemId) {
    return invalidMovie();
  }
  if (movie["Type"] !== "Movie") {
    throw new ConnectError("Jellyfin media kind is unsupported", Code.Unimplemented);
  }
  if (movie["PlayAccess"] === "None") {
    throw new ConnectError("Jellyfin item is forbidden", Code.PermissionDenied);
  }
  if (movie["PlayAccess"] !== "Full") {
    return invalidMovie();
  }
  return itemId;
};

const normalizeJellyfinMovie = (
  movie: Readonly<Record<string, unknown>>,
  requestedItemId: string,
) => {
  const itemId = normalizedItemId(movie, requestedItemId);
  const releaseDate = normalizedDate(movie["PremiereDate"]);
  const runtime = optionalDuration(movie["RunTimeTicks"]);
  return {
    artwork: normalizedArtwork(movie, itemId),
    ...optionalProperty("contentRating", optionalText(movie["OfficialRating"])),
    credits: normalizedCredits(movie["People"]),
    externalIdentifiers: normalizedExternalIdentifiers(movie["ProviderIds"]),
    genres: normalizedStrings(movie["Genres"], MAXIMUM_GENRES),
    itemReference: { itemId },
    kind: MediaKind.MOVIE,
    kindDetails: {
      case: "movie" as const,
      value: { ...optionalProperty("releaseDate", releaseDate) },
    },
    ...optionalProperty("originalTitle", optionalText(movie["OriginalTitle"])),
    ...optionalProperty("releaseYear", optionalYear(movie["ProductionYear"])),
    ...optionalProperty("runtime", runtime),
    sources: normalizeJellyfinSources(movie["MediaSources"], itemId, movie["LocationType"]),
    studios: normalizedStudios(movie["Studios"]),
    ...optionalProperty("synopsis", optionalText(movie["Overview"], MAXIMUM_SYNOPSIS_BYTES)),
    ...optionalProperty("tagline", normalizedTagline(movie["Taglines"])),
    title: requiredText(movie["Name"]),
  };
};

export { normalizeJellyfinMovie };
