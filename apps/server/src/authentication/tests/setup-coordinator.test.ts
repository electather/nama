import { expect, it } from "@effect/vitest";
import { Deferred, Effect } from "effect";

import { RuntimeControl } from "../../lifecycle/runtime-control.ts";
import { makeBootstrapToken } from "../../setup/bootstrap-token.ts";
import type { BootstrapTokenService } from "../../setup/bootstrap-token.ts";
import type { SetupCoordinatorService } from "../setup-coordinator.ts";
import {
  ADMINISTRATOR_ID,
  DISPLAY_NAME,
  EMAIL,
  NO_CREATION_CALLS,
  ONE_CREATION_CALL,
  PASSWORD,
  administrator,
  createAdministratorRequest,
  expectCreateFailure,
  expectCreationCalls,
  expectSetupStatus,
  expectSuccessfulCreation,
  expectTokenClosed,
  failed,
  makeAdapter,
  makeCoordinatorFixture,
  makeCreationCallCounts,
  makeEligibleBootstrapToken,
  makeSuccessfulCreationDependencies,
  wrongTokenCreateAdministratorRequest,
} from "./setup-coordinator.test-support.ts";
import type { CoordinatorFixture } from "./setup-coordinator.test-support.ts";

interface ConfiguredCreationCallCounts {
  adapter: number;
  claims: number;
  marker: number;
}

interface ConfiguredCreationFixture extends CoordinatorFixture {
  readonly calls: ConfiguredCreationCallCounts;
}

const makeConfiguredCreationFixture = (
  runtimeControl: RuntimeControl["Service"],
): ConfiguredCreationFixture => {
  const calls = {
    adapter: NO_CREATION_CALLS,
    claims: NO_CREATION_CALLS,
    marker: NO_CREATION_CALLS,
  };
  const bootstrapToken = makeBootstrapToken("configured");
  const countedBootstrapToken: BootstrapTokenService = Object.freeze({
    activate: bootstrapToken.activate,
    claim: (candidate: string) => {
      calls.claims += ONE_CREATION_CALL;
      return bootstrapToken.claim(candidate);
    },
  });
  const fixture = makeCoordinatorFixture(runtimeControl, {
    adapter: makeAdapter(() =>
      Effect.sync(() => {
        calls.adapter += ONE_CREATION_CALL;
        return administrator;
      }),
    ),
    bootstrapToken: countedBootstrapToken,
    completeInitialization: () =>
      Effect.sync(() => {
        calls.marker += ONE_CREATION_CALL;
      }),
    initialization: "configured",
  });

  return Object.freeze({ ...fixture, calls });
};

const expectConfiguredCreationWasInert = (
  failure: unknown,
  calls: ConfiguredCreationCallCounts,
): void => {
  expect(failure).toStrictEqual({ _tag: "SetupAlreadyInitialized" });
  expect(calls.claims).toBe(NO_CREATION_CALLS);
  expect(calls.adapter).toBe(NO_CREATION_CALLS);
  expect(calls.marker).toBe(NO_CREATION_CALLS);
};

const recordBootstrap = (
  bootstrapToken: BootstrapTokenService,
  events: string[],
  getStatusBeforeSuccess: () => SetupCoordinatorService["getStatus"],
): BootstrapTokenService =>
  Object.freeze({
    activate: bootstrapToken.activate,
    claim: (candidate: string) =>
      bootstrapToken.claim(candidate).pipe(
        Effect.map((attempt) => {
          events.push("claim");

          return Object.freeze({
            enterCommitCapable: attempt.enterCommitCapable.pipe(
              Effect.tap(() => Effect.sync(() => events.push("commit-capable"))),
            ),
            succeed: Effect.gen(function* recordedAttemptSuccess() {
              const status = yield* getStatusBeforeSuccess().pipe(Effect.orDie);
              expect(status).toBe(true);
              events.push("state-initialized");
              yield* attempt.succeed;
              events.push("attempt-succeeded");
            }),
          });
        }),
      ),
  });

