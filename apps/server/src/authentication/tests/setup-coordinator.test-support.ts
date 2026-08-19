// oxlint-disable import/max-dependencies -- The complete Database test double includes the provider persistence seam.
import { expect } from "@effect/vitest";
import { drizzle } from "drizzle-orm/node-postgres";
import { Cause, Effect, Exit } from "effect";
import { Pool } from "pg";

import { Database } from "../../database/database.ts";
import { databaseSchema } from "../../database/schema.ts";
import { unusedProviderPersistence } from "../../database/tests/provider-persistence.test-support.ts";
import type { RuntimeControl } from "../../lifecycle/runtime-control.ts";
import { makeBootstrapToken } from "../../setup/bootstrap-token.ts";
import type { BootstrapTokenService } from "../../setup/bootstrap-token.ts";
import type { BetterAuthAdapterService } from "../better-auth-adapter.ts";
import { makeSetupCoordinator } from "../setup-coordinator.ts";
import type { CreateAdministratorRequest, SetupCoordinatorService } from "../setup-coordinator.ts";

const TOKEN_BYTES = 32;
const BOOTSTRAP_TOKEN = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const WRONG_BOOTSTRAP_TOKEN = "wrong-bootstrap-token";
const ADMINISTRATOR_ID = "administrator-1";
const DISPLAY_NAME = "Ada Administrator";
const EMAIL = "ada.administrator@nama.example";
const PASSWORD = "correct-horse-battery-staple";
const PRIVATE_ADAPTER_DETAIL = "private Better Auth runtime failure";
const PRIVATE_DATABASE_DETAIL = "private database completion failure";
const NO_CREATION_CALLS = 0;
const ONE_CREATION_CALL = 1;

const administrator = Object.freeze({
  displayName: DISPLAY_NAME,
  email: EMAIL,
  id: ADMINISTRATOR_ID,
});

const createAdministratorRequest = Object.freeze({
  bootstrapToken: BOOTSTRAP_TOKEN,
  displayName: DISPLAY_NAME,
  email: EMAIL,
  password: PASSWORD,
}) satisfies CreateAdministratorRequest;

const wrongTokenCreateAdministratorRequest = Object.freeze({
  ...createAdministratorRequest,
  bootstrapToken: WRONG_BOOTSTRAP_TOKEN,
}) satisfies CreateAdministratorRequest;

const privateAdapterFailure = Object.freeze({
  _tag: "PrivateAuthenticationDefect" as const,
  administratorId: ADMINISTRATOR_ID,
  bootstrapToken: BOOTSTRAP_TOKEN,
  detail: PRIVATE_ADAPTER_DETAIL,
  password: PASSWORD,
});

type CoordinatorDatabaseService = Database["Service"];
type DatabaseInitialization = CoordinatorDatabaseService["initialization"];
type CompleteInitialization =
  CoordinatorDatabaseService["authentication"]["completeInitialization"];
type CoordinatorRuntimeControlService = RuntimeControl["Service"];
type BootstrapTokenFailureTag =
  | "BootstrapSetupClosedError"
  | "BootstrapTokenBusyError"
  | "BootstrapTokenInvalidError";

interface CoordinatorFixtureOptions {
  readonly adapter?: BetterAuthAdapterService;
  readonly bootstrapToken?: BootstrapTokenService;
  readonly completeInitialization?: CompleteInitialization;
  readonly initialization?: DatabaseInitialization;
}

interface CoordinatorFixture {
  readonly bootstrapToken: BootstrapTokenService;
  readonly coordinator: SetupCoordinatorService;
}

interface CreationCallCounts {
  adapter: number;
  marker: number;
}

const unusedAuthenticationDatabase = drizzle(new Pool(), { schema: databaseSchema });

const defaultAdapter = Object.freeze({
  createAdministrator: () => Effect.die("unexpected createAdministrator call"),
  resolveBearer: () => Effect.die("unexpected resolveBearer call"),
  signIn: () => Effect.die("unexpected signIn call"),
  signOut: () => Effect.die("unexpected signOut call"),
}) satisfies BetterAuthAdapterService;

const defaultCompleteInitialization: CompleteInitialization = () => Effect.void;

const failed = <Success, Failure, Requirements>(
  effect: Effect.Effect<Success, Failure, Requirements>,
): Effect.Effect<Failure | false, never, Requirements> =>
  effect.pipe(Effect.match({ onFailure: (failure) => failure, onSuccess: () => false }));

const makeEligibleBootstrapToken = () =>
  makeBootstrapToken("setup-eligible", {
    randomBytes: () => Buffer.alloc(TOKEN_BYTES),
    writeLine: (line) => line.length,
  });

const makeAdapter = (
  createAdministrator: BetterAuthAdapterService["createAdministrator"],
): BetterAuthAdapterService =>
  Object.freeze({
    ...defaultAdapter,
    createAdministrator,
  });

const makeCoordinatorFixture = (
  runtimeControl: CoordinatorRuntimeControlService,
  options: CoordinatorFixtureOptions = {},
): CoordinatorFixture => {
  const initialization = options.initialization ?? "setup-eligible";
  const bootstrapToken = options.bootstrapToken ?? makeEligibleBootstrapToken();
  const completeInitialization = options.completeInitialization ?? defaultCompleteInitialization;
  const database = Database.of({
    authentication: { completeInitialization, database: unusedAuthenticationDatabase },
    checkReadiness: Effect.succeed(true),
    initialization,
    providers: unusedProviderPersistence,
  });
  const coordinator = makeSetupCoordinator({
    betterAuthAdapter: options.adapter ?? defaultAdapter,
    bootstrapToken,
    database,
    initialization,
    runtimeControl,
  });

  return Object.freeze({ bootstrapToken, coordinator });
};

