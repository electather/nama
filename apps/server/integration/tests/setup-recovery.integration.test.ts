import { expect, it } from "@effect/vitest";
import { Cause, Deferred, Effect, Exit, Fiber } from "effect";

import {
  callOptions,
  clientsFor,
  expectReady,
  expectRpcSuccess,
  stopCleanly,
} from "./authentication-process.test-support.ts";
import { productionMigrations, withPool } from "./database.test-support.ts";
import { withIsolatedDatabase } from "./postgres.test-support.ts";
import { BOOTSTRAP_TOKEN_PREFIX, MASTER_KEY, startProcess } from "./process.test-support.ts";
import {
  awaitCancellationPhase,
  failAfterCommittedAdapterWrite,
  hasFailureTag,
  makeCommittedAdapter,
  useProductionSetup,
} from "./setup-recovery.test-support.ts";
import type { ProductionSetupServices } from "./setup-recovery.test-support.ts";

interface DurableSetupState {
  readonly account_count: string;
  readonly administrator_user_id: string | null;
  readonly credential_account_count: string;
  readonly initialized_at: Date | null;
  readonly user_count: string;
}

const BOOTSTRAP_SETUP_CLOSED_TAG = "BootstrapSetupClosedError";
const CREDENTIAL_PROVIDER_ID = "credential";
const DURABLE_SETUP_STATE_QUERY = `
SELECT
  state.administrator_user_id,
  state.initialized_at,
  (SELECT count(*) FROM "user") AS user_count,
  (SELECT count(*) FROM account) AS account_count,
  (SELECT count(*) FROM account WHERE user_id = $1 AND provider_id = $2 AND password IS NOT NULL) AS credential_account_count
FROM nama_server_state AS state
WHERE state."key" = $3
`;
const DURABLE_SETUP_STATE_ROW_INDEX = 0;
const EXPECTED_DURABLE_SETUP_STATE_ROWS = 1;
const EXPECTED_SINGLE_DURABLE_COUNT = "1";
const EXPECTED_SINGLE_WRITE_ATTEMPT = 1;
const INTEGRATION_TIMEOUT_MILLISECONDS = 30_000;
const RECOVERED_STATUS_PHASE = "recovered GetStatus";
const RUNTIME_FAILURE_TAG = "RuntimeFailure";
const SERVER_STATE_KEY = "server";
const SETUP_COMMIT_AMBIGUOUS_TAG = "SetupCommitAmbiguous";
const ADMINISTRATOR = Object.freeze({
  displayName: "Setup Recovery Administrator",
  email: "administrator@setup-recovery.test",
  id: "setup-recovery-administrator",
});
const CREATE_ADMINISTRATOR_REQUEST = Object.freeze({
  bootstrapToken: "",
  displayName: ADMINISTRATOR.displayName,
  email: ADMINISTRATOR.email,
  password: "setup-recovery-administrator-password",
});

const readDurableSetupState = (databaseUrl: string) =>
  withPool(databaseUrl, (pool) =>
    Effect.map(
      Effect.promise(() =>
        pool.query<DurableSetupState>(DURABLE_SETUP_STATE_QUERY, [
          ADMINISTRATOR.id,
          CREDENTIAL_PROVIDER_ID,
          SERVER_STATE_KEY,
        ]),
      ),
      ({ rows }) => {
        const durableSetupState = rows[DURABLE_SETUP_STATE_ROW_INDEX];
        if (rows.length !== EXPECTED_DURABLE_SETUP_STATE_ROWS || durableSetupState === undefined) {
          throw new Error("expected exactly one durable setup state row");
        }
        return durableSetupState;
      },
    ),
  );

const expectDurableSetupState = (state: DurableSetupState, initialized: boolean): void => {
  const {
    account_count: accountCount,
    administrator_user_id: administratorUserId,
    credential_account_count: credentialAccountCount,
    initialized_at: initializedAt,
    user_count: userCount,
  } = state;
  expect({ accountCount, credentialAccountCount, userCount }).toEqual({
    accountCount: EXPECTED_SINGLE_DURABLE_COUNT,
    credentialAccountCount: EXPECTED_SINGLE_DURABLE_COUNT,
    userCount: EXPECTED_SINGLE_DURABLE_COUNT,
  });
  if (initialized) {
    expect(administratorUserId).toBe(ADMINISTRATOR.id);
    expect(initializedAt).toBeInstanceOf(Date);
  } else {
    expect(administratorUserId).toBeNull();
    expect(initializedAt).toBeNull();
  }
};

