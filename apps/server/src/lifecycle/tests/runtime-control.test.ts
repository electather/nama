import { expect, it } from "@effect/vitest";
import { Effect, Fiber } from "effect";

import { RuntimeControl } from "../runtime-control.ts";

const SAFE_RUNTIME_FAILURE = { _tag: "RuntimeFailure" } as const;

const assertSafeRuntimeFailure = (failure: unknown, privateCause: Error): void => {
  expect(failure).toStrictEqual(SAFE_RUNTIME_FAILURE);
  expect(failure).not.toBe(privateCause);
  expect(failure).not.toHaveProperty("message");
  expect(failure).not.toHaveProperty("arbitraryProperty");
};

it.effect("starts not ready", () =>
  Effect.gen(function* runtimeControlInitialReadinessTest() {
    const runtimeControl = yield* RuntimeControl;

    expect(yield* runtimeControl.isReady).toBe(false);
  }).pipe(Effect.provide(RuntimeControl.layer)),
);

it.effect("becomes ready when marked after construction", () =>
  Effect.gen(function* runtimeControlReadyTransitionTest() {
    const runtimeControl = yield* RuntimeControl;

    yield* runtimeControl.markReady;

    expect(yield* runtimeControl.isReady).toBe(true);
  }).pipe(Effect.provide(RuntimeControl.layer)),
);

it.effect("becomes unready before the root waiter observes a fatal runtime failure", () =>
  Effect.gen(function* runtimeControlFatalReadinessTest() {
    const runtimeControl = yield* RuntimeControl;
    const privateCause = Object.assign(new Error("private runtime failure"), {
      arbitraryProperty: "must not reach the root",
    });
    const rootWaiter = yield* Effect.forkChild(runtimeControl.awaitFatalFailure.pipe(Effect.flip));

    yield* Effect.yieldNow;
    yield* runtimeControl.markReady;
    yield* runtimeControl.reportFatalFailure(privateCause);

    expect(yield* runtimeControl.isReady).toBe(false);

    const failure = yield* Fiber.join(rootWaiter);
    assertSafeRuntimeFailure(failure, privateCause);
  }).pipe(Effect.provide(RuntimeControl.layer)),
);

it.effect("accepts only the first fatal report", () =>
  Effect.gen(function* runtimeControlFatalLatchTest() {
    const runtimeControl = yield* RuntimeControl;

    const firstReport = yield* runtimeControl.reportFatalFailure(
      new Error("first private runtime failure"),
    );
    const secondReport = yield* runtimeControl.reportFatalFailure(
      new Error("second private runtime failure"),
    );

    expect(firstReport).toBe(true);
    expect(secondReport).toBe(false);
    expect(yield* runtimeControl.awaitFatalFailure.pipe(Effect.flip)).toStrictEqual(
      SAFE_RUNTIME_FAILURE,
    );
  }).pipe(Effect.provide(RuntimeControl.layer)),
);
