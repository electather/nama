// oxlint-disable import/max-dependencies, eslint/max-lines-per-function, eslint/max-statements, eslint/no-magic-numbers, eslint/prefer-destructuring, unicorn/max-nested-calls -- Integration scenarios keep policy values and ordered process transitions visible.
// oxlint-disable eslint/no-await-in-loop, eslint/init-declarations, typescript/consistent-return, typescript/no-unsafe-type-assertion, typescript/no-inferrable-types, unicorn/no-await-expression-member -- Polling and trusted fixture records are deliberate test-only boundaries.
import { spawn as spawnChild } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  watch,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { Code, ConnectError, createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import { expect, it } from "@effect/vitest";
import { HealthService, ServingStatus } from "@nama/api/nama/plugin/v1/health_pb.js";
import { PluginService } from "@nama/api/nama/plugin/v1/plugin_pb.js";
import { Cause, Context, Effect, Exit, Fiber, Layer, Redacted, Scope } from "effect";
import { TestClock } from "effect/testing";

import { Config } from "../../src/config/config.ts";
import { configuredLoggingLayer } from "../../src/logging/logging.ts";
import { PluginSupervisor } from "../../src/plugin/supervisor.ts";
import type { PluginStderrEventDeclaration } from "../../src/plugin/supervisor.ts";

const FIXTURE_PATH = join(import.meta.dirname, "fixtures/plugin-subprocess.mjs");
const loggingConfig = Config.of({
  database: Object.freeze({ maxConnections: 1, url: Redacted.make("unused") }),
  logging: Object.freeze({ level: "info" as const }),
  security: Object.freeze({ masterKey: Redacted.make("unused") }),
  server: Object.freeze({
    bind: "127.0.0.1:8080",
    publicUrl: "http://127.0.0.1:8080/",
  }),
});
const CALL_DEADLINE_MILLISECONDS = 1000;

interface LaunchRecord {
  readonly argumentsExcludeLaunchMaterial: boolean;
  readonly bearer: string;
  readonly environmentEmpty: boolean;
  readonly launchNumber: number;
  readonly pid: number;
  readonly seededEnvironmentAbsent: boolean;
  readonly socketPath: string;
}

const SEEDED_PARENT_ENVIRONMENT: Readonly<Record<string, string>> = Object.freeze({
  NAMA_DATABASE_URL: "postgres://database-secret",
  NAMA_MASTER_KEY: "master-key-secret",
  NAMA_PLUGIN_LAUNCH_SECRET: "launch-secret",
  NAMA_PROVIDER_CREDENTIAL: "provider-credential-secret",
});
const acquireSeededParentEnvironment = Effect.acquireRelease(
  Effect.sync(() => {
    const previous: Record<string, string | undefined> = {};
    for (const [name, value] of Object.entries(SEEDED_PARENT_ENVIRONMENT)) {
      previous[name] = process.env[name];
      process.env[name] = value;
    }
    return previous;
  }),
  (previous) =>
    Effect.sync(() => {
      for (const [name, value] of Object.entries(previous)) {
        if (value === undefined) {
          delete process.env[name];
        } else {
          process.env[name] = value;
        }
      }
    }),
);

const withControlDirectory = <Success, Failure, Requirements>(
  use: (controlDirectory: string) => Effect.Effect<Success, Failure, Requirements>,
) =>
  Effect.acquireUseRelease(
    Effect.promise(() => mkdtemp(join(tmpdir(), "nama-plugin-test-"))),
    use,
    (controlDirectory) =>
      Effect.promise(() => rm(controlDirectory, { force: true, recursive: true })),
  );

const readLaunchRecords = (controlDirectory: string) =>
  Effect.promise(async () => {
    const content = await readFile(join(controlDirectory, "launches.ndjson"), "utf8");
    return content
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as LaunchRecord);
  });

const awaitFileLineCount = (
  controlDirectory: string,
  filename: string,
  expectedCount: number,
): Effect.Effect<readonly string[], unknown> =>
  Effect.tryPromise({
    catch: (error) => error,
    try: async (signal) => {
      const path = join(controlDirectory, filename);
      const readLines = async (): Promise<readonly string[]> => {
        try {
          return (await readFile(path, "utf8")).trim().split("\n").filter(Boolean);
        } catch (error) {
          if (
            typeof error === "object" &&
            error !== null &&
            "code" in error &&
            error.code === "ENOENT"
          ) {
            return [];
          }
          throw error;
        }
      };
      const current = await readLines();
      if (current.length >= expectedCount) {
        return current;
      }
      for await (const event of watch(controlDirectory, { signal })) {
        if (event.filename === filename) {
          const lines = await readLines();
          if (lines.length >= expectedCount) {
            return lines;
          }
        }
      }
      throw new Error("fixture control watch ended");
    },
  });

const awaitLaunchCount = (controlDirectory: string, expectedCount: number) =>
  awaitFileLineCount(controlDirectory, "launches.ndjson", expectedCount).pipe(
    Effect.map((lines) => lines.map((line) => JSON.parse(line) as LaunchRecord)),
  );

const awaitProcessExit = (processId: number) =>
  Effect.promise(async () => {
    while (true) {
      try {
        process.kill(processId, 0);
      } catch (error) {
        if (
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "ESRCH"
        ) {
          return;
        }
        throw error;
      }
      const nextTurn = Promise.withResolvers<void>();
      setImmediate(nextTurn.resolve);
      await nextTurn.promise;
    }
  });

const awaitPathRemoval = (path: string) =>
  Effect.promise(async () => {
    while (true) {
      try {
        await lstat(path);
      } catch (error) {
        if (
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "ENOENT"
        ) {
          return;
        }
        throw error;
      }
      const nextTurn = Promise.withResolvers<void>();
      setImmediate(nextTurn.resolve);
      await nextTurn.promise;
    }
  });

const directHealthCheck = (socketPath: string, authorization?: string) => {
  const client = createClient(
    HealthService,
    createConnectTransport({
      baseUrl: "http://localhost",
      httpVersion: "1.1",
      nodeOptions: { socketPath },
    }),
  );
  const headers = new Headers();
  if (authorization !== undefined) {
    headers.set("authorization", authorization);
  }
  return Effect.tryPromise({
    catch: (error) => error,
    try: () => client.check({}, { headers }),
  });
};

const awaitCondition = (condition: () => boolean) =>
  Effect.promise(async () => {
    while (!condition()) {
      const nextTurn = Promise.withResolvers<void>();
      setImmediate(nextTurn.resolve);
      await nextTurn.promise;
    }
  });
const fixtureDescriptor = (
  controlDirectory: string,
  mode: string = "normal",
  stderrEvents: readonly PluginStderrEventDeclaration[] = [],
) => ({
  arguments: [FIXTURE_PATH, controlDirectory, mode],
  executable: process.execPath,
  expectedProviderType: "fixture",
  stderrEvents,
});

const descriptor = {
  arguments: [] as const,
  executable: "relative-plugin",
  expectedProviderType: "fixture",
  stderrEvents: [] as const,
};

it.effect("rejects a relative plugin executable before launch", () =>
  Effect.scoped(
    Effect.gen(function* relativeExecutableTest() {
      const supervisor = yield* PluginSupervisor;
      const failure = yield* supervisor.supervise(descriptor).pipe(Effect.flip);

      expect(failure).toMatchObject({
        _tag: "PluginUnavailable",
        reason: "executable_invalid",
      });
    }).pipe(Effect.provide(PluginSupervisor.layer())),
  ),
);

it.live("acquires a valid handle without creating launch resources", () =>
  withControlDirectory((controlDirectory) =>
    Effect.suspend(() => {
      let spawnAttempts = 0;
      const spawnProcess = ((...arguments_: Parameters<typeof spawnChild>) => {
        spawnAttempts += 1;
        return Reflect.apply(spawnChild, undefined, arguments_);
      }) as typeof spawnChild;
      return Effect.scoped(
        Effect.gen(function* lazySupervisionTest() {
          const supervisor = yield* PluginSupervisor;
          yield* supervisor.supervise(fixtureDescriptor(controlDirectory));
          yield* Effect.sleep(100);
          expect(spawnAttempts).toBe(0);
          const absentLaunchFile = yield* Effect.tryPromise({
            catch: (error) => error,
            try: () => readFile(join(controlDirectory, "launches.ndjson")),
          }).pipe(Effect.flip);

          expect(absentLaunchFile).toMatchObject({ code: "ENOENT" });
        }).pipe(Effect.provide(PluginSupervisor.layer({ spawnProcess }))),
      );
    }),
  ),
);

it.live("accepts opaque provider-instance IDs", () =>
  withControlDirectory((controlDirectory) =>
    Effect.scoped(
      Effect.gen(function* opaqueProviderInstanceIdTest() {
        const supervisor = yield* PluginSupervisor;
        const plugin = yield* supervisor.supervise({
          ...fixtureDescriptor(controlDirectory),
          providerInstanceId: "1",
        });

        const health = yield* plugin.call(
          HealthService.method.check,
          {},
          CALL_DEADLINE_MILLISECONDS,
        );

        expect(health.status).toBe(ServingStatus.SERVING);
      }).pipe(Effect.provide(PluginSupervisor.layer())),
    ),
  ),
);

it.live("launches the authenticated fixture without ambient authority", () =>
  withControlDirectory((controlDirectory) =>
    Effect.scoped(
      Effect.gen(function* authenticatedLaunchTest() {
        yield* acquireSeededParentEnvironment;
        const supervisor = yield* PluginSupervisor;
        const plugin = yield* supervisor.supervise(fixtureDescriptor(controlDirectory));
        const response = yield* plugin.call(
          PluginService.method.getConnection,
          {},
          CALL_DEADLINE_MILLISECONDS,
        );
        const launches = yield* readLaunchRecords(controlDirectory);

        expect(response.connection?.status).toBe(1);
        expect(launches).toHaveLength(1);
        expect(launches[0]).toMatchObject({
          argumentsExcludeLaunchMaterial: true,
          environmentEmpty: true,
          seededEnvironmentAbsent: true,
        });
        expect(launches[0]?.bearer).toMatch(/^[A-Za-z0-9_-]{43}$/u);
      }).pipe(Effect.provide(PluginSupervisor.layer())),
    ),
  ),
);

