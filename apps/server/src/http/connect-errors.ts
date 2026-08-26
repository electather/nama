// oxlint-disable eslint/max-lines -- Public failure normalization keeps the complete allowlisted tag, detail, and retry mapping in one auditable boundary.
import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import {
  BadRequestSchema,
  ErrorInfoSchema,
  RequestInfoSchema,
  RetryInfoSchema,
} from "@nama/api/google/rpc/error_details_pb.js";

const API_ERROR_DOMAIN = "nama.api.v1";
const MILLISECONDS_PER_SECOND = 1000n;
const NANOSECONDS_PER_MILLISECOND = 1_000_000;
const PUBLIC_ERROR_MESSAGE = "The request could not be completed.";
const ZERO_MILLISECONDS = 0;
const PROVIDER_RETRY_DELAY_MILLISECONDS = 5000;

type PublicErrorReason =
  | "ALREADY_INITIALIZED"
  | "AUTHENTICATION_FAILED"
  | "CATALOG_NOT_READY"
  | "AUTHENTICATION_UNAVAILABLE"
  | "CREDENTIAL_INVALID"
  | "DEVICE_AUTHORIZATION_ACCESS_DENIED"
  | "DEVICE_AUTHORIZATION_ALREADY_PROCESSED"
  | "DEVICE_AUTHORIZATION_CODE_INVALID"
  | "DEVICE_AUTHORIZATION_EXPIRED"
  | "DEADLINE_EXCEEDED"
  | "INTERNAL"
  | "NOT_INITIALIZED"
  | "PERMISSION_DENIED"
  | "MEDIA_HAS_NO_CHILDREN"
  | "MEDIA_STATE_UNAVAILABLE"
  | "IDEMPOTENCY_KEY_REUSED"
  | "PAGE_TOKEN_INVALID"
  | "PLUGIN_UNAVAILABLE"
  | "PROVIDER_AUTHENTICATION_FAILED"
  | "PROVIDER_COMMIT_AMBIGUOUS"
  | "PROVIDER_CREDENTIALS_UNAVAILABLE"
  | "PROVIDER_INCOMPATIBLE"
  | "PROVIDER_INSTANCE_LIMIT_REACHED"
  | "PROVIDER_INSTANCE_BUSY"
  | "PROVIDER_USER_CHANGED"
  | "PROVIDER_UNAVAILABLE"
  | "RESOURCE_NOT_FOUND"
  | "RATE_LIMITED"
  | "REVISION_MISMATCH"
  | "REQUEST_CANCELLED"
  | "SESSION_REVOCATION_UNCONFIRMED"
  | "SETUP_IN_PROGRESS"
  | "SOURCE_UNAVAILABLE"
  | "SETUP_UNAVAILABLE"
  | "VALIDATION_FAILED";

type PreNormalizedFieldViolation = Readonly<{
  readonly description: string;
  readonly field: string;
  readonly reason: string;
}>;

type TaggedFailureTag =
  | "AuthenticationStoreUnavailable"
  | "BootstrapSetupClosedError"
  | "BootstrapTokenBusyError"
  | "BootstrapTokenInvalidError"
  | "BootstrapTokenUnavailableError"
  | "CatalogNotReady"
  | "DeadlineExceeded"
  | "DeviceAuthorizationAccessDenied"
  | "DeviceAuthorizationAlreadyProcessed"
  | "DeviceAuthorizationCodeInvalid"
  | "DeviceAuthorizationExpired"
  | "InvalidBearer"
  | "InvalidCredentials"
  | "MissingAuthorityInventory"
  | "MediaHasNoChildren"
  | "MediaStateUnavailable"
  | "NotInitialized"
  | "PermissionDenied"
  | "PageTokenInvalid"
  | "IdempotencyKeyReused"
  | "ProviderAuthenticationFailed"
  | "ProviderCommitAmbiguous"
  | "ProviderCredentialsUnavailable"
  | "ProviderIncompatible"
  | "ProviderInstanceLimitReached"
  | "ProviderInstanceBusy"
  | "ProviderPluginUnavailable"
  | "ProviderResourceNotFound"
  | "ProviderUnavailable"
  | "ProviderUserChanged"
  | "ProviderValidationFailed"
  | "PrivateAuthenticationDefect"
  | "ResourceNotFound"
  | "SearchQueryInvalid"
  | "SourceUnavailable"
  | "RequestCancelled"
  | "RevisionMismatch"
  | "SessionRevocationUnconfirmed"
  | "SetupAlreadyInitialized"
  | "SetupCommitAmbiguous";

