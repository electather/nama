import { create } from "@bufbuild/protobuf";
import { createContextValues } from "@connectrpc/connect";
import type { HandlerContext, Interceptor, ServiceImpl, UnaryRequest } from "@connectrpc/connect";
import { Effect } from "effect";
import { expect, test } from "vitest";

import {
  AuthService,
  GetCurrentUserRequestSchema,
  GetCurrentUserResponseSchema,
  SignInRequestSchema,
  SignOutRequestSchema,
} from "../../../../../gen/ts/src/nama/api/v1/auth_pb.js";
import type { AuthenticationService } from "../../authentication/authentication-service.ts";
import { createRequestPipeline } from "../request-pipeline.ts";
import { createAuthServiceHandlers } from "../rpc-handlers.ts";
import {
  ADMINISTRATOR,
  ADMINISTRATOR_MESSAGE,
  AUTHORIZATION,
  REQUEST_ID,
  captureTaggedFailure,
  makeRpcAuthenticationService,
  makeHandlerContext,
  makeMissingContextFixture,
  makeRpcRequestRuntime,
  makeRpcSetupCoordinator,
  makeUnaryRequest,
  makeTaggedFailureFixture,
  required,
} from "./rpc-handlers.test-support.ts";

const SIGN_IN_INPUT = Object.freeze({
  email: "administrator@nama.example",
  password: "correct horse battery staple",
});
const CREATE_ADMINISTRATOR_INPUT = Object.freeze({
  bootstrapToken: "bootstrap-token",
  displayName: "Nama Administrator",
  email: SIGN_IN_INPUT.email,
  password: SIGN_IN_INPUT.password,
});
const SIGNED_BEARER = "signed-nama-bearer";
const SESSION_EXPIRY_MILLISECONDS = 1_700_000_000_123;
const SESSION_EXPIRY_SECONDS = 1_700_000_000n;
const SESSION_EXPIRY_NANOS = 123_000_000;
const NO_ELAPSED_MILLISECONDS = 0;
const INITIALIZED_STATUS = true;
const FIRST_LOOKUP_COUNT = 0;
const EXPECTED_LOOKUP_COUNT = 1;
const SIGN_OUT_NOT_CONFIRMED = false;
const SIGN_OUT_CONFIRMED = true;

interface CurrentUserTracker {
  readonly handlerResponses: unknown[];
  readonly handlerSignals: AbortSignal[];
  lookupCount: number;
  readonly terminalRecords: unknown[];
}

interface SignOutTracker {
  confirmed: boolean;
  readonly receivedAuthorizations: string[];
  readonly receivedSignals: AbortSignal[];
}
type CurrentUserInvocationInput = Readonly<{
  readonly context: HandlerContext;
  readonly getCurrentUser: Exclude<ServiceImpl<typeof AuthService>["getCurrentUser"], undefined>;
  readonly pipeline: Interceptor;
  readonly request: UnaryRequest<
    typeof GetCurrentUserRequestSchema,
    typeof GetCurrentUserResponseSchema
  >;
  readonly tracker: CurrentUserTracker;
}>;
type CurrentUserPipelineInput = Readonly<{
  readonly authentication: AuthenticationService;
  readonly tracker: CurrentUserTracker;
}>;
const makeSignInFixture = () => {
  const receivedInputs: unknown[] = [];
  const receivedSignals: AbortSignal[] = [];
  const handlers: Partial<ServiceImpl<typeof AuthService>> = createAuthServiceHandlers({
    authentication: makeRpcAuthenticationService({
      signIn: (input) =>
        Effect.sync(() => {
          receivedInputs.push(input);
          return {
            administrator: ADMINISTRATOR,
            bearer: SIGNED_BEARER,
            sessionExpiresAt: new Date(SESSION_EXPIRY_MILLISECONDS),
          };
        }),
    }),
    requestRuntime: makeRpcRequestRuntime(receivedSignals),
  });
  const context = makeHandlerContext({
    method: AuthService.method.signIn,
    service: AuthService,
    signal: new AbortController().signal,
  });

  return Object.freeze({
    context,
    receivedInputs,
    receivedSignals,
    request: create(SignInRequestSchema, SIGN_IN_INPUT),
    signIn: required(handlers.signIn),
  });
};