const makeSequenceFixture = (runtimeControl: RuntimeControl["Service"], events: string[]) =>
  Effect.gen(function* makeSequenceFixtureEffect() {
    const coordinatorReady = yield* Deferred.make<SetupCoordinatorService>();
    const bootstrapToken = makeEligibleBootstrapToken();
    const recordedBootstrapToken = recordBootstrap(bootstrapToken, events, () =>
      Deferred.await(coordinatorReady).pipe(Effect.flatMap((coordinator) => coordinator.getStatus)),
    );
    const adapter = makeAdapter((input) =>
      Effect.sync(() => {
        expect(input).toStrictEqual({
          email: EMAIL,
          name: DISPLAY_NAME,
          password: PASSWORD,
        });
        events.push("adapter");
      }).pipe(Effect.as(administrator)),
    );
    const completeInitialization = (administratorUserId: string) =>
      Effect.sync(() => {
        expect(administratorUserId).toBe(ADMINISTRATOR_ID);
        events.push(`marker:${administratorUserId}`);
      });
    const fixture = makeCoordinatorFixture(runtimeControl, {
      adapter,
      bootstrapToken: recordedBootstrapToken,
      completeInitialization,
    });

    yield* Deferred.succeed(coordinatorReady, fixture.coordinator);
    return fixture;
  });

it.effect("reports configured startup as initialized", () =>
  Effect.gen(function* configuredStatusTest() {
    const runtimeControl = yield* RuntimeControl;
    const bootstrapToken = makeBootstrapToken("configured");
    const fixture = makeCoordinatorFixture(runtimeControl, {
      bootstrapToken,
      initialization: "configured",
    });

    yield* expectSetupStatus(fixture.coordinator, true);
  }).pipe(Effect.provide(RuntimeControl.layer)),
);

it.effect("reports setup-eligible startup as uninitialized", () =>
  Effect.gen(function* eligibleStatusTest() {
    const runtimeControl = yield* RuntimeControl;
    const fixture = makeCoordinatorFixture(runtimeControl);

    yield* expectSetupStatus(fixture.coordinator, false);
  }).pipe(Effect.provide(RuntimeControl.layer)),
);

it.effect(
  "rejects configured administrator creation before claiming the token or touching dependencies",
  () =>
    Effect.gen(function* configuredCreateTest() {
      const runtimeControl = yield* RuntimeControl;
      const fixture = makeConfiguredCreationFixture(runtimeControl);
      const creation = fixture.coordinator.createAdministrator(createAdministratorRequest);
      const failure = yield* failed(creation);

      expectConfiguredCreationWasInert(failure, fixture.calls);
    }).pipe(Effect.provide(RuntimeControl.layer)),
);

it.effect("preserves setup eligibility after a wrong real bootstrap token", () =>
  Effect.gen(function* wrongTokenTest() {
    const runtimeControl = yield* RuntimeControl;
    const calls = makeCreationCallCounts();
    const dependencies = makeSuccessfulCreationDependencies(calls);
    const fixture = makeCoordinatorFixture(runtimeControl, dependencies);

    yield* fixture.bootstrapToken.activate;
    yield* expectCreateFailure(
      fixture.coordinator,
      wrongTokenCreateAdministratorRequest,
      "BootstrapTokenInvalidError",
    );
    expectCreationCalls(calls, NO_CREATION_CALLS, NO_CREATION_CALLS);
    yield* expectSetupStatus(fixture.coordinator, false);
    yield* expectSuccessfulCreation(fixture.coordinator);
  }).pipe(Effect.provide(RuntimeControl.layer)),
);

it.effect("commits the administrator in the token, adapter, marker, state, and success order", () =>
  Effect.gen(function* successfulCreateSequenceTest() {
    const runtimeControl = yield* RuntimeControl;
    const events: string[] = [];
    const fixture = yield* makeSequenceFixture(runtimeControl, events);

    yield* fixture.bootstrapToken.activate;
    yield* expectSetupStatus(fixture.coordinator, false);
    yield* expectSuccessfulCreation(fixture.coordinator);
    expect(events).toStrictEqual([
      "claim",
      "commit-capable",
      "adapter",
      `marker:${ADMINISTRATOR_ID}`,
      "state-initialized",
      "attempt-succeeded",
    ]);
    yield* expectTokenClosed(fixture.bootstrapToken);
  }).pipe(Effect.provide(RuntimeControl.layer)),
);
