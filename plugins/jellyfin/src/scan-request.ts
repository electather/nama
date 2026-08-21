import { randomUUID } from "node:crypto";

import { Code, ConnectError } from "@connectrpc/connect";
import { BadRequestSchema, ErrorInfoSchema } from "@nama/api/google/rpc/error_details_pb.js";
import type {
  BadRequest,
  BadRequest_FieldViolation,
  ErrorInfo,
} from "@nama/api/google/rpc/error_details_pb.js";
import type { ListItemsRequest } from "@nama/api/nama/plugin/v1/library_pb.js";
import type { ListWatchStatesRequest } from "@nama/api/nama/plugin/v1/watch_state_pb.js";

import { decodeCatalogContinuation } from "./catalog-continuation.ts";
import type { ProviderLaunchDocument } from "./launch-document.ts";
import type { ScanContinuationPosition } from "./scan-continuation.ts";
import { hasMaximumCodePointLength } from "./value.ts";
import { decodeWatchStateContinuation } from "./watch-state-continuation.ts";

const EMPTY_LENGTH = 0;
const DEFAULT_SCAN_PAGE_SIZE = 50;
const MAXIMUM_SCAN_PAGE_SIZE = 100;
const MAXIMUM_SCAN_CONTINUATION_CODE_POINTS = 4096;
const SCAN_CONTINUATION_LIFETIME_SECONDS = 86_400;
const PLUGIN_ERROR_DOMAIN = "nama.plugin.v1";
const VALIDATION_FAILED_REASON = "VALIDATION_FAILED";
const REQUIRED_REASON = "REQUIRED";
const OUT_OF_RANGE_REASON = "OUT_OF_RANGE";
const SCAN_FIELD = "scan";
const PAGE_SIZE_FIELD = "scan.begin.page_size";
const CONTINUATION_FIELD = "scan.continuation";
const SCAN_DESCRIPTION = "Must select begin or continuation.";
const PAGE_SIZE_DESCRIPTION = "Must be between 0 and 100.";
const CONTINUATION_DESCRIPTION = "Must contain between 1 and 4096 characters.";

type ScanRequest = ListItemsRequest | ListWatchStatesRequest;
type DecodeContinuation = typeof decodeCatalogContinuation;
interface ScanRequestScope {
  readonly decodeContinuation: DecodeContinuation;
  readonly invalidMessage: string;
}

const CATALOG_SCAN_SCOPE: ScanRequestScope = {
  decodeContinuation: decodeCatalogContinuation,
  invalidMessage: "catalog request is invalid",
};
const WATCH_STATE_SCAN_SCOPE: ScanRequestScope = {
  decodeContinuation: decodeWatchStateContinuation,
  invalidMessage: "watch-state request is invalid",
};

const scanValidationError = (
  scope: ScanRequestScope,
  failure: Readonly<Pick<BadRequest_FieldViolation, "description" | "field" | "reason">>,
): ConnectError => {
  const errorInfo: ErrorInfo = {
    $typeName: "google.rpc.ErrorInfo",
    domain: PLUGIN_ERROR_DOMAIN,
    metadata: {},
    reason: VALIDATION_FAILED_REASON,
  };
  const violation: BadRequest_FieldViolation = {
    $typeName: "google.rpc.BadRequest.FieldViolation",
    description: failure.description,
    field: failure.field,
    reason: failure.reason,
  };
  const badRequest: BadRequest = {
    $typeName: "google.rpc.BadRequest",
    fieldViolations: [violation],
  };
  return new ConnectError(scope.invalidMessage, Code.InvalidArgument, undefined, [
    { desc: ErrorInfoSchema, value: errorInfo },
    { desc: BadRequestSchema, value: badRequest },
  ]);
};

const beginScanPosition = (
  scope: ScanRequestScope,
  requestedPageSize: number,
  now: number,
): ScanContinuationPosition => {
  let pageSize = requestedPageSize;
  if (pageSize === EMPTY_LENGTH) {
    pageSize = DEFAULT_SCAN_PAGE_SIZE;
  }
  if (!Number.isInteger(pageSize) || pageSize < EMPTY_LENGTH || pageSize > MAXIMUM_SCAN_PAGE_SIZE) {
    throw scanValidationError(scope, {
      description: PAGE_SIZE_DESCRIPTION,
      field: PAGE_SIZE_FIELD,
      reason: OUT_OF_RANGE_REASON,
    });
  }
  return {
    expiresAt: now + SCAN_CONTINUATION_LIFETIME_SECONDS,
    offset: EMPTY_LENGTH,
    pageSize,
    scanId: randomUUID(),
  };
};

const continuationForRequest = (scope: ScanRequestScope, request: ScanRequest): string => {
  if (request.scan.case !== "continuation") {
    throw scanValidationError(scope, {
      description: SCAN_DESCRIPTION,
      field: SCAN_FIELD,
      reason: REQUIRED_REASON,
    });
  }
  const continuation = request.scan.value;
  if (continuation.length === EMPTY_LENGTH) {
    throw scanValidationError(scope, {
      description: CONTINUATION_DESCRIPTION,
      field: CONTINUATION_FIELD,
      reason: REQUIRED_REASON,
    });
  }
  if (!hasMaximumCodePointLength(continuation, MAXIMUM_SCAN_CONTINUATION_CODE_POINTS)) {
    throw scanValidationError(scope, {
      description: CONTINUATION_DESCRIPTION,
      field: CONTINUATION_FIELD,
      reason: OUT_OF_RANGE_REASON,
    });
  }
  return continuation;
};

const scanPositionForRequest = (
  scope: ScanRequestScope,
  input: Readonly<{
    launch: ProviderLaunchDocument;
    now: number;
    request: ScanRequest;
  }>,
): ScanContinuationPosition => {
  const { launch, now, request } = input;
  if (request.scan.case === "begin") {
    return beginScanPosition(scope, request.scan.value.pageSize, now);
  }
  const continuation = continuationForRequest(scope, request);
  const providerInstanceId = launch.provider_instance_id;
  const providerRevision = launch.revision;
  if (providerInstanceId === undefined || providerRevision === undefined) {
    throw new ConnectError("Jellyfin adapter is unavailable", Code.Internal);
  }
  return scope.decodeContinuation({
    apiKey: launch.credentials.api_key,
    now,
    providerInstanceId,
    providerRevision,
    token: continuation,
  });
};

const catalogPositionForRequest = (
  launch: ProviderLaunchDocument,
  request: ListItemsRequest,
  now: number,
): ScanContinuationPosition => scanPositionForRequest(CATALOG_SCAN_SCOPE, { launch, now, request });

const watchStatePositionForRequest = (
  launch: ProviderLaunchDocument,
  request: ListWatchStatesRequest,
  now: number,
): ScanContinuationPosition =>
  scanPositionForRequest(WATCH_STATE_SCAN_SCOPE, { launch, now, request });

export { catalogPositionForRequest, watchStatePositionForRequest };
