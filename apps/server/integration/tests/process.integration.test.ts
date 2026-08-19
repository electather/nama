import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { Pool } from "pg";

import {
  acquireMigrationLock,
  productionMigrations,
  readMigratedState,
  releaseMigrationLock,
  useDatabase,
  withPool,
} from "./database.test-support.ts";
import type { MigratedState } from "./database.test-support.ts";
import {
  SINGLE_CONNECTION,
  integrationUrl,
  namaServerConnectionCount,
  waitForNamaServerConnectionCount,
  waitForNamaServerMigrationLock,
  withIsolatedDatabase,
} from "./postgres.test-support.ts";
import {
  MASTER_KEY,
  eventsFrom,
  expectPortReleased,
  recordFromLine,
  startProcess,
  stopProcess,
  waitForExit,
  waitForStatus,
} from "./process.test-support.ts";
import type { RunningProcess } from "./process.test-support.ts";

const HTTP_OK = 200;
const HTTP_UNAVAILABLE = 503;
const SUCCESS_EXIT_CODE = 0;
const EXPECTED_SINGLE_RECORD_COUNT = 1;
const FIRST_RECORD_INDEX = 0;
const NO_CONNECTIONS = 0;
const DATABASE_PATH_PREFIX_LENGTH = 1;
const UNAVAILABLE_PORT = "1";
const SIGNAL_TEST_TIMEOUT_MILLISECONDS = 20_000;
const FAILURE_TEST_TIMEOUT_MILLISECONDS = 10_000;
const INTEGRITY_USERS = [
  ["integrity-user-one", "Integrity One", "integrity-one@example.test"],
  ["integrity-user-two", "Integrity Two", "integrity-two@example.test"],
] as const;
const INTEGRITY_USER_INSERT =
  'INSERT INTO "user" (id, name, email) VALUES ($1, $2, $3), ($4, $5, $6)';
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
    yield* Effect.promise(async () => {
      await admin.query(`ALTER DATABASE "${databaseName}" WITH ALLOW_CONNECTIONS false`);
      await admin.query(
        "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1",
        [databaseName],
      );
    });
    yield* waitForStatus(runningProcess.origin, "/health/ready", HTTP_UNAVAILABLE);
    yield* waitForStatus(runningProcess.origin, "/health/live", HTTP_OK);
  });
const observeDatabaseRecovery = (
  runningProcess: RunningProcess,
  admin: Pool,
  databaseName: string,
) =>
  Effect.gen(function* databaseRecovery() {
    yield* Effect.promise(() =>
      admin.query(`ALTER DATABASE "${databaseName}" WITH ALLOW_CONNECTIONS true`),
    );
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
    const before = yield* withPool(databaseUrl, readMigratedState);
    yield* observeDatabaseLoss(runningProcess, admin, databaseName);
    yield* observeDatabaseRecovery(runningProcess, admin, databaseName);
    expect(yield* withPool(databaseUrl, readMigratedState)).toEqual(before);
  });
const expectFatalOutput = (
  runningProcess: RunningProcess,
  errorTag: "DatabaseConnectionError" | "DatabaseIntegrityError" | "MigrationError",
  redactedValues: readonly string[],
): void => {
  const output = runningProcess.stdout();
  const records = output.trim().split("\n").filter(Boolean);
  expect(records).toHaveLength(EXPECTED_SINGLE_RECORD_COUNT);
  const record = recordFromLine(records.at(FIRST_RECORD_INDEX) ?? "null");
  expect(typeof record["timestamp"]).toBe("string");
  expect(record).toEqual({
    error_tag: errorTag,
    event: "server.start_failed",
    level: "fatal",
    timestamp: record["timestamp"],
  });
  expect(runningProcess.stderr()).toBe("");
  for (const value of [MASTER_KEY, ...redactedValues].filter(Boolean)) {
    expect(output).not.toContain(value);
  }
};

const expectFreshMigratedState = (migratedState: MigratedState): void => {
  expect(migratedState.migrationCount).toBe("2");
  expect(migratedState.serverState?.key).toBe("server");
  expect(migratedState.serverState?.administrator_user_id).toBeNull();
  expect(migratedState.serverState?.initialized_at).toBeNull();
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
      expectFatalOutput(runningProcess, "DatabaseConnectionError", [
        unavailableDatabaseUrl.toString(),
      ]);
    }),
  FAILURE_TEST_TIMEOUT_MILLISECONDS,
);

