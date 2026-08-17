import { ConnectError } from "@connectrpc/connect";
import type { Code } from "@connectrpc/connect";
import {
  BadRequestSchema,
  ErrorInfoSchema,
  RequestInfoSchema,
  RetryInfoSchema,
} from "@nama/api/google/rpc/error_details_pb.js";
import { expect } from "vitest";

import { REQUEST_ID } from "./request-pipeline-fixtures.ts";

type ApplicationErrorExpectation = Readonly<{
  code: Code;
  promise: Promise<unknown>;
  reason: string;
}>;

const FIRST_DETAIL_INDEX = 0;

const captureApplicationError = async (promise: Promise<unknown>): Promise<ConnectError> => {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ConnectError);
    if (error instanceof ConnectError) {
      return error;
    }
    throw new Error("Expected a Connect application error.", { cause: error });
  }
  throw new Error("Expected an application error.");
};

const expectApplicationIdentity = (
  error: ConnectError,
  expectation: ApplicationErrorExpectation,
): void => {
  expect(error.code).toBe(expectation.code);
  expect(error.findDetails(ErrorInfoSchema)).toEqual([
    expect.objectContaining({
      domain: "nama.api.v1",
      metadata: {},
      reason: expectation.reason,
    }),
  ]);
};

const expectRequestDetail = (error: ConnectError): void => {
  expect(error.findDetails(RequestInfoSchema)).toEqual([
    expect.objectContaining({ requestId: REQUEST_ID, servingData: "" }),
  ]);
};

type FieldViolationExpectation = Readonly<{
  description: string;
  field: string;
  reason: string;
}>;

const expectValidationFieldViolation = (
  error: ConnectError,
  expectation: FieldViolationExpectation,
): void => {
  expect(error.findDetails(BadRequestSchema)).toEqual([
    expect.objectContaining({
      fieldViolations: [expect.objectContaining(expectation)],
    }),
  ]);
};

const expectRetryAfter = (error: ConnectError, seconds: bigint, nanos: number): void => {
  const retryInfo = error.findDetails(RetryInfoSchema)[FIRST_DETAIL_INDEX];
  expect(retryInfo).toBeDefined();
  if (retryInfo === undefined) {
    throw new Error("Expected retry information.");
  }
  const { retryDelay } = retryInfo;
  expect(retryDelay).toBeDefined();
  if (retryDelay === undefined) {
    throw new Error("Expected retry delay.");
  }
  expect(retryDelay.nanos).toBe(nanos);
  expect(retryDelay.seconds).toBe(seconds);
};

const expectApplicationError = async (
  expectation: ApplicationErrorExpectation,
): Promise<ConnectError> => {
  const error = await captureApplicationError(expectation.promise);
  expectApplicationIdentity(error, expectation);
  expectRequestDetail(error);
  return error;
};

export type { ApplicationErrorExpectation, FieldViolationExpectation };

export { expectApplicationError, expectRetryAfter, expectValidationFieldViolation };
