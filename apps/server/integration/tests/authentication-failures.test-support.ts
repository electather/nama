import { Code } from "@connectrpc/connect";
import type { ConnectError } from "@connectrpc/connect";
import { expect } from "@effect/vitest";
import {
  BadRequestSchema,
  ErrorInfoSchema,
  RequestInfoSchema,
  RetryInfoSchema,
} from "@nama/api/google/rpc/error_details_pb.js";
import { Effect } from "effect";

import {
  expectApplicationError,
  expectApplicationFailure,
} from "./authentication-process.test-support.ts";
import { withPool } from "./database.test-support.ts";
import { MASTER_KEY, structuredLinesFrom } from "./process.test-support.ts";
import type { RunningProcess } from "./process.test-support.ts";

type FailureState = Readonly<{
  publicErrors: ConnectError[];
  runningProcesses: RunningProcess[];
  unsafeValues: string[];
}>;
type RateLimitInput = Readonly<{
  invoke: () => Promise<unknown>;
  publicErrors: ConnectError[];
  retryLimitMilliseconds: number;
}>;
type SensitiveOutputInput = Readonly<{ bootstrapToken: string; state: FailureState }>;
type AuthenticationFailureInput = Readonly<{
  invoke: () => Promise<unknown>;
  publicErrors: ConnectError[];
}>;
const GLOBAL_SIGN_IN_ATTEMPT_COUNT = 100;
const IDENTITY_SIGN_IN_ATTEMPT_COUNT = 5;
const MILLISECONDS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;
const GLOBAL_RATE_WINDOW_SECONDS = 10;
const IDENTITY_RATE_WINDOW_MINUTES = 15;
const GLOBAL_RATE_WINDOW_MILLISECONDS = GLOBAL_RATE_WINDOW_SECONDS * MILLISECONDS_PER_SECOND;
const IDENTITY_RATE_WINDOW_MILLISECONDS =
  IDENTITY_RATE_WINDOW_MINUTES * SECONDS_PER_MINUTE * MILLISECONDS_PER_SECOND;
const NANOSECONDS_PER_MILLISECOND = 1_000_000;
const FIRST_ITEM_INDEX = 0;
const SECOND_ITEM_INDEX = 1;
const EXPECTED_ERROR_DETAIL_COUNT = 1;
const EXPECTED_SESSION_ROW_COUNT = 1;
const SIGNED_BEARER_SEGMENT_COUNT = 2;
const NO_RETRY_DELAY_MILLISECONDS = 0;
const EMPTY_STRING_LENGTH = 0;
const HTTP_READY = 200;
const HTTP_SERVICE_UNAVAILABLE = 503;
const BEARER_PREFIX = "Bearer ";
const SESSION_TOKEN_PATTERN = /^[A-Za-z0-9]{32}$/u;
const FIXED_SESSION_DELETE_FAULT = "nama test target session deletion fault";
const ADMINISTRATOR = Object.freeze({
  displayName: "Authentication Failures Administrator",
  email: "administrator@authentication-failures.test",
  password: "administrator-password-for-authentication-failures",
});
const UPPERCASE_ADMINISTRATOR_EMAIL = "ADMINISTRATOR@AUTHENTICATION-FAILURES.TEST";
const WRONG_PASSWORD = "wrong-password-for-authentication-failures";
const INVALID_GLOBAL_PASSWORD = "invalid-global-window-password";
const INVALID_GLOBAL_EMAIL = "not-an-email";
const INVALID_SIGN_IN_FIELD_VIOLATIONS = Object.freeze([
  Object.freeze({ description: "has an invalid format", field: "email", reason: "INVALID_FORMAT" }),
]);
const rawSessionTokenFromBearer = (input: { readonly authorization: string }): string => {
  if (!input.authorization.startsWith(BEARER_PREFIX)) {
    throw new Error("expected bearer authorization");
  }
  const segments = input.authorization.slice(BEARER_PREFIX.length).split(".");
  const sessionToken = segments.at(FIRST_ITEM_INDEX);
  const signature = segments.at(SECOND_ITEM_INDEX);
  if (
    sessionToken === undefined ||
    !SESSION_TOKEN_PATTERN.test(sessionToken) ||
    signature === undefined ||
    signature.length === EMPTY_STRING_LENGTH ||
    segments.length !== SIGNED_BEARER_SEGMENT_COUNT
  ) {
    throw new Error("expected a signed bearer token");
  }
  return sessionToken;
};
const retryDelayMillisecondsFrom = (error: ConnectError): number => {
  const retryInfo = error.findDetails(RetryInfoSchema);
  expect(retryInfo).toHaveLength(EXPECTED_ERROR_DETAIL_COUNT);
  const retryDelay = retryInfo.at(FIRST_ITEM_INDEX)?.retryDelay;
  if (retryDelay === undefined) {
    throw new Error("expected RetryInfo retry delay");
  }
  const milliseconds =
    Number(retryDelay.seconds) * MILLISECONDS_PER_SECOND +
    Math.ceil(retryDelay.nanos / NANOSECONDS_PER_MILLISECOND);
  expect(Number.isSafeInteger(milliseconds)).toBe(true);
  return milliseconds;
};
const expectAuthenticationFailure = (input: AuthenticationFailureInput) =>
  expectApplicationFailure({
    ...input,
    expectedCode: Code.Unauthenticated,
    expectedReason: "AUTHENTICATION_FAILED",
  });

