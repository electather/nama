import { ArtworkAuthorizationScope } from "@nama/api/nama/plugin/v1/library_pb.js";
import type { ProviderArtworkLease } from "@nama/api/nama/plugin/v1/library_pb.js";

import { normalizedLocatorOrigin } from "./catalog-artwork-origin.ts";

const MAXIMUM_MIME_TYPE_LENGTH = 256;
const MAXIMUM_NANOSECONDS = 999_999_999;
const MILLISECONDS_PER_SECOND = 1000;
const NANOSECONDS_PER_MILLISECOND = 1_000_000;
const ZERO = 0;
const IMAGE_MIME_TYPE = /^image\/[A-Za-z0-9.+-]+$/u;

interface ValidatedArtworkLease {
  readonly accessExpiresAt?: number | undefined;
  readonly allowedOrigins: ReadonlySet<string>;
  readonly headers: Readonly<Record<string, string>>;
  readonly mimeType: string;
  readonly url: URL;
}

interface ValidatedArtworkOrigins {
  readonly allowed: ReadonlySet<string>;
  readonly url: URL;
}

const timestampMilliseconds = (
  timestamp: ProviderArtworkLease["accessExpiresAt"],
): number | undefined => {
  if (timestamp === undefined) {
    return undefined;
  }
  const seconds = Number(timestamp.seconds);
  if (
    !Number.isSafeInteger(seconds) ||
    !Number.isSafeInteger(timestamp.nanos) ||
    timestamp.nanos < ZERO ||
    timestamp.nanos > MAXIMUM_NANOSECONDS
  ) {
    return undefined;
  }
  const milliseconds =
    seconds * MILLISECONDS_PER_SECOND + Math.floor(timestamp.nanos / NANOSECONDS_PER_MILLISECOND);
  if (!Number.isSafeInteger(milliseconds)) {
    return undefined;
  }
  return milliseconds;
};

const normalizedOrigins = (origins: readonly string[]): Set<string> | undefined => {
  const values = new Set<string>();
  for (const origin of origins) {
    const normalized = normalizedLocatorOrigin(origin);
    if (normalized === undefined || normalized !== origin || values.has(origin)) {
      return undefined;
    }
    values.add(origin);
  }
  return values;
};

const isSubset = (values: ReadonlySet<string>, allowed: ReadonlySet<string>): boolean => {
  for (const value of values) {
    if (!allowed.has(value)) {
      return false;
    }
  }
  return true;
};

const validHeaders = (lease: ProviderArtworkLease): boolean =>
  lease.headers.every(
    (header) =>
      header.name.toLowerCase() === "authorization" &&
      header.value.length > ZERO &&
      !/[\r\n]/u.test(header.name) &&
      !/[\r\n]/u.test(header.value),
  );

const validatedArtworkOrigins = (
  lease: ProviderArtworkLease,
  approvedOrigins: readonly string[],
): ValidatedArtworkOrigins | undefined => {
  const initialOrigin = normalizedLocatorOrigin(lease.url);
  const allowed = normalizedOrigins(lease.allowedRedirectOrigins);
  const approved = normalizedOrigins(approvedOrigins);
  if (
    initialOrigin === undefined ||
    allowed === undefined ||
    approved === undefined ||
    !allowed.has(initialOrigin) ||
    !approved.has(initialOrigin) ||
    !isSubset(allowed, approved)
  ) {
    return undefined;
  }
  return { allowed, url: new URL(lease.url) };
};

const validAuthorization = (
  lease: ProviderArtworkLease,
  accessExpiresAt: number | undefined,
  now: number,
): boolean => {
  if (lease.authorizationScope === ArtworkAuthorizationScope.PUBLIC) {
    return lease.headers.length === ZERO;
  }
  return (
    lease.authorizationScope === ArtworkAuthorizationScope.MEDIA_ITEM &&
    accessExpiresAt !== undefined &&
    accessExpiresAt > now
  );
};

const validatedArtworkLease = (
  lease: ProviderArtworkLease,
  approvedOrigins: readonly string[],
  now: number,
): ValidatedArtworkLease | undefined => {
  const origins = validatedArtworkOrigins(lease, approvedOrigins);
  const accessExpiresAt = timestampMilliseconds(lease.accessExpiresAt);
  if (
    origins === undefined ||
    lease.mimeType.length > MAXIMUM_MIME_TYPE_LENGTH ||
    !IMAGE_MIME_TYPE.test(lease.mimeType) ||
    !validHeaders(lease) ||
    (lease.accessExpiresAt !== undefined && accessExpiresAt === undefined) ||
    !validAuthorization(lease, accessExpiresAt, now)
  ) {
    return undefined;
  }
  return {
    accessExpiresAt,
    allowedOrigins: origins.allowed,
    headers: Object.fromEntries(lease.headers.map(({ name, value }) => [name, value])),
    mimeType: lease.mimeType.toLowerCase(),
    url: origins.url,
  };
};

export { validatedArtworkLease };
export type { ValidatedArtworkLease };
