import { randomUUID } from "node:crypto";

import type { ConnectRouter } from "@connectrpc/connect";
import { Code, ConnectError } from "@connectrpc/connect";
import { LibraryService, ListConsistency } from "@nama/api/nama/plugin/v1/library_pb.js";
import type { ListItemsRequest } from "@nama/api/nama/plugin/v1/library_pb.js";

import { decodeCatalogContinuation, encodeCatalogContinuation } from "./catalog-continuation.ts";
import type { CatalogContinuationPosition } from "./catalog-continuation.ts";
import type { LaunchDocument, ProviderLaunchDocument } from "./launch-document.ts";
import { normalizeJellyfinItem } from "./media-item.ts";
import { createJellyfinRequest } from "./request.ts";
import type { JellyfinJsonResponse } from "./request.ts";
import { hasMaximumCodePointLength, isUnknownRecord } from "./value.ts";

const EMPTY_LENGTH = 0;
const MAXIMUM_ITEM_REFERENCE_CODE_POINTS = 256;
const MAXIMUM_MEDIA_RESPONSE_BYTES = 1_048_576;
const DEFAULT_CATALOG_PAGE_SIZE = 50;
const MAXIMUM_CATALOG_PAGE_SIZE = 100;
const MAXIMUM_CATALOG_RESPONSE_BYTES = 16_777_216;
const CATALOG_CONTINUATION_LIFETIME_SECONDS = 86_400;
const MILLISECONDS_PER_SECOND = 1000;
const SUPPORTED_CATALOG_ITEM_TYPES: Readonly<Record<string, true>> = Object.freeze({
  Episode: true,
  Movie: true,
  Season: true,
  Series: true,
});
const CATALOG_FIELDS = "Genres,MediaStreams,Overview,People,ProviderIds,Studios,Taglines";

type RequireAuthorization = (authorization: string | null, bearer: string) => void;

const itemFromResponse = (response: JellyfinJsonResponse, itemId: string) => {
  if (response.kind === "success") {
    return normalizeJellyfinItem(response.body, itemId);
  }
  if (response.kind === "authentication_failed" || response.kind === "forbidden") {
    throw new ConnectError("Jellyfin item is forbidden", Code.PermissionDenied);
  }
  if (response.kind === "not_found") {
    throw new ConnectError("Jellyfin item was not found", Code.NotFound);
  }
  if (response.kind === "unreachable") {
    throw new ConnectError("Jellyfin server is unavailable", Code.Unavailable);
  }
  throw new ConnectError("Jellyfin media response is invalid", Code.Internal);
};
const catalogBodyFromResponse = (
  response: JellyfinJsonResponse,
): Readonly<Record<string, unknown>> => {
  if (response.kind === "authentication_failed" || response.kind === "forbidden") {
    throw new ConnectError("Jellyfin catalog is forbidden", Code.PermissionDenied);
  }
  if (response.kind === "not_found" || response.kind === "unreachable") {
    throw new ConnectError("Jellyfin catalog is unavailable", Code.Unavailable);
  }
  if (response.kind !== "success") {
    throw new ConnectError("Jellyfin catalog response is invalid", Code.Internal);
  }
  return response.body;
};

const excludesCatalogObservation = (
  providerItem: Readonly<Record<string, unknown>>,
  itemType: string,
): boolean =>
  SUPPORTED_CATALOG_ITEM_TYPES[itemType] !== true ||
  (itemType === "Season" && providerItem["IndexNumber"] === EMPTY_LENGTH) ||
  (itemType === "Episode" && providerItem["ParentIndexNumber"] === EMPTY_LENGTH);

const normalizeCatalogObservation = (providerItem: unknown) => {
  if (!isUnknownRecord(providerItem) || typeof providerItem["Type"] !== "string") {
    throw new ConnectError("Jellyfin catalog response is invalid", Code.Internal);
  }
  const itemType = providerItem["Type"];
  if (excludesCatalogObservation(providerItem, itemType)) {
    return [];
  }
  const itemId = providerItem["Id"];
  if (typeof itemId !== "string") {
    throw new ConnectError("Jellyfin catalog response is invalid", Code.Internal);
  }
  return [normalizeJellyfinItem(providerItem, itemId)];
};

const catalogPageFromResponse = (response: JellyfinJsonResponse, pageSize: number) => {
  const providerItems = catalogBodyFromResponse(response)["Items"];
  if (!Array.isArray(providerItems) || providerItems.length > pageSize) {
    throw new ConnectError("Jellyfin catalog response is invalid", Code.Internal);
  }
  return {
    items: providerItems.flatMap((providerItem) => normalizeCatalogObservation(providerItem)),
    providerItemCount: providerItems.length,
  };
};

const catalogQuery = (launch: ProviderLaunchDocument, position: CatalogContinuationPosition) => ({
  collapseBoxSetItems: "false",
  enableImages: "true",
  enableTotalRecordCount: "false",
  enableUserData: "false",
  fields: CATALOG_FIELDS,
  imageTypeLimit: "20",
  includeItemTypes: "Movie,Series,Season,Episode",
  limit: String(position.pageSize),
  recursive: "true",
  sortBy: "SortName",
  sortOrder: "Ascending",
  startIndex: String(position.offset),
  userId: launch.configuration.user_id,
});

const requestJellyfinCatalogPage = (
  launch: ProviderLaunchDocument,
  position: CatalogContinuationPosition,
  signal: AbortSignal,
) => {
  const request = createJellyfinRequest({
    apiKey: launch.credentials.api_key,
    baseUrl: launch.configuration.base_url,
  });
  if (request === undefined) {
    throw new ConnectError("Jellyfin adapter is unavailable", Code.Internal);
  }
  return request.requestJson(["Items"], {
    authentication: "api_key",
    maximumResponseBytes: MAXIMUM_CATALOG_RESPONSE_BYTES,
    query: catalogQuery(launch, position),
    signal,
  });
};