const makeCurrentUserPipeline = ({ authentication, tracker }: CurrentUserPipelineInput) =>
  createRequestPipeline({
    authentication,
    monotonicNow: () => NO_ELAPSED_MILLISECONDS,
    requestRuntime: makeRpcRequestRuntime([]),
    requestValidator: { validate: () => ({ kind: "valid" }) },
    setupCoordinator: makeRpcSetupCoordinator({ getStatus: Effect.succeed(INITIALIZED_STATUS) }),
    terminalLog: (record) => {
      tracker.terminalRecords.push(record);
    },
  });

const makeCurrentUserInvoker =
  ({ context, getCurrentUser, pipeline, request, tracker }: CurrentUserInvocationInput) =>
  async (): Promise<void> => {
    const response = await pipeline(async (received) => {
      if (received.stream) {
        throw new Error("Expected GetCurrentUser interceptor dispatch to remain unary");
      }
      const handlerResponse = await getCurrentUser(request.message, context);
      tracker.handlerResponses.push(handlerResponse);
      return {
        header: new Headers(),
        message: create(GetCurrentUserResponseSchema),
        method: request.method,
        service: request.service,
        stream: false,
        trailer: new Headers(),
      };
    })(request);
    if (response.stream) {
      throw new Error("Expected GetCurrentUser interceptor response to remain unary");
    }
  };

const makeCurrentUserFixture = () => {
  const tracker: CurrentUserTracker = {
    handlerResponses: [],
    handlerSignals: [],
    lookupCount: FIRST_LOOKUP_COUNT,
    terminalRecords: [],
  };
  const authentication = makeRpcAuthenticationService({
    resolveAdministrator: (authorization) =>
      Effect.suspend(() => {
        if (authorization !== AUTHORIZATION || tracker.lookupCount !== FIRST_LOOKUP_COUNT) {
          return Effect.die("Handler must read the interceptor context");
        }
        tracker.lookupCount = EXPECTED_LOOKUP_COUNT;
        return Effect.succeed(ADMINISTRATOR);
      }),
  });
  const handlers: Partial<ServiceImpl<typeof AuthService>> = createAuthServiceHandlers({
    authentication,
    requestRuntime: makeRpcRequestRuntime(tracker.handlerSignals),
  });
  const values = createContextValues();
  const context = makeHandlerContext({
    method: AuthService.method.getCurrentUser,
    requestHeader: new Headers({ authorization: AUTHORIZATION }),
    service: AuthService,
    signal: new AbortController().signal,
    values,
  });
  const request = makeUnaryRequest({
    contextValues: values,
    header: new Headers({ authorization: AUTHORIZATION, "nama-request-id": REQUEST_ID }),
    message: create(GetCurrentUserRequestSchema),
    method: AuthService.method.getCurrentUser,
    service: AuthService,
    signal: new AbortController().signal,
  });
  const pipeline = makeCurrentUserPipeline({ authentication, tracker });
  const invoke = makeCurrentUserInvoker({
    context,
    getCurrentUser: required(handlers.getCurrentUser),
    pipeline,
    request,
    tracker,
  });

  return Object.freeze({ context, invoke, request, tracker });
};