it.effect("retires a ready plugin after 30 idle seconds and starts a fresh incarnation", () =>
  withControlDirectory((controlDirectory) =>
    Effect.scoped(
      Effect.gen(function* idleRetirementTest() {
        const supervisor = yield* PluginSupervisor;
        const plugin = yield* supervisor.supervise(fixtureDescriptor(controlDirectory));
        yield* plugin.call(HealthService.method.check, {}, CALL_DEADLINE_MILLISECONDS);
        const firstLaunch = (yield* awaitLaunchCount(controlDirectory, 1))[0];
        if (firstLaunch === undefined) {
          return yield* Effect.die("fixture launch record missing");
        }

        yield* TestClock.adjust(29_999);
        expect(() => process.kill(firstLaunch.pid, 0)).not.toThrow();
        expect(yield* readLaunchRecords(controlDirectory)).toHaveLength(1);

        yield* TestClock.adjust(1);
        const response = yield* plugin.call(
          PluginService.method.getConnection,
          {},
          CALL_DEADLINE_MILLISECONDS,
        );
        const launches = yield* readLaunchRecords(controlDirectory);
        const secondLaunch = launches[1];
        if (secondLaunch === undefined) {
          return yield* Effect.die("replacement launch record missing");
        }
        const retiredLaunchFailure = yield* Effect.tryPromise({
          catch: (error) => error,
          try: () => lstat(dirname(firstLaunch.socketPath)),
        }).pipe(Effect.flip);

        expect(response.connection?.status).toBe(1);
        expect(launches).toHaveLength(2);
        expect(secondLaunch.bearer).not.toBe(firstLaunch.bearer);
        expect(secondLaunch.socketPath).not.toBe(firstLaunch.socketPath);
        expect(retiredLaunchFailure).toMatchObject({ code: "ENOENT" });
      }).pipe(Effect.provide(PluginSupervisor.layer())),
    ),
  ),
);

it.effect("resets the full idle interval when demand returns before expiry", () =>
  withControlDirectory((controlDirectory) =>
    Effect.scoped(
      Effect.gen(function* idleResetTest() {
        const supervisor = yield* PluginSupervisor;
        const plugin = yield* supervisor.supervise(fixtureDescriptor(controlDirectory));
        yield* plugin.call(HealthService.method.check, {}, CALL_DEADLINE_MILLISECONDS);
        const firstLaunch = (yield* awaitLaunchCount(controlDirectory, 1))[0];
        if (firstLaunch === undefined) {
          return yield* Effect.die("fixture launch record missing");
        }

        yield* TestClock.adjust(29_999);
        yield* plugin.call(HealthService.method.check, {}, CALL_DEADLINE_MILLISECONDS);
        yield* TestClock.adjust(29_999);

        expect(() => process.kill(firstLaunch.pid, 0)).not.toThrow();
        expect(yield* readLaunchRecords(controlDirectory)).toHaveLength(1);

        yield* TestClock.adjust(1);
        yield* plugin.call(HealthService.method.check, {}, CALL_DEADLINE_MILLISECONDS);
        expect(yield* readLaunchRecords(controlDirectory)).toHaveLength(2);
      }).pipe(Effect.provide(PluginSupervisor.layer())),
    ),
  ),
);

it.effect("keeps committed retirement shared when one waiting caller times out", () =>
  withControlDirectory((controlDirectory) =>
    Effect.scoped(
      Effect.gen(function* committedRetirementTest() {
        const supervisor = yield* PluginSupervisor;
        const plugin = yield* supervisor.supervise(
          fixtureDescriptor(controlDirectory, "wait-first-termination"),
        );
        yield* plugin.call(HealthService.method.check, {}, CALL_DEADLINE_MILLISECONDS);
        const firstLaunch = (yield* awaitLaunchCount(controlDirectory, 1))[0];
        if (firstLaunch === undefined) {
          return yield* Effect.die("fixture launch record missing");
        }

        yield* TestClock.adjust(30_000);
        yield* awaitFileLineCount(controlDirectory, "termination-signals.ndjson", 1);

        const survivingCall = yield* Effect.forkChild(
          plugin.call(PluginService.method.getConnection, {}, 10_000),
          { startImmediately: true },
        );
        const expiringCall = yield* Effect.forkChild(
          plugin.call(PluginService.method.getConnection, {}, 100),
          { startImmediately: true },
        );
        yield* TestClock.adjust(100);

        const expiringExitAtDeadline = expiringCall.pollUnsafe();
        expect(() => process.kill(firstLaunch.pid, 0)).not.toThrow();
        expect(yield* readLaunchRecords(controlDirectory)).toHaveLength(1);

        yield* Effect.promise(() =>
          writeFile(join(controlDirectory, "termination-continue"), "", { mode: 0o600 }),
        );
        const expiringFailure = yield* Fiber.join(expiringCall).pipe(Effect.flip);
        const response = yield* Fiber.join(survivingCall);
        const launches = yield* awaitLaunchCount(controlDirectory, 2);
        const requests = yield* awaitFileLineCount(controlDirectory, "requests.ndjson", 1);

        expect(expiringExitAtDeadline).toBeDefined();
        expect(expiringFailure).toMatchObject({ _tag: "PluginDeadlineExceeded" });
        expect(response.connection?.status).toBe(1);
        expect(launches).toHaveLength(2);
        expect(requests).toHaveLength(1);
      }).pipe(Effect.provide(PluginSupervisor.layer())),
    ),
  ),
);

it.effect("keeps a blocked call alive and starts the idle interval after interruption", () =>
  withControlDirectory((controlDirectory) =>
    Effect.scoped(
      Effect.gen(function* blockedDemandTest() {
        const supervisor = yield* PluginSupervisor;
        const plugin = yield* supervisor.supervise(
          fixtureDescriptor(controlDirectory, "block-first-connection"),
        );
        const blockedCall = yield* Effect.forkChild(
          plugin.call(PluginService.method.getConnection, {}, 120_000),
        );
        yield* awaitFileLineCount(controlDirectory, "requests.ndjson", 1);
        const firstLaunch = (yield* awaitLaunchCount(controlDirectory, 1))[0];
        if (firstLaunch === undefined) {
          return yield* Effect.die("fixture launch record missing");
        }

        yield* TestClock.adjust(30_000);
        expect(() => process.kill(firstLaunch.pid, 0)).not.toThrow();
        expect(yield* readLaunchRecords(controlDirectory)).toHaveLength(1);

        yield* Fiber.interrupt(blockedCall);
        yield* awaitFileLineCount(controlDirectory, "cancellations.ndjson", 1);
        yield* TestClock.adjust(29_999);
        expect(() => process.kill(firstLaunch.pid, 0)).not.toThrow();

        yield* TestClock.adjust(1);
        yield* plugin.call(HealthService.method.check, {}, CALL_DEADLINE_MILLISECONDS);
        expect(yield* readLaunchRecords(controlDirectory)).toHaveLength(2);
      }).pipe(Effect.provide(PluginSupervisor.layer())),
    ),
  ),
);

it.effect("starts the idle interval after a plugin RPC failure", () =>
  withControlDirectory((controlDirectory) =>
    Effect.scoped(
      Effect.gen(function* failedDemandTest() {
        const supervisor = yield* PluginSupervisor;
        const plugin = yield* supervisor.supervise(
          fixtureDescriptor(controlDirectory, "rpc-not-found"),
        );
        const failure = yield* plugin
          .call(PluginService.method.getConnection, {}, CALL_DEADLINE_MILLISECONDS)
          .pipe(Effect.flip);

        expect(failure).toMatchObject({ _tag: "PluginRpcError", code: Code.NotFound });
        expect(yield* readLaunchRecords(controlDirectory)).toHaveLength(1);

        yield* TestClock.adjust(30_000);
        yield* plugin.call(HealthService.method.check, {}, CALL_DEADLINE_MILLISECONDS);
        expect(yield* readLaunchRecords(controlDirectory)).toHaveLength(2);
      }).pipe(Effect.provide(PluginSupervisor.layer())),
    ),
  ),
);

it.effect("starts the idle interval after a plugin RPC deadline", () =>
  withControlDirectory((controlDirectory) =>
    Effect.scoped(
      Effect.gen(function* deadlineDemandTest() {
        const supervisor = yield* PluginSupervisor;
        const plugin = yield* supervisor.supervise(
          fixtureDescriptor(controlDirectory, "block-first-connection"),
        );
        const blockedCall = yield* Effect.forkChild(
          plugin.call(PluginService.method.getConnection, {}, 100),
        );
        yield* awaitFileLineCount(controlDirectory, "requests.ndjson", 1);
        const firstLaunch = (yield* awaitLaunchCount(controlDirectory, 1))[0];
        if (firstLaunch === undefined) {
          return yield* Effect.die("fixture launch record missing");
        }

        yield* TestClock.adjust(100);
        expect(yield* Fiber.join(blockedCall).pipe(Effect.flip)).toMatchObject({
          _tag: "PluginDeadlineExceeded",
        });
        yield* awaitFileLineCount(controlDirectory, "cancellations.ndjson", 1);
        yield* Effect.yieldNow;

        yield* TestClock.adjust(1000);
        yield* awaitProcessExit(firstLaunch.pid);
        yield* Effect.yieldNow;
        yield* TestClock.adjust(99);
        expect(yield* readLaunchRecords(controlDirectory)).toHaveLength(1);
        yield* TestClock.adjust(1);
        yield* TestClock.adjust(100);
        const recoveryLaunches = yield* awaitLaunchCount(controlDirectory, 2);
        const recoveredLaunch = recoveryLaunches[1];
        if (recoveredLaunch === undefined) {
          return yield* Effect.die("recovery launch record missing");
        }
        yield* TestClock.adjust(28_799);
        expect(() => process.kill(recoveredLaunch.pid, 0)).not.toThrow();

        yield* TestClock.adjust(1);
        yield* plugin.call(HealthService.method.check, {}, CALL_DEADLINE_MILLISECONDS);
        expect(yield* readLaunchRecords(controlDirectory)).toHaveLength(3);
      }).pipe(Effect.provide(PluginSupervisor.layer())),
    ),
  ),
);

