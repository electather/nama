import { Code, ConnectError } from "@connectrpc/connect";

const EMPTY_LENGTH = 0;
const ARTWORK_PAYLOAD_LENGTH = 3;
const ARTWORK_REFERENCE_PREFIX = "jellyfin/artwork/v1:";
const MAXIMUM_ARTWORK_REFERENCE_LENGTH = 256;
const MAXIMUM_CACHE_TAG_LENGTH = 128;
const MAXIMUM_IMAGE_INDEX = 2_147_483_647;
const CACHE_TAG = /^[A-Za-z0-9._~-]+$/u;

type JellyfinImageType = "Backdrop" | "Logo" | "Primary" | "Thumb";

const JELLYFIN_IMAGE_TYPES: Readonly<Record<JellyfinImageType, true>> = {
  Backdrop: true,
  Logo: true,
  Primary: true,
  Thumb: true,
};

interface JellyfinArtworkReference {
  readonly cacheTag: string;
  readonly imageIndex: number;
  readonly imageType: JellyfinImageType;
}

type JellyfinArtworkPayload = readonly [JellyfinImageType, number, string];

const isImageType = (value: unknown): value is JellyfinImageType =>
  typeof value === "string" && Object.hasOwn(JELLYFIN_IMAGE_TYPES, value);

const isImageIndex = (value: unknown): value is number =>
  typeof value === "number" &&
  Number.isSafeInteger(value) &&
  value >= EMPTY_LENGTH &&
  value <= MAXIMUM_IMAGE_INDEX;

const isCacheTag = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > EMPTY_LENGTH &&
  value.length <= MAXIMUM_CACHE_TAG_LENGTH &&
  CACHE_TAG.test(value);

const isArtworkPayload = (value: unknown): value is JellyfinArtworkPayload => {
  if (!Array.isArray(value) || value.length !== ARTWORK_PAYLOAD_LENGTH) {
    return false;
  }
  const entries: readonly unknown[] = value;
  const [imageType, imageIndex, cacheTag] = entries;
  return isImageType(imageType) && isImageIndex(imageIndex) && isCacheTag(cacheTag);
};

const encodeArtworkPayload = (payload: JellyfinArtworkPayload): string =>
  Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");

const isCanonicalArtworkPayload = (payload: JellyfinArtworkPayload, encoded: string): boolean =>
  encodeArtworkPayload(payload) === encoded;

const encodedArtworkReference = (reference: JellyfinArtworkReference): string => {
  const payload: JellyfinArtworkPayload = [
    reference.imageType,
    reference.imageIndex,
    reference.cacheTag,
  ];
  return `${ARTWORK_REFERENCE_PREFIX}${encodeArtworkPayload(payload)}`;
};

const encodeArtworkReference = (reference: JellyfinArtworkReference): string => {
  if (!isArtworkPayload([reference.imageType, reference.imageIndex, reference.cacheTag])) {
    throw new ConnectError("Jellyfin artwork observation is invalid", Code.Internal);
  }
  const encoded = encodedArtworkReference(reference);
  if (encoded.length > MAXIMUM_ARTWORK_REFERENCE_LENGTH) {
    throw new ConnectError("Jellyfin artwork observation is invalid", Code.Internal);
  }
  return encoded;
};

const encodedArtworkPayload = (value: string): string | undefined => {
  if (
    value.length > MAXIMUM_ARTWORK_REFERENCE_LENGTH ||
    !value.startsWith(ARTWORK_REFERENCE_PREFIX)
  ) {
    return undefined;
  }
  const encoded = value.slice(ARTWORK_REFERENCE_PREFIX.length);
  if (encoded.length === EMPTY_LENGTH) {
    return undefined;
  }
  return encoded;
};

const decodedArtworkPayload = (encoded: string): JellyfinArtworkPayload | undefined => {
  try {
    const bytes = Buffer.from(encoded, "base64url");
    if (bytes.toString("base64url") !== encoded) {
      return undefined;
    }
    const decoded: unknown = JSON.parse(bytes.toString("utf8"));
    if (!isArtworkPayload(decoded) || !isCanonicalArtworkPayload(decoded, encoded)) {
      return undefined;
    }
    return decoded;
  } catch {
    return undefined;
  }
};

const decodeArtworkReference = (value: string): JellyfinArtworkReference | undefined => {
  const encoded = encodedArtworkPayload(value);
  if (encoded === undefined) {
    return undefined;
  }
  const decoded = decodedArtworkPayload(encoded);
  if (decoded === undefined) {
    return undefined;
  }
  const [imageType, imageIndex, cacheTag] = decoded;
  return { cacheTag, imageIndex, imageType };
};

export { decodeArtworkReference, encodeArtworkReference };
export type { JellyfinArtworkReference, JellyfinImageType };
