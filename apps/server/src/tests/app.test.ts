import { expect, it } from "@effect/vitest";
import { Deferred, Effect, Exit, Fiber, Layer, Redacted } from "effect";

import { runConfigured } from "../app.ts";
import { CatalogImport } from "../catalog/catalog-import-live.ts";
import { Config } from "../config/config.ts";
import { HttpServer } from "../http/http-server.ts";
import { RuntimeControl } from "../lifecycle/runtime-control.ts";
import { makeBootstrapToken, BootstrapToken } from "../setup/bootstrap-token.ts";
import {
  RUNTIME_FAILURE,
  expectBootstrapActivationFailure,
  expectFatalRuntimeFailure,
  expectLifecycleOrder,
  makeMarkReadyWithFatalReport,
  makeRecordedBootstrapToken,
} from "./app.test-support.ts";
import type { ServerRuntimeLayer } from "./app.test-support.ts";

const TOKEN_BYTES = 32;
const STARTED_AT = 0;

const config = Config.of({
  database: Object.freeze({ maxConnections: 1, url: Redacted.make("postgres://secret") }),
  logging: Object.freeze({ level: "info" as const }),
  security: Object.freeze({ masterKey: Redacted.make("master-secret") }),
  server: Object.freeze({
    bind: "127.0.0.1:8080",
    lanDiscovery: false,
    publicUrl: "http://127.0.0.1:8080/",
  }),
});

const fatalLoggingConfig = Config.of({
  ...config,
  logging: Object.freeze({ level: "fatal" as const }),
});

type LifecycleCallback = () => void;

const discardLogLine = (_line: string): void => {};
const makeCatalogImportLayer = (onStart: LifecycleCallback = () => {}) =>
  Layer.succeed(
    CatalogImport,
    CatalogImport.of({
      start: () => Effect.sync(onStart),
    }),
  );

const makeSuccessfulBootstrapToken = () =>
  makeBootstrapToken("setup-eligible", {
    randomBytes: () => Buffer.alloc(TOKEN_BYTES),
    writeLine: (line) => Buffer.byteLength(line),
  });

const makeHttpServerLayer = (
  onAcquire: LifecycleCallback,
  onRelease: LifecycleCallback,
  onAdvertise: LifecycleCallback = () => {},
) => {
  const acquire = Effect.sync(() => {
    onAcquire();
    const service = {
      advertiseLan: Effect.sync(onAdvertise),
      listening: true as const,
    };
    return HttpServer.of(service);
  });
  const release = Effect.sync(onRelease);
  return Layer.effect(
    HttpServer,
    Effect.acquireRelease(acquire, () => release),
  );
};

const makeBootstrapActivationFailureFixture = () => {
  const state = { markedReady: false, released: false };
  const bootstrapToken = makeBootstrapToken("setup-eligible", {
    randomBytes: () => Buffer.alloc(TOKEN_BYTES),
    writeLine: () => {
      throw new Error("raw-output-failure");
    },
  });
  const runtimeControl = RuntimeControl.of({
    awaitFatalFailure: Effect.never,
    isReady: Effect.succeed(false),
    markReady: Effect.sync(() => {
      state.markedReady = true;
    }),
    reportFatalFailure: () => Effect.succeed(false),
  });
  const listenerLayer = makeHttpServerLayer(
    () => {},
    () => {
      state.released = true;
    },
  );
  const runtimeLayer = Layer.mergeAll(
    Layer.succeed(BootstrapToken, BootstrapToken.of(bootstrapToken)),
    makeCatalogImportLayer(),
    listenerLayer,
    Layer.succeed(RuntimeControl, runtimeControl),
  );
  return {
    runtimeLayer,
    wasMarkedReady: () => state.markedReady,
    wasReleased: () => state.released,
  };
};

const makeLifecycleOrderFixture = () =>
  Effect.gen(function* lifecycleOrderFixture() {
    const events: string[] = [];
    let markedReady = false;
    const fatalFailure = yield* Deferred.make<never, typeof RUNTIME_FAILURE>();
    const readyMarked = yield* Deferred.make<void>();
    const bootstrapToken = makeSuccessfulBootstrapToken();
    const runtimeControl = RuntimeControl.of({
      awaitFatalFailure: Deferred.await(fatalFailure),
      isReady: Effect.sync(() => markedReady),
      markReady: Effect.sync(() => {
        markedReady = true;
        events.push("runtime.ready");
        Deferred.doneUnsafe(readyMarked, Effect.void);
      }),
      reportFatalFailure: () => Effect.succeed(false),
    });
    const listenerLayer = makeHttpServerLayer(
      () => {
        events.push("listener.bound");
      },
      () => {
        events.push("listener.released");
      },
      () => {
        events.push("lan.started");
      },
    );
    const activatedBootstrapToken = makeRecordedBootstrapToken(bootstrapToken, () => {
      events.push("bootstrap.activated");
    });
    const runtimeLayer = Layer.mergeAll(
      listenerLayer,
      makeCatalogImportLayer(() => {
        events.push("catalog.started");
      }),
      Layer.succeed(BootstrapToken, activatedBootstrapToken),
      Layer.succeed(RuntimeControl, runtimeControl),
    );
    return {
      awaitReady: Deferred.await(readyMarked),
      completeFatal: Deferred.done(fatalFailure, Exit.fail(RUNTIME_FAILURE)).pipe(Effect.asVoid),
      events,
      runtimeLayer,
    };
  });

