import { expect, it } from "@effect/vitest";
import { Data, Deferred, Effect, Exit, Fiber } from "effect";

import { RuntimeControl } from "../../lifecycle/runtime-control.ts";
import type { Administrator } from "../better-auth-adapter.ts";
import type { SetupCoordinatorFailure } from "../setup-coordinator.ts";
import {
  NO_CREATION_CALLS,
  ONE_CREATION_CALL,
  administrator,
  createAdministratorRequest,
  expectAmbiguousFailure,
  expectCreationCalls,
  expectInterruptedExit,
  expectSetupStatus,
  expectTokenClosed,
  failed,
  makeAdapter,
  makeCoordinatorFixture,
  makeCreationCallCounts,
  makeEligibleBootstrapToken,
  privateAdapterFailure,
} from "./setup-coordinator.test-support.ts";
import type { CoordinatorFixture, CreationCallCounts } from "./setup-coordinator.test-support.ts";

interface AmbiguityFixture extends CoordinatorFixture {
  readonly calls: CreationCallCounts;
}

interface PostCommitFixture extends CoordinatorFixture {
  readonly adapterStarted: Deferred.Deferred<void>;
  readonly calls: CreationCallCounts;
  readonly markerStarted: Deferred.Deferred<void>;
  readonly releaseAdapter: Deferred.Deferred<void>;
  readonly releaseMarker: Deferred.Deferred<void>;
}

type AmbiguityBoundary = "adapter" | "marker";

const taggedError = Data.TaggedError;

class PrivateMarkerFailure extends taggedError("DatabaseInitializationCompletionError")<{
  readonly administratorId: string;
  readonly bootstrapToken: string;
  readonly detail: string;
  readonly password: string;
}> {}

const privateMarkerFailure = new PrivateMarkerFailure({
  administratorId: administrator.id,
  bootstrapToken: createAdministratorRequest.bootstrapToken,
  detail: "private database completion failure",
  password: createAdministratorRequest.password,
});

const makeAmbiguityFixture = (
  runtimeControl: RuntimeControl["Service"],
  boundary: AmbiguityBoundary,
): AmbiguityFixture => {
  const bootstrapToken = makeEligibleBootstrapToken();
  const calls = makeCreationCallCounts();
  const adapter = makeAdapter(() => {
    calls.adapter += ONE_CREATION_CALL;
    if (boundary === "adapter") {
      return Effect.fail(privateAdapterFailure);
    }
    return Effect.succeed(administrator);
  });
  const completeInitialization = () => {
    calls.marker += ONE_CREATION_CALL;
    if (boundary === "marker") {
      return Effect.fail(privateMarkerFailure);
    }
    return Effect.void;
  };
  const fixture = makeCoordinatorFixture(runtimeControl, {
    adapter,
    bootstrapToken,
    completeInitialization,
  });

  return Object.freeze({ ...fixture, calls });
};

interface AmbiguousAttempt {
  readonly calls: CreationCallCounts;
  readonly expectedAdapterCalls: number;
  readonly expectedMarkerCalls: number;
  readonly failure: unknown;
}

const expectAmbiguousAttempt = ({
  calls,
  expectedAdapterCalls,
  expectedMarkerCalls,
  failure,
}: AmbiguousAttempt): void => {
  expectAmbiguousFailure(failure);
  expectCreationCalls(calls, expectedAdapterCalls, expectedMarkerCalls);
};

const expectFatalRuntime = (
  runtimeControl: RuntimeControl["Service"],
  rootWaiter: Fiber.Fiber<{ readonly _tag: "RuntimeFailure" }>,
  coordinator: CoordinatorFixture["coordinator"],
) =>
  Effect.gen(function* expectFatalRuntimeEffect() {
    const runtimeFailure = yield* Fiber.join(rootWaiter);
    expect(runtimeFailure).toStrictEqual({ _tag: "RuntimeFailure" });
    const reported = yield* runtimeControl.reportFatalFailure(new Error("second failure"));
    expect(reported).toBe(false);
    expectAmbiguousFailure(yield* failed(coordinator.getStatus));
  });

const expectClosedAmbiguity = (
  fixture: AmbiguityFixture,
  expectedAdapterCalls: number,
  expectedMarkerCalls: number,
) =>
  Effect.gen(function* expectClosedAmbiguityEffect() {
    yield* expectTokenClosed(fixture.bootstrapToken);
    const retry = fixture.coordinator.createAdministrator(createAdministratorRequest);
    const repeatedFailure = yield* failed(retry);
    expectAmbiguousFailure(repeatedFailure);
    expectCreationCalls(fixture.calls, expectedAdapterCalls, expectedMarkerCalls);
  });

const expectAmbiguousCreation = (
  fixture: AmbiguityFixture,
  expectedAdapterCalls: number,
  expectedMarkerCalls: number,
) =>
  Effect.gen(function* expectAmbiguousCreationEffect() {
    const creation = fixture.coordinator.createAdministrator(createAdministratorRequest);
    const failure = yield* failed(creation);
    expectAmbiguousAttempt({
      calls: fixture.calls,
      expectedAdapterCalls,
      expectedMarkerCalls,
      failure,
    });
  });

