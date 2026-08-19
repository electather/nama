import { Code, ConnectError } from "@connectrpc/connect";
import {
  BadRequestSchema,
  ErrorInfoSchema,
  RequestInfoSchema,
  RetryInfoSchema,
} from "@nama/api/google/rpc/error_details_pb.js";
import { expect, test } from "vitest";

import {
  createRateLimitError,
  createValidationError,
  normalizeConnectFailure,
} from "../connect-errors.ts";

const API_ERROR_DOMAIN = "nama.api.v1";
const REQUEST_ID = "5e1cfe0d-01af-4901-ab1b-473fc7bfbb7b";
const RETRY_DELAY_MILLISECONDS = 1234;
const PROTOBUF_RETRY_DELAY = Object.freeze({
  nanos: 234_000_000,
  seconds: 1n,
});
const PROVIDER_RETRY_DELAY = Object.freeze({
  nanos: 0,
  seconds: 5n,
});
const ERROR_DETAIL_COUNT = 1;
const FIRST_ERROR_DETAIL_INDEX = 0;
const FIELD_VIOLATION_LIMIT = 50;
const VALIDATION_FIELD_INDEX_WIDTH = 2;
const UNSAFE_BOOTSTRAP_TOKEN = "bootstrap-token-must-not-escape";
const UNSAFE_BEARER = "Bearer signed-session-token-must-not-escape";
const UNSAFE_FAILURE_DETAIL = "database password=must-not-escape";
const UNSAFE_PASSWORD = "correct-horse-battery-staple";

const preNormalizedViolations = Array.from(
  { length: FIELD_VIOLATION_LIMIT },
  (_unusedElement, fieldOrdinal) => {
    const fieldIndex = String(fieldOrdinal).padStart(VALIDATION_FIELD_INDEX_WIDTH, "0");
    return Object.freeze({
      description: "Enter a supported value.",
      field: `request.fields[${fieldIndex}]`,
      reason: "UNSUPPORTED_VALUE",
    });
  },
);

const expectErrorInfo = (error: ConnectError, expectedReason: string): void => {
  const errorInfo = error.findDetails(ErrorInfoSchema);
  expect(errorInfo).toHaveLength(ERROR_DETAIL_COUNT);
  expect(errorInfo[FIRST_ERROR_DETAIL_INDEX]?.domain).toBe(API_ERROR_DOMAIN);
  expect(errorInfo[FIRST_ERROR_DETAIL_INDEX]?.metadata).toEqual({});
  expect(errorInfo[FIRST_ERROR_DETAIL_INDEX]?.reason).toBe(expectedReason);
};

const expectRequestInfo = (error: ConnectError): void => {
  const requestInfo = error.findDetails(RequestInfoSchema);
  expect(requestInfo).toHaveLength(ERROR_DETAIL_COUNT);
  expect(requestInfo[FIRST_ERROR_DETAIL_INDEX]?.requestId).toBe(REQUEST_ID);
  expect(requestInfo[FIRST_ERROR_DETAIL_INDEX]?.servingData).toBe("");
};

const expectApplicationIdentity = (
  error: ConnectError,
  expectedCode: Code,
  expectedReason: string,
): void => {
  expect(error).toBeInstanceOf(ConnectError);
  expect(error.code).toBe(expectedCode);
  expectErrorInfo(error, expectedReason);
  expectRequestInfo(error);
};

const expectNoRetryGuidance = (error: ConnectError): void => {
  expect(error.findDetails(RetryInfoSchema)).toEqual([]);
};

const expectPublicErrorDoesNotExpose = (
  error: ConnectError,
  unsafeValues: readonly string[],
): void => {
  const publicContents = JSON.stringify({
    badRequest: error.findDetails(BadRequestSchema),
    errorInfo: error.findDetails(ErrorInfoSchema),
    metadata: [...error.metadata.entries()],
    rawMessage: error.rawMessage,
    requestInfo: error.findDetails(RequestInfoSchema),
    retryInfo: error.findDetails(RetryInfoSchema),
  });

  for (const unsafeValue of unsafeValues) {
    expect(publicContents).not.toContain(unsafeValue);
  }
};

const expectValidationDetails = (error: ConnectError): void => {
  const badRequests = error.findDetails(BadRequestSchema);
  expect(badRequests).toHaveLength(ERROR_DETAIL_COUNT);
  expect(
    badRequests[FIRST_ERROR_DETAIL_INDEX]?.fieldViolations.map(
      ({ description, field, reason }) => ({
        description,
        field,
        reason,
      }),
    ),
  ).toEqual(preNormalizedViolations);
  expect(badRequests[FIRST_ERROR_DETAIL_INDEX]?.fieldViolations).toHaveLength(
    FIELD_VIOLATION_LIMIT,
  );
  expect(
    badRequests[FIRST_ERROR_DETAIL_INDEX]?.fieldViolations.map((violation) => violation.field),
  ).toEqual(preNormalizedViolations.map((violation) => violation.field));
  expectPublicErrorDoesNotExpose(error, [
    UNSAFE_BOOTSTRAP_TOKEN,
    UNSAFE_BEARER,
    UNSAFE_FAILURE_DETAIL,
    UNSAFE_PASSWORD,
  ]);
};

