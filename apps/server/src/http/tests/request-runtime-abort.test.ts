import { expect, it } from "@effect/vitest";
import { Deferred, Effect } from "effect";
import { vi } from "vitest";

import type { RequestRuntime } from "../request-runtime.ts";
import {
  assertSingleInterruption,
  assertSingleInterruptions,
  pendingEffect,
  promiseRejectionEffect,
  startInterruptedRequest,
  startRequestRuntime,
} from "./request-runtime.test-support.ts";
import type { InterruptedRequestFixture } from "./request-runtime.test-support.ts";

const FIRST_ABORT_LISTENER_CALL_INDEX = 0;
const ABORT_EVENT_TYPE_ARGUMENT_INDEX = 0;
const ABORT_EVENT_LISTENER_ARGUMENT_INDEX = 1;
const NO_ABORT_LISTENER_COUNT = 0;
const SINGLE_ABORT_LISTENER_COUNT = 1;

interface AbortListenerSpy {
  readonly mock: {
    readonly calls: readonly (readonly unknown[])[];
  };
}

interface AbortableRequestFixture extends InterruptedRequestFixture {
  readonly abortReason: object;
  readonly addAbortListener: AbortListenerSpy;
  readonly controller: AbortController;
  readonly removeAbortListener: AbortListenerSpy;
}

interface AlreadyAbortedRequestFixture {
  readonly abortReason: object;
  readonly addAbortListener: AbortListenerSpy;
  readonly request: Promise<never>;
  readonly started: { value: boolean };
}

interface AbortReasonRequestFixture extends InterruptedRequestFixture {
  readonly abortReason: object;
  readonly controller: AbortController;
}

const abortController = (controller: AbortController, reason: unknown) =>
  Effect.sync(() => {
    controller.abort(reason);
  });

const abortAndAwaitFinalization = (
  controller: AbortController,
  reason: unknown,
  finalized: Deferred.Deferred<void>,
) => {
  const abort = abortController(controller, reason);
  const finalization = Deferred.await(finalized);
  return abort.pipe(Effect.andThen(finalization));
};

const awaitFinalizations = (first: Deferred.Deferred<void>, second: Deferred.Deferred<void>) => {
  const firstFinalization = Deferred.await(first);
  const secondFinalization = Deferred.await(second);
  return Effect.all([firstFinalization, secondFinalization]);
};

const abortBothAndAwaitFinalization = (
  first: AbortReasonRequestFixture,
  second: AbortReasonRequestFixture,
) => {
  const firstAbort = abortController(first.controller, first.abortReason);
  const secondAbort = abortController(second.controller, second.abortReason);
  const finalizations = awaitFinalizations(first.finalized, second.finalized);
  const aborts = Effect.all([firstAbort, secondAbort]);
  return aborts.pipe(Effect.andThen(finalizations));
};

const startAbortableRequest = (requestRuntime: RequestRuntime) =>
  Effect.gen(function* abortableRequestFixture() {
    const controller = new AbortController();
    const abortReason = Object.freeze({ source: "client-cancellation" });
    const addAbortListener = vi.spyOn(controller.signal, "addEventListener");
    const removeAbortListener = vi.spyOn(controller.signal, "removeEventListener");
    const interruptedRequest = yield* startInterruptedRequest(requestRuntime, controller.signal);
    return {
      ...interruptedRequest,
      abortReason,
      addAbortListener,
      controller,
      removeAbortListener,
    } satisfies AbortableRequestFixture;
  });

const makeObservablePendingEffect = (
  started: { value: boolean },
  pending: Effect.Effect<never>,
) => {
  const markStarted = Effect.sync(() => {
    started.value = true;
  });
  return markStarted.pipe(Effect.andThen(pending));
};