it.live(
  "redacts migration failure and closes the real package pool without binding",
  () =>
    withIsolatedDatabase((databaseUrl) =>
      Effect.gen(function* migrationFailureProcessTest() {
        yield* withPool(databaseUrl, (fixture) =>
          Effect.promise(() => fixture.query('CREATE TABLE "user" (id text PRIMARY KEY)')),
        );
        yield* withPool(databaseUrl, (observer) =>
          Effect.gen(function* observeMigrationFailure() {
            const runningProcess = yield* startProcess(databaseUrl);
            const exit = yield* waitForExit(runningProcess.child);
            expect(exit.code).not.toBe(SUCCESS_EXIT_CODE);
            expect(exit.signal).toBeNull();
            yield* expectPortReleased(runningProcess.origin);
            const location = new URL(databaseUrl);
            expectFatalOutput(runningProcess, "MigrationError", [
              databaseUrl,
              location.pathname.slice(DATABASE_PATH_PREFIX_LENGTH),
              location.hostname,
              location.port,
              location.username,
              location.password,
              "already exists",
              "CREATE TABLE",
              "user",
            ]);
            yield* waitForNamaServerConnectionCount(observer, NO_CONNECTIONS);
            expect(yield* namaServerConnectionCount(observer)).toBe(NO_CONNECTIONS);
          }),
        );
      }),
    ),
  FAILURE_TEST_TIMEOUT_MILLISECONDS,
);

it.live(
  "does not bind until the real package migration and reconciliation complete",
  () =>
    withIsolatedDatabase((databaseUrl) =>
      withPool(databaseUrl, (locker) =>
        withPool(databaseUrl, (observer) =>
          Effect.gen(function* preBindMigrationOrderingTest() {
            const runningProcess = yield* Effect.acquireUseRelease(
              acquireMigrationLock(locker),
              () =>
                Effect.gen(function* lockedMigrationAssertion() {
                  const acquiredProcess = yield* startProcess(databaseUrl);
                  yield* waitForNamaServerMigrationLock(observer);
                  const connectionCount = yield* namaServerConnectionCount(observer);
                  expect(connectionCount).toBeGreaterThan(NO_CONNECTIONS);
                  expect(acquiredProcess.child.exitCode).toBeNull();
                  expect(acquiredProcess.child.signalCode).toBeNull();
                  yield* expectPortReleased(acquiredProcess.origin);
                  return acquiredProcess;
                }),
              releaseMigrationLock,
            );

            yield* expectHealthy(runningProcess);
            const migratedState = yield* readMigratedState(observer);
            expectFreshMigratedState(migratedState);
            const exit = yield* stopProcess(runningProcess, "SIGTERM");
            expect(exit.code).toBe(SUCCESS_EXIT_CODE);
            expect(exit.signal).toBeNull();
            yield* waitForNamaServerConnectionCount(observer, NO_CONNECTIONS);
            expect(yield* namaServerConnectionCount(observer)).toBe(NO_CONNECTIONS);
          }),
        ),
      ),
    ),
  SIGNAL_TEST_TIMEOUT_MILLISECONDS,
);

it.live(
  "redacts integrity failure and closes the real package pool without binding",
  () =>
    withIsolatedDatabase((databaseUrl) =>
      Effect.gen(function* integrityFailureProcessTest() {
        yield* useDatabase(databaseUrl, productionMigrations, () => Effect.void);
        yield* withPool(databaseUrl, (fixture) =>
          Effect.promise(() => fixture.query(INTEGRITY_USER_INSERT, INTEGRITY_USERS.flat())),
        );

        yield* withPool(databaseUrl, (observer) =>
          Effect.gen(function* observeIntegrityFailure() {
            const runningProcess = yield* startProcess(databaseUrl);
            const exit = yield* waitForExit(runningProcess.child);
            expect(exit.code).not.toBe(SUCCESS_EXIT_CODE);
            expect(exit.signal).toBeNull();
            yield* expectPortReleased(runningProcess.origin);
            const location = new URL(databaseUrl);
            expectFatalOutput(runningProcess, "DatabaseIntegrityError", [
              databaseUrl,
              location.pathname.slice(DATABASE_PATH_PREFIX_LENGTH),
              location.hostname,
              location.port,
              location.username,
              location.password,
              "nama_server_state",
              "nama_server_state_initialization_pair_check",
              "user_email_unique",
              "SELECT",
              "INSERT",
              ...INTEGRITY_USERS.flatMap(([id, , email]) => [id, email]),
            ]);
            yield* waitForNamaServerConnectionCount(observer, NO_CONNECTIONS);
            expect(yield* namaServerConnectionCount(observer)).toBe(NO_CONNECTIONS);
          }),
        );
      }),
    ),
  FAILURE_TEST_TIMEOUT_MILLISECONDS,
);
