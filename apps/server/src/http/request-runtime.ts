import { Effect, Fiber, Layer, Logger, ManagedRuntime, References } from "effect";
import type { Exit } from "effect";

import { Database } from "../database/database.ts";

interface RequestRuntime {
  readonly awaitRequests: Effect.Effect<void>;
  readonly interruptRequests: Effect.Effect<void>;
  readonly run: (
    effect: Effect.Effect<unknown, unknown>,
    onExit: (exit: Exit.Exit<unknown, unknown>) => void,
  ) => void;
}

const makeRequestRuntime = (database: Database["Service"]) =>
  Effect.gen(function* makeRequestRuntimeBridge() {
    const loggers = yield* Effect.service(Logger.CurrentLoggers);
    const minimumLogLevel = yield* References.MinimumLogLevel;
    const requestLayer = Layer.mergeAll(
      Layer.succeed(Database, database),
      Layer.succeed(Logger.CurrentLoggers, loggers),
      Layer.succeed(References.MinimumLogLevel, minimumLogLevel),
    );
    const managedRuntime = ManagedRuntime.make(requestLayer);
    const activeRequests = new Set<Fiber.Fiber<unknown, unknown>>();
    yield* Effect.addFinalizer(() => managedRuntime.disposeEffect);
    yield* Effect.promise(() => managedRuntime.runPromise(Database));

    return {
      awaitRequests: Fiber.awaitAll(activeRequests).pipe(Effect.asVoid),
      interruptRequests: Fiber.interruptAll(activeRequests),
      run: (effect, onExit) => {
        const fiber = managedRuntime.runFork(effect);
        activeRequests.add(fiber);
        fiber.addObserver((exit) => {
          activeRequests.delete(fiber);
          onExit(exit);
        });
      },
    } satisfies RequestRuntime;
  });

export { makeRequestRuntime };
export type { RequestRuntime };