it.effect("interrupts unfinished recovery when idle grace expires", () =>
  withControlDirectory((controlDirectory) =>
    Effect.suspend(() => {
      const lines: string[] = [];
      let recoveryProcessId: number | undefined;
      let spawnAttempts = 0;
      const spawnProcess = ((...arguments_: Parameters<typeof spawnChild>) => {
        spawnAttempts += 1;
        const child = Reflect.apply(spawnChild, undefined, arguments_);
        if (spawnAttempts === 2) {
          recoveryProcessId = child.pid;
          const originalOnce = child.once.bind(child);
          child.once = ((event: string | symbol, listener: (...arguments_: unknown[]) => void) => {
            if (event === "spawn") {
              return child;
            }
            return Reflect.apply(originalOnce, child, [event, listener]) as typeof child;
          }) as typeof child.once;
        }
        return child;
      }) as typeof spawnChild;
      return Effect.scoped(
        Effect.gen(function* recoveryIdleExpiryTest() {
          const supervisor = yield* PluginSupervisor;
          const plugin = yield* supervisor.supervise(fixtureDescriptor(controlDirectory));
          yield* plugin.call(HealthService.method.check, {}, CALL_DEADLINE_MILLISECONDS);
          const firstLaunch = (yield* readLaunchRecords(controlDirectory))[0];
          if (firstLaunch === undefined) {
            return yield* Effect.die("fixture launch record missing");
          }
          const runtimeRoot = dirname(dirname(firstLaunch.socketPath));

          process.kill(firstLaunch.pid, "SIGKILL");
          yield* awaitProcessExit(firstLaunch.pid);
          yield* awaitPathRemoval(dirname(firstLaunch.socketPath));

          const initiatingCall = yield* Effect.forkChild(
            plugin.call(PluginService.method.getConnection, {}, 150),
          );
          yield* awaitCondition(() =>
            lines.some(
              (line) =>
                line.includes('"event":"plugin.recovery_attempt"') &&
                line.includes('"recovery_attempt":2'),
            ),
          );
          yield* TestClock.adjust(100);
          yield* awaitCondition(() => recoveryProcessId !== undefined);
          const partialProcessId = recoveryProcessId;
          if (partialProcessId === undefined) {
            return yield* Effect.die("partial recovery process missing");
          }
          yield* TestClock.adjust(50);
          expect(yield* Fiber.join(initiatingCall).pipe(Effect.flip)).toMatchObject({
            _tag: "PluginDeadlineExceeded",
          });

          yield* TestClock.adjust(29_999);
          expect(() => process.kill(partialProcessId, 0)).not.toThrow();
          const partialLaunches = yield* Effect.promise(() => readdir(runtimeRoot));
          expect(partialLaunches).toHaveLength(1);
          const partialLaunch = partialLaunches[0];
          if (partialLaunch === undefined) {
            return yield* Effect.die("partial recovery launch directory missing");
          }
          const partialLaunchDirectory = join(runtimeRoot, partialLaunch);

          yield* TestClock.adjust(1);
          yield* awaitProcessExit(partialProcessId);
          yield* awaitPathRemoval(partialLaunchDirectory);
          expect(() => process.kill(partialProcessId, 0)).toThrow(
            expect.objectContaining({ code: "ESRCH" }),
          );
          expect(yield* Effect.promise(() => readdir(runtimeRoot))).toHaveLength(0);
        }).pipe(
          Effect.provide(PluginSupervisor.layer({ spawnProcess })),
          Effect.provide(
            configuredLoggingLayer(loggingConfig, (line) => {
              lines.push(line);
            }),
          ),
        ),
      );
    }),
  ),
);

it.live("recovers a killed ready plugin with fresh launch authority", () =>
  withControlDirectory((controlDirectory) =>
    Effect.scoped(
      Effect.gen(function* killedPluginRecoveryTest() {
        const supervisor = yield* PluginSupervisor;
        const plugin = yield* supervisor.supervise(fixtureDescriptor(controlDirectory));
        yield* plugin.call(HealthService.method.check, {}, CALL_DEADLINE_MILLISECONDS);
        const firstLaunch = (yield* awaitLaunchCount(controlDirectory, 1))[0];
        if (firstLaunch === undefined) {
          return yield* Effect.die("fixture launch record missing");
        }

        process.kill(firstLaunch.pid, "SIGKILL");
        yield* awaitProcessExit(firstLaunch.pid);
        const response = yield* plugin.call(
          PluginService.method.getConnection,
          {},
          CALL_DEADLINE_MILLISECONDS,
        );
        const launches = yield* readLaunchRecords(controlDirectory);

        expect(response.connection?.status).toBe(1);
        expect(launches).toHaveLength(2);
        expect(launches[1]?.bearer).not.toBe(firstLaunch.bearer);
        expect(launches[1]?.socketPath).not.toBe(firstLaunch.socketPath);
      }).pipe(Effect.provide(PluginSupervisor.layer())),
    ),
  ),
);

it.effect("bounds a recovery episode to three launches with 100/500ms backoff", () =>
  withControlDirectory((controlDirectory) =>
    Effect.scoped(
      Effect.gen(function* boundedRecoveryTest() {
        const supervisor = yield* PluginSupervisor;
        const plugin = yield* supervisor.supervise(
          fixtureDescriptor(controlDirectory, "recover-twice"),
        );
        const call = yield* Effect.forkChild(
          plugin.call(PluginService.method.getConnection, {}, CALL_DEADLINE_MILLISECONDS),
        );
        const firstLaunch = (yield* awaitLaunchCount(controlDirectory, 1))[0];
        if (firstLaunch === undefined) {
          return yield* Effect.die("first launch record missing");
        }
        yield* awaitFileLineCount(controlDirectory, "exits.ndjson", 1);
        yield* awaitProcessExit(firstLaunch.pid);
        yield* Effect.yieldNow;

        yield* TestClock.adjust(99);
        expect(yield* readLaunchRecords(controlDirectory)).toHaveLength(1);
        yield* TestClock.adjust(1);
        const secondLaunch = (yield* awaitLaunchCount(controlDirectory, 2))[1];
        if (secondLaunch === undefined) {
          return yield* Effect.die("second launch record missing");
        }
        yield* awaitFileLineCount(controlDirectory, "exits.ndjson", 2);
        yield* awaitProcessExit(secondLaunch.pid);
        yield* Effect.yieldNow;

        yield* TestClock.adjust(499);
        expect(yield* readLaunchRecords(controlDirectory)).toHaveLength(2);
        yield* TestClock.adjust(1);
        const response = yield* Fiber.join(call);

        expect(response.connection?.status).toBe(1);
        expect(yield* readLaunchRecords(controlDirectory)).toHaveLength(3);
      }).pipe(Effect.provide(PluginSupervisor.layer())),
    ),
  ),
);

it.effect("retries a transient spawn resource failure after 100ms", () =>
  withControlDirectory((controlDirectory) =>
    Effect.suspend(() => {
      let spawnAttempts = 0;
      const lines: string[] = [];
      const spawnProcess = ((...arguments_: Parameters<typeof spawnChild>) => {
        spawnAttempts += 1;
        if (spawnAttempts === 1) {
          throw Object.assign(new Error("transient spawn failure"), { code: "EAGAIN" });
        }
        return Reflect.apply(spawnChild, undefined, arguments_);
      }) as typeof spawnChild;
      return Effect.scoped(
        Effect.gen(function* transientSpawnFailureTest() {
          const supervisor = yield* PluginSupervisor;
          const plugin = yield* supervisor.supervise(fixtureDescriptor(controlDirectory));
          const call = yield* Effect.forkChild(
            plugin.call(HealthService.method.check, {}, CALL_DEADLINE_MILLISECONDS),
          );
          yield* awaitCondition(
            () =>
              spawnAttempts === 1 && lines.some((line) => line.includes('"recovery_attempt":2')),
          );

          yield* TestClock.adjust(99);
          const absentLaunchFile = yield* Effect.tryPromise({
            catch: (error) => error,
            try: () => readFile(join(controlDirectory, "launches.ndjson")),
          }).pipe(Effect.flip);
          expect(absentLaunchFile).toMatchObject({ code: "ENOENT" });

          yield* TestClock.adjust(1);
          const health = yield* Fiber.join(call);
          expect(health.status).toBe(ServingStatus.SERVING);
          expect(spawnAttempts).toBe(2);
          expect(yield* readLaunchRecords(controlDirectory)).toHaveLength(1);
        }).pipe(
          Effect.provide(PluginSupervisor.layer({ spawnProcess })),
          Effect.provide(
            configuredLoggingLayer(loggingConfig, (line) => {
              lines.push(line);
            }),
          ),
        ),
      );
    }),
  ),
);

it.effect("does not retry a launch-protocol rejection", () =>
  withControlDirectory((controlDirectory) =>
    Effect.scoped(
      Effect.gen(function* launchProtocolRejectionTest() {
        const supervisor = yield* PluginSupervisor;
        const plugin = yield* supervisor.supervise(
          fixtureDescriptor(controlDirectory, "launch-reject"),
        );
        const call = yield* Effect.forkChild(
          plugin.call(HealthService.method.check, {}, CALL_DEADLINE_MILLISECONDS),
        );
        const launches = yield* awaitLaunchCount(controlDirectory, 1);
        yield* awaitFileLineCount(controlDirectory, "exits.ndjson", 1);
        const firstLaunch = launches[0];
        if (firstLaunch === undefined) {
          return yield* Effect.die("fixture launch record missing");
        }
        yield* awaitProcessExit(firstLaunch.pid);
        yield* Effect.yieldNow;
        yield* TestClock.adjust(600);
        const failure = yield* Fiber.join(call).pipe(Effect.flip);

        expect(failure).toMatchObject({
          _tag: "PluginUnavailable",
          reason: "launch_protocol_rejected",
        });
        expect(yield* readLaunchRecords(controlDirectory)).toHaveLength(1);
      }).pipe(Effect.provide(PluginSupervisor.layer())),
    ),
  ),
);

it.effect("recycles a process after deadline cancellation grace", () =>
  withControlDirectory((controlDirectory) =>
    Effect.scoped(
      Effect.gen(function* deadlineRecoveryTest() {
        const supervisor = yield* PluginSupervisor;
        const plugin = yield* supervisor.supervise(
          fixtureDescriptor(controlDirectory, "block-connection"),
        );
        yield* plugin.call(HealthService.method.check, {}, CALL_DEADLINE_MILLISECONDS);
        const firstLaunch = (yield* awaitLaunchCount(controlDirectory, 1))[0];
        if (firstLaunch === undefined) {
          return yield* Effect.die("fixture launch record missing");
        }
        const blockedCall = yield* Effect.forkChild(
          plugin.call(PluginService.method.getConnection, {}, 100),
        );
        yield* awaitFileLineCount(controlDirectory, "requests.ndjson", 1);

        yield* TestClock.adjust(100);
        const failure = yield* Fiber.join(blockedCall).pipe(Effect.flip);
        yield* awaitFileLineCount(controlDirectory, "cancellations.ndjson", 1);
        expect(failure).toMatchObject({ _tag: "PluginDeadlineExceeded" });

        yield* TestClock.adjust(999);
        expect(yield* readLaunchRecords(controlDirectory)).toHaveLength(1);
        yield* TestClock.adjust(1);
        yield* awaitProcessExit(firstLaunch.pid);
        yield* Effect.yieldNow;
        yield* TestClock.adjust(99);
        expect(yield* readLaunchRecords(controlDirectory)).toHaveLength(1);
        yield* TestClock.adjust(1);
        yield* TestClock.adjust(100);
        yield* awaitLaunchCount(controlDirectory, 2);
        const health = yield* plugin.call(
          HealthService.method.check,
          {},
          CALL_DEADLINE_MILLISECONDS,
        );

        expect(health.status).toBe(ServingStatus.SERVING);
        expect(yield* readLaunchRecords(controlDirectory)).toHaveLength(2);
      }).pipe(Effect.provide(PluginSupervisor.layer())),
    ),
  ),
);