type TaggedFailureMapping = Readonly<{
  readonly code: Code;
  readonly reason: PublicErrorReason;
}>;

const TAGGED_FAILURE_MAPPINGS = Object.freeze({
  AuthenticationStoreUnavailable: {
    code: Code.Unavailable,
    reason: "AUTHENTICATION_UNAVAILABLE",
  },
  BootstrapSetupClosedError: {
    code: Code.FailedPrecondition,
    reason: "ALREADY_INITIALIZED",
  },
  BootstrapTokenBusyError: {
    code: Code.Aborted,
    reason: "SETUP_IN_PROGRESS",
  },
  BootstrapTokenInvalidError: {
    code: Code.Unauthenticated,
    reason: "AUTHENTICATION_FAILED",
  },
  BootstrapTokenUnavailableError: {
    code: Code.Unavailable,
    reason: "SETUP_UNAVAILABLE",
  },
  CatalogNotReady: {
    code: Code.Unavailable,
    reason: "CATALOG_NOT_READY",
  },
  DeadlineExceeded: {
    code: Code.DeadlineExceeded,
    reason: "DEADLINE_EXCEEDED",
  },
  DeviceAuthorizationAccessDenied: {
    code: Code.PermissionDenied,
    reason: "DEVICE_AUTHORIZATION_ACCESS_DENIED",
  },
  DeviceAuthorizationAlreadyProcessed: {
    code: Code.FailedPrecondition,
    reason: "DEVICE_AUTHORIZATION_ALREADY_PROCESSED",
  },
  DeviceAuthorizationCodeInvalid: {
    code: Code.InvalidArgument,
    reason: "DEVICE_AUTHORIZATION_CODE_INVALID",
  },
  DeviceAuthorizationExpired: {
    code: Code.FailedPrecondition,
    reason: "DEVICE_AUTHORIZATION_EXPIRED",
  },
  IdempotencyKeyReused: {
    code: Code.AlreadyExists,
    reason: "IDEMPOTENCY_KEY_REUSED",
  },
  InvalidBearer: {
    code: Code.Unauthenticated,
    reason: "CREDENTIAL_INVALID",
  },
  InvalidCredentials: {
    code: Code.Unauthenticated,
    reason: "AUTHENTICATION_FAILED",
  },
  MediaHasNoChildren: {
    code: Code.FailedPrecondition,
    reason: "MEDIA_HAS_NO_CHILDREN",
  },
  MediaStateUnavailable: {
    code: Code.FailedPrecondition,
    reason: "MEDIA_STATE_UNAVAILABLE",
  },
  MissingAuthorityInventory: {
    code: Code.PermissionDenied,
    reason: "PERMISSION_DENIED",
  },
  NotInitialized: {
    code: Code.FailedPrecondition,
    reason: "NOT_INITIALIZED",
  },
  PageTokenInvalid: {
    code: Code.InvalidArgument,
    reason: "PAGE_TOKEN_INVALID",
  },
  PermissionDenied: {
    code: Code.PermissionDenied,
    reason: "PERMISSION_DENIED",
  },
  PrivateAuthenticationDefect: {
    code: Code.Internal,
    reason: "INTERNAL",
  },
  ProviderAuthenticationFailed: {
    code: Code.FailedPrecondition,
    reason: "PROVIDER_AUTHENTICATION_FAILED",
  },
  ProviderCommitAmbiguous: {
    code: Code.Unavailable,
    reason: "PROVIDER_COMMIT_AMBIGUOUS",
  },
  ProviderCredentialsUnavailable: {
    code: Code.Unavailable,
    reason: "PROVIDER_CREDENTIALS_UNAVAILABLE",
  },
  ProviderIncompatible: {
    code: Code.FailedPrecondition,
    reason: "PROVIDER_INCOMPATIBLE",
  },
  ProviderInstanceBusy: {
    code: Code.FailedPrecondition,
    reason: "PROVIDER_INSTANCE_BUSY",
  },
  ProviderInstanceLimitReached: {
    code: Code.ResourceExhausted,
    reason: "PROVIDER_INSTANCE_LIMIT_REACHED",
  },
  ProviderPluginUnavailable: {
    code: Code.Unavailable,
    reason: "PLUGIN_UNAVAILABLE",
  },
  ProviderResourceNotFound: {
    code: Code.NotFound,
    reason: "RESOURCE_NOT_FOUND",
  },
  ProviderUnavailable: {
    code: Code.Unavailable,
    reason: "PROVIDER_UNAVAILABLE",
  },
  ProviderUserChanged: {
    code: Code.FailedPrecondition,
    reason: "PROVIDER_USER_CHANGED",
  },
  ProviderValidationFailed: {
    code: Code.InvalidArgument,
    reason: "VALIDATION_FAILED",
  },
  RequestCancelled: {
    code: Code.Canceled,
    reason: "REQUEST_CANCELLED",
  },
  ResourceNotFound: {
    code: Code.NotFound,
    reason: "RESOURCE_NOT_FOUND",
  },
  RevisionMismatch: {
    code: Code.Aborted,
    reason: "REVISION_MISMATCH",
  },
  SearchQueryInvalid: {
    code: Code.InvalidArgument,
    reason: "VALIDATION_FAILED",
  },
  SessionRevocationUnconfirmed: {
    code: Code.Unavailable,
    reason: "SESSION_REVOCATION_UNCONFIRMED",
  },
  SetupAlreadyInitialized: {
    code: Code.FailedPrecondition,
    reason: "ALREADY_INITIALIZED",
  },
  SetupCommitAmbiguous: {
    code: Code.Unavailable,
    reason: "SETUP_UNAVAILABLE",
  },
  SourceUnavailable: {
    code: Code.Unavailable,
    reason: "SOURCE_UNAVAILABLE",
  },
} as const satisfies Record<TaggedFailureTag, TaggedFailureMapping>);

