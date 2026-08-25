import { create } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { Effect } from "effect";

import { ResolveArtworkResponseSchema } from "../../../../gen/ts/src/nama/api/v1/library_pb.js";
import type { ArtworkLocator } from "../../../../gen/ts/src/nama/api/v1/media_pb.js";
import { ArtworkAuthorizationScope } from "../../../../gen/ts/src/nama/plugin/v1/library_pb.js";
import type { ProviderArtworkLease } from "../../../../gen/ts/src/nama/plugin/v1/library_pb.js";
import type { CatalogArtworkTarget } from "../database/catalog-query-storage.ts";
import { CatalogQueryPersistenceError, ResourceNotFound } from "./catalog-query-model.ts";
import type { CatalogQueryDependencies, CatalogQueryService } from "./catalog-query-model.ts";
import { ensureCatalogReady } from "./catalog-readiness.ts";

const ARTWORK_REFRESH_MILLISECONDS = 300_000;
const HALF = 2;
const MAXIMUM_NANOSECONDS = 999_999_999;
const MILLISECONDS_PER_SECOND = 1000;
const NANOSECONDS_PER_MILLISECOND = 1_000_000;
const ZERO = 0;
const ABSENT_VALUE = undefined;

const timestampMilliseconds = (
  timestamp: ProviderArtworkLease["accessExpiresAt"],
): number | undefined => {
  if (timestamp === undefined) {
    return ABSENT_VALUE;
  }
  const seconds = Number(timestamp.seconds);
  if (
    !Number.isSafeInteger(seconds) ||
    !Number.isSafeInteger(timestamp.nanos) ||
    timestamp.nanos < ZERO ||
    timestamp.nanos > MAXIMUM_NANOSECONDS
  ) {
    return ABSENT_VALUE;
  }
  const milliseconds =
    seconds * MILLISECONDS_PER_SECOND + Math.floor(timestamp.nanos / NANOSECONDS_PER_MILLISECOND);
  if (!Number.isSafeInteger(milliseconds)) {
    return ABSENT_VALUE;
  }
  return milliseconds;
};

const normalizedLocatorOrigin = (value: string): string | undefined => {
  try {
    const url = new URL(value);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username.length > ZERO ||
      url.password.length > ZERO
    ) {
      return ABSENT_VALUE;
    }
    return url.origin;
  } catch {
    return ABSENT_VALUE;
  }
};

const hasValidAllowedOrigins = (origins: readonly string[], initialOrigin: string): boolean => {
  const allowedOrigins = new Set<string>();
  for (const origin of origins) {
    const normalized = normalizedLocatorOrigin(origin);
    if (normalized === undefined || normalized !== origin || allowedOrigins.has(origin)) {
      return false;
    }
    allowedOrigins.add(origin);
  }
  return allowedOrigins.has(initialOrigin);
};

const hasValidArtworkAuthority = (
  lease: ProviderArtworkLease,
  accessExpiresAt: number | undefined,
  now: number,
): boolean => {
  if (accessExpiresAt !== undefined && accessExpiresAt <= now) {
    return false;
  }
  if (lease.authorizationScope === ArtworkAuthorizationScope.PUBLIC) {
    return lease.headers.length === ZERO;
  }
  if (lease.authorizationScope === ArtworkAuthorizationScope.MEDIA_ITEM) {
    return accessExpiresAt !== undefined;
  }
  return false;
};

const hasValidLocatorHeaders = (lease: ProviderArtworkLease): boolean => {
  for (const header of lease.headers) {
    if (
      header.name.toLowerCase() !== "authorization" ||
      header.value.length === ZERO ||
      /[\r\n]/u.test(header.name) ||
      /[\r\n]/u.test(header.value)
    ) {
      return false;
    }
  }
  return true;
};

interface ArtworkLeaseTiming {
  readonly accessExpiresAt?: number | undefined;
  readonly refreshAt: number;
}

const validatedArtworkOrigin = (lease: ProviderArtworkLease): string | undefined => {
  const initialOrigin = normalizedLocatorOrigin(lease.url);
  if (
    initialOrigin === undefined ||
    !/^image\/[A-Za-z0-9.+-]+$/u.test(lease.mimeType) ||
    !hasValidAllowedOrigins(lease.allowedRedirectOrigins, initialOrigin)
  ) {
    return ABSENT_VALUE;
  }
  return initialOrigin;
};

const validatedArtworkTiming = (
  lease: ProviderArtworkLease,
  now: number,
): ArtworkLeaseTiming | undefined => {
  const accessExpiresAt = timestampMilliseconds(lease.accessExpiresAt);
  if (
    (lease.accessExpiresAt !== undefined && accessExpiresAt === undefined) ||
    !hasValidArtworkAuthority(lease, accessExpiresAt, now) ||
    !hasValidLocatorHeaders(lease)
  ) {
    return ABSENT_VALUE;
  }
  const defaultRefreshAt = now + ARTWORK_REFRESH_MILLISECONDS;
  let refreshAt = defaultRefreshAt;
  if (accessExpiresAt !== undefined) {
    refreshAt = Math.min(defaultRefreshAt, now + Math.floor((accessExpiresAt - now) / HALF));
  }
  if (refreshAt < now || (accessExpiresAt !== undefined && refreshAt >= accessExpiresAt)) {
    return ABSENT_VALUE;
  }
  return { accessExpiresAt, refreshAt };
};

const validatedArtworkLocator = (
  lease: ProviderArtworkLease,
  target: CatalogArtworkTarget,
  now: number,
): ArtworkLocator | undefined => {
  const initialOrigin = validatedArtworkOrigin(lease);
  const timing = validatedArtworkTiming(lease, now);
  if (initialOrigin === undefined || timing === undefined) {
    return ABSENT_VALUE;
  }
  return {
    $typeName: "nama.api.v1.ArtworkLocator",
    accessExpiresAt: lease.accessExpiresAt,
    allowedRedirectOrigins: [...lease.allowedRedirectOrigins],
    headers: lease.headers.map((header) => ({
      $typeName: "nama.api.v1.HttpHeader",
      name: header.name,
      value: header.value,
    })),
    height: target.height ?? undefined,
    refreshAt: timestampFromDate(new Date(timing.refreshAt)),
    url: lease.url,
    width: target.width ?? undefined,
  };
};

const makeResolveArtwork =
  (dependencies: CatalogQueryDependencies): CatalogQueryService["resolveArtwork"] =>
  (_principalId, request) =>
    Effect.gen(function* resolveStoredArtwork() {
      const now = dependencies.now();
      yield* ensureCatalogReady(dependencies, now);
      const target = yield* Effect.tryPromise({
        catch: () => new CatalogQueryPersistenceError({}),
        try: () => dependencies.catalog.getArtworkTarget(request.artworkId),
      });
      if (target === undefined) {
        return yield* Effect.fail(new ResourceNotFound({}));
      }
      const lease = yield* dependencies
        .resolveArtworkLease({
          ...target,
          maxHeight: request.maxHeight,
          maxWidth: request.maxWidth,
        })
        .pipe(Effect.mapError(() => new ResourceNotFound({})));
      const locator = validatedArtworkLocator(lease, target, now);
      if (locator === undefined) {
        return yield* Effect.fail(new ResourceNotFound({}));
      }
      return create(ResolveArtworkResponseSchema, { locator });
    });

export { makeResolveArtwork };
