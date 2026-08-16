import { expect, it } from "@effect/vitest";
import { Deferred, Effect, Exit, Fiber } from "effect";
import type { Layer, ManagedRuntime as ManagedRuntimeApi } from "effect";
import { vi } from "vitest";

import type { RequestRuntime } from "../request-runtime.ts";
import { makeDatabase, startServer } from "./http-server.test-support.ts";
import {
  assertSingleInterruption,
  promiseRejectionEffect,
  startControlledRequest,
  startInterruptedRequest,
  startRequestRuntime,
} from "./request-runtime.test-support.ts";

const REQUEST_SUCCESS = "request completed";
const NO_RUNTIME_DISPOSAL_COUNT = 0;
const SINGLE_RUNTIME_DISPOSAL_COUNT = 1;

interface DisposalProbe {
  disposeCalls: number;
}

interface ManagedRuntimeExports {
  readonly make: <Requirements, Error>(
    layer: Layer.Layer<Requirements, Error>,
    options?: { readonly memoMap?: Layer.MemoMap | undefined },
  ) => ManagedRuntimeApi.ManagedRuntime<Requirements, Error>;
}

interface EffectExports {
  readonly Effect: typeof Effect;
  readonly ManagedRuntime: ManagedRuntimeExports;
  readonly [name: string]: unknown;
}

interface TypedRequestFailure {
  readonly _tag: "TypedRequestFailure";
  readonly privateDetail: string;
}

interface PromiseResultFixture {
  readonly failureRequest: Promise<never>;
  readonly successRequest: Promise<string>;
  readonly typedFailure: TypedRequestFailure;
}

const disposalProbes = vi.hoisted((): DisposalProbe[] => []);

vi.mock("effect", async (importOriginal) => {
  const actual = await importOriginal<EffectExports>();
  const makeManagedRuntime: ManagedRuntimeExports["make"] = (layer, options) => {
    const runtime = actual.ManagedRuntime.make(layer, options);
    const probe: DisposalProbe = { disposeCalls: NO_RUNTIME_DISPOSAL_COUNT };
    disposalProbes.push(probe);
    const markDisposed = actual.Effect.sync(() => {
      probe.disposeCalls += SINGLE_RUNTIME_DISPOSAL_COUNT;
    });
    const recordDisposal = actual.Effect.tap(() => markDisposed);
    const disposeEffect = runtime.disposeEffect.pipe(recordDisposal);
    return { ...runtime, disposeEffect };
  };
  return {
    ...actual,
    ManagedRuntime: {
      ...actual.ManagedRuntime,
      make: makeManagedRuntime,
    },
  };
});

const startPromiseResultFixture = (requestRuntime: RequestRuntime): PromiseResultFixture => {
  const successEffect = Effect.succeed(REQUEST_SUCCESS);
  const successRequest = requestRuntime.runPromise<string, never>(successEffect);
  const typedFailure = Object.freeze({
    _tag: "TypedRequestFailure" as const,
    privateDetail: "must not be wrapped in a Cause",
  });
  const failureEffect = Effect.fail(typedFailure);
  const failureRequest = requestRuntime.runPromise<never, TypedRequestFailure>(failureEffect);
  return { failureRequest, successRequest, typedFailure };
};

const interruptAndAwaitFinalization = (
  requestRuntime: RequestRuntime,
  finalized: Deferred.Deferred<void>,
) => {
  const interruption = requestRuntime.interruptRequests;
  const finalization = Deferred.await(finalized);
  return interruption.pipe(Effect.andThen(finalization));
};

const expectRequestRuntimeInterrupted = (failure: unknown): void => {
  expect(failure).toStrictEqual({ _tag: "RequestRuntimeInterrupted" });
  expect(failure).not.toHaveProperty("cause");
};

it.live("resolves runPromise success and rejects typed failures unchanged", () =>
  Effect.gen(function* requestRuntimePromiseResultTest() {
    const { requestRuntime } = yield* startRequestRuntime();
    const fixture = startPromiseResultFixture(requestRuntime);
    const success = yield* Effect.promise(() => fixture.successRequest);
    const failure = yield* promiseRejectionEffect(fixture.failureRequest);

    expect(success).toBe(REQUEST_SUCCESS);
    expect(failure).toBe(fixture.typedFailure);
    yield* requestRuntime.awaitRequests;
  }),
);

it.live("keeps awaitRequests pending for a running runPromise and drains after completion", () =>
  Effect.gen(function* requestRuntimeDrainTest() {
    const { requestRuntime } = yield* startRequestRuntime();
    const fixture = yield* startControlledRequest(requestRuntime);
    const awaitingRequests = yield* Effect.forkChild(requestRuntime.awaitRequests);

    yield* Effect.yieldNow;
    expect(awaitingRequests.pollUnsafe()).toBeUndefined();
    yield* Deferred.done(fixture.release, Exit.void);
    yield* Effect.promise(() => fixture.request);
    yield* Fiber.join(awaitingRequests);
    yield* requestRuntime.awaitRequests;
  }),
);

it.live("interrupts signal-less runPromise work safely before disposing the runtime scope", () =>
  Effect.gen(function* runtimeInterruptionTest() {
    const disposalProbeIndex = disposalProbes.length;
    const { close, requestRuntime } = yield* startRequestRuntime();
    const fixture = yield* startInterruptedRequest(requestRuntime);

    yield* interruptAndAwaitFinalization(requestRuntime, fixture.finalized);
    yield* assertSingleInterruption(fixture.interruptions);
    const failure = yield* promiseRejectionEffect(fixture.request);

    expectRequestRuntimeInterrupted(failure);
    yield* requestRuntime.awaitRequests;
    yield* close;
    expect(disposalProbes[disposalProbeIndex]?.disposeCalls).toBe(SINGLE_RUNTIME_DISPOSAL_COUNT);
  }),
);

it.live("disposes the managed runtime when the server scope closes", () =>
  Effect.gen(function* managedRuntimeDisposalTest() {
    const disposalProbeIndex = disposalProbes.length;
    const database = makeDatabase(Effect.succeed(true));
    const server = yield* startServer(database);

    yield* server.close;

    expect(disposalProbes[disposalProbeIndex]?.disposeCalls).toBe(SINGLE_RUNTIME_DISPOSAL_COUNT);
  }),
);
