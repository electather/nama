import { create } from "@bufbuild/protobuf";
import type {
  DescMessage,
  DescMethod,
  DescMethodUnary,
  DescService,
  MessageShape,
} from "@bufbuild/protobuf";
import { createContextValues, createHandlerContext } from "@connectrpc/connect";
import type { ContextValues, HandlerContext, ServiceImpl, UnaryRequest } from "@connectrpc/connect";
import { Effect } from "effect";

import {
  AuthService,
  GetCurrentUserRequestSchema,
  SignInRequestSchema,
  SignOutRequestSchema,
} from "../../../../../gen/ts/src/nama/api/v1/auth_pb.js";
import {
  CreateAdministratorRequestSchema,
  SetupService,
} from "../../../../../gen/ts/src/nama/api/v1/setup_pb.js";
import type { AuthenticationService } from "../../authentication/authentication-service.ts";
import type { SetupCoordinatorService } from "../../authentication/setup-coordinator.ts";
import type { RequestRuntime } from "../request-runtime.ts";
import { createAuthServiceHandlers, createSetupServiceHandlers } from "../rpc-handlers.ts";

const AUTHORIZATION = "Bearer signed-nama-bearer";
const REQUEST_ID = "0b04cc5b-76d0-4234-bb1c-f20c8b4cc758";
const ADMINISTRATOR = Object.freeze({
  displayName: "Nama Administrator",
  email: "administrator@nama.example",
  id: "administrator-1",
});
const ADMINISTRATOR_MESSAGE = Object.freeze({
  displayName: "Nama Administrator",
  email: "administrator@nama.example",
  id: "administrator-1",
});

type HandlerContextInput = Readonly<{
  readonly method: DescMethod;
  readonly requestHeader?: Headers;
  readonly service: DescService;
  readonly signal: AbortSignal;
  readonly values?: ContextValues;
}>;
type UnaryRequestInput<Input extends DescMessage, Output extends DescMessage> = Readonly<{
  readonly contextValues: ContextValues;
  readonly header: Headers;
  readonly message: MessageShape<Input>;
  readonly method: DescMethodUnary<Input, Output>;
  readonly service: DescService;
  readonly signal: AbortSignal;
}>;

const required = <Value>(value: Value | undefined): Value => {
  if (value === undefined) {
    throw new Error("Expected generated RPC handler to be implemented");
  }
  return value;
};

const captureTaggedFailure = async (operation: () => unknown): Promise<object> => {
  try {
    await operation();
  } catch (error: unknown) {
    if (error instanceof Error) {
      throw error;
    }
    if (typeof error === "object" && error !== null) {
      return error;
    }
    throw new TypeError("Expected RPC handler to reject with a tagged object", { cause: error });
  }
  throw new Error("Expected RPC handler to reject");
};

const makeRpcRequestRuntime = (receivedSignals: AbortSignal[]): RequestRuntime => {
  const runPromise: RequestRuntime["runPromise"] = (effect, signal) => {
    if (signal === undefined) {
      throw new Error("Expected every RPC handler to pass its HandlerContext signal");
    }
    receivedSignals.push(signal);
    return Effect.runPromise(effect);
  };
  const requestRuntime: RequestRuntime = {
    awaitRequests: Effect.void,
    interruptRequests: Effect.void,
    run: () => {
      throw new Error("Unexpected RequestRuntime.run invocation");
    },
    runPromise,
  };

  return Object.freeze(requestRuntime);
};

const makeRpcSetupCoordinator = (
  overrides: Partial<SetupCoordinatorService> = {},
): SetupCoordinatorService =>
  Object.freeze({
    createAdministrator: () => Effect.die("Unexpected administrator creation"),
    getStatus: Effect.succeed(false),
    ...overrides,
  });

const makeRpcAuthenticationService = (
  overrides: Partial<AuthenticationService> = {},
): AuthenticationService =>
  Object.freeze({
    consumeGlobalSignInBudget: Effect.die("Unexpected global sign-in limit check"),
    consumeIdentitySignInBudget: () => Effect.die("Unexpected identity sign-in limit check"),
    resolveAdministrator: () => Effect.die("Unexpected administrator lookup"),
    signIn: () => Effect.die("Unexpected sign-in"),
    signOut: () => Effect.die("Unexpected sign-out"),
    ...overrides,
  });

const makeHandlerContext = ({
  method,
  requestHeader = new Headers(),
  service,
  signal,
  values = createContextValues(),
}: HandlerContextInput): HandlerContext =>
  createHandlerContext({
    contextValues: values,
    method,
    protocolName: "connect",
    requestHeader,
    requestMethod: "POST",
    requestSignal: signal,
    service,
    url: "https://nama.example/rpc",
  });

