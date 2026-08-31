import { Code, ConnectError } from "@connectrpc/connect";
import type {
  ProviderSourceReference,
  ProviderTrackReference,
} from "@nama/api/nama/plugin/v1/common_pb.js";
import type { ProviderSubtitleSelection } from "@nama/api/nama/plugin/v1/playback_pb.js";

const EMPTY_LENGTH = 0;
const MAXIMUM_ARRAY_ITEMS = 100;
const MAXIMUM_JELLYFIN_INDEX = 2_147_483_647;
const MAXIMUM_TEXT_BYTES = 8192;
const MAXIMUM_TIMESTAMP_BYTES = 64;
const MILLISECONDS_PER_SECOND = 1000;
const NANOSECONDS_PER_MILLISECOND = 1_000_000;
const NO_TRACK_INDEX = void Number.NaN;
const ZERO_INDEX = 0;

interface ProtobufTimestamp {
  readonly $typeName: "google.protobuf.Timestamp";
  readonly nanos: number;
  readonly seconds: bigint;
}

interface ProviderSourceIdentity {
  readonly itemId: string;
  readonly sourceId: string;
}

const invalidExtensionResponse = (): never => {
  throw new ConnectError("Jellyfin extension response is invalid", Code.Internal);
};

const requiredText = (value: unknown, maximumBytes = MAXIMUM_TEXT_BYTES): string => {
  if (
    typeof value !== "string" ||
    value.length === EMPTY_LENGTH ||
    Buffer.byteLength(value, "utf8") > maximumBytes
  ) {
    return invalidExtensionResponse();
  }
  return value;
};

const optionalText = (value: unknown): string | undefined => {
  if (value === undefined) {
    return value;
  }
  return requiredText(value);
};

const requiredInteger = (value: unknown, minimum: number, maximum: number): number => {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    return invalidExtensionResponse();
  }
  return value;
};

const requiredJellyfinIndex = (value: unknown): number =>
  requiredInteger(value, ZERO_INDEX, MAXIMUM_JELLYFIN_INDEX);

const optionalJellyfinIndex = (value: unknown): number | undefined => {
  if (value === undefined) {
    return value;
  }
  return requiredJellyfinIndex(value);
};

const requiredBoolean = (value: unknown): boolean => {
  if (typeof value !== "boolean") {
    return invalidExtensionResponse();
  }
  return value;
};

const requiredArray = (value: unknown): readonly unknown[] => {
  if (!Array.isArray(value) || value.length > MAXIMUM_ARRAY_ITEMS) {
    return invalidExtensionResponse();
  }
  return value;
};

const futureTimestamp = (
  value: unknown,
  maximumLifetimeMilliseconds: number,
): ProtobufTimestamp => {
  const text = requiredText(value, MAXIMUM_TIMESTAMP_BYTES);
  const milliseconds = new Date(text).getTime();
  const now = Date.now();
  if (
    !Number.isFinite(milliseconds) ||
    milliseconds <= now ||
    milliseconds - now > maximumLifetimeMilliseconds
  ) {
    return invalidExtensionResponse();
  }
  const seconds = Math.floor(milliseconds / MILLISECONDS_PER_SECOND);
  return {
    $typeName: "google.protobuf.Timestamp" as const,
    nanos: (milliseconds - seconds * MILLISECONDS_PER_SECOND) * NANOSECONDS_PER_MILLISECOND,
    seconds: BigInt(seconds),
  };
};

const canonicalBase64Url = (value: unknown): Uint8Array => {
  const encoded = requiredText(value, MAXIMUM_TEXT_BYTES);
  const decoded = Buffer.from(encoded, "base64url");
  if (decoded.byteLength === EMPTY_LENGTH || decoded.toString("base64url") !== encoded) {
    return invalidExtensionResponse();
  }
  return decoded;
};

const durationBody = (value: Readonly<{ nanos: number; seconds: bigint }> | undefined) => {
  if (value === undefined) {
    return value;
  }
  return { nanos: value.nanos, seconds: value.seconds.toString() };
};

const sourceIdentity = (sourceReference: ProviderSourceReference | undefined) => {
  const itemId = sourceReference?.itemReference?.itemId;
  const sourceId = sourceReference?.sourceId;
  if (itemId === undefined || sourceId === undefined) {
    throw new ConnectError("playback source reference is invalid", Code.InvalidArgument);
  }
  return { itemId, sourceId };
};

const trackReference = (
  source: ProviderSourceIdentity,
  trackIndex: number,
): ProviderTrackReference => ({
  $typeName: "nama.plugin.v1.ProviderTrackReference",
  partReference: {
    $typeName: "nama.plugin.v1.ProviderPartReference",
    partId: source.sourceId,
    sourceReference: {
      $typeName: "nama.plugin.v1.ProviderSourceReference",
      itemReference: {
        $typeName: "nama.plugin.v1.ProviderItemReference",
        itemId: source.itemId,
      },
      sourceId: source.sourceId,
    },
  },
  trackId: String(trackIndex),
});

const trackIndex = (reference: ProviderTrackReference | undefined): number | undefined => {
  if (reference === undefined) {
    return reference;
  }
  const parsed = Number(reference.trackId);
  if (!Number.isSafeInteger(parsed) || parsed < ZERO_INDEX) {
    throw new ConnectError("playback track reference is invalid", Code.InvalidArgument);
  }
  return parsed;
};

const subtitleIndex = (selection: ProviderSubtitleSelection | undefined): number | undefined => {
  if (selection?.selection.case === "disabled" && selection.selection.value) {
    return NO_TRACK_INDEX;
  }
  if (selection?.selection.case === "trackReference") {
    return trackIndex(selection.selection.value);
  }
  throw new ConnectError("playback subtitle selection is invalid", Code.InvalidArgument);
};

export {
  canonicalBase64Url,
  durationBody,
  futureTimestamp,
  invalidExtensionResponse,
  optionalText,
  requiredArray,
  optionalJellyfinIndex,
  requiredBoolean,
  requiredInteger,
  requiredJellyfinIndex,
  requiredText,
  sourceIdentity,
  subtitleIndex,
  trackIndex,
  trackReference,
};
export type { ProtobufTimestamp, ProviderSourceIdentity };
