import type { RequestListener } from "node:http";

import { Context, Effect, Layer } from "effect";

import { Config } from "../config/config.ts";
import type { ConfigService } from "../config/schema.ts";
import { Database } from "../database/database.ts";
import {
  authenticationStoreUnavailable,
  callRuntime,
  deriveSecret,
  invalidCredentials,
  isInvalidCredentialsError,
  makeResolveBearer,
  makeSignOut,
  parseCreateAdministratorResult,
  parseRuntimeResult,
  privateAuthenticationDefect,
  readSignedBearer,
} from "./better-auth-adapter-private.ts";
import type {
  Administrator,
  AuthenticationStoreUnavailable,
  InvalidBearer,
  InvalidCredentials,
  PrivateAuthenticationDefect,
  ResolveBearerFailure,
  ResolvedBearer,
  RuntimeModuleLoader,
  StoreFailure,
} from "./better-auth-adapter-private.ts";
import { isObjectValue, readProperty } from "./better-auth-adapter-runtime.ts";
import { makeApproveDeviceAuthorization } from "./better-auth-device-approval-private.ts";
import type { ApproveDeviceAuthorization } from "./better-auth-device-approval-private.ts";
import { makeResolveOAuthAccess } from "./better-auth-oauth-private.ts";
import type { ResolveOAuthAccess } from "./better-auth-oauth-private.ts";
import { makeBetterAuthRuntime } from "./better-auth-runtime-private.ts";
import type { AuthenticationDatabase, BetterAuthRuntime } from "./better-auth-runtime-private.ts";

type BetterAuthConstructionFailure = Readonly<{ _tag: "BetterAuthConstructionError" }>;
type AuthenticationFailure = StoreFailure | InvalidBearer | InvalidCredentials;

const betterAuthConstructionError: BetterAuthConstructionFailure = Object.freeze({
  _tag: "BetterAuthConstructionError",
});
const contextService = Context.Service;

interface CreateAdministratorInput {
  readonly email: string;
  readonly name: string;
  readonly password: string;
}

interface SignInInput {
  readonly email: string;
  readonly password: string;
}

interface SignedInAdministrator extends ResolvedBearer {
  readonly bearer: string;
}

interface BetterAuthAdapterService {
  readonly createAdministrator: (
    input: CreateAdministratorInput,
  ) => Effect.Effect<Administrator, StoreFailure>;
  readonly oauthRequestListener: RequestListener;
  readonly approveDeviceAuthorization: ApproveDeviceAuthorization;
  readonly resolveOAuthAccess: ResolveOAuthAccess;
  readonly revokeAppleClientRefreshTokens: Effect.Effect<void, StoreFailure>;
  readonly resolveBearer: (
    authorization: string,
  ) => Effect.Effect<ResolvedBearer, ResolveBearerFailure>;
  readonly signIn: (
    input: SignInInput,
  ) => Effect.Effect<SignedInAdministrator, AuthenticationFailure>;
  readonly signOut: (authorization: string) => Effect.Effect<void, StoreFailure>;
}

interface BetterAuthAdapterInput {
  readonly config: ConfigService;
  readonly database: AuthenticationDatabase;
  readonly loadModule?: RuntimeModuleLoader;
}

const makeCreateAdministrator =
  (runtime: unknown): BetterAuthAdapterService["createAdministrator"] =>
  (input) =>
    callRuntime({
      defect: privateAuthenticationDefect,
      input: { body: { email: input.email, name: input.name, password: input.password } },
      methodName: "signUpEmail",
      onRejection: () => authenticationStoreUnavailable,
      runtime,
    }).pipe(
      Effect.flatMap((result) =>
        parseRuntimeResult({
          defect: privateAuthenticationDefect,
          parse: parseCreateAdministratorResult,
          result,
        }),
      ),
    );