it.effect("kills the complete plugin process group at shutdown", () =>
  withControlDirectory((controlDirectory) =>
    Effect.scoped(
      Effect.gen(function* processGroupShutdownTest() {
        const supervisor = yield* PluginSupervisor;
        const handleScope = yield* Scope.make();
        const plugin = yield* Scope.provide(handleScope)(
          supervisor.supervise(fixtureDescriptor(controlDirectory, "helper")),
        );
        yield* plugin.call(HealthService.method.check, {}, CALL_DEADLINE_MILLISECONDS);
        const helperLines = yield* awaitFileLineCount(controlDirectory, "helper-pid", 1);
        const helperProcessId = Number(helperLines[0]);
        const firstLaunch = (yield* readLaunchRecords(controlDirectory))[0];
        if (firstLaunch === undefined) {
          return yield* Effect.die("fixture launch record missing");
        }
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            try {
              process.kill(helperProcessId, "SIGKILL");
            } catch (error) {
              if (
                typeof error !== "object" ||
                error === null ||
                !("code" in error) ||
                error.code !== "ESRCH"
              ) {
                throw error;
              }
            }
          }),
        );

        const shutdown = yield* Effect.forkChild(Scope.close(handleScope, Exit.void));
        yield* awaitProcessExit(firstLaunch.pid);
        yield* TestClock.adjust(2000);
        yield* Fiber.join(shutdown);

        expect(() => process.kill(helperProcessId, 0)).toThrow(
          expect.objectContaining({ code: "ESRCH" }),
        );
      }).pipe(Effect.provide(PluginSupervisor.layer())),
    ),
  ),
);

it.live("accepts only bounded declared structured plugin stderr", () =>
  withControlDirectory((controlDirectory) => {
    const lines: string[] = [];
    return Effect.scoped(
      Effect.gen(function* structuredStderrTest() {
        const validRecords = Array.from({ length: 46 }, (_value, index) =>
          JSON.stringify({
            event: "fixture.metric",
            fields: { count: index, state: "ready" },
            level: "info",
          }),
        );
        const hostileSecret = "stderr-secret-must-not-appear";
        const records = [
          "not-json",
          JSON.stringify({
            event: "constructor",
            fields: { value: 1 },
            level: "info",
          }),
          JSON.stringify({
            event: "fixture.metric",
            fields: { count: 1, toString: "ready" },
            level: "info",
          }),
          JSON.stringify({
            event: "fixture.unknown",
            fields: { count: 1 },
            level: "info",
          }),
          JSON.stringify({
            event: "fixture.metric",
            fields: { count: 1, state: hostileSecret },
            level: "error",
          }),
          JSON.stringify({
            event: "fixture.metric",
            fields: { count: 1, state: "ready" },
            level: "fatal",
          }),
          JSON.stringify({
            event: "fixture.metric",
            fields: { count: 1, padding: "x".repeat(4096), state: "ready" },
            level: "info",
          }),
          ...validRecords,
        ];
        yield* Effect.promise(() =>
          writeFile(join(controlDirectory, "stderr.ndjson"), `${records.join("\n")}\n`, {
            mode: 0o600,
          }),
        );
        const supervisor = yield* PluginSupervisor;
        const plugin = yield* supervisor.supervise(
          fixtureDescriptor(controlDirectory, "stderr-lines", [
            {
              event: "fixture.metric",
              fields: {
                count: { kind: "number" },
                state: { kind: "enum", values: ["ready"] },
              },
            },
          ]),
        );
        yield* plugin.call(PluginService.method.getConnection, {}, CALL_DEADLINE_MILLISECONDS);
        yield* awaitFileLineCount(controlDirectory, "stderr-complete", 1);
        yield* awaitCondition(
          () =>
            lines.filter((line) => line.includes('"event":"fixture.metric"')).length === 40 &&
            lines.some((line) => line.includes('"event":"plugin.stderr_dropped"')),
        );

        const output = lines.join("");
        const loggedRecords = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
        const accepted = loggedRecords.filter((record) => record["event"] === "fixture.metric");
        const dropped = loggedRecords.filter(
          (record) => record["event"] === "plugin.stderr_dropped",
        );
        expect(accepted).toHaveLength(40);
        expect(accepted[0]).toMatchObject({
          count: 0,
          event: "fixture.metric",
          level: "info",
          provider_type: "fixture",
          state: "ready",
        });
        expect(dropped).toHaveLength(1);
        expect(output).not.toContain(hostileSecret);
        expect(output).not.toContain("fixture.unknown");
        expect(output).not.toContain("padding");
        expect(output).not.toContain('"level":"fatal"');
        expect(output).not.toContain('"event":"constructor"');
        expect(output).not.toContain('"toString"');
      }).pipe(
        Effect.provide(PluginSupervisor.layer()),
        Effect.provide(
          configuredLoggingLayer(loggingConfig, (line) => {
            lines.push(line);
          }),
        ),
      ),
    );
  }),
);

it.live("requires the current launch bearer on every plugin RPC", () =>
  withControlDirectory((controlDirectory) =>
    Effect.scoped(
      Effect.gen(function* pluginAuthenticationTest() {
        const supervisor = yield* PluginSupervisor;
        const plugin = yield* supervisor.supervise(fixtureDescriptor(controlDirectory));
        yield* plugin.call(HealthService.method.check, {}, CALL_DEADLINE_MILLISECONDS);
        const firstLaunch = (yield* readLaunchRecords(controlDirectory))[0];
        if (firstLaunch === undefined) {
          return yield* Effect.die("fixture launch record missing");
        }

        for (const authorization of [
          undefined,
          "Basic Zml4dHVyZQ==",
          "Bearer malformed",
          `Bearer ${"A".repeat(43)}`,
        ]) {
          const failure = yield* directHealthCheck(firstLaunch.socketPath, authorization).pipe(
            Effect.flip,
          );
          expect(ConnectError.from(failure).code).toBe(Code.Unauthenticated);
        }
        const health = yield* directHealthCheck(
          firstLaunch.socketPath,
          `Bearer ${firstLaunch.bearer}`,
        );
        expect(health.status).toBe(ServingStatus.SERVING);
      }).pipe(Effect.provide(PluginSupervisor.layer())),
    ),
  ),
);

it.live("does not retry deterministic handshake rejections", () =>
  withControlDirectory((controlDirectory) =>
    Effect.scoped(
      Effect.gen(function* deterministicHandshakeTest() {
        const supervisor = yield* PluginSupervisor;
        const cases = [
          ["authentication-failure", "authentication_failed"],
          ["contract-major", "contract_unsupported"],
          ["provider-mismatch", "provider_type_mismatch"],
          ["insecure-socket", "socket_invalid"],
          ["regular-socket", "socket_invalid"],
        ] as const;

        for (const [mode, reason] of cases) {
          const caseDirectory = join(controlDirectory, mode);
          yield* Effect.promise(() => mkdir(caseDirectory, { mode: 0o700, recursive: true }));
          const plugin = yield* supervisor.supervise(fixtureDescriptor(caseDirectory, mode));
          const failure = yield* plugin
            .call(HealthService.method.check, {}, CALL_DEADLINE_MILLISECONDS)
            .pipe(Effect.flip);
          expect(failure).toMatchObject({
            _tag: "PluginUnavailable",
            reason,
          });
          expect(yield* readLaunchRecords(caseDirectory)).toHaveLength(1);
        }
      }).pipe(Effect.provide(PluginSupervisor.layer())),
    ),
  ),
);

it.effect("leaves an unexpectedly exited idle plugin absent", () =>
  withControlDirectory((controlDirectory) =>
    Effect.suspend(() => {
      const lines: string[] = [];
      let spawnAttempts = 0;
      const spawnProcess = ((...arguments_: Parameters<typeof spawnChild>) => {
        spawnAttempts += 1;
        return Reflect.apply(spawnChild, undefined, arguments_);
      }) as typeof spawnChild;
      return Effect.scoped(
        Effect.gen(function* idleExitTest() {
          const supervisor = yield* PluginSupervisor;
          const plugin = yield* supervisor.supervise(fixtureDescriptor(controlDirectory));
          yield* plugin.call(HealthService.method.check, {}, CALL_DEADLINE_MILLISECONDS);
          const firstLaunch = (yield* readLaunchRecords(controlDirectory))[0];
          if (firstLaunch === undefined) {
            return yield* Effect.die("fixture launch record missing");
          }

          process.kill(firstLaunch.pid, "SIGKILL");
          yield* awaitProcessExit(firstLaunch.pid);
          yield* awaitPathRemoval(dirname(firstLaunch.socketPath));
          yield* TestClock.adjust(100);
          yield* Effect.yieldNow;

          const retiredLaunchFailure = yield* Effect.tryPromise({
            catch: (error) => error,
            try: () => lstat(dirname(firstLaunch.socketPath)),
          }).pipe(Effect.flip);
          expect(retiredLaunchFailure).toMatchObject({ code: "ENOENT" });
          expect(spawnAttempts).toBe(1);
          yield* awaitCondition(() =>
            lines.some((line) => line.includes('"event":"plugin.process_exited"')),
          );
          const records = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
          expect(records).toContainEqual(
            expect.objectContaining({
              event: "plugin.process_exited",
              level: "warn",
              provider_type: "fixture",
              signal: "SIGKILL",
            }),
          );
          const output = lines.join("");
          expect(output).not.toContain(firstLaunch.bearer);
          expect(output).not.toContain(firstLaunch.socketPath);
          expect(output).not.toContain(controlDirectory);
        }).pipe(
          Effect.provide(PluginSupervisor.layer({ spawnProcess })),
          Effect.provide(
            configuredLoggingLayer(loggingConfig, (line) => {
              lines.push(line);
            }),
          ),
        ),
      );
    }),
  ),
);

