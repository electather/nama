// oxlint-disable import/max-dependencies -- The application composition root wires every runtime owner exactly once.
import { NodeFileSystem } from "@effect/platform-node";
import { Cause, Clock, Effect, Exit, Layer } from "effect";

import { makeSetupAuthenticationLayer } from "./authentication/setup-coordinator.ts";
import { CatalogImport } from "./catalog/catalog-import.ts";
import { Config } from "./config/config.ts";
import { Database } from "./database/database.ts";
import { HttpServer } from "./http/http-server.ts";
import { RuntimeControl } from "./lifecycle/runtime-control.ts";
import {
  configuredLoggingLayer,
  logEvent,
  logFailure,
  logFatalEvent,
  writeBootstrapFailure,
} from "./logging/logging.ts";
import { PluginSupervisor } from "./plugin/supervisor.ts";
import { ProviderActivity, ProviderManagement } from "./provider/provider-management.ts";
import { BootstrapToken } from "./setup/bootstrap-token.ts";

const PRODUCTION_MIGRATIONS = `${import.meta.dirname}/../drizzle/`;

type Environment = Readonly<Record<string, string | undefined>>;

const loadConfiguration = (environment: Environment) => {
  const configLayer = Config.layer(environment).pipe(Layer.provide(NodeFileSystem.layer));
  return Effect.scoped(Config.pipe(Effect.provide(configLayer)));
};

const serverLayer = (
  config: Readonly<Config["Service"]>,
  migrationsFolder: string,
  emitStopping: () => Effect.Effect<void>,
) => {
  const configLayer = Layer.succeed(Config, config);
  const databaseLayer = Database.layer(migrationsFolder).pipe(Layer.provide(configLayer));
  const foundationLayer = Layer.mergeAll(configLayer, databaseLayer);
  const pluginFoundationLayer = PluginSupervisor.layer().pipe(Layer.provideMerge(foundationLayer));
  const providerActivityFoundationLayer = ProviderActivity.layer.pipe(
    Layer.provideMerge(pluginFoundationLayer),
  );
  const catalogFoundationLayer = CatalogImport.layer.pipe(
    Layer.provideMerge(providerActivityFoundationLayer),
  );
  const providerFoundationLayer = ProviderManagement.layer.pipe(
    Layer.provideMerge(catalogFoundationLayer),
  );
  return HttpServer.layer({ emitStopping }).pipe(
    Layer.provideMerge(makeSetupAuthenticationLayer(providerFoundationLayer, RuntimeControl.layer)),
  );
};

interface RunConfiguredOptions {
  readonly config: Readonly<Config["Service"]>;
  readonly migrationsFolder: string;
  readonly serverRuntimeLayer?: Layer.Layer<
    BootstrapToken | CatalogImport | HttpServer | RuntimeControl,
    unknown
  >;
  readonly startedAt: number;
  readonly writeLogLine?: (line: string) => void;
}

interface LifecycleState {
  lifecycleFailure: "runtime" | undefined;
  ready: boolean;
}

const runLifecycle = (state: LifecycleState, startedAt: number) =>
  Effect.gen(function* runLifecycleProgram() {
    const runtimeControl = yield* RuntimeControl;
    const httpServer = yield* HttpServer;
    const bootstrapToken = yield* BootstrapToken;
    const catalogImport = yield* CatalogImport;
    yield* bootstrapToken.activate.pipe(
      Effect.andThen(runtimeControl.markReady),
      Effect.andThen(catalogImport.start(runtimeControl.reportFatalFailure)),
      Effect.andThen(httpServer.advertiseLan),
    );
    const readyAt = yield* Clock.currentTimeMillis;
    yield* logEvent("server.ready", { durationMs: readyAt - startedAt });
    state.ready = true;
    yield* runtimeControl.awaitFatalFailure.pipe(
      Effect.catch((error) =>
        Effect.sync(() => {
          state.lifecycleFailure = "runtime";
        }).pipe(
          Effect.andThen(logFatalEvent("server.runtime_failed")),
          Effect.andThen(Effect.fail(error)),
        ),
      ),
    );
  });

const makeEmitStopping = (state: LifecycleState) => () =>
  Effect.suspend(() => {
    if (!state.ready) {
      return Effect.void;
    }
    return logEvent("server.stopping");
  });

const logStoppedOnInterruption = (state: LifecycleState) => (exit: Exit.Exit<unknown, unknown>) => {
  if (state.ready && Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)) {
    return logEvent("server.stopped");
  }
  return Effect.void;
};

const classifyLifecycleFailure = (state: LifecycleState, cause: Readonly<Cause.Cause<unknown>>) => {
  if (state.lifecycleFailure === "runtime" || Cause.hasInterruptsOnly(cause)) {
    return Effect.failCause(cause);
  }
  if (state.ready) {
    return logFailure(cause, "server.shutdown_failed").pipe(
      Effect.andThen(Effect.failCause(cause)),
    );
  }
  return logFailure(cause, "server.start_failed").pipe(Effect.andThen(Effect.failCause(cause)));
};

const runConfigured = ({
  config,
  migrationsFolder,
  serverRuntimeLayer,
  startedAt,
  writeLogLine,
}: RunConfiguredOptions) => {
  const state: LifecycleState = { lifecycleFailure: undefined, ready: false };
  const emitStopping = makeEmitStopping(state);
  const runtimeLayer = serverRuntimeLayer ?? serverLayer(config, migrationsFolder, emitStopping);
  return runLifecycle(state, startedAt).pipe(
    Effect.provide(runtimeLayer),
    Effect.onExit(logStoppedOnInterruption(state)),
    Effect.catchCause((cause) => classifyLifecycleFailure(state, cause)),
    Effect.provide(configuredLoggingLayer(config, writeLogLine)),
  );
};

const makeApp = (environment: Environment, migrationsFolder: string = PRODUCTION_MIGRATIONS) =>
  Effect.gen(function* applicationProgram() {
    const startedAt = yield* Clock.currentTimeMillis;
    return yield* Effect.matchCauseEffect(loadConfiguration(environment), {
      onFailure: (cause: Readonly<Cause.Cause<unknown>>) =>
        Effect.sync(() => {
          writeBootstrapFailure(cause);
        }).pipe(Effect.andThen(Effect.failCause(cause))),
      onSuccess: (config: Readonly<Config["Service"]>) =>
        runConfigured({ config, migrationsFolder, startedAt }),
    });
  });

const app = makeApp(process.env);

export type { RunConfiguredOptions };
export { app, runConfigured };