const makeSignIn =
  (
    runtime: unknown,
    resolveBearer: BetterAuthAdapterService["resolveBearer"],
  ): BetterAuthAdapterService["signIn"] =>
  (input) =>
    callRuntime({
      defect: privateAuthenticationDefect,
      input: { body: { email: input.email, password: input.password }, returnHeaders: true },
      methodName: "signInEmail",
      onRejection: (rejection) => {
        if (isInvalidCredentialsError(rejection)) {
          return invalidCredentials;
        }
        return authenticationStoreUnavailable;
      },
      runtime,
    }).pipe(
      Effect.flatMap((result) =>
        parseRuntimeResult({
          defect: privateAuthenticationDefect,
          parse: readSignedBearer,
          result,
        }),
      ),
      Effect.flatMap((bearer) =>
        resolveBearer(`Bearer ${bearer}`).pipe(
          Effect.map((resolved) =>
            Object.freeze({
              administrator: resolved.administrator,
              bearer,
              sessionExpiresAt: resolved.sessionExpiresAt,
            }),
          ),
        ),
      ),
    );

const makeAdapterService = ({
  oauthRequestListener,
  resource,
  revokeAppleClientRefreshTokens,
  runtime,
  verifyJwsAccessToken,
}: BetterAuthRuntime): BetterAuthAdapterService => {
  const resolveBearer = makeResolveBearer(runtime);
  return Object.freeze({
    approveDeviceAuthorization: makeApproveDeviceAuthorization(runtime, resource),
    createAdministrator: makeCreateAdministrator(runtime),
    oauthRequestListener,
    resolveBearer,
    resolveOAuthAccess: makeResolveOAuthAccess(runtime, resource, verifyJwsAccessToken),
    revokeAppleClientRefreshTokens,
    signIn: makeSignIn(runtime, resolveBearer),
    signOut: makeSignOut(runtime),
  });
};

const makeBetterAuthAdapter = (
  input: BetterAuthAdapterInput,
): Effect.Effect<BetterAuthAdapterService, BetterAuthConstructionFailure> =>
  Effect.gen(function* makeBetterAuthAdapterService() {
    const secret = yield* deriveSecret(input.config.security.masterKey).pipe(
      Effect.mapError(() => betterAuthConstructionError),
    );
    const runtimeAdapter = yield* Effect.try({
      catch: () => betterAuthConstructionError,
      try: () =>
        makeBetterAuthRuntime({
          config: input.config,
          database: input.database,
          loadModule: input.loadModule,
          secret,
        }),
    });
    yield* Effect.tryPromise({
      catch: () => betterAuthConstructionError,
      try: async () => {
        if (!isObjectValue(runtimeAdapter.runtime)) {
          throw new TypeError("Better Auth runtime must be an object");
        }
        const initialization = readProperty(runtimeAdapter.runtime, "$context");
        if (initialization === undefined) {
          throw new TypeError("Better Auth runtime context is missing");
        }
        await Promise.resolve(initialization);
      },
    });
    return makeAdapterService(runtimeAdapter);
  });

class BetterAuthAdapter extends contextService<BetterAuthAdapter, BetterAuthAdapterService>()(
  "@nama/server/BetterAuthAdapter",
) {
  static readonly layer = Layer.effect(
    BetterAuthAdapter,
    Effect.gen(function* makeBetterAuthAdapterLayer() {
      const config = yield* Config;
      const database = yield* Database;
      return yield* makeBetterAuthAdapter({ config, database });
    }),
  );
}

export { BetterAuthAdapter, makeBetterAuthAdapter };
export type {
  Administrator,
  AuthenticationDatabase,
  AuthenticationFailure,
  AuthenticationStoreUnavailable,
  BetterAuthAdapterInput,
  BetterAuthAdapterService,
  BetterAuthConstructionFailure,
  CreateAdministratorInput,
  InvalidBearer,
  InvalidCredentials,
  PrivateAuthenticationDefect,
  ResolvedBearer,
  SignedInAdministrator,
  SignInInput,
};
