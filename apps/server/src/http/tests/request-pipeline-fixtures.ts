import { create } from "@bufbuild/protobuf";
import type { DescMessage, DescMethodUnary, MessageShape } from "@bufbuild/protobuf";
import { createContextValues } from "@connectrpc/connect";
import type { ContextValues, Interceptor, UnaryRequest, UnaryResponse } from "@connectrpc/connect";
import { Effect, Option } from "effect";

import type { AuthenticationService } from "../../authentication/authentication-service.ts";
import type { Administrator } from "../../authentication/better-auth-adapter.ts";
import type { SetupCoordinatorService } from "../../authentication/setup-coordinator.ts";
import type { RequestPipelineDependencies } from "../request-pipeline.ts";
import type { RequestRuntime } from "../request-runtime.ts";

const REQUEST_ID = "42d3b87b-7499-4f07-8ed9-e9a1b6bf242f";
const CONNECT_CODE_OK = 0;
const INITIAL_MONOTONIC_TIME = 0;
const TEST_AUTHORIZATION = "Bearer a.b";
const VALID_VALIDATION_RESULT = Object.freeze({ kind: "valid" as const });
const ADMINISTRATOR = Object.freeze({
  displayName: "Administrator",
  email: "administrator@nama.example",
  id: "administrator-1",
}) satisfies Administrator;

const FIRST_INTERCEPTOR_PARAMETER = 0;

type UnaryNext = (request: UnaryRequest) => Promise<UnaryResponse>;
type InterceptorNext = Parameters<Interceptor>[typeof FIRST_INTERCEPTOR_PARAMETER];

const validValidator: RequestPipelineDependencies["requestValidator"] = Object.freeze({
  validate: () => VALID_VALIDATION_RESULT,
});

const NO_LIMIT_RETRY_AFTER_MILLISECONDS = Option.getOrUndefined(Option.none<number>());

const noGlobalSignInLimit = (): Effect.Effect<number | undefined> =>
  Effect.succeed(NO_LIMIT_RETRY_AFTER_MILLISECONDS);

const noIdentitySignInLimit: AuthenticationService["consumeIdentitySignInBudget"] = () =>
  noGlobalSignInLimit();

const makeTestSetupCoordinator = (
  initialized = true,
  trace: string[] = [],
): SetupCoordinatorService =>
  Object.freeze({
    createAdministrator: () => Effect.die(new Error("Unexpected administrator creation.")),
    getStatus: Effect.sync(() => {
      trace.push("state");
      return initialized;
    }),
  });

const makeTestAuthenticationService = (
  overrides: Partial<AuthenticationService> = {},
): AuthenticationService =>
  Object.freeze({
    approveDeviceAuthorization: () => Effect.die(new Error("Unexpected device approval.")),
    consumeGlobalSignInBudget: noGlobalSignInLimit(),
    consumeIdentitySignInBudget: noIdentitySignInLimit,
    resolveAdministrator: () => Effect.die(new Error("Unexpected administrator resolution.")),
    resolveConsumerPrincipal: () => Effect.die(new Error("Unexpected consumer resolution.")),
    resolvePrincipal: () => Effect.die(new Error("Unexpected principal resolution.")),
    revokeAppleClientRefreshTokens: Effect.die(new Error("Unexpected Apple client revocation.")),
    signIn: () => Effect.die(new Error("Unexpected sign-in.")),
    signOut: () => Effect.die(new Error("Unexpected sign-out.")),
    ...overrides,
  });

const runEffect: RequestRuntime["runPromise"] = (effect) => Effect.runPromise(effect);

const makeTestRequestRuntime = (
  runPromise: RequestRuntime["runPromise"] = runEffect,
): RequestRuntime =>
  Object.freeze({
    awaitRequests: Effect.void,
    interruptRequests: Effect.void,
    run: () => NO_LIMIT_RETRY_AFTER_MILLISECONDS,
    runPromise,
  });

