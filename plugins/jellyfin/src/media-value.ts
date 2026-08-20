import { Code, ConnectError } from "@connectrpc/connect";

import { hasMaximumCodePointLength } from "./value.ts";

const EMPTY_LENGTH = 0;
const ZERO = 0;
const ZERO_BIGINT = 0n;
const MINIMUM_YEAR = 1;
const MAXIMUM_YEAR = 9999;
const MAXIMUM_TEXT_CODE_POINTS = 256;
const MAXIMUM_UINT32 = 4_294_967_295;
const MAXIMUM_UINT64 = 18_446_744_073_709_551_615n;
const JELLYFIN_TICKS_PER_SECOND = 10_000_000n;
const NANOSECONDS_PER_JELLYFIN_TICK = 100n;
const DECIMAL_INTEGER = /^(?:0|[1-9]\d*)$/u;
const JELLYFIN_TIMESTAMP =
  /^(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2})T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?(?:Z|[+-]\d{2}:\d{2})$/u;
const ABSENT_MEDIA_VALUE = Symbol("absent Jellyfin media value");

const invalidMedia = (): never => {
  throw new ConnectError("Jellyfin media response is invalid", Code.Internal);
};

const requiredText = (value: unknown, maximumCodePoints = MAXIMUM_TEXT_CODE_POINTS): string => {
  if (
    typeof value !== "string" ||
    value.length === EMPTY_LENGTH ||
    !hasMaximumCodePointLength(value, maximumCodePoints)
  ) {
    return invalidMedia();
  }
  return value;
};

const optionalText = (value: unknown, maximumCodePoints = MAXIMUM_TEXT_CODE_POINTS) => {
  if (value === undefined || value === null || value === "") {
    return ABSENT_MEDIA_VALUE;
  }
  return requiredText(value, maximumCodePoints);
};

const unsignedInteger = (value: unknown): bigint => {
  let integer = ZERO_BIGINT;
  if (typeof value === "number" && Number.isSafeInteger(value)) {
    integer = BigInt(value);
  } else if (typeof value === "string" && DECIMAL_INTEGER.test(value)) {
    integer = BigInt(value);
  } else {
    return invalidMedia();
  }
  if (integer < ZERO_BIGINT || integer > MAXIMUM_UINT64) {
    return invalidMedia();
  }
  return integer;
};

const optionalUnsignedInteger = (value: unknown) => {
  if (value === undefined || value === null) {
    return ABSENT_MEDIA_VALUE;
  }
  return unsignedInteger(value);
};

const optionalPositiveInteger = (value: unknown) => {
  const integer = optionalUnsignedInteger(value);
  if (integer === ABSENT_MEDIA_VALUE || integer === ZERO_BIGINT) {
    return ABSENT_MEDIA_VALUE;
  }
  return integer;
};

const optionalUint32 = (value: unknown) => {
  if (value === undefined || value === null || value === ZERO) {
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

const optionalPositiveNumber = (value: unknown) => {
  if (value === undefined || value === null || value === ZERO) {
    return ABSENT_MEDIA_VALUE;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value < ZERO) {
    return invalidMedia();
  }
  return value;
};

const providerBoolean = (value: unknown): boolean => {
  if (value === undefined || value === null) {
    return false;
  }
  if (typeof value !== "boolean") {
    return invalidMedia();
  }
  return value;
};

const durationFromTicks = (value: unknown) => {
  const ticks = unsignedInteger(value);
  return {
    nanos: Number((ticks % JELLYFIN_TICKS_PER_SECOND) * NANOSECONDS_PER_JELLYFIN_TICK),
    seconds: ticks / JELLYFIN_TICKS_PER_SECOND,
  };
};

const optionalDuration = (value: unknown) => {
  if (value === undefined || value === null) {
    return ABSENT_MEDIA_VALUE;
  }
  return durationFromTicks(value);
};

const optionalYear = (value: unknown) => {
  if (value === undefined || value === null || value === ZERO) {
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

const requiredDateParts = (value: string) => {
  const groups = JELLYFIN_TIMESTAMP.exec(value)?.groups;
  if (groups === undefined) {
    return invalidMedia();
  }
  return {
    day: Number(groups["day"]),
    month: Number(groups["month"]),
    source: `${groups["year"]}-${groups["month"]}-${groups["day"]}`,
    year: Number(groups["year"]),
  };
};

const normalizedDate = (value: unknown) => {
  if (value === undefined || value === null || value === "") {
    return ABSENT_MEDIA_VALUE;
  }
  if (typeof value !== "string") {
    return invalidMedia();
  }
  const { day, month, source, year } = requiredDateParts(value);
  const parsed = new Date(`${source}T00:00:00Z`);
  if (
    year < MINIMUM_YEAR ||
    year > MAXIMUM_YEAR ||
    Number.isNaN(Date.parse(value)) ||
    Number.isNaN(parsed.getTime()) ||
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() + MINIMUM_YEAR !== month ||
    parsed.getUTCDate() !== day
  ) {
    return invalidMedia();
  }
  return { day, month, year };
};

const normalizedStrings = (value: unknown, maximumItems: number): string[] => {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value) || value.length > maximumItems) {
    return invalidMedia();
  }
  return value.map((entry) => requiredText(entry));
};

const optionalProperty = <Value>(name: string, value: Value | typeof ABSENT_MEDIA_VALUE) => {
  if (value === ABSENT_MEDIA_VALUE) {
    return {};
  }
  return { [name]: value };
};

export {
  ABSENT_MEDIA_VALUE,
  durationFromTicks,
  invalidMedia,
  normalizedDate,
  normalizedStrings,
  optionalDuration,
  optionalPositiveInteger,
  optionalPositiveNumber,
  optionalProperty,
  optionalText,
  optionalUint32,
  optionalUnsignedInteger,
  optionalYear,
  providerBoolean,
  requiredText,
};
