import type { ConnectRouter } from "@connectrpc/connect";
import { Code, ConnectError } from "@connectrpc/connect";
import { BadRequestSchema, ErrorInfoSchema } from "@nama/api/google/rpc/error_details_pb.js";
import type {
  BadRequest,
  BadRequest_FieldViolation,
  ErrorInfo,
} from "@nama/api/google/rpc/error_details_pb.js";
import { WatchStateService } from "@nama/api/nama/plugin/v1/watch_state_pb.js";
import type {
  GetWatchStatesRequest,
  PushWatchStatesRequest,
} from "@nama/api/nama/plugin/v1/watch_state_pb.js";

import { identifierViolationReason } from "./identifier.ts";
import type { LaunchDocument } from "./launch-document.ts";
import { pushJellyfinWatchStates } from "./watch-state-mutation.ts";
import { listJellyfinWatchStates } from "./watch-state-scan.ts";
import { getJellyfinWatchStates } from "./watch-state.ts";

const MINIMUM_ITEM_REFERENCES = 1;
const MAXIMUM_ITEM_REFERENCES = 100;
const MINIMUM_MUTATIONS = 1;
const MAXIMUM_MUTATIONS = 100;
const MAXIMUM_BATCH_ID_LENGTH = 256;
const MAXIMUM_ITEM_ID_LENGTH = 256;
const MAXIMUM_FIELD_VIOLATIONS = 50;
const NO_FIELD_VIOLATIONS = 0;
const PLUGIN_ERROR_DOMAIN = "nama.plugin.v1";
const VALIDATION_FAILED_REASON = "VALIDATION_FAILED";
const OUT_OF_RANGE_REASON = "OUT_OF_RANGE";
const ITEM_REFERENCES_FIELD = "item_references";
const BATCH_ID_FIELD = "batch_id";
const MUTATIONS_FIELD = "mutations";
const ITEM_ID_DESCRIPTION = "Must contain between 1 and 256 characters.";
const ITEM_REFERENCES_DESCRIPTION = "Must contain between 1 and 100 references.";
const BATCH_ID_DESCRIPTION = "Must contain between 1 and 256 characters.";
const MUTATIONS_DESCRIPTION = "Must contain between 1 and 100 mutations.";

type RequireAuthorization = (authorization: string | null, bearer: string) => void;

const fieldViolation = (
  field: string,
  description: string,
  reason: "OUT_OF_RANGE" | "REQUIRED",
): BadRequest_FieldViolation => ({
  $typeName: "google.rpc.BadRequest.FieldViolation",
  description,
  field,
  reason,
});

const watchStateRequestViolations = (
  request: GetWatchStatesRequest,
): BadRequest_FieldViolation[] => {
  const violations: BadRequest_FieldViolation[] = [];
  if (
    request.itemReferences.length < MINIMUM_ITEM_REFERENCES ||
    request.itemReferences.length > MAXIMUM_ITEM_REFERENCES
  ) {
    violations.push(
      fieldViolation(ITEM_REFERENCES_FIELD, ITEM_REFERENCES_DESCRIPTION, OUT_OF_RANGE_REASON),
    );
  }
  for (const [index, { itemId }] of request.itemReferences.entries()) {
    if (violations.length >= MAXIMUM_FIELD_VIOLATIONS) {
      break;
    }
    const reason = identifierViolationReason(itemId, MAXIMUM_ITEM_ID_LENGTH);
    if (reason !== false) {
      violations.push(
        fieldViolation(`item_references[${index}].item_id`, ITEM_ID_DESCRIPTION, reason),
      );
    }
  }
  return violations;
};
const pushWatchStateRequestViolations = (
  request: PushWatchStatesRequest,
): BadRequest_FieldViolation[] => {
  const violations: BadRequest_FieldViolation[] = [];
  const batchIdReason = identifierViolationReason(request.batchId, MAXIMUM_BATCH_ID_LENGTH);
  if (batchIdReason !== false) {
    violations.push(fieldViolation(BATCH_ID_FIELD, BATCH_ID_DESCRIPTION, batchIdReason));
  }
  if (
    request.mutations.length < MINIMUM_MUTATIONS ||
    request.mutations.length > MAXIMUM_MUTATIONS
  ) {
    violations.push(fieldViolation(MUTATIONS_FIELD, MUTATIONS_DESCRIPTION, OUT_OF_RANGE_REASON));
  }
  return violations;
};