type ConnectErrorOutgoingDetail = Extract<
  ConnectError["details"][number],
  { readonly desc: unknown }
>;

type ApplicationErrorOptions = Readonly<{
  readonly code: Code;
  readonly extraDetails?: readonly ConnectErrorOutgoingDetail[];
  readonly reason: PublicErrorReason;
  readonly requestId: string;
}>;

const createApplicationError = ({
  code,
  extraDetails = [],
  reason,
  requestId,
}: ApplicationErrorOptions): ConnectError =>
  new ConnectError(PUBLIC_ERROR_MESSAGE, code, undefined, [
    {
      desc: ErrorInfoSchema,
      value: create(ErrorInfoSchema, {
        domain: API_ERROR_DOMAIN,
        reason,
      }),
    },
    {
      desc: RequestInfoSchema,
      value: create(RequestInfoSchema, { requestId }),
    },
    ...extraDetails,
  ]);

const retryDelayFromMilliseconds = (retryAfterMilliseconds: number) => {
  if (!Number.isSafeInteger(retryAfterMilliseconds) || retryAfterMilliseconds < ZERO_MILLISECONDS) {
    throw new RangeError("retryAfterMilliseconds must be a nonnegative safe integer");
  }

  const milliseconds = BigInt(retryAfterMilliseconds);
  return {
    nanos: Number(milliseconds % MILLISECONDS_PER_SECOND) * NANOSECONDS_PER_MILLISECOND,
    seconds: milliseconds / MILLISECONDS_PER_SECOND,
  };
};

const isTaggedFailureTag = (value: unknown): value is TaggedFailureTag =>
  typeof value === "string" && Object.hasOwn(TAGGED_FAILURE_MAPPINGS, value);

type DataPropertyDescriptor = Readonly<{ readonly value?: unknown }>;

const dataPropertyValue = (value: object, property: PropertyKey): unknown => {
  const descriptor: DataPropertyDescriptor | undefined = Object.getOwnPropertyDescriptor(
    value,
    property,
  );
  if (descriptor === undefined || !Object.hasOwn(descriptor, "value")) {
    return undefined;
  }

  return descriptor.value;
};

const taggedFailureTag = (failure: unknown): TaggedFailureTag | undefined => {
  if (typeof failure !== "object" || failure === null) {
    return undefined;
  }

  try {
    const tag = dataPropertyValue(failure, "_tag");
    if (!isTaggedFailureTag(tag)) {
      return undefined;
    }

    return tag;
  } catch {
    return undefined;
  }
};

const createValidationError = (
  requestId: string,
  preNormalizedViolations: readonly PreNormalizedFieldViolation[],
): ConnectError =>
  createApplicationError({
    code: Code.InvalidArgument,
    extraDetails: [
      {
        desc: BadRequestSchema,
        value: create(BadRequestSchema, { fieldViolations: [...preNormalizedViolations] }),
      },
    ],
    reason: "VALIDATION_FAILED",
    requestId,
  });

const createRateLimitError = (requestId: string, retryAfterMilliseconds: number): ConnectError =>
  createApplicationError({
    code: Code.ResourceExhausted,
    extraDetails: [
      {
        desc: RetryInfoSchema,
        value: create(RetryInfoSchema, {
          retryDelay: retryDelayFromMilliseconds(retryAfterMilliseconds),
        }),
      },
    ],
    reason: "RATE_LIMITED",
    requestId,
  });

