import {
  Cause,
  Effect,
  Exit,
  Fiber,
  Layer,
  Logger,
  ManagedRuntime,
  References,
  Result,
} from "effect";

import { Database } from "../database/database.ts";

interface RequestRuntime {
  readonly awaitRequests: Effect.Effect<void>;
  readonly interruptRequests: Effect.Effect<void>;
  readonly run: (
    effect: Effect.Effect<unknown, unknown>,
    onExit: (exit: Exit.Exit<unknown, unknown>) => void,
  ) => void;
  readonly runPromise: <Success, Failure>(
    effect: Effect.Effect<Success, Failure>,
    signal?: AbortSignal,
  ) => Promise<Success>;
}

interface RequestRuntimeRunner {
  readonly runFork: <Success, Failure>(
    effect: Effect.Effect<Success, Failure>,
  ) => Fiber.Fiber<Success, Failure>;
  readonly runPromise: <Success, Failure>(
    effect: Effect.Effect<Success, Failure>,
  ) => Promise<Success>;
}

type RequestFiber = Fiber.Fiber<unknown, unknown>;
type RequestInterrupter = (reason: unknown) => void;

const REQUEST_RUNTIME_INTERRUPTED = Object.freeze({
  _tag: "RequestRuntimeInterrupted" as const,
});

const REQUEST_RUNTIME_FAILURE = Object.freeze({
  _tag: "RequestRuntimeFailure" as const,
});

const failureFromCause = <Failure>(cause: Readonly<Cause.Cause<Failure>>) => {
  const error = Cause.findError(cause);
  if (Result.isSuccess(error)) {
    return error.success;
  }
  if (Cause.hasInterruptsOnly(cause)) {
    return REQUEST_RUNTIME_INTERRUPTED;
  }
  return REQUEST_RUNTIME_FAILURE;
};

const interruptTrackedRequests = (
  activeRequests: Set<RequestFiber>,
  requestInterrupts: Map<RequestFiber, RequestInterrupter>,
) =>
  Effect.suspend(() => {
    const requests = [...activeRequests];
    for (const request of requests) {
      const interrupt = requestInterrupts.get(request);
      if (interrupt === undefined) {
        request.interruptUnsafe();
      } else {
        interrupt(REQUEST_RUNTIME_INTERRUPTED);
      }
    }
    return Fiber.awaitAll(requests).pipe(Effect.asVoid);
  });

interface PendingRequestDependencies<Success, Failure> {
  readonly activeRequests: Set<RequestFiber>;
  readonly fiber: Fiber.Fiber<Success, Failure>;
  readonly requestInterrupts: Map<RequestFiber, RequestInterrupter>;
  readonly runner: RequestRuntimeRunner;
  readonly signal: AbortSignal | undefined;
}

interface RunPromiseRequestDependencies<Success, Failure> {
  readonly activeRequests: Set<RequestFiber>;
  readonly effect: Effect.Effect<Success, Failure>;
  readonly requestInterrupts: Map<RequestFiber, RequestInterrupter>;
  readonly runner: RequestRuntimeRunner;
  readonly signal: AbortSignal | undefined;
}

class PendingRequest<Success, Failure> {
  private readonly activeRequests: Set<RequestFiber>;
  private readonly fiber: Fiber.Fiber<Success, Failure>;
  private readonly requestInterrupts: Map<RequestFiber, RequestInterrupter>;
  private readonly runner: RequestRuntimeRunner;
  private readonly signal: AbortSignal | undefined;
  private abortListenerAdded = false;
  private interruption: { readonly reason: unknown } | undefined;
  private settled = false;

  constructor({
    activeRequests,
    fiber,
    requestInterrupts,
    runner,
    signal,
  }: PendingRequestDependencies<Success, Failure>) {
    this.activeRequests = activeRequests;
    this.fiber = fiber;
    this.requestInterrupts = requestInterrupts;
    this.runner = runner;
    this.signal = signal;
  }