const validationError = (violations: BadRequest_FieldViolation[]): ConnectError => {
  const errorInfo: ErrorInfo = {
    $typeName: "google.rpc.ErrorInfo",
    domain: PLUGIN_ERROR_DOMAIN,
    metadata: {},
    reason: VALIDATION_FAILED_REASON,
  };
  const badRequest: BadRequest = {
    $typeName: "google.rpc.BadRequest",
    fieldViolations: violations,
  };
  return new ConnectError("watch-state request is invalid", Code.InvalidArgument, undefined, [
    { desc: ErrorInfoSchema, value: errorInfo },
    { desc: BadRequestSchema, value: badRequest },
  ]);
};

const registerGetWatchStates = (
  router: ConnectRouter,
  launch: LaunchDocument,
  requireAuthorization: RequireAuthorization,
): void => {
  router.rpc(WatchStateService.method.getWatchStates, (request, context) => {
    requireAuthorization(context.requestHeader.get("authorization"), launch.bearer);
    if (launch.kind !== "instance") {
      throw new ConnectError("watch state unavailable", Code.Unimplemented);
    }
    const violations = watchStateRequestViolations(request);
    if (violations.length > NO_FIELD_VIOLATIONS) {
      throw validationError(violations);
    }
    return getJellyfinWatchStates(
      {
        apiKey: launch.credentials.api_key,
        baseUrl: launch.configuration.base_url,
        userId: launch.configuration.user_id,
      },
      request.itemReferences,
      { cancellation: context.signal, request: context.signal },
    );
  });
};

const registerListWatchStates = (
  router: ConnectRouter,
  launch: LaunchDocument,
  requireAuthorization: RequireAuthorization,
): void => {
  router.rpc(WatchStateService.method.listWatchStates, (request, context) => {
    requireAuthorization(context.requestHeader.get("authorization"), launch.bearer);
    if (launch.kind !== "instance") {
      throw new ConnectError("watch state unavailable", Code.Unimplemented);
    }
    return listJellyfinWatchStates(launch, request, context.signal);
  });
};

const registerPushWatchStates = (
  router: ConnectRouter,
  launch: LaunchDocument,
  requireAuthorization: RequireAuthorization,
): void => {
  router.rpc(WatchStateService.method.pushWatchStates, (request, context) => {
    requireAuthorization(context.requestHeader.get("authorization"), launch.bearer);
    if (launch.kind !== "instance") {
      throw new ConnectError("watch state unavailable", Code.Unimplemented);
    }
    const violations = pushWatchStateRequestViolations(request);
    if (violations.length > NO_FIELD_VIOLATIONS) {
      throw validationError(violations);
    }
    return pushJellyfinWatchStates({
      context: {
        apiKey: launch.credentials.api_key,
        baseUrl: launch.configuration.base_url,
        userId: launch.configuration.user_id,
      },
      mutations: request.mutations,
      signal: context.signal,
      timeoutMs: context.timeoutMs,
    });
  });
};

const registerJellyfinWatchStateService = (
  router: ConnectRouter,
  launch: LaunchDocument,
  requireAuthorization: RequireAuthorization,
): void => {
  registerGetWatchStates(router, launch, requireAuthorization);
  registerListWatchStates(router, launch, requireAuthorization);
  registerPushWatchStates(router, launch, requireAuthorization);
};

export { registerJellyfinWatchStateService };
