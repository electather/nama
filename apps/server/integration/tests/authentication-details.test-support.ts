import type { Code } from "@connectrpc/connect";
import { ConnectError } from "@connectrpc/connect";
import { expect } from "@effect/vitest";
import {
  BadRequestSchema,
  ErrorInfoSchema,
  RequestInfoSchema,
} from "@nama/api/google/rpc/error_details_pb.js";

type ExpectedFieldViolation = Readonly<{ description: string; field: string; reason: string }>;
type ExpectedAdministrator = Readonly<{ displayName: string; email: string; id: string }>;
type ApplicationErrorInput = Readonly<{
  error: unknown;
  expectedCode: Code;
  expectedFieldViolations?: readonly ExpectedFieldViolation[];
  expectedReason: string;
}>;

const FIRST_INDEX = 0;
const EXPECTED_SINGLE_ITEM = 1;
const REQUEST_ID_HEADER = "nama-request-id";
const API_ERROR_DOMAIN = "nama.api.v1";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

const administratorFromSetup = (administrator: ExpectedAdministrator | undefined) => {
  if (administrator === undefined) {
    throw new Error("expected setup response administrator");
  }
  return administrator;
};
const expectAdministrator = (
  administrator: ExpectedAdministrator | undefined,
  expectedAdministrator: ExpectedAdministrator,
): void => {
  expect({
    displayName: administrator?.displayName,
    email: administrator?.email,
    id: administrator?.id,
  }).toEqual(expectedAdministrator);
};
const credentialFailureShape = (error: ConnectError) => ({
  badRequest: error.findDetails(BadRequestSchema).map((detail) =>
    detail.fieldViolations.map((violation) => ({
      description: violation.description,
      field: violation.field,
      reason: violation.reason,
    })),
  ),
  code: error.code,
  errorInfo: error.findDetails(ErrorInfoSchema).map((detail) => ({
    domain: detail.domain,
    metadata: detail.metadata,
    reason: detail.reason,
  })),
  requestInfo: error.findDetails(RequestInfoSchema).map((detail) => ({
    servingData: detail.servingData,
  })),
});
const expectErrorInfo = (error: ConnectError, expectedReason: string): void => {
  const errorInfos = error.findDetails(ErrorInfoSchema);
  expect(errorInfos).toHaveLength(EXPECTED_SINGLE_ITEM);
  const errorInfo = errorInfos.at(FIRST_INDEX);
  expect({
    domain: errorInfo?.domain,
    metadata: errorInfo?.metadata,
    reason: errorInfo?.reason,
  }).toEqual({ domain: API_ERROR_DOMAIN, metadata: {}, reason: expectedReason });
};
const expectRequestInfo = (error: ConnectError): void => {
  const requestInfos = error.findDetails(RequestInfoSchema);
  expect(requestInfos).toHaveLength(EXPECTED_SINGLE_ITEM);
  const requestInfo = requestInfos.at(FIRST_INDEX);
  expect(requestInfo?.requestId).toMatch(UUID_PATTERN);
  expect(requestInfo?.servingData).toBe("");
  expect(error.metadata.get(REQUEST_ID_HEADER)).toBe(requestInfo?.requestId);
};
const expectBadRequestDetails = (
  error: ConnectError,
  expectedFieldViolations: readonly ExpectedFieldViolation[] | undefined,
): void => {
  const badRequests = error.findDetails(BadRequestSchema);
  if (expectedFieldViolations === undefined) {
    expect(badRequests).toEqual([]);
    return;
  }
  expect(badRequests).toHaveLength(EXPECTED_SINGLE_ITEM);
  const fieldViolations = badRequests.at(FIRST_INDEX)?.fieldViolations.map((violation) => ({
    description: violation.description,
    field: violation.field,
    reason: violation.reason,
  }));
  expect(fieldViolations).toEqual(expectedFieldViolations);
};
const expectApplicationError = (input: ApplicationErrorInput): ConnectError => {
  if (!(input.error instanceof ConnectError)) {
    throw new Error("expected Connect application failure", { cause: input.error });
  }
  const { error } = input;
  expect(error.code).toBe(input.expectedCode);
  expectErrorInfo(error, input.expectedReason);
  expectRequestInfo(error);
  expectBadRequestDetails(error, input.expectedFieldViolations);
  return error;
};

export {
  administratorFromSetup,
  credentialFailureShape,
  expectAdministrator,
  expectApplicationError,
};
export type { ApplicationErrorInput, ExpectedAdministrator, ExpectedFieldViolation };