const continuationForPage = (
  launch: ProviderLaunchDocument,
  position: CatalogContinuationPosition,
  providerItemCount: number,
): string => {
  const providerInstanceId = launch.provider_instance_id;
  const providerRevision = launch.revision;
  if (providerInstanceId === undefined || providerRevision === undefined) {
    throw new ConnectError("Jellyfin adapter is unavailable", Code.Internal);
  }
  return encodeCatalogContinuation({
    apiKey: launch.credentials.api_key,
    expiresAt: position.expiresAt,
    offset: position.offset + providerItemCount,
    pageSize: position.pageSize,
    providerInstanceId,
    providerRevision,
    scanId: position.scanId,
  });
};

const catalogResponseForPage = (
  launch: ProviderLaunchDocument,
  position: CatalogContinuationPosition,
  response: JellyfinJsonResponse,
) => {
  const page = catalogPageFromResponse(response, position.pageSize);
  if (page.providerItemCount < position.pageSize) {
    return {
      complete: true,
      consistency: ListConsistency.BEST_EFFORT_SCAN,
      items: page.items,
    };
  }
  return {
    complete: false,
    consistency: ListConsistency.BEST_EFFORT_SCAN,
    items: page.items,
    nextPageToken: continuationForPage(launch, position, page.providerItemCount),
  };
};

const readJellyfinCatalogPage = async (
  launch: ProviderLaunchDocument,
  position: CatalogContinuationPosition,
  signal: AbortSignal,
) => {
  const response = await requestJellyfinCatalogPage(launch, position, signal);
  return catalogResponseForPage(launch, position, response);
};

const readJellyfinItem = async (
  launch: ProviderLaunchDocument,
  itemId: string,
  signal: AbortSignal,
) => {
  const request = createJellyfinRequest({
    apiKey: launch.credentials.api_key,
    baseUrl: launch.configuration.base_url,
  });
  if (request === undefined) {
    throw new ConnectError("Jellyfin adapter is unavailable", Code.Internal);
  }
  const response = await request.requestJson(["Items", itemId], {
    authentication: "api_key",
    maximumResponseBytes: MAXIMUM_MEDIA_RESPONSE_BYTES,
    query: { userId: launch.configuration.user_id },
    signal,
  });
  return itemFromResponse(response, itemId);
};

const beginCatalogPosition = (
  request: ListItemsRequest,
  now: number,
): CatalogContinuationPosition => {
  if (request.scan.case !== "begin") {
    throw new ConnectError("catalog scan is invalid", Code.InvalidArgument);
  }
  const { pageSize: requestedPageSize } = request.scan.value;
  let pageSize = requestedPageSize;
  if (pageSize === EMPTY_LENGTH) {
    pageSize = DEFAULT_CATALOG_PAGE_SIZE;
  }
  if (pageSize > MAXIMUM_CATALOG_PAGE_SIZE) {
    throw new ConnectError("catalog page size is invalid", Code.InvalidArgument);
  }
  return {
    expiresAt: now + CATALOG_CONTINUATION_LIFETIME_SECONDS,
    offset: EMPTY_LENGTH,
    pageSize,
    scanId: randomUUID(),
  };
};

const catalogPositionForRequest = (
  launch: ProviderLaunchDocument,
  request: ListItemsRequest,
  now: number,
): CatalogContinuationPosition => {
  if (request.scan.case === "begin") {
    return beginCatalogPosition(request, now);
  }
  if (request.scan.case !== "continuation") {
    throw new ConnectError("catalog scan is required", Code.InvalidArgument);
  }
  const providerInstanceId = launch.provider_instance_id;
  const providerRevision = launch.revision;
  if (providerInstanceId === undefined || providerRevision === undefined) {
    throw new ConnectError("Jellyfin adapter is unavailable", Code.Internal);
  }
  return decodeCatalogContinuation({
    apiKey: launch.credentials.api_key,
    now,
    providerInstanceId,
    providerRevision,
    token: request.scan.value,
  });
};

const registerJellyfinLibraryService = (
  router: ConnectRouter,
  launch: LaunchDocument,
  requireAuthorization: RequireAuthorization,
): void => {
  router.rpc(LibraryService.method.listItems, (request, context) => {
    requireAuthorization(context.requestHeader.get("authorization"), launch.bearer);
    if (launch.kind !== "instance") {
      throw new ConnectError("library unavailable", Code.Unimplemented);
    }
    const now = Math.floor(Date.now() / MILLISECONDS_PER_SECOND);
    const position = catalogPositionForRequest(launch, request, now);
    return readJellyfinCatalogPage(launch, position, context.signal);
  });

  router.rpc(LibraryService.method.getItem, async (request, context) => {
    requireAuthorization(context.requestHeader.get("authorization"), launch.bearer);
    if (launch.kind !== "instance") {
      throw new ConnectError("library unavailable", Code.Unimplemented);
    }
    const itemId = request.itemReference?.itemId;
    if (
      itemId === undefined ||
      itemId.length === EMPTY_LENGTH ||
      !hasMaximumCodePointLength(itemId, MAXIMUM_ITEM_REFERENCE_CODE_POINTS)
    ) {
      throw new ConnectError("item reference is invalid", Code.InvalidArgument);
    }
    return { item: await readJellyfinItem(launch, itemId, context.signal) };
  });
};

export { registerJellyfinLibraryService };
