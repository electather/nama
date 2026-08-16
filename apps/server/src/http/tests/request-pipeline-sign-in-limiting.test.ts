import { create } from "@bufbuild/protobuf";
import { Code } from "@connectrpc/connect";
import type { UnaryResponse } from "@connectrpc/connect";
import { expect, test } from "vitest";

import { AuthService, SignInRequestSchema } from "../../../../../gen/ts/src/nama/api/v1/auth_pb.js";
import { createRequestPipeline } from "../request-pipeline.ts";
import type { RequestPipelineDependencies } from "../request-pipeline.ts";
import { expectApplicationError, expectRetryAfter } from "./request-pipeline-assertions.ts";
import {
  invoke,
  makeTestAuthenticationService,
  makeDependencies,
  makeTestSetupCoordinator,
  responseFor,
  traceEffect,
  traceNoLimit,
  withRequestId,
} from "./request-pipeline-fixtures.ts";

const SIGN_IN_EMAIL = "ADMINISTRATOR@NAMA.EXAMPLE";
const SIGN_IN_PASSWORD = "12345678";
const RETRY_AFTER_MILLISECONDS = 1234;
const RETRY_AFTER_SECONDS = 1n;
const RETRY_AFTER_NANOS = 234_000_000;
const IDENTITY_RETRY_DELAY_MILLISECONDS = 456;
const IDENTITY_RETRY_DELAY_SECONDS = 0n;
const IDENTITY_RETRY_DELAY_NANOS = 456_000_000;

const INVOKE_NEXT_PARAMETER = 2;
const SIGN_IN_MESSAGE = create(SignInRequestSchema, {
  email: SIGN_IN_EMAIL,
  password: SIGN_IN_PASSWORD,
});
const SIGN_IN_REQUEST = withRequestId(AuthService.method.signIn, SIGN_IN_MESSAGE);

type RequestHandler = Exclude<Parameters<typeof invoke>[typeof INVOKE_NEXT_PARAMETER], undefined>;

const makeSignInPipeline = (trace: string[], overrides: Partial<RequestPipelineDependencies>) => {
  const setupCoordinator = makeTestSetupCoordinator(true, trace);
  const dependencies = makeDependencies({ ...overrides, setupCoordinator });
  return createRequestPipeline(dependencies);
};

const validSignInValidator = (trace: string[]) => ({
  validate: () => {
    trace.push("validate");
    return { kind: "valid" as const };
  },
});

const recordDispatch =
  (trace: string[]): RequestHandler =>
  (received) => {
    trace.push("next");
    const response = responseFor(received);
    return Promise.resolve(response);
  };

type InvocationResponse = UnaryResponse;

type NormalizedSignInSuccess = Readonly<{
  expectedResponse: InvocationResponse;
  identityInputsAreNormalized: readonly boolean[];
  response: InvocationResponse;
  trace: readonly string[];
}>;

const expectNormalizedSignInSuccess = ({
  expectedResponse,
  identityInputsAreNormalized,
  response,
  trace,
}: NormalizedSignInSuccess): void => {
  expect(response).toBe(expectedResponse);
  expect(identityInputsAreNormalized).toStrictEqual([true]);
  expect(trace).toStrictEqual(["state", "global", "validate", "identity", "next"]);
};

test("spends the global SignIn budget before validation and returns its exact retry delay", async () => {
  const trace: string[] = [];
  const authentication = makeTestAuthenticationService({
    consumeGlobalSignInBudget: traceEffect(trace, "global", RETRY_AFTER_MILLISECONDS),
  });
  const requestValidator = validSignInValidator(trace);
  const interceptor = makeSignInPipeline(trace, { authentication, requestValidator });
  const promise = invoke(interceptor, SIGN_IN_REQUEST, recordDispatch(trace));
  const error = await expectApplicationError({
    code: Code.ResourceExhausted,
    promise,
    reason: "RATE_LIMITED",
  });

  expectRetryAfter(error, RETRY_AFTER_SECONDS, RETRY_AFTER_NANOS);
  expect(trace).toStrictEqual(["state", "global"]);
});

test("uses the normalized identity budget only after valid SignIn validation and passes through success", async () => {
  const trace: string[] = [];
  const expectedNormalizedEmail = SIGN_IN_REQUEST.message.email.toLowerCase();
  const identityInputsAreNormalized: boolean[] = [];
  const authentication = makeTestAuthenticationService({
    consumeGlobalSignInBudget: traceNoLimit(trace, "global"),
    consumeIdentitySignInBudget: (validatedEmail) => {
      identityInputsAreNormalized.push(validatedEmail === expectedNormalizedEmail);
      return traceNoLimit(trace, "identity");
    },
  });
  const expectedResponse = responseFor(SIGN_IN_REQUEST);
  const requestValidator = validSignInValidator(trace);
  const interceptor = makeSignInPipeline(trace, { authentication, requestValidator });
  const response = await invoke(interceptor, SIGN_IN_REQUEST, () => {
    trace.push("next");
    return Promise.resolve(expectedResponse);
  });

  expectNormalizedSignInSuccess({
    expectedResponse,
    identityInputsAreNormalized,
    response,
    trace,
  });
});

test("uses the identity SignIn budget retry delay after successful validation", async () => {
  const trace: string[] = [];
  const authentication = makeTestAuthenticationService({
    consumeIdentitySignInBudget: () =>
      traceEffect(trace, "identity", IDENTITY_RETRY_DELAY_MILLISECONDS),
  });
  const interceptor = makeSignInPipeline(trace, { authentication });
  const promise = invoke(interceptor, SIGN_IN_REQUEST);
  const error = await expectApplicationError({
    code: Code.ResourceExhausted,
    promise,
    reason: "RATE_LIMITED",
  });

  expectRetryAfter(error, IDENTITY_RETRY_DELAY_SECONDS, IDENTITY_RETRY_DELAY_NANOS);
  expect(trace).toStrictEqual(["state", "identity"]);
});
