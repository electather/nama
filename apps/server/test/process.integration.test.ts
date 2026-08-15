import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { Pool } from "pg";

import {
  MASTER_KEY,
  SINGLE_CONNECTION,
  eventsFrom,
  expectPortReleased,
  integrationUrl,
  recordFromLine,
  startProcess,
  startMigrationFailureProcess,
  stopProcess,
  waitForExit,
  waitForStatus,
  withIsolatedDatabase,
} from "./process.test-support.ts";
import type { RunningProcess } from "./process.test-support.ts";

const HTTP_OK = 200;
const HTTP_UNAVAILABLE = 503;
const SUCCESS_EXIT_CODE = 0;
const EXPECTED_FATAL_RECORDS = 1;
const FIRST_RECORD_INDEX = 0;
const DATABASE_PATH_PREFIX_LENGTH = 1;
const UNAVAILABLE_PORT = "1";
const SIGNAL_TEST_TIMEOUT_MILLISECONDS = 20_000;
const FAILURE_TEST_TIMEOUT_MILLISECONDS = 10_000;

const expectHealthy = (runningProcess: RunningProcess) =>
  Effect.gen(function* healthyProcessAssertion() {
    const live = yield* waitForStatus(runningProcess.origin, "/health/live", HTTP_OK);
    const ready = yield* waitForStatus(runningProcess.origin, "/health/ready", HTTP_OK);
    expect(yield* Effect.promise(() => live.text())).toBe("");
    expect(yield* Effect.promise(() => ready.text())).toBe("");
  });

const expectLifecycleOutput = (runningProcess: RunningProcess, databaseUrl: string): void => {
  expect(eventsFrom(runningProcess)).toEqual([
    "server.ready",
    "database.readiness_changed",
    "server.stopping",
    "server.stopped",
  ]);
  expect(runningProcess.stderr()).toBe("");
  expect(runningProcess.stdout()).not.toContain(databaseUrl);
  expect(runningProcess.stdout()).not.toContain(MASTER_KEY);
};

const exerciseSignal = (databaseUrl: string, signal: NodeJS.Signals) =>
  Effect.gen(function* signalLifecycleTest() {
    const runningProcess = yield* startProcess(databaseUrl);
    yield* expectHealthy(runningProcess);
    const exit = yield* stopProcess(runningProcess, signal);
    expect(exit.code).toBe(SUCCESS_EXIT_CODE);
    expect(exit.signal).toBeNull();
    yield* expectPortReleased(runningProcess.origin);
    expectLifecycleOutput(runningProcess, databaseUrl);
  });

const observeDatabaseLoss = (runningProcess: RunningProcess, admin: Pool, databaseName: string) =>
  Effect.gen(function* databaseLoss() {
    yield* Effect.promise(() => admin.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`));
    yield* waitForStatus(runningProcess.origin, "/health/ready", HTTP_UNAVAILABLE);
    yield* waitForStatus(runningProcess.origin, "/health/live", HTTP_OK);
  });

const observeDatabaseRecovery = (
  runningProcess: RunningProcess,
  admin: Pool,
  databaseName: string,
) =>
  Effect.gen(function* databaseRecovery() {
    yield* Effect.promise(() => admin.query(`CREATE DATABASE "${databaseName}"`));
    yield* waitForStatus(runningProcess.origin, "/health/ready", HTTP_OK);
    const exit = yield* stopProcess(runningProcess, "SIGTERM");
    expect(exit.code).toBe(SUCCESS_EXIT_CODE);
  });

const exerciseDatabaseRecovery = (databaseUrl: string) =>
  Effect.gen(function* databaseRecoveryTest() {
    const databaseName = new URL(databaseUrl).pathname.slice(DATABASE_PATH_PREFIX_LENGTH);
    const admin = yield* Effect.acquireRelease(
      Effect.sync(() => new Pool({ connectionString: integrationUrl, max: SINGLE_CONNECTION })),
      (acquired) => Effect.promise(() => acquired.end()),
    );
    const runningProcess = yield* startProcess(databaseUrl);
    yield* waitForStatus(runningProcess.origin, "/health/ready", HTTP_OK);
    yield* observeDatabaseLoss(runningProcess, admin, databaseName);
    yield* observeDatabaseRecovery(runningProcess, admin, databaseName);
  });

const expectFatalOutput = (
  runningProcess: RunningProcess,
  unavailableDatabaseUrl: string,
): void => {
  const records = runningProcess.stdout().trim().split("\n").filter(Boolean);
  expect(records).toHaveLength(EXPECTED_FATAL_RECORDS);
  const record = recordFromLine(records.at(FIRST_RECORD_INDEX) ?? "null");
  expect(typeof record["timestamp"]).toBe("string");
  expect(record).toEqual({
    error_tag: "DatabaseConnectionError",
    event: "server.start_failed",
    level: "fatal",
    timestamp: record["timestamp"],
  });
  expect(runningProcess.stderr()).toBe("");
  expect(runningProcess.stdout()).not.toContain(unavailableDatabaseUrl);
  expect(runningProcess.stdout()).not.toContain(MASTER_KEY);
};

it.live(
  "boots the package entrypoint and releases its listener on both signals",
  () =>
    withIsolatedDatabase((databaseUrl) =>
      Effect.gen(function* signalTests() {
        yield* Effect.scoped(exerciseSignal(databaseUrl, "SIGINT"));
        yield* Effect.scoped(exerciseSignal(databaseUrl, "SIGTERM"));
      }),
    ),
  SIGNAL_TEST_TIMEOUT_MILLISECONDS,
);

it.live(
  "reports database loss and recovery without a process restart",
  () => withIsolatedDatabase(exerciseDatabaseRecovery),
  SIGNAL_TEST_TIMEOUT_MILLISECONDS,
);

it.live(
  "emits one normalized fatal record and never binds after startup failure",
  () =>
    Effect.gen(function* startupFailureTest() {
      const unavailableDatabaseUrl = new URL(integrationUrl);
      unavailableDatabaseUrl.port = UNAVAILABLE_PORT;
      const runningProcess = yield* startProcess(unavailableDatabaseUrl.toString());
      const exit = yield* waitForExit(runningProcess.child);
      expect(exit.code).not.toBe(SUCCESS_EXIT_CODE);
      yield* expectPortReleased(runningProcess.origin);
      expectFatalOutput(runningProcess, unavailableDatabaseUrl.toString());
    }),
  FAILURE_TEST_TIMEOUT_MILLISECONDS,
);

it.live(
  "exits non-zero without binding when migration application fails",
  () =>
    withIsolatedDatabase((databaseUrl) =>
      Effect.gen(function* migrationFailureProcessTest() {
        const runningProcess = yield* startMigrationFailureProcess(databaseUrl);
        const exit = yield* waitForExit(runningProcess.child);
        expect(exit.code).not.toBe(SUCCESS_EXIT_CODE);
        yield* expectPortReleased(runningProcess.origin);
        expect(runningProcess.stderr()).toBe("");
        expect(runningProcess.stdout()).not.toContain(databaseUrl);
        expect(runningProcess.stdout()).not.toContain(MASTER_KEY);
      }),
    ),
  FAILURE_TEST_TIMEOUT_MILLISECONDS,
);