it.live("recovers a replacement that exits after its handshake during active demand", () =>
  withControlDirectory((controlDirectory) =>
    Effect.scoped(
      Effect.gen(function* replacementExitRecoveryTest() {
        const supervisor = yield* PluginSupervisor;
        const plugin = yield* supervisor.supervise(
          fixtureDescriptor(controlDirectory, "block-and-exit-after-ready-during-recovery"),
        );
        yield* plugin.call(HealthService.method.check, {}, CALL_DEADLINE_MILLISECONDS);
        const firstLaunch = (yield* readLaunchRecords(controlDirectory))[0];
        if (firstLaunch === undefined) {
          return yield* Effect.die("fixture launch record missing");
        }
        const blockedCall = yield* Effect.forkChild(
          plugin.call(PluginService.method.getConnection, {}, CALL_DEADLINE_MILLISECONDS),
        );
        yield* awaitFileLineCount(controlDirectory, "requests.ndjson", 1);

        process.kill(firstLaunch.pid, "SIGKILL");
        expect(yield* Fiber.join(blockedCall).pipe(Effect.flip)).toMatchObject({
          _tag: "PluginUnavailable",
          reason: "plugin_exited",
        });
        const recoveryCall = yield* Effect.forkChild(
          plugin.call(PluginService.method.getConnection, {}, CALL_DEADLINE_MILLISECONDS),
        );
        const launches = yield* awaitLaunchCount(controlDirectory, 3);
        expect(yield* Fiber.join(recoveryCall).pipe(Effect.flip)).toMatchObject({
          _tag: "PluginUnavailable",
          reason: "plugin_exited",
        });
        const recoveredLaunch = launches[2];
        if (recoveredLaunch === undefined) {
          return yield* Effect.die("recovered launch record missing");
        }

        const health = yield* directHealthCheck(
          recoveredLaunch.socketPath,
          `Bearer ${recoveredLaunch.bearer}`,
        );
        expect(health.status).toBe(ServingStatus.SERVING);
      }).pipe(Effect.provide(PluginSupervisor.layer())),
    ),
  ),
);

it.effect("makes a three-launch exhausted recovery episode terminal", () =>
  withControlDirectory((controlDirectory) =>
    Effect.scoped(
      Effect.gen(function* exhaustedRecoveryTest() {
        const supervisor = yield* PluginSupervisor;
        const plugin = yield* supervisor.supervise(
          fixtureDescriptor(controlDirectory, "always-exit-before-ready"),
        );
        const call = yield* Effect.forkChild(
          plugin.call(HealthService.method.check, {}, CALL_DEADLINE_MILLISECONDS),
        );

        yield* awaitFileLineCount(controlDirectory, "exits.ndjson", 1);
        yield* TestClock.adjust(100);
        yield* awaitFileLineCount(controlDirectory, "exits.ndjson", 2);
        yield* TestClock.adjust(500);
        yield* awaitFileLineCount(controlDirectory, "exits.ndjson", 3);
        const failure = yield* Fiber.join(call).pipe(Effect.flip);
        yield* TestClock.adjust(10_000);

        expect(failure).toMatchObject({
          _tag: "PluginUnavailable",
          reason: "plugin_exited",
        });
        expect(yield* readLaunchRecords(controlDirectory)).toHaveLength(3);
        expect(yield* Effect.succeed("core-alive")).toBe("core-alive");
      }).pipe(Effect.provide(PluginSupervisor.layer())),
    ),
  ),
);

it.live("cancels one RPC without recycling its healthy sibling process", () =>
  withControlDirectory((controlDirectory) =>
    Effect.scoped(
      Effect.gen(function* isolatedCancellationTest() {
        const supervisor = yield* PluginSupervisor;
        const plugin = yield* supervisor.supervise(
          fixtureDescriptor(controlDirectory, "block-first-connection"),
        );
        const blockedCall = yield* Effect.forkChild(
          plugin.call(PluginService.method.getConnection, {}, CALL_DEADLINE_MILLISECONDS),
        );
        yield* awaitFileLineCount(controlDirectory, "requests.ndjson", 1);

        yield* Fiber.interrupt(blockedCall);
        yield* awaitFileLineCount(controlDirectory, "cancellations.ndjson", 1);
        const response = yield* plugin.call(
          PluginService.method.getConnection,
          {},
          CALL_DEADLINE_MILLISECONDS,
        );

        expect(response.connection?.status).toBe(1);
        expect(yield* readLaunchRecords(controlDirectory)).toHaveLength(1);
        expect(yield* awaitFileLineCount(controlDirectory, "requests.ndjson", 2)).toHaveLength(2);
      }).pipe(Effect.provide(PluginSupervisor.layer())),
    ),
  ),
);

it.live("preserves logical RPC statuses without recycling a healthy plugin", () =>
  withControlDirectory((controlDirectory) =>
    Effect.scoped(
      Effect.gen(function* logicalStatusTest() {
        const supervisor = yield* PluginSupervisor;
        for (const [mode, code] of [
          ["rpc-deadline", Code.DeadlineExceeded],
          ["rpc-not-found", Code.NotFound],
        ] as const) {
          const caseDirectory = join(controlDirectory, mode);
          yield* Effect.promise(() => mkdir(caseDirectory, { mode: 0o700 }));
          yield* Effect.scoped(
            Effect.gen(function* logicalStatusCase() {
              const plugin = yield* supervisor.supervise(fixtureDescriptor(caseDirectory, mode));
              const failure = yield* plugin
                .call(PluginService.method.getConnection, {}, CALL_DEADLINE_MILLISECONDS)
                .pipe(Effect.flip);
              const health = yield* plugin.call(
                HealthService.method.check,
                {},
                CALL_DEADLINE_MILLISECONDS,
              );

              expect(failure).toMatchObject({ _tag: "PluginRpcError", code });
              expect(health.status).toBe(ServingStatus.SERVING);
              expect(yield* readLaunchRecords(caseDirectory)).toHaveLength(1);
            }),
          );
        }
      }).pipe(Effect.provide(PluginSupervisor.layer())),
    ),
  ),
);

it.live("shares one first-demand launch while preserving caller deadlines", () =>
  withControlDirectory((controlDirectory) =>
    Effect.scoped(
      Effect.gen(function* initialSingleFlightTest() {
        const supervisor = yield* PluginSupervisor;
        const plugin = yield* supervisor.supervise(
          fixtureDescriptor(controlDirectory, "wait-start"),
        );
        const shortCall = yield* Effect.forkChild(
          plugin.call(PluginService.method.getConnection, {}, 50),
        );
        const longCall = yield* Effect.forkChild(
          plugin.call(PluginService.method.getConnection, {}, CALL_DEADLINE_MILLISECONDS),
        );
        yield* awaitLaunchCount(controlDirectory, 1);

        expect(yield* Fiber.join(shortCall).pipe(Effect.flip)).toMatchObject({
          _tag: "PluginDeadlineExceeded",
        });
        yield* Effect.promise(() =>
          writeFile(join(controlDirectory, "continue"), "", {
            mode: 0o600,
          }),
        );
        const response = yield* Fiber.join(longCall);

        expect(response.connection?.status).toBe(1);
        expect(yield* readLaunchRecords(controlDirectory)).toHaveLength(1);
      }).pipe(Effect.provide(PluginSupervisor.layer())),
    ),
  ),
);

it.live("never replays a call lost with a crashing plugin process", () =>
  withControlDirectory((controlDirectory) =>
    Effect.scoped(
      Effect.gen(function* noReplayTest() {
        const supervisor = yield* PluginSupervisor;
        const plugin = yield* supervisor.supervise(
          fixtureDescriptor(controlDirectory, "crash-connection"),
        );

        const failure = yield* plugin
          .call(PluginService.method.getConnection, {}, CALL_DEADLINE_MILLISECONDS)
          .pipe(Effect.flip);
        expect(failure).toMatchObject({
          _tag: "PluginUnavailable",
          reason: "plugin_exited",
        });
        yield* awaitLaunchCount(controlDirectory, 2);

        const response = yield* plugin.call(
          PluginService.method.getConnection,
          {},
          CALL_DEADLINE_MILLISECONDS,
        );
        expect(response.connection?.status).toBe(1);
        expect(yield* awaitFileLineCount(controlDirectory, "requests.ndjson", 2)).toHaveLength(2);
      }).pipe(Effect.provide(PluginSupervisor.layer())),
    ),
  ),
);

it.live("shares one recovery launch across concurrent callers", () =>
  withControlDirectory((controlDirectory) =>
    Effect.scoped(
      Effect.gen(function* singleFlightRecoveryTest() {
        const supervisor = yield* PluginSupervisor;
        const plugin = yield* supervisor.supervise(fixtureDescriptor(controlDirectory));
        yield* plugin.call(HealthService.method.check, {}, CALL_DEADLINE_MILLISECONDS);
        const firstLaunch = (yield* readLaunchRecords(controlDirectory))[0];
        if (firstLaunch === undefined) {
          return yield* Effect.die("fixture launch record missing");
        }
        process.kill(firstLaunch.pid, "SIGKILL");
        yield* awaitProcessExit(firstLaunch.pid);

        const calls = yield* Effect.all(
          [
            plugin.call(PluginService.method.getConnection, {}, CALL_DEADLINE_MILLISECONDS),
            plugin.call(PluginService.method.getConnection, {}, CALL_DEADLINE_MILLISECONDS),
          ],
          { concurrency: "unbounded" },
        );

        expect(calls).toHaveLength(2);
        expect(yield* readLaunchRecords(controlDirectory)).toHaveLength(2);
      }).pipe(Effect.provide(PluginSupervisor.layer())),
    ),
  ),
);

it.effect("finishes demand-initiated recovery during idle grace", () =>
  withControlDirectory((controlDirectory) => {
    const lines: string[] = [];
    return Effect.scoped(
      Effect.gen(function* recoveryDeadlineTest() {
        const supervisor = yield* PluginSupervisor;
        const plugin = yield* supervisor.supervise(
          fixtureDescriptor(controlDirectory, "wait-recovery"),
        );
        yield* plugin.call(HealthService.method.check, {}, CALL_DEADLINE_MILLISECONDS);
        const firstLaunch = (yield* readLaunchRecords(controlDirectory))[0];
        if (firstLaunch === undefined) {
          return yield* Effect.die("fixture launch record missing");
        }
        process.kill(firstLaunch.pid, "SIGKILL");
        yield* awaitProcessExit(firstLaunch.pid);
        yield* awaitPathRemoval(dirname(firstLaunch.socketPath));

        const initiatingCall = yield* Effect.forkChild(
          plugin.call(PluginService.method.getConnection, {}, 150),
        );
        yield* awaitCondition(() =>
          lines.some(
            (line) =>
              line.includes('"event":"plugin.recovery_attempt"') &&
              line.includes('"recovery_attempt":2'),
          ),
        );
        yield* TestClock.adjust(100);
        const recoveryLaunch = (yield* awaitLaunchCount(controlDirectory, 2))[1];
        if (recoveryLaunch === undefined) {
          return yield* Effect.die("recovery launch record missing");
        }
        yield* TestClock.adjust(50);
        expect(yield* Fiber.join(initiatingCall).pipe(Effect.flip)).toMatchObject({
          _tag: "PluginDeadlineExceeded",
        });

        yield* Effect.promise(() =>
          writeFile(join(controlDirectory, "recovery-continue"), "", {
            mode: 0o600,
          }),
        );
        yield* awaitFileLineCount(controlDirectory, "ready.ndjson", 1);
        const recoveredHealth = yield* directHealthCheck(
          recoveryLaunch.socketPath,
          `Bearer ${recoveryLaunch.bearer}`,
        );
        expect(recoveredHealth.status).toBe(ServingStatus.SERVING);
        yield* Effect.yieldNow;
        const response = yield* plugin.call(
          PluginService.method.getConnection,
          {},
          CALL_DEADLINE_MILLISECONDS,
        );
        expect(response.connection?.status).toBe(1);
        expect(yield* readLaunchRecords(controlDirectory)).toHaveLength(2);
      }).pipe(
        Effect.provide(PluginSupervisor.layer()),
        Effect.provide(
          configuredLoggingLayer(loggingConfig, (line) => {
            lines.push(line);
          }),
        ),
      ),
    );
  }),
);

