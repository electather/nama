import { randomUUID } from "node:crypto";

import { Code, ConnectError } from "@connectrpc/connect";
import { BadRequestSchema, ErrorInfoSchema } from "@nama/api/google/rpc/error_details_pb.js";
import type {
  BadRequest,
  BadRequest_FieldViolation,
  ErrorInfo,
} from "@nama/api/google/rpc/error_details_pb.js";
import type { ListItemsRequest } from "@nama/api/nama/plugin/v1/library_pb.js";

import { decodeCatalogContinuation } from "./catalog-continuation.ts";
import type { CatalogContinuationPosition } from "./catalog-continuation.ts";
import type { ProviderLaunchDocument } from "./launch-document.ts";
import { hasMaximumCodePointLength } from "./value.ts";

const EMPTY_LENGTH = 0;
const DEFAULT_CATALOG_PAGE_SIZE = 50;
const MAXIMUM_CATALOG_PAGE_SIZE = 100;
const MAXIMUM_CATALOG_CONTINUATION_CODE_POINTS = 4096;
const CATALOG_CONTINUATION_LIFETIME_SECONDS = 86_400;
const PLUGIN_ERROR_DOMAIN = "nama.plugin.v1";
const VALIDATION_FAILED_REASON = "VALIDATION_FAILED";
const REQUIRED_REASON = "REQUIRED";
const OUT_OF_RANGE_REASON = "OUT_OF_RANGE";
const CATALOG_SCAN_FIELD = "scan";
const CATALOG_PAGE_SIZE_FIELD = "scan.begin.page_size";
const CATALOG_CONTINUATION_FIELD = "scan.continuation";
const CATALOG_SCAN_DESCRIPTION = "Must select begin or continuation.";
const CATALOG_PAGE_SIZE_DESCRIPTION = "Must be between 0 and 100.";
const CATALOG_CONTINUATION_DESCRIPTION = "Must contain between 1 and 4096 characters.";

const catalogValidationError = (
  field: string,
  description: string,
  reason: "OUT_OF_RANGE" | "REQUIRED",
): ConnectError => {
  const errorInfo: ErrorInfo = {
    $typeName: "google.rpc.ErrorInfo",
    domain: PLUGIN_ERROR_DOMAIN,
    metadata: {},
    reason: VALIDATION_FAILED_REASON,
  };
  const violation: BadRequest_FieldViolation = {
    $typeName: "google.rpc.BadRequest.FieldViolation",
    description,
    field,
    reason,
  };
  const badRequest: BadRequest = {
    $typeName: "google.rpc.BadRequest",
    fieldViolations: [violation],
  };
  return new ConnectError("catalog request is invalid", Code.InvalidArgument, undefined, [
    { desc: ErrorInfoSchema, value: errorInfo },
    { desc: BadRequestSchema, value: badRequest },
  ]);
};

const beginCatalogPosition = (
  requestedPageSize: number,
  now: number,
): CatalogContinuationPosition => {
  let pageSize = requestedPageSize;
  if (pageSize === EMPTY_LENGTH) {
    pageSize = DEFAULT_CATALOG_PAGE_SIZE;
  }
  if (pageSize > MAXIMUM_CATALOG_PAGE_SIZE) {
    throw catalogValidationError(
      CATALOG_PAGE_SIZE_FIELD,
      CATALOG_PAGE_SIZE_DESCRIPTION,
      OUT_OF_RANGE_REASON,
    );
  }
  return {
    expiresAt: now + CATALOG_CONTINUATION_LIFETIME_SECONDS,
    offset: EMPTY_LENGTH,
    pageSize,
    scanId: randomUUID(),
  };
};

const catalogContinuationForRequest = (request: ListItemsRequest): string => {
  if (request.scan.case !== "continuation") {
    throw catalogValidationError(CATALOG_SCAN_FIELD, CATALOG_SCAN_DESCRIPTION, REQUIRED_REASON);
  }
  const continuation = request.scan.value;
  if (continuation.length === EMPTY_LENGTH) {
    throw catalogValidationError(
      CATALOG_CONTINUATION_FIELD,
      CATALOG_CONTINUATION_DESCRIPTION,
      REQUIRED_REASON,
    );
  }
  if (!hasMaximumCodePointLength(continuation, MAXIMUM_CATALOG_CONTINUATION_CODE_POINTS)) {
    throw catalogValidationError(
      CATALOG_CONTINUATION_FIELD,
      CATALOG_CONTINUATION_DESCRIPTION,
      OUT_OF_RANGE_REASON,
    );
  }
  return continuation;
};

const catalogPositionForRequest = (
  launch: ProviderLaunchDocument,
  request: ListItemsRequest,
  now: number,
): CatalogContinuationPosition => {
  if (request.scan.case === "begin") {
    return beginCatalogPosition(request.scan.value.pageSize, now);
  }
  const continuation = catalogContinuationForRequest(request);
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
    token: continuation,
  });
};

export { catalogPositionForRequest };
