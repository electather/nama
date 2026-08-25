// oxlint-disable import/max-dependencies -- The complete Database test double includes the catalog and provider persistence seams.
import { drizzle } from "drizzle-orm/node-postgres";
import { Context, Effect, Exit, Layer, Logger, Option, Redacted, Scope } from "effect";

import { Authentication } from "../../authentication/authentication-service.ts";
import type { AuthenticationService } from "../../authentication/authentication-service.ts";
import { BetterAuthAdapter } from "../../authentication/better-auth-adapter.ts";
import type { BetterAuthAdapterService } from "../../authentication/better-auth-adapter.ts";
import { SetupCoordinator } from "../../authentication/setup-coordinator.ts";
import type { SetupCoordinatorService } from "../../authentication/setup-coordinator.ts";
import { Config } from "../../config/config.ts";
import { Database } from "../../database/database.ts";
import { databaseSchema } from "../../database/schema.ts";
import {
  unusedCatalogPersistence,
  unusedCatalogQueries,
} from "../../database/tests/catalog-persistence.test-support.ts";
import { unusedProviderPersistence } from "../../database/tests/provider-persistence.test-support.ts";
import { RuntimeControl } from "../../lifecycle/runtime-control.ts";
import { ProviderManagement } from "../../provider/provider-management.ts";
import { HttpServer } from "../http-server.ts";
import { HOST, reservePortOn } from "./network.test-support.ts";

const SERVER_MAX_CONNECTIONS = 1;
const FIRST_LOG_MESSAGE_PART = 0;
const SINGLE_LOG_MESSAGE_PART = 1;

const noSignInLimit: Effect.Effect<number | undefined> = Effect.succeed(
  Option.getOrUndefined(Option.none<number>()),
);

const formattedHost = (host: string): string => {
  if (host.includes(":")) {
    return `[${host}]`;
  }
  return host;
};

const serverConfig = (port: number, options: ServerLayerOptions) => {
  const host = formattedHost(options.host ?? HOST);
  return Config.of({
    database: Object.freeze({
      maxConnections: SERVER_MAX_CONNECTIONS,
      url: Redacted.make("postgres://unused"),
    }),
    logging: Object.freeze({ level: "info" as const }),
    security: Object.freeze({ masterKey: Redacted.make("unused") }),
    server: Object.freeze({
      bind: `${host}:${port}`,
      lanDiscovery: options.lanDiscovery ?? false,
      publicUrl: `http://${host}:${port}/`,
    }),
  });
};

const messageText = (message: unknown): string => {
  if (Array.isArray(message)) {
    const parts = message.map(String);
    return parts.join(" ");
  }
  return String(message);
};

interface ServerLayerOptions {
  readonly authentication?: AuthenticationService;
  readonly betterAuthAdapter?: BetterAuthAdapterService;
  readonly emitStopping?: () => Effect.Effect<void>;
  readonly host?: string;
  readonly lanDiscovery?: boolean;
  readonly messages?: string[];
  readonly records?: unknown[];
  readonly runtimeControl?: RuntimeControl["Service"];
  readonly providerManagement?: ProviderManagement["Service"];
  readonly setupCoordinator?: SetupCoordinatorService;
}

const testAuthenticationDatabase: Database["Service"]["authentication"]["database"] = drizzle(
  "postgres://unused",
  { schema: databaseSchema },
);

const defaultAuthentication = Authentication.of({
  approveDeviceAuthorization: () => Effect.die("unexpected device authorization approval"),
  consumeGlobalSignInBudget: noSignInLimit,
  consumeIdentitySignInBudget: () => noSignInLimit,
  resolveAdministrator: () => Effect.die("unexpected administrator resolution"),
  resolveConsumerPrincipal: () => Effect.die("unexpected consumer principal resolution"),
  resolvePrincipal: () => Effect.die("unexpected principal resolution"),
  revokeAppleClientRefreshTokens: Effect.die("unexpected Apple client revocation"),
  signIn: () => Effect.die("unexpected administrator sign-in"),
  signOut: () => Effect.die("unexpected administrator sign-out"),
});
const defaultBetterAuthAdapter = BetterAuthAdapter.of({
  approveDeviceAuthorization: () => Effect.die("unexpected device authorization approval"),
  createAdministrator: () => Effect.die("unexpected administrator creation"),
  oauthRequestListener: () => {},
  resolveBearer: () => Effect.die("unexpected bearer resolution"),
  resolveOAuthAccess: () => Effect.die("unexpected OAuth access resolution"),
  revokeAppleClientRefreshTokens: Effect.die("unexpected Apple client revocation"),
  signIn: () => Effect.die("unexpected administrator sign-in"),
  signOut: () => Effect.die("unexpected administrator sign-out"),
});

const defaultRuntimeControl = RuntimeControl.of({
  awaitFatalFailure: Effect.never,
  isReady: Effect.succeed(true),
  markReady: Effect.void,
  reportFatalFailure: () => Effect.succeed(false),
});