it.effect("preserves and resets the bounded episode across idle expiry", () =>
  withControlDirectory((controlDirectory) => {
    const lines: string[] = [];
    return Effect.scoped(
      Effect.gen(function* idleRecoveryEpisodeTest() {
        const supervisor = yield* PluginSupervisor;
        const plugin = yield* supervisor.supervise(
          fixtureDescriptor(controlDirectory, "idle-bounded-recovery"),
        );
        yield* plugin.call(HealthService.method.check, {}, CALL_DEADLINE_MILLISECONDS);
        const firstLaunch = (yield* readLaunchRecords(controlDirectory))[0];
        if (firstLaunch === undefined) {
          return yield* Effect.die("fixture launch record missing");
        }

        process.kill(firstLaunch.pid, "SIGKILL");
        yield* awaitProcessExit(firstLaunch.pid);
        yield* awaitPathRemoval(dirname(firstLaunch.socketPath));

        const remainingEpisodeCall = yield* Effect.forkChild(
          plugin.call(PluginService.method.getConnection, {}, 10_000),
        );
        yield* awaitCondition(() =>
          lines.some(
            (line) =>
              line.includes('"event":"plugin.recovery_attempt"') &&
              line.includes('"recovery_attempt":2'),
          ),
        );
        yield* TestClock.adjust(100);
        const secondLaunch = (yield* awaitLaunchCount(controlDirectory, 2))[1];
        if (secondLaunch === undefined) {
          return yield* Effect.die("second launch record missing");
        }
        yield* awaitFileLineCount(controlDirectory, "exits.ndjson", 1);
        yield* awaitProcessExit(secondLaunch.pid);
        yield* awaitCondition(() =>
          lines.some(
            (line) =>
              line.includes('"event":"plugin.recovery_attempt"') &&
              line.includes('"recovery_attempt":3'),
          ),
        );
        yield* TestClock.adjust(500);
        const thirdLaunch = (yield* awaitLaunchCount(controlDirectory, 3))[2];
        if (thirdLaunch === undefined) {
          return yield* Effect.die("third launch record missing");
        }
        yield* awaitFileLineCount(controlDirectory, "exits.ndjson", 2);
        yield* awaitProcessExit(thirdLaunch.pid);
        expect(yield* Fiber.join(remainingEpisodeCall).pipe(Effect.flip)).toMatchObject({
          _tag: "PluginUnavailable",
          reason: "plugin_exited",
        });

        expect(
          yield* plugin
            .call(PluginService.method.getConnection, {}, CALL_DEADLINE_MILLISECONDS)
            .pipe(Effect.flip),
        ).toMatchObject({
          _tag: "PluginUnavailable",
          reason: "plugin_exited",
        });
        expect(yield* readLaunchRecords(controlDirectory)).toHaveLength(3);

        yield* TestClock.adjust(30_001);
        yield* Effect.yieldNow;
        const freshEpisodeCall = yield* Effect.forkChild(
          plugin.call(PluginService.method.getConnection, {}, 10_000),
        );
        const fourthLaunch = (yield* awaitLaunchCount(controlDirectory, 4))[3];
        if (fourthLaunch === undefined) {
          return yield* Effect.die("fourth launch record missing");
        }
        yield* awaitFileLineCount(controlDirectory, "exits.ndjson", 3);
        yield* awaitProcessExit(fourthLaunch.pid);
        yield* awaitCondition(
          () =>
            lines.filter(
              (line) =>
                line.includes('"event":"plugin.recovery_attempt"') &&
                line.includes('"recovery_attempt":2'),
            ).length >= 2,
        );
        yield* TestClock.adjust(100);
        const fifthLaunch = (yield* awaitLaunchCount(controlDirectory, 5))[4];
        if (fifthLaunch === undefined) {
          return yield* Effect.die("fifth launch record missing");
        }
        yield* awaitFileLineCount(controlDirectory, "exits.ndjson", 4);
        yield* awaitProcessExit(fifthLaunch.pid);
        yield* awaitCondition(
          () =>
            lines.filter(
              (line) =>
                line.includes('"event":"plugin.recovery_attempt"') &&
                line.includes('"recovery_attempt":3'),
            ).length >= 2,
        );
        yield* TestClock.adjust(500);
        const response = yield* Fiber.join(freshEpisodeCall);

        expect(response.connection?.status).toBe(1);
        expect(yield* readLaunchRecords(controlDirectory)).toHaveLength(6);
        expect(yield* awaitFileLineCount(controlDirectory, "requests.ndjson", 1)).toHaveLength(1);
      }).pipe(
        Effect.provide(PluginSupervisor.layer()),
        Effect.provide(
          configuredLoggingLayer(loggingConfig, (line) => {
            lines.push(line);
          }),
        ),
      ),
    );
  }),
);

it.effect("rejects unsafe executable files before spawning them", () =>
  withControlDirectory((controlDirectory) =>
    Effect.scoped(
      Effect.gen(function* executableValidationTest() {
        const supervisor = yield* PluginSupervisor;
        const unsafeModePath = join(controlDirectory, "unsafe-mode");
        const nonExecutablePath = join(controlDirectory, "non-executable");
        const symlinkPath = join(controlDirectory, "symlink");
        yield* Effect.promise(async () => {
          await writeFile(unsafeModePath, "#!/bin/sh\nexit 0\n", {
            mode: 0o722,
          });
          await chmod(unsafeModePath, 0o722);
          await writeFile(nonExecutablePath, "#!/bin/sh\nexit 0\n", {
            mode: 0o600,
          });
          await symlink(process.execPath, symlinkPath);
        });

        for (const executable of [
          join(controlDirectory, "missing"),
          unsafeModePath,
          nonExecutablePath,
          symlinkPath,
        ]) {
          const failure = yield* supervisor
            .supervise({
              ...descriptor,
              executable,
            })
            .pipe(Effect.flip);
          expect(failure).toMatchObject({
            _tag: "PluginUnavailable",
            reason: "executable_invalid",
          });
        }
      }).pipe(Effect.provide(PluginSupervisor.layer())),
    ),
  ),
);

it.effect("rejects an executable outside the effective owner boundary", () =>
  withControlDirectory((controlDirectory) =>
    Effect.scoped(
      Effect.gen(function* executableOwnerTest() {
        const executable = join(controlDirectory, "owned-executable");
        yield* Effect.promise(() => writeFile(executable, "#!/bin/sh\nexit 0\n", { mode: 0o700 }));
        const supervisor = yield* PluginSupervisor;
        const failure = yield* supervisor
          .supervise({ ...descriptor, executable })
          .pipe(Effect.flip);

        expect(failure).toMatchObject({
          _tag: "PluginUnavailable",
          reason: "executable_invalid",
        });
      }).pipe(
        Effect.provide(
          PluginSupervisor.layer({
            effectiveUserId: (process.geteuid?.() ?? 1) + 1,
          }),
        ),
      ),
    ),
  ),
);

it.live("revalidates the executable before recovery spawn", () =>
  withControlDirectory((controlDirectory) =>
    Effect.scoped(
      Effect.gen(function* recoveryExecutableValidationTest() {
        const executable = join(controlDirectory, "fixture-node");
        yield* Effect.promise(() =>
          writeFile(executable, `#!/bin/sh\nexec ${process.execPath} "$@"\n`, { mode: 0o700 }),
        );

        const supervisor = yield* PluginSupervisor;
        const plugin = yield* supervisor.supervise({
          ...fixtureDescriptor(controlDirectory),
          executable,
        });
        yield* plugin.call(HealthService.method.check, {}, CALL_DEADLINE_MILLISECONDS);
        const firstLaunch = (yield* readLaunchRecords(controlDirectory))[0];
        if (firstLaunch === undefined) {
          return yield* Effect.die("fixture launch record missing");
        }

        yield* Effect.promise(() => chmod(executable, 0o722));
        process.kill(firstLaunch.pid, "SIGKILL");
        yield* awaitProcessExit(firstLaunch.pid);
        yield* Effect.yieldNow;

        const call = yield* Effect.forkChild(
          plugin.call(HealthService.method.check, {}, CALL_DEADLINE_MILLISECONDS),
        );
        const failure = yield* Fiber.join(call).pipe(Effect.flip);

        expect(failure).toMatchObject({
          _tag: "PluginUnavailable",
          reason: "executable_invalid",
        });
        expect(yield* readLaunchRecords(controlDirectory)).toHaveLength(1);
      }).pipe(Effect.provide(PluginSupervisor.layer())),
    ),
  ),
);

it.effect("rejects unsafe structured-stderr declarations before launch", () =>
  withControlDirectory((controlDirectory) =>
    Effect.scoped(
      Effect.gen(function* stderrDeclarationValidationTest() {
        const supervisor = yield* PluginSupervisor;
        const invalidDeclarations: readonly (readonly PluginStderrEventDeclaration[])[] = [
          [
            {
              event: "fixture.metric",
              fields: { provider_type: { kind: "number" } },
            },
          ],
          [
            {
              event: "fixture.metric",
              fields: {
                state: {
                  kind: "enum",
                  values: ["ready", "unsafe\nvalue"],
                },
              },
            },
          ],
          [
            { event: "fixture.metric", fields: {} },
            { event: "fixture.metric", fields: {} },
          ],
        ];

        for (const stderrEvents of invalidDeclarations) {
          const failure = yield* supervisor
            .supervise({
              ...fixtureDescriptor(controlDirectory),
              stderrEvents,
            })
            .pipe(Effect.flip);
          expect(failure).toMatchObject({
            _tag: "PluginUnavailable",
            reason: "descriptor_invalid",
          });
        }
      }).pipe(Effect.provide(PluginSupervisor.layer())),
    ),
  ),
);

