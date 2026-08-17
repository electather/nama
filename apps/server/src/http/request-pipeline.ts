import { createContextKey } from "@connectrpc/connect";
import type {
  Code,
  ContextValues,
  Interceptor,
  StreamRequest,
  StreamResponse,
  UnaryRequest,
  UnaryResponse,
} from "@connectrpc/connect";
import { Effect } from "effect";

import type { AuthenticationService } from "../authentication/authentication-service.ts";
import type { Administrator } from "../authentication/better-auth-adapter.ts";
import type { SetupCoordinatorService } from "../authentication/setup-coordinator.ts";
import { contractAuthorityByMethod } from "../contracts/authorization.ts";
import type { RequestValidator } from "../contracts/request-validation.ts";
import {
  consumeGlobalSignInBudget,
  consumeIdentitySignInBudget,
  invokeHandler,
  normalizeRequestFailure,
  requestPipelineInternalFailure,
  SIGN_IN_METHOD,
  validateRequest,
} from "./request-pipeline-failures.ts";
import type { RequestRuntime } from "./request-runtime.ts";

const REQUEST_ID_HEADER = "nama-request-id";
const CREATE_ADMINISTRATOR_METHOD = "nama.api.v1.SetupService.CreateAdministrator";
const BEGIN_PAIRING_METHOD = "nama.api.v1.DeviceService.BeginPairing";
const CONNECT_CODE_OK = 0;
const EMPTY_REQUEST_ID_LENGTH = CONNECT_CODE_OK;
const MINIMUM_DURATION_MILLISECONDS = CONNECT_CODE_OK;

const requestIdContextKey = createContextKey<string | undefined>(undefined, {
  description: "nama request id",
});
const requestAdministratorContextKey = createContextKey<Administrator | undefined>(undefined, {
  description: "nama request administrator",
});

const contractAuthorities: Readonly<
  Record<string, (typeof contractAuthorityByMethod)[keyof typeof contractAuthorityByMethod]>
> = contractAuthorityByMethod;

type TerminalRpcCode = Code | typeof CONNECT_CODE_OK;
type InterceptorRequest = UnaryRequest | StreamRequest;
type InterceptorResponse = UnaryResponse | StreamResponse;
type RequestNext = (request: InterceptorRequest) => Promise<InterceptorResponse>;
type SetupGateFailure = Readonly<{ readonly _tag: "NotInitialized" | "SetupAlreadyInitialized" }>;
type RequestExecutionDependencies = Readonly<{
  readonly authentication: AuthenticationService;
  readonly requestValidator: RequestValidator;
  readonly setupCoordinator: SetupCoordinatorService;
}>;
type RequestEffectInput = Readonly<{
  readonly dependencies: RequestExecutionDependencies;
  readonly method: string;
  readonly next: RequestNext;
  readonly request: InterceptorRequest;
  readonly requestId: string;
}>;
type TerminalRpcRecord = Readonly<{
  readonly code: TerminalRpcCode;
  readonly durationMs: number;
  readonly event: "rpc.completed";
  readonly method: string;
  readonly requestId: string;
}>;
type TerminalLogInput = Readonly<{
  readonly code: TerminalRpcCode;
  readonly method: string;
  readonly monotonicNow: () => number;
  readonly requestId: string;
  readonly startedAt: number;
  readonly terminalLog: (record: TerminalRpcRecord) => void | Promise<void>;
}>;
type RequestExecutionState = Readonly<{
  readonly method: string;
  readonly requestId: string;
  readonly signal: AbortSignal;
  readonly startedAt: number;
}>;

interface RequestPipelineDependencies {
  readonly authentication: AuthenticationService;
  readonly monotonicNow: () => number;
  readonly requestRuntime: RequestRuntime;
  readonly requestValidator: RequestValidator;
  readonly setupCoordinator: SetupCoordinatorService;
  readonly terminalLog: (record: TerminalRpcRecord) => void | Promise<void>;
}

const getRequestId = (contextValues: ContextValues): string | undefined =>
  contextValues.get(requestIdContextKey);

const getRequestAdministrator = (contextValues: ContextValues): Administrator | undefined =>
  contextValues.get(requestAdministratorContextKey);

const ensureSetupState = (
  setupCoordinator: SetupCoordinatorService,
  expectedInitialized: boolean,
  failure: SetupGateFailure,
): Effect.Effect<void, unknown> =>
  Effect.gen(function* ensureSetupStateEffect() {
    const initialized = yield* setupCoordinator.getStatus;
    if (initialized !== expectedInitialized) {
      yield* Effect.fail(failure);
    }
  });

