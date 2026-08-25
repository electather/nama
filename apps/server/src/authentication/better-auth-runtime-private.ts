import type { RequestListener } from "node:http";
import { createRequire } from "node:module";

import { Effect } from "effect";

import { makeOAuthProviderOptions } from "../config/oauth.ts";
import type { ConfigService } from "../config/schema.ts";
import { generatedAuthenticationSchema } from "../database/schema.ts";
import {
  authenticationStoreUnavailable,
  invokeRuntimeFunction,
  readRuntimeFunction,
  readRuntimeModule,
} from "./better-auth-adapter-private.ts";
import type { RuntimeModuleLoader, StoreFailure } from "./better-auth-adapter-private.ts";
import type { RuntimeFunction } from "./better-auth-adapter-runtime.ts";
import { makeOAuthRequestListener } from "./better-auth-oauth-private.ts";

const MAXIMUM_PASSWORD_LENGTH = 128;
const MINIMUM_PASSWORD_LENGTH = 8;

interface AuthenticationDatabase {
  readonly authentication: Readonly<{
    readonly database: unknown;
    readonly revokeAppleClientRefreshTokens: Effect.Effect<void, unknown>;
  }>;
}

interface BetterAuthRuntimeInput {
  readonly config: ConfigService;
  readonly database: AuthenticationDatabase;
  readonly loadModule: RuntimeModuleLoader | undefined;
  readonly secret: string;
}

interface BetterAuthRuntime {
  readonly oauthRequestListener: RequestListener;
  readonly resource: string;
  readonly revokeAppleClientRefreshTokens: Effect.Effect<void, StoreFailure>;
  readonly runtime: unknown;
  readonly verifyJwsAccessToken: RuntimeFunction;
}

interface RuntimeFactories {
  readonly bearer: RuntimeFunction;
  readonly betterAuth: RuntimeFunction;
  readonly drizzleAdapter: RuntimeFunction;
  readonly jwt: RuntimeFunction;
  readonly oauthDeviceAuthorization: RuntimeFunction;
  readonly oauthProvider: RuntimeFunction;
  readonly toNodeHandler: RuntimeFunction;
  readonly verifyJwsAccessToken: RuntimeFunction;
}
const isRequestListener = (value: unknown): value is RequestListener => typeof value === "function";

const nodeRequire = createRequire(import.meta.url);
const defaultModuleLoader: RuntimeModuleLoader = (moduleId) => {
  switch (moduleId) {
    case "@better-auth/oauth-provider": {
      return nodeRequire("@better-auth/oauth-provider");
    }
    case "better-auth": {
      return nodeRequire("better-auth");
    }
    case "better-auth/adapters/drizzle": {
      return nodeRequire("better-auth/adapters/drizzle");
    }
    case "better-auth/node": {
      return nodeRequire("better-auth/node");
    }
    case "better-auth/oauth2": {
      return nodeRequire("better-auth/oauth2");
    }
    case "better-auth/plugins/bearer": {
      return nodeRequire("better-auth/plugins/bearer");
    }
    case "better-auth/plugins/jwt": {
      return nodeRequire("better-auth/plugins/jwt");
    }
    default: {
      const neverModuleId: never = moduleId;
      return neverModuleId;
    }
  }
};

const loadRuntimeFactories = (loadModule: RuntimeModuleLoader): RuntimeFactories => {
  const oauthModule = readRuntimeModule(loadModule("@better-auth/oauth-provider"));
  return {
    bearer: readRuntimeFunction(
      readRuntimeModule(loadModule("better-auth/plugins/bearer")),
      "bearer",
    ),
    betterAuth: readRuntimeFunction(readRuntimeModule(loadModule("better-auth")), "betterAuth"),
    drizzleAdapter: readRuntimeFunction(
      readRuntimeModule(loadModule("better-auth/adapters/drizzle")),
      "drizzleAdapter",
    ),
    jwt: readRuntimeFunction(readRuntimeModule(loadModule("better-auth/plugins/jwt")), "jwt"),
    oauthDeviceAuthorization: readRuntimeFunction(oauthModule, "oauthDeviceAuthorization"),
    oauthProvider: readRuntimeFunction(oauthModule, "oauthProvider"),
    toNodeHandler: readRuntimeFunction(
      readRuntimeModule(loadModule("better-auth/node")),
      "toNodeHandler",
    ),
    verifyJwsAccessToken: readRuntimeFunction(
      readRuntimeModule(loadModule("better-auth/oauth2")),
      "verifyJwsAccessToken",
    ),
  };
};

const makeRuntimePlugins = (factories: RuntimeFactories, publicUrl: string): unknown[] => [
  invokeRuntimeFunction(factories.bearer, [{ requireSignature: true }]),
  invokeRuntimeFunction(factories.jwt, [{ disableSettingJwtHeader: true }]),
  invokeRuntimeFunction(factories.oauthProvider, [makeOAuthProviderOptions(publicUrl)]),
  invokeRuntimeFunction(factories.oauthDeviceAuthorization, []),
];

const makeBetterAuthRuntime = ({
  config,
  database,
  loadModule = defaultModuleLoader,
  secret,
}: BetterAuthRuntimeInput): BetterAuthRuntime => {
  const factories = loadRuntimeFactories(loadModule);
  const adapter = invokeRuntimeFunction(factories.drizzleAdapter, [
    database.authentication.database,
    { provider: "pg", schema: generatedAuthenticationSchema, transaction: true },
  ]);
  const runtime = invokeRuntimeFunction(factories.betterAuth, [
    {
      basePath: "/",
      baseURL: config.server.publicUrl,
      database: adapter,
      emailAndPassword: {
        autoSignIn: false,
        enabled: true,
        maxPasswordLength: MAXIMUM_PASSWORD_LENGTH,
        minPasswordLength: MINIMUM_PASSWORD_LENGTH,
      },
      logger: { disabled: true },
      plugins: makeRuntimePlugins(factories, config.server.publicUrl),
      secret,
      telemetry: { enabled: false },
    },
  ]);
  const betterAuthRequestListener: unknown = invokeRuntimeFunction(factories.toNodeHandler, [
    runtime,
  ]);
  if (!isRequestListener(betterAuthRequestListener)) {
    throw new TypeError("Better Auth Node handler must be callable");
  }
  return {
    oauthRequestListener: makeOAuthRequestListener(
      betterAuthRequestListener,
      config.server.publicUrl,
    ),
    resource: config.server.publicUrl,
    revokeAppleClientRefreshTokens: database.authentication.revokeAppleClientRefreshTokens.pipe(
      Effect.mapError(() => authenticationStoreUnavailable),
    ),
    runtime,
    verifyJwsAccessToken: factories.verifyJwsAccessToken,
  };
};

export { makeBetterAuthRuntime };
export type { AuthenticationDatabase, BetterAuthRuntime, BetterAuthRuntimeInput };
