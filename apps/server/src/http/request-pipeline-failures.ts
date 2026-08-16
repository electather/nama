import { Code, ConnectError } from "@connectrpc/connect";
import type { StreamResponse, UnaryRequest, UnaryResponse } from "@connectrpc/connect";
import { Effect } from "effect";

import type { AuthenticationService } from "../authentication/authentication-service.ts";
import type { RequestValidator } from "../contracts/request-validation.ts";
import {
  createRateLimitError,
  createValidationError,
  normalizeConnectFailure,
} from "./connect-errors.ts";

const ZERO_DETAILS = 0;
const SIGN_IN_METHOD = "nama.api.v1.AuthService.SignIn";
const requestPipelineInternalFailure = Object.freeze({
  _tag: "PrivateAuthenticationDefect" as const,
});

type FieldError = Readonly<{
  readonly description: string;
  readonly field: string;
  readonly reason: string;
}>;

type RateLimitFailure = Readonly<{
  readonly kind: "rate-limit";
  readonly retryAfterMilliseconds: number;
}>;

type ValidationFailure = Readonly<{
  readonly fieldErrors: readonly FieldError[];
  readonly kind: "validation";
}>;

type FrameworkUnimplementedFailure = Readonly<{
  readonly error: ConnectError;
  readonly kind: "framework-unimplemented";
}>;

type RequestPipelineFailurePayload =
  | RateLimitFailure
  | ValidationFailure
  | FrameworkUnimplementedFailure;

type RequestFailureInput = Readonly<{
  readonly error: unknown;
  readonly requestId: string;
  readonly signal: AbortSignal;
}>;

type UnaryNext = (request: UnaryRequest) => Promise<UnaryResponse | StreamResponse>;

class RequestPipelineFailure {
  readonly payload: RequestPipelineFailurePayload;

  constructor(payload: RequestPipelineFailurePayload) {
    this.payload = payload;
  }
}

const createRateLimitFailure = (retryAfterMilliseconds: number) =>
  new RequestPipelineFailure({ kind: "rate-limit", retryAfterMilliseconds });

const createValidationFailure = (fieldErrors: readonly FieldError[]) =>
  new RequestPipelineFailure({ fieldErrors, kind: "validation" });
const consumeGlobalSignInBudget = (
  authentication: AuthenticationService,
  method: string,
): Effect.Effect<void, unknown> =>
  Effect.gen(function* consumeGlobalSignInBudgetEffect() {
    if (method === SIGN_IN_METHOD) {
      const retryAfterMilliseconds = yield* authentication.consumeGlobalSignInBudget;
      if (retryAfterMilliseconds !== undefined) {
        yield* Effect.fail(createRateLimitFailure(retryAfterMilliseconds));
      }
    }
  });

const validateRequest = (
  requestValidator: RequestValidator,
  request: UnaryRequest,
): Effect.Effect<void, unknown> =>
  Effect.gen(function* validateRequestEffect() {
    const validation = yield* Effect.try({
      catch: () => requestPipelineInternalFailure,
      try: () => requestValidator.validate(request.method.input, request.message),
    });
    if (validation.kind === "invalid") {
      yield* Effect.fail(createValidationFailure(validation.fieldErrors));
    }
    if (validation.kind === "defect") {
      yield* Effect.fail(requestPipelineInternalFailure);
    }
  });

const normalizedSignInEmail = (message: unknown): string | undefined => {
  if (typeof message !== "object" || message === null || !("email" in message)) {
    return undefined;
  }
  if (typeof message.email !== "string") {
    return undefined;
  }
  return message.email.toLowerCase();
};

const consumeIdentitySignInBudget = (
  authentication: AuthenticationService,
  message: unknown,
  method: string,
): Effect.Effect<void, unknown> =>
  Effect.gen(function* consumeIdentitySignInBudgetEffect() {
    if (method === SIGN_IN_METHOD) {
      const email = normalizedSignInEmail(message);
      if (email === undefined) {
        yield* Effect.fail(requestPipelineInternalFailure);
      } else {
        const retryAfterMilliseconds = yield* authentication.consumeIdentitySignInBudget(email);
        if (retryAfterMilliseconds !== undefined) {
          yield* Effect.fail(createRateLimitFailure(retryAfterMilliseconds));
        }
      }
    }
  });

const isFrameworkUnimplemented = (error: unknown, method: string): error is ConnectError => {
  if (!(error instanceof ConnectError)) {
    return false;
  }
  if (error.code !== Code.Unimplemented || error.rawMessage !== `${method} is not implemented`) {
    return false;
  }
  if (error.cause !== undefined || error.details.length > ZERO_DETAILS) {
    return false;
  }
  return error.metadata.keys().next().done === true;
};

const createFrameworkUnimplementedFailure = (error: ConnectError) =>
  new RequestPipelineFailure({ error, kind: "framework-unimplemented" });

const invokeHandler = (next: UnaryNext, request: UnaryRequest, method: string) =>
  Effect.tryPromise({
    catch: (error: unknown) => {
      if (isFrameworkUnimplemented(error, method)) {
        return createFrameworkUnimplementedFailure(error);
      }
      return error;
    },
    try: () => next(request),
  });

const getRequestPipelineFailure = (error: unknown): RequestPipelineFailurePayload | undefined => {
  if (error instanceof RequestPipelineFailure) {
    return error.payload;
  }
  return undefined;
};

const activeSignalFailure = (signal: AbortSignal) => {
  if (signal.reason instanceof ConnectError && signal.reason.code === Code.DeadlineExceeded) {
    return { _tag: "DeadlineExceeded" };
  }
  return { _tag: "RequestCancelled" };
};

const normalizeRequestFailure = ({
  error,
  requestId,
  signal,
}: RequestFailureInput): ConnectError => {
  const pipelineFailure = getRequestPipelineFailure(error);
  if (!signal.aborted && pipelineFailure?.kind === "framework-unimplemented") {
    return pipelineFailure.error;
  }
  if (signal.aborted) {
    return normalizeConnectFailure(requestId, activeSignalFailure(signal));
  }
  if (pipelineFailure?.kind === "rate-limit") {
    return createRateLimitError(requestId, pipelineFailure.retryAfterMilliseconds);
  }
  if (pipelineFailure?.kind === "validation") {
    return createValidationError(requestId, pipelineFailure.fieldErrors);
  }
  return normalizeConnectFailure(requestId, error);
};

export {
  SIGN_IN_METHOD,
  consumeGlobalSignInBudget,
  consumeIdentitySignInBudget,
  invokeHandler,
  normalizeRequestFailure,
  requestPipelineInternalFailure,
  validateRequest,
};
export type { RequestFailureInput, UnaryNext };