const assertDurableSetupState = (databaseUrl: string, initialized: boolean) =>
  Effect.gen(function* durableSetupStateAssertion() {
    expectDurableSetupState(yield* readDurableSetupState(databaseUrl), initialized);
    return yield* Effect.void;
  });

const expectBootstrapClosed = (
  bootstrapToken: ProductionSetupServices["bootstrapToken"],
  capturedBootstrapToken: string,
) =>
  Effect.scoped(bootstrapToken.claim(capturedBootstrapToken).pipe(Effect.flip)).pipe(
    Effect.tap((failure) =>
      Effect.sync(() => {
        expect(hasFailureTag(failure, BOOTSTRAP_SETUP_CLOSED_TAG)).toBe(true);
      }),
    ),
    Effect.asVoid,
  );

const expectAmbiguousGetStatus = (coordinator: ProductionSetupServices["coordinator"]) =>
  coordinator.getStatus.pipe(
    Effect.flip,
    Effect.tap((failure) =>
      Effect.sync(() => {
        expect(hasFailureTag(failure, SETUP_COMMIT_AMBIGUOUS_TAG)).toBe(true);
      }),
    ),
    Effect.asVoid,
  );

const assertSecretSafeRestartOutput = (databaseUrl: string, output: string): void => {
  const sensitiveValues = [databaseUrl, MASTER_KEY, CREATE_ADMINISTRATOR_REQUEST.password];
  if (sensitiveValues.some((value) => output.includes(value))) {
    throw new Error("recovered process output must not contain secrets");
  }
};

const restartAndAssertConfigured = (databaseUrl: string) =>
  Effect.gen(function* restartRecoveryAssertion() {
    const restartedProcess = yield* startProcess(databaseUrl);
    yield* expectReady(restartedProcess);
    if (restartedProcess.stdout().includes(BOOTSTRAP_TOKEN_PREFIX)) {
      return yield* Effect.die(new Error("recovered startup must not emit bootstrap output"));
    }
    const status = yield* expectRpcSuccess({
      invoke: () => clientsFor(restartedProcess.origin).setup.getStatus({}, callOptions()),
      phase: RECOVERED_STATUS_PHASE,
    });
    expect(status.initialized).toBe(true);
    yield* stopCleanly(restartedProcess);

    const output = `${restartedProcess.stdout()}\n${restartedProcess.stderr()}`;
    assertSecretSafeRestartOutput(databaseUrl, output);
    return yield* Effect.void;
  });

const assertConfiguredRecoveryState = (databaseUrl: string) =>
  Effect.gen(function* configuredRecoveryStateAssertion() {
    yield* restartAndAssertConfigured(databaseUrl);
    yield* assertDurableSetupState(databaseUrl, true);
    return yield* Effect.void;
  });

const assertCommittedAmbiguity = ({
  bootstrapToken,
  capturedBootstrapToken,
  controlledAdapter,
  coordinator,
  runtimeControl,
}: ProductionSetupServices) =>
  Effect.gen(function* committedAmbiguity() {
    yield* runtimeControl.markReady;
    const fatalFailure = yield* Effect.forkChild(
      runtimeControl.awaitFatalFailure.pipe(Effect.flip),
    );
    const failure = yield* coordinator
      .createAdministrator({
        ...CREATE_ADMINISTRATOR_REQUEST,
        bootstrapToken: capturedBootstrapToken,
      })
      .pipe(Effect.flip);

    expect(hasFailureTag(failure, SETUP_COMMIT_AMBIGUOUS_TAG)).toBe(true);
    expect(controlledAdapter.writeAttempts()).toBe(EXPECTED_SINGLE_WRITE_ATTEMPT);
    yield* expectAmbiguousGetStatus(coordinator);
    expect(yield* runtimeControl.isReady).toBe(false);
    expect(hasFailureTag(yield* Fiber.join(fatalFailure), RUNTIME_FAILURE_TAG)).toBe(true);
    yield* expectBootstrapClosed(bootstrapToken, capturedBootstrapToken);
    return yield* Effect.void;
  });