it.live("protects and removes every plugin runtime artifact", () =>
  withControlDirectory((controlDirectory) =>
    Effect.gen(function* runtimeArtifactTest() {
      let runtimeRoot: string | undefined;
      yield* Effect.scoped(
        Effect.gen(function* managedRuntimeTest() {
          const supervisor = yield* PluginSupervisor;
          const handleScope = yield* Scope.make();
          const plugin = yield* Scope.provide(handleScope)(
            supervisor.supervise(fixtureDescriptor(controlDirectory)),
          );
          yield* plugin.call(HealthService.method.check, {}, CALL_DEADLINE_MILLISECONDS);
          const launch = (yield* readLaunchRecords(controlDirectory))[0];
          if (launch === undefined) {
            return yield* Effect.die("fixture launch record missing");
          }
          const launchDirectory = dirname(launch.socketPath);
          runtimeRoot = dirname(launchDirectory);
          const [rootStat, launchStat, socketStat] = yield* Effect.promise(() =>
            Promise.all([
              lstat(runtimeRoot as string),
              lstat(launchDirectory),
              lstat(launch.socketPath),
            ]),
          );
          expect(rootStat.mode & 0o777).toBe(0o700);
          expect(launchStat.mode & 0o777).toBe(0o700);
          expect(socketStat.isSocket()).toBe(true);
          expect(socketStat.mode & 0o777).toBe(0o600);
          expect(Buffer.byteLength(launch.socketPath, "utf8")).toBeLessThanOrEqual(100);

          yield* Scope.close(handleScope, Exit.void);
          const launchFailure = yield* Effect.tryPromise({
            catch: (error) => error,
            try: () => lstat(launchDirectory),
          }).pipe(Effect.flip);
          expect(launchFailure).toMatchObject({ code: "ENOENT" });
          expect((yield* Effect.promise(() => lstat(runtimeRoot as string))).isDirectory()).toBe(
            true,
          );
        }).pipe(Effect.provide(PluginSupervisor.layer())),
      );
      const removedRoot = runtimeRoot;
      if (removedRoot === undefined) {
        return yield* Effect.die("runtime root missing");
      }
      const rootFailure = yield* Effect.tryPromise({
        catch: (error) => error,
        try: () => lstat(removedRoot),
      }).pipe(Effect.flip);
      expect(rootFailure).toMatchObject({ code: "ENOENT" });
    }),
  ),
);

it.live("reaps and cleans a process interrupted during initial startup", () =>
  withControlDirectory((controlDirectory) =>
    Effect.gen(function* interruptedStartupCleanupTest() {
      const layerScope = yield* Scope.make();
      const context = yield* Layer.buildWithScope(PluginSupervisor.layer(), layerScope);
      const supervisor = Context.get(context, PluginSupervisor);
      const handleScope = yield* Scope.make();
      const plugin = yield* Scope.provide(handleScope)(
        supervisor.supervise(fixtureDescriptor(controlDirectory, "wait-start")),
      );
      const startupCall = yield* Effect.forkChild(
        plugin.call(HealthService.method.check, {}, CALL_DEADLINE_MILLISECONDS),
      );
      const launch = (yield* awaitLaunchCount(controlDirectory, 1))[0];
      if (launch === undefined) {
        return yield* Effect.die("fixture launch record missing");
      }

      yield* Scope.close(handleScope, Exit.void);
      yield* awaitProcessExit(launch.pid);
      yield* Fiber.interrupt(startupCall);
      const launchFailure = yield* Effect.tryPromise({
        catch: (error) => error,
        try: () => lstat(dirname(launch.socketPath)),
      }).pipe(Effect.flip);
      expect(launchFailure).toMatchObject({ code: "ENOENT" });

      yield* Scope.close(layerScope, Exit.void);
    }),
  ),
);

it.effect("fails startup when a protected socket path cannot fit", () =>
  Effect.acquireUseRelease(
    Effect.promise(async () => {
      const root = await mkdtemp(join(tmpdir(), "nama-long-path-"));
      const temporaryDirectory = join(root, "x".repeat(80));
      await mkdir(temporaryDirectory, { mode: 0o700 });
      return { root, temporaryDirectory };
    }),
    ({ temporaryDirectory }) =>
      Effect.gen(function* socketPathBoundaryTest() {
        const failure = yield* Effect.scoped(
          PluginSupervisor.pipe(Effect.provide(PluginSupervisor.layer({ temporaryDirectory }))),
        ).pipe(Effect.flip);
        expect(failure).toMatchObject({
          _tag: "PluginSupervisorBoundaryError",
        });
      }),
    ({ root }) => Effect.promise(() => rm(root, { force: true, recursive: true })),
  ),
);

it.live("fails sibling RPCs without replay when a deadline recycles the process", () =>
  withControlDirectory((controlDirectory) =>
    Effect.scoped(
      Effect.gen(function* siblingDeadlineTest() {
        const supervisor = yield* PluginSupervisor;
        const plugin = yield* supervisor.supervise(
          fixtureDescriptor(controlDirectory, "block-connection"),
        );
        yield* plugin.call(HealthService.method.check, {}, CALL_DEADLINE_MILLISECONDS);
        const expiringCall = yield* Effect.forkChild(
          plugin.call(PluginService.method.getConnection, {}, 100),
        );
        yield* awaitFileLineCount(controlDirectory, "requests.ndjson", 1);
        const siblingCall = yield* Effect.forkChild(
          plugin.call(PluginService.method.getConnection, {}, 10_000),
        );
        yield* awaitFileLineCount(controlDirectory, "requests.ndjson", 2);

        expect(yield* Fiber.join(expiringCall).pipe(Effect.flip)).toMatchObject({
          _tag: "PluginDeadlineExceeded",
        });
        const siblingFailure = yield* Fiber.join(siblingCall).pipe(Effect.flip);
        expect(siblingFailure).toMatchObject({
          _tag: "PluginUnavailable",
          reason: "plugin_exited",
        });
        expect(yield* awaitFileLineCount(controlDirectory, "requests.ndjson", 2)).toHaveLength(2);
        yield* awaitLaunchCount(controlDirectory, 2);
        expect(yield* readLaunchRecords(controlDirectory)).toHaveLength(2);
      }).pipe(Effect.provide(PluginSupervisor.layer())),
    ),
  ),
);

it.effect("reaps every active process before surfacing peer cleanup failure", () =>
  withControlDirectory((controlDirectory) =>
    Effect.gen(function* concurrentHandleCleanupTest() {
      const cleanupControlDirectory = join(controlDirectory, "cleanup");
      const ignoringControlDirectory = join(controlDirectory, "ignoring");
      yield* Effect.promise(async () => {
        await mkdir(cleanupControlDirectory, { mode: 0o700 });
        await mkdir(ignoringControlDirectory, { mode: 0o700 });
      });

      const layerScope = yield* Scope.make();
      const context = yield* Layer.buildWithScope(PluginSupervisor.layer(), layerScope);
      const supervisor = Context.get(context, PluginSupervisor);
      const cleanupScope = yield* Scope.make();
      const ignoringScope = yield* Scope.make();
      const cleanupPlugin = yield* Scope.provide(cleanupScope)(
        supervisor.supervise(fixtureDescriptor(cleanupControlDirectory, "cleanup-failure")),
      );
      const ignoringPlugin = yield* Scope.provide(ignoringScope)(
        supervisor.supervise(fixtureDescriptor(ignoringControlDirectory, "ignore-termination")),
      );
      yield* cleanupPlugin.call(HealthService.method.check, {}, CALL_DEADLINE_MILLISECONDS);
      yield* ignoringPlugin.call(HealthService.method.check, {}, CALL_DEADLINE_MILLISECONDS);
      const cleanupLaunch = (yield* readLaunchRecords(cleanupControlDirectory))[0];
      const ignoringLaunch = (yield* readLaunchRecords(ignoringControlDirectory))[0];
      if (cleanupLaunch === undefined || ignoringLaunch === undefined) {
        return yield* Effect.die("fixture launch record missing");
      }

      const shutdown = yield* Effect.forkChild(
        Scope.close(layerScope, Exit.void).pipe(Effect.exit),
      );
      yield* awaitProcessExit(cleanupLaunch.pid);
      yield* TestClock.adjust(2000);
      yield* awaitProcessExit(ignoringLaunch.pid);
      const shutdownExit = yield* Fiber.join(shutdown);
      expect(Exit.isSuccess(shutdownExit)).toBe(false);

      yield* Scope.close(cleanupScope, Exit.void);
      yield* Scope.close(ignoringScope, Exit.void);
    }),
  ),
);

it.live("closes active handles before the supervisor runtime root", () =>
  withControlDirectory((controlDirectory) =>
    Effect.gen(function* rootOwnedHandleTest() {
      const layerScope = yield* Scope.make();
      const context = yield* Layer.buildWithScope(PluginSupervisor.layer(), layerScope);
      const supervisor = Context.get(context, PluginSupervisor);
      const handleScope = yield* Scope.make();
      const plugin = yield* Scope.provide(handleScope)(
        supervisor.supervise(fixtureDescriptor(controlDirectory)),
      );
      yield* plugin.call(HealthService.method.check, {}, CALL_DEADLINE_MILLISECONDS);
      const launch = (yield* readLaunchRecords(controlDirectory))[0];
      if (launch === undefined) {
        return yield* Effect.die("fixture launch record missing");
      }

      yield* Scope.close(layerScope, Exit.void);
      yield* awaitProcessExit(launch.pid);
      const launchFailure = yield* Effect.tryPromise({
        catch: (error) => error,
        try: () => lstat(dirname(launch.socketPath)),
      }).pipe(Effect.flip);
      expect(launchFailure).toMatchObject({ code: "ENOENT" });

      yield* Scope.close(handleScope, Exit.void);
    }),
  ),
);

it.live("emits safe allowlisted plugin lifecycle records", () =>
  withControlDirectory((controlDirectory) => {
    const lines: string[] = [];
    return Effect.scoped(
      Effect.gen(function* pluginLifecycleLoggingTest() {
        const supervisor = yield* PluginSupervisor;
        const plugin = yield* supervisor.supervise({
          ...fixtureDescriptor(controlDirectory, "crash-connection"),
          providerInstanceId: "provider-instance",
        });
        yield* plugin.call(HealthService.method.check, {}, CALL_DEADLINE_MILLISECONDS);
        const firstLaunch = (yield* readLaunchRecords(controlDirectory))[0];
        if (firstLaunch === undefined) {
          return yield* Effect.die("fixture launch record missing");
        }
        expect(
          yield* plugin
            .call(PluginService.method.getConnection, {}, CALL_DEADLINE_MILLISECONDS)
            .pipe(Effect.flip),
        ).toMatchObject({
          _tag: "PluginUnavailable",
          reason: "plugin_exited",
        });
        yield* awaitLaunchCount(controlDirectory, 2);
        yield* awaitCondition(
          () =>
            lines.some((line) => line.includes('"event":"plugin.process_exited"')) &&
            lines.some((line) => line.includes('"event":"plugin.recovery_attempt"')),
        );

        const output = lines.join("");
        const records = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
        expect(records).toContainEqual(
          expect.objectContaining({
            event: "plugin.process_exited",
            level: "warn",
            provider_instance_id: "provider-instance",
            provider_type: "fixture",
            signal: "SIGKILL",
          }),
        );
        expect(output).not.toContain(firstLaunch.bearer);
        expect(output).not.toContain(firstLaunch.socketPath);
        expect(output).not.toContain(controlDirectory);
        expect(output).not.toContain("server.runtime_failed");
      }).pipe(
        Effect.provide(PluginSupervisor.layer()),
        Effect.provide(
          configuredLoggingLayer(loggingConfig, (line) => {
            lines.push(line);
          }),
        ),
      ),
    );
  }),
);

