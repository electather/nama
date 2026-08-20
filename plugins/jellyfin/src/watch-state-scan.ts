import { Code, ConnectError } from "@connectrpc/connect";
import { ErrorInfoSchema, RetryInfoSchema } from "@nama/api/google/rpc/error_details_pb.js";
import type { ErrorInfo, RetryInfo } from "@nama/api/google/rpc/error_details_pb.js";
import { WatchStateConsistency } from "@nama/api/nama/plugin/v1/watch_state_pb.js";
import type { ListWatchStatesRequest } from "@nama/api/nama/plugin/v1/watch_state_pb.js";

import type { ProviderLaunchDocument } from "./launch-document.ts";
import { createJellyfinRequest } from "./request.ts";
import type { JellyfinJsonResponse } from "./request.ts";
import type { ScanContinuationPosition } from "./scan-continuation.ts";
import { watchStatePositionForRequest } from "./scan-request.ts";
import { encodeWatchStateContinuation } from "./watch-state-continuation.ts";
import {
  ABSENT_VALUE,
  normalizeJellyfinScannedWatchState,
  timestampFromMilliseconds,
} from "./watch-state-value.ts";
import type { ProtobufTimestamp } from "./watch-state-value.ts";

const MAXIMUM_WATCH_STATE_RESPONSE_BYTES = 16_777_216;
const MILLISECONDS_PER_SECOND = 1000;
const PLUGIN_ERROR_DOMAIN = "nama.plugin.v1";
const PROVIDER_RETRY_DELAY_SECONDS = 5n;

type WatchStateScanErrorReason = "INTERNAL" | "PERMISSION_DENIED" | "PROVIDER_UNAVAILABLE";

const watchStateScanError = (
  message: string,
  code: Code,
  reason: WatchStateScanErrorReason,
): ConnectError => {
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

const watchStateBodyFromResponse = (
  response: JellyfinJsonResponse,
): Readonly<Record<string, unknown>> => {
  if (response.kind === "authentication_failed" || response.kind === "forbidden") {
    throw watchStateScanError(
      "Jellyfin watch-state scan is forbidden",
      Code.PermissionDenied,
      "PERMISSION_DENIED",
    );
  }
  if (response.kind === "not_found" || response.kind === "unreachable") {
    throw watchStateScanError(
      "Jellyfin watch-state scan is unavailable",
      Code.Unavailable,
      "PROVIDER_UNAVAILABLE",
    );
  }
  if (response.kind !== "success") {
    throw watchStateScanError(
      "Jellyfin watch-state scan response is invalid",
      Code.Internal,
      "INTERNAL",
    );
  }
  return response.body;
};

const normalizeWatchStateObservation = (providerItem: unknown, observedAt: ProtobufTimestamp) => {
  const state = normalizeJellyfinScannedWatchState(providerItem, observedAt);
  if (state === ABSENT_VALUE) {
    throw watchStateScanError(
      "Jellyfin watch-state scan response is invalid",
      Code.Internal,
      "INTERNAL",
    );
  }
  return state;
};

const watchStatePageFromResponse = (
  response: JellyfinJsonResponse,
  pageSize: number,
  observedAt: ProtobufTimestamp,
) => {
  const providerItems = watchStateBodyFromResponse(response)["Items"];
  if (!Array.isArray(providerItems) || providerItems.length > pageSize) {
    throw watchStateScanError(
      "Jellyfin watch-state scan response is invalid",
      Code.Internal,
      "INTERNAL",
    );
  }
  return {
    providerItemCount: providerItems.length,
    states: providerItems.map((providerItem) =>
      normalizeWatchStateObservation(providerItem, observedAt),
    ),
  };
};

const watchStateQuery = (launch: ProviderLaunchDocument, position: ScanContinuationPosition) => ({
  collapseBoxSetItems: "false",
  enableImages: "false",
  enableTotalRecordCount: "false",
  enableUserData: "true",
  includeItemTypes: "Movie,Episode",
  limit: String(position.pageSize),
  recursive: "true",
  sortBy: "SortName",
  sortOrder: "Ascending",
  startIndex: String(position.offset),
  userId: launch.configuration.user_id,
});

const requestJellyfinWatchStatePage = (
  launch: ProviderLaunchDocument,
  position: ScanContinuationPosition,
  signal: AbortSignal,
) => {
  const request = createJellyfinRequest({
    apiKey: launch.credentials.api_key,
    baseUrl: launch.configuration.base_url,
  });
  if (request === undefined) {
    throw watchStateScanError("Jellyfin adapter is unavailable", Code.Internal, "INTERNAL");
  }
  return request.requestJson(["Items"], {
    authentication: "api_key",
    maximumResponseBytes: MAXIMUM_WATCH_STATE_RESPONSE_BYTES,
    query: watchStateQuery(launch, position),
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
    throw watchStateScanError("Jellyfin adapter is unavailable", Code.Internal, "INTERNAL");
  }
  return encodeWatchStateContinuation({
    apiKey: launch.credentials.api_key,
    expiresAt: position.expiresAt,
    offset: position.offset + providerItemCount,
    pageSize: position.pageSize,
    providerInstanceId,
    providerRevision,
    scanId: position.scanId,
  });
};

const watchStateResponseForPage = (
  launch: ProviderLaunchDocument,
  position: ScanContinuationPosition,
  response: JellyfinJsonResponse,
) => {
  const observedAt = timestampFromMilliseconds(Date.now());
  const page = watchStatePageFromResponse(response, position.pageSize, observedAt);
  if (page.providerItemCount < position.pageSize) {
    return {
      complete: true,
      consistency: WatchStateConsistency.BEST_EFFORT_SCAN,
      states: page.states,
    };
  }
  return {
    complete: false,
    consistency: WatchStateConsistency.BEST_EFFORT_SCAN,
    nextPageToken: continuationForPage(launch, position, page.providerItemCount),
    states: page.states,
  };
};

const listJellyfinWatchStates = async (
  launch: ProviderLaunchDocument,
  request: ListWatchStatesRequest,
  signal: AbortSignal,
) => {
  const now = Math.floor(Date.now() / MILLISECONDS_PER_SECOND);
  const position = watchStatePositionForRequest(launch, request, now);
  const response = await requestJellyfinWatchStatePage(launch, position, signal);
  return watchStateResponseForPage(launch, position, response);
};

export { listJellyfinWatchStates };