const defaultSetupCoordinator = SetupCoordinator.of({
  createAdministrator: () => Effect.die("unexpected administrator creation"),
  getStatus: Effect.succeed(true),
});

const defaultProviderManagement = ProviderManagement.of({
  createProviderInstance: () => Effect.die("unexpected provider instance creation"),
  deleteProviderInstance: () => Effect.die("unexpected provider instance deletion"),
  getProviderInstance: () => Effect.die("unexpected provider instance read"),
  listProviderInstances: () => Effect.die("unexpected provider instance list"),
  listProviderTypes: () => Effect.succeed({ nextPageToken: "", providerTypes: [] }),
  runProviderActivity: <Success, Failure, Requirements>(
    _providerInstanceId: string,
    activity: Effect.Effect<Success, Failure, Requirements>,
  ) => activity,
  testProviderConfiguration: () => Effect.die("unexpected provider configuration test"),
  testProviderInstance: () => Effect.die("unexpected provider instance test"),
  updateProviderInstance: () => Effect.die("unexpected provider instance update"),
});

const makeHttpServerTestDependencies = (
  config: Config["Service"],
  database: Database["Service"],
  runtimeControlLayer: Layer.Layer<RuntimeControl>,
) =>
  Layer.mergeAll(
    Layer.succeed(BetterAuthAdapter, defaultBetterAuthAdapter),
    Layer.succeed(Authentication, defaultAuthentication),
    Layer.succeed(Config, config),
    Layer.succeed(Database, database),
    Layer.succeed(ProviderManagement, defaultProviderManagement),
    runtimeControlLayer,
    Layer.succeed(SetupCoordinator, defaultSetupCoordinator),
  );

const makeDatabase = (
  checkReadiness: Database["Service"]["checkReadiness"],
  initialization: Database["Service"]["initialization"] = "setup-eligible",
) =>
  Database.of({
    authentication: {
      completeInitialization: () => Effect.die("unexpected database initialization"),
      database: testAuthenticationDatabase,
      revokeAppleClientRefreshTokens: Effect.die("unexpected Apple client revocation"),
    },
    catalog: unusedCatalogPersistence,
    catalogQueries: unusedCatalogQueries,
    checkReadiness,
    initialization,
    providers: unusedProviderPersistence,
  });

const makeHttpServerLayer = (emitStopping: (() => Effect.Effect<void>) | undefined) => {
  if (emitStopping === undefined) {
    return HttpServer.layer();
  }
  return HttpServer.layer({ emitStopping });
};

const serverLayerWithDatabase = (
  port: number,
  databaseLayer: Layer.Layer<Database>,
  options: ServerLayerOptions = {},
) => {
  const messages = options.messages ?? [];
  const records = options.records ?? [];
  const capture = Logger.make<unknown, void>(({ message }) => {
    messages.push(messageText(message));
    if (Array.isArray(message) && message.length === SINGLE_LOG_MESSAGE_PART) {
      records.push(message[FIRST_LOG_MESSAGE_PART]);
    } else {
      records.push(message);
    }
  });
  const dependencies = Layer.mergeAll(
    Layer.succeed(BetterAuthAdapter, options.betterAuthAdapter ?? defaultBetterAuthAdapter),
    Layer.succeed(Authentication, options.authentication ?? defaultAuthentication),
    Layer.succeed(Config, serverConfig(port, options)),
    databaseLayer,
    Logger.layer([capture]),
    Layer.succeed(RuntimeControl, options.runtimeControl ?? defaultRuntimeControl),
    Layer.succeed(ProviderManagement, options.providerManagement ?? defaultProviderManagement),
    Layer.succeed(SetupCoordinator, options.setupCoordinator ?? defaultSetupCoordinator),
  );
  return makeHttpServerLayer(options.emitStopping).pipe(Layer.provide(dependencies));
};

const serverLayer = (
  port: number,
  database: Database["Service"],
  options: ServerLayerOptions = {},
) => serverLayerWithDatabase(port, Layer.succeed(Database, database), options);

const startServer = (database: Database["Service"], options: ServerLayerOptions = {}) =>
  Effect.gen(function* startedServer() {
    const host = options.host ?? HOST;
    const port = yield* reservePortOn(host);
    const scope = yield* Scope.make();
    yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
    const context = yield* Layer.buildWithScope(serverLayer(port, database, options), scope);
    const httpServer = Context.get(context, HttpServer);
    return {
      advertiseLan: httpServer.advertiseLan,
      close: Scope.close(scope, Exit.void),
      origin: `http://${formattedHost(host)}:${port}`,
    };
  });

export {
  makeDatabase,
  makeHttpServerTestDependencies,
  serverLayer,
  serverLayerWithDatabase,
  startServer,
};
export type { ServerLayerOptions };