const expectRateLimited = (input: RateLimitInput) =>
  Effect.promise(async () => {
    try {
      await input.invoke();
    } catch (error) {
      const applicationError = expectApplicationError({
        error,
        expectedCode: Code.ResourceExhausted,
        expectedReason: "RATE_LIMITED",
      });
      input.publicErrors.push(applicationError);
      const retryDelayMilliseconds = retryDelayMillisecondsFrom(applicationError);
      expect(retryDelayMilliseconds).toBeGreaterThan(NO_RETRY_DELAY_MILLISECONDS);
      expect(retryDelayMilliseconds).toBeLessThanOrEqual(input.retryLimitMilliseconds);
      return;
    }
    throw new Error("expected SignIn to be rate limited");
  });
const expireSessionForBearer = (input: {
  readonly authorization: string;
  readonly databaseUrl: string;
}) =>
  withPool(input.databaseUrl, (observer) =>
    Effect.promise(async () => {
      const result = await observer.query(
        "UPDATE \"session\" SET expires_at = NOW() - INTERVAL '1 second' WHERE token = $1",
        [rawSessionTokenFromBearer({ authorization: input.authorization })],
      );
      expect(result.rowCount).toBe(EXPECTED_SESSION_ROW_COUNT);
    }),
  );

const publicErrorContents = (error: ConnectError): string =>
  JSON.stringify(
    {
      badRequest: error.findDetails(BadRequestSchema),
      errorInfo: error.findDetails(ErrorInfoSchema),
      metadata: [...error.metadata.entries()],
      rawMessage: error.rawMessage,
      requestInfo: error.findDetails(RequestInfoSchema),
      retryInfo: error.findDetails(RetryInfoSchema),
    },
    (_key, value: unknown): unknown => {
      if (typeof value === "bigint") {
        return value.toString();
      }
      return value;
    },
  );

const expectValuesAbsent = (contents: readonly string[], values: readonly string[]): void => {
  for (const value of values) {
    if (value.length !== EMPTY_STRING_LENGTH) {
      for (const content of contents) {
        expect(content).not.toContain(value);
      }
    }
  }
};

const expectSafeProcessOutputs = (input: SensitiveOutputInput): void => {
  const diagnostics = [
    ...input.state.runningProcesses.flatMap((runningProcess) => [
      runningProcess.stderr(),
      structuredLinesFrom(runningProcess).join("\n"),
    ]),
    ...input.state.publicErrors.map((error) => publicErrorContents(error)),
  ];
  expectValuesAbsent(diagnostics, [...input.state.unsafeValues, input.bootstrapToken]);
  const stdout = input.state.runningProcesses.map((runningProcess) => runningProcess.stdout());
  expectValuesAbsent(stdout, input.state.unsafeValues);
};

const createFailureState = (input: { readonly databaseUrl: string }): FailureState => {
  const databaseLocation = new URL(input.databaseUrl);
  return {
    publicErrors: [],
    runningProcesses: [],
    unsafeValues: [
      ADMINISTRATOR.email,
      UPPERCASE_ADMINISTRATOR_EMAIL,
      ADMINISTRATOR.password,
      WRONG_PASSWORD,
      INVALID_GLOBAL_PASSWORD,
      input.databaseUrl,
      databaseLocation.hostname,
      databaseLocation.pathname,
      MASTER_KEY,
      FIXED_SESSION_DELETE_FAULT,
    ],
  };
};
export {
  ADMINISTRATOR,
  GLOBAL_RATE_WINDOW_MILLISECONDS,
  GLOBAL_SIGN_IN_ATTEMPT_COUNT,
  HTTP_READY,
  HTTP_SERVICE_UNAVAILABLE,
  IDENTITY_RATE_WINDOW_MILLISECONDS,
  IDENTITY_SIGN_IN_ATTEMPT_COUNT,
  INVALID_GLOBAL_EMAIL,
  INVALID_GLOBAL_PASSWORD,
  INVALID_SIGN_IN_FIELD_VIOLATIONS,
  UPPERCASE_ADMINISTRATOR_EMAIL,
  WRONG_PASSWORD,
  createFailureState,
  expectAuthenticationFailure,
  expectRateLimited,
  rawSessionTokenFromBearer,
  expectSafeProcessOutputs,
  expireSessionForBearer,
};
export type { AuthenticationFailureInput, FailureState, RateLimitInput, SensitiveOutputInput };
