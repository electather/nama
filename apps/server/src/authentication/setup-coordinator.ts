import { Context, Effect, Layer } from "effect";

import type { Config } from "../config/config.ts";
import { Database } from "../database/database.ts";
import type { DatabaseInitialization } from "../database/initialization.ts";
import { RuntimeControl } from "../lifecycle/runtime-control.ts";
import { BootstrapToken } from "../setup/bootstrap-token.ts";
import type { BootstrapTokenClaimError, BootstrapTokenService } from "../setup/bootstrap-token.ts";
import { Authentication } from "./authentication-service.ts";
import { BetterAuthAdapter } from "./better-auth-adapter.ts";
import type { Administrator, BetterAuthAdapterService } from "./better-auth-adapter.ts";

const contextService = Context.Service;

type DatabaseService = Context.Service.Shape<typeof Database>;
type RuntimeControlService = Context.Service.Shape<typeof RuntimeControl>;

type CreateAdministratorRequest = Readonly<{
  readonly bootstrapToken: string;
  readonly displayName: string;
  readonly email: string;
  readonly password: string;
}>;
type SetupAlreadyInitialized = Readonly<{
  readonly _tag: "SetupAlreadyInitialized";
}>;
type SetupCommitAmbiguous = Readonly<{
  readonly _tag: "SetupCommitAmbiguous";
}>;
type SetupCoordinatorFailure =
  | BootstrapTokenClaimError
  | SetupAlreadyInitialized
  | SetupCommitAmbiguous;

interface SetupCoordinatorService {
  readonly getStatus: Effect.Effect<boolean, SetupCommitAmbiguous>;
  readonly createAdministrator: (
    request: CreateAdministratorRequest,
  ) => Effect.Effect<Administrator, SetupCoordinatorFailure>;
}

interface SetupCoordinatorDependencies {
  readonly betterAuthAdapter: BetterAuthAdapterService;
  readonly bootstrapToken: BootstrapTokenService;
  readonly database: DatabaseService;
  readonly initialization: DatabaseInitialization;
  readonly runtimeControl: RuntimeControlService;
}

type SetupState = "eligible" | "fatal" | "initialized";
type FailCommitAmbiguously = () => Effect.Effect<never, SetupCommitAmbiguous>;

interface CreateAdministratorDependencies {
  readonly betterAuthAdapter: BetterAuthAdapterService;
  readonly bootstrapToken: BootstrapTokenService;
  readonly database: DatabaseService;
  readonly failCommitAmbiguously: FailCommitAmbiguously;
  readonly state: SetupCoordinatorState;
}

interface SetupCoordinatorState {
  current: SetupState;
}

const setupAlreadyInitialized: SetupAlreadyInitialized = Object.freeze({
  _tag: "SetupAlreadyInitialized",
});
const setupCommitAmbiguous: SetupCommitAmbiguous = Object.freeze({
  _tag: "SetupCommitAmbiguous",
});

const makeCreateAdministrator =
  ({
    betterAuthAdapter,
    bootstrapToken,
    database,
    failCommitAmbiguously,
    state,
  }: CreateAdministratorDependencies) =>
  (request: CreateAdministratorRequest) =>
    Effect.suspend<Administrator, SetupCoordinatorFailure, never>(() => {
      if (state.current === "initialized") {
        return Effect.fail(setupAlreadyInitialized);
      }
      if (state.current === "fatal") {
        return Effect.fail(setupCommitAmbiguous);
      }

      return Effect.scoped(
        bootstrapToken.claim(request.bootstrapToken).pipe(
          Effect.flatMap((attempt) =>
            Effect.uninterruptible(
              Effect.gen(function* commitAdministrator() {
                yield* attempt.enterCommitCapable;
                const administrator = yield* betterAuthAdapter.createAdministrator({
                  email: request.email,
                  name: request.displayName,
                  password: request.password,
                });
                yield* database.authentication.completeInitialization(administrator.id);
                yield* Effect.sync(() => {
                  state.current = "initialized";
                });
                yield* attempt.succeed;
                return administrator;
              }).pipe(
                Effect.matchEffect({
                  onFailure: () => failCommitAmbiguously(),
                  onSuccess: (administrator) => Effect.succeed(administrator),
                }),
              ),
            ).pipe(
              Effect.flatMap((administrator) =>
                Effect.interruptible(Effect.yieldNow).pipe(Effect.as(administrator)),
              ),
            ),
          ),
        ),
      );
    });

