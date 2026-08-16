import { createRequire } from "node:module";

import { Context, Effect, Layer } from "effect";

import { Config } from "../config/config.ts";
import type { ConfigService } from "../config/schema.ts";
import { account, session, user, verification } from "../database/auth-schema.ts";
import { Database } from "../database/database.ts";
import {
  authenticationStoreUnavailable,
  callRuntime,
  deriveSecret,
  invalidCredentials,
  invokeRuntimeFunction,
  isInvalidCredentialsError,
  makeResolveBearer,
  makeSignOut,
  parseCreateAdministratorResult,
  parseRuntimeResult,
  privateAuthenticationDefect,
  readRuntimeFunction,
  readRuntimeModule,
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

const MAXIMUM_PASSWORD_LENGTH = 128;
const MINIMUM_PASSWORD_LENGTH = 8;

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
  readonly resolveBearer: (
    authorization: string,
  ) => Effect.Effect<ResolvedBearer, ResolveBearerFailure>;
  readonly signIn: (
    input: SignInInput,
  ) => Effect.Effect<SignedInAdministrator, AuthenticationFailure>;
  readonly signOut: (authorization: string) => Effect.Effect<void, StoreFailure>;
}

interface AuthenticationDatabase {
  readonly authentication: Readonly<{ readonly database: unknown }>;
}

interface BetterAuthAdapterInput {
  readonly config: ConfigService;
  readonly database: AuthenticationDatabase;
  readonly loadModule?: RuntimeModuleLoader;
}

interface RuntimeAdapterOptions {
  readonly config: ConfigService;
  readonly database: AuthenticationDatabase;
  readonly loadModule: RuntimeModuleLoader;
  readonly secret: string;
}

const nodeRequire = createRequire(import.meta.url);
const defaultModuleLoader: RuntimeModuleLoader = (moduleId) => {
  switch (moduleId) {
    case "better-auth": {
      return nodeRequire("better-auth");
    }
    case "better-auth/adapters/drizzle": {
      return nodeRequire("better-auth/adapters/drizzle");
    }
    case "better-auth/plugins/bearer": {
      return nodeRequire("better-auth/plugins/bearer");
    }
    default: {
      const neverModuleId: never = moduleId;
      return neverModuleId;
    }
  }
};

const makeRuntimeAdapter = ({
  config,
  database,
  loadModule,
  secret,
}: RuntimeAdapterOptions): unknown => {
  const betterAuth = readRuntimeFunction(
    readRuntimeModule(loadModule("better-auth")),
    "betterAuth",
  );
  const drizzleAdapter = readRuntimeFunction(
    readRuntimeModule(loadModule("better-auth/adapters/drizzle")),
    "drizzleAdapter",
  );
  const bearer = readRuntimeFunction(
    readRuntimeModule(loadModule("better-auth/plugins/bearer")),
    "bearer",
  );
  const adapter = invokeRuntimeFunction(drizzleAdapter, [
    database.authentication.database,
    {
      provider: "pg",
      schema: { account, session, user, verification },
      transaction: true,
    },
  ]);
  const plugin = invokeRuntimeFunction(bearer, [{ requireSignature: true }]);
  return invokeRuntimeFunction(betterAuth, [
    {
      baseURL: config.server.publicUrl,
      database: adapter,
      emailAndPassword: {
        autoSignIn: false,
        enabled: true,
        maxPasswordLength: MAXIMUM_PASSWORD_LENGTH,
        minPasswordLength: MINIMUM_PASSWORD_LENGTH,
      },
      logger: { disabled: true },
      plugins: [plugin],
      secret,
      telemetry: { enabled: false },
    },
  ]);
};

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

const makeAdapterService = (runtime: unknown): BetterAuthAdapterService => {
  const resolveBearer = makeResolveBearer(runtime);
  return Object.freeze({
    createAdministrator: makeCreateAdministrator(runtime),
    resolveBearer,
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
    return yield* Effect.try({
      catch: () => betterAuthConstructionError,
      try: () =>
        makeAdapterService(
          makeRuntimeAdapter({
            config: input.config,
            database: input.database,
            loadModule: input.loadModule ?? defaultModuleLoader,
            secret,
          }),
        ),
    });
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