const makePostCommitFixture = (runtimeControl: RuntimeControl["Service"]) =>
  Effect.gen(function* makePostCommitFixtureEffect() {
    const [adapterStarted, releaseAdapter, markerStarted, releaseMarker] = yield* Effect.all([
      Deferred.make<void>(),
      Deferred.make<void>(),
      Deferred.make<void>(),
      Deferred.make<void>(),
    ] as const);
    const bootstrapToken = makeEligibleBootstrapToken();
    const calls = makeCreationCallCounts();
    const adapter = makeAdapter(() =>
      Effect.gen(function* interruptProtectedAdapter() {
        calls.adapter += ONE_CREATION_CALL;
        yield* Deferred.done(adapterStarted, Exit.void);
        yield* Deferred.await(releaseAdapter);
        return administrator;
      }),
    );
    const completeInitialization = () =>
      Effect.gen(function* interruptProtectedMarker() {
        calls.marker += ONE_CREATION_CALL;
        yield* Deferred.done(markerStarted, Exit.void);
        yield* Deferred.await(releaseMarker);
      });
    const fixture = makeCoordinatorFixture(runtimeControl, {
      adapter,
      bootstrapToken,
      completeInitialization,
    });

    return Object.freeze({
      ...fixture,
      adapterStarted,
      calls,
      markerStarted,
      releaseAdapter,
      releaseMarker,
    });
  });

const interruptAndCompletePostCommit = (
  create: Fiber.Fiber<Administrator, SetupCoordinatorFailure>,
  fixture: PostCommitFixture,
) =>
  Effect.gen(function* interruptAndCompletePostCommitEffect() {
    const interruptionEffect = Fiber.interrupt(create);
    const interruption = yield* Effect.forkChild(interruptionEffect);
    yield* Deferred.done(fixture.releaseAdapter, Exit.void);
    yield* Deferred.await(fixture.markerStarted);
    yield* Deferred.done(fixture.releaseMarker, Exit.void);
    yield* Fiber.join(interruption);
    return yield* Fiber.await(create);
  });

const expectPostCommitCancellation = (
  exit: Exit.Exit<Administrator, SetupCoordinatorFailure>,
  fixture: PostCommitFixture,
) =>
  Effect.gen(function* expectPostCommitCancellationEffect() {
    expectInterruptedExit(exit);
    expectCreationCalls(fixture.calls, ONE_CREATION_CALL, ONE_CREATION_CALL);
    yield* expectSetupStatus(fixture.coordinator, true);
    yield* expectTokenClosed(fixture.bootstrapToken);
  });

it.effect("fails closed after a private adapter failure once creation has started", () =>
  Effect.gen(function* adapterAmbiguityTest() {
    const runtimeControl = yield* RuntimeControl;
    const fixture = makeAmbiguityFixture(runtimeControl, "adapter");

    yield* fixture.bootstrapToken.activate;
    yield* runtimeControl.markReady;
    const fatalFailure = runtimeControl.awaitFatalFailure.pipe(Effect.flip);
    const rootWaiter = yield* Effect.forkChild(fatalFailure);
    yield* expectAmbiguousCreation(fixture, ONE_CREATION_CALL, NO_CREATION_CALLS);
    yield* expectFatalRuntime(runtimeControl, rootWaiter, fixture.coordinator);
    yield* expectClosedAmbiguity(fixture, ONE_CREATION_CALL, NO_CREATION_CALLS);
  }).pipe(Effect.provide(RuntimeControl.layer)),
);

it.effect("fails closed after a private marker completion failure once creation has started", () =>
  Effect.gen(function* markerAmbiguityTest() {
    const runtimeControl = yield* RuntimeControl;
    const fixture = makeAmbiguityFixture(runtimeControl, "marker");

    yield* fixture.bootstrapToken.activate;
    yield* runtimeControl.markReady;
    const fatalFailure = runtimeControl.awaitFatalFailure.pipe(Effect.flip);
    const rootWaiter = yield* Effect.forkChild(fatalFailure);
    yield* expectAmbiguousCreation(fixture, ONE_CREATION_CALL, ONE_CREATION_CALL);
    yield* expectFatalRuntime(runtimeControl, rootWaiter, fixture.coordinator);
    yield* expectClosedAmbiguity(fixture, ONE_CREATION_CALL, ONE_CREATION_CALL);
  }).pipe(Effect.provide(RuntimeControl.layer)),
);

it.effect("finishes the post-commit boundary after its caller is interrupted", () =>
  Effect.gen(function* postCommitInterruptionTest() {
    const runtimeControl = yield* RuntimeControl;
    const fixture = yield* makePostCommitFixture(runtimeControl);

    yield* fixture.bootstrapToken.activate;
    const creation = fixture.coordinator.createAdministrator(createAdministratorRequest);
    const create = yield* Effect.forkChild(creation);
    yield* Deferred.await(fixture.adapterStarted);
    const exit = yield* interruptAndCompletePostCommit(create, fixture);
    yield* expectPostCommitCancellation(exit, fixture);
  }).pipe(Effect.provide(RuntimeControl.layer)),
);