const makeDependencies = (
  overrides: Partial<RequestPipelineDependencies> = {},
): RequestPipelineDependencies => ({
  authentication: makeTestAuthenticationService(),
  monotonicNow: () => INITIAL_MONOTONIC_TIME,
  requestRuntime: makeTestRequestRuntime(),
  requestValidator: validValidator,
  setupCoordinator: makeTestSetupCoordinator(),
  terminalLog: () => {},
  ...overrides,
});

const makeRequest = <Input extends DescMessage, Output extends DescMessage>(
  method: DescMethodUnary<Input, Output>,
  message: MessageShape<Input>,
  options: Readonly<{
    contextValues?: ContextValues;
    header?: Headers;
    signal?: AbortSignal;
  }> = {},
): UnaryRequest<Input, Output> => ({
  contextValues: options.contextValues ?? createContextValues(),
  header: options.header ?? new Headers(),
  message,
  method,
  requestMethod: "POST",
  service: method.parent,
  signal: options.signal ?? new AbortController().signal,
  stream: false,
  url: "",
});

const responseFor = <Input extends DescMessage, Output extends DescMessage>(
  request: UnaryRequest<Input, Output>,
): UnaryResponse<Input, Output> => ({
  header: new Headers(),
  message: create(request.method.output),
  method: request.method,
  service: request.service,
  stream: false,
  trailer: new Headers(),
});

const invoke = async (
  interceptor: Interceptor,
  request: UnaryRequest,
  next: UnaryNext = (received) => Promise.resolve(responseFor(received)),
): Promise<UnaryResponse> => {
  const connectNext: InterceptorNext = (received) => {
    if (received.stream) {
      return Promise.reject(new Error("Expected a unary request."));
    }
    return next(received);
  };

  const response = await interceptor(connectNext)(request);
  if (response.stream) {
    throw new Error("Expected a unary response.");
  }
  return response;
};

const bearerHeader = (): Headers => new Headers({ authorization: TEST_AUTHORIZATION });

const withRequestId = <Input extends DescMessage, Output extends DescMessage>(
  method: DescMethodUnary<Input, Output>,
  message: MessageShape<Input>,
  options: Readonly<{
    contextValues?: ContextValues;
    header?: Headers;
    signal?: AbortSignal;
  }> = {},
): UnaryRequest<Input, Output> => {
  const header = options.header ?? new Headers();
  header.set("nama-request-id", REQUEST_ID);
  return makeRequest(method, message, { ...options, header });
};

const traceFailureEffect = <Failure>(trace: string[], event: string, failure: Failure) =>
  Effect.sync(() => {
    trace.push(event);
  }).pipe(Effect.andThen(Effect.fail(failure)));

const succeedEffect = <Value>(value: Value) => Effect.succeed(value);

const traceEffect = <Value>(trace: string[], event: string, value: Value) =>
  Effect.sync(() => {
    trace.push(event);
    return value;
  });

const traceNoLimit = (trace: string[], event: string) =>
  traceEffect(trace, event, NO_LIMIT_RETRY_AFTER_MILLISECONDS);

const makeMonotonicClock = (timestamps: readonly number[]) => {
  const pendingTimestamps = [...timestamps];
  return () => {
    const timestamp = pendingTimestamps.shift();
    if (timestamp === undefined) {
      throw new Error("Unexpected monotonic clock read.");
    }
    return timestamp;
  };
};

export type { UnaryNext };

export {
  ADMINISTRATOR,
  CONNECT_CODE_OK,
  REQUEST_ID,
  bearerHeader,
  invoke,
  makeTestAuthenticationService,
  makeDependencies,
  makeTestRequestRuntime,
  makeMonotonicClock,
  makeTestSetupCoordinator,
  responseFor,
  traceEffect,
  succeedEffect,
  traceFailureEffect,
  traceNoLimit,
  withRequestId,
};
