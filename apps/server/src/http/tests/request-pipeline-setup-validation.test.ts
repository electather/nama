import { create } from "@bufbuild/protobuf";
import { Code } from "@connectrpc/connect";
import { expect, test } from "vitest";

import { AuthService, SignInRequestSchema } from "../../../../../gen/ts/src/nama/api/v1/auth_pb.js";
import { DeviceService } from "../../../../../gen/ts/src/nama/api/v1/device_pb.js";
import { SetupService } from "../../../../../gen/ts/src/nama/api/v1/setup_pb.js";
import { createRequestPipeline } from "../request-pipeline.ts";
import type { RequestPipelineDependencies } from "../request-pipeline.ts";
import {
  expectApplicationError,
  expectValidationFieldViolation,
} from "./request-pipeline-assertions.ts";
import {
  ADMINISTRATOR,
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
const VALIDATION_DESCRIPTION = "Enter a valid value.";
const VALIDATION_FIELD = "email";
const VALIDATION_REASON = "INVALID_FORMAT";

const CREATE_ADMINISTRATOR_REQUEST = withRequestId(
  SetupService.method.createAdministrator,
  create(SetupService.method.createAdministrator.input),
);
const SIGN_IN_REQUEST = withRequestId(
  AuthService.method.signIn,
  create(SignInRequestSchema, { email: SIGN_IN_EMAIL, password: SIGN_IN_PASSWORD }),
);
const BEGIN_PAIRING_REQUEST = withRequestId(
  DeviceService.method.beginPairing,
  create(DeviceService.method.beginPairing.input),
);

const INVOKE_NEXT_PARAMETER = 2;

type RequestHandler = Exclude<Parameters<typeof invoke>[typeof INVOKE_NEXT_PARAMETER], undefined>;

const createPipeline = (overrides: Partial<RequestPipelineDependencies>) => {
  const dependencies = makeDependencies(overrides);
  return createRequestPipeline(dependencies);
};

const makeValidRequestValidator = (trace: string[]) => ({
  validate: () => {
    trace.push("validate");
    return { kind: "valid" as const };
  },
});

const recordDispatch =
  (trace: string[], event = "next"): RequestHandler =>
  (received) => {
    trace.push(event);
    const response = responseFor(received);
    return Promise.resolve(response);
  };

const makePublicPipeline = (trace: string[], initialized: boolean) => {
  const authentication = makeTestAuthenticationService({
    consumeGlobalSignInBudget: traceNoLimit(trace, "global"),
    consumeIdentitySignInBudget: () => traceNoLimit(trace, "identity"),
    resolveAdministrator: () => traceEffect(trace, "resolve", ADMINISTRATOR),
  });
  const requestValidator = makeValidRequestValidator(trace);
  const setupCoordinator = makeTestSetupCoordinator(initialized, trace);
  return createPipeline({ authentication, requestValidator, setupCoordinator });
};

test("applies configured and setup-eligible state gates before downstream pipeline work", async () => {
  const trace: string[] = [];
  const authentication = makeTestAuthenticationService({
    consumeGlobalSignInBudget: traceNoLimit(trace, "global"),
  });
  const requestValidator = makeValidRequestValidator(trace);
  const setupGateCases = [
    [true, CREATE_ADMINISTRATOR_REQUEST, "ALREADY_INITIALIZED"],
    [false, SIGN_IN_REQUEST, "NOT_INITIALIZED"],
    [false, BEGIN_PAIRING_REQUEST, "NOT_INITIALIZED"],
  ] as const;
  const setupGateChecks = setupGateCases.map(([initialized, request, reason]) => {
    const setupCoordinator = makeTestSetupCoordinator(initialized, trace);
    const interceptor = createPipeline({
      authentication,
      requestValidator,
      setupCoordinator,
    });
    const promise = invoke(interceptor, request, recordDispatch(trace));
    return expectApplicationError({ code: Code.FailedPrecondition, promise, reason });
  });

  await Promise.all(setupGateChecks);
  expect(trace).toStrictEqual(["state", "state", "state"]);
});

test("keeps public SignIn and bootstrap CreateAdministrator outside administrator bearer lookup", async () => {
  const signInTrace: string[] = [];
  const bootstrapTrace: string[] = [];
  const signInPipeline = makePublicPipeline(signInTrace, true);
  const bootstrapPipeline = makePublicPipeline(bootstrapTrace, false);
  const publicInvocations = [
    invoke(signInPipeline, SIGN_IN_REQUEST, recordDispatch(signInTrace)),
    invoke(bootstrapPipeline, CREATE_ADMINISTRATOR_REQUEST, recordDispatch(bootstrapTrace)),
  ];

  await Promise.all(publicInvocations);
  expect(signInTrace).toStrictEqual(["state", "global", "validate", "identity", "next"]);
  expect(bootstrapTrace).toStrictEqual(["state", "validate", "next"]);
});

test("allows GetStatus to reach its handler in either process setup state", async () => {
  const trace: string[] = [];
  const getStatus = withRequestId(
    SetupService.method.getStatus,
    create(SetupService.method.getStatus.input),
  );
  const configuredSetupCoordinator = makeTestSetupCoordinator(true, trace);
  const eligibleSetupCoordinator = makeTestSetupCoordinator(false, trace);
  const configuredPipeline = createPipeline({
    setupCoordinator: configuredSetupCoordinator,
  });
  const eligiblePipeline = createPipeline({
    setupCoordinator: eligibleSetupCoordinator,
  });

  await Promise.all([
    invoke(configuredPipeline, getStatus, recordDispatch(trace, "configured-handler")),
    invoke(eligiblePipeline, getStatus, recordDispatch(trace, "eligible-handler")),
  ]);
  expect(trace).toEqual(expect.arrayContaining(["configured-handler", "eligible-handler"]));
});

test("returns validation details after the global SignIn budget without spending identity budget", async () => {
  const trace: string[] = [];
  const authentication = makeTestAuthenticationService({
    consumeGlobalSignInBudget: traceNoLimit(trace, "global"),
    consumeIdentitySignInBudget: () => traceNoLimit(trace, "identity"),
  });
  const requestValidator = {
    validate: () => {
      trace.push("validate");
      return {
        fieldErrors: [
          {
            description: VALIDATION_DESCRIPTION,
            field: VALIDATION_FIELD,
            reason: VALIDATION_REASON,
          },
        ],
        kind: "invalid" as const,
      };
    },
  };
  const setupCoordinator = makeTestSetupCoordinator(true, trace);
  const interceptor = createPipeline({
    authentication,
    requestValidator,
    setupCoordinator,
  });
  const promise = invoke(interceptor, SIGN_IN_REQUEST);
  const error = await expectApplicationError({
    code: Code.InvalidArgument,
    promise,
    reason: "VALIDATION_FAILED",
  });

  expectValidationFieldViolation(error, {
    description: VALIDATION_DESCRIPTION,
    field: VALIDATION_FIELD,
    reason: VALIDATION_REASON,
  });
  expect(trace).toStrictEqual(["state", "global", "validate"]);
});
