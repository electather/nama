// oxlint-disable eslint/max-lines, eslint/max-statements, eslint/sort-keys -- Public failure normalization keeps the complete allowlisted tag, detail, and retry mapping in one auditable boundary.
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
  | "AUTHENTICATION_UNAVAILABLE"
  | "CREDENTIAL_INVALID"
  | "DEADLINE_EXCEEDED"
  | "INTERNAL"
  | "NOT_INITIALIZED"
  | "PERMISSION_DENIED"
  | "IDEMPOTENCY_KEY_REUSED"
  | "PAGE_TOKEN_INVALID"
  | "PLUGIN_UNAVAILABLE"
  | "PROVIDER_AUTHENTICATION_FAILED"
  | "PROVIDER_INCOMPATIBLE"
  | "PROVIDER_INSTANCE_LIMIT_REACHED"
  | "PROVIDER_UNAVAILABLE"
  | "RESOURCE_NOT_FOUND"
  | "RATE_LIMITED"
  | "REQUEST_CANCELLED"
  | "SESSION_REVOCATION_UNCONFIRMED"
  | "SETUP_IN_PROGRESS"
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
  | "DeadlineExceeded"
  | "InvalidBearer"
  | "InvalidCredentials"
  | "MissingAuthorityInventory"
  | "NotInitialized"
  | "PermissionDenied"
  | "PageTokenInvalid"
  | "IdempotencyKeyReused"
  | "ProviderAuthenticationFailed"
  | "ProviderIncompatible"
  | "ProviderInstanceLimitReached"
  | "ProviderPluginUnavailable"
  | "ProviderResourceNotFound"
  | "ProviderUnavailable"
  | "ProviderValidationFailed"
  | "PrivateAuthenticationDefect"
  | "RequestCancelled"
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
  DeadlineExceeded: {
    code: Code.DeadlineExceeded,
    reason: "DEADLINE_EXCEEDED",
  },
  InvalidBearer: {
    code: Code.Unauthenticated,
    reason: "CREDENTIAL_INVALID",
  },
  InvalidCredentials: {
    code: Code.Unauthenticated,
    reason: "AUTHENTICATION_FAILED",
  },
  MissingAuthorityInventory: {
    code: Code.PermissionDenied,
    reason: "PERMISSION_DENIED",
  },
  NotInitialized: {
    code: Code.FailedPrecondition,
    reason: "NOT_INITIALIZED",
  },
  IdempotencyKeyReused: {
    code: Code.AlreadyExists,
    reason: "IDEMPOTENCY_KEY_REUSED",
  },
  PageTokenInvalid: {
    code: Code.InvalidArgument,
    reason: "PAGE_TOKEN_INVALID",
  },
  PermissionDenied: {
    code: Code.PermissionDenied,
    reason: "PERMISSION_DENIED",
  },
  ProviderAuthenticationFailed: {
    code: Code.FailedPrecondition,
    reason: "PROVIDER_AUTHENTICATION_FAILED",
  },
  ProviderIncompatible: {
    code: Code.FailedPrecondition,
    reason: "PROVIDER_INCOMPATIBLE",
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
  ProviderValidationFailed: {
    code: Code.InvalidArgument,
    reason: "VALIDATION_FAILED",
  },
  PrivateAuthenticationDefect: {
    code: Code.Internal,
    reason: "INTERNAL",
  },
  RequestCancelled: {
    code: Code.Canceled,
    reason: "REQUEST_CANCELLED",
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

// fallow-ignore-next-line complexity -- Provider field details are structurally allowlisted before entering public protobuf errors.
const providerValidationError = (requestId: string, failure: unknown): ConnectError | undefined => {
  if (
    taggedFailureTag(failure) !== "ProviderValidationFailed" ||
    typeof failure !== "object" ||
    failure === null
  ) {
    return undefined;
  }
  const value = dataPropertyValue(failure, "violations");
  if (!Array.isArray(value)) {
    return undefined;
  }
  const violationValues: readonly unknown[] = value;
  const violations: PreNormalizedFieldViolation[] = [];
  for (const violation of violationValues) {
    if (typeof violation !== "object" || violation === null) {
      return undefined;
    }
    const description = dataPropertyValue(violation, "description");
    const field = dataPropertyValue(violation, "field");
    const reason = dataPropertyValue(violation, "reason");
    if (
      typeof description !== "string" ||
      typeof field !== "string" ||
      typeof reason !== "string"
    ) {
      return undefined;
    }
    violations.push({ description, field, reason });
  }
  return createValidationError(requestId, violations);
};

const normalizeConnectFailure = (requestId: string, failure: unknown): ConnectError => {
  const validation = providerValidationError(requestId, failure);
  if (validation !== undefined) {
    return validation;
  }
  const tag = taggedFailureTag(failure);
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

export { createRateLimitError, createValidationError, normalizeConnectFailure };

export type { PreNormalizedFieldViolation };