const providerFieldViolation = (violation: unknown): PreNormalizedFieldViolation | undefined => {
  if (typeof violation !== "object" || violation === null) {
    return undefined;
  }

  const description = dataPropertyValue(violation, "description");
  const field = dataPropertyValue(violation, "field");
  const reason = dataPropertyValue(violation, "reason");
  if (typeof description !== "string" || typeof field !== "string" || typeof reason !== "string") {
    return undefined;
  }

  return { description, field, reason };
};

const providerFieldViolations = (
  value: unknown,
): readonly PreNormalizedFieldViolation[] | undefined => {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const violations: PreNormalizedFieldViolation[] = [];
  for (const rawViolation of value) {
    const violation = providerFieldViolation(rawViolation);
    if (violation === undefined) {
      return undefined;
    }
    violations.push(violation);
  }
  return violations;
};

const providerValidationError = (requestId: string, failure: unknown): ConnectError | undefined => {
  if (
    taggedFailureTag(failure) !== "ProviderValidationFailed" ||
    typeof failure !== "object" ||
    failure === null
  ) {
    return undefined;
  }

  const violations = providerFieldViolations(dataPropertyValue(failure, "violations"));
  if (violations === undefined) {
    return undefined;
  }
  return createValidationError(requestId, violations);
};

const isRetryDelayMilliseconds = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= ZERO_MILLISECONDS;

const catalogRetryError = (
  requestId: string,
  failure: unknown,
  tag: "CatalogNotReady" | "SourceUnavailable",
): ConnectError | undefined => {
  if (typeof failure !== "object" || failure === null) {
    return createApplicationError({ code: Code.Internal, reason: "INTERNAL", requestId });
  }
  const retryDelayMilliseconds = dataPropertyValue(failure, "retryDelayMilliseconds");
  if (retryDelayMilliseconds === undefined) {
    if (tag === "SourceUnavailable") {
      return undefined;
    }
    return createApplicationError({ code: Code.Internal, reason: "INTERNAL", requestId });
  }
  if (!isRetryDelayMilliseconds(retryDelayMilliseconds)) {
    return createApplicationError({ code: Code.Internal, reason: "INTERNAL", requestId });
  }
  return createApplicationError({
    ...TAGGED_FAILURE_MAPPINGS[tag],
    extraDetails: [
      {
        desc: RetryInfoSchema,
        value: create(RetryInfoSchema, {
          retryDelay: retryDelayFromMilliseconds(retryDelayMilliseconds),
        }),
      },
    ],
    requestId,
  });
};

const catalogApplicationError = (
  requestId: string,
  failure: unknown,
  tag: TaggedFailureTag | undefined,
): ConnectError | undefined => {
  if (tag === "SearchQueryInvalid") {
    return createValidationError(requestId, [
      {
        description: "Enter a non-whitespace search query.",
        field: "query",
        reason: "INVALID_FORMAT",
      },
    ]);
  }
  if (tag === "CatalogNotReady" || tag === "SourceUnavailable") {
    return catalogRetryError(requestId, failure, tag);
  }
  return undefined;
};

const taggedApplicationError = (
  requestId: string,
  tag: TaggedFailureTag | undefined,
): ConnectError => {
  if (tag === undefined) {
    return createApplicationError({ code: Code.Internal, reason: "INTERNAL", requestId });
  }
  if (tag === "ProviderPluginUnavailable" || tag === "ProviderUnavailable") {
    return createApplicationError({
      ...TAGGED_FAILURE_MAPPINGS[tag],
      extraDetails: [
        {
          desc: RetryInfoSchema,
          value: create(RetryInfoSchema, {
            retryDelay: retryDelayFromMilliseconds(PROVIDER_RETRY_DELAY_MILLISECONDS),
          }),
        },
      ],
      requestId,
    });
  }
  return createApplicationError({
    ...TAGGED_FAILURE_MAPPINGS[tag],
    requestId,
  });
};

const normalizeConnectFailure = (requestId: string, failure: unknown): ConnectError => {
  const validation = providerValidationError(requestId, failure);
  if (validation !== undefined) {
    return validation;
  }
  const tag = taggedFailureTag(failure);
  const catalogError = catalogApplicationError(requestId, failure, tag);
  if (catalogError !== undefined) {
    return catalogError;
  }

  return taggedApplicationError(requestId, tag);
};

export { createRateLimitError, createValidationError, normalizeConnectFailure };

export type { PreNormalizedFieldViolation };