it.live("tolerates plugin removal of its own runtime artifacts", () =>
  withControlDirectory((controlDirectory) =>
    Effect.scoped(
      Effect.gen(function* absentArtifactCleanupTest() {
        const supervisor = yield* PluginSupervisor;
        const handleScope = yield* Scope.make();
        const plugin = yield* Scope.provide(handleScope)(
          supervisor.supervise(fixtureDescriptor(controlDirectory, "remove-artifacts")),
        );
        yield* plugin.call(HealthService.method.check, {}, CALL_DEADLINE_MILLISECONDS);

        yield* Scope.close(handleScope, Exit.void);
      }).pipe(Effect.provide(PluginSupervisor.layer())),
    ),
  ),
);

it.live("retries failed health handshakes within the bounded episode", () =>
  withControlDirectory((controlDirectory) =>
    Effect.scoped(
      Effect.gen(function* handshakeRecoveryTest() {
        const supervisor = yield* PluginSupervisor;
        const plugin = yield* supervisor.supervise(
          fixtureDescriptor(controlDirectory, "handshake-not-serving"),
        );
        const failure = yield* plugin
          .call(HealthService.method.check, {}, 10_000)
          .pipe(Effect.flip);

        expect(failure).toMatchObject({
          _tag: "PluginUnavailable",
          reason: "handshake_failed",
        });
        expect(yield* readLaunchRecords(controlDirectory)).toHaveLength(3);
      }).pipe(Effect.provide(PluginSupervisor.layer())),
    ),
  ),
);

it.effect("bounds each complete launch handshake to five seconds", () =>
  withControlDirectory((controlDirectory) =>
    Effect.scoped(
      Effect.gen(function* handshakeDeadlineTest() {
        const supervisor = yield* PluginSupervisor;
        const plugin = yield* supervisor.supervise(
          fixtureDescriptor(controlDirectory, "wait-start"),
        );
        const call = yield* Effect.forkChild(plugin.call(HealthService.method.check, {}, 20_000));
        const first = (yield* awaitLaunchCount(controlDirectory, 1))[0];
        if (first === undefined) {
          return yield* Effect.die("first launch record missing");
        }
        yield* Effect.yieldNow;

        yield* TestClock.adjust(4999);
        expect(call.pollUnsafe()).toBeUndefined();
        expect(() => process.kill(first.pid, 0)).not.toThrow();
        yield* TestClock.adjust(1);
        yield* awaitProcessExit(first.pid);
        yield* TestClock.withLive(Effect.sleep(10));

        yield* TestClock.adjust(100);
        const second = (yield* awaitLaunchCount(controlDirectory, 2))[1];
        if (second === undefined) {
          return yield* Effect.die("second launch record missing");
        }
        yield* Effect.yieldNow;
        yield* TestClock.adjust(5000);
        yield* awaitProcessExit(second.pid);

        yield* TestClock.withLive(Effect.sleep(10));
        yield* TestClock.adjust(500);
        const third = (yield* awaitLaunchCount(controlDirectory, 3))[2];
        if (third === undefined) {
          return yield* Effect.die("third launch record missing");
        }
        yield* Effect.yieldNow;
        yield* TestClock.adjust(5000);
        yield* awaitProcessExit(third.pid);

        const failure = yield* Fiber.join(call).pipe(Effect.flip);
        expect(failure).toMatchObject({
          _tag: "PluginUnavailable",
          reason: "handshake_failed",
        });
      }).pipe(Effect.provide(PluginSupervisor.layer())),
    ),
  ),
);

it.live("surfaces genuine launch-artifact cleanup failure", () =>
  withControlDirectory((controlDirectory) =>
    Effect.gen(function* cleanupFailureTest() {
      const layerScope = yield* Scope.make();
      const context = yield* Layer.buildWithScope(PluginSupervisor.layer(), layerScope);
      const supervisor = Context.get(context, PluginSupervisor);
      const handleScope = yield* Scope.make();
      const plugin = yield* Scope.provide(handleScope)(
        supervisor.supervise(fixtureDescriptor(controlDirectory, "cleanup-failure")),
      );
      yield* plugin.call(HealthService.method.check, {}, CALL_DEADLINE_MILLISECONDS);
      const launch = (yield* readLaunchRecords(controlDirectory))[0];
      if (launch === undefined) {
        return yield* Effect.die("fixture launch record missing");
      }
      const runtimeRoot = dirname(dirname(launch.socketPath));

      const shutdownExit = yield* Scope.close(handleScope, Exit.void).pipe(Effect.exit);
      if (Exit.isSuccess(shutdownExit)) {
        return yield* Effect.die("cleanup unexpectedly succeeded");
      }
      const cleanupDefect = shutdownExit.cause.reasons.find(Cause.isDieReason);
      expect(cleanupDefect?.defect).toMatchObject({
        _tag: "PluginSupervisorCleanupError",
      });

      yield* Effect.promise(() => chmod(runtimeRoot, 0o700));
      yield* Scope.close(layerScope, Exit.void);
    }),
  ),
);

it.live("surfaces cleanup failure while closing initial startup", () =>
  withControlDirectory((controlDirectory) =>
    Effect.gen(function* startupCleanupFailureTest() {
      const layerScope = yield* Scope.make();
      const context = yield* Layer.buildWithScope(PluginSupervisor.layer(), layerScope);
      const supervisor = Context.get(context, PluginSupervisor);
      const handleScope = yield* Scope.make();
      const plugin = yield* Scope.provide(handleScope)(
        supervisor.supervise(fixtureDescriptor(controlDirectory, "wait-start-cleanup-failure")),
      );
      const startupCall = yield* Effect.forkChild(
        plugin.call(HealthService.method.check, {}, CALL_DEADLINE_MILLISECONDS),
      );
      const launch = (yield* awaitLaunchCount(controlDirectory, 1))[0];
      if (launch === undefined) {
        return yield* Effect.die("fixture launch record missing");
      }
      const runtimeRoot = dirname(dirname(launch.socketPath));

      const shutdownExit = yield* Scope.close(handleScope, Exit.void).pipe(Effect.exit);
      if (Exit.isSuccess(shutdownExit)) {
        return yield* Effect.die("startup cleanup unexpectedly succeeded");
      }
      const cleanupDefect = shutdownExit.cause.reasons.find(Cause.isDieReason);
      expect(cleanupDefect?.defect).toMatchObject({
        _tag: "PluginSupervisorCleanupError",
      });

      yield* Fiber.interrupt(startupCall);
      yield* Effect.promise(() => chmod(runtimeRoot, 0o700));
      yield* Scope.close(layerScope, Exit.void);
    }),
  ),
);

it.effect("records recovery exhaustion exactly once", () =>
  withControlDirectory((controlDirectory) => {
    const lines: string[] = [];
    return Effect.scoped(
      Effect.gen(function* exhaustionLoggingTest() {
        const supervisor = yield* PluginSupervisor;
        const plugin = yield* supervisor.supervise(
          fixtureDescriptor(controlDirectory, "always-exit-before-ready"),
        );
        const call = yield* Effect.forkChild(
          plugin.call(HealthService.method.check, {}, CALL_DEADLINE_MILLISECONDS),
        );

        yield* awaitFileLineCount(controlDirectory, "exits.ndjson", 1);
        yield* awaitCondition(() =>
          lines.some(
            (line) =>
              line.includes('"event":"plugin.recovery_attempt"') &&
              line.includes('"recovery_attempt":2'),
          ),
        );
        yield* TestClock.adjust(100);
        yield* awaitFileLineCount(controlDirectory, "exits.ndjson", 2);
        yield* awaitCondition(() =>
          lines.some(
            (line) =>
              line.includes('"event":"plugin.recovery_attempt"') &&
              line.includes('"recovery_attempt":3'),
          ),
        );
        yield* TestClock.adjust(500);
        yield* awaitFileLineCount(controlDirectory, "exits.ndjson", 3);
        yield* Fiber.join(call).pipe(Effect.flip);
        yield* awaitCondition(() =>
          lines.some((line) => line.includes('"event":"plugin.recovery_exhausted"')),
        );

        const exhaustionRecords = lines
          .map((line) => JSON.parse(line) as Record<string, unknown>)
          .filter((record) => record["event"] === "plugin.recovery_exhausted");
        expect(exhaustionRecords).toEqual([
          expect.objectContaining({
            level: "error",
            provider_type: "fixture",
            recovery_attempt: 3,
          }),
        ]);
      }).pipe(
        Effect.provide(PluginSupervisor.layer()),
        Effect.provide(
          configuredLoggingLayer(loggingConfig, (line) => {
            lines.push(line);
          }),
        ),
      ),
    );
  }),
);

it.live("discards stdout and keeps requested termination quiet", () =>
  withControlDirectory((controlDirectory) => {
    const lines: string[] = [];
    return Effect.scoped(
      Effect.gen(function* quietTerminationTest() {
        const supervisor = yield* PluginSupervisor;
        const handleScope = yield* Scope.make();
        const plugin = yield* Scope.provide(handleScope)(
          supervisor.supervise(fixtureDescriptor(controlDirectory, "stdout-secret")),
        );
        yield* plugin.call(HealthService.method.check, {}, CALL_DEADLINE_MILLISECONDS);
        yield* awaitCondition(() =>
          lines.some((line) => line.includes('"event":"plugin.recovery_attempt"')),
        );

        yield* Scope.close(handleScope, Exit.void);
        expect(lines.join("")).not.toContain("stdout-secret-must-not-appear");
        expect(lines.join("")).not.toContain("plugin.process_exited");
      }).pipe(
        Effect.provide(PluginSupervisor.layer()),
        Effect.provide(
          configuredLoggingLayer(loggingConfig, (line) => {
            lines.push(line);
          }),
        ),
      ),
    );
  }),
);
