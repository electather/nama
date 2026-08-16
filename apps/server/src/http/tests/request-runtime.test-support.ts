import { expect } from "@effect/vitest";
import { Deferred, Effect, Exit, Ref, Scope } from "effect";

import { makeRequestRuntime } from "../request-runtime.ts";
import type { RequestRuntime } from "../request-runtime.ts";
import { makeDatabase } from "./http-server.test-support.ts";

const NO_INTERRUPTION_COUNT = 0;
const SINGLE_INTERRUPTION_COUNT = 1;

interface RequestRuntimeTestRuntime {
  readonly close: Effect.Effect<void>;
  readonly requestRuntime: RequestRuntime;
}

interface ControlledRequestFixture {
  readonly release: Deferred.Deferred<void>;
  readonly request: Promise<void>;
}

interface InterruptedRequestFixture {
  readonly finalized: Deferred.Deferred<void>;
  readonly interruptions: Ref.Ref<number>;
  readonly request: Promise<never>;
}

interface InterruptedRequestInput {
  readonly finalized: Deferred.Deferred<void>;
  readonly interruptions: Ref.Ref<number>;
  readonly pending: Deferred.Deferred<never>;
  readonly started: Deferred.Deferred<void>;
}

const startRequestRuntime = () =>
  Effect.gen(function* requestRuntimeTestRuntime() {
    const database = makeDatabase(Effect.succeed(true));
    const scope = yield* Scope.make();
    const close = Scope.close(scope, Exit.void);
    yield* Effect.addFinalizer(() => close);
    const requestRuntimeEffect = makeRequestRuntime(database);
    const provideScope = Scope.provide(scope);
    const scopedRequestRuntime = provideScope(requestRuntimeEffect);
    const requestRuntime = yield* scopedRequestRuntime;
    return { close, requestRuntime } satisfies RequestRuntimeTestRuntime;
  });

const pendingEffect = <Success, Failure>(pending: Deferred.Deferred<Success, Failure>) =>
  Deferred.await(pending);

const startControlledRequest = (requestRuntime: RequestRuntime) =>
  Effect.gen(function* controlledRequestFixture() {
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const startedEffect = Deferred.done(started, Exit.void);
    const releaseEffect = pendingEffect(release);
    const requestEffect = startedEffect.pipe(Effect.andThen(releaseEffect));
    const request = requestRuntime.runPromise<void, never>(requestEffect);
    yield* Deferred.await(started);
    return { release, request } satisfies ControlledRequestFixture;
  });

const makeInterruptedRequest = ({
  finalized,
  interruptions,
  pending,
  started,
}: Readonly<InterruptedRequestInput>) => {
  const startedEffect = Deferred.done(started, Exit.void);
  const pendingRequest = pendingEffect(pending);
  const markInterrupted = Ref.update(interruptions, (count) => count + SINGLE_INTERRUPTION_COUNT);
  const finalize = Deferred.done(finalized, Exit.void);
  const interruptionFinalizer = markInterrupted.pipe(Effect.andThen(finalize));
  return startedEffect.pipe(
    Effect.andThen(pendingRequest),
    Effect.onInterrupt(() => interruptionFinalizer),
  );
};

const startInterruptedRequest = (requestRuntime: RequestRuntime, signal?: AbortSignal) =>
  Effect.gen(function* interruptedRequestFixture() {
    const started = yield* Deferred.make<void>();
    const finalized = yield* Deferred.make<void>();
    const interruptions = yield* Ref.make(NO_INTERRUPTION_COUNT);
    const pending = yield* Deferred.make<never>();
    const effect = makeInterruptedRequest({ finalized, interruptions, pending, started });
    const request = requestRuntime.runPromise<never, never>(effect, signal);
    yield* Deferred.await(started);
    return { finalized, interruptions, request } satisfies InterruptedRequestFixture;
  });

const observePromiseRejection = async <Success>(promise: Promise<Success>): Promise<unknown> => {
  try {
    await promise;
  } catch (error: unknown) {
    return error;
  }
  throw new Error("Expected request promise to reject");
};

const promiseRejectionEffect = <Success>(promise: Promise<Success>) =>
  Effect.promise(() => observePromiseRejection(promise));

const assertSingleInterruption = (interruptions: Ref.Ref<number>) =>
  Effect.gen(function* singleInterruptionAssertion() {
    const count = yield* Ref.get(interruptions);
    expect(count).toBe(SINGLE_INTERRUPTION_COUNT);
  });

const assertSingleInterruptions = (first: Ref.Ref<number>, second: Ref.Ref<number>) =>
  Effect.gen(function* singleInterruptionsAssertion() {
    yield* assertSingleInterruption(first);
    yield* assertSingleInterruption(second);
  });

export {
  assertSingleInterruption,
  assertSingleInterruptions,
  pendingEffect,
  promiseRejectionEffect,
  startControlledRequest,
  startInterruptedRequest,
  startRequestRuntime,
};
export type { InterruptedRequestFixture };