  readonly start = (): Promise<Success> => {
    this.activeRequests.add(this.fiber);
    this.requestInterrupts.set(this.fiber, this.interrupt);
    this.listenForAbort();
    this.fiber.addObserver(this.onExit);
    return this.runner.runPromise(Fiber.await(this.fiber).pipe(Effect.flatMap(this.exitEffect)));
  };

  private readonly exitEffect = (
    exit: Exit.Exit<Success, Failure>,
  ): Effect.Effect<Success, unknown> => {
    if (this.interruption !== undefined) {
      return Effect.fail(this.interruption.reason);
    }
    if (Exit.isSuccess(exit)) {
      return Effect.succeed(exit.value);
    }
    return Effect.fail(failureFromCause(exit.cause));
  };

  private readonly interrupt: RequestInterrupter = (reason) => {
    if (this.settled || this.interruption !== undefined) {
      return;
    }
    this.interruption = { reason };
    this.fiber.interruptUnsafe();
  };

  private readonly listenForAbort = (): void => {
    if (this.signal === undefined) {
      return;
    }
    if (this.signal.aborted) {
      this.interrupt(this.signal.reason);
      return;
    }
    this.signal.addEventListener("abort", this.onAbort, { once: true });
    this.abortListenerAdded = true;
  };

  private readonly onAbort = (): void => {
    if (this.signal !== undefined) {
      this.interrupt(this.signal.reason);
    }
  };

  private readonly onExit = (): void => {
    if (this.settled) {
      return;
    }
    this.settled = true;
    this.activeRequests.delete(this.fiber);
    this.requestInterrupts.delete(this.fiber);
    if (this.signal !== undefined && this.abortListenerAdded) {
      this.signal.removeEventListener("abort", this.onAbort);
      this.abortListenerAdded = false;
    }
  };
}

const runPromiseRequest = <Success, Failure>({
  activeRequests,
  effect,
  requestInterrupts,
  runner,
  signal,
}: RunPromiseRequestDependencies<Success, Failure>): Promise<Success> => {
  if (signal?.aborted === true) {
    return runner.runPromise(Effect.fail(signal.reason));
  }
  try {
    return new PendingRequest({
      activeRequests,
      fiber: runner.runFork(effect),
      requestInterrupts,
      runner,
      signal,
    }).start();
  } catch {
    return runner.runPromise(Effect.fail(REQUEST_RUNTIME_FAILURE));
  }
};

const createRequestRuntime = (runner: RequestRuntimeRunner): RequestRuntime => {
  const activeRequests = new Set<RequestFiber>();
  const requestInterrupts = new Map<RequestFiber, RequestInterrupter>();

  return {
    awaitRequests: Effect.suspend(() => Fiber.awaitAll(activeRequests).pipe(Effect.asVoid)),
    interruptRequests: interruptTrackedRequests(activeRequests, requestInterrupts),
    run: (effect, onExit) => {
      const fiber = runner.runFork(effect);
      activeRequests.add(fiber);
      fiber.addObserver((exit) => {
        activeRequests.delete(fiber);
        onExit(exit);
      });
    },
    runPromise: (effect, signal) =>
      runPromiseRequest({ activeRequests, effect, requestInterrupts, runner, signal }),
  };
};

const makeRequestRuntime = (database: Database["Service"]) =>
  Effect.gen(function* makeRequestRuntimeBridge() {
    const loggers = yield* Effect.service(Logger.CurrentLoggers);
    const minimumLogLevel = yield* References.MinimumLogLevel;
    const requestLayer = Layer.mergeAll(
      Layer.succeed(Database, database),
      Layer.succeed(Logger.CurrentLoggers, loggers),
      Layer.succeed(References.MinimumLogLevel, minimumLogLevel),
    );
    const managedRuntime = ManagedRuntime.make(requestLayer);
    const requestRuntime = createRequestRuntime(managedRuntime);

    yield* Effect.addFinalizer(() =>
      requestRuntime.interruptRequests.pipe(Effect.andThen(managedRuntime.disposeEffect)),
    );
    yield* Effect.promise(() => managedRuntime.runPromise(Database));
    return requestRuntime;
  });

export { makeRequestRuntime };
export type { RequestRuntime };
