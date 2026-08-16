import { expect, it } from "@effect/vitest";
import { Deferred, Effect, Exit, Fiber } from "effect";

import { RuntimeControl } from "../../lifecycle/runtime-control.ts";
import type { BootstrapTokenService } from "../../setup/bootstrap-token.ts";
import type { Administrator } from "../better-auth-adapter.ts";
import type { SetupCoordinatorFailure } from "../setup-coordinator.ts";
import {
  ONE_CREATION_CALL,
  administrator,
  createAdministratorRequest,
  expectCreateFailure,
  expectCreationCalls,
  expectInterruptedExit,
  expectSetupStatus,
  expectTokenClaimable,
  makeAdapter,
  makeCoordinatorFixture,
  makeCreationCallCounts,
  makeEligibleBootstrapToken,
} from "./setup-coordinator.test-support.ts";
import type { CoordinatorFixture, CreationCallCounts } from "./setup-coordinator.test-support.ts";

interface PreCommitFixture extends CoordinatorFixture {
  readonly attemptClaimed: Deferred.Deferred<void>;
}

const makePreCommitFixture = (runtimeControl: RuntimeControl["Service"]) =>
  Effect.gen(function* makePreCommitFixtureEffect() {
    const attemptClaimed = yield* Deferred.make<void>();
    const bootstrapToken = makeEligibleBootstrapToken();
    const interruptibleBootstrapToken: BootstrapTokenService = Object.freeze({
      activate: bootstrapToken.activate,
      claim: (candidate: string) =>
        bootstrapToken.claim(candidate).pipe(
          Effect.tap(() => Deferred.done(attemptClaimed, Exit.void)),
          Effect.andThen(Effect.never),
        ),
    });
    const fixture = makeCoordinatorFixture(runtimeControl, {
      adapter: makeAdapter(() => Effect.die("adapter must not be called")),
      bootstrapToken: interruptibleBootstrapToken,
      completeInitialization: () => Effect.die("marker must not be called"),
    });

    return Object.freeze({ ...fixture, attemptClaimed, bootstrapToken });
  });

const makeConcurrentCreationFixture = (runtimeControl: RuntimeControl["Service"]) =>
  Effect.gen(function* makeConcurrentCreationFixtureEffect() {
    const adapterStarted = yield* Deferred.make<void>();
    const releaseAdapter = yield* Deferred.make<void>();
    const calls = makeCreationCallCounts();
    const adapter = makeAdapter(() =>
      Effect.gen(function* controlledCreateAdministrator() {
        calls.adapter += ONE_CREATION_CALL;
        yield* Deferred.done(adapterStarted, Exit.void);
        yield* Deferred.await(releaseAdapter);
        return administrator;
      }),
    );
    const completeInitialization = () =>
      Effect.sync(() => {
        calls.marker += ONE_CREATION_CALL;
      });
    const fixture = makeCoordinatorFixture(runtimeControl, {
      adapter,
      completeInitialization,
    });

    return Object.freeze({ ...fixture, adapterStarted, calls, releaseAdapter });
  });

const expectConcurrentWinner = (
  first: Fiber.Fiber<Administrator, SetupCoordinatorFailure>,
  fixture: CoordinatorFixture,
  calls: CreationCallCounts,
) =>
  Effect.gen(function* expectConcurrentWinnerEffect() {
    const winner = yield* Fiber.join(first);
    expect(winner).toStrictEqual(administrator);
    expectCreationCalls(calls, ONE_CREATION_CALL, ONE_CREATION_CALL);
    yield* expectSetupStatus(fixture.coordinator, true);
  });

const expectPreCommitCancellation = <Success, Failure>(
  exit: Exit.Exit<Success, Failure>,
  fixture: PreCommitFixture,
) =>
  Effect.gen(function* expectPreCommitCancellationEffect() {
    expectInterruptedExit(exit);
    yield* expectSetupStatus(fixture.coordinator, false);
    yield* expectTokenClaimable(fixture.bootstrapToken);
  });

it.effect("restores the bootstrap token when cancellation arrives before commit-capable work", () =>
  Effect.gen(function* preCommitInterruptionTest() {
    const runtimeControl = yield* RuntimeControl;
    const fixture = yield* makePreCommitFixture(runtimeControl);

    yield* fixture.bootstrapToken.activate;
    const creation = fixture.coordinator.createAdministrator(createAdministratorRequest);
    const create = yield* Effect.forkChild(creation);
    yield* Deferred.await(fixture.attemptClaimed);
    yield* Fiber.interrupt(create);
    const exit = yield* Fiber.await(create);
    yield* expectPreCommitCancellation(exit, fixture);
  }).pipe(Effect.provide(RuntimeControl.layer)),
);

it.effect("allows exactly one concurrent valid setup creation and rejects the other as busy", () =>
  Effect.gen(function* concurrentCreateTest() {
    const runtimeControl = yield* RuntimeControl;
    const fixture = yield* makeConcurrentCreationFixture(runtimeControl);

    yield* fixture.bootstrapToken.activate;
    const creation = fixture.coordinator.createAdministrator(createAdministratorRequest);
    const first = yield* Effect.forkChild(creation);
    yield* Deferred.await(fixture.adapterStarted);
    yield* expectCreateFailure(
      fixture.coordinator,
      createAdministratorRequest,
      "BootstrapTokenBusyError",
    );
    yield* Deferred.done(fixture.releaseAdapter, Exit.void);
    yield* expectConcurrentWinner(first, fixture, fixture.calls);
  }).pipe(Effect.provide(RuntimeControl.layer)),
);