const startAlreadyAbortedRequest = (requestRuntime: RequestRuntime) =>
  Effect.gen(function* alreadyAbortedRequestFixture() {
    const controller = new AbortController();
    const abortReason = Object.freeze({ source: "already-aborted" });
    const addAbortListener = vi.spyOn(controller.signal, "addEventListener");
    const started = { value: false };
    yield* abortController(controller, abortReason);
    const pending = yield* Deferred.make<never>();
    const blockedRequest = pendingEffect(pending);
    const effect = makeObservablePendingEffect(started, blockedRequest);
    const request = requestRuntime.runPromise<never, never>(effect, controller.signal);
    return {
      abortReason,
      addAbortListener,
      request,
      started,
    } satisfies AlreadyAbortedRequestFixture;
  });

const startAbortReasonRequest = (requestRuntime: RequestRuntime, source: string) =>
  Effect.gen(function* abortReasonRequestFixture() {
    const controller = new AbortController();
    const abortReason = Object.freeze({ source });
    const interruptedRequest = yield* startInterruptedRequest(requestRuntime, controller.signal);
    return { ...interruptedRequest, abortReason, controller } satisfies AbortReasonRequestFixture;
  });

const assertAbortListenerCleanup = (fixture: AbortableRequestFixture): void => {
  const addedListener =
    fixture.addAbortListener.mock.calls[FIRST_ABORT_LISTENER_CALL_INDEX]?.[
      ABORT_EVENT_LISTENER_ARGUMENT_INDEX
    ];
  const removedCall = fixture.removeAbortListener.mock.calls[FIRST_ABORT_LISTENER_CALL_INDEX];
  const removedListener = removedCall?.[ABORT_EVENT_LISTENER_ARGUMENT_INDEX];
  expect(fixture.addAbortListener).toHaveBeenCalledTimes(SINGLE_ABORT_LISTENER_COUNT);
  expect(fixture.removeAbortListener).toHaveBeenCalledTimes(SINGLE_ABORT_LISTENER_COUNT);
  expect(removedCall?.[ABORT_EVENT_TYPE_ARGUMENT_INDEX]).toBe("abort");
  expect(removedListener).toBe(addedListener);
};

it.live("interrupts a runPromise on abort and removes its listener and tracking", () =>
  Effect.gen(function* abortSignalRequestTest() {
    const { requestRuntime } = yield* startRequestRuntime();
    const fixture = yield* startAbortableRequest(requestRuntime);

    yield* abortAndAwaitFinalization(fixture.controller, fixture.abortReason, fixture.finalized);
    yield* assertSingleInterruption(fixture.interruptions);
    const failure = yield* promiseRejectionEffect(fixture.request);

    expect(failure).toBe(fixture.abortReason);
    assertAbortListenerCleanup(fixture);
    yield* requestRuntime.awaitRequests;
  }),
);

it.live("rejects an already-aborted runPromise without starting its Effect", () =>
  Effect.gen(function* alreadyAbortedRequestTest() {
    const { requestRuntime } = yield* startRequestRuntime();
    const fixture = yield* startAlreadyAbortedRequest(requestRuntime);
    const failure = yield* promiseRejectionEffect(fixture.request);

    expect(failure).toBe(fixture.abortReason);
    expect(fixture.started.value).toBe(false);
    expect(fixture.addAbortListener).toHaveBeenCalledTimes(NO_ABORT_LISTENER_COUNT);
    yield* requestRuntime.awaitRequests;
  }),
);

it.live("preserves cancellation and deadline abort reasons without classifying them", () =>
  Effect.gen(function* distinctAbortReasonsTest() {
    const { requestRuntime } = yield* startRequestRuntime();
    const cancellation = yield* startAbortReasonRequest(requestRuntime, "client-cancellation");
    const deadline = yield* startAbortReasonRequest(requestRuntime, "deadline");

    yield* abortBothAndAwaitFinalization(cancellation, deadline);
    yield* assertSingleInterruptions(cancellation.interruptions, deadline.interruptions);
    const cancellationFailure = yield* promiseRejectionEffect(cancellation.request);
    const deadlineFailure = yield* promiseRejectionEffect(deadline.request);

    expect(cancellationFailure).toBe(cancellation.abortReason);
    expect(deadlineFailure).toBe(deadline.abortReason);
    yield* requestRuntime.awaitRequests;
  }),
);