const makeUnaryRequest = <Input extends DescMessage, Output extends DescMessage>({
  contextValues,
  header,
  message,
  method,
  service,
  signal,
}: UnaryRequestInput<Input, Output>): UnaryRequest<Input, Output> => ({
  contextValues,
  header,
  message,
  method,
  requestMethod: "POST",
  service,
  signal,
  stream: false,
  url: "https://nama.example/rpc",
});

type TaggedFailureFixtureInput = Readonly<{
  readonly createAdministrator: Readonly<{
    readonly bootstrapToken: string;
    readonly displayName: string;
    readonly email: string;
    readonly password: string;
  }>;
  readonly signIn: Readonly<{
    readonly email: string;
    readonly password: string;
  }>;
}>;

type TaggedFailureOperationInput = Readonly<{
  readonly authHandlers: Partial<ServiceImpl<typeof AuthService>>;
  readonly createAdministratorInput: TaggedFailureFixtureInput["createAdministrator"];
  readonly setupHandlers: Partial<ServiceImpl<typeof SetupService>>;
  readonly signInInput: TaggedFailureFixtureInput["signIn"];
}>;

const makeTaggedFailureOperations = ({
  authHandlers,
  createAdministratorInput,
  setupHandlers,
  signInInput,
}: TaggedFailureOperationInput) =>
  Object.freeze({
    setup: () =>
      required(setupHandlers.createAdministrator)(
        create(CreateAdministratorRequestSchema, createAdministratorInput),
        makeHandlerContext({
          method: SetupService.method.createAdministrator,
          service: SetupService,
          signal: new AbortController().signal,
        }),
      ),
    signIn: () =>
      required(authHandlers.signIn)(
        create(SignInRequestSchema, signInInput),
        makeHandlerContext({
          method: AuthService.method.signIn,
          service: AuthService,
          signal: new AbortController().signal,
        }),
      ),
    signOut: () =>
      required(authHandlers.signOut)(
        create(SignOutRequestSchema),
        makeHandlerContext({
          method: AuthService.method.signOut,
          requestHeader: new Headers({ authorization: AUTHORIZATION }),
          service: AuthService,
          signal: new AbortController().signal,
        }),
      ),
  });

const makeTaggedFailureFixture = ({
  createAdministrator: createAdministratorInput,
  signIn: signInInput,
}: TaggedFailureFixtureInput) => {
  const failures = Object.freeze({
    setup: Object.freeze({ _tag: "SetupAlreadyInitialized" as const }),
    signIn: Object.freeze({ _tag: "AuthenticationStoreUnavailable" as const }),
    signOut: Object.freeze({ _tag: "SessionRevocationUnconfirmed" as const }),
  });
  const setupHandlers: Partial<ServiceImpl<typeof SetupService>> = createSetupServiceHandlers({
    requestRuntime: makeRpcRequestRuntime([]),
    setupCoordinator: makeRpcSetupCoordinator({
      createAdministrator: () => Effect.fail(failures.setup),
    }),
  });
  const authHandlers: Partial<ServiceImpl<typeof AuthService>> = createAuthServiceHandlers({
    authentication: makeRpcAuthenticationService({
      signIn: () => Effect.fail(failures.signIn),
      signOut: () => Effect.fail(failures.signOut),
    }),
    requestRuntime: makeRpcRequestRuntime([]),
  });
  const operations = makeTaggedFailureOperations({
    authHandlers,
    createAdministratorInput,
    setupHandlers,
    signInInput,
  });

  return Object.freeze({ failures, ...operations });
};

const makeMissingContextFixture = () => {
  const handlers: Partial<ServiceImpl<typeof AuthService>> = createAuthServiceHandlers({
    authentication: makeRpcAuthenticationService(),
    requestRuntime: makeRpcRequestRuntime([]),
  });

  return Object.freeze({
    getCurrentUser: () =>
      required(handlers.getCurrentUser)(
        create(GetCurrentUserRequestSchema),
        makeHandlerContext({
          method: AuthService.method.getCurrentUser,
          service: AuthService,
          signal: new AbortController().signal,
        }),
      ),
    signOut: () =>
      required(handlers.signOut)(
        create(SignOutRequestSchema),
        makeHandlerContext({
          method: AuthService.method.signOut,
          service: AuthService,
          signal: new AbortController().signal,
        }),
      ),
  });
};

export {
  ADMINISTRATOR,
  ADMINISTRATOR_MESSAGE,
  AUTHORIZATION,
  REQUEST_ID,
  captureTaggedFailure,
  makeRpcAuthenticationService,
  makeHandlerContext,
  makeRpcRequestRuntime,
  makeRpcSetupCoordinator,
  makeMissingContextFixture,
  makeTaggedFailureFixture,
  makeUnaryRequest,
  required,
};

export type { HandlerContextInput, TaggedFailureFixtureInput, UnaryRequestInput };
