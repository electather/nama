import { Code, ConnectError } from "@connectrpc/connect";
import {
  ArtworkRole,
  ArtworkTextPresence,
  MediaCreditRole,
} from "@nama/api/nama/plugin/v1/media_pb.js";

import { encodeArtworkReference } from "./artwork-reference.ts";
import type { JellyfinArtworkReference } from "./artwork-reference.ts";
import { normalizeJellyfinItemStructure } from "./media-structure.ts";
import {
  ABSENT_MEDIA_VALUE,
  invalidMedia,
  normalizedStrings,
  optionalDuration,
  optionalProperty,
  optionalText,
  optionalYear,
  requiredText,
} from "./media-value.ts";
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
    return invalidMedia();
  }
  return value.map((studio) => {
    if (!isUnknownRecord(studio)) {
      return invalidMedia();
    }
    return requiredText(studio["Name"]);
  });
};

const portraitReference = (person: Readonly<Record<string, unknown>>) => {
  if (person["PrimaryImageTag"] === undefined || person["PrimaryImageTag"] === null) {
    return ABSENT_MEDIA_VALUE;
  }
  const itemId = requiredText(person["Id"]);
  const tag = requiredText(person["PrimaryImageTag"]);
  return {
    artworkId: encodeArtworkReference({ cacheTag: tag, imageIndex: ZERO, imageType: "Primary" }),
    itemReference: { itemId },
  };
};

const normalizedCredit = (value: unknown) => {
  if (!isUnknownRecord(value) || typeof value["Type"] !== "string") {
    return invalidMedia();
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
    return invalidMedia();
  }
  const credits = value.flatMap((person) => normalizedCredit(person));
  if (credits.length > MAXIMUM_CREDITS) {
    return invalidMedia();
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
    return invalidMedia();
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
    return invalidMedia();
  }
  const entries = Object.entries(value);
  return (["imdb", "tmdb", "tvdb"] as const).flatMap((namespace) =>
    normalizedExternalIdentifier(entries, namespace),
  );
};

const artworkObservation = (
  itemId: string,
  reference: JellyfinArtworkReference,
  role: ArtworkRole,
) => ({
  artworkReference: {
    artworkId: encodeArtworkReference(reference),
    itemReference: { itemId },
  },
  role,
  textPresence: ArtworkTextPresence.UNKNOWN,
});

const normalizedImageTags = (value: unknown): Readonly<Record<string, unknown>> => {
  if (value === undefined || value === null) {
    return {};
  }
  if (!isUnknownRecord(value)) {
    return invalidMedia();
  }
  return value;
};

const normalizedBackdrops = (value: unknown, itemId: string, maximumItems: number) => {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    return invalidMedia();
  }
  const artwork = [];
  for (let index = ZERO; index < value.length && artwork.length < maximumItems; index += ONE) {
    const tag = requiredText(value[index]);
    artwork.push(
      artworkObservation(
        itemId,
        { cacheTag: tag, imageIndex: index, imageType: "Backdrop" },
        ArtworkRole.BACKDROP,
      ),
    );
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
      if (tag !== ABSENT_MEDIA_VALUE) {
        artwork.push(
          artworkObservation(itemId, { cacheTag: tag, imageIndex: ZERO, imageType }, role),
        );
      }
    }
  }
  return artwork;
};

const normalizedArtwork = (
  item: Readonly<Record<string, unknown>>,
  itemId: string,
  primaryRole: ArtworkRole,
) => {
  const imageTags = normalizedImageTags(item["ImageTags"]);
  const artwork = [];
  const primaryTag = optionalText(imageTags["Primary"]);
  if (primaryTag !== ABSENT_MEDIA_VALUE) {
    artwork.push(
      artworkObservation(
        itemId,
        { cacheTag: primaryTag, imageIndex: ZERO, imageType: "Primary" },
        primaryRole,
      ),
    );
  }
  const maximumBackdrops = MAXIMUM_ARTWORK - artwork.length;
  artwork.push(...normalizedBackdrops(item["BackdropImageTags"], itemId, maximumBackdrops));
  const maximumRemaining = MAXIMUM_ARTWORK - artwork.length;
  artwork.push(...normalizedRemainingArtwork(imageTags, itemId, maximumRemaining));
  return artwork;
};

const normalizedTagline = (value: unknown) => {
  if (value === undefined || value === null) {
    return ABSENT_MEDIA_VALUE;
  }
  if (!Array.isArray(value)) {
    return invalidMedia();
  }
  if (value.length === EMPTY_LENGTH) {
    return ABSENT_MEDIA_VALUE;
  }
  return optionalText(value[ZERO]);
};

const normalizedItemId = (
  item: Readonly<Record<string, unknown>>,
  requestedItemId: string,
): string => {
  const itemId = requiredText(item["Id"]);
  if (itemId !== requestedItemId) {
    return invalidMedia();
  }
  if (item["PlayAccess"] === "None") {
    throw new ConnectError("Jellyfin item is forbidden", Code.PermissionDenied);
  }
  if (item["PlayAccess"] !== "Full") {
    return invalidMedia();
  }
  return itemId;
};

const normalizeJellyfinItem = (
  item: Readonly<Record<string, unknown>>,
  requestedItemId: string,
) => {
  const itemId = normalizedItemId(item, requestedItemId);
  const itemStructure = normalizeJellyfinItemStructure(item, itemId);
  return {
    artwork: normalizedArtwork(item, itemId, itemStructure.primaryArtworkRole),
    ...optionalProperty("contentRating", optionalText(item["OfficialRating"])),
    credits: normalizedCredits(item["People"]),
    externalIdentifiers: normalizedExternalIdentifiers(item["ProviderIds"]),
    genres: normalizedStrings(item["Genres"], MAXIMUM_GENRES),
    itemReference: { itemId },
    kind: itemStructure.kind,
    kindDetails: itemStructure.kindDetails,
    ...optionalProperty("originalTitle", optionalText(item["OriginalTitle"])),
    ...optionalProperty("releaseYear", optionalYear(item["ProductionYear"])),
    ...optionalProperty("runtime", optionalDuration(item["RunTimeTicks"])),
    sources: itemStructure.sources,
    studios: normalizedStudios(item["Studios"]),
    ...optionalProperty("synopsis", optionalText(item["Overview"], MAXIMUM_SYNOPSIS_BYTES)),
    ...optionalProperty("tagline", normalizedTagline(item["Taglines"])),
    title: requiredText(item["Name"]),
  };
};

export { normalizeJellyfinItem };