const makeFatalRuntimeFixture = () =>
  Effect.gen(function* fatalRuntimeFixture() {
    const state = { fatalReported: false, markedReady: false, ready: false, released: false };
    const fatalFailure = yield* Deferred.make<never, typeof RUNTIME_FAILURE>();
    const bootstrapToken = makeSuccessfulBootstrapToken();
    const reportFatalFailure = (_cause: unknown) =>
      Effect.sync(() => {
        if (state.fatalReported) {
          return false;
        }
        state.fatalReported = true;
        state.ready = false;
        Deferred.doneUnsafe(fatalFailure, Effect.fail(RUNTIME_FAILURE));
        return true;
      });
    const markReady = makeMarkReadyWithFatalReport(state, reportFatalFailure);
    const runtimeControl = RuntimeControl.of({
      awaitFatalFailure: Deferred.await(fatalFailure),
      isReady: Effect.sync(() => state.ready),
      markReady,
      reportFatalFailure,
    });
    const listenerLayer = makeHttpServerLayer(
      () => {},
      () => {
        state.released = true;
      },
    );
    const bootstrapLayer = Layer.succeed(BootstrapToken, BootstrapToken.of(bootstrapToken));
    const runtimeLayer = Layer.mergeAll(
      makeCatalogImportLayer(),
      bootstrapLayer,
      listenerLayer,
      Layer.succeed(RuntimeControl, runtimeControl),
    );
    return {
      runtimeLayer,
      wasFatalReported: () => state.fatalReported,
      wasMarkedReady: () => state.markedReady,
      wasReleased: () => state.released,
    };
  });

const runTestApp = (
  runtimeLayer: ServerRuntimeLayer,
  writeLogLine: (line: string) => void,
  testConfig: Readonly<Config["Service"]> = config,
) =>
  runConfigured({
    config: testConfig,
    migrationsFolder: "unused",
    serverRuntimeLayer: runtimeLayer,
    startedAt: STARTED_AT,
    writeLogLine,
  });

it.effect("emits only one tagged startup failure after bootstrap activation fails", () =>
  Effect.gen(function* bootstrapActivationFailureTest() {
    const lines: string[] = [];
    const fixture = makeBootstrapActivationFailureFixture();
    const writeLogLine = (line: string): void => {
      lines.push(line);
    };
    const exit = yield* Effect.exit(runTestApp(fixture.runtimeLayer, writeLogLine));

    expectBootstrapActivationFailure(exit, fixture, lines);
  }),
);

it.effect("starts catalog import and LAN advertisement after runtime readiness", () =>
  Effect.gen(function* lifecycleOrderTest() {
    const fixture = yield* makeLifecycleOrderFixture();
    const root = yield* Effect.forkChild(runTestApp(fixture.runtimeLayer, discardLogLine));

    return yield* Effect.gen(function* observeLifecycleOrder() {
      yield* fixture.awaitReady;
      yield* Effect.yieldNow;
      expect(fixture.events).toEqual([
        "listener.bound",
        "bootstrap.activated",
        "runtime.ready",
        "catalog.started",
        "lan.started",
      ]);
      yield* fixture.completeFatal;
      expectLifecycleOrder(yield* Fiber.await(root), fixture.events);
    }).pipe(Effect.ensuring(Fiber.interrupt(root)));
  }),
);

it.effect("logs and tears down exactly once when runtime control fails after readiness", () =>
  Effect.gen(function* fatalRuntimeFailureTest() {
    const lines: string[] = [];
    const fixture = yield* makeFatalRuntimeFixture();
    const writeLogLine = (line: string): void => {
      lines.push(line);
    };
    const root = yield* Effect.forkChild(
      runTestApp(fixture.runtimeLayer, writeLogLine, fatalLoggingConfig),
    );

    return yield* Effect.gen(function* observeFatalRuntimeFailure() {
      expectFatalRuntimeFailure(yield* Fiber.await(root), fixture, lines);
    }).pipe(Effect.ensuring(Fiber.interrupt(root)));
  }),
);