const applySetupGate = (
  setupCoordinator: SetupCoordinatorService,
  method: string,
): Effect.Effect<void, unknown> => {
  if (method === CREATE_ADMINISTRATOR_METHOD) {
    return ensureSetupState(setupCoordinator, false, { _tag: "SetupAlreadyInitialized" });
  }
  if (method === SIGN_IN_METHOD || method === BEGIN_PAIRING_METHOD) {
    return ensureSetupState(setupCoordinator, true, { _tag: "NotInitialized" });
  }
  return Effect.void;
};

const resolveRequestAdministrator = (
  authentication: AuthenticationService,
  request: UnaryRequest,
): Effect.Effect<void, unknown> =>
  Effect.gen(function* resolveRequestAdministratorEffect() {
    const authorization = request.header.get("authorization");
    if (authorization === null) {
      yield* Effect.fail({ _tag: "InvalidBearer" as const });
    } else {
      const administrator = yield* authentication.resolveAdministrator(authorization);
      request.contextValues.set(requestAdministratorContextKey, administrator);
    }
  });

const authorizeRequest = (
  authentication: AuthenticationService,
  request: UnaryRequest,
  method: string,
): Effect.Effect<void, unknown> => {
  const authority = contractAuthorities[method];
  if (authority === "public" || authority === "bootstrap-token") {
    return Effect.void;
  }
  if (authority === "administrator" || authority === "administrator-or-device") {
    return resolveRequestAdministrator(authentication, request);
  }
  if (authority === "polling-token" || authority === "plugin-bearer") {
    return Effect.fail({ _tag: "PermissionDenied" as const });
  }
  return Effect.fail({ _tag: "MissingAuthorityInventory" as const });
};

const createRequestEffect = ({
  dependencies,
  method,
  next,
  request,
  requestId,
}: RequestEffectInput): Effect.Effect<InterceptorResponse, unknown> =>
  Effect.gen(function* requestPipelineEffect() {
    const hasRequestId = yield* Effect.sync(() => {
      if (requestId.length === EMPTY_REQUEST_ID_LENGTH) {
        return false;
      }
      request.contextValues.set(requestIdContextKey, requestId);
      return true;
    });
    if (!hasRequestId || request.stream) {
      return yield* Effect.fail(requestPipelineInternalFailure);
    }
    yield* applySetupGate(dependencies.setupCoordinator, method);
    yield* consumeGlobalSignInBudget(dependencies.authentication, method);
    yield* authorizeRequest(dependencies.authentication, request, method);
    yield* validateRequest(dependencies.requestValidator, request);
    yield* consumeIdentitySignInBudget(dependencies.authentication, request.message, method);
    return yield* invokeHandler(next, request, method);
  });

const createRequestExecutionState = (
  request: InterceptorRequest,
  monotonicNow: () => number,
): RequestExecutionState => {
  const { header, method: descriptor, signal } = request;
  const requestId = header.get(REQUEST_ID_HEADER) ?? "";
  const method = `${descriptor.parent.typeName}.${descriptor.name}`;
  return { method, requestId, signal, startedAt: monotonicNow() };
};

const logTerminal = async ({
  code,
  method,
  monotonicNow,
  requestId,
  startedAt,
  terminalLog,
}: TerminalLogInput): Promise<void> => {
  const durationMs = Math.max(MINIMUM_DURATION_MILLISECONDS, monotonicNow() - startedAt);
  await terminalLog({
    code,
    durationMs,
    event: "rpc.completed",
    method,
    requestId,
  });
};

const createRequestPipeline = ({
  authentication,
  monotonicNow,
  requestRuntime,
  requestValidator,
  setupCoordinator,
  terminalLog,
}: RequestPipelineDependencies): Interceptor => {
  const dependencies = { authentication, requestValidator, setupCoordinator };

  return (next) => async (request) => {
    const { method, requestId, signal, startedAt } = createRequestExecutionState(
      request,
      monotonicNow,
    );
    let code: TerminalRpcCode = CONNECT_CODE_OK;

    try {
      return await requestRuntime.runPromise(
        createRequestEffect({ dependencies, method, next, request, requestId }),
        signal,
      );
    } catch (error: unknown) {
      const responseError = normalizeRequestFailure({ error, requestId, signal });
      const { code: responseCode } = responseError;
      code = responseCode;
      throw responseError;
    } finally {
      await logTerminal({ code, method, monotonicNow, requestId, startedAt, terminalLog });
    }
  };
};
export { createRequestPipeline, getRequestAdministrator, getRequestId };
export type { RequestPipelineDependencies, TerminalRpcCode, TerminalRpcRecord };
