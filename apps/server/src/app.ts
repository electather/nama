import { NodeFileSystem } from "@effect/platform-node";
import { Cause, Clock, Effect, Exit, Layer } from "effect";

import { Config } from "./config/config.ts";
import { Database } from "./database/database.ts";
import { HttpServer } from "./http/http-server.ts";
import {
  configuredLoggingLayer,
  logEvent,
  logFailure,
  writeBootstrapFailure,
} from "./logging/logging.ts";

const PRODUCTION_MIGRATIONS = `${import.meta.dirname}/../drizzle/`;

type Environment = Readonly<Record<string, string | undefined>>;

const loadConfiguration = (environment: Environment) => {
  const configLayer = Config.layer(environment).pipe(Layer.provide(NodeFileSystem.layer));
  return Effect.scoped(Config.pipe(Effect.provide(configLayer)));
};

const serverLayer = (config: Readonly<Config["Service"]>, migrationsFolder: string) => {
  const configLayer = Layer.succeed(Config, config);
  const databaseLayer = Database.layer(migrationsFolder).pipe(Layer.provide(configLayer));
  return HttpServer.layer().pipe(Layer.provide(Layer.mergeAll(configLayer, databaseLayer)));
};

const runConfigured = (
  config: Readonly<Config["Service"]>,
  migrationsFolder: string,
  startedAt: number,
) => {
  const state = { ready: false };
  const runServer = Effect.gen(function* runServerProgram() {
    yield* HttpServer;
    const readyAt = yield* Clock.currentTimeMillis;
    yield* logEvent("server.ready", { durationMs: readyAt - startedAt });
    state.ready = true;
    return yield* Effect.never;
  });

  return runServer.pipe(
    Effect.provide(serverLayer(config, migrationsFolder)),
    Effect.onExit((exit) => {
      if (state.ready && Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)) {
        return logEvent("server.stopped");
      }
      return Effect.void;
    }),
    Effect.catchCause((cause: Readonly<Cause.Cause<unknown>>) => {
      if (Cause.hasInterruptsOnly(cause)) {
        return Effect.failCause(cause);
      }
      if (state.ready) {
        return logFailure(cause, "server.shutdown_failed").pipe(
          Effect.andThen(Effect.failCause(cause)),
        );
      }
      return logFailure(cause, "server.start_failed").pipe(Effect.andThen(Effect.failCause(cause)));
    }),
    Effect.provide(configuredLoggingLayer(config)),
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
        runConfigured(config, migrationsFolder, startedAt),
    });
  });

const app = makeApp(process.env);

export { app };