const runAmbiguousRecoveryScenario = (databaseUrl: string) =>
  Effect.scoped(
    Effect.gen(function* ambiguousRecoveryScenario() {
      yield* useProductionSetup({
        consumeSetup: assertCommittedAmbiguity,
        databaseUrl,
        makeAdapter: (database) =>
          makeCommittedAdapter(database, ADMINISTRATOR, failAfterCommittedAdapterWrite),
        masterKey: MASTER_KEY,
        migrationsFolder: productionMigrations,
      });

      yield* assertDurableSetupState(databaseUrl, false);
      yield* assertConfiguredRecoveryState(databaseUrl);
      return yield* Effect.void;
    }),
  );

const ensureInterruptedPostCommitExit = (exit: Exit.Exit<unknown, unknown>): void => {
  if (!Exit.isFailure(exit)) {
    throw new Error("post-commit caller interruption must complete");
  }
  expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true);
};

const assertPostCommitSetupCompleted = ({
  bootstrapToken,
  capturedBootstrapToken,
  controlledAdapter,
  coordinator,
}: ProductionSetupServices) =>
  Effect.gen(function* postCommitSetupCompletedAssertion() {
    expect(controlledAdapter.writeAttempts()).toBe(EXPECTED_SINGLE_WRITE_ATTEMPT);
    expect(yield* coordinator.getStatus).toBe(true);
    yield* expectBootstrapClosed(bootstrapToken, capturedBootstrapToken);
    return yield* Effect.void;
  });

const completePostCommitCancellation = (
  adapterCommitted: Deferred.Deferred<void>,
  releaseAdapter: Deferred.Deferred<void>,
  services: ProductionSetupServices,
) =>
  Effect.gen(function* postCommitCancellation() {
    const { capturedBootstrapToken, coordinator } = services;
    const create = yield* Effect.forkChild(
      coordinator.createAdministrator({
        ...CREATE_ADMINISTRATOR_REQUEST,
        bootstrapToken: capturedBootstrapToken,
      }),
    );
    yield* awaitCancellationPhase("adapter-committed", Deferred.await(adapterCommitted));
    const interruption = yield* Effect.forkChild(Fiber.interrupt(create));
    yield* Deferred.done(releaseAdapter, Exit.void);
    yield* awaitCancellationPhase("interruption-join", Fiber.join(interruption));

    const exit = yield* awaitCancellationPhase("interrupted-create-exit", Fiber.await(create));
    ensureInterruptedPostCommitExit(exit);
    yield* assertPostCommitSetupCompleted(services);
    return yield* Effect.void;
  });
const runPostCommitCancellationScenario = (databaseUrl: string) =>
  Effect.scoped(
    Effect.gen(function* postCommitCancellationScenario() {
      const adapterCommitted = yield* Deferred.make<void>();
      const releaseAdapter = yield* Deferred.make<void>();
      yield* useProductionSetup({
        consumeSetup: (services) =>
          completePostCommitCancellation(adapterCommitted, releaseAdapter, services),
        databaseUrl,
        makeAdapter: (database) =>
          makeCommittedAdapter(
            database,
            ADMINISTRATOR,
            Effect.gen(function* holdAfterCommit() {
              yield* Deferred.done(adapterCommitted, Exit.void);
              yield* Deferred.await(releaseAdapter);
              return yield* Effect.void;
            }),
          ),
        masterKey: MASTER_KEY,
        migrationsFolder: productionMigrations,
      });
      yield* assertConfiguredRecoveryState(databaseUrl);
      return yield* Effect.void;
    }),
  );
it.live(
  "fails closed after a committed adapter ambiguity and repairs the marker on entrypoint restart",
  () => withIsolatedDatabase(runAmbiguousRecoveryScenario),
  INTEGRATION_TIMEOUT_MILLISECONDS,
);

it.live(
  "completes the protected marker boundary before delivering post-commit interruption",
  () => withIsolatedDatabase(runPostCommitCancellationScenario),
  INTEGRATION_TIMEOUT_MILLISECONDS,
);
