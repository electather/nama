import type { ConnectRouter } from "@connectrpc/connect";
import { Code, ConnectError } from "@connectrpc/connect";
import { ErrorInfoSchema, RetryInfoSchema } from "@nama/api/google/rpc/error_details_pb.js";
import type { ErrorInfo, RetryInfo } from "@nama/api/google/rpc/error_details_pb.js";
import { LibraryService, ListConsistency } from "@nama/api/nama/plugin/v1/library_pb.js";

import { encodeCatalogContinuation } from "./catalog-continuation.ts";
import type { LaunchDocument, ProviderLaunchDocument } from "./launch-document.ts";
import { normalizeJellyfinItem } from "./media-item.ts";
import { createJellyfinRequest } from "./request.ts";
import type { JellyfinJsonResponse } from "./request.ts";
import type { ScanContinuationPosition } from "./scan-continuation.ts";
import { catalogPositionForRequest } from "./scan-request.ts";
import { isUnknownRecord } from "./value.ts";

const EMPTY_LENGTH = 0;
const MAXIMUM_CATALOG_RESPONSE_BYTES = 16_777_216;
const MILLISECONDS_PER_SECOND = 1000;
const PLUGIN_ERROR_DOMAIN = "nama.plugin.v1";
const PROVIDER_RETRY_DELAY_SECONDS = 5n;
const SUPPORTED_CATALOG_ITEM_TYPES: Readonly<Record<string, true>> = Object.freeze({
  Episode: true,
  Movie: true,
  Season: true,
  Series: true,
});
const CATALOG_FIELDS =
  "ChildCount,Genres,MediaSources,MediaStreams,OriginalTitle,Overview,People,PlayAccess,ProviderIds,RecursiveItemCount,Studios,Taglines";

type RequireAuthorization = (authorization: string | null, bearer: string) => void;
type CatalogErrorReason = "INTERNAL" | "PERMISSION_DENIED" | "PROVIDER_UNAVAILABLE";

const catalogError = (message: string, code: Code, reason: CatalogErrorReason): ConnectError => {
  const errorInfo: ErrorInfo = {
    $typeName: "google.rpc.ErrorInfo",
    domain: PLUGIN_ERROR_DOMAIN,
    metadata: {},
    reason,
  };
  const errorInfoDetail = { desc: ErrorInfoSchema, value: errorInfo };
  if (reason !== "PROVIDER_UNAVAILABLE") {
    return new ConnectError(message, code, undefined, [errorInfoDetail]);
  }
  const retryInfo: RetryInfo = {
    $typeName: "google.rpc.RetryInfo",
    retryDelay: {
      $typeName: "google.protobuf.Duration",
      nanos: 0,
      seconds: PROVIDER_RETRY_DELAY_SECONDS,
    },
  };
  return new ConnectError(message, code, undefined, [
    errorInfoDetail,
    { desc: RetryInfoSchema, value: retryInfo },
  ]);
};

const catalogBodyFromResponse = (
  response: JellyfinJsonResponse,
): Readonly<Record<string, unknown>> => {
  if (response.kind === "authentication_failed" || response.kind === "forbidden") {
    throw catalogError("Jellyfin catalog is forbidden", Code.PermissionDenied, "PERMISSION_DENIED");
  }
  if (response.kind === "not_found" || response.kind === "unreachable") {
    throw catalogError("Jellyfin catalog is unavailable", Code.Unavailable, "PROVIDER_UNAVAILABLE");
  }
  if (response.kind !== "success") {
    throw catalogError("Jellyfin catalog response is invalid", Code.Internal, "INTERNAL");
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
    throw catalogError("Jellyfin catalog response is invalid", Code.Internal, "INTERNAL");
  }
  const itemType = providerItem["Type"];
  if (excludesCatalogObservation(providerItem, itemType)) {
    return [];
  }
  const itemId = providerItem["Id"];
  if (typeof itemId !== "string") {
    throw catalogError("Jellyfin catalog response is invalid", Code.Internal, "INTERNAL");
  }
  return [normalizeJellyfinItem(providerItem, itemId)];
};

const catalogPageFromResponse = (response: JellyfinJsonResponse, pageSize: number) => {
  const providerItems = catalogBodyFromResponse(response)["Items"];
  if (!Array.isArray(providerItems) || providerItems.length > pageSize) {
    throw catalogError("Jellyfin catalog response is invalid", Code.Internal, "INTERNAL");
  }
  return {
    items: providerItems.flatMap((providerItem) => normalizeCatalogObservation(providerItem)),
    providerItemCount: providerItems.length,
  };
};

const catalogQuery = (launch: ProviderLaunchDocument, position: ScanContinuationPosition) => ({
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
  position: ScanContinuationPosition,
  signal: AbortSignal,
) => {
  const request = createJellyfinRequest({
    apiKey: launch.credentials.api_key,
    baseUrl: launch.configuration.base_url,
  });
  if (request === undefined) {
    throw catalogError("Jellyfin adapter is unavailable", Code.Internal, "INTERNAL");
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
  position: ScanContinuationPosition,
  providerItemCount: number,
): string => {
  const providerInstanceId = launch.provider_instance_id;
  const providerRevision = launch.revision;
  if (providerInstanceId === undefined || providerRevision === undefined) {
    throw catalogError("Jellyfin adapter is unavailable", Code.Internal, "INTERNAL");
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
  position: ScanContinuationPosition,
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
  position: ScanContinuationPosition,
  signal: AbortSignal,
) => {
  const response = await requestJellyfinCatalogPage(launch, position, signal);
  return catalogResponseForPage(launch, position, response);
};

const registerJellyfinCatalogService = (
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
};

export { registerJellyfinCatalogService };