const makeCreationCallCounts = (): CreationCallCounts => ({
  adapter: NO_CREATION_CALLS,
  marker: NO_CREATION_CALLS,
});

const makeSuccessfulCreationDependencies = (
  calls: CreationCallCounts,
): Pick<CoordinatorFixtureOptions, "adapter" | "completeInitialization"> => ({
  adapter: makeAdapter(() =>
    Effect.sync(() => {
      calls.adapter += ONE_CREATION_CALL;
      return administrator;
    }),
  ),
  completeInitialization: () =>
    Effect.sync(() => {
      calls.marker += ONE_CREATION_CALL;
    }),
});

const expectSafeBootstrapTokenFailure = (
  bootstrapFailure: unknown,
  tag: BootstrapTokenFailureTag,
): void => {
  expect(bootstrapFailure).toMatchObject({ _tag: tag });

  const representation = `${String(bootstrapFailure)}${JSON.stringify(bootstrapFailure) ?? ""}`;
  for (const privateValue of [
    BOOTSTRAP_TOKEN,
    WRONG_BOOTSTRAP_TOKEN,
    PASSWORD,
    PRIVATE_ADAPTER_DETAIL,
    PRIVATE_DATABASE_DETAIL,
  ]) {
    expect(representation).not.toContain(privateValue);
  }
};

const expectAmbiguousFailure = (failure: unknown): void => {
  expect(failure).toStrictEqual({ _tag: "SetupCommitAmbiguous" });
};

const expectInterruptedExit = <Success, Failure>(exit: Exit.Exit<Success, Failure>): void => {
  expect(Exit.isFailure(exit)).toBe(true);
  if (Exit.isFailure(exit)) {
    expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true);
  }
};

const expectSetupStatus = (coordinator: SetupCoordinatorService, expected: boolean) =>
  coordinator.getStatus.pipe(
    Effect.tap((actual) =>
      Effect.sync(() => {
        expect(actual).toBe(expected);
      }),
    ),
    Effect.asVoid,
  );

const expectCreateFailure = (
  coordinator: SetupCoordinatorService,
  request: CreateAdministratorRequest,
  tag: BootstrapTokenFailureTag,
) => {
  const creation = coordinator.createAdministrator(request);
  return failed(creation).pipe(
    Effect.tap((creationFailure) =>
      Effect.sync(() => {
        expectSafeBootstrapTokenFailure(creationFailure, tag);
      }),
    ),
    Effect.asVoid,
  );
};

const expectSuccessfulCreation = (coordinator: SetupCoordinatorService) => {
  const creation = coordinator.createAdministrator(createAdministratorRequest);
  return creation.pipe(
    Effect.tap((actual) =>
      Effect.sync(() => {
        expect(actual).toStrictEqual(administrator);
      }),
    ),
    Effect.andThen(expectSetupStatus(coordinator, true)),
  );
};

const expectTokenClaimable = (bootstrapToken: BootstrapTokenService) => {
  const claim = bootstrapToken.claim(BOOTSTRAP_TOKEN);
  return Effect.scoped(
    claim.pipe(
      Effect.tap((attempt) =>
        Effect.sync(() => {
          expect(attempt).toBeDefined();
        }),
      ),
      Effect.asVoid,
    ),
  );
};

const expectTokenClosed = (bootstrapToken: BootstrapTokenService) => {
  const claim = bootstrapToken.claim(BOOTSTRAP_TOKEN);
  const claimFailure = failed(claim);
  return Effect.scoped(
    claimFailure.pipe(
      Effect.tap((bootstrapFailure) =>
        Effect.sync(() => {
          expectSafeBootstrapTokenFailure(bootstrapFailure, "BootstrapSetupClosedError");
        }),
      ),
      Effect.asVoid,
    ),
  );
};

const expectCreationCalls = (
  calls: CreationCallCounts,
  expectedAdapterCalls: number,
  expectedMarkerCalls: number,
): void => {
  expect(calls.adapter).toBe(expectedAdapterCalls);
  expect(calls.marker).toBe(expectedMarkerCalls);
};

export {
  ADMINISTRATOR_ID,
  DISPLAY_NAME,
  EMAIL,
  NO_CREATION_CALLS,
  ONE_CREATION_CALL,
  PASSWORD,
  administrator,
  createAdministratorRequest,
  expectAmbiguousFailure,
  expectCreateFailure,
  expectCreationCalls,
  expectInterruptedExit,
  expectSetupStatus,
  expectSuccessfulCreation,
  expectTokenClaimable,
  expectTokenClosed,
  failed,
  makeAdapter,
  makeCoordinatorFixture,
  makeCreationCallCounts,
  makeEligibleBootstrapToken,
  makeSuccessfulCreationDependencies,
  privateAdapterFailure,
  wrongTokenCreateAdministratorRequest,
};
export type {
  BootstrapTokenFailureTag,
  CompleteInitialization,
  CoordinatorFixture,
  CoordinatorFixtureOptions,
  CreationCallCounts,
  DatabaseInitialization,
  CoordinatorDatabaseService,
  CoordinatorRuntimeControlService,
};
