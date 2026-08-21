import { Code } from "@connectrpc/connect";
import { WatchStateConsistency } from "@nama/api/nama/plugin/v1/watch_state_pb.js";
import type { ListWatchStatesRequest } from "@nama/api/nama/plugin/v1/watch_state_pb.js";

import type { ProviderLaunchDocument } from "./launch-document.ts";
import { createJellyfinRequest } from "./request.ts";
import type { JellyfinJsonResponse } from "./request.ts";
import type { ScanContinuationPosition } from "./scan-continuation.ts";
import { watchStatePositionForRequest } from "./scan-request.ts";
import { jellyfinScanBodyFromResponse, jellyfinScanError } from "./scan-response.ts";
import { encodeWatchStateContinuation } from "./watch-state-continuation.ts";
import {
  ABSENT_VALUE,
  normalizeJellyfinScannedWatchState,
  timestampFromMilliseconds,
} from "./watch-state-value.ts";
import type { ProtobufTimestamp } from "./watch-state-value.ts";

const MAXIMUM_WATCH_STATE_RESPONSE_BYTES = 16_777_216;
const MILLISECONDS_PER_SECOND = 1000;
const WATCH_STATE_SCAN_RESPONSE_MESSAGES = Object.freeze({
  forbidden: "Jellyfin watch-state scan is forbidden",
  invalid: "Jellyfin watch-state scan response is invalid",
  unavailable: "Jellyfin watch-state scan is unavailable",
});

const normalizeWatchStateObservation = (providerItem: unknown, observedAt: ProtobufTimestamp) => {
  const state = normalizeJellyfinScannedWatchState(providerItem, observedAt);
  if (state === ABSENT_VALUE) {
    throw jellyfinScanError(
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
  const providerItems = jellyfinScanBodyFromResponse(response, WATCH_STATE_SCAN_RESPONSE_MESSAGES)[
    "Items"
  ];
  if (!Array.isArray(providerItems) || providerItems.length > pageSize) {
    throw jellyfinScanError(
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
    throw jellyfinScanError("Jellyfin adapter is unavailable", Code.Internal, "INTERNAL");
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
    throw jellyfinScanError("Jellyfin adapter is unavailable", Code.Internal, "INTERNAL");
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