test("createValidationError attaches sorted capped field violations to an invalid argument error", () => {
  const error = createValidationError(REQUEST_ID, preNormalizedViolations);

  expectApplicationIdentity(error, Code.InvalidArgument, "VALIDATION_FAILED");
  expectNoRetryGuidance(error);
  expectValidationDetails(error);
});

test("createRateLimitError preserves an exact millisecond retry delay", () => {
  const error = createRateLimitError(REQUEST_ID, RETRY_DELAY_MILLISECONDS);

  expectApplicationIdentity(error, Code.ResourceExhausted, "RATE_LIMITED");
  expect(error.findDetails(BadRequestSchema)).toEqual([]);

  const retryInfo = error.findDetails(RetryInfoSchema);
  expect(retryInfo).toHaveLength(ERROR_DETAIL_COUNT);
  expect(retryInfo[FIRST_ERROR_DETAIL_INDEX]?.retryDelay?.seconds).toBe(
    PROTOBUF_RETRY_DELAY.seconds,
  );
  expect(retryInfo[FIRST_ERROR_DETAIL_INDEX]?.retryDelay?.nanos).toBe(PROTOBUF_RETRY_DELAY.nanos);
});

const mappedFailureCases = [
  [
    "invalid bootstrap token",
    { _tag: "BootstrapTokenInvalidError", token: UNSAFE_BOOTSTRAP_TOKEN },
    Code.Unauthenticated,
    "AUTHENTICATION_FAILED",
    [UNSAFE_BOOTSTRAP_TOKEN],
  ],
  [
    "concurrent setup claim",
    { _tag: "BootstrapTokenBusyError" },
    Code.Aborted,
    "SETUP_IN_PROGRESS",
    [],
  ],
  [
    "unavailable bootstrap token",
    { _tag: "BootstrapTokenUnavailableError" },
    Code.Unavailable,
    "SETUP_UNAVAILABLE",
    [],
  ],
  [
    "closed bootstrap setup",
    { _tag: "BootstrapSetupClosedError" },
    Code.FailedPrecondition,
    "ALREADY_INITIALIZED",
    [],
  ],
  [
    "already initialized setup coordinator",
    { _tag: "SetupAlreadyInitialized" },
    Code.FailedPrecondition,
    "ALREADY_INITIALIZED",
    [],
  ],
  [
    "ambiguous setup commit",
    { _tag: "SetupCommitAmbiguous", detail: UNSAFE_FAILURE_DETAIL },
    Code.Unavailable,
    "SETUP_UNAVAILABLE",
    [UNSAFE_FAILURE_DETAIL],
  ],
  [
    "invalid sign-in credentials",
    { _tag: "InvalidCredentials", password: UNSAFE_PASSWORD },
    Code.Unauthenticated,
    "AUTHENTICATION_FAILED",
    [UNSAFE_PASSWORD],
  ],
  [
    "invalid bearer",
    { _tag: "InvalidBearer", authorization: UNSAFE_BEARER },
    Code.Unauthenticated,
    "CREDENTIAL_INVALID",
    [UNSAFE_BEARER],
  ],
  [
    "unavailable authentication store",
    { _tag: "AuthenticationStoreUnavailable", detail: UNSAFE_FAILURE_DETAIL },
    Code.Unavailable,
    "AUTHENTICATION_UNAVAILABLE",
    [UNSAFE_FAILURE_DETAIL],
  ],
  [
    "unconfirmed session revocation",
    { _tag: "SessionRevocationUnconfirmed", authorization: UNSAFE_BEARER },
    Code.Unavailable,
    "SESSION_REVOCATION_UNCONFIRMED",
    [UNSAFE_BEARER],
  ],
  [
    "private authentication defect",
    { _tag: "PrivateAuthenticationDefect", detail: UNSAFE_FAILURE_DETAIL },
    Code.Internal,
    "INTERNAL",
    [UNSAFE_FAILURE_DETAIL],
  ],
  [
    "permission denial",
    { _tag: "PermissionDenied" },
    Code.PermissionDenied,
    "PERMISSION_DENIED",
    [],
  ],
  [
    "missing authority inventory",
    { _tag: "MissingAuthorityInventory" },
    Code.PermissionDenied,
    "PERMISSION_DENIED",
    [],
  ],
  [
    "uninitialized setup state",
    { _tag: "NotInitialized" },
    Code.FailedPrecondition,
    "NOT_INITIALIZED",
    [],
  ],
  ["request cancellation", { _tag: "RequestCancelled" }, Code.Canceled, "REQUEST_CANCELLED", []],
  [
    "request deadline",
    { _tag: "DeadlineExceeded" },
    Code.DeadlineExceeded,
    "DEADLINE_EXCEEDED",
    [],
  ],
  [
    "invalid provider page token",
    { _tag: "PageTokenInvalid", token: UNSAFE_FAILURE_DETAIL },
    Code.InvalidArgument,
    "PAGE_TOKEN_INVALID",
    [UNSAFE_FAILURE_DETAIL],
  ],
  [
    "provider resource absence",
    { _tag: "ProviderResourceNotFound" },
    Code.NotFound,
    "RESOURCE_NOT_FOUND",
    [],
  ],
  [
    "provider credential rejection",
    { _tag: "ProviderAuthenticationFailed" },
    Code.FailedPrecondition,
    "PROVIDER_AUTHENTICATION_FAILED",
    [],
  ],
  [
    "provider incompatibility",
    { _tag: "ProviderIncompatible" },
    Code.FailedPrecondition,
    "PROVIDER_INCOMPATIBLE",
    [],
  ],
  [
    "provider instance limit",
    { _tag: "ProviderInstanceLimitReached" },
    Code.ResourceExhausted,
    "PROVIDER_INSTANCE_LIMIT_REACHED",
    [],
  ],
  [
    "provider operation key reuse",
    { _tag: "IdempotencyKeyReused" },
    Code.AlreadyExists,
    "IDEMPOTENCY_KEY_REUSED",
    [],
  ],
  ["stale provider revision", { _tag: "RevisionMismatch" }, Code.Aborted, "REVISION_MISMATCH", []],
  [
    "changed provider principal",
    { _tag: "ProviderUserChanged" },
    Code.FailedPrecondition,
    "PROVIDER_USER_CHANGED",
    [],
  ],
  [
    "unreadable provider credentials",
    { _tag: "ProviderCredentialsUnavailable" },
    Code.Unavailable,
    "PROVIDER_CREDENTIALS_UNAVAILABLE",
    [],
  ],
  [
    "ambiguous provider update commit",
    { _tag: "ProviderCommitAmbiguous" },
    Code.Unavailable,
    "INTERNAL",
    [],
  ],
  [
    "arbitrary defect",
    new ConnectError(UNSAFE_FAILURE_DETAIL, Code.Unknown),
    Code.Internal,
    "INTERNAL",
    [UNSAFE_FAILURE_DETAIL],
  ],
] as const;