const makeSignOutFixture = () => {
  const tracker: SignOutTracker = {
    confirmed: SIGN_OUT_NOT_CONFIRMED,
    receivedAuthorizations: [],
    receivedSignals: [],
  };
  const handlers: Partial<ServiceImpl<typeof AuthService>> = createAuthServiceHandlers({
    authentication: makeRpcAuthenticationService({
      signOut: (authorization) =>
        Effect.sync(() => {
          tracker.confirmed = SIGN_OUT_CONFIRMED;
          tracker.receivedAuthorizations.push(authorization);
        }),
    }),
    requestRuntime: makeRpcRequestRuntime(tracker.receivedSignals),
  });
  const context = makeHandlerContext({
    method: AuthService.method.signOut,
    requestHeader: new Headers({ authorization: AUTHORIZATION }),
    service: AuthService,
    signal: new AbortController().signal,
  });

  return Object.freeze({
    context,
    request: create(SignOutRequestSchema),
    signOut: required(handlers.signOut),
    tracker,
  });
};

test("maps signed-in administrator, bearer, and exact protobuf expiry through the request runtime", async () => {
  const fixture = makeSignInFixture();
  const response = await fixture.signIn(fixture.request, fixture.context);
  const { credential } = response;
  if (credential === undefined || credential.expiresAt === undefined) {
    throw new Error("Expected SignIn to return a bearer credential with an expiry");
  }
  const expiry = credential.expiresAt;

  expect(fixture.receivedInputs).toStrictEqual([SIGN_IN_INPUT]);
  expect(response.administrator).toStrictEqual(ADMINISTRATOR_MESSAGE);
  expect([credential.token, expiry.nanos, expiry.seconds]).toStrictEqual([
    SIGNED_BEARER,
    SESSION_EXPIRY_NANOS,
    SESSION_EXPIRY_SECONDS,
  ]);
  expect(fixture.receivedSignals).toStrictEqual([fixture.context.signal]);
});

test("returns the interceptor-established administrator without a second authentication lookup", async () => {
  const fixture = makeCurrentUserFixture();
  await fixture.invoke();

  expect(fixture.tracker.handlerResponses).toStrictEqual([
    { administrator: ADMINISTRATOR_MESSAGE },
  ]);
  expect(fixture.tracker.lookupCount).toBe(EXPECTED_LOOKUP_COUNT);
  expect(fixture.tracker.handlerSignals).toStrictEqual([fixture.context.signal]);
  expect(fixture.tracker.terminalRecords).toStrictEqual([
    expect.objectContaining({ event: "rpc.completed", requestId: REQUEST_ID }),
  ]);
});

test("forwards the presented Authorization value and waits for confirmed sign-out", async () => {
  const fixture = makeSignOutFixture();
  const response = await fixture.signOut(fixture.request, fixture.context);

  expect(fixture.tracker.confirmed).toBe(SIGN_OUT_CONFIRMED);
  expect(fixture.tracker.receivedAuthorizations).toStrictEqual([AUTHORIZATION]);
  expect(response).toStrictEqual({});
  expect(fixture.tracker.receivedSignals).toStrictEqual([fixture.context.signal]);
});

test("lets tagged setup and authentication service failures reject unchanged", async () => {
  const fixture = makeTaggedFailureFixture({
    createAdministrator: CREATE_ADMINISTRATOR_INPUT,
    signIn: SIGN_IN_INPUT,
  });
  const setupFailure = await captureTaggedFailure(fixture.setup);
  const signInFailure = await captureTaggedFailure(fixture.signIn);
  const signOutFailure = await captureTaggedFailure(fixture.signOut);

  expect(setupFailure).toBe(fixture.failures.setup);
  expect(signInFailure).toBe(fixture.failures.signIn);
  expect(signOutFailure).toBe(fixture.failures.signOut);
});

test("fails missing request-local administrator or Authorization state with one safe tagged failure", async () => {
  const fixture = makeMissingContextFixture();
  const missingAdministrator = await captureTaggedFailure(fixture.getCurrentUser);
  const missingAuthorization = await captureTaggedFailure(fixture.signOut);

  expect(missingAdministrator).toBe(missingAuthorization);
  expect(missingAdministrator).toStrictEqual({ _tag: "PrivateAuthenticationDefect" });
});