const makeSetupCoordinator = ({
  betterAuthAdapter,
  bootstrapToken,
  database,
  initialization,
  runtimeControl,
}: SetupCoordinatorDependencies): SetupCoordinatorService => {
  const state: SetupCoordinatorState = { current: "eligible" };

  if (initialization === "configured") {
    state.current = "initialized";
  }

  const getStatus = Effect.suspend<boolean, SetupCommitAmbiguous, never>(() => {
    if (state.current === "fatal") {
      return Effect.fail(setupCommitAmbiguous);
    }

    return Effect.succeed(state.current === "initialized");
  });
  const failCommitAmbiguously: FailCommitAmbiguously = () =>
    Effect.gen(function* reportAmbiguousCommit() {
      yield* Effect.sync(() => {
        state.current = "fatal";
      });
      yield* runtimeControl.reportFatalFailure(setupCommitAmbiguous);
      return yield* Effect.fail(setupCommitAmbiguous);
    });
  const createAdministrator = makeCreateAdministrator({
    betterAuthAdapter,
    bootstrapToken,
    database,
    failCommitAmbiguously,
    state,
  });

  return Object.freeze({ createAdministrator, getStatus });
};

class SetupCoordinator extends contextService<SetupCoordinator, SetupCoordinatorService>()(
  "@nama/server/SetupCoordinator",
) {
  static readonly layer = Layer.effect(
    SetupCoordinator,
    Effect.gen(function* makeSetupCoordinatorService() {
      const database = yield* Database;
      const bootstrapToken = yield* BootstrapToken;
      const betterAuthAdapter = yield* BetterAuthAdapter;
      const runtimeControl = yield* RuntimeControl;

      return SetupCoordinator.of(
        makeSetupCoordinator({
          betterAuthAdapter,
          bootstrapToken,
          database,
          initialization: database.initialization,
          runtimeControl,
        }),
      );
    }),
  );
}

const makeSetupAuthenticationLayer = (
  foundationLayer: Layer.Layer<Config | Database, unknown>,
  runtimeControlLayer: Layer.Layer<RuntimeControl>,
) => {
  const runtimeDependencies = Layer.mergeAll(foundationLayer, runtimeControlLayer);
  const bootstrapTokenLayer = BootstrapToken.layer().pipe(Layer.provide(foundationLayer));
  const betterAuthAdapterLayer = BetterAuthAdapter.layer.pipe(Layer.provide(foundationLayer));
  const serviceDependencies = Layer.mergeAll(
    runtimeDependencies,
    bootstrapTokenLayer,
    betterAuthAdapterLayer,
  );
  const setupCoordinatorLayer = SetupCoordinator.layer.pipe(Layer.provide(serviceDependencies));
  const authenticationLayer = Authentication.layer.pipe(Layer.provide(betterAuthAdapterLayer));
  return Layer.mergeAll(serviceDependencies, setupCoordinatorLayer, authenticationLayer);
};

export { SetupCoordinator, makeSetupAuthenticationLayer, makeSetupCoordinator };
export type {
  CreateAdministratorRequest,
  DatabaseService,
  RuntimeControlService,
  SetupAlreadyInitialized,
  SetupCommitAmbiguous,
  SetupCoordinatorDependencies,
  SetupCoordinatorFailure,
  SetupCoordinatorService,
};