for (const [
  description,
  failure,
  expectedCode,
  expectedReason,
  unsafeValues,
] of mappedFailureCases) {
  test(`normalizeConnectFailure maps ${description} without unsafe retry guidance`, () => {
    const error = normalizeConnectFailure(REQUEST_ID, failure);

    expectApplicationIdentity(error, expectedCode, expectedReason);
    expect(error.findDetails(BadRequestSchema)).toEqual([]);
    expectNoRetryGuidance(error);
    expectPublicErrorDoesNotExpose(error, unsafeValues);
  });
}

test.each([
  ["provider unavailability", { _tag: "ProviderUnavailable" }, "PROVIDER_UNAVAILABLE"],
  ["plugin unavailability", { _tag: "ProviderPluginUnavailable" }, "PLUGIN_UNAVAILABLE"],
] as const)("normalizeConnectFailure adds retry guidance for %s", (_title, failure, reason) => {
  const error = normalizeConnectFailure(REQUEST_ID, failure);

  expectApplicationIdentity(error, Code.Unavailable, reason);
  const retry = error.findDetails(RetryInfoSchema);
  expect(retry).toHaveLength(ERROR_DETAIL_COUNT);
  expect(retry[FIRST_ERROR_DETAIL_INDEX]?.retryDelay).toMatchObject(PROVIDER_RETRY_DELAY);
});

test("normalizeConnectFailure preserves provider configuration field violations", () => {
  const error = normalizeConnectFailure(REQUEST_ID, {
    _tag: "ProviderValidationFailed",
    violations: [
      {
        description: "is required",
        field: "configuration.api_key",
        reason: "REQUIRED",
      },
    ],
  });

  expectApplicationIdentity(error, Code.InvalidArgument, "VALIDATION_FAILED");
  expect(
    error.findDetails(BadRequestSchema)[FIRST_ERROR_DETAIL_INDEX]?.fieldViolations,
  ).toMatchObject([
    {
      description: "is required",
      field: "configuration.api_key",
      reason: "REQUIRED",
    },
  ]);
});
